// ================================================================
// SNIPER V25
// Smarter breakout engine
// Crypto + Stocks swing breakout scanner
// Improved breakout confirmation
// Dynamic SL/TP
// Trend strength filter
// Better volume filtering
// Fakeout reduction
// Retest-style momentum logic
// ================================================================

console.log("🚀 SNIPER V25 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const DATA_DIR = process.env.DATA_DIR || "./data";

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const TRADES_FILE = path.join(DATA_DIR, "trades.json");
const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");

// ================================================================
// SETTINGS
// ================================================================

const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 84);

const MAX_SIGNALS = Number(process.env.MAX_SIGNALS || 3);

const MAX_OPEN_TRADES =
  Number(process.env.MAX_OPEN_TRADES || 3);

const COOLDOWN_HOURS =
  Number(process.env.COOLDOWN_HOURS || 24);

const MIN_MOMENTUM =
  Number(process.env.MIN_MOMENTUM || 0.003);

const MIN_VOL_RATIO =
  Number(process.env.MIN_VOL_RATIO || 1.35);

const BREAKOUT_BUFFER =
  Number(process.env.BREAKOUT_BUFFER || 1.002);

const MAX_MIN_STAKE =
  Number(process.env.MAX_MIN_STAKE || 200);

const SPREAD_PCT =
  Number(process.env.SPREAD_PCT || 0.02);

const MIN_PROFIT_GBP =
  Number(process.env.MIN_PROFIT_GBP || 2);

const MIN_PROFIT_BUFFER =
  Number(process.env.MIN_PROFIT_BUFFER || 0.04);

const MIN_STAKE_BUFFER_MULT =
  Number(process.env.MIN_STAKE_BUFFER_MULT || 1.3);

const ENABLE_STOCKS =
  String(process.env.ENABLE_STOCKS || "true")
    .toLowerCase() === "true";

const REVOLUT_PLAN =
  (process.env.REVOLUT_PLAN || "standard")
    .toLowerCase();

const MONTHLY_VOLUME_GBP =
  Number(process.env.MONTHLY_VOLUME_GBP || 0);

// ================================================================

const STOCK_POOL = [
  "AAPL","MSFT","NVDA","TSLA","AMD",
  "META","GOOG","AMZN","PLTR","COIN",
  "MSTR","SMCI","NFLX","CRM","ADBE",
  "INTC","BA","DIS","PYPL","UBER",
  "SHOP","XYZ","ROKU","SNOW"
];

const STATIC_CRYPTO_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT",
  "XRPUSDT","BNBUSDT","DOGEUSDT",
  "AVAXUSDT","LINKUSDT","ADAUSDT",
  "NEARUSDT","DOTUSDT","TRXUSDT",
  "APTUSDT","ARBUSDT","OPUSDT",
  "SUIUSDT","INJUSDT","SEIUSDT",
  "ATOMUSDT","AAVEUSDT","PEPEUSDT"
];

const BINANCE_BASES = [
  "https://data-api.binance.vision",
  "https://api.binance.com"
];

let GBP = 0.79;
let btcTrend = "neutral";
let running = false;

// ================================================================
// HELPERS
// ================================================================

