"use strict";

/* Run locally, not on Render, to create the Telegram MTProto session string. */
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");

(async () => {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0);
  const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
  if (!apiId || !apiHash) {
    console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH before running this script.");
    process.exit(1);
  }

  const { TelegramClient } = await import("teleproto");
  const { StringSession } = await import("teleproto/sessions/index.js");
  const rl = readline.createInterface({ input, output });

  try {
    const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
      connectionRetries: 5,
      retryDelay: 1000,
    });

    await client.start({
      phoneNumber: async () => rl.question("Telegram phone number: "),
      password: async () => rl.question("Telegram 2FA password (leave blank if none): "),
      phoneCode: async () => rl.question("Telegram login code: "),
      onError: (error) => console.error("Telegram login error:", error?.message || error),
    });

    console.log("\nLogin successful. Save this value as Render's TELEGRAM_SESSION secret:\n");
    console.log(client.session.save());
    await client.disconnect();
  } finally {
    rl.close();
  }
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

    
