Cloud-Zen — Vercel frontend + one persistent Telegram backend
Architecture
Vercel: only the website and /api/* same-origin proxy.
Persistent Node service (Render or another always-on Node host): Telegram MTProto session and storage.
The same TELEGRAM_SESSION must NEVER run in multiple backend instances. Doing so can cause AUTH_KEY_DUPLICATED.
Backend
Deploy /backend as a Node service with npm start. Required environment variables:
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT (for example me)
NODE_ENV=production
Do not put Telegram secrets in the frontend.
Vercel
Deploy the repository root. Add this environment variable:
TELEGRAM_BACKEND_URL = the HTTPS URL of the single persistent backend service.
Do NOT point TELEGRAM_BACKEND_URL at the Vercel frontend itself.
Why this fixes the current problem
The persistent backend's / intentionally returns a JSON health-style response. It is not the website UI. The Vercel deployment must serve public/index.html and proxy /api/* to the persistent backend.
The frontend upload code also does not manually send the forbidden Content-Length browser header.
