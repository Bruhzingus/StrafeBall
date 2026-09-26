/** Review real Hud debug rendering with deterministic game state; run Vite on :5173 first. */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const out = 'tmp/debug-review';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
const bounds = [];
const errors = [];
const check = (name, passed) => {
  checks.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  assert.ok(passed, name);
};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  const head = readFileSync('index.html', 'utf8').match(/<head>([\s\S]*?)<\/head>/)[1];
  await page.route('**/debug-review', route => route.fulfill({ contentType: 'text/html', body: `<html><head>${head}</head><body></body></html>` }));
  await page.goto('http://127.0.0.1:5173/debug-review');
  await page.evaluate(async () => {
    const { Hud } = await import('/src/game/ui/Hud.ts');
    const { createRoomState } = await import('/shared/simulation/MatchSim.ts');
    const { createPlayerState } = await import('/shared/simulation/PlayerSim.ts');
    const room = createRoomState({ id: 'diagnostics-room-with-long-identifier', netMode: 'high',
      players: [createPlayerState('p0', 'blue'), createPlayerState('p1', 'red')] });
    room.match.status = 'playing';
    room.players.p0.movement.speed = 12.4;
    room.players.p0.movement.velocity = { x: -12.4, y: 2.1, z: 0.5 };
    window.debugSnapshot = { type: 'snapshot', room, tick: 120048, serverTimeMs: 2000000 };
    window.debugNet = {
      snapshotRateHz: 48, renderSnapshotRateHz: 47.8, inputSeq: 98120, lastAckedSeq: 98116,
      pendingInputs: 4, predictionErrorM: .453, residualAfterReplayM: .085, expectedLeadM: .43,
      desyncAverageM: .016, desyncRecentMaxM: .115, desyncPeakM: .235, ackAgeMs: 58,
      pingJitterMs: 4.2, connectionPath: 'direct', lastPongAgeMs: 420, missedPongs: 1,
      socketBufferedAmount: 1234, socketBufferedPeak: 5120, pingSendBufferedAmount: 260,
      rttEstimateMs: 42, maxRecentPingMs: 65, serverOutBufferedB: 32768, serverLoopP95Ms: 12.3,
      predictionActive: true
    };
    const hand = { ball: null, charging: false, catchStance: false, cooldown: 0, chargeSeconds: 0 };
    const player = {
      lastMovementSnapshot: { ...room.players.p0.movement, bhopGraceTimer: .12, wallRunTimer: 0, frictionMode: 'ground' },
      hands: { left: { ...hand }, right: { ...hand }, hasTwoBalls: () => false, lastAction: 'Caught a dodgeball' },
      backflip: { cooldown: 1.2, active: false },
      dash: { maxCharges: 3, rechargeSeconds: 2, charges: 2, rechargeTimer: .5 },
      catching: { getParryCooldown: () => 0 }
    };
    const rules = { boundary: { elapsed: 0, noBoundaries: false, illegalCountdownActive: false, illegalCountdownSeconds: 0, illegalCrossWarnings: 0, opponentPenaltyHits: 0 }, scoring: { playerHits: 0 } };
    document.body.style.background = '#29415d';
    window.debugHud = new Hud(document.body);
    window.debugHud.setVisible(false);
    window.debugHud.toggleDebug();
    window.debugUpdate = (mode, fps = 120) => {
      if (mode === 'online') window.debugHud.updateNetwork(window.debugSnapshot, 'p0', fps, 8.3, 47, window.debugNet);
      else window.debugHud.update(player, rules, { balls: [] }, fps, 8.3);
    };
    window.debugUpdate('offline');
  });
  await page.evaluate(() => document.fonts.ready);
  const panel = page.locator('.hud-debug-panel');
  check('Debug uses the shared dark surface and readable text', await panel.evaluate(el => {
    const style = getComputedStyle(el);
    return style.backgroundColor === 'rgb(7, 23, 46)' && style.color === 'rgb(243, 240, 231)' && style.transform === 'none';
  }));
  check('Offline diagnostics retain all movement and performance fields', await panel.evaluate(el => {
    const labels = [...el.querySelectorAll('dt')].map(row => row.textContent);
    return ['Frame rate', 'Tick / snapshot', 'Speed', 'Velocity (x/y/z)', 'State', 'Contact', 'Friction', 'Bunny hop', 'Wall run', 'Stamina', 'Backflip cooldown', 'Last action'].every(label => labels.includes(label));
  }));
  for (const mode of ['offline', 'online']) {
    await page.evaluate(mode => window.debugUpdate(mode), mode);
    for (const [width, height] of [[1440, 900], [800, 600], [390, 844], [1280, 600]]) {
      await page.setViewportSize({ width, height });
      const measurement = await panel.evaluate(el => {
        const r = el.getBoundingClientRect();
        return { mode: el.dataset.mode, viewport: [innerWidth, innerHeight], width: r.width, height: r.height,
          inBounds: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
          noHorizontalOverflow: el.scrollWidth <= el.clientWidth,
          allValuesFit: [...el.querySelectorAll('dt, dd')].every(value => value.scrollWidth <= value.clientWidth + 1) };
      });
      bounds.push(measurement);
      await page.screenshot({ path: `${out}/${mode}-${width}x${height}.png` });
    }
  }
  check('Both debug modes fit every viewport without horizontal scrolling', bounds.every(value => value.inBounds && value.noHorizontalOverflow && value.allValuesFit));
  check('Local diagnostics occupy less space than network diagnostics', bounds.find(value => value.mode === 'offline').width < bounds.find(value => value.mode === 'online').width);
  check('Online diagnostics retain session, network and reconciliation fields', await panel.evaluate(el => {
    const labels = [...el.querySelectorAll('dt')].map(row => row.textContent);
    return ['Frame rate', 'Room', 'Players', 'Tick / snapshot', 'Server tick', 'Connection', 'Ping', 'Recent max / RTT', 'Jitter', 'Snapshot recv / render', 'Ack age', 'Pong age / missed', 'Socket buffer', 'Peak / at ping', 'Prediction', 'Raw / expected lead', 'Desync after replay', 'Average / recent max', 'Peak desync', 'Input seq / acked', 'Pending inputs', 'Server loop p95', 'Server out buffer', 'Player interpolation', 'Ball interpolation', 'Speed', 'Velocity (x/y/z)'].every(label => labels.includes(label));
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  check('Tall diagnostics scroll vertically', await panel.evaluate(el => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop > 0;
  }));
  const beforeScroll = await panel.evaluate(el => el.scrollTop);
  await page.waitForTimeout(220);
  await page.evaluate(() => window.debugUpdate('online', 117));
  check('Live values update without resetting the scroll position', await panel.evaluate((el, previous) => Math.abs(el.scrollTop - previous) <= 1 && el.textContent.includes('117 FPS'), beforeScroll));
  check('Header remains accessible while diagnostics scroll', await panel.evaluate(el => {
    const panelRect = el.getBoundingClientRect();
    const headerRect = el.querySelector('.hud-debug__header').getBoundingClientRect();
    return headerRect.top >= panelRect.top && headerRect.bottom < panelRect.bottom;
  }));
  check('Rapid frame updates do not rebuild debug content', await page.evaluate(() => {
    window.debugHud.nextDebugUpdateMs = 0;
    window.debugUpdate('online', 120);
    const before = document.querySelector('.hud-debug__section');
    for (let i = 0; i < 10; i += 1) window.debugUpdate('online', 130 + i);
    return before === document.querySelector('.hud-debug__section');
  }));
  await panel.locator('button').click();
  check('Debug close button hides the panel', await panel.isHidden());
  check('Hidden diagnostics do not update', await page.evaluate(() => {
    const before = document.querySelector('.hud-debug__content').innerHTML;
    window.debugUpdate('online', 99);
    return before === document.querySelector('.hud-debug__content').innerHTML;
  }));
  await page.evaluate(() => { window.debugHud.toggleDebug(); window.debugUpdate('online', 99); });
  check('Reopening refreshes diagnostics immediately', (await panel.textContent()).includes('99 FPS'));
  check('No browser runtime errors', errors.length === 0);
} finally {
  writeFileSync(`${out}/results.json`, JSON.stringify({ checks, bounds, errors }, null, 2));
  await browser.close();
}
