// ================================================================
// SNIPER V34
// QUALITY MOMENTUM + BREAKOUT CONFIRMATION SCANNER
// CRYPTO + US + LSE
// WATCH → BUILDING → READY → PARABOLIC
// ================================================================

console.log("🚀 SNIPER V48 STARTING...");

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

const PORT =
  process.env.PORT || 3000;

const BOT_TOKEN =
  process.env.BOT_TOKEN || "";

const CHAT_ID =
  process.env.CHAT_ID || "";

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const FILES = {

  alerts:
    path.join(
      DATA_DIR,
      "alerts.json"
    ),

  trades:
    path.join(
      DATA_DIR,
      "trades.json"
    )

};

// ================================================================
// SETTINGS
// ================================================================

const MAX_SIGNALS = 12;

const CRYPTO_COOLDOWN = 2;

const STOCK_COOLDOWN = 1;

// REAL breakout required now
const BREAKOUT_BUFFER = 1.002;

const MAX_MOMENTUM = 0.35;

// ================================================================
// PARABOLIC
// ================================================================

const PARABOLIC_MIN_VOL = 1.6;

const PARABOLIC_MIN_MOMENTUM = 0.018;

const PARABOLIC_LOOKBACK = 5;

// ================================================================
// ENABLES
// ================================================================

const ENABLE_CRYPTO = true;
const ENABLE_US = true;
const ENABLE_LSE = true;

// ================================================================
// CRYPTO
// ================================================================

const CRYPTO_PAIRS = [

  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",

  "FETUSDT",
  "RENDERUSDT",
  "TAOUSDT",

  "DYDXUSDT",
  "SEIUSDT",
  "INJUSDT",
  "SUIUSDT",
  "ONDOUSDT",
  "ARBUSDT",

  "PEPEUSDT",
  "BONKUSDT",
  "WIFUSDT",
  "APEUSDT",

  "API3USDT",
  "SAFEUSDT",
  "HIGHUSDT",
  "BIGTIMEUSDT",

  "BLURUSDT",
  "CTSIUSDT",
  "ILVUSDT",

  "AXSUSDT",
  "ALICEUSDT",

  "GALAUSDT",
  "SANDUSDT",
  "MANAUSDT",

  "CHZUSDT",
  "ROSEUSDT",

  "JASMYUSDT",
  "ACHUSDT",

  "AAVEUSDT",
  "UNIUSDT",
  "LDOUSDT",

  "HBARUSDT",
  "LINKUSDT",
  "NEARUSDT",

  "APTUSDT",
  "TIAUSDT",

  "PYTHUSDT",
  "ENSUSDT",

  "ETCUSDT",
  "NEIROUSDT"

];

// ================================================================
// STOCKS
// ================================================================

const STOCK_POOL = [

  "NVDA",
  "AMD",
  "PLTR",
  "TSLA",

  "META",
  "MSFT",
  "GOOG",
  "AMZN",

  "SMCI",
  "MSTR",
  "COIN",

  "ARM",
  "AVGO",

  "QQQ",
  "SOXL"

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
  "RIO.L"

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

  for (
    const file of Object.values(FILES)
  ) {

    if (
      !fs.existsSync(file)
    ) {

      fs.writeFileSync(
        file,
        "[]"
      );

    }

  }

}

