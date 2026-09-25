Cloud-Zen Telegram Backend — Vercel-safe revision
This revision fixes two concrete problems in the previous build:
Browser uploads are now 4 MiB chunks, compatible with Vercel's function payload limit.
Telegram MTProto clients use autoReconnect: false and are disconnected after each HTTP response, reducing the chance of the same StringSession being held by multiple warm Vercel instances.
IMPORTANT: AUTH_KEY_DUPLICATED can invalidate the existing Telegram authorization key. If that error has already happened, generate a fresh TELEGRAM_SESSION and put that new value in Vercel. Do not run another copy of this same session elsewhere.
Environment variables: APP_PASSWORD DELETE_PASSWORD SESSION_SECRET TELEGRAM_API_ID TELEGRAM_API_HASH TELEGRAM_SESSION TELEGRAM_STORAGE_CHAT TELEGRAM_WORKERS NODE_ENV
CHUNK_SIZE is no longer used for the browser request size; the frontend is fixed at 4 MiB for Vercel compatibility.
The storage backend remains Telegram-only.
