"use strict";

/*
  my-personal-cloud / My-cloud-io
  Vercel + Vercel Blob Private Storage

  IMPORTANT:
  - Completed files are stored in Vercel Blob and are NEVER auto-deleted.
  - A completed file is removed only by the user's explicit Delete action.
  - Uploads go directly from the browser to Vercel Blob using the official
    client-upload token flow, so large files do not pass through a Vercel
    Function request body.
  - Telegram/MTProto is intentionally not used for production storage. This
    prevents the AUTH_KEY_DUPLICATED problem caused by sharing one Telegram
    session between multiple serverless instances.
*/

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const archiver = require("archiver");
const {
  put,
  get,
  list,
  del,
  head,
  copy,
} = require("@vercel/blob");
const { handleUpload } = require("@vercel/blob/client");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const APP_PASSWORD = String(process.env.APP_PASSWORD || "").trim();
const DELETE_PASSWORD = String(process.env.DELETE_PASSWORD || "").trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || "").trim();
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 1024 * 1024 * 1024 * 1024);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 3;
const DEVICE_LOCK_MS = 24 * 60 * 60 * 1000;
const FILE_PREFIX = "my-cloud-io/files/";

const authFailures = new Map();
const deviceLocks = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

function jsonError(res, status, error) {
  return res.status(status).json({ error: String(error || "Request failed") });
}

