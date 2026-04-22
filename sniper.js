// ================================================================
// SNIPER V21 (KRAKEN VERSION - NO BINANCE)
// ================================================================

console.log("🚀 SNIPER V21 STARTING...");

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

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const TRADES_FILE = path.join(DATA_DIR, "trades.json");

const MIN_CONFIDENCE = 54;
const MAX_SIGNALS = 3;

const SPREAD_PCT = 0.02;
const MIN_PROFIT_GBP = 2;
const MIN_PROFIT_BUFFER = 0.03;
const MIN_STAKE_BUFFER_MULT = 1.3;
const MAX_MIN_STAKE = 50;

// ============================
// KRAKEN PAIRS
// ============================

const PAIRS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "ADAUSDT",
  "DOTUSDT",
  "NEARUSDT"
];

const KRAKEN_MAP = {
  BTCUSDT: "XBTUSD",
  ETHUSDT: "ETHUSD",
  SOLUSDT: "SOLUSD",
  XRPUSDT: "XRPUSD",
  DOGEUSDT: "DOGEUSD",
  AVAXUSDT: "AVAXUSD",
  LINKUSDT: "LINKUSD",
  ADAUSDT: "ADAUSD",
  DOTUSDT: "DOTUSD",
  NEARUSDT: "NEARUSD"
};

let dataSource = "kraken";

// ============================
// STORAGE
// ============================

const load = file => {
  try {
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
};

const save = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// ============================
// TELEGRAM
// ============================

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: msg
      }
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
  return 0.0149;
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
    const { data } = await axios.get(
      "https://open.er-api.com/v6/latest/USD"
    );

    if (data?.rates?.GBP) {
      GBP = data.rates.GBP;
    }

  } catch {}
}

const toGBP = v => v * GBP;

// ============================
// KRAKEN CANDLES
// ============================

async function fetchCandles(symbol) {

  try {

    const pair = KRAKEN_MAP[symbol];

    const url =
      `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=60`;

    const { data } = await axios.get(url);

    if (!data.result) {
      console.log("Kraken fail:", symbol);
      return null;
    }

    const resultKey = Object.keys(data.result)
      .find(k => k !== "last");

    if (!resultKey) return null;

    return data.result[resultKey]
      .slice(-120)
      .map(c => ({
        c: +c[4],
        h: +c[2],
        v: +c[6]
      }));

  } catch (e) {

    console.log("Kraken error:", symbol, e.message);

    return null;
  }
}

// ============================
// BTC TREND
// ============================

let btcTrend = "neutral";

async function updateBTC() {

  try {

    const candles = await fetchCandles("BTCUSDT");

    if (!candles || candles.length < 50) {
      btcTrend = "neutral";
      return;
    }

    const closes = candles.map(c => c.c);

    const e20 = ema(closes.slice(-30), 20);
    const e50 = ema(closes.slice(-50), 50);

    const price = closes.at(-1);

    btcTrend =
      price > e20 && e20 > e50
        ? "up"
        : "down";

  } catch {

    btcTrend = "neutral";
  }
}

// ============================
// ANALYSIS
// ============================

function analyse(symbol, candles) {

  if (!candles || candles.length < 50) {
    return null;
  }

  const fee = getRevolutFeePct();

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const vols = candles.map(c => c.v);

  const last = closes.at(-1);
  const prev = closes.at(-2);

  const ema9 = ema(closes.slice(-30), 9);
  const ema21 = ema(closes.slice(-50), 21);

  if (!ema9 || !ema21 || ema9 <= ema21) {
    return null;
  }

  const high = Math.max(...highs.slice(-20));

  const breakout = last >= high * 0.997;
  const nearBreakout = last >= high * 0.988;

  const momentum = (last - prev) / prev;

  if (momentum < 0.0008) {
    return null;
  }

  const volRatio =
    vols.at(-1) / avg(vols.slice(-20));

  if (volRatio < 1.1) {
    return null;
  }

  let confidence = 50;

  if (breakout) confidence += 14;
  else if (nearBreakout) confidence += 8;

  if (momentum > 0.0025) confidence += 8;

  if (volRatio > 1.4) confidence += 6;

  if (btcTrend === "up") confidence += 6;

  if (btcTrend === "down") confidence -= 10;

  confidence = clamp(confidence, 0, 99);

  if (confidence < MIN_CONFIDENCE) {
    return null;
  }

  const friction =
    fee * 2 +
    SPREAD_PCT;

  const minMove =
    friction +
    MIN_PROFIT_BUFFER +
    0.01;

  const entry = last;

  const sl = entry * 0.97;

  const tp = entry * (1 + minMove);

  let minStake =
    minStakeRequired(entry, tp, fee);

  if (minStake > MAX_MIN_STAKE) {
    return null;
  }

  if (minStake < 10) {
    minStake = 10;
  }

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

  console.log("=== V21 SCAN ===");

  await updateFX();

  await updateBTC();

  const results = [];

  for (const pair of PAIRS) {

    const candles =
      await fetchCandles(pair);

    const signal =
      analyse(pair, candles);

    if (signal) {
      results.push(signal);
    }
  }

  return results
    .sort((a, b) =>
      b.confidence - a.confidence
    )
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

      if (
        trades.find(t => t.asset === s.asset)
      ) {
        continue;
      }

      trades.push({
        ...s,
        status: "open"
      });

      await send(

`🚨 V21 SIGNAL

${s.asset}

Confidence: ${s.confidence}

Source: ${dataSource}

Entry: ${fmtGBP(toGBP(s.entry))}
SL: ${fmtGBP(toGBP(s.sl))}
TP: ${fmtGBP(toGBP(s.tp))}

Volume: ${s.volRatio.toFixed(2)}x

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

app.get("/", (_, res) => {
  res.send("V21 KRAKEN SNIPER RUNNING");
});

app.listen(PORT, () => {

  console.log("API running on", PORT);

  runCycle();

  setInterval(runCycle, 300000);

});
