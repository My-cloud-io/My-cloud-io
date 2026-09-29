'use strict';

/*
  CLOUD-ZEN — Telegram-backed private cloud

  IMPORTANT ARCHITECTURE RULE
  ---------------------------
  Run this backend as ONE persistent Node.js process/container.
  NEVER run the same TELEGRAM_SESSION in two processes/instances.
  Telegram can invalidate the authorization key and return AUTH_KEY_DUPLICATED.

  This package intentionally keeps the project small:
    server.js
    telegram-session.js
    package.json
    admin.md
    public/index.html
*/

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = String(process.env.APP_PASSWORD || '');
const DELETE_PASSWORD = String(process.env.DELETE_PASSWORD || '');
const SESSION_SECRET = String(process.env.SESSION_SECRET || '');
const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = String(process.env.TELEGRAM_API_HASH || '');
const TELEGRAM_SESSION = String(process.env.TELEGRAM_SESSION || '');
const STORAGE_CHAT = String(process.env.TELEGRAM_STORAGE_CHAT || 'me');
const STORAGE_LIMIT = Number(process.env.STORAGE_LIMIT_BYTES || 10 * 1024 ** 3);

// 4 MiB keeps browser/proxy requests small and predictable.
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 50 * 1024 ** 3);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;
const TEMP_DIR = path.join(os.tmpdir(), 'cloud-zen-upload');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!APP_PASSWORD || !DELETE_PASSWORD || !SESSION_SECRET) {
  console.warn('[Cloud-Zen] APP_PASSWORD, DELETE_PASSWORD and SESSION_SECRET are required.');
}
if (!API_ID || !API_HASH || !TELEGRAM_SESSION) {
  console.warn('[Cloud-Zen] TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION are required.');
}
fs.mkdirSync(TEMP_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// JSON only applies to JSON requests; upload chunks use application/octet-stream.
app.use(express.json({ limit: '1mb' }));

const text = v => String(v ?? '');
const safeName = name => text(name || 'file').replace(/[\\/\0]/g, '_').trim().slice(0, 255) || 'file';
const errText = err => text(err?.errorMessage || err?.message || err || 'Unknown error');

function safeEqual(a, b) {
  const aa = Buffer.from(text(a));
  const bb = Buffer.from(text(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function hmac(value, secret = SESSION_SECRET) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}
function makeSessionToken() {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    exp: Date.now() + SESSION_TTL_MS,
    nonce: crypto.randomBytes(16).toString('hex')
  })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}
function validSessionToken(token) {
  try {
    const [payload, sig] = text(token).split('.');
    if (!payload || !sig || !safeEqual(sig, hmac(payload))) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data?.v === 1 && Number(data.exp) > Date.now();
  } catch { return false; }
}
function readSession(req) {
  const auth = text(req.headers.authorization);
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const match = text(req.headers.cookie).match(/(?:^|;\s*)cz_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
function requireAuth(req, res, next) {
  if (!validSessionToken(readSession(req))) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  next();
}
function setSession(res, token) {
  res.setHeader('Set-Cookie', `cz_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', 'cz_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}
function newId() { return crypto.randomBytes(16).toString('hex'); }
function bytesText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)) - 1);
  return `${(n / 1024 ** (i + 1)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}
function disposition(name, attachment) {
  const clean = safeName(name);
  const ascii = clean.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/* ---------------- Telegram: ONE client, ONE queue ---------------- */
const client = new TelegramClient(
  new StringSession(TELEGRAM_SESSION),
  API_ID,
  API_HASH,
  { connectionRetries: 5 }
);

let telegramReady = null;
let telegramChat = null;
let telegramAccount = null;
let lastTelegramError = null;
let indexCache = null;
let indexPromise = null;
let tgQueue = Promise.resolve();

function tgRun(label, fn) {
  const job = tgQueue.then(async () => {
    try {
      lastTelegramError = null;
      return await fn();
    } catch (err) {
      lastTelegramError = `${label}: ${errText(err)}`;
      throw err;
    }
  });
  tgQueue = job.catch(() => {});
  return job;
}

async function ensureTelegram() {
  if (telegramReady) return telegramReady;
  telegramReady = (async () => {
    if (!API_ID || !API_HASH || !TELEGRAM_SESSION) throw new Error('TELEGRAM_ENV_MISSING');
    await client.connect();
    if (!(await client.isUserAuthorized())) throw new Error('TELEGRAM_SESSION_NOT_AUTHORIZED');
    telegramAccount = await client.getMe();
    telegramChat = await client.getInputEntity(STORAGE_CHAT);
    console.log(`[Cloud-Zen] Telegram connected: ${telegramAccount?.username || telegramAccount?.firstName || telegramAccount?.id || 'account'}`);
    console.log(`[Cloud-Zen] Storage chat: ${STORAGE_CHAT}`);
    return true;
  })().catch(err => {
    telegramReady = null;
    throw err;
  });
  return telegramReady;
}

function fileCaption(file) {
  return `CZFILE3|${JSON.stringify({
    id: file.id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    chunks: file.chunks,
    created: file.created
  })}`;
}
function chunkCaption(id, index, total) { return `CZCHUNK3|${id}|${index}|${total}`; }
function opCaption(op) { return `CZOP3|${JSON.stringify(op)}`; }
function msgText(message) { return text(message?.message || message?.text); }

function parseFile(message) {
  const s = msgText(message);
  if (!s.startsWith('CZFILE3|')) return null;
  try {
    const x = JSON.parse(s.slice(8));
    if (!x?.id || !x?.name) return null;
    return { ...x, messageId: Number(message.id), source: 'cloud-zen' };
  } catch { return null; }
}
function parseChunk(message) {
  const p = msgText(message).split('|');
  if (p.length !== 4 || p[0] !== 'CZCHUNK3') return null;
  return { id: p[1], index: Number(p[2]), total: Number(p[3]), messageId: Number(message.id) };
}
function parseOp(message) {
  const s = msgText(message);
  if (!s.startsWith('CZOP3|')) return null;
  try { return JSON.parse(s.slice(6)); } catch { return null; }
}

// Detect older media already stored in the configured Telegram chat.
function legacyMediaInfo(message) {
  const media = message?.media;
  if (!media) return null;
  const doc = media?.document || media;
  const attrs = Array.isArray(doc?.attributes) ? doc.attributes : [];
  const filename = attrs.find(a => a?.className === 'DocumentAttributeFilename' || a?.constructor?.name === 'DocumentAttributeFilename');
  const video = attrs.find(a => a?.className === 'DocumentAttributeVideo' || a?.constructor?.name === 'DocumentAttributeVideo');
  const audio = attrs.find(a => a?.className === 'DocumentAttributeAudio' || a?.constructor?.name === 'DocumentAttributeAudio');
  const name = filename?.fileName || filename?.filename || (video ? `video-${message.id}.mp4` : audio ? `audio-${message.id}.mp3` : `telegram-${message.id}`);
  const size = Number(doc?.size || media?.size || message?.file?.size || 0);
  const mime = text(doc?.mimeType || message?.file?.mime || (video ? 'video/mp4' : audio ? 'audio/mpeg' : 'application/octet-stream'));
  if (!size) return null;
  return { id: `legacy-${message.id}`, name: safeName(name), size, mime, created: Number(message.date || 0) * 1000, messageId: Number(message.id), source: 'legacy' };
}

/*
  Telegram history is the durable index. No database is required.
  indexRecords contains private Telegram message IDs; public API strips them.
*/
async function rebuildIndex(force = false) {
  if (indexCache && !force) return indexCache;
  if (indexPromise && !force) return indexPromise;

  indexPromise = tgRun('scanIndex', async () => {
    await ensureTelegram();
    const files = new Map();
    const chunks = new Map();
    const ops = [];

    for await (const message of client.iterMessages(telegramChat, { limit: undefined })) {
      const f = parseFile(message);
      if (f) { files.set(f.id, f); continue; }
      const c = parseChunk(message);
      if (c) { if (!chunks.has(c.id)) chunks.set(c.id, []); chunks.get(c.id).push(c); continue; }
      const op = parseOp(message);
      if (op?.id) { ops.push(op); continue; }

      // Only show legacy media that is not one of our control messages.
      const legacy = legacyMediaInfo(message);
      if (legacy) files.set(legacy.id, legacy);
    }

    for (const [fileId, list] of chunks) {
      const f = files.get(fileId);
      if (f) f.chunkMessages = list.sort((a, b) => a.index - b.index);
    }

    for (const op of ops) {
      const f = files.get(op.id);
      if (!f) continue;
      if (op.type === 'rename' && op.name) f.name = safeName(op.name);
      if (op.type === 'hide') f.hidden = !!op.hidden;
      if (op.type === 'delete') f.deleted = true;
    }

    const records = [...files.values()].filter(f => !f.deleted).map(f => ({
      id: f.id,
      name: f.name,
      size: Number(f.size || 0),
      mime: f.mime || 'application/octet-stream',
      created: f.created || 0,
      source: f.source || 'cloud-zen',
      hidden: !!f.hidden,
      complete: f.source === 'legacy' || (Array.isArray(f.chunkMessages) && f.chunkMessages.length === Number(f.chunks)) || f.source === 'cloud-zen'
    }));

    indexCache = { records, internal: files };
    return indexCache;
  }).finally(() => { indexPromise = null; });

  return indexPromise;
}
function invalidateIndex() { indexCache = null; }

async function getInternalFile(fileId) {
  const index = await rebuildIndex();
  return index.internal.get(fileId) || null;
}

function publicFile(file) {
  return {
    id: file.id,
    name: file.name,
    size: Number(file.size || 0),
    mime: file.mime || 'application/octet-stream',
    created: file.created || 0,
    source: file.source || 'cloud-zen',
    hidden: !!file.hidden,
    complete: !!file.complete
  };
}

/* ---------------- Auth ---------------- */
app.post('/api/auth/login', (req, res) => {
  const password = text(req.body?.password);
  if (!APP_PASSWORD || !safeEqual(password, APP_PASSWORD)) return res.status(401).json({ error: 'INVALID_PASSWORD' });
  const token = makeSessionToken();
  setSession(res, token);
  res.json({ ok: true });
});
app.get('/api/auth/me', (req, res) => res.json({ authenticated: validSessionToken(readSession(req)) }));
app.post('/api/auth/logout', (_req, res) => { clearSession(res); res.json({ ok: true }); });

/* ---------------- Health ---------------- */
app.get('/api/health', async (_req, res) => {
  try {
    await tgRun('health', ensureTelegram);
    res.json({
      ok: true,
      service: 'cloud-zen-telegram-backend',
      telegram: true,
      account: telegramAccount?.username || telegramAccount?.firstName || telegramAccount?.id || null,
      storageChat: STORAGE_CHAT,
      singleProcessClient: true,
      chunkSize: CHUNK_SIZE,
      lastTelegramError
    });
  } catch (err) {
    res.status(503).json({ ok: false, telegram: false, error: errText(err), lastTelegramError });
  }
});

/* ---------------- Files / storage ---------------- */
app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const q = text(req.query.q).trim().toLowerCase();
    const showHidden = text(req.query.hidden) === 'true';
    const index = await rebuildIndex();
    const result = index.records
      .filter(f => showHidden ? f.hidden : !f.hidden)
      .filter(f => !q || f.name.toLowerCase().includes(q))
      .map(publicFile);
    res.json({ files: result, count: result.length });
  } catch (err) {
    console.error('[Cloud-Zen] FILE LIST:', errText(err));
    res.status(503).json({ error: 'TELEGRAM_UNAVAILABLE', detail: errText(err) });
  }
});

app.get('/api/storage', requireAuth, async (_req, res) => {
  try {
    const index = await rebuildIndex();
    const visible = index.records.filter(f => !f.hidden);
    const usedBytes = visible.reduce((sum, f) => sum + Number(f.size || 0), 0);
    const remainingBytes = Math.max(0, STORAGE_LIMIT - usedBytes);
    const usedPercent = STORAGE_LIMIT ? Math.min(100, Number(((usedBytes / STORAGE_LIMIT) * 100).toFixed(2))) : 0;
    res.json({
      usedBytes,
      remainingBytes,
      limitBytes: STORAGE_LIMIT,
      files: visible.length,
      hiddenFiles: index.records.filter(f => f.hidden).length,
      usedText: bytesText(usedBytes),
      remainingText: bytesText(remainingBytes),
      limitText: bytesText(STORAGE_LIMIT),
      usedPercent,
      telegram: true
    });
  } catch (err) {
    res.status(503).json({ error: 'TELEGRAM_UNAVAILABLE', detail: errText(err) });
  }
});

/* ---------------- Upload ---------------- */
app.post('/api/upload-chunk', requireAuth, express.raw({ type: '*/*', limit: '4.5mb' }), async (req, res) => {
  try {
    const fileId = text(req.headers['x-file-id']);
    const index = Number(req.headers['x-chunk-index']);
    const total = Number(req.headers['x-total-chunks']);
    const name = safeName(req.headers['x-file-name']);
    const size = Number(req.headers['x-file-size']);
    const mime = text(req.headers['x-file-mime'] || 'application/octet-stream').slice(0, 180);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (!fileId || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || index >= total || total < 1) {
      return res.status(400).json({ error: 'INVALID_UPLOAD_HEADERS' });
    }
    if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_SIZE) return res.status(413).json({ error: 'FILE_TOO_LARGE' });
    if (size > STORAGE_LIMIT) return res.status(413).json({ error: 'FILE_EXCEEDS_CLOUD_LIMIT' });
    if (body.length > CHUNK_SIZE + 64 * 1024) return res.status(413).json({ error: 'CHUNK_TOO_LARGE' });

    await tgRun(`upload:${fileId}:${index}`, async () => {
      await ensureTelegram();
      const temp = path.join(TEMP_DIR, `${fileId}-${index}-${crypto.randomBytes(8).toString('hex')}.bin`);
      await fsp.writeFile(temp, body);
      try {
        await client.sendFile(telegramChat, {
          file: temp,
          caption: chunkCaption(fileId, index, total),
          forceDocument: true
        });
        if (index === 0) {
          await client.sendMessage(telegramChat, {
            message: fileCaption({ id: fileId, name, size, mime, chunks: total, created: Date.now() })
          });
        }
      } finally {
        await fsp.rm(temp, { force: true }).catch(() => {});
      }
    });

    invalidateIndex();
    res.json({ ok: true, id: fileId, index, total, percent: Math.floor(((index + 1) / total) * 100) });
  } catch (err) {
    console.error('[Cloud-Zen] UPLOAD:', errText(err));
    res.status(503).json({ error: 'TELEGRAM_UPLOAD_FAILED', detail: errText(err) });
  }
});

/* ---------------- Telegram download / preview ---------------- */
async function sendTelegramContent(res, file, attachment) {
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  if (file.size) res.setHeader('Content-Length', String(file.size));
  res.setHeader('Content-Disposition', disposition(file.name, attachment));
  res.setHeader('Cache-Control', 'private, no-store');

  if (file.source === 'legacy') {
    await tgRun(`download:${file.id}`, async () => {
      const messages = await client.getMessages(telegramChat, { ids: [file.messageId] });
      const message = messages?.[0];
      if (!message) throw new Error('MISSING_TELEGRAM_MESSAGE');
      for await (const buf of client.iterDownload(message)) {
        if (res.destroyed) break;
        if (!res.write(buf)) await new Promise(resolve => res.once('drain', resolve));
      }
    });
  } else {
    const parts = [...(file.chunkMessages || [])].sort((a, b) => a.index - b.index);
    if (parts.length !== Number(file.chunks)) throw new Error('FILE_INCOMPLETE');
    for (const part of parts) {
      await tgRun(`download:${file.id}:${part.index}`, async () => {
        const messages = await client.getMessages(telegramChat, { ids: [part.messageId] });
        const message = messages?.[0];
        if (!message) throw new Error(`MISSING_TELEGRAM_CHUNK:${part.index}`);
        for await (const buf of client.iterDownload(message)) {
          if (res.destroyed) return;
          if (!res.write(buf)) await new Promise(resolve => res.once('drain', resolve));
        }
      });
    }
  }
  if (!res.destroyed) res.end();
}

app.get('/api/files/:id/content', requireAuth, async (req, res) => {
  try {
    const file = await getInternalFile(text(req.params.id));
    if (!file || file.deleted || file.hidden) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    await sendTelegramContent(res, file, text(req.query.download) === '1');
  } catch (err) {
    console.error('[Cloud-Zen] DOWNLOAD:', errText(err));
    if (!res.headersSent) res.status(503).json({ error: 'TELEGRAM_DOWNLOAD_FAILED', detail: errText(err) });
    else res.destroy();
  }
});

/* ---------------- Share links ---------------- */
function makeShareToken(fileId) {
  const payload = Buffer.from(JSON.stringify({ v: 1, id: fileId, exp: Date.now() + SHARE_TTL_MS })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}
function readShareToken(token) {
  try {
    const [payload, sig] = text(token).split('.');
    if (!payload || !sig || !safeEqual(sig, hmac(payload))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data?.v !== 1 || Number(data.exp) <= Date.now() || !data.id) return null;
    return data;
  } catch { return null; }
}
app.post('/api/files/:id/share', requireAuth, async (req, res) => {
  const fileId = text(req.params.id);
  try {
    const file = await getInternalFile(fileId);
    if (!file || file.deleted || file.hidden) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    const token = makeShareToken(fileId);
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, expiresAt: Date.now() + SHARE_TTL_MS, url: `${base}/share/${encodeURIComponent(token)}` });
  } catch (err) {
    res.status(503).json({ error: 'SHARE_FAILED', detail: errText(err) });
  }
});
app.get('/share/:token', async (req, res) => {
  const share = readShareToken(text(req.params.token));
  if (!share) return res.status(404).send('Share link expired or invalid.');
  try {
    const file = await getInternalFile(share.id);
    if (!file || file.deleted || file.hidden) return res.status(404).send('File not found.');
    await sendTelegramContent(res, file, false);
  } catch (err) {
    console.error('[Cloud-Zen] SHARE DOWNLOAD:', errText(err));
    if (!res.headersSent) res.status(503).send('Telegram is temporarily unavailable.');
    else res.destroy();
  }
});

/* ---------------- Rename / hide / delete ---------------- */
app.post('/api/files/:id/rename', requireAuth, async (req, res) => {
  const fileId = text(req.params.id);
  const name = safeName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'INVALID_NAME' });
  try {
    const file = await getInternalFile(fileId);
    if (!file || file.deleted) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    await tgRun('rename', async () => {
      await ensureTelegram();
      await client.sendMessage(telegramChat, { message: opCaption({ id: fileId, type: 'rename', name, at: Date.now() }) });
    });
    invalidateIndex();
    res.json({ ok: true, id: fileId, name });
  } catch (err) {
    res.status(503).json({ error: 'TELEGRAM_RENAME_FAILED', detail: errText(err) });
  }
});

