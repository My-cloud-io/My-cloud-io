Cloud-Zen 3.3.1 — Vercel + Telegram
This build connects the supplied public/index.html UI to the supplied Telegram MTProto backend and adapts the server for Vercel serverless hosting.
Vercel Environment Variables
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
MAX_FILE_SIZE=1099511627776 (1 TiB; this is the default)
Do NOT put Telegram secrets in public/index.html or GitHub.
Vercel upload behavior
Browser/server chunks are fixed at 4 MiB to stay below Vercel Function request-body limits. The original HTML used 100 MiB chunks, so the HTML was updated to 4 MiB.
The durable file copy is Telegram. Vercel's local filesystem is temporary and is used only for short-lived chunk/download files.
Completed files are not automatically deleted by this application. They remain in Telegram until the user uses the Delete action. Delete requires DELETE_PASSWORD.
Deploy
Push this folder to GitHub.
Import the repository into Vercel.
Framework preset: Other.
Build command: leave empty.
Output directory: leave empty.
Add the Environment Variables above for Production.
Deploy.
The /api/* routes are rewritten to the Vercel serverless entry at api/index.js.
