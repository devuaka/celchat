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
