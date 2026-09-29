'use strict';

const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { createInterface } = require('node:readline/promises');

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || '';

if (!apiId || !apiHash) {
  console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH first.');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

(async () => {
  try {
    await client.start({
      phoneNumber: async () => rl.question('Telegram phone number: '),
      password: async () => rl.question('Telegram 2FA password (leave blank if none): '),
      phoneCode: async () => rl.question('Telegram login code: '),
      onError: (err) => console.error('Telegram auth error:', err?.message || err)
    });
    console.log('\nTELEGRAM_SESSION=');
    console.log(client.session.save());
    console.log('\nCopy the complete value into your server environment.');
  } finally {
    rl.close();
    try { await client.disconnect(); } catch {}
  }
})().catch(err => { console.error(err); process.exit(1); });
