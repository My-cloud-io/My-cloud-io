"use strict";

/*
============================================================
 MY-PERSONAL-CLOUD
 CLOUD VAULT PRO â€” MULTI STORAGE
 Render + Backblaze B2 + MEGA + IDrive E2 + Cloudinary + Filebase + Koofr

 STORAGE ARCHITECTURE

 PRIMARY STORAGE:
 Backblaze B2 (10 GB / Routing limit: 9.95 GiB)

 SECONDARY STORAGE:
 MEGA (20 GB / Routing limit: 19.95 GiB)

 TERTIARY STORAGE:
 IDrive E2 (10 GB / Routing limit: 9.95 GiB)

 QUATERNARY STORAGE:
 Cloudinary (25 GB / Routing limit: 24.95 GiB)

 QUINARY STORAGE:
 Filebase (5 GB / Routing limit: 4.95 GiB)

 SENARY STORAGE:
 Koofr (10 GB / Routing limit: 9.95 GiB)


 STORAGE ROUTING

 New File
 |
 v
 BACKBLAZE B2
 |
 | B2 usage + complete file size
 | <= 9.95 GiB
 |
 +---------------------> B2


 If B2 cannot accept complete file
 |
 v
 MEGA
 |
 | MEGA usage + complete file size
 | <= 19.95 GiB
 |
 +---------------------> MEGA


 If B2 and MEGA cannot accept complete file
 |
 v
 IDRIVE E2
 |
 | E2 usage + complete file size
 | <= 9.95 GiB
 |
 +---------------------> IDrive E2


 If B2, MEGA, and IDrive E2 cannot accept complete file
 |
 v
 CLOUDINARY
 |
 | Cloudinary usage + complete file size
 | <= 24.95 GiB
 |
 +---------------------> Cloudinary


 If B2, MEGA, IDrive E2, and Cloudinary cannot accept complete file
 |
 v
 FILEBASE
 |
 | Filebase usage + complete file size
 | <= 4.95 GiB
 |
 +---------------------> Filebase


 If B2, MEGA, IDrive E2, Cloudinary, and Filebase cannot accept complete file
 |
 v
 KOOFR
 |
 | Koofr usage + complete file size
 | <= 9.95 GiB
 |
 +---------------------> Koofr


 If ALL storages are full / cannot accept file
 |
 v
 ALERT / ERROR 507: Storage full limit exceeded!


 IMPORTANT:

 A single file is NEVER split between storages.

 Existing files remain where they are.

 New uploads are automatically routed.

 FILE ACCESS:

 /api/files
 |
 +-- B2
 +-- MEGA
 +-- IDrive E2
 +-- Cloudinary
 +-- Filebase
 +-- Koofr

 DOWNLOAD / STREAM / DELETE:

 Backend locates the file and operates
 directly against its storage.


 REQUIRED B2 ENVIRONMENT VARIABLES:

 B2_ENDPOINT
 B2_REGION
 B2_KEY_ID
 B2_APPLICATION_KEY
 B2_BUCKET_NAME


 REQUIRED AUTH:

 APP_PASSWORD
 SESSION_SECRET


 REQUIRED MEGA:

 MEGA_EMAIL
 MEGA_PASSWORD


 REQUIRED IDRIVE E2:

 IDRIVE_E2_ENDPOINT
 IDRIVE_E2_REGION
 IDRIVE_E2_KEY_ID
 IDRIVE_E2_APPLICATION_KEY
 IDRIVE_E2_BUCKET_NAME


 REQUIRED CLOUDINARY ENVIRONMENT VARIABLES:

 CLOUDINARY_CLOUD_NAME
 CLOUDINARY_API_KEY
 CLOUDINARY_API_SECRET


 REQUIRED FILEBASE ENVIRONMENT VARIABLES:

 FILEBASE_ENDPOINT (optional; defaults to https://s3.filebase.com)
 FILEBASE_REGION (optional; defaults to us-east-1)
 FILEBASE_KEY_ID or FILEBASE_ACCESS_KEY
 FILEBASE_APPLICATION_KEY or FILEBASE_SECRET_KEY
 FILEBASE_BUCKET_NAME or FILEBASE_BUCKET


 REQUIRED KOOFR ENVIRONMENT VARIABLES:

 KOOFR_EMAIL
 KOOFR_PASSWORD (or App Password)
 KOOFR_ENDPOINT (e.g., https://app.koofr.net/dav/swift)


 OPTIONAL:

 MEGA_SECOND_FACTOR_CODE

 PORT
 CHUNK_SIZE
 MAX_FILE_SIZE

 B2_ROUTING_LIMIT_BYTES
 MEGA_ROUTING_LIMIT_BYTES
 IDRIVE_E2_ROUTING_LIMIT_BYTES
 CLOUDINARY_ROUTING_LIMIT_BYTES
 CLOUDINARY_STORAGE_LIMIT_BYTES
 FILEBASE_ROUTING_LIMIT_BYTES
 FILEBASE_STORAGE_LIMIT_BYTES
 KOOFR_ROUTING_LIMIT_BYTES
 KOOFR_STORAGE_LIMIT_BYTES


 NEVER put passwords or credentials in this file.
============================================================
*/


/* =========================================================
MODULES
========================================================= */

const express = require("express");

const path = require("path");

const crypto = require("crypto");

const fs = require("fs");

const fsp = fs.promises;

const {
 once
} = require("events");

const {
 Readable
} = require("stream");

const {
 S3Client,

 CreateMultipartUploadCommand,
 UploadPartCommand,
 CompleteMultipartUploadCommand,
 AbortMultipartUploadCommand,
 ListPartsCommand,

 ListObjectsV2Command,
 ListObjectVersionsCommand,

 GetObjectCommand,
 HeadObjectCommand,

 DeleteObjectCommand,
 PutObjectCommand
} = require("@aws-sdk/client-s3");

const {
 Storage
} = require("megajs");

const cloudinary = require("cloudinary").v2;
const archiver = require("archiver");


/* =========================================================
APP
========================================================= */

const app =
 express();

app.disable(
 "x-powered-by"
);


/* =========================================================
SERVER
========================================================= */

const PORT =
 Number(
 process.env.PORT ||
 10000
 );

const PUBLIC_DIR =
 path.join(
 __dirname,
 "public"
 );


/* =========================================================
B2 ENVIRONMENT
========================================================= */

const B2_ENDPOINT =
 String(
 process.env.B2_ENDPOINT ||
 ""
 ).trim();

const B2_REGION =
 String(
 process.env.B2_REGION ||
 ""
 ).trim();

const B2_KEY_ID =
 String(
 process.env.B2_KEY_ID ||
 ""
 ).trim();

const B2_APPLICATION_KEY =
 String(
 process.env.B2_APPLICATION_KEY ||
 ""
 ).trim();

const BUCKET_NAME =
 String(
 process.env.B2_BUCKET_NAME ||
 ""
 ).trim();


/* =========================================================
IDRIVE E2 ENVIRONMENT
========================================================= */

const IDRIVE_E2_ENDPOINT =
 String(
 process.env.IDRIVE_E2_ENDPOINT ||
 ""
 ).trim();

const IDRIVE_E2_REGION =
 String(
 process.env.IDRIVE_E2_REGION ||
 ""
 ).trim();

const IDRIVE_E2_KEY_ID =
 String(
 process.env.IDRIVE_E2_KEY_ID ||
 ""
 ).trim();

const IDRIVE_E2_APPLICATION_KEY =
 String(
 process.env.IDRIVE_E2_APPLICATION_KEY ||
 ""
 ).trim();

const IDRIVE_E2_BUCKET_NAME =
 String(
 process.env.IDRIVE_E2_BUCKET_NAME ||
 ""
 ).trim();


/* =========================================================
FILEBASE ENVIRONMENT
========================================================= */

const FILEBASE_ENDPOINT =
 String(
 process.env.FILEBASE_ENDPOINT ||
 "https://s3.filebase.io"
 ).trim();

const FILEBASE_REGION =
 String(
 process.env.FILEBASE_REGION ||
 "auto"
 ).trim();

const FILEBASE_KEY_ID =
 String(
 process.env.FILEBASE_KEY_ID ||
 process.env.FILEBASE_ACCESS_KEY ||
 process.env.FILEBASE_S3_ACCESS_KEY ||
 process.env.FILEBASE_ACCESS_KEY_ID ||
 process.env.FILEBASE_KEY ||
 process.env.FILEBASE_API_KEY ||
 ""
 ).trim();

const FILEBASE_APPLICATION_KEY =
 String(
 process.env.FILEBASE_APPLICATION_KEY ||
 process.env.FILEBASE_SECRET_KEY ||
 process.env.FILEBASE_S3_SECRET_KEY ||
 process.env.FILEBASE_SECRET_ACCESS_KEY ||
 process.env.FILEBASE_SECRET ||
 process.env.FILEBASE_API_SECRET ||
 ""
 ).trim();

const FILEBASE_BUCKET_NAME =
 String(
 process.env.FILEBASE_BUCKET_NAME ||
 process.env.FILEBASE_BUCKET ||
 ""
 ).trim();


/* =========================================================
KOOFR ENVIRONMENT (WEBDAV / S3 COMPATIBLE)
========================================================= */

const KOOFR_ENDPOINT =
 String(
 process.env.KOOFR_ENDPOINT ||
 "https://app.koofr.net/dav/Koofr"
 ).trim();

const KOOFR_REGION =
 String(
 process.env.KOOFR_REGION ||
 "us-east-1"
 ).trim();

const KOOFR_KEY_ID =
 String(
 process.env.KOOFR_KEY_ID ||
 process.env.KOOFR_USERNAME ||
 ""
 ).trim();

const KOOFR_APPLICATION_KEY =
 String(
 process.env.KOOFR_APPLICATION_KEY ||
 process.env.KOOFR_PASSWORD ||
 ""
 ).trim();

const KOOFR_BUCKET_NAME =
 String(
 process.env.KOOFR_BUCKET_NAME ||
 "Koofr"
 ).trim();


/* =========================================================
AUTH ENVIRONMENT
========================================================= */

const APP_PASSWORD =
 String(
 process.env.APP_PASSWORD ||
 ""
 );

const SESSION_SECRET =
 String(
 process.env.SESSION_SECRET ||
 ""
 );


/* =========================================================
MEGA ENVIRONMENT
========================================================= */

const MEGA_EMAIL =
 String(
 process.env.MEGA_EMAIL ||
 ""
 ).trim();

const MEGA_PASSWORD =
 String(
 process.env.MEGA_PASSWORD ||
 ""
 );

const MEGA_SECOND_FACTOR_CODE =
 String(
 process.env.MEGA_SECOND_FACTOR_CODE ||
 ""
 ).trim();


/* =========================================================
CLOUDINARY ENVIRONMENT
========================================================= */

const CLOUDINARY_CLOUD_NAME =
 String(
 process.env.CLOUDINARY_CLOUD_NAME ||
 process.env.CLOUDINARY_NAME ||
 ""
 ).trim();

const CLOUDINARY_API_KEY =
 String(
 process.env.CLOUDINARY_API_KEY ||
 ""
 ).trim();

const CLOUDINARY_API_SECRET =
 String(
 process.env.CLOUDINARY_API_SECRET ||
 ""
 ).trim();


if (
 CLOUDINARY_CLOUD_NAME &&
 CLOUDINARY_API_KEY &&
 CLOUDINARY_API_SECRET
) {
 cloudinary.config({
 cloud_name: CLOUDINARY_CLOUD_NAME,
 api_key: CLOUDINARY_API_KEY,
 api_secret: CLOUDINARY_API_SECRET
 });
}


/* =========================================================
STORAGE LIMITS
========================================================= */

const GIB =
 1024 *
 1024 *
 1024;


/*
Backblaze B2 routing threshold.

Default:
9.95 GiB (10 GB Capacity)
*/

const B2_ROUTING_LIMIT_BYTES =
 Number(
 process.env.B2_ROUTING_LIMIT_BYTES ||
 (
 9.95 *
 GIB
 )
 );


/*
MEGA routing threshold.

Default:
19.95 GiB (20 GB Capacity)
*/

const MEGA_ROUTING_LIMIT_BYTES =
 Number(
 process.env.MEGA_ROUTING_LIMIT_BYTES ||
 (
 19.95 *
 GIB
 )
 );


/*
IDrive E2 routing threshold.

Default:
9.95 GiB (10 GB Capacity)
*/

const IDRIVE_E2_ROUTING_LIMIT_BYTES =
 Number(
 process.env.IDRIVE_E2_ROUTING_LIMIT_BYTES ||
 (
 9.95 *
 GIB
 )
 );


/*
IDrive E2 warning threshold.

Default:
9.95 GiB
*/

const IDRIVE_E2_WARNING_LIMIT_BYTES =
 Number(
 process.env.IDRIVE_E2_WARNING_LIMIT_BYTES ||
 (
 9.95 *
 GIB
 )
 );


/*
Logical IDrive E2 capacity.

Default:
10 GiB
*/

const IDRIVE_E2_STORAGE_LIMIT_BYTES =
 Number(
 process.env.IDRIVE_E2_STORAGE_LIMIT_BYTES ||
 (
 10 *
 GIB
 )
 );


/*
Logical MEGA capacity.

Default:
20 GiB
*/

const MEGA_STORAGE_LIMIT_BYTES =
 Number(
 process.env.MEGA_STORAGE_LIMIT_BYTES ||
 (
 20 *
 GIB
 )
 );


/*
B2 display capacity.

Default:
10 GiB
*/

const B2_DISPLAY_CAPACITY_BYTES =
 10 *
 GIB;


/*
Cloudinary routing threshold and capacity.

Default:
24.95 GiB (25 GB Capacity)
*/

const CLOUDINARY_ROUTING_LIMIT_BYTES =
 Number(
 process.env.CLOUDINARY_ROUTING_LIMIT_BYTES ||
 (
 24.95 *
 GIB
 )
 );

const CLOUDINARY_STORAGE_LIMIT_BYTES =
 Number(
 process.env.CLOUDINARY_STORAGE_LIMIT_BYTES ||
 (
 25 *
 GIB
 )
 );


/*
Filebase routing threshold and capacity.

Default:
4.95 GiB (5 GB Capacity)
*/

const FILEBASE_ROUTING_LIMIT_BYTES =
 Number(
 process.env.FILEBASE_ROUTING_LIMIT_BYTES ||
 (
 4.95 *
 GIB
 )
 );

const FILEBASE_STORAGE_LIMIT_BYTES =
 Number(
 process.env.FILEBASE_STORAGE_LIMIT_BYTES ||
 (
 5 *
 GIB
 )
 );


/*
Koofr routing threshold and capacity.

Default:
9.95 GiB (10 GB Capacity)[span_1](start_span)[span_1](end_span)
*/

const KOOFR_ROUTING_LIMIT_BYTES =
 Number(
 process.env.KOOFR_ROUTING_LIMIT_BYTES ||
 (
 9.95 *
 GIB
 )
 );

const KOOFR_STORAGE_LIMIT_BYTES =
 Number(
 process.env.KOOFR_STORAGE_LIMIT_BYTES ||
 (
 10 *
 GIB
 )
 );


/* =========================================================
TOTAL LOGICAL CAPACITY
========================================================= */

const TOTAL_LOGICAL_CAPACITY_BYTES =
 B2_DISPLAY_CAPACITY_BYTES +
 MEGA_STORAGE_LIMIT_BYTES +
 IDRIVE_E2_STORAGE_LIMIT_BYTES +
 CLOUDINARY_STORAGE_LIMIT_BYTES +
 FILEBASE_STORAGE_LIMIT_BYTES +
 KOOFR_STORAGE_LIMIT_BYTES;


/* =========================================================
LIMITS
========================================================= */

const CHUNK_SIZE =
 Number(
 process.env.CHUNK_SIZE ||
 (
 100 *
 1024 *
 1024
 )
 );

const MAX_FILE_SIZE =
 Number(
 process.env.MAX_FILE_SIZE ||
 (
 1024 *
 1024 *
 1024 *
 1024
 )
 );

const MAX_PARTS =
 10000;


/* =========================================================
PATHS
========================================================= */

const FILE_PREFIX =
 "files/";

const UPLOAD_PREFIX =
 "_vault_uploads/";


/*
All MEGA-managed files live inside this folder.
*/

const MEGA_FOLDER_NAME =
 "My-Personal-Cloud";


/*
Internal MEGA filename prefix.
*/

const MEGA_FILE_PREFIX =
 "__MPC__";


/* =========================================================
ENVIRONMENT VALIDATION
========================================================= */

const missing =
 [];


if (!B2_ENDPOINT)
 missing.push(
 "B2_ENDPOINT"
 );

if (!B2_REGION)
 missing.push(
 "B2_REGION"
 );

if (!B2_KEY_ID)
 missing.push(
 "B2_KEY_ID"
 );

if (!B2_APPLICATION_KEY)
 missing.push(
 "B2_APPLICATION_KEY"
 );

if (!BUCKET_NAME)
 missing.push(
 "B2_BUCKET_NAME"
 );

if (!APP_PASSWORD)
 missing.push(
 "APP_PASSWORD"
 );

if (!SESSION_SECRET)
 missing.push(
 "SESSION_SECRET"
 );


if (missing.length) {

 console.error("");

 console.error(
 "=============================================="
 );

 console.error(
 "MISSING RENDER ENVIRONMENT VARIABLES"
 );

 console.error(
 "=============================================="
 );

 for (
 const item
 of missing
 ) {

 console.error(
 item
 );
 }

 console.error("");

 process.exit(1);
}


/* =========================================================
ENDPOINT VALIDATION
========================================================= */

const normalizedEndpoint =
 B2_ENDPOINT.replace(
 /\/+$/,
 ""
 );


if (
 !normalizedEndpoint.startsWith(
 "https://"
 )
) {

 console.error(
 "B2_ENDPOINT must start with https://"
 );

 process.exit(1);
}


const normalizedIDriveEndpoint =
 IDRIVE_E2_ENDPOINT.replace(
 /\/+$/,
 ""
 );


if (
 IDRIVE_E2_ENDPOINT &&
 !normalizedIDriveEndpoint.startsWith(
 "https://"
 )
) {

 console.error(
 "IDRIVE_E2_ENDPOINT must start with https://"
 );

 process.exit(1);
}


const normalizedFilebaseEndpoint =
 FILEBASE_ENDPOINT.replace(
 /\/+$/,
 ""
 );


if (
 FILEBASE_ENDPOINT &&
 !normalizedFilebaseEndpoint.startsWith(
 "https://"
 )
) {

 console.error(
 "FILEBASE_ENDPOINT must start with https://"
 );

 process.exit(1);
}


const normalizedKoofrEndpoint =
 KOOFR_ENDPOINT.replace(
 /\/+$/,
 ""
 );


if (
 KOOFR_ENDPOINT &&
 !normalizedKoofrEndpoint.startsWith(
 "https://"
 )
) {

 console.error(
 "KOOFR_ENDPOINT must start with https://"
 );

 process.exit(1);
}


/* =========================================================
B2 CLIENT
========================================================= */

const storage =
 new S3Client({

 region:
 B2_REGION,

 endpoint:
 normalizedEndpoint,

 forcePathStyle:
 true,

 credentials: {

 accessKeyId:
 B2_KEY_ID,

 secretAccessKey:
 B2_APPLICATION_KEY
 }
 });


/* =========================================================
IDRIVE E2 CLIENT
========================================================= */

let idriveStorage =
 null;


function idriveConfigured() {

 return (
 Boolean(
 IDRIVE_E2_ENDPOINT
 ) &&
 Boolean(
 IDRIVE_E2_REGION
 ) &&
 Boolean(
 IDRIVE_E2_KEY_ID
 ) &&
 Boolean(
 IDRIVE_E2_APPLICATION_KEY
 ) &&
 Boolean(
 IDRIVE_E2_BUCKET_NAME
 )
 );
}


