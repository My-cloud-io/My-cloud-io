Cloud-Zen — Vercel Frontend + Persistent Telegram Backend
Architecture
Vercel hosts ONLY the frontend. Telegram MTProto code runs ONLY in one persistent Node.js backend process.
Vercel frontend -> persistent backend -> ONE TelegramClient -> Telegram storage chat.
Do not run the Telegram backend as Vercel serverless functions and do not run more than one backend replica with the same TELEGRAM_SESSION.
1. Vercel frontend
Deploy the contents of vercel-frontend/ to your existing my-cloud-io Vercel project.
No Telegram credentials are required on Vercel.
2. Persistent Telegram backend
Deploy telegram-backend/ to a persistent Node.js host that supports a long-running process.
Install and run:
npm install
npm run check
npm start
Set all variables from .env.example.
3. Telegram session
The old session that produced AUTH_KEY_DUPLICATED should not be reused.
Create/use a fresh valid TELEGRAM_SESSION and put it ONLY on this persistent backend.
Do not put TELEGRAM_SESSION, TELEGRAM_API_ID, or TELEGRAM_API_HASH on Vercel.
4. Backend URL
The frontend must point its API requests to the public URL of this persistent backend. If the existing index.html has a hard-coded API base, update that base URL to the persistent backend URL.
5. Storage
Storage is Telegram-only. No B2, MEGA, IDrive E2, Cloudinary, Filebase, or Koofr storage is configured here.
Important
No real credentials are included in this ZIP.
