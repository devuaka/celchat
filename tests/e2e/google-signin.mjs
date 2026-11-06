// "Continue with Google" end to end against a FAKE Google (OAuth page, tokeninfo, userinfo, Drive
// app-data folder), so it runs without a Google Cloud project. Real browser, real popup, real
// oauth.html hand-back.
//   node tests/e2e/google-signin.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8795;
const BASE = `http://localhost:${PORT}/`;
const CLIENT = 'test-client.apps.googleusercontent.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log('  PASS', name);
  } catch (e) {
    failed++;
    console.log('  FAIL', name, '\n   ', e.message.split('\n')[0]);
  }
};

// ---- fake Google -----------------------------------------------------------------------------
const users = {
  alice: { sub: '1001', email: 'alice@gmail.example', name: 'Alice Test' },
  carol: { sub: '1003', email: 'carol@gmail.example', name: 'Carol Test' },
};
let signingInAs = 'alice';
const drives = {}; // sub -> { id, body }
const tokens = {}; // token -> user
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
const json = (route, status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function fakeGoogle(context) {
  await context.route(/^https:\/\/accounts\.google\.com\//, (route) => {
    const u = new URL(route.request().url());
    if (u.searchParams.get('client_id') !== CLIENT) return route.fulfill({ status: 400, body: 'bad client' });
    const token = 'tok-' + Math.random().toString(36).slice(2);
    tokens[token] = users[signingInAs];
    const back = `${u.searchParams.get('redirect_uri')}#access_token=${token}&token_type=Bearer&expires_in=3599&scope=${encodeURIComponent(u.searchParams.get('scope'))}&state=${u.searchParams.get('state')}`;
    return route.fulfill({ status: 302, headers: { location: back } });
  });
  await context.route(/^https:\/\/(oauth2|openidconnect|www)\.googleapis\.com\//, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    if (u.pathname === '/tokeninfo') {
      return tokens[u.searchParams.get('access_token')] ? json(route, 200, { aud: CLIENT, azp: CLIENT, scope: 'openid email profile https://www.googleapis.com/auth/drive.appdata' }) : json(route, 400, { error: 'invalid_token' });
    }
    const user = tokens[(req.headers().authorization || '').replace('Bearer ', '')];
    if (!user) return json(route, 401, { error: { message: 'no auth' } });
    if (u.pathname === '/v1/userinfo') return json(route, 200, user);
    const d = drives[user.sub];
    if (u.pathname === '/drive/v3/files' && req.method() === 'GET') return json(route, 200, { files: d ? [{ id: d.id }] : [] });
    if (u.pathname.startsWith('/drive/v3/files/') && req.method() === 'GET') return d ? route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: d.body }) : json(route, 404, {});
    if (u.pathname.startsWith('/drive/v3/files/') && req.method() === 'DELETE') {
      delete drives[user.sub];
      return route.fulfill({ status: 204, headers: cors });
    }
    if (u.pathname === '/upload/drive/v3/files' && req.method() === 'POST') {
      const body = req.postData();
      const parts = body.split(/--celchat[0-9a-f]+/);
      const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]);
      if (!meta.parents?.includes('appDataFolder')) return json(route, 400, { error: { message: 'not app data' } });
      drives[user.sub] = { id: 'f' + user.sub, body: parts[2].split('\r\n\r\n')[1].trim() };
      return json(route, 200, { id: drives[user.sub].id });
    }
    if (u.pathname.startsWith('/upload/drive/v3/files/') && req.method() === 'PATCH') {
      drives[user.sub] = { id: 'f' + user.sub, body: req.postData() };
      return json(route, 200, { id: drives[user.sub].id });
    }
    return json(route, 404, { error: { message: 'unhandled ' + u.pathname } });
  });
}

