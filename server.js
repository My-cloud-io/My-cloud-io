"use strict";

/*
  CLOUD-ZEN / MY PERSONAL CLOUD
  Telegram-only storage backend.

  Storage provider:
    Telegram MTProto account + TELEGRAM_STORAGE_CHAT

  No Backblaze B2, MEGA, IDrive E2, Cloudinary, Filebase or Koofr code is used.

  Important Vercel constraint:
    Vercel Functions have a small request-body limit, so the browser uploads
    small chunks. Each chunk becomes one Telegram document message. The
    metadata in the caption lets the website rebuild the original file for
    listing, preview, download, rename and delete without a separate database.
*/

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");

const app = express();

/* ----------------------------- configuration ---------------------------- */

const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = String(process.env.APP_PASSWORD || "");
const DELETE_PASSWORD = String(process.env.DELETE_PASSWORD || APP_PASSWORD);
const SESSION_SECRET = String(process.env.SESSION_SECRET || "");
const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const TELEGRAM_API_HASH = String(process.env.TELEGRAM_API_HASH || "");
const TELEGRAM_SESSION = String(process.env.TELEGRAM_SESSION || "");
const TELEGRAM_STORAGE_CHAT = String(process.env.TELEGRAM_STORAGE_CHAT || "");
const TELEGRAM_WORKERS = Math.max(1, Math.min(8, Number(process.env.TELEGRAM_WORKERS || 2)));

// Keep this at or below the Vercel request-body ceiling.
const CHUNK_SIZE = Math.max(
  256 * 1024,
  Math.min(4 * 1024 * 1024, Number(process.env.CHUNK_SIZE || 4 * 1024 * 1024))
);

const MAX_FILE_SIZE = Math.max(
  CHUNK_SIZE,
  Number(process.env.MAX_FILE_SIZE || 4 * 1024 * 1024 * 1024)
);

const FILE_MARKER = "CLOUDZEN1";
const COOKIE_NAME = "cloud_session";
const PUBLIC_DIR = path.join(__dirname, "public");

if (!APP_PASSWORD) console.warn("APP_PASSWORD is not set.");
if (!SESSION_SECRET) console.warn("SESSION_SECRET is not set.");
if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH || !TELEGRAM_SESSION || !TELEGRAM_STORAGE_CHAT) {
  console.warn("Telegram environment is incomplete. Set TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION and TELEGRAM_STORAGE_CHAT.");
}

/* ----------------------------- body parsing ------------------------------ */

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "256kb" }));

/* ------------------------------- sessions -------------------------------- */

const sessions = new Map();
const loginAttempts = new Map();

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sessionSignature(token) {
  return crypto.createHmac("sha256", SESSION_SECRET || "missing-secret").update(token).digest("base64url");
}

function createSession() {
  const token = `${randomToken(32)}.${sessionSignature(randomToken(1))}`;
  // Store only a hash; the cookie contains the opaque session value.
  const id = randomToken(32);
  const digest = crypto.createHash("sha256").update(id).digest("hex");
  sessions.set(digest, Date.now() + 7 * 24 * 60 * 60 * 1000);
  return id;
}

function cookieValue(req) {
  const raw = String(req.headers.cookie || "");
  const match = raw.split(";").map(x => x.trim()).find(x => x.startsWith(`${COOKIE_NAME}=`));
  return match ? decodeURIComponent(match.slice(COOKIE_NAME.length + 1)) : "";
}

function isAuthenticated(req) {
  const id = cookieValue(req);
  if (!id) return false;
  const digest = crypto.createHash("sha256").update(id).digest("hex");
  const expiry = sessions.get(digest);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    sessions.delete(digest);
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: "Authentication required" });
  next();
}

