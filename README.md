Cloud-Zen 4.0.2 — Telegram Private Cloud
This build keeps Telegram as the durable storage backend and the existing mobile-first UI.
Included
Telegram-backed multipart upload
Durable Telegram reconstruction after reload/redeploy
Open/preview images, videos, audio and PDF in the website
Download files
Durable share links
Rename and permanent delete
Storage usage + logical 10 GB display quota
File count
Vercel Express deployment configuration
Existing session helper
Required Vercel environment variables
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT (optional; defaults to me)
TELEGRAM_WORKERS (optional)
STORAGE_LIMIT_BYTES (optional; defaults to 10 GiB for the UI meter)
NODE_ENV=production
Do not put Telegram credentials in public files or the repository.
Cloud-Zen 4.0.2 fixes stateless share-token verification, adds POST /api/files/rename as a reliable rename endpoint, keeps PATCH as compatibility, and resolves shared links by durable file ID. Existing Telegram data is not deleted by deployment.
