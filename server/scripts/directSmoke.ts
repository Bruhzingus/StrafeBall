import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
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
    for (const mode of ['direct', 'blocked-ice', 'relay-only', 'host-death']) {
      const host = await new Client(hostHttp.replace('http:', 'ws:')).create('duel', { name: 'Host', tickPresetId: 'high' });
      host.reconnection.enabled = false; host.onMessage('*', () => undefined);
      const publication = await fetch(`${hostHttp}/private-host/publish`, { method: 'POST', headers: {
        'Content-Type': 'application/json', Origin: hostHttp
      }, body: JSON.stringify({ roomId: host.roomId, sessionId: host.sessionId }) });
      assert.equal(publication.status, 200);
      const page = await browser.newPage();
      await page.addInitScript('window.__name = value => value;');
      await page.goto(`http://127.0.0.1:${vitePort}/?no-stun`);
      const joined = await page.evaluate(async ({ modulePath, codecPath, brokerUrl, code, mode }) => {
        const { joinPrivateHost, roomConnectionPath } = await import(/* @vite-ignore */ modulePath);
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
        Object.assign(window, { directRoom: room, snapshots: 0, pongs: [], closedCode: null });
        let previous: any = null;
        room.onMessage('snapshot', (message: any) => {
          (window as any).snapshots++;
          previous = codec.isTieredCompactSnapshot(message) ? codec.mergeTieredCompactSnapshot(message, previous, room.sessionId)?.snapshot ?? previous
            : codec.isCompactSnapshot(message) ? codec.inflateCompactSnapshot(message) : message;
          (window as any).live = (window as any).live || previous?.room.phase === 'live';
          (window as any).ack = previous?.room.players[room.sessionId]?.lastProcessedInputSeq ?? 0;
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
      if (mode === 'blocked-ice') assert.ok(joined.elapsedMs >= 4900 && joined.elapsedMs < 10_000, 'ICE budget then relay');
      await page.waitForFunction(() => (window as any).snapshots > 10 && (window as any).pongs.length > 0);
      host.send('start-match', {});
      await page.waitForFunction(() => (window as any).live && (window as any).ack > 100);
      if (mode === 'host-death') {
        await stop(hostProcess);
        await page.waitForFunction(() => (window as any).closedCode !== null, { timeout: 15_000 });
        assert.equal(await page.evaluate(() => (window as any).closedCode), 4410);
      } else {
        const closeCode = await page.evaluate(() => (window as any).directRoom.leave());
        assert.equal(closeCode, 4000);
        await host.leave();
      }
      results.push({ mode, ...joined });
      console.log('PASS ' + JSON.stringify({ mode, path: joined.path, elapsedMs: Math.round(joined.elapsedMs) }));
      await page.close();
    }
    await mkdir(resolve(root, 'tmp'), { recursive: true });
    await writeFile(resolve(root, 'tmp/direct-integration.json'), JSON.stringify({ scope: 'loopback integration, not cross-network acceptance', results }, null, 2));
  } finally { await browser.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { for (const child of children.reverse()) await stop(child); });
