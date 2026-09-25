My Personal Cloud — Telegram Storage Final
This version keeps the existing mobile UI and uses Telegram MTProto as the durable storage backend.
Important deployment rule
Run server.js as one persistent Node.js backend process (for example Render). Do not run the MTProto storage process as Vercel Serverless Functions. Telegram can invalidate an authorization session when the same main MTProto authorization is used concurrently from multiple connections. This is the cause of the Concurrent usage of the current session ... InvokeWithLayer error.
Required environment variables
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT
CHUNK_SIZE (recommended: 4194304)
NODE_ENV=production
TELEGRAM_STORAGE_CHAT=me uses the logged-in Telegram account's Saved Messages. A private storage channel/chat can also be used when the logged-in account has access to it.
Fresh Telegram session
The session shown in the previous error has been invalidated by Telegram. Generate a new session with:
npm install
npm run telegram:session
Save the printed value as TELEGRAM_SESSION in the backend environment. Do not reuse the invalidated session.
The backend serializes Telegram operations so upload, index rebuild, rename, delete, preview and download do not open competing main-session requests.
