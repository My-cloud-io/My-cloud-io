Cloud-Zen — Persistent Telegram Storage Final
Important architecture
Run this Node.js app as ONE persistent backend instance. Do NOT run the same TELEGRAM_SESSION in Vercel Functions or in multiple backend instances. Telegram can invalidate the shared MTProto authorization key when two processes connect at the same time (AUTH_KEY_DUPLICATED).
This package includes the existing mobile Cloud-Zen UI and a persistent Telegram backend in one app.
Features
Telegram is the durable storage backend.
Files stay in Telegram until you explicitly delete them.
Uploads use 4 MiB chunks with browser progress and retry logic.
Images, video, audio and PDF can be opened inside the website.
Download works from the website.
Rename updates the Cloud-Zen canonical name; the uploaded Telegram document is also created with the original filename.
Delete requires DELETE_PASSWORD and removes the stored Telegram chunks.
Share creates a direct Cloud-Zen public link. The share page displays the file inline for images/video/audio/PDF and has a download button for other types.
File metadata is reconstructed from Telegram, so Vercel/host restarts do not erase the index.
A short index cache reduces repeated Telegram history scans and dashboard lag.
Required environment variables
APP_PASSWORD DELETE_PASSWORD SESSION_SECRET TELEGRAM_API_ID TELEGRAM_API_HASH TELEGRAM_SESSION TELEGRAM_STORAGE_CHAT (for example me) NODE_ENV=production PORT (provided by the host when required)
Start
npm install
npm start
Critical deployment rule
Do not deploy server.js to Vercel Functions with the Telegram session. Vercel is a serverless platform and may run multiple instances; that is the cause of the AuthKeyDuplicatedError seen in the Cloud-Zen logs. Use one persistent Node service for this package. If you keep my-cloud-io.vercel.app, use it only as a frontend/proxy and point it to this single persistent backend; never copy the Telegram session into another Vercel deployment.
Never commit .env or Telegram credentials to GitHub.