if (
 idriveConfigured()
) {

 idriveStorage =
 new S3Client({

 region:
 IDRIVE_E2_REGION,

 endpoint:
 normalizedIDriveEndpoint,

 forcePathStyle:
 true,

 credentials: {

 accessKeyId:
 IDRIVE_E2_KEY_ID,

 secretAccessKey:
 IDRIVE_E2_APPLICATION_KEY
 }
 });
}


/* =========================================================
FILEBASE CLIENT
========================================================= */

let filebaseStorage =
 null;


function filebaseConfigured() {

 return (
 Boolean(
 FILEBASE_KEY_ID
 ) &&
 Boolean(
 FILEBASE_APPLICATION_KEY
 ) &&
 Boolean(
 FILEBASE_BUCKET_NAME
 )
 );
}


if (
 filebaseConfigured()
) {

 filebaseStorage =
 new S3Client({

 region:
 FILEBASE_REGION,

 endpoint:
 normalizedFilebaseEndpoint,

 forcePathStyle:
 true,

 credentials: {

 accessKeyId:
 FILEBASE_KEY_ID,

 secretAccessKey:
 FILEBASE_APPLICATION_KEY
 }
 });
}


/* =========================================================
KOOFR CLIENT â€” OFFICIAL WEBDAV ADAPTER

Koofr exposes WebDAV for application connections. The previous
implementation treated the WebDAV endpoint as an S3 endpoint,
which caused HTTP 401/XML parser errors. This adapter keeps the
existing S3-style call sites in the server while translating the
needed commands to Koofr WebDAV requests.
========================================================= */

let koofrStorage = null;

function koofrConfigured() {
 return Boolean(KOOFR_KEY_ID) && Boolean(KOOFR_APPLICATION_KEY);
}

const koofrMultipartDir = path.join(process.cwd(), ".koofr-multipart");
const koofrMultipartState = new Map();

function koofrUrl(key = "") {
 const clean = String(key || "").replace(/^\/+/, "");
 return `${normalizedKoofrEndpoint}/${clean.split("/").map(encodeURIComponent).join("/")}`;
}

function koofrAuthHeader() {
 return "Basic " + Buffer.from(`${KOOFR_KEY_ID}:${KOOFR_APPLICATION_KEY}`).toString("base64");
}

