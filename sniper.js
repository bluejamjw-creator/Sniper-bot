// ================================================================
// SNIPER V38 ELITE STABLE
// Railway Safe Edition
// Crypto + Stocks Momentum Scanner
// Rate Limit Protected
// Auto Retry + Cooldowns
// ================================================================

console.log("🚀 SNIPER V38 ELITE STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// ================================================================
// CONFIG
// ================================================================

const PORT = process.env.PORT || 8080;

const BOT_TOKEN =
  process.env.BOT_TOKEN || "";

const CHAT_ID =
  process.env.CHAT_ID || "";

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const TRADES_FILE =
  path.join(DATA_DIR, "trades.json");

const ALERTS_FILE =
  path.join(DATA_DIR, "alerts.json");

// ================================================================
// SETTINGS
// ================================================================

const MAX_SIGNALS = 5;

const MAX_OPEN_TRADES = 5;

const COOLDOWN_HOURS = 6;

const SCAN_INTERVAL = 1000 * 60 * 5;

// ================================================================
// CRYPTO SETTINGS
// ================================================================

const CRYPTO_MIN_SCORE = 65;

const CRYPTO_MIN_VOL_RATIO = 1.3;

const CRYPTO_BREAKOUT_BUFFER = 1.0005;

const CRYPTO_MAX_EXTENSION = 0.03;

// ================================================================
// STOCK SETTINGS
// ================================================================

const STOCK_MIN_SCORE = 65;

const STOCK_MIN_RELVOL = 1.4;

const STOCK_BREAKOUT_BUFFER = 1.0005;

const STOCK_MAX_EXTENSION = 0.03;

// ================================================================
// STOCKS
// ================================================================

const STOCKS = [

  "NVDA",
  "TSLA",
  "PLTR",
  "AMD",
  "META",
  "COIN",
  "MSTR",
  "SMCI",
  "UBER",
  "NFLX",
  "AMZN",
  "AAPL",
  "MSFT",
  "GOOG"

];

// ================================================================
// BINANCE CRYPTOS
// ================================================================

const CRYPTOS = [

  {
    name: "bitcoin",
    symbol: "BTCUSDT"
  },

  {
    name: "ethereum",
    symbol: "ETHUSDT"
  },

  {
    name: "solana",
    symbol: "SOLUSDT"
  },

  {
    name: "ripple",
    symbol: "XRPUSDT"
  },

  {
    name: "dogecoin",
    symbol: "DOGEUSDT"
  },

  {
    name: "chainlink",
    symbol: "LINKUSDT"
  },

  {
    name: "avalanche",
    symbol: "AVAXUSDT"
  },

  {
    name: "near",
    symbol: "NEARUSDT"
  },

  {
    name: "render",
    symbol: "RENDERUSDT"
  },

  {
    name: "sui",
    symbol: "SUIUSDT"
  }

];

// ================================================================
// GLOBALS
// ================================================================

let running = false;

let btcTrend = "neutral";

let connectionDown = false;

// ================================================================
// FILE SETUP
// ================================================================

function ensureFiles() {

  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });

  if (!fs.existsSync(TRADES_FILE)) {
    fs.writeFileSync(TRADES_FILE, "[]");
  }

  if (!fs.existsSync(ALERTS_FILE)) {
    fs.writeFileSync(ALERTS_FILE, "[]");
  }

}

// ================================================================
// FILE HELPERS
// ================================================================

function load(file) {

  try {

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );

  } catch {

    return [];

  }

}

function save(file, data) {

  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2)
  );

}

// ================================================================
// HELPERS
// ================================================================

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );

}

function avg(arr) {

  if (!arr.length) {
    return 0;
  }

  return (
    arr.reduce(
      (a, b) => a + b,
      0
    ) / arr.length
  );

}

function ema(values, period) {

  if (!values.length) {
    return 0;
  }

  const k =
    2 / (period + 1);

  let out = values[0];

  for (
    let i = 1;
    i < values.length;
    i++
  ) {

    out =

      values[i] * k +

      out * (1 - k);

  }

  return out;

}

function hoursAgo(ts) {

  return (

    Date.now() -

    new Date(ts).getTime()

  ) / 36e5;

}

// ================================================================
// TELEGRAM
// ================================================================

async function send(msg) {

  if (!BOT_TOKEN || !CHAT_ID) {

    console.log(msg);

    return;

  }

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
      "TELEGRAM ERROR:",
      e.message
    );

  }

}

// ================================================================
// SAFE REQUEST
// ================================================================

async function safeGet(
  url,
  options = {}
) {

  try {

    const response =
      await axios.get(

        url,

        {

          timeout: 20000,

          ...options

        }

      );

    return response.data;

  } catch (e) {

    console.error(

      "REQUEST FAILED:",

      url,

      e.response?.status ||

      e.message

    );

    return null;

  }

}

