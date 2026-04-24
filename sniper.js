// ================================================================
// SNIPER V34
// SMART MOMENTUM BREAKOUT SCANNER PRO
// Crypto + US Stocks + LSE
// READY NOW / WATCHLIST SYSTEM
// A* / A / B GRADING
// TRADE TRACKING + TP/SL ALERTS
// ================================================================

console.log("🚀 SNIPER V37 STARTING...");

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

  alerts: path.join(
    DATA_DIR,
    "alerts.json"
  ),

  trades: path.join(
    DATA_DIR,
    "trades.json"
  )

};

// ================================================================
// SETTINGS
// ================================================================

const MAX_SIGNALS_PER_CYCLE = 5;

const COOLDOWN_HOURS = 1;

const MIN_MOMENTUM = 0.001;

const MAX_MOMENTUM = 0.30;

const MIN_VOL_RATIO = 1.0;

const BREAKOUT_BUFFER = 0.998;

// ================================================================
// ENABLES
// ================================================================

const ENABLE_CRYPTO = true;

const ENABLE_STOCKS = true;

const ENABLE_LSE = true;

// ================================================================
// CRYPTO
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

  "BNBUSDT",
  "ADAUSDT",
  "DOTUSDT",
  "ATOMUSDT",

  "APTUSDT",
  "TIAUSDT",
  "JUPUSDT",
  "PYTHUSDT",

  "GALAUSDT",
  "ALGOUSDT",
  "ICPUSDT",

  "XLMUSDT",
  "HBARUSDT",
  "ENSUSDT",

  "DYDXUSDT",
  "LDOUSDT",
  "UNIUSDT",

  "BONKUSDT",
  "ETCUSDT"

];

// ================================================================
// US STOCKS
// ================================================================

const STOCK_POOL = [

  "NVDA",
  "TSLA",
  "PLTR",
  "AMD",
  "META",

  "COIN",
  "MSTR",
  "SMCI",

  "AMZN",
  "AAPL",

  "MSFT",
  "GOOG"

];

// ================================================================
// LSE
// ================================================================

const LSE_POOL = [

  "RR.L",
  "BARC.L",
  "LLOY.L",

  "BP.L",
  "SHEL.L",

  "HSBA.L",
  "NWG.L"

];

// ================================================================

let running = false;

let btcTrend = "neutral";

// ================================================================
// HELPERS
// ================================================================

function nowIso() {

  return new Date().toISOString();

}

function ensureFiles() {

  fs.mkdirSync(
    DATA_DIR,
    { recursive: true }
  );

  if (
    !fs.existsSync(
      FILES.alerts
    )
  ) {

    fs.writeFileSync(
      FILES.alerts,
      "[]"
    );

  }

  if (
    !fs.existsSync(
      FILES.trades
    )
  ) {

    fs.writeFileSync(
      FILES.trades,
      "[]"
    );

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

  if (!arr.length) {
    return 0;
  }

  return (

    arr.reduce(
      (a, b) => a + b,
      0
    ) /

    arr.length

  );

}

function ema(values, period) {

  if (!values.length) {
    return 0;
  }

  const k =
    2 / (period + 1);

  let out =
    values[0];

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

    (
      Date.now() -

      new Date(ts)
        .getTime()

    ) / 36e5

  );

}

function formatPrice(
  value,
  currency
) {

  if (value >= 1000) {
    return `${currency}${value.toFixed(0)}`;
  }

  if (value >= 1) {
    return `${currency}${value.toFixed(2)}`;
  }

  if (value >= 0.1) {
    return `${currency}${value.toFixed(4)}`;
  }

  return `${currency}${value.toFixed(6)}`;

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

        chat_id:
          CHAT_ID,

        text:
          msg

      }

    );

  } catch (e) {

    console.log(
      "Telegram Error:",
      e.message
    );

  }

}

// ================================================================
// FETCH CRYPTO
// ================================================================

async function fetchCrypto(symbol) {

  try {

    const { data } =

      await axios.get(

        "https://data-api.binance.vision/api/v3/klines",

        {

          params: {

            symbol,

            interval: "1h",

            limit: 100

          },

          timeout: 10000

        }

      );

    return data.map(k => ({

      close:
        +k[4],

      high:
        +k[2],

      volume:
        +k[5]

    }));

  } catch {

    return null;

  }

}

// ================================================================
// FETCH STOCKS
// ================================================================

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

          timeout: 10000

        }

      );

    const result =
      data?.chart?.result?.[0];

    const quote =
      result?.indicators
        ?.quote?.[0];

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

    if (!candles) {
      return;
    }

    const closes =
      candles.map(
        c => c.close
      );

    const ema20 =
      ema(closes, 20);

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
  market
) {

  if (
    !candles ||
    candles.length < 20
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

  const momentum =

    (last - prev) /
    prev;

  if (

    momentum <
      MIN_MOMENTUM ||

    momentum >
      MAX_MOMENTUM

  ) {

    return null;

  }

  const breakout =

    Math.max(
      ...highs.slice(-10)
    );

  const nearBreakout =

    last >=
    breakout *
      BREAKOUT_BUFFER;

  const volRatio =

    vols.at(-1) /

    avg(
      vols.slice(-15)
    );

  if (
    volRatio <
    MIN_VOL_RATIO
  ) {

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
    volRatio > 1.3
  ) {
    score += 10;
  }

  if (
    btcTrend ===
    "bullish"
  ) {
    score += 10;
  }

  let grade = "B";

  if (score >= 85) {
    grade = "A*";
  }

  else if (
    score >= 70
  ) {
    grade = "A";
  }

  const status =

    score >= 70 &&
    nearBreakout

      ? "READY NOW"

      : "WATCHLIST";

  const entry = last;

  const sl =
    last * 0.96;

  const tp =
    last * 1.08;

  let currency = "$";

  if (
    market === "LSE"
  ) {
    currency = "£";
  }

  return {

    asset,

    market,

    grade,

    status,

    score,

    momentum,

    volRatio,

    entry,

    sl,

    tp,

    currency

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
    ) < COOLDOWN_HOURS

  );

}

