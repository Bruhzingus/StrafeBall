/** Browser regression review: actual HUD components, event/state rendering and production styles.
 * Run with the Vite client on :5173. Artifacts go to tmp/ui-review (not shipped with the game).
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const out = 'tmp/ui-review';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
try {
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => localStorage.setItem('strafeball.graphics.mode', 'performance'));
// Isolate components from scene transitions, which dispose HUD instances during application startup.
const head = readFileSync('index.html', 'utf8').match(/<head>([\s\S]*?)<\/head>/)[1];
await page.route('**/ui-review', route => route.fulfill({ contentType: 'text/html', body: `<html><head>${head}</head><body></body></html>` }));
await page.goto('http://127.0.0.1:5173/ui-review');

await page.evaluate(async () => {
  const { Hud } = await import('/src/game/ui/Hud.ts');
  document.querySelectorAll('.hud, .settings-panel, .music-hud, .network-status').forEach(el => el.style.display = 'none');
  const parent = document.createElement('div');
  parent.id = 'review-root';
  Object.assign(parent.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
  document.body.append(parent);
  window.reviewHud = new Hud(parent);
  window.reviewHud.setPresentation('playing');
  window.reviewHud.teamScoreboard.setVisible(true);
  window.reviewHud.teamScoreboard.update({ mode: '2v2', phase: 'playing', currentRound: 2, roundCount: 3, scoreLabel: 'LIVES', halfDropSecondsRemaining: 9, noBoundaries: false,
    blueTeam: { name: 'BLUE TEAM', color: 'blue', score: 12, players: ['A very long player name (You)', 'Second Blue Player'], roundsWon: 1 },
    redTeam: { name: 'RED TEAM', color: 'red', score: 10, players: ['Another long opponent name', 'Second Red Player'], roundsWon: 0 } });
  window.reviewHud.updateGameplayHud({ leftCatchCooldown: 0, rightCatchCooldown: .8, backflipCooldown: 0, leftMode: 'holding', rightMode: 'empty', backflipActive: false, leftCharge: 0, rightCharge: 0, speed: 12.3, dt: .016 });
  window.reviewHud.updateStaminaWidget(2.4, 3);
  window.reviewHud.setPowerupSlot({ glyph: '»', color: '#75e6ff', name: 'Active effects', hint: 'Speed 2s · Armor ●●', state: 'active', progress: .15, expiring: true });
  window.reviewHud.setInteractPrompt('Press', 'to pick up ball');
});

const measurements = [];
for (const [width, height] of [[1920,1080], [2560,1440], [1366,768], [1440,900], [2560,1080], [800,600], [640,480]]) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${out}/match-${width}x${height}.png` });
  measurements.push(await page.evaluate(() => {
    const selectors = ['.team-scoreboard', '.ability-hud', '.stamina-widget', '.powerup-dock', '.ability-speed'];
    return { viewport: [innerWidth, innerHeight], elements: selectors.map(selector => {
      const el = document.querySelector(`#review-root ${selector}`);
      const b = el.getBoundingClientRect();
      return { selector, x: b.x, y: b.y, width: b.width, height: b.height,
        inBounds: b.x >= 0 && b.y >= 0 && b.right <= innerWidth && b.bottom <= innerHeight };
    }) };
  }));
}

