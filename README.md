Cloud-Zen v4.0.4
Private personal cloud UI with Telegram as the durable storage backend.
What this build fixes
1 KB, 2 KB, small files and large files use the same chunk uploader.
4 MiB chunks keep request sizes practical; the final chunk can be any size, including 1 byte.
Upload requests retry up to 6 attempts with exponential backoff.
Completion is rebuilt from Telegram on the final chunk so Vercel serverless instances do not have to share in-memory upload state.
Telegram remains the durable source of file data; Vercel local disk is temporary only.
Image/video/audio/PDF preview and download use the Telegram-backed file ID.
HTTP Range requests are supported for media playback and partial downloads.
Share links are Cloud-Zen branded and carry a stable file ID, so renaming a file does not invalidate an existing share link.
Shared media can be viewed directly from the share URL. Download uses the share token itself as the access secret.
Explicit Delete removes the Telegram chunks. Reload, redeploy, logout, or a Vercel cold start does not delete stored data.
Environment variables
APP_PASSWORD DELETE_PASSWORD SESSION_SECRET TELEGRAM_API_ID TELEGRAM_API_HASH TELEGRAM_SESSION TELEGRAM_STORAGE_CHAT NODE_ENV=production TELEGRAM_WORKERS (optional) MAX_FILE_SIZE (optional)
Do not put Telegram credentials in public/index.html.