async function koofrRequest(method, key = "", options = {}) {
 const headers = {
  Authorization: koofrAuthHeader(),
  ...(options.headers || {})
 };
 const response = await fetch(koofrUrl(key), {
  method,
  headers,
  body: options.body,
  duplex: options.body ? "half" : undefined
 });
 if (!response.ok) {
  let text = "";
  try { text = await response.text(); } catch (_) {}
  const error = new Error(`Koofr WebDAV ${method} ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
  error.statusCode = response.status;
  throw error;
 }
 return response;
}

function decodeXmlText(value) {
 return String(value || "")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");
}

function parseKoofrPropfind(xml) {
 const responses = [];
 const blocks = String(xml || "").match(/<[^:>]*:?response\b[\s\S]*?<\/[^:>]*:?response>/gi) || [];
 for (const block of blocks) {
  const hrefMatch = block.match(/<[^:>]*:?href[^>]*>([\s\S]*?)<\//i);
  const lenMatch = block.match(/<[^:>]*:?getcontentlength[^>]*>([\s\S]*?)<\//i);
  const modMatch = block.match(/<[^:>]*:?getlastmodified[^>]*>([\s\S]*?)<\//i);
  const typeMatch = block.match(/<[^:>]*:?resourcetype[^>]*>([\s\S]*?)<\//i);
  if (!hrefMatch) continue;
  const href = decodeXmlText(hrefMatch[1]);
  const directory = /<[^:>]*:?collection\s*\/?\s*>/i.test(typeMatch?.[1] || "") || /\/$/.test(href);
  responses.push({
   filename: href,
   basename: decodeURIComponent(href.replace(/\/$/, "").split("/").pop() || ""),
   size: Number(lenMatch?.[1] || 0),
   lastmod: modMatch ? decodeXmlText(modMatch[1]) : null,
   type: directory ? "directory" : "file"
  });
 }
 return responses;
}

async function koofrList(prefix = FILE_PREFIX) {
 const response = await koofrRequest("PROPFIND", "", {
  headers: {
   Depth: "infinity",
   "Content-Type": "application/xml; charset=utf-8"
  },
  body: `<?xml version="1.0" encoding="utf-8" ?><propfind xmlns="DAV:"><prop><getcontentlength/><getlastmodified/><resourcetype/></prop></propfind>`
 });
 const xml = await response.text();
 const items = parseKoofrPropfind(xml);
 const base = "/" + String(prefix).replace(/^\/+|\/+$/g, "") + "/";
 return items.filter(item => {
  const href = decodeURIComponent(String(item.filename || ""));
  return item.type === "file" && (href.endsWith(base.slice(0,-1)) || href.includes(base));
 });
}

async function koofrStat(key) {
 const response = await koofrRequest("PROPFIND", key, {
  headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
  body: `<?xml version="1.0" encoding="utf-8" ?><propfind xmlns="DAV:"><prop><getcontentlength/><getlastmodified/><resourcetype/></prop></propfind>`
 });
 const items = parseKoofrPropfind(await response.text());
 const item = items.find(x => x.type === "file") || items[0];
 if (!item) throw new Error("Koofr object not found");
 return item;
}

async function koofrEnsureParent(key) {
 const clean = String(key || "").replace(/^\/+/, "");
 const parts = clean.split("/");
 parts.pop();
 let current = "";
 for (const part of parts) {
  if (!part) continue;
  current += (current ? "/" : "") + part;
  try { await koofrRequest("PROPFIND", current, { headers: { Depth: "0" }, body: `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>` }); }
  catch (error) {
   if (error.statusCode !== 404) throw error;
   try { await koofrRequest("MKCOL", current); } catch (e) { if (e.statusCode !== 405) throw e; }
  }
 }
}

async function koofrUploadPart(command) {
 const input = command.input || {};
 const uploadId = input.UploadId;
 const partNumber = Number(input.PartNumber);
 const state = koofrMultipartState.get(uploadId);
 if (!state) throw new Error("Koofr upload session not found; restart the upload.");
 await fsp.mkdir(koofrMultipartDir, { recursive: true });
 const filePath = state.filePath;
 const chain = state.locks.get(partNumber) || Promise.resolve();
 const task = chain.then(async () => {
  const handle = await fsp.open(filePath, "r+");
  try {
   let position = (partNumber - 1) * state.partSize;
   let total = 0;
   const hash = crypto.createHash("sha256");
   for await (const chunk of input.Body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    await handle.write(buffer, 0, buffer.length, position);
    position += buffer.length;
    total += buffer.length;
    hash.update(buffer);
   }
   state.parts.set(partNumber, { PartNumber: partNumber, ETag: `"${hash.digest("hex")}"`, Size: total });
   return { ETag: state.parts.get(partNumber).ETag };
  } finally { await handle.close(); }
 });
 state.locks.set(partNumber, task.catch(() => {}));
 return task;
}

async function koofrAdapterSend(command) {
 const name = command?.constructor?.name || "";
 const input = command.input || {};
 const key = input.Key || "";

 if (name === "ListObjectsV2Command") {
  const all = await koofrList(input.Prefix || FILE_PREFIX);
  const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
  const max = Number(input.MaxKeys || 1000);
  const slice = all.slice(start, start + max);
  return {
   Contents: slice.map(x => ({ Key: decodeURIComponent(x.filename).replace(/^\/+/, ""), Size: x.size, LastModified: x.lastmod ? new Date(x.lastmod) : undefined })),
   IsTruncated: start + max < all.length,
   NextContinuationToken: start + max < all.length ? String(start + max) : undefined
  };
 }
 if (name === "HeadObjectCommand") {
  const item = await koofrStat(key);
  return { ContentLength: item.size, LastModified: item.lastmod ? new Date(item.lastmod) : undefined, ContentType: getContentType(key) };
 }
 if (name === "GetObjectCommand") {
  const response = await koofrRequest("GET", key, { headers: input.Range ? { Range: input.Range } : {} });
  return { Body: Readable.fromWeb(response.body) };
 }
 if (name === "DeleteObjectCommand") {
  try { await koofrRequest("DELETE", key); } catch (error) { if (error.statusCode !== 404) throw error; }
  return {};
 }
 if (name === "CreateMultipartUploadCommand") {
  await fsp.mkdir(koofrMultipartDir, { recursive: true });
  const uploadId = crypto.randomBytes(18).toString("hex");
  const filePath = path.join(koofrMultipartDir, `${uploadId}.part`);
  const handle = await fsp.open(filePath, "w"); await handle.close();
  koofrMultipartState.set(uploadId, { filePath, key, partSize: CHUNK_SIZE, parts: new Map(), locks: new Map() });
  return { UploadId: uploadId };
 }
 if (name === "UploadPartCommand") return koofrUploadPart(command);
 if (name === "ListPartsCommand") {
  const state = koofrMultipartState.get(input.UploadId);
  if (!state) return { Parts: [], IsTruncated: false };
  return { Parts: [...state.parts.values()].sort((a,b) => a.PartNumber - b.PartNumber), IsTruncated: false };
 }
 if (name === "CompleteMultipartUploadCommand") {
  const state = koofrMultipartState.get(input.UploadId);
  if (!state) throw new Error("Koofr upload session not found; restart the upload.");
  await Promise.all([...state.locks.values()]);
  await koofrEnsureParent(key);
  const stat = await fsp.stat(state.filePath);
  const stream = fs.createReadStream(state.filePath);
  await koofrRequest("PUT", key, { headers: { "Content-Type": getContentType(key), "Content-Length": String(stat.size) }, body: stream });
  await fsp.rm(state.filePath, { force: true });
  koofrMultipartState.delete(input.UploadId);
  return { Key: key };
 }
 if (name === "AbortMultipartUploadCommand") {
  const state = koofrMultipartState.get(input.UploadId);
  if (state) { await fsp.rm(state.filePath, { force: true }); koofrMultipartState.delete(input.UploadId); }
  return {};
 }
 if (name === "ListObjectVersionsCommand") return { Versions: [], DeleteMarkers: [], IsTruncated: false };
 throw new Error(`Unsupported Koofr operation: ${name}`);
}

if (koofrConfigured()) {
 koofrStorage = { send: koofrAdapterSend };
}

/* =========================================================
MEGA STATE
========================================================= */

let megaStorage =
 null;

let megaFolder =
 null;

let megaReady =
 false;

let megaInitPromise =
 null;

let megaLastError =
 null;


const megaUploads =
 new Map();


let megaFolderPromise =
 null;


/* =========================================================
CLOUDINARY HELPERS & CONFIG
========================================================= */

function cloudinaryConfigured() {
 return (
 Boolean(CLOUDINARY_CLOUD_NAME) &&
 Boolean(CLOUDINARY_API_KEY) &&
 Boolean(CLOUDINARY_API_SECRET)
 );
}


async function getCloudinaryStorageUsage() {
 if (!cloudinaryConfigured()) {
 return {
 totalBytes: 0,
 fileCount: 0,
 limitBytes: CLOUDINARY_STORAGE_LIMIT_BYTES,
 routingLimitBytes: CLOUDINARY_ROUTING_LIMIT_BYTES,
 remainingBytes: CLOUDINARY_STORAGE_LIMIT_BYTES,
 routingRemainingBytes: CLOUDINARY_ROUTING_LIMIT_BYTES
 };
 }

 try {
 let totalBytes = 0;
 let fileCount = 0;
 let nextCursor = null;

 do {
 const result = await cloudinary.api.resources({
 type: "upload",
 prefix: "my_personal_cloud/",
 max_results: 500,
 next_cursor: nextCursor
 });

 if (result && result.resources) {
 for (const resItem of result.resources) {
 totalBytes += Number(resItem.bytes || 0);
 fileCount++;
 }
 }

 nextCursor = result?.next_cursor;
 } while (nextCursor);

 return {
 totalBytes,
 fileCount,
 limitBytes: CLOUDINARY_STORAGE_LIMIT_BYTES,
 routingLimitBytes: CLOUDINARY_ROUTING_LIMIT_BYTES,
 remainingBytes: Math.max(0, CLOUDINARY_STORAGE_LIMIT_BYTES - totalBytes),
 routingRemainingBytes: Math.max(0, CLOUDINARY_ROUTING_LIMIT_BYTES - totalBytes)
 };
 } catch (error) {
 console.error("CLOUDINARY USAGE SCAN ERROR:", error);
 return {
 totalBytes: 0,
 fileCount: 0,
 limitBytes: CLOUDINARY_STORAGE_LIMIT_BYTES,
 routingLimitBytes: CLOUDINARY_ROUTING_LIMIT_BYTES,
 remainingBytes: CLOUDINARY_STORAGE_LIMIT_BYTES,
 routingRemainingBytes: CLOUDINARY_ROUTING_LIMIT_BYTES
 };
 }
}


async function listCloudinaryFiles() {
 if (!cloudinaryConfigured()) {
 return [];
 }

 try {
 const files = [];
 let nextCursor = null;

 do {
 const result = await cloudinary.api.resources({
 type: "upload",
 prefix: "my_personal_cloud/",
 max_results: 500,
 next_cursor: nextCursor
 });

 if (result && result.resources) {
 for (const resItem of result.resources) {
 const publicId = resItem.public_id || "";
 let name = publicId;
 if (name.startsWith("my_personal_cloud/")) {
 name = name.substring("my_personal_cloud/".length);
 }
 
 const size = Number(resItem.bytes || 0);
 files.push({
 name,
 size,
 sizeText: formatBytes(size),
 modified: resItem.created_at || null,
 type: getContentType(name),
 storage: "CLOUDINARY",
 storageLabel: "Cloudinary",
 publicId: resItem.public_id,
 secureUrl: resItem.secure_url
 });
 }
 }

 nextCursor = result?.next_cursor;
 } while (nextCursor);

 return files;
 } catch (error) {
 console.error("CLOUDINARY LIST ERROR:", error);
 return [];
 }
}


async function findCloudinaryFile(relativePath) {
 const clean = cleanPath(relativePath);
 if (!clean) return null;

 const files = await listCloudinaryFiles();
 for (const f of files) {
 if (f.name === clean) {
 return f;
 }
 }
 return null;
}


/* =========================================================
BODY
========================================================= */

app.use(
 express.json({
 limit:
 "1mb"
 })
);


/* =========================================================
STATIC WEBSITE
========================================================= */

app.use(
 express.static(
 PUBLIC_DIR,
 {

 extensions:
 ["html"],

 setHeaders(
 res
 ) {

 res.setHeader(
 "Cache-Control",
 "no-store"
 );
 }
 }
 )
);


/* =========================================================
HELPERS
========================================================= */

function cleanPath(
 value
) {

 return String(
 value || ""
 )
 .replace(
 /\\/g,
 "/"
 )
 .split("/")
 .filter(
 part =>
 part &&
 part !== "." &&
 part !== ".."
 )
 .map(
 part =>
 part.replace(
 /[<>:"|?*\x00-\x1F]/g,
 "_"
 )
 )
 .join("/");
}


function fileKey(
 relativePath
) {

 const clean =
 cleanPath(
 relativePath
 );

 if (!clean) {

 throw new Error(
 "Invalid file path"
 );
 }

 return (
 FILE_PREFIX +
 clean
 );
}


function metadataKey(
 id
) {

 return (
 UPLOAD_PREFIX +
 id +
 ".json"
 );
}


function createUploadId() {

 return crypto
 .randomBytes(
 20
 )
 .toString(
 "hex"
 );
}


function formatBytes(
 bytes
) {

 bytes =
 Number(
 bytes
 );

 if (
 !Number.isFinite(
 bytes
 ) ||
 bytes <= 0
 ) {

 return "0 B";
 }

 const units = [
 "B",
 "KB",
 "MB",
 "GB",
 "TB"
 ];

 const index =
 Math.min(
 Math.floor(
 Math.log(
 bytes
 ) /
 Math.log(
 1024
 )
 ),
 units.length - 1
 );

 return (
 (
 bytes /
 Math.pow(
 1024,
 index
 )
 ).toFixed(
 index === 0
 ? 0
 : 2
 ) +
 " " +
 units[index]
 );
}


function errorCode(
 error
) {

 return (
 error?.Code ||
 error?.code ||
 error?.name ||
 ""
 );
}


function getContentType(
 name
) {

 const ext =
 path.extname(
 String(
 name || ""
 )
 ).toLowerCase();

 const types = {

 ".jpg":
 "image/jpeg",

 ".jpeg":
 "image/jpeg",

 ".png":
 "image/png",

 ".gif":
 "image/gif",

 ".webp":
 "image/webp",

 ".svg":
 "image/svg+xml",

 ".bmp":
 "image/bmp",

 ".mp4":
 "video/mp4",

 ".webm":
 "video/webm",

 ".mov":
 "video/quicktime",

 ".m4v":
 "video/x-m4v",

 ".mp3":
 "audio/mpeg",

 ".wav":
 "audio/wav",

 ".m4a":
 "audio/mp4",

 ".aac":
 "audio/aac",

 ".ogg":
 "audio/ogg",

 ".flac":
 "audio/flac",

 ".pdf":
 "application/pdf",

 ".txt":
 "text/plain; charset=utf-8",

 ".json":
 "application/json",

 ".csv":
 "text/csv",

 ".zip":
 "application/zip",

 ".rar":
 "application/vnd.rar",

 ".7z":
 "application/x-7z-compressed",

 ".doc":
 "application/msword",

 ".docx":
 "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

 ".xls":
 "application/vnd.ms-excel",

 ".xlsx":
 "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

 ".ppt":
 "application/vnd.ms-powerpoint",

 ".pptx":
 "application/vnd.openxmlformats-officedocument.presentationml.presentation"
 };

 return (
 types[ext] ||
 "application/octet-stream"
 );
}


/* =========================================================
SESSION SECURITY
========================================================= */

function base64url(
 buffer
) {

 return Buffer
 .from(
 buffer
 )
 .toString(
 "base64"
 )
 .replace(
 /\+/g,
 "-"
 )
 .replace(
 /\//g,
 "_"
 )
 .replace(
 /=+$/g,
 ""
 );
}


function sign(
 value
) {

 return base64url(
 crypto
 .createHmac(
 "sha256",
 SESSION_SECRET
 )
 .update(
 value
 )
 .digest()
 );
}


function createSession() {

 const payload =
 JSON.stringify({

 exp:
 Date.now() +
 1000 *
 60 *
 60 *
 24 *
 7,

 nonce:
 crypto
 .randomBytes(
 16
 )
 .toString(
 "hex"
 )
 });

 const encoded =
 base64url(
 Buffer.from(
 payload
 )
 );

 return (
 encoded +
 "." +
 sign(
 encoded
 )
 );
}


function verifySession(
 value
) {

 if (!value) {
 return false;
 }

 const parts =
 String(
 value
 ).split(
 "."
 );

 if (
 parts.length !== 2
 ) {

 return false;
 }

 const [
 encoded,
 signature
 ] = parts;

 const expected =
 sign(
 encoded
 );

 const a =
 Buffer.from(
 signature
 );

 const b =
 Buffer.from(
 expected
 );

 if (
 a.length !== b.length ||
 !crypto.timingSafeEqual(
 a,
 b
 )
 ) {

 return false;
 }

 try {

 const payload =
 JSON.parse(
 Buffer.from(
 encoded,
 "base64url"
 ).toString(
 "utf8"
 )
 );

 return (
 Number(
 payload.exp
 ) >
 Date.now()
 );

 } catch (_) {

 return false;
 }
}


function getCookies(
 req
) {

 const result = {};

 const raw =
 req.headers.cookie ||
 "";

 for (
 const part
 of raw.split(";")
 ) {

 const index =
 part.indexOf("=");

 if (
 index === -1
 ) {

 continue;
 }

 const key =
 part
 .slice(
 0,
 index
 )
 .trim();

 const value =
 part
 .slice(
 index + 1
 )
 .trim();

 result[key] =
 value;
 }

 return result;
}


function isAuthenticated(
 req
) {

 const cookies =
 getCookies(
 req
 );

 return verifySession(
 cookies.cloud_session
 );
}


function requireAuth(
 req,
 res,
 next
) {

 if (
 isAuthenticated(
 req
 )
 ) {

 return next();
 }

 return res
 .status(
 401
 )
 .json({
 error:
 "Authentication required"
 });
}


/* =========================================================
LOGIN RATE LIMIT
========================================================= */

const loginAttempts =
 new Map();


function loginAllowed(
 ip
) {

 const now =
 Date.now();

 const item =
 loginAttempts.get(
 ip
 );

 if (!item) {
 return true;
 }

 if (
 now -
 item.time >
 15 *
 60 *
 1000
 ) {

 loginAttempts.delete(
 ip
 );

 return true;
 }

 return (
 item.count <
 10
 );
}


/* =========================================================
AUTH LOGIN
========================================================= */

app.post(
 "/api/auth/login",
 function(
 req,
 res
 ) {

 const ip =
 req.ip ||
 "unknown";

 if (
 !loginAllowed(
 ip
 )
 ) {

 return res
 .status(
 429
 )
 .json({
 error:
 "Too many login attempts. Try again later."
 });
 }

 const password =
 String(
 req.body?.password ||
 ""
 );

 const a =
 Buffer.from(
 password
 );

 const b =
 Buffer.from(
 APP_PASSWORD
 );

 const valid =
 a.length ===
 b.length &&
 crypto.timingSafeEqual(
 a,
 b
 );

 if (!valid) {

 const old =
 loginAttempts.get(
 ip
 ) || {

 count:
 0,

 time:
 Date.now()
 };

 old.count +=
 1;

 old.time =
 Date.now();

 loginAttempts.set(
 ip,
 old
 );

 return res
 .status(
 401
 )
 .json({
 error:
 "Incorrect password"
 });
 }

 loginAttempts.delete(
 ip
 );

 const session =
 createSession();

 const secure =
 process.env.NODE_ENV ===
 "production";

 res.setHeader(
 "Set-Cookie",
 [
 "cloud_session=" +
 session,

 "Path=/",

 "HttpOnly",

 "SameSite=Lax",

 secure
 ? "Secure"
 : ""
 ]
 .filter(
 Boolean
 )
 .join(
 "; "
 )
 );

 return res.json({
 ok:
 true
 });
 }
);


/* =========================================================
AUTH CHECK
========================================================= */

app.get(
 "/api/auth/me",
 function(
 req,
 res
 ) {

 return res.json({

 authenticated:
 isAuthenticated(
 req
 )
 });
 }
);


/* =========================================================
LOGOUT
========================================================= */

app.post(
 "/api/auth/logout",
 function(
 req,
 res
 ) {

 res.setHeader(
 "Set-Cookie",
 "cloud_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
 );

 return res.json({
 ok:
 true
 });
 }
);


/* =========================================================
B2 METADATA
========================================================= */

async function readMetadata(
 key
) {

 const result =
 await storage.send(
 new GetObjectCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 key
 })
 );

 const text =
 await result.Body
 .transformToString(
 "utf8"
 );

 return JSON.parse(
 text
 );
}


async function writeMetadata(
 key,
 data
) {

 await storage.send(
 new PutObjectCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 key,

 Body:
 JSON.stringify(
 data
 ),

 ContentType:
 "application/json",

 CacheControl:
 "no-store"
 })
 );
}


async function deleteMetadata(
 id
) {

 try {

 await storage.send(
 new DeleteObjectCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 metadataKey(
 id
 )
 })
 );

 } catch (_) {}
}


/* =========================================================
B2 STORAGE SCAN
========================================================= */

async function getB2StorageUsage() {

 let totalBytes =
 0;

 let fileCount =
 0;

 let continuationToken;


 do {

 const result =
 await storage.send(
 new ListObjectsV2Command({

 Bucket:
 BUCKET_NAME,

 Prefix:
 FILE_PREFIX,

 ContinuationToken:
 continuationToken,

 MaxKeys:
 1000
 })
 );


 for (
 const object
 of result.Contents || []
 ) {

 if (
 object.Key &&
 !object.Key.endsWith(
 "/"
 )
 ) {

 totalBytes +=
 Number(
 object.Size ||
 0
 );

 fileCount++;
 }
 }


 continuationToken =
 result.IsTruncated
 ? result.NextContinuationToken
 : undefined;

 } while (
 continuationToken
 );


 return {

 totalBytes,

 fileCount,

 limitBytes:
 B2_DISPLAY_CAPACITY_BYTES,

 routingLimitBytes:
 B2_ROUTING_LIMIT_BYTES,

 remainingBytes:
 Math.max(
 0,
 B2_DISPLAY_CAPACITY_BYTES -
 totalBytes
 ),

 routingRemainingBytes:
 Math.max(
 0,
 B2_ROUTING_LIMIT_BYTES -
 totalBytes
 )
 };
}


/* =========================================================
IDRIVE E2 STORAGE SCAN
========================================================= */

async function getIDriveE2StorageUsage() {

 if (
 !idriveConfigured()
 ) {

 const error =
 new Error(
 "IDrive E2 is not configured."
 );

 error.code =
 "IDRIVE_E2_NOT_CONFIGURED";

 throw error;
 }


 let totalBytes =
 0;

 let fileCount =
 0;

 let continuationToken;


 do {

 const result =
 await idriveStorage.send(
 new ListObjectsV2Command({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Prefix:
 FILE_PREFIX,

 ContinuationToken:
 continuationToken,

 MaxKeys:
 1000
 })
 );


 for (
 const object
 of result.Contents || []
 ) {

 if (
 object.Key &&
 !object.Key.endsWith(
 "/"
 )
 ) {

 totalBytes +=
 Number(
 object.Size ||
 0
 );

 fileCount++;
 }
 }


 continuationToken =
 result.IsTruncated
 ? result.NextContinuationToken
 : undefined;

 } while (
 continuationToken
 );


 const warning =
 totalBytes >=
 IDRIVE_E2_WARNING_LIMIT_BYTES;


 return {

 totalBytes,

 fileCount,

 limitBytes:
 IDRIVE_E2_STORAGE_LIMIT_BYTES,

 routingLimitBytes:
 IDRIVE_E2_ROUTING_LIMIT_BYTES,

 warningLimitBytes:
 IDRIVE_E2_WARNING_LIMIT_BYTES,

 remainingBytes:
 Math.max(
 0,
 IDRIVE_E2_STORAGE_LIMIT_BYTES -
 totalBytes
 ),

 routingRemainingBytes:
 Math.max(
 0,
 IDRIVE_E2_ROUTING_LIMIT_BYTES -
 totalBytes
 ),

 warning,

 warningMessage:
 warning
 ? "IDrive E2 storage is almost full."
 : null
 };
}


/* =========================================================
IDRIVE E2 HEALTH
========================================================= */

async function verifyIDriveE2() {

 if (
 !idriveConfigured()
 ) {

 return {

 configured:
 false,

 connected:
 false,

 error:
 "IDrive E2 is not configured."
 };
 }


 try {

 await idriveStorage.send(
 new ListObjectsV2Command({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Prefix:
 FILE_PREFIX,

 MaxKeys:
 1
 })
 );


 return {

 configured:
 true,

 connected:
 true,

 error:
 null
 };

 } catch (error) {

 return {

 configured:
 true,

 connected:
 false,

 error:
 error.message
 };
 }
}


/* =========================================================
FILEBASE STORAGE SCAN
========================================================= */

async function getFilebaseStorageUsage() {

 if (
 !filebaseConfigured()
 ) {

 const error =
 new Error(
 "Filebase is not configured."
 );

 error.code =
 "FILEBASE_NOT_CONFIGURED";

 throw error;
 }


 let totalBytes =
 0;

 let fileCount =
 0;

 let continuationToken;


 do {

 const result =
 await filebaseStorage.send(
 new ListObjectsV2Command({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Prefix:
 FILE_PREFIX,

 ContinuationToken:
 continuationToken,

 MaxKeys:
 1000
 })
 );


 for (
 const object
 of result.Contents || []
 ) {

 if (
 object.Key &&
 !object.Key.endsWith(
 "/"
 )
 ) {

 totalBytes +=
 Number(
 object.Size ||
 0
 );

 fileCount++;
 }
 }


 continuationToken =
 result.IsTruncated
 ? result.NextContinuationToken
 : undefined;

 } while (
 continuationToken
 );


 return {

 totalBytes,

 fileCount,

 limitBytes:
 FILEBASE_STORAGE_LIMIT_BYTES,

 routingLimitBytes:
 FILEBASE_ROUTING_LIMIT_BYTES,

 remainingBytes:
 Math.max(
 0,
 FILEBASE_STORAGE_LIMIT_BYTES -
 totalBytes
 ),

 routingRemainingBytes:
 Math.max(
 0,
 FILEBASE_ROUTING_LIMIT_BYTES -
 totalBytes
 )
 };
}


/* =========================================================
FILEBASE HEALTH
========================================================= */

async function verifyFilebase() {

 if (
 !filebaseConfigured()
 ) {

 return {

 configured:
 false,

 connected:
 false,

 error:
 "Filebase is not configured."
 };
 }


 try {

 await filebaseStorage.send(
 new ListObjectsV2Command({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Prefix:
 FILE_PREFIX,

 MaxKeys:
 1
 })
 );


 return {

 configured:
 true,

 connected:
 true,

 error:
 null
 };

 } catch (error) {

 return {

 configured:
 true,

 connected:
 false,

 error:
 error.message
 };
 }
}


/* =========================================================
KOOFR STORAGE SCAN
========================================================= */

async function getKoofrStorageUsage() {

 if (
 !koofrConfigured()
 ) {

 const error =
 new Error(
 "Koofr is not configured."
 );

 error.code =
 "KOOFR_NOT_CONFIGURED";

 throw error;
 }


 let totalBytes =
 0;

 let fileCount =
 0;

 let continuationToken;


 do {

 const result =
 await koofrStorage.send(
 new ListObjectsV2Command({

 Bucket:
 KOOFR_BUCKET_NAME,

 Prefix:
 FILE_PREFIX,

 ContinuationToken:
 continuationToken,

 MaxKeys:
 1000
 })
 );


 for (
 const object
 of result.Contents || []
 ) {

 if (
 object.Key &&
 !object.Key.endsWith(
 "/"
 )
 ) {

 totalBytes +=
 Number(
 object.Size ||
 0
 );

 fileCount++;
 }
 }


 continuationToken =
 result.IsTruncated
 ? result.NextContinuationToken
 : undefined;

 } while (
 continuationToken
 );


 return {

 totalBytes,

 fileCount,

 limitBytes:
 KOOFR_STORAGE_LIMIT_BYTES,

 routingLimitBytes:
 KOOFR_ROUTING_LIMIT_BYTES,

 remainingBytes:
 Math.max(
 0,
 KOOFR_STORAGE_LIMIT_BYTES -
 totalBytes
 ),

 routingRemainingBytes:
 Math.max(
 0,
 KOOFR_ROUTING_LIMIT_BYTES -
 totalBytes
 )
 };
}


/* =========================================================
KOOFR HEALTH
========================================================= */

async function verifyKoofr() {

 if (
 !koofrConfigured()
 ) {

 return {

 configured:
 false,

 connected:
 false,

 error:
 "Koofr is not configured."
 };
 }


 try {

 await koofrStorage.send(
 new ListObjectsV2Command({

 Bucket:
 KOOFR_BUCKET_NAME,

 Prefix:
 FILE_PREFIX,

 MaxKeys:
 1
 })
 );


 return {

 configured:
 true,

 connected:
 true,

 error:
 null
 };

 } catch (error) {

 return {

 configured:
 true,

 connected:
 false,

 error:
 error.message
 };
 }
}


/* =========================================================
MEGA INITIALIZATION
========================================================= */

function megaConfigured() {

 return (
 Boolean(
 MEGA_EMAIL
 ) &&
 Boolean(
 MEGA_PASSWORD
 )
 );
}


async function ensureMegaStorage() {

 if (
 megaReady &&
 megaStorage
 ) {

 return megaStorage;
 }


 if (
 !megaConfigured()
 ) {

 const error =
 new Error(
 "MEGA is not configured. Set MEGA_EMAIL and MEGA_PASSWORD in Render."
 );

 error.code =
 "MEGA_NOT_CONFIGURED";

 throw error;
 }


 if (
 megaInitPromise
 ) {

 return megaInitPromise;
 }


 megaInitPromise =
 (async function() {

 console.log(
 "Connecting to MEGA..."
 );


 const options = {

 email:
 MEGA_EMAIL,

 password:
 MEGA_PASSWORD,

 userAgent:
 "My-Personal-Cloud/4.0"
 };


 if (
 MEGA_SECOND_FACTOR_CODE
 ) {

 options.secondFactorCode =
 MEGA_SECOND_FACTOR_CODE;
 }


 // Load the login session first, then explicitly reload the file tree.
 // This avoids treating a not-yet-loaded root as a failed connection.
 options.autoload = false;

 const instance = new Storage(options);
 const connected = await instance.ready;

 if (!connected) {
  throw new Error("MEGA login did not return a storage session.");
 }

 if (typeof connected.reload === "function") {
  await connected.reload();
 }

 if (!connected.root) {
  throw new Error("MEGA login succeeded but the Cloud Drive root was not loaded after reload. Check MEGA credentials/2FA and try again.");
 }

 megaStorage = connected;
 megaFolder = null;

 await ensureMegaFolder();


 megaReady =
 true;
 megaLastError =
 null;

 console.log(
 "MEGA connection: READY"
 );


 return megaStorage;

 })();


 try {

 return await megaInitPromise;

 } catch (error) {

 megaReady =
 false;

 megaStorage =
 null;
 megaFolder =
 null;
 megaFolderPromise =
 null;
 megaLastError =
 error?.message || String(error);

 console.error(
 "MEGA CONNECTION ERROR:",
 megaLastError
 );

 throw error;

 } finally {

 megaInitPromise =
 null;
 }
}


/* =========================================================
MEGA FOLDER
========================================================= */

async function ensureMegaFolder() {

 if (!megaStorage || !megaStorage.root) {
  throw new Error("MEGA Cloud Drive root is unavailable.");
 }

 if (
 megaFolder
 ) {

 return megaFolder;
 }


 if (
 megaFolderPromise
 ) {

 return megaFolderPromise;
 }


 megaFolderPromise =
 (async function() {

 const current =
 megaStorage.root
 .children
 .find(
 item =>
 item.directory &&
 item.name ===
 MEGA_FOLDER_NAME
 );


 if (
 current
 ) {

 megaFolder =
 current;

 return current;
 }


 const created =
 await megaStorage.root.mkdir(
 MEGA_FOLDER_NAME
 );


 megaFolder =
 created;


 return created;

 })();


 try {

 return await megaFolderPromise;

 } finally {

 megaFolderPromise =
 null;
 }
}


/* =========================================================
MEGA QUOTA
========================================================= */

async function getMegaAccountUsage() {

 const mega =
 await ensureMegaStorage();


 const info =
 await mega.getAccountInfo();


 const actualTotal =
 Number(
 info.spaceTotal ||
 0
 );

 const actualUsed =
 Number(
 info.spaceUsed ||
 0
 );


 const effectiveLimit =
 actualTotal > 0
 ? Math.min(
 MEGA_STORAGE_LIMIT_BYTES,
 actualTotal
 )
 : MEGA_STORAGE_LIMIT_BYTES;


 return {

 spaceUsed:
 actualUsed,

 spaceTotal:
 actualTotal,

 effectiveLimit,

 available:
 Math.max(
 0,
 effectiveLimit -
 actualUsed
 )
 };
}


/* =========================================================
MEGA INTERNAL NAME
========================================================= */

function encodeMegaPath(
 value
) {

 return Buffer
 .from(
 String(
 value
 ),
 "utf8"
 )
 .toString(
 "base64url"
 );
}


function decodeMegaPath(
 value
) {

 try {

 return Buffer
 .from(
 String(
 value
 ),
 "base64url"
 )
 .toString(
 "utf8"
 );

 } catch (_) {

 return "";
 }
}


function createMegaInternalName(
 relativePath,
 id
) {

 const encoded =
 encodeMegaPath(
 cleanPath(
 relativePath
 )
 );

 const cleanId =
 String(
 id
 ).replace(
 /[^a-z0-9-]/gi,
 ""
 );

 return (
 MEGA_FILE_PREFIX +
 encoded +
 "__" +
 cleanId
 );
}


function parseMegaInternalName(
 name
) {

 const value =
 String(
 name ||
 ""
 );


 if (
 !value.startsWith(
 MEGA_FILE_PREFIX
 )
 ) {

 return null;
 }


 const rest =
 value.substring(
 MEGA_FILE_PREFIX.length
 );


 const separator =
 rest.lastIndexOf(
 "__"
 );


 if (
 separator <= 0
 ) {

 return null;
 }


 const encoded =
 rest.substring(
 0,
 separator
 );


 const id =
 rest.substring(
 separator + 2
 );


 const originalPath =
 decodeMegaPath(
 encoded
 );


 if (
 !originalPath
 ) {

 return null;
 }


 return {

 id,

 name:
 originalPath,

 internalName:
 value
 };
}


/* =========================================================
MEGA FIND FILE
========================================================= */

async function findMegaFile(
 relativePath
) {

 const folder =
 await ensureMegaFolder();


 const clean =
 cleanPath(
 relativePath
 );


 if (!clean) {
 return null;
 }


 const matches =
 folder.children
 .filter(
 item =>
 !item.directory
 );


 for (
 const item
 of matches
 ) {

 const parsed =
 parseMegaInternalName(
 item.name
 );


 if (
 parsed &&
 parsed.name ===
 clean
 ) {

 return {

 file:
 item,

 parsed
 };
 }
 }


 return null;
}


/* =========================================================
MEGA LIST
========================================================= */

async function listMegaFiles() {

 // IMPORTANT: /api/files can be requested immediately after the Render
 // process starts.  In that case MEGA login may still be in progress.
 // Always wait for the MEGA session to become ready before touching
 // megaStorage.root.  This prevents the:
 //   "MEGA Cloud Drive root is unavailable"
 // race condition.
 await ensureMegaStorage();

 const folder =
 await ensureMegaFolder();


 try {

 await megaStorage.reload();

 } catch (error) {

 console.warn(
 "MEGA reload warning:",
 error.message
 );
 }


 const refreshedFolder =
 megaStorage.root
 .children
 .find(
 item =>
 item.directory &&
 item.name ===
 MEGA_FOLDER_NAME
 );


 if (
 refreshedFolder
 ) {

 megaFolder =
 refreshedFolder;
 }


 const files = [];


 for (
 const item
 of megaFolder.children || []
 ) {

 if (
 item.directory
 ) {

 continue;
 }


 const parsed =
 parseMegaInternalName(
 item.name
 );


 if (
 !parsed
 ) {

 continue;
 }


 const size =
 Number(
 item.size ||
 0
 );


 let modified =
 null;


 if (
 item.timestamp
 ) {

 modified =
 new Date(
 Number(
 item.timestamp
 ) *
 1000
 ).toISOString();
 }


 files.push({

 name:
 parsed.name,

 size,

 sizeText:
 formatBytes(
 size
 ),

 modified,

 type:
 getContentType(
 parsed.name
 ),

 storage:
 "MEGA",

 storageLabel:
 "MEGA",

 megaNodeId:
 item.nodeId
 });
 }


 return files;
}


/* =========================================================
UPLOAD LOCKS
========================================================= */

const uploadCreationLocks =
 new Map();

const finalizeLocks =
 new Map();


/* =========================================================
UPLOAD ROUTING
Sequence: B2 -> MEGA -> IDrive E2 -> Cloudinary -> Filebase -> Koofr
========================================================= */

async function chooseUploadStorage(
 size
) {

 const fileSize =
 Number(
 size
 );


 if (
 !Number.isSafeInteger(
 fileSize
 ) ||
 fileSize <= 0
 ) {

 const error =
 new Error(
 "Invalid file size."
 );

 error.statusCode =
 400;

 throw error;
 }


 /*
 --------------------------------------------------------
 STEP 1 â€” BACKBLAZE B2 (10 GB / Routing limit 9.95 GB)
 --------------------------------------------------------
 */

 const b2 =
 await getB2StorageUsage();


 if (
 b2.totalBytes +
 fileSize <=
 B2_ROUTING_LIMIT_BYTES
 ) {

 return {

 storage:
 "B2",

 b2
 };
 }


 /*
 --------------------------------------------------------
 STEP 2 â€” MEGA (20 GB / Routing limit 19.95 GB)
 --------------------------------------------------------
 */

 if (
 megaConfigured()
 ) {

 const megaFiles = await listMegaFiles();
 let megaTotal = 0;
 for (const f of megaFiles) {
 megaTotal += Number(f.size || 0);
 }

 if (
 megaTotal +
 fileSize <=
 MEGA_ROUTING_LIMIT_BYTES
 ) {

 return {

 storage:
 "MEGA",

 b2,

 megaTotal
 };
 }
 }


 /*
 --------------------------------------------------------
 STEP 3 â€” IDRIVE E2 (10 GB / Routing limit 9.95 GB)
 --------------------------------------------------------
 */

 if (
 idriveConfigured()
 ) {

 const idrive =
 await getIDriveE2StorageUsage();


 if (
 idrive.totalBytes +
 fileSize <=
 IDRIVE_E2_ROUTING_LIMIT_BYTES
 ) {

 return {

 storage:
 "IDRIVE_E2",

 b2,

 idrive
 };
 }
 }


 /*
 --------------------------------------------------------
 STEP 4 â€” CLOUDINARY (25 GB / Routing limit 24.95 GB)
 --------------------------------------------------------
 */

 if (
 cloudinaryConfigured()
 ) {

 const cloudinaryUsage =
 await getCloudinaryStorageUsage();


 if (
 cloudinaryUsage.totalBytes +
 fileSize <=
 CLOUDINARY_ROUTING_LIMIT_BYTES
 ) {

 return {

 storage:
 "CLOUDINARY",

 b2,

 cloudinary:
 cloudinaryUsage
 };
 }
 }


 /*
 --------------------------------------------------------
 STEP 5 â€” FILEBASE (5 GB / Routing limit 4.95 GB)
 --------------------------------------------------------
 */

 if (
 filebaseConfigured()
 ) {

 const filebase =
 await getFilebaseStorageUsage();


 if (
 filebase.totalBytes +
 fileSize <=
 FILEBASE_ROUTING_LIMIT_BYTES
 ) {

 return {

 storage:
 "FILEBASE",

 b2,

 filebase
 };
 }
 }


 /*
 --------------------------------------------------------
 STEP 6 â€” KOOFR (10 GB / Routing limit 9.95 GB)[span_2](start_span)[span_2](end_span)
 --------------------------------------------------------
 */

 if (
 koofrConfigured()
 ) {

 const koofr =
 await getKoofrStorageUsage();


 if (
 koofr.totalBytes +
 fileSize <=
 KOOFR_ROUTING_LIMIT_BYTES
 ) {

 return {

 storage:
 "KOOFR",

 b2,

 koofr
 };
 }
 }


 /*
 --------------------------------------------------------
 STORAGE FULL LIMIT EXCEEDED ALERT
 --------------------------------------------------------
 */

 const error =
 new Error(
 "Alert: Storage full limit exceeded! All configured cloud locations (B2, MEGA, IDrive E2, Cloudinary, Filebase, Koofr) are full. Data usage blocked to prevent extra charges."
 );

 error.statusCode =
 507;

 throw error;
}


/* =========================================================
MEGA APPLICATION USAGE
========================================================= */

async function getMegaApplicationUsage() {

 const files =
 await listMegaFiles();

 let total =
 0;


 for (
 const file
 of files
 ) {

 total +=
 Number(
 file.size ||
 0
 );
 }


 return total;
}


/* =========================================================
CREATE B2 MULTIPART UPLOAD
========================================================= */

async function getOrCreateB2Upload(
 options
) {

 const {
 id,
 name,
 relativePath,
 size,
 total
 } = options;

 const metaKey =
 metadataKey(
 id
 );


 try {

 const existing =
 await readMetadata(
 metaKey
 );

 if (
 existing?.uploadId &&
 existing?.key &&
 existing?.storage ===
 "B2"
 ) {

 return existing;
 }

 } catch (_) {}


 if (
 uploadCreationLocks.has(
 id
 )
 ) {

 return uploadCreationLocks.get(
 id
 );
 }


 const promise =
 (async function() {

 try {

 const existing =
 await readMetadata(
 metaKey
 );

 if (
 existing?.uploadId &&
 existing?.key &&
 existing?.storage ===
 "B2"
 ) {

 return existing;
 }

 } catch (_) {}


 const routing =
 await chooseUploadStorage(
 size
 );


 if (
 routing.storage !==
 "B2"
 ) {

 throw new Error(
 "Upload must be routed to another storage."
 );
 }


 const safePath =
 cleanPath(
 relativePath
 ) ||
 cleanPath(
 name
 );


 if (!safePath) {

 throw new Error(
 "Invalid file name"
 );
 }


 const key =
 fileKey(
 safePath
 );


 const result =
 await storage.send(
 new CreateMultipartUploadCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 key,

 ContentType:
 getContentType(
 name
 ),

 CacheControl:
 "private, no-cache",

 Metadata: {

 "original-name":
 String(
 name
 ),

 "relative-path":
 safePath
 }
 })
 );


 if (
 !result.UploadId
 ) {

 throw new Error(
 "B2 did not return UploadId"
 );
 }


 const metadata = {

 id,

 storage:
 "B2",

 uploadId:
 result.UploadId,

 key,

 name:
 safePath,

 size:
 Number(
 size
 ),

 total:
 Number(
 total
 ),

 chunkSize:
 CHUNK_SIZE,

 createdAt:
 new Date()
 .toISOString()
 };


 await writeMetadata(
 metaKey,
 metadata
 );


 return metadata;

 })();


 uploadCreationLocks.set(
 id,
 promise
 );


 try {

 return await promise;

 } finally {

 uploadCreationLocks.delete(
 id
 );
 }
}


/* =========================================================
CREATE IDRIVE E2 MULTIPART UPLOAD
========================================================= */

async function getOrCreateIDriveE2Upload(
 options
) {

 const {
 id,
 name,
 relativePath,
 size,
 total
 } = options;


 if (
 !idriveConfigured()
 ) {

 const error =
 new Error(
 "IDrive E2 is not configured."
 );

 error.statusCode =
 503;

 throw error;
 }


 const metaKey =
 metadataKey(
 id
 );


 try {

 const existing =
 await readMetadata(
 metaKey
 );

 if (
 existing?.uploadId &&
 existing?.key &&
 existing?.storage ===
 "IDRIVE_E2"
 ) {

 return existing;
 }

 } catch (_) {}


 if (
 uploadCreationLocks.has(
 id
 )
 ) {

 return uploadCreationLocks.get(
 id
 );
 }


 const promise =
 (async function() {

 try {

 const existing =
 await readMetadata(
 metaKey
 );

 if (
 existing?.uploadId &&
 existing?.key &&
 existing?.storage ===
 "IDRIVE_E2"
 ) {

 return existing;
 }

 } catch (_) {}


 const routing =
 await chooseUploadStorage(
 size
 );


 if (
 routing.storage !==
 "IDRIVE_E2"
 ) {

 throw new Error(
 "Upload must be routed to another storage."
 );
 }


 const safePath =
 cleanPath(
 relativePath
 ) ||
 cleanPath(
 name
 );


 if (!safePath) {

 throw new Error(
 "Invalid file name"
 );
 }


 const key =
 fileKey(
 safePath
 );


 const result =
 await idriveStorage.send(
 new CreateMultipartUploadCommand({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Key:
 key,

 ContentType:
 getContentType(
 name
 ),

 CacheControl:
 "private, no-cache",

 Metadata: {

 "original-name":
 String(
 name
 ),

 "relative-path":
 safePath
 }
 })
 );


 if (
 !result.UploadId
 ) {

 throw new Error(
 "IDrive E2 did not return UploadId"
 );
 }


 const metadata = {

 id,

 storage:
 "IDRIVE_E2",

 uploadId:
 result.UploadId,

 key,

 name:
 safePath,

 size:
 Number(
 size
 ),

 total:
 Number(
 total
 ),

 chunkSize:
 CHUNK_SIZE,

 createdAt:
 new Date()
 .toISOString()
 };


 await writeMetadata(
 metaKey,
 metadata
 );


 return metadata;

 })();


 uploadCreationLocks.set(
 id,
 promise
 );


 try {

 return await promise;

 } finally {

 uploadCreationLocks.delete(
 id
 );
 }
}


/* =========================================================
CREATE FILEBASE MULTIPART UPLOAD
========================================================= */

async function getOrCreateFilebaseUpload(
 options
) {

 const {
 id,
 name,
 relativePath,
 size,
 total
 } = options;


 if (
 !filebaseConfigured()
 ) {

 const error =
 new Error(
 "Filebase is not configured."
 );

 error.statusCode =
 503;

 throw error;
 }


 const metaKey =
 metadataKey(
 id
 );


 try {

 const existing =
 await readMetadata(
 metaKey
 );

 if (
 existing?.uploadId &&
 existing?.key &&
 existing?.storage ===
 "FILEBASE"
 ) {

 return existing;
 }

 } catch (_) {}


 if (
 uploadCreationLocks.has(
 id
 )
 ) {

 return uploadCreationLocks.get(
 id
 );
 }


 const promise =
 (async function() {

 try {

 const existing =
 await readMetadata(
 metaKey
 );

 if (
 existing?.uploadId &&
 existing?.key &&
 existing?.storage ===
 "FILEBASE"
 ) {

 return existing;
 }

 } catch (_) {}


 const routing =
 await chooseUploadStorage(
 size
 );


 if (
 routing.storage !==
 "FILEBASE"
 ) {

 throw new Error(
 "Upload must be routed to another storage."
 );
 }


 const safePath =
 cleanPath(
 relativePath
 ) ||
 cleanPath(
 name
 );


 if (!safePath) {

 throw new Error(
 "Invalid file name"
 );
 }


 const key =
 fileKey(
 safePath
 );


 const result =
 await filebaseStorage.send(
 new CreateMultipartUploadCommand({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Key:
 key,

 ContentType:
 getContentType(
 name
 ),

 CacheControl:
 "private, no-cache",

 Metadata: {

 "original-name":
 String(
 name
 ),

 "relative-path":
 safePath
 }
 })
 );


 if (
 !result.UploadId
 ) {

 throw new Error(
 "Filebase did not return UploadId"
 );
 }


 const metadata = {

 id,

 storage:
 "FILEBASE",

 uploadId:
 result.UploadId,

 key,

 name:
 safePath,

 size:
 Number(
 size
 ),

 total:
 Number(
 total
 ),

 chunkSize:
 CHUNK_SIZE,

 createdAt:
 new Date()
 .toISOString()
 };


 await writeMetadata(
 metaKey,
 metadata
 );


 return metadata;

 })();


 uploadCreationLocks.set(
 id,
 promise
 );


 try {

 return await promise;

 } finally {

 uploadCreationLocks.delete(
 id
 );
 }
}


/* =========================================================
CREATE KOOFR MULTIPART UPLOAD
========================================================= */

async function getOrCreateKoofrUpload(
 options
) {

 const {
 id,
 name,
 relativePath,
 size,
 total
 } = options;


 if (
 !koofrConfigured()
 ) {

 const error =
 new Error(
 "Koofr is not configured."
 );

 error.statusCode =
 503;

 throw error;
 }


 const metaKey =
 metadataKey(
 id
 );


 try {

 const existing =
 await readMetadata(
 metaKey
 );

 if (
 existing?.uploadId &&
 existing?.key &&
 existing?.storage ===
 "KOOFR"
 ) {

 return existing;
 }

 } catch (_) {}


 if (
 uploadCreationLocks.has(
 id
 )
 ) {

 return uploadCreationLocks.get(
 id
 );
 }


 const promise =
 (async function() {

 try {

 const existing =
 await readMetadata(
 metaKey
 );

 if (
 existing?.uploadId &&
 existing?.key &&
 existing?.storage ===
 "KOOFR"
 ) {

 return existing;
 }

 } catch (_) {}


 const routing =
 await chooseUploadStorage(
 size
 );


 if (
 routing.storage !==
 "KOOFR"
 ) {

 throw new Error(
 "Upload must be routed to another storage."
 );
 }


 const safePath =
 cleanPath(
 relativePath
 ) ||
 cleanPath(
 name
 );


 if (!safePath) {

 throw new Error(
 "Invalid file name"
 );
 }


 const key =
 fileKey(
 safePath
 );


 const result =
 await koofrStorage.send(
 new CreateMultipartUploadCommand({

 Bucket:
 KOOFR_BUCKET_NAME,

 Key:
 key,

 ContentType:
 getContentType(
 name
 ),

 CacheControl:
 "private, no-cache",

 Metadata: {

 "original-name":
 String(
 name
 ),

 "relative-path":
 safePath
 }
 })
 );


 if (
 !result.UploadId
 ) {

 throw new Error(
 "Koofr did not return UploadId"
 );
 }


 const metadata = {

 id,

 storage:
 "KOOFR",

 uploadId:
 result.UploadId,

 key,

 name:
 safePath,

 size:
 Number(
 size
 ),

 total:
 Number(
 total
 ),

 chunkSize:
 CHUNK_SIZE,

 createdAt:
 new Date()
 .toISOString()
 };


 await writeMetadata(
 metaKey,
 metadata
 );


 return metadata;

 })();


 uploadCreationLocks.set(
 id,
 promise
 );


 try {

 return await promise;

 } finally {

 uploadCreationLocks.delete(
 id
 );
 }
}


/* =========================================================
B2 FINALIZE
========================================================= */

async function finishB2UploadIfReady(
 metadata
) {

 const id =
 metadata.id;


 if (
 finalizeLocks.has(
 id
 )
 ) {

 return finalizeLocks.get(
 id
 );
 }


 const promise =
 (async function() {

 let parts = [];

 let marker;


 while (true) {

 const response =
 await storage.send(
 new ListPartsCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId,

 PartNumberMarker:
 marker
 })
 );


 if (
 response.Parts
 ) {

 parts.push(
 ...response.Parts
 );
 }


 if (
 !response.IsTruncated
 ) {

 break;
 }


 marker =
 response.NextPartNumberMarker;
 }


 if (
 parts.length <
 Number(
 metadata.total
 )
 ) {

 return false;
 }


 parts.sort(
 (
 a,
 b
 ) =>
 Number(
 a.PartNumber
 ) -
 Number(
 b.PartNumber
 )
 );


 for (
 let i = 0;
 i < metadata.total;
 i++
 ) {

 if (
 !parts[i] ||
 Number(
 parts[i].PartNumber
 ) !==
 i + 1
 ) {

 return false;
 }
 }


 try {

 await storage.send(
 new CompleteMultipartUploadCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId,

 MultipartUpload: {

 Parts:
 parts.map(
 part => ({

 PartNumber:
 Number(
 part.PartNumber
 ),

 ETag:
 part.ETag
 })
 )
 }
 })
 );

 } catch (error) {

 try {

 await storage.send(
 new HeadObjectCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 metadata.key
 })
 );

 } catch (_) {

 throw error;
 }
 }


 await deleteMetadata(
 id
 );


 return true;

 })();


 finalizeLocks.set(
 id,
 promise
 );


 try {

 return await promise;

 } finally {

 finalizeLocks.delete(
 id
 );
 }
}


/* =========================================================
IDRIVE E2 FINALIZE
========================================================= */

async function finishIDriveE2UploadIfReady(
 metadata
) {

 const id =
 metadata.id;


 if (
 finalizeLocks.has(
 id
 )
 ) {

 return finalizeLocks.get(
 id
 );
 }


 const promise =
 (async function() {

 let parts = [];

 let marker;


 while (true) {

 const response =
 await idriveStorage.send(
 new ListPartsCommand({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId,

 PartNumberMarker:
 marker
 })
 );


 if (
 response.Parts
 ) {

 parts.push(
 ...response.Parts
 );
 }


 if (
 !response.IsTruncated
 ) {

 break;
 }


 marker =
 response.NextPartNumberMarker;
 }


 if (
 parts.length <
 Number(
 metadata.total
 )
 ) {

 return false;
 }


 parts.sort(
 (
 a,
 b
 ) =>
 Number(
 a.PartNumber
 ) -
 Number(
 b.PartNumber
 )
 );


 for (
 let i = 0;
 i < metadata.total;
 i++
 ) {

 if (
 !parts[i] ||
 Number(
 parts[i].PartNumber
 ) !==
 i + 1
 ) {

 return false;
 }
 }


 try {

 await idriveStorage.send(
 new CompleteMultipartUploadCommand({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId,

 MultipartUpload: {

 Parts:
 parts.map(
 part => ({

 PartNumber:
 Number(
 part.PartNumber
 ),

 ETag:
 part.ETag
 })
 )
 }
 })
 );

 } catch (error) {

 try {

 await idriveStorage.send(
 new HeadObjectCommand({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Key:
 metadata.key
 })
 );

 } catch (_) {

 throw error;
 }
 }


 await deleteMetadata(
 id
 );


 return true;

 })();


 finalizeLocks.set(
 id,
 promise
 );


 try {

 return await promise;

 } finally {

 finalizeLocks.delete(
 id
 );
 }
}


/* =========================================================
FILEBASE FINALIZE
========================================================= */

async function finishFilebaseUploadIfReady(
 metadata
) {

 const id =
 metadata.id;


 if (
 finalizeLocks.has(
 id
 )
 ) {

 return finalizeLocks.get(
 id
 );
 }


 const promise =
 (async function() {

 let parts = [];

 let marker;


 while (true) {

 const response =
 await filebaseStorage.send(
 new ListPartsCommand({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId,

 PartNumberMarker:
 marker
 })
 );


 if (
 response.Parts
 ) {

 parts.push(
 ...response.Parts
 );
 }


 if (
 !response.IsTruncated
 ) {

 break;
 }


 marker =
 response.NextPartNumberMarker;
 }


 if (
 parts.length <
 Number(
 metadata.total
 )
 ) {

 return false;
 }


 parts.sort(
 (
 a,
 b
 ) =>
 Number(
 a.PartNumber
 ) -
 Number(
 b.PartNumber
 )
 );


 for (
 let i = 0;
 i < metadata.total;
 i++
 ) {

 if (
 !parts[i] ||
 Number(
 parts[i].PartNumber
 ) !==
 i + 1
 ) {

 return false;
 }
 }


 try {

 await filebaseStorage.send(
 new CompleteMultipartUploadCommand({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId,

 MultipartUpload: {

 Parts:
 parts.map(
 part => ({

 PartNumber:
 Number(
 part.PartNumber
 ),

 ETag:
 part.ETag
 })
 )
 }
 })
 );

 } catch (error) {

 try {

 await filebaseStorage.send(
 new HeadObjectCommand({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Key:
 metadata.key
 })
 );

 } catch (_) {

 throw error;
 }
 }


 await deleteMetadata(
 id
 );


 return true;

 })();


 finalizeLocks.set(
 id,
 promise
 );


 try {

 return await promise;

 } finally {

 finalizeLocks.delete(
 id
 );
 }
}


/* =========================================================
KOOFR FINALIZE
========================================================= */

async function finishKoofrUploadIfReady(
 metadata
) {

 const id =
 metadata.id;


 if (
 finalizeLocks.has(
 id
 )
 ) {

 return finalizeLocks.get(
 id
 );
 }


 const promise =
 (async function() {

 let parts = [];

 let marker;


 while (true) {

 const response =
 await koofrStorage.send(
 new ListPartsCommand({

 Bucket:
 KOOFR_BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId,

 PartNumberMarker:
 marker
 })
 );


 if (
 response.Parts
 ) {

 parts.push(
 ...response.Parts
 );
 }


 if (
 !response.IsTruncated
 ) {

 break;
 }


 marker =
 response.NextPartNumberMarker;
 }


 if (
 parts.length <
 Number(
 metadata.total
 )
 ) {

 return false;
 }


 parts.sort(
 (
 a,
 b
 ) =>
 Number(
 a.PartNumber
 ) -
 Number(
 b.PartNumber
 )
 );


 for (
 let i = 0;
 i < metadata.total;
 i++
 ) {

 if (
 !parts[i] ||
 Number(
 parts[i].PartNumber
 ) !==
 i + 1
 ) {

 return false;
 }
 }


 try {

 await koofrStorage.send(
 new CompleteMultipartUploadCommand({

 Bucket:
 KOOFR_BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId,

 MultipartUpload: {

 Parts:
 parts.map(
 part => ({

 PartNumber:
 Number(
 part.PartNumber
 ),

 ETag:
 part.ETag
 })
 )
 }
 })
 );

 } catch (error) {

 try {

 await koofrStorage.send(
 new HeadObjectCommand({

 Bucket:
 KOOFR_BUCKET_NAME,

 Key:
 metadata.key
 })
 );

 } catch (_) {

 throw error;
 }
 }


 await deleteMetadata(
 id
 );


 return true;

 })();


 finalizeLocks.set(
 id,
 promise
 );


 try {

 return await promise;

 } finally {

 finalizeLocks.delete(
 id
 );
 }
}


/* =========================================================
MEGA UPLOAD STREAM CREATION
========================================================= */

async function createMegaUpload(
 options
) {

 const {
 id,
 name,
 relativePath,
 size
 } = options;


 const mega =
 await ensureMegaStorage();


 const folder =
 await ensureMegaFolder();


 const internalName =
 createMegaInternalName(
 relativePath,
 id
 );


 const uploadStream =
 folder.upload({

 name:
 internalName,

 size:
 Number(
 size
 ),

 maxConnections:
 4,

 initialChunkSize:
 128 *
 1024,

 chunkSizeIncrement:
 128 *
 1024,

 maxChunkSize:
 1024 *
 1024
 });


 const state = {

 id,

 storage:
 "MEGA",

 name:
 cleanPath(
 relativePath
 ),

 size:
 Number(
 size
 ),

 internalName,

 uploadStream,

 complete:
 uploadStream.complete,

 uploadedBytes:
 0,

 completed:
 false,

 error:
 null,

 createdAt:
 Date.now()
 };


 megaUploads.set(
 id,
 state
 );


 uploadStream.on(
 "error",
 error => {

 state.error =
 error;

 megaUploads.delete(
 id
 );

 console.error(
 "MEGA UPLOAD STREAM ERROR:",
 error
 );
 }
 );


 uploadStream.on(
 "complete",
 file => {

 state.completed =
 true;

 state.file =
 file;

 megaUploads.delete(
 id
 );

 console.log(
 "MEGA upload complete:",
 state.name
 );
 }
 );


 return state;
}


/* =========================================================
WRITE REQUEST INTO MEGA STREAM
========================================================= */

async function pipeRequestToMega(
 req,
 state,
 expectedSize
) {

 let received =
 0;


 for await (
 const chunk
 of req
 ) {

 const buffer =
 Buffer.isBuffer(
 chunk
 )
 ? chunk
 : Buffer.from(
 chunk
 );


 received +=
 buffer.length;


 if (
 received >
 expectedSize
 ) {

 state.uploadStream.destroy(
 new Error(
 "Received more data than expected"
 )
 );

 throw new Error(
 "Chunk size exceeded expected size"
 );
 }


 const canContinue =
 state.uploadStream.write(
 buffer
 );


 if (
 !canContinue
 ) {

 await once(
 state.uploadStream,
 "drain"
 );
 }
 }


 if (
 received !==
 expectedSize
 ) {

 throw new Error(
 `Chunk size mismatch. Expected ${expectedSize}, received ${received}`
 );
 }


 return received;
}


/* =========================================================
MEGA FINALIZE
========================================================= */

async function finishMegaUpload(
 state
) {

 if (
 state.completed &&
 state.file
 ) {

 return state.file;
 }


 if (
 state.error
 ) {

 throw state.error;
 }


 state.uploadStream.end();


 const file =
 await state.complete;


 state.completed =
 true;

 state.file =
 file;


 megaUploads.delete(
 state.id
 );


 return file;
}


/* =========================================================
CLOUDINARY UPLOAD STATE & BUFFERS
========================================================= */

const cloudinaryUploads = new Map();


async function uploadBufferToCloudinary(buffer, relativePath) {
 if (!cloudinaryConfigured()) {
 throw new Error("Cloudinary is not configured.");
 }

 const safePath = cleanPath(relativePath);
 const publicId = "my_personal_cloud/" + safePath.replace(/\.[^/.]+$/, "");

 return new Promise((resolve, reject) => {
 const uploadStream = cloudinary.uploader.upload_stream(
 {
 public_id: publicId,
 resource_type: "auto",
 overwrite: true
 },
 (error, result) => {
 if (error) {
 return reject(error);
 }
 resolve(result);
 }
 );
 uploadStream.end(buffer);
 });
}


/* =========================================================
UPLOAD CHUNK
========================================================= */

app.post(
 "/api/upload-chunk",
 requireAuth,
 async function(
 req,
 res
 ) {

 try {

 const id =
 String(
 req.query.id ||
 ""
 );

 const index =
 Number(
 req.query.index
 );

 const total =
 Number(
 req.query.total
 );

 const size =
 Number(
 req.query.size
 );

 const name =
 String(
 req.query.name ||
 "file"
 );

 const relativePath =
 String(
 req.query.relativePath ||
 name
 );


 if (
 !/^[a-z0-9-]{8,100}$/i.test(
 id
 )
 ) {

 return res
 .status(
 400
 )
 .json({
 error:
 "Invalid upload ID"
 });
 }


 if (
 !Number.isInteger(
 index
 ) ||
 !Number.isInteger(
 total
 ) ||
 total < 1 ||
 index < 0 ||
 index >= total
 ) {

 return res
 .status(
 400
 )
 .json({
 error:
 "Invalid chunk information"
 });
 }


 if (
 !Number.isSafeInteger(
 size
 ) ||
 size <= 0 ||
 size >
 MAX_FILE_SIZE
 ) {

 return res
 .status(
 413
 )
 .json({

 error:
 "File exceeds server limit",

 maxFileSize:
 formatBytes(
 MAX_FILE_SIZE
 )
 });
 }


 if (
 total >
 MAX_PARTS
 ) {

 return res
 .status(
 413
 )
 .json({
 error:
 "Too many chunks"
 });
 }


 const expectedSize =
 Math.min(
 CHUNK_SIZE,
 size -
 index *
 CHUNK_SIZE
 );


 if (
 expectedSize <= 0
 ) {

 return res
 .status(
 400
 )
 .json({
 error:
 "Invalid chunk"
 });
 }


 if (
 req.headers[
 "content-length"
 ]
 ) {

 const received =
 Number(
 req.headers[
 "content-length"
 ]
 );


 if (
 Number.isFinite(
 received
 ) &&
 received !==
 expectedSize
 ) {

 return res
 .status(
 400
 )
 .json({

 error:
 "Chunk size mismatch",

 expected:
 expectedSize,

 received
 });
 }
 }


 /*
 ------------------------------------------------
 STORAGE ROUTE
 Sequence: B2 -> MEGA -> IDrive E2 -> Cloudinary -> Filebase -> Koofr
 ------------------------------------------------
 */

 let route =
 null;


 const existingMega =
 megaUploads.get(
 id
 );

 const existingCloudinary =
 cloudinaryUploads.get(
 id
 );


 if (
 existingMega
 ) {

 route =
 "MEGA";

 } else if (
 existingCloudinary
 ) {

 route =
 "CLOUDINARY";

 } else {

 const existingMetadata =
 await readUploadMetadataSafely(
 id
 );


 if (
 existingMetadata?.storage ===
 "B2"
 ) {

 route =
 "B2";

 } else if (
 existingMetadata?.storage ===
 "IDRIVE_E2"
 ) {

 route =
 "IDRIVE_E2";

 } else if (
 existingMetadata?.storage ===
 "MEGA"
 ) {

 route =
 "MEGA";

 } else if (
 existingMetadata?.storage ===
 "CLOUDINARY"
 ) {

 route =
 "CLOUDINARY";

 } else if (
 existingMetadata?.storage ===
 "FILEBASE"
 ) {

 route =
 "FILEBASE";

 } else if (
 existingMetadata?.storage ===
 "KOOFR"
 ) {

 route =
 "KOOFR";

 } else {

 const selected =
 await chooseUploadStorage(
 size
 );

 route =
 selected.storage;
 }
 }


 /* =============================================
 B2
 ============================================= */

 if (
 route ===
 "B2"
 ) {

 const metadata =
 await getOrCreateB2Upload({

 id,

 name,

 relativePath,

 size,

 total
 });


 const result =
 await storage.send(
 new UploadPartCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId,

 PartNumber:
 index + 1,

 Body:
 req,

 ContentLength:
 expectedSize
 })
 );


 const done =
 await finishB2UploadIfReady(
 metadata
 );


 return res.json({

 ok:
 true,

 storage:
 "B2",

 done,

 part:
 index + 1,

 total,

 etag:
 result.ETag ||
 null,

 name:
 metadata.name
 });
 }


 /* =============================================
 MEGA
 ============================================= */

 if (
 route ===
 "MEGA"
 ) {

 let state =
 megaUploads.get(
 id
 );


 if (
 !state
 ) {

 const selected =
 await chooseUploadStorage(
 size
 );


 if (
 selected.storage !==
 "MEGA"
 ) {

 throw new Error(
 "Upload routing changed unexpectedly."
 );
 }


 state =
 await createMegaUpload({

 id,

 name,

 relativePath,

 size
 });
 }


 await pipeRequestToMega(
 req,
 state,
 expectedSize
 );


 state.uploadedBytes +=
 expectedSize;


 const isLast =
 index ===
 total - 1;


 if (
 isLast
 ) {

 const file =
 await finishMegaUpload(
 state
 );


 return res.json({

 ok:
 true,

 storage:
 "MEGA",

 done:
 true,

 part:
 index + 1,

 total,

 etag:
 null,

 name:
 cleanPath(
 relativePath
 ),

 megaNodeId:
 file?.nodeId ||
 null
 });
 }


 return res.json({

 ok:
 true,

 storage:
 "MEGA",

 done:
 false,

 part:
 index + 1,

 total,

 etag:
 null,

 name:
 cleanPath(
 relativePath
 )
 });
 }


 /* =============================================
 IDRIVE E2
 ============================================= */

 if (
 route ===
 "IDRIVE_E2"
 ) {

 const metadata =
 await getOrCreateIDriveE2Upload({

 id,

 name,

 relativePath,

 size,

 total
 });


 const result =
 await idriveStorage.send(
 new UploadPartCommand({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId,

 PartNumber:
 index + 1,

 Body:
 req,

 ContentLength:
 expectedSize
 })
 );


 const done =
 await finishIDriveE2UploadIfReady(
 metadata
 );


 return res.json({

 ok:
 true,

 storage:
 "IDRIVE_E2",

 storageLabel:
 "IDrive E2",

 done,

 part:
 index + 1,

 total,

 etag:
 result.ETag ||
 null,

 name:
 metadata.name
 });
 }


 /* =============================================
 CLOUDINARY
 ============================================= */

 if (
 route ===
 "CLOUDINARY"
 ) {

 let state = cloudinaryUploads.get(id);
 if (!state) {
 state = {
 id,
 name: cleanPath(relativePath || name),
 size: Number(size),
 total: Number(total),
 buffers: new Array(total)
 };
 cloudinaryUploads.set(id, state);
 }

 const chunks = [];
 for await (const chunk of req) {
 chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
 }
 const partBuffer = Buffer.concat(chunks);
 state.buffers[index] = partBuffer;

 const isLast = index === total - 1;

 if (isLast) {
 const completeBuffer = Buffer.concat(state.buffers);
 cloudinaryUploads.delete(id);

 await uploadBufferToCloudinary(completeBuffer, relativePath || name);

 return res.json({
 ok: true,
 storage: "CLOUDINARY",
 done: true,
 part: index + 1,
 total,
 name: cleanPath(relativePath || name)
 });
 }

 return res.json({
 ok: true,
 storage: "CLOUDINARY",
 done: false,
 part: index + 1,
 total,
 name: cleanPath(relativePath || name)
 });
 }


 /* =============================================
 FILEBASE
 ============================================= */

 if (
 route ===
 "FILEBASE"
 ) {

 const metadata =
 await getOrCreateFilebaseUpload({

 id,

 name,

 relativePath,

 size,

 total
 });


 const result =
 await filebaseStorage.send(
 new UploadPartCommand({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId,

 PartNumber:
 index + 1,

 Body:
 req,

 ContentLength:
 expectedSize
 })
 );


 const done =
 await finishFilebaseUploadIfReady(
 metadata
 );


 return res.json({

 ok:
 true,

 storage:
 "FILEBASE",

 storageLabel:
 "Filebase",

 done,

 part:
 index + 1,

 total,

 etag:
 result.ETag ||
 null,

 name:
 metadata.name
 });
 }


 /* =============================================
 KOOFR
 ============================================= */

 if (
 route ===
 "KOOFR"
 ) {

 const metadata =
 await getOrCreateKoofrUpload({

 id,

 name,

 relativePath,

 size,

 total
 });


 const result =
 await koofrStorage.send(
 new UploadPartCommand({

 Bucket:
 KOOFR_BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId,

 PartNumber:
 index + 1,

 Body:
 req,

 ContentLength:
 expectedSize
 })
 );


 const done =
 await finishKoofrUploadIfReady(
 metadata
 );


 return res.json({

 ok:
 true,

 storage:
 "KOOFR",

 storageLabel:
 "Koofr",

 done,

 part:
 index + 1,

 total,

 etag:
 result.ETag ||
 null,

 name:
 metadata.name
 });
 }


 throw new Error(
 "Unknown storage route"
 );

 } catch (error) {

 console.error(
 "UPLOAD ERROR:",
 error
 );


 return res
 .status(
 error.statusCode ||
 error?.$metadata
 ?.httpStatusCode ||
 500
 )
 .json({

 error:
 error.message ||
 "Upload failed"
 });
 }
 }
);


/* =========================================================
SAFE UPLOAD METADATA READ
========================================================= */

async function readUploadMetadataSafely(
 id
) {

 try {

 return await readMetadata(
 metadataKey(
 id
 )
 );

 } catch (_) {

 return null;
 }
}


/* =========================================================
B2 FILE LIST
========================================================= */

async function listB2Files() {

 const files = [];

 let token;


 do {

 const result =
 await storage.send(
 new ListObjectsV2Command({

 Bucket:
 BUCKET_NAME,

 Prefix:
 FILE_PREFIX,

 ContinuationToken:
 token,

 MaxKeys:
 1000
 })
 );


 for (
 const object
 of result.Contents || []
 ) {

 if (
 !object.Key ||
 object.Key.endsWith(
 "/"
 )
 ) {

 continue;
 }


 const name =
 object.Key.substring(
 FILE_PREFIX.length
 );


 const size =
 Number(
 object.Size ||
 0
 );


 files.push({

 name,

 size,

 sizeText:
 formatBytes(
 size
 ),

 modified:
 object.LastModified ||
 null,

 type:
 getContentType(
 name
 ),

 storage:
 "B2",

 storageLabel:
 "Backblaze B2"
 });
 }


 token =
 result.IsTruncated
 ? result.NextContinuationToken
 : undefined;

 } while (
 token
 );


 return files;
}


/* =========================================================
IDRIVE E2 FILE LIST
========================================================= */

async function listIDriveE2Files() {

 if (
 !idriveConfigured()
 ) {

 return [];
 }


 const files = [];

 let token;


 do {

 const result =
 await idriveStorage.send(
 new ListObjectsV2Command({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Prefix:
 FILE_PREFIX,

 ContinuationToken:
 token,

 MaxKeys:
 1000
 })
 );


 for (
 const object
 of result.Contents || []
 ) {

 if (
 !object.Key ||
 object.Key.endsWith(
 "/"
 )
 ) {

 continue;
 }


 const name =
 object.Key.substring(
 FILE_PREFIX.length
 );


 const size =
 Number(
 object.Size ||
 0
 );


 files.push({

 name,

 size,

 sizeText:
 formatBytes(
 size
 ),

 modified:
 object.LastModified ||
 null,

 type:
 getContentType(
 name
 ),

 storage:
 "IDRIVE_E2",

 storageLabel:
 "IDrive E2"
 });
 }


 token =
 result.IsTruncated
 ? result.NextContinuationToken
 : undefined;

 } while (
 token
 );


 return files;
}


/* =========================================================
FILEBASE FILE LIST
========================================================= */

async function listFilebaseFiles() {

 if (
 !filebaseConfigured()
 ) {

 return [];
 }


 const files = [];

 let token;


 do {

 const result =
 await filebaseStorage.send(
 new ListObjectsV2Command({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Prefix:
 FILE_PREFIX,

 ContinuationToken:
 token,

 MaxKeys:
 1000
 })
 );


 for (
 const object
 of result.Contents || []
 ) {

 if (
 !object.Key ||
 object.Key.endsWith(
 "/"
 )
 ) {

 continue;
 }


 const name =
 object.Key.substring(
 FILE_PREFIX.length
 );


 const size =
 Number(
 object.Size ||
 0
 );


 files.push({

 name,

 size,

 sizeText:
 formatBytes(
 size
 ),

 modified:
 object.LastModified ||
 null,

 type:
 getContentType(
 name
 ),

 storage:
 "FILEBASE",

 storageLabel:
 "Filebase"
 });
 }


 token =
 result.IsTruncated
 ? result.NextContinuationToken
 : undefined;

 } while (
 token
 );


 return files;
}


/* =========================================================
KOOFR FILE LIST
========================================================= */

async function listKoofrFiles() {

 if (
 !koofrConfigured()
 ) {

 return [];
 }


 const files = [];

 let token;


 do {

 const result =
 await koofrStorage.send(
 new ListObjectsV2Command({

 Bucket:
 KOOFR_BUCKET_NAME,

 Prefix:
 FILE_PREFIX,

 ContinuationToken:
 token,

 MaxKeys:
 1000
 })
 );


 for (
 const object
 of result.Contents || []
 ) {

 if (
 !object.Key ||
 object.Key.endsWith(
 "/"
 )
 ) {

 continue;
 }


 const name =
 object.Key.substring(
 FILE_PREFIX.length
 );


 const size =
 Number(
 object.Size ||
 0
 );


 files.push({

 name,

 size,

 sizeText:
 formatBytes(
 size
 ),

 modified:
 object.LastModified ||
 null,

 type:
 getContentType(
 name
 ),

 storage:
 "KOOFR",

 storageLabel:
 "Koofr"
 });
 }


 token =
 result.IsTruncated
 ? result.NextContinuationToken
 : undefined;

 } while (
 token
 );


 return files;
}


/* =========================================================
STORAGE API
========================================================= */

app.get(
 "/api/storage",
 requireAuth,
 async function(
 req,
 res
 ) {

 try {

 const b2 =
 await getB2StorageUsage();


 let megaFilesUsed = 0;
 let megaConnected = false;
 let megaError = megaLastError;
 if (megaConfigured()) {
 try {
   await ensureMegaStorage();
   const megaFiles = await listMegaFiles();
   for (const f of megaFiles) {
    megaFilesUsed += Number(f.size || 0);
   }
   megaConnected = true;
   megaError = null;
 } catch (error) {
   megaConnected = false;
   megaError = error?.message || String(error);
   console.error("MEGA STORAGE ERROR:", error);
 }
 }


 let idrive = {

 configured:
 idriveConfigured(),

 connected:
 false,

 totalBytes:
 0,

 fileCount:
 0,

 limitBytes:
 IDRIVE_E2_STORAGE_LIMIT_BYTES,

 routingLimitBytes:
 IDRIVE_E2_ROUTING_LIMIT_BYTES,

 warningLimitBytes:
 IDRIVE_E2_WARNING_LIMIT_BYTES,

 remainingBytes:
 IDRIVE_E2_STORAGE_LIMIT_BYTES,

 routingRemainingBytes:
 IDRIVE_E2_ROUTING_LIMIT_BYTES,

 warning:
 false,

 warningMessage:
 null,

 error:
 null
 };


 if (
 idriveConfigured()
 ) {

 try {

 const usage =
 await getIDriveE2StorageUsage();


 idrive =
 {

 ...idrive,

 configured:
 true,

 connected:
 true,

 ...usage,

 usedText:
 formatBytes(
 usage.totalBytes
 ),

 limitText:
 formatBytes(
 usage.limitBytes
 ),

 remainingText:
 formatBytes(
 usage.remainingBytes
 ),

 routingLimitText:
 formatBytes(
 usage.routingLimitBytes
 ),

 warningLimitText:
 formatBytes(
 usage.warningLimitBytes
 )
 };

 } catch (error) {

 idrive.error =
 error.message;

 console.error(
 "IDRIVE E2 STORAGE ERROR:",
 error
 );
 }
 }


 let cloudinaryUsage = {
 totalBytes: 0,
 fileCount: 0,
 limitBytes: CLOUDINARY_STORAGE_LIMIT_BYTES,
 routingLimitBytes: CLOUDINARY_ROUTING_LIMIT_BYTES,
 remainingBytes: CLOUDINARY_STORAGE_LIMIT_BYTES,
 routingRemainingBytes: CLOUDINARY_ROUTING_LIMIT_BYTES
 };

 if (cloudinaryConfigured()) {
 try {
 cloudinaryUsage = await getCloudinaryStorageUsage();
 } catch (error) {
 console.error("CLOUDINARY STORAGE ERROR:", error);
 }
 }


 let filebase = {

 configured:
 filebaseConfigured(),

 connected:
 false,

 totalBytes:
 0,

 fileCount:
 0,

 limitBytes:
 FILEBASE_STORAGE_LIMIT_BYTES,

 routingLimitBytes:
 FILEBASE_ROUTING_LIMIT_BYTES,

 remainingBytes:
 FILEBASE_STORAGE_LIMIT_BYTES,

 routingRemainingBytes:
 FILEBASE_ROUTING_LIMIT_BYTES,

 error:
 null
 };


 if (
 filebaseConfigured()
 ) {

 try {

 const usage =
 await getFilebaseStorageUsage();


 filebase =
 {

 ...filebase,

 configured:
 true,

 connected:
 true,

 ...usage,

 usedText:
 formatBytes(
 usage.totalBytes
 ),

 limitText:
 formatBytes(
 usage.limitBytes
 ),

 remainingText:
 formatBytes(
 usage.remainingBytes
 ),

 routingLimitText:
 formatBytes(
 usage.routingLimitBytes
 )
 };

 } catch (error) {

 filebase.error =
 error.message;

 console.error(
 "FILEBASE STORAGE ERROR:",
 error
 );
 }
 }


 let koofr = {

 configured:
 koofrConfigured(),

 connected:
 false,

 totalBytes:
 0,

 fileCount:
 0,

 limitBytes:
 KOOFR_STORAGE_LIMIT_BYTES,

 routingLimitBytes:
 KOOFR_ROUTING_LIMIT_BYTES,

 remainingBytes:
 KOOFR_STORAGE_LIMIT_BYTES,

 routingRemainingBytes:
 KOOFR_ROUTING_LIMIT_BYTES,

 error:
 null
 };


 if (
 koofrConfigured()
 ) {

 try {

 const usage =
 await getKoofrStorageUsage();


 koofr =
 {

 ...koofr,

 configured:
 true,

 connected:
 true,

 ...usage,

 usedText:
 formatBytes(
 usage.totalBytes
 ),

 limitText:
 formatBytes(
 usage.limitBytes
 ),

 remainingText:
 formatBytes(
 usage.remainingBytes
 ),

 routingLimitText:
 formatBytes(
 usage.routingLimitBytes
 )
 };

 } catch (error) {

 koofr.error =
 error.message;

 console.error(
 "KOOFR STORAGE ERROR:",
 error
 );
 }
 }


 const totalUsed =
 b2.totalBytes +
 megaFilesUsed +
 Number(
 idrive.totalBytes ||
 0
 ) +
 cloudinaryUsage.totalBytes +
 Number(
 filebase.totalBytes ||
 0
 ) +
 Number(
 koofr.totalBytes ||
 0
 );

 // Only count storage that is actually configured. This prevents an
 // unconfigured provider from appearing as usable/free capacity in the UI.
 const totalLimit =
 B2_DISPLAY_CAPACITY_BYTES +
 (megaConfigured() ? MEGA_STORAGE_LIMIT_BYTES : 0) +
 (idrive.configured ? IDRIVE_E2_STORAGE_LIMIT_BYTES : 0) +
 (cloudinaryConfigured() ? CLOUDINARY_STORAGE_LIMIT_BYTES : 0) +
 (filebase.configured ? FILEBASE_STORAGE_LIMIT_BYTES : 0) +
 (koofr.configured ? KOOFR_STORAGE_LIMIT_BYTES : 0);


 const remaining =
 Math.max(
 0,
 totalLimit -
 totalUsed
 );


 const usedPercent =
 totalLimit > 0
 ? Math.min(
 100,
 (
 totalUsed /
 totalLimit
 ) *
 100
 )
 : 0;


 return res.json({

 ok:
 true,

 usedBytes:
 totalUsed,

 limitBytes:
 totalLimit,

 remainingBytes:
 remaining,

 usedText:
 formatBytes(
 totalUsed
 ),

 limitText:
 formatBytes(
 totalLimit
 ),

 remainingText:
 formatBytes(
 remaining
 ),

 usedPercent:
 Number(
 usedPercent.toFixed(
 2
 )
 ),


 b2: {

 usedBytes:
 b2.totalBytes,

 usedText:
 formatBytes(
 b2.totalBytes
 ),

 capacityBytes:
 B2_DISPLAY_CAPACITY_BYTES,

 capacityText:
 formatBytes(
 B2_DISPLAY_CAPACITY_BYTES
 ),

 routingLimitBytes:
 B2_ROUTING_LIMIT_BYTES,

 routingLimitText:
 formatBytes(
 B2_ROUTING_LIMIT_BYTES
 ),

 remainingBytes:
 b2.remainingBytes,

 routingRemainingBytes:
 b2.routingRemainingBytes
 },


 mega: {

 configured:
 megaConfigured(),

 connected:
 megaConnected,

 error:
 megaError,

 usedBytes:
 megaFilesUsed,

 usedText:
 formatBytes(
 megaFilesUsed
 ),

 capacityBytes:
 MEGA_STORAGE_LIMIT_BYTES,

 capacityText:
 formatBytes(
 MEGA_STORAGE_LIMIT_BYTES
 ),

 routingLimitBytes:
 MEGA_ROUTING_LIMIT_BYTES,

 routingLimitText:
 formatBytes(
 MEGA_ROUTING_LIMIT_BYTES
 )
 },


 idriveE2: {

 configured:
 idrive.configured,

 connected:
 idrive.connected,

 usedBytes:
 idrive.totalBytes,

 usedText:
 formatBytes(
 idrive.totalBytes
 ),

 capacityBytes:
 IDRIVE_E2_STORAGE_LIMIT_BYTES,

 capacityText:
 formatBytes(
 IDRIVE_E2_STORAGE_LIMIT_BYTES
 ),

 routingLimitBytes:
 IDRIVE_E2_ROUTING_LIMIT_BYTES,

 routingLimitText:
 formatBytes(
 IDRIVE_E2_ROUTING_LIMIT_BYTES
 ),

 warningLimitBytes:
 IDRIVE_E2_WARNING_LIMIT_BYTES,

 warningLimitText:
 formatBytes(
 IDRIVE_E2_WARNING_LIMIT_BYTES
 ),

 remainingBytes:
 idrive.remainingBytes,

 remainingText:
 formatBytes(
 idrive.remainingBytes
 ),

 routingRemainingBytes:
 idrive.routingRemainingBytes,

 warning:
 idrive.warning,

 warningMessage:
 idrive.warningMessage,

 error:
 idrive.error
 },


 cloudinary: {

 configured:
 cloudinaryConfigured(),

 usedBytes:
 cloudinaryUsage.totalBytes,

 usedText:
 formatBytes(
 cloudinaryUsage.totalBytes
 ),

 capacityBytes:
 CLOUDINARY_STORAGE_LIMIT_BYTES,

 capacityText:
 formatBytes(
 CLOUDINARY_STORAGE_LIMIT_BYTES
 ),

 routingLimitBytes:
 CLOUDINARY_ROUTING_LIMIT_BYTES,

 routingLimitText:
 formatBytes(
 CLOUDINARY_ROUTING_LIMIT_BYTES
 ),

 remainingBytes:
 cloudinaryUsage.remainingBytes,

 remainingText:
 formatBytes(
 cloudinaryUsage.remainingBytes
 )
 },


 filebase: {

 configured:
 filebase.configured,

 connected:
 filebase.connected,

 usedBytes:
 filebase.totalBytes,

 usedText:
 formatBytes(
 filebase.totalBytes
 ),

 capacityBytes:
 FILEBASE_STORAGE_LIMIT_BYTES,

 capacityText:
 formatBytes(
 FILEBASE_STORAGE_LIMIT_BYTES
 ),

 routingLimitBytes:
 FILEBASE_ROUTING_LIMIT_BYTES,

 routingLimitText:
 formatBytes(
 FILEBASE_ROUTING_LIMIT_BYTES
 ),

 remainingBytes:
 filebase.remainingBytes,

 remainingText:
 formatBytes(
 filebase.remainingBytes
 ),

 routingRemainingBytes:
 filebase.routingRemainingBytes,

 error:
 filebase.error
 },


 koofr: {

 configured:
 koofr.configured,

 connected:
 koofr.connected,

 usedBytes:
 koofr.totalBytes,

 usedText:
 formatBytes(
 koofr.totalBytes
 ),

 capacityBytes:
 KOOFR_STORAGE_LIMIT_BYTES,

 capacityText:
 formatBytes(
 KOOFR_STORAGE_LIMIT_BYTES
 ),

 routingLimitBytes:
 KOOFR_ROUTING_LIMIT_BYTES,

 routingLimitText:
 formatBytes(
 KOOFR_ROUTING_LIMIT_BYTES
 ),

 remainingBytes:
 koofr.remainingBytes,

 remainingText:
 formatBytes(
 koofr.remainingBytes
 ),

 routingRemainingBytes:
 koofr.routingRemainingBytes,

 error:
 koofr.error
 }
 });

 } catch (error) {

 console.error(
 "STORAGE ERROR:",
 error
 );

 return res
 .status(
 500
 )
 .json({
 error:
 "Could not read storage usage"
 });
 }
 }
);


/* =========================================================
FILES
========================================================= */

app.get(
 "/api/files",
 requireAuth,
 async function(
 req,
 res
 ) {

 try {

 const b2Files =
 await listB2Files();


 let megaFiles =
 [];


 if (
 megaConfigured()
 ) {

 try {

 megaFiles =
 await listMegaFiles();

 } catch (error) {

 console.error(
 "MEGA LIST ERROR:",
 error
 );
 }
 }


 let idriveFiles =
 [];


 if (
 idriveConfigured()
 ) {

 try {

 idriveFiles =
 await listIDriveE2Files();

 } catch (error) {

 console.error(
 "IDRIVE E2 LIST ERROR:",
 error
 );
 }
 }


 let cloudinaryFiles =
 [];


 if (
 cloudinaryConfigured()
 ) {

 try {

 cloudinaryFiles =
 await listCloudinaryFiles();

 } catch (error) {

 console.error(
 "CLOUDINARY LIST ERROR:",
 error
 );
 }
 }


 let filebaseFiles =
 [];


 if (
 filebaseConfigured()
 ) {

 try {

 filebaseFiles =
 await listFilebaseFiles();

 } catch (error) {

 console.error(
 "FILEBASE LIST ERROR:",
 error
 );
 }
 }


 let koofrFiles =
 [];


 if (
 koofrConfigured()
 ) {

 try {

 koofrFiles =
 await listKoofrFiles();

 } catch (error) {

 console.error(
 "KOOFR LIST ERROR:",
 error
 );
 }
 }


 const files =
 [
 ...b2Files,
 ...megaFiles,
 ...idriveFiles,
 ...cloudinaryFiles,
 ...filebaseFiles,
 ...koofrFiles
 ];


 files.sort(
 (
 a,
 b
 ) =>
 new Date(
 b.modified ||
 0
 ) -
 new Date(
 a.modified ||
 0
 )
 );


 return res.json(
 files
 );

 } catch (error) {

 console.error(
 "LIST ERROR:",
 error
 );

 return res
 .status(
 500
 )
 .json({
 error:
 "Could not load files"
 });
 }
 }
);


/* =========================================================
B2 OBJECT SEND
========================================================= */

async function sendB2Object(
 req,
 res,
 relative,
 attachment
) {

 const key =
 fileKey(
 relative
 );


 const head =
 await storage.send(
 new HeadObjectCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 key
 })
 );


 const totalSize =
 Number(
 head.ContentLength ||
 0
 );


 const contentType =
 head.ContentType ||
 getContentType(
 relative
 );


 let range =
 req.headers.range;


 let start =
 0;

 let end =
 totalSize - 1;

 let partial =
 false;


 if (range) {

 const match =
 /^bytes=(\d*)-(\d*)$/
 .exec(
 range
 );


 if (!match) {

 return res
 .status(
 416
 )
 .set(
 "Content-Range",
 `bytes */${totalSize}`
 )
 .end();
 }


 if (
 match[1]
 ) {

 start =
 Number(
 match[1]
 );
 }


 if (
 match[2]
 ) {

 end =
 Number(
 match[2]
 );

 } else {

 end =
 totalSize - 1;
 }


 if (
 !match[1]
 ) {

 const suffix =
 Number(
 match[2]
 );

 start =
 Math.max(
 0,
 totalSize -
 suffix
 );

 end =
 totalSize - 1;
 }


 if (
 start < 0 ||
 start > end ||
 start >= totalSize
 ) {

 return res
 .status(
 416
 )
 .set(
 "Content-Range",
 `bytes */${totalSize}`
 )
 .end();
 }


 end =
 Math.min(
 end,
 totalSize - 1
 );

 partial =
 true;
 }


 const length =
 end -
 start +
 1;


 const command =
 new GetObjectCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 key,

 ...(partial
 ? {

 Range:
 `bytes=${start}-${end}`

 }
 : {})
 });


 const result =
 await storage.send(
 command
 );


 res.setHeader(
 "Content-Type",
 contentType
 );

 res.setHeader(
 "Accept-Ranges",
 "bytes"
 );

 res.setHeader(
 "Content-Length",
 String(
 length
 )
 );

 res.setHeader(
 "Cache-Control",
 "private, no-cache"
 );


 if (partial) {

 res.status(
 206
 );

 res.setHeader(
 "Content-Range",
 `bytes ${start}-${end}/${totalSize}`
 );

 } else {

 res.status(
 200
 );
 }


 const safeName =
 path
 .basename(
 relative
 )
 .replace(
 /"/g,
 ""
 );


 res.setHeader(
 "Content-Disposition",
 attachment
 ? `attachment; filename="${safeName}"`
 : `inline; filename="${safeName}"`
 );


 if (
 result.Body &&
 typeof result.Body.pipe ===
 "function"
 ) {

 result.Body.on(
 "error",
 error => {

 console.error(
 "B2 STREAM ERROR:",
 error
 );

 if (
 !res.headersSent
 ) {

 res.status(
 500
 ).end();

 } else {

 res.destroy();
 }
 }
 );


 return result.Body.pipe(
 res
 );
 }


 const bytes =
 await result.Body
 .transformToByteArray();


 return res.end(
 Buffer.from(
 bytes
 )
 );
}


/* =========================================================
IDRIVE E2 OBJECT SEND
========================================================= */

async function sendIDriveE2Object(
 req,
 res,
 relative,
 attachment
) {

 if (
 !idriveConfigured()
 ) {

 const error =
 new Error(
 "IDrive E2 is not configured."
 );

 error.statusCode =
 503;

 throw error;
 }


 const key =
 fileKey(
 relative
 );


 const head =
 await idriveStorage.send(
 new HeadObjectCommand({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Key:
 key
 })
 );


 const totalSize =
 Number(
 head.ContentLength ||
 0
 );


 const contentType =
 head.ContentType ||
 getContentType(
 relative
 );


 let start =
 0;

 let end =
 totalSize - 1;

 let partial =
 false;


 const range =
 req.headers.range;


 if (range) {

 const match =
 /^bytes=(\d*)-(\d*)$/
 .exec(
 range
 );


 if (!match) {

 return res
 .status(
 416
 )
 .set(
 "Content-Range",
 `bytes */${totalSize}`
 )
 .end();
 }


 if (
 match[1]
 ) {

 start =
 Number(
 match[1]
 );
 }


 if (
 match[2]
 ) {

 end =
 Number(
 match[2]
 );

 } else {

 end =
 totalSize - 1;
 }


 if (
 !match[1]
 ) {

 const suffix =
 Number(
 match[2]
 );

 start =
 Math.max(
 0,
 totalSize -
 suffix
 );

 end =
 totalSize - 1;
 }


 if (
 start < 0 ||
 start > end ||
 start >= totalSize
 ) {

 return res
 .status(
 416
 )
 .set(
 "Content-Range",
 `bytes */${totalSize}`
 )
 .end();
 }


 end =
 Math.min(
 end,
 totalSize - 1
 );

 partial =
 true;
 }


 const length =
 end -
 start +
 1;


 const result =
 await idriveStorage.send(
 new GetObjectCommand({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Key:
 key,

 ...(partial
 ? {

 Range:
 `bytes=${start}-${end}`

 }
 : {})
 })
 );


 res.setHeader(
 "Content-Type",
 contentType
 );

 res.setHeader(
 "Accept-Ranges",
 "bytes"
 );

 res.setHeader(
 "Content-Length",
 String(
 length
 )
 );

 res.setHeader(
 "Cache-Control",
 "private, no-cache"
 );


 if (partial) {

 res.status(
 206
 );

 res.setHeader(
 "Content-Range",
 `bytes ${start}-${end}/${totalSize}`
 );

 } else {

 res.status(
 200
 );
 }


 const safeName =
 path
 .basename(
 relative
 )
 .replace(
 /"/g,
 ""
 );


 res.setHeader(
 "Content-Disposition",
 attachment
 ? `attachment; filename="${safeName}"`
 : `inline; filename="${safeName}"`
 );


 if (
 result.Body &&
 typeof result.Body.pipe ===
 "function"
 ) {

 result.Body.on(
 "error",
 error => {

 console.error(
 "IDRIVE E2 STREAM ERROR:",
 error
 );

 if (
 !res.headersSent
 ) {

 res.status(
 500
 ).end();

 } else {

 res.destroy();
 }
 }
 );


 return result.Body.pipe(
 res
 );
 }


 const bytes =
 await result.Body
 .transformToByteArray();


 return res.end(
 Buffer.from(
 bytes
 )
 );
}


/* =========================================================
FILEBASE OBJECT SEND
========================================================= */

async function sendFilebaseObject(
 req,
 res,
 relative,
 attachment
) {

 if (
 !filebaseConfigured()
 ) {

 const error =
 new Error(
 "Filebase is not configured."
 );

 error.statusCode =
 503;

 throw error;
 }


 const key =
 fileKey(
 relative
 );


 const head =
 await filebaseStorage.send(
 new HeadObjectCommand({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Key:
 key
 })
 );


 const totalSize =
 Number(
 head.ContentLength ||
 0
 );


 const contentType =
 head.ContentType ||
 getContentType(
 relative
 );


 let start =
 0;

 let end =
 totalSize - 1;

 let partial =
 false;


 const range =
 req.headers.range;


 if (range) {

 const match =
 /^bytes=(\d*)-(\d*)$/
 .exec(
 range
 );


 if (!match) {

 return res
 .status(
 416
 )
 .set(
 "Content-Range",
 `bytes */${totalSize}`
 )
 .end();
 }


 if (
 match[1]
 ) {

 start =
 Number(
 match[1]
 );
 }


 if (
 match[2]
 ) {

 end =
 Number(
 match[2]
 );

 } else {

 end =
 totalSize - 1;
 }


 if (
 !match[1]
 ) {

 const suffix =
 Number(
 match[2]
 );

 start =
 Math.max(
 0,
 totalSize -
 suffix
 );

 end =
 totalSize - 1;
 }


 if (
 start < 0 ||
 start > end ||
 start >= totalSize
 ) {

 return res
 .status(
 416
 )
 .set(
 "Content-Range",
 `bytes */${totalSize}`
 )
 .end();
 }


 end =
 Math.min(
 end,
 totalSize - 1
 );

 partial =
 true;
 }


 const length =
 end -
 start +
 1;


 const result =
 await filebaseStorage.send(
 new GetObjectCommand({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Key:
 key,

 ...(partial
 ? {

 Range:
 `bytes=${start}-${end}`

 }
 : {})
 })
 );


 res.setHeader(
 "Content-Type",
 contentType
 );

 res.setHeader(
 "Accept-Ranges",
 "bytes"
 );

 res.setHeader(
 "Content-Length",
 String(
 length
 )
 );

 res.setHeader(
 "Cache-Control",
 "private, no-cache"
 );


 if (partial) {

 res.status(
 206
 );

 res.setHeader(
 "Content-Range",
 `bytes ${start}-${end}/${totalSize}`
 );

 } else {

 res.status(
 200
 );
 }


 const safeName =
 path
 .basename(
 relative
 )
 .replace(
 /"/g,
 ""
 );


 res.setHeader(
 "Content-Disposition",
 attachment
 ? `attachment; filename="${safeName}"`
 : `inline; filename="${safeName}"`
 );


 if (
 result.Body &&
 typeof result.Body.pipe ===
 "function"
 ) {

 result.Body.on(
 "error",
 error => {

 console.error(
 "FILEBASE STREAM ERROR:",
 error
 );

 if (
 !res.headersSent
 ) {

 res.status(
 500
 ).end();

 } else {

 res.destroy();
 }
 }
 );


 return result.Body.pipe(
 res
 );
 }


 const bytes =
 await result.Body
 .transformToByteArray();


 return res.end(
 Buffer.from(
 bytes
 )
 );
}


/* =========================================================
KOOFR OBJECT SEND
========================================================= */

async function sendKoofrObject(
 req,
 res,
 relative,
 attachment
) {

 if (
 !koofrConfigured()
 ) {

 const error =
 new Error(
 "Koofr is not configured."
 );

 error.statusCode =
 503;

 throw error;
 }


 const key =
 fileKey(
 relative
 );


 const head =
 await koofrStorage.send(
 new HeadObjectCommand({

 Bucket:
 KOOFR_BUCKET_NAME,

 Key:
 key
 })
 );


 const totalSize =
 Number(
 head.ContentLength ||
 0
 );


 const contentType =
 head.ContentType ||
 getContentType(
 relative
 );


 let start =
 0;

 let end =
 totalSize - 1;

 let partial =
 false;


 const range =
 req.headers.range;


 if (range) {

 const match =
 /^bytes=(\d*)-(\d*)$/
 .exec(
 range
 );


 if (!match) {

 return res
 .status(
 416
 )
 .set(
 "Content-Range",
 `bytes */${totalSize}`
 )
 .end();
 }


 if (
 match[1]
 ) {

 start =
 Number(
 match[1]
 );
 }


 if (
 match[2]
 ) {

 end =
 Number(
 match[2]
 );

 } else {

 end =
 totalSize - 1;
 }


 if (
 !match[1]
 ) {

 const suffix =
 Number(
 match[2]
 );

 start =
 Math.max(
 0,
 totalSize -
 suffix
 );

 end =
 totalSize - 1;
 }


 if (
 start < 0 ||
 start > end ||
 start >= totalSize
 ) {

 return res
 .status(
 416
 )
 .set(
 "Content-Range",
 `bytes */${totalSize}`
 )
 .end();
 }


 end =
 Math.min(
 end,
 totalSize - 1
 );

 partial =
 true;
 }


 const length =
 end -
 start +
 1;


 const result =
 await koofrStorage.send(
 new GetObjectCommand({

 Bucket:
 KOOFR_BUCKET_NAME,

 Key:
 key,

 ...(partial
 ? {

 Range:
 `bytes=${start}-${end}`

 }
 : {})
 })
 );


 res.setHeader(
 "Content-Type",
 contentType
 );

 res.setHeader(
 "Accept-Ranges",
 "bytes"
 );

 res.setHeader(
 "Content-Length",
 String(
 length
 )
 );

 res.setHeader(
 "Cache-Control",
 "private, no-cache"
 );


 if (partial) {

 res.status(
 206
 );

 res.setHeader(
 "Content-Range",
 `bytes ${start}-${end}/${totalSize}`
 );

 } else {

 res.status(
 200
 );
 }


 const safeName =
 path
 .basename(
 relative
 )
 .replace(
 /"/g,
 ""
 );


 res.setHeader(
 "Content-Disposition",
 attachment
 ? `attachment; filename="${safeName}"`
 : `inline; filename="${safeName}"`
 );


 if (
 result.Body &&
 typeof result.Body.pipe ===
 "function"
 ) {

 result.Body.on(
 "error",
 error => {

 console.error(
 "KOOFR STREAM ERROR:",
 error
 );

 if (
 !res.headersSent
 ) {

 res.status(
 500
 ).end();

 } else {

 res.destroy();
 }
 }
 );


 return result.Body.pipe(
 res
 );
 }


 const bytes =
 await result.Body
 .transformToByteArray();


 return res.end(
 Buffer.from(
 bytes
 )
 );
}


/* =========================================================
MEGA OBJECT SEND
========================================================= */

async function sendMegaObject(
 req,
 res,
 relative,
 attachment
) {

 const found =
 await findMegaFile(
 relative
 );


 if (
 !found?.file
 ) {

 const error =
 new Error(
 "MEGA file not found"
 );

 error.statusCode =
 404;

 throw error;
 }


 const file =
 found.file;


 const totalSize =
 Number(
 file.size ||
 0
 );


 const contentType =
 getContentType(
 relative
 );


 let start =
 0;

 let end =
 totalSize -
 1;

 let partial =
 false;


 const range =
 req.headers.range;


 if (range) {

 const match =
 /^bytes=(\d*)-(\d*)$/
 .exec(
 range
 );


 if (!match) {

 return res
 .status(
 416
 )
 .set(
 "Content-Range",
 `bytes */${totalSize}`
 )
 .end();
 }


 if (
 match[1]
 ) {

 start =
 Number(
 match[1]
 );
 }


 if (
 match[2]
 ) {

 end =
 Number(
 match[2]
 );
 } else {

 end =
 totalSize -
 1;
 }


 if (
 !match[1]
 ) {

 const suffix =
 Number(
 match[2]
 );

 start =
 Math.max(
 0,
 totalSize -
 suffix
 );

 end =
 totalSize -
 1;
 }


 if (
 start < 0 ||
 start > end ||
 start >= totalSize
 ) {

 return res
 .status(
 416
 )
 .set(
 "Content-Range",
 `bytes */${totalSize}`
 )
 .end();
 }


 end =
 Math.min(
 end,
 totalSize -
 1
 );

 partial =
 true;
 }


 const downloadOptions =
 partial
 ? {
 start,
 end
 }
 : {};


 const stream =
 file.download(
 downloadOptions
 );


 const length =
 end -
 start +
 1;


 res.setHeader(
 "Content-Type",
 contentType
 );

 res.setHeader(
 "Accept-Ranges",
 "bytes"
 );

 res.setHeader(
 "Content-Length",
 String(
 length
 )
 );

 res.setHeader(
 "Cache-Control",
 "private, no-cache"
 );


 if (partial) {

 res.status(
 206
 );

 res.setHeader(
 "Content-Range",
 `bytes ${start}-${end}/${totalSize}`
 );

 } else {

 res.status(
 200
 );
 }


 const safeName =
 path
 .basename(
 relative
 )
 .replace(
 /"/g,
 ""
 );


 res.setHeader(
 "Content-Disposition",
 attachment
 ? `attachment; filename="${safeName}"`
 : `inline; filename="${safeName}"`
 );


 stream.on(
 "error",
 error => {

 console.error(
 "MEGA DOWNLOAD ERROR:",
 error
 );

 if (
 !res.headersSent
 ) {

 res.status(
 500
 ).end();

 } else {

 res.destroy();
 }
 }
 );


 return stream.pipe(
 res
 );
}


/* =========================================================
FIND STORAGE FOR FILE
========================================================= */

async function locateFile(
 relative
) {

 const clean =
 cleanPath(
 relative
 );


 if (!clean) {
 return null;
 }


 /*
 --------------------------------------------------------
 1. B2 FIRST
 --------------------------------------------------------
 */

 try {

 await storage.send(
 new HeadObjectCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 fileKey(
 clean
 )
 })
 );


 return {

 storage:
 "B2",

 name:
 clean
 };

 } catch (_) {}


 /*
 --------------------------------------------------------
 2. MEGA SECOND
 --------------------------------------------------------
 */

 if (
 megaConfigured()
 ) {

 try {

 const found =
 await findMegaFile(
 clean
 );


 if (
 found?.file
 ) {

 return {

 storage:
 "MEGA",

 name:
 clean,

 file:
 found.file
 };
 }

 } catch (error) {

 console.error(
 "MEGA LOCATE ERROR:",
 error
 );
 }
 }


 /*
 --------------------------------------------------------
 3. IDRIVE E2 THIRD
 --------------------------------------------------------
 */

 if (
 idriveConfigured()
 ) {

 try {

 await idriveStorage.send(
 new HeadObjectCommand({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Key:
 fileKey(
 clean
 )
 })
 );


 return {

 storage:
 "IDRIVE_E2",

 name:
 clean
 };

 } catch (_) {}
 }


 /*
 --------------------------------------------------------
 4. CLOUDINARY FOURTH
 --------------------------------------------------------
 */

 if (
 cloudinaryConfigured()
 ) {

 try {

 const found =
 await findCloudinaryFile(
 clean
 );

 if (
 found
 ) {

 return {

 storage:
 "CLOUDINARY",

 name:
 clean,

 publicId:
 found.publicId
 };
 }

 } catch (error) {

 console.error(
 "CLOUDINARY LOCATE ERROR:",
 error
 );
 }
 }


 /*
 --------------------------------------------------------
 5. FILEBASE FIFTH
 --------------------------------------------------------
 */

 if (
 filebaseConfigured()
 ) {

 try {

 await filebaseStorage.send(
 new HeadObjectCommand({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Key:
 fileKey(
 clean
 )
 })
 );


 return {

 storage:
 "FILEBASE",

 name:
 clean
 };

 } catch (_) {}
 }


 /*
 --------------------------------------------------------
 6. KOOFR SIXTH
 --------------------------------------------------------
 */

 if (
 koofrConfigured()
 ) {

 try {

 await koofrStorage.send(
 new HeadObjectCommand({

 Bucket:
 KOOFR_BUCKET_NAME,

 Key:
 fileKey(
 clean
 )
 })
 );


 return {

 storage:
 "KOOFR",

 name:
 clean
 };

 } catch (_) {}
 }


 return null;
}


/* =========================================================
STREAM
========================================================= */

app.get(
 /^\/api\/stream\/(.+)$/,
 requireAuth,
 async function(
 req,
 res
 ) {

 try {

 const relative =
 cleanPath(
 req.params[0]
 );


 if (!relative) {

 return res
 .status(
 400
 )
 .send(
 "Invalid file"
 );
 }


 const location =
 await locateFile(
 relative
 );


 if (!location) {

 return res
 .status(
 404
 )
 .send(
 "File not found"
 );
 }


 if (
 location.storage ===
 "B2"
 ) {

 await sendB2Object(
 req,
 res,
 relative,
 false
 );

 } else if (
 location.storage ===
 "MEGA"
 ) {

 await sendMegaObject(
 req,
 res,
 relative,
 false
 );

 } else if (
 location.storage ===
 "IDRIVE_E2"
 ) {

 await sendIDriveE2Object(
 req,
 res,
 relative,
 false
 );

 } else if (
 location.storage ===
 "CLOUDINARY"
 ) {
 const found = await findCloudinaryFile(relative);
 if (!found || !found.secureUrl) {
 return res.status(404).send("File not found");
 }
 return res.redirect(found.secureUrl);

 } else if (
 location.storage ===
 "FILEBASE"
 ) {

 await sendFilebaseObject(
 req,
 res,
 relative,
 false
 );

 } else if (
 location.storage ===
 "KOOFR"
 ) {

 await sendKoofrObject(
 req,
 res,
 relative,
 false
 );
 }

 } catch (error) {

 console.error(
 "STREAM ERROR:",
 error
 );

 if (
 !res.headersSent
 ) {

 return res
 .status(
 error?.statusCode ||
 error?.$metadata
 ?.httpStatusCode ||
 404
 )
 .send(
 "File not found"
 );
 }

 res.destroy();
 }
 }
);


/* =========================================================
DOWNLOAD
========================================================= */

app.get(
 /^\/api\/download\/(.+)$/,
 requireAuth,
 async function(
 req,
 res
 ) {

 try {

 const relative =
 cleanPath(
 req.params[0]
 );


 if (!relative) {

 return res
 .status(
 400
 )
 .send(
 "Invalid file"
 );
 }


 const location =
 await locateFile(
 relative
 );


 if (!location) {

 return res
 .status(
 404
 )
 .send(
 "File not found"
 );
 }


 if (
 location.storage ===
 "B2"
 ) {

 await sendB2Object(
 req,
 res,
 relative,
 true
 );

 } else if (
 location.storage ===
 "MEGA"
 ) {

 await sendMegaObject(
 req,
 res,
 relative,
 true
 );

 } else if (
 location.storage ===
 "IDRIVE_E2"
 ) {

 await sendIDriveE2Object(
 req,
 res,
 relative,
 true
 );

 } else if (
 location.storage ===
 "CLOUDINARY"
 ) {
 const found = await findCloudinaryFile(relative);
 if (!found || !found.secureUrl) {
 return res.status(404).send("File not found");
 }
 return res.redirect(found.secureUrl);

 } else if (
 location.storage ===
 "FILEBASE"
 ) {

 await sendFilebaseObject(
 req,
 res,
 relative,
 true
 );

 } else if (
 location.storage ===
 "KOOFR"
 ) {

 await sendKoofrObject(
 req,
 res,
 relative,
 true
 );
 }

 } catch (error) {

 console.error(
 "DOWNLOAD ERROR:",
 error
 );

 if (
 !res.headersSent
 ) {

 return res
 .status(
 error?.statusCode ||
 404
 )
 .send(
 "File not found"
 );
 }

 res.destroy();
 }
 }
);


/* =========================================================
PERMANENTLY DELETE B2 KEY
========================================================= */

async function permanentlyDeleteB2Key(
 key
) {

 let keyMarker;

 let versionIdMarker;


 while (true) {

 const result =
 await storage.send(
 new ListObjectVersionsCommand({

 Bucket:
 BUCKET_NAME,

 Prefix:
 key,

 KeyMarker:
 keyMarker,

 VersionIdMarker:
 versionIdMarker,

 MaxKeys:
 1000
 })
 );


 const versions =
 [];


 for (
 const item
 of result.Versions ||
 []
 ) {

 if (
 item.Key === key &&
 item.VersionId
 ) {

 versions.push({

 Key:
 item.Key,

 VersionId:
 item.VersionId
 });
 }
 }


 for (
 const item
 of result.DeleteMarkers ||
 []
 ) {

 if (
 item.Key === key &&
 item.VersionId
 ) {

 versions.push({

 Key:
 item.Key,

 VersionId:
 item.VersionId
 });
 }
 }


 for (
 const version
 of versions
 ) {

 await storage.send(
 new DeleteObjectCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 version.Key,

 VersionId:
 version.VersionId
 })
 );
 }


 if (
 !result.IsTruncated
 ) {

 break;
 }


 keyMarker =
 result.NextKeyMarker;

 versionIdMarker =
 result.NextVersionIdMarker;
 }


 try {

 await storage.send(
 new DeleteObjectCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 key
 })
 );

 } catch (_) {}
}


/* =========================================================
PERMANENTLY DELETE IDRIVE E2 KEY
========================================================= */

async function permanentlyDeleteIDriveE2Key(
 key
) {

 if (
 !idriveConfigured()
 ) {

 throw new Error(
 "IDrive E2 is not configured."
 );
 }


 try {

 let keyMarker;

 let versionIdMarker;


 while (true) {

 const result =
 await idriveStorage.send(
 new ListObjectVersionsCommand({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Prefix:
 key,

 KeyMarker:
 keyMarker,

 VersionIdMarker:
 versionIdMarker,

 MaxKeys:
 1000
 })
 );


 const versions =
 [];


 for (
 const item
 of result.Versions ||
 []
 ) {

 if (
 item.Key === key &&
 item.VersionId
 ) {

 versions.push({

 Key:
 item.Key,

 VersionId:
 item.VersionId
 });
 }
 }


 for (
 const item
 of result.DeleteMarkers ||
 []
 ) {

 if (
 item.Key === key &&
 item.VersionId
 ) {

 versions.push({

 Key:
 item.Key,

 VersionId:
 item.VersionId
 });
 }
 }


 for (
 const version
 of versions
 ) {

 await idriveStorage.send(
 new DeleteObjectCommand({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Key:
 version.Key,

 VersionId:
 version.VersionId
 })
 );
 }


 if (
 !result.IsTruncated
 ) {

 break;
 }


 keyMarker =
 result.NextKeyMarker;

 versionIdMarker =
 result.NextVersionIdMarker;
 }

 } catch (error) {

 console.warn(
 "IDrive E2 version cleanup warning:",
 error.message
 );
 }


 await idriveStorage.send(
 new DeleteObjectCommand({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Key:
 key
 })
 );
}


/* =========================================================
PERMANENTLY DELETE FILEBASE KEY
========================================================= */

async function permanentlyDeleteFilebaseKey(
 key
) {

 if (
 !filebaseConfigured()
 ) {

 throw new Error(
 "Filebase is not configured."
 );
 }


 try {

 let keyMarker;

 let versionIdMarker;


 while (true) {

 const result =
 await filebaseStorage.send(
 new ListObjectVersionsCommand({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Prefix:
 key,

 KeyMarker:
 keyMarker,

 VersionIdMarker:
 versionIdMarker,

 MaxKeys:
 1000
 })
 );


 const versions =
 [];


 for (
 const item
 of result.Versions ||
 []
 ) {

 if (
 item.Key === key &&
 item.VersionId
 ) {

 versions.push({

 Key:
 item.Key,

 VersionId:
 item.VersionId
 });
 }
 }


 for (
 const item
 of result.DeleteMarkers ||
 []
 ) {

 if (
 item.Key === key &&
 item.VersionId
 ) {

 versions.push({

 Key:
 item.Key,

 VersionId:
 item.VersionId
 });
 }
 }


 for (
 const version
 of versions
 ) {

 await filebaseStorage.send(
 new DeleteObjectCommand({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Key:
 version.Key,

 VersionId:
 version.VersionId
 })
 );
 }


 if (
 !result.IsTruncated
 ) {

 break;
 }


 keyMarker =
 result.NextKeyMarker;

 versionIdMarker =
 result.NextVersionIdMarker;
 }

 } catch (error) {

 console.warn(
 "Filebase version cleanup warning:",
 error.message
 );
 }


 await filebaseStorage.send(
 new DeleteObjectCommand({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Key:
 key
 })
 );
}


/* =========================================================
PERMANENTLY DELETE KOOFR KEY
========================================================= */

async function permanentlyDeleteKoofrKey(
 key
) {

 if (
 !koofrConfigured()
 ) {

 throw new Error(
 "Koofr is not configured."
 );
 }


 try {

 let keyMarker;

 let versionIdMarker;


 while (true) {

 const result =
 await koofrStorage.send(
 new ListObjectVersionsCommand({

 Bucket:
 KOOFR_BUCKET_NAME,

 Prefix:
 key,

 KeyMarker:
 keyMarker,

 VersionIdMarker:
 versionIdMarker,

 MaxKeys:
 1000
 })
 );


 const versions =
 [];


 for (
 const item
 of result.Versions ||
 []
 ) {

 if (
 item.Key === key &&
 item.VersionId
 ) {

 versions.push({

 Key:
 item.Key,

 VersionId:
 item.VersionId
 });
 }
 }


 for (
 const item
 of result.DeleteMarkers ||
 []
 ) {

 if (
 item.Key === key &&
 item.VersionId
 ) {

 versions.push({

 Key:
 item.Key,

 VersionId:
 item.VersionId
 });
 }
 }


 for (
 const version
 of versions
 ) {

 await koofrStorage.send(
 new DeleteObjectCommand({

 Bucket:
 KOOFR_BUCKET_NAME,

 Key:
 version.Key,

 VersionId:
 version.VersionId
 })
 );
 }


 if (
 !result.IsTruncated
 ) {

 break;
 }


 keyMarker =
 result.NextKeyMarker;

 versionIdMarker =
 result.NextVersionIdMarker;
 }

 } catch (error) {

 console.warn(
 "Koofr version cleanup warning:",
 error.message
 );
 }


 await koofrStorage.send(
 new DeleteObjectCommand({

 Bucket:
 KOOFR_BUCKET_NAME,

 Key:
 key
 })
 );
}


/* =========================================================
DELETE MEGA FILE
========================================================= */

async function permanentlyDeleteMegaFile(
 relative
) {

 const found =
 await findMegaFile(
 relative
 );


 if (
 !found?.file
 ) {

 return false;
 }


 await found.file.delete(
 true
 );


 return true;
}


/* =========================================================
DELETE CLOUDINARY FILE
========================================================= */

async function permanentlyDeleteCloudinaryFile(
 relative
) {
 if (!cloudinaryConfigured()) {
 return false;
 }

 const found = await findCloudinaryFile(relative);
 if (!found || !found.publicId) {
 return false;
 }

 try {
 await cloudinary.uploader.destroy(found.publicId, { resource_type: "auto" });
 return true;
 } catch (error) {
 console.error("CLOUDINARY DELETE ERROR:", error);
 return false;
 }
}


/* =========================================================
DELETE FILE
========================================================= */

app.delete(
 "/api/files",
 requireAuth,
 async function(
 req,
 res
 ) {

 try {

 const relative =
 cleanPath(
 req.body?.name
 );


 if (!relative) {

 return res
 .status(
 400
 )
 .json({
 error:
 "File name missing"
 });
 }


 const location =
 await locateFile(
 relative
 );


 if (!location) {

 return res
 .status(
 404
 )
 .json({
 error:
 "File not found"
 });
 }


 if (
 location.storage ===
 "B2"
 ) {

 const key =
 fileKey(
 relative
 );


 await permanentlyDeleteB2Key(
 key
 );

 } else if (
 location.storage ===
 "MEGA"
 ) {

 await permanentlyDeleteMegaFile(
 relative
 );

 } else if (
 location.storage ===
 "IDRIVE_E2"
 ) {

 const key =
 fileKey(
 relative
 );


 await permanentlyDeleteIDriveE2Key(
 key
 );

 } else if (
 location.storage ===
 "CLOUDINARY"
 ) {

 await permanentlyDeleteCloudinaryFile(
 relative
 );

 } else if (
 location.storage ===
 "FILEBASE"
 ) {

 const key =
 fileKey(
 relative
 );


 await permanentlyDeleteFilebaseKey(
 key
 );

 } else if (
 location.storage ===
 "KOOFR"
 ) {

 const key =
 fileKey(
 relative
 );


 await permanentlyDeleteKoofrKey(
 key
 );
 }


 return res.json({

 ok:
 true,

 name:
 relative,

 storage:
 location.storage,

 message:
 "File permanently deleted"
 });

 } catch (error) {

 console.error(
 "DELETE ERROR:",
 error
 );

 return res
 .status(
 error?.statusCode ||
 500
 )
 .json({
 error:
 error.message ||
 "Delete failed"
 });
 }
 }
);


/* =========================================================
ABORT B2 UPLOAD
========================================================= */

async function abortB2Upload(
 id
) {

 try {

 const metadata =
 await readMetadata(
 metadataKey(
 id
 )
 );


 if (
 metadata?.storage ===
 "B2" &&
 metadata?.uploadId &&
 metadata?.key
 ) {

 try {

 await storage.send(
 new AbortMultipartUploadCommand({

 Bucket:
 BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId
 })
 );

 } catch (_) {}
 }


 await deleteMetadata(
 id
 );

 } catch (_) {}
}


/* =========================================================
ABORT IDRIVE E2 UPLOAD
========================================================= */

async function abortIDriveE2Upload(
 id
) {

 if (
 !idriveConfigured()
 ) {

 return;
 }


 try {

 const metadata =
 await readMetadata(
 metadataKey(
 id
 )
 );


 if (
 metadata?.storage ===
 "IDRIVE_E2" &&
 metadata?.uploadId &&
 metadata?.key
 ) {

 try {

 await idriveStorage.send(
 new AbortMultipartUploadCommand({

 Bucket:
 IDRIVE_E2_BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId
 })
 );

 } catch (_) {}
 }


 await deleteMetadata(
 id
 );

 } catch (_) {}
}


/* =========================================================
ABORT FILEBASE UPLOAD
========================================================= */

async function abortFilebaseUpload(
 id
) {

 if (
 !filebaseConfigured()
 ) {

 return;
 }


 try {

 const metadata =
 await readMetadata(
 metadataKey(
 id
 )
 );


 if (
 metadata?.storage ===
 "FILEBASE" &&
 metadata?.uploadId &&
 metadata?.key
 ) {

 try {

 await filebaseStorage.send(
 new AbortMultipartUploadCommand({

 Bucket:
 FILEBASE_BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId
 })
 );

 } catch (_) {}
 }


 await deleteMetadata(
 id
 );

 } catch (_) {}
}


/* =========================================================
ABORT KOOFR UPLOAD
========================================================= */

async function abortKoofrUpload(
 id
) {

 if (
 !koofrConfigured()
 ) {

 return;
 }


 try {

 const metadata =
 await readMetadata(
 metadataKey(
 id
 )
 );


 if (
 metadata?.storage ===
 "KOOFR" &&
 metadata?.uploadId &&
 metadata?.key
 ) {

 try {

 await koofrStorage.send(
 new AbortMultipartUploadCommand({

 Bucket:
 KOOFR_BUCKET_NAME,

 Key:
 metadata.key,

 UploadId:
 metadata.uploadId
 })
 );

 } catch (_) {}
 }


 await deleteMetadata(
 id
 );

 } catch (_) {}
}


/* =========================================================
ABORT MEGA UPLOAD
========================================================= */

async function abortMegaUpload(
 id
) {

 const state =
 megaUploads.get(
 id
 );


 if (!state) {
 return;
 }


 try {

 if (
 state.uploadStream &&
 !state.uploadStream.destroyed
 ) {

 state.uploadStream.destroy(
 new Error(
 "Upload cancelled"
 )
 );
 }

 } catch (_) {}


 megaUploads.delete(
 id
 );
}


/* =========================================================
ABORT CLOUDINARY UPLOAD
========================================================= */

async function abortCloudinaryUpload(
 id
) {
 cloudinaryUploads.delete(id);
}


/* =========================================================
ABORT UPLOAD
========================================================= */

app.delete(
 "/api/upload/:id",
 requireAuth,
 async function(
 req,
 res
 ) {

 const id =
 String(
 req.params.id ||
 ""
 );


 if (
 !/^[a-z0-9-]{8,100}$/i.test(
 id
 )
 ) {

 return res
 .status(
 400
 )
 .json({
 error:
 "Invalid upload ID"
 });
 }


 try {

 await abortMegaUpload(
 id
 );


 await abortIDriveE2Upload(
 id
 );


 await abortB2Upload(
 id
 );


 await abortCloudinaryUpload(
 id
 );


 await abortFilebaseUpload(
 id
 );


 await abortKoofrUpload(
 id
 );


 return res.json({
 ok:
 true
 });

 } catch (error) {

 const code =
 errorCode(
 error
 );


 if (
 code ===
 "NoSuchKey" ||
 code ===
 "NotFound"
 ) {

 return res.json({
 ok:
 true
 });
 }


 return res
 .status(
 500
 )
 .json({
 error:
 "Could not cancel upload"
 });
 }
 }
);


/* =========================================================
HEALTH
========================================================= */

app.get(
 "/api/health",
 async function(
 req,
 res
 ) {

 try {

 await storage.send(
 new ListObjectsV2Command({

 Bucket:
 BUCKET_NAME,

 Prefix:
 FILE_PREFIX,

 MaxKeys:
 1
 })
 );


 const idriveStatus =
 await verifyIDriveE2();


 const filebaseStatus =
 await verifyFilebase();


 const koofrStatus =
 await verifyKoofr();


 let megaStatus = {

 configured:
 megaConfigured(),

 connected:
 false,

 storage:
 "MEGA",

 error:
 null
 };


 if (
 megaConfigured()
 ) {

 try {

 await ensureMegaStorage();


 const info =
 await getMegaAccountUsage();


 megaStatus.connected =
 true;

 megaStatus.accountUsed =
 formatBytes(
 info.spaceUsed
 );

 megaStatus.accountTotal =
 formatBytes(
 info.spaceTotal
 );

 } catch (error) {

 megaStatus.error =
 error.message;
 }
 }


 let cloudinaryStatus = {
 configured: cloudinaryConfigured(),
 connected: false,
 storage: "Cloudinary",
 error: null
 };

 if (cloudinaryConfigured()) {
  try {
   await cloudinary.api.ping();
   cloudinaryStatus.connected = true;
  } catch (error) {
   cloudinaryStatus.error = error?.message || String(error);
  }
 } else {
  cloudinaryStatus.error = "Cloudinary is not configured.";
 }


 return res.json({

 success:
 true,

 status:
 "online",

 storage:
 "Backblaze B2 + MEGA + IDrive E2 + Cloudinary + Filebase + Koofr",

 persistent:
 true,

 multipart:
 true,

 idriveE2:
 idriveStatus,

 filebase:
 filebaseStatus,

 koofr:
 koofrStatus,

 mega:
 megaStatus,

 cloudinary:
 cloudinaryStatus

 });

 } catch (error) {

 console.error(
 "HEALTH ERROR:",
 error
 );

 return res.status(500).json({
 success: false,
 error: error.message
 });
}
});



/* =========================================================
DOWNLOAD ALL STORAGE LOCATIONS AS ONE LOGICAL ZIP

This does NOT merge physical cloud providers into one bucket.
It presents all existing files as one downloadable archive.
Files remain in their original storage locations.
========================================================= */

async function getArchiveEntryStream(file) {

 const relative =
 cleanPath(
 file?.name || ""
 );

 if (!relative) {
  throw new Error("Invalid archive file name");
 }

 const storageName =
 String(
  file?.storage || ""
 ).toUpperCase();

 if (storageName === "B2") {
  const result =
   await storage.send(
    new GetObjectCommand({
     Bucket: BUCKET_NAME,
     Key: fileKey(relative)
    })
   );
  return result.Body;
 }

 if (storageName === "MEGA") {
  const found =
   await findMegaFile(relative);
  if (!found?.file) {
   throw new Error("MEGA file not found");
  }
  return found.file.download();
 }

 if (storageName === "IDRIVE_E2") {
  if (!idriveConfigured()) {
   throw new Error("IDrive E2 is not configured");
  }
  const result =
   await idriveStorage.send(
    new GetObjectCommand({
     Bucket: IDRIVE_E2_BUCKET_NAME,
     Key: fileKey(relative)
    })
   );
  return result.Body;
 }

 if (storageName === "CLOUDINARY") {
  const found =
   await findCloudinaryFile(relative);
  if (!found?.secureUrl) {
   throw new Error("Cloudinary file not found");
  }
  const response =
   await fetch(found.secureUrl);
  if (!response.ok || !response.body) {
   throw new Error(
    `Cloudinary download failed: ${response.status}`
   );
  }
  return Readable.fromWeb(response.body);
 }

 if (storageName === "FILEBASE") {
  if (!filebaseConfigured()) {
   throw new Error("Filebase is not configured");
  }
  const result =
   await filebaseStorage.send(
    new GetObjectCommand({
     Bucket: FILEBASE_BUCKET_NAME,
     Key: fileKey(relative)
    })
   );
  return result.Body;
 }

 if (storageName === "KOOFR") {
  if (!koofrConfigured()) {
   throw new Error("Koofr is not configured");
  }
  const result =
   await koofrStorage.send(
    new GetObjectCommand({
     Bucket: KOOFR_BUCKET_NAME,
     Key: fileKey(relative)
    })
   );
  return result.Body;
 }

 throw new Error(
  `Unsupported storage: ${storageName || "unknown"}`
 );
}


app.get(
 "/api/download-all",
 requireAuth,
 async function(
  req,
  res
 ) {

  let archive = null;

  try {

   const files = [];

   const b2Files =
    await listB2Files();

   files.push(...b2Files);

   if (megaConfigured()) {
    try {
     files.push(...await listMegaFiles());
    } catch (error) {
     console.error("DOWNLOAD ALL MEGA LIST ERROR:", error);
    }
   }

   if (idriveConfigured()) {
    try {
     files.push(...await listIDriveE2Files());
    } catch (error) {
     console.error("DOWNLOAD ALL IDRIVE E2 LIST ERROR:", error);
    }
   }

   if (cloudinaryConfigured()) {
    try {
     files.push(...await listCloudinaryFiles());
    } catch (error) {
     console.error("DOWNLOAD ALL CLOUDINARY LIST ERROR:", error);
    }
   }

   if (filebaseConfigured()) {
    try {
     files.push(...await listFilebaseFiles());
    } catch (error) {
     console.error("DOWNLOAD ALL FILEBASE LIST ERROR:", error);
    }
   }

   if (koofrConfigured()) {
    try {
     files.push(...await listKoofrFiles());
    } catch (error) {
     console.error("DOWNLOAD ALL KOOFR LIST ERROR:", error);
    }
   }

   const totalBytes =
    files.reduce(
     (sum, file) =>
      sum + Number(file?.size || 0),
     0
    );

   res.status(200);
   res.setHeader(
    "Content-Type",
    "application/zip"
   );
   res.setHeader(
    "Content-Disposition",
    'attachment; filename="my-personal-cloud-all-storage.zip"'
   );
   res.setHeader(
    "Cache-Control",
    "private, no-cache"
   );
   res.setHeader(
    "X-Archive-File-Count",
    String(files.length)
   );
   res.setHeader(
    "X-Archive-Total-Bytes",
    String(totalBytes)
   );

   archive = archiver(
    "zip",
    {
     zlib: {
      level: 0
     }
    }
   );

   archive.on(
    "warning",
    error => {
     console.warn(
      "DOWNLOAD ALL ARCHIVE WARNING:",
      error
     );
    }
   );

   archive.on(
    "error",
    error => {
     console.error(
      "DOWNLOAD ALL ARCHIVE ERROR:",
      error
     );
     if (!res.headersSent) {
      res.status(500).end();
     } else {
      res.destroy(error);
     }
    }
   );

   archive.pipe(res);

   const usedNames =
    new Set();

   for (const file of files) {

    if (res.destroyed) {
     break;
    }

    const storageLabel =
     String(
      file?.storageLabel ||
      file?.storage ||
      "STORAGE"
     )
     .replace(/[^a-z0-9_-]+/gi, "_");

    const cleanName =
     cleanPath(
      file?.name || "file"
     );

    let entryName =
     `${storageLabel}/${cleanName}`;

    let counter = 2;
    while (usedNames.has(entryName)) {
     entryName =
      `${storageLabel}/${cleanName} (${counter})`;
     counter++;
    }
    usedNames.add(entryName);

    try {

     const stream =
      await getArchiveEntryStream(file);

     if (!stream) {
      throw new Error("Empty download stream");
     }

     archive.append(
      stream,
      {
       name: entryName
      }
     );

     if (typeof stream.on === "function") {
      await new Promise(
       (resolve, reject) => {
        let settled = false;
        const finish = () => {
         if (settled) return;
         settled = true;
         resolve();
        };
        const fail = error => {
         if (settled) return;
         settled = true;
         reject(error);
        };
        stream.once("end", finish);
        stream.once("close", finish);
        stream.once("error", fail);
       }
      );
     }

    } catch (error) {

     console.error(
      "DOWNLOAD ALL FILE ERROR:",
      file?.name,
      file?.storage,
      error
     );

     const message =
      `Unable to include ${cleanName}: ${error.message}`;

     archive.append(
      Buffer.from(message, "utf8"),
      {
       name:
        `${storageLabel}/_ERRORS/${cleanName}.txt`
      }
     );
    }
   }

   await archive.finalize();

  } catch (error) {

   console.error(
    "DOWNLOAD ALL ERROR:",
    error
   );

   if (archive) {
    try {
     archive.abort();
    } catch (_) {}
   }

   if (!res.headersSent) {
    return res
     .status(
      error?.statusCode || 500
     )
     .json({
      error:
       error.message ||
       "Could not create combined download"
     });
   }

   res.destroy(error);
  }
 }
);


/* =========================================================
SERVER START
========================================================= */

app.listen(
 PORT,
 async function() {

 console.log(
 `Server running on port ${PORT}`
 );

 console.log("");
 console.log("============================================================");
 console.log("MULTI-STORAGE CONNECTION STATUS");
 console.log("============================================================");

 const printStatus = (name, status) => {
  const connected = Boolean(status?.connected);
  const configured = Boolean(status?.configured);
  const state = connected
   ? "CONNECTED"
   : configured
    ? "NOT CONNECTED"
    : "NOT CONFIGURED";

  console.log(
   `${name}: ${state}${status?.error ? ` â€” ${status.error}` : ""}`
  );
 };

 try {
  try {
   await storage.send(
    new ListObjectsV2Command({
     Bucket: BUCKET_NAME,
     Prefix: FILE_PREFIX,
     MaxKeys: 1
    })
   );
   printStatus("Backblaze B2", {
    configured: true,
    connected: true
   });
  } catch (error) {
   printStatus("Backblaze B2", {
    configured: true,
    connected: false,
    error: error?.message || String(error)
   });
  }

  try {
   if (!megaConfigured()) {
    printStatus("MEGA", {
     configured: false,
     connected: false,
     error: "MEGA is not configured."
    });
   } else {
    await ensureMegaStorage();
    await getMegaAccountUsage();
    printStatus("MEGA", {
     configured: true,
     connected: true
    });
   }
  } catch (error) {
   printStatus("MEGA", {
    configured: true,
    connected: false,
    error: error?.message || String(error)
   });
  }

  printStatus("IDrive E2", await verifyIDriveE2());

  try {
   if (!cloudinaryConfigured()) {
    printStatus("Cloudinary", {
     configured: false,
     connected: false,
     error: "Cloudinary is not configured."
    });
   } else {
    await cloudinary.api.ping();
    printStatus("Cloudinary", {
     configured: true,
     connected: true
    });
   }
  } catch (error) {
   printStatus("Cloudinary", {
    configured: true,
    connected: false,
    error: error?.message || String(error)
   });
  }

  printStatus("Filebase", await verifyFilebase());
  printStatus("Koofr", await verifyKoofr());

 } catch (error) {
  console.error(
   "MULTI-STORAGE STATUS CHECK ERROR:",
   error?.message || error
  );
 }

 console.log("============================================================");
 console.log("Connection status check complete.");
 console.log("============================================================");
 }
);
