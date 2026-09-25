Cloud-Zen — Telegram-only backend
This build keeps the supplied dashboard and connects its /api/* calls to a real Telegram MTProto user session.
Vercel
Deploy the folder as a Node.js project. Add the Telegram/auth environment variables from .env.example to Production.
The browser upload chunk is intentionally 4 MiB. Vercel documents a 4.5 MiB Function request payload limit, so the original 100 MiB browser chunk was not suitable for a Vercel Function.
Telegram
The backend uses GramJS with TELEGRAM_SESSION and sends files into TELEGRAM_STORAGE_CHAT. It uses Telegram's upload.saveBigFilePart flow with 512 KiB protocol parts, then creates one document message in the storage chat.
Telegram currently documents 4000 upload parts for non-Premium and 8000 for Premium, with 512 KiB as the maximum protocol part size. That is approximately 2 GiB and 4 GiB respectively.
Important
This backend does not use B2, MEGA, IDrive, Cloudinary, Filebase or Koofr. The dashboard's provider display is changed to Telegram Storage only.
DELETE_PASSWORD, if configured, is enforced on DELETE through x-delete-password. The supplied dashboard already authenticates the private session; if you want a second delete prompt in the UI, add that header from the client.
Local
npm install npm start
Telegram session
Do not paste the session string into the frontend or commit it to GitHub. Keep it only in Vercel Environment Variables.
