# CelChat architecture

CelChat is P2P-first. Your browser holds your identity, your data and your copy of every
community you are in. A tiny, self-hostable **hub** only introduces peers to each other and
holds a few small things for people who are offline. Nothing is paid, nothing is metered.

```
 +-----------+   WebRTC DataChannels (DTLS, peer-authenticated)  +-----------+
 |  Client A | <-----------------------------------------------> |  Client B |
 | IndexedDB |   WebRTC audio (SRTP) for voice                   | IndexedDB |
 +-----+-----+                                                   +-----+-----+
       |  WebSocket: signaling, presence topics, sealed mailbox,       |
       |  encrypted relay fallback, username directory                 |
       +---------------------------> HUB <-----------------------------+
                                  (Node + SQLite)
                     optional:  STUN (public, free)  /  TURN (self-hosted coturn)
```

## 1. What is P2P and what needs coordination

| Feature | Works fully P2P | Needs the hub | Notes |
|---|---|---|---|
| Community messages, edits, reactions, pins | yes | only to find peers | Signed ops gossiped over DataChannels |
| Roles, permissions, bans, kicks, timeouts | yes | no | Every peer validates every op |
| History sync / catch-up after being offline | yes | to find peers | Needs at least one member with the data online |
| DMs and group DMs | yes | mailbox if recipient offline | Mailbox holds sealed (E2E encrypted) envelopes only |
| Files, images, GIFs, videos | yes | no | Chunked over DataChannels, sha256-verified |
| Avatars and banners when owner is offline | from any peer that cached them | optional public asset cache | Asset cache can be disabled |
| Voice calls and voice channels | yes (mesh) | signaling | Symmetric NAT needs TURN |
| Finding someone by @username | no | directory | Adding by full CelChat ID works without it |
| Presence (online/idle/dnd) | no | topics | Invisible = hub hides you from topic lists |
| Moving your account to a new device | backup file | optional encrypted vault | Vault blob is encrypted with a key only you have |

Being honest about P2P limits:

* **Somebody has to be online.** A community's history lives on its members' devices. If you
  post while everyone else is offline and then close CelChat, nobody receives that message until
  you and another member are online at the same time. An optional self-hosted archive peer (section
  10) is an always-on member that closes this gap. The hub itself never stores community messages.
* **NAT and firewalls.** STUN gets most home connections through. Symmetric NATs, many mobile
  carriers and strict corporate networks need TURN. CelChat ships no TURN server (bandwidth costs
  money); you can self-host coturn (see SELF_HOSTING.md). Without TURN, text and files fall back
  to the hub's **encrypted relay** (end-to-end encrypted, the hub only sees ciphertext). Voice
  cannot use that relay.
* **Mesh voice scales poorly.** Every participant sends audio to every other participant. Around
  8 people is comfortable on home upload speeds; CelChat warns above that and caps rooms at 16.
* **Gossip fan-out.** Each client keeps a few connections per community (full mesh for small
  communities). Large communities (hundreds online) work but propagation takes a few hops.
* **Browser storage.** IndexedDB can be evicted by the browser under storage pressure. CelChat
  requests persistent storage and offers a backup export.

## 2. Identity and authentication

* An identity is an **Ed25519 signing key** plus an **X25519 encryption key**, both derived from a
  32-byte seed generated in the browser. Your CelChat ID is the Ed25519 public key.
* Your password never leaves your device. It derives (PBKDF2-SHA256, 600k iterations) the
  AES-GCM key that encrypts your seed in IndexedDB. "Stay signed in" stores the seed wrapped by
  a non-extractable WebCrypto key instead.
* Hub login is challenge/response: the hub sends a nonce, the client signs it. The hub stores no
  passwords at all.
* Recovery: a recovery key (base32 seed) and an encrypted backup file. Optionally an encrypted
  account vault on the hub (friends list, community list, settings, themes).
* **Profile cards** are signed JSON (display name, username, about, colors, font, avatar/banner
  hashes, created date). Anyone can verify them; nobody can forge them.

## 3. Communities as signed operation logs

A community is a set of signed **ops**. Each op:

```
header = { v, c (community id), a (author key), dv (device id), s (per-device seq),
           l (lamport clock), t (wall clock), k (kind), ph (sha256 of payload) }
id     = sha256(canonical(header));  sig = ed25519(id)
op     = header + id + sig + p (payload, may be absent after deletion)
```

* The community id is `sha256(owner key + nonce)` from the genesis op, so the owner is provable.
* Merging two copies is set union (a grow-only set CRDT). State is a deterministic fold over the
  ops sorted by `(lamport, id)`, so every peer with the same ops computes the same state.
* Because the signature covers only the payload hash, a **deleted message can be redacted**
  (payload dropped everywhere) while its header still verifies.

### Permissions enforced by every peer

There is no server to trust, so every client re-checks every op against the community state at
that op's position: membership, bans, timeouts, role hierarchy, channel overwrites and
permission bits (Discord-style: administrator, manage community/channels/roles, kick, ban,
timeout, invites, nicknames, send, manage messages, attach, react, mention everyone, voice
connect/speak/mute). Invalid ops are stored as rejected and never shown or forwarded.

