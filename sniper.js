// =======================
// SNIPER V3 (PRO ENGINE)
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
const STATS_FILE = path.join(DATA_DIR, "stats.json");

const ACCOUNT_SIZE = Number(process.env.ACCOUNT_SIZE || 1000);
let riskPct = Number(process.env.RISK_PCT || 0.02);

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
if(!fs.existsSync(STATS_FILE)) fs.writeFileSync(STATS_FILE, JSON.stringify({
  wins:0,
  losses:0,
  streak:0
}));

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
    return data.map(x=>Number(x[4]));
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
// SIGNAL ANALYSIS
// =======================
function analyse(symbol, closes){

  if(!closes || closes.length < 30) return null;

  const last = closes.at(-1);
  const prev = closes.at(-2);

  const high = Math.max(...closes.slice(-20));
  const low = Math.min(...closes.slice(-20));

  const ema20 = ema(closes.slice(-20),20);
  const ema50 = ema(closes.slice(-50),50);

  if(ema20 < ema50 * 0.97) return null;

  const momentum = (last-prev)/prev;
  const range = (high-low)/low;

  const breakout =
    last > high*0.94 &&
    momentum > 0.01 &&
    range > 0.04;

  const pullback =
    last < high*0.99 &&
    last > low*1.01 &&
    last > ema20;

  const soft =
    momentum > 0.01 &&
    last > ema20;

  if(!breakout && !pullback && !soft) return null;

  const entry = last;
  const sl = breakout ? entry*0.94 : entry*0.97;

  const tp2 = entry * 1.10;

  const rr = (tp2-entry)/(entry-sl);
  if(rr < 1.15) return null;

  // 🧠 SCORE (REAL EDGE)
  let score = 50;

  if(breakout) score += 15;
  if(momentum > 0.02) score += 15;
  if(range > 0.08) score += 10;
  if(rr > 2) score += 10;

  return {
    asset:symbol,
    entry:+entry.toFixed(2),
    sl:+sl.toFixed(2),
    tp:+tp2.toFixed(2),
    score,
    rr:+rr.toFixed(2),
    mode: breakout ? "BREAKOUT" : (pullback ? "PULLBACK" : "MOMENTUM"),
    time:Date.now()
  };
}

// =======================
// BEST SIGNAL SELECTOR
// =======================
function selectBest(signals){

  return signals
    .filter(Boolean)
    .sort((a,b)=>b.score-a.score)
    .slice(0,2); // ONLY BEST 2
}

// =======================
// COMPOUNDING LOGIC
// =======================
function adjustRisk(){
  const stats = load(STATS_FILE);

  if(stats.streak >= 3) riskPct = 0.03;
  else if(stats.streak <= -2) riskPct = 0.01;
  else riskPct = 0.02;

  return riskPct;
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

  const best = selectBest(results);

  const signals = load(SIGNAL_FILE);
  const trades = load(TRADES_FILE);

  const currentRisk = adjustRisk();

  for(const s of best){

    const risk = ACCOUNT_SIZE * currentRisk;
    const size = risk/(s.entry-s.sl);

    signals.push(s);
    save(SIGNAL_FILE,signals);

    trades.push({
      ...s,
      size,
      status:"open"
    });

    save(TRADES_FILE,trades);

    await send(
`🚨 SNIPER PRO

${s.asset} (Score: ${s.score})
Mode: ${s.mode}

Entry: ${s.entry}
SL: ${s.sl}
TP: ${s.tp}

RR: ${s.rr}
Risk: ${(currentRisk*100).toFixed(1)}%`
    );

    console.log("Signal:", s.asset, s.score);
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
setInterval(()=>{},60000);
