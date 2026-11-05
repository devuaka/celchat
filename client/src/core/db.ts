import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Op } from '@shared/ops';
import type { ProfileCard } from '@shared/profile';

// ---------------------------------------------------------------------------
// Global account list (one per browser profile)
// ---------------------------------------------------------------------------

export interface AccountRecord {
  pub: string;
  dv: string;
  username: string;
  displayName: string;
  createdAt: number;
  lastUsed: number;
  /** seed encrypted with PBKDF2(password) */
  vault: { salt: string; iter: number; ct: string };
  /** "stay signed in": seed wrapped by a non-extractable device key */
  wrapped?: { key: CryptoKey; ct: string };
}

interface AccountsDB extends DBSchema {
  accounts: { key: string; value: AccountRecord };
}

let accountsDb: Promise<IDBPDatabase<AccountsDB>> | null = null;
export function accounts() {
  if (!accountsDb)
    accountsDb = openDB<AccountsDB>('celchat-accounts', 1, {
      upgrade(db) {
        db.createObjectStore('accounts', { keyPath: 'pub' });
      },
    });
  return accountsDb;
}

// ---------------------------------------------------------------------------
// Per-account database
// ---------------------------------------------------------------------------

export interface StoredOp extends Op {
  rcv: number;
  /** 1 = governance op */
  g: 0 | 1;
  /** channel for msg ops ('' for others) */
  ch: string;
  /** target message id for edit/del/react/pin ('' for others) */
  tgt: string;
  /** equivocation detected */
  eq?: 1;
}

export type ConvoType = 'community' | 'dm' | 'group';
export type NotifyLevel = 'all' | 'mentions' | 'none';

export interface ConvoRecord {
  c: string;
  type: ConvoType;
  /** dm partner */
  peer?: string;
  addedAt: number;
  /** my per-device seq in this conversation */
  seq: number;
  /** pending join: invite code we will use once we have synced */
  joinCode?: string;
  /** we left / were removed; data kept until the user deletes it */
  left?: boolean;
  /** last time something happened (for DM ordering) */
  lastActivity: number;
  notify: NotifyLevel | 'default';
  muted: boolean;
  chans: Record<string, { notify?: NotifyLevel | 'default'; muted?: boolean }>;
  /** per-channel read marker (lamport of last read message) */
  read: Record<string, number>;
  /** sidebar order for communities */
  order: number;
  /** hide from the DM list */
  hidden?: boolean;
}

export interface BlobRecord {
  hash: string;
  mime: string;
  size: number;
  name: string;
  data: Blob;
  addedAt: number;
}

export type FriendState = 'friend' | 'incoming' | 'outgoing' | 'blocked';
export interface FriendRecord {
  pub: string;
  state: FriendState;
  since: number;
  /** blocked users we were friends with keep nothing else */
  note?: string;
  /** their shared friend list (if they share it) */
  friendsOf?: string[];
}

export interface KvRecord {
  k: string;
  v: unknown;
}

interface AccountDB extends DBSchema {
  ops: {
    key: string;
    value: StoredOp;
    indexes: {
      c: string;
      cl: [string, number];
      cg: [string, number];
      cch: [string, string, number];
      chain: [string, string, string, number];
      tgt: string;
    };
  };
  convos: { key: string; value: ConvoRecord };
  blobs: { key: string; value: BlobRecord };
  profiles: { key: string; value: ProfileCard & { seenAt: number } };
  friends: { key: string; value: FriendRecord };
  kv: { key: string; value: KvRecord };
}

export type AccountDb = IDBPDatabase<AccountDB>;

export async function openAccountDb(pub: string): Promise<AccountDb> {
  return openDB<AccountDB>(`celchat-${pub.slice(0, 24)}`, 1, {
    upgrade(db) {
      const ops = db.createObjectStore('ops', { keyPath: 'id' });
      ops.createIndex('c', 'c');
      ops.createIndex('cl', ['c', 'l']);
      ops.createIndex('cg', ['c', 'g']);
      ops.createIndex('cch', ['c', 'ch', 'l']);
      ops.createIndex('chain', ['c', 'a', 'dv', 's']);
      ops.createIndex('tgt', 'tgt');
      db.createObjectStore('convos', { keyPath: 'c' });
      db.createObjectStore('blobs', { keyPath: 'hash' });
      db.createObjectStore('profiles', { keyPath: 'pub' });
      db.createObjectStore('friends', { keyPath: 'pub' });
      db.createObjectStore('kv', { keyPath: 'k' });
    },
  });
}

export async function deleteAccountDb(pub: string) {
  await new Promise<void>((res) => {
    const r = indexedDB.deleteDatabase(`celchat-${pub.slice(0, 24)}`);
    r.onsuccess = r.onerror = r.onblocked = () => res();
  });
}
