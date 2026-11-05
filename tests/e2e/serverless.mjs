// Serverless-mode e2e: two isolated browsers talk through the PUBLIC MQTT brokers (no hub at all).
// Needs internet. Usernames are random because the public directory is shared with everyone.
//   node tests/e2e/serverless.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_PORT = 8794;
const BASE = `http://localhost:${WEB_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const results = [];

async function waitFor(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up */
    }
    await sleep(300);
  }
  throw new Error('timeout ' + url);
}
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(true);
    console.log(`  \x1b[32mPASS\x1b[0m ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push(false);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}: ${e.message}`);
  }
}
async function until(page, fn, arg, ms = 30000, what = 'condition') {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await page.evaluate(fn, arg).catch((e) => ({ __err: e.message }));
    if (last && !last.__err) return last;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 160)})`);
}

async function signUp(page, username) {
  await page.goto(BASE);
  await page.getByText('Create your account').waitFor();
  const inputs = page.locator('input');
  await inputs.nth(0).fill(username);
  await inputs.nth(1).fill(username);
  await inputs.nth(2).fill('serverless-e2e-pass');
  await inputs.nth(3).fill('serverless-e2e-pass');
  await page.getByRole('button', { name: 'Create account' }).click();
  await until(page, () => window.__cel?.store.getState().phase === 'ready', null, 30000, 'ready');
  await until(page, () => window.__cel.store.getState().hub.state === 'online', null, 30000, 'brokers online');
}

async function main() {
  // no hub at all: VITE_SERVERLESS makes public brokers the default, like the published website
  procs.push(spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', 'vite.config.ts', '--port', String(WEB_PORT)], { cwd: root, env: { ...process.env, VITE_SERVERLESS: '1' }, stdio: 'ignore' }));
  await waitFor(BASE);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !process.env.HEADED,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  const A = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  const B = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  const tag = randomBytes(3).toString('hex');
  const ua = `e2ea_${tag}`;
  const ub = `e2eb_${tag}`;
  let alice, bob, c;

  await check('both sign up and reach the public brokers', async () => {
    await signUp(A, ua);
    await signUp(B, ub);
    alice = await A.evaluate(() => window.__cel.store.getState().me);
    bob = await B.evaluate(() => window.__cel.store.getState().me);
    const kind = await A.evaluate(() => window.__cel.app().hub.kind);
    if (kind !== 'mqtt') throw new Error('not in serverless mode: ' + kind);
  });

  await check('username directory + sealed friend request over brokers', async () => {
    await until(B, (u) => window.__cel.app().resolveUser('@' + u).then(() => true).catch(() => false), ua, 30000, 'directory lookup');
    await B.evaluate((u) => window.__cel.app().addFriend('@' + u), ua);
    await until(A, (b) => window.__cel.store.getState().friends[b]?.state === 'incoming', bob, 30000, 'request');
    await A.evaluate((b) => window.__cel.app().acceptFriend(b), bob);
    await until(B, (a) => window.__cel.store.getState().friends[a]?.state === 'friend', alice, 30000, 'accept');
  });

  await check('encrypted presence + WebRTC link via broker signaling', async () => {
    await until(A, (b) => window.__cel.store.getState().presence[b] === 'online', bob, 40000, 'presence');
    await until(A, (b) => window.__cel.app().peers.byPub(b).some((l) => l.helloReceived), bob, 40000, 'link');
  });

  await check('DM + community join + message, all peer to peer', async () => {
    await A.evaluate(async (b) => {
      const a = window.__cel.app();
      await a.sendMessage(await a.openDm(b), 'main', 'hi over brokers', []);
    }, bob);
    await until(B, () => Object.values(window.__cel.store.getState().convos).some((x) => x.type === 'dm'), null, 20000, 'dm');
    const link = await A.evaluate(async () => {
      const a = window.__cel.app();
      const cc = await a.createCommunity('Serverless Guild');
      return a.createInvite(cc, 3600, 3);
    });
    c = link.match(/[0-9a-f]{64}/)[0];
    await B.evaluate((l) => window.__cel.app().joinByInvite(l), link);
    await until(B, (cc) => !!window.__cel.store.getState().states[cc]?.members[window.__cel.store.getState().me], c, 40000, 'joined');
    await B.evaluate((cc) => window.__cel.app().sendMessage(cc, window.__cel.app().firstChannel(window.__cel.store.getState().states[cc]), 'gm serverless', []), c);
    await until(A, (cc) => window.__cel.app().search([cc], { text: 'gm serverless' }).then((r) => r.length > 0), c, 20000, 'message on A');
  });

  await check('offline DM through the retained-message mailbox', async () => {
    const dc = await A.evaluate(() => Object.values(window.__cel.store.getState().convos).find((x) => x.type === 'dm').c);
    await B.goto('about:blank');
    await until(A, (b) => !window.__cel.app().peers.byPub(b).length || !window.__cel.store.getState().presence[b], bob, 90000, 'B gone');
    await A.evaluate((d) => window.__cel.app().sendMessage(d, 'main', 'sealed while you were away', []), dc);
    await sleep(1500);
    await B.goto(BASE);
    await until(B, () => window.__cel?.store.getState().phase === 'ready', null, 30000, 'B back');
    await until(B, (d) => window.__cel.app().convos.loadChannel(d, 'main').then((r) => r.messages.some((m) => m.text === 'sealed while you were away')), dc, 45000, 'mailbox delivery');
  });

  await browser.close();
}

main()
  .catch((e) => {
    console.error(e);
    results.push(false);
  })
  .finally(() => {
    for (const p of procs) p.kill();
    const pass = results.filter(Boolean).length;
    console.log(`\n${pass}/${results.length} passed`);
    process.exit(pass === results.length ? 0 : 1);
  });
