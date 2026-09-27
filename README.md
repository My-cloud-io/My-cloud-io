Cloud-Zen — Telegram Storage / Vercel
This is the Vercel-targeted Telegram-only build.
Project files
index.html — single-file mobile-first website UI
server.js — Express + Telegram MTProto backend
package.json — dependencies and start script
.env.example — required environment variable names
Vercel environment variables
Set these in Production:
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT (for example me)
TELEGRAM_WORKERS
NODE_ENV=production
CHUNK_SIZE is intentionally ignored. Browser and server use a fixed 4 MiB chunk so requests stay below Vercel's 4.5 MB function request-body limit.
Storage behavior
File chunks are stored as Telegram documents with Cloud-Zen metadata in their captions. The website rebuilds its file index from Telegram history, so completed data does not depend on Vercel's temporary filesystem.
Important deployment note
Do not put Telegram secrets in index.html or GitHub. After changing code, deploy a new Production deployment and test / and /api/health before uploading a large file.