function load(
  file,
  fallback
) {

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

function save(
  file,
  data
) {

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

  return (

    arr.reduce(
      (a, b) => a + b,
      0
    ) /

    arr.length

  );

}

function ema(
  values,
  period
) {

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

function formatPrice(
  value,
  currency
) {

  const gbp =
    value * 0.75;

  if (value >= 1) {

    return `${currency}${value.toFixed(2)} | £${gbp.toFixed(2)}`;

  }

  return `${currency}${value.toFixed(4)} | £${gbp.toFixed(4)}`;

}

// ================================================================
// FETCH CRYPTO
// ================================================================

async function fetchCrypto(
  symbol
) {

  try {

    const { data } =

      await axios.get(

        "https://data-api.binance.vision/api/v3/klines",

        {

          params: {

            symbol,

            interval: "1h",

            limit: 100

          }

        }

      );

    return data.map(k => ({

      close: +k[4],

      high: +k[2],

      volume: +k[5]

    }));

  } catch {

    return null;

  }

}

// ================================================================
// FETCH STOCK
// ================================================================

async function fetchStock(
  symbol
) {

  try {

    const { data } =

      await axios.get(

        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,

        {

          params: {

            range: "5d",

            interval: "5m",

            includePrePost: true

          }

        }

      );

    const result =
      data?.chart?.result?.[0];

    const quote =
      result?.indicators
        ?.quote?.[0];

    if (!quote?.close) {
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
        x =>
          x.close &&
          x.volume
      );

  } catch {

    return null;

  }

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
    return;
  }

  const closes =
    candles.map(
      x => x.close
    );

  const ema20 =
    ema(
      closes,
      20
    );

  btcTrend =

    closes.at(-1) >
    ema20

      ? "bullish"

      : "neutral";

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
    candles.length < 50
  ) {

    return null;

  }

  const closes =
    candles.map(
      x => x.close
    );

  const highs =
    candles.map(
      x => x.high
    );

  const vols =
    candles.map(
      x => x.volume
    );

  const last =
    closes.at(-1);

  const prev =
    closes.at(-2);

  const momentum =

    (last - prev) /
    prev;

  if (

    momentum <= 0 ||

    momentum >
      MAX_MOMENTUM

  ) {

    return null;

  }

  const volRatio =

    vols.at(-1) /

    avg(
      vols.slice(-20)
    );

  const breakout =

    Math.max(
      ...highs.slice(-15)
    );

  // REAL breakout only
  const breakoutStrength =

    (last - breakout) /
    breakout;

  const confirmedBreakout =

    breakoutStrength >
    0.003;

  // ============================================================
  // TREND
  // ============================================================

  const ema20 =
    ema(
      closes,
      20
    );

  const ema50 =
    ema(
      closes,
      50
    );

  const strongTrend =
    ema20 > ema50;

  // ============================================================
  // PARABOLIC
  // ============================================================

  const localBreakout =

    last >

    Math.max(
      ...highs.slice(
        -PARABOLIC_LOOKBACK
      )
    );

  const parabolic =

    strongTrend &&

    localBreakout &&

    momentum >
      PARABOLIC_MIN_MOMENTUM &&

    volRatio >
      PARABOLIC_MIN_VOL;

  if (

    !confirmedBreakout &&

    !parabolic

  ) {

    return null;

  }

  // ============================================================
  // SCORING
  // ============================================================

  let score = 50;

  if (
    momentum > 0.01
  ) {
    score += 10;
  }

  if (
    momentum > 0.02
  ) {
    score += 10;
  }

  if (
    volRatio > 1.5
  ) {
    score += 10;
  }

  if (
    strongTrend
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

  if (score >= 90) {

    grade = "A*";

  }

  else if (
    score >= 75
  ) {

    grade = "A";

  }

  // ============================================================
  // STATUS PROGRESSION
  // ============================================================

  let status =
    "WATCH";

  if (

    momentum > 0.01 &&

    volRatio > 1.3

  ) {

    status =
      "BUILDING";

  }

  if (

    grade === "A*" &&

    volRatio > 1.8 &&

    momentum > 0.015

  ) {

    status =
      "READY";

  }

  if (parabolic) {

    status =
      "PARABOLIC";

  }

  // ============================================================
  // TP / SL
  // ============================================================

  let sl =
    last * 0.96;

  let tp =
    last * 1.08;

  if (parabolic) {

    sl =
      last * 0.975;

    tp =
      last * 1.05;

  }

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

    momentum,
    volRatio,

    entry: last,
    sl,
    tp,

    currency,

    parabolic

  };

}

// ================================================================
// ALERTS
// ================================================================

async function sendSignal(
  s
) {

  const market =

    s.market ===
    "CRYPTO"

      ? "🪙"

      : s.market ===
        "US"

      ? "🇺🇸"

      : "🇬🇧";

  let icon = "👀";

  if (
    s.status ===
    "BUILDING"
  ) {

    icon = "⚡";

  }

  if (
    s.status ===
    "READY"
  ) {

    icon = "🚨";

  }

  if (
    s.status ===
    "PARABOLIC"
  ) {

    icon = "🔥";

  }

  await send(

`${icon} ${s.status} ${s.grade}

${market} ${s.asset}

🎯 ${formatPrice(
  s.entry,
  s.currency
)}

🛑 ${formatPrice(
  s.sl,
  s.currency
)}

💰 ${formatPrice(
  s.tp,
  s.currency
)}

📈 ${(
  s.momentum * 100
).toFixed(2)}%

📊 ${s.volRatio.toFixed(2)}x

₿ ${btcTrend}`

  );

}

// ================================================================
// SEND
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
      e.message
    );

  }

}

// ================================================================
// SCAN
// ================================================================

async function scan() {

  const results = [];

  for (const pair of CRYPTO_PAIRS) {

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

      results.push(
        signal
      );

    }

  }

  return results

    .sort(
      (a, b) =>

        b.volRatio -
        a.volRatio

    )

    .slice(
      0,
      MAX_SIGNALS
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

    ensureFiles();

    await updateBTCTrend();

    const signals =
      await scan();

    console.log(
      `Signals: ${signals.length}`
    );

    for (const s of signals) {

      await sendSignal(
        s
      );

    }

  }

  catch (e) {

    console.log(
      e.message
    );

  }

  finally {

    running = false;

  }

}

// ================================================================
// API
// ================================================================

app.get("/", (_req, res) => {

  res.send(
    "SNIPER V48 RUNNING 🚀"
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

`🚀 SNIPER V48 LIVE

👀 WATCH
⚡ BUILDING
🚨 READY
🔥 PARABOLIC

✅ Higher quality setups
✅ Stronger breakout confirmation
✅ Reduced sideways entries`

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
