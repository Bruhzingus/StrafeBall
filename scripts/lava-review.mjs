import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const out = 'tmp/lava-review';
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/scene.ts`, `
import { Engine, Scene, FreeCamera, Vector3, Color4, HemisphericLight, DirectionalLight } from '@babylonjs/core';
import { LavaSurface } from '/src/game/powerups/LavaSurface';
import { GymArena } from '/src/game/map/GymArena';
import { ModelLoader } from '/src/game/assets/ModelLoader';
import { settings } from '/src/game/config/Settings';
const canvas = document.querySelector('canvas');
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.07, 0.08, 0.11, 1);
const camera = new FreeCamera('camera', new Vector3(12.7, 3.6, -12), scene);
camera.setTarget(new Vector3(0, 0.8, 1));
camera.minZ = 0.05;
new HemisphericLight('fill', new Vector3(0, 1, 0), scene).intensity = 1.1;
new DirectionalLight('key', new Vector3(-0.3, -1, 0.3), scene).intensity = 0.8;
const gym = new GymArena(scene, new ModelLoader(scene));
gym.build();
const lava = new LavaSurface(scene);
lava.update(1.5, 6);
engine.runRenderLoop(() => scene.render());
window.review = { engine, scene, lava, camera, settings, ready: false };
await scene.whenReadyAsync();
window.review.ready = true;
`);
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
const requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && /shader|GLSL|compil/i.test(message.text())) errors.push(message.text()); });
page.on('request', request => { if (request.url().includes('/assets/lava/')) requests.push(request.url()); });
await page.route('**/lava-review', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><canvas style="width:100vw;height:100vh;display:block"></canvas><script type="module" src="/tmp/lava-review/scene.ts"></script></body></html>' }));
const checks = [];
try {
  await page.goto(`${base}/lava-review`);
  await page.waitForFunction(() => window.review?.ready, { timeout: 30000 });
  for (const quality of ['performance', 'polished']) {
    await page.evaluate(quality => {
      localStorage.setItem('strafeball.graphics.mode', quality);
      window.review.settings.reducedEffects = quality === 'performance';
      window.review.lava.update(1.5, 6);
    }, quality);
    await page.waitForTimeout(150);
    const state = await page.evaluate(() => {
      const { lava, scene } = window.review;
      scene.render();
      return { enabled: lava.mesh.isEnabled(), ready: lava.mesh.material.isReady(lava.mesh), height: lava.mesh.position.y, shaderError: lava.mesh.material.getEffect()?.getCompilationError() ?? '' };
    });
    checks.push({ quality, ...state });
    await page.screenshot({ path: `${out}/${quality}.png` });
  }
  const hidden = await page.evaluate(() => {
    window.review.lava.update(0, 8);
    return !window.review.lava.mesh.isEnabled();
  });
  const result = { checks, hidden, missingTextureRequests: requests, errors };
  writeFileSync(`${out}/results.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!hidden || requests.length || errors.length || checks.some(check => !check.enabled || !check.ready || check.shaderError || Math.abs(check.height - 1.51) > 0.001)) process.exitCode = 1;
} finally {
  await browser.close();
}
