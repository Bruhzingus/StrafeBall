import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const overlay = page.locator('#lock-overlay');
if (await overlay.count() > 0) {
  try { await overlay.click({ timeout: 2000, force: true }); } catch {}
}
await page.waitForTimeout(1500);

// Walk toward north-east corner using WASD + look right, to frame the corner seam like the user's shot.
await page.mouse.move(800, 500);
await page.mouse.move(1150, 480, { steps: 20 }); // turn right a bit
await page.waitForTimeout(300);

await page.keyboard.down('w');
await page.waitForTimeout(2500);
await page.keyboard.up('w');
await page.waitForTimeout(300);

await page.mouse.move(1150, 480);
await page.mouse.move(1550, 380, { steps: 20 }); // turn further right + up toward corner
await page.waitForTimeout(500);

await page.screenshot({ path: 'scripts/_corner-check.png' });
await browser.close();
