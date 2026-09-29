Cloud-Zen / My Personal Cloud — Telegram Backend v4
Backend-only upgrade for the existing website. The Telegram storage/upload system is preserved.
Authentication fix
The login endpoint reads APP_PASSWORD directly from the Vercel runtime without trimming or transforming it. It returns explicit JSON error codes instead of the frontend's generic Request failed:
APP_PASSWORD_MISSING — this deployment does not have APP_PASSWORD.
INVALID_PASSWORD — the submitted password does not exactly match APP_PASSWORD.
AUTH_SERVER_ERROR — an actual server-side authentication problem.
/api/auth/status is a safe diagnostic endpoint. It reports only whether configuration values exist; it never returns their values.
IMPORTANT Vercel environment scope
Vercel environment variables are scoped to Production, Preview, and Development. A preview URL uses Preview variables; a production URL uses Production variables. After changing an environment variable, redeploy the project. See Vercel's environment-variable documentation.
For the URL being tested, configure at least:
APP_PASSWORD SESSION_SECRET TELEGRAM_API_ID TELEGRAM_API_HASH TELEGRAM_SESSION TELEGRAM_STORAGE_CHAT
Optional:
DELETE_PASSWORD CHUNK_SIZE=4194304 MAX_CHUNKS=1024 TELEGRAM_WORKERS=1 NODE_ENV=production
Do not put any real secret in GitHub, HTML, or browser JavaScript.
Telegram storage
Browser upload -> /api/upload-chunk -> Telegram storage chat.
Each file is represented by Telegram document chunks plus a small Telegram manifest message. The website can list, open/stream, download, rename, and delete those Telegram-backed files without requiring the Telegram app to be opened.
The backend does not use Vercel's filesystem as permanent storage.
Vercel upload limit
Vercel documents a 4.5 MB Function request-body limit. Therefore the backend accepts chunks up to 4 MiB. The existing frontend must also send chunks no larger than 4 MiB; a frontend that still sends 100 MiB chunks cannot work through this Vercel Function route.
Verification
Run:
npm install npm run check
Then deploy and test /api/auth/status, login, /api/health, file listing, upload, stream/download, rename, and delete.
