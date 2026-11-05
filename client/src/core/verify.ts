/**
 * Fast op verification: WebCrypto Ed25519 (native, async) when the browser has
 * it, noble (pure JS) otherwise. Structure and hashes are checked identically.
 */
import { canonical } from '@shared/canonical';
import { sha256Bytes, sha256Hex, verify as nobleVerify } from '@shared/crypto';
import { bytesToHex, hexToBytes, isHex } from '@shared/bytes';
import { headerOf, type Op } from '@shared/ops';
import { LIMITS } from '@shared/limits';

let native: boolean | null = null;
const keyCache = new Map<string, Promise<CryptoKey>>();

async function hasNative() {
  if (native !== null) return native;
  try {
    const k = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(1), { name: 'Ed25519' }, false, ['verify']);
    native = !!k;
  } catch {
    native = false;
  }
  return native;
}

function keyFor(pub: string) {
  let k = keyCache.get(pub);
  if (!k) {
    if (keyCache.size > 5000) keyCache.clear();
    k = crypto.subtle.importKey('raw', hexToBytes(pub) as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['verify']);
    keyCache.set(pub, k);
  }
  return k;
}

export async function verifySig(pub: string, msg: Uint8Array, sig: string): Promise<boolean> {
  if (!isHex(pub, 64) || !isHex(sig, 128)) return false;
  if (await hasNative()) {
    try {
      return await crypto.subtle.verify('Ed25519', await keyFor(pub), hexToBytes(sig) as Uint8Array<ArrayBuffer>, msg as Uint8Array<ArrayBuffer>);
    } catch {
      return false;
    }
  }
  return nobleVerify(pub, msg, sig);
}

export async function verifyOpFast(raw: unknown): Promise<boolean> {
  if (!raw || typeof raw !== 'object') return false;
  const op = raw as Op;
  if (op.v !== 1) return false;
  if (!isHex(op.c, 64) || !isHex(op.a, 64) || !isHex(op.dv, 16) || !isHex(op.id, 64) || !isHex(op.sig, 128) || !isHex(op.ph, 64)) return false;
  if (!Number.isSafeInteger(op.s) || op.s < 1 || !Number.isSafeInteger(op.l) || op.l < 1 || !Number.isSafeInteger(op.t) || op.t < 0) return false;
  if (typeof op.k !== 'string' || op.k.length > 24) return false;
  const idBytes = sha256Bytes(canonical(headerOf(op)));
  if (bytesToHex(idBytes) !== op.id) return false;
  if (op.p !== undefined) {
    let pj: string;
    try {
      pj = canonical(op.p);
    } catch {
      return false;
    }
    if (pj.length > LIMITS.opBytes || sha256Hex(pj) !== op.ph) return false;
  }
  return verifySig(op.a, idBytes, op.sig);
}

/** Copy only the fields that belong on the wire (drops anything a peer smuggled in). */
export function cleanOp(raw: Op): Op {
  const o: Op = { v: 1, c: raw.c, a: raw.a, dv: raw.dv, s: raw.s, l: raw.l, t: raw.t, k: raw.k, ph: raw.ph, id: raw.id, sig: raw.sig };
  if (raw.p !== undefined) o.p = raw.p;
  return o;
}
