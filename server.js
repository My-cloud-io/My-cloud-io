/**
 * Cloud-Zen — Persistent Telegram Backend (single-file server)
 *
 * IMPORTANT:
 * Run this file on ONE persistent Node.js service (not a Vercel Function).
 * Vercel should host only the frontend/proxy. Do not run the same
 * TELEGRAM_SESSION in more than one backend instance.
 *
 * Required environment:
 * APP_PASSWORD
 * DELETE_PASSWORD
 * SESSION_SECRET
 * TELEGRAM_API_ID
 * TELEGRAM_API_HASH
 * TELEGRAM_SESSION
 * TELEGRAM_STORAGE_CHAT
 * PORT (optional, default 3000)
 *
 * Install:
 *   npm i express teleproto
 *
 * The Telegram account/session is kept as ONE process-wide client and every
 * Telegram operation is serialized through tgQueue. This is intentional:
 * using the same MTProto authorization key from multiple simultaneous
 * connections can invalidate the session with AUTH_KEY_DUPLICATED.
 */

'use strict';

const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const DELETE_PASSWORD = process.env.DELETE_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const SESSION = process.env.TELEGRAM_SESSION || '';
const STORAGE_CHAT = process.env.TELEGRAM_STORAGE_CHAT || '';
const MAX_CHUNK = 4 * 1024 * 1024; // keep below common serverless proxy limits
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 50 * 1024 * 1024 * 1024);
const TEMP_DIR = path.join(os.tmpdir(), 'cloud-zen');

if (!APP_PASSWORD || !SESSION_SECRET || !API_ID || !API_HASH || !SESSION || !STORAGE_CHAT) {
  console.warn('[Cloud-Zen] Missing one or more required environment variables.');
}

