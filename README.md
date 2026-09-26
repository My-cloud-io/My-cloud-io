Cloud-Zen — Telegram-only Vercel build
This build keeps the recovered public/index.html UI and replaces the old multi-provider storage backend with Telegram MTProto only.
Removed from the storage backend
Backblaze B2
MEGA
IDrive E2
Cloudinary
Filebase
Koofr
S3/WebDAV storage clients
Telegram storage model
The website sends small upload chunks to the backend. Each chunk is stored as a Telegram document message in TELEGRAM_STORAGE_CHAT. The message caption contains the Cloud-Zen file/chunk metadata. The website reconstructs the original file for listing, preview/streaming, download, rename and delete.
No Telegram app interaction is required for normal website use after the session is configured.
Vercel environment variables
Use the variables in .env.example:
APP_PASSWORD, DELETE_PASSWORD, SESSION_SECRET, NODE_ENV, TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION, TELEGRAM_STORAGE_CHAT, CHUNK_SIZE, TELEGRAM_WORKERS, MAX_FILE_SIZE.
Do not paste secret values into source files or commit them to GitHub.
Important Vercel upload detail
The frontend must send chunks small enough for a Vercel Function request. The included UI is adjusted to use a 4 MiB chunk size instead of the old 100 MiB chunk size.