function clearSession(req, res) {
  const id = cookieValue(req);
  if (id) sessions.delete(crypto.createHash("sha256").update(id).digest("hex"));
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function loginAllowed(ip) {
  const now = Date.now();
  const old = loginAttempts.get(ip);
  if (!old || now - old.time > 15 * 60 * 1000) return true;
  return old.count < 10;
}

/* --------------------------- Telegram connection ------------------------- */

let telegramClient = null;
let telegramReady = null;
let telegramEntity = null;

async function getTelegramClient() {
  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH || !TELEGRAM_SESSION || !TELEGRAM_STORAGE_CHAT) {
    throw new Error("Telegram storage is not configured. Check TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION and TELEGRAM_STORAGE_CHAT.");
  }

  if (telegramClient && telegramReady) {
    await telegramReady;
    return telegramClient;
  }

  if (!telegramClient) {
    telegramClient = new TelegramClient(
      new StringSession(TELEGRAM_SESSION),
      TELEGRAM_API_ID,
      TELEGRAM_API_HASH,
      { connectionRetries: 5 }
    );
  }

  if (!telegramReady) {
    telegramReady = (async () => {
      await telegramClient.connect();
      const authorized = await telegramClient.isUserAuthorized();
      if (!authorized) throw new Error("Telegram session is not authorized. Generate a valid TELEGRAM_SESSION and add it to Vercel.");
      telegramEntity = await telegramClient.getEntity(TELEGRAM_STORAGE_CHAT);
      return telegramEntity;
    })().catch(err => {
      telegramReady = null;
      throw err;
    });
  }

  await telegramReady;
  return telegramClient;
}

async function getTelegramEntity() {
  await getTelegramClient();
  return telegramEntity;
}

/* ----------------------------- file metadata ----------------------------- */

function cleanName(name) {
  let value = String(name || "file").replace(/\\/g, "/").split("/").pop();
  value = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!value) value = "file";
  return value.slice(0, 240);
}

function cleanRelativePath(name) {
  // Keep the UI contract, but do not allow traversal.
  const parts = String(name || "").replace(/\\/g, "/").split("/").filter(Boolean);
  const safe = parts.filter(p => p !== "." && p !== "..").map(p => p.replace(/[\u0000-\u001f\u007f]/g, "").trim()).filter(Boolean);
  return safe.length ? safe.join("/").slice(0, 500) : "file";
}

function encodeCaption(meta) {
  return `${FILE_MARKER}|${JSON.stringify(meta)}`;
}