// ================================================================
// CONNECTION CHECK
// ================================================================

async function checkConnection() {

  const data =
    await safeGet(
      "https://api.binance.com/api/v3/ping"
    );

  const online =
    !!data || data === "";

  if (
    !online &&
    !connectionDown
  ) {

    connectionDown = true;

    await send(
      "⚠️ CONNECTION LOST"
    );

  }

  if (
    online &&
    connectionDown
  ) {

    connectionDown = false;

    await send(
      "✅ CONNECTION RESTORED"
    );

  }

}

// ================================================================
// COOLDOWN
// ================================================================

function cooldown(asset) {

  const alerts =
    load(ALERTS_FILE);

  const found =

    [...alerts]

      .reverse()

      .find(
        a =>
          a.asset === asset
      );

  if (!found) {
    return false;
  }

  return (

    hoursAgo(
      found.sentAt
    ) < COOLDOWN_HOURS

  );

}

// ================================================================
// OPEN TRADES
// ================================================================

function hasOpenTrade(asset) {

  const trades =
    load(TRADES_FILE);

  return trades.some(

    t =>

      t.asset === asset &&

      t.status === "open"

  );

}

// ================================================================
// FETCH CRYPTO
// ================================================================

async function fetchCrypto(
  symbol
) {

  await sleep(500);

  const data =
    await safeGet(

      "https://api.binance.com/api/v3/klines",

      {

        params: {

          symbol,

          interval: "1h",

          limit: 200

        }

      }

    );

  if (!data) {

    console.error(
      "CRYPTO FETCH FAILED:",
      symbol
    );

    return null;

  }

  return data.map(c => ({

    close:
      parseFloat(c[4]),

    high:
      parseFloat(c[2]),

    volume:
      parseFloat(c[5])

  }));

}

// ================================================================
// FETCH STOCK
// ================================================================

async function fetchStock(
  symbol
) {

  await sleep(1000);

  const data =
    await safeGet(

      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,

      {

        params: {

          range: "5d",

          interval: "1h"

        },

        headers: {

          "User-Agent":

            "Mozilla/5.0",

          "Accept":

            "application/json,text/plain,*/*",

          "Referer":

            "https://finance.yahoo.com/"

        }

      }

    );

  const result =
    data?.chart?.result?.[0];

  const quote =
    result?.indicators?.quote?.[0];

  if (!quote?.close) {

    console.error(
      "STOCK FETCH FAILED:",
      symbol
    );

    return null;

  }

  return quote.close

    .map((c, i) => ({

      close: c,

      high:
        quote.high?.[i],

      volume:
        quote.volume?.[i]

    }))

    .filter(

      x =>

        x.close &&

        x.high &&

        x.volume

    );

}

// ================================================================
// BTC TREND
// ================================================================

async function updateBTCTrend() {

  const candles =
    await fetchCrypto(
      "BTCUSDT"
    );

  if (!candles) {

    btcTrend =
      "neutral";

    return;

  }

  const closes =
    candles.map(
      c => c.close
    );

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  const last =
    closes.at(-1);

  btcTrend =

    (
      last > ema20 &&
      ema20 > ema50
    )

    ? "bullish"

    : "neutral";

}

// ================================================================
// CRYPTO ANALYSIS
// ================================================================

function analyseCrypto(
  asset,
  candles
) {

  if (
    !candles ||
    candles.length < 60
  ) {
    return null;
  }

  const closes =
    candles.map(
      c => c.close
    );

  const highs =
    candles.map(
      c => c.high
    );

  const vols =
    candles.map(
      c => c.volume
    );

  const last =
    closes.at(-1);

  const prev =
    closes.at(-2);

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  if (

    !(
      last > ema20 &&
      ema20 > ema50
    )

  ) {

    return null;

  }

  const breakout =
    Math.max(

      ...highs.slice(
        -20,
        -1
      )

    );

  if (

    last <

    breakout *

    CRYPTO_BREAKOUT_BUFFER

  ) {

    return null;

  }

  const extension =

    (
      last - breakout
    ) / breakout;

  if (

    extension >
    CRYPTO_MAX_EXTENSION

  ) {

    return null;

  }

  const volRatio =

    vols.at(-1) /

    avg(
      vols.slice(-20)
    );

  let score = 50;

  if (
    volRatio > 1.3
  ) {
    score += 10;
  }

  if (
    volRatio > 2
  ) {
    score += 10;
  }

  const momentum =

    (
      last - prev
    ) / prev;

  if (
    momentum > 0.003
  ) {
    score += 10;
  }

  if (
    btcTrend ===
    "bullish"
  ) {
    score += 10;
  }

  if (
    score <
    CRYPTO_MIN_SCORE
  ) {

    return null;

  }

  return {

    asset,

    type: "crypto",

    score,

    entry: last,

    sl:
      breakout * 0.98,

    tp:
      last * 1.08,

    volRatio

  };

}

