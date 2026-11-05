/**
 * CelChat Hub: the only server-side piece. It introduces peers, relays
 * encrypted frames when direct connections fail and holds a few small things
 * for offline users. It never sees community messages or DM plaintext.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { db, q } from './db';
import { Bucket, KeyedBuckets } from './ratelimit';
import { verify, sha256Hex } from '@shared/crypto';
import { isHex, fromB64 } from '@shared/bytes';
import { verifyProfile } from '@shared/profile';
import { gifUrl, normalizeGifs, isGifMediaHost, GIF_MAX_SEND_BYTES } from '@shared/gifs';
import { authMessage, assetAuthMessage, sniffImage, type ClientToHub, type HubInfo, type HubToClient, type IceServer, type Presence, type TopicPeer } from '@shared/protocol';

const VERSION = '0.1.0';
const PRESENCES: Presence[] = ['online', 'idle', 'dnd', 'invisible'];

const hubInfo: HubInfo = {
  name: config.name,
  version: VERSION,
  features: {
    mailbox: config.mailbox,
    directory: config.directory,
    assets: config.assets,
    vault: config.vault,
    relay: config.relay,
    turn: config.turnUrls.length > 0 && !!config.turnSecret,
    gifs: config.gifProvider && config.gifKey ? config.gifProvider : null,
  },
  limits: {
    mailItemBytes: config.mailItemBytes,
    mailUserBytes: config.mailUserBytes,
    mailTtlDays: config.mailTtlDays,
    assetBytes: config.assetBytes,
    vaultBytes: config.vaultBytes,
  },
};

function iceFor(pub: string): IceServer[] {
  const out: IceServer[] = config.stun.length ? [{ urls: config.stun }] : [];
  if (hubInfo.features.turn) {
    // coturn "use-auth-secret" REST credentials; the secret never leaves the hub.
    const username = `${Math.floor(Date.now() / 1000) + config.turnTtl}:${pub.slice(0, 16)}`;
    const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
    out.push({ urls: config.turnUrls, username, credential });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connections, presence topics
// ---------------------------------------------------------------------------

interface Conn {
  ws: WebSocket;
  ip: string;
  nonce: string;
  pub: string | null;
  dv: string | null;
  addr: string | null;
  st: Presence;
  topics: Set<string>;
  alive: boolean;
  msgs: Bucket;
  mail: Bucket;
  dir: Bucket;
  relayBytes: Bucket;
  dropped?: boolean;
}

const byAddr = new Map<string, Conn>();
const byPub = new Map<string, Set<Conn>>();
const topics = new Map<string, Set<Conn>>();
const ipCount = new Map<string, number>();
const allConns = new Map<WebSocket, Conn>();

const send = (c: Conn, m: HubToClient) => {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m));
};
const peerOf = (c: Conn): TopicPeer => ({ pub: c.pub!, dv: c.dv!, st: c.st });
const visible = (c: Conn) => c.st !== 'invisible';

function topicJoin(c: Conn, id: string) {
  if (c.topics.has(id)) return;
  if (c.topics.size >= config.maxTopicsPerConn) return;
  let set = topics.get(id);
  if (!set) topics.set(id, (set = new Set()));
  const peers: TopicPeer[] = [];
  for (const o of set) if (visible(o) && o.pub !== c.pub) peers.push(peerOf(o));
  set.add(c);
  c.topics.add(id);
  send(c, { t: 'topic', id, peers });
  if (visible(c)) for (const o of set) if (o !== c) send(o, { t: 'tj', id, peer: peerOf(c) });
}

function topicLeave(c: Conn, id: string, announce = true) {
  const set = topics.get(id);
  if (!set || !set.delete(c)) return;
  c.topics.delete(id);
  if (!set.size) topics.delete(id);
  if (announce && visible(c)) for (const o of set) send(o, { t: 'tl', id, pub: c.pub!, dv: c.dv! });
}

function setStatus(c: Conn, st: Presence) {
  const was = c.st;
  if (was === st) return;
  c.st = st;
  for (const id of c.topics) {
    const set = topics.get(id);
    if (!set) continue;
    for (const o of set) {
      if (o === c) continue;
      if (st === 'invisible') send(o, { t: 'tl', id, pub: c.pub!, dv: c.dv! });
      else if (was === 'invisible') send(o, { t: 'tj', id, peer: peerOf(c) });
      else send(o, { t: 'ts', id, peer: peerOf(c) });
    }
  }
}

function dropConn(c: Conn) {
  if (c.dropped) return;
  c.dropped = true;
  for (const id of [...c.topics]) topicLeave(c, id);
  if (c.addr && byAddr.get(c.addr) === c) byAddr.delete(c.addr);
  if (c.pub) {
    const s = byPub.get(c.pub);
    s?.delete(c);
    if (s && !s.size) byPub.delete(c.pub);
  }
  const n = (ipCount.get(c.ip) ?? 1) - 1;
  if (n <= 0) ipCount.delete(c.ip);
  else ipCount.set(c.ip, n);
}

/** `to` is either "pub" (all devices) or "pub:dv" (one device). */
function targets(to: string): Conn[] {
  if (to.length === 64) return [...(byPub.get(to) ?? [])];
  const c = byAddr.get(to);
  return c ? [c] : [];
}

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

