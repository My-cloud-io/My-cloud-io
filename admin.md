Cloud-Zen — Backend Only
This package is intentionally small. It contains only:
server.js
telegram-session.js
package.json
admin.md
public/index.html
Critical: hosting
This Telegram MTProto backend must run as one persistent Node.js process.
Do not run the same TELEGRAM_SESSION in multiple Vercel Functions, preview deployments, production deployments, or other simultaneous processes. Telegram can invalidate the authorization key and return:
AUTH_KEY_DUPLICATED: Concurrent usage of the current session from multiple connections was detected
That is the exact failure seen in the previous deployment. The code serializes Telegram calls inside one process, but no application code can make the same MTProto session safe across multiple independent serverless instances.
If the frontend is kept on Vercel, point it at this one persistent backend. If you deploy this folder itself, use a persistent Node host rather than Vercel Functions.
Required environment variables
APP_PASSWORD — website login password.
DELETE_PASSWORD — password required for permanent delete.
SESSION_SECRET — long random secret for the website session cookie.
TELEGRAM_API_ID — Telegram API ID.
TELEGRAM_API_HASH — Telegram API hash.
TELEGRAM_SESSION — Telegram user-account StringSession.
TELEGRAM_STORAGE_CHAT — storage destination, for example me or a chat/channel identifier.
STORAGE_LIMIT_BYTES — optional website meter; defaults to 10 GiB.
MAX_FILE_SIZE — optional; defaults to 50 GiB.
PORT — supplied by the host; defaults to 3000.
CHUNK_SIZE is deliberately not configurable here: browser and server both use exactly 4 MiB.
Install
npm install
npm start
Health:
GET /api/health
Website:
GET /
Create the Telegram session once
On a trusted local machine:
npm run telegram:session
Enter the Telegram login code and 2FA password if enabled. Put the printed TELEGRAM_SESSION value only in the persistent backend's environment.
Never put Telegram credentials or the session string in public/index.html.
Storage design
Browser uploads 4 MiB binary chunks.
The backend sends each chunk to the configured Telegram chat as a document.
File metadata and rename/hide/delete operations are stored as small Telegram control messages.
The file index is rebuilt from Telegram history, so restarting the backend does not erase the cloud listing.
Existing ordinary Telegram media in the configured storage chat is also detected as legacy files.
Website operations: search, open/preview, download, rename, hide/unhide, share link, delete.
Images, video, audio and PDF files can be opened in the website viewer when the browser supports the format.
Important recovery step for the current AUTH_KEY_DUPLICATED error
Stop/delete every old backend deployment that uses the same TELEGRAM_SESSION.
Do not leave an old Vercel preview/production function using that session.
Start this backend as exactly one persistent process.
If Telegram has already invalidated the session, create a fresh session with npm run telegram:session and replace TELEGRAM_SESSION on the one persistent backend.
Keep the same TELEGRAM_STORAGE_CHAT so the website can scan the existing Telegram data.
The website cannot display Telegram data until the backend can successfully return GET /api/health with telegram: true.
Security
Do not share:
TELEGRAM_SESSION
TELEGRAM_API_HASH
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
