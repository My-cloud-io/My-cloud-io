Cloud-Zen — Telegram-only Personal Cloud
This build keeps the My Personal Cloud mobile UI and uses Telegram MTProto as the storage backend. There is no Backblaze B2, MEGA, IDrive E2, Cloudinary, Filebase, Koofr, or Vercel Blob storage path.
What works
Password-protected website
Upload files from the website to Telegram
Chunked uploads so Vercel request limits are respected
File list read back from Telegram
Open images, videos, audio, and PDFs from the website
Download files from the website
Rename files (Telegram message metadata is updated)
Hide/unhide files without deleting Telegram data
Delete files from Telegram
Hidden-files tab
Authentication works across Vercel serverless instances using a signed session token
Important Vercel design
Vercel documents a 4.5 MB request/response payload limit for Functions. This project therefore uses a 4 MiB upload chunk. Downloads and previews are also retrieved one Telegram chunk at a time; the browser assembles the file locally. This avoids returning a multi-gigabyte response through a single Vercel Function response.
Vercel environment variables
Set these in the Vercel project (Production; add Preview too if you test Preview deployments):
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
NODE_ENV=production
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT
CHUNK_SIZE=4194304
MAX_FILE_SIZE=4294967296
STORAGE_DISPLAY_BYTES=10737418240
TELEGRAM_WORKERS=2
Never put your real Telegram session string in GitHub or this ZIP. Put it only in Vercel Environment Variables.
Deploy
Put all files from this folder in the root of the Vercel/Git repository.
Keep index.html, server.js, package.json, vercel.json, .env.example, and README.md at the same level.
Add the environment variables above.
Deploy with Node 24.x.
Open /api/health after deployment. A successful response confirms the Telegram session is authorized.
Open the main site, enter APP_PASSWORD, and test a small file before uploading a large video.
Telegram storage chat
TELEGRAM_STORAGE_CHAT is the chat/channel/entity where the logged-in Telegram account has permission to send, edit, search, and delete the storage messages. The backend stores each upload chunk as a Telegram document message with Cloud-Zen metadata in its caption.
Notes
The website does not need the Telegram app open. The server uses the saved MTProto session from TELEGRAM_SESSION.
