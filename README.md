Cloud-Zen 4.0.3 FINAL
Private Telegram-backed cloud for Vercel.
What is fixed
Telegram remains the durable storage backend.
Uploads are stored as Telegram chunk messages with CZ1 metadata.
Reload/redeploy rebuilds the file index from Telegram.
Image/video/audio/PDF preview uses /api/stream with file IDs.
Large downloads use direct attachment streaming and HTTP Range support.
Rename has a mobile-friendly POST endpoint: /api/files/rename.
Share tokens are signed directly with HMAC-SHA256 and include the stable file ID.
Share pages show Cloud-Zen branding/version and immediately preview image/video/audio/PDF.
Shared download is direct from the secret share URL; no second password is required.
Explicit Delete permanently removes the selected file's Telegram chunks. Files are not removed by reload/redeploy.
Vercel environment variables
Keep the existing production values: APP_PASSWORD, DELETE_PASSWORD, SESSION_SECRET, TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION, TELEGRAM_STORAGE_CHAT, TELEGRAM_WORKERS, NODE_ENV.
Do not paste Telegram credentials into source code.