function decodeCaption(text) {
  const value = String(text || "");
  if (!value.startsWith(`${FILE_MARKER}|`)) return null;
  try {
    const parsed = JSON.parse(value.slice(FILE_MARKER.length + 1));
    if (!parsed || parsed.v !== 1 || !parsed.id) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function isTelegramDocumentMessage(message) {
  return Boolean(message && message.media && message.media.document);
}

function messageFileSize(message) {
  return Number(message?.media?.document?.size || 0);
}

function messageMime(message) {
  return String(message?.media?.document?.mimeType || "application/octet-stream");
}

function getDocumentName(message) {
  const attrs = message?.media?.document?.attributes || [];
  for (const attr of attrs) {
    if (attr && typeof attr.fileName === "string" && attr.fileName) return attr.fileName;
  }
  return "file";
}

/* ------------------------------ catalog ---------------------------------- */

async function collectCloudMessages() {
  const client = await getTelegramClient();
  const chat = await getTelegramEntity();
  const groups = new Map();

  // Search is much cheaper than downloading all chat history and only matches
  // captions produced by this application.
  for await (const message of client.iterMessages(chat, { search: FILE_MARKER, limit: 10000 })) {
    const meta = decodeCaption(message?.text || message?.message || "");
    if (!meta || !isTelegramDocumentMessage(message)) continue;
    if (!groups.has(meta.id)) groups.set(meta.id, { meta, chunks: [] });
    groups.get(meta.id).chunks.push({ index: Number(meta.i), messageId: Number(message.id), size: messageFileSize(message) });
  }

  const files = [];
  for (const group of groups.values()) {
    const { meta } = group;
    const chunks = group.chunks.sort((a, b) => a.index - b.index);
    const total = Number(meta.total || 0);
    const complete = total > 0 && chunks.length === total && chunks.every((c, i) => c.index === i);
    if (!complete) continue;

    files.push({
      name: cleanRelativePath(meta.name),
      size: Number(meta.size || chunks.reduce((n, c) => n + c.size, 0)),
      mimeType: String(meta.mime || "application/octet-stream"),
      storage: "TELEGRAM",
      updatedAt: Number(meta.updatedAt || meta.createdAt || Date.now()),
      uploadId: meta.id,
      chunks: chunks.map(c => c.messageId),
      chunkCount: total
    });
  }

  files.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return files;
}

async function findFile(name) {
  const target = cleanRelativePath(name);
  const files = await collectCloudMessages();
  return files.find(f => f.name === target) || null;
}

async function findFileById(uploadId) {
  const files = await collectCloudMessages();
  return files.find(f => f.uploadId === uploadId) || null;
}

/* ------------------------------- uploads --------------------------------- */

const uploadLocks = new Map();

async function withUploadLock(id, fn) {
  const previous = uploadLocks.get(id) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  uploadLocks.set(id, previous.then(() => current));
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (uploadLocks.get(id) === current) uploadLocks.delete(id);
  }
}

function validUploadId(id) {
  return /^[A-Za-z0-9_-]{12,80}$/.test(id);
}

function parseUploadParams(req) {
  const id = String(req.query.id || "");
  const index = Number(req.query.index);
  const total = Number(req.query.total);
  const size = Number(req.query.size);
  const name = cleanRelativePath(req.query.relativePath || req.query.name || "file");
  const mime = String(req.query.mime || "application/octet-stream").slice(0, 180);

  if (!validUploadId(id)) throw Object.assign(new Error("Invalid upload ID"), { statusCode: 400 });
  if (!Number.isInteger(index) || index < 0) throw Object.assign(new Error("Invalid chunk index"), { statusCode: 400 });
  if (!Number.isInteger(total) || total < 1 || total > Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE) + 2) throw Object.assign(new Error("Invalid chunk count"), { statusCode: 400 });
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_SIZE) throw Object.assign(new Error("File is too large"), { statusCode: 413 });
  if (index >= total) throw Object.assign(new Error("Chunk index out of range"), { statusCode: 400 });
  return { id, index, total, size, name, mime };
}

