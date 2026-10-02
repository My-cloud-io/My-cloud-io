import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { CustomFile } from "teleproto/client/uploads/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const DELETE_PASSWORD = process.env.DELETE_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = process.env.TELEGRAM_API_HASH || "";
const TELEGRAM_SESSION = process.env.TELEGRAM_SESSION || "";
const STORAGE_CHAT = process.env.TELEGRAM_STORAGE_CHAT || "me";
const STORAGE_LIMIT = Number(process.env.STORAGE_LIMIT_BYTES || 10 * 1024 ** 3);
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 4_000_000_000);
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_JSON_BODY = "6mb";
const COOKIE_NAME = "cloudzen_session";
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const SHARE_TTL_MS = 1000 * 60 * 60 * 24;
const PREFIX = "CZ1";

if (!APP_PASSWORD || !DELETE_PASSWORD || !SESSION_SECRET) {
  console.warn("[Cloud-Zen] APP_PASSWORD, DELETE_PASSWORD and SESSION_SECRET should be configured.");
}
if (!API_ID || !API_HASH || !TELEGRAM_SESSION) {
  console.warn("[Cloud-Zen] Telegram credentials are not configured.");
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: MAX_JSON_BODY }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

// One process = one Telegram client = one serialized operation queue.
// This prevents concurrent use inside this process. It cannot make a serverless
// deployment safe when multiple independent instances share one StringSession.
let tgClient = null;
let tgState = "not-configured";
let tgError = null;
let tgConnectPromise = null;
let storageEntity = null;
let fileIndex = new Map();
let indexLoadedAt = 0;

let queue = Promise.resolve();
function telegramTask(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function b64urlEncode(text) {
  return Buffer.from(String(text), "utf8").toString("base64url");
}
function b64urlDecode(text) {
  return Buffer.from(String(text), "base64url").toString("utf8");
}
function safeName(name) {
  const n = String(name || "unnamed").replace(/[\\/\0]/g, "_").trim();
  return (n || "unnamed").slice(0, 255);
}
function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}
function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}
function makeToken() {
  const body = `${Date.now()}.${crypto.randomBytes(18).toString("base64url")}`;
  return `${body}.${sign(body)}`;
}
function makeShareToken(id, expiresAt) {
  const body = `${id}.${expiresAt}`;
  return `${expiresAt}.${sign(body)}`;
}
function verifyShareToken(id, token) {
  if (!token || !SESSION_SECRET) return false;
  const [expiresAt, sig] = String(token).split('.');
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) < Date.now()) return false;
  const expected = sign(`${id}.${expiresAt}`);
  return sig && Buffer.byteLength(sig) === Buffer.byteLength(expected) && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