function mailPut(c: Conn, to: string, box: string, rid: string) {
  if (!config.mailbox) return send(c, { t: 'err', code: 'disabled', msg: 'Mailbox is disabled on this hub', rid });
  if (!isHex(to, 64) || typeof box !== 'string') return send(c, { t: 'err', code: 'bad', msg: 'bad mail', rid });
  const size = box.length;
  if (size > config.mailItemBytes * 1.4) return send(c, { t: 'err', code: 'too_big', msg: 'Envelope too large', rid });
  const usage = q.mailUsage.get(to) as { used: number; n: number };
  if (usage.used + size > config.mailUserBytes * 1.4 || usage.n >= 2000)
    return send(c, { t: 'err', code: 'mailbox_full', msg: "Recipient's mailbox is full", rid });
  const id = crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  q.mailPut.run(id, to, box, size, now, now + config.mailTtlDays * 86400_000);
  send(c, { t: 'ok', rid });
  for (const r of byPub.get(to) ?? []) send(r, { t: 'mail', items: [{ id, box, at: now }] });
}

setInterval(() => q.mailExpire.run(Date.now()), 10 * 60_000).unref();

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------

function handle(c: Conn, m: ClientToHub) {
  if (!c.pub) {
    if (m.t !== 'auth') return send(c, { t: 'err', code: 'auth', msg: 'Authenticate first' });
    if (!isHex(m.pub, 64) || !isHex(m.dv, 16) || !verify(m.pub, authMessage(c.nonce), m.sig)) {
      send(c, { t: 'err', code: 'auth', msg: 'Bad signature' });
      return c.ws.close(4001, 'auth');
    }
    const addr = `${m.pub}:${m.dv}`;
    const old = byAddr.get(addr);
    if (old) {
      send(old, { t: 'replaced' });
      dropConn(old);
      old.ws.close(4002, 'replaced');
    }
    c.pub = m.pub;
    c.dv = m.dv;
    c.addr = addr;
    c.st = PRESENCES.includes(m.st) ? m.st : 'online';
    byAddr.set(addr, c);
    let s = byPub.get(m.pub);
    if (!s) byPub.set(m.pub, (s = new Set()));
    s.add(c);
    let relayRate = config.relayBytesPerSec;
    if (config.relayTrusted.includes(m.pub)) {
      relayRate = config.relayTrustedBytesPerSec;
      c.relayBytes = new Bucket(relayRate, relayRate * 4);
      c.msgs = new Bucket(600, 4000);
    }
    send(c, { t: 'ready', addr, ice: iceFor(m.pub), hub: hubInfo, relayRate });
    return;
  }

  switch (m.t) {
    case 'sub':
      if (Array.isArray(m.topics)) for (const id of m.topics.slice(0, 200)) if (isHex(id, 64)) topicJoin(c, id);
      return;
    case 'unsub':
      if (Array.isArray(m.topics)) for (const id of m.topics) if (typeof id === 'string') topicLeave(c, id);
      return;
    case 'status':
      if (PRESENCES.includes(m.st)) setStatus(c, m.st);
      return;
    case 'sig': {
      if (typeof m.to !== 'string') return;
      const raw = JSON.stringify(m.d ?? null);
      if (raw.length > 64 * 1024) return send(c, { t: 'err', code: 'too_big', msg: 'Signal too large' });
      const ts = targets(m.to);
      if (!ts.length) return send(c, { t: 'err', code: 'offline', msg: 'Peer is offline', ref: m.to });
      for (const tc of ts) if (tc !== c) send(tc, { t: 'sig', from: c.addr!, d: m.d });
      return;
    }
    case 'relay': {
      if (!config.relay) return send(c, { t: 'err', code: 'disabled', msg: 'Relay is disabled on this hub', ref: m.to });
      if (typeof m.to !== 'string' || typeof m.d !== 'string' || m.d.length > 200 * 1024) return;
      if (!c.relayBytes.take(m.d.length)) return send(c, { t: 'err', code: 'rate', msg: 'Relay rate limit', ref: m.to });
      const tc = byAddr.get(m.to);
      if (!tc) return send(c, { t: 'err', code: 'offline', msg: 'Peer is offline', ref: m.to });
      send(tc, { t: 'relay', from: c.addr!, d: m.d });
      return;
    }
    case 'mail.put':
      if (!c.mail.take()) return send(c, { t: 'err', code: 'rate', msg: 'Slow down', rid: m.rid });
      return mailPut(c, m.to, m.box, String(m.rid ?? ''));
    case 'mail.get': {
      const items = (q.mailFor.all(c.pub) as { id: string; box: string; at: number }[]).map((r) => ({ id: r.id, box: r.box, at: r.at }));
      send(c, { t: 'mail', items });
      return;
    }
    case 'mail.del':
      if (Array.isArray(m.ids)) for (const id of m.ids.slice(0, 500)) if (typeof id === 'string') q.mailDel.run(id, c.pub);
      return;
    case 'dir.put': {
      const rid = String(m.rid ?? '');
      if (!config.directory) return send(c, { t: 'err', code: 'disabled', msg: 'Directory disabled', rid });
      if (!c.dir.take()) return send(c, { t: 'err', code: 'rate', msg: 'Slow down', rid });
      const card = verifyProfile(m.card);
      if (!card || card.pub !== c.pub) return send(c, { t: 'err', code: 'bad', msg: 'Invalid profile card', rid });
      const owner = q.dirOwnerOf.get(card.username) as { pub: string } | undefined;
      if (owner && owner.pub !== c.pub) return send(c, { t: 'err', code: 'taken', msg: 'That username is taken on this hub', rid });
      const prev = q.dirGetByPub.get(c.pub) as { card: string } | undefined;
      if (prev) {
        const p = JSON.parse(prev.card) as { updatedAt: number };
        if (p.updatedAt > card.updatedAt) return send(c, { t: 'ok', rid });
      }
      const json = JSON.stringify(card);
      if (json.length > 32 * 1024) return send(c, { t: 'err', code: 'too_big', msg: 'Profile too large', rid });
      q.dirUpsert.run(c.pub, card.username, json, Date.now());
      return send(c, { t: 'ok', rid });
    }
    case 'dir.get': {
      const rid = String(m.rid ?? '');
      if (!c.dir.take()) return send(c, { t: 'err', code: 'rate', msg: 'Slow down', rid });
      const qs = String(m.q ?? '').trim().toLowerCase().replace(/^@/, '');
      const row = (isHex(qs, 64) ? q.dirGetByPub.get(qs) : q.dirGetByName.get(qs)) as { card: string } | undefined;
      return send(c, { t: 'dir', rid, card: row ? JSON.parse(row.card) : null });
    }
    case 'vault.put': {
      const rid = String(m.rid ?? '');
      if (!config.vault) return send(c, { t: 'err', code: 'disabled', msg: 'Vault disabled', rid });
      if (typeof m.blob !== 'string' || m.blob.length > config.vaultBytes * 1.4) return send(c, { t: 'err', code: 'too_big', msg: 'Vault too large', rid });
      if (!c.dir.take()) return send(c, { t: 'err', code: 'rate', msg: 'Slow down', rid });
      q.vaultPut.run(c.pub, m.blob, Date.now());
      return send(c, { t: 'ok', rid });
    }
    case 'vault.get': {
      const rid = String(m.rid ?? '');
      const row = q.vaultGet.get(c.pub) as { blob: string; updated_at: number } | undefined;
      return send(c, { t: 'vault', rid, blob: row?.blob ?? null, at: row?.updated_at ?? null });
    }
  }
}

