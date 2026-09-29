"use strict";

const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const { createInterface } = require("node:readline/promises");

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const apiId = Number(await rl.question("Telegram API ID: "));
    const apiHash = await rl.question("Telegram API Hash: ");

    if (!Number.isInteger(apiId) || !apiHash.trim()) {
      throw new Error("Valid TELEGRAM_API_ID and TELEGRAM_API_HASH are required.");
    }

    const session = new StringSession("");
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      autoReconnect: false
    });

    try {
      await client.start({
        phoneNumber: () => rl.question("Telegram phone number: "),
        password: () => rl.question("Telegram 2FA password (leave blank if none): "),
        phoneCode: () => rl.question("Telegram login code: "),
        onError: (err) => console.error("Telegram login error:", err?.message || err)
      });
      const me = await client.getMe();
      console.log("\nAuthenticated Telegram account:", me?.username ? `@${me.username}` : me?.id);
      console.log("\nNEW TELEGRAM_SESSION:\n");
      console.log(client.session.save());
      console.log("\nCopy this value into TELEGRAM_SESSION on the persistent backend only.");
      console.log("Do not put this session string in the website HTML, GitHub, or Vercel frontend.");
    } finally {
      await client.disconnect().catch(() => {});
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Session generator failed:", err?.message || err);
  process.exitCode = 1;
});
