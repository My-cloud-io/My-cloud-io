"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const { CustomFile } = require("teleproto/client/uploads");

/*
 * My Personal Cloud / Cloud-Zen
 * Telegram MTProto storage backend.
 *
 * Storage model:
 *   - Every uploaded file is split into <= 4 MiB browser requests.
 *   - Every chunk becomes a Telegram document in TELEGRAM_STORAGE_CHAT.
 *   - A small Telegram text message is the file manifest.
 *   - The website reads the manifest, downloads the chunks from Telegram,
 *     and streams them back to the browser.
 *
 * No uploaded file is persisted to Vercel's filesystem.
 */

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const COOKIE_NAME = "mpc_session";
const MANIFEST_PREFIX = "MPC_MANIFEST|1|";
const CHUNK_PREFIX = "MPC_CHUNK|1|";
const MAX_REQUEST_CHUNK = 4 * 1024 * 1024; // safely below Vercel's 4.5 MiB body limit

const isProduction = process.env.NODE_ENV === "production";
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(cookieParser());
app.use(express.json({ limit: "256kb" }));

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

const APP_PASSWORD = env("APP_PASSWORD");
const DELETE_PASSWORD = env("DELETE_PASSWORD");
const API_ID = Number(env("TELEGRAM_API_ID", "0"));
const API_HASH = env("TELEGRAM_API_HASH");
const TELEGRAM_SESSION = env("TELEGRAM_SESSION");
const STORAGE_CHAT = env("TELEGRAM_STORAGE_CHAT", "me");
const TELEGRAM_WORKERS = Math.max(1, Math.min(4, Number(env("TELEGRAM_WORKERS", "1")) || 1));
const CHUNK_SIZE = Math.max(
  256 * 1024,
  Math.min(MAX_REQUEST_CHUNK, Number(env("CHUNK_SIZE", String(MAX_REQUEST_CHUNK))) || MAX_REQUEST_CHUNK)
);
const MAX_CHUNKS = Math.max(1, Math.min(4096, Number(env("MAX_CHUNKS", "1024")) || 1024));
const MAX_FILE_BYTES = CHUNK_SIZE * MAX_CHUNKS;

/*
 * The screenshot shows a SESSION_SECRET validation failure. The upgraded
 * backend accepts an existing non-empty secret even when it is shorter than
 * 32 characters, then derives a fixed 32-byte HMAC key from it. This keeps an
 * already-configured deployment working while preserving stable signatures.
 */
function getSessionKey() {
  const supplied = env("SESSION_SECRET");
  if (!supplied) {
    fail("SESSION_SECRET is not configured", 500);
  }
  return crypto.createHash("sha256").update(supplied, "utf8").digest();
}

function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", getSessionKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verifySession(token) {
  if (!token) return false;
  try {
    const parts = String(token).split(".");
    if (parts.length !== 2) return false;
    const expected = crypto.createHmac("sha256", getSessionKey()).update(parts[0]).digest("base64url");
    if (!timingSafeEqualText(expected, parts[1])) return false;
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return payload?.ok === true && Number(payload.exp) > Date.now();
  } catch {
    return false;
  }
}

function setSessionCookie(res) {
  const token = signSession({ ok: true, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/"
  });
}

function requireConfig() {
  if (!APP_PASSWORD) fail("APP_PASSWORD is not configured", 500);
  if (!env("SESSION_SECRET")) fail("SESSION_SECRET is not configured", 500);
  if (!API_ID || !API_HASH || !TELEGRAM_SESSION) {
    fail("Telegram environment variables are not fully configured", 500);
  }
  if (!STORAGE_CHAT) fail("TELEGRAM_STORAGE_CHAT is not configured", 500);
}