fs.mkdirSync(TEMP_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// JSON is used only by control endpoints. Upload chunks use raw bytes.
app.use('/api', express.json({ limit: '1mb', strict: true }));

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function makeToken() {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    nonce: crypto.randomBytes(16).toString('hex')
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = String(req.headers.cookie || '');
  const match = cookie.match(/(?:^|;\s*)cz_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function validToken(token) {
  try {
    if (!token) return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data?.v === 1 && Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function requireAuth(req, res, next) {
  if (!validToken(readToken(req))) {
    return res.status(401).json({ error: 'AUTH_REQUIRED' });
  }
  next();
}

function sendSession(res, token) {
  res.setHeader(
    'Set-Cookie',
    `cz_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`
  );
}

function clearSession(res) {
  res.setHeader(
    'Set-Cookie',
    'cz_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
  );
}

function errText(err) {
  return String(err?.errorMessage || err?.message || err || 'Unknown error');
}

function safeFileName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 180) || 'file';
}

function makeShareToken(fileId, ttlMs = 30 * 24 * 60 * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    id: String(fileId),
    exp: Date.now() + ttlMs,
    nonce: crypto.randomBytes(12).toString('hex')
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readShareToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data?.v !== 1 || !data?.id || Number(data.exp) <= Date.now()) return null;
    return data;
  } catch { return null; }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/*
 * One Telegram client for the whole process.
 * Never create a client inside a request handler.
 */
const client = new TelegramClient(
  new StringSession(SESSION),
  API_ID,
  API_HASH,
  { connectionRetries: 5 }
);

let tgReady = null;
let tgChat = null;
let tgAccount = null;
let lastTelegramError = null;
let indexCache = null;
let indexCacheAt = 0;
const INDEX_TTL_MS = 5000;

function invalidateIndexCache() { indexCache = null; indexCacheAt = 0; }

// Serialize ALL Telegram operations, including reads and writes.
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
  if (tgReady) return tgReady;
  tgReady = (async () => {
    await client.connect();

    if (!(await client.isUserAuthorized())) {
      throw new Error('TELEGRAM_SESSION_NOT_AUTHORIZED');
    }

    tgAccount = await client.getMe();
    tgChat = await client.getInputEntity(STORAGE_CHAT);

    console.log(`[Cloud-Zen] Telegram connected as ${tgAccount?.username || tgAccount?.firstName || tgAccount?.id || 'account'}`);
    console.log(`[Cloud-Zen] Storage chat resolved: ${STORAGE_CHAT}`);
    return true;
  })().catch(err => {
    tgReady = null;
    throw err;
  });

  return tgReady;
}

function newFileId() {
  return crypto.randomBytes(12).toString('hex');
}

function metaCaption(file) {
  // Compact JSON. This is the canonical file record.
  return `CZFILE1|${JSON.stringify({
    id: file.id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    chunks: file.chunks,
    created: file.created,
    hidden: !!file.hidden
  })}`;
}

function chunkCaption(id, index, total) {
  return `CZCHUNK1|${id}|${index}|${total}`;
}

function opCaption(op) {
  return `CZOP1|${JSON.stringify(op)}`;
}

function parseText(message) {
  return String(message?.message || message?.text || '');
}

function parseFileMeta(message) {
  const text = parseText(message);
  if (!text.startsWith('CZFILE1|')) return null;
  try {
    const x = JSON.parse(text.slice(7));
    if (!x?.id || !x?.name) return null;
    return {
      ...x,
      messageId: Number(message.id),
      hidden: !!x.hidden
    };
  } catch {
    return null;
  }
}

function parseChunk(message) {
  const text = parseText(message);
  if (!text.startsWith('CZCHUNK1|')) return null;
  const p = text.split('|');
  if (p.length !== 4) return null;
  return {
    id: p[1],
    index: Number(p[2]),
    total: Number(p[3]),
    messageId: Number(message.id)
  };
}

function parseOp(message) {
  const text = parseText(message);
  if (!text.startsWith('CZOP1|')) return null;
  try {
    return JSON.parse(text.slice(6));
  } catch {
    return null;
  }
}

/*
 * Scan storage chat and reconstruct state from canonical file records,
 * chunk records, and operation records.
 *
 * Telegram history is the durable index. No database or Vercel memory is
 * required for file metadata.
 */
async function scanIndex() {
  if (indexCache && Date.now() - indexCacheAt < INDEX_TTL_MS) return indexCache.map(x => ({ ...x }));
  return tgRun('scanIndex', async () => {
    if (indexCache && Date.now() - indexCacheAt < INDEX_TTL_MS) return indexCache.map(x => ({ ...x }));
    await ensureTelegram();

    const files = new Map();
    const chunks = new Map();
    const ops = [];

    for await (const message of client.iterMessages(tgChat, { limit: undefined })) {
      const meta = parseFileMeta(message);
      if (meta) {
        files.set(meta.id, meta);
        continue;
      }

      const chunk = parseChunk(message);
      if (chunk) {
        if (!chunks.has(chunk.id)) chunks.set(chunk.id, []);
        chunks.get(chunk.id).push(chunk);
        continue;
      }

      const op = parseOp(message);
      if (op?.id) ops.push(op);
    }

    for (const op of ops) {
      const f = files.get(op.id);
      if (!f) continue;
      if (op.type === 'rename' && typeof op.name === 'string' && op.name.trim()) {
        f.name = op.name.trim().slice(0, 255);
      } else if (op.type === 'hide') {
        f.hidden = !!op.hidden;
      } else if (op.type === 'delete') {
        f.deleted = true;
      }
    }

    for (const [id, list] of chunks) {
      list.sort((a, b) => a.index - b.index);
      const f = files.get(id);
      if (f) f.chunkMessages = list;
    }

    const result = [...files.values()]
      .filter(f => !f.deleted)
      .map(f => ({
        ...f,
        type: f.mime || 'application/octet-stream',
        chunkMessages: undefined,
        complete: Array.isArray(f.chunkMessages) && f.chunkMessages.length === Number(f.chunks)
      }));
    indexCache = result;
    indexCacheAt = Date.now();
    return result.map(x => ({ ...x }));
  });
}

async function findFile(fileId) {
  const all = await scanIndex();
  return all.find(f => f.id === fileId) || null;
}

async function findFileWithChunks(fileId) {
  return tgRun('findFile', async () => {
    await ensureTelegram();
    let file = null;
    const chunkMessages = [];

    for await (const message of client.iterMessages(tgChat, { limit: undefined })) {
      const meta = parseFileMeta(message);
      if (meta?.id === fileId) file = meta;

      const chunk = parseChunk(message);
      if (chunk?.id === fileId) chunkMessages.push(chunk);

      const op = parseOp(message);
      if (op?.id === fileId) {
        if (op.type === 'rename' && typeof op.name === 'string') file = file || { id: fileId }, file.name = op.name;
        if (op.type === 'hide') file = file || { id: fileId }, file.hidden = !!op.hidden;
        if (op.type === 'delete') file = file || { id: fileId }, file.deleted = true;
      }
    }

    if (!file || file.deleted) return null;
    chunkMessages.sort((a, b) => a.index - b.index);
    return { ...file, chunkMessages };
  });
}

function contentDisposition(name, attachment) {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name);
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ---------- Authentication ----------
app.post('/api/auth/login', (req, res) => {
  const password = String(req.body?.password || '');
  if (!APP_PASSWORD || !safeEqual(password, APP_PASSWORD)) {
    return res.status(401).json({ error: 'INVALID_PASSWORD' });
  }
  const token = makeToken();
  sendSession(res, token);
  return res.json({ ok: true, token });
});

app.get('/api/auth/me', (req, res) => {
  return res.json({ authenticated: validToken(readToken(req)) });
});

app.post('/api/auth/logout', (req, res) => {
  clearSession(res);
  return res.json({ ok: true });
});

// ---------- Health ----------
app.get('/api/health', async (req, res) => {
  try {
    await ensureTelegram();
    res.json({
      ok: true,
      telegram: true,
      account: tgAccount?.username || tgAccount?.firstName || tgAccount?.id || null,
      storageChat: STORAGE_CHAT,
      singleProcessClient: true,
      lastTelegramError
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      telegram: false,
      error: errText(err),
      lastTelegramError
    });
  }
});

// ---------- File listing ----------
app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const files = await scanIndex();
    const includeHidden = String(req.query.hidden || '') === 'true';
    const q = String(req.query.q || '').trim().toLowerCase();

    const result = files.filter(f => {
      if (!includeHidden && f.hidden) return false;
      if (includeHidden && !f.hidden) return false;
      return !q || f.name.toLowerCase().includes(q);
    });

    res.json(result);
  } catch (err) {
    console.error('[Cloud-Zen] FILE LIST ERROR:', err);
    res.status(503).json({ error: 'TELEGRAM_UNAVAILABLE', detail: errText(err) });
  }
});

