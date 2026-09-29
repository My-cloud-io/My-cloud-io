"use strict";

/*
 * Vercel-side thin proxy.
 * IMPORTANT: this file never connects to Telegram.
 * TELEGRAM_SESSION lives only in the persistent backend.
 */

const BACKEND = String(process.env.TELEGRAM_BACKEND_URL || "").replace(/\/$/, "");

function fail(res, status, code, error) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: false, code, error }));
}

async function readRequestBody(req) {
  if (["GET", "HEAD"].includes(req.method)) return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4.25 * 1024 * 1024) throw Object.assign(new Error("Request body is larger than the Vercel-safe 4 MiB upload size"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function copyRequestHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    const lower = key.toLowerCase();
    if (["host", "connection", "content-length"].includes(lower)) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return headers;
}

function copyResponseHeaders(source, res) {
  for (const [key, value] of source.headers.entries()) {
    if (key.toLowerCase() === "transfer-encoding") continue;
    res.setHeader(key, value);
  }
  // Node's Headers iterator can merge Set-Cookie. Preserve multiple cookies if available.
  if (typeof source.headers.getSetCookie === "function") {
    const cookies = source.headers.getSetCookie();
    if (cookies.length) res.setHeader("set-cookie", cookies);
  }
}

module.exports = async function handler(req, res) {
  if (!BACKEND) return fail(res, 503, "BACKEND_URL_MISSING", "TELEGRAM_BACKEND_URL is not configured on the Vercel deployment.");

  try {
    const body = await readRequestBody(req);
    const target = `${BACKEND}${req.url}`;
    const upstream = await fetch(target, {
      method: req.method,
      headers: copyRequestHeaders(req),
      body,
      redirect: "manual"
    });

    res.statusCode = upstream.status;
    copyResponseHeaders(upstream, res);

    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
      }
      res.end();
    } finally {
      reader.releaseLock();
    }
  } catch (err) {
    console.error("BACKEND PROXY ERROR", err);
    fail(res, err.status || 502, "BACKEND_UNAVAILABLE", err.message || "Telegram backend unavailable");
  }
};

module.exports.config = { api: { bodyParser: false } };