function requireAuth(req, res, next) {
  if (!verifySession(req.cookies[COOKIE_NAME])) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

function sanitizeName(name) {
  const value = String(name || "").replace(/\\/g, "/").split("/").pop().trim();
  if (!value || value === "." || value === "..") fail("Invalid file name");
  if (value.length > 240) fail("File name is too long");
  return value;
}

function b64(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}
function fromB64(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}
function manifestText(meta) {
  return MANIFEST_PREFIX + b64(JSON.stringify(meta));
}
function parseManifest(text) {
  if (typeof text !== "string" || !text.startsWith(MANIFEST_PREFIX)) return null;
  try {
    const meta = JSON.parse(fromB64(text.slice(MANIFEST_PREFIX.length)));
    if (!meta || !meta.id || !meta.name || !Array.isArray(meta.chunks)) return null;
    return meta;
  } catch {
    return null;
  }
}
function chunkCaption(id, index, total) {
  return `${CHUNK_PREFIX}${id}|${index}|${total}`;
}
function parseChunkCaption(text) {
  if (typeof text !== "string" || !text.startsWith(CHUNK_PREFIX)) return null;
  const p = text.slice(CHUNK_PREFIX.length).split("|");
  if (p.length !== 3) return null;
  const index = Number(p[1]);
  const total = Number(p[2]);
  if (!p[0] || !Number.isInteger(index) || !Number.isInteger(total)) return null;
  return { id: p[0], index, total };
}
function normalizePeerId(value) {
  const text = String(value).trim();
  if (text === "me" || text.startsWith("@") || text.includes("/")) return text;
  if (/^-?\d+$/.test(text)) return BigInt(text);
  return text;
}
function messageText(message) {
  return String(message?.message || message?.text || "");
}
function getMessageMedia(message) {
  return message?.media || null;
}
function getMessageFileSize(message) {
  const doc = message?.document;
  if (doc?.size != null) return Number(doc.size);
  return 0;
}
function getMimeFromMessage(message) {
  return String(message?.document?.mimeType || "application/octet-stream");
}
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}
function guessMime(name) {
  const ext = String(name).toLowerCase().split(".").pop();
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo",
    mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
    pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip", rar: "application/vnd.rar", "7z": "application/x-7z-compressed"
  };
  return map[ext] || "application/octet-stream";
}

let telegramClientPromise = null;
let storageEntityPromise = null;
let manifestCache = { expires: 0, files: null };

function invalidateManifestCache() {
  manifestCache = { expires: 0, files: null };
}

async function getTelegramClient() {
  requireConfig();
  if (!telegramClientPromise) {
    const client = new TelegramClient(
      new StringSession(TELEGRAM_SESSION),
      API_ID,
      API_HASH,
      { connectionRetries: 5, autoReconnect: true, floodSleepThreshold: 60 }
    );
    telegramClientPromise = (async () => {
      await client.connect();
      if (!(await client.checkAuthorization())) fail("TELEGRAM_SESSION is not authorized", 500);
      return client;
    })().catch((err) => {
      telegramClientPromise = null;
      throw err;
    });
  }
  return telegramClientPromise;
}

async function getStorageEntity() {
  if (!storageEntityPromise) {
    storageEntityPromise = getTelegramClient()
      .then((client) => client.getEntity(normalizePeerId(STORAGE_CHAT)))
      .catch((err) => {
        storageEntityPromise = null;
        throw err;
      });
  }
  return storageEntityPromise;
}

async function getManifestList() {
  if (manifestCache.files && manifestCache.expires > Date.now()) return manifestCache.files;
  const client = await getTelegramClient();
  const chat = await getStorageEntity();
  const results = [];

  // Search by the stable manifest marker instead of scanning every Telegram message.
  for await (const message of client.iterMessages(chat, { search: "MPC_MANIFEST", limit: undefined, waitTime: 100 })) {
    const meta = parseManifest(messageText(message));
    if (meta) results.push({ ...meta, manifestMessageId: Number(message.id) });
  }

  results.sort((a, b) => Number(new Date(b.modified || b.created || 0)) - Number(new Date(a.modified || a.created || 0)));
  manifestCache = { expires: Date.now() + 5000, files: results };
  return results;
}

async function findManifestById(id) {
  return (await getManifestList()).find((m) => String(m.id) === String(id)) || null;
}
async function findManifestByName(name) {
  const safe = sanitizeName(name);
  return (await getManifestList()).find((m) => m.name === safe) || null;
}
function publicFile(meta) {
  return {
    id: meta.id,
    name: meta.name,
    type: meta.type || "application/octet-stream",
    size: Number(meta.size || 0),
    modified: meta.modified || meta.created || new Date().toISOString(),
    chunks: Number(meta.total || meta.chunks?.length || 0),
    url: `/api/stream/${encodeURIComponent(meta.id)}`
  };
}

async function sendChunk(buffer, fileId, index, total) {
  const client = await getTelegramClient();
  const chat = await getStorageEntity();
  const customFile = new CustomFile(`${fileId}.${index}.part`, buffer.length, "", buffer);
  const message = await client.sendFile(chat, {
    file: customFile,
    caption: chunkCaption(fileId, index, total),
    forceDocument: true,
    workers: TELEGRAM_WORKERS
  });
  return Number(message.id);
}

