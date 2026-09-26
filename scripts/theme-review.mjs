/** Real production menus without WebGL. Run Vite on :5173; review artifacts stay in tmp/. */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const out = 'tmp/theme-review';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, screen: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const head = readFileSync('index.html', 'utf8').match(/<head>([\s\S]*?)<\/head>/)[1];
  await page.route('**/theme-review', route => route.fulfill({ contentType: 'text/html', body: `<html><head>${head}</head><body><div id="theme-host" style="position:fixed;inset:0"></div></body></html>` }));
  await page.goto('http://127.0.0.1:5173/theme-review');
  await page.evaluate(async () => {
    // Headless Chromium reports its viewport as the available screen after resizing. Model a
    // windowed browser so the real fullscreen-warning path remains reachable in every fixture.
    Object.defineProperty(window.screen, 'availWidth', { configurable: true, get: () => innerWidth + 100 });
    Object.defineProperty(window.screen, 'availHeight', { configurable: true, get: () => innerHeight + 100 });
    const { SettingsPanel } = await import('/src/game/ui/SettingsPanel.ts');
    const { GraphicsTuningPanel } = await import('/src/game/ui/GraphicsTuningPanel.ts');
    const { HowToPlay } = await import('/src/game/ui/HowToPlay.ts');
    const { CourseRaceUI } = await import('/src/game/practice/CourseRaceUI.ts');
    const { CourseRunHud } = await import('/src/game/practice/creator/CourseRunHud.ts');
    const { CreatorUI } = await import('/src/game/practice/creator/CreatorUI.ts');
    const { MultiplayerOverlay } = await import('/src/game/network/MultiplayerOverlay.ts');
    const { createRoomState, createStartVoteState } = await import('/shared/simulation/MatchSim.ts');
    const { createPlayerState } = await import('/shared/simulation/PlayerSim.ts');
    const { createMatchState } = await import('/shared/simulation/RuleSim.ts');
    const { defaultRoomSettings } = await import('/shared/roomSettings.ts');
    const host = document.querySelector('#theme-host');
    document.body.style.background = '#172a43';
    let current, dockedSettings;
    window.mountReview = screen => {
      dockedSettings?.dispose();
      dockedSettings = null;
      current?.dispose();
      host.replaceChildren();
      if (screen.startsWith('settings')) {
        current = new SettingsPanel(host);
        host.querySelector('.settings-toggle').click();
        if (screen === 'settings-advanced') host.querySelector('.settings-advanced').open = true;
      } else if (screen === 'help') {
        current = new HowToPlay(host);
        current.show();
      } else if (screen.startsWith('race')) {
        current = new CourseRaceUI(host, { onCreate() {}, onJoin() {}, onLeaveRace() {}, onRestartAll() {}, onCloseOverlay() {} });
        if (screen === 'race') current.openOverlay();
        else {
          current.showPanel('AbCd12');
          current.updateRoster(Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: i ? `Racer number ${i}` : 'A long racer name (host)', bestMs: 42425 + i * 2321, host: i === 0 })), 'p0', true);
        }
      } else if (screen === 'course-results') {
        current = new CourseRunHud(host, 'Movement course');
        current.setVisible(true);
        current.showFinished(42425, 42425);
        current.renderLeaderboard(Array.from({ length: 10 }, (_, i) => 42425 + i * 1500), 1);
      } else if (screen === 'graphics-tuning') {
        current = new GraphicsTuningPanel({ getEngine: () => ({ setHardwareScalingLevel() {} }), imageProcessingConfiguration: {}, getMaterialByName: () => null }, host);
      } else if (screen.startsWith('creator')) {
        const bridge = new Proxy({
          getMode: () => 'build', getSelectedObject: () => null, selectionCount: () => 0,
          listProjects: () => [], listObjects: () => [], getSelectedIds: () => [], getPrefabNames: () => [],
          getCourseInfo: () => ({ name: 'Training court', description: 'Movement practice', difficulty: 'easy', sky: 'day' }),
          getSnapSettings: () => ({ gridSnap: true, gridSize: 1, rotationSnapDeg: 15, scaleSnap: .25, gizmo: 'move', showGrid: true })
        }, { get: (target, key) => target[key] ?? (() => null) });
        current = new CreatorUI(host, bridge);
        if (screen === 'creator-help') current.showOnboarding(() => {});
        else if (screen === 'creator-import') current.showImportPreview({ name: 'A movement course with a longer title', description: 'Practice movement, jumps and advanced throws with friends.', difficulty: 'hard', objectCount: 128, problems: ['One obsolete object was removed.'] }, () => {});
        else {
          current.setToolbarVisible(true);
          if (screen === 'creator-settings') {
            dockedSettings = new SettingsPanel(host);
            dockedSettings.dock(current.gameSettingsSlot());
            [...host.querySelectorAll('.creator-settings-toggle')].find(el => el.textContent.startsWith('Settings')).click();
          }
        }
      } else {
        const mode = screen.endsWith('1v1') ? '1v1' : '2v2';
        const count = mode === '1v1' ? 2 : 4;
        const players = ['Randall', 'A teammate with a long name', 'Jordan', 'Alex'].slice(0, count)
          .map((name, i) => createPlayerState(`p${i}`, i < count / 2 ? 'blue' : 'red', 'negativeZ', { name, teamSlotIndex: i % (count / 2) }));
        const room = createRoomState({ id: 'review', players, settings: defaultRoomSettings(mode), hostPlayerId: 'p0',
          match: createMatchState('review', ['blue', 'red'], { mode, status: 'warmup', playersPerTeam: count / 2, maxPlayers: count }),
          startVote: createStartVoteState({ requiredVotes: 3, requiredTeamChoices: count, teamChoiceCount: count,
            teamChoicesByPlayerId: Object.fromEntries(players.map(p => [p.id, true])) }) });
        const connected = !['room-setup', 'fullscreen'].includes(screen);
        const client = { connected, status: connected ? 'connected' : 'disconnected', localPlayerId: 'p0', roomId: 'AbCd12', pingMs: 47,
          connectionPath: 'public', errorMessage: '', latestSnapshot: connected ? { room } : null,
          requestSwitchTeam() {}, requestStartVote() {}, requestRoomSettings() {}, requestEndVote() {}, requestReset() {}, requestIntermissionVote() {}, leave() {} };
        current = new MultiplayerOverlay(client, { setLockSuppressed() {} });
        current.openMode(mode);
        if (!connected) {
          const name = document.querySelector('.multiplayer-name');
          name.value = 'Randall';
          name.dispatchEvent(new Event('input', { bubbles: true }));
          if (screen === 'fullscreen') current.runWithFullscreenCheck(async () => {});
        }
        if (screen === 'room-settings') document.querySelector('[data-action="open-settings"]').click();
        if (screen.startsWith('results')) {
          room.match.status = 'complete';
          room.match.winnerTeamId = 'blue';
          current.update();
        }
      }
    };
  });
  await page.evaluate(() => document.fonts.ready);

  const screens = [
    { name: 'settings', selector: '.settings-content', last: '.settings-advanced > summary', paper: true },
    { name: 'settings-advanced', selector: '.settings-content', last: '.settings-link--secondary', paper: true },
    { name: 'help', selector: '.htp-panel', last: '.htp-nav:last-child', paper: true },
    { name: 'room-setup', selector: '.multiplayer-panel--lobby', last: '.multiplayer-connection-options > summary', paper: true },
    { name: 'room-1v1', selector: '.multiplayer-panel--lobby', last: '.multiplayer-leave', paper: true },
    { name: 'room-2v2', selector: '.multiplayer-panel--lobby', last: '.multiplayer-leave', paper: true },
    { name: 'room-settings', selector: '.multiplayer-settings-menu__panel', last: '[data-action="close-settings"]', paper: true },
    { name: 'fullscreen', selector: '.fullscreen-prompt__card', last: '.fullscreen-cancel', paper: true },
    { name: 'creator', selector: '.creator-ui--visible', auxiliary: '.creator-hotbar--visible' },
    { name: 'creator-settings', selector: '.creator-ui--visible', last: '.settings-advanced > summary', auxiliary: '.creator-hotbar--visible' },
    { name: 'graphics-tuning', selector: '.graphics-tuning', last: '.graphics-tuning__actions button:last-child' },
    { name: 'creator-help', selector: '.creator-modal-backdrop--visible .creator-modal', last: '.creator-modal-actions button', paper: true },
    { name: 'creator-import', selector: '.creator-modal-backdrop--visible .creator-modal', last: '.creator-modal-actions button:last-child', paper: true },
    { name: 'race', selector: '.creator-modal-backdrop--visible .creator-modal', last: '.creator-modal-actions button', paper: true },
    { name: 'race-roster', selector: '.race-panel--visible', last: '.race-panel-actions button:last-child' },
    { name: 'course-results', selector: '.course-leaderboard--visible', paper: true },
    { name: 'results-1v1', selector: '.multiplayer-modal--postmatch .multiplayer-postmatch', last: '[data-postmatch-action="copy-code"]', paper: true, surface: '.multiplayer-report-card' },
    { name: 'results-2v2', selector: '.multiplayer-modal--postmatch .multiplayer-postmatch', last: '[data-postmatch-action="copy-code"]', paper: true, surface: '.multiplayer-report-card' }
  ];
  const measurements = [];
  const tokenChecks = [];
  for (const [width, height] of [[1440, 900], [800, 600], [390, 844], [1280, 600]]) {
    await page.setViewportSize({ width, height });
    for (const screen of screens.filter(item => !process.env.THEME_REVIEW_SCREENS || process.env.THEME_REVIEW_SCREENS.split(',').includes(item.name))) {
      console.log(`Review ${screen.name} at ${width}x${height}`);
      await page.evaluate(name => window.mountReview(name), screen.name);
      const panel = page.locator(screen.selector).last();
      await panel.waitFor({ state: 'visible', timeout: 6000 });
      const measure = await panel.evaluate(el => {
        const r = el.getBoundingClientRect();
        return { viewport: [innerWidth, innerHeight], x: r.x, y: r.y, width: r.width, height: r.height,
          inBounds: r.x >= -.5 && r.y >= -.5 && r.right <= innerWidth + .5 && r.bottom <= innerHeight + .5,
          noHorizontalOverflow: el.scrollWidth <= el.clientWidth + 1,
          scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      });
      measure.screen = screen.name;
      if (screen.auxiliary) measure.auxiliary = await page.locator(screen.auxiliary).evaluate(el => {
        const r = el.getBoundingClientRect();
        return { selector: el.className, x: r.x, y: r.y, width: r.width, height: r.height,
          inBounds: r.x >= -.5 && r.y >= -.5 && r.right <= innerWidth + .5 && r.bottom <= innerHeight + .5 };
      });
      if (screen.paper) {
        const surface = screen.surface ? panel.locator(screen.surface) : panel;
        measure.paperTheme = await surface.evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(243, 240, 231)');
        if (width === 1440) tokenChecks.push({ screen: screen.name, propagated: await surface.evaluate(async el => {
          // Reduced motion can retain a tiny CSS transition. Read the settled color, rather
          // than its initial frame, and settle the restore before the screenshot as well.
          const settleColor = async () => {
            void getComputedStyle(el).backgroundColor;
            await Promise.all(el.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.finished));
          };
          document.documentElement.style.setProperty('--sb-cream', '#eeeeee');
          try {
            await settleColor();
            return getComputedStyle(el).backgroundColor === 'rgb(238, 238, 238)';
          } finally {
            document.documentElement.style.removeProperty('--sb-cream');
            await settleColor();
          }
        }) });
      }
      await page.screenshot({ path: `${out}/${screen.name}-${width}x${height}.png`, animations: 'disabled' });
      if (screen.last) {
        const action = panel.locator(screen.last).last();
        await action.scrollIntoViewIfNeeded({ timeout: 2000 });
        measure.lastActionAccessible = await action.evaluate(el => {
          const r = el.getBoundingClientRect();
          const point = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return r.x >= -.5 && r.y >= -.5 && r.right <= innerWidth + .5 && r.bottom <= innerHeight + .5 && (point === el || el.contains(point));
        });
      }
      if (screen.name === 'help') {
        measure.pages = [];
        const tabs = panel.locator('.htp-tab');
        for (let i = 0; i < await tabs.count(); i++) {
          await tabs.nth(i).click();
          measure.pages.push(await panel.locator('.htp-body').evaluate(el => ({ noHorizontalOverflow: el.scrollWidth <= el.clientWidth + 1, height: el.clientHeight })));
        }
      }
      measurements.push(measure);
    }
  }
  const failures = measurements.filter(item => !item.inBounds || !item.noHorizontalOverflow || item.auxiliary?.inBounds === false || item.paperTheme === false || item.lastActionAccessible === false || item.pages?.some(p => !p.noHorizontalOverflow || p.height < 80));
  const results = { errors, tokenChecks, measurements, failures };
  writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ errors, cases: measurements.length, tokenChecks, failures }, null, 2));
  if (errors.length || failures.length || tokenChecks.some(check => !check.propagated)) process.exitCode = 1;
} finally { await browser.close(); }
