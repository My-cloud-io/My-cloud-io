"use strict";

/*
  MY-CLOUD-IO — Vercel-ready private cloud

  Storage backend: Vercel Blob (PRIVATE)
  - No local filesystem is used for completed files.
  - Completed files are never auto-deleted by this application.
  - Uploads arrive as 4 MiB requests so they stay below Vercel Function
    request-body limits. Each chunk is a durable Blob object.
  - File metadata is a small JSON Blob. Rename only changes metadata.
  - Download/stream reconstructs the file from its durable chunks.

  This deliberately avoids sharing one Telegram MTProto session between
  concurrent Vercel instances, which can cause AUTH_KEY_DUPLICATED.
*/

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const archiver = require("archiver");
const { put, get, list, del, head } = require("@vercel/blob");
const { handleUpload } = require("@vercel/blob/client");
const { Readable } = require("stream");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PUBLIC_DIR = path.join(__dirname, "public");
const APP_PASSWORD = String(process.env.APP_PASSWORD || "").trim();
const DELETE_PASSWORD = String(process.env.DELETE_PASSWORD || "").trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || "").trim();
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 1 * 1024 * 1024 * 1024 * 1024);
const CHUNK_SIZE = 4 * 1024 * 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_LOCK_MS = 24 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 3;
const META_PREFIX = "my-cloud-io/meta/";
const FILE_PREFIX = "my-cloud-io/files/";
const ID_RE = /^[a-f0-9-]{16,80}$/i;

const failures = new Map();
const locks = new Map();

if (!APP_PASSWORD || !DELETE_PASSWORD || !SESSION_SECRET) {
  console.warn("[My-cloud-io] APP_PASSWORD, DELETE_PASSWORD and SESSION_SECRET must be configured in Vercel.");
}

