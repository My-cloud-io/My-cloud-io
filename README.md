My Personal Cloud / Cloud-Zen — Vercel Final 7.2.0
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
Uploads use a short-lived, authenticated, pathname-scoped Vercel Blob signed PUT URL. The browser sends the file bytes directly to Blob, so the file never passes through the Vercel Function and the 4.5 MB Function request-body limit is avoided. The UI shows upload progress and retries transient PUT failures.
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
The file index reads both the current my-personal-cloud/files/ prefix and the legacy my-cloud-io/files/ prefix, so older files already stored in this same Blob store are not hidden by the new pathname.
Important
If the Vercel Blob store is not connected, uploads cannot work because there is no storage credential available to the backend. The website now reports that condition clearly instead of failing with req.arrayBuffer() or a generic upload error.
7.2.0 focused changes
Removed the visible connected-cloud/provider accordion (Show Clouds / Hide Clouds) and provider cards from the UI.
Added a real Rename action that uses the Vercel Blob backend copy/delete flow.
Delete now asks for DELETE_PASSWORD and permanently deletes the selected Blob object from storage.
No automatic deletion of completed files was added.