function b64url(value) {
  return Buffer.from(String(value)).toString("base64url");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function signPayload(payload) {
  if (!SESSION_SECRET) throw new Error("SESSION_SECRET is not configured");
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyPayload(token) {
  if (!SESSION_SECRET || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || Number(payload.exp) <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function makeSession() {
  return signPayload({ type: "session", iat: Date.now(), exp: Date.now() + SESSION_TTL_MS });
}

function getCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function getSession(req) {
  const payload = verifyPayload(getCookie(req, "my_cloud_io_session"));
  return payload?.type === "session" ? payload : null;
}

function clientKey(req, area) {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  const ua = String(req.headers["user-agent"] || "unknown");
  return `${area}:${crypto.createHash("sha256").update(`${ip}|${ua}`).digest("hex")}`;
}

function locked(req, area) {
  const key = clientKey(req, area);
  const until = deviceLocks.get(key) || 0;
  if (until > Date.now()) return true;
  deviceLocks.delete(key);
  return false;
}

function failure(req, area) {
  const key = clientKey(req, area);
  const n = (authFailures.get(key) || 0) + 1;
  if (n >= MAX_LOGIN_FAILURES) {
    authFailures.delete(key);
    deviceLocks.set(key, Date.now() + DEVICE_LOCK_MS);
    return true;
  }
  authFailures.set(key, n);
  return false;
}

function clearFailures(req, area) {
  authFailures.delete(clientKey(req, area));
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return jsonError(res, 401, "Authentication required");
  req.cloudSession = session;
  next();
}

function requireDeletePassword(req, res, next) {
  if (locked(req, "delete")) return jsonError(res, 423, "Delete access is locked for 24 hours on this device.");
  const password = String(req.body?.deletePassword || "");
  if (!DELETE_PASSWORD || !safeEqual(password, DELETE_PASSWORD)) {
    const isLocked = failure(req, "delete");
    return jsonError(res, isLocked ? 423 : 403, isLocked ? "Delete access locked for 24 hours." : "Incorrect delete password.");
  }
  clearFailures(req, "delete");
  next();
}

function cleanName(value) {
  const base = path.basename(String(value || "file")).replace(/[\u0000]/g, "").trim();
  return (base || "file").slice(0, 240);
}

function cleanRelativePath(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  const parts = raw.split("/").filter(Boolean).map(part => part.replace(/[\u0000]/g, "").trim()).filter(Boolean);
  const cleaned = [];
  for (const part of parts) {
    if (part === "." || part === "..") continue;
    cleaned.push(part.slice(0, 180));
  }
  return cleaned.join("/").slice(0, 1200);
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = n;
  let i = -1;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}

function mimeFor(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  const map = {
    ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".png":"image/png", ".gif":"image/gif", ".webp":"image/webp", ".svg":"image/svg+xml",
    ".mp4":"video/mp4", ".webm":"video/webm", ".mov":"video/quicktime", ".mkv":"video/x-matroska", ".avi":"video/x-msvideo",
    ".mp3":"audio/mpeg", ".wav":"audio/wav", ".m4a":"audio/mp4", ".aac":"audio/aac", ".ogg":"audio/ogg", ".flac":"audio/flac",
    ".pdf":"application/pdf", ".txt":"text/plain", ".csv":"text/csv", ".json":"application/json", ".xml":"application/xml",
    ".zip":"application/zip", ".rar":"application/vnd.rar", ".7z":"application/x-7z-compressed", ".gz":"application/gzip",
    ".doc":"application/msword", ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls":"application/vnd.ms-excel", ".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt":"application/vnd.ms-powerpoint", ".pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  return map[ext] || "application/octet-stream";
}

function blobCredentialsPresent() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_BLOB_STORE_ID);
}

async function blobCheck() {
  try {
    await list({ prefix: FILE_PREFIX, limit: 1 });
    return { configured: true, ok: true };
  } catch (error) {
    return { configured: blobCredentialsPresent(), ok: false, error: error?.message || String(error) };
  }
}

function makePath(id, relativePath, name) {
  const safeRelative = cleanRelativePath(relativePath);
  const safeName = cleanName(name);
  return `${FILE_PREFIX}${id}/${safeRelative ? `${safeRelative}/` : ""}${encodeURIComponent(safeName)}`;
}

function parseFilePath(pathname) {
  const prefix = FILE_PREFIX;
  if (!String(pathname).startsWith(prefix)) return null;
  const rest = String(pathname).slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const id = rest.slice(0, slash);
  const encoded = rest.slice(slash + 1);
  const decodedParts = encoded.split("/").map(part => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const name = decodedParts[decodedParts.length - 1] || "file";
  const relativePath = decodedParts.slice(0, -1).join("/");
  return { id, name, relativePath };
}

async function listAllFiles() {
  const all = [];
  let cursor;
  do {
    const result = await list({ prefix: FILE_PREFIX, limit: 1000, cursor });
    for (const blob of result.blobs || []) {
      const parsed = parseFilePath(blob.pathname);
      if (!parsed) continue;
      all.push({
        id: parsed.id,
        name: parsed.name,
        relativePath: parsed.relativePath,
        pathname: blob.pathname,
        url: blob.url,
        downloadUrl: blob.downloadUrl,
        size: Number(blob.size || 0),
        sizeText: formatBytes(blob.size),
        uploadedAt: blob.uploadedAt,
        mime: blob.contentType || mimeFor(parsed.name),
        etag: blob.etag
      });
    }
    cursor = result.cursor;
  } while (cursor);
  all.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return all;
}

function totalSize(files) {
  return files.reduce((sum, f) => sum + Number(f.size || 0), 0);
}

function publicFile(file) {
  return {
    id: file.id,
    name: file.name,
    path: file.relativePath ? `${file.relativePath}/${file.name}` : file.name,
    relativePath: file.relativePath,
    pathname: file.pathname,
    size: file.size,
    sizeText: file.sizeText,
    uploadedAt: file.uploadedAt,
    mime: file.mime,
    etag: file.etag
  };
}

/* =========================
   AUTH
========================= */
app.post("/api/auth/login", (req, res) => {
  if (locked(req, "login")) return jsonError(res, 423, "Access locked for 24 hours on this device.");
  if (!APP_PASSWORD) return jsonError(res, 500, "APP_PASSWORD is not configured in Vercel.");
  const password = String(req.body?.password || "");
  if (!safeEqual(password, APP_PASSWORD)) {
    const isLocked = failure(req, "login");
    return jsonError(res, isLocked ? 423 : 401, isLocked ? "Access locked for 24 hours." : "Incorrect password");
  }
  clearFailures(req, "login");
  const secure = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  const token = encodeURIComponent(makeSession());
  res.setHeader("Set-Cookie", `my_cloud_io_session=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => res.json({ authenticated: Boolean(getSession(req)) }));

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", "my_cloud_io_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/health", async (req, res) => {
  const storage = await blobCheck();
  res.json({
    success: true,
    service: "my-personal-cloud",
    status: "online",
    storage,
    provider: "vercel-blob-private",
    completedFilesAutoDelete: false,
    time: new Date().toISOString()
  });
});

app.get("/api/status", requireAuth, async (req, res) => {
  try {
    const files = await listAllFiles();
    const used = totalSize(files);
    const percent = Math.min(100, (used / Math.max(1, MAX_FILE_SIZE)) * 100);
    const storage = await blobCheck();
    res.json({
      ok: true,
      usedBytes: used,
      usedText: formatBytes(used),
      totalText: "Cloud",
      freeText: "Vercel Blob",
      percent,
      fileCount: files.length,
      provider: "Vercel Blob Private Storage",
      blobOk: storage.ok,
      blobError: storage.ok ? "" : storage.error || "Vercel Blob is not connected",
      retention: "PERMANENT UNTIL MANUAL DELETE",
      autoDelete: false
    });
  } catch (error) {
    return jsonError(res, 503, error?.message || "Storage unavailable");
  }
});

app.get("/api/storage", requireAuth, async (req, res) => {
  const files = await listAllFiles();
  const used = totalSize(files);
  res.json({ usedBytes: used, usedText: formatBytes(used), remainingBytes: null, remainingText: "Vercel Blob", limitText: "Cloud" });
});

/* =========================
   VERCEL BLOB CLIENT UPLOAD
========================= */
app.post("/api/blob-upload", requireAuth, async (req, res) => {
  try {
    const body = req.body;
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload, multipart) => {
        if (!String(pathname).startsWith(FILE_PREFIX)) {
          throw new Error("Invalid upload path");
        }
        let payload = {};
        try { payload = JSON.parse(String(clientPayload || "{}")); } catch {}
        const size = Number(payload.size || 0);
        if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_SIZE) {
          throw new Error(`File size must be between 1 byte and ${formatBytes(MAX_FILE_SIZE)}`);
        }
        return {
          access: "private",
          addRandomSuffix: false,
          multipart: Boolean(multipart),
          allowedContentTypes: ["*/*"],
          tokenPayload: JSON.stringify({
            id: payload.id,
            size,
            name: cleanName(payload.name),
            relativePath: cleanRelativePath(payload.relativePath)
          })
        };
      },
      onUploadCompleted: async () => {
        // The blob itself is the durable source of truth. Nothing is deleted here.
      }
    });
    return res.json(result);
  } catch (error) {
    console.error("BLOB TOKEN ERROR:", error?.stack || error);
    const message = String(error?.message || error);
    if (/No blob credentials|credentials found|BLOB_READ_WRITE_TOKEN|oidcToken|BLOB_STORE_ID/i.test(message)) {
      return jsonError(res, 503, "Vercel Blob is not connected. In Vercel open Storage → Create Database → Blob, choose Private, connect it to this project, enable Production, then redeploy.");
    }
    return jsonError(res, 400, message);
  }
});

/* Compatibility endpoint: old chunk uploader is intentionally disabled on Vercel. */
app.post("/api/upload/chunk", requireAuth, (req, res) => {
  return jsonError(res, 410, "The old server-chunk upload endpoint is disabled. This build uses direct Vercel Blob multipart uploads for real large-file transfers.");
});

app.post("/api/register-upload", requireAuth, async (req, res) => {
  try {
    const { pathname, size, name } = req.body || {};
    if (!String(pathname || "").startsWith(FILE_PREFIX)) return jsonError(res, 400, "Invalid Blob pathname");
    const expectedSize = Number(size);
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_FILE_SIZE) return jsonError(res, 400, "Invalid file size");
    const blob = await head(String(pathname));
    if (!blob || Number(blob.size) !== expectedSize) return jsonError(res, 409, "Uploaded Blob could not be verified");
    res.json({ ok: true, file: publicFile({
      id: parseFilePath(pathname)?.id || "",
      name: cleanName(name || parseFilePath(pathname)?.name),
      relativePath: parseFilePath(pathname)?.relativePath || "",
      pathname: blob.pathname,
      size: blob.size,
      sizeText: formatBytes(blob.size),
      uploadedAt: blob.uploadedAt,
      mime: blob.contentType || mimeFor(name),
      etag: blob.etag
    })});
  } catch (error) {
    return jsonError(res, 400, error?.message || "Upload registration failed");
  }
});

/* =========================
   FILE LIST
========================= */
app.get("/api/files", requireAuth, async (req, res) => {
  try {
    const files = await listAllFiles();
    res.json({ items: files.map(publicFile) });
  } catch (error) {
    console.error("FILE LIST ERROR:", error?.stack || error);
    return jsonError(res, 503, error?.message || "Storage index unavailable");
  }
});

async function findBlob(pathname) {
  const safe = String(pathname || "");
  if (!safe.startsWith(FILE_PREFIX)) return null;
  const blob = await head(safe);
  if (!blob) return null;
  return blob;
}

async function streamBlob(req, res, pathname, forceDownload) {
  const range = String(req.headers.range || "").trim();
  const options = { access: "private" };
  if (range) options.headers = { Range: range };
  const result = await get(pathname, options);
  if (!result || result.statusCode !== 200 || !result.stream) return res.status(404).send("Not found");

  const blob = result.blob;
  res.setHeader("Content-Type", blob.contentType || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("ETag", blob.etag || "");
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (forceDownload) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.parse(blob.pathname).base)}`);

  const contentRange = result.headers?.get?.("content-range");
  const contentLength = result.headers?.get?.("content-length");
  if (contentRange) {
    res.status(206).setHeader("Content-Range", contentRange);
  }
  if (contentLength) res.setHeader("Content-Length", contentLength);
  Readable.fromWeb(result.stream).pipe(res);
}

app.get("/api/stream", requireAuth, async (req, res) => {
  try {
    const pathname = String(req.query.pathname || "");
    await streamBlob(req, res, pathname, false);
  } catch (error) {
    console.error("STREAM ERROR:", error?.message || error);
    return jsonError(res, 404, "File not found");
  }
});

app.get("/api/download", requireAuth, async (req, res) => {
  try {
    const pathname = String(req.query.pathname || "");
    await streamBlob(req, res, pathname, true);
  } catch (error) {
    console.error("DOWNLOAD ERROR:", error?.message || error);
    return jsonError(res, 404, "File not found");
  }
});


/* =========================
   RENAME
========================= */
app.patch("/api/files", requireAuth, async (req, res) => {
  try {
    const pathname = String(req.body?.pathname || "");
    const newName = cleanName(req.body?.newName || "");
    if (!pathname || !newName) return jsonError(res, 400, "Pathname and new name are required");
    const parsed = parseFilePath(pathname);
    if (!parsed) return jsonError(res, 400, "Invalid file pathname");

    const oldBlob = await findBlob(pathname);
    if (!oldBlob) return jsonError(res, 404, "File not found");

    const newPath = makePath(parsed.id, parsed.relativePath, newName);
    if (newPath !== pathname) {
      await copy(pathname, newPath, { access: "private" });
      await del(pathname, { access: "private" });
    }
    res.json({ ok: true, pathname: newPath, name: newName });
  } catch (error) {
    return jsonError(res, 400, error?.message || "Rename failed");
  }
});

/* =========================
   DELETE — MANUAL ONLY
========================= */
app.delete("/api/files", requireAuth, requireDeletePassword, async (req, res) => {
  try {
    const pathname = String(req.body?.pathname || req.body?.path || "");
    if (!pathname.startsWith(FILE_PREFIX)) return jsonError(res, 400, "Invalid file pathname");
    const blob = await findBlob(pathname);
    if (!blob) return jsonError(res, 404, "File not found");
    await del(pathname, { access: "private" });
    res.json({ ok: true, deleted: pathname, autoDelete: false });
  } catch (error) {
    return jsonError(res, 400, error?.message || "Delete failed");
  }
});

/* =========================
   SHARE
========================= */
app.post("/api/share", requireAuth, async (req, res) => {
  try {
    const pathname = String(req.body?.pathname || "");
    const blob = await findBlob(pathname);
    if (!blob) return jsonError(res, 404, "File not found");
    const token = signPayload({ type: "share", pathname, exp: Date.now() + SHARE_TTL_MS });
    const base = `${req.protocol}://${req.get("host")}`;
    res.json({ ok: true, token, url: `${base}/s/${encodeURIComponent(token)}`, expiresAt: Date.now() + SHARE_TTL_MS });
  } catch (error) {
    return jsonError(res, 400, error?.message || "Share failed");
  }
});

app.get("/api/shared-stream", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    const payload = verifyPayload(token);
    if (!payload || payload.type !== "share") return res.status(401).send("Invalid or expired share");
    await streamBlob(req, res, payload.pathname, false);
  } catch {
    res.status(404).send("File not found");
  }
});

app.get("/s/:token", async (req, res) => {
  const token = decodeURIComponent(String(req.params.token || ""));
  const payload = verifyPayload(token);
  if (!payload || payload.type !== "share") return res.status(404).send("Share link expired or invalid");
  try {
    const blob = await findBlob(payload.pathname);
    if (!blob) return res.status(404).send("File no longer exists");
    const parsed = parseFilePath(payload.pathname) || { name: path.basename(payload.pathname), relativePath: "" };
    const name = cleanName(parsed.name);
    const mime = blob.contentType || mimeFor(name);
    const streamUrl = `/api/shared-stream?token=${encodeURIComponent(token)}`;
    const downloadUrl = `${streamUrl}&download=1`;
    const escapedName = name.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#07080d"><title>${escapedName}</title><style>body{margin:0;background:#07080d;color:#fff;font-family:system-ui;display:grid;place-items:center;min-height:100vh;padding:20px;box-sizing:border-box}.card{width:min(900px,100%);padding:24px;border:1px solid #ffffff18;border-radius:24px;background:#ffffff08;backdrop-filter:blur(18px)}h1{word-break:break-word}.meta{color:#999;margin-bottom:18px}img,video,iframe,audio{max-width:100%;width:100%;max-height:70vh;border-radius:16px;background:#000}a{display:inline-block;margin-top:18px;padding:13px 17px;border-radius:13px;background:#fff;color:#111;text-decoration:none;font-weight:800}</style></head><body><main class="card"><h1>${escapedName}</h1><div class="meta">${formatBytes(blob.size)} · ${mime}</div><div id="v"></div><a href="${downloadUrl}">Download file</a></main><script>const m=${JSON.stringify(mime)},u=${JSON.stringify(streamUrl)},v=document.getElementById('v');if(m.startsWith('image/'))v.innerHTML='<img src="'+u+'">';else if(m.startsWith('video/'))v.innerHTML='<video src="'+u+'" controls playsinline></video>';else if(m.startsWith('audio/'))v.innerHTML='<audio src="'+u+'" controls></audio>';else if(m==='application/pdf'||m.startsWith('text/'))v.innerHTML='<iframe src="'+u+'" style="height:70vh"></iframe>';else v.innerHTML='<p>Preview is not available for this file type.</p>';</script></body></html>`);
  } catch (error) {
    res.status(404).send("File not found");
  }
});

/* =========================
   DOWNLOAD ALL
========================= */
app.get("/api/download-all", requireAuth, async (req, res) => {
  try {
    const files = await listAllFiles();
    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=My-Personal-Cloud.zip");
    const archive = archiver("zip", { zlib: { level: 0 } });
    archive.on("error", err => { try { res.destroy(err); } catch {} });
    archive.pipe(res);
    for (const file of files) {
      const result = await get(file.pathname, { access: "private" });
      if (!result?.stream) continue;
      archive.append(Readable.fromWeb(result.stream), { name: file.relativePath ? `${file.relativePath}/${file.name}` : file.name });
    }
    await archive.finalize();
  } catch (error) {
    if (!res.headersSent) return jsonError(res, 500, error?.message || "ZIP download failed");
    try { res.destroy(error); } catch {}
  }
});

/* Static app last, after API routes. */
app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  dotfiles: "deny",
  setHeaders(res) { res.setHeader("Cache-Control", "no-store"); }
}));

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

/* Local server; Vercel imports the Express app instead. */
if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`my-personal-cloud running on port ${PORT}`);
  });
}

module.exports = app;
