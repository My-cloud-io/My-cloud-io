require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

const publicDir = path.join(__dirname, "public");

app.use(express.static(publicDir, {
    extensions: ["html"],
    index: "index.html",
    etag: true,
    maxAge: "1h"
}));

function telegramConfigured() {
    return Boolean(TELEGRAM_BOT_TOKEN);
}

function telegramUrl(method) {
    if (!telegramConfigured()) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegramCall(method, body = undefined) {
    const response = await fetch(telegramUrl(method), {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : {"content-type": "application/json"},
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`Telegram returned non-JSON response (HTTP ${response.status})`); }

    if (!response.ok || !data.ok) {
        const error = new Error(data.description || `Telegram HTTP ${response.status}`);
        error.telegram = data;
        error.httpStatus = response.status;
        throw error;
    }
    return data;
}

/* Safe connection diagnostic. Never returns the bot token. */
app.get("/api/telegram/status", async (_req, res) => {
    if (!telegramConfigured()) {
        return res.status(503).json({ok:false, configured:false, error:"TELEGRAM_BOT_TOKEN is not configured"});
    }
    try {
        const result = await telegramCall("getMe");
        res.json({
            ok:true,
            configured:true,
            bot:{
                id:result.result.id,
                first_name:result.result.first_name,
                username:result.result.username || null,
                is_bot:result.result.is_bot
            },
            chat_id_configured:Boolean(TELEGRAM_CHAT_ID)
        });
    } catch (error) {
        console.error("Telegram status error:", error.message);
        res.status(502).json({ok:false, configured:true, error:error.message});
    }
});

/* Setup helper for reading recent incoming messages/Chat IDs. */
app.get("/api/telegram/updates", async (req, res) => {
    if (!telegramConfigured()) {
        return res.status(503).json({ok:false, configured:false, error:"TELEGRAM_BOT_TOKEN is not configured"});
    }
    try {
        const n = Number(req.query.limit);
        const limit = Number.isInteger(n) ? Math.min(Math.max(n,1),100) : 20;
        const result = await telegramCall(`getUpdates?limit=${limit}`);
        const updates = (result.result || []).map(update => {
            const message = update.message || update.edited_message || null;
            const chat = message?.chat || null;
            const from = message?.from || null;
            return {
                update_id:update.update_id,
                message_id:message?.message_id ?? null,
                text:typeof message?.text === "string" ? message.text : null,
                chat:chat ? {
                    id:chat.id,
                    type:chat.type,
                    first_name:chat.first_name || null,
                    username:chat.username || null
                } : null,
                from:from ? {
                    id:from.id,
                    first_name:from.first_name || null,
                    username:from.username || null
                } : null
            };
        });
        res.json({ok:true, updates});
    } catch (error) {
        console.error("Telegram updates error:", error.message);
        res.status(502).json({ok:false, configured:true, error:error.message});
    }
});

/* Optional simple test message. File storage is intentionally not enabled yet. */
app.post("/api/telegram/test-message", async (req, res) => {
    if (!telegramConfigured()) return res.status(503).json({ok:false,error:"TELEGRAM_BOT_TOKEN is not configured"});
    if (!TELEGRAM_CHAT_ID) return res.status(400).json({ok:false,error:"TELEGRAM_CHAT_ID is not configured"});

    const requested = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const text = requested || "My Personal Cloud: Telegram connection test successful.";
    if (text.length > 4096) return res.status(400).json({ok:false,error:"Message is too long"});

    try {
        const result = await telegramCall("sendMessage", {chat_id:TELEGRAM_CHAT_ID, text});
        res.json({ok:true,message_id:result.result.message_id,chat_id:result.result.chat.id});
    } catch (error) {
        console.error("Telegram test-message error:", error.message);
        res.status(502).json({ok:false,error:error.message});
    }
});

app.get("/api/health", (_req, res) => {
    res.json({
        ok:true,
        service:"My-cloud-io",
        status:"online",
        telegram_configured:telegramConfigured(),
        telegram_chat_id_configured:Boolean(TELEGRAM_CHAT_ID),
        timestamp:new Date().toISOString()
    });
});

app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
        return res.status(404).json({ok:false,error:"API route not found"});
    }
    res.sendFile(path.join(publicDir, "index.html"), err => { if (err) next(err); });
});

app.use((err, _req, res, _next) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(500).json({ok:false,error:"Internal server error"});
});

app.listen(PORT, HOST, () => {
    console.log("");
    console.log("========================================");
    console.log(" My-cloud-io server is running");
    console.log(` http://localhost:${PORT}`);
    console.log(` Health: http://localhost:${PORT}/api/health`);
    console.log(` Telegram: http://localhost:${PORT}/api/telegram/status`);
    console.log("========================================");
    console.log("");
});
                                 
