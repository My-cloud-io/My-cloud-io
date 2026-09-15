My Personal Cloud — Final 7.4.0
Final Vercel deployment package.
Changes in this build are intentionally limited to:
Welcome screen is enforced to transition away after 2 seconds.
Cloud provider cards/options (Backblaze B2, MEGA, IDrive E2, Cloudinary, Filebase, Koofr) are hidden from the UI.
Real Vercel Blob rename is enabled through PATCH /api/files.
Real permanent delete is enabled through DELETE /api/files with DELETE_PASSWORD.
Completed files are never automatically deleted by this application.
Storage remains Vercel Blob Private Storage. The production server does not use Telegram for storage.
Required environment variables:
APP_PASSWORD
DELETE_PASSWORD
SESSION_SECRET
Connect a Private Vercel Blob store to the Vercel project before uploading.
