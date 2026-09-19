Cloud-Zen 3.3.7 — Vercel + Telegram
Final upgraded build for the existing My Personal Cloud / Cloud-Zen deployment.
Included
public/index.html — upgraded mobile UI
server.js — Express + Telegram MTProto backend
package.json
telegram-session.js
Environment variables
Keep these in Vercel Environment Variables; never put Telegram secrets in public/index.html.
Required:
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
TELEGRAM_STORAGE_CHAT (recommended: me)
NODE_ENV=production
Optional:
TELEGRAM_WORKERS=4
CHUNK_SIZE is intentionally ignored by the app's Vercel-safe upload setting; browser/server use a fixed 4 MiB chunk.
MAX_CHUNKS is fixed in code.
Main upgrades
Vercel-safe 4 MiB upload chunks.
Real per-chunk upload progress using XHR.
Automatic upload retries.
File list and storage UI use local cache first, then refresh in the background so the dashboard does not appear frozen during a Telegram cold start.
Telegram index discovery uses server-side search for the app's CZ1 marker instead of scanning all Saved Messages history.
Short in-memory index TTL to avoid repeated Telegram history scans.
Browser-private caching for authenticated file streams to reduce repeated image/PDF downloads.
Three-dot file menu: Open, Share, Download, Rename, Delete.
Rename UI connected to the existing backend rename endpoint.
Share UI connected to the existing secure /api/share endpoint.
Delete UI now actually asks for DELETE_PASSWORD and sends it to the backend.
PDF opens inside the built-in viewer instead of forcing a download.
Existing image/video/audio preview remains supported.
Important
Telegram credentials/session are user-owned secrets. Do not commit them to GitHub or place them in the HTML.
Telegram session concurrency note
This Vercel-targeted build keeps Telegram-backed dashboard requests sequential on the browser side and limits the Telegram client's download concurrency. The same TELEGRAM_SESSION must not be used by another running deployment or local process at the same time. If Telegram has already returned AUTH_KEY_DUPLICATED, that session has been invalidated by Telegram and a fresh session string must be generated and placed in Vercel; do not paste the session string into chat or source code.
3.3.5 recovery / deployment rule
The storage index scans the complete Telegram storage chat again, so files from older Cloud-Zen versions are not hidden by a search: "CZ1" optimization.
Upload completion no longer depends on an in-memory activeUploads map surviving across Vercel function instances; Telegram is the durable source of truth and the next file-list refresh rebuilds the index.
Vercel Preview deployments are no longer blocked by the UI. Preview and Production use the same app behavior. Do not keep Preview and Production (or a local/Render process) running simultaneously with the same TELEGRAM_SESSION, because Telegram can invalidate a duplicated MTProto session.
Keep every other local/Render/preview process that uses the same TELEGRAM_SESSION stopped. A single MTProto StringSession cannot safely be shared by independent live processes.
No code can guarantee one MTProto connection across multiple Vercel serverless instances. For a hard single-connection guarantee, the Telegram backend must run as one persistent service/instance.
3.3.6 upload reliability
Telegram file mutations are serialized within a warm Vercel/Node instance.
After the final chunk, the browser updates its local file list from the upload response instead of immediately making another Telegram-backed list request.
vercel.json allows the Express function up to 60 seconds when the project is running with legacy duration settings. Fluid Compute projects may allow longer defaults.
The 4 MiB HTTP chunk remains below Vercel's documented 4.5 MB request-body limit.
The same TELEGRAM_SESSION must still be used by only one active deployment/process. A fresh session is required if Telegram has already invalidated the old one with AUTH_KEY_DUPLICATED.
3.3.7 preview fix
Removed the Preview-only blank screen that incorrectly told users to open Production.
Removed the server-side Preview deployment block.
The existing Cloud-Zen UI, file recovery, and upload flow are unchanged.
For reliable Telegram sessions, keep only one active deployment/process using the same TELEGRAM_SESSION while testing.
