const express = require('express');
const dotenv = require('dotenv');
const crypto = require('crypto');
const path = require('path');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

function timingSafeEqualStrings(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function verifyConfiguredPassword(input) {
  // Preferred: salted scrypt hash stored in .env, never the plaintext password.
  const stored = process.env.CLOUD_PASSWORD_SCRYPT;
  if (stored) {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const [, saltB64, keyLenText, hashB64] = parts;
    const keyLen = Number(keyLenText);
    if (!Number.isInteger(keyLen) || keyLen < 16 || keyLen > 128) return false;
    try {
      const salt = Buffer.from(saltB64, 'base64url');
      const expected = Buffer.from(hashB64, 'base64url');
      const derived = crypto.scryptSync(String(input || ''), salt, keyLen, {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 32 * 1024 * 1024
      });
      return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
    } catch (_) {
      return false;
    }
  }

  // Development fallback only. Do not use this for a public deployment.
  return timingSafeEqualStrings(input, process.env.CLOUD_PASSWORD || '');
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, data] of sessions) {
    if (data.expiresAt <= now) sessions.delete(token);
  }
}
setInterval(cleanupSessions, 10 * 60 * 1000).unref();

function setSessionCookie(res, token) {
  const secure = process.env.COOKIE_SECURE === 'true';
  const parts = [
    `cloud_session=${token}`,
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'cloud_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
}

function getSession(req) {
  const header = req.headers.cookie || '';
  const match = header.match(/(?:^|;\s*)cloud_session=([^;]+)/);
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function requireAuth(req, res, next) {
  if (!getSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'My Personal Cloud',
    password_configured: Boolean(process.env.CLOUD_PASSWORD_SCRYPT || process.env.CLOUD_PASSWORD),
    telegram_configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    uptime_seconds: Math.round(process.uptime())
  });
});

app.get('/api/auth/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ ok: false, authenticated: false });
  res.json({ ok: true, authenticated: true });
});

app.post('/api/auth/login', (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!verifyConfiguredPassword(password)) {
    return res.status(401).json({ ok: false, error: 'Invalid password' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  setSessionCookie(res, token);
  res.json({ ok: true, authenticated: true });
});

app.post('/api/auth/logout', (req, res) => {
  const header = req.headers.cookie || '';
  const match = header.match(/(?:^|;\s*)cloud_session=([^;]+)/);
  if (match) sessions.delete(decodeURIComponent(match[1]));
  clearSessionCookie(res);
  res.json({ ok: true });
});

async function telegramApi(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram bot token is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `Telegram API error (${response.status})`);
  return data;
}

app.get('/api/telegram/status', requireAuth, async (req, res) => {
  try {
    const me = await telegramApi('getMe', {});
    res.json({ ok: true, bot: { id: me.result.id, username: me.result.username, first_name: me.result.first_name } });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.post('/api/telegram/test-message', requireAuth, async (req, res) => {
  try {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) return res.status(500).json({ ok: false, error: 'TELEGRAM_CHAT_ID is not configured' });
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: 'My Personal Cloud: Telegram connection test successful.'
    });
    res.json({ ok: true, sent: true });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

// Compatibility endpoints for the existing frontend. Real file/DB storage is intentionally next phase.
app.get('/api/storage', requireAuth, (req, res) => {
  res.json({ ok: true, used: 0, total: 0, free: 0, files: 0 });
});

app.get('/api/files', requireAuth, (req, res) => {
  res.json({ ok: true, files: [] });
});

app.delete('/api/files/:name', requireAuth, (req, res) => {
  res.status(404).json({ ok: false, error: 'File not found' });
});

app.get('/api/stream/:name', requireAuth, (req, res) => {
  res.status(404).json({ ok: false, error: 'File not found' });
});

app.get('/api/download/:name', requireAuth, (req, res) => {
  res.status(404).json({ ok: false, error: 'File not found' });
});

app.post('/api/upload-chunk', requireAuth, (req, res) => {
  res.status(501).json({ ok: false, error: 'Upload storage is not enabled yet.' });
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'API route not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log('========================================');
  console.log(' My Personal Cloud server is running');
  console.log(` http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(` Health: http://localhost:${PORT}/api/health`);
  console.log(` Password auth: ${Boolean(process.env.CLOUD_PASSWORD_SCRYPT || process.env.CLOUD_PASSWORD) ? 'configured' : 'NOT configured'}`);
  console.log(` Telegram: ${process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? 'configured' : 'NOT configured'}`);
  console.log('========================================');
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
                      
