const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const APP_PASSWORD = String(process.env.APP_PASSWORD || "");
const DELETE_PASSWORD = String(process.env.DELETE_PASSWORD || "");
const SESSION_SECRET = String(process.env.SESSION_SECRET || "");
const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = String(process.env.TELEGRAM_API_HASH || "");
const TELEGRAM_SESSION = String(process.env.TELEGRAM_SESSION || "");
const STORAGE_CHAT = String(process.env.TELEGRAM_STORAGE_CHAT || "");
const TELEGRAM_WORKERS = Math.max(1, Number(process.env.TELEGRAM_WORKERS || 2));

const HTTP_CHUNK_SIZE = 4 * 1024 * 1024;
const TELEGRAM_PART_SIZE = 512 * 1024;

if (!APP_PASSWORD || !SESSION_SECRET || !API_ID || !API_HASH || !TELEGRAM_SESSION || !STORAGE_CHAT) {
  console.warn("Cloud-Zen: one or more Telegram/auth environment variables are missing.");
}

let telegramClient = null;
let storageEntity = null;
let telegramInitPromise = null;
let storageLock = Promise.resolve();

function json(res, status, value) {
  res.status(status).json(value);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function makeAuthToken() {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(`cloud-zen-auth:${APP_PASSWORD}`)
    .digest("hex");
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setAuthCookie(res) {
  const token = makeAuthToken();
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `cloud_zen_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
  );
}

function clearAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "cloud_zen_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
}

function isAuthenticated(req) {
  const token = parseCookies(req).cloud_zen_auth || "";
  return !!SESSION_SECRET && safeEqual(token, makeAuthToken());
}

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) return json(res, 401, { error: "Authentication required" });
  next();
}

function withStorageLock(fn) {
  const run = storageLock.then(fn, fn);
  storageLock = run.catch(() => {});
  return run;
}

function randomLong() {
  return BigInt.asIntN(64, BigInt("0x" + crypto.randomBytes(8).toString("hex")));
}

function normalizeName(name) {
  const value = String(name || "").replace(/\u0000/g, "").trim();
  if (!value || value.length > 255) throw new Error("Invalid file name");
  return value;
}

function getMessageId(message) {
  return Number(message?.id || 0);
}

function messageDocument(message) {
  if (message?.media?.document) return message.media.document;
  if (message?.media?.className === "MessageMediaDocument" && message.media.document) return message.media.document;
  return null;
}

function messagePhoto(message) {
  if (message?.media?.photo) return message.media.photo;
  return null;
}

function attrValue(document, className) {
  const attrs = Array.isArray(document?.attributes) ? document.attributes : [];
  const attr = attrs.find((x) => x?.className === className);
  return attr || null;
}

function filenameFromDocument(document) {
  const attr = attrValue(document, "DocumentAttributeFilename");
  return attr?.fileName || "file";
}

function mimeFromDocument(document) {
  return String(document?.mimeType || "application/octet-stream");
}

function captionName(message, fallback) {
  const text = String(message?.message || "");
  const match = text.match(/^CLOUD_ZEN_NAME:(.*)$/s);
  return match ? normalizeName(match[1]) : fallback;
}

async function getTelegram() {
  if (telegramClient && telegramClient.connected) return telegramClient;
  if (telegramInitPromise) return telegramInitPromise;

  telegramInitPromise = (async () => {
    if (!API_ID || !API_HASH || !TELEGRAM_SESSION || !STORAGE_CHAT) {
      throw new Error("Telegram environment is not configured");
    }

    const client = new TelegramClient(
      new StringSession(TELEGRAM_SESSION),
      API_ID,
      API_HASH,
      {
        connectionRetries: 5,
        autoReconnect: true,
        requestRetries: 5
      }
    );

    await client.connect();

    if (!(await client.checkAuthorization())) {
      throw new Error("TELEGRAM_SESSION is not authorized");
    }

    storageEntity = await client.getEntity(STORAGE_CHAT);
    telegramClient = client;
    return client;
  })();

  try {
    return await telegramInitPromise;
  } finally {
    telegramInitPromise = null;
  }
}

async function listCloudFiles() {
  const client = await getTelegram();
  const files = [];
  let offsetId = 0;
  const pageSize = 100;

  // A personal storage chat can contain a large number of files.
  // Read pages until Telegram returns fewer than a full page.
  for (let page = 0; page < 50; page++) {
    const messages = await client.getMessages(storageEntity, {
      limit: pageSize,
      ...(offsetId ? { offsetId } : {})
    });

    if (!messages.length) break;

    for (const message of messages) {
      const document = messageDocument(message);
      const photo = messagePhoto(message);

      if (document) {
        const original = filenameFromDocument(document);
        const name = captionName(message, original);
        const size = Number(document.size || 0);
        files.push({
          id: getMessageId(message),
          name,
          originalName: original,
          type: mimeFromDocument(document),
          size,
          sizeText: formatBytes(size),
          modified: message.date ? new Date(Number(message.date) * 1000).toISOString() : null,
          telegramMessageId: getMessageId(message)
        });
      } else if (photo) {
        // Photos sent manually to the storage chat are also exposed.
        const size = Number(photo.sizes?.[photo.sizes.length - 1]?.size || 0);
        const name = captionName(message, `telegram-photo-${getMessageId(message)}.jpg`);
        files.push({
          id: getMessageId(message),
          name,
          originalName: name,
          type: "image/jpeg",
          size,
          sizeText: formatBytes(size),
          modified: message.date ? new Date(Number(message.date) * 1000).toISOString() : null,
          telegramMessageId: getMessageId(message)
        });
      }
    }

    const last = messages[messages.length - 1];
    const next = getMessageId(last);
    if (!next || messages.length < pageSize) break;
    offsetId = next;
  }

  return files;
}

async function findMessageByName(name) {
  const files = await listCloudFiles();
  const wanted = String(name);
  const file = files.find((x) => x.name === wanted);
  if (!file) return null;
  const client = await getTelegram();
  const messages = await client.getMessages(storageEntity, { ids: [file.telegramMessageId] });
  return { file, message: messages[0] || null };
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function fileCapacityLimit() {
  // Telegram currently documents 4000 parts for non-Premium and 8000 for Premium,
  // with a maximum part size of 512 KiB.
  return 8000 * TELEGRAM_PART_SIZE;
}

async function sendUploadedDocument({ fileId, parts, name, mimeType }) {
  const client = await getTelegram();
  const inputFile = new Api.InputFileBig({
    id: fileId,
    parts,
    name
  });

  const media = new Api.InputMediaUploadedDocument({
    file: inputFile,
    mimeType: mimeType || "application/octet-stream",
    attributes: [
      new Api.DocumentAttributeFilename({ fileName: name })
    ]
  });

  return client.invoke(
    new Api.messages.SendMedia({
      peer: storageEntity,
      media,
      message: "",
      randomId: randomLong()
    })
  );
}

async function readRawRequest(req, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw Object.assign(new Error("Upload chunk is too large"), { statusCode: 413 });
    chunks.push(buf);
  }

  return Buffer.concat(chunks, total);
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(header.trim());
  if (!match) return null;

  const start = Number(match[1]);
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || start >= size) return { invalid: true };
  if (!Number.isSafeInteger(end) || end >= size) end = size - 1;
  if (end < start) return { invalid: true };
  return { start, end };
}

async function writeTelegramRange(res, message, start, end) {
  const client = await getTelegram();
  const total = end - start + 1;

  res.setHeader("Content-Length", String(total));

  // Telegram file download limits each request to <= 1 MiB.
  const iterator = client.iterDownload({
    file: message.media,
    offset: start,
    limit: total,
    chunkSize: 1024 * 1024,
    requestSize: 1024 * 1024,
    stride: 1024 * 1024,
    precise: true
  });

  for await (const chunk of iterator) {
    if (!res.write(Buffer.from(chunk))) {
      await new Promise((resolve) => res.once("drain", resolve));
    }
  }
  res.end();
}

async function uploadBrowserChunk(req, res) {
  const q = req.query;
  const uploadId = String(q.id || "");
  const index = Number(q.index);
  const totalBrowserChunks = Number(q.total);
  const fileSize = Number(q.size);
  const name = normalizeName(q.name);
  const mimeType = String(q.type || "application/octet-stream");

  if (!/^[a-fA-F0-9-]{16,128}$/.test(uploadId)) {
    return json(res, 400, { error: "Invalid upload id" });
  }
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(totalBrowserChunks) || totalBrowserChunks < 1 || index >= totalBrowserChunks) {
    return json(res, 400, { error: "Invalid upload chunk index" });
  }
  if (!Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > fileCapacityLimit()) {
    return json(res, 413, {
      error: `File is larger than the current Telegram part limit (${formatBytes(fileCapacityLimit())})`
    });
  }

  const expectedTotal = Math.ceil(fileSize / HTTP_CHUNK_SIZE);
  if (expectedTotal !== totalBrowserChunks) {
    return json(res, 400, { error: "Upload chunk count does not match file size" });
  }

  const body = await readRawRequest(req, HTTP_CHUNK_SIZE);
  if (!body.length) return json(res, 400, { error: "Empty upload chunk" });

  // Each Vercel request is 4 MiB max. Telegram's MTProto upload parts are 512 KiB.
  const firstTelegramPart = index * (HTTP_CHUNK_SIZE / TELEGRAM_PART_SIZE);
  const parts = Math.ceil(fileSize / TELEGRAM_PART_SIZE);

  if (firstTelegramPart >= parts) {
    return json(res, 400, { error: "Invalid Telegram part offset" });
  }

  await withStorageLock(async () => {
    const client = await getTelegram();
    for (let local = 0; local < Math.ceil(body.length / TELEGRAM_PART_SIZE); local++) {
      const slice = body.subarray(
        local * TELEGRAM_PART_SIZE,
        Math.min(body.length, (local + 1) * TELEGRAM_PART_SIZE)
      );
      const partNumber = firstTelegramPart + local;

      let ok = false;
      for (let attempt = 0; attempt < 5 && !ok; attempt++) {
        try {
          ok = await client.invoke(
            new Api.upload.SaveBigFilePart({
              fileId: BigInt("0x" + uploadId.replace(/-/g, "").slice(0, 16)),
              filePart: partNumber,
              fileTotalParts: parts,
              bytes: slice
            })
          );
        } catch (error) {
          if (attempt === 4) throw error;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }

      if (!ok) throw new Error(`Telegram rejected part ${partNumber}`);
    }
  });

  const lastChunk = index === totalBrowserChunks - 1;

  if (lastChunk) {
    await withStorageLock(async () => {
      const client = await getTelegram();
      const fileId = BigInt("0x" + uploadId.replace(/-/g, "").slice(0, 16));
      await sendUploadedDocument({
        fileId,
        parts,
        name,
        mimeType
      });
    });
  }

  return json(res, 200, {
    ok: true,
    id: uploadId,
    index,
    total: totalBrowserChunks,
    complete: lastChunk,
    percent: ((index + 1) / totalBrowserChunks) * 100
  });
}

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/health", async (req, res) => {
  try {
    await getTelegram();
    json(res, 200, { ok: true, telegram: true });
  } catch (error) {
    json(res, 503, { ok: false, telegram: false, error: error.message });
  }
});

app.post("/api/auth/login", express.json({ limit: "20kb" }), (req, res) => {
  const password = String(req.body?.password || "");
  if (!APP_PASSWORD || !safeEqual(password, APP_PASSWORD)) {
    return json(res, 401, { error: "Invalid password" });
  }
  setAuthCookie(res);
  return json(res, 200, { authenticated: true });
});

app.get("/api/auth/me", (req, res) => {
  json(res, 200, { authenticated: isAuthenticated(req) });
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res);
  json(res, 200, { authenticated: false });
});

app.get("/api/storage", requireAuth, async (req, res) => {
  try {
    const files = await listCloudFiles();
    const usedBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    const limitBytes = fileCapacityLimit();
    const remainingBytes = Math.max(0, limitBytes - usedBytes);
    const usedPercent = limitBytes ? Number(((usedBytes / limitBytes) * 100).toFixed(2)) : 0;

    json(res, 200, {
      usedBytes,
      limitBytes,
      remainingBytes,
      usedPercent,
      usedText: formatBytes(usedBytes),
      limitText: formatBytes(limitBytes),
      remainingText: formatBytes(remainingBytes),
      telegram: {
        configured: true,
        connected: true,
        usedBytes,
        capacityBytes: limitBytes,
        remainingBytes,
        usedText: formatBytes(usedBytes),
        remainingText: formatBytes(remainingBytes),
        limitText: formatBytes(limitBytes),
        usedPercent
      }
    });
  } catch (error) {
    console.error("STORAGE ERROR", error);
    json(res, 503, { error: error.message || "Telegram storage unavailable" });
  }
});

app.get("/api/files", requireAuth, async (req, res) => {
  try {
    const files = await listCloudFiles();
    files.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
    json(res, 200, files);
  } catch (error) {
    console.error("FILE LIST ERROR", error);
    json(res, 503, { error: error.message || "Could not list Telegram files" });
  }
});

app.post("/api/upload-chunk", requireAuth, async (req, res) => {
  try {
    await uploadBrowserChunk(req, res);
  } catch (error) {
    console.error("UPLOAD ERROR", error);
    const status = Number(error.statusCode || 500);
    json(res, status, { error: error.message || "Upload failed" });
  }
});

app.patch("/api/files", requireAuth, express.json({ limit: "20kb" }), async (req, res) => {
  try {
    const oldName = normalizeName(req.body?.name);
    const newName = normalizeName(req.body?.newName);
    if (oldName === newName) return json(res, 200, { ok: true });

    const found = await findMessageByName(oldName);
    if (!found?.message) return json(res, 404, { error: "File not found" });

    const existing = await listCloudFiles();
    if (existing.some((f) => f.name === newName)) {
      return json(res, 409, { error: "A file with that name already exists" });
    }

    const client = await getTelegram();
    await client.invoke(
      new Api.messages.EditMessage({
        peer: storageEntity,
        id: found.file.telegramMessageId,
        message: `CLOUD_ZEN_NAME:${newName}`
      })
    );

    json(res, 200, { ok: true, name: newName });
  } catch (error) {
    console.error("RENAME ERROR", error);
    json(res, 500, { error: error.message || "Rename failed" });
  }
});

app.delete("/api/files", requireAuth, express.json({ limit: "20kb" }), async (req, res) => {
  try {
    const name = normalizeName(req.body?.name);
    const found = await findMessageByName(name);
    if (!found?.message) return json(res, 404, { error: "File not found" });

    // DELETE_PASSWORD is accepted as an optional second factor via header.
    // If it is configured, the client must provide it; otherwise the authenticated
    // cloud session is sufficient.
    if (DELETE_PASSWORD) {
      const supplied = String(req.headers["x-delete-password"] || "");
      if (!safeEqual(supplied, DELETE_PASSWORD)) {
        return json(res, 403, { error: "Delete password required" });
      }
    }

    const client = await getTelegram();
    await client.deleteMessages(storageEntity, [found.file.telegramMessageId], { revoke: true });
    json(res, 200, { ok: true });
  } catch (error) {
    console.error("DELETE ERROR", error);
    json(res, 500, { error: error.message || "Delete failed" });
  }
});

async function resolveFile(req, res) {
  const rawName = Array.isArray(req.params[0]) ? req.params[0].join("/") : req.params[0];
  const name = decodeURIComponent(String(rawName || ""));
  const found = await findMessageByName(name);
  if (!found?.message) {
    json(res, 404, { error: "File not found" });
    return null;
  }
  return found;
}

app.get(/^\/api\/stream\/(.+)$/, requireAuth, async (req, res) => {
  try {
    const found = await resolveFile(req, res);
    if (!found) return;

    const document = messageDocument(found.message);
    const photo = messagePhoto(found.message);
    const size = Number(document?.size || 0);

    if (!document && !photo) return json(res, 415, { error: "Unsupported Telegram media" });

    const mimeType = document ? mimeFromDocument(document) : "image/jpeg";
    const range = parseRange(req.headers.range, size);

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(found.file.name)}`);

    if (range?.invalid) {
      res.setHeader("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }

    if (!range) {
      res.status(200);
      return writeTelegramRange(res, found.message, 0, Math.max(0, size - 1));
    }

    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    return writeTelegramRange(res, found.message, range.start, range.end);
  } catch (error) {
    console.error("STREAM ERROR", error);
    if (!res.headersSent) json(res, 500, { error: error.message || "Stream failed" });
    else res.destroy(error);
  }
});

app.get(/^\/api\/download\/(.+)$/, requireAuth, async (req, res) => {
  try {
    const found = await resolveFile(req, res);
    if (!found) return;

    const document = messageDocument(found.message);
    const photo = messagePhoto(found.message);
    const size = Number(document?.size || 0);
    if (!document && !photo) return json(res, 415, { error: "Unsupported Telegram media" });

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", document ? mimeFromDocument(document) : "image/jpeg");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(found.file.name)}`);

    const range = parseRange(req.headers.range, size);
    if (range?.invalid) {
      res.setHeader("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }

    if (!range) {
      return writeTelegramRange(res, found.message, 0, Math.max(0, size - 1));
    }

    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    return writeTelegramRange(res, found.message, range.start, range.end);
  } catch (error) {
    console.error("DOWNLOAD ERROR", error);
    if (!res.headersSent) json(res, 500, { error: error.message || "Download failed" });
    else res.destroy(error);
  }
});

// Static frontend
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  maxAge: "1h",
  index: "index.html"
}));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Cloud-Zen server listening on 0.0.0.0:${PORT}`);
  });
}