function verifyToken(token) {
  if (!token || !SESSION_SECRET) return false;
  const parts = String(token).split(".");
  if (parts.length !== 3) return false;
  const [ts, nonce, sig] = parts;
  const body = `${ts}.${nonce}`;
  if (!/^\d+$/.test(ts)) return false;
  if (Date.now() - Number(ts) > TOKEN_TTL_MS) return false;
  const expected = sign(body);
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
function isAuthed(req) {
  return verifyToken(req.cookies?.[COOKIE_NAME]);
}
function requireAuth(req, res, next) {
  if (!isAuthed(req)) return jsonError(res, 401, "AUTH_REQUIRED");
  next();
}
function normalizeId(id) {
  return String(id);
}
function parseCaption(text) {
  const s = String(text || "");
  if (!s.startsWith(PREFIX + "|")) return null;
  const p = s.split("|");
  if (p[1] === "C" && p.length >= 8) {
    return {
      type: "chunk",
      fileId: p[2],
      index: Number(p[3]),
      total: Number(p[4]),
      size: Number(p[5]),
      mime: p[6] || "application/octet-stream",
      name: (() => { try { return safeName(b64urlDecode(p.slice(7).join("|"))); } catch { return "unnamed"; } })()
    };
  }
  if (p[1] === "R" && p.length >= 4) {
    try { return { type: "rename", fileId: p[2], name: safeName(b64urlDecode(p.slice(3).join("|"))) }; } catch { return null; }
  }
  if (p[1] === "H" && p.length >= 4) return { type: "hide", fileId: p[2], hidden: p[3] === "1" };
  if (p[1] === "D" && p.length >= 3) return { type: "deleted", fileId: p[2] };
  return null;
}

function messageHasMedia(message) {
  return Boolean(message?.media);
}
function messageFileInfo(message) {
  const doc = message?.document || message?.media?.document;
  const photo = message?.photo || message?.media?.photo;
  if (doc) {
    const attrs = Array.isArray(doc.attributes) ? doc.attributes : [];
    const filenameAttr = attrs.find(a => a?.className === "DocumentAttributeFilename" || a?.fileName);
    const name = filenameAttr?.fileName || message?.fileName || "document";
    return {
      name: safeName(name),
      size: Number(doc.size || 0),
      mime: doc.mimeType || "application/octet-stream"
    };
  }
  if (photo) {
    const sizes = Array.isArray(photo.sizes) ? photo.sizes : [];
    const last = sizes[sizes.length - 1];
    return {
      name: `photo-${message.id}.jpg`,
      size: Number(last?.size || 0),
      mime: "image/jpeg"
    };
  }
  return null;
}

async function connectTelegram() {
  if (tgClient && tgState === "ready") return tgClient;
  if (tgConnectPromise) return tgConnectPromise;
  if (!API_ID || !API_HASH || !TELEGRAM_SESSION) {
    tgState = "not-configured";
    throw new Error("Telegram environment variables are incomplete.");
  }

  tgConnectPromise = (async () => {
    tgState = "connecting";
    tgError = null;
    const session = new StringSession(TELEGRAM_SESSION.trim());
    const client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 5,
      requestRetries: 3,
      retryDelay: 1000,
      autoReconnect: true
    });
    try {
      await client.connect();
      const authorized = await client.isUserAuthorized();
      if (!authorized) throw new Error("TELEGRAM_SESSION is not authorized.");
      storageEntity = await client.getInputEntity(STORAGE_CHAT);
      tgClient = client;
      tgState = "ready";
      console.log("[Cloud-Zen] Telegram connected.");
      return client;
    } catch (err) {
      tgState = "error";
      tgError = String(err?.message || err);
      try { await client.disconnect(); } catch {}
      tgClient = null;
      throw err;
    } finally {
      tgConnectPromise = null;
    }
  })();
  return tgConnectPromise;
}

async function withTelegram(fn) {
  return telegramTask(async () => {
    const client = await connectTelegram();
    try {
      return await fn(client);
    } catch (err) {
      const msg = String(err?.message || err);
      if (/AUTH_KEY_DUPLICATED|AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/i.test(msg)) {
        tgState = "session-invalid";
        tgError = msg;
      }
      throw err;
    }
  });
}

async function rebuildIndex() {
  return withTelegram(async (client) => {
    const chunks = new Map();
    const legacy = new Map();
    const control = [];
    for await (const message of client.iterMessages(storageEntity, { limit: undefined })) {
      const meta = parseCaption(message?.message);
      if (meta?.type === "chunk") {
        if (!chunks.has(meta.fileId)) chunks.set(meta.fileId, []);
        chunks.get(meta.fileId).push({
          messageId: Number(message.id),
          index: meta.index,
          total: meta.total,
          size: meta.size,
          mime: meta.mime,
          name: meta.name
        });
      } else if (meta?.type === "rename" || meta?.type === "hide" || meta?.type === "deleted") {
        control.push({ messageId: Number(message.id), ...meta });
      } else if (messageHasMedia(message)) {
        const info = messageFileInfo(message);
        if (info) {
          legacy.set(normalizeId(message.id), {
            id: `tg-${message.id}`,
            telegramMessageId: Number(message.id),
            name: info.name,
            size: info.size,
            mime: info.mime,
            hidden: false,
            legacy: true,
            total: 1,
            chunks: [Number(message.id)],
            updatedAt: Number(message.date || 0) * 1000
          });
        }
      }
    }

    const index = new Map();
    for (const [fileId, list] of chunks) {
      list.sort((a, b) => a.index - b.index);
      const first = list[0];
      const complete = list.length === first.total && list.every((x, i) => x.index === i);
      if (!complete) continue;
      index.set(fileId, {
        id: fileId,
        name: first.name,
        size: first.size,
        mime: first.mime,
        hidden: false,
        legacy: false,
        total: first.total,
        chunks: list.map(x => x.messageId),
        updatedAt: Date.now()
      });
    }
    for (const c of control.sort((a, b) => a.messageId - b.messageId)) {
      const item = index.get(c.fileId);
      if (!item) continue;
      if (c.type === "rename") item.name = c.name;
      if (c.type === "hide") item.hidden = c.hidden;
      if (c.type === "deleted") index.delete(c.fileId);
    }
    for (const item of legacy.values()) index.set(item.id, item);

    fileIndex = index;
    indexLoadedAt = Date.now();
    return Array.from(index.values());
  });
}

