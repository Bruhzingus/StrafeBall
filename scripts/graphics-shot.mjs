/**
 * Graphics verification harness (plan: dreamy-chasing-quokka).
 *
 * Captures a deterministic screenshot (+ optional FPS sample + [graphics] console audit) of one
 * view under one graphics preset, for the per-phase visual/perf gates of the graphics overhaul.
 *
 * Usage (dev server must be running — `npm run dev`):
 *   node scripts/graphics-shot.mjs --preset polished --view gym-spawn --tag phase0
 *   node scripts/graphics-shot.mjs --preset performance --view gym-corner --fps 6
 *   node scripts/graphics-shot.mjs --preset polished --view sandbox --headed
 *
 * Args:
 *   --preset  polished | performance | neutral      (default polished)
 *   --view    gym-spawn | gym-corner | scoreboard | sandbox   (default gym-spawn)
 *   --tag     filename prefix, e.g. the phase id     (default none)
 *   --url     dev server URL                         (default http://localhost:5173/)
 *   --fps N   ALSO sample average FPS over N seconds (rAF-based). Use --headed for real numbers —
 *             headless Chromium may fall back to SwiftShader and report meaningless FPS.
 *   --headed  run with a visible browser window
 *
 * Output: scripts/shots/<tag-><preset>-<view>.png + console summary (FPS, [graphics] lines).
 * The dev tuning panel (#graphics-tuning-panel) is hidden in captures so screenshots stay
 * pixel-comparable across presets/phases.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}
const hasFlag = (name) => args.includes(`--${name}`);

const preset = argValue('preset', 'polished');
const view = argValue('view', 'gym-spawn');
const tag = argValue('tag', '');
const url = argValue('url', 'http://localhost:5173/');
const fpsSeconds = Number(argValue('fps', '0'));
const headed = hasFlag('headed');
// Optional POLISHED_CONFIG override JSON injected as the tuning blob (diagnostics — e.g. crank the
// mirror to max to prove the reflection pipeline renders at all). Omitted = compiled values.
const tuningJson = argValue('tuning', '');

const VALID_PRESETS = ['polished', 'performance', 'neutral'];
const VALID_VIEWS = ['gym-spawn', 'gym-corner', 'scoreboard', 'sandbox', 'floor'];
if (!VALID_PRESETS.includes(preset)) throw new Error(`--preset must be one of ${VALID_PRESETS.join('|')}`);
if (!VALID_VIEWS.includes(view)) throw new Error(`--view must be one of ${VALID_VIEWS.join('|')}`);

mkdirSync('scripts/shots', { recursive: true });
const outPath = `scripts/shots/${tag ? `${tag}-` : ''}${preset}-${view}.png`;

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

// Preset + debug flags must exist BEFORE the app boots (graphics systems build once at construction).
await page.addInitScript(
  ({ preset, autosandbox, tuningJson }) => {
    localStorage.setItem('strafeball.graphics.mode', preset);
    localStorage.setItem('strafeball.debug.graphics', '1'); // enables the one-shot [graphics] audit
    if (autosandbox) localStorage.setItem('strafeball.debug.autosandbox', '1');
    else localStorage.removeItem('strafeball.debug.autosandbox');
    // Captures use compiled values unless a diagnostic override blob was passed via --tuning.
    if (tuningJson) localStorage.setItem('strafeball.graphics.tuning.v1', tuningJson);
    else localStorage.removeItem('strafeball.graphics.tuning.v1');
  },
  { preset, autosandbox: view === 'sandbox', tuningJson }
);

const graphicsLines = [];
const errorLines = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.includes('[graphics]') || text.includes('[graphics-tuning]')) graphicsLines.push(text);
  if (msg.type() === 'error') errorLines.push(text);
});
page.on('pageerror', (err) => errorLines.push(`pageerror: ${err.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500); // engine + gym build + one-shot audit
// Wait out the "TIP-OFF!" asset-loading splash if it's still up (a fresh dev-server HMR rebuild can
// push first load past the base wait). The loading overlay carries the #loading-screen id.
for (let i = 0; i < 20; i += 1) {
  const loading = page.locator('#loading-screen, #loading-overlay, .loading-screen');
  const stillLoading = (await loading.count()) > 0 && (await loading.first().isVisible().catch(() => false));
  if (!stillLoading) break;
  await page.waitForTimeout(500);
}

// Hide the dev tuning panel so captures stay pixel-comparable across presets.
await page.addStyleTag({ content: '#graphics-tuning-panel { display: none !important; }' });

// Dismiss the pointer-lock overlay if present. Retry with a real mouse click at the viewport
// center — a single element-click has proven flaky (the overlay's handler may attach late, or the
// first synthetic click can race the engine's own pointer handling).
const overlay = page.locator('#lock-overlay');
for (let attempt = 0; attempt < 5; attempt += 1) {
  const visible = (await overlay.count()) > 0 && (await overlay.isVisible().catch(() => false));
  if (!visible) break;
  try {
    if (attempt % 2 === 0) await overlay.click({ timeout: 1500, force: true });
    else await page.mouse.click(800, 500);
  } catch {
    /* retry */
  }
  await page.waitForTimeout(900);
}
await page.waitForTimeout(1200);