app.get('/api/storage', requireAuth, async (req, res) => {
  try {
    const files = await scanIndex();
    const visible = files.filter(f => !f.hidden);
    const bytes = visible.reduce((n, f) => n + Number(f.size || 0), 0);
    res.json({
      usedBytes: bytes,
      files: visible.length,
      telegram: true
    });
  } catch (err) {
    res.status(503).json({ error: 'TELEGRAM_UNAVAILABLE', detail: errText(err) });
  }
});

// ---------- Upload ----------
// Browser sends one raw binary chunk per request.
// The persistent backend writes each chunk to a temporary file, then Telegram
// stores it as a document message. Temporary files are removed immediately.
app.post(
  '/api/upload-chunk',
  requireAuth,
  express.raw({ type: '*/*', limit: '4.25mb' }),
  async (req, res) => {
    try {
      const fileId = String(req.headers['x-file-id'] || '');
      const index = Number(req.headers['x-chunk-index']);
      const total = Number(req.headers['x-total-chunks']);
      const name = String(req.headers['x-file-name'] || 'file').slice(0, 255);
      const size = Number(req.headers['x-file-size']);
      const mime = String(req.headers['x-file-mime'] || 'application/octet-stream').slice(0, 150);

      if (!fileId || !Number.isInteger(index) || !Number.isInteger(total) ||
          index < 0 || total < 1 || index >= total ||
          !Number.isFinite(size) || size < 0 || size > MAX_FILE_SIZE) {
        return res.status(400).json({ error: 'INVALID_UPLOAD_HEADERS' });
      }

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!body.length && size > 0) return res.status(400).json({ error: 'EMPTY_CHUNK' });
      if (body.length > MAX_CHUNK + 256 * 1024) return res.status(413).json({ error: 'CHUNK_TOO_LARGE' });

      await tgRun('uploadChunk', async () => {
        await ensureTelegram();

        const temp = path.join(TEMP_DIR, `${safeFileName(name)}-${String(index).padStart(6, '0')}-${crypto.randomBytes(4).toString('hex')}`);
        await fsp.writeFile(temp, body);

        try {
          await client.sendFile(tgChat, {
            file: temp,
            caption: chunkCaption(fileId, index, total),
            forceDocument: true
          });

          // First chunk creates the canonical file record.
          if (index === 0) {
            await client.sendMessage(tgChat, {
              message: metaCaption({
                id: fileId,
                name,
                size,
                mime,
                chunks: total,
                created: Date.now(),
                hidden: false
              })
            });
          }
        } finally {
          await fsp.rm(temp, { force: true });
        }
      });

      return res.json({ ok: true, id: fileId, index, total });
    } catch (err) {
      console.error('[Cloud-Zen] UPLOAD CHUNK ERROR:', err);
      return res.status(503).json({ error: 'TELEGRAM_UPLOAD_FAILED', detail: errText(err) });
    }
  }
);

