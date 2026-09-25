/** Review actual room components with deterministic snapshots. Run Vite on :5173 first. */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const out = 'tmp/team-room-review';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const head = readFileSync('index.html', 'utf8').match(/<head>([\s\S]*?)<\/head>/)[1];
await page.route('**/team-room-review', route => route.fulfill({ contentType: 'text/html', body: `<html><head>${head}</head><body></body></html>` }));
await page.goto('http://127.0.0.1:5173/team-room-review');
await page.evaluate(async () => {
  await import('/src/style.css');
  await import('/src/game/ui/competitive.css');
  const { MultiplayerOverlay } = await import('/src/game/network/MultiplayerOverlay.ts');
  const { createRoomState, createStartVoteState } = await import('/shared/simulation/MatchSim.ts');
  const { createPlayerState } = await import('/shared/simulation/PlayerSim.ts');
  const { createMatchState } = await import('/shared/simulation/RuleSim.ts');
  const { defaultRoomSettings } = await import('/shared/roomSettings.ts');
  const style = document.createElement('style');
  style.textContent = 'body { background: #14243a url(/scripts/shots/phase2-polished-gym-spawn.png) center / cover; }';
  document.head.append(style);
  window.reviewCalls = [];
  window.reviewFixture = count => {
    const players = ['Randall', 'A teammate with a long name', 'Jordan', 'Alex'].slice(0, count)
      .map((name, i) => createPlayerState(`p${i}`, i < 2 ? 'blue' : 'red', 'negativeZ', { name, teamSlotIndex: i % 2 }));
    return createRoomState({ id: 'internal', players, settings: defaultRoomSettings('2v2'), hostPlayerId: 'p0',
      match: createMatchState('review', ['blue', 'red'], { mode: '2v2', status: 'warmup', playersPerTeam: 2, maxPlayers: 4 }),
      startVote: createStartVoteState({ requiredVotes: count > 2 ? 3 : 0, requiredTeamChoices: count, teamChoiceCount: count,
        teamChoicesByPlayerId: Object.fromEntries(players.map(p => [p.id, true])) }) });
  };
  window.reviewClient = { connected: true, status: 'connected', localPlayerId: 'p0', roomId: 'hhEvuLVpG', pingMs: 47,
    connectionPath: 'public', errorMessage: '', latestSnapshot: { room: window.reviewFixture(1) },
    requestSwitchTeam: (...args) => window.reviewCalls.push(['switch', ...args]),
    requestStartVote: () => window.reviewCalls.push(['ready']),
    requestRoomSettings: patch => window.reviewCalls.push(['settings', patch]),
    requestEndVote: () => window.reviewCalls.push(['end']),
    requestReset: mode => window.reviewCalls.push(['reset', mode]),
    requestIntermissionVote: mode => window.reviewCalls.push(['intermission', mode]),
    leave: () => { window.reviewClient.connected = false; window.reviewClient.latestSnapshot = null; }
  };
  window.reviewOverlay = new MultiplayerOverlay(window.reviewClient, { setLockSuppressed: value => window.reviewSuppressed = value });
  document.querySelectorAll('.multiplayer-modal').item(document.querySelectorAll('.multiplayer-modal').length - 1).classList.add('review-room');
});
const root = page.locator('.review-room');
await page.evaluate(() => document.fonts.ready);
const checks = [];
const check = (name, passed) => { checks.push({ name, passed }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); assert.ok(passed, name); };
check('A new team room opens with one primary action', await root.locator('.multiplayer-start-vote:visible').count() === 1 && await root.locator('[data-action="start-match"]:visible').count() === 0);
check('Solo room cannot ready up', await root.locator('.multiplayer-start-vote').isDisabled());
await page.screenshot({ path: `${out}/solo.png` });
await root.locator('[data-team-id="red"][data-slot-index="0"]').click();
check('Open slot sends its exact team and slot', await page.evaluate(() => JSON.stringify(window.reviewCalls.pop()) === '["switch","red",0]'));
await root.locator('[data-action="open-settings"]').click();
check('Settings opens', await root.locator('.multiplayer-settings-menu').isVisible());
check('Settings has no competing start action', await root.locator('[data-action="start-match"]:visible').count() === 0);
await root.locator('[data-action="close-settings"]').last().click();
check('Back from settings restores the lineup', await root.locator('.team-room-team').first().isVisible());
await root.locator('[data-action="open-settings"]').click();
await page.keyboard.press('Escape');
check('Escape returns from settings to the lineup', await root.locator('.team-room-team').first().isVisible() && await root.locator('[data-action="open-settings"]').evaluate(el => el === document.activeElement));
await root.locator('.team-room-resume').click();
check('Warmup collapses the sheet and releases input', await root.locator('.team-room-manage').isVisible() && await page.evaluate(() => !window.reviewSuppressed));
await page.screenshot({ path: `${out}/compact.png` });
await root.locator('.team-room-manage').click();
await page.evaluate(() => { window.reviewClient.latestSnapshot.room = window.reviewFixture(4); window.reviewOverlay.update(); });
check('Full confirmed teams can ready up', await root.locator('.multiplayer-start-vote').isEnabled());
await root.locator('.multiplayer-start-vote').click();
check('Ready action sends a start vote', await page.evaluate(() => window.reviewCalls.pop()[0] === 'ready'));
await page.evaluate(() => { const vote = window.reviewClient.latestSnapshot.room.startVote; vote.votesByPlayerId = { p0: true }; vote.voteCount = 1; window.reviewOverlay.update(); });
check('Ready feedback disables duplicate votes', await root.locator('.multiplayer-start-vote').isDisabled() && await root.locator('.team-room-player--ready').count() === 1);
const bounds = [];
for (const [width, height] of [[1920, 1080], [1440, 900], [1366, 768], [800, 600], [390, 844]]) {
  await page.setViewportSize({ width, height });
  await page.screenshot({ path: `${out}/teams-${width}x${height}.png` });
  bounds.push(await root.locator('.multiplayer-panel--lobby').evaluate(el => {
    const r = el.getBoundingClientRect();
    return { viewport: [innerWidth, innerHeight], inBounds: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      noHorizontalOverflow: el.scrollWidth <= el.clientWidth };
  }));
}
check('Lineup fits desktop and narrow screens', bounds.every(b => b.inBounds && b.noHorizontalOverflow));
await page.setViewportSize({ width: 1440, height: 900 });
await root.locator('[data-team-id="red"][data-slot-index="0"]').focus();
check('Ping refresh preserves the focused DOM button', await page.evaluate(() => {
  const before = document.activeElement; window.reviewClient.pingMs = 52; window.reviewOverlay.update(); return before === document.activeElement;
}));
await root.locator('.multiplayer-leave').focus();
await page.keyboard.press('Tab');
check('Keyboard focus wraps within the room', await root.locator('.multiplayer-close').evaluate(el => el === document.activeElement));
await page.evaluate(() => {
  const room = window.reviewClient.latestSnapshot.room;
  room.startVote.votesByPlayerId = {}; room.startVote.voteCount = 0;
  room.startVote.teamChoicesByPlayerId = { p0: true, p1: true, p2: true }; room.startVote.teamChoiceCount = 3;
  window.reviewOverlay.update();
});
check('Unconfirmed teams block the ready action with guidance', await root.locator('.multiplayer-start-vote').isDisabled() && (await root.locator('.multiplayer-start-vote-hint').textContent()).includes('confirm a team'));
await page.evaluate(() => {
  const room = window.reviewClient.latestSnapshot.room;
  room.players.p3.connected = false; room.players.p3.reconnectDeadlineAtMs = Date.now() + 15000;
  window.reviewOverlay.update();
});
check('Disconnected slot shows reconnecting', (await root.locator('.team-room-player').last().textContent()).includes('Reconnecting'));
await page.evaluate(() => { window.reviewClient.latestSnapshot.room = window.reviewFixture(4); window.reviewClient.localPlayerId = 'p2'; window.reviewOverlay.update(); });
await root.locator('[data-action="open-settings"]').click();
check('Guest settings cannot send host edits', await root.locator('.multiplayer-settings-menu .multiplayer-step').count() === 0);
await page.keyboard.press('Escape');
check('Guest sees their own team highlighted', (await root.locator('.team-room-team--red .team-room-team__header').textContent()).includes('YOUR TEAM'));
await page.evaluate(() => { window.reviewClient.localPlayerId = 'p0'; window.reviewOverlay.update(); });
await page.evaluate(() => { window.reviewClient.latestSnapshot.room.match.status = 'playing'; window.reviewOverlay.update(); });
check('Live transition hides the room and releases input', await root.isHidden() && await page.evaluate(() => !window.reviewSuppressed));
await page.evaluate(() => window.reviewOverlay.openRoomMenu());
check('Live room controls remain accessible', await root.locator('[data-action="end-vote"]').isVisible());
await page.screenshot({ path: `${out}/live-controls.png` });
await page.evaluate(() => { window.reviewClient.latestSnapshot.room.match.status = 'complete'; window.reviewOverlay.update(); });
await root.locator('.multiplayer-report-card').waitFor({ state: 'visible', timeout: 6000 });
check('Postmatch report still appears after celebration', await root.locator('.multiplayer-report-card').isVisible());
await page.screenshot({ path: `${out}/postmatch.png` });
await page.evaluate(() => {
  window.reviewClient.latestSnapshot.room = window.reviewFixture(1);
  const room = window.reviewClient.latestSnapshot.room;
  room.match.mode = '1v1'; room.settings.format = '1v1'; room.match.playersPerTeam = 1;
  window.reviewOverlay.update();
});
check('1v1 keeps its existing layout without team room controls', !(await root.getAttribute('class')).includes('multiplayer-modal--team-room') && await root.locator('.team-room-manage:visible, .team-room-resume:visible').count() === 0);
writeFileSync(`${out}/results.json`, JSON.stringify({ checks, bounds, errors }, null, 2));
console.log(JSON.stringify({ checks, bounds, errors }, null, 2));
assert.equal(errors.length, 0, 'No browser runtime errors');
} finally {
  await browser.close();
}