async function getIndex(force = false) {
  if (!force && indexLoadedAt && Date.now() - indexLoadedAt < 30_000) return Array.from(fileIndex.values());
  return rebuildIndex();
}

function publicFile(item) {
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    mime: item.mime,
    hidden: Boolean(item.hidden),
    legacy: Boolean(item.legacy),
    total: item.total,
    updatedAt: item.updatedAt,
    openUrl: `/api/files/${encodeURIComponent(item.id)}/open`,
    downloadUrl: `/api/files/${encodeURIComponent(item.id)}/download`
  };
}

async function findFile(id) {
  const list = await getIndex(false);
  return list.find(x => x.id === id) || null;
}

async function sendControl(text) {
  return withTelegram(client => client.sendMessage(storageEntity, { message: text }));
}

async function deleteTelegramMessages(ids) {
  const unique = [...new Set(ids.map(Number).filter(Number.isFinite))];
  for (let i = 0; i < unique.length; i += 100) {
    await withTelegram(client => client.deleteMessages(storageEntity, unique.slice(i, i + 100)));
  }
}

function isRangeRequest(req) {
  return typeof req.headers.range === "string" && req.headers.range.startsWith("bytes=");
}

async function streamTelegramMessage(res, message, contentType, downloadName, req, totalSize) {
  const client = await connectTelegram();
  res.setHeader("Content-Type", contentType || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  if (!isRangeRequest(req)) {
    res.setHeader("Content-Length", String(totalSize));
  }
  for await (const chunk of client.iterDownload(message, { requestSize: 512 * 1024 })) {
    if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve));
  }
  res.end();
}

app.get("/api/health", async (req, res) => {
  let telegram = tgState === "ready";
  let error = tgError;
  if (!telegram && API_ID && API_HASH && TELEGRAM_SESSION) {
    try { await connectTelegram(); telegram = true; error = null; } catch (e) { error = String(e?.message || e); }
  }
  res.json({
    ok: true,
    service: "cloud-zen-telegram-backend",
    persistent: true,
    telegram,
    telegramState: tgState,
    error: error || undefined,
    storageChatConfigured: Boolean(STORAGE_CHAT)
  });
});

app.post("/api/auth/login", (req, res) => {
  if (!APP_PASSWORD) return jsonError(res, 503, "APP_PASSWORD_NOT_CONFIGURED");
  if (String(req.body?.password || "") !== APP_PASSWORD) return jsonError(res, 401, "INVALID_PASSWORD");
  const token = makeToken();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: TOKEN_TTL_MS,
    path: "/"
  });
  res.json({ ok: true });
});
app.get("/api/auth/me", (req, res) => res.json({ ok: isAuthed(req) }));
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  res.json({ ok: true });
});

app.get("/api/files", requireAuth, async (req, res) => {
  try {
    const includeHidden = String(req.query.includeHidden || "") === "1";
    const items = (await getIndex(false)).filter(x => includeHidden || !x.hidden);
    const q = String(req.query.q || "").trim().toLowerCase();
    const filtered = q ? items.filter(x => x.name.toLowerCase().includes(q)) : items;
    res.json({ ok: true, files: filtered.map(publicFile) });
  } catch (e) {
    console.error("[Cloud-Zen] FILE LIST:", e);
    jsonError(res, 503, "TELEGRAM_UNAVAILABLE", { detail: String(e?.message || e) });
  }
});

app.get("/api/storage", requireAuth, async (req, res) => {
  try {
    const items = await getIndex(false);
    const used = items.filter(x => !x.hidden).reduce((sum, x) => sum + Number(x.size || 0), 0);
    res.json({ ok: true, used, limit: STORAGE_LIMIT, free: Math.max(0, STORAGE_LIMIT - used), count: items.filter(x => !x.hidden).length });
  } catch (e) {
    console.error("[Cloud-Zen] STORAGE:", e);
    jsonError(res, 503, "TELEGRAM_UNAVAILABLE", { detail: String(e?.message || e) });
  }
});

app.post("/api/upload-start", requireAuth, async (req, res) => {
  const name = safeName(req.body?.name);
  const size = Number(req.body?.size);
  const mime = String(req.body?.mime || "application/octet-stream").slice(0, 200);
  if (!name || !Number.isSafeInteger(size) || size <= 0) return jsonError(res, 400, "INVALID_FILE");
  if (size > MAX_FILE_SIZE) return jsonError(res, 413, "FILE_TOO_LARGE");
  const total = Math.ceil(size / CHUNK_SIZE);
  const fileId = crypto.randomBytes(16).toString("hex");
  res.json({ ok: true, fileId, chunkSize: CHUNK_SIZE, total, name, size, mime });
});