// ---------- Download / Open ----------
app.get('/api/files/:id/content', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  const attachment = String(req.query.download || '') === '1';

  try {
    const file = await findFileWithChunks(id);
    if (!file || !file.chunkMessages?.length) {
      return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    }

    res.status(200);
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', contentDisposition(file.name, attachment));
    res.setHeader('Cache-Control', 'private, no-store');

    for (const part of file.chunkMessages) {
      await tgRun(`downloadChunk:${part.index}`, async () => {
        const messages = await client.getMessages(tgChat, { ids: [part.messageId] });
        const message = messages?.[0];
        if (!message) throw new Error(`MISSING_TELEGRAM_CHUNK:${part.index}`);

        for await (const buf of client.iterDownload(message)) {
          if (!res.destroyed) {
            if (!res.write(buf)) {
              await new Promise(resolve => res.once('drain', resolve));
            }
          }
        }
      });
    }

    if (!res.destroyed) res.end();
  } catch (err) {
    console.error('[Cloud-Zen] DOWNLOAD ERROR:', err);
    if (!res.headersSent) {
      return res.status(503).json({ error: 'TELEGRAM_DOWNLOAD_FAILED', detail: errText(err) });
    }
    res.destroy();
  }
});

// ---------- Rename ----------
app.post('/api/files/:id/rename', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  const name = String(req.body?.name || '').trim().slice(0, 255);
  if (!name) return res.status(400).json({ error: 'INVALID_NAME' });

  try {
    const old = await findFileWithChunks(id);
    if (!old) return res.status(404).json({ error: 'FILE_NOT_FOUND' });

    await tgRun('rename', async () => {
      await ensureTelegram();
      const newId = newFileId();
      const replacementIds = [];
      for (const part of old.chunkMessages) {
        const temp = path.join(TEMP_DIR, `${safeFileName(name)}-${String(part.index).padStart(6, '0')}-${crypto.randomBytes(4).toString('hex')}.bin`);
        try {
          const out = fs.createWriteStream(temp);
          for await (const buf of client.iterDownload(await getTelegramMessage(part.messageId))) {
            if (!out.write(buf)) await new Promise(resolve => out.once('drain', resolve));
          }
          await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
          const sent = await client.sendFile(tgChat, {
            file: temp,
            caption: chunkCaption(newId, part.index, old.chunks),
            forceDocument: true
          });
          const sentId = Number(sent?.id || sent?.message?.id || 0);
          if (sentId) replacementIds.push(sentId);
        } finally {
          await fsp.rm(temp, { force: true });
        }
      }
      if (replacementIds.length !== Number(old.chunks)) throw new Error('RENAME_REUPLOAD_INCOMPLETE');

      await client.sendMessage(tgChat, {
        message: metaCaption({
          id: newId,
          name,
          size: old.size,
          mime: old.mime,
          chunks: old.chunks,
          created: old.created || Date.now(),
          hidden: false
        })
      });

      const oldIds = old.chunkMessages.map(x => x.messageId).filter(Boolean);
      if (old.messageId) oldIds.push(old.messageId);
      for (let i = 0; i < oldIds.length; i += 100) {
        await client.deleteMessages(tgChat, oldIds.slice(i, i + 100), { revoke: true });
      }
      await client.sendMessage(tgChat, { message: opCaption({ id, type: 'delete', at: Date.now() }) });
      invalidateIndexCache();
    });

    res.json({ ok: true, id, name });
  } catch (err) {
    res.status(503).json({ error: 'TELEGRAM_RENAME_FAILED', detail: errText(err) });
  }
});

