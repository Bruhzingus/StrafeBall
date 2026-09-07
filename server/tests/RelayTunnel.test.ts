import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { TunnelBroker } from '../src/relay/TunnelBroker';
import { HostTunnelClient } from '../src/relay/HostTunnelClient';
import { SIGNAL_MAX_BYTES } from '../../shared/relayTunnel';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  return `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function connect(url: string, options = {}): Promise<WebSocket> {
  const socket = new WebSocket(url, options);
  socket.on('error', () => undefined);
  cleanups.push(() => socket.terminate());
  await once(socket, 'open');
  return socket;
}
async function register(base: string, code: string, secret = 'a'.repeat(64)): Promise<WebSocket> {
  const ws = await connect(`${base}/relay/register`);
  const registered = once(ws, 'message');
  ws.send(JSON.stringify({ code, secret }));
  await registered;
  return ws;
}
async function broker(timeoutMs = 500, graceMs = 1000): Promise<string> {
  const server = createServer((_req, res) => res.end('public route'));
  const normal = new WebSocketServer({ server });
  normal.on('connection', (ws) => ws.on('message', (data, binary) => ws.send(data, { binary })));
  const base = await listen(server);
  const relay = new TunnelBroker(server, timeoutMs, graceMs);
  cleanups.push(() => { relay.close(); for (const ws of normal.clients) ws.terminate(); normal.close(); });
  return base;
}
/**
 * Buffers control-socket messages so a test can await one that may already have arrived.
 * Matches are CONSUMED, so two awaits for the same predicate resolve to two different messages
 * rather than both seeing the earliest one.
 */
function collect(ws: WebSocket) {
  const queue: any[] = [];
  const waiting: Array<{ match: (m: any) => boolean; resolve: (m: any) => void }> = [];
  ws.on('message', (data) => {
    const message = JSON.parse(bytesOf(data));
    const waiter = waiting.findIndex((pending) => pending.match(message));
    if (waiter >= 0) { waiting.splice(waiter, 1)[0].resolve(message); return; }
    queue.push(message);
  });
  return {
    expect: (match: (m: any) => boolean) => new Promise<any>((resolve) => {
      const buffered = queue.findIndex(match);
      if (buffered >= 0) { resolve(queue.splice(buffered, 1)[0]); return; }
      waiting.push({ match, resolve });
    })
  };
}
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for an agent-side callback');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function bytesOf(data: unknown): string {
  return Array.isArray(data) ? Buffer.concat(data).toString() : String(data);
}

const codeA = 'HOST-0123456789ABCDEF';
const codeB = 'HOST-FEDCBA9876543210';

describe('relay broker', () => {
  it('rejects malformed registration JSON values without crashing the public server', async () => {
    const base = await broker();
    const preflight = await fetch(base.replace('ws:', 'http:') + `/relay/${codeA}/matchmake/joinById/${codeA}`, {
      method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(preflight.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    const socket = await connect(base + '/relay/register');
    const rejected = once(socket, 'close');
    socket.send('null');
    expect((await rejected)[0]).toBe(4411);
    expect(await (await fetch(base.replace('ws:', 'http:') + '/public')).text()).toBe('public route');
  });

  it('preserves ordinary HTTP/WebSocket routes and arbitrary binary/text frame boundaries', async () => {
    const base = await broker();
    expect(await (await fetch(base.replace('ws:', 'http:') + '/matchmake/public')).text()).toBe('public route');
    const normal = await connect(base + '/ordinary');
    const normalReply = once(normal, 'message');
    normal.send('normal');
    expect((await normalReply)[0].toString()).toBe('normal');
    const control = await register(base, codeA);
    const opening = once(control, 'message');
    const guest = await connect(`${base}/relay/${codeA}/process/room?sessionId=guest`);
    const request = JSON.parse((await opening)[0].toString());
    const tunnel = await connect(`${base}/relay/data?code=${codeA}&id=${request.id}`, { headers: { Authorization: `Bearer ${'a'.repeat(64)}` } });
    const payload = Buffer.from([0, 255, 193, 0, 42]);
    const forward = once(tunnel, 'message');
    guest.send(payload);
    const [received, binary] = await forward;
    expect(received).toEqual(payload);
    expect(binary).toBe(true);
    const backward = once(guest, 'message');
    tunnel.send('unparsed text', { binary: false });
    const [text, isBinary] = await backward;
    expect(text.toString()).toBe('unparsed text');
    expect(isBinary).toBe(false);
    const disconnected = once(guest, 'close');
    control.terminate();
    expect((await disconnected)[0]).toBe(4410);
  });

  it('rejects collisions and unauthorized player pairing, retains identity across reconnect', async () => {
    const base = await broker();
    const owner = await register(base, codeA);
    const attacker = await connect(base + '/relay/register');
    const rejected = once(attacker, 'close');
    attacker.send(JSON.stringify({ code: codeA, secret: 'b'.repeat(64) }));
    expect((await rejected)[0]).toBe(4409);
    const opening = once(owner, 'message');
    await connect(`${base}/relay/${codeA}/p/r?sessionId=s`);
    const { id } = JSON.parse((await opening)[0].toString());
    const bad = await connect(`${base}/relay/data?code=${codeA}&id=${id}`, { headers: { Authorization: `Bearer ${'b'.repeat(64)}` } });
    expect((await once(bad, 'close'))[0]).toBe(4411);
    const closed = once(owner, 'close');
    owner.terminate();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const imposter = await connect(base + '/relay/register');
    const denied = once(imposter, 'close');
    imposter.send(JSON.stringify({ code: codeA, secret: 'b'.repeat(64) }));
    expect((await denied)[0]).toBe(4409);
    await register(base, codeA);
  });

  it('times out unresponsive hosts, expires disconnected registrations, and reports bad codes', async () => {
    const base = await broker(50, 80);
    const post = (code: string) => fetch(`${base.replace('ws:', 'http:')}/relay/${code}/matchmake/joinById/${code}`, { method: 'POST', body: '{}' });
    expect((await (await post(codeA)).json()).code).toBe(4404);
    const control = await register(base, codeA);
    expect((await (await post(codeA)).json()).code).toBe(4411);
    control.terminate();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await (await post(codeA)).json()).code).toBe(4410);
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect((await (await post(codeA)).json()).code).toBe(4404);
  });

  it('isolates concurrent real host agents and forwards matchmaking to their selected local room', async () => {
    const base = await broker();
    for (const [code, label] of [[codeA, 'alpha'], [codeB, 'beta']]) {
      const local = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ room: label, path: req.url })); });
      const wss = new WebSocketServer({ server: local });
      wss.on('connection', (ws) => ws.on('message', (data) => ws.send(`${label}:${data}`)));
      const localUrl = await listen(local);
      cleanups.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
      await new Promise<void>((resolve) => {
        const agent = new HostTunnelClient({ brokerUrl: base, localUrl, code, roomId: () => label,
          onStatus: (status) => { if (status.startsWith('Relay connected')) resolve(); } });
        cleanups.push(() => agent.stop());
        agent.start();
      });
      const reservation = await fetch(`${base.replace('ws:', 'http:')}/relay/${code}/matchmake/joinById/${code}`, { method: 'POST', body: '{}' });
      expect(await reservation.json()).toEqual({ room: label, path: `/matchmake/joinById/${label}` });
    }
    const guests = await Promise.all([[codeA, 'alpha'], [codeB, 'beta']].map(async ([code, label]) => {
      const guest = await connect(`${base}/relay/${code}/p/${label}?sessionId=s`);
      // Model real Colyseus: the host sends the handshake before a guest sends gameplay.
      await new Promise((resolve) => setTimeout(resolve, 80));
      const reply = once(guest, 'message');
      guest.send('test');
      expect((await reply)[0].toString()).toBe(`${label}:test`);
      return guest;
    }));
    expect(guests).toHaveLength(2);
  });

  it('reconnects a dropped host tunnel with the same code and secret', async () => {
    const base = await broker();
    let connections = 0;
    let reconnected!: () => void;
    const secondConnection = new Promise<void>((resolve) => { reconnected = resolve; });
    const agent = new HostTunnelClient({ brokerUrl: base, localUrl: 'ws://127.0.0.1:1', code: codeA,
      roomId: () => null, retryBaseMs: 20, onStatus: (status) => {
        if (!status.startsWith('Relay connected')) return;
        if (++connections === 1) {
          // Fault injection: abruptly lose the agent's network connection, retaining its process identity.
          (agent as unknown as { control: WebSocket }).control.terminate();
        } else reconnected();
      } });
    cleanups.push(() => agent.stop());
    agent.start();
    await secondConnection;
    expect(agent.code).toBe(codeA);
    const result = await fetch(`${base.replace('ws:', 'http:')}/relay/${codeA}/matchmake/joinById/${codeA}`, { method: 'POST', body: '{}' });
    // An active agent without a published room is reachable by the broker, but unavailable to play.
    expect((await result.json()).code).toBe(4411);
  });

  // --- Phase 1 of docs/DIRECT_P2P_PLAN.md: opaque signaling relay for WebRTC negotiation. ---

  it('relays opaque signaling payloads verbatim and isolates concurrent guests', async () => {
    const base = await broker();
    const control = await register(base, codeA);
    const host = collect(control);

    const guestA = await connect(`${base}/relay/${codeA}/signal`);
    const openA = await host.expect((m) => m.type === 'signal-open');
    const guestB = await connect(`${base}/relay/${codeA}/signal`);
    const openB = await host.expect((m) => m.type === 'signal-open' && m.id !== openA.id);

    // Deliberately not JSON, and full of characters an SDP parser would choke on: the broker must
    // forward bytes without understanding them, so the negotiation format can change freely.
    const offer = 'v=0\r\no=- 42 2 IN IP4 127.0.0.1\r\na=candidate:{"not":json} ÿ  end';
    const forwarded = host.expect((m) => m.type === 'signal' && m.id === openA.id);
    guestA.send(offer);
    expect((await forwarded).data).toBe(offer);

    // Host -> guest, delivered only to the addressed channel.
    let strayFrames = 0;
    guestB.on('message', () => { strayFrames += 1; });
    const answer = once(guestA, 'message');
    control.send(JSON.stringify({ type: 'signal', id: openA.id, data: 'answer-sdp' }));
    expect((await answer)[0].toString()).toBe('answer-sdp');
    expect(strayFrames).toBe(0);

    // A guest leaving retracts only its own channel.
    const retracted = host.expect((m) => m.type === 'signal-close' && m.id === openB.id);
    guestB.close();
    await retracted;
    const stillLive = once(guestA, 'message');
    control.send(JSON.stringify({ type: 'signal', id: openA.id, data: 'still-here' }));
    expect((await stillLive)[0].toString()).toBe('still-here');

    // Losing the host tears down every remaining channel with the host-disconnected code.
    const dropped = once(guestA, 'close');
    control.terminate();
    expect((await dropped)[0]).toBe(4410);
  });

  it('rejects signaling for unknown codes, oversized frames, and host-closed channels', async () => {
    const base = await broker();
    const orphan = new WebSocket(`${base}/relay/${codeB}/signal`);
    orphan.on('error', () => undefined);
    cleanups.push(() => orphan.terminate());
    const rejected = once(orphan, 'close');
    expect((await rejected)[0]).toBe(4404);

    const control = await register(base, codeA);
    const host = collect(control);

    const flooder = await connect(`${base}/relay/${codeA}/signal`);
    await host.expect((m) => m.type === 'signal-open');
    const evicted = once(flooder, 'close');
    flooder.send(Buffer.alloc(SIGNAL_MAX_BYTES + 1));
    await evicted;

    // The host can retract a channel it has finished with; the guest socket closes.
    const guest = await connect(`${base}/relay/${codeA}/signal`);
    const opened = await host.expect((m) => m.type === 'signal-open');
    const closed = once(guest, 'close');
    control.send(JSON.stringify({ type: 'signal-close', id: opened.id }));
    await closed;

    // Gameplay and matchmaking routes are untouched by any of the above.
    expect(await (await fetch(base.replace('ws:', 'http:') + '/anything')).text()).toBe('public route');
  });

  it('delivers signaling to a real host agent and back, and reports loss of the tunnel', async () => {
    const base = await broker();
    const opened: string[] = [];
    const received: Array<[string, string]> = [];
    const closed: string[] = [];
    let ready!: () => void;
    const connected = new Promise<void>((resolve) => { ready = resolve; });
    const agent = new HostTunnelClient({
      brokerUrl: base, localUrl: 'ws://127.0.0.1:1', code: codeA, roomId: () => null, retryBaseMs: 20,
      onStatus: (status) => { if (status.startsWith('Relay connected')) ready(); },
      onSignalOpen: (id) => opened.push(id),
      onSignal: (id, data) => received.push([id, data]),
      onSignalClose: (id) => closed.push(id)
    });
    cleanups.push(() => agent.stop());
    agent.start();
    await connected;

    const guest = await connect(`${base}/relay/${codeA}/signal`);
    await until(() => opened.length === 1);

    // Guest -> agent, verbatim.
    guest.send('offer-payload');
    await until(() => received.length === 1);
    expect(received[0]).toEqual([opened[0], 'offer-payload']);

    // Agent -> guest.
    const answer = once(guest, 'message');
    expect(agent.sendSignal(opened[0], 'answer-payload')).toBe(true);
    expect((await answer)[0].toString()).toBe('answer-payload');

    // Bad sends are refused locally rather than tearing down the shared control socket.
    expect(agent.sendSignal(opened[0], 'x'.repeat(SIGNAL_MAX_BYTES + 1))).toBe(false);
    expect(agent.sendSignal('not-a-real-channel', 'ignored')).toBe(false);

    // The agent can retract a channel once negotiation is done; no echo back to itself.
    const retracted = once(guest, 'close');
    agent.closeSignal(opened[0]);
    await retracted;
    expect(agent.sendSignal(opened[0], 'gone')).toBe(false);
    expect(closed).not.toContain(opened[0]);

    // Losing the tunnel reports every channel still riding on it, so a peer can be torn down.
    const survivor = await connect(`${base}/relay/${codeA}/signal`);
    await until(() => opened.length === 2);
    expect(survivor.readyState).toBe(WebSocket.OPEN);
    (agent as unknown as { control: WebSocket }).control.terminate();
    await until(() => closed.includes(opened[1]));
  });

  it('caps host-to-guest signaling without dropping the shared host control connection', async () => {
    const base = await broker();
    const control = await register(base, codeA);
    const host = collect(control);
    const guest = await connect(`${base}/relay/${codeA}/signal`);
    const opened = await host.expect(m => m.type === 'signal-open');
    // Escaped envelope size is larger than the opaque payload's UTF-8 size.
    const echoed = once(guest, 'message');
    control.send(JSON.stringify({ type: 'signal', id: opened.id, data: '\u0000'.repeat(SIGNAL_MAX_BYTES) }));
    expect((await echoed)[0].toString()).toBe('\u0000'.repeat(SIGNAL_MAX_BYTES));
    const closed = once(guest, 'close');
    control.send(JSON.stringify({ type: 'signal', id: opened.id, data: 'x'.repeat(SIGNAL_MAX_BYTES + 1) }));
    await closed;
    expect(control.readyState).toBe(WebSocket.OPEN);
  });
});