app.post("/api/upload-chunk", requireAuth, async (req, res) => {
  const fileId = String(req.query.fileId || req.body?.fileId || "");
  const index = Number(req.query.index ?? req.body?.index);
  const total = Number(req.query.total ?? req.body?.total);
  const size = Number(req.query.size ?? req.body?.size);
  const mime = String(req.query.mime || req.body?.mime || "application/octet-stream").slice(0, 200);
  const name = safeName(req.query.name || req.body?.name);
  const raw = req.body?.data;
  if (!/^[a-f0-9]{32}$/.test(fileId) || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || index >= total || !Number.isInteger(size) || size <= 0 || !name || !raw) {
    return jsonError(res, 400, "INVALID_CHUNK");
  }
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "base64");
  const expected = index === total - 1 ? size - CHUNK_SIZE * (total - 1) : CHUNK_SIZE;
  if (buffer.length !== expected || buffer.length <= 0 || buffer.length > CHUNK_SIZE) return jsonError(res, 400, "CHUNK_SIZE_MISMATCH");

  try {
    const caption = `${PREFIX}|C|${fileId}|${index}|${total}|${size}|${mime}|${b64urlEncode(name)}`;
    const message = await withTelegram(client => client.sendFile(storageEntity, {
      file: new CustomFile(`chunk-${fileId}-${index}.bin`, buffer.length, "", buffer),
      caption,
      forceDocument: true,
      workers: 1,
      silent: true
    }));
    fileIndex.delete(fileId);
    indexLoadedAt = 0;
    res.json({ ok: true, fileId, index, messageId: Number(message.id), received: buffer.length });
  } catch (e) {
    console.error("[Cloud-Zen] UPLOAD:", e);
    jsonError(res, 503, "TELEGRAM_UPLOAD_FAILED", { detail: String(e?.message || e) });
  }
});

app.post("/api/upload-finish", requireAuth, async (req, res) => {
  const fileId = String(req.body?.fileId || "");
  if (!/^[a-f0-9]{32}$/.test(fileId)) return jsonError(res, 400, "INVALID_FILE_ID");
  try {
    const item = await findFile(fileId);
    if (!item || item.legacy) return jsonError(res, 409, "UPLOAD_INCOMPLETE");
    res.json({ ok: true, file: publicFile(item) });
  } catch (e) {
    jsonError(res, 503, "TELEGRAM_UNAVAILABLE", { detail: String(e?.message || e) });
  }
});

async function loadMessages(ids) {
  return withTelegram(client => client.getMessages(storageEntity, { ids }));
}

app.get("/api/files/:id/open", requireAuth, async (req, res) => {
  try {
    const item = await findFile(req.params.id);
    if (!item || item.hidden) return jsonError(res, 404, "NOT_FOUND");
    const ids = item.chunks;
    if (item.legacy) {
      const [message] = await loadMessages(ids);
      if (!message) return jsonError(res, 404, "TELEGRAM_MESSAGE_NOT_FOUND");
      await streamTelegramMessage(res, message, item.mime, item.name, req, item.size);
      return;
    }
    if (item.mime?.startsWith("image/") || item.mime?.startsWith("video/") || item.mime?.startsWith("audio/") || item.mime === "application/pdf" || item.mime?.startsWith("text/")) {
      res.setHeader("Content-Type", item.mime);
    } else {
      res.setHeader("Content-Type", "application/octet-stream");
    }
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(item.name)}`);
    let sent = 0;
    for (const id of ids) {
      const [message] = await loadMessages([id]);
      if (!message) return;
      for await (const chunk of (await connectTelegram()).iterDownload(message, { requestSize: 512 * 1024 })) {
        sent += chunk.length;
        if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) jsonError(res, 503, "TELEGRAM_DOWNLOAD_FAILED", { detail: String(e?.message || e) });
    else res.end();
  }
});

app.get("/api/files/:id/download", requireAuth, async (req, res) => {
  try {
    const item = await findFile(req.params.id);
    if (!item || item.hidden) return jsonError(res, 404, "NOT_FOUND");
    res.setHeader("Content-Type", item.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`);
    if (item.legacy) {
      const [message] = await loadMessages(item.chunks);
      if (!message) return jsonError(res, 404, "TELEGRAM_MESSAGE_NOT_FOUND");
      await streamTelegramMessage(res, message, item.mime, item.name, req, item.size);
      return;
    }
    for (const id of item.chunks) {
      const [message] = await loadMessages([id]);
      if (!message) throw new Error(`Missing Telegram chunk ${id}`);
      for await (const chunk of (await connectTelegram()).iterDownload(message, { requestSize: 512 * 1024 })) {
        if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) jsonError(res, 503, "TELEGRAM_DOWNLOAD_FAILED", { detail: String(e?.message || e) });
    else res.end();
  }
});

