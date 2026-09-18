Cloud-Zen 3.3.0 — Vercel + Telegram
Final upgraded build for the existing My Personal Cloud / Cloud-Zen deployment.
Included
public/index.html — upgraded mobile UI
server.js — Express + Telegram MTProto backend
package.json
telegram-session.js
Environment variables
Keep these in Vercel Environment Variables; never put Telegram secrets in public/index.html.
Required:
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT (recommended: me)
NODE_ENV=production
Optional:
TELEGRAM_WORKERS=4
CHUNK_SIZE is intentionally ignored by the app's Vercel-safe upload setting; browser/server use a fixed 4 MiB chunk.
MAX_CHUNKS is fixed in code.
Main upgrades
Vercel-safe 4 MiB upload chunks.
Real per-chunk upload progress using XHR.
Automatic upload retries.
File list and storage UI use local cache first, then refresh in the background so the dashboard does not appear frozen during a Telegram cold start.
Telegram index discovery uses server-side search for the app's CZ1 marker instead of scanning all Saved Messages history.
Short in-memory index TTL to avoid repeated Telegram history scans.
Browser-private caching for authenticated file streams to reduce repeated image/PDF downloads.
Three-dot file menu: Open, Share, Download, Rename, Delete.
Rename UI connected to the existing backend rename endpoint.
Share UI connected to the existing secure /api/share endpoint.
Delete UI now actually asks for DELETE_PASSWORD and sends it to the backend.
PDF opens inside the built-in viewer instead of forcing a download.
Existing image/video/audio preview remains supported.
Important
Telegram credentials/session are user-owned secrets. Do not commit them to GitHub or place them in the HTML.
