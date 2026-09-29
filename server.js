'use strict';

/* Cloud-Zen — single persistent Telegram-backed cloud server.
 * Run ONE instance only. Do not run the same TELEGRAM_SESSION in multiple
 * processes/containers; Telegram can invalidate the authorization key.
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
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const DELETE_PASSWORD = process.env.DELETE_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const TELEGRAM_SESSION = process.env.TELEGRAM_SESSION || '';
const STORAGE_CHAT = process.env.TELEGRAM_STORAGE_CHAT || '';
const STORAGE_LIMIT = Number(process.env.STORAGE_LIMIT_BYTES || 10 * 1024 ** 3);
const CHUNK_SIZE = Math.min(Math.max(Number(process.env.CHUNK_SIZE || 4 * 1024 * 1024), 512 * 1024), 8 * 1024 * 1024);
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 50 * 1024 ** 3);
const TEMP_DIR = path.join(os.tmpdir(), 'cloud-zen-upload');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!APP_PASSWORD || !DELETE_PASSWORD || !API_ID || !API_HASH || !TELEGRAM_SESSION || !STORAGE_CHAT) {
  console.warn('[Cloud-Zen] One or more required environment variables are missing.');
}
fs.mkdirSync(TEMP_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

function text(v) { return String(v ?? ''); }
function safeEqual(a, b) {
  const aa = Buffer.from(text(a));
  const bb = Buffer.from(text(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ v: 1, exp: Date.now() + 7 * 24 * 3600 * 1000, n: crypto.randomBytes(12).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function getToken(req) {
  const auth = text(req.headers.authorization);
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const m = text(req.headers.cookie).match(/(?:^|;\s*)cz_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
function validToken(token) {
  try {
    const [p, s] = text(token).split('.');
    if (!p || !s || !safeEqual(s, sign(p))) return false;
    const x = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return x.v === 1 && Number(x.exp) > Date.now();
  } catch { return false; }
}
function requireAuth(req, res, next) {
  if (!validToken(getToken(req))) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  next();
}
function setSession(res, token) {
  res.setHeader('Set-Cookie', `cz_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', 'cz_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}
function errText(err) { return text(err?.errorMessage || err?.message || err || 'Unknown error'); }
function id() { return crypto.randomBytes(16).toString('hex'); }
function safeName(name) { return text(name || 'file').replace(/[\\/]/g, '_').trim().slice(0, 255) || 'file'; }
function contentDisposition(name, attachment) {
  const ascii = safeName(name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safeName(name))}`;
}
function bytesText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)) - 1);
  return `${(n / 1024 ** (i + 1)).toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

const client = new TelegramClient(new StringSession(TELEGRAM_SESSION), API_ID, API_HASH, { connectionRetries: 5 });
let tgReady = null;
let tgChat = null;
let tgAccount = null;
let lastTelegramError = null;
let indexCache = null;
let indexPromise = null;
let tgQueue = Promise.resolve();

// Every Telegram operation is serialized. This is the important fix for
// AUTH_KEY_DUPLICATED when several browser requests arrive together.
function tgRun(label, fn) {
  const run = tgQueue.then(async () => {
    try {
      lastTelegramError = null;
      return await fn();
    } catch (e) {
      lastTelegramError = `${label}: ${errText(e)}`;
      throw e;
    }
  });
  tgQueue = run.catch(() => {});
  return run;
}

async function ensureTelegram() {
  if (tgReady) return tgReady;
  tgReady = (async () => {
    await client.connect();
    if (!(await client.isUserAuthorized())) throw new Error('TELEGRAM_SESSION_NOT_AUTHORIZED');
    tgAccount = await client.getMe();
    tgChat = await client.getInputEntity(STORAGE_CHAT);
    console.log(`[Cloud-Zen] Telegram connected: ${tgAccount?.username || tgAccount?.firstName || tgAccount?.id || 'account'}`);
    console.log(`[Cloud-Zen] Storage chat: ${STORAGE_CHAT}`);
    return true;
  })().catch(e => { tgReady = null; throw e; });
  return tgReady;
}

function fileCaption(file) {
  return `CZFILE2|${JSON.stringify({ id: file.id, name: file.name, size: file.size, mime: file.mime, chunks: file.chunks, created: file.created })}`;
}
function chunkCaption(fileId, index, total) { return `CZCHUNK2|${fileId}|${index}|${total}`; }
function opCaption(op) { return `CZOP2|${JSON.stringify(op)}`; }
function messageText(m) { return text(m?.message || m?.text); }
function parseFile(m) {
  const s = messageText(m); if (!s.startsWith('CZFILE2|')) return null;
  try { const x = JSON.parse(s.slice(8)); return x?.id && x?.name ? { ...x, messageId: Number(m.id), source: 'cloud-zen' } : null; } catch { return null; }
}
function parseChunk(m) {
  const s = messageText(m); if (!s.startsWith('CZCHUNK2|')) return null;
  const p = s.split('|');
  if (p.length !== 4) return null;
  return { id: p[1], index: Number(p[2]), total: Number(p[3]), messageId: Number(m.id) };
}
function parseOp(m) {
  const s = messageText(m); if (!s.startsWith('CZOP2|')) return null;
  try { return JSON.parse(s.slice(6)); } catch { return null; }
}

function mediaInfo(m) {
  const media = m?.media;
  const doc = media?.document || media;
  const attrs = Array.isArray(doc?.attributes) ? doc.attributes : [];
  const filenameAttr = attrs.find(a => a?.className === 'DocumentAttributeFilename' || a?.constructor?.name === 'DocumentAttributeFilename');
  const videoAttr = attrs.find(a => a?.className === 'DocumentAttributeVideo' || a?.constructor?.name === 'DocumentAttributeVideo');
  const audioAttr = attrs.find(a => a?.className === 'DocumentAttributeAudio' || a?.constructor?.name === 'DocumentAttributeAudio');
  const name = filenameAttr?.fileName || filenameAttr?.filename || (videoAttr ? `video-${m.id}.mp4` : audioAttr ? `audio-${m.id}.mp3` : `telegram-${m.id}`);
  const size = Number(doc?.size || media?.size || m?.file?.size || 0);
  const mime = text(doc?.mimeType || m?.file?.mime || (videoAttr ? 'video/mp4' : audioAttr ? 'audio/mpeg' : 'application/octet-stream'));
  if (!size && !doc && !media) return null;
  return { id: `legacy-${m.id}`, name: safeName(name), size, mime, created: Number(m.date || 0) * 1000, messageId: Number(m.id), source: 'legacy' };
}

async function rebuildIndex(force = false) {
  if (indexCache && !force) return indexCache;
  if (indexPromise && !force) return indexPromise;
  indexPromise = tgRun('scanIndex', async () => {
    await ensureTelegram();
    const files = new Map();
    const chunks = new Map();
    const ops = [];
    for await (const m of client.iterMessages(tgChat, { limit: undefined })) {
      const f = parseFile(m);
      if (f) { files.set(f.id, f); continue; }
      const c = parseChunk(m);
      if (c) { if (!chunks.has(c.id)) chunks.set(c.id, []); chunks.get(c.id).push(c); continue; }
      const op = parseOp(m);
      if (op?.id) { ops.push(op); continue; }
      const legacy = mediaInfo(m);
      if (legacy) files.set(legacy.id, legacy);
    }
    for (const [fid, list] of chunks) {
      const f = files.get(fid); if (f) f.chunkMessages = list.sort((a, b) => a.index - b.index);
    }
    for (const op of ops) {
      const f = files.get(op.id); if (!f) continue;
      if (op.type === 'rename' && op.name) f.name = safeName(op.name);
      if (op.type === 'delete') f.deleted = true;
    }
    const result = [...files.values()].filter(f => !f.deleted).map(f => ({
      id: f.id, name: f.name, size: Number(f.size || 0), mime: f.mime || 'application/octet-stream',
      created: f.created || 0, source: f.source || 'cloud-zen',
      complete: f.source === 'legacy' || (Array.isArray(f.chunkMessages) && f.chunkMessages.length === Number(f.chunks))
    }));
    indexCache = result;
    return result;
  }).finally(() => { indexPromise = null; });
  return indexPromise;
}
function invalidateIndex() { indexCache = null; }
async function getFileWithMessages(fileId) {
  const all = await rebuildIndex();
  const f = all.find(x => x.id === fileId);
  if (!f) return null;
  if (f.source === 'legacy') return f;
  return tgRun('findFile', async () => {
    await ensureTelegram();
    let meta = null; const parts = [];
    for await (const m of client.iterMessages(tgChat, { limit: undefined })) {
      const x = parseFile(m); if (x?.id === fileId) meta = x;
      const c = parseChunk(m); if (c?.id === fileId) parts.push(c);
    }
    if (!meta) return null;
    parts.sort((a, b) => a.index - b.index);
    return { ...meta, chunkMessages: parts };
  });
}

// ---------- Auth ----------
app.post('/api/auth/login', (req, res) => {
  const p = text(req.body?.password);
  if (!APP_PASSWORD || !safeEqual(p, APP_PASSWORD)) return res.status(401).json({ error: 'INVALID_PASSWORD' });
  const token = makeToken(); setSession(res, token); res.json({ ok: true });
});
app.get('/api/auth/me', (req, res) => res.json({ authenticated: validToken(getToken(req)) }));
app.post('/api/auth/logout', (_req, res) => { clearSession(res); res.json({ ok: true }); });

// ---------- Health ----------
app.get('/api/health', async (_req, res) => {
  try {
    await tgRun('health', ensureTelegram);
    res.json({ ok: true, telegram: true, account: tgAccount?.username || tgAccount?.firstName || tgAccount?.id || null, storageChat: STORAGE_CHAT, singleProcessClient: true, lastTelegramError });
  } catch (e) {
    res.status(503).json({ ok: false, telegram: false, error: errText(e), lastTelegramError });
  }
});

// ---------- Files / storage ----------
app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const q = text(req.query.q).trim().toLowerCase();
    let files = await rebuildIndex();
    if (q) files = files.filter(f => f.name.toLowerCase().includes(q));
    res.json(files);
  } catch (e) { res.status(503).json({ error: 'TELEGRAM_UNAVAILABLE', detail: errText(e) }); }
});
app.get('/api/storage', requireAuth, async (_req, res) => {
  try {
    const files = await rebuildIndex();
    const usedBytes = files.reduce((n, f) => n + Number(f.size || 0), 0);
    const remainingBytes = Math.max(0, STORAGE_LIMIT - usedBytes);
    const usedPercent = STORAGE_LIMIT ? Math.min(100, Number(((usedBytes / STORAGE_LIMIT) * 100).toFixed(2))) : 0;
    res.json({ usedBytes, remainingBytes, limitBytes: STORAGE_LIMIT, files: files.length, usedText: bytesText(usedBytes), remainingText: bytesText(remainingBytes), limitText: bytesText(STORAGE_LIMIT), usedPercent, telegram: true });
  } catch (e) { res.status(503).json({ error: 'TELEGRAM_UNAVAILABLE', detail: errText(e) }); }
});

// ---------- Upload ----------
app.post('/api/upload-chunk', requireAuth, express.raw({ type: '*/*', limit: '8.5mb' }), async (req, res) => {
  try {
    const fileId = text(req.headers['x-file-id']);
    const index = Number(req.headers['x-chunk-index']);
    const total = Number(req.headers['x-total-chunks']);
    const name = safeName(req.headers['x-file-name']);
    const size = Number(req.headers['x-file-size']);
    const mime = text(req.headers['x-file-mime'] || 'application/octet-stream').slice(0, 180);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!fileId || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || index >= total || total < 1 || !Number.isFinite(size) || size < 0 || size > MAX_FILE_SIZE) return res.status(400).json({ error: 'INVALID_UPLOAD_HEADERS' });
    if (body.length > CHUNK_SIZE + 256 * 1024) return res.status(413).json({ error: 'CHUNK_TOO_LARGE' });
    if (size > STORAGE_LIMIT) return res.status(413).json({ error: 'FILE_EXCEEDS_CLOUD_LIMIT' });

    await tgRun(`upload:${fileId}:${index}`, async () => {
      await ensureTelegram();
      const temp = path.join(TEMP_DIR, `${fileId}-${index}-${crypto.randomBytes(6).toString('hex')}.bin`);
      await fsp.writeFile(temp, body);
      try {
        await client.sendFile(tgChat, { file: temp, caption: chunkCaption(fileId, index, total), forceDocument: true });
        if (index === 0) {
          await client.sendMessage(tgChat, { message: fileCaption({ id: fileId, name, size, mime, chunks: total, created: Date.now() }) });
        }
      } finally { await fsp.rm(temp, { force: true }); }
    });
    invalidateIndex();
    res.json({ ok: true, id: fileId, index, total });
  } catch (e) { console.error('[Cloud-Zen] UPLOAD:', e); res.status(503).json({ error: 'TELEGRAM_UPLOAD_FAILED', detail: errText(e) }); }
});