async function sendChunkToTelegram(buffer, params) {
  const client = await getTelegramClient();
  const chat = await getTelegramEntity();

  const caption = encodeCaption({
    v: 1,
    id: params.id,
    i: params.index,
    total: params.total,
    size: params.size,
    name: params.name,
    mime: params.mime,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  const fileName = `${params.id}.${String(params.index).padStart(7, "0")}.part`;
  return client.sendFile(chat, {
    file: buffer,
    caption,
    forceDocument: true,
    fileName,
    workers: TELEGRAM_WORKERS
  });
}

/* ------------------------------- API ------------------------------------- */

app.post("/api/auth/login", (req, res) => {
  const ip = req.ip || "unknown";
  if (!loginAllowed(ip)) return res.status(429).json({ error: "Too many login attempts. Try again later." });
  if (!APP_PASSWORD) return res.status(503).json({ error: "APP_PASSWORD is not configured." });

  if (!safeEqual(req.body?.password || "", APP_PASSWORD)) {
    const item = loginAttempts.get(ip) || { count: 0, time: Date.now() };
    item.count += 1;
    item.time = Date.now();
    loginAttempts.set(ip, item);
    return res.status(401).json({ error: "Incorrect password" });
  }

  loginAttempts.delete(ip);
  const token = createSession();
  const secure = process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => res.json({ authenticated: isAuthenticated(req) }));

app.post("/api/auth/logout", (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.get("/api/files", requireAuth, async (req, res) => {
  try {
    res.json(await collectCloudMessages());
  } catch (error) {
    console.error("FILE LIST ERROR:", error);
    res.status(500).json({ error: error.message || "Could not list Telegram files" });
  }
});

app.get("/api/storage", requireAuth, async (req, res) => {
  try {
    const files = await collectCloudMessages();
    const used = files.reduce((sum, f) => sum + Number(f.size || 0), 0);
    const limit = MAX_FILE_SIZE;
    const percent = limit ? Math.min(100, Number(((used / limit) * 100).toFixed(2))) : 0;
    const remaining = Math.max(0, limit - used);
    res.json({
      usedBytes: used,
      limitBytes: limit,
      remainingBytes: remaining,
      usedText: formatBytes(used),
      limitText: formatBytes(limit),
      remainingText: formatBytes(remaining),
      usedPercent: percent,
      telegram: { configured: true, connected: true, usedBytes: used, capacityBytes: limit, remainingBytes: remaining, usedText: formatBytes(used), remainingText: formatBytes(remaining) },
      b2: { configured: false, connected: false },
      mega: { configured: false, connected: false },
      idriveE2: { configured: false, connected: false },
      cloudinary: { configured: false, connected: false },
      filebase: { configured: false, connected: false },
      koofr: { configured: false, connected: false }
    });
  } catch (error) {
    console.error("STORAGE ERROR:", error);
    res.status(500).json({ error: error.message || "Telegram storage unavailable" });
  }
});

app.post("/api/upload-chunk", requireAuth, express.raw({ type: "application/octet-stream", limit: `${Math.ceil(CHUNK_SIZE / 1024 / 1024) + 1}mb` }), async (req, res) => {
  try {
    const params = parseUploadParams(req);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) return res.status(400).json({ error: "Empty chunk" });
    if (body.length > CHUNK_SIZE) return res.status(413).json({ error: `Chunk too large. Maximum is ${formatBytes(CHUNK_SIZE)}.` });

    const message = await withUploadLock(params.id, () => sendChunkToTelegram(body, params));
    res.json({ ok: true, uploadId: params.id, index: params.index, messageId: Number(message.id), storage: "TELEGRAM" });
  } catch (error) {
    console.error("TELEGRAM UPLOAD ERROR:", error);
    res.status(error.statusCode || 500).json({ error: error.message || "Telegram upload failed" });
  }
});

async function getMessagesByIds(ids) {
  const client = await getTelegramClient();
  const chat = await getTelegramEntity();
  if (!ids.length) return [];
  const messages = await client.getMessages(chat, { ids });
  const map = new Map(messages.filter(Boolean).map(m => [Number(m.id), m]));
  return ids.map(id => map.get(Number(id))).filter(Boolean);
}

async function streamTelegramFile(file, req, res) {
  const messages = await getMessagesByIds(file.chunks);
  const byId = new Map(messages.map(m => [Number(m.id), m]));
  res.status(200);
  res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
  res.setHeader("Content-Length", String(file.size));
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(cleanName(file.name))}`);

  for (const id of file.chunks) {
    const message = byId.get(Number(id));
    if (!message) throw new Error(`Telegram chunk ${id} is missing`);
    for await (const chunk of (await getTelegramClient()).iterDownload(message)) {
      if (res.destroyed) return;
      if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve));
    }
  }
  res.end();
}

async function streamTelegramDownload(file, res) {
  const messages = await getMessagesByIds(file.chunks);
  const byId = new Map(messages.map(m => [Number(m.id), m]));
  res.status(200);
  res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
  res.setHeader("Content-Length", String(file.size));
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(cleanName(file.name))}`);
  for (const id of file.chunks) {
    const message = byId.get(Number(id));
    if (!message) throw new Error(`Telegram chunk ${id} is missing`);
    for await (const chunk of (await getTelegramClient()).iterDownload(message)) {
      if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve));
    }
  }
  res.end();
}

app.get(/^\/api\/stream\/(.+)$/, requireAuth, async (req, res) => {
  try {
    const file = await findFile(decodeURIComponent(req.params[0]));
    if (!file) return res.status(404).send("File not found");
    await streamTelegramFile(file, req, res);
  } catch (error) {
    console.error("STREAM ERROR:", error);
    if (!res.headersSent) res.status(500).send(error.message || "Stream failed");
    else res.destroy(error);
  }
});

