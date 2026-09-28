Cloud-Zen — Persistent Telegram Backend
Architecture
Vercel/static frontend -> one persistent Node.js backend -> one Telegram MTProto client -> Telegram storage chat.
Do NOT run the Telegram MTProto backend as multiple Vercel serverless instances. The same TELEGRAM_SESSION must not be used concurrently by multiple backend processes.
Files
index.html — existing Cloud-Zen frontend.
server.js — persistent Telegram backend.
package.json — Node dependencies and start/check scripts.
.env.example — required environment variable names.
Environment
Set these on the persistent backend:
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT
PORT (optional; default 3000)
NODE_ENV=production
TELEGRAM_WORKERS (optional)
CHUNK_SIZE (optional)
Do not commit .env or real Telegram credentials.
Run
npm install
npm run check
npm start
The backend exposes /api/health for Telegram connection status.
Important
Keep exactly one active backend process/replica using the Telegram session. If an old Vercel Telegram backend is still using the same session, stop it before starting this backend. If Telegram has already invalidated the session because of AUTH_KEY_DUPLICATED, generate/use a fresh valid session for the single persistent backend.
The project is intended to keep storage in Telegram rather than B2, MEGA, IDrive E2, Cloudinary, Filebase, or Koofr.
