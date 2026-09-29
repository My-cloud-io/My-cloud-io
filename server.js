"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const { CustomFile } = require("teleproto/client/uploads");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const COOKIE_NAME = "mpc_session";
const MANIFEST_PREFIX = "MPC_MANIFEST|1|";
const CHUNK_PREFIX = "MPC_CHUNK|1|";
const MAX_REQUEST_CHUNK = 4 * 1024 * 1024;

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(cookieParser());
app.use(express.json({ limit: "256kb" }));
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

function fail(message, status = 400, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  throw err;
}
function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}
function secret(name) {
  return typeof process.env[name] === "string" ? process.env[name] : "";
}
function getAppPassword() { return secret("APP_PASSWORD"); }
function getDeletePassword() { return secret("DELETE_PASSWORD"); }

const API_ID = Number(env("TELEGRAM_API_ID", "0"));
const API_HASH = env("TELEGRAM_API_HASH");
const TELEGRAM_SESSION = env("TELEGRAM_SESSION");
const STORAGE_CHAT = env("TELEGRAM_STORAGE_CHAT", "me");
const TELEGRAM_WORKERS = Math.max(1, Math.min(4, Number(env("TELEGRAM_WORKERS", "1")) || 1));
const CHUNK_SIZE = Math.max(
  256 * 1024,
  Math.min(MAX_REQUEST_CHUNK, Number(env("CHUNK_SIZE", String(MAX_REQUEST_CHUNK))) || MAX_REQUEST_CHUNK)
);
const MAX_CHUNKS = Math.max(1, Math.min(4096, Number(env("MAX_CHUNKS", "1024")) || 1024));
const MAX_FILE_BYTES = CHUNK_SIZE * MAX_CHUNKS;
const STORAGE_QUOTA_BYTES = Math.max(1, Number(env("STORAGE_QUOTA_GB", "10")) || 10) * 1024 * 1024 * 1024;

