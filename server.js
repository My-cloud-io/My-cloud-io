require("dotenv").config();
const express=require("express");
const path=require("path");
const crypto=require("crypto");
const app=express();
const PORT=Number(process.env.PORT||3000);
const HOST=process.env.HOST||"0.0.0.0";
const CLOUD_PASSWORD=process.env.CLOUD_PASSWORD||"";
const TELEGRAM_BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN||"";
const TELEGRAM_CHAT_ID=process.env.TELEGRAM_CHAT_ID||"";
const sessions=new Map();

app.disable("x-powered-by");
app.use(express.json({limit:"2mb"}));

function sid(req){const c=req.headers.cookie||"";const m=c.match(/(?:^|;\s*)cloud_session=([^;]+)/);return m?decodeURIComponent(m[1]):null;}
function auth(req,res,next){const s=sid(req);if(!s||!sessions.has(s))return res.status(401).json({ok:false,error:"Authentication required"});next();}
function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function cookie(res,v){res.setHeader("Set-Cookie",`cloud_session=${encodeURIComponent(v)}; Path=/; HttpOnly; SameSite=Lax`);}
async function tg(method,body){if(!TELEGRAM_BOT_TOKEN)throw Error("Telegram bot token is not configured");const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});const d=await r.json();if(!r.ok||!d.ok)throw Error(d.description||`Telegram API error (${r.status})`);return d;}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"My-cloud-io",uptime_seconds:Math.floor(process.uptime()),password_configured:Boolean(CLOUD_PASSWORD),telegram_configured:Boolean(TELEGRAM_BOT_TOKEN&&TELEGRAM_CHAT_ID)}));
app.get("/api/auth/me",(req,res)=>res.json({ok:true,authenticated:Boolean(sid(req)&&sessions.has(sid(req)))}));
app.post("/api/auth/login",(req,res)=>{if(!CLOUD_PASSWORD)return res.status(503).json({ok:false,error:"Cloud password is not configured on the server"});if(!equal(req.body?.password||"",CLOUD_PASSWORD))return res.status(401).json({ok:false,error:"Incorrect password"});const s=crypto.randomBytes(32).toString("hex");sessions.set(s,{createdAt:Date.now()});cookie(res,s);res.json({ok:true,authenticated:true});});
app.post("/api/auth/logout",(req,res)=>{const s=sid(req);if(s)sessions.delete(s);res.setHeader("Set-Cookie","cloud_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");res.json({ok:true});});

app.get("/api/telegram/status",auth,async(req,res)=>{try{const d=await tg("getMe");res.json({ok:true,bot:{id:d.result.id,first_name:d.result.first_name,username:d.result.username||null},chat_id_configured:Boolean(TELEGRAM_CHAT_ID)});}catch(e){res.status(502).json({ok:false,error:e.message});}});
app.post("/api/telegram/test-message",auth,async(req,res)=>{if(!TELEGRAM_CHAT_ID)return res.status(503).json({ok:false,error:"Telegram chat ID is not configured"});try{await tg("sendMessage",{chat_id:TELEGRAM_CHAT_ID,text:(req.body?.text||"My Personal Cloud: Telegram connection test successful.").toString().slice(0,4000)});res.json({ok:true});}catch(e){res.status(502).json({ok:false,error:e.message});}});

app.get("/api/storage",auth,(req,res)=>res.json({usedText:"0 B",limitText:"10 GB",usedPercent:0,remainingText:"10 GB"}));
app.get("/api/files",auth,(req,res)=>res.json([]));
app.delete("/api/files",auth,(req,res)=>res.json({ok:true,message:"File storage is not enabled yet."}));
app.get("/api/stream/*",auth,(req,res)=>res.status(404).json({ok:false,error:"File streaming is not enabled yet."}));
app.get("/api/download/*",auth,(req,res)=>res.status(404).json({ok:false,error:"File downloading is not enabled yet."}));
app.post("/api/upload-chunk",auth,(req,res)=>res.status(501).json({ok:false,error:"Upload storage is the next build step."}));

const publicDir=path.join(__dirname,"public");
app.use(express.static(publicDir));
app.get("*",(req,res)=>res.sendFile(path.join(publicDir,"index.html")));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({ok:false,error:"Internal server error"});});
app.listen(PORT,HOST,()=>{console.log("\n========================================");console.log(" My-cloud-io server is running");console.log(` http://localhost:${PORT}`);console.log(` Health: http://localhost:${PORT}/api/health`);console.log(` Telegram: http://localhost:${PORT}/api/telegram/status`);console.log("========================================\n");});
                                
