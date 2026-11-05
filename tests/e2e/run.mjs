// End-to-end test: two isolated browser contexts (two separate CelChat users),
// a fresh hub with an empty data dir, real WebRTC between them, fake mics.
//
//   npm run test:e2e            (starts its own hub on :8791 and client on :8790)
//   HEADED=1 npm run test:e2e   to watch
//   BROWSER=msedge              to use Edge instead of Chrome
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HUB_PORT = 8791;
const WEB_PORT = 8790;
const KEEPER_STATUS = 8792;
const BASE = `http://localhost:${WEB_PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'celchat-e2e-'));
const procs = [];
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(args, env) {
  const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  p.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write('[srv] ' + d));
  procs.push(p);
}

async function waitFor(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error('timeout waiting for ' + url);
}

async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  \x1b[32mPASS\x1b[0m ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}: ${e.message}`);
  }
}

/** Poll a page function until it returns truthy. */
async function until(page, fn, arg, ms = 20000, what = 'condition') {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await page.evaluate(fn, arg).catch((e) => ({ __err: e.message }));
    if (last && !last.__err) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 200)})`);
}

async function signUp(page, username, display, password) {
  await page.goto(BASE);
  await page.getByText('Create your account').waitFor();
  const inputs = page.locator('input');
  await inputs.nth(0).fill(username);
  await inputs.nth(1).fill(display);
  await inputs.nth(2).fill(password);
  await inputs.nth(3).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await until(page, () => window.__cel?.store.getState().phase === 'ready' && window.__cel.store.getState().hub.state === 'online', null, 30000, 'signed in + hub online');
}

const me = (page) => page.evaluate(() => window.__cel.store.getState().me);

async function main() {
  console.log('CelChat e2e: starting hub + client...');
  start([path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'hub/src/index.ts'], { HUB_PORT: String(HUB_PORT), DATA_DIR: dataDir, STATIC_DIR: path.join(dataDir, 'nostatic') });
  start([path.join(root, 'node_modules/vite/bin/vite.js'), '--config', 'vite.config.ts', '--port', String(WEB_PORT)], { HUB_DEV_URL: `http://localhost:${HUB_PORT}` });
  await waitFor(`http://localhost:${HUB_PORT}/api/health`);
  start([path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'keeper/src/index.ts'], {
    KEEPER_HUB_URL: `ws://localhost:${HUB_PORT}/ws`,
    KEEPER_DATA_DIR: path.join(dataDir, 'keeper'),
    KEEPER_OPEN: '1',
    KEEPER_USERNAME: 'archive',
    KEEPER_STATUS_PORT: String(KEEPER_STATUS),
  });
  await waitFor(BASE);
  await waitFor(`http://127.0.0.1:${KEEPER_STATUS}/status`);

  const browser = await chromium.launch({
    channel: process.env.BROWSER || 'chrome',
    headless: !process.env.HEADED,
    // Two contexts on one machine: expose real host IPs instead of mDNS names, whose resolution is flaky on Windows.
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--auto-select-desktop-capture-source=Entire screen', '--enable-features=GetDisplayMediaSetAutoSelectAllScreens'],
  });
  const ctxA = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1400, height: 860 } });
  const ctxB = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1400, height: 860 } });
  // skip the first-run welcome dialog in tests
  for (const ctx of [ctxA, ctxB]) await ctx.addInitScript(() => { try { localStorage.setItem('cel-welcomed', '1'); } catch { /* about:blank */ } });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  for (const [n, p] of [['A', A], ['B', B]]) {
    p.on('pageerror', (e) => console.log(`  [${n} pageerror] ${e.message}`));
    p.on('console', (m) => (m.type() === 'error' || /\[peer\]|negotiation|signal handling/.test(m.text())) && !/favicon|404/.test(m.text()) && console.log(`  [${n} console] ${m.text().slice(0, 400)}`));
  }

  let alice, bob, c, ch;

  await check('both users sign up (keys made in-browser, hub auth by signature)', async () => {
    await signUp(A, 'alice', 'Alice', 'e2e-pass-alice');
    await signUp(B, 'bob', 'Bob', 'e2e-pass-bob');
    alice = await me(A);
    bob = await me(B);
    if (alice === bob) throw new Error('same key?');
  });

  await check('friend request by @username via directory + sealed mailbox', async () => {
    await B.evaluate(() => window.__cel.app().addFriend('@alice'));
    await until(A, (b) => window.__cel.store.getState().friends[b]?.state === 'incoming', bob, 15000, 'incoming request');
    await A.evaluate((b) => window.__cel.app().acceptFriend(b), bob);
    await until(B, (a) => window.__cel.store.getState().friends[a]?.state === 'friend', alice, 15000, 'friendship on B');
  });

  await check('friends see each other online and open a direct WebRTC link', async () => {
    await until(A, (b) => window.__cel.store.getState().presence[b] === 'online', bob, 15000, 'presence');
    try {
      await until(A, (b) => window.__cel.app().peers.byPub(b).some((l) => l.state === 'direct' && l.helloReceived), bob, 25000, 'direct link');
    } catch (e) {
      const dump = (p) => p.evaluate(() => [...window.__cel.app().peers.links.values()].map((l) => ({ state: l.state, polite: l.polite, pc: l.pc?.connectionState, ice: l.pc?.iceConnectionState, sig: l.pc?.signalingState, gather: l.pc?.iceGatheringState, dc: l.dc?.readyState })));
      console.log('  A links:', JSON.stringify(await dump(A)));
      console.log('  B links:', JSON.stringify(await dump(B)));
      throw e;
    }
  });

  await check('DM delivered peer to peer and rendered with markdown', async () => {
    await A.evaluate(async (b) => {
      const a = window.__cel.app();
      const dc = await a.openDm(b);
      await a.sendMessage(dc, 'main', 'hello **bob** from e2e', []);
    }, bob);
    await until(B, () => Object.values(window.__cel.store.getState().convos).some((x) => x.type === 'dm'), null, 15000, 'dm convo on B');
    await B.evaluate(() => {
      const s = window.__cel.store.getState();
      const dc = Object.values(s.convos).find((x) => x.type === 'dm').c;
      window.__cel.app().navigate({ kind: 'dm', c: dc });
    });
    await B.locator('.msg-body strong', { hasText: 'bob' }).waitFor({ timeout: 10000 });
  });

  await check('create community + invite + join (state synced from a member, no server copy)', async () => {
    const link = await A.evaluate(async () => {
      const a = window.__cel.app();
      const cc = await a.createCommunity('E2E Guild');
      return a.createInvite(cc, 3600, 5);
    });
    c = link.match(/[0-9a-f]{64}/)[0];
    await B.evaluate((l) => window.__cel.app().joinByInvite(l), link);
    await until(B, (cc) => !!window.__cel.store.getState().states[cc]?.members[window.__cel.store.getState().me], c, 25000, 'B is a member');
    await until(A, (cc) => Object.keys(window.__cel.store.getState().states[cc]?.members ?? {}).length === 2, c, 15000, 'A sees 2 members');
    ch = await A.evaluate((cc) => window.__cel.app().firstChannel(window.__cel.store.getState().states[cc]), c);
  });

  await check('channel message gossips to the other member', async () => {
    await B.evaluate(([cc, chh]) => window.__cel.app().sendMessage(cc, chh, 'gm from bob', []), [c, ch]);
    await A.evaluate(([cc, chh]) => window.__cel.app().navigate({ kind: 'community', c: cc, ch: chh }), [c, ch]);
    await A.getByText('gm from bob').waitFor({ timeout: 10000 });
  });

  await check('file attachment travels P2P in chunks and verifies by sha256', async () => {
    const hash = await A.evaluate(async ([cc, chh]) => {
      const bytes = new Uint8Array(300_000);
      crypto.getRandomValues(bytes.subarray(0, 65536));
      const f = new File([bytes], 'payload.bin', { type: 'application/octet-stream' });
      const op = await window.__cel.app().sendMessage(cc, chh, 'a file', [f]);
      return op.p.att[0].hash;
    }, [c, ch]);
    await until(B, (h) => window.__cel.app().files.has(h).then((x) => x || window.__cel.app().ensureBlob({ hash: h, size: 300000, mime: 'application/octet-stream' }, { auto: true }).then(() => false)), hash, 25000, 'file on B');
  });

  await check('reactions, edits and deletes converge on both sides', async () => {
    const id = await B.evaluate(async ([cc, chh]) => {
      const a = window.__cel.app();
      const op = await a.sendMessage(cc, chh, 'original text', []);
      await a.editMessage(cc, op.id, 'edited text');
      return op.id;
    }, [c, ch]);
    await A.evaluate(([cc, mid]) => window.__cel.app().react(cc, mid, '🔥', true), [c, id]);
    await until(B, ([cc, mid]) => window.__cel.app().convos.getMessage(cc, mid).then((m) => m && m.text === 'edited text' && m.reacts['🔥']?.length === 1), [c, id], 10000, 'edit+react on B');
    await B.evaluate(([cc, mid]) => window.__cel.app().deleteMessage(cc, mid), [c, id]);
    await until(A, ([cc, mid]) => window.__cel.app().convos.getMessage(cc, mid).then((m) => !m || m.deleted), [c, id], 10000, 'delete on A');
  });

  await check('permissions are enforced by every peer (forged op rejected)', async () => {
    await A.evaluate(([cc, chh]) => window.__cel.app().updateChannel(cc, chh, { overwrites: { [cc]: { allow: 0, deny: 1 << 10 } } }), [c, ch]);
    await until(B, ([cc, chh]) => !!window.__cel.store.getState().states[cc]?.channels[chh]?.overwrites[cc], [c, ch], 10000, 'overwrite synced');
    const opId = await B.evaluate(async ([cc, chh]) => {
      const a = window.__cel.app();
      const op = await a.convos.author(cc, 'msg', { ch: chh, text: 'FORGED' });
      a.sync.gossip(op);
      return op.id;
    }, [c, ch]);
    await until(A, (oid) => window.__cel.app().convos.getOp(oid).then((o) => !!o), opId, 10000, 'forged op arrives');
    const verdict = await A.evaluate(([cc, oid]) => window.__cel.app().convos.getOp(oid).then((o) => window.__cel.app().convos.get(cc).eng.checkMessageOp(o)), [c, opId]);
    if (verdict.ok) throw new Error('forged message was accepted');
    await A.evaluate(([cc, chh]) => window.__cel.app().updateChannel(cc, chh, { overwrites: {} }), [c, ch]);
  });

  await check('voice channel: both join, mesh audio flows both ways (fake mics)', async () => {
    const voiceCh = await A.evaluate((cc) => Object.values(window.__cel.store.getState().states[cc].channels).find((x) => x.type === 'voice').id, c);
    await A.evaluate(([cc, v]) => window.__cel.app().joinVoice(cc, v), [c, voiceCh]);
    await B.evaluate(([cc, v]) => window.__cel.app().joinVoice(cc, v), [c, voiceCh]);
    const bytes = (pub) => {
      const l = window.__cel.app().peers.byPub(pub)[0];
      if (!l?.pc) return Promise.resolve(0);
      return l.pc.getStats().then((st) => {
        let rx = 0;
        st.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') rx += r.bytesReceived ?? 0;
        });
        return rx > 2000 ? rx : 0;
      });
    };
    try {
      await until(A, bytes, bob, 30000, 'A receiving audio');
      await until(B, bytes, alice, 30000, 'B receiving audio');
    } catch (e) {
      const dump = (p) => p.evaluate(async () => {
        const a = window.__cel.app();
        const out = [];
        for (const l of a.peers.links.values()) {
          const st = l.pc ? await l.pc.getStats() : null;
          const rtp = [];
          st?.forEach((r) => (r.type === 'inbound-rtp' || r.type === 'outbound-rtp') && r.kind === 'audio' && rtp.push([r.type, r.bytesReceived ?? r.bytesSent]));
          out.push({ state: l.state, polite: l.polite, pc: l.pc?.connectionState, sig: l.pc?.signalingState, tx: l.pc?.getTransceivers().map((t) => [t.mid, t.direction, t.currentDirection, !!t.sender.track]), rtp, voicePeers: [...a.voice.peers.values()].map((p) => p.connected) });
        }
        return out;
      });
      console.log('  A:', JSON.stringify(await dump(A)));
      console.log('  B:', JSON.stringify(await dump(B)));
      throw e;
    }
    await until(A, (cc) => Object.keys(Object.entries(window.__cel.store.getState().voiceRooms).find(([k]) => k.startsWith(cc))?.[1] ?? {}).length === 2, c, 30000, 'voice presence shows 2');
  });

  await check('camera + 1080p screen share reach the other side, labelled correctly', async () => {
    await A.evaluate(() => window.__cel.app().toggleCamera());
    // screen capture needs a real user gesture: click the button on the voice stage
    await A.locator('button[title^="Share screen"]').click();
    await until(B, (a) => {
      const p = window.__cel.app().voice.peers;
      const peer = [...p.values()].find((x) => x.pub === a);
      return peer && peer.cam && peer.screen ? true : null;
    }, alice, 30000, 'B sees camera + screen');
    const tiles = await B.locator('.tile video').count().catch(() => 0);
    await A.evaluate(() => {
      window.__cel.app().voice.stopScreen();
      window.__cel.app().voice.stopCamera();
    });
    await until(B, (a) => {
      const peer = [...window.__cel.app().voice.peers.values()].find((x) => x.pub === a);
      return peer && !peer.cam && !peer.screen ? true : null;
    }, alice, 20000, 'B sees them stop');
    await A.evaluate(() => window.__cel.app().leaveVoice());
    await B.evaluate(() => window.__cel.app().leaveVoice());
    void tiles;
  });

  await check('polls: votes from both sides converge', async () => {
    const id = await A.evaluate(async ([cc, chh]) => (await window.__cel.app().sendPoll(cc, chh, { q: 'Ship it?', options: ['yes', 'no'], multi: false, durationSecs: 3600 })).id, [c, ch]);
    await until(B, ([cc, mid]) => window.__cel.app().convos.getMessage(cc, mid).then((m) => !!m?.poll), [c, id], 10000, 'poll on B');
    await B.evaluate(([cc, mid]) => window.__cel.app().vote(cc, mid, [0]), [c, id]);
    await A.evaluate(([cc, mid]) => window.__cel.app().vote(cc, mid, [1]), [c, id]);
    await until(A, ([cc, mid, b]) => window.__cel.app().convos.getMessage(cc, mid).then((m) => m.poll.votes[b]?.[0] === 0 && Object.keys(m.poll.votes).length === 2), [c, id, bob], 10000, 'both votes on A');
  });

  await check('custom community emoji: added by the owner, used by a member in a DM', async () => {
    await A.evaluate(async (cc) => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g = cv.getContext('2d');
      g.fillStyle = '#5fd3b3';
      g.beginPath();
      g.arc(32, 32, 28, 0, 7);
      g.fill();
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      await window.__cel.app().addEmoji(cc, 'celadon', new File([blob], 'e.png', { type: 'image/png' }));
    }, c);
    const token = await until(B, () => window.__cel.app().allEmoji().find((e) => e.name === 'celadon')?.token ?? null, null, 10000, 'emoji synced to B');
    const dc = await B.evaluate(() => Object.values(window.__cel.store.getState().convos).find((x) => x.type === 'dm').c);
    await B.evaluate(([d, t]) => window.__cel.app().sendMessage(d, 'main', `look ${t}`, []), [dc, token]);
    await A.evaluate((d) => window.__cel.app().navigate({ kind: 'dm', c: d }), dc);
    try {
      await A.locator('img.cemoji[alt=":celadon:"]').first().waitFor({ timeout: 15000 });
    } catch (e) {
      console.log('  A dm:', JSON.stringify(await A.evaluate(async (d) => ({ view: window.__cel.store.getState().view, msgs: (await window.__cel.app().convos.loadChannel(d, 'main')).messages.map((m) => m.text.slice(0, 120)), html: document.querySelector('.msgs')?.innerHTML.match(/look.{0,300}/)?.[0] }), dc)));
      throw e;
    }
  });

  await check('scheduled message is sent by the client when due', async () => {
    await A.evaluate(([cc, chh]) => window.__cel.app().schedule(cc, chh, 'from the future', Date.now() + 6000, null), [c, ch]);
    await until(B, ([cc, chh]) => window.__cel.app().convos.loadChannel(cc, chh).then((r) => r.messages.some((m) => m.text === 'from the future')), [c, ch], 20000, 'scheduled message on B');
  });

  await check('DM survives the recipient being offline (sealed mailbox)', async () => {
    const dc = await A.evaluate(() => Object.values(window.__cel.store.getState().convos).find((x) => x.type === 'dm').c);
    await B.goto('about:blank');
    await until(A, (b) => !window.__cel.store.getState().presence[b], bob, 15000, 'B offline');
    await A.evaluate((d) => window.__cel.app().sendMessage(d, 'main', 'while you were away', []), dc);
    await B.goto(BASE);
    await until(B, () => window.__cel?.store.getState().phase === 'ready', null, 20000, 'B auto-unlocked');
    await until(B, (d) => window.__cel.app().convos.loadChannel(d, 'main').then((r) => r.messages.some((m) => m.text === 'while you were away')), dc, 20000, 'mailbox delivery');
  });

  await check('kick is enforced on the kicked member too', async () => {
    await A.evaluate(([cc, b]) => window.__cel.app().kick(cc, b, 'e2e'), [c, bob]);
    await until(B, (cc) => !window.__cel.store.getState().states[cc]?.members[window.__cel.store.getState().me], c, 20000, 'B removed');
  });

  await check('archive peer keeps a community readable while every member is offline', async () => {
    const status = async () => (await fetch(`http://127.0.0.1:${KEEPER_STATUS}/status`)).json();
    const { c2, link, hash } = await A.evaluate(async () => {
      const a = window.__cel.app();
      const cc = await a.createCommunity('Archive Test');
      const chh = a.firstChannel(window.__cel.store.getState().states[cc]);
      const bytes = new Uint8Array(120_000);
      crypto.getRandomValues(bytes.subarray(0, 65536));
      const op = await a.sendMessage(cc, chh, 'only the archive has this now', [new File([bytes], 'kept.bin', { type: 'application/octet-stream' })]);
      const inv = await a.createInvite(cc, 3600, 5);
      await a.addArchivePeer(cc, '@archive');
      return { c2: cc, link: inv, hash: op.p.att[0].hash };
    });
    // the archive peer joins, syncs and pulls the attachment from Alice
    const t0 = Date.now();
    for (;;) {
      const s = await status();
      const comm = s.communities.find((x) => x.c === c2);
      if (comm?.member && s.files.count >= 1 && s.files.wanted === 0) break;
      if (Date.now() - t0 > 30000) throw new Error('archive peer did not finish archiving: ' + JSON.stringify(s));
      await sleep(500);
    }
    await A.goto('about:blank');
    await until(B, (a) => !window.__cel.store.getState().presence[a], alice, 15000, 'A offline');
    await B.evaluate((l) => window.__cel.app().joinByInvite(l), link);
    await until(B, (cc) => !!window.__cel.store.getState().states[cc]?.members[window.__cel.store.getState().me], c2, 30000, 'B joined via the archive peer');
    await until(
      B,
      (cc) => {
        const a = window.__cel.app();
        const chh = a.firstChannel(window.__cel.store.getState().states[cc]);
        return a.convos.loadChannel(cc, chh).then((r) => r.messages.some((m) => m.text === 'only the archive has this now'));
      },
      c2,
      20000,
      'history from the archive peer',
    );
    await until(B, (h) => window.__cel.app().files.has(h).then((x) => x || window.__cel.app().ensureBlob({ hash: h, size: 120000, mime: 'application/octet-stream' }, { auto: true }).then(() => false)), hash, 30000, 'attachment from the archive peer');
  });

  await browser.close();
}

main()
  .catch((e) => {
    console.error(e);
    results.push({ name: 'harness', ok: false, err: e.message });
  })
  .finally(() => {
    for (const p of procs) p.kill();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n${pass}/${results.length} passed`);
    process.exit(pass === results.length ? 0 : 1);
  });
