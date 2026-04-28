// ================================================================
// SNIPER V61 PRODUCTION
// INSTITUTIONAL MOMENTUM CONTINUATION ENGINE
// CRYPTO + US STOCKS + LSE
// V60 = ANTI-CHASE UPGRADED
//   - recentRun filter (blocks late 3-candle breakouts)
//   - extension threshold tightened 0.12 → 0.09
//   - breakout volume confirmation raised 1.15 → 1.20
// V60.1 = SPLIT VOLUME REQUIREMENTS
//   - breakout vol: 1.20x (aggression required)
//   - reclaim vol:  1.05x (quieter continuation allowed)
// V61 = SETUP-AWARE ENTRY LOGIC
//   - RECLAIM  → LIMIT BUY  at last * 0.992 (wait for retest)
//   - BREAKOUT → STOP BUY   at breakout * 1.002 (prove continuation)
//   - PARABOLIC → STOP BUY  at breakout * 1.003 (overrides all)
//   - MARKET BUY retired — no more blind market entries
// ================================================================

console.log("🚀 SNIPER V61 PRODUCTION STARTING...");

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
// V60 SETTINGS
// ================================================================

const MAX_SIGNALS = 8;

const CRYPTO_COOLDOWN = 3;
const STOCK_COOLDOWN = 4;

const MAX_MOMENTUM = 0.15;

const BREAKOUT_THRESHOLD = 0.002;

const CRYPTO_VOL_RATIO_BULL = 1.05;
const CRYPTO_VOL_RATIO_NEUTRAL = 1.12;

const STOCK_MIN_VOL_RATIO = 1.05;

const MIN_RR = 1.5;

// ================================================================
// PARABOLIC
// ================================================================

const PARABOLIC_MIN_VOL = 2.0;
const PARABOLIC_MIN_MOMENTUM = 0.03;

// ================================================================
// V61 ANTI-CHASE + ENTRY SETTINGS
// ================================================================

// Hard limit — no entries beyond this extension from EMA20
const EXTENSION_HARD_LIMIT = 0.09;

// V60.1: SPLIT VOLUME REQUIREMENTS
// Breakouts require aggression — 1.20x
// Reclaims work on quieter continuation flow — 1.05x sufficient
const BREAKOUT_VOL_CONFIRM = 1.20;
const RECLAIM_VOL_CONFIRM = 1.05;

// recentRun momentum threshold — blocks late impulsive entries
const RECENT_RUN_MOMENTUM = 0.025;

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

  // BTC + ETH anchors
  "BTCUSDT",
  "ETHUSDT",

  // Layer 1 momentum
  "SOLUSDT",
  "SUIUSDT",
  "AVAXUSDT",

  // AI narrative
  "FETUSDT",
  "RENDERUSDT",
  "NEARUSDT",

  // DeFi + infrastructure
  "INJUSDT",
  "JUPUSDT",
  "HYPEUSDT",

  // Bitcoin layer + data
  "STXUSDT",
  "TIAUSDT",
  "ONDOUSDT",

  // Link — reliable momentum
  "LINKUSDT"

];

// ================================================================
// US STOCKS
// ================================================================

const STOCK_POOL = [

  // AI semis core
  "NVDA",
  "AVGO",
  "AMD",
  "MU",
  "TSM",
  "ASML",
  "QCOM",

  // AI software
  "PLTR",
  "CRWD",

  // AI power demand
  "GEV",
  "VST",
  "CCJ",

  // Defence — momentum plays
  "LMT",
  "RTX",

  // ETF proxies
  "SMH",
  "QQQ",
  "SOXL"

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

  "WEIR.L"

];

// ================================================================

let running = false;

let btcTrend = "neutral";

let usMarketState = false;
let lseMarketState = false;

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
      "TELEGRAM ERROR:",
      e.message
    );

  }

}

// ================================================================
// MARKET STATUS
// ================================================================

async function marketStatusCheck() {

  const usOpen =
    isUSMarketOpen();

  const lseOpen =
    isLSEOpen();

  if (
    usOpen &&
    !usMarketState
  ) {

    await send(
`🇺🇸 US MARKET OPEN

⚡ Momentum scanner active`
    );

  }

  if (
    !usOpen &&
    usMarketState
  ) {

    await send(
`🇺🇸 US MARKET CLOSED`
    );

  }

  if (
    lseOpen &&
    !lseMarketState
  ) {

    await send(
`🇬🇧 LSE OPEN

⚡ Momentum scanner active`
    );

  }

  if (
    !lseOpen &&
    lseMarketState
  ) {

    await send(
`🇬🇧 LSE CLOSED`
    );

  }

  usMarketState =
    usOpen;

  lseMarketState =
    lseOpen;

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

  } catch (e) {

    console.log(
      `CRYPTO ERROR ${symbol}`,
      e.message
    );

    return null;

  }

}

