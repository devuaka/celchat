# Self-hosting CelChat

You do not need to host anything to use CelChat: the website and desktop app work in **serverless
mode**, where free public MQTT brokers carry small encrypted messages (presence, call setup, sealed
offline mail) and everything else goes peer to peer. Host your own pieces when you want control,
reliability or extras:

| Piece | Why you might want it |
|---|---|
| The web client (static files) | Your own copy of the website: `npm run build:site`, upload `site/` anywhere (GitHub Pages, Netlify, any web server): landing page at the root, the app in `app/`. Or upload just `dist/` from `node scripts/build-variant.mjs serverless` for the bare app. Relative paths, works under any sub-path. |
| A hub | A username directory you control, avatar cache, faster encrypted relay, TURN credentials, GIF search with your key. People on your hub only meet each other. |
| An archive peer | Keeps your communities readable while everyone is offline. |
| TURN (coturn) | Calls for people behind strict NATs. |
| Your own MQTT broker | Serverless mode without depending on public brokers: in Settings, Connection, choose a hub URL of the form `mqtt:wss://your-broker:8084/mqtt` (comma-separate several). |

## Desktop app

```bash
npm run dist:desktop
```

builds `release/CelChat Setup <version>.exe` (NSIS, per-user install). macOS (`dmg`) and Linux
(`AppImage`) targets are configured in `package.json` but must be built on those systems. The app loads
the serverless client from a private `app://` origin; users can switch it to your hub in Settings.
Without a code-signing certificate Windows SmartScreen shows a warning on first run.

## Running a hub

A hub is one Node process that also serves the web client. It needs almost no storage: it never holds
community messages or DM contents.

## Option A: Docker

```bash
docker compose up -d
```

This builds the client, starts the hub on port 8781 and keeps its SQLite database and asset cache in
the `celchat-data` volume. Put a reverse proxy with HTTPS in front of it (below).

To also run a TURN server for voice behind strict NATs:

```bash
docker compose --profile turn up -d
```

and set `TURN_URLS` / `TURN_SECRET` (see the compose file). The TURN container uses host networking
because TURN needs a large UDP port range.

## Option B: plain Node

```bash
npm ci
```

```bash
npm run build
```

```bash
HUB_PORT=8781 DATA_DIR=/var/lib/celchat npm start
```

Run it under systemd, pm2 or similar.

## HTTPS reverse proxy (required)

Browsers only allow WebCrypto, microphones and service features on `https://` (or `localhost`).
The hub speaks plain HTTP and WebSocket at `/ws`.

Caddy (automatic certificates):

```
chat.example.com {
  reverse_proxy 127.0.0.1:8781
}
```

nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name chat.example.com;
  # ssl_certificate ... (e.g. certbot)
  client_max_body_size 12m;
  location / {
    proxy_pass http://127.0.0.1:8781;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 3600s;
  }
}
```

Set `TRUST_PROXY=1` when behind a proxy so rate limits use the real client IP.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `HUB_PORT` / `PORT` | `8781` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `HUB_NAME` | `CelChat Hub` | Shown in clients |
| `DATA_DIR` | `./data` | SQLite database + asset cache |
| `STATIC_DIR` | `./dist` | Built client to serve |
| `TRUST_PROXY` | off | Use `X-Forwarded-For` for rate limiting |
| `ALLOWED_ORIGINS` | any | Comma-separated origins allowed to connect |
| `STUN_URLS` | Google + Cloudflare STUN | Comma-separated `stun:` URLs |
| `TURN_URLS` | none | Comma-separated `turn:`/`turns:` URLs of your coturn |
| `TURN_SECRET` | none | coturn `static-auth-secret`; the hub mints time-limited credentials, the secret never reaches browsers |
| `TURN_TTL` | `43200` | TURN credential lifetime (seconds) |
| `MAILBOX` | on | Sealed offline mail for DMs and friend requests |
| `MAIL_TTL_DAYS` | `7` | How long undelivered mail is kept |
| `MAIL_ITEM_BYTES` | `262144` | Max size of one envelope |
| `MAIL_USER_BYTES` | `4194304` | Max pending mail per recipient |
| `DIRECTORY` | on | @username lookups |
| `ASSET_CACHE` | on | Public cache for avatars, banners and community icons |
| `ASSET_MAX_BYTES` | `10485760` | Max size per cached image |
| `ASSET_TOTAL_BYTES` | `1073741824` | Cache size cap (least recently used are evicted) |
| `VAULT` | on | Encrypted account backups (friends, communities, settings; never messages) |
| `VAULT_BYTES` | `786432` | Max vault size per account |
| `RELAY` | on | Encrypted relay when direct WebRTC fails |
| `RELAY_BYTES_PER_SEC` | `262144` | Relay bandwidth per connection |
| `RELAY_TRUSTED_KEYS` | none | CelChat IDs of your archive peers (bigger relay budget) |
| `RELAY_TRUSTED_BYTES_PER_SEC` | `4194304` | Their relay bandwidth |
| `MAX_CONNS_PER_IP` | `32` | WebSocket connections per IP |
| `GIF_PROVIDER` | none | `klipy`, `giphy` or `tenor-compatible` (Tenor's own API shut down on 2026-06-30) |
| `GIF_API_KEY` | none | The provider key. Stays on the hub; clients search through `/api/gifs/*` and media is proxied, so the provider never sees users' IPs |
| `GIF_BASE_URL` | provider default | For `tenor-compatible`: any server speaking Tenor's v2 API |
| `GIF_CONTENT_FILTER` | `medium` | `off`, `low`, `medium`, `high` |

Turn a feature off with `=0`. Clients adapt (for example, with no directory users add each other by
CelChat ID).

## What the hub stores

| Data | Readable by the hub? |
|---|---|
| Who is online in which topic (hashed community ids, pairwise friend topics) | yes, it must route signaling |
| Sealed mailbox envelopes | no, encrypted to the recipient |
| Encrypted account vault | no, encrypted with a key derived from your private key |
| Signed profile cards (directory) | yes, they are public profiles |
| Avatar/banner/icon cache | yes, they are public images |
| Community messages, DMs, files | never stored, never seen |

Back up `DATA_DIR` if you care about pending mail and the directory. Losing it loses no messages.

## Archive peers (keep communities available)

Community history lives on members' devices. An **archive peer** is an always-on member you run
yourself (next to the hub, or on any machine that stays on). It keeps full history and attachments
and serves them to members and invite holders whenever they come online, so a community stays
readable and joinable even when every human member is offline.

```bash
KEEPER_HUB_URL=wss://chat.example.com/ws KEEPER_OWNERS=@your_username npm run keeper
```

On first start it creates its identity in `KEEPER_DATA_DIR/identity.json` and prints its CelChat ID.
Then, in CelChat: community settings, **Archive peers**, enter `@archive` (or its ID), **Add**. The
client sends it a sealed single-use invite; the archive peer joins if the sender is in `KEEPER_OWNERS`.

What it is and is not:

* It is a **member**: it can read everything in the communities it is in, like any member. Only add
  ones run by people the community trusts. Its profile is signed with `bot: true`, so every client
  labels it "archive".
* It validates every op with the same engine as browsers, obeys roles and bans, and **deletes its copy**
  of a community if it is kicked or banned. Deleted messages and ban purges are redacted on disk too.
* It has no WebRTC stack: it talks to browsers through the hub's end-to-end encrypted relay, so it needs
  no open ports. Put its ID in the hub's `RELAY_TRUSTED_KEYS` to give it a bigger relay budget.
* It does not join DMs or group DMs (those already have the sealed mailbox) and never sends messages.

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_HUB_URL` | `ws://localhost:8781/ws` | Hub WebSocket URL |
| `KEEPER_DATA_DIR` | `./data/keeper` | SQLite store, files, identity |
| `KEEPER_USERNAME` | `archive` | Must be free on the hub |
| `KEEPER_NAME` / `KEEPER_ABOUT` | | Display name and about text |
| `KEEPER_OWNERS` | none | Comma-separated CelChat IDs or @usernames allowed to add it |
| `KEEPER_OPEN` | off | Accept join requests from anyone who can create an invite (watch your disk) |
| `KEEPER_MAX_COMMUNITIES` | `50` | Cap |
| `KEEPER_JOIN` | none | Invite links to join on start |
| `KEEPER_FILES` | on | Archive attachments, avatars, banners, community icons |
| `KEEPER_FILE_MAX_MB` | `25` | Largest file it keeps |
| `KEEPER_FILES_TOTAL_GB` | `5` | Total file budget |
| `KEEPER_STATUS_PORT` | off | Local JSON status at `http://127.0.0.1:PORT/status` |

Hub-side settings for archive peers: `RELAY_TRUSTED_KEYS` (comma-separated IDs) and
`RELAY_TRUSTED_BYTES_PER_SEC` (default 4 MB/s).

For local development, `npm run dev -- --keeper` starts one that accepts anyone (status on :8785).

## TURN (voice through strict NATs)

Most home connections work with STUN only. If your users are on mobile networks or behind corporate
firewalls, run coturn:

```
# /etc/turnserver.conf
use-auth-secret
static-auth-secret=CHANGE_ME_LONG_RANDOM
realm=chat.example.com
listening-port=3478
tls-listening-port=5349
min-port=49160
max-port=49200
fingerprint
no-cli
```

Then start the hub with:

```bash
TURN_URLS=turn:chat.example.com:3478,turns:chat.example.com:5349 TURN_SECRET=CHANGE_ME_LONG_RANDOM npm start
```

TURN relays media, so its bandwidth bill is the only real running cost of CelChat. Without TURN, text
and files still work through the hub's encrypted relay; voice needs a direct path or TURN.

## Updating

Clients and hubs speak protocol version 1. Rebuild and restart; clients reconnect automatically.
