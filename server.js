"use strict";

/*
  my-personal-cloud / Cloud-Zen
  Vercel-ready storage upgrade.

  The original UI/API contract is preserved: login, storage status, file list,
  upload, cancel upload, stream/preview, download, rename, share, delete and
  download-all keep their original routes. Only the physical storage layer is
  changed from Telegram MTProto to Vercel Blob Private Storage.

  Completed files are NEVER auto-deleted by this application. A completed
  object is removed only by the explicit DELETE route.
*/

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const archiver = require("archiver");
const { put, get, list, del, head, copy, issueSignedToken, presignUrl } = require("@vercel/blob");
const { handleUpload } = require("@vercel/blob/client");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");

/* =========================
   ENVIRONMENT / SECRETS
========================= */
const APP_PASSWORD = String(process.env.APP_PASSWORD ?? "").trim();
const DELETE_PASSWORD = String(process.env.DELETE_PASSWORD ?? "").trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET ?? "").trim();
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 1024 * 1024 * 1024 * 1024);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_LOCK_MS = 24 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 3;
const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
const FILE_PREFIX = "my-personal-cloud/files/";
const LEGACY_FILE_PREFIX = "my-cloud-io/files/";

const authFailures = new Map();
const deviceLocks = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  }
}));

function jsonError(res, status, message) {
  return res.status(status).json({ error: String(message || "Request failed") });
}

function b64url(value) {
  return Buffer.from(String(value)).toString("base64url");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function signPayload(payload) {
  if (!SESSION_SECRET) throw new Error("SESSION_SECRET is not configured.");
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyPayload(token) {
  if (!SESSION_SECRET || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || Number(payload.exp) <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function getSession(req) {
  const token = getCookie(req, "cloud_zen_session") || getCookie(req, "my_cloud_io_session");
  const payload = verifyPayload(token);
  return payload?.type === "session" ? payload : null;
}

function makeSession() {
  return signPayload({ type: "session", iat: Date.now(), exp: Date.now() + SESSION_TTL_MS });
}

function deviceKey(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  const ua = String(req.headers["user-agent"] || "unknown");
  const device = String(req.headers["x-cloud-device"] || "");
  return crypto.createHash("sha256").update(`${ip}|${ua}|${device}`).digest("hex");
}

function isLocked(req, area) {
  const key = `${area}:${deviceKey(req)}`;
  const until = deviceLocks.get(key) || 0;
  if (until > Date.now()) return true;
  deviceLocks.delete(key);
  return false;
}

function registerFailure(req, area) {
  const key = `${area}:${deviceKey(req)}`;
  const count = (authFailures.get(key) || 0) + 1;
  if (count >= MAX_LOGIN_FAILURES) {
    authFailures.delete(key);
    deviceLocks.set(key, Date.now() + DEVICE_LOCK_MS);
    return true;
  }
  authFailures.set(key, count);
  return false;
}

function clearFailures(req, area) {
  authFailures.delete(`${area}:${deviceKey(req)}`);
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return jsonError(res, 401, "Authentication required");
  req.cloudSession = session;
  next();
}

function requireDeletePassword(req, res, next) {
  if (isLocked(req, "delete")) return jsonError(res, 423
