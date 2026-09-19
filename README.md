My Personal Cloud — Telegram Storage Edition 8.0.0
This build keeps the existing My Personal Cloud / Cloud-Zen website UI and uses Telegram MTProto user-session storage as the physical storage backend.
Storage
Every uploaded file is split in the browser into fixed 4 MiB chunks and sent to the authenticated server. Each chunk is stored as a Telegram document message with a CZ1|CHUNK|... metadata caption. The website reconstructs the logical file from those Telegram messages.
Supported by the application:
Images and photos
Videos, including 4K video files
Audio and recordings
Documents
ZIP/RAR/7z and other general files
KB / MB / GB sized files
Up to 1 TB per file in this application build
Open/preview where the existing UI supports the MIME type
Download with range support
Rename by editing Telegram metadata captions
Delete with the existing delete-password flow; the real Telegram messages are deleted
No automatic deletion of completed files
Vercel environment variables
Set these in the Vercel Project → Settings → Environment Variables:
APP_PASSWORD=your-existing-login-password
DELETE_PASSWORD=your-existing-delete-password
SESSION_SECRET=your-long-random-session-secret
TELEGRAM_API_ID=your-telegram-api-id
TELEGRAM_API_HASH=your-telegram-api-hash
TELEGRAM_SESSION=your-existing-telegram-string-session
TELEGRAM_STORAGE_CHAT=me
NODE_ENV=production
TELEGRAM_SESSION is a secret. Do not put it in public/index.html or commit it to GitHub.
Telegram storage chat
The default is me, meaning the authenticated Telegram account's Saved Messages. You can set TELEGRAM_STORAGE_CHAT to the target chat/channel entity you intentionally use for storage.
Large uploads
The browser uses 4 MiB requests so the file itself does not have to be sent as one large Vercel request. Telegram MTProto handles the internal Telegram upload protocol for each chunk. The website uploads chunks sequentially to avoid deliberately creating concurrent connections with the same Telegram user session.
The application limit is 1 TB per file. A 1 TB file is represented by many Telegram chunk messages; upload time depends on the phone/network and Telegram connection speed.
Session creator
telegram-session.js is only for creating a StringSession locally. Run it on a trusted computer with:
TELEGRAM_API_ID=... TELEGRAM_API_HASH=... node telegram-session.js
Then save the printed session string as the Vercel TELEGRAM_SESSION environment variable.
Vercel deployment
The ZIP includes vercel.json and api/index.js. Vercel runs the Express application as a Node function, while public/index.html remains the website UI.
After adding/updating environment variables, redeploy the project.
Important Telegram API distinction
This build uses a Telegram MTProto user session, not the ordinary Telegram Bot API upload method. The Bot API has much smaller direct-upload limits; MTProto is used here because the project needs large-file storage.