// ================================================================
// FETCH STOCKS
// ================================================================

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

  } catch (e) {

    console.log(
      `YAHOO ERROR ${symbol}`,
      e.message
    );

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
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  btcTrend =
    ema20 > ema50
      ? "bullish"
      : "neutral";

}

// ================================================================
// COOLDOWN
// ================================================================

function cooldown(
  asset,
  alerts,
  market
) {

  const found =

    [...alerts]

      .reverse()

      .find(
        x =>
          x.asset === asset
      );

  if (!found) {

    return false;

  }

  const limit =

    market === "CRYPTO"

      ? CRYPTO_COOLDOWN

      : STOCK_COOLDOWN;

  return (

    hoursAgo(
      found.sentAt
    ) < limit

  );

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

  // ============================================================
  // TREND
  // ============================================================

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  const strongTrend =
    ema20 > ema50;

  if (
    !strongTrend
  ) {

    return null;

  }

  // ============================================================
  // VOLUME
  // ============================================================

  const avgVol =
    avg(
      volumes.slice(-20)
    );

  const currentVol =
    volumes.at(-1);

  const volRatio =
    currentVol / avgVol;

  if (
    market === "CRYPTO"
  ) {

    const requiredVol =

      btcTrend === "bullish"

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

  // ============================================================
  // BREAKOUT
  // ============================================================

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

  // V60.1: breakout confirmation — 1.20x required (reclaims handled separately below)
  const breakoutSignal =

    breakoutStrength >
      BREAKOUT_THRESHOLD &&

    volRatio > BREAKOUT_VOL_CONFIRM;

  // ============================================================
  // RECLAIM
  // ============================================================

  const reclaim =

    closes.at(-2) < ema20 &&

    last > ema20;

  // ============================================================
  // VALIDATION
  // ============================================================

  if (
    !breakoutSignal &&
    !reclaim
  ) {

    return null;

  }

  // ============================================================
  // V60.1: SPLIT VOLUME VALIDATION
  // Breakouts require 1.20x — reclaims only need 1.05x
  // Applied after signal type determined so each uses correct threshold
  // ============================================================

  if (
    breakoutSignal &&
    !reclaim &&
    volRatio < BREAKOUT_VOL_CONFIRM
  ) {

    return null;

  }

  if (
    reclaim &&
    !breakoutSignal &&
    volRatio < RECLAIM_VOL_CONFIRM
  ) {

    return null;

  }

  // ============================================================
  // V60: ANTI-CHASE — BLOCK LATE BREAKOUTS AFTER 3+ IMPULSIVE CANDLES
  // Catches entries like TIA on 28 Apr where scanner fired at spike peak
  // Reclaims are exempt — only breakout signals are blocked
  // ============================================================

  const recentRun = (
    closes.at(-1) > closes.at(-2) &&
    closes.at(-2) > closes.at(-3) &&
    closes.at(-3) > closes.at(-4)
  );

  if (
    breakoutSignal &&
    recentRun &&
    momentum > RECENT_RUN_MOMENTUM
  ) {

    return null;

  }

  // ============================================================
  // SETUP TYPE
  // ============================================================

  let setupType =
    reclaim
      ? "RECLAIM"
      : "BREAKOUT";

  // ============================================================
  // PARABOLIC
  // ============================================================

  const parabolic =

    momentum >
      PARABOLIC_MIN_MOMENTUM &&

    volRatio >
      PARABOLIC_MIN_VOL;

  // ============================================================
  // ENTRY
  // ============================================================

  let entry =
    last;

  let entryType =
    "MARKET BUY";

  const extension =
    (
      last - ema20
    ) / ema20;

  // ============================================================
  // V60: ANTI-CHASE HARD LIMIT — tightened 0.12 → 0.09
  // ============================================================

  if (
    extension > EXTENSION_HARD_LIMIT
  ) {

    return null;

  }

  // ============================================================
  // V61: SETUP-AWARE ENTRY LOGIC
  // PARABOLIC  → STOP BUY  breakout * 1.003 (override — always first)
  // RECLAIM    → LIMIT BUY last * 0.992     (wait for retest)
  // BREAKOUT   → STOP BUY  breakout * 1.002 (prove continuation)
  // MARKET BUY retired — no blind market entries
  // ============================================================

  if (
    parabolic
  ) {

    entryType =
      "STOP BUY";

    entry =
      breakout * 1.003;

  } else if (
    reclaim
  ) {

    entryType =
      "LIMIT BUY";

    entry =
      last * 0.992;

  } else if (
    breakoutSignal
  ) {

    entryType =
      "STOP BUY";

    entry =
      breakout * 1.002;

  }

  // ============================================================
  // STOP
  // ============================================================

  const recentLow =
    Math.min(
      ...lows.slice(-5)
    );

  const sl =
    recentLow * 0.995;

  if (
    sl >= entry
  ) {

    return null;

  }

  // ============================================================
  // TARGET
  // ============================================================

  let tp =
    entry * 1.06;

  if (
    parabolic
  ) {

    tp =
      entry * 1.10;

  }

  // ============================================================
  // RR
  // ============================================================

  const riskPct =
    (entry - sl) / entry;

  if (
    riskPct <= 0
  ) {

    return null;

  }

  const rewardPct =
    (tp - entry) / entry;

  const rr =

    (
      rewardPct / riskPct
    ).toFixed(1);

  if (
    rr < MIN_RR
  ) {

    return null;

  }

  // ============================================================
  // SCORE
  // ============================================================

  let score = 50;

  if (
    momentum > 0.01
  ) score += 10;

  if (
    volRatio > 1.5
  ) score += 10;

  if (
    breakoutSignal
  ) score += 10;

  if (
    reclaim
  ) score += 15;

  if (
    strongTrend
  ) score += 10;

  // ============================================================
  // GRADE
  // ============================================================

  let grade = "B";

  if (
    score >= 90
  ) {

    grade = "A*";

  }

  else if (
    score >= 75
  ) {

    grade = "A";

  }

  return {

    asset,
    market,

    grade,

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

    score,

    momentum,

    volRatio

  };

}

// ================================================================
// SIGNAL MESSAGE
// ================================================================

async function sendSignal(
  s
) {

  const icon =

    s.status === "PARABOLIC"

      ? "🔥"

      : "🚨";

  const marketIcon =

    s.market === "CRYPTO"

      ? "🪙"

      : s.market === "US"

      ? "🇺🇸"

      : "🇬🇧";

  await send(

`${icon} ${s.status} ${s.grade}

${marketIcon} ${s.asset}

🧠 ${s.setupType}

⚡ ${s.entryType}

🎯 ENTRY
${formatPrice(
  s.entry,
  s.market
)}

🛑 STOP
${formatPrice(
  s.sl,
  s.market
)}

💰 TARGET
${formatPrice(
  s.tp,
  s.market
)}

📊 R:R ${s.rr}

📈 ${(
  s.momentum * 100
).toFixed(2)}%

📊 VOL ${s.volRatio.toFixed(2)}x

🧠 SCORE ${s.score}

₿ ${btcTrend}`

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

  async function processAsset(
    asset,
    market,
    fetcher
  ) {

    if (
      cooldown(
        asset,
        alerts,
        market
      )
    ) {

      return;

    }

    const candles =
      await fetcher(asset);

    const signal =
      analyse(
        asset,
        candles,
        market
      );

    if (
      signal
    ) {

      results.push(
        signal
      );

    }

  }

  // CRYPTO

  if (
    ENABLE_CRYPTO
  ) {

    for (
      const pair of CRYPTO_PAIRS
    ) {

      await processAsset(
        pair,
        "CRYPTO",
        fetchCrypto
      );

    }

  }

  // US

  if (
    ENABLE_US &&
    isUSMarketOpen()
  ) {

    for (
      const stock of STOCK_POOL
    ) {

      await processAsset(
        stock,
        "US",
        fetchYahoo
      );

    }

  }

  // LSE

  if (
    ENABLE_LSE &&
    isLSEOpen()
  ) {

    for (
      const stock of LSE_POOL
    ) {

      await processAsset(
        stock,
        "LSE",
        fetchYahoo
      );

    }

  }

  return results

    .sort(
      (a, b) =>
        b.score -
        a.score
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

  const alerts =
    load(
      FILES.alerts,
      []
    );

  for (
    const s of signals
  ) {

    await sendSignal(s);

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

    await marketStatusCheck();

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
    "SNIPER V61 PRODUCTION RUNNING 🚀"
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

`🚀 SNIPER V61 PRODUCTION LIVE

✅ reclaim-priority continuation engine
✅ split volume: breakout 1.20x / reclaim 1.05x
✅ recentRun filter (blocks late impulsive entries)
✅ anti-chase hard limit 0.09
✅ setup-aware entries:
   📌 RECLAIM  → LIMIT BUY (retest zone)
   📌 BREAKOUT → STOP BUY  (prove continuation)
   📌 PARABOLIC → STOP BUY (breakout + buffer)
✅ MARKET BUY retired
✅ institutional trend filters
✅ crypto + US + LSE
✅ market open alerts enabled

🎯 V61 — execution-grade momentum engine active`

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
