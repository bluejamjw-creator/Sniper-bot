// ============================
// SNIPER V11 (MOMENTUM + TRADE SIGNALS)
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
// SECURITY (PUBLIC ENDPOINTS)
// ============================

app.use((req, res, next) => {
  if (["/", "/trades", "/stats"].includes(req.path)) return next();

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
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1h`
    );
    return data.chart.result[0].indicators.quote[0].close;
  }catch{return null;}
}

async function fetchCrypto(symbol){
  try{
    const {data} = await axios.get(
      `https://api.binance.com/api/v3/klines`,
      {params:{symbol:`${symbol}USDT`,interval:"1h",limit:120}}
    );
    return data.map(x=>Number(x[4]));
  }catch{return null;}
}

// ============================
// MOMENTUM ANALYSIS
// ============================

function analyse(symbol, closes){

  if(!closes || closes.length < 30) return null;

  const last = closes.at(-1);
  const prev = closes.at(-2);

  const base = closes.at(-12);
  const move = (last - base) / base;

  const high = Math.max(...closes.slice(-20));
  const low = Math.min(...closes.slice(-20));

  const momentum = (last - prev) / prev;
  const expansion = (high - low) / low;

  const isMoving = move > 0.05;
  const breakout = last > high * 0.97;
  const strongMomentum = momentum > 0.005;

  if(!isMoving || !strongMomentum) return null;

  let confidence = 60;

  if(move > 0.08) confidence += 10;
  if(move > 0.12) confidence += 10;
  if(expansion > 0.06) confidence += 10;
  if(breakout) confidence += 10;

  const entry = last;
  const sl = entry * 0.94;
  const tp = entry * 1.12;

  return {
    asset: symbol,
    entry,
    sl,
    tp,
    confidence,
    move: (move * 100),
    breakout,
    time: Date.now()
  };
}

// ============================
// WATCHLIST
// ============================

const WATCHLIST = {
  stocks: ["MSTR","PLTR","AMD","SMH","APP","NVDA","TSLA","COIN"],
  crypto: ["SOL","ETH","FET","RNDR","INJ","NEAR","ARB"]
};

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

  return results
    .sort((a,b)=>b.confidence-a.confidence)
    .slice(0,5);
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
      send(`💰 TP HIT: ${t.asset}`);
    }

    if(price <= t.sl){
      t.status="closed";
      t.pnl = (t.sl - t.entry);
      send(`❌ SL HIT: ${t.asset}`);
    }
  }

  save(TRADES_FILE,trades);
}

// ============================
// MAIN LOOP
// ============================

async function runCycle(){

  console.log("=== SNIPER (MOMENTUM MODE) ===");

  const signals = await scan();
  const trades = load(TRADES_FILE);

  console.log("Signals found:", signals.length);

  for(const s of signals){

    if(trades.find(t=>t.asset===s.asset && t.status!=="closed")) continue;

    const rr = ((s.tp - s.entry) / (s.entry - s.sl)).toFixed(2);
    const mode = s.breakout ? "BREAKOUT" : "MOMENTUM";

    // Simple fixed risk size (upgrade later)
    const size = 0.20;

    trades.push({...s,status:"open"});

    send(
`🚨 TRADE SIGNAL

${s.asset} (Score: ${s.confidence})
Mode: ${mode}

Entry: ${s.entry.toFixed(2)}
SL: ${s.sl.toFixed(2)}
TP: ${s.tp.toFixed(2)}

RR: ${rr}
Size: ${size}`
    );
  }

  save(TRADES_FILE,trades);

  await manage();
}

setInterval(runCycle,300000);
runCycle();

// ============================
// API
// ============================

app.get("/",(req,res)=>{
  res.send("Sniper Bot LIVE 🚀");
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

// keep alive (Railway fix)
setInterval(() => {}, 60000);