// ================================================================
// SCAN
// ================================================================

async function scan() {

  const alerts =
    load(
      FILES.alerts,
      []
    );

  const results = [];

  for (const pair of CRYPTO_PAIRS) {

    if (
      cooldown(
        pair,
        alerts
      )
    ) {
      continue;
    }

    const candles =
      await fetchCrypto(
        pair
      );

    const signal =
      analyse(
        pair,
        candles,
        "CRYPTO"
      );

    if (signal) {
      results.push(signal);
    }

  }

  if (
    ENABLE_STOCKS &&
    isUSMarketOpen()
  ) {

    for (const stock of STOCK_POOL) {

      const candles =
        await fetchYahoo(
          stock
        );

      const signal =
        analyse(
          stock,
          candles,
          "US"
        );

      if (signal) {
        results.push(signal);
      }

    }

  }

  if (
    ENABLE_LSE &&
    isLSEOpen()
  ) {

    for (const stock of LSE_POOL) {

      const candles =
        await fetchYahoo(
          stock
        );

      const signal =
        analyse(
          stock,
          candles,
          "LSE"
        );

      if (signal) {
        results.push(signal);
      }

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

  const trades =
    load(
      FILES.trades,
      []
    );

  for (const s of signals) {

    if (
      s.grade === "B"
    ) {
      continue;
    }

    const marketEmoji =

      s.market ===
      "CRYPTO"

        ? "🪙"

        : s.market ===
          "US"

        ? "🇺🇸"

        : "🇬🇧";

    const msg =

`${s.status === "READY NOW" ? "🚨 READY TO TRADE" : "👀 WATCHLIST"}

${marketEmoji} ${s.market}

${s.asset}

🏅 Grade:
${s.grade}

Confidence:
${s.score}/100

Momentum:
${(s.momentum * 100).toFixed(2)}%

Volume:
${s.volRatio.toFixed(2)}x

🎯 Entry:
${formatPrice(
  s.entry,
  s.currency
)}

🛑 Stop Loss:
${formatPrice(
  s.sl,
  s.currency
)}

💰 Take Profit:
${formatPrice(
  s.tp,
  s.currency
)}

BTC Trend:
${btcTrend}`;

    await send(msg);

    trades.push({

      asset: s.asset,

      market: s.market,

      grade: s.grade,

      entry: s.entry,

      sl: s.sl,

      tp: s.tp,

      currency: s.currency,

      status: "OPEN",

      createdAt: nowIso()

    });

    alerts.push({

      asset:
        s.asset,

      sentAt:
        nowIso()

    });

  }

  save(
    FILES.alerts,
    alerts
  );

  save(
    FILES.trades,
    trades
  );

}

// ================================================================
// TRADE MANAGEMENT
// ================================================================

async function manageTrades() {

  const trades =
    load(
      FILES.trades,
      []
    );

  let changed = false;

  for (const t of trades) {

    if (
      t.status !== "OPEN"
    ) {
      continue;
    }

    let candles;

    if (
      t.market ===
      "CRYPTO"
    ) {

      candles =
        await fetchCrypto(
          t.asset
        );

    } else {

      candles =
        await fetchYahoo(
          t.asset
        );

    }

    if (!candles) {
      continue;
    }

    const price =
      candles.at(-1)
        .close;

    if (
      price >= t.tp
    ) {

      t.status = "TP";

      changed = true;

      await send(

`✅ TAKE PROFIT HIT

${t.asset}

🏆 WINNER

Entry:
${formatPrice(
  t.entry,
  t.currency
)}

Exit:
${formatPrice(
  price,
  t.currency
)}`

      );

    }

    else if (
      price <= t.sl
    ) {

      t.status = "SL";

      changed = true;

      await send(

`❌ STOP LOSS HIT

${t.asset}

Trade Closed

Entry:
${formatPrice(
  t.entry,
  t.currency
)}

Exit:
${formatPrice(
  price,
  t.currency
)}`

      );

    }

  }

  if (changed) {

    save(
      FILES.trades,
      trades
    );

  }

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

    ensureFiles();

    await updateBTCTrend();

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

    await manageTrades();

  } catch (e) {

    console.log(
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
    "SNIPER V37 RUNNING 🚀"
  );

});

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

`🚀 SNIPER V37 LIVE

🪙 Crypto Enabled
🇺🇸 US Stocks Enabled
🇬🇧 LSE Enabled

🏅 A* / A / B grading

👀 Watchlist Mode
🚨 Ready-To-Trade Alerts

✅ TP / SL Tracking Enabled`

    );

    setTimeout(
      runCycle,
      5000
    );

    setInterval(
      runCycle,
      600000
    );

  }

);