// ---------- Hide / Unhide ----------
app.post('/api/files/:id/hide', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  const hidden = !!req.body?.hidden;

  try {
    const file = await findFile(id);
    if (!file) return res.status(404).json({ error: 'FILE_NOT_FOUND' });

    await tgRun('hide', async () => {
      await ensureTelegram();
      await client.sendMessage(tgChat, {
        message: opCaption({ id, type: 'hide', hidden, at: Date.now() })
      });
      invalidateIndexCache();
    });

    res.json({ ok: true, id, hidden });
  } catch (err) {
    res.status(503).json({ error: 'TELEGRAM_HIDE_FAILED', detail: errText(err) });
  }
});

// ---------- Delete ----------
app.delete('/api/files/:id', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  const password = String(req.body?.password || req.headers['x-delete-password'] || '');

  if (!DELETE_PASSWORD || !safeEqual(password, DELETE_PASSWORD)) {
    return res.status(403).json({ error: 'DELETE_PASSWORD_REQUIRED' });
  }

  try {
    const file = await findFileWithChunks(id);
    if (!file) return res.status(404).json({ error: 'FILE_NOT_FOUND' });

    await tgRun('delete', async () => {
      await ensureTelegram();

      const ids = file.chunkMessages.map(x => x.messageId).filter(Boolean);
      if (file.messageId) ids.push(file.messageId);

      // Delete the actual media chunks. The operation record is deliberately
      // also written so a partial Telegram deletion cannot make the file
      // reappear in the web index.
      if (ids.length) {
        for (let i = 0; i < ids.length; i += 100) {
          await client.deleteMessages(tgChat, ids.slice(i, i + 100), { revoke: true });
        }
      }

      await client.sendMessage(tgChat, {
        message: opCaption({ id, type: 'delete', at: Date.now() })
      });
      invalidateIndexCache();
    });

    res.json({ ok: true, id });
  } catch (err) {
    res.status(503).json({ error: 'TELEGRAM_DELETE_FAILED', detail: errText(err) });
  }
});


async function getTelegramMessage(messageId) {
  const messages = await client.getMessages(tgChat, { ids: [messageId] });
  const message = messages?.[0];
  if (!message) throw new Error(`MISSING_TELEGRAM_CHUNK:${messageId}`);
  return message;
}

// ---------- Compatibility routes for the existing Cloud-Zen UI ----------
async function resolveFileFromRequest(name, fileId) {
  if (fileId) return findFileWithChunks(String(fileId));
  const wanted = decodeURIComponent(String(name || '')).split('/').pop().toLowerCase();
  const files = await scanIndex();
  const match = files.find(f => String(f.name || '').split('/').pop().toLowerCase() === wanted);
  return match ? findFileWithChunks(match.id) : null;
}

async function pipeFileToResponse(file, res, attachment = false) {
  if (!file || !file.chunkMessages?.length) return false;
  res.status(200);
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('Content-Disposition', contentDisposition(file.name, attachment));
  res.setHeader('Cache-Control', attachment ? 'private, no-store' : 'private, max-age=60');
  for (const part of file.chunkMessages) {
    await tgRun(`downloadChunk:${part.index}`, async () => {
      const messages = await client.getMessages(tgChat, { ids: [part.messageId] });
      const message = messages?.[0];
      if (!message) throw new Error(`MISSING_TELEGRAM_CHUNK:${part.index}`);
      for await (const buf of client.iterDownload(message)) {
        if (!res.destroyed) {
          if (!res.write(buf)) await new Promise(resolve => res.once('drain', resolve));
        }
      }
    });
  }
  if (!res.destroyed) res.end();
  return true;
}

