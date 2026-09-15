"use strict";

/*
  My-cloud-io Vercel build intentionally does not use a shared MTProto
  TELEGRAM_SESSION for file storage.

  A single MTProto user session reused by concurrent Vercel serverless
  instances can be invalidated by Telegram with AUTH_KEY_DUPLICATED.
  This file is retained because the project structure requested by the
  owner includes telegram-session.js. It is a compatibility placeholder.

  Real durable file storage is Vercel Blob (private store), which is designed
  for concurrent Vercel Functions and supports multipart/large files.
*/

console.log("My-cloud-io: telegram-session.js is retained for compatibility; Vercel Blob is the active storage backend.");