// --- View choreography (deterministic keyboard/mouse steps, same spirit as _shot-corner.mjs) ---
if (view === 'gym-corner') {
  // Turn ~90° right FIRST (the lobby portals stand directly ahead of spawn — walking forward
  // face-plants into a portal surface), then run down the court and angle back for a grazing
  // corner view of floor + walls (the wash-out / shadow-acne check view).
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.move(800, 500);
    await page.mouse.move(1250, 495, { steps: 15 });
  }
  await page.waitForTimeout(300);
  await page.keyboard.down('w');
  await page.waitForTimeout(2200);
  await page.keyboard.up('w');
  await page.waitForTimeout(300);
  await page.mouse.move(800, 500);
  await page.mouse.move(1150, 430, { steps: 20 });
  await page.waitForTimeout(500);
} else if (view === 'floor') {
  // Walk a little, then pitch steeply down at the court — the view where camera-following light
  // specular blobs on the glossy floor are most visible (regression view for the roaming-glint fix).
  await page.mouse.move(800, 500);
  await page.mouse.move(1250, 495, { steps: 15 });
  await page.waitForTimeout(200);
  await page.keyboard.down('w');
  await page.waitForTimeout(1200);
  await page.keyboard.up('w');
  await page.waitForTimeout(300);
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.move(800, 400);
    await page.mouse.move(800, 900, { steps: 15 });
  }
  await page.waitForTimeout(400);
} else if (view === 'scoreboard') {
  // Turn ~180° and tilt up toward the end-wall scoreboard.
  await page.mouse.move(800, 500);
  await page.mouse.move(2400, 300, { steps: 40 });
  await page.waitForTimeout(500);
} else if (view === 'sandbox') {
  // The autosandbox debug hook enters the yard ~0.8s after load; give the build + fade time,
  // then look around slightly for a representative vista.
  await page.waitForTimeout(3000);
  await page.mouse.move(800, 500);
  await page.mouse.move(1100, 460, { steps: 20 });
  await page.waitForTimeout(500);
}
// gym-spawn: no movement — the spawn framing is the baseline shot.

let fpsResult = null;
if (fpsSeconds > 0) {
  fpsResult = await page.evaluate(
    (seconds) =>
      new Promise((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          frames += 1;
          const elapsed = performance.now() - start;
          if (elapsed >= seconds * 1000) resolve({ fps: (frames * 1000) / elapsed, seconds: elapsed / 1000 });
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    fpsSeconds
  );
}

await page.screenshot({ path: outPath });
await browser.close();

console.log(`shot: ${outPath}`);
if (fpsResult) {
  console.log(`fps: ${fpsResult.fps.toFixed(1)} (over ${fpsResult.seconds.toFixed(1)}s${headed ? '' : ' — HEADLESS, may be SwiftShader; use --headed for real numbers'})`);
}
if (graphicsLines.length > 0) {
  console.log('--- [graphics] audit ---');
  for (const line of graphicsLines) console.log(line);
} else {
  console.log('(no [graphics] audit lines captured)');
}
if (errorLines.length > 0) {
  console.log('--- page errors ---');
  for (const line of errorLines.slice(0, 12)) console.log(line);
}