**Backdating defence.** A demoted admin could sign an op with an old lamport clock so it sorts
before their demotion. Every revoking op (ban, kick, timeout, role removal, permission removal,
ownership transfer) carries a **cutoff vector** `{ author:device -> last seq seen }` for the
affected users. Any op by them that the revoker had not seen is evaluated as if it came after the
revocation. Two different ops with the same author, device and seq (equivocation) are both
rejected.

Joining requires an invite op (created by someone with the invite permission, revocable, with
optional expiry) or an "open" join policy.

## 4. Transport

* **Hub WebSocket** for signaling. Signaling payloads (SDP/ICE) are signed by the sender's
  identity key, so the hub cannot man-in-the-middle a WebRTC session.
* **WebRTC DataChannel** `cel` (reliable, ordered) for JSON protocol messages, `bin` for file
  chunks. Perfect negotiation (polite peer = lower key) handles renegotiation for voice.
* **Encrypted relay fallback**: if ICE fails and both peers allow it, frames go through the hub,
  AES-GCM encrypted with an X25519-derived pairwise key.
* Privacy setting for direct connections: everyone in my communities / friends only / never
  (relay and TURN only, hides your IP from peers).

Peer protocol messages (JSON on `cel`, fragmented above 60 KB): `hello` (signed profile card),
`sreq` (version vector + optional invite code), `sops` / `sdone` / `sdeny`, `op` (gossip; only ops
that are valid for the forwarder are relayed), `eph` (signed typing and voice presence, 2 hops max),
`freq` / `fcancel` / `ferr` plus binary chunk frames on `bin` (`sha256(32) | index(4) | data`),
`preq` / `profs` / `prof`, `rcpt` (DM read receipts), `fshare` (friend lists for mutual friends),
`ping` / `pong`.

Link lifecycle details that matter in practice:

* Every signal carries a per-tab session id, so when a peer reloads (same device address, new tab)
  the old dead connection is replaced instead of reused.
* When the hub reports that a device left every topic, its link is closed at once (WebRTC can take
  ~30 s to notice), so DMs fall back to the sealed mailbox instead of a dead link.
* Relayed links periodically try an ICE restart, and immediately when voice starts (voice cannot use
  the data relay; once a page has mic access Chrome stops hiding LAN IPs behind mDNS names).
* Removed members (kick/ban) still receive the op that removed them, and ex-members can sync
  governance ops only, so their client learns why it lost access.

Hub topics (presence and peer discovery): `sha256("cc:" + community)`, a pairwise secret topic per
friend or DM partner (`X25519` shared secret, so strangers cannot watch your presence), `gr:` per group
DM, a private `self` topic for your other devices, and one topic per voice room or call.

## 5. Direct messages

1:1 DM ops live in a conversation `c = sha256("dm:" + sorted keys)` and are only ever sent to
the two participants. Paths: DTLS (direct), pairwise AES-GCM (relay), or sealed boxes
(ephemeral X25519 + HKDF + AES-GCM, sender-signed inside) in the hub mailbox. No path exposes
plaintext to the hub. Group DMs (up to 10) work the same way with a member list op log.
Limitation: no forward secrecy ratchet yet (static X25519 keys).

## 6. Files

Attachments are never uploaded to the hub. A message carries `{ hash, name, size, mime,
w, h, thumb }` where `thumb` is a tiny inline preview. The file lives in the sender's IndexedDB
and is fetched in 16 KB chunks from any peer that has it, with progress, cancel and retry. The
receiver verifies size and sha256, sniffs magic bytes before rendering inline, and never renders
SVG/HTML inline. Images under the auto-download limit download automatically.

## 7. Voice

WebRTC mesh audio (Opus) on the same peer connections. Voice channel presence is ephemeral
gossip plus a hub topic per room. Mute, deafen, input/output device selection (`setSinkId`),
browser noise suppression / echo cancellation / AGC, speaking indicators via `AnalyserNode`,
moderator server-mute enforced by every receiver muting that track locally.

## 8. Hub (coordination service)

Node + `ws` + built-in `node:sqlite`. It stores:

| Table | Purpose | Limits (configurable) |
|---|---|---|
| `directory` | username -> signed profile card | 1 per key |
| `mailbox` | sealed envelopes for offline users | 7 day TTL, 2 MB/user, 256 KB/item |
| `assets` | public avatar/banner cache (optional) | 8 MB/file, LRU total cap |
| `vault` | encrypted account backup blob (optional) | 512 KB/user |

Rate limiting is per connection (token buckets) and per IP for HTTP. It also serves the built
client in production and hands out STUN/TURN config (TURN credentials via coturn's shared-secret
REST scheme, never shipped in the frontend).

## 9. Local storage (IndexedDB, per account)

