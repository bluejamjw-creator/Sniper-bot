// =======================
// SNIPER V2 (UPGRADED)
// =======================

const fs = require("fs");
const path = require("path");
const axios = require("axios");

// =======================
// ENV
// =======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DATA_DIR = process.env.DATA_DIR || ".";

const SIGNAL_FILE = path.join(DATA_DIR, "signals.json");
const TRADES_FILE = path.join(DATA_DIR, "trades.json");
const DASHBOARD_FILE = path.join(DATA_DIR, "dashboard.json");

const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 55);
const MAX_ALERTS = Number(process.env.MAX_ALERTS_PER_SCAN || 4);
const COOLDOWN_HOURS = Number(process.env.COOLDOWN_HOURS || 4);

const ACCOUNT_SIZE = Number(process.env.ACCOUNT_SIZE || 1000);
const RISK_PCT = Number(process.env.RISK_PCT || 0.02);

const REQUEST_TIMEOUT_MS = 15000;

// =======================
// WATCHLIST
// =======================
const WATCHLIST = {
  stocks: ["SMH","EQQQ.L","PLTR","AMD","APP","MSTR","COIN","ASTS","SOUN"],
  crypto: ["SOL","ETH","FET","RNDR"]
};

// =======================
// STORAGE
// =======================
fs.mkdirSync(DATA_DIR,{recursive:true});

if(!fs.existsSync(SIGNAL_FILE)) fs.writeFileSync(SIGNAL_FILE,"[]");
if(!fs.existsSync(TRADES_FILE)) fs.writeFileSync(TRADES_FILE,"[]");

const load = f => { try{return JSON.parse(fs.readFileSync(f));}catch{return [];} };
const save = (f,d) => fs.writeFileSync(f,JSON.stringify(d,null,2));

// =======================
// TELEGRAM
// =======================
async function send(msg){
  if(!BOT_TOKEN||!CHAT_ID) return;
  try{
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{
      chat_id:CHAT_ID,text:msg
    });
  }catch{}
}

// =======================
// FETCH
// =======================
async function fetchCrypto(symbol){
  try{
    const {data}=await axios.get(
      `https://api.binance.com/api/v3/klines`,
      {params:{symbol:`${symbol}USDT`,interval:"4h",limit:50}}
    );
    const closes=data.map(x=>Number(x[4]));
    return closes;
  }catch{return null;}
}

async function fetchStock(symbol){
  try{
    const {data}=await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`
    );
    return data.chart.result[0].indicators.quote[0].close;
  }catch{return null;}
}

// =======================
// HELPERS
// =======================
function ema(v,p){
  const k=2/(p+1);
  let e=v[0];
  for(let i=1;i<v.length;i++) e=v[i]*k+e*(1-k);
  return e;
}

// =======================
// SIGNAL LOGIC
// =======================
function analyse(symbol, closes){

  if(!closes || closes.length < 30) return null;

  const last = closes.at(-1);
  const prev = closes.at(-2);

  const high = Math.max(...closes.slice(-20));
  const low = Math.min(...closes.slice(-20));

  const ema20 = ema(closes.slice(-20),20);
  const ema50 = ema(closes.slice(-50),50);

  if(ema20 <= ema50) return null;

  const momentum = (last-prev)/prev;
  const range = (high-low)/low;

  // 🔥 BREAKOUT DETECTION
  const breakout =
    last > high*0.97 &&
    momentum > 0.015 &&
    range > 0.05;

  // 🧠 PULLBACK
  const pullback =
    last < high*0.98 &&
    last > low*1.02 &&
    last > ema20;

  if(!breakout && !pullback) return null;

  const entry = last;

  const sl = breakout ? entry*0.94 : entry*0.97;

  // 🎯 TP LADDER
  const tp1 = entry * 1.05;
  const tp2 = entry * 1.10;
  const tp3 = entry * (range > 0.1 ? 1.25 : 1.15);

  const rr = (tp2-entry)/(entry-sl);
  if(rr < 1.3) return null;

  // 🎯 CONFIDENCE
  let conf = 55;
  if(breakout) conf += 15;
  if(momentum > 0.02) conf += 10;
  if(range > 0.08) conf += 10;

  if(conf < MIN_CONFIDENCE) return null;

  return {
    asset:symbol,
    entry:+entry.toFixed(2),
    sl:+sl.toFixed(2),
    tp1:+tp1.toFixed(2),
    tp2:+tp2.toFixed(2),
    tp3:+tp3.toFixed(2),
    confidence:conf,
    mode: breakout ? "BREAKOUT" : "PULLBACK",
    rr:+rr.toFixed(2),
    time:Date.now()
  };
}

// =======================
// SCAN
// =======================
async function scan(){

  console.log("Scan start");

  const results=[];

  for(const s of WATCHLIST.stocks){
    const c = await fetchStock(s);
    results.push(analyse(s,c));
  }

  for(const c of WATCHLIST.crypto){
    const d = await fetchCrypto(c);
    results.push(analyse(c,d));
  }

  const ranked = results.filter(Boolean)
    .sort((a,b)=>b.confidence-a.confidence)
    .slice(0,MAX_ALERTS);

  const signals = load(SIGNAL_FILE);
  const trades = load(TRADES_FILE);

  for(const s of ranked){

    if(signals.some(x=>x.asset===s.asset)) continue;

    const risk = ACCOUNT_SIZE*RISK_PCT;
    const size = risk/(s.entry-s.sl);

    signals.push(s);
    save(SIGNAL_FILE,signals);

    trades.push({
      ...s,
      size,
      status:"open",
      highest:s.entry
    });

    save(TRADES_FILE,trades);

    await send(
`🚨 SNIPER
${s.asset} (${s.confidence}%)
Mode: ${s.mode}

Entry: ${s.entry}
SL: ${s.sl}

TP1: ${s.tp1}
TP2: ${s.tp2}
TP3: ${s.tp3}

RR: ${s.rr}`
    );
  }

  console.log("Scan end");
}

// =======================
// RUN
// =======================
async function runCycle(){
  console.log("=== NEW CYCLE ===", new Date().toISOString());
  await scan();
}

runCycle();
setInterval(runCycle,300000);

// keep alive
setInterval(()=>{},60000);
