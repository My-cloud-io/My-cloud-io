My Personal Cloud — Telegram Backend v2
This folder is the backend-only upgrade for the existing My Personal Cloud / Cloud-Zen Vercel project.
What it does
Website login with signed HTTP-only cookie.
Uses a Telegram MTProto user session (TELEGRAM_SESSION), not a Telegram Bot API token.
Uploaded files are stored in TELEGRAM_STORAGE_CHAT as Telegram document chunks.
A small Telegram manifest message records file name, MIME type, size, chunk order, and timestamps.
/api/files lists files from Telegram.
/api/stream/:id opens media in the website and supports HTTP Range requests for video/audio seeking.
/api/download/:id downloads a file reconstructed from Telegram chunks.
/api/files DELETE removes the Telegram chunks and manifest.
/api/files/:id PATCH renames the file by editing its Telegram manifest.
No uploaded file is stored permanently on Vercel disk.
Important Vercel point
Vercel documents a 4.5 MiB maximum Function request/response payload. The backend therefore expects browser upload chunks no larger than 4 MiB.
The existing Cloud UI supplied with the project must keep its upload chunk constant at 4 * 1024 * 1024. Do not change it to 100 MB on Vercel.
Fix for the current log
The reported error was:
SESSION_SECRET must be at least 32 characters
This v2 backend removes that brittle length check. A non-empty SESSION_SECRET is SHA-256-derived into a fixed 32-byte HMAC key, so an existing shorter secret will not produce that error. For security, use a long random secret in Vercel.
Vercel Environment Variables
Production should contain:
APP_PASSWORD
DELETE_PASSWORD (optional)
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT
CHUNK_SIZE = 4194304
MAX_CHUNKS = 1024
TELEGRAM_WORKERS = 1
NODE_ENV = production
The values are secrets/configuration. Do not put the Telegram session string in public/ or browser JavaScript.
Deploy
Replace only the backend files in the existing repository with this folder's:
server.js
api/index.js
package.json
vercel.json
Keep the existing public/index.html that already uses the Cloud API, provided its upload chunk is 4 MiB.
After deployment, check:
/api/health
A successful response contains ok: true and telegram: true.
Telegram limits
Telegram's documented cloud file limit is up to 2 GB per file for normal accounts and 4 GB with Premium. This backend's default MAX_CHUNKS=1024 and CHUNK_SIZE=4 MiB allow up to 4 GiB in the application layer; Telegram account limits still apply.