await page.setViewportSize({ width: 1440, height: 900 });
// A gallery of real event markup/styles makes every supported variant reviewable together.
const contrast = await page.evaluate(() => {
  const gallery = document.createElement('div');
  gallery.id = 'event-gallery';
  Object.assign(gallery.style, { position: 'fixed', inset: '155px 30px 145px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', alignContent: 'start', gap: '22px', pointerEvents: 'none', zIndex: '100' });
  document.body.append(gallery);
  const add = selector => {
    const source = document.querySelector(`#review-root ${selector}`);
    const clone = source.cloneNode(true);
    Object.assign(clone.style, { position: 'relative', top: 'auto', bottom: 'auto', left: 'auto', right: 'auto', opacity: '1', animation: 'none', transform: 'none', width: 'auto', maxWidth: 'none' });
    gallery.append(clone);
  };
  for (const variant of ['good', 'bad', 'neutral', 'team-blue', 'team-red']) {
    window.reviewHud.showTimedScoreEvent(variant === 'bad' ? 'LIFE LOST' : 'HIT / TEAM JOIN', 'Player name · 2 lives remaining', variant, 10000);
    add('.score-event');
  }
  for (const strength of [.2, .6, 1]) {
    window.reviewHud.showQteEvent(strength === 1 ? 'PERFECT' : 'BACKFLIP THROW', 'Throw result feedback', strength);
    add('.qte-event');
  }
  window.reviewHud.showClutchBuffEvent(); add('.clutch-event');
  window.reviewHud.showPracticeHalfCourtHint(); add('.half-court-warning');
  window.reviewHud.updateHalfCourtWarning({ wasAcross: true, deathCountdownActive: true, countdownSeconds: 2, eliminationIssued: false }); add('.half-court-warning');
  window.reviewHud.showRoundSplash(2, 3); add('.round-splash__panel');
  document.querySelectorAll('#review-root .score-event, #review-root .qte-event, #review-root .clutch-event, #review-root .half-court-warning, #review-root .round-splash').forEach(el => el.style.display = 'none');
  const rgba = css => (css.match(/[\d.]+/g) ?? []).map(Number);
  const luminance = rgb => rgb.slice(0, 3).reduce((sum, value, i) => {
    const c = value / 255;
    return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
  }, 0);
  const contrastRatio = el => {
    // White is the worst-case bright world behind these translucent dark popup surfaces.
    let bg = [255, 255, 255];
    const layers = [];
    for (let node = el; node && node !== gallery; node = node.parentElement) layers.unshift(node);
    for (const node of layers) {
      const color = rgba(getComputedStyle(node).backgroundColor);
      const alpha = color[3] ?? 1;
      bg = bg.map((c, i) => (color[i] ?? 0) * alpha + c * (1 - alpha));
    }
    const fg = rgba(getComputedStyle(el).color);
    const a = luminance(fg), b = luminance(bg);
    return Number(((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toFixed(2));
  };
  return Array.from(gallery.children).map(el => ({ class: el.className, background: getComputedStyle(el).backgroundColor,
    text: Array.from(el.querySelectorAll('*')).filter(e => e.textContent && !e.children.length && e.getClientRects().length).map(e => ({ text: e.textContent, color: getComputedStyle(e).color, background: getComputedStyle(e).backgroundColor, contrast: contrastRatio(e) })) }));
});
await page.screenshot({ path: `${out}/events.png` });

// Timing and reduced-effects are behavior checks: GO must survive consecutive rendered frames.
const countdownChecks = await page.evaluate(async () => {
  document.querySelector('#event-gallery').remove();
  document.body.dataset.reducedEffects = 'true';
  const hud = window.reviewHud;
  hud.updateCountdown('countdown', 3);
  const el = document.querySelector('#review-root .countdown');
  const countdownVisibleWithReducedEffects = getComputedStyle(el).opacity === '1';
  hud.updateCountdown('playing', 0);
  hud.updateCountdown('playing', 0);
  const goSurvivesNextFrame = el.textContent === 'GO!' && el.classList.contains('countdown--visible');
  await new Promise(resolve => setTimeout(resolve, 760));
  hud.updateCountdown('playing', 0);
  const goClears = !el.classList.contains('countdown--visible');
  hud.updateCountdown('countdown', 2);
  return { countdownVisibleWithReducedEffects, goSurvivesNextFrame, goClears };
});
await page.screenshot({ path: `${out}/countdown-reduced-effects.png` });
const lowContrast = contrast.flatMap(group => group.text.filter(t => t.contrast < 4.5).map(t => ({ class: group.class, ...t })));
const bounds = measurements.flatMap(m => m.elements.filter(e => !e.inBounds).map(e => ({ viewport: m.viewport, ...e })));
writeFileSync(`${out}/results.json`, JSON.stringify({ errors, measurements, contrast, countdownChecks }, null, 2));
console.log(JSON.stringify({ errors, bounds, lowContrast, countdownChecks, viewports: measurements.length, eventVariants: contrast.length }, null, 2));
if (errors.length || bounds.length || lowContrast.length || Object.values(countdownChecks).some(passed => !passed)) process.exitCode = 1;
} finally { await browser.close(); }
