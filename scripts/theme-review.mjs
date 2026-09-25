/** Real menu/editor components under the single production stylesheet, without a WebGL scene. */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out = 'tmp/theme-review';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const head = readFileSync('index.html', 'utf8').match(/<head>([\s\S]*?)<\/head>/)[1];
  await page.route('**/theme-review', route => route.fulfill({ contentType: 'text/html', body: `<html><head>${head}</head><body><div id="theme-host" style="position:fixed;inset:0"></div></body></html>` }));
  await page.goto('http://127.0.0.1:5173/theme-review');
  await page.evaluate(async () => {
    const { SettingsPanel } = await import('/src/game/ui/SettingsPanel.ts');
    const { HowToPlay } = await import('/src/game/ui/HowToPlay.ts');
    const { CourseRaceUI } = await import('/src/game/practice/CourseRaceUI.ts');
    const { CourseRunHud } = await import('/src/game/practice/creator/CourseRunHud.ts');
    const { CreatorUI } = await import('/src/game/practice/creator/CreatorUI.ts');
    const host = document.querySelector('#theme-host');
    document.body.style.background = '#172a43';
    window.reviewSettings = new SettingsPanel(host);
    window.reviewHelp = new HowToPlay(host);
    window.reviewRace = new CourseRaceUI(host, { onCreate() {}, onJoin() {}, onLeaveRace() {}, onRestartAll() {}, onCloseOverlay() {} });
    window.reviewCourse = new CourseRunHud(host, 'Movement course');
    const bridge = new Proxy({
      getMode: () => 'build', getSelectedObject: () => null, selectionCount: () => 0,
      listProjects: () => [], listObjects: () => [], getSelectedIds: () => [], getPrefabNames: () => [],
      getCourseInfo: () => ({ name: 'Training court', description: 'Movement practice', difficulty: 'easy', sky: 'day' }),
      getSnapSettings: () => ({ gridSnap: true, gridSize: 1, rotationSnapDeg: 15, scaleSnap: .25, gizmo: 'move', showGrid: true })
    }, { get: (target, key) => target[key] ?? (() => null) });
    window.reviewCreator = new CreatorUI(host, bridge);
    window.reviewTheme = () => {
      const theme = getComputedStyle(document.documentElement);
      return { cream: theme.getPropertyValue('--sb-cream').trim(), gold: theme.getPropertyValue('--sb-gold').trim() };
    };
  });
  await page.evaluate(() => document.fonts.ready);
  const checks = [];
  const check = (name, value) => { checks.push({ name, passed: value }); assert.ok(value, name); };
  await page.locator('.settings-toggle').click();
  check('Settings uses the paper theme', await page.locator('.settings-content').evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(243, 240, 231)'));
  await page.screenshot({ path: `${out}/settings.png` });
  await page.locator('.settings-toggle').click();
  await page.evaluate(() => window.reviewHelp.show());
  check('Help uses the paper theme', await page.locator('.htp-panel').last().evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(243, 240, 231)'));
  await page.screenshot({ path: `${out}/help.png` });
  await page.evaluate(() => { window.reviewHelp.close(); window.reviewRace.openOverlay(); });
  const race = page.locator('.creator-modal-backdrop--visible .creator-modal');
  check('Race dialog uses cream rather than legacy dark blue', await race.evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(243, 240, 231)'));
  check('Race primary action uses school gold', await race.locator('.creator-btn-primary').first().evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(242, 200, 75)'));
  await page.screenshot({ path: `${out}/race.png` });
  await page.evaluate(() => { window.reviewRace.closeOverlay(); window.reviewCreator.setToolbarVisible(true); });
  check('Editor active tool uses school gold', await page.locator('.creator-mode-btn--active').evaluate(el => getComputedStyle(el).backgroundColor === 'rgb(242, 200, 75)'));
  await page.screenshot({ path: `${out}/creator.png` });
  await page.evaluate(() => window.reviewCreator.showOnboarding(() => {}));
  await page.screenshot({ path: `${out}/creator-help.png` });
  // A token change must propagate through existing adapters as well as the new primitive classes.
  check('Shared tokens propagate across components', await page.evaluate(() => {
    document.documentElement.style.setProperty('--sb-cream', '#eeeeee');
    const result = [...document.querySelectorAll('.htp-panel, .creator-modal, .settings-content')]
      .every(el => getComputedStyle(el).backgroundColor === 'rgb(238, 238, 238)');
    document.documentElement.style.removeProperty('--sb-cream');
    return result;
  }));
  const bounds = [];
  for (const [width, height] of [[1440, 900], [800, 600], [390, 844]]) {
    await page.setViewportSize({ width, height });
    bounds.push(await page.locator('.creator-modal-backdrop--visible .creator-modal').evaluate(el => {
      const r = el.getBoundingClientRect();
      return { viewport: [innerWidth, innerHeight], fits: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth };
    }));
  }
  check('Shared dialogs fit desktop and narrow screens', bounds.every(item => item.fits));
  check('No browser runtime errors', errors.length === 0);
  writeFileSync(`${out}/results.json`, JSON.stringify({ checks, bounds, errors }, null, 2));
  console.log(JSON.stringify({ checks, bounds, errors }, null, 2));
} finally { await browser.close(); }
