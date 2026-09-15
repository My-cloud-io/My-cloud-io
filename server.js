"use strict";

/*
  my-personal-cloud / Cloud-Zen
  Vercel-ready storage upgrade.

  The original UI/API contract is preserved: login, storage status, file list,
  upload, cancel upload, stream/preview, download, rename, share, delete and
  download-all keep their original routes. Only the physical storage layer is
  changed from Telegram MTProto to Vercel Blob Private Storage.

  Completed files are NEVER auto-deleted by this application. A completed
  object is removed only by the explicit DELETE route.
*/

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const archiver = require("archiver");
const { put, get, list, del, head, copy, issueSignedToken, presignUrl } = require("@vercel/blob");
const { handleUpload } = require("@vercel/blob/client");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");

/* =========================
   ENVIRONMENT / SECRETS
========================= */
const APP_PASSWORD = String(process.env.APP_PASSWORD ?? "").trim();
const DELETE_PASSWORD = String(process.env.DELETE_PASSWORD ?? "").trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET ?? "").trim();
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 1024 * 1024 * 1024 * 1024);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_LOCK_MS = 24 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 3;
const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
const FILE_PREFIX = "my-personal-cloud/files/";
const LEGACY_FILE_PREFIX = "my-cloud-io/files/";

const authFailures = new Map();
const deviceLocks = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  }
}));