function b64(v) { return Buffer.from(String(v)).toString("base64url"); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function sign(payload) {
  if (!SESSION_SECRET) throw new Error("SESSION_SECRET is not configured");
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verify(token) {
  if (!SESSION_SECRET || !token) return null;
  const [body, sig] = String(token).split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return p && Number(p.exp) > Date.now() ? p : null;
  } catch (_) { return null; }
}
function clientKey(req, area) {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  const ua = String(req.headers["user-agent"] || "unknown");
  return `${area}:${crypto.createHash("sha256").update(ip + "|" + ua).digest("hex").slice(0, 48)}`;
}
function isLocked(req, area) {
  const k = clientKey(req, area);
  const until = locks.get(k) || 0;
  if (until > Date.now()) return true;
  locks.delete(k);
  return false;
}
function fail(req, area) {
  const k = clientKey(req, area);
  const n = (failures.get(k) || 0) + 1;
  if (n >= MAX_LOGIN_FAILURES) {
    failures.delete(k);
    locks.set(k, Date.now() + DEVICE_LOCK_MS);
    return true;
  }
  failures.set(k, n);
  return false;
}
function clearFail(req, area) { failures.delete(clientKey(req, area)); }
function sessionFrom(req) {
  const cookie = String(req.headers.cookie || "");
  const m = cookie.match(/(?:^|;\s*)my_cloud_io_session=([^;]+)/);
  if (!m) return null;
  const p = verify(decodeURIComponent(m[1]));
  return p && p.type === "session" ? p : null;
}
function requireAuth(req, res, next) {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: "Authentication required" });
  req.cloudSession = s;
  next();
}
function requireDeletePassword(req, res, next) {
  if (isLocked(req, "delete")) return res.status(423).json({ error: "Delete access is locked for 24 hours on this device." });
  const pw = String(req.body?.deletePassword || "").trim();
  if (!DELETE_PASSWORD || !safeEqual(pw, DELETE_PASSWORD)) {
    const locked = fail(req, "delete");
    return res.status(locked ? 423 : 403).json({ error: locked ? "Delete access locked for 24 hours." : "Incorrect delete password." });
  }
  clearFail(req, "delete");
  next();
}
function cleanName(v) {
  return path.basename(String(v || "file")).replace(/[\u0000]/g, "").trim().slice(0, 240) || "file";
}
function cleanRelative(v) {
  const raw = String(v || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = raw.split("/").filter(Boolean).map(cleanName);
  return parts.join("/") || "file";
}
function newId() { return crypto.randomUUID(); }
function metaPath(id) { return `${META_PREFIX}${id}.json`; }
function parseId(v) {
  const id = String(v || "");
  if (!ID_RE.test(id)) throw new Error("Invalid upload id");
  return id;
}
function formatBytes(n) {
  let x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  const u = ["KB", "MB", "GB", "TB", "PB"];
  let i = -1;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)} ${u[i]}`;
}
function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".png":"image/png", ".gif":"image/gif", ".webp":"image/webp", ".svg":"image/svg+xml",
    ".mp4":"video/mp4", ".webm":"video/webm", ".mov":"video/quicktime", ".m4v":"video/mp4", ".mkv":"video/x-matroska",
    ".mp3":"audio/mpeg", ".wav":"audio/wav", ".m4a":"audio/mp4", ".ogg":"audio/ogg", ".aac":"audio/aac",
    ".pdf":"application/pdf", ".txt":"text/plain", ".json":"application/json", ".zip":"application/zip", ".rar":"application/vnd.rar",
    ".doc":"application/msword", ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls":"application/vnd.ms-excel", ".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt":"application/vnd.ms-powerpoint", ".pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  return map[ext] || "application/octet-stream";
}

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
app.use(express.static(PUBLIC_DIR, { extensions: ["html"], setHeaders(res) { res.setHeader("Cache-Control", "no-store"); } }));

app.post("/api/auth/login", (req, res) => {
  if (isLocked(req, "login")) return res.status(423).json({ error: "Access locked for 24 hours on this device." });
  const pw = String(req.body?.password || "").trim();
  if (!APP_PASSWORD || !safeEqual(pw, APP_PASSWORD)) {
    const locked = fail(req, "login");
    return res.status(locked ? 423 : 401).json({ error: locked ? "Access locked for 24 hours." : "Incorrect password" });
  }
  clearFail(req, "login");
  const token = sign({ type: "session", iat: Date.now(), exp: Date.now() + SESSION_TTL_MS });
  res.setHeader("Set-Cookie", `my_cloud_io_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; ${process.env.NODE_ENV === "production" ? "Secure; " : ""}Max-Age=${Math.floor(SESSION_TTL_MS/1000)}`);
  res.json({ ok: true });
});
app.get("/api/auth/me", (req, res) => res.json({ authenticated: Boolean(sessionFrom(req)) }));
app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", "my_cloud_io_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/health", (req, res) => res.json({ ok: true, storage: "vercel-blob", durable: true, completedFilesAutoDelete: false, chunkSize: CHUNK_SIZE }));

async function readMeta(pathname) {
  const r = await get(pathname, { access: "private", useCache: false });
  if (!r) return null;
  const chunks = [];
  for await (const c of r.stream) chunks.push(Buffer.from(c));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function writeMeta(meta) {
  return put(metaPath(meta.id), JSON.stringify(meta), {
    access: "private", allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60
  });
}
async function allMeta() {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix: META_PREFIX, limit: 1000, cursor, mode: "expanded" });
    for (const b of page.blobs || []) {
      try { const m = await readMeta(b.pathname); if (m && m.complete !== false) out.push(m); } catch (e) { console.error("META READ:", b.pathname, e.message); }
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  out.sort((a,b) => String(a.name).localeCompare(String(b.name)));
  return out;
}
async function findMetaByName(name) {
  const wanted = String(name || "");
  const files = await allMeta();
  return files.find(f => String(f.name) === wanted || String(f.relativePath || f.name) === wanted) || null;
}

app.get("/api/storage", requireAuth, async (req, res) => {
  try {
    const files = await allMeta();
    const total = files.reduce((n, f) => n + Number(f.size || 0), 0);
    res.json({ used: total, total, max: MAX_FILE_SIZE, files: files.length, maxFileSize: MAX_FILE_SIZE, formattedUsed: formatBytes(total), formattedMax: formatBytes(MAX_FILE_SIZE) });
  } catch (e) { res.status(500).json({ error: e.message || "Storage unavailable" }); }
});

app.get("/api/files", requireAuth, async (req, res) => {
  try {
    const files = await allMeta();
    res.json(files.map(f => ({
      id: f.id, name: f.name, relativePath: f.relativePath || f.name, size: f.size, sizeText: formatBytes(f.size), type: f.type || mimeFor(f.name), mimeType: f.type || mimeFor(f.name), uploadedAt: f.uploadedAt, modifiedAt: f.modifiedAt || f.uploadedAt
    })));
  } catch (e) { res.status(500).json({ error: e.message || "Could not list files" }); }
});

/*
  Direct browser -> Vercel Blob upload.
  This is intentionally used instead of POSTing file bytes through the
  Express function: Vercel documents a 4.5 MB Function request-body limit
  and recommends Blob client uploads for larger files.
*/
app.post("/api/blob-upload", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload, multipart) => {
        let payload = {};
        try { payload = JSON.parse(String(clientPayload || "{}")); } catch (_) {}
        const id = parseId(payload.id || newId());
        const name = cleanName(payload.name || path.basename(pathname));
        const relativePath = cleanRelative(payload.relativePath || name);
        const size = Number(payload.size || 0);
        const expectedPrefix = `${FILE_PREFIX}${id}/`;
        if (!String(pathname).startsWith(expectedPrefix)) throw new Error("Invalid upload pathname");
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_SIZE) throw new Error("File size exceeds the configured limit");
        return {
          addRandomSuffix: false,
          tokenPayload: JSON.stringify({ id, name, relativePath, size, type: String(payload.type || mimeFor(name)), multipart: Boolean(multipart) })
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        let p = {};
        try { p = JSON.parse(String(tokenPayload || "{}")); } catch (_) {}
        let existing = null;
        try { existing = await readMeta(metaPath(parseId(p.id))); } catch (_) {}
        if (existing) return;
        const meta = {
          id: parseId(p.id),
          name: cleanName(p.name),
          relativePath: cleanRelative(p.relativePath || p.name),
          size: Number(p.size || 0),
          type: String(p.type || mimeFor(p.name)),
          pathname: blob.pathname,
          url: blob.url,
          downloadUrl: blob.downloadUrl,
          etag: blob.etag,
          complete: true,
          uploadedAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString()
        };
        await writeMeta(meta);
      }
    });
    res.status(200).json(jsonResponse);
  } catch (e) {
    console.error("BLOB UPLOAD HANDSHAKE:", e);
    const msg = String(e?.message || e || "Upload service unavailable");
    const credentialError = /blob credentials|BLOB_READ_WRITE_TOKEN|BLOB_STORE_ID|OIDC|token/i.test(msg);
    res.status(400).json({
      error: credentialError
        ? "Vercel Blob is not connected. In Vercel open Storage → Blob, create/connect a PRIVATE Blob store to this project, then redeploy."
        : msg
    });
  }
});

app.post("/api/register-upload", requireAuth, async (req, res) => {
  try {
    const id = parseId(req.body?.id);
    const pathname = String(req.body?.pathname || "");
    const name = cleanName(req.body?.name || "file");
    const relativePath = cleanRelative(req.body?.relativePath || name);
    const size = Number(req.body?.size || 0);
    const type = String(req.body?.type || mimeFor(name));
    if (!pathname.startsWith(`${FILE_PREFIX}${id}/`)) throw new Error("Invalid storage path");
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_SIZE) throw new Error("Invalid file size");
    const blob = await head(pathname);
    if (Number(blob.size || 0) !== size) throw new Error(`Upload size mismatch: expected ${size}, received ${Number(blob.size || 0)}`);
    const meta = {
      id, name, relativePath, size, type, pathname,
      url: String(req.body?.url || ""),
      downloadUrl: String(req.body?.downloadUrl || ""),
      etag: String(req.body?.etag || blob.etag || ""),
      complete: true,
      uploadedAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString()
    };
    await writeMeta(meta);
    res.json({ ok: true, file: { id, name, relativePath, size, sizeText: formatBytes(size), type, mimeType: type, uploadedAt: meta.uploadedAt, modifiedAt: meta.modifiedAt } });
  } catch (e) {
    console.error("REGISTER UPLOAD:", e);
    res.status(400).json({ error: e.message || "Could not register uploaded file" });
  }
});

app.delete("/api/upload/:id", requireAuth, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const meta = await readMeta(metaPath(id));
    if (meta?.pathname) {
      try { await del(meta.pathname); } catch (_) {}
    }
    try { await del(metaPath(id)); } catch (_) {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message || "Could not cancel upload" }); }
});

async function streamFile(meta, req, res, attachment) {
  const size = Number(meta.size || 0);
  const mime = meta.type || mimeFor(meta.name);
  let start = 0, end = size - 1, partial = false;
  const range = String(req.headers.range || "");
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [a,b] = range.replace("bytes=", "").split("-");
    if (a === "") { const suffix = Number(b); start = Math.max(0, size - suffix); }
    else { start = Number(a); if (b) end = Math.min(size - 1, Number(b)); }
    if (start <= end && start < size) partial = true; else return res.status(416).set("Content-Range", `bytes */${size}`).end();
  }
  const r = await get(meta.pathname, { access: "private", useCache: false });
  if (!r) throw new Error("File not found in Vercel Blob");
  res.status(partial ? 206 : 200);
  res.setHeader("Content-Type", mime);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Length", String(Math.max(0, end - start + 1)));
  if (partial) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  if (attachment) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  let pos = 0;
  for await (const piece of r.stream) {
    if (res.destroyed) return;
    const buf = Buffer.from(piece);
    const pieceStart = pos;
    const pieceEnd = pos + buf.length - 1;
    if (pieceEnd >= start && pieceStart <= end) {
      const from = Math.max(0, start - pieceStart);
      const to = Math.min(buf.length, end - pieceStart + 1);
      if (to > from) res.write(buf.subarray(from, to));
    }
    pos += buf.length;
    if (pos > end) break;
  }
  res.end();
}

async function resolveMeta(req, nameParam) {
  const raw = decodeURIComponent(String(nameParam || ""));
  let meta = null;
  if (ID_RE.test(raw)) {
    try { meta = await readMeta(metaPath(raw)); } catch (_) {}
  }
  if (!meta) meta = await findMetaByName(raw);
  return meta;
}

app.get("/api/stream/{*path}", requireAuth, async (req, res) => {
  try { const name = req.params.path; const meta = await resolveMeta(req, name); if (!meta) return res.status(404).json({ error: "File not found" }); await streamFile(meta, req, res, false); }
  catch (e) { console.error("STREAM:", e); if (!res.headersSent) res.status(500).json({ error: e.message || "Stream failed" }); else res.destroy(e); }
});
app.get("/api/download/{*path}", requireAuth, async (req, res) => {
  try { const name = req.params.path; const meta = await resolveMeta(req, name); if (!meta) return res.status(404).json({ error: "File not found" }); await streamFile(meta, req, res, true); }
  catch (e) { console.error("DOWNLOAD:", e); if (!res.headersSent) res.status(500).json({ error: e.message || "Download failed" }); else res.destroy(e); }
});

app.patch("/api/files", requireAuth, async (req, res) => {
  try {
    const oldName = String(req.body?.name || "");
    const newName = cleanName(req.body?.newName || req.body?.rename || "");
    if (!oldName || !newName) return res.status(400).json({ error: "Name is required" });
    const meta = await findMetaByName(oldName);
    if (!meta) return res.status(404).json({ error: "File not found" });
    const oldBase = meta.relativePath || meta.name;
    meta.name = newName;
    if (meta.relativePath) {
      const parts = meta.relativePath.split("/");
      parts[parts.length - 1] = newName;
      meta.relativePath = parts.join("/");
    } else meta.relativePath = newName;
    meta.modifiedAt = new Date().toISOString();
    await writeMeta(meta);
    res.json({ ok: true, file: { ...meta, sizeText: formatBytes(meta.size) }, oldName: oldBase });
  } catch (e) { res.status(500).json({ error: e.message || "Rename failed" }); }
});

app.delete("/api/files", requireAuth, requireDeletePassword, async (req, res) => {
  try {
    const name = String(req.body?.name || "");
    const meta = await findMetaByName(name);
    if (!meta) return res.status(404).json({ error: "File not found" });
    if (meta.pathname) await del(meta.pathname);
    await del(metaPath(meta.id));
    res.json({ ok: true, deleted: name });
  } catch (e) { res.status(500).json({ error: e.message || "Delete failed" }); }
});

app.post("/api/share", requireAuth, async (req, res) => {
  try {
    const meta = await findMetaByName(String(req.body?.name || ""));
    if (!meta) return res.status(404).json({ error: "File not found" });
    const token = sign({ type: "share", id: meta.id, exp: Date.now() + 24 * 60 * 60 * 1000 });
    res.json({ ok: true, url: `${req.protocol}://${req.get("host")}/api/shared-access?token=${encodeURIComponent(token)}` });
  } catch (e) { res.status(500).json({ error: e.message || "Share failed" }); }
});
app.get("/api/shared-access", async (req, res) => {
  try {
    const p = verify(String(req.query.token || ""));
    if (!p || p.type !== "share") return res.status(401).json({ error: "Invalid or expired share link" });
    const meta = await readMeta(metaPath(p.id));
    if (!meta) return res.status(404).json({ error: "File not found" });
    await streamFile(meta, req, res, true);
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message || "Share failed" }); else res.destroy(e); }
});

app.get("/api/download-all", requireAuth, async (req, res) => {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="my-personal-cloud-all-storage.zip"');
  res.setHeader("Cache-Control", "private, no-store");
  const archive = archiver("zip", { zlib: { level: 0 } });
  archive.on("error", err => { if (!res.headersSent) res.status(500); res.destroy(err); });
  archive.pipe(res);
  try {
    const files = await allMeta();
    for (const meta of files) {
      const r = await get(meta.pathname, { access: "private", useCache: false });
      if (!r) throw new Error(`Missing file for ${meta.name}`);
      archive.append(Readable.fromWeb(r.stream), { name: meta.relativePath || meta.name });
    }
    await archive.finalize();
  } catch (e) { console.error("ZIP:", e); try { archive.abort(); } catch (_) {} if (!res.destroyed) res.destroy(e); }
});

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.use((err, req, res, next) => { console.error("UNHANDLED:", err); if (!res.headersSent) res.status(500).json({ error: "Internal server error" }); else next(err); });

if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, "0.0.0.0", () => console.log(`[My-cloud-io] Local server on ${PORT}`));
}

module.exports = app;
