Cloud-Zen v4.0.5
Telegram-backed private cloud deployment for Vercel.
v4.0.5 upload durability fixes
Telegram is the durable source of truth for uploaded chunks.
Upload completion is explicitly committed by /api/upload/complete, so Vercel serverless-instance memory is not used as the final upload state.
/api/files?refresh=1 forces a fresh Telegram index after uploads.
The frontend keeps the existing file list visible while a refresh is in progress instead of replacing it with an empty loading state.
Chunk uploads retry up to six times on transient network/server errors.
Existing Telegram data is not removed by reloads, cold starts, or deployments.
Delete is the explicit operation that removes stored Telegram chunks.
Share tokens contain the stable file ID and support media/PDF previews.
/api/files/rename is provided for the mobile frontend.
Environment
Use the existing Vercel environment variables: APP_PASSWORD, DELETE_PASSWORD, SESSION_SECRET, TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION, TELEGRAM_STORAGE_CHAT, TELEGRAM_WORKERS, NODE_ENV.
