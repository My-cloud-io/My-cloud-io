Cloud-Zen — Backend Only
This package intentionally contains only:
server.js
telegram-session.js
package.json
admin.md
public/index.html
Important: one persistent Telegram process
TELEGRAM_SESSION is a Telegram authorization credential. Telegram can invalidate it when the same session is used by multiple independent connections. Your previous AUTH_KEY_DUPLICATED logs are consistent with that situation.
Do not run this backend in multiple Vercel Functions, Preview deployments, Production serverless functions, or another server at the same time.
Recommended layout:
Vercel: frontend only, if you want.
One persistent Node.js service: this backend + the Telegram session.
Point the frontend at that single backend URL.
A persistent Node host is required for the Telegram part. A normal Vercel Function is not a suitable place for a single long-lived MTProto connection.
Environment
Required:
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT
Optional:
STORAGE_LIMIT_BYTES (default 10 GiB)
MAX_FILE_SIZE (default 4,000,000,000 bytes)
PORT (default 3000)
The browser/backend upload protocol uses 4 MiB browser chunks. Each chunk is sent to the configured Telegram storage chat as a Telegram document. File metadata is encoded in captions and small Telegram control messages, so the listing can be rebuilt from Telegram after a restart.
Fresh session
If the current session has already been invalidated:
Stop every old process/deployment using that session.
On a trusted local machine run: npm install npm run telegram:session
Complete Telegram's login code/2FA prompts.
Put the printed value into TELEGRAM_SESSION on the ONE persistent backend.
Keep TELEGRAM_STORAGE_CHAT pointed at the same storage chat to recover existing data.
Never put the session string in public/index.html, GitHub, screenshots, or chat.
Test
Start: npm start
Health: GET /api/health
A healthy Telegram connection should report: "telegram": true
If health is false, the website cannot list or upload Telegram data.
Website API
POST /api/auth/login
GET /api/auth/me
POST /api/auth/logout
GET /api/files?q=...
GET /api/storage
POST /api/upload-start
POST /api/upload-chunk?fileId=...&index=...&total=...&size=...&mime=...&name=...
POST /api/upload-finish
GET /api/files/:id/open
GET /api/files/:id/download
GET /api/files/:id/share
GET /api/share/:id?token=...
POST /api/files/:id/rename
POST /api/files/:id/hide
Add ?includeHidden=1 to /api/files to show hidden items for unhide.
POST /api/files/:id/delete
Telegram size note
Telegram currently documents ordinary user uploads up to 2 GB per file, or 4 GB for Premium. This backend therefore defaults to a 4,000,000,000-byte maximum. The storage chat itself remains Telegram-backed.
Security
Never expose:
TELEGRAM_SESSION
TELEGRAM_API_HASH
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
The dark/terminal appearance in public/index.html is only a visual theme; this project does not add hacking tools or bypasses.
