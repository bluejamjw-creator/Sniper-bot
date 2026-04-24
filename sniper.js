// ================================================================
// SNIPER V34
// ULTRA AGGRESSIVE MOMENTUM SCANNER
// Crypto + US Stocks + LSE
// HIGH FREQUENCY BREAKOUT EDITION
// ================================================================

console.log("🚀 SNIPER V34 STARTING...");

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

const PORT = process.env.PORT || 3000;

const BOT_TOKEN =
  process.env.BOT_TOKEN || "";

const CHAT_ID =
  process.env.CHAT_ID || "";

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const FILES = {
  trades: path.join(DATA_DIR, "trades.json"),
  alerts: path.join(DATA_DIR, "alerts.json")
};

// ================================================================
// ULTRA AGGRESSIVE SETTINGS
// ================================================================

const MAX_SIGNALS_PER_CYCLE = 8;

const MAX_OPEN_TRADES = 20;

const MIN_CONFIDENCE = 55;

const COOLDOWN_HOURS = 1;

// MUCH MORE AGGRESSIVE

const MIN_MOMENTUM = 0.0008;

const MAX_MOMENTUM = 0.35;

const MIN_VOL_RATIO = 0.95;

const BREAKOUT_BUFFER = 1.0;

// ================================================================
// ENABLES
// ================================================================

const ENABLE_CRYPTO = true;

const ENABLE_STOCKS = true;

const ENABLE_LSE = true;

// ================================================================
// HUGE CRYPTO POOL
// ================================================================

const CRYPTO_PAIRS = [

  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "SUIUSDT",
  "INJUSDT",
  "AAVEUSDT",
  "SEIUSDT",
  "PEPEUSDT",
  "WIFUSDT",
  "FETUSDT",
  "RNDRUSDT",
  "TAOUSDT",
  "ONDOUSDT",
  "NEARUSDT",
  "ARBUSDT",
  "OPUSDT",

  "BNBUSDT",
  "ADAUSDT",
  "DOTUSDT",
  "ATOMUSDT",
  "FILUSDT",
  "APTUSDT",
  "TIAUSDT",
  "JUPUSDT",
  "PYTHUSDT",
  "RUNEUSDT",

  "GALAUSDT",
  "ALGOUSDT",
  "SANDUSDT",
  "MANAUSDT",
  "ICPUSDT",
  "FLOWUSDT",
  "EGLDUSDT",
  "KASUSDT",
  "XLMUSDT",
  "HBARUSDT",

  "ENSUSDT",
  "DYDXUSDT",
  "GMTUSDT",
  "LDOUSDT",
  "UNIUSDT",
  "MKRUSDT",
  "BLURUSDT",
  "BONKUSDT",
  "1000PEPEUSDT",
  "ETCUSDT"

];

const STOCK_POOL = [

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
  "GOOG",
  "SHOP",
  "ROKU",
  "SNOW",
  "CRM",
  "INTC",
  "PYPL"

];

const LSE_POOL = [

  "RR.L",
  "BARC.L",
  "LLOY.L",
  "VOD.L",
  "BP.L",
  "SHEL.L",
  "HSBA.L",
  "NWG.L",
  "TSCO.L",
  "BT-A.L"

];

// ================================================================

let running = false;

let btcTrend = "neutral";

let lastHeartbeatHour = null;

const scanStats = {

  scanned: 0,
  rejected: 0,
  signals: 0

};

// ================================================================
// HELPERS
// ================================================================

function nowIso() {

  return new Date().toISOString();

}

function ensureFiles() {

  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });

  for (const file of Object.values(FILES)) {

    if (!fs.existsSync(file)) {

      fs.writeFileSync(
        file,
        "[]"
      );

    }

  }

}

function load(file, fallback) {

  try {

    return JSON.parse(
      fs.readFileSync(
        file,
        "utf8"
      )
    );

  } catch {

    return fallback;

  }

}

function save(file, data) {

  fs.writeFileSync(
    file,
    JSON.stringify(
      data,
      null,
      2
    )
  );

}

function avg(arr) {

  if (!arr.length) return 0;

  return (
    arr.reduce(
      (a, b) => a + b,
      0
    ) / arr.length
  );

}

function ema(values, period) {

  if (!values.length) return 0;

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
    (Date.now() -
      new Date(ts).getTime()) /
    36e5
  );

}

