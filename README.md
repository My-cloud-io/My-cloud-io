My Personal Cloud / Cloud-Zen — Final Upgraded Build
Requested-only upgrade:
Real Rename action for files, audio, video, documents, images, recordings and other uploaded files.
Rename uses the existing authenticated Vercel Blob backend copy/delete flow.
Delete requires the separate DELETE_PASSWORD before a file is permanently deleted.
Completed files are never automatically deleted by this application.
Large uploads use Vercel Blob client multipart uploads with retries and progress reporting.
Default application file-size ceiling is 5 TB, matching Vercel Blob's documented maximum for multipart uploads.
The visible connected-cloud/provider section (including MEGA, IDrive E2, Backblaze, Cloudinary, Filebase, Koofr and Show/Hide Clouds) has been removed from the page.
Existing welcome/login/dashboard/file-management UI is otherwise preserved.
Required Vercel environment variables: APP_PASSWORD=your-login-password DELETE_PASSWORD=your-delete-password SESSION_SECRET=long-random-secret BLOB_READ_WRITE_TOKEN=provided by the connected Vercel Blob store when applicable
Vercel Blob:
Create/connect a PRIVATE Blob store to this project.
Enable Production for the store.
Redeploy after connecting storage.
The frontend uses @vercel/blob/client through a browser module import and calls /api/blob-upload for the authenticated client-token exchange. The file bytes go directly from the browser to Vercel Blob.
