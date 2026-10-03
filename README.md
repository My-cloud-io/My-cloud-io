Cloud-Zen 4.0.0 — Vercel + Telegram private storage
This build keeps Telegram as the real storage backend while hiding the storage provider from the website UI.
UI behavior
No Show Clouds / Hide Clouds / provider cards.
No Backblaze B2, MEGA, IDrive, Cloudinary, Filebase or Koofr labels.
Telegram is not shown as a storage provider in the UI.
Files remain stored in Telegram until the user explicitly deletes them.
Delete removes the stored Telegram chunk messages and the file disappears from the website index.
Rename re-uploads each Telegram document with the new filename, then removes the old Telegram messages.
Image/video/audio/PDF previews use a short-lived stream access token so native browser media requests do not fail with 401.
Uploads use fixed 4 MiB chunks, no manual Content-Length header, progress reporting and retries.
Vercel environment variables
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT=me
NODE_ENV=production
Do not put Telegram credentials in public/index.html.
Deploy
Replace server.js, public/index.html, and package.json in the existing Vercel project and redeploy.