// Preview access compatibility token. The protected stream still requires the normal login cookie.
app.get('/api/access/stream', requireAuth, (_req, res) => {
  const token = crypto.randomBytes(24).toString('base64url');
  res.json({ token, expiresIn: 900 });
});

// Existing frontend uses /api/stream/:name?fileId=... and /api/download/:name?fileId=...
app.get('/api/stream/:name', requireAuth, async (req, res) => {
  try {
    const file = await resolveFileFromRequest(req.params.name, req.query.fileId);
    if (!file) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    await pipeFileToResponse(file, res, false);
  } catch (err) {
    console.error('[Cloud-Zen] STREAM ERROR:', errText(err));
    if (!res.headersSent) res.status(503).json({ error: 'TELEGRAM_STREAM_FAILED', detail: errText(err) });
    else res.destroy();
  }
});

app.get('/api/download/:name', requireAuth, async (req, res) => {
  try {
    const file = await resolveFileFromRequest(req.params.name, req.query.fileId);
    if (!file) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    await pipeFileToResponse(file, res, true);
  } catch (err) {
    console.error('[Cloud-Zen] DOWNLOAD COMPAT ERROR:', errText(err));
    if (!res.headersSent) res.status(503).json({ error: 'TELEGRAM_DOWNLOAD_FAILED', detail: errText(err) });
    else res.destroy();
  }
});

// Existing frontend rename/delete contract.
app.patch('/api/files', requireAuth, async (req, res) => {
  const oldName = String(req.body?.name || '').trim();
  const newName = String(req.body?.newName || '').trim().slice(0, 255);
  if (!oldName || !newName) return res.status(400).json({ error: 'INVALID_NAME' });
  try {
    const files = await scanIndex();
    const file = files.find(f => String(f.name || '') === oldName || String(f.name || '').split('/').pop() === oldName.split('/').pop());
    if (!file) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    await tgRun('rename', async () => {
      await ensureTelegram();
      await client.sendMessage(tgChat, { message: opCaption({ id: file.id, type: 'rename', name: newName, at: Date.now() }) });
      invalidateIndexCache();
    });
    return res.json({ ok: true, id: file.id, name: newName });
  } catch (err) {
    return res.status(503).json({ error: 'TELEGRAM_RENAME_FAILED', detail: errText(err) });
  }
});

app.delete('/api/files', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.deletePassword || req.body?.password || req.headers['x-delete-password'] || '');
  if (!DELETE_PASSWORD || !safeEqual(password, DELETE_PASSWORD)) return res.status(403).json({ error: 'DELETE_PASSWORD_REQUIRED' });
  try {
    const files = await scanIndex();
    const file = files.find(f => String(f.name || '') === name || String(f.name || '').split('/').pop() === name.split('/').pop());
    if (!file) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    const full = await findFileWithChunks(file.id);
    if (!full) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    await tgRun('delete', async () => {
      await ensureTelegram();
      const ids = full.chunkMessages.map(x => x.messageId).filter(Boolean);
      if (full.messageId) ids.push(full.messageId);
      for (let i = 0; i < ids.length; i += 100) await client.deleteMessages(tgChat, ids.slice(i, i + 100), { revoke: true });
      await client.sendMessage(tgChat, { message: opCaption({ id: file.id, type: 'delete', at: Date.now() }) });
      invalidateIndexCache();
    });
    return res.json({ ok: true, id: file.id });
  } catch (err) {
    return res.status(503).json({ error: 'TELEGRAM_DELETE_FAILED', detail: errText(err) });
  }
});

// ---------- Public sharing ----------
app.post('/api/share', requireAuth, async (req, res) => {
  const id = String(req.body?.id || req.body?.fileId || '').trim();
  try {
    let file = id ? await findFile(id) : null;
    if (!file && req.body?.name) {
      const files = await scanIndex();
      file = files.find(f => String(f.name || '') === String(req.body.name));
    }
    if (!file) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    const token = makeShareToken(file.id);
    const base = `${req.protocol}://${req.get('host')}`;
    return res.json({
      ok: true,
      name: file.name,
      url: `${base}/s/${encodeURIComponent(token)}`,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
    });
  } catch (err) {
    return res.status(503).json({ error: 'SHARE_FAILED', detail: errText(err) });
  }
});