// ================================================================
// MARKET HOURS
// ================================================================

function isUSMarketOpen() {

  const now =
    new Date();

  const hour =
    now.getUTCHours();

  const day =
    now.getUTCDay();

  if (
    day === 0 ||
    day === 6
  ) {
    return false;
  }

  return (
    hour >= 13 &&
    hour < 20
  );

}

function isLSEOpen() {

  const now =
    new Date();

  const hour =
    now.getUTCHours();

  const day =
    now.getUTCDay();

  if (
    day === 0 ||
    day === 6
  ) {
    return false;
  }

  return (
    hour >= 7 &&
    hour < 15
  );

}

// ================================================================
// TELEGRAM
// ================================================================

async function send(msg) {

  if (
    !BOT_TOKEN ||
    !CHAT_ID
  ) {

    console.log(msg);

    return;

  }

  try {

    await axios.post(

      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,

      {
        chat_id: CHAT_ID,
        text: msg
      }

    );

  } catch (e) {

    console.error(
      "Telegram Error:",
      e.message
    );

  }

}

// ================================================================
// FETCHERS
// ================================================================

async function fetchCrypto(symbol) {

  const { data } =
    await axios.get(

      "https://api.binance.com/api/v3/klines",

      {
        params: {

          symbol,

          interval: "1h",

          limit: 100

        },

        timeout: 15000

      }

    );

  return data.map(k => ({

    close: +k[4],

    high: +k[2],

    volume: +k[5]

  }));

}

async function fetchYahoo(symbol) {

  try {

    const { data } =
      await axios.get(

        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,

        {
          params: {

            range: "3mo",

            interval: "1d"

          },

          timeout: 15000

        }

      );

    const result =
      data?.chart?.result?.[0];

    const quote =
      result?.indicators?.quote?.[0];

    if (
      !quote?.close
    ) {
      return null;
    }

    return quote.close

      .map((c, i) => ({

        close: +c,

        high:
          +quote.high?.[i],

        volume:
          +quote.volume?.[i]

      }))

      .filter(
        x => x.close
      );

  } catch {

    return null;

  }

}

// ================================================================
// BTC TREND
// ================================================================

async function updateBTCTrend() {

  try {

    const candles =
      await fetchCrypto(
        "BTCUSDT"
      );

    const closes =
      candles.map(
        c => c.close
      );

    const ema20 =
      ema(
        closes.slice(-20),
        20
      );

    btcTrend =
      closes.at(-1) >
      ema20

        ? "bullish"

        : "neutral";

  } catch {

    btcTrend =
      "neutral";

  }

}

// ================================================================
// ANALYSIS
// ================================================================

function analyse(
  asset,
  candles,
  type
) {

  scanStats.scanned++;

  if (
    !candles ||
    candles.length < 20
  ) {

    console.log(`${asset} rejected: insufficient candles`);

    scanStats.rejected++;

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

  const momentum =
    (last - prev) /
    prev;

  if (

    momentum <
      MIN_MOMENTUM ||

    momentum >
      MAX_MOMENTUM

  ) {

    console.log(`${asset} rejected: momentum`);

    scanStats.rejected++;

    return null;

  }

  // FIXED BREAKOUT LOGIC

  const breakout =
    Math.max(
      ...highs.slice(-10, -1)
    );

  if (

    last <
    breakout *
      BREAKOUT_BUFFER

  ) {

    console.log(`${asset} rejected: breakout`);

    scanStats.rejected++;

    return null;

  }

  const volRatio =

    vols.at(-1) /

    avg(
      vols.slice(-15)
    );

  if (
    volRatio <
    MIN_VOL_RATIO
  ) {

    console.log(`${asset} rejected: volume`);

    scanStats.rejected++;

    return null;

  }

  let score = 50;

  if (
    momentum > 0.005
  ) {
    score += 10;
  }

  if (
    momentum > 0.015
  ) {
    score += 10;
  }

  if (
    volRatio > 1.2
  ) {
    score += 10;
  }

  if (
    btcTrend ===
    "bullish"
  ) {
    score += 10;
  }

  scanStats.signals++;

  return {

    asset,

    type,

    score,

    entry: last,

    sl:
      last * 0.96,

    tp:
      last * 1.10,

    volRatio,

    momentum

  };

}

// ================================================================
// COOLDOWN
// ================================================================

function cooldown(
  asset,
  alerts
) {

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
    ) <
    COOLDOWN_HOURS

  );

}

