'use strict';

/* Run locally once to create TELEGRAM_SESSION. Never put the result in public/. */
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = String(process.env.TELEGRAM_API_HASH || '');
if (!apiId || !apiHash) {
  console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH first.');
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

(async () => {
  try {
    await client.start({
      phoneNumber: async () => rl.question('Telegram phone number: '),
      password: async () => rl.question('Telegram 2FA password (if enabled): '),
      phoneCode: async () => rl.question('Telegram login code: '),
      onError: err => console.error('Telegram login error:', err?.message || err)
    });
    console.log('\nTELEGRAM_SESSION=');
    console.log(client.session.save());
    console.log('\nCopy only that session value to your persistent backend environment.');
  } finally {
    rl.close();
    try { await client.disconnect(); } catch {}
  }
})();
