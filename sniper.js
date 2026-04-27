// ================================================================
// SNIPER V57 TEST FLOW
// RELAXED DIAGNOSTIC VERSION
// TEMPORARY VERSION TO VERIFY SIGNAL FLOW
// ================================================================

console.log("🚀 SNIPER V57 TEST FLOW STARTING...");

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
    )

};

// ================================================================
// TEST SETTINGS
// ================================================================

const MAX_SIGNALS = 15;

const CRYPTO_COOLDOWN = 1;
const STOCK_COOLDOWN = 12;

const MAX_MOMENTUM = 0.15;

// relaxed breakout

const BREAKOUT_THRESHOLD = 0.000;

// relaxed volume

const CRYPTO_VOL_RATIO_BULL = 1.00;
const CRYPTO_VOL_RATIO_NEUTRAL = 1.05;

const STOCK_MIN_VOL_RATIO = 1.00;

// relaxed RR

const MIN_RR = 1.2;

// ================================================================
// PARABOLIC
// ================================================================

const PARABOLIC_MIN_VOL = 1.8;
const PARABOLIC_MIN_MOMENTUM = 0.025;

// ================================================================
// ENABLES
// ================================================================

const ENABLE_CRYPTO = true;
const ENABLE_US = true;
const ENABLE_LSE = true;

// ================================================================
// CRYPTO WATCHLIST
// ================================================================

const CRYPTO_PAIRS = [

  "BTCUSDT",
  "ETHUSDT",

  "SOLUSDT",
  "LINKUSDT",
  "AVAXUSDT",

  "INJUSDT",
  "NEARUSDT",
  "RENDERUSDT",

  "ONDOUSDT",
  "TIAUSDT",
  "SUIUSDT",

  "FETUSDT",
  "ARBUSDT",
  "OPUSDT",

  "PYTHUSDT"

];

// ================================================================
// US STOCKS
// ================================================================

const STOCK_POOL = [

  "NVDA",
  "AVGO",
  "AMD",
  "MU",
  "TSM",
  "ASML",
  "QCOM",

  "PLTR",
  "CRWD",

  "LMT",
  "RTX",
  "NOC",

  "XOM",
  "CVX",

  "GE",

  "SMH",
  "QQQ",
  "SOXL",
  "TQQQ"

];

// ================================================================
// LSE
// ================================================================

const LSE_POOL = [

  "RR.L",
  "BA.L",

  "GLEN.L",
  "RIO.L",

  "STAN.L",
  "BARC.L",

  "SHEL.L",
  "BP.L",

  "WEIR.L"

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
  market
) {

  if (
    market === "LSE"
  ) {

    return `£${value.toFixed(2)}`;

  }

  if (value >= 1) {

    return `$${value.toFixed(2)}`;

  }

  return `$${value.toFixed(4)}`;

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
    hour >= 14 &&
    hour < 21
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
    hour >= 8 &&
    hour < 16
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
      e.message
    );

  }

}

// ================================================================
// FETCHERS
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

            limit: 120

          }

        }

      );

    return data.map(k => ({

      close: +k[4],

      high: +k[2],

      low: +k[3],

      volume: +k[5]

    }));

  } catch {

    return null;

  }

}

async function fetchYahoo(
  symbol
) {

  try {

    const { data } =

      await axios.get(

        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,

        {

          params: {

            range: "6mo",

            interval: "1d"

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

        low:
          +quote.low?.[i],

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

  const ema50 =
    ema(
      closes,
      50
    );

  btcTrend =

    ema20 > ema50

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
    candles.length < 60
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

  const lows =
    candles.map(
      x => x.low
    );

  const volumes =
    candles.map(
      x => x.volume
    );

  const last =
    closes.at(-1);

  const prev =
    closes.at(-2);

  const momentum =

    (
      last - prev
    ) / prev;

  if (
    momentum <= 0 ||
    momentum >
      MAX_MOMENTUM
  ) {

    return null;

  }

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

  if (
    !strongTrend
  ) {

    return null;

  }

  const breakout =

    Math.max(
      ...highs.slice(
        -15,
        -1
      )
    );

  const breakoutStrength =

    (
      last - breakout
    ) / breakout;

  const breakoutSignal =

    breakoutStrength >=
    BREAKOUT_THRESHOLD;

  const reclaim =

    last > ema20 &&

    closes.at(-2) > ema20;

  const avgVol =

    avg(
      volumes.slice(-20)
    );

  const currentVol =
    volumes.at(-1);

  const volRatio =

    currentVol /
    avgVol;

  if (
    market === "CRYPTO"
  ) {

    const requiredVol =

      btcTrend ===
      "bullish"

        ? CRYPTO_VOL_RATIO_BULL

        : CRYPTO_VOL_RATIO_NEUTRAL;

    if (
      volRatio <
      requiredVol
    ) {

      return null;

    }

  } else {

    if (
      volRatio <
      STOCK_MIN_VOL_RATIO
    ) {

      return null;

    }

  }

  if (
    !breakoutSignal &&
    !reclaim
  ) {

    return null;

  }

  const parabolic =

    momentum >
      PARABOLIC_MIN_MOMENTUM &&

    volRatio >
      PARABOLIC_MIN_VOL;

  let setupType =
    reclaim
      ? "RECLAIM"
      : "BREAKOUT";

  let entry =
    last;

  let entryType =
    "MARKET BUY";

  const extension =

    (
      last - ema20
    ) / ema20;

  if (
    extension > 0.06
  ) {

    entryType =
      "LIMIT BUY";

    entry =
      ema20 * 1.01;

  }

  if (
    parabolic
  ) {

    entryType =
      "STOP BUY";

    entry =
      breakout * 1.003;

  }

  const sl =

    Math.min(
      ...lows.slice(-5)
    );

  let tp =
    entry * 1.06;

  if (
    parabolic
  ) {

    tp =
      entry * 1.10;

  }

  const riskPct =

    Math.abs(
      (
        entry - sl
      ) / entry
    );

  const rewardPct =

    (
      (
        tp - entry
      ) / entry
    );

  const rr =

    (
      rewardPct / riskPct
    ).toFixed(1);

  if (
    rr < MIN_RR
  ) {

    return null;

  }

  console.log(

    `[${market}] ${asset}`,

    {

      setupType,

      momentum:
        momentum.toFixed(4),

      breakoutStrength:
        breakoutStrength.toFixed(4),

      volRatio:
        volRatio.toFixed(2),

      rr,

      reclaim,

      breakoutSignal,

      strongTrend

    }

  );

  return {

    asset,
    market,

    setupType,

    status:

      parabolic
        ? "PARABOLIC"
        : "CONFIRMED",

    entryType,

    entry,

    sl,

    tp,

    rr,

    momentum,

    volRatio

  };

        }