async function streamTelegramFile(res, file, attachment) {
  res.status(200);
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  if (file.size) res.setHeader('Content-Length', String(file.size));
  res.setHeader('Content-Disposition', contentDisposition(file.name, attachment));
  res.setHeader('Cache-Control', 'private, no-store');
  if (file.source === 'legacy') {
    await tgRun(`download:${file.id}`, async () => {
      const messages = await client.getMessages(tgChat, { ids: [file.messageId] });
      const m = messages?.[0]; if (!m) throw new Error('MISSING_TELEGRAM_MESSAGE');
      for await (const buf of client.iterDownload(m)) { if (!res.destroyed && !res.write(buf)) await new Promise(r => res.once('drain', r)); }
    });
  } else {
    for (const part of file.chunkMessages || []) {
      await tgRun(`download:${file.id}:${part.index}`, async () => {
        const messages = await client.getMessages(tgChat, { ids: [part.messageId] });
        const m = messages?.[0]; if (!m) throw new Error(`MISSING_TELEGRAM_CHUNK:${part.index}`);
        for await (const buf of client.iterDownload(m)) { if (!res.destroyed && !res.write(buf)) await new Promise(r => res.once('drain', r)); }
      });
    }
  }
  if (!res.destroyed) res.end();
}

app.get('/api/files/:id/content', requireAuth, async (req, res) => {
  try {
    const file = await getFileWithMessages(text(req.params.id));
    if (!file) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    await streamTelegramFile(res, file, text(req.query.download) === '1');
  } catch (e) { if (!res.headersSent) res.status(503).json({ error: 'TELEGRAM_DOWNLOAD_FAILED', detail: errText(e) }); else res.destroy(); }
});
// Aliases used by older Cloud-Zen pages.
app.get('/api/stream/:id', requireAuth, async (req, res) => { req.url = `/api/files/${encodeURIComponent(req.params.id)}/content`; });
app.get('/api/download/:id', requireAuth, async (req, res) => { req.url = `/api/files/${encodeURIComponent(req.params.id)}/content?download=1`; });

