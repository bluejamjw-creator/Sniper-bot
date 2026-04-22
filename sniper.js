// ================================================================
// SNIPER V19 FINAL+
// Balanced Breakout Engine (REALISTIC + USABLE)
// GBP + Fees + Min Stake Buffer + Soft BTC Filter + Stable Server
// ================================================================

console.log("🚀 SNIPER V19 FINAL+ STARTING...");

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

const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 56);
const MAX_SIGNALS = Number(process.env.MAX_SIGNALS || 3);

const SPREAD_PCT = Number(process.env.SPREAD_PCT || 0.02);
const MIN_PROFIT_GBP = Number(process.env.MIN_PROFIT_GBP || 2);
const MIN_PROFIT_BUFFER = Number(process.env.MIN_PROFIT_BUFFER || 0.03); // 3% extra above friction
const MIN_STAKE_BUFFER_MULT = Number(process.env.MIN_STAKE_BUFFER_MULT || 1.3);
const MAX_MIN_STAKE = Number(process.env.MAX_MIN_STAKE || 50);

const REVOLUT_PLAN = (process.env.REVOLUT_PLAN || "standard").toLowerCase();
const MONTHLY_VOLUME_GBP = Number(process.env.MONTHLY_VOLUME_GBP || 0);

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
      { chat_id: CHAT_ID, text: msg },
      { timeout: 15000 }
    );
  } catch (e) {
    console.error("TELEGRAM_ERROR:", e.message);
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
  if (!arr || !arr.length) return null;
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

function getRevolutFeePct(plan, monthlyVolumeGBP) {
  const tiers = [
    { max: 10000, standard: 0.0149, plus: 0.0149, premium: 0.0099, metal: 0.0099, ultra: 0.0049 },
    { max: 50000, standard: 0.0129, plus: 0.0129, premium: 0.0079, metal: 0.0079, ultra: 0.0039 },
    { max: 100000, standard: 0.0109, plus: 0.0109, premium: 0.0059, metal: 0.0059, ultra: 0.0029 },
    { max: 250000, standard: 0.0089, plus: 0.0089, premium: 0.0049, metal: 0.0049, ultra: 0.0019 },
    { max: Infinity, standard: 0.0049, plus: 0.0049, premium: 0.0029, metal: 0.0029, ultra: 0.0 }
  ];

  const tier = tiers.find(t => monthlyVolumeGBP < t.max) || tiers[tiers.length - 1];
  return tier[plan] ?? tier.standard;
}

function totalFrictionPct(feePct) {
  return feePct + feePct + SPREAD_PCT;
}

function realBuy(price, feePct) {
  return price * (1 + feePct + SPREAD_PCT);
}

function realSell(price, feePct) {
  return price * (1 - feePct - SPREAD_PCT);
}

function minStakeRequired(entry, tp, feePct) {
  const effectiveEntry = realBuy(entry, feePct);
  const effectiveExit = realSell(tp, feePct);
  const netPct = (effectiveExit - effectiveEntry) / effectiveEntry;

  if (netPct <= 0) return Infinity;
  return (MIN_PROFIT_GBP * MIN_STAKE_BUFFER_MULT) / netPct;
}

// ============================
// FX
// ============================

let GBP = 0.79;

async function updateFX() {
  try {
    const { data } = await axios.get(
      "https://open.er-api.com/v6/latest/USD",
      { timeout: 15000 }
    );
    if (data?.rates?.GBP) GBP = data.rates.GBP;
  } catch (e) {
    console.error("FX_ERROR:", e.message);
  }
}

const toGBP = v => v * GBP;

// ============================
// BTC TREND
// ============================

let btcTrend = "neutral";

async function updateBTC() {
  try {
    const { data } = await axios.get(
      "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=55",
      { timeout: 15000 }
    );

    const closes = data.map(x => +x[4]);
    const e20 = ema(closes.slice(-30), 20);
    const e50 = ema(closes.slice(-50), 50);
    const price = closes.at(-1);

    if (!e20 || !e50 || !price) {
      btcTrend = "neutral";
      return;
    }

    if (price > e20 && e20 > e50) btcTrend = "up";
    else if (price < e20 && e20 < e50) btcTrend = "down";
    else btcTrend = "neutral";
  } catch (e) {
    console.error("BTC_ERROR:", e.message);
    btcTrend = "neutral";
  }
}

// ============================
// PAIRS
// ============================

async function getPairs() {
  try {
    const { data } = await axios.get(
      "https://api.binance.com/api/v3/ticker/24hr",
      { timeout: 15000 }
    );

    return data
      .filter(x => x.symbol.endsWith("USDT"))
      .filter(x => parseFloat(x.quoteVolume) > 1000000)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 40)
      .map(x => x.symbol);
  } catch (e) {
    console.error("PAIRS_ERROR:", e.message);
    return [];
  }
}

