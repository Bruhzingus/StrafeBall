import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { Client } from '@colyseus/sdk';
import { defineServer, defineRoom } from 'colyseus';
import { WebSocket } from 'ws';
import { DuelRoom } from '../../src/rooms/DuelRoom';
import { SpikePeer } from './peer';
import { tickPresetById } from '../../../shared/tickPresets';
import { netModeConfig } from '../../../shared/netConfig';

async function main(): Promise<void> {
  Object.assign(globalThis, { WebSocket });
  const root = resolve(__dirname, '../../..');
  const server = defineServer({ rooms: { duel: defineRoom(DuelRoom) }, gracefullyShutdown: false, greet: false });
  const peer = new SpikePeer([]);
  const vite = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--config',
    resolve(root, 'spikes/direct-p2p/vite.config.ts'), '--port', '5174', '--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  vite.stderr?.on('data', (data) => process.stderr.write(data));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Vite startup timeout')), 15_000);
      vite.stdout?.on('data', (data) => { if (data.toString().includes('5174')) { clearTimeout(timer); resolveReady(); } });
      vite.once('exit', () => { clearTimeout(timer); reject(new Error('Vite exited')); });
    });
    await server.listen(0, '127.0.0.1');
    const port = (server.transport.server!.address() as { port: number }).port;
    const host = await new Client(`ws://127.0.0.1:${port}`).create('duel', { name: 'Spike host', tickPresetId: 'high' });
    host.onMessage('*', () => undefined);
    host.reconnection.enabled = false;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // tsx preserves function names with this helper, including functions serialized by Playwright.
    await page.addInitScript('window.__name = (value) => value;');
    page.on('pageerror', (error) => console.error('BROWSER ERROR', error.message));
    await page.goto('http://127.0.0.1:5174/?no-stun');
    await page.waitForFunction(() => Boolean((window as any).p2pSpike));
    // Copy the full SDP descriptions between peers. No signaling endpoints or broker integration.
    const offer = await page.evaluate(() => (window as any).p2pSpike.offer());
    const answer = await peer.answer(offer);
    await page.evaluate((value) => (window as any).p2pSpike.answer(value), answer);
    await page.evaluate((path) => { (window as any).spikeCodecPath = path; }, resolve(root, 'shared/snapshotCodec.ts').replaceAll('\\', '/'));
    await page.evaluate(async (roomId) => {
      const modulePath = '/@fs/' + (window as any).spikeCodecPath;
      const codec = await import(/* @vite-ignore */ modulePath);
      const spike = (window as any).p2pSpike;
      const room = await spike.join(roomId, 'Chromium guest');
      room.onMessage('*', () => undefined);
      (window as any).snapshots = 0;
      let previous: any = null;
      room.onMessage('snapshot', (message: any) => {
        (window as any).snapshots++;
        previous = codec.isTieredCompactSnapshot(message)
          ? codec.mergeTieredCompactSnapshot(message, previous, room.sessionId)?.snapshot ?? previous
          : codec.isCompactSnapshot(message) ? codec.inflateCompactSnapshot(message) : message;
        (window as any).played = (window as any).played || previous?.room.phase === 'live';
        (window as any).ack = previous?.room.players[room.sessionId]?.lastProcessedInputSeq ?? 0;
      });
      (window as any).lastPong = null;
      room.onMessage('pong', (value: unknown) => (window as any).lastPong = value);
      room.send('ping', { clientTimeMs: Date.now() });
    }, host.roomId);
    await page.waitForFunction(() => (window as any).snapshots > 10 && (window as any).lastPong);
    host.send('start-match', {});
    // Sustained real Colyseus input and pong traffic at the high preset's 128Hz input rate.
    await page.evaluate((inputRate) => {
      const spike = (window as any).p2pSpike;
      let sequence = 0;
      const period = 1000 / inputRate;
      let next = performance.now();
      const sendInput = () => {
        spike.room.send('input', { sequence: ++sequence, clientTimeMs: Date.now(), input: { moveX: sequence % 256 < 128 ? 1 : -1, moveZ: 0, lookYawRadians: 0, lookPitchRadians: 0 } });
        next = Math.max(next + period, performance.now());
        (window as any).inputTimer = setTimeout(sendInput, Math.max(0, next - performance.now()));
      };
      sendInput();
      (window as any).pingTimer = setInterval(() => spike.room.send('ping', { clientTimeMs: Date.now() }), 1000);
    }, netModeConfig(tickPresetById('high').netMode)!.clientInputRate);
    await new Promise((resolveRun) => setTimeout(resolveRun, Number(process.env.P2P_SPIKE_SECONDS ?? 20) * 1000));
    const report = await page.evaluate(async () => {
      clearInterval((window as any).inputTimer); clearInterval((window as any).pingTimer);
      return { ...await (window as any).p2pSpike.report(), snapshots: (window as any).snapshots,
        played: (window as any).played, acknowledgedInput: (window as any).ack,
        networkScope: 'single-machine loopback; NOT a Phase 0 gate pass' };
    });
    assert.ok(report.count >= 10, 'Must receive application pongs over the DataChannel');
    assert.ok(report.snapshots > 30, 'Must receive real DuelRoom snapshots');
    assert.equal(report.played, true, 'Match must enter playing phase');
    assert.ok(report.acknowledgedInput > 100, 'Server must acknowledge gameplay input');
    await mkdir(resolve(root, 'tmp'), { recursive: true });
    await writeFile(resolve(root, 'tmp/p2p-spike-loopback.json'), JSON.stringify(report, null, 2));
    console.log('SPIKE RESULT ' + JSON.stringify({ samples: report.count, snapshots: report.snapshots,
      medianMs: report.medianMs, p95Ms: report.p95Ms, maxMs: report.maxMs, scope: report.networkScope }));
    await page.evaluate(async () => { await (window as any).p2pSpike.room.leave(); });
    await host.leave();
  } finally {
    await browser?.close();
    await peer.close();
    await server.gracefullyShutdown(false);
    vite.kill();
    if (vite.exitCode === null) await once(vite, 'exit');
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
