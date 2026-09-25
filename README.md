My Personal Cloud — Telegram Storage
This is the compact production project layout:
public/index.html
server.js
package.json
telegram-session.js
README.md
Storage
All uploaded file data is sent to the configured Telegram storage chat through the Telegram MTProto user session. The web UI does not need the Telegram app.
Uploads are sent as 4 MiB chunks. Telegram is the durable source of truth; the Vercel function's temporary filesystem is used only while a chunk is being transferred.
Required Vercel Environment Variables
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT (default: me)
TELEGRAM_WORKERS (optional)
NODE_ENV=production
Telegram session
Run locally:
npm install
Then:
npm run telegram:session
Copy the generated TELEGRAM_SESSION into the Vercel environment variables. Never commit the session string to GitHub.
Deployment
Vercel currently supports Express deployments with zero configuration. The server exports the Express app when VERCEL is present and uses app.listen() only for ordinary local/Node hosting.
The browser uploads sequential 4 MiB chunks to /api/upload-chunk; each chunk is immediately stored in Telegram. The file index is rebuilt from Telegram history, so the storage data is not dependent on Vercel's temporary filesystem.
Important
A real Telegram session and API credentials are intentionally not included in this ZIP. They must be supplied as private Vercel environment variables.