function sessionKey() {
  const supplied = secret("SESSION_SECRET");
  const fallback = getAppPassword() ? `cloud-session:${getAppPassword()}` : "";
  const source = supplied || fallback;
  if (!source) fail("APP_PASSWORD is not configured for this backend.", 503, "APP_PASSWORD_MISSING");
  return crypto.createHash("sha256").update(source, "utf8").digest();
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", sessionKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}
function verifySession(token) {
  if (!token) return false;
  try {
    const [body, mac] = String(token).split(".");
    if (!body || !mac) return false;
    const expected = crypto.createHmac("sha256", sessionKey()).update(body).digest("base64url");
    if (!safeEqual(expected, mac)) return false;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload?.ok === true && Number(payload.exp) > Date.now();
  } catch {
    return false;
  }
}
function setSessionCookie(res) {
  res.cookie(COOKIE_NAME, signSession({
    ok: true,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  }), {
    httpOnly: true,
    secure: env("NODE_ENV") === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/"
  });
}
function requireConfig() {
  if (!getAppPassword()) fail("APP_PASSWORD is not configured.", 503, "APP_PASSWORD_MISSING");
  if (!API_ID || !API_HASH || !TELEGRAM_SESSION) {
    fail("Telegram environment variables are not fully configured.", 503, "TELEGRAM_CONFIG_MISSING");
  }
  if (!STORAGE_CHAT) fail("TELEGRAM_STORAGE_CHAT is not configured.", 503, "STORAGE_CHAT_MISSING");
}
function requireAuth(req, res, next) {
  try {
    if (!verifySession(req.cookies[COOKIE_NAME])) {
      return res.status(401).json({ ok: false, error: "Authentication required" });
    }
    next();
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
}

function sanitizeName(name) {
  const value = String(name || "").replace(/\\/g, "/").split("/").pop().trim();
  if (!value || value === "." || value === "..") fail("Invalid file name");
  if (value.length > 240) fail("File name is too long");
  return value;
}
function b64(value) { return Buffer.from(value, "utf8").toString("base64url"); }
function fromB64(value) { return Buffer.from(value, "base64url").toString("utf8"); }
function manifestText(meta) { return MANIFEST_PREFIX + b64(JSON.stringify(meta)); }
function parseManifest(text) {
  if (typeof text !== "string" || !text.startsWith(MANIFEST_PREFIX)) return null;
  try {
    const meta = JSON.parse(fromB64(text.slice(MANIFEST_PREFIX.length)));
    if (!meta?.id || !meta?.name || !Array.isArray(meta.chunks)) return null;
    return meta;
  } catch { return null; }
}
function chunkCaption(id, index, total) { return `${CHUNK_PREFIX}${id}|${index}|${total}`; }
function parseChunkCaption(text) {
  if (typeof text !== "string" || !text.startsWith(CHUNK_PREFIX)) return null;
  const p = text.slice(CHUNK_PREFIX.length).split("|");
  if (p.length !== 3) return null;
  const index = Number(p[1]), total = Number(p[2]);
  if (!p[0] || !Number.isInteger(index) || !Number.isInteger(total)) return null;
  return { id: p[0], index, total };
}
function normalizePeerId(value) {
  const text = String(value).trim();
  if (text === "me" || text.startsWith("@") || text.includes("/")) return text;
  if (/^-?\d+$/.test(text)) return BigInt(text);
  return text;
}
function messageText(message) { return String(message?.message || message?.text || ""); }
function messageMedia(message) { return message?.media || null; }
function messageSize(message) { return Number(message?.document?.size || 0); }
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 2 : 0)} ${units[i]}`;
}
function guessMime(name) {
  const ext = String(name).toLowerCase().split(".").pop();
  const map = {
    jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",webp:"image/webp",svg:"image/svg+xml",
    mp4:"video/mp4",webm:"video/webm",mov:"video/quicktime",mkv:"video/x-matroska",avi:"video/x-msvideo",
    mp3:"audio/mpeg",m4a:"audio/mp4",wav:"audio/wav",ogg:"audio/ogg",flac:"audio/flac",
    pdf:"application/pdf",txt:"text/plain",csv:"text/csv",json:"application/json",
    doc:"application/msword",docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls:"application/vnd.ms-excel",xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt:"application/vnd.ms-powerpoint",pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip:"application/zip",rar:"application/vnd.rar","7z":"application/x-7z-compressed"
  };
  return map[ext] || "application/octet-stream";
}

/*
 * IMPORTANT ARCHITECTURE:
 * This process owns exactly ONE MTProto Telegram client for ONE session.
 * The Vercel website is only a proxy; it must never contain TELEGRAM_SESSION.
 *
 * A single Telegram auth key must not be connected by multiple backend
 * processes/hosts at the same time. The old deployment hit AUTH_KEY_DUPLICATED
 * because more than one instance was using the same StringSession.
 */
let telegramClientPromise = null;
let storageEntityPromise = null;
let sessionDead = false;
let manifestCache = { expires: 0, files: null };
let telegramQueue = Promise.resolve();

function invalidateCache() { manifestCache = { expires: 0, files: null }; }

function isAuthKeyDuplicated(err) {
  const text = String(err?.errorMessage || err?.message || "");
  return Number(err?.code) === 406 || text.includes("AUTH_KEY_DUPLICATED");
}
function normalizeTelegramError(err) {
  if (!isAuthKeyDuplicated(err)) return err;
  sessionDead = true;
  telegramClientPromise = null;
  storageEntityPromise = null;
  invalidateCache();
  return Object.assign(
    new Error("Telegram rejected this session because the same TELEGRAM_SESSION was connected by another backend instance. This session must be replaced with a newly generated StringSession, and only the persistent backend may use it."),
    { status: 503, code: "TELEGRAM_SESSION_INVALIDATED" }
  );
}
function withTelegramLock(task) {
  const run = telegramQueue.then(task, task);
  telegramQueue = run.catch(() => {});
  return run;
}
async function getTelegramClient() {
  return withTelegramLock(async () => {
    requireConfig();
    if (sessionDead) fail("TELEGRAM_SESSION is invalidated. Generate a new Telegram StringSession and deploy it only to the persistent backend.", 503, "TELEGRAM_SESSION_INVALIDATED");
    if (telegramClientPromise) return telegramClientPromise;
    const client = new TelegramClient(new StringSession(TELEGRAM_SESSION), API_ID, API_HASH, {
      connectionRetries: 5,
      autoReconnect: true,
      floodSleepThreshold: 60
    });
    telegramClientPromise = (async () => {
      try {
        await client.connect();
        if (!(await client.checkAuthorization())) {
          fail("TELEGRAM_SESSION is not authorized. Generate a new StringSession.", 503, "TELEGRAM_SESSION_UNAUTHORIZED");
        }
        return client;
      } catch (err) {
        telegramClientPromise = null;
        throw normalizeTelegramError(err);
      }
    })();
    return telegramClientPromise;
  });
}
async function getStorageEntity() {
  if (storageEntityPromise) return storageEntityPromise;
  storageEntityPromise = getTelegramClient().then(client =>
    client.getEntity(normalizePeerId(STORAGE_CHAT))
  ).catch(err => {
    storageEntityPromise = null;
    throw normalizeTelegramError(err);
  });
  return storageEntityPromise;
}

async function tg(task) {
  return withTelegramLock(async () => {
    try {
      const client = await getTelegramClient();
      return await task(client, await getStorageEntity());
    } catch (err) {
      throw normalizeTelegramError(err);
    }
  });
}
async function getManifestList() {
  if (manifestCache.files && manifestCache.expires > Date.now()) return manifestCache.files;
  const files = await tg(async (client, chat) => {
    const results = [];
    for await (const message of client.iterMessages(chat, {
      search: "MPC_MANIFEST",
      limit: undefined,
      waitTime: 100
    })) {
      const meta = parseManifest(messageText(message));
      if (meta) results.push({ ...meta, manifestMessageId: Number(message.id) });
    }
    results.sort((a, b) =>
      Number(new Date(b.modified || b.created || 0)) -
      Number(new Date(a.modified || a.created || 0))
    );
    return results;
  });
  manifestCache = { expires: Date.now() + 5000, files };
  return files;
}
async function findManifestById(id) {
  return (await getManifestList()).find(m => String(m.id) === String(id)) || null;
}
async function findManifestByName(name) {
  const safe = sanitizeName(name);
  return (await getManifestList()).find(m => m.name === safe) || null;
}
function publicFile(meta) {
  return {
    id: meta.id,
    name: meta.name,
    type: meta.type || "application/octet-stream",
    size: Number(meta.size || 0),
    modified: meta.modified || meta.created || new Date().toISOString(),
    chunks: Number(meta.total || meta.chunks?.length || 0),
    url: `/api/stream/${encodeURIComponent(meta.id)}`
  };
}
async function sendChunk(buffer, id, index, total) {
  return tg(async (client, chat) => {
    const file = new CustomFile(`${id}.${index}.part`, buffer.length, "", buffer);
    const message = await client.sendFile(chat, {
      file,
      caption: chunkCaption(id, index, total),
      forceDocument: true,
      workers: TELEGRAM_WORKERS
    });
    return Number(message.id);
  });
}
async function sendManifest(meta) {
  return tg(async (client, chat) => {
    const message = await client.sendMessage(chat, { message: manifestText(meta) });
    return Number(message.id);
  });
}
async function collectChunksForUpload(id, total) {
  return tg(async (client, chat) => {
    const found = new Map();
    for await (const message of client.iterMessages(chat, { search: id, limit: undefined, waitTime: 100 })) {
      const c = parseChunkCaption(messageText(message));
      if (c && c.id === id && c.total === total) found.set(c.index, Number(message.id));
    }
    return [...found.entries()].sort((a,b) => a[0]-b[0]).map(([index,messageId]) => ({index,messageId}));
  });
}
async function updateManifest(messageId, meta) {
  await tg(async (client, chat) => {
    await client.editMessage(chat, { message: Number(messageId), text: manifestText(meta) });
  });
  invalidateCache();
}
async function finalizeUploadedFile({id,total,size,name,type}) {
  const existing = await findManifestById(id);
  if (existing) return existing;
  const chunks = await collectChunksForUpload(id,total);
  if (chunks.length !== total || chunks.some((x,i) => x.index !== i)) return null;
  const meta = {
    id,
    name: sanitizeName(name),
    type: String(type || guessMime(name)).slice(0,200),
    size: Number(size),
    total,
    chunks: chunks.map(x => x.messageId),
    created: new Date().toISOString(),
    modified: new Date().toISOString()
  };
  meta.manifestMessageId = await sendManifest(meta);
  invalidateCache();
  return meta;
}
async function getChunkMessages(meta) {
  return tg(async (client, chat) => {
    if (!Array.isArray(meta.chunks) || !meta.chunks.length) fail("File has no stored chunks",404);
    const messages = await client.getMessages(chat, { ids: meta.chunks.map(Number) });
    const byId = new Map(messages.filter(Boolean).map(m => [Number(m.id), m]));
    return meta.chunks.map((id,index) => {
      const message = byId.get(Number(id));
      if (!message || !messageMedia(message)) fail(`Missing Telegram chunk ${index+1}`,500);
      return message;
    });
  });
}
async function deleteMessages(ids) {
  if (!ids?.length) return;
  await tg(async (client, chat) => {
    for (let i=0;i<ids.length;i+=100) {
      await client.deleteMessages(chat, ids.slice(i,i+100).map(Number), { revoke: true });
    }
  });
}

app.get("/api/auth/me", (req,res) => {
  let authenticated = false;
  try { authenticated = verifySession(req.cookies[COOKIE_NAME]); } catch {}
  res.json({ authenticated });
});
app.post("/api/auth/login", (req,res) => {
  try {
    const expected = getAppPassword();
    if (!expected) return res.status(503).json({
      ok:false, code:"APP_PASSWORD_MISSING",
      error:"APP_PASSWORD is not configured on the persistent backend."
    });
    const supplied = typeof req.body?.password === "string" ? req.body.password : "";
    if (!safeEqual(supplied, expected)) return res.status(401).json({
      ok:false, code:"INVALID_PASSWORD", error:"Incorrect password"
    });
    setSessionCookie(res);
    res.json({ ok:true, authenticated:true });
  } catch(err) {
    res.status(err.status || 500).json({
      ok:false, code:err.code || "AUTH_SERVER_ERROR", error:err.message
    });
  }
});
app.get("/api/auth/status", (req,res) => {
  res.json({
    ok:true,
    appPasswordConfigured:Boolean(getAppPassword()),
    sessionSecretConfigured:Boolean(secret("SESSION_SECRET")),
    telegramApiConfigured:Boolean(secret("TELEGRAM_API_ID") && secret("TELEGRAM_API_HASH")),
    telegramSessionConfigured:Boolean(secret("TELEGRAM_SESSION")),
    storageChatConfigured:Boolean(secret("TELEGRAM_STORAGE_CHAT")),
    ownerEmailConfigured:Boolean(secret("OWNER_EMAIL")),
    persistentBackend:true,
    deployment:process.env.RENDER ? "render" : (process.env.VERCEL ? "vercel" : "server")
  });
});
app.post("/api/auth/logout", (req,res) => {
  res.clearCookie(COOKIE_NAME,{httpOnly:true,secure:env("NODE_ENV")==="production",sameSite:"lax",path:"/"});
  res.json({ok:true});
});

app.get("/api/storage", requireAuth, async (req,res) => {
  try {
    const files = await getManifestList();
    const usedBytes = files.reduce((s,f)=>s+Number(f.size||0),0);
    const remainingBytes = Math.max(0,STORAGE_QUOTA_BYTES-usedBytes);
    res.json({
      usedBytes, limitBytes:STORAGE_QUOTA_BYTES, remainingBytes,
      usedText:formatBytes(usedBytes), limitText:formatBytes(STORAGE_QUOTA_BYTES),
      remainingText:formatBytes(remainingBytes),
      usedPercent:Number(Math.min(100,usedBytes/STORAGE_QUOTA_BYTES*100).toFixed(2)),
      telegram:{
        configured:true, connected:!sessionDead, usedBytes,
        capacityBytes:STORAGE_QUOTA_BYTES, remainingBytes,
        usedText:formatBytes(usedBytes), remainingText:formatBytes(remainingBytes)
      },
      b2:{configured:false,connected:false},mega:{configured:false,connected:false},
      idriveE2:{configured:false,connected:false},cloudinary:{configured:false,connected:false},
      filebase:{configured:false,connected:false},koofr:{configured:false,connected:false}
    });
  } catch(err) {
    res.status(err.status||500).json({ok:false,code:err.code,error:err.message});
  }
});
app.get("/api/files", requireAuth, async (req,res) => {
  try { res.json((await getManifestList()).map(publicFile)); }
  catch(err) { res.status(err.status||500).json({ok:false,code:err.code,error:err.message}); }
});

app.post("/api/upload-chunk", requireAuth,
  express.raw({type:"application/octet-stream",limit:"4.25mb"}),
  async (req,res) => {
    try {
      const id=String(req.query.id||"").replace(/[^a-zA-Z0-9_-]/g,"");
      const index=Number(req.query.index), total=Number(req.query.total), size=Number(req.query.size);
      const name=sanitizeName(req.query.name||"");
      const relativePath=sanitizeName(req.query.relativePath||name);
      const type=String(req.query.type||guessMime(relativePath)).slice(0,200);
      if(!id||id.length>100) fail("Invalid upload id");
      if(!Number.isInteger(index)||index<0) fail("Invalid chunk index");
      if(!Number.isInteger(total)||total<1||total>MAX_CHUNKS) fail("Invalid chunk count");
      if(index>=total) fail("Chunk index is out of range");
      if(!Number.isSafeInteger(size)||size<=0||size>MAX_FILE_BYTES) fail(`File is too large (${formatBytes(MAX_FILE_BYTES)} maximum).`);
      if(!Buffer.isBuffer(req.body)||!req.body.length) fail("Empty upload chunk");
      if(req.body.length>CHUNK_SIZE) fail("Upload chunk is larger than CHUNK_SIZE");
      const existing=await findManifestById(id);
      if(existing) return res.json({ok:true,duplicate:true,complete:true,id,file:publicFile(existing)});
      const known=(await collectChunksForUpload(id,total)).find(x=>x.index===index);
      const messageId=known?.messageId || await sendChunk(req.body,id,index,total);
      let file=null;
      if(index===total-1) file=await finalizeUploadedFile({id,total,size,name:relativePath,type});
      invalidateCache();
      res.json({ok:true,id,index,total,messageId,complete:Boolean(file),file:file?publicFile(file):undefined});
    } catch(err) {
      res.status(err.status||500).json({ok:false,code:err.code,error:err.message});
    }
  }
);
app.post("/api/upload-complete",requireAuth,async(req,res)=>{
  try{
    const id=String(req.body?.id||"").replace(/[^a-zA-Z0-9_-]/g,"");
    const total=Number(req.body?.total),size=Number(req.body?.size);
    const name=sanitizeName(req.body?.name||"");
    const type=String(req.body?.type||guessMime(name)).slice(0,200);
    if(!id) fail("Invalid upload id");
    if(!Number.isInteger(total)||total<1||total>MAX_CHUNKS) fail("Invalid chunk count");
    if(!Number.isSafeInteger(size)||size<=0||size>MAX_FILE_BYTES) fail("Invalid file size");
    const meta=await finalizeUploadedFile({id,total,size,name,type});
    if(!meta) fail("Not all Telegram chunks are present yet",409);
    res.json({ok:true,complete:true,file:publicFile(meta)});
  }catch(err){res.status(err.status||500).json({ok:false,code:err.code,error:err.message});}
});

async function streamMeta(req,res,meta,download=false){
  const chunks=await getChunkMessages(meta);
  const totalSize=Number(meta.size||0);
  let start=0,end=Math.max(0,totalSize-1);
  const range=req.headers.range;
  if(range){
    const m=/^bytes=(\d*)-(\d*)$/i.exec(range);
    if(!m) return res.status(416).set("Content-Range",`bytes */${totalSize}`).end();
    if(m[1]) start=Number(m[1]);
    if(m[2]) end=Number(m[2]); else end=totalSize-1;
    if(!m[1]){const suffix=Number(m[2]);start=Math.max(0,totalSize-suffix);end=totalSize-1;}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=totalSize)
      return res.status(416).set("Content-Range",`bytes */${totalSize}`).end();
    end=Math.min(end,totalSize-1);
    res.status(206).set("Content-Range",`bytes ${start}-${end}/${totalSize}`);
  }
  const safeName=String(meta.name||"download").replace(/[\r\n"]/g,"_");
  res.set("Accept-Ranges","bytes");
  res.set("Content-Length",String(end-start+1));
  res.set("Content-Type",meta.type||"application/octet-stream");
  res.set("Content-Disposition",`${download?"attachment":"inline"}; filename="${safeName}"`);
  res.set("Cache-Control","private,no-store,max-age=0");

  let fileOffset=0;
  for(const message of chunks){
    const chunkSize=messageSize(message)||CHUNK_SIZE;
    const chunkStart=fileOffset,chunkEnd=Math.min(totalSize-1,fileOffset+chunkSize-1);
    fileOffset+=chunkSize;
    if(chunkEnd<start) continue;
    if(chunkStart>end) break;
    const data=await tg(async(client)=>client.downloadMedia(message,{workers:TELEGRAM_WORKERS}));
    if(!data) fail("Telegram returned no chunk data",500);
    const buffer=Buffer.isBuffer(data)?data:Buffer.from(data);
    const from=Math.max(start-chunkStart,0);
    const to=Math.min(end-chunkStart+1,buffer.length);
    if(to>from && !res.destroyed){
      if(!res.write(buffer.subarray(from,to))) await new Promise(resolve=>res.once("drain",resolve));
    }
    if(res.destroyed) return;
  }
  res.end();
}
async function handleStream(req,res,download){
  try{
    const id=decodeURIComponent(req.params.id||"");
    const meta=await findManifestById(id);
    if(!meta) fail("File not found",404);
    await streamMeta(req,res,meta,download);
  }catch(err){
    if(!res.headersSent) res.status(err.status||500).json({ok:false,code:err.code,error:err.message});
    else res.destroy(err);
  }
}
app.get("/api/stream/:id",requireAuth,(req,res)=>handleStream(req,res,false));
app.get("/api/download/:id",requireAuth,(req,res)=>handleStream(req,res,true));

app.delete("/api/files",requireAuth,async(req,res)=>{
  try{
    const supplied=req.headers["x-delete-password"]||req.body?.password||"";
    const expected=getDeletePassword();
    if(expected && !safeEqual(supplied,expected)) return res.status(403).json({ok:false,error:"Invalid delete password"});
    const name=sanitizeName(req.body?.name||"");
    const meta=await findManifestByName(name);
    if(!meta) fail("File not found",404);
    await deleteMessages([...(meta.chunks||[]),meta.manifestMessageId].filter(Boolean));
    invalidateCache();
    res.json({ok:true,deleted:name});
  }catch(err){res.status(err.status||500).json({ok:false,code:err.code,error:err.message});}
});
app.patch("/api/files/:id",requireAuth,async(req,res)=>{
  try{
    const id=decodeURIComponent(req.params.id||"");
    const meta=await findManifestById(id);
    if(!meta) fail("File not found",404);
    const newName=sanitizeName(req.body?.name||"");
    const duplicate=await findManifestByName(newName);
    if(duplicate&&duplicate.id!==meta.id) fail("A file with that name already exists",409);
    meta.name=newName;meta.modified=new Date().toISOString();
    await updateManifest(meta.manifestMessageId,meta);
    res.json({ok:true,file:publicFile(meta)});
  }catch(err){res.status(err.status||500).json({ok:false,code:err.code,error:err.message});}
});

app.get("/api/health",async(req,res)=>{
  try{
    requireConfig();
    const client=await getTelegramClient();
    const me=await client.getMe();
    res.json({
      ok:true,telegram:true,persistent:true,
      user:me?.username?`@${me.username}`:me?.id||null,
      storageChat:STORAGE_CHAT,chunkSize:CHUNK_SIZE,
      maxFileBytes:MAX_FILE_BYTES,maxFileText:formatBytes(MAX_FILE_BYTES),
      ownerEmailConfigured:Boolean(secret("OWNER_EMAIL"))
    });
  }catch(err){
    res.status(503).json({ok:false,telegram:false,persistent:true,code:err.code,error:err.message});
  }
});
app.get("/",(req,res)=>res.json({ok:true,service:"cloud-zen-telegram-backend",persistent:true}));

app.use((err,req,res,next)=>{
  console.error("UNHANDLED ERROR",err);
  if(res.headersSent)return next(err);
  res.status(err.status||500).json({ok:false,code:err.code,error:err.message||"Server error"});
});

if(require.main===module){
  app.listen(PORT,"0.0.0.0",()=>console.log(`Cloud-Zen Telegram backend listening on 0.0.0.0:${PORT}`));
}
module.exports=app;