app.post('/api/files/:id/hide', requireAuth, async (req, res) => {
  const fileId = text(req.params.id);
  const hidden = Boolean(req.body?.hidden);
  try {
    const file = await getInternalFile(fileId);
    if (!file || file.deleted) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    await tgRun('hide', async () => {
      await ensureTelegram();
      await client.sendMessage(telegramChat, { message: opCaption({ id: fileId, type: 'hide', hidden, at: Date.now() }) });
    });
    invalidateIndex();
    res.json({ ok: true, id: fileId, hidden });
  } catch (err) {
    res.status(503).json({ error: 'TELEGRAM_HIDE_FAILED', detail: errText(err) });
  }
});

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  const fileId = text(req.params.id);
  const password = text(req.body?.password || req.headers['x-delete-password']);
  if (!DELETE_PASSWORD || !safeEqual(password, DELETE_PASSWORD)) return res.status(403).json({ error: 'DELETE_PASSWORD_REQUIRED' });

  try {
    const file = await getInternalFile(fileId);
    if (!file || file.deleted) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    await tgRun('delete', async () => {
      await ensureTelegram();
      const ids = file.source === 'legacy'
        ? [file.messageId]
        : [file.messageId, ...(file.chunkMessages || []).map(x => x.messageId)].filter(Boolean);
      for (let i = 0; i < ids.length; i += 100) {
        await client.deleteMessages(telegramChat, ids.slice(i, i + 100), { revoke: true });
      }
      // Durable tombstone protects against a partial deletion or an old cache.
      await client.sendMessage(telegramChat, { message: opCaption({ id: fileId, type: 'delete', at: Date.now() }) });
    });
    invalidateIndex();
    res.json({ ok: true, id: fileId });
  } catch (err) {
    res.status(503).json({ error: 'TELEGRAM_DELETE_FAILED', detail: errText(err) });
  }
});

/* ---------------- Root / static UI ---------------- */
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Cloud-Zen] listening on 0.0.0.0:${PORT}`);
});
server.on('error', err => console.error('[Cloud-Zen] HTTP ERROR:', errText(err)));

// Connect once at startup. If Telegram is temporarily unreachable, requests will retry via ensureTelegram.
ensureTelegram().catch(err => console.error('[Cloud-Zen] Telegram startup:', errText(err)));

async function shutdown(signal) {
  console.log(`[Cloud-Zen] ${signal}: shutdown`);
  try { await tgRun('disconnect', () => client.disconnect()); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
