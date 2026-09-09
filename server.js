require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

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

app.get("/api/health", (_req, res) => {
    res.json({
        ok: true,
        service: "My-cloud-io",
        status: "online",
        timestamp: new Date().toISOString()
    });
});

app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
        return res.status(404).json({
            ok: false,
            error: "API route not found"
        });
    }

    res.sendFile(path.join(publicDir, "index.html"), (err) => {
        if (err) next(err);
    });
});

app.use((err, _req, res, _next) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(500).json({
        ok: false,
        error: "Internal server error"
    });
});

app.listen(PORT, HOST, () => {
    console.log("");
    console.log("========================================");
    console.log(" My-cloud-io server is running");
    console.log(` http://localhost:${PORT}`);
    console.log(` Health: http://localhost:${PORT}/api/health`);
    console.log("========================================");
    console.log("");
});
                      
