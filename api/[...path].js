// Cloud-Zen Vercel same-origin API proxy.
// Telegram MTProto MUST run in exactly one persistent backend process.

export const config = {
  api: { bodyParser: false },
};

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function backendBase() {
  const raw = String(process.env.TELEGRAM_BACKEND_URL || '').trim();
  if (!raw) throw new Error('TELEGRAM_BACKEND_URL is not configured');
  return raw.replace(/\\/$/, '');
}

export default async function handler(req, res) {
  try {
    const base = backendBase();
    const parts = Array.isArray(req.query?.path) ? req.query.path : [];
    const target = `${base}/api/${parts.map(encodeURIComponent).join('/')}`;
    const qs = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers || {})) {
      if (value == null || HOP_BY_HOP.has(key.toLowerCase())) continue;
      if (key.toLowerCase() === 'host') continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
    }

    const body = ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : await readBody(req);

    const upstream = await fetch(target + qs, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
    });

    res.statusCode = upstream.status;

    for (const [key, value] of upstream.headers.entries()) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      if (key.toLowerCase() === 'set-cookie') continue;
      res.setHeader(key, value);
    }

    const getSetCookie = upstream.headers.getSetCookie;
    if (typeof getSetCookie === 'function') {
      const cookies = getSetCookie.call(upstream.headers);
      if (cookies.length) res.setHeader('set-cookie', cookies);
    } else {
      const cookie = upstream.headers.get('set-cookie');
      if (cookie) res.setHeader('set-cookie', cookie);
    }

    if (!upstream.body) return res.end();

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise(resolve => res.once('drain', resolve));
        }
      }
    } finally {
      reader.releaseLock();
    }
    res.end();
  } catch (error) {
    const message = error?.message || String(error);
    const status = message.includes('TELEGRAM_BACKEND_URL') ? 503 : 502;
    res.status(status).json({
      error: status === 503 ? 'BACKEND_NOT_CONFIGURED' : 'BACKEND_UNAVAILABLE',
      detail: message,
    });
  }
}