// ============================
// ANALYSIS
// ============================

function analyse(symbol, candles) {
  if (!candles || candles.length < 50) return null;

  const feePct = getRevolutFeePct(REVOLUT_PLAN, MONTHLY_VOLUME_GBP);

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const vols = candles.map(c => c.v);

  const last = closes.at(-1);
  const prev = closes.at(-2);
  const ema9 = ema(closes.slice(-30), 9);
  const ema21 = ema(closes.slice(-50), 21);

  if (!last || !prev || !ema9 || !ema21) return null;
  if (ema9 <= ema21) return null;

  const priorHigh = Math.max(...highs.slice(-21, -1));
  const breakout = last >= priorHigh * 0.998;
  const nearBreakout = last >= priorHigh * 0.992;

  const momentum = (last - prev) / prev;
  if (momentum < 0.001) return null;

  const avgVol = avg(vols.slice(-20));
  const volRatio = avgVol ? vols.at(-1) / avgVol : 0;
  if (volRatio < 1.2) return null;

  let confidence = 50;
  if (breakout) confidence += 14;
  else if (nearBreakout) confidence += 8;
  if (momentum > 0.0025) confidence += 8;
  if (momentum > 0.004) confidence += 6;
  if (volRatio > 1.4) confidence += 6;
  if (volRatio > 1.8) confidence += 6;
  if (btcTrend === "up") confidence += 6;
  if (btcTrend === "down") confidence -= 10;

  confidence = Math.round(clamp(confidence, 0, 99));
  if (confidence < MIN_CONFIDENCE) return null;

  const frictionPct = totalFrictionPct(feePct);
  const minMove = frictionPct + MIN_PROFIT_BUFFER;

  const entry = last;
  const sl = entry * 0.97;
  const tp = entry * (1 + minMove);

  const minStake = minStakeRequired(entry, tp, feePct);
  if (minStake > MAX_MIN_STAKE) return null;

  const grossMovePct = ((tp - entry) / entry) * 100;
  const effectiveEntry = realBuy(entry, feePct);
  const effectiveExit = realSell(tp, feePct);
  const netMovePct = ((effectiveExit - effectiveEntry) / effectiveEntry) * 100;

  return {
    asset: symbol,
    entry,
    sl,
    tp,
    confidence,
    minStake,
    feePct,
    frictionPct,
    grossMovePct,
    netMovePct,
    btcTrend,
    breakout,
    nearBreakout,
    volRatio
  };
}

// ============================
// FETCH
// ============================

async function fetchCandles(symbol) {
  try {
    const { data } = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=120`,
      { timeout: 15000 }
    );

    return data.map(k => ({
      c: +k[4],
      h: +k[2],
      v: +k[5]
    }));
  } catch (e) {
    console.error(`FETCH_ERROR ${symbol}:`, e.message);
    return null;
  }
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
    const data = await fetchCandles(p);
    const r = analyse(p, data);
    if (r) results.push(r);
  }

  return results
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.minStake - b.minStake;
    })
    .slice(0, MAX_SIGNALS);
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
      if (trades.find(t => t.asset === s.asset && t.status !== "closed")) continue;

      trades.push({
        ...s,
        status: "open",
        createdAt: new Date().toISOString()
      });

      await send(
`🚨 V19 BREAKOUT

${s.asset}
Confidence: ${s.confidence}
BTC Trend: ${s.btcTrend}
Breakout: ${s.breakout ? "YES" : s.nearBreakout ? "NEAR" : "NO"}

Entry: ${fmtGBP(toGBP(s.entry))}
SL: ${fmtGBP(toGBP(s.sl))}
TP: ${fmtGBP(toGBP(s.tp))}

Gross move: ${s.grossMovePct.toFixed(2)}%
Net move est: ${s.netMovePct.toFixed(2)}%
Friction est: ${(s.frictionPct * 100).toFixed(2)}%
Vol ratio: ${s.volRatio.toFixed(2)}x
Fee tier: ${(s.feePct * 100).toFixed(2)}%

Min Stake: ${fmtGBP(s.minStake)}`
      );
    }

    save(TRADES_FILE, trades);
  } catch (e) {
    console.error("RUN_ERROR:", e.message);
  } finally {
    running = false;
  }
}

// ============================
// SERVER
// ============================

app.get("/", (_req, res) => res.send("V19 FINAL+ RUNNING 🚀"));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    gbp: GBP,
    btcTrend
  });
});

app.get("/trades", (_req, res) => {
  res.json(load(TRADES_FILE));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("API running", PORT);
  runCycle();
  setInterval(runCycle, 300000);
});
