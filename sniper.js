// ================================================================
// SNIPER V19 FINAL
// Balanced Breakout Engine (REALISTIC + USABLE)
// GBP + Fees + Minimum Stake + Stable Server
// ================================================================

console.log("🚀 SNIPER V19 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ============================
// CONFIG
// ============================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const DATA_DIR = "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TRADES_FILE = path.join(DATA_DIR, "trades.json");

const MIN_CONFIDENCE = 60;
const MAX_SIGNALS = 3;

// 🔥 KEY SETTINGS (BALANCED)
const SPREAD_PCT = 0.02;
const MIN_PROFIT_BUFFER = 0.02; // 2%
const MIN_PROFIT_GBP = 2;
const MAX_MIN_STAKE = 50;

// ============================
// STORAGE
// ============================

const load = f => {
  try {
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { return []; }
};

const save = (f, d) => {
  fs.writeFileSync(f, JSON.stringify(d, null, 2));
};

// ============================
// TELEGRAM
// ============================

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: msg
    });
  } catch {}
}

// ============================
// HELPERS
// ============================

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function avg(arr) {
  return arr.reduce((a,b)=>a+b,0)/arr.length;
}

// ============================
// FEES
// ============================

function totalCost() {
  return 0.0149 * 2 + SPREAD_PCT; // buy+sell+spread
}

function realBuy(price) {
  return price * (1 + 0.0149 + SPREAD_PCT);
}

function realSell(price) {
  return price * (1 - 0.0149 - SPREAD_PCT);
}

function netProfitPct(entry, exit) {
  return (realSell(exit) - realBuy(entry)) / realBuy(entry);
}

// ============================
// MIN STAKE LOGIC
// ============================

function minStakeRequired(entry, tp) {
  const move = (tp - entry) / entry;
  const net = move - totalCost();

  if (net <= 0) return Infinity;

  return MIN_PROFIT_GBP / net;
}

// ============================
// FX
// ============================

let GBP = 0.79;

async function updateFX() {
  try {
    const { data } = await axios.get("https://api.exchangerate-api.com/v4/latest/USD");
    GBP = data.rates.GBP;
  } catch {}
}

const toGBP = v => v * GBP;

// ============================
// BTC TREND
// ============================

let btcTrend = "neutral";

async function updateBTC() {
  try {
    const { data } = await axios.get(
      "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=55"
    );

    const closes = data.map(x => +x[4]);
    const e20 = ema(closes.slice(-30), 20);
    const e50 = ema(closes.slice(-50), 50);
    const price = closes.at(-1);

    btcTrend = price > e20 && e20 > e50 ? "up" : "down";
  } catch {}
}

// ============================
// PAIRS
// ============================

async function getPairs() {
  try {
    const { data } = await axios.get("https://api.binance.com/api/v3/ticker/24hr");

    return data
      .filter(x => x.symbol.endsWith("USDT"))
      .sort((a,b)=>parseFloat(b.quoteVolume)-parseFloat(a.quoteVolume))
      .slice(0,30)
      .map(x => x.symbol);
  } catch {
    return [];
  }
}

// ============================
// ANALYSIS (BALANCED)
// ============================

function analyse(symbol, candles) {

  if (!candles || candles.length < 50) return null;

  const closes = candles.map(c=>c.c);
  const highs = candles.map(c=>c.h);
  const vols = candles.map(c=>c.v);

  const last = closes.at(-1);
  const prev = closes.at(-2);

  const ema9 = ema(closes.slice(-30),9);
  const ema21 = ema(closes.slice(-50),21);

  if (ema9 <= ema21) return null;

  const high = Math.max(...highs.slice(-20));
  const breakout = last > high * 0.998;

  const momentum = (last - prev)/prev;
  if (momentum < 0.0015) return null;

  const avgVol = avg(vols.slice(-20));
  const volRatio = vols.at(-1) / avgVol;
  if (volRatio < 1.8) return null;

  if (btcTrend === "down") return null;

  let confidence = 60;
  if (breakout) confidence += 15;
  if (momentum > 0.003) confidence += 10;
  if (volRatio > 2.2) confidence += 10;

  if (confidence < MIN_CONFIDENCE) return null;

  const entry = last;
  const sl = entry * 0.97;
  const tp = entry * 1.07;

  // 🔥 MIN STAKE FILTER
  const minStake = minStakeRequired(entry, tp);
  if (minStake > MAX_MIN_STAKE) return null;

  return {
    asset: symbol,
    entry,
    sl,
    tp,
    confidence,
    minStake
  };
}

// ============================
// FETCH
// ============================

async function fetch(symbol) {
  try {
    const { data } = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=120`
    );

    return data.map(k=>({
      c:+k[4],
      h:+k[2],
      v:+k[5]
    }));

  } catch { return null; }
}

// ============================
// SCAN
// ============================

async function scan() {

  console.log("=== V19 SCAN ===");

  await updateFX();
  await updateBTC();

  const pairs = await getPairs();
  const results = [];

  for (const p of pairs) {
    const data = await fetch(p);
    const r = analyse(p, data);
    if (r) results.push(r);
  }

  return results
    .sort((a,b)=>b.confidence-a.confidence)
    .slice(0,MAX_SIGNALS);
}

// ============================
// MAIN LOOP
// ============================

let running = false;

async function runCycle() {
  if (running) return;
  running = true;

  try {

    const signals = await scan();
    const trades = load(TRADES_FILE);

    console.log("Signals:", signals.length);

    for (const s of signals) {

      if (trades.find(t=>t.asset===s.asset && t.status!=="closed"))
        continue;

      trades.push({...s,status:"open"});

      await send(
`🚨 V19 BREAKOUT

${s.asset}
Confidence: ${s.confidence}

Entry: £${toGBP(s.entry).toFixed(3)}
SL: £${toGBP(s.sl).toFixed(3)}
TP: £${toGBP(s.tp).toFixed(3)}

Min Stake: £${s.minStake.toFixed(2)}`
      );
    }

    save(TRADES_FILE,trades);

  } catch(e) {
    console.error(e.message);
  }

  running = false;
}

// ============================
// SERVER
// ============================

app.get("/", (_req,res)=>res.send("V19 RUNNING 🚀"));

app.get("/health", (_req,res)=>{
  res.json({status:"ok", time:new Date()});
});

app.listen(PORT,"0.0.0.0",()=>{
  console.log("API running",PORT);
  runCycle();
  setInterval(runCycle,300000);
});
