import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { createInterface } from "node:readline/promises";

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || "";

if (!apiId || !apiHash) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH first.");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => rl.question(q);

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
  requestRetries: 3,
  retryDelay: 1000
});

try {
  await client.start({
    phoneNumber: () => ask("Telegram phone number: "),
    password: () => ask("Telegram 2FA password (press Enter if none): "),
    phoneCode: () => ask("Telegram login code: "),
    onError: (err) => console.error("[Telegram auth]", err?.message || err)
  });

  console.log("\nCONNECTED.");
  console.log("Copy the following value into the ONE persistent backend's TELEGRAM_SESSION secret:\n");
  console.log(client.session.save());
  console.log("\nDo not put this value in public/index.html, GitHub, or chat.");
} finally {
  rl.close();
  await client.disconnect().catch(() => {});
}
