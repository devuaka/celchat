// Imports a .celbot file through the real UI of a production build and plays one command.
//   node tests/e2e/import-smoke.mjs <url of the built app> <path to .celbot>
// e.g. after `npm run build:site` and serving site/ on :8784:
//   node tests/e2e/import-smoke.mjs http://localhost:8784/app/ "../celchat-bots/high-roller/High Roller.celbot"
import { chromium } from 'playwright-core';
import path from 'node:path';

const [url = 'http://localhost:8784/app/', file] = process.argv.slice(2);
if (!file) throw new Error('pass the .celbot path');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let ok = false;
try {
  await page.addInitScript(() => localStorage.setItem('cel-welcomed', '1'));
  await page.goto(url);
  await page.getByText('Create your account').waitFor({ timeout: 20000 });
  const inputs = page.locator('input');
  const pw = 'pw-' + Math.random().toString(36).slice(2);
  await inputs.nth(0).fill('imp' + Math.random().toString(36).slice(2, 8));
  await inputs.nth(2).fill(pw);
  await inputs.nth(3).fill(pw);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.locator('.rail').waitFor({ timeout: 30000 });
  await page.keyboard.press('Control+Comma');
  await page.locator('.settings-tab', { hasText: 'Bots' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Import bot/ }).click();
  await (await chooser).setFiles(path.resolve(file));
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.locator('.bot-nav-head').waitFor({ timeout: 15000 });
  console.log('imported:', (await page.locator('.bot-nav-name').innerText()).trim());
  await page.locator('.bot-nav-actions button', { hasText: 'Run' }).click();
  await page.locator('.bot-nav-head .bot-status.running').waitFor({ timeout: 20000 });
  await page.locator('.settings-tab', { hasText: 'Test' }).click();
  await page.locator('.play-compose input').fill('/casino');
  await page.locator('.play-compose input').press('Enter');
  await page.locator('.play-msg .embed-title', { hasText: 'Welcome' }).waitFor({ timeout: 10000 });
  ok = true;
  console.log('PASS: imported through the UI, ran it, /casino answered');
} catch (e) {
  console.log('FAIL', e.message.split('\n')[0]);
  console.log('errors:', errors.slice(-6).join('\n  '));
} finally {
  await browser.close();
  process.exit(ok ? 0 : 1);
}
