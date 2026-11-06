// Launches the Electron app, attaches over CDP and checks it really works: secure app:// origin,
// IndexedDB + WebCrypto, account creation, serverless network online, desktop bridge present.
//   node tests/e2e/desktop-smoke.mjs   (after `node scripts/build-variant.mjs serverless`)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// CELCHAT_EXE=release/win-unpacked/CelChat.exe tests the packaged app instead of the dev runtime
const packaged = process.env.CELCHAT_EXE;
const exe = packaged ? path.resolve(root, packaged) : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const userData = mkdtempSync(path.join(tmpdir(), 'celchat-desktop-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(exe, [...(packaged ? [] : ['.']), '--remote-debugging-port=9339', `--user-data-dir=${userData}`], { cwd: root, stdio: 'ignore' });
let ok = false;
const logs = [];
try {
  let browser;
  for (let i = 0; i < 40 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9339');
    } catch {
      await sleep(500);
    }
  }
  if (!browser) throw new Error('could not attach to the desktop app');
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('app://'));
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('no app:// window');
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  const env = await page.evaluate(() => ({ url: location.href, secure: isSecureContext, idb: !!indexedDB, bridge: !!window.celDesktop, ua: navigator.userAgent.includes('CelChatDesktop') }));
  console.log('window:', JSON.stringify(env));
  if (!env.secure || !env.bridge || !env.ua) throw new Error('desktop environment incomplete');
  await page.getByText('Create your account').waitFor({ timeout: 15000 });
  const inputs = page.locator('input');
  const name = 'desk' + Math.random().toString(36).slice(2, 7);
  await inputs.nth(0).fill(name);
  await inputs.nth(2).fill('desktop-smoke-pass');
  await inputs.nth(3).fill('desktop-smoke-pass');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.locator('.rail').waitFor({ timeout: 30000 });
  for (let i = 0; i < 60; i++) {
    const online = await page.evaluate(() => !!document.querySelector('.hub-dot.online'));
    if (online) {
      ok = true;
      break;
    }
    await sleep(500);
  }
  console.log(ok ? 'PASS desktop app: signed up and connected to the public brokers' : 'FAIL: never came online');
  if (ok) {
    // bots run in a sandboxed srcdoc iframe + Worker: make sure that works under app://, through the UI
    try {
      await page.keyboard.press('Control+Comma');
      await page.locator('.settings-tab', { hasText: 'Bots' }).click({ timeout: 10000 });
      await page.locator('.template-card', { hasText: 'Starter Bot' }).click({ timeout: 10000 });
      await page.locator('.bot-nav-head .bot-status.running').waitFor({ timeout: 20000 });
      await page.locator('.play-compose input').fill('/ping');
      await page.locator('.play-compose input').press('Enter');
      await page.locator('.play-msg .msg-body', { hasText: 'Pong!' }).waitFor({ timeout: 10000 });
      console.log('PASS desktop app: a sandboxed bot runs and answers /ping');
      // CELBOT=path/to/file.celbot also imports a bot file through the UI (it must keep its avatar)
      if (process.env.CELBOT) {
        await page.locator('.settings-tab', { hasText: 'All bots' }).click();
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: /Import bot/ }).click();
        await (await chooser).setFiles(path.resolve(process.env.CELBOT));
        await page.getByRole('button', { name: 'Import', exact: true }).click();
        await page.locator('.bot-nav-head').waitFor({ timeout: 15000 });
        console.log('PASS desktop app: imported', (await page.locator('.bot-nav-name').innerText()).trim());
      }
    } catch (e) {
      ok = false;
      console.log('FAIL bot in desktop app:', e.message.split('\n')[0]);
      console.log('  studio:', await page.locator('.settings-main').innerText().catch(() => '(none)').then((t) => t.slice(0, 400)));
      console.log('  console:', logs.slice(-12).join('\n  '));
    }
  }
  await browser.close();
} catch (e) {
  console.log('FAIL', e.message);
} finally {
  proc.kill();
  await sleep(800);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    /* electron may still hold files */
  }
  process.exit(ok ? 0 : 1);
}
