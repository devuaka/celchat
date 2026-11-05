import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'assets'), { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'hub.sqlite'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS directory (
  pub        TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  card       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox (
  id         TEXT PRIMARY KEY,
  to_pub     TEXT NOT NULL,
  box        TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mailbox_to ON mailbox(to_pub, created_at);
CREATE INDEX IF NOT EXISTS mailbox_exp ON mailbox(expires_at);

CREATE TABLE IF NOT EXISTS assets (
  hash        TEXT PRIMARY KEY,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  owner       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_access INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_lru ON assets(last_access);

CREATE TABLE IF NOT EXISTS vault (
  pub        TEXT PRIMARY KEY,
  blob       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

export const q = {
  dirGetByPub: db.prepare('SELECT card FROM directory WHERE pub = ?'),
  dirGetByName: db.prepare('SELECT card FROM directory WHERE username = ?'),
  dirOwnerOf: db.prepare('SELECT pub FROM directory WHERE username = ?'),
  dirUpsert: db.prepare(
    `INSERT INTO directory (pub, username, card, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(pub) DO UPDATE SET username = excluded.username, card = excluded.card, updated_at = excluded.updated_at`,
  ),

  mailPut: db.prepare('INSERT INTO mailbox (id, to_pub, box, size, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
  mailFor: db.prepare('SELECT id, box, created_at AS at FROM mailbox WHERE to_pub = ? ORDER BY created_at LIMIT 500'),
  mailUsage: db.prepare('SELECT COALESCE(SUM(size), 0) AS used, COUNT(*) AS n FROM mailbox WHERE to_pub = ?'),
  mailDel: db.prepare('DELETE FROM mailbox WHERE id = ? AND to_pub = ?'),
  mailExpire: db.prepare('DELETE FROM mailbox WHERE expires_at < ?'),

  assetGet: db.prepare('SELECT mime, size FROM assets WHERE hash = ?'),
  assetPut: db.prepare('INSERT OR IGNORE INTO assets (hash, mime, size, owner, created_at, last_access) VALUES (?, ?, ?, ?, ?, ?)'),
  assetTouch: db.prepare('UPDATE assets SET last_access = ? WHERE hash = ?'),
  assetTotal: db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM assets'),
  assetOldest: db.prepare('SELECT hash, size FROM assets ORDER BY last_access LIMIT 50'),
  assetDel: db.prepare('DELETE FROM assets WHERE hash = ?'),

  vaultGet: db.prepare('SELECT blob, updated_at FROM vault WHERE pub = ?'),
  vaultPut: db.prepare(
    `INSERT INTO vault (pub, blob, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(pub) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
  ),
};
