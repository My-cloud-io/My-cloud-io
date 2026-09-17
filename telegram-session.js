"use strict";

/*
  Compatibility file kept because the original project used Telegram MTProto.
  Production storage in this final Vercel build is Vercel Blob Private Storage.
  This file is intentionally NOT connected to the storage server, so one
  Telegram session can never be shared by multiple Vercel instances.
*/

console.log("[my-personal-cloud] Telegram session is not used. Storage backend: Vercel Blob.");
