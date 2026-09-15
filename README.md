My Personal Cloud / Cloud-Zen — Vercel Final 7.0.0
This build keeps the original index.html UI and its existing file-management API contract, while replacing the Telegram MTProto file-storage path with Vercel Blob Private Storage.
Project files
public/index.html — original mobile-first UI, tabs, search, sort, viewer, QR, upload queue, drag/drop, file list and existing controls.
server.js — Express backend with the original authentication/file routes and Vercel Blob storage implementation.
package.json
telegram-session.js — retained for compatibility with the original project layout; it is NOT used as the production storage backend.
Vercel setup — required once
Open the Vercel project.
Open Storage.
Select Create Database → Blob.
Choose Private.
Connect the Blob store to this project.
Enable the Production environment.
Redeploy the project.
Vercel's Blob client-upload flow sends large files directly from the browser to Blob, avoiding the 4.5 MB Vercel Function request-body limit. Multipart uploads are enabled in the browser code.
Required environment variables
APP_PASSWORD=your-login-password
DELETE_PASSWORD=your-delete-password
SESSION_SECRET=long-random-secret
BLOB_READ_WRITE_TOKEN is normally added by Vercel when the Blob store is connected. New Vercel projects can also use Vercel's OIDC-based Blob authentication.
Storage behavior
Completed files are stored in Vercel Blob Private Storage.
The application has no automatic age-based deletion.
Completed files are deleted only through the explicit Delete route.
Telegram MTProto is not used for production storage, so the old shared-session AUTH_KEY_DUPLICATED architecture is removed from the active storage path.
Maximum file size defaults to 1 TB and can be changed with MAX_FILE_SIZE.
Important
If the Vercel Blob store is not connected, uploads cannot work because there is no storage credential available to the backend. The website now reports that condition clearly instead of failing with req.arrayBuffer() or a generic upload error.
