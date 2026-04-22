// ================================================================
// SNIPER V20 FINAL (STABLE + TUNED FOR DAILY SIGNALS)
// ================================================================

console.log("🚀 SNIPER V20 STARTING...");

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

const DATA_DIR = process.env.DATA_DIR || "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TRADES_FILE = path.join(DATA_DIR, "trades.json");

// 🔥 TUNED SETTINGS
const MIN_CONFIDENCE = 54;
const MAX_SIGNALS = 3;

const SPREAD_PCT = 0.02;
const MIN_PROFIT_GBP = 2;
const MIN_PROFIT_BUFFER = 0.03;
const MIN_STAKE_BUFFER_MULT = 1.3;
const MAX_MIN_STAKE = 50;

// Revolut fee
const REVOLUT_PLAN = "standard";
const MONTHLY_VOLUME_GBP = 0;

// Fallback pairs
const STATIC_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT",
  "DOGEUSDT","AVAXUSDT","LINKUSDT","ADAUSDT","NEARUSDT"
];

const BINANCE_BASES = [
  "https://api.binance.com",
  "https://data-api.binance.vision"
];

let dataSource = "binance";

// ============================
// STORAGE
// ============================

const load = f => {
  try {
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return [];
  }
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
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text: msg }
    );
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

// ============================
// HELPERS
// ============================

function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function fmtGBP(v) {
  return `£${Number(v).toFixed(2)}`;
}

// ============================
// FEES
// ============================

function getRevolutFeePct() {
  return 0.0149; // standard
}

function realBuy(p, fee) {
  return p * (1 + fee + SPREAD_PCT);
}

function realSell(p, fee) {
  return p * (1 - fee - SPREAD_PCT);
}

function minStakeRequired(entry, tp, fee) {
  const buy = realBuy(entry, fee);
  const sell = realSell(tp, fee);
  const net = (sell - buy) / buy;

  if (net <= 0) return Infinity;

  return (MIN_PROFIT_GBP * MIN_STAKE_BUFFER_MULT) / net;
}

// ============================
// FX
// ============================

let GBP = 0.79;

async function updateFX() {
  try {
    const { data } = await axios.get("https://open.er-api.com/v6/latest/USD");
    if (data?.rates?.GBP) GBP = data.rates.GBP;
  } catch {}
}

const toGBP = v => v * GBP;

// ============================
// SAFE FETCH
// ============================

async function safeGet(endpoint, params = {}) {
  for (const base of BINANCE_BASES) {
    try {
      const { data } = await axios.get(`${base}${endpoint}`, { params });

      dataSource = base.includes("vision")
        ? "binance_vision"
        : "binance";

      return data;
    } catch (e) {
      console.log("Binance fail:", e.response?.status);
    }
  }
  throw new Error("Binance failed");
}

// ============================
// BTC TREND
// ============================

let btcTrend = "neutral";

async function updateBTC() {
  try {
    const data = await safeGet("/api/v3/klines", {
      symbol: "BTCUSDT",
      interval: "4h",
      limit: 55
    });

    const closes = data.map(x => +x[4]);
    const e20 = ema(closes.slice(-30), 20);
    const e50 = ema(closes.slice(-50), 50);
    const price = closes.at(-1);

    btcTrend = price > e20 && e20 > e50 ? "up" : "down";
  } catch {
    btcTrend = "neutral";
  }
}

// ============================
// PAIRS
// ============================

async function getPairs() {
  try {
    const data = await safeGet("/api/v3/ticker/24hr");

    return data
      .filter(x => x.symbol.endsWith("USDT"))
      .slice(0, 40)
      .map(x => x.symbol);

  } catch {
    dataSource = "static";
    return STATIC_PAIRS;
  }
}

// ============================
// CANDLES
// ============================

async function fetchCandles(symbol) {
  try {
    const data = await safeGet("/api/v3/klines", {
      symbol,
      interval: "1h",
      limit: 120
    });

    return data.map(k => ({
      c: +k[4],
      h: +k[2],
      v: +k[5]
    }));

  } catch {
    return null;
  }
}

// ============================
// ANALYSIS
// ============================

function analyse(symbol, candles) {
  if (!candles || candles.length < 50) return null;

  const fee = getRevolutFeePct();

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const vols = candles.map(c => c.v);

  const last = closes.at(-1);
  const prev = closes.at(-2);

  const ema9 = ema(closes.slice(-30), 9);
  const ema21 = ema(closes.slice(-50), 21);

  if (!ema9 || !ema21 || ema9 <= ema21) return null;

  const high = Math.max(...highs.slice(-20));

  const breakout = last >= high * 0.997;
  const nearBreakout = last >= high * 0.988;

  const momentum = (last - prev) / prev;
  if (momentum < 0.0008) return null;

  const volRatio = vols.at(-1) / avg(vols.slice(-20));
  if (volRatio < 1.1) return null;

  let confidence = 50;

  if (breakout) confidence += 14;
  else if (nearBreakout) confidence += 8;

  if (momentum > 0.0025) confidence += 8;
  if (volRatio > 1.4) confidence += 6;

  if (btcTrend === "up") confidence += 6;
  if (btcTrend === "down") confidence -= 10;

  confidence = clamp(confidence, 0, 99);

  if (confidence < MIN_CONFIDENCE) return null;

  const friction = fee * 2 + SPREAD_PCT;
  const minMove = friction + MIN_PROFIT_BUFFER + 0.01;

  const entry = last;
  const sl = entry * 0.97;
  const tp = entry * (1 + minMove);

  let minStake = minStakeRequired(entry, tp, fee);

  if (minStake > MAX_MIN_STAKE) return null;
  if (minStake < 10) minStake = 10;

  return {
    asset: symbol,
    entry,
    sl,
    tp,
    confidence,
    minStake,
    volRatio,
    breakout
  };
}

// ============================
// SCAN
// ============================

async function scan() {
  console.log("=== V20 SCAN ===");

  await updateFX();
  await updateBTC();

  const pairs = await getPairs();
  const results = [];

  for (const p of pairs) {
    const data = await fetchCandles(p);
    const r = analyse(p, data);
    if (r) results.push(r);
  }

  return results
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_SIGNALS);
}

// ============================
// RUN LOOP
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
      if (trades.find(t => t.asset === s.asset)) continue;

      trades.push({ ...s, status: "open" });

      await send(
`🚨 V20 SIGNAL

${s.asset}
Confidence: ${s.confidence}
Source: ${dataSource}

Entry: ${fmtGBP(toGBP(s.entry))}
SL: ${fmtGBP(toGBP(s.sl))}
TP: ${fmtGBP(toGBP(s.tp))}

Vol: ${s.volRatio.toFixed(2)}x
Min Stake: ${fmtGBP(s.minStake)}`
      );
    }

    save(TRADES_FILE, trades);

  } catch (e) {
    console.log("RUN ERROR:", e.message);
  }

  running = false;
}

// ============================
// SERVER
// ============================

app.get("/", (_, res) => res.send("V20 RUNNING"));

app.listen(PORT, () => {
  console.log("API running on", PORT);
  runCycle();
  setInterval(runCycle, 300000);
});
