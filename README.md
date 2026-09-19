My Personal Cloud / Cloud-Zen — Vercel Blob 7.3.0
This package keeps the existing My Personal Cloud UI and routes. The requested changes are limited to the upload path and file rename controls.
Large-file upload
Browser uploads go directly to the connected private Vercel Blob store; the file bytes do not pass through a Vercel Function.
The upload uses Vercel Blob's presigned browser-upload flow instead of the failing private client-token flow.
multipart: true is used for large files, so the Vercel Blob client can split large files into parts, retry failed parts and upload parts in parallel.
Upload progress remains visible in the existing queue UI.
Failed uploads are retried up to 3 times.
The application limit remains 1 TB per file.
Vercel Blob supports files up to 5 TB with its large-file/multipart capabilities; this application intentionally keeps its existing 1 TB per-file limit.
Rename / Hide
Rename is a real editable rename dialog, not an Info-style action.
The dialog opens with the current filename selected so the name can be changed naturally and saved.
A Hide button sits beside Rename in the quick-action row and closes that action row.
Rename uses the exact Blob pathname of the selected card, so duplicate visible filenames are handled correctly.
Starred and Recent references are updated when a file is renamed.
Delete
Delete first asks for confirmation.
It then asks for the configured DELETE_PASSWORD before sending the DELETE request.
The exact Blob pathname from the selected card is used, so duplicate filenames do not delete the wrong object.
The server deletes the real private Vercel Blob object. Completed files are not automatically deleted.
Vercel setup
Connect a Private Vercel Blob store to this Vercel project.
Make sure the Blob store is enabled for the Production environment.
Keep the existing APP_PASSWORD, DELETE_PASSWORD and SESSION_SECRET environment variables configured.
Deploy the project and refresh the deployed site before testing an upload.
Important The source package has been syntax-checked and the ZIP has been rebuilt here. A real multi-GB upload cannot be performed from this build environment, so live upload success still depends on the connected Vercel Blob store and the user's network/browser.
