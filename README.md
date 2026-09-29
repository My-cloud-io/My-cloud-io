My Personal Cloud — Telegram Backend
This bundle keeps the existing dashboard UI and adds a Telegram MTProto storage backend.
Architecture
Browser uploads are split into 4 MiB chunks so they stay below Vercel's documented 4.5 MiB function payload limit.
Every chunk is uploaded as a Telegram document into TELEGRAM_STORAGE_CHAT using the TELEGRAM_SESSION user session.
A small Telegram manifest message records the file name, MIME type, size, and ordered Telegram message IDs.
The website lists files from Telegram, opens media through /api/stream/..., and downloads through /api/download/....
Range requests are supported for video/audio seeking when the browser asks for them.
Delete removes the manifest and all Telegram chunk messages.
The website password is handled by a signed HTTP-only cookie using SESSION_SECRET.
Vercel
Set the variables in .env.example in Vercel. Do not put the Telegram session string in the HTML or in client-side JavaScript.
The included vercel.json routes the existing page and /api/* endpoints to the Express app.
Telegram session
TELEGRAM_SESSION must be a valid GramJS StringSession for the Telegram account that owns/can write to the storage chat. The backend does not create a session from a phone number at runtime.
TELEGRAM_STORAGE_CHAT can be me, a username such as @mychannel, or a Telegram peer ID that the session can resolve.
Important limits
Vercel documents a 4.5 MiB function request payload limit, so the client chunk size is intentionally 4 MiB. Telegram's standard account file limit is 2 GB per file; Premium accounts can upload up to 4 GB per document. The backend's MAX_CHUNKS should be high enough for the intended maximum file size (the bundle defaults to 1024 chunks).
Local run
npm install
cp .env.example .env
npm start
Open http://localhost:3000.