// ================================================================
// STOCK ANALYSIS
// ================================================================

function analyseStock(
  asset,
  candles
) {

  if (
    !candles ||
    candles.length < 50
  ) {

    return null;

  }

  const closes =
    candles.map(
      c => c.close
    );

  const highs =
    candles.map(
      c => c.high
    );

  const vols =
    candles.map(
      c => c.volume
    );

  const last =
    closes.at(-1);

  const ema9 =
    ema(closes, 9);

  const ema21 =
    ema(closes, 21);

  const ema50 =
    ema(closes, 50);

  if (

    !(
      last > ema9 &&
      ema9 > ema21 &&
      ema21 > ema50
    )

  ) {

    return null;

  }

  const breakout =
    Math.max(

      ...highs.slice(
        -20,
        -1
      )

    );

  if (

    last <

    breakout *

    STOCK_BREAKOUT_BUFFER

  ) {

    return null;

  }

  const extension =

    (
      last - breakout
    ) / breakout;

  if (

    extension >
    STOCK_MAX_EXTENSION

  ) {

    return null;

  }

  const relVol =

    vols.at(-1) /

    avg(
      vols.slice(-20)
    );

  let score = 50;

  if (
    relVol > 1.5
  ) {
    score += 10;
  }

  if (
    relVol > 2
  ) {
    score += 10;
  }

  score += 10;

  if (
    score <
    STOCK_MIN_SCORE
  ) {

    return null;

  }

  return {

    asset,

    type: "stock",

    score,

    entry: last,

    sl:
      breakout * 0.97,

    tp:
      last * 1.10,

    relVol

  };

}

// ================================================================
// SCAN
// ================================================================

async function scan() {

  const results = [];

  // ============================================================
  // CRYPTO
  // ============================================================

  for (const c of CRYPTOS) {

    if (

      cooldown(c.name) ||

      hasOpenTrade(c.name)

    ) {

      continue;

    }

    const candles =
      await fetchCrypto(
        c.symbol
      );

    const signal =
      analyseCrypto(

        c.name,

        candles

      );

    if (signal) {

      results.push(signal);

    }

  }

  // ============================================================
  // STOCKS
  // ============================================================

  for (const s of STOCKS) {

    if (

      cooldown(s) ||

      hasOpenTrade(s)

    ) {

      continue;

    }

    const candles =
      await fetchStock(s);

    const signal =
      analyseStock(
        s,
        candles
      );

    if (signal) {

      results.push(signal);

    }

  }

  return results

    .sort(
      (a, b) =>
        b.score - a.score
    )

    .slice(
      0,
      MAX_SIGNALS
    );

}

// ================================================================
// PROCESS SIGNALS
// ================================================================

async function processSignals(
  signals
) {

  const trades =
    load(TRADES_FILE);

  const alerts =
    load(ALERTS_FILE);

  for (const s of signals) {

    const msg =

`${s.type === "crypto"

? "🚀 CRYPTO BREAKOUT"

: "📈 STOCK MOMENTUM"}

${s.asset.toUpperCase()}

Score: ${s.score}

Entry: ${s.entry.toFixed(2)}

SL: ${s.sl.toFixed(2)}

TP: ${s.tp.toFixed(2)}

${s.type === "crypto"

? `Volume Ratio: ${s.volRatio.toFixed(2)}x`

: `Relative Volume: ${s.relVol.toFixed(2)}x`}
`;

    await send(msg);

    trades.push({

      ...s,

      status: "open",

      createdAt:
        new Date()
          .toISOString()

    });

    alerts.push({

      asset: s.asset,

      sentAt:
        new Date()
          .toISOString()

    });

  }

  save(
    TRADES_FILE,
    trades
  );

  save(
    ALERTS_FILE,
    alerts
  );

}

// ================================================================
// MAIN LOOP
// ================================================================

async function runCycle() {

  if (running) {
    return;
  }

  running = true;

  try {

    console.log(
      "Running scan..."
    );

    await checkConnection();

    if (connectionDown) {

      console.log(
        "Offline"
      );

      return;

    }

    await updateBTCTrend();

    console.log(
      "BTC Trend:",
      btcTrend
    );

    const signals =
      await scan();

    console.log(

      "Signals Found:",

      signals.length

    );

    if (
      signals.length
    ) {

      await processSignals(
        signals
      );

    }

  } catch (e) {

    console.error(

      "RUN ERROR:",

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
    "SNIPER V38 RUNNING 🚀"
  );

});

app.get(
  "/health",

  (_req, res) => {

    res.status(200).json({

      status: "ok",

      btcTrend,

      connectionDown,

      timestamp:
        new Date()
          .toISOString()

    });

  }

);

// ================================================================
// START
// ================================================================

ensureFiles();

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

      SCAN_INTERVAL

    );

  }

);
