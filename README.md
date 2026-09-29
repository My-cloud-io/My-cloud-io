Cloud-Zen Telegram Persistent Backend — v5
Backend-only upgrade for the existing Vercel Cloud-Zen / My Personal Cloud website.
What is fixed
APP_PASSWORD is compared exactly as entered; it is not trimmed.
Website login is independent from Telegram.
One persistent process owns one Telegram MTProto client/session.
Telegram calls are serialized to reduce connection races.
AUTH_KEY_DUPLICATED is reported clearly instead of repeatedly reconnecting.
Uploads remain Telegram-backed: 4 MiB chunks + manifest messages.
Existing files remain discoverable when the same Telegram account/storage chat is used with a newly generated session.
Existing UI endpoints are preserved: login, files, storage, upload, stream, download, rename, delete, health.
Required architecture
Vercel should remain the website + thin API proxy. This backend must run as ONE persistent server process. Do not deploy this MTProto process as a Vercel Function.
The existing Vercel proxy expects TELEGRAM_BACKEND_URL. Set that variable in the Vercel Production environment to the URL of this backend, then redeploy Vercel.
Backend variables
APP_PASSWORD DELETE_PASSWORD SESSION_SECRET OWNER_EMAIL (optional) TELEGRAM_API_ID TELEGRAM_API_HASH TELEGRAM_SESSION TELEGRAM_STORAGE_CHAT=me NODE_ENV=production PORT CHUNK_SIZE=4194304 MAX_CHUNKS=4096 TELEGRAM_WORKERS=1 STORAGE_QUOTA_GB=10
Current Telegram error recovery
The screenshot showed AUTH_KEY_DUPLICATED. Telegram invalidates an authorization key when the same MTProto session is connected by multiple backend instances. Code cannot revive an already-invalidated auth key.
Therefore:
Stop/remove every other backend that uses the old TELEGRAM_SESSION.
Generate a fresh session with node generate-session.js.
Put that NEW value only in this persistent backend.
Keep TELEGRAM_SESSION out of Vercel/public frontend/GitHub.
Point Vercel TELEGRAM_BACKEND_URL at this backend.
Restart the backend and redeploy the Vercel frontend.
The previous TELEGRAM_BACKEND_URL is not configured screenshot is a Vercel configuration issue, not an APP_PASSWORD mismatch.
Large-file behavior
The browser sends <=4 MiB requests, so KB/MB/GB-sized files are represented by many Telegram document messages. The effective per-file maximum is CHUNK_SIZE * MAX_CHUNKS. The UI can keep its existing upload system.
Important
This ZIP cannot honestly guarantee a production result without your real credentials and hosting being exercised. The code is syntax-checked locally, and the architecture specifically addresses the errors shown in your logs. The final Telegram connection must be tested after deployment.
