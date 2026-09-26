Cloud-Zen authentication fix
The login loop was caused by storing authenticated sessions only in an in-memory Map. On Vercel, a request after login can execute on another serverless instance, where that Map is empty, so /api/auth/me returned authenticated: false and the UI showed the password screen again.
This build uses a signed, stateless session cookie based on SESSION_SECRET, so every Vercel function instance can verify the login without sharing memory.
Keep these environment variables configured in Vercel:
APP_PASSWORD
SESSION_SECRET
DELETE_PASSWORD
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT
TELEGRAM_WORKERS
CHUNK_SIZE
NODE_ENV=production