function jsonError(res, status, message) {
  return res.status(status).json({ error: String(message || "Request failed") });
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
  if (!SESSION_SECRET) throw new Error("SESSION_SECRET is not configured.");
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyPayload(token) {
  if (!SESSION_SECRET || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || Number(payload.exp) <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function getSession(req) {
  const token = getCookie(req, "cloud_zen_session") || getCookie(req, "my_cloud_io_session");
  const payload = verifyPayload(token);
  return payload?.type === "session" ? payload : null;
}

function makeSession() {
  return signPayload({ type: "session", iat: Date.now(), exp: Date.now() + SESSION_TTL_MS });
}

function deviceKey(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  const ua = String(req.headers["user-agent"] || "unknown");
  const device = String(req.headers["x-cloud-device"] || "");
  return crypto.createHash("sha256").update(`${ip}|${ua}|${device}`).digest("hex");
}

function isLocked(req, area) {
  const key = `${area}:${deviceKey(req)}`;
  const until = deviceLocks.get(key) || 0;
  if (until > Date.now()) return true;
  deviceLocks.delete(key);
  return false;
}

function registerFailure(req, area) {
  const key = `${area}:${deviceKey(req)}`;
  const count = (authFailures.get(key) || 0) + 1;
  if (count >= MAX_LOGIN_FAILURES) {
    authFailures.delete(key);
    deviceLocks.set(key, Date.now() + DEVICE_LOCK_MS);
    return true;
  }
  authFailures.set(key, count);
  return false;
}

function clearFailures(req, area) {
  authFailures.delete(`${area}:${deviceKey(req)}`);
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return jsonError(res, 401, "Authentication required");
  req.cloudSession = session;
  next();
}

function requireDeletePassword(req, res, next) {
  if (isLocked(req, "delete")) return jsonError(res, 423, "Delete access is locked for 24 hours on this device.");
  const password = String(req.body?.deletePassword ?? "").trim();
  if (!DELETE_PASSWORD || !safeEqual(password, DELETE_PASSWORD)) {
    const locked = registerFailure(req, "delete");
    return jsonError(res, locked ? 423 : 403, locked ? "Delete access locked for 24 hours." : "Incorrect delete password.");
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
  return parts.filter(part => part !== "." && part !== "..").map(part => part.slice(0, 180)).join("/").slice(0, 1200);
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
    ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".png":"image/png", ".gif":"image/gif", ".webp":"image/webp", ".svg":"image/svg+xml", ".bmp":"image/bmp", ".ico":"image/x-icon",
    ".mp4":"video/mp4", ".webm":"video/webm", ".mov":"video/quicktime", ".mkv":"video/x-matroska", ".avi":"video/x-msvideo", ".m4v":"video/x-m4v",
    ".mp3":"audio/mpeg", ".wav":"audio/wav", ".m4a":"audio/mp4", ".aac":"audio/aac", ".ogg":"audio/ogg", ".flac":"audio/flac",
    ".pdf":"application/pdf", ".txt":"text/plain", ".csv":"text/csv", ".json":"application/json", ".xml":"application/xml", ".html":"text/html", ".md":"text/markdown",
    ".zip":"application/zip", ".rar":"application/vnd.rar", ".7z":"application/x-7z-compressed", ".gz":"application/gzip",
    ".doc":"application/msword", ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xls":"application/vnd.ms-excel", ".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".ppt":"application/vnd.ms-powerpoint", ".pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  return map[ext] || "application/octet-stream";
}

function storageConfiguredHint() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_BLOB_STORE_ID);
}

async function blobHealth() {
  try {
    await list({ prefix: FILE_PREFIX, limit: 1 });
    return { configured: true, connected: true, error: "" };
  } catch (error) {
    return { configured: storageConfiguredHint(), connected: false, error: error?.message || String(error) };
  }
}

function makePath(id, relativePath, name) {
  const safeRelative = cleanRelativePath(relativePath);
  const safeName = cleanName(name);
  return `${FILE_PREFIX}${id}/${safeRelative ? `${safeRelative}/` : ""}${encodeURIComponent(safeName)}`;
}

function parseFilePath(pathname) {
  const raw = String(pathname || "");
  const prefix = raw.startsWith(FILE_PREFIX) ? FILE_PREFIX : raw.startsWith(LEGACY_FILE_PREFIX) ? LEGACY_FILE_PREFIX : null;
  if (!prefix) return null;
  const rest = raw.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const id = rest.slice(0, slash);
  const parts = rest.slice(slash + 1).split("/").map(part => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const name = parts.pop() || "file";
  return { id, name: cleanName(name), relativePath: cleanRelativePath(parts.join("/")) };
}

function publicFile(meta) {
  return {
    name: meta.name,
    size: Number(meta.size || 0),
    sizeText: formatBytes(meta.size),
    modified: meta.modified || meta.uploadedAt || null,
    type: meta.type || meta.mime || mimeFor(meta.name),
    storage: "CLOUD",
    storageLabel: "Vercel Blob",
    chunks: meta.total || 1,
    pathname: meta.pathname,
    relativePath: meta.relativePath || ""
  };
}

async function listAllFiles() {
  const files = [];
  const seen = new Set();
  const prefixes = [FILE_PREFIX, LEGACY_FILE_PREFIX];

  for (const prefix of prefixes) {
    let cursor;
    do {
      const result = await list({ prefix, limit: 1000, cursor });
      for (const blob of result.blobs || []) {
        if (seen.has(blob.pathname)) continue;
        const parsed = parseFilePath(blob.pathname);
        if (!parsed) continue;
        seen.add(blob.pathname);
        files.push({
          name: parsed.name,
          size: Number(blob.size || 0),
          sizeText: formatBytes(blob.size),
          modified: blob.uploadedAt || null,
          uploadedAt: blob.uploadedAt || null,
          type: blob.contentType || mimeFor(parsed.name),
          mime: blob.contentType || mimeFor(parsed.name),
          pathname: blob.pathname,
          relativePath: parsed.relativePath,
          etag: blob.etag,
          url: blob.url,
          downloadUrl: blob.downloadUrl
        });
      }
      cursor = result.cursor;
    } while (cursor);
  }

  files.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return files;
}

async function findFile(name) {
  const clean = cleanName(name);
  const files = await listAllFiles();
  return files.find(file => file.name === clean) || null;
}

async function findByPathname(pathname) {
  const safe = String(pathname || "");
  if (!safe.startsWith(FILE_PREFIX) && !safe.startsWith(LEGACY_FILE_PREFIX)) return null;
  try { return await head(safe, { access: "private" }); } catch { return null; }
}

/* =========================
   AUTH
========================= */
app.post("/api/auth/login", (req, res) => {
  if (isLocked(req, "login")) return jsonError(res, 423, "Access locked for 24 hours on this device.");
  if (!APP_PASSWORD) return jsonError(res, 500, "APP_PASSWORD is not configured in Vercel.");
  const password = String(req.body?.password || "");
  if (!safeEqual(password, APP_PASSWORD)) {
    const locked = registerFailure(req, "login");
    return jsonError(res, locked ? 423 : 401, locked ? "Access locked for 24 hours." : "Incorrect password");
  }
  clearFailures(req, "login");
  const secure = Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
  const token = encodeURIComponent(makeSession());
  res.setHeader("Set-Cookie", `cloud_zen_session=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => res.json({ authenticated: Boolean(getSession(req)) }));

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", "cloud_zen_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

/* Compatibility endpoint from the original project. */
app.post("/api/access/download", requireAuth, (req, res) => {
  res.json({ ok: true, expiresIn: 0, message: "Download is protected by the main Enter password." });
});

/* =========================
   HEALTH / STORAGE
========================= */
app.get("/api/health", async (req, res) => {
  const storage = await blobHealth();
  res.status(storage.connected ? 200 : 503).json({
    success: storage.connected,
    status: storage.connected ? "online" : "degraded",
    storage: "Cloud Storage",
    persistent: true,
    multipart: true,
    provider: "Vercel Blob Private Storage",
    completedFilesAutoDelete: false,
    blob: storage,
    telegram: { configured: false, connected: false, disabled: true },
    time: new Date().toISOString()
  });
});

app.get("/api/storage", requireAuth, async (req, res) => {
  try {
    const files = await listAllFiles();
    const used = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    const percent = Math.min(100, Number(((used / Math.max(1, MAX_FILE_SIZE)) * 100).toFixed(2)));
    const storage = await blobHealth();
    res.json({
      usedBytes: used,
      usedText: formatBytes(used),
      remainingBytes: null,
      remainingText: storage.connected ? "Vercel Blob" : "Blob not connected",
      usedPercent: percent,
      limitText: "Cloud",
      provider: { configured: storage.configured, connected: storage.connected, usedText: formatBytes(used), remainingText: storage.connected ? "Vercel Blob" : "Not connected" },
      // Legacy provider fields intentionally report disabled; production storage is Vercel Blob only.
      b2: { configured: false, connected: false, hidden: true },
      mega: { configured: false, connected: false, hidden: true },
      idriveE2: { configured: false, connected: false, hidden: true },
      cloudinary: { configured: false, connected: false, hidden: true },
      filebase: { configured: false, connected: false, hidden: true },
      koofr: { configured: false, connected: false, hidden: true },
      vercelBlob: { configured: storage.configured, connected: storage.connected },
      retention: "PERMANENT UNTIL MANUAL DELETE",
      autoDelete: false
    });
  } catch (error) {
    return jsonError(res, 503, error?.message || "Storage unavailable");
  }
});

/* =========================
   FILE LIST
========================= */
app.get("/api/files", requireAuth, async (req, res) => {
  try {
    const files = await listAllFiles();
    res.json(files.map(publicFile));
  } catch (error) {
    console.error("FILE LIST ERROR:", error?.stack || error);
    return jsonError(res, 503, "Storage index unavailable");
  }
});

/* =========================
   DIRECT VERCEL BLOB CLIENT UPLOAD
========================= */
app.post("/api/blob-upload-url", requireAuth, async (req, res) => {
  try {
    const pathname = String(req.body?.pathname || "");
    const size = Number(req.body?.size);
    const contentType = String(req.body?.contentType || "application/octet-stream").slice(0, 180);

    if (!pathname.startsWith(FILE_PREFIX)) return jsonError(res, 400, "Invalid upload path");
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_SIZE) {
      return jsonError(res, 400, `File size must be between 1 byte and ${formatBytes(MAX_FILE_SIZE)}`);
    }

    // A short-lived URL is scoped to this exact pathname and PUT operation.
    // The file bytes go directly from the browser to Vercel Blob, never through
    // the Vercel Function, so the Function 4.5 MB request limit is avoided.
    const token = await issueSignedToken({
      pathname,
      operations: ["put"],
      validUntil: Date.now() + 15 * 60 * 1000
    });

    const signed = await presignUrl(token, {
      pathname,
      operation: "put",
      validUntil: Date.now() + 15 * 60 * 1000
    });

    res.json({
      ok: true,
      pathname,
      uploadUrl: signed.presignedUrl,
      expiresAt: Date.now() + 15 * 60 * 1000,
      contentType
    });
  } catch (error) {
    console.error("BLOB SIGNED UPLOAD ERROR:", error?.stack || error);
    const message = String(error?.message || error);
    if (/No blob credentials|credentials found|BLOB_READ_WRITE_TOKEN|oidc|store/i.test(message)) {
      return jsonError(res, 503, "Vercel Blob is not connected. Connect a PRIVATE Blob store to this Vercel project and redeploy.");
    }
    return jsonError(res, 400, message);
  }
});

app.post("/api/blob-upload", requireAuth, async (req, res) => {
  try {
    const body = req.body;
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload, multipart) => {
        if (!String(pathname).startsWith(FILE_PREFIX)) throw new Error("Invalid upload path");
        let payload = {};
        try { payload = JSON.parse(String(clientPayload || "{}")); } catch { throw new Error("Invalid upload metadata"); }
        const size = Number(payload.size || 0);
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_SIZE) {
          throw new Error(`File size must be between 1 byte and ${formatBytes(MAX_FILE_SIZE)}`);
        }
        return {
          allowedContentTypes: ["*/*"],
          addRandomSuffix: false,
          access: "private",
          multipart: Boolean(multipart),
          tokenPayload: JSON.stringify({
            id: String(payload.id || ""),
            size,
            name: cleanName(payload.name),
            relativePath: cleanRelativePath(payload.relativePath)
          })
        };
      },
      onUploadCompleted: async () => {
        // Blob is the durable source of truth. Completed objects are not auto-deleted.
      }
    });
    res.json(result);
  } catch (error) {
    console.error("BLOB CLIENT UPLOAD ERROR:", error?.stack || error);
    const message = String(error?.message || error);
    if (/No blob credentials|credentials found|BLOB_READ_WRITE_TOKEN|oidcToken|BLOB_STORE_ID/i.test(message)) {
      return jsonError(res, 503, "Vercel Blob is not connected. In Vercel open Storage → Create Database → Blob → Private, connect it to this project, enable Production, then redeploy.");
    }
    return jsonError(res, 400, message);
  }
});

/* Keep the old endpoint name so stale browser code gets a clear message instead of a generic 404. */
app.post("/api/upload-chunk", requireAuth, (req, res) => {
  return jsonError(res, 410, "This Vercel build uses direct browser-to-Blob multipart uploads. Please refresh the page and try the upload again.");
});

app.post("/api/register-upload", requireAuth, async (req, res) => {
  try {
    const pathname = String(req.body?.pathname || "");
    const expectedSize = Number(req.body?.size);
    if (!pathname.startsWith(FILE_PREFIX)) return jsonError(res, 400, "Invalid Blob pathname");
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_FILE_SIZE) return jsonError(res, 400, "Invalid file size");
    const blob = await findByPathname(pathname);
    if (!blob || Number(blob.size) !== expectedSize) return jsonError(res, 409, "Uploaded Blob could not be verified");
    res.json({ ok: true, verified: true, pathname: blob.pathname, size: blob.size, etag: blob.etag });
  } catch (error) {
    return jsonError(res, 400, error?.message || "Upload verification failed");
  }
});

app.delete("/api/upload/:id", requireAuth, async (req, res) => {
  // Client cancellation normally leaves no completed object. If an object was
  // already completed under this UUID, remove only that explicitly cancelled id.
  const id = cleanName(req.params.id);
  try {
    const files = await listAllFiles();
    const matches = files.filter(file => parseFilePath(file.pathname)?.id === id);
    for (const file of matches) await del(file.pathname, { access: "private" });
    res.json({ ok: true });
  } catch (error) {
    return jsonError(res, 400, error?.message || "Cancel failed");
  }
});

/* =========================
   STREAM / DOWNLOAD
========================= */
async function streamBlob(req, res, pathname, inline) {
  const safe = String(pathname || "");
  if (!safe.startsWith(FILE_PREFIX) && !safe.startsWith(LEGACY_FILE_PREFIX)) return res.status(404).send("File not found");
  const range = String(req.headers.range || "").trim();
  const options = { access: "private" };
  if (range) options.range = range;
  const result = await get(safe, options);
  if (!result || !result.stream || ![200, 206].includes(Number(result.statusCode))) return res.status(404).send("File not found");
  const blob = result.blob || {};
  res.status(Number(result.statusCode));
  res.setHeader("Content-Type", blob.contentType || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (blob.etag) res.setHeader("ETag", blob.etag);
  const contentRange = result.headers?.get?.("content-range");
  const contentLength = result.headers?.get?.("content-length");
  if (contentRange) res.setHeader("Content-Range", contentRange);
  if (contentLength) res.setHeader("Content-Length", contentLength);
  const parsed = parseFilePath(safe);
  if (inline) {
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(parsed?.name || "file")}`);
  } else {
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(parsed?.name || "file")}`);
  }
  Readable.fromWeb(result.stream).pipe(res);
}

app.get(/^\/api\/stream\/(.+)$/, requireAuth, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params[0]);
    const file = await findFile(name);
    if (!file) return res.status(404).send("File not found");
    await streamBlob(req, res, file.pathname, true);
  } catch (error) {
    if (!res.headersSent) res.status(404).send("File not found"); else res.destroy(error);
  }
});

app.get(/^\/api\/download\/(.+)$/, requireAuth, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params[0]);
    const file = await findFile(name);
    if (!file) return res.status(404).send("File not found");
    await streamBlob(req, res, file.pathname, false);
  } catch (error) {
    if (!res.headersSent) res.status(404).send("Download failed"); else res.destroy(error);
  }
});

/* Query-style compatibility routes for the newer client build. */
app.get("/api/stream", requireAuth, async (req, res) => {
  try {
    const pathname = String(req.query.pathname || "");
    const blob = await findByPathname(pathname);
    if (!blob) return res.status(404).send("File not found");
    await streamBlob(req, res, pathname, true);
  } catch (error) {
    if (!res.headersSent) res.status(404).send("File not found"); else res.destroy(error);
  }
});

app.get("/api/download", requireAuth, async (req, res) => {
  try {
    const pathname = String(req.query.pathname || "");
    const blob = await findByPathname(pathname);
    if (!blob) return res.status(404).send("File not found");
    await streamBlob(req, res, pathname, false);
  } catch (error) {
    if (!res.headersSent) res.status(404).send("Download failed"); else res.destroy(error);
  }
});

/* =========================
   RENAME
========================= */
app.patch("/api/files", requireAuth, async (req, res) => {
  try {
    const oldName = cleanName(req.body?.name || "");
    const newName = cleanName(req.body?.newName || "");
    if (!oldName || !newName || oldName === newName) return jsonError(res, 400, "Enter a different file name.");
    const file = await findFile(oldName);
    if (!file) return jsonError(res, 404, "File not found");
    const duplicate = await findFile(newName);
    if (duplicate) return jsonError(res, 409, "A file with that name already exists.");
    const parsed = parseFilePath(file.pathname);
    const newPath = makePath(parsed?.id || crypto.randomUUID(), parsed?.relativePath || "", newName);
    await copy(file.pathname, newPath, { access: "private", addRandomSuffix: false });
    await del(file.pathname, { access: "private" });
    res.json({ ok: true, file: publicFile({ ...file, name: newName, pathname: newPath, type: mimeFor(newName), modified: new Date().toISOString() }) });
  } catch (error) {
    console.error("RENAME ERROR:", error?.stack || error);
    return jsonError(res, 500, error?.message || "Rename failed");
  }
});

/* =========================
   SHARE
========================= */
function createShareToken(name) {
  const exp = Math.floor(Date.now() / 1000) + SHARE_TTL_SECONDS;
  return signPayload({ type: "share", n: cleanName(name), exp, nonce: crypto.randomBytes(8).toString("hex") });
}

app.post("/api/share", requireAuth, async (req, res) => {
  try {
    const name = cleanName(req.body?.name || "");
    const file = await findFile(name);
    if (!file) return jsonError(res, 404, "File not found");
    const token = createShareToken(name);
    const base = `${req.protocol}://${req.get("host")}`;
    res.json({ ok: true, url: `${base}/s/${encodeURIComponent(token)}`, expiresIn: SHARE_TTL_SECONDS, name: file.name });
  } catch (error) {
    return jsonError(res, 500, error?.message || "Could not create share link");
  }
});

function verifyShareToken(token) {
  const data = verifyPayload(token);
  return data?.type === "share" ? data : null;
}

app.post("/api/shared-access", async (req, res) => {
  const token = String(req.body?.token || "");
  const data = verifyShareToken(token);
  if (!data) return jsonError(res, 410, "Share link expired or invalid.");
  if (!APP_PASSWORD || !safeEqual(String(req.body?.password || ""), APP_PASSWORD)) return jsonError(res, 403, "Incorrect Enter password.");
  const sharedToken = signPayload({ type: "shared-download", tokenHash: crypto.createHash("sha256").update(token).digest("hex"), exp: Date.now() + 15 * 60 * 1000 });
  const secure = Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
  res.setHeader("Set-Cookie", `cloud_zen_shared_download_access=${encodeURIComponent(sharedToken)}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=900`);
  res.json({ ok: true, expiresIn: 900 });
});

app.get(/^\/api\/shared-stream\/(.+)$/, async (req, res) => {
  try {
    const token = decodeURIComponent(req.params[0]);
    const data = verifyShareToken(token);
    if (!data) return res.status(410).send("Share link expired");
    const file = await findFile(data.n);
    if (!file) return res.status(404).send("File not found");
    await streamBlob(req, res, file.pathname, true);
  } catch (error) {
    if (!res.headersSent) res.status(404).send("File not found"); else res.destroy(error);
  }
});

app.get(/^\/s\/([^/]+)$/, async (req, res) => {
  const token = decodeURIComponent(req.params[0]);
  const data = verifyShareToken(token);
  if (!data) return res.status(404).send("This share link has expired or is invalid.");
  const file = await findFile(data.n);
  if (!file) return res.status(404).send("File not found");
  const safeName = file.name.replace(/[<>]/g, "");
  const streamUrl = `/api/shared-stream/${encodeURIComponent(token)}`;
  const downloadUrl = `/s/${encodeURIComponent(token)}/download`;
  const mime = file.type || mimeFor(file.name);
  const escaped = JSON.stringify({ name: safeName, size: file.size, type: mime, streamUrl, downloadUrl, token }).replace(/</g, "\\u003c");
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#070b14"><title>${safeName}</title><style>body{margin:0;background:#070b14;color:#eef2ff;font-family:system-ui;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}.card{width:min(920px,100%);padding:28px;border:1px solid #ffffff18;border-radius:28px;background:#ffffff08;backdrop-filter:blur(18px)}h1{font-size:clamp(20px,4vw,34px);margin:0 0 8px;word-break:break-word}.meta{color:#9aa7bf;margin-bottom:22px}video,audio,img,iframe{width:100%;max-height:70vh;border-radius:18px;background:#000;object-fit:contain}.btn{display:inline-flex;margin-top:18px;padding:12px 16px;border-radius:12px;background:#fff;color:#07101e;text-decoration:none;font-weight:750;border:0;cursor:pointer}.shade{position:fixed;inset:0;background:#0009;backdrop-filter:blur(10px);display:none;place-items:center;padding:18px}.box{width:min(420px,100%);background:#101a2b;border:1px solid #ffffff18;border-radius:22px;padding:24px}.box input{width:100%;height:46px;box-sizing:border-box;border-radius:12px;border:1px solid #ffffff18;background:#091321;color:#fff;padding:0 12px;margin:8px 0 12px}.err{color:#ffb5c0;font-size:12px;min-height:18px}</style></head><body><main class="card"><h1>${safeName}</h1><div class="meta">${formatBytes(file.size)} · ${mime}</div><div id="viewer"></div><button class="btn" id="downloadBtn">Download file</button></main><div class="shade" id="shade"><div class="box"><h2>Secure download</h2><p>Enter the website password to continue.</p><input id="pw" type="password" autocomplete="off" placeholder="Password"><div class="err" id="err"></div><button class="btn" id="unlock">Unlock & download</button></div></div><script>const f=${escaped},v=document.getElementById('viewer'),u=f.streamUrl;if(f.type.startsWith('image/'))v.innerHTML='<img src="'+u+'">';else if(f.type.startsWith('video/'))v.innerHTML='<video src="'+u+'" controls playsinline preload="metadata"></video>';else if(f.type.startsWith('audio/'))v.innerHTML='<audio src="'+u+'" controls preload="metadata"></audio>';else if(f.type==='application/pdf'||f.type.startsWith('text/'))v.innerHTML='<iframe src="'+u+'" style="height:70vh"></iframe>';else v.innerHTML='<p style="color:#9aa7bf">Preview is not available for this file type.</p>';const sh=document.getElementById('shade');document.getElementById('downloadBtn').onclick=()=>sh.style.display='grid';document.getElementById('unlock').onclick=async()=>{const err=document.getElementById('err'),b=document.getElementById('unlock');b.disabled=true;err.textContent='';try{const r=await fetch('/api/shared-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:f.token,password:document.getElementById('pw').value})});const d=await r.json();if(!r.ok)throw Error(d.error||'Access denied');location.href=f.downloadUrl}catch(e){err.textContent=e.message;b.disabled=false}};</script></body></html>`);
});

app.get(/^\/s\/([^/]+)\/download$/, async (req, res) => {
  const token = decodeURIComponent(req.params[0]);
  const data = verifyShareToken(token);
  if (!data) return res.status(410).send("Share link expired");
  const file = await findFile(data.n);
  if (!file) return res.status(404).send("File not found");
  // Share download is intentionally protected by the website password through
  // a short-lived cookie in the original UI. For compatibility, accept the
  // main authenticated session as well as the short-lived shared session.
  const shared = verifyPayload(getCookie(req, "cloud_zen_shared_download_access"));
  const validShared = Boolean(shared && shared.type === "shared-download" && shared.tokenHash === crypto.createHash("sha256").update(token).digest("hex"));
  if (!getSession(req) && !validShared) return res.status(403).send("Download access requires the website password.");
  await streamBlob(req, res, file.pathname, false);
});

/* =========================
   DELETE — MANUAL ONLY
========================= */
app.delete("/api/files", requireAuth, requireDeletePassword, async (req, res) => {
  try {
    const name = cleanName(req.body?.name || "");
    const file = await findFile(name);
    if (!file) return jsonError(res, 404, "File not found");
    await del(file.pathname, { access: "private" });
    res.json({ ok: true, name, message: "File permanently deleted", autoDelete: false });
  } catch (error) {
    console.error("DELETE ERROR:", error?.stack || error);
    return jsonError(res, 500, error?.message || "Delete failed");
  }
});

/* =========================
   DOWNLOAD ALL
========================= */
app.get("/api/download-all", requireAuth, async (req, res) => {
  let archive;
  try {
    const files = await listAllFiles();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''my-personal-cloud-all-files.zip");
    res.setHeader("Cache-Control", "private, no-store");
    archive = archiver("zip", { zlib: { level: 0 } });
    archive.on("error", error => { if (!res.destroyed) res.destroy(error); });
    archive.pipe(res);
    for (const file of files) {
      if (res.destroyed) break;
      const result = await get(file.pathname, { access: "private" });
      if (!result?.stream) throw new Error(`Could not read ${file.name}`);
      archive.append(Readable.fromWeb(result.stream), { name: file.name });
    }
    await archive.finalize();
  } catch (error) {
    if (archive) { try { archive.abort(); } catch {} }
    if (!res.headersSent) res.status(500).json({ error: error?.message || "Could not create archive" });
    else res.destroy(error);
  }
});

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
});

if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => console.log(`[my-personal-cloud] Server running on ${HOST}:${PORT}`));
}

module.exports = app;

