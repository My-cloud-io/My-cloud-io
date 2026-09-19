Cloud-Zen 3.4.0 — Telegram-backed private cloud
Final upgraded build. This version fixes the core bug that was breaking every upload of more than a few MB, and adds faster parallel uploads, bulk select/delete, and a cleaner storage display.
What was actually broken (and is now fixed)
The browser was slicing files into fixed 4 MiB chunks, but the server validated every chunk against its own chunk size (64 MiB by default). Those two numbers never matched, so the server rejected almost every chunk after the first one — which is exactly why big files (and often any file over a few MB) would not upload.
Fix: the server now exposes its real chunk size at GET /api/config, and the browser always uses that exact number. There is only one source of truth now, so this class of bug cannot happen again.
Real, honest limits (please read this)
Telegram's own per-message file size limit is about 2 GB on a regular account (4 GB with Telegram Premium). This app works around that by splitting every file into many chunks, each sent as its own message, then reassembling them on download. That's how it can store files far larger than Telegram's single-message limit — GB or TB scale files are fine in principle, limited only by your disk/network and how long you're willing to leave the tab open while it uploads.
Actual upload speed is bounded by your internet uplink and Telegram's server-side limits — no app can make your network faster than it is. What this update does is remove the artificial bottlenecks in the code (the broken chunk size, and fully serial one-chunk-at-a-time uploads). Chunks now upload in parallel (4 at once by default), which meaningfully improves throughput on a fast connection.
Telegram may rate-limit (FLOOD_WAIT) if you push too many requests too fast. The server now waits and retries automatically when this happens, instead of just failing the upload.
If the browser tab is closed mid-upload, the transfer stops — no web app can keep sending bytes after the browser has stopped. Re-uploading picks up from scratch (chunks already accepted by Telegram are simply overwritten by a fresh attempt with a new upload ID).
Deployment: use Render, Railway, Fly.io, or a VPS — NOT Vercel
This app needs a long-running Node process that keeps one persistent Telegram (MTProto) connection alive, and it needs to accept large request bodies without a hard execution-time limit. Vercel's serverless functions are a poor fit for both of those (short execution limits, and historically small request body caps) — if you deployed this on Vercel before, that is very likely part of why uploads failed. Deploy it on Render, Railway, Fly.io, or any regular VPS/Node host instead.
Environment variables
Never put Telegram secrets in public/index.html — keep them in your host's environment variable settings only.
Required:
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT (recommended: me, i.e. your own Saved Messages)
NODE_ENV=production
Optional:
CHUNK_SIZE — bytes per chunk. Default 20 MiB. Clamped between 4 MiB and 256 MiB. Bigger chunks mean fewer Telegram messages per file (faster for huge files on a fast, stable connection); smaller chunks resume more granularly on a flaky connection.
UPLOAD_CONCURRENCY — how many chunks the browser uploads in parallel per file. Default 4, max 8. Higher can be faster but hits Telegram's rate limits sooner.
TELEGRAM_WORKERS — Telegram client internal upload workers per chunk. Default 8, max 16.
MAX_FILE_SIZE — safety ceiling in bytes. Default 20 TiB.
What's new in this build
Fixed the chunk-size mismatch bug that broke uploads of any real-sized file (see above) — this was the main reported problem.
Parallel chunk uploads (4 at once by default) instead of one at a time, for real speed improvements on big files.
Automatic FLOOD_WAIT handling — if Telegram asks the server to slow down, it waits the exact requested time and retries instead of failing the upload.
Live upload speed shown per file in the upload queue (MB/s).
Multi-select: tap the select icon in the toolbar, tick files, then bulk-download or bulk-delete (delete still requires the delete password, same as single-file delete).
Simplified storage card: removed the old fake "X / 10 GB" quota display, since there was never a real 10 GB cap — it now just shows how much you've actually used.
Rename (three-dot menu → Rename) and password-protected delete were already implemented in the previous build and are unchanged — both use the existing backend endpoints (PATCH /api/files, DELETE /api/files with deletePassword).
Tapping a file card now opens/downloads it directly, in addition to the three-dot menu (Open, Share, Download, Rename, Delete).
Existing features carried over unchanged: search, sort, grid/list view, drag-and-drop upload, starred files, recent files, QR share, built-in PDF/image/video/audio preview, secure share links.
Files
public/index.html — frontend UI
server.js — Express + Telegram MTProto backend
package.json
telegram-session.js — run locally, not on your host, to generate TELEGRAM_SESSION
Telegram session note
The same TELEGRAM_SESSION must not be used by another running deployment or local process at the same time — Telegram will invalidate it (AUTH_KEY_DUPLICATED) if two processes fight over the same session. If that happens, generate a fresh session with telegram-session.js and update your host's environment variable. Never paste your session string into chat, source code, or version control.