// ================================================================
// SCANNER
// ================================================================

async function scan() {

  const alerts =
    load(
      FILES.alerts,
      []
    );

  const results = [];

  if (ENABLE_CRYPTO) {

    for (const pair of CRYPTO_PAIRS) {

      if (
        cooldown(
          pair,
          alerts
        )
      ) {
        continue;
      }

      try {

        const signal =
          analyse(

            pair,

            await fetchCrypto(
              pair
            ),

            "crypto"

          );

        if (signal) {

          console.log(`[CRYPTO SIGNAL] ${pair}`);

          results.push(
            signal
          );

        }

      } catch (e) {

        console.log(`${pair} fetch failed`);

      }

    }

  }

  if (
    ENABLE_STOCKS &&
    isUSMarketOpen()
  ) {

    for (const stock of STOCK_POOL) {

      try {

        const signal =
          analyse(

            stock,

            await fetchYahoo(
              stock
            ),

            "stock"

          );

        if (signal) {

          console.log(`[US SIGNAL] ${stock}`);

          results.push(
            signal
          );

        }

      } catch {}

    }

  }

  if (
    ENABLE_LSE &&
    isLSEOpen()
  ) {

    for (const stock of LSE_POOL) {

      try {

        const signal =
          analyse(

            stock,

            await fetchYahoo(
              stock
            ),

            "lse"

          );

        if (signal) {

          console.log(`[LSE SIGNAL] ${stock}`);

          results.push(
            signal
          );

        }

      } catch {}

    }

  }

  return results

    .sort(
      (a, b) =>
        b.score - a.score
    )

    .slice(
      0,
      MAX_SIGNALS_PER_CYCLE
    );

}

// ================================================================
// ALERTS
// ================================================================

async function processSignals(
  signals
) {

  const alerts =
    load(
      FILES.alerts,
      []
    );

  for (const s of signals) {

    const label =

      s.score >= 80

        ? "🚨 ELITE BREAKOUT"

        : "🔥 MOMENTUM BREAKOUT";

    await send(

`${label}

${s.asset}

Confidence:
${s.score}/100

Momentum:
${(s.momentum * 100).toFixed(2)}%

Volume Surge:
${s.volRatio.toFixed(2)}x

BTC Trend:
${btcTrend}

Status:
⚡ LIVE BREAKOUT DETECTED`

    );

    alerts.push({

      asset: s.asset,

      sentAt:
        nowIso()

    });

  }

  save(
    FILES.alerts,
    alerts
  );

}

// ================================================================
// HEARTBEAT
// ================================================================

async function heartbeat() {

  const hour =
    new Date()
      .getUTCHours();

  if (
    lastHeartbeatHour ===
    hour
  ) {
    return;
  }

  lastHeartbeatHour =
    hour;

  await send(

`🔎 SNIPER STATUS

Scanner ACTIVE

✅ Crypto ON
${isUSMarketOpen() ? "✅ US Stocks ON" : "⏸️ US Stocks CLOSED"}
${isLSEOpen() ? "✅ LSE ON" : "⏸️ LSE CLOSED"}

BTC Trend:
${btcTrend}

Assets Scanned:
${scanStats.scanned}

Signals Found:
${scanStats.signals}

Rejected:
${scanStats.rejected}

Scanning for momentum breakouts...`

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

  scanStats.scanned = 0;
  scanStats.rejected = 0;
  scanStats.signals = 0;

  try {

    ensureFiles();

    await updateBTCTrend();

    await heartbeat();

    const signals =
      await scan();

    console.log(
      `Signals: ${signals.length}`
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
    "SNIPER V34 RUNNING 🚀"
  );

});

app.get(
  "/health",
  (_req, res) => {

    res.json({

      status: "ok",

      btcTrend,

      time: nowIso()

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

  async () => {

    console.log(
      `API running on ${PORT}`
    );

    await send(

`🚀 SNIPER V34 LIVE

🔎 Scanner active

✅ 50 Crypto coins scanning
✅ US stocks scanning
✅ LSE stocks scanning

Mode:
ULTRA AGGRESSIVE MOMENTUM

Hunting live breakouts...`

    );

    runCycle();

    setInterval(
      runCycle,
      300000
    );

  }

);