app.get(/^\/api\/download\/(.+)$/, requireAuth, async (req, res) => {
  try {
    const file = await findFile(decodeURIComponent(req.params[0]));
    if (!file) return res.status(404).send("File not found");
    await streamTelegramDownload(file, res);
  } catch (error) {
    console.error("DOWNLOAD ERROR:", error);
    if (!res.headersSent) res.status(500).send(error.message || "Download failed");
    else res.destroy(error);
  }
});

app.put("/api/files", requireAuth, async (req, res) => {
  try {
    const oldName = cleanRelativePath(req.body?.oldName || req.body?.name || "");
    const newName = cleanRelativePath(req.body?.newName || "");
    if (!oldName || !newName) return res.status(400).json({ error: "Old and new file names are required" });

    const file = await findFile(oldName);
    if (!file) return res.status(404).json({ error: "File not found" });
    if (await findFile(newName)) return res.status(409).json({ error: "A file with that name already exists" });

    const client = await getTelegramClient();
    const chat = await getTelegramEntity();
    const messages = await getMessagesByIds(file.chunks);

    const concurrency = Math.max(1, Math.min(TELEGRAM_WORKERS, 4));
    let cursor = 0;
    const worker = async () => {
      while (cursor < messages.length) {
        const message = messages[cursor++];
        const oldMeta = decodeCaption(message.text || message.message || "");
        if (!oldMeta) continue;
        const nextMeta = { ...oldMeta, name: newName, updatedAt: Date.now() };
        await client.editMessage(chat, { message: message.id, text: encodeCaption(nextMeta) });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    res.json({ ok: true, name: newName, storage: "TELEGRAM" });
  } catch (error) {
    console.error("RENAME ERROR:", error);
    res.status(500).json({ error: error.message || "Rename failed" });
  }
});

app.delete("/api/files", requireAuth, async (req, res) => {
  try {
    const name = cleanRelativePath(req.body?.name || "");
    if (!name) return res.status(400).json({ error: "File name missing" });
    if (DELETE_PASSWORD && !safeEqual(req.body?.deletePassword || DELETE_PASSWORD, DELETE_PASSWORD)) {
      return res.status(403).json({ error: "Delete password is incorrect" });
    }

    const file = await findFile(name);
    if (!file) return res.status(404).json({ error: "File not found" });

    const client = await getTelegramClient();
    const chat = await getTelegramEntity();
    for (let i = 0; i < file.chunks.length; i += 100) {
      await client.deleteMessages(chat, file.chunks.slice(i, i + 100), { revoke: true });
    }
    res.json({ ok: true, name, storage: "TELEGRAM", message: "File permanently deleted" });
  } catch (error) {
    console.error("DELETE ERROR:", error);
    res.status(500).json({ error: error.message || "Delete failed" });
  }
});

app.delete("/api/upload/:id", requireAuth, async (req, res) => {
  // Cancel a partially uploaded file by deleting its already-uploaded chunks.
  try {
    const id = String(req.params.id || "");
    if (!validUploadId(id)) return res.status(400).json({ error: "Invalid upload ID" });
    const files = await collectCloudMessages();
    const partial = files.find(f => f.uploadId === id);
    if (partial) {
      const client = await getTelegramClient();
      const chat = await getTelegramEntity();
      for (let i = 0; i < partial.chunks.length; i += 100) {
        await client.deleteMessages(chat, partial.chunks.slice(i, i + 100), { revoke: true });
      }
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not cancel upload" });
  }
});

app.get("/api/health", async (req, res) => {
  try {
    const client = await getTelegramClient();
    const me = await client.getMe();
    res.json({ ok: true, telegram: { connected: true, authorized: true, userId: String(me?.id || "") } });
  } catch (error) {
    res.status(503).json({ ok: false, telegram: { connected: false }, error: error.message || "Telegram unavailable" });
  }
});

/* ------------------------------- frontend -------------------------------- */

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let i = -1;
  do { value /= 1024; i++; } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}

// Local/Render compatibility. Vercel can import the Express app without a listener.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Cloud-Zen Telegram server listening on ${PORT}`));
}

module.exports = app;