// ---------- Rename / delete ----------
app.post('/api/files/:id/rename', requireAuth, async (req, res) => {
  const fileId = text(req.params.id); const name = safeName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'INVALID_NAME' });
  try {
    if (!(await rebuildIndex()).some(f => f.id === fileId)) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    await tgRun('rename', async () => { await ensureTelegram(); await client.sendMessage(tgChat, { message: opCaption({ id: fileId, type: 'rename', name, at: Date.now() }) }); });
    invalidateIndex(); res.json({ ok: true, id: fileId, name });
  } catch (e) { res.status(503).json({ error: 'TELEGRAM_RENAME_FAILED', detail: errText(e) }); }
});
app.delete('/api/files/:id', requireAuth, async (req, res) => {
  const fileId = text(req.params.id); const password = text(req.body?.password || req.headers['x-delete-password']);
  if (!DELETE_PASSWORD || !safeEqual(password, DELETE_PASSWORD)) return res.status(403).json({ error: 'DELETE_PASSWORD_REQUIRED' });
  try {
    const file = await getFileWithMessages(fileId); if (!file) return res.status(404).json({ error: 'FILE_NOT_FOUND' });
    await tgRun('delete', async () => {
      await ensureTelegram();
      if (file.source !== 'legacy') {
        const ids = [file.messageId, ...(file.chunkMessages || []).map(x => x.messageId)].filter(Boolean);
        for (let i = 0; i < ids.length; i += 100) await client.deleteMessages(tgChat, ids.slice(i, i + 100), { revoke: true });
      } else {
        await client.deleteMessages(tgChat, [file.messageId], { revoke: true });
      }
      await client.sendMessage(tgChat, { message: opCaption({ id: fileId, type: 'delete', at: Date.now() }) });
    });
    invalidateIndex(); res.json({ ok: true, id: fileId });
  } catch (e) { res.status(503).json({ error: 'TELEGRAM_DELETE_FAILED', detail: errText(e) }); }
});

// ---------- Serve only this cloud UI ----------
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

const server = app.listen(PORT, () => console.log(`[Cloud-Zen] listening on :${PORT}`));
server.on('error', e => { console.error('[Cloud-Zen] HTTP ERROR', e); process.exitCode = 1; });
ensureTelegram().catch(e => console.error('[Cloud-Zen] Telegram startup:', errText(e)));

async function shutdown(signal) {
  console.log(`[Cloud-Zen] ${signal}: shutdown`);
  try { await tgRun('disconnect', () => client.disconnect()); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
