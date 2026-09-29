Cloud-Zen — Telegram backend setup
This package intentionally contains only the backend server, Telegram session helper, package manifest, admin notes, and public/index.html.
Required environment variables
APP_PASSWORD — website login password.
DELETE_PASSWORD — password required for permanent delete.
SESSION_SECRET — long random secret used to sign the website cookie.
TELEGRAM_API_ID — Telegram API ID.
TELEGRAM_API_HASH — Telegram API hash.
TELEGRAM_SESSION — saved user-account StringSession.
TELEGRAM_STORAGE_CHAT — Telegram chat/channel ID or username used as the storage destination.
STORAGE_LIMIT_BYTES — optional; defaults to 10 GiB for the website meter.
CHUNK_SIZE — optional; defaults to 4 MiB.
MAX_FILE_SIZE — optional; defaults to 50 GiB.
PORT — supplied by the hosting service when available.
Important architecture rule
Run exactly one persistent Node.js process with one TELEGRAM_SESSION. Do not run the same Telegram session in multiple backend instances. All Telegram requests are serialized through one queue to prevent AUTH_KEY_DUPLICATED caused by concurrent connections.
Vercel Functions are not the runtime target for this MTProto session. Use one persistent Node service. The same service serves public/index.html, so no separate frontend folder or API proxy is required.
Install and run
npm install
npm start
Health check:
GET /api/health
The website itself is:
GET /
Creating TELEGRAM_SESSION
With TELEGRAM_API_ID and TELEGRAM_API_HASH set locally:
npm run telegram:session
Complete the Telegram login once. Put the printed session string into TELEGRAM_SESSION on the persistent server. Do not put it in public/index.html, GitHub, or client-side JavaScript.
Storage behavior
Browser uploads binary chunks to /api/upload-chunk.
The single Telegram client sends every chunk into TELEGRAM_STORAGE_CHAT.
File metadata is stored in the same Telegram chat as CZFILE2 records.
The website rebuilds its file index from Telegram history, so it does not depend on Vercel memory or a separate database.
Older media already present in the configured storage chat is also detected as legacy files where Telegram exposes media information.
The website can list, search, open/stream, download, rename, and delete files without opening Telegram.
Security
Never share TELEGRAM_SESSION, TELEGRAM_API_HASH, APP_PASSWORD, DELETE_PASSWORD, or SESSION_SECRET.
