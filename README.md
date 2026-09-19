Cloud-Zen 3.5.0 — Telegram-backed private cloud
Final upgraded build. Fixes the upload bug from the previous version and adds free instant notifications, plus the Render deployment files needed to make this actually reliable in production.
Why it broke on Vercel (from your screenshot)
The error you saw — "Concurrent usage of the current session from multiple connections was detected, the current session was invalidated by the server for security reasons!" — happens because Vercel runs this app as serverless functions that can spin up more than one instance at the same time. Each instance tried to open the same Telegram session (TELEGRAM_SESSION) at once. Telegram's own security rules do not allow the same user session to be active from two connections simultaneously, so Telegram itself kills the session. Once that happens, every API call fails until you generate a brand new session string.
This is not something the app's code can fix while staying on Vercel's serverless model — it's a fundamental mismatch between "one persistent login" (what Telegram requires) and "many parallel short-lived functions" (how Vercel runs Node apps by default). This build is set up for Render instead, which runs your code as one single, always-on process — exactly what a Telegram MTProto session needs. Same code, same GitHub repo, just a different host.
(If you specifically want to stay on Vercel, that requires an external distributed lock — e.g. Upstash Redis — so only one instance ever holds the Telegram connection at a time. It's a real option but is more complex and adds latency. Ask if you want that version instead.)
Deploy on Render — step by step
Push this code to your GitHub repo (same one you already have connected is fine — replace the old files with these).
Go to render.com → New → Blueprint → connect your GitHub repo. Render will read render.yaml in this zip automatically and set most things up for you.
No Blueprint option, or prefer doing it manually? New → Web Service → connect your repo → Runtime: Node → Build Command: npm install → Start Command: node server.js.
When asked, fill in these Environment Variables (same values you already used on Vercel — copy them over):
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT = me
NODE_ENV = production
Important: make sure this TELEGRAM_SESSION is not still running anywhere else (old Vercel deployment, your own laptop, etc.) at the same time — that's what causes the crash you saw. If in doubt, generate a fresh session with telegram-session.js (run it on your own computer, never on the host) and use the new string here.
Deploy. First boot can take ~30–60 seconds (Render free tier spins down after inactivity and wakes back up on the next visit).
Open the Render URL, log in with APP_PASSWORD, and you should see your real files.
What's new in this build (3.5.0)
Free instant notifications: every upload, download, delete, and rename now sends you a Telegram message (to your own Saved Messages) the moment it happens — a free "SMS-like" alert that needs no extra signup, since you already have Telegram configured. Turn it off by setting NOTIFY_ON_EVENTS=false.
Optional real SMS: if you set all four of TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_TO_NUMBER (from a Twilio account — this costs a small amount per text and needs its own signup), you'll also get real phone SMS for the same events. Leave these unset to just use the free Telegram alerts.
render.yaml included so Render's Blueprint deploy can set almost everything up automatically.
Everything from 3.4.0 is included: the chunk-size fix that made uploads actually work, parallel chunk uploads for speed, live upload percentage and speed per file, automatic retry on Telegram rate-limits, multi-select bulk download/delete, and a storage-used display with no fake quota.
Already working (carried over, unchanged)
Open a file inside the site: images and PDFs preview in the built-in viewer; videos/audio play inline; everything else offers Open/Download.
Rename, Download, Delete (password-protected), Share (secure link) — three-dot menu on every file, or tap the file to open it directly.
Real upload percentage per file, updated live as it uploads.
Storage-used counter, search, sort, grid/list view, drag-and-drop, starred files, recent files, QR share.
Environment variables — full list
Required: APP_PASSWORD, DELETE_PASSWORD, SESSION_SECRET, TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION, TELEGRAM_STORAGE_CHAT (recommend me), NODE_ENV=production.
Optional:
CHUNK_SIZE — bytes per upload chunk. Default 20 MiB (4–256 MiB range).
UPLOAD_CONCURRENCY — parallel chunks per file. Default 4 (max 8).
TELEGRAM_WORKERS — Telegram internal upload workers. Default 8 (max 16).
MAX_FILE_SIZE — safety ceiling in bytes. Default 20 TiB.
TELEGRAM_NOTIFY_CHAT — where Telegram alerts go. Default: same as TELEGRAM_STORAGE_CHAT.
NOTIFY_ON_EVENTS — set to false to turn off all notifications.
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_TO_NUMBER — optional, enables real SMS via Twilio.
Real, honest limits (please read this)
Files are split into chunks and stored across many Telegram messages, so there's no hard cap from Telegram's ~2 GB (4 GB Premium) single-message limit — GB/TB-scale files work in principle.
Actual upload speed is bounded by your internet connection and Telegram's servers — no app can exceed your real network speed. This build removes the artificial bottlenecks (broken chunk size, fully serial uploads) and uploads chunks in parallel for real gains on a fast connection.
If Telegram rate-limits requests (FLOOD_WAIT), the server waits the exact time Telegram asks for and retries automatically.
Closing the browser tab mid-upload stops the transfer — no web app can keep sending bytes the browser has stopped sending.
Telegram session note
Never run the same TELEGRAM_SESSION in two places at once (two deployments, a deployment plus your laptop, etc.) — Telegram will invalidate it, exactly like your screenshot showed. If that happens, generate a fresh session with telegram-session.js (run locally, never on the host) and update the host's environment variable. Never paste your session string into chat, source code, or version control.
Files
public/index.html — frontend UI
server.js — Express + Telegram MTProto backend
package.json
render.yaml — Render Blueprint config
telegram-session.js — run locally to generate TELEGRAM_SESSION