// ---- run -------------------------------------------------------------------------------------
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', 'vite.config.ts', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  env: { ...process.env, VITE_GOOGLE_CLIENT_ID: CLIENT, VITE_SERVERLESS: '' },
  stdio: 'ignore',
});
const browser = await chromium.launch({ channel: 'chrome' });
const device = async () => {
  const ctx = await browser.newContext();
  await fakeGoogle(ctx);
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('cel-welcomed', '1');
    } catch {}
  });
  const page = await ctx.newPage();
  for (let i = 0; i < 60; i++) {
    try {
      await page.goto(BASE, { timeout: 5000 });
      break;
    } catch {
      await sleep(500);
    }
  }
  return page;
};
const ready = (page) => page.waitForFunction(() => window.__cel?.store.getState().phase === 'ready', null, { timeout: 30000 });
const me = (page) => page.evaluate(() => window.__cel.store.getState().me);

try {
  let alicePub;
  const d1 = await device();
  await check('device 1: Continue with Google creates an account kept in Drive', async () => {
    await d1.locator('.google-btn').first().click();
    await d1.getByText('Welcome to CelChat').waitFor({ timeout: 15000 });
    const prefilled = await d1.locator('.input-prefix input').inputValue();
    if (prefilled !== 'alice') throw new Error('username not prefilled from the email: ' + prefilled);
    await d1.getByRole('button', { name: 'Create account' }).click();
    await ready(d1);
    alicePub = await me(d1);
    const stored = JSON.parse(drives['1001'].body);
    if (stored.pub !== alicePub || stored.username !== 'alice' || !stored.seed) throw new Error('Drive file does not hold this account');
  });

  const d2 = await device();
  await check('device 2: Continue with Google signs in to the SAME account', async () => {
    await d2.locator('.google-btn').first().click();
    await ready(d2);
    if ((await me(d2)) !== alicePub) throw new Error('different identity on device 2');
  });

  await check('device 2: signed out, the Google-only account unlocks with Google', async () => {
    await d2.evaluate(() => window.__cel.app().logout());
    await d2.getByText('Welcome back').waitFor({ timeout: 20000 });
    await d2.getByText('alice@gmail.example').waitFor();
    await d2.locator('.acct-main').first().click();
    await d2.getByText('This account signs in with Google').waitFor();
    await d2.locator('.google-btn').click();
    await ready(d2);
    if ((await me(d2)) !== alicePub) throw new Error('wrong account after unlock');
  });

  const d3 = await device();
  let carolPub;
  await check('existing password account: link Google in Settings', async () => {
    const inputs = d3.locator('.auth-body input');
    await inputs.nth(0).fill('carolpw');
    await inputs.nth(2).fill('a-long-password');
    await inputs.nth(3).fill('a-long-password');
    await d3.getByRole('button', { name: 'Create account' }).click();
    await ready(d3);
    carolPub = await me(d3);
    signingInAs = 'carol';
    await d3.evaluate(() => window.__cel.store.setState({ modal: { kind: 'settings', props: { tab: 'account' } } }));
    await d3.getByRole('button', { name: 'Link Google account' }).click();
    await d3.locator('.settings-main').getByText('carol@gmail.example').waitFor({ timeout: 15000 });
    if (JSON.parse(drives['1003'].body).pub !== carolPub) throw new Error('not saved to Drive');
  });

  const d4 = await device();
  await check('device 4: Continue with Google opens the linked password account', async () => {
    signingInAs = 'carol';
    await d4.locator('.google-btn').first().click();
    await ready(d4);
    if ((await me(d4)) !== carolPub) throw new Error('wrong account');
  });

  await check('unlink removes the key from Drive; a Google account holding another CelChat account is refused', async () => {
    signingInAs = 'carol';
    await d3.getByRole('button', { name: 'Unlink Google' }).click();
    await d3.getByRole('button', { name: 'Unlink', exact: true }).click();
    await d3.getByRole('button', { name: 'Link Google account' }).waitFor({ timeout: 15000 });
    if (drives['1003']) throw new Error('Drive file still there');
    signingInAs = 'alice';
    await d3.getByRole('button', { name: 'Link Google account' }).click();
    await d3.getByText(/already signs in to the CelChat account @alice/).waitFor({ timeout: 15000 });
  });
} finally {
  await browser.close();
  vite.kill();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
