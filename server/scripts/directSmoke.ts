import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { chromium, type Page } from 'playwright';
import { Client } from '@colyseus/sdk';
import { WebSocket } from 'ws';

const root = resolve(__dirname, '../..');
const children: ChildProcess[] = [];
async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(r => server.close(() => r()));
  return port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await once(killer, 'exit');
  } else { child.kill(); await once(child, 'exit'); }
}
async function launch(args: string[], env: Record<string, string>, ready: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: 'pipe' });
  children.push(child);
  await new Promise<void>((done, reject) => {
    let log = '';
    const timeout = setTimeout(() => reject(new Error(log || 'Startup timeout')), 20_000);
    const read = (data: Buffer) => { log += data.toString(); if (log.includes(ready)) { clearTimeout(timeout); done(); } };
    child.stdout!.on('data', read); child.stderr!.on('data', read);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(log)); });
  });
  return child;
}
async function main(): Promise<void> {
  Object.assign(globalThis, { WebSocket });
  const brokerPort = await freePort();
  const hostPort = await freePort();
  const vitePort = await freePort();
  const brokerUrl = `ws://127.0.0.1:${brokerPort}`;
  const hostHttp = `http://127.0.0.1:${hostPort}`;
  const tsx = resolve(root, 'server/node_modules/tsx/dist/cli.mjs');
  await launch([tsx, 'server/src/index.ts'], { PORT: String(brokerPort) }, 'Colyseus server listening');
  const hostProcess = await launch([tsx, 'server/src/index.ts', '--private-host'], {
    PORT: String(hostPort), HOST_OPEN_BROWSER: '0', DIRECT_NO_STUN: '1', RELAY_BROKER_URL: brokerUrl
  }, 'Relay connected');
  await launch(['node_modules/vite/bin/vite.js', '--config', 'spikes/direct-p2p/vite.config.ts', '--port', String(vitePort), '--strictPort'], {}, String(vitePort));
  const code = (await (await fetch(`${hostHttp}/private-host/config`)).json()).code;
  const browser = await chromium.launch({ headless: true });
  const results: object[] = [];
  try {
    for (const mode of ['direct', 'direct-2v2', 'blocked-ice', 'relay-only', 'host-death']) {
      const is2v2 = mode === 'direct-2v2';
      const host = await new Client(hostHttp.replace('http:', 'ws:')).create('duel', {
        name: 'Host', tickPresetId: 'high', format: is2v2 ? '2v2' : '1v1'
      });
      host.reconnection.enabled = false; host.onMessage('*', () => undefined);
      const publication = await fetch(`${hostHttp}/private-host/publish`, { method: 'POST', headers: {
        'Content-Type': 'application/json', Origin: hostHttp
      }, body: JSON.stringify({ roomId: host.roomId, sessionId: host.sessionId }) });
      assert.equal(publication.status, 200);
      const guests: Array<{ page: Page; joined: { path: string; elapsedMs: number; sessionId: string } }> = [];
      for (let guestIndex = 0; guestIndex < (is2v2 ? 3 : 1); guestIndex++) {
      const page = await browser.newPage();
      await page.addInitScript('window.__name = value => value;');
      await page.goto(`http://127.0.0.1:${vitePort}/?no-stun`);
      const joined = await page.evaluate(async ({ modulePath, codecPath, brokerUrl, code, mode }) => {
        const { joinPrivateHost, roomConnectionPath, roomConnectionDiagnostics } = await import(/* @vite-ignore */ modulePath);
        const codec = await import(/* @vite-ignore */ codecPath);
        const original = window.RTCPeerConnection;
        if (mode === 'blocked-ice') window.RTCPeerConnection = class extends original {
          constructor(config: RTCConfiguration) { super({ ...config, iceTransportPolicy: 'relay' }); }
        };
        const started = performance.now();
        const room = await joinPrivateHost(brokerUrl, code, 'Browser guest', new AbortController().signal,
          { stunUrls: [], relayOnly: mode === 'relay-only' });
        window.RTCPeerConnection = original;
        room.onMessage('*', () => undefined);
        Object.assign(window, { directRoom: room, snapshots: 0, pongs: [], closedCode: null,
          connectionDiagnostics: () => roomConnectionDiagnostics(room) });
        let previous: any = null;
        room.onMessage('snapshot', (message: any) => {
          (window as any).snapshots++;
          previous = codec.isTieredCompactSnapshot(message) ? codec.mergeTieredCompactSnapshot(message, previous, room.sessionId)?.snapshot ?? previous
            : codec.isCompactSnapshot(message) ? codec.inflateCompactSnapshot(message) : message;
          (window as any).live = (window as any).live || previous?.room.phase === 'live';
          (window as any).ack = previous?.room.players[room.sessionId]?.lastProcessedInputSeq ?? 0;
          (window as any).teamChoices = previous?.room.startVote.teamChoiceCount ?? 0;
          (window as any).playerCount = Object.keys(previous?.room.players ?? {}).length;
        });
        room.onMessage('pong', (pong: { clientTimeMs: number }) => (window as any).pongs.push(Date.now() - pong.clientTimeMs));
        room.onLeave((code: number) => { (window as any).closedCode = code; });
        let sequence = 0;
        const input = setInterval(() => room.send('input', { sequence: ++sequence, clientTimeMs: Date.now(), input: { moveX: 1, moveZ: 0 } }), 10);
        room.onLeave(() => clearInterval(input));
        room.send('ping', { clientTimeMs: Date.now() });
        return { path: roomConnectionPath(room), elapsedMs: performance.now() - started, sessionId: room.sessionId };
      }, { modulePath: '/@fs/' + resolve(root, 'src/game/network/directSession.ts').replaceAll('\\', '/'),
        codecPath: '/@fs/' + resolve(root, 'shared/snapshotCodec.ts').replaceAll('\\', '/'), brokerUrl, code, mode });
      assert.equal(joined.path, mode === 'blocked-ice' || mode === 'relay-only' ? 'relay' : 'direct');
      if (mode === 'blocked-ice') assert.ok(joined.elapsedMs < 10_000, 'ICE failure or budget then relay');
      await page.waitForFunction(() => (window as any).snapshots > 10 && (window as any).pongs.length > 0);
      guests.push({ page, joined });
      }
      if (is2v2) {
        host.send('switch-team', { teamId: 'blue', teamSlotIndex: 0 });
        for (let i = 0; i < guests.length; i++) {
          await guests[i].page.evaluate(({ teamId, teamSlotIndex }) => {
            (window as any).directRoom.send('switch-team', { teamId, teamSlotIndex });
          }, { teamId: i === 1 ? 'blue' : 'red', teamSlotIndex: i === 0 ? 0 : 1 });
        }
        await guests[0].page.waitForFunction(() => (window as any).teamChoices === 4 && (window as any).playerCount === 4);
      }
      host.send('start-match', {});
      for (const { page, joined } of guests) {
      await page.waitForFunction(() => (window as any).live && (window as any).ack > 100);
      if (joined.path === 'direct') await page.waitForFunction(() => (window as any).connectionDiagnostics().networkRttMs !== null);
      const diagnostics = await page.evaluate(() => (window as any).connectionDiagnostics());
      if (mode === 'blocked-ice') assert.ok(['timeout', 'ice'].includes(diagnostics.relayReason), 'explain ICE fallback');
      if (mode === 'relay-only') assert.equal(diagnostics.relayReason, 'requested');
      if (joined.path === 'direct') {
        assert.equal(diagnostics.networkProtocol, 'udp');
        assert.ok(Number.isFinite(diagnostics.networkRttMs) && diagnostics.networkRttMs >= 0);
      }
      if (mode === 'host-death') {
        await stop(hostProcess);
        await page.waitForFunction(() => (window as any).closedCode !== null, undefined, { timeout: 15_000 });
        assert.equal(await page.evaluate(() => (window as any).closedCode), 4410);
      } else {
        const closeCode = await page.evaluate(() => (window as any).directRoom.leave());
        assert.equal(closeCode, 4000);
      }
      results.push({ mode, ...joined, diagnostics });
      console.log('PASS ' + JSON.stringify({ mode, path: joined.path, elapsedMs: Math.round(joined.elapsedMs), diagnostics }));
      await page.close();
      }
      if (mode !== 'host-death') await host.leave();
    }
    await mkdir(resolve(root, 'tmp'), { recursive: true });
    await writeFile(resolve(root, 'tmp/direct-integration.json'), JSON.stringify({ scope: 'loopback integration, not cross-network acceptance', results }, null, 2));
  } finally { await browser.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { for (const child of children.reverse()) await stop(child); });
