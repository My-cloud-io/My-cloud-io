 "use strict";
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const { createInterface } = require("node:readline/promises");
async function main() {
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try {
    const apiId=Number(await rl.question("Telegram API ID: "));
    const apiHash=await rl.question("Telegram API Hash: ");
    if(!Number.isInteger(apiId)||!apiHash.trim()) throw new Error("Valid API ID/API Hash required.");
    const session=new StringSession("");
    const client=new TelegramClient(session,apiId,apiHash,{connectionRetries:5,autoReconnect:false});
    try {
      await client.start({
        phoneNumber:()=>rl.question("Telegram phone number: "),
        password:()=>rl.question("Telegram 2FA password (blank if none): "),
        phoneCode:()=>rl.question("Telegram login code: "),
        onError:e=>console.error("Telegram login error:",e?.message||e)
      });
      const me=await client.getMe();
      console.log("\nAuthenticated account:",me?.username?`@${me.username}`:me?.id);
      console.log("\nNEW TELEGRAM_SESSION:\n");
      console.log(client.session.save());
      console.log("\nUse this ONLY on the single persistent backend.");
    } finally { await client.disconnect().catch(()=>{}); }
  } finally { rl.close(); }
}
main().catch(e=>{console.error("Session generator failed:",e?.message||e);process.exitCode=1;});