app.get('/s/:token', async (req, res) => {
  const data = readShareToken(req.params.token);
  if (!data) return res.status(410).send('<!doctype html><meta charset="utf-8"><title>Cloud-Zen</title><h2>Share link expired</h2>');
  try {
    const file = await findFileWithChunks(data.id);
    if (!file) return res.status(404).send('<!doctype html><meta charset="utf-8"><title>Cloud-Zen</title><h2>File not found</h2>');
    const mediaUrl = `/api/shared-stream/${encodeURIComponent(req.params.token)}`;
    const type = String(file.mime || 'application/octet-stream');
    let media = `<div class="filebox"><div class="fileicon">FILE</div><a class="download" href="${mediaUrl}?download=1">Download ${escapeHtml(file.name)}</a></div>`;
    if (type.startsWith('image/')) media = `<img src="${mediaUrl}" alt="${escapeHtml(file.name)}">`;
    else if (type.startsWith('video/')) media = `<video src="${mediaUrl}" controls playsinline preload="metadata"></video>`;
    else if (type.startsWith('audio/')) media = `<audio src="${mediaUrl}" controls preload="metadata"></audio>`;
    else if (type === 'application/pdf') media = `<iframe src="${mediaUrl}" title="${escapeHtml(file.name)}"></iframe>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta property="og:title" content="${escapeHtml(file.name)}"><meta property="og:site_name" content="My Personal Cloud"><meta name="description" content="Shared from My Personal Cloud"><title>${escapeHtml(file.name)} — My Personal Cloud</title><style>body{margin:0;min-height:100vh;background:#07111f;color:#f5f8ff;font-family:system-ui;padding:24px;display:grid;place-items:center}.card{width:min(900px,100%);background:rgba(17,31,50,.88);border:1px solid rgba(255,255,255,.12);border-radius:24px;padding:22px;box-sizing:border-box;text-align:center}h1{font-size:20px;word-break:break-word}.brand{color:#9ed7ff;font-weight:700;margin-bottom:8px}img,video,iframe{max-width:100%;width:100%;max-height:72vh;border-radius:16px;background:#02070d}audio{width:100%}.download{display:inline-block;margin-top:16px;padding:12px 16px;border-radius:12px;background:#8fc8ff;color:#06101d;text-decoration:none;font-weight:700}.filebox{padding:30px}</style></head><body><main class="card"><div class="brand">My Personal Cloud</div><h1>${escapeHtml(file.name)}</h1>${media}</main></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    return res.status(503).send(`<h2>Cloud-Zen unavailable</h2><p>${escapeHtml(errText(err))}</p>`);
  }
});

app.get('/api/shared-stream/:token', async (req, res) => {
  const data = readShareToken(req.params.token);
  if (!data) return res.status(410).json({ error: 'SHARE_EXPIRED' });
  try {
    const file = await findFileWithChunks(data.id);
    if (!file) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    await pipeFileToResponse(file, res, String(req.query.download || '') === '1');
  } catch (err) {
    console.error('[Cloud-Zen] SHARED STREAM ERROR:', errText(err));
    if (!res.headersSent) res.status(503).json({ error: 'TELEGRAM_SHARED_STREAM_FAILED', detail: errText(err) });
    else res.destroy();
  }
});

// ---------- Root / fallback ----------
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api', (_req, res) => res.json({ ok: true, service: 'cloud-zen' }));

app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

// ---------- Startup ----------
const server = app.listen(PORT, () => {
  console.log(`[Cloud-Zen] Persistent backend listening on :${PORT}`);
});

server.on('error', (err) => {
  console.error('[Cloud-Zen] HTTP SERVER ERROR:', err);
  process.exitCode = 1;
});

// Connect exactly once when the process starts.
// A failure is logged; health/API calls can retry via ensureTelegram().
ensureTelegram().catch((err) => {
  console.error('[Cloud-Zen] Telegram startup connection failed:', errText(err));
});

async function shutdown(signal) {
  console.log(`[Cloud-Zen] ${signal}: shutting down`);
  try { await client.disconnect(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