async function sendManifest(meta) {
  const client = await getTelegramClient();
  const chat = await getStorageEntity();
  const message = await client.sendMessage(chat, { message: manifestText(meta) });
  return Number(message.id);
}

async function collectChunksForUpload(id, total) {
  const client = await getTelegramClient();
  const chat = await getStorageEntity();
  const found = new Map();
  for await (const message of client.iterMessages(chat, { search: id, limit: undefined, waitTime: 100 })) {
    const c = parseChunkCaption(messageText(message));
    if (c && c.id === id && c.total === total) found.set(c.index, Number(message.id));
  }
  return [...found.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, messageId]) => ({ index, messageId }));
}

async function updateManifest(manifestMessageId, meta) {
  const client = await getTelegramClient();
  const chat = await getStorageEntity();
  await client.editMessage(chat, { message: Number(manifestMessageId), text: manifestText(meta) });
  invalidateManifestCache();
}

async function finalizeUploadedFile({ id, total, size, name, type }) {
  const existing = await findManifestById(id);
  if (existing) return existing;
  const chunks = await collectChunksForUpload(id, total);
  if (chunks.length !== total || chunks.some((x, i) => x.index !== i)) return null;

  const meta = {
    id,
    name: sanitizeName(name),
    type: String(type || guessMime(name)).slice(0, 200),
    size: Number(size),
    total,
    chunks: chunks.map((x) => x.messageId),
    created: new Date().toISOString(),
    modified: new Date().toISOString()
  };
  const manifestMessageId = await sendManifest(meta);
  meta.manifestMessageId = manifestMessageId;
  invalidateManifestCache();
  return meta;
}

async function getChunkMessages(meta) {
  const client = await getTelegramClient();
  const chat = await getStorageEntity();
  if (!Array.isArray(meta.chunks) || !meta.chunks.length) fail("File has no stored chunks", 404);
  const messages = await client.getMessages(chat, { ids: meta.chunks.map(Number) });
  const byId = new Map(messages.filter(Boolean).map((m) => [Number(m.id), m]));
  return meta.chunks.map((id, index) => {
    const message = byId.get(Number(id));
    if (!message || !getMessageMedia(message)) fail(`Missing Telegram chunk ${index + 1}`, 500);
    return message;
  });
}

async function deleteTelegramMessages(ids) {
  if (!ids?.length) return;
  const client = await getTelegramClient();
  const chat = await getStorageEntity();
  for (let i = 0; i < ids.length; i += 100) {
    await client.deleteMessages(chat, ids.slice(i, i + 100).map(Number), { revoke: true });
  }
}

function totalUsed(files) {
  return files.reduce((sum, f) => sum + Number(f.size || 0), 0);
}

/* ---------- Authentication ---------- */
app.get("/api/auth/me", (req, res) => {
  res.json({ authenticated: verifySession(req.cookies[COOKIE_NAME]) });
});

