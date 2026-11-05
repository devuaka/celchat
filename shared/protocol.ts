/** Hub <-> client wire messages (JSON over WebSocket). */

export type Presence = 'online' | 'idle' | 'dnd' | 'invisible';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface HubFeatures {
  mailbox: boolean;
  directory: boolean;
  assets: boolean;
  vault: boolean;
  relay: boolean;
  turn: boolean;
  /** GIF search proxied by the hub (provider id), if its operator configured a key */
  gifs?: 'klipy' | 'giphy' | 'tenor-compatible' | null;
}

export interface HubInfo {
  name: string;
  version: string;
  features: HubFeatures;
  limits: { mailItemBytes: number; mailUserBytes: number; mailTtlDays: number; assetBytes: number; vaultBytes: number };
}

export interface TopicPeer {
  pub: string;
  dv: string;
  st: Presence;
}

export type HubToClient =
  | { t: 'challenge'; nonce: string; hub: HubInfo }
  | { t: 'ready'; addr: string; ice: IceServer[]; hub: HubInfo; relayRate?: number }
  | { t: 'topic'; id: string; peers: TopicPeer[] }
  | { t: 'tj'; id: string; peer: TopicPeer }
  | { t: 'tl'; id: string; pub: string; dv: string }
  | { t: 'ts'; id: string; peer: TopicPeer }
  | { t: 'sig'; from: string; d: unknown }
  | { t: 'relay'; from: string; d: string }
  | { t: 'mail'; items: { id: string; box: string; at: number }[] }
  | { t: 'dir'; rid: string; card: unknown | null }
  | { t: 'vault'; rid: string; blob: string | null; at: number | null }
  | { t: 'ok'; rid: string }
  | { t: 'err'; code: string; msg: string; rid?: string; ref?: string }
  | { t: 'replaced' };

export type ClientToHub =
  | { t: 'auth'; pub: string; dv: string; sig: string; st: Presence }
  | { t: 'sub'; topics: string[] }
  | { t: 'unsub'; topics: string[] }
  | { t: 'status'; st: Presence }
  | { t: 'sig'; to: string; d: unknown }
  | { t: 'relay'; to: string; d: string }
  | { t: 'mail.put'; to: string; box: string; rid: string }
  | { t: 'mail.get' }
  | { t: 'mail.del'; ids: string[] }
  | { t: 'dir.put'; card: unknown; rid: string }
  | { t: 'dir.get'; q: string; rid: string }
  | { t: 'vault.put'; blob: string; rid: string }
  | { t: 'vault.get'; rid: string };

export const authMessage = (nonce: string) => `celchat-hub-auth/v1:${nonce}`;
export const assetAuthMessage = (hash: string, ts: number) => `celchat-asset/v1:${hash}:${ts}`;

/** Image formats the hub's public asset cache accepts (magic-byte sniffed). */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'image/webp';
  return null;
}

/** Media types a client will render inline after sniffing (everything else is a download). */
export function sniffMedia(b: Uint8Array): string | null {
  const img = sniffImage(b);
  if (img) return img;
  if (b.length < 12) return null;
  // ISO BMFF (mp4/mov): "ftyp" at offset 4
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'video/mp4';
  // WebM / Matroska EBML
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  // Ogg
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg';
  // MP3 (ID3 or frame sync)
  if ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  // WAV
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45)
    return 'audio/wav';
  return null;
}
