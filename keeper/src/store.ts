import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Op } from '@shared/ops';

export interface OpRow {
  id: string;
  c: string;
  a: string;
  dv: string;
  s: number;
  l: number;
  t: number;
  k: string;
  g: number;
  tgt: string;
  json: string;
  rcv: number;
  eq: number;
}

export interface ConvoRow {
  c: string;
  join_code: string | null;
  seq: number;
  left: number;
  added_by: string;
  added_at: number;
}

export interface WantRow {
  hash: string;
  c: string;
  owner: string;
  size: number;
  mime: string;
  tries: number;
  next_at: number;
}

export const parseOp = (r: { json: string; rcv?: number }): Op => ({ ...(JSON.parse(r.json) as Op), rcv: r.rcv });

/** Everything an archive peer keeps, in one SQLite file plus a files/ directory. */
export class Store {
  db: DatabaseSync;
  filesDir: string;
  private q;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.filesDir = path.join(dir, 'files');
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'keeper.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS ops (
        id TEXT PRIMARY KEY, c TEXT NOT NULL, a TEXT NOT NULL, dv TEXT NOT NULL, s INTEGER NOT NULL,
        l INTEGER NOT NULL, t INTEGER NOT NULL, k TEXT NOT NULL, g INTEGER NOT NULL, tgt TEXT NOT NULL,
        json TEXT NOT NULL, rcv INTEGER NOT NULL, eq INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS ops_cg ON ops(c, g);
      CREATE INDEX IF NOT EXISTS ops_chain ON ops(c, a, dv, s);
      CREATE INDEX IF NOT EXISTS ops_tgt ON ops(tgt);
      CREATE INDEX IF NOT EXISTS ops_author ON ops(c, a, k, t);
      CREATE TABLE IF NOT EXISTS convos (
        c TEXT PRIMARY KEY, join_code TEXT, seq INTEGER NOT NULL DEFAULT 0, left INTEGER NOT NULL DEFAULT 0,
        added_by TEXT NOT NULL, added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (pub TEXT PRIMARY KEY, card TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, added_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wanted (
        hash TEXT PRIMARY KEY, c TEXT NOT NULL, owner TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL,
        tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    const d = this.db;
    this.q = {
      hasOp: d.prepare('SELECT 1 FROM ops WHERE id = ?'),
      getOp: d.prepare('SELECT * FROM ops WHERE id = ?'),
      putOp: d.prepare('INSERT OR IGNORE INTO ops (id, c, a, dv, s, l, t, k, g, tgt, json, rcv, eq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      chain: d.prepare('SELECT id, eq FROM ops WHERE c = ? AND a = ? AND dv = ? AND s = ? LIMIT 1'),
      markEq: d.prepare('UPDATE ops SET eq = 1 WHERE id = ?'),
      gov: d.prepare('SELECT json, rcv, eq, id FROM ops WHERE c = ? AND g = 1'),
      all: d.prepare('SELECT json, rcv, a, dv, s, g, l FROM ops WHERE c = ?'),
      chainKeys: d.prepare('SELECT a, dv, s FROM ops WHERE c = ? ORDER BY a, dv, s'),
      maxL: d.prepare('SELECT MAX(l) AS l FROM ops WHERE c = ?'),
      mySeq: d.prepare('SELECT MAX(s) AS s FROM ops WHERE c = ? AND a = ? AND dv = ?'),
      byTarget: d.prepare('SELECT json, rcv, eq FROM ops WHERE tgt = ? AND c = ?'),
      authorMsgs: d.prepare("SELECT id, json FROM ops WHERE c = ? AND a = ? AND k = 'msg' AND t >= ?"),
      redact: d.prepare('UPDATE ops SET json = ? WHERE id = ?'),
      countOps: d.prepare('SELECT COUNT(*) AS n FROM ops WHERE c = ?'),
      delConvoOps: d.prepare('DELETE FROM ops WHERE c = ?'),
      convos: d.prepare('SELECT * FROM convos'),
      putConvo: d.prepare(
        'INSERT INTO convos (c, join_code, seq, left, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(c) DO UPDATE SET join_code = excluded.join_code, seq = excluded.seq, left = excluded.left',
      ),
      profile: d.prepare('SELECT card FROM profiles WHERE pub = ?'),
      putProfile: d.prepare('INSERT INTO profiles (pub, card, updated_at) VALUES (?, ?, ?) ON CONFLICT(pub) DO UPDATE SET card = excluded.card, updated_at = excluded.updated_at WHERE excluded.updated_at > profiles.updated_at'),
      hasBlob: d.prepare('SELECT mime, size FROM blobs WHERE hash = ?'),
      putBlob: d.prepare('INSERT OR REPLACE INTO blobs (hash, mime, size, added_at) VALUES (?, ?, ?, ?)'),
      blobTotal: d.prepare('SELECT COALESCE(SUM(size), 0) AS b, COUNT(*) AS n FROM blobs'),
      want: d.prepare('INSERT OR IGNORE INTO wanted (hash, c, owner, size, mime, tries, next_at) VALUES (?, ?, ?, ?, ?, 0, 0)'),
      due: d.prepare('SELECT * FROM wanted WHERE next_at <= ? ORDER BY rowid LIMIT 20'),
      unwant: d.prepare('DELETE FROM wanted WHERE hash = ?'),
      retryLater: d.prepare('UPDATE wanted SET tries = tries + 1, next_at = ? WHERE hash = ?'),
      wantedCount: d.prepare('SELECT COUNT(*) AS n FROM wanted'),
      kvGet: d.prepare('SELECT v FROM kv WHERE k = ?'),
      kvPut: d.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    };
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  hasOp(id: string) {
    return !!this.q.hasOp.get(id);
  }
  getOp(id: string) {
    return this.q.getOp.get(id) as OpRow | undefined;
  }
  putOp(r: OpRow) {
    this.q.putOp.run(r.id, r.c, r.a, r.dv, r.s, r.l, r.t, r.k, r.g, r.tgt, r.json, r.rcv, r.eq);
  }
  chainOther(c: string, a: string, dv: string, s: number) {
    return this.q.chain.get(c, a, dv, s) as { id: string; eq: number } | undefined;
  }
  markEq(id: string) {
    this.q.markEq.run(id);
  }
  govOps(c: string) {
    return this.q.gov.all(c) as { json: string; rcv: number; eq: number; id: string }[];
  }
  allOps(c: string) {
    return this.q.all.all(c) as { json: string; rcv: number; a: string; dv: string; s: number; g: number; l: number }[];
  }
  maxLamport(c: string) {
    return ((this.q.maxL.get(c) as { l: number | null }).l ?? 0) as number;
  }
  mySeq(c: string, a: string, dv: string) {
    return ((this.q.mySeq.get(c, a, dv) as { s: number | null }).s ?? 0) as number;
  }
  /** highest contiguous seq per author device */
  vv(c: string) {
    const vv: Record<string, number> = {};
    let chain = '';
    let expect = 1;
    for (const r of this.q.chainKeys.all(c) as { a: string; dv: string; s: number }[]) {
      const k = `${r.a}:${r.dv}`;
      if (k !== chain) {
        chain = k;
        expect = 1;
      }
      if (r.s === expect) {
        vv[k] = r.s;
        expect++;
      } else if (r.s > expect) expect = Number.POSITIVE_INFINITY;
    }
    return vv;
  }
  byTarget(tgt: string, c: string) {
    return (this.q.byTarget.all(tgt, c) as { json: string; rcv: number; eq: number }[]).filter((r) => !r.eq).map(parseOp);
  }
  authorMsgsSince(c: string, a: string, t: number) {
    return this.q.authorMsgs.all(c, a, t) as { id: string; json: string }[];
  }
  redact(id: string) {
    const row = this.getOp(id);
    if (!row) return;
    const op = JSON.parse(row.json) as Op;
    if (op.p === undefined) return;
    delete op.p;
    this.q.redact.run(JSON.stringify(op), id);
  }
  countOps(c: string) {
    return (this.q.countOps.get(c) as { n: number }).n;
  }
  deleteConvoOps(c: string) {
    this.q.delConvoOps.run(c);
  }
  convos() {
    return this.q.convos.all() as unknown as ConvoRow[];
  }
  putConvo(r: ConvoRow) {
    this.q.putConvo.run(r.c, r.join_code, r.seq, r.left, r.added_by, r.added_at);
  }
  profile(pub: string) {
    const r = this.q.profile.get(pub) as { card: string } | undefined;
    return r ? JSON.parse(r.card) : null;
  }
  putProfile(pub: string, card: unknown, updatedAt: number) {
    this.q.putProfile.run(pub, JSON.stringify(card), updatedAt);
  }
  blob(hash: string) {
    return this.q.hasBlob.get(hash) as { mime: string; size: number } | undefined;
  }
  blobPath(hash: string) {
    return path.join(this.filesDir, hash);
  }
  putBlob(hash: string, mime: string, data: Uint8Array) {
    fs.writeFileSync(this.blobPath(hash), data);
    this.q.putBlob.run(hash, mime, data.length, Date.now());
  }
  blobTotals() {
    return this.q.blobTotal.get() as { b: number; n: number };
  }
  want(hash: string, c: string, owner: string, size: number, mime: string) {
    if (this.blob(hash)) return;
    this.q.want.run(hash, c, owner, size, mime);
  }
  due(now: number) {
    return this.q.due.all(now) as unknown as WantRow[];
  }
  unwant(hash: string) {
    this.q.unwant.run(hash);
  }
  retryLater(hash: string, at: number) {
    this.q.retryLater.run(at, hash);
  }
  wantedCount() {
    return (this.q.wantedCount.get() as { n: number }).n;
  }
  kv(k: string): string | null {
    return ((this.q.kvGet.get(k) as { v: string } | undefined)?.v ?? null) as string | null;
  }
  setKv(k: string, v: string) {
    this.q.kvPut.run(k, v);
  }
}