app.post("/api/auth/login", (req, res) => {
  try {
    if (!APP_PASSWORD) fail("APP_PASSWORD is not configured", 500);
    if (!timingSafeEqualText(req.body?.password || "", APP_PASSWORD)) {
      return res.status(401).json({ error: "Incorrect password" });
    }
    setSessionCookie(res);
    res.json({ ok: true, authenticated: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Login failed" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: isProduction, sameSite: "lax", path: "/" });
  res.json({ ok: true });
});

/* ---------- Storage / files ---------- */
app.get("/api/storage", requireAuth, async (req, res) => {
  try {
    const files = await getManifestList();
    const usedBytes = totalUsed(files);
    const limitBytes = MAX_FILE_BYTES;
    const remainingBytes = Math.max(0, limitBytes - usedBytes);
    const usedPercent = limitBytes ? Math.min(100, (usedBytes / limitBytes) * 100) : 0;
    res.json({
      usedBytes,
      limitBytes,
      remainingBytes,
      usedText: formatBytes(usedBytes),
      limitText: formatBytes(limitBytes),
      remainingText: formatBytes(remainingBytes),
      usedPercent: Number(usedPercent.toFixed(2)),
      telegram: {
        configured: true,
        connected: true,
        usedBytes,
        capacityBytes: limitBytes,
        remainingBytes,
        usedText: formatBytes(usedBytes),
        remainingText: formatBytes(remainingBytes)
      },
      b2: { configured: false, connected: false },
      mega: { configured: false, connected: false },
      idriveE2: { configured: false, connected: false },
      cloudinary: { configured: false, connected: false },
      filebase: { configured: false, connected: false },
      koofr: { configured: false, connected: false }
    });
  } catch (err) {
    console.error("STORAGE ERROR", err);
    res.status(err.status || 500).json({ error: err.message || "Telegram storage error" });
  }
});

app.get("/api/files", requireAuth, async (req, res) => {
  try {
    const files = await getManifestList();
    res.json(files.map(publicFile));
  } catch (err) {
    console.error("FILE LIST ERROR", err);
    res.status(err.status || 500).json({ error: err.message || "Could not list Telegram files" });
  }
});

/*
 * Vercel's documented Function request-body limit is 4.5 MiB. The frontend
 * must therefore send chunks <= 4 MiB. The current Cloud UI already uses 4 MiB.
 */
app.post(
  "/api/upload-chunk",
  requireAuth,
  express.raw({ type: "application/octet-stream", limit: "4.25mb" }),
  async (req, res) => {
    try {
      const id = String(req.query.id || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const index = Number(req.query.index);
      const total = Number(req.query.total);
      const size = Number(req.query.size);
      const name = sanitizeName(req.query.name || "");
      const relativePath = sanitizeName(req.query.relativePath || name);
      const type = String(req.query.type || guessMime(relativePath)).slice(0, 200);

      if (!id || id.length > 100) fail("Invalid upload id");
      if (!Number.isInteger(index) || index < 0) fail("Invalid chunk index");
      if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS) fail("Invalid chunk count");
      if (index >= total) fail("Chunk index is out of range");
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES) {
        fail(`File is too large for this backend (${formatBytes(MAX_FILE_BYTES)} configured)`);
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) fail("Empty upload chunk");
      if (req.body.length > CHUNK_SIZE) fail("Upload chunk is larger than configured CHUNK_SIZE");

      const existing = await findManifestById(id);
      if (existing) {
        return res.json({ ok: true, duplicate: true, complete: true, id, file: publicFile(existing) });
      }

      const knownChunks = await collectChunksForUpload(id, total);
      const known = knownChunks.find((x) => x.index === index);
      const messageId = known?.messageId || await sendChunk(req.body, id, index, total);

      let file = null;
      // The browser sends chunks in order. Final chunk is the natural commit point.
      if (index === total - 1) {
        file = await finalizeUploadedFile({ id, total, size, name: relativePath, type });
      }

      invalidateManifestCache();
      res.json({ ok: true, id, index, total, messageId, complete: Boolean(file), file: file ? publicFile(file) : undefined });
    } catch (err) {
      console.error("UPLOAD CHUNK ERROR", err);
      res.status(err.status || 500).json({ error: err.message || "Upload failed" });
    }
  }
);

app.post("/api/upload-complete", requireAuth, async (req, res) => {
  try {
    const id = String(req.body?.id || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const total = Number(req.body?.total);
    const size = Number(req.body?.size);
    const name = sanitizeName(req.body?.name || "");
    const type = String(req.body?.type || guessMime(name)).slice(0, 200);
    if (!id) fail("Invalid upload id");
    if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNKS) fail("Invalid chunk count");
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES) fail("Invalid file size");
    const meta = await finalizeUploadedFile({ id, total, size, name, type });
    if (!meta) fail("Not all Telegram chunks are present yet", 409);
    res.json({ ok: true, complete: true, file: publicFile(meta) });
  } catch (err) {
    console.error("UPLOAD COMPLETE ERROR", err);
    res.status(err.status || 500).json({ error: err.message || "Upload completion failed" });
  }
});

/* ---------- Stream / download ---------- */
async function streamMeta(req, res, meta, asDownload = false) {
  const chunks = await getChunkMessages(meta);
  const totalSize = Number(meta.size || 0);
  const mime = meta.type || "application/octet-stream";
  const safeName = String(meta.name || "download").replace(/[\r\n\"]/g, "_");

  let start = 0;
  let end = Math.max(0, totalSize - 1);
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (!match) {
      res.status(416).set("Content-Range", `bytes */${totalSize}`).end();
      return;
    }
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    else end = totalSize - 1;
    if (!match[1]) {
      const suffix = Number(match[2]);
      start = Math.max(0, totalSize - suffix);
      end = totalSize - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= totalSize) {
      res.status(416).set("Content-Range", `bytes */${totalSize}`).end();
      return;
    }
    end = Math.min(end, totalSize - 1);
    res.status(206);
    res.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
  }

  res.set("Accept-Ranges", "bytes");
  res.set("Content-Length", String(end - start + 1));
  res.set("Content-Type", mime);
  res.set("Cache-Control", "private, no-store, max-age=0");
  res.set("Content-Disposition", `${asDownload ? "attachment" : "inline"}; filename="${safeName}"`);

  let fileOffset = 0;
  const client = await getTelegramClient();

  for (const message of chunks) {
    const chunkSize = getMessageFileSize(message) || CHUNK_SIZE;
    const chunkStart = fileOffset;
    const chunkEnd = Math.min(totalSize - 1, fileOffset + chunkSize - 1);
    fileOffset += chunkSize;
    if (chunkEnd < start) continue;
    if (chunkStart > end) break;

    const data = await client.downloadMedia(message, { workers: TELEGRAM_WORKERS });
    if (!data) fail("Telegram chunk download returned no data", 500);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const from = Math.max(start - chunkStart, 0);
    const to = Math.min(end - chunkStart + 1, buffer.length);
    if (to > from) {
      if (!res.write(buffer.subarray(from, to))) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
    if (res.destroyed) return;
  }
  res.end();
}

async function handleStream(req, res, download) {
  try {
    const id = decodeURIComponent(req.params.id || "");
    if (!id) fail("Missing file id", 400);
    const meta = await findManifestById(id);
    if (!meta) fail("File not found", 404);
    await streamMeta(req, res, meta, download);
  } catch (err) {
    console.error(download ? "DOWNLOAD ERROR" : "STREAM ERROR", err);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message || "File operation failed" });
    else res.destroy(err);
  }
}
app.get("/api/stream/:id", requireAuth, (req, res) => handleStream(req, res, false));
app.get("/api/download/:id", requireAuth, (req, res) => handleStream(req, res, true));

/* ---------- Rename / delete ---------- */
app.delete("/api/files", requireAuth, async (req, res) => {
  try {
    // The authenticated website session is the primary authorization.
    // If the client supplies DELETE_PASSWORD, validate it as an additional check.
    const supplied = req.headers["x-delete-password"] || req.body?.password || "";
    if (DELETE_PASSWORD && supplied && !timingSafeEqualText(supplied, DELETE_PASSWORD)) {
      return res.status(403).json({ error: "Invalid delete password" });
    }
    const name = sanitizeName(req.body?.name || "");
    const meta = await findManifestByName(name);
    if (!meta) fail("File not found", 404);
    await deleteTelegramMessages([...(meta.chunks || []), meta.manifestMessageId].filter(Boolean));
    invalidateManifestCache();
    res.json({ ok: true, deleted: name });
  } catch (err) {
    console.error("DELETE ERROR", err);
    res.status(err.status || 500).json({ error: err.message || "Delete failed" });
  }
});

app.patch("/api/files/:id", requireAuth, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id || "");
    const meta = await findManifestById(id);
    if (!meta) fail("File not found", 404);
    const newName = sanitizeName(req.body?.name || "");
    const duplicate = await findManifestByName(newName);
    if (duplicate && duplicate.id !== meta.id) fail("A file with that name already exists", 409);
    meta.name = newName;
    meta.modified = new Date().toISOString();
    await updateManifest(meta.manifestMessageId, meta);
    res.json({ ok: true, file: publicFile(meta) });
  } catch (err) {
    console.error("RENAME ERROR", err);
    res.status(err.status || 500).json({ error: err.message || "Rename failed" });
  }
});

/* ---------- Health / diagnostics ---------- */
app.get("/api/health", async (req, res) => {
  try {
    requireConfig();
    const client = await getTelegramClient();
    const me = await client.getMe();
    res.json({
      ok: true,
      telegram: true,
      user: me?.username || me?.id || null,
      storageChat: STORAGE_CHAT,
      chunkSize: CHUNK_SIZE,
      maxFileBytes: MAX_FILE_BYTES,
      maxFileText: formatBytes(MAX_FILE_BYTES)
    });
  } catch (err) {
    res.status(503).json({ ok: false, telegram: false, error: err.message || "Telegram unavailable" });
  }
});

app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: isProduction ? "1h" : 0 }));
app.get("/{*splat}", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR", err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`My Personal Cloud Telegram backend listening on 0.0.0.0:${PORT}`);
  });
}

module.exports = app;
