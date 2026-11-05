# CelChat

A free, peer-to-peer, deeply customizable community chat app. Communities with channels, roles and
moderation; DMs and group DMs; voice, video and screen sharing; polls, custom emoji, a soundboard;
animated profiles; full theming with your own fonts. No subscriptions, no paid tiers, no feature
gates, and no company server holding your messages.

**Use it:** in the browser at https://devuaka.github.io/celchat/ (installable as an app on desktop and
phones), or download the Windows desktop app from
[Releases](https://github.com/devuaka/celchat/releases).

> **Status: working alpha.** Everything listed below is implemented and exercised by unit tests and
> two-browser end-to-end tests (one against a local hub, one against the public brokers the website
> uses). It has not been through a security audit. Read "Limitations" before trusting it with
> anything important.

## What makes it different

- **P2P-first.** Your identity is a key pair made on your device. Messages, files, voice and video go
  directly between members' devices over WebRTC. The website needs no server at all: it finds peers
  through free public MQTT brokers, with everything encrypted. Or self-host a tiny hub.
- **Members enforce the rules.** A community is a log of signed operations. Every client re-checks every
  operation against roles, bans, timeouts and channel permissions, so nobody can fake moderator powers,
  even with a modified client. Revocations carry "cutoff vectors" so a demoted admin cannot backdate
  actions to before their demotion.
- **Everything is free.** Things other apps sell or limit, CelChat just does: see the table below.

## CelChat vs Discord's free tier

| | Discord (free) | CelChat |
|---|---|---|
| Screen share quality | 720p 30 fps | up to 1080p 60 fps or source |
| File size per upload | 10 MB | your choice (default 200 MB), sent peer to peer |
| Custom emoji in other servers and DMs | Nitro only | yes, every community emoji works everywhere |
| Animated avatar, banner, profile colors | Nitro only | yes |
| Soundboard sounds from anywhere | Nitro only | yes, your own clips |
| Custom app themes and fonts | no (official themes need Nitro) | full theme editor, your own fonts, share themes in chat |
| DMs end-to-end encrypted | no | yes, on every path |
| Edit history | hidden | visible (peers keep every signed version anyway) |
| Scheduled messages, reminders, bookmarks | no | yes |
| Markdown tables | no | yes |
| Runs without the company's servers | no | yes (P2P, self-hostable hub, archive peers) |

Discord still wins on scale (huge servers, big video calls), bots and integrations, mobile push
notifications and polish from years of work. CelChat is honest about that below.

## Features

| Area | What works |
|---|---|
| Accounts | Key pair identity, password-encrypted local vault, stay signed in, recovery key, encrypted backup files, multiple accounts per browser, optional encrypted account vault |
| Profiles | Display name, @username, avatar + banner (PNG/JPG/WebP/animated GIF), profile colors, name font + style (gradient/glow/shadow), pronouns, about me (markdown), custom status with expiry, online/idle/DND/invisible, creation date, mutual communities and friends, live preview |
| Communities | Create, invite links (expiry, max uses, revoke), open or invite-only, icon, banner, description, community theme, categories, text and voice channels, permission overwrites, roles with 19 permissions and hierarchy, kick, ban (with purge), timeout, nicknames, ownership transfer, up to 250 custom emoji, folders in the sidebar |
| Messaging | Real-time P2P delivery, DMs, group DMs, edit (with visible history), delete, reply, reactions (incl. custom emoji), emoji picker, `:shortcode:` autocomplete, mentions with autocomplete, markdown incl. tables, code blocks with syntax highlighting, polls, voice messages, pins, local search, typing indicators, read receipts, unread markers, jump to message |
| Productivity | Bookmarks, reminders ("remind me in 1 hour"), scheduled messages ("send tomorrow at 9"), an inbox of recent mentions, quick switcher (Ctrl+K), keyboard shortcuts (Ctrl+/), read messages aloud |
| Files | Images, GIFs, videos, audio, any file: sent peer to peer in chunks with progress, cancel, retry and sha256 verification; previews, drag and drop, paste, spoilers, lightbox |
| GIFs | Search via KLIPY or GIPHY (Tenor's API was shut down in 2026), through the hub's key or your own; picked GIFs are sent peer to peer, so recipients never contact the GIF service. Favorites and uploads. |
| Calls | Voice channels with a video stage, 1:1 and group calls with ringing, camera, screen share with system audio (720p to source quality), push-to-talk, mute, deafen, device selection, noise suppression, speaking indicators, per-person volume, soundboard |
| Customization | 10 themes, a full theme editor (every color, font, size, spacing, message style, avatar shape, chat background, custom CSS), uploaded fonts used everywhere, theme import/export and sharing in chat |
| Notifications | Desktop notifications, sounds, mention detection, per-community and per-channel levels, mute, DND, unread badges (tab title, taskbar in the desktop app) |
| Privacy | E2E encrypted DMs on every path, signed (MITM-proof) WebRTC signaling, encrypted relay fallback, direct-connection policy, DM and friend-request filters, blocking |
| Availability | Optional **archive peers**: always-on members you self-host that keep history and attachments available while every human member is offline |
| Apps | Website, installable PWA (desktop and mobile, offline shell), Windows desktop app (tray, taskbar badge, global mute/deafen hotkeys, `celchat://` invite links, start with Windows), responsive mobile layout |

## Quick start (development)

Requirements: Node.js 22.13+ (uses the built-in `node:sqlite`).

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:8780. To try two users on one machine, open a second browser profile, or open
http://127.0.0.1:8780 in another tab: a different origin gets its own storage, so it is a separate user.

| Script | What it does |
|---|---|
| `npm run dev` | Hub on :8781 (auto-restart) + Vite on :8780 (proxies `/ws` and `/api` to the hub); add `-- --keeper` for a local archive peer |
| `npm run build` | Typecheck + production client build into `dist/` (uses the hub serving it) |
| `npm run build:site` | Client that needs no server (public brokers), for static hosting |
| `npm start` | Run the hub; it also serves `dist/` |
| `npm run keeper` | Run an archive peer (see SELF_HOSTING.md) |
| `npm run desktop` | Build the serverless client and open it in the desktop app |
| `npm run dist:desktop` | Build the Windows installer into `release/` |
| `npm run publish` | Push to GitHub Pages and attach the installer to a GitHub release (gh CLI) |
| `npm test` | Unit tests (permission engine, polls, emoji, GIF providers) |
| `npm run test:e2e` | Two isolated browsers against a local hub: messaging, files, permissions, voice, camera, screen share, polls, emoji, scheduling, archive peer |
| `npm run test:serverless` | Two browsers against the public brokers only (needs internet) |
| `npm run test:desktop` | Launches the Electron app and signs up inside it |

## Networks: serverless or hub

CelChat needs something to introduce peers. You choose in Settings, then Connection:

- **Public brokers (no server):** the default for the website and desktop app. Free public MQTT brokers
  relay small encrypted messages: presence, call setup, sealed offline mail. Operators see only
  encrypted traffic, topic hashes, timing and IP addresses.
- **A CelChat hub:** the small server in `hub/` (`npm start`, Docker image included). Adds a username
  directory you control, an avatar cache, faster relaying, optional TURN credentials and GIF search with
  the operator's key.

People only meet others on the same network. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## How it fits together

```
shared/   protocol: crypto, signed ops, permission engine, GIF providers (browser + Node)
client/   React app: core/ (identity, storage, WebRTC, sync, files, voice, transports) + ui/
hub/      optional coordination server: signaling, presence, sealed mailbox, directory, caches, GIF proxy
keeper/   optional archive peer
desktop/  Electron shell for the Windows/macOS/Linux app
tests/    unit tests and the e2e suites
docs/     ARCHITECTURE.md (protocol + data model), SELF_HOSTING.md
```

## Limitations (honest list)

- **Somebody has to be online.** Community history lives on members' devices. If everyone who has a
  message is offline, nobody new can get it until one of them comes back, unless the community has an
  archive peer. DMs use a sealed offline mailbox (about 7 days).
- **Strict NATs.** Without TURN, some networks (symmetric NAT, many mobile carriers, corporate firewalls)
  cannot connect directly. Text and files then go through the encrypted relay; calls do not work.
- **Mesh calls** are comfortable up to about 8 people (rooms cap at 16), and video multiplies the upload
  each person needs.
- **Public brokers are best effort.** They are free services run by others: they can rate limit, drop
  retained mail early or go away. Usernames there are first come, first served but not enforced.
- **Hidden channels are not secret.** "View channel" hides a channel in the UI, but every member's device
  still syncs it.
- **No forward secrecy** in DMs yet (static X25519 keys, no ratchet).
- **Notifications** only arrive while CelChat is open (a tab, the PWA or the desktop app in the tray).
- **Scheduled messages and reminders** run on your device: if CelChat is closed at that moment, they
  happen the next time you open it.
- **The Windows installer is not code-signed** (signing certificates cost money), so SmartScreen warns
  on first run.
- **Browser storage can be evicted.** CelChat asks for persistent storage; keep a backup file.

## License

MIT. Bundled fonts are under the SIL Open Font License (via Fontsource).