app.post("/api/files/:id/rename", requireAuth, async (req, res) => {
  const name = safeName(req.body?.name);
  if (!name) return jsonError(res, 400, "INVALID_NAME");
  try {
    const item = await findFile(req.params.id);
    if (!item || item.legacy) return jsonError(res, 404, "NOT_FOUND");
    await sendControl(`${PREFIX}|R|${item.id}|${b64urlEncode(name)}`);
    indexLoadedAt = 0;
    res.json({ ok: true, name });
  } catch (e) {
    jsonError(res, 503, "RENAME_FAILED", { detail: String(e?.message || e) });
  }
});

app.post("/api/files/:id/hide", requireAuth, async (req, res) => {
  try {
    const item = await findFile(req.params.id);
    if (!item) return jsonError(res, 404, "NOT_FOUND");
    const hidden = Boolean(req.body?.hidden);
    await sendControl(`${PREFIX}|H|${item.id}|${hidden ? 1 : 0}`);
    indexLoadedAt = 0;
    res.json({ ok: true, hidden });
  } catch (e) {
    jsonError(res, 503, "HIDE_FAILED", { detail: String(e?.message || e) });
  }
});

app.post("/api/files/:id/delete", requireAuth, async (req, res) => {
  if (!DELETE_PASSWORD || String(req.body?.password || "") !== DELETE_PASSWORD) return jsonError(res, 403, "DELETE_PASSWORD_REQUIRED");
  try {
    const item = await findFile(req.params.id);
    if (!item) return jsonError(res, 404, "NOT_FOUND");
    if (item.legacy) {
      await deleteTelegramMessages(item.chunks);
    } else {
      await deleteTelegramMessages(item.chunks);
      await sendControl(`${PREFIX}|D|${item.id}`);
    }
    fileIndex.delete(item.id);
    indexLoadedAt = 0;
    res.json({ ok: true });
  } catch (e) {
    jsonError(res, 503, "DELETE_FAILED", { detail: String(e?.message || e) });
  }
});

app.get("/api/files/:id/share", requireAuth, async (req, res) => {
  try {
    const item = await findFile(req.params.id);
    if (!item || item.hidden) return jsonError(res, 404, "NOT_FOUND");
    const expiresAt = Date.now() + SHARE_TTL_MS;
    const token = makeShareToken(item.id, expiresAt);
    res.json({ ok: true, expiresAt, url: `/api/share/${encodeURIComponent(item.id)}?token=${encodeURIComponent(token)}` });
  } catch (e) {
    jsonError(res, 500, "SHARE_FAILED");
  }
});

app.get("/api/share/:id", async (req, res) => {
  try {
    if (!verifyShareToken(req.params.id, req.query.token)) return jsonError(res, 403, "INVALID_OR_EXPIRED_SHARE");
    const item = await findFile(req.params.id);
    if (!item || item.hidden) return jsonError(res, 404, "NOT_FOUND");
    res.setHeader("Content-Type", item.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(item.name)}`);
    if (item.legacy) {
      const [message] = await loadMessages(item.chunks);
      if (!message) return jsonError(res, 404, "TELEGRAM_MESSAGE_NOT_FOUND");
      await streamTelegramMessage(res, message, item.mime, item.name, req, item.size);
      return;
    }
    const client = await connectTelegram();
    for (const id of item.chunks) {
      const [message] = await loadMessages([id]);
      if (!message) throw new Error(`Missing Telegram chunk ${id}`);
      for await (const chunk of client.iterDownload(message, { requestSize: 512 * 1024 })) {
        if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) jsonError(res, 503, "TELEGRAM_SHARE_FAILED", { detail: String(e?.message || e) });
    else res.end();
  }
});

app.use((err, req, res, next) => {
  console.error("[Cloud-Zen] HTTP:", err);
  if (res.headersSent) return next(err);
  jsonError(res, 500, "INTERNAL_ERROR");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Cloud-Zen] listening on 0.0.0.0:${PORT}`);
  if (process.env.VERCEL) {
    console.warn("[Cloud-Zen] This backend requires one persistent process. Do not deploy the Telegram session to multiple Vercel Functions.");
  }
});