function clientIp(req: http.IncomingMessage) {
  if (config.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

// Browsers always send Origin, so this blocks other websites. Non-browser clients (archive peers)
// send none; they could forge one anyway, so the origin list is not an authentication mechanism.
const originOk = (origin: string | undefined) => !config.allowedOrigins.length || !origin || config.allowedOrigins.includes(origin);

// ---------------------------------------------------------------------------
// HTTP: info, public asset cache, static client
// ---------------------------------------------------------------------------

const httpLimit = new KeyedBuckets(20, 120);
const gifLimit = new KeyedBuckets(1, 30);
const gifMediaLimit = new KeyedBuckets(8, 120);
const uploadLimit = new KeyedBuckets(0.2, 10);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  'connect-src *',
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

function cors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = req.headers.origin;
  if (origin && originOk(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-cel-pub, x-cel-ts, x-cel-sig');
  }
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function evictAssets() {
  let total = (q.assetTotal.get() as { total: number }).total;
  while (total > config.assetTotalBytes) {
    const rows = q.assetOldest.all() as { hash: string; size: number }[];
    if (!rows.length) break;
    for (const r of rows) {
      fs.rmSync(path.join(config.dataDir, 'assets', r.hash), { force: true });
      q.assetDel.run(r.hash);
      total -= r.size;
      if (total <= config.assetTotalBytes) break;
    }
  }
}

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  const root = config.staticDir;
  let file = path.normalize(path.join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root)) return json(res, 400, { error: 'bad path' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('CelChat hub is running. Build the client with "npm run build" to serve it from here, or use "npm run dev".');
  }
  const ext = path.extname(file);
  const headers: Record<string, string> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', ...SECURITY_HEADERS };
  if (ext === '.html') {
    headers['Content-Security-Policy'] = CSP;
    headers['Cache-Control'] = 'no-cache';
  } else if (pathname.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const ip = clientIp(req);
    const url = new URL(req.url ?? '/', 'http://hub');
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname.startsWith('/api/') && !httpLimit.take(ip)) return json(res, 429, { error: 'rate limited' });

    if (url.pathname === '/api/info') return json(res, 200, hubInfo);

    // GIF search proxy: keeps the provider key on the hub and users' IPs away from the provider
    if (url.pathname === '/api/gifs/search' || url.pathname === '/api/gifs/featured') {
      const provider = hubInfo.features.gifs;
      if (!provider) return json(res, 404, { error: 'GIF search is not configured on this hub' });
      if (!gifLimit.take(ip)) return json(res, 429, { error: 'rate limited' });
      const kind = url.pathname.endsWith('search') ? 'search' : 'featured';
      const q = (url.searchParams.get('q') ?? '').slice(0, 100);
      if (kind === 'search' && !q.trim()) return json(res, 400, { error: 'missing q' });
      const pos = url.searchParams.get('pos');
      try {
        const r = await fetch(gifUrl(provider, config.gifBaseUrl, config.gifKey, kind, q, pos ? pos.slice(0, 64) : null, config.gifContentFilter), { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return json(res, 502, { error: `GIF provider answered ${r.status}` });
        return json(res, 200, normalizeGifs(provider, await r.json()));
      } catch {
        return json(res, 502, { error: 'GIF provider unreachable' });
      }
    }
    if (url.pathname === '/api/gifs/media') {
      if (!hubInfo.features.gifs) return json(res, 404, { error: 'GIF search is not configured on this hub' });
      if (!gifMediaLimit.take(ip)) return json(res, 429, { error: 'rate limited' });
      const target = url.searchParams.get('u') ?? '';
      if (!isGifMediaHost(target)) return json(res, 400, { error: 'host not allowed' });
      try {
        const r = await fetch(target, { signal: AbortSignal.timeout(15000) });
        const len = Number(r.headers.get('content-length') ?? 0);
        if (!r.ok || len > GIF_MAX_SEND_BYTES * 1.5) return json(res, 502, { error: 'media unavailable' });
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > GIF_MAX_SEND_BYTES * 1.5 || !sniffImage(new Uint8Array(buf))) return json(res, 502, { error: 'not an image' });
        res.writeHead(200, { 'Content-Type': sniffImage(new Uint8Array(buf))!, 'Content-Length': String(buf.length), 'Cache-Control': 'public, max-age=86400', ...SECURITY_HEADERS });
        return res.end(buf);
      } catch {
        return json(res, 502, { error: 'media unreachable' });
      }
    }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, online: byAddr.size });

    const am = /^\/api\/assets\/([0-9a-f]{64})$/.exec(url.pathname);
    if (am) {
      const hash = am[1];
      if (!config.assets) return json(res, 404, { error: 'asset cache disabled' });
      if (req.method === 'GET') {
        const row = q.assetGet.get(hash) as { mime: string; size: number } | undefined;
        const file = path.join(config.dataDir, 'assets', hash);
        if (!row || !fs.existsSync(file)) return json(res, 404, { error: 'not found' });
        q.assetTouch.run(Date.now(), hash);
        res.writeHead(200, {
          'Content-Type': row.mime,
          'Content-Length': String(row.size),
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          ...SECURITY_HEADERS,
        });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'PUT') {
        if (!uploadLimit.take(ip)) return json(res, 429, { error: 'rate limited' });
        const pub = String(req.headers['x-cel-pub'] ?? '');
        const ts = Number(req.headers['x-cel-ts'] ?? 0);
        const sig = String(req.headers['x-cel-sig'] ?? '');
        if (!isHex(pub, 64) || Math.abs(Date.now() - ts) > 5 * 60_000 || !verify(pub, assetAuthMessage(hash, ts), sig))
          return json(res, 401, { error: 'bad signature' });
        if (q.assetGet.get(hash)) return json(res, 200, { ok: true, cached: true });
        const body = await readBody(req, config.assetBytes);
        if (!body) return json(res, 413, { error: 'too large' });
        if (sha256Hex(new Uint8Array(body)) !== hash) return json(res, 400, { error: 'hash mismatch' });
        const mime = sniffImage(new Uint8Array(body));
        if (!mime) return json(res, 415, { error: 'only png, jpeg, gif and webp are cached' });
        fs.writeFileSync(path.join(config.dataDir, 'assets', hash), body);
        q.assetPut.run(hash, mime, body.length, pub, Date.now(), Date.now());
        evictAssets();
        return json(res, 201, { ok: true });
      }
      return json(res, 405, { error: 'method not allowed' });
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://hub');
  if (url.pathname !== '/ws' || !originOk(req.headers.origin)) {
    socket.destroy();
    return;
  }
  const ip = clientIp(req);
  const n = ipCount.get(ip) ?? 0;
  if (n >= config.maxConnsPerIp) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ipCount.set(ip, n + 1);
    const c: Conn = {
      ws,
      ip,
      nonce: crypto.randomBytes(24).toString('hex'),
      pub: null,
      dv: null,
      addr: null,
      st: 'online',
      topics: new Set(),
      alive: true,
      msgs: new Bucket(60, 400),
      mail: new Bucket(1, 60),
      dir: new Bucket(0.5, 30),
      relayBytes: new Bucket(config.relayBytesPerSec, config.relayBytesPerSec * 4),
    };
    allConns.set(ws, c);
    send(c, { t: 'challenge', nonce: c.nonce, hub: hubInfo });
    ws.on('pong', () => (c.alive = true));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (!c.msgs.take()) {
        send(c, { t: 'err', code: 'rate', msg: 'Too many messages' });
        return;
      }
      let m: ClientToHub;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      try {
        handle(c, m);
      } catch (e) {
        console.error('[ws]', e);
      }
    });
    ws.on('close', () => {
      allConns.delete(ws);
      dropConn(c);
    });
    ws.on('error', () => ws.terminate());
  });
});

setInterval(() => {
  for (const [ws, c] of allConns) {
    if (!c.alive) {
      ws.terminate();
      continue;
    }
    c.alive = false;
    ws.ping();
  }
}, 25_000).unref();

server.listen(config.port, config.host, () => {
  console.log(`[celchat-hub] ${config.name} v${VERSION} on http://${config.host}:${config.port}`);
  console.log(`[celchat-hub] data: ${config.dataDir}`);
  console.log(
    `[celchat-hub] features: ${Object.entries(hubInfo.features)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ')}`,
  );
});

const shutdown = () => {
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
