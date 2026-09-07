import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Client, type Room } from '@colyseus/sdk';
import { HostSessionClient } from '../../src/game/network/hostSession';

const root = resolve(__dirname, '../..');
const processes: ChildProcess[] = [];
const rooms: Room[] = [];
let brokerUrl: string;
let hostUrl: string;
let hostPort: number;
let code: string;
let hostProcess: ChildProcess;
async function freePort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}
async function start(port: number, host = false): Promise<{ process: ChildProcess; code?: string }> {
  const child = spawn(process.execPath, [resolve(root, 'server/node_modules/tsx/dist/cli.mjs'),
    resolve(root, 'server/src/index.ts'), ...(host ? ['--private-host'] : [])], {
    cwd: root, windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST_CLIENT_DIR: resolve(root, 'dist'), RELAY_BROKER_URL: brokerUrl },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processes.push(child);
  return new Promise((resolve, reject) => {
    let log = '';
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${log}`)), 15_000);
    const inspect = (data: Buffer) => {
      log += data.toString();
      const match = /Share code: (HOST-[A-F0-9]{16})/.exec(log);
      if (host ? match : log.includes('Colyseus server listening')) {
        clearTimeout(timeout);
        resolve({ process: child, code: match?.[1] });
      }
    };
    child.stdout!.on('data', inspect);
    child.stderr!.on('data', inspect);
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${log}`)); });
  });
}

beforeAll(async () => {
  const brokerPort = await freePort();
  brokerUrl = `ws://127.0.0.1:${brokerPort}`;
  await start(brokerPort);
  hostPort = await freePort();
  hostUrl = `ws://127.0.0.1:${hostPort}`;
  const host = await start(hostPort, true);
  hostProcess = host.process;
  code = host.code!;
}, 30_000);

afterAll(async () => {
  for (const room of rooms) { room.reconnection.enabled = false; room.connection.close(); }
  for (const child of processes) {
    // tsx launches a child runtime; kill the process tree on Windows to avoid orphan test servers.
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await once(killer, 'exit');
    } else child.kill('SIGTERM');
  }
});

it('joins an unmodified DuelRoom through the relay, exchanges snapshots/pong, preserves public room types, and handles host death', async () => {
  for (const type of ['duel', 'course', 'coop']) {
    const room = await new Client(brokerUrl).create(type, { name: 'Public regression', courseJson: JSON.stringify({ version: 1, objects: [] }) });
    room.onMessage('*', () => undefined);
    rooms.push(room);
    expect(room.roomId).toBeTruthy();
    const joiner = await new Client(brokerUrl).joinById(room.roomId, { name: 'Public joiner' });
    joiner.onMessage('*', () => undefined);
    rooms.push(joiner);
    expect(joiner.roomId).toBe(room.roomId);
    await joiner.leave();
    await room.leave();
  }
  const html = await (await fetch(hostUrl.replace('ws:', 'http:') + '/')).text();
  expect(html).toContain(`window.__STRAFEBALL_HOST__={"code":"${code}"`);
  const host = await new Client(hostUrl).create('duel', { name: 'Local host', tickPresetId: 'high' });
  rooms.push(host);
  host.onMessage('*', () => undefined);
  const publish = await fetch(hostUrl.replace('ws:', 'http:') + '/private-host/publish', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${hostPort}` },
    body: JSON.stringify({ roomId: host.roomId, sessionId: host.sessionId })
  });
  expect(publish.status).toBe(200);
  const guest = await new HostSessionClient(`${brokerUrl}/relay/${code}`).joinById(code, { name: 'Remote guest' });
  rooms.push(guest);
  guest.onMessage('*', () => undefined);
  expect(guest.roomId).toBe(host.roomId);
  expect(guest.sessionId).not.toBe(host.sessionId);
  await expect(new HostSessionClient(`${brokerUrl}/relay/HOST-AAAAAAAAAAAAAAAA`)
    .joinById('HOST-AAAAAAAAAAAAAAAA', { name: 'Bad code' })).rejects.toThrow('Invalid or expired host code');
  await expect(new HostSessionClient(`${brokerUrl}/relay/${code}`).joinById(code, { name: 'Full' })).rejects.toThrow(/full|seat|locked/i);
  const snapshot = new Promise((resolve) => guest.onMessage('snapshot', resolve));
  expect(await snapshot).toBeTruthy();
  const pong = new Promise<{ clientTimeMs: number }>((resolve) => guest.onMessage('pong', resolve));
  guest.send('ping', { clientTimeMs: 123 });
  expect((await pong).clientTimeMs).toBe(123);
  const closed = new Promise<number>((resolve) => guest.onLeave(resolve));
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(hostProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await once(killer, 'exit');
  } else hostProcess.kill('SIGTERM');
  expect(await closed).toBe(4410);
}, 20_000);
