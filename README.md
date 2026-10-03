Cloud-Zen — Final Upload Persistence Fix
This build keeps the existing Cloud-Zen Telegram storage architecture and UI. It only fixes the upload/file-list persistence issue.
Changed
Completed uploads remain stored in Telegram.
The file list cache is invalidated after every successfully stored chunk.
After the final chunk, /api/files rebuilds from Telegram instead of returning a stale in-memory list.
This is safe for Vercel because upload chunks can land on different function instances.
No automatic deletion of completed files was added.
Files are deleted only through the existing explicit Delete action.
Existing stream, download, rename, share and authentication behavior is otherwise unchanged.
Storage
Telegram remains the private storage backend and is not presented as a visible cloud/provider in the UI.
Keep the existing Vercel environment variables and Telegram session unchanged.