function nowIso() {
  return new Date().toISOString();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function avg(arr) {
  if (!arr?.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmtGBP(v) {
  return `£${Number(v).toFixed(2)}`;
}

function fmtUSD(v) {
  return `$${Number(v).toFixed(2)}`;
}

function load(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function ema(values, period) {
  if (!values || values.length < period) return null;

  const k = 2 / (period + 1);

  let e = values[0];

  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }

  return e;
}

function isFinitePositive(n) {
  return Number.isFinite(n) && n > 0;
}

function toGBP(v) {
  return v * GBP;
}

// ================================================================
// TELEGRAM
// ================================================================

async function send(msg) {

  if (!BOT_TOKEN || !CHAT_ID) return;

  try {

    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: msg
      },
      {
        timeout: 15000
      }
    );

  } catch (e) {

    console.error(
      "TELEGRAM_ERROR:",
      e.message
    );

  }
}

// ================================================================
// FX
// ================================================================

async function updateFX() {

  try {

    const { data } = await axios.get(
      "https://open.er-api.com/v6/latest/USD",
      {
        timeout: 15000
      }
    );

    if (data?.rates?.GBP) {
      GBP = data.rates.GBP;
    }

  } catch (e) {

    console.error(
      "FX_ERROR:",
      e.message
    );

  }
}

// ================================================================
// BINANCE
// ================================================================

async function safeBinanceGet(endpoint, params = {}) {

  for (const base of BINANCE_BASES) {

    try {

      const { data } = await axios.get(
        `${base}${endpoint}`,
        {
          params,
          timeout: 10000
        }
      );

      return data;

    } catch (e) {

      console.error(
        "BINANCE_FAIL:",
        base,
        e.message
      );

    }
  }

  throw new Error("Binance failed");
}

async function getCryptoPairs() {

  const data = await safeBinanceGet(
    "/api/v3/ticker/24hr"
  );

  return data
    .filter(x => x.symbol.endsWith("USDT"))
    .filter(x => Number(x.quoteVolume) > 1000000)
    .sort((a, b) =>
      Number(b.quoteVolume) -
      Number(a.quoteVolume)
    )
    .slice(0, 40)
    .map(x => x.symbol);
}

async function fetchCryptoCandles(symbol) {

  const data = await safeBinanceGet(
    "/api/v3/klines",
    {
      symbol,
      interval: "1h",
      limit: 120
    }
  );

  return data
    .map(k => ({
      c: +k[4],
      h: +k[2],
      v: +k[5]
    }))
    .filter(x =>
      isFinitePositive(x.c) &&
      isFinitePositive(x.h)
    );
}

// ================================================================
// STOCKS
// ================================================================

async function fetchStockCandles(symbol) {

  try {

    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=3mo&interval=1d`;

    const { data } = await axios.get(
      url,
      {
        timeout: 15000,
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      }
    );

    const result =
      data?.chart?.result?.[0];

    const quote =
      result?.indicators?.quote?.[0];

    if (!quote) return null;

    return (quote.close || [])
      .map((c, i) => ({
        c: Number(c),
        h: Number(quote.high?.[i]),
        v: Number(quote.volume?.[i] || 0)
      }))
      .filter(x =>
        isFinitePositive(x.c) &&
        isFinitePositive(x.h)
      );

  } catch (e) {

    console.error(
      "STOCK_FETCH_FAIL:",
      symbol,
      e.response?.status || e.message
    );

    return null;
  }
}

// ================================================================
// BTC TREND
// ================================================================

async function updateBTCTrend() {

  try {

    const data = await safeBinanceGet(
      "/api/v3/klines",
      {
        symbol: "BTCUSDT",
        interval: "4h",
        limit: 55
      }
    );

    const closes =
      data.map(x => +x[4]);

    const e20 =
      ema(closes.slice(-30), 20);

    const e50 =
      ema(closes.slice(-50), 50);

    const price =
      closes.at(-1);

    if (
      price > e20 &&
      e20 > e50
    ) {
      btcTrend = "up";
    }

    else if (
      price < e20 &&
      e20 < e50
    ) {
      btcTrend = "down";
    }

    else {
      btcTrend = "neutral";
    }

  } catch {

    btcTrend = "neutral";

  }
}

// ================================================================
// ANALYSIS
// ================================================================

function analyseAsset(
  asset,
  candles,
  type
) {

  if (!candles || candles.length < 50) {
    return null;
  }

  const closes =
    candles.map(x => x.c);

  const highs =
    candles.map(x => x.h);

  const vols =
    candles.map(x => x.v || 0);

  const last =
    closes.at(-1);

  const prev =
    closes.at(-2);

  const ema9 =
    ema(closes.slice(-30), 9);

  const ema21 =
    ema(closes.slice(-50), 21);

  if (
    !last ||
    !prev ||
    !ema9 ||
    !ema21
  ) {
    return null;
  }

  const priorHigh =
    Math.max(
      ...highs.slice(-21, -1)
    );

  const momentum =
    (last - prev) / prev;

  const avgVol =
    avg(vols.slice(-20));

  const volRatio =
    (vols.at(-1) || 1) /
    (avgVol || 1);

  const trendStrength =
    ((ema9 - ema21) / ema21) * 100;

  // ============================================================
  // FILTERS
  // ============================================================

  if (momentum < MIN_MOMENTUM) {
    return null;
  }

  if (momentum > 0.08) {
    return null;
  }

  if (volRatio < MIN_VOL_RATIO) {
    return null;
  }

  if (trendStrength < 0.15) {
    return null;
  }

  const breakout =
    last >
    priorHigh * BREAKOUT_BUFFER &&
    momentum > 0.003;

  if (!breakout) {
    return null;
  }

  // ============================================================
  // CONFIDENCE
  // ============================================================

  let confidence = 50;

  confidence += 18;

  if (ema9 > ema21) {
    confidence += 12;
  }

  if (volRatio > 1.5) {
    confidence += 10;
  }

  if (volRatio > 2) {
    confidence += 6;
  }

  if (
    momentum > 0.005 &&
    momentum < 0.03
  ) {
    confidence += 8;
  }

  if (
    type === "crypto" &&
    btcTrend === "up"
  ) {
    confidence += 8;
  }

  confidence =
    clamp(
      Math.round(confidence),
      0,
      99
    );

  if (
    confidence < MIN_CONFIDENCE
  ) {
    return null;
  }

  // ============================================================
  // DYNAMIC RISK
  // ============================================================

  const recentRange =
    (
      Math.max(...highs.slice(-10)) -
      Math.min(...closes.slice(-10))
    ) / last;

  const stopPct =
    clamp(
      recentRange * 0.6,
      0.015,
      0.04
    );

  const takePct =
    stopPct * 2.2;

  const entry = last;

  const sl =
    entry * (1 - stopPct);

  const tp =
    entry * (1 + takePct);

  return {

    asset,

    type,

    confidence,

    breakout,

    btcTrend:
      type === "crypto"
        ? btcTrend
        : "n/a",

    entry,

    sl,

    tp,

    volRatio,

    grossMovePct:
      ((tp - entry) / entry) * 100

  };
}

// ================================================================
// HELPERS
// ================================================================

function hasOpenTrade(
  asset,
  trades
) {

  return trades.some(
    t =>
      t.asset === asset &&
      t.status !== "closed"
  );
}

// ================================================================
// SCAN
// ================================================================

async function scanAll() {

  await updateFX();

  await updateBTCTrend();

  const trades =
    load(TRADES_FILE);

  const results = [];

  let pairs = [];

  try {

    pairs =
      await getCryptoPairs();

  } catch {

    pairs =
      STATIC_CRYPTO_PAIRS;

  }

  // ============================================================
  // CRYPTO
  // ============================================================

  for (const pair of pairs) {

    if (
      hasOpenTrade(pair, trades)
    ) {
      continue;
    }

    const candles =
      await fetchCryptoCandles(pair);

    const signal =
      analyseAsset(
        pair,
        candles,
        "crypto"
      );

    if (signal) {
      results.push(signal);
    }
  }

  // ============================================================
  // STOCKS
  // ============================================================

  if (ENABLE_STOCKS) {

    for (const stock of STOCK_POOL) {

      if (
        hasOpenTrade(stock, trades)
      ) {
        continue;
      }

      const candles =
        await fetchStockCandles(stock);

      const signal =
        analyseAsset(
          stock,
          candles,
          "stock"
        );

      if (signal) {
        results.push(signal);
      }
    }
  }

  return results
    .sort(
      (a, b) =>
        b.confidence -
        a.confidence
    )
    .slice(0, MAX_SIGNALS);
}

// ================================================================
// MANAGE TRADES
// ================================================================

async function manageTrades() {

  const trades =
    load(TRADES_FILE);

  let changed = false;

  for (const t of trades) {

    if (t.status === "closed") {
      continue;
    }

    try {

      let price = null;

      if (t.type === "crypto") {

        const candles =
          await fetchCryptoCandles(
            t.asset
          );

        price =
          candles?.at(-1)?.c;

      } else {

        const candles =
          await fetchStockCandles(
            t.asset
          );

        price =
          candles?.at(-1)?.c;
      }

      if (!price) {
        continue;
      }

      // ========================================================

      if (price >= t.tp) {

        t.status = "closed";

        t.exit = price;

        t.closedAt = nowIso();

        changed = true;

        await send(
          `💰 TP HIT: ${t.asset}`
        );
      }

      else if (price <= t.sl) {

        t.status = "closed";

        t.exit = price;

        t.closedAt = nowIso();

        changed = true;

        await send(
          `❌ SL HIT: ${t.asset}`
        );
      }

    } catch (e) {

      console.error(
        "MANAGE_ERROR:",
        t.asset,
        e.message
      );

    }
  }

  if (changed) {
    save(TRADES_FILE, trades);
  }
}

// ================================================================
// MAIN LOOP
// ================================================================

async function runCycle() {

  if (running) return;

  running = true;

  try {

    const trades =
      load(TRADES_FILE);

    const openTrades =
      trades.filter(
        t => t.status !== "closed"
      );

    if (
      openTrades.length >=
      MAX_OPEN_TRADES
    ) {
      return;
    }

    const signals =
      await scanAll();

    console.log(
      "Signals:",
      signals.length
    );

    for (const s of signals) {

      const msg =
`${s.type === "crypto"
  ? "CRYPTO ALERT"
  : "STOCK ALERT"}

${s.asset}

Confidence: ${s.confidence}

Breakout: ${
  s.breakout ? "YES" : "NO"
}

Entry: ${
  s.type === "crypto"
    ? fmtGBP(toGBP(s.entry))
    : fmtUSD(s.entry)
}

SL: ${
  s.type === "crypto"
    ? fmtGBP(toGBP(s.sl))
    : fmtUSD(s.sl)
}

TP: ${
  s.type === "crypto"
    ? fmtGBP(toGBP(s.tp))
    : fmtUSD(s.tp)
}

Vol Ratio:
${s.volRatio.toFixed(2)}x

Potential:
${s.grossMovePct.toFixed(2)}%
`;

      await send(msg);

      trades.push({

        ...s,

        status: "open",

        createdAt: nowIso()

      });
    }

    save(TRADES_FILE, trades);

    await manageTrades();

  } catch (e) {

    console.error(
      "RUN_ERROR:",
      e.message
    );

  } finally {

    running = false;

  }
}

// ================================================================
// API
// ================================================================

app.get("/", (_req, res) => {

  res.send(
    "SNIPER V25 RUNNING 🚀"
  );

});

app.get("/health", (_req, res) => {

  res.json({

    status: "ok",

    btcTrend,

    time: nowIso()

  });

});

app.get("/trades", (_req, res) => {

  res.json(
    load(TRADES_FILE)
  );

});

// ================================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `API running on ${PORT}`
    );

    runCycle();

    setInterval(
      runCycle,
      300000
    );

  }
);
