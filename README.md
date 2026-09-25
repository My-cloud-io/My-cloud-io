My Personal Cloud — Telegram Persistent Final
This build keeps the existing five-file project structure and uses Telegram MTProto as the durable file store.
Required deployment model
Run server.js as exactly ONE persistent Node.js service instance. Do not run the Telegram MTProto backend as Vercel serverless functions. Vercel can remain your frontend only; the Telegram backend must run on a persistent Node host.
The reason is Telegram's AUTH_KEY_DUPLICATED rule: when the same authorization key is used by too many parallel main sessions/connections, Telegram invalidates the authorization key. A persistent single backend process avoids the multiple-serverless-instance problem.
Environment variables
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT (default: me)
CHUNK_SIZE (default: 64 MiB; the browser build currently uploads 100 MiB chunks, so set this to at least 100 MiB or change the browser constant to match)
MAX_FILE_SIZE
NODE_ENV=production
Important session rule
The TELEGRAM_SESSION must be generated once for this backend and must not be copied into another running backend, local development server, or second Render/Railway instance. If Telegram has already returned AUTH_KEY_DUPLICATED, that session has been invalidated and a new session must be generated before testing again.
Run
npm install
npm start
For a new session, set TELEGRAM_API_ID and TELEGRAM_API_HASH locally and run:
npm run telegram:session
Copy the printed session string into the persistent host's TELEGRAM_SESSION secret.
Storage behavior
Uploaded chunks are sent to the configured Telegram storage chat with a CZ1|CHUNK|... caption. The file index is rebuilt from those Telegram messages, so the persistent file data does not depend on the host's local filesystem.
