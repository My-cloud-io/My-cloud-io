Cloud-Zen — Telegram Persistent Backend v4
Why this version is different
The Vercel logs showed Telegram AUTH_KEY_DUPLICATED / AuthKeyDuplicatedError. Telegram documents that this error is emitted when an authorized MTProto session is used through parallel main connections and that the affected authorization key is invalidated. A Vercel Function deployment can have multiple instances, so putting the personal Telegram MTProto client directly inside the Vercel function is not a safe architecture for this session-based storage backend.
This bundle separates the two jobs:
Vercel keeps serving your existing Cloud website and only proxies /api/*.
One persistent Node backend owns the Telegram StringSession and keeps exactly one MTProto client process alive.
The website continues to use /api/files, /api/upload-chunk, /api/stream/:id, /api/download/:id, rename and delete without opening Telegram.
Files are stored in the Telegram storage chat. The website is a browser interface to that Telegram data; it does not create a second permanent file store on Vercel.
IMPORTANT: the old Telegram session is already invalid
The Vercel log contains AUTH_KEY_DUPLICATED. Telegram's official documentation says the affected authorization key is invalidated and a new authorization key must be generated. Therefore, do not keep retrying the old TELEGRAM_SESSION value.
Generate a new session once on your own computer/Termux:
npm install
npm run generate-session
Then put the printed value into TELEGRAM_SESSION on the persistent backend only.
The generator uses the same teleproto StringSession flow documented by the package. Never commit the generated session string to GitHub.
Deployment layout
Persistent backend
Deploy backend/server.js as a normal Node web service on an always-running/persistent Node host. Render/Railway/Fly/etc. can host it. The important requirement is one running process for the Telegram session, not a horizontally scaled set of identical processes.
Set these variables on that backend:
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION (NEW session)
TELEGRAM_STORAGE_CHAT
TELEGRAM_WORKERS=1
CHUNK_SIZE=4194304
MAX_CHUNKS=1024
STORAGE_QUOTA_GB=10
NODE_ENV=production
Vercel
Keep your existing public/index.html and deploy the api/index.js and vercel.json from this bundle alongside it.
On Vercel set only:
TELEGRAM_BACKEND_URL=https://YOUR-PERSISTENT-BACKEND-DOMAIN
Do NOT put TELEGRAM_SESSION in Vercel.
The existing frontend can keep calling relative /api/... URLs. The Vercel proxy forwards those requests to the persistent Telegram backend.
Existing data
After the new session is generated for the same Telegram account, the backend reads the existing manifests/chunks from TELEGRAM_STORAGE_CHAT. The website does not need to open the Telegram app.
If the previous storage chat was me, keep:
TELEGRAM_STORAGE_CHAT=me
If you used another chat/channel, use that same storage chat.
Gmail
Gmail is not required for Telegram storage/authentication. The backend deliberately does not store a Gmail password or use Gmail as a storage provider. If the website has an email/contact field, it can remain in the frontend separately.
File handling
Uploads are split into 4 MiB browser requests because Vercel's request payload limit is 4.5 MiB. Each chunk is uploaded to Telegram as a document and a Telegram message stores the file manifest. The website reads those records to list/open/download/delete/rename files.
The default manifest quota shown by the backend is 10 GiB (STORAGE_QUOTA_GB=10). This is a website accounting quota, not a claim that Telegram itself has exactly 10 GiB of total cloud capacity.
