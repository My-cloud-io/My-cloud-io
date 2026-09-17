"use strict";

/*
  My-cloud-io keeps this file for compatibility with the original project
  layout. The production Vercel build does NOT use an MTProto session for
  storage, so concurrent Vercel instances cannot invalidate one Telegram
  auth key with AUTH_KEY_DUPLICATED.

  Durable file storage is handled by Vercel Blob in server.js.
*/

console.log("[My-cloud-io] telegram-session.js is compatibility-only; Vercel Blob is the active storage backend.");
