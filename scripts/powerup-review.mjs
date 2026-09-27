/** Actual HUD + state derivation. Run Vite on :5173; screenshots stay under tmp/. */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const out = 'tmp/powerup-review';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const checks = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, passed) => checks.push({ name, passed });
try {
  const head = readFileSync('index.html', 'utf8').match(/<head>([\s\S]*?)<\/head>/)[1];
  await page.route('**/powerup-review', route => route.fulfill({ contentType: 'text/html', body: `<html><head>${head}</head><body></body></html>` }));
  await page.goto('http://127.0.0.1:5173/powerup-review');
  await page.evaluate(async () => {
    const { Hud } = await import('/src/game/ui/Hud.ts');
    const { buildPowerupHudView, POWERUP_ITEMS } = await import('/src/game/powerups/PowerupHudView.ts');
    const root = document.createElement('div');
    document.body.append(root);
    window.reviewHud = new Hud(root);
    window.reviewHud.setPresentation('playing');
    document.body.dataset.reducedEffects = 'true';
    window.reviewRoom = {
      practicePlayerId: 'practice',
      practiceBuffs: { speedSeconds: 8, adrenalineSeconds: 0, magnetSeconds: 0, cannonLocked: false },
      settings: { powerupsEnabled: true }, powerups: { spawns: [], stations: [] },
      resetVote: { resetSerial: 1 }, match: { currentRound: 1, status: 'warmup' }, players: {}, balls: {}
    };
    window.reviewItems = POWERUP_ITEMS;
    window.renderItem = (heldKind = 'bomb', rolling = false, rollKind = 'heal') => {
      const view = buildPowerupHudView({ room: window.reviewRoom, heldKind, rolling, rollKind, waitSeconds: 20 });
      window.reviewHud.setPowerupSlot(view);
    };
    window.renderItem();
  });
  await page.evaluate(() => document.fonts.ready);
  const measure = () => page.evaluate(() => {
    const dock = document.querySelector('.powerup-dock');
    const side = dock.querySelector('.powerup-roulette');
    const mainRect = dock.getBoundingClientRect(), sideRect = side.getBoundingClientRect();
    const speedRect = document.querySelector('.ability-speed').getBoundingClientRect();
    return {
      hidden: dock.hidden, state: dock.dataset.state, selection: dock.dataset.selectionState,
      mainIcon: dock.querySelector('.ability-powerup-glyph').dataset.icon,
      sideIcon: side.querySelector('.powerup-roulette__glyph--current').dataset.icon,
      hint: dock.querySelector('.ability-powerup-hint').textContent,
      key: side.querySelector('.powerup-roulette__key').textContent,
      overlapsSpeed: sideRect.left < speedRect.right && sideRect.right > speedRect.left && sideRect.top < speedRect.bottom && sideRect.bottom > speedRect.top,
      main: { x: mainRect.x, y: mainRect.y, width: mainRect.width, height: mainRect.height, right: mainRect.right },
      side: { x: sideRect.x, y: sideRect.y, width: sideRect.width, height: sideRect.height, right: sideRect.right }
    };
  });
  const capture = async name => {
    const { main, side } = await measure();
    await page.screenshot({ path: `${out}/${name}.png`, clip: {
      x: Math.max(0, side.x - 10), y: Math.max(0, main.y - 10),
      width: main.right - Math.max(0, side.x - 10) + 10, height: main.height + 20
    } });
  };
  for (const [width, height] of [[1440, 900], [800, 600], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => { window.reviewRoom.practiceBuffs.speedSeconds = 8; window.renderItem('bomb', true); });
    await page.waitForTimeout(260);
    const rolling = await measure();
    check(`${width}: reel matches main height/top`, Math.abs(rolling.main.height - rolling.side.height) < 1 && Math.abs(rolling.main.y - rolling.side.y) < 1);
    check(`${width}: side stays left and inside viewport`, rolling.side.x >= 0 && rolling.side.right <= rolling.main.x + 1);
    check(`${width}: side leaves speed readout visible`, !rolling.overlapsSpeed);
    check(`${width}: active effect survives rolling`, rolling.mainIcon === 'speed' && rolling.hint.includes('Speed 8s') && rolling.selection === 'rolling');
    await capture(`rolling-${width}`);
    await page.evaluate(() => window.renderItem('bomb', false));
    await page.waitForTimeout(300);
    const held = await measure();
    check(`${width}: reveal stays open with equipped item`, held.selection === 'held' && held.sideIcon === 'bomb' && held.key === 'G' && held.side.width > 50);
    check(`${width}: main card does not enlarge during rolling`, Math.abs(rolling.main.width - held.main.width) < 1 && Math.abs(rolling.main.height - held.main.height) < 1);
    await capture(`revealed-${width}`);
    await page.evaluate(() => { window.reviewRoom.practiceBuffs.speedSeconds = 0; window.renderItem(); });
    const expired = await measure();
    check(`${width}: buff expiry preserves unused item and full side height`, expired.selection === 'held' && expired.sideIcon === 'bomb' && Math.abs(expired.main.height - expired.side.height) < 1);
  }
  const colors = await page.evaluate(() => {
    return Object.entries(window.reviewItems).map(([kind, item]) => {
      window.renderItem('bomb', true, kind);
      const glyph = document.querySelector('.powerup-roulette__glyph--current');
      const expected = document.createElement('span');
      expected.style.color = item.color;
      document.body.append(expected);
      const correct = getComputedStyle(glyph).color === getComputedStyle(expected).color && !!glyph.querySelector('svg');
      expected.remove();
      return { kind, correct };
    });
  });
  check('All eight reel icons match their HUD colors', colors.every(color => color.correct));
  await page.evaluate(() => { window.reviewRoom.practiceHandItems = [{ kind: 'bomb', hand: 'right' }]; window.renderItem(null); });
  await page.waitForTimeout(260);
  const used = await measure();
  check('Use closes inventory slot and keeps equipped hand item visible', used.selection === 'none' && used.side.width < 1 && used.mainIcon === 'bomb' && !used.hidden);
  await page.evaluate(() => { window.reviewRoom.practiceHandItems = []; window.renderItem(null); });
  check('Throwing final item clears the display', (await measure()).hidden);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.renderItem('bomb', true, 'magnet'));
  check('OS reduced motion disables reel motion', await page.evaluate(() =>
    document.querySelector('.powerup-roulette__glyph--current').getAnimations().length === 0));
  writeFileSync(`${out}/results.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }, null, 2));
  if (errors.length || checks.some(check => !check.passed)) process.exitCode = 1;
} finally {
  await browser.close();
}
