# EZR WhatsApp Bot

Pairing-code WhatsApp bot on Node.js 20+, Express and Baileys (`@whiskeysockets/baileys` 6.x stable, no forks, no RC).
Session ID: **EZR4-4BH1** (override with `SESSION_ID`). Credentials live in `./sessions/EZR4-4BH1/` and survive restarts.

## Install
```bash
git clone <your-repo> ezr-whatsapp-bot && cd ezr-whatsapp-bot
cp .env.example .env        # edit values
npm install                 # needs git installed (Baileys fetches libsignal from GitHub)
npm start
```
Open `http://localhost:8000`, enter your number, press **GENERATE PAIRING CODE**.

## Local testing
```bash
curl localhost:8000/                       # {"status":"online","service":"EZR WhatsApp Bot"}
curl localhost:8000/status
curl "localhost:8000/pair?number=919876543210"   # {"success":true,"sessionId":"EZR4-4BH1","pairingCode":"XXXX-XXXX"}
curl localhost:8000/qr                     # JSON with QR; add ?format=png for an image
curl -X POST localhost:8000/logout
```
If `ACCESS_KEY` is set add `-H "x-access-key: <key>"` to `/pair`, `/qr`, `/logout`.
Then in WhatsApp: **Linked Devices → Link a Device → Link with phone number instead**, enter the code.
Send `ping` → `pong`, `menu`, `status`, `help` to the linked number from another chat.
Restart the server: it reconnects automatically from the saved credentials (no new code).

## API
| Route | Purpose |
|---|---|
| `GET /` | Health JSON (browsers get the web UI) |
| `GET /status` | Connection / auth state, last connected, reconnect attempts |
| `GET /pair?number=` | Create/reuse socket, wait until ready, return pairing code |
| `GET /qr` | Current QR (JSON, or `?format=png`) |
| `POST /logout` | Log out and delete saved credentials |

## Reconnect behaviour
- 401 loggedOut / 500 badSession: credentials removed, fresh pairing required
- 408 / 428 / others: exponential backoff (1s → 30s cap, `MAX_RECONNECT_ATTEMPTS`)
- 515 restartRequired: quick recreate (expected right after pairing)
- 440 replaced / 403 forbidden: no automatic reconnect
- One socket per session; the old socket is always detached before a new one is created.

## Deployment
**Docker**
```bash
docker build -t ezr-whatsapp-bot .
docker run -d --name ezr -p 8000:8000 --env-file .env -v ezr_sessions:/app/sessions ezr-whatsapp-bot
```
The volume is essential: without persistent storage you must re-pair after every deploy.
The image runs as the `node` user; if a mounted host directory is not writable, `chown 1000:1000` it.
The server binds `0.0.0.0` and honours `PORT`. On Render/Railway/Fly/VPS, mount a persistent disk at `/app/sessions`
(or enable the GitHub backup below). Set `ACCESS_KEY` if the app is public, otherwise anyone can call `/pair` or `/logout`.
Run only **one instance** per session.

**GitHub backup (optional)** – set `GITHUB_TOKEN`, `GITHUB_REPO=owner/repo`, `GITHUB_BRANCH`. `creds.json` is uploaded
(debounced) and restored on boot if missing. Use a **private** repo: these credentials give full access to the linked account.
Failures are logged and never affect WhatsApp or pairing.

## Troubleshooting pairing codes
- **"Invalid phone number"**: digits only, country code included, no leading 0 (`919876543210`).
- **"Already authenticated"**: call `POST /logout` first, or delete `sessions/EZR4-4BH1/`.
- **Timeout / code never arrives**: server has no outbound internet or WhatsApp blocks the host IP; try another network/host.
- **Code rejected by WhatsApp**: codes last about 2 minutes; generate a fresh one, and use the same number you entered.
- **Link fails / "can't link device"**: make sure the number is the one logged into that phone's WhatsApp, update WhatsApp, and don't have too many linked devices (max 4).
- **Disconnects with 401**: WhatsApp removed the device; pair again.
- **Disconnects with 440**: same session opened elsewhere (second server instance?).
- **`npm install` fails on libsignal**: install `git` (and in Docker use the provided Dockerfile).
- **Readable logs**: `npm start | npx pino-pretty`. Pairing codes are masked in logs by design.

## Security
No secrets in code. `.env`, `sessions/`, `temp/` are git-ignored and never served (the app uses no static middleware; only `public/index.html` is sent explicitly).
Baileys is an unofficial client; automation can violate WhatsApp's Terms of Service, so use a number you can afford to lose.