| Store | Key | Contents |
|---|---|---|
| `ops` | id | every op, indexes: `[c,l]`, `[c,a,dv,s]`, `tgt` (edit/react/delete target) |
| `messages` | id | materialized messages per channel, index `[c,ch,l]` |
| `conversations` | c | communities, DMs, group DMs: cached state + per-channel read markers |
| `blobs` | hash | file bytes (chunks) |
| `profiles` | key | verified profile cards |
| `friends` | key | friend / pending / blocked |
| `kv` | name | settings, themes, fonts, notification prefs |

## 9b. Serverless transport (public MQTT brokers)

`client/src/core/mqtthub.ts` implements the same interface as the WebSocket hub client, so the rest of
the app does not know which one it uses. The static website and the desktop app default to it.

| Hub feature | Over public brokers |
|---|---|
| Presence topics | `celchat/v1/t/<topic id>`; payloads AES-GCM encrypted with a key derived from the topic's secret under a different label (knowing the topic id is not enough), signed by the sender; `who` / `here` / `bye` with 20 s heartbeats and 55 s expiry; pre-encrypted `bye` sent on page hide |
| Signals, relay frames | Sealed box (ephemeral X25519) to the recipient on `celchat/v1/a/<hash(device)>` or `.../p/<hash(key)>`; the sender is authenticated downstream (signed signals, pairwise-keyed relay frames) |
| Mailbox | Retained QoS 1 messages under `celchat/v1/m/<hash(key)>/<id>` with a 7 day MQTT 5 expiry, read by wildcard subscription, deleted by publishing an empty retained message |
| Directory | Retained signed profile cards under hashed username and key topics; first come, first served but not enforceable |
| Vault | Retained encrypted blob under a topic derived from the private key |

Two brokers are used at once (EMQX and HiveMQ public brokers); everything is published to both and
duplicates are dropped by content hash.

## 9c. Calls

Each kind of media has its own sender transceiver per peer: `mic` (mixed through Web Audio so mute,
push-to-talk and the soundboard act on one track), `cam`, `screen` and `screenAudio`. Peers announce
which stream id is the camera and which is the screen in an `av` message, so receivers label tiles
correctly. Screen share bitrate and frame rate are set per sender (`setParameters`).

## 10. Archive peers

`keeper/` is a headless member for availability. It reuses `shared/` (engine, ops, crypto) and the
client's `HubClient` and fast op verifier, stores ops in SQLite and files on disk, and speaks the
exact peer protocol of browsers, but only over the encrypted hub relay (no WebRTC in Node).

* **Joining:** a member with invite rights sends it a sealed `keeper.join` envelope holding a
  single-use invite link. The keeper accepts only from `KEEPER_OWNERS` (or anyone with
  `KEEPER_OPEN`), syncs the community from members using the invite code, then signs its own `join`.
* **Discovery:** its profile card is signed with `bot: true`. Clients always keep a link to archive
  peers in their community topics (outside the random gossip fan-out) and go straight to the relay.
  If a browser tries WebRTC first, the keeper answers with a signed `relay-only` signal.
* **Serving:** members sync from it like from any peer; invite holders can join through it while all
  humans are offline; it pulls attachments, avatars, banners and icons (size-capped) from their
  authors and serves them back chunk by chunk, verified by sha256 on both ends.
* **Obeying the community:** it validates every op, relays only valid ones, redacts deleted and
  purged messages on disk, and deletes the whole community if it is kicked or banned.
* **Ordering:** both browsers and the keeper process each link's messages strictly in order, and
  browsers apply WebRTC signals strictly in order (concurrent handling lost renegotiation offers).

## 11. Technical decisions (and why)

| Decision | Why |
|---|---|
| Signed op log + deterministic replay instead of Yjs/Automerge | Generic CRDTs accept any edit from any peer. Communities need *authorized* merges, so every op is signed and validated against roles at its position. |
| Cutoff vectors on revocations | Without them a demoted admin can sign ops with an old lamport clock. Ops a revoker had not seen are evaluated after the revocation. |
| Ed25519 for identity, its Montgomery form for X25519 | One public key per user serves as ID, signature key and encryption key. |
| PBKDF2-SHA256 600k (WebCrypto) for the local vault | Native in every browser, no WASM; the password never leaves the device. |
| WebCrypto Ed25519 verification with noble fallback | Native verification is roughly 10x faster for history sync. |
| Materialize messages on read, do not store them | Message validity depends on governance, which can change retroactively; recomputing on load is always correct. |
| Node + `node:sqlite` hub | Zero native dependencies, one file of state, trivial to self-host. PostgreSQL would be overkill for a service that stores almost nothing. |
| No GIF search provider | Every provider needs an API key and sees searches. Uploads, stars and favorites instead. |
| Hidden channels labelled as not encrypted | Being honest beats a fake privacy feature; encrypted private channels need key distribution and rotation, which is roadmap work. |

## 12. Development stages

1. Architecture (this file) 2. Scaffold 3. Shared protocol + permission engine (unit tested)
4. Hub 5. Client core: identity, storage, P2P links, sync 6. Main UI 7. Communities and channels
8. Messaging 9. Profiles and customization 10. Files 11. Voice 12. Notifications
13. Two-browser end-to-end test 14. Polish and docs
