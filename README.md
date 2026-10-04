Cloud-Zen 4.0.6
Telegram-backed private cloud for Vercel.
Persistence behavior
Telegram is the durable storage source.
Upload chunks are stored in Telegram as CZ1 chunk records.
A transient Telegram index read can no longer blank a healthy existing file list.
After an upload is durably committed, the returned file is immediately inserted into the UI before background reconciliation.
Reloads/deploys do not delete Telegram data.
Files are removed from Telegram only by the explicit Delete operation.
Main features
Open/preview, download, share, rename, delete, file count and storage usage.
Required Vercel environment variables
APP_PASSWORD, DELETE_PASSWORD, SESSION_SECRET, TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION, TELEGRAM_STORAGE_CHAT, NODE_ENV.
Do not commit secrets to source control.
