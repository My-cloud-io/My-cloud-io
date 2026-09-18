Cloud-Zen 3.2.0 — Vercel + Telegram MTProto
This build keeps the existing Cloud-Zen UI and Telegram-backed storage design, but changes the upload path for Vercel Functions.
What was fixed
Browser upload chunks changed from 100 MB to 4 MB.
Removed the browser Content-Length request header.
Upload uses XMLHttpRequest so the progress bar updates while the chunk is transferring.
Added 3 upload attempts with backoff for transient failures.
Upload timeout is 240 seconds per chunk.
Server uses the same fixed 4 MB chunk size so an old CHUNK_SIZE environment variable cannot make the browser/server disagree.
Server returns a clearer /api/health status for Telegram connectivity.
Telegram API ID/hash/session remain server-side environment variables; they are not placed in public/index.html.
Existing Telegram chunk metadata, download, open/stream, rename, share and delete routes are preserved.
Environment variables
Set these in Vercel:
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT = me
NODE_ENV = production
Do not put Telegram secrets inside public/index.html or commit them to GitHub.
CHUNK_SIZE is intentionally ignored by this Vercel-targeted build; the application always uses 4 MB chunks.
Files
server.js — Express + Telegram MTProto backend
package.json — dependencies and start command
telegram-session.js — local helper for creating a Telegram session string
public/index.html — Cloud-Zen frontend
