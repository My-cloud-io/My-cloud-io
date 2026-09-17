My-cloud-io — Minimal Vercel Final
Exactly the requested project files are used:
public/index.html
server.js
package.json
telegram-session.js
README.md
The app uses Vercel Blob Private Storage as the real durable storage backend. telegram-session.js is retained only for the requested project structure and is not used for file storage. This avoids the AUTH_KEY_DUPLICATED problem caused by sharing one Telegram MTProto session across concurrent Vercel instances.
Vercel setup
Import this project into Vercel.
In Storage, create a Private Blob store and connect it to this project. Vercel supplies BLOB_READ_WRITE_TOKEN (or OIDC-backed Blob authentication for supported connected stores).
Add these Environment Variables:
APP_PASSWORD=your-login-password
DELETE_PASSWORD=your-delete-password
SESSION_SECRET=use-a-long-random-secret
NODE_ENV=production
MAX_FILE_SIZE=1099511627776
Deploy.
Open the live URL and use the APP_PASSWORD.
Real features
Upload
Download
Video/image/audio streaming
Delete with DELETE_PASSWORD
Rename
File listing
Folder/relative-path preservation from folder selection
Download All
Share link endpoint
Durable completed files
No automatic deletion of completed files
Uploads are sent as 4 MiB requests to stay below Vercel Function request-body limits. Each chunk is immediately stored in Blob. A completed file is considered complete only after all chunks exist and the recorded size matches.
Important
Vercel deployment can remain available continuously, but no hosting platform can guarantee zero downtime. Also, Vercel Function execution limits still apply to individual requests. Vercel Blob is the durable storage layer, so files do not depend on the ephemeral server filesystem.
