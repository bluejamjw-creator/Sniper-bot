// ============================
// SNIPER V10 (FINAL STABLE)
// ============================

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// ============================
// SECURITY
// ============================

app.use((req, res, next) => {
  if (req.path === "/") return next();

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ============================
// STORAGE
// ============================

const DATA_DIR = process.env.DATA_DIR || "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const TRADES_FILE = path.join(DATA_DIR, "trades.json");
const SIGNALS_FILE = path.join(DATA_DIR, "signals.json");

const load = f => {
  try { return JSON.parse(fs.readFileSync(f)); } catch { return []; }
};

const save = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

// ============================
// TELEGRAM
// ============================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

async function send(msg){
  if(!BOT_TOKEN || !CHAT_ID) return;
  try{
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{
      chat_id:CHAT_ID,
      text:msg
    });
  }catch{}
}

// ============================
// DATA FETCH
// ============================

async function fetchStock(symbol){
  try{
    const {data} = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`
    );
    return data.chart.result[0].indicators.quote[0].close;
  }catch{return null;}
}

async function fetchCrypto(symbol){
  try{
    const {data} = await axios.get(
      `https://api.binance.com/api/v3/klines`,
      {params:{symbol:`${symbol}USDT`,interval:"4h",limit:100}}
    );
    return data.map(x=>Number(x[4]));
  }catch{return null;}
}

// ============================
// INDICATORS
// ============================

function ema(v,p){
  const k=2/(p+1);
  let e=v[0];
  for(let i=1;i<v.length;i++) e=v[i]*k+e*(1-k);
  return e;
}

// ============================
// WATCHLIST
// ============================

const WATCHLIST = {
  stocks:["MSTR","PLTR","AMD","SMH","APP"],
  crypto:["SOL","ETH","FET","RNDR"]
};

// ============================
// STRATEGY
// ============================

function analyse(symbol, closes){

  if(!closes || closes.length < 50) return null;

  const last = closes.at(-1);
  const prev = closes.at(-2);

  const high = Math.max(...closes.slice(-20));
  const low = Math.min(...closes.slice(-20));

  const ema20 = ema(closes.slice(-20),20);
  const ema50 = ema(closes.slice(-50),50);

  if(ema20 <= ema50) return null;

  const momentum = (last-prev)/prev;
  const range = (high-low)/low;

  const breakout =
    last > high*0.98 &&
    momentum > 0.015 &&
    range > 0.05;

  const pullback =
    last < high*0.98 &&
    last > ema20 &&
    momentum > 0;

  if(!breakout && !pullback) return null;

  const entry = last;
  const sl = entry * (breakout ? 0.94 : 0.96);
  const tp = entry * 1.10;

  const rr = (tp-entry)/(entry-sl);
  if(rr < 1.3) return null;

  let confidence = 60;

  if(breakout) confidence += 10;
  if(momentum > 0.02) confidence += 10;
  if(range > 0.08) confidence += 10;

  return {
    asset:symbol,
    entry,
    sl,
    tp,
    confidence,
    time:Date.now()
  };
}

// ============================
// SCAN
// ============================

async function scan(){

  const results=[];

  for(const s of WATCHLIST.stocks){
    const data = await fetchStock(s);
    const r = analyse(s,data);
    if(r) results.push(r);
  }

  for(const c of WATCHLIST.crypto){
    const data = await fetchCrypto(c);
    const r = analyse(c,data);
    if(r) results.push(r);
  }

  return results.sort((a,b)=>b.confidence-a.confidence).slice(0,3);
}

// ============================
// TRADE MANAGEMENT
// ============================

async function manage(){

  const trades = load(TRADES_FILE);

  for(const t of trades){

    if(t.status === "closed") continue;

    let price;

    try{
      if(WATCHLIST.crypto.includes(t.asset)){
        const {data} = await axios.get(
          `https://api.binance.com/api/v3/ticker/price?symbol=${t.asset}USDT`
        );
        price = Number(data.price);
      }else{
        const {data} = await axios.get(
          `https://query1.finance.yahoo.com/v8/finance/chart/${t.asset}?interval=1m&range=1d`
        );
        price = data.chart.result[0].meta.regularMarketPrice;
      }
    }catch{
      continue;
    }

    if(price >= t.tp){
      t.status="closed";
      t.pnl = (t.tp - t.entry);
      send(`💰 TP ${t.asset}`);
    }

    if(price <= t.sl){
      t.status="closed";
      t.pnl = (t.sl - t.entry);
      send(`❌ SL ${t.asset}`);
    }
  }

  save(TRADES_FILE,trades);
}

// ============================
// MAIN LOOP
// ============================

async function runCycle(){

  console.log("=== SNIPER ===");

  const signals = await scan();

  // ✅ SAVE SIGNALS FOR PORTFOLIO BOT
  save(SIGNALS_FILE, signals);

  const trades = load(TRADES_FILE);

  for(const s of signals){

    if(trades.find(t=>t.asset===s.asset && t.status!=="closed")) continue;

    trades.push({...s,status:"open"});

    send(`🚨 ${s.asset} (${s.confidence}%)\nEntry: ${s.entry.toFixed(2)}`);
  }

  save(TRADES_FILE,trades);

  await manage();
}

// Run every 5 mins
setInterval(runCycle,300000);
runCycle();

// ============================
// API
// ============================

app.get("/",(req,res)=>{
  res.send("Sniper Bot API Running 🚀");
});

app.get("/trades",(req,res)=>{
  res.json(load(TRADES_FILE));
});

app.get("/stats",(req,res)=>{
  const trades = load(TRADES_FILE);
  const closed = trades.filter(t=>t.status==="closed");
  const pnl = closed.reduce((a,t)=>a+(t.pnl||0),0);

  res.json({
    total:trades.length,
    closed:closed.length,
    pnl:pnl.toFixed(2)
  });
});

app.listen(PORT,()=>console.log("API running"));

// ✅ KEEP ALIVE (prevents Railway stopping container)
setInterval(() => {}, 60000);
