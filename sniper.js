// ================================================================
// SNIPER V53
// INSTITUTIONAL MOMENTUM CONTINUATION ENGINE
// CRYPTO + US STOCKS + LSE
// EXECUTION-AWARE BREAKOUT SYSTEM
// ================================================================

console.log("🚀 SNIPER V53 STARTING...");

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
// SETTINGS
// ================================================================

const MAX_SIGNALS = 10;

const CRYPTO_COOLDOWN = 3;

const STOCK_COOLDOWN = 6;

const MAX_MOMENTUM = 0.12;

const BREAKOUT_THRESHOLD = 0.006;

const MIN_CONFIRM_CANDLES = 2;

// ================================================================
// PARABOLIC
// ================================================================

const PARABOLIC_MIN_VOL = 2.2;

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

  "SOLUSDT",
  "LINKUSDT",
  "INJUSDT",
  "NEARUSDT",
  "RENDERUSDT",

  "TIAUSDT",
  "ONDOUSDT",
  "SUIUSDT",
  "SEIUSDT",

  "AVAXUSDT",
  "ARBUSDT",
  "PYTHUSDT",

  "FETUSDT",
  "HBARUSDT"

];

// ================================================================
// US STOCKS
// ================================================================

const STOCK_POOL = [

  "NVDA",
  "AVGO",
  "AMD",
  "MU",

  "PLTR",
  "CRWD",

  "META",
  "MSFT",

  "APP",
  "COIN",
  "MSTR",

  "GEV",
  "VST",

  "LMT",

  "QQQ",
  "SOXL",
  "TQQQ"

];

// ================================================================
// LSE
// ================================================================

const LSE_POOL = [

  "RR.L",
  "BAB.L",

  "BARC.L",
  "LLOY.L",
  "STAN.L",

  "RIO.L",
  "ANTO.L",

  "BP.L",
  "SHEL.L"

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

  } catch {

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

  const confirmedBreakout =

    breakoutStrength >
    BREAKOUT_THRESHOLD;

  // ============================================================
  // BREAKOUT HOLD
  // ============================================================

  const heldBreakout =

    closes

      .slice(
        -MIN_CONFIRM_CANDLES
      )

      .every(
        c =>
          c > breakout
      );

  // ============================================================
  // VOLUME
  // ============================================================

  const avgVol =

    avg(
      volumes.slice(-20)
    );

  const currentVol =
    volumes.at(-1);

  const prevVol =
    volumes.at(-2);

  const volRatio =

    currentVol /
    avgVol;

  const volumeExpansion =

    currentVol >

    prevVol * 1.2;

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

  const ema20Prev =
    ema(
      closes.slice(
        0,
        -3
      ),
      20
    );

  const ema50Prev =
    ema(
      closes.slice(
        0,
        -3
      ),
      50
    );

  const strongTrend =

    ema20 > ema50;

  const risingTrend =

    ema20 > ema20Prev &&

    ema50 >= ema50Prev;

  // ============================================================
  // FILTERS
  // ============================================================

  if (

    !confirmedBreakout ||

    !heldBreakout ||

    !volumeExpansion ||

    !strongTrend ||

    !risingTrend

  ) {

    return null;

  }

  // ============================================================
  // MARKET FILTERS
  // ============================================================

  if (
    market === "CRYPTO"
  ) {

    let requiredVol =
      1.4;

    if (
      btcTrend !==
      "bullish"
    ) {

      requiredVol =
        1.8;

    }

    if (
      volRatio <
      requiredVol
    ) {

      return null;

    }

  } else {

    if (
      volRatio < 1.2
    ) {

      return null;

    }

  }

  // ============================================================
  // PARABOLIC
  // ============================================================

  const parabolic =

    momentum >
      PARABOLIC_MIN_MOMENTUM &&

    volRatio >
      PARABOLIC_MIN_VOL;

  // ============================================================
  // SCORE
  // ============================================================

  let score = 50;

  if (
    momentum > 0.01
  ) score += 10;

  if (
    momentum > 0.02
  ) score += 10;

  if (
    volRatio > 2
  ) score += 10;

  if (
    risingTrend
  ) score += 10;

  if (
    heldBreakout
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

  // ============================================================
  // STATUS
  // ============================================================

  let status =
    "CONFIRMED";

  if (
    parabolic
  ) {

    status =
      "PARABOLIC";

  }

  // ============================================================
  // STOP LOSS
  // ============================================================

  let sl =
    Math.min(
      ...lows.slice(-5)
    );

  // ============================================================
  // TAKE PROFIT
  // ============================================================

  let tp =
    last * 1.06;

  if (
    parabolic
  ) {

    tp =
      last * 1.08;

  }

  // ============================================================
  // ENTRY ENGINE
  // ============================================================

  const extensionFromEMA =

    (
      last - ema20
    ) / ema20;

  const extendedMove =

    extensionFromEMA > 0.04 ||

    momentum > 0.035;

  let entryType =
    "MARKET BUY";

  let entryPrice =
    last;

  // ------------------------------------------------------------

  if (

    breakoutStrength < 0.015 &&

    !extendedMove

  ) {

    entryType =
      "CONDITIONAL / STOP BUY";

    entryPrice =

      breakout * 1.003;

  }

  // ------------------------------------------------------------

  if (

    extendedMove &&

    !parabolic

  ) {

    entryType =
      "LIMIT BUY";

    entryPrice =

      breakout * 1.001;

  }

  // ------------------------------------------------------------

  if (
    parabolic
  ) {

    entryType =
      "CONDITIONAL / STOP BUY";

    entryPrice =

      breakout * 1.006;

  }

  // ============================================================
  // RR
  // ============================================================

  const riskPct =

    Math.abs(
      (
        entryPrice - sl
      ) / entryPrice
    ) * 100;

  const rewardPct =

    (
      (
        tp - entryPrice
      ) / entryPrice
    ) * 100;

  const rr =

    (
      rewardPct / riskPct
    ).toFixed(1);

  if (
    rr < 1.5
  ) {

    return null;

  }

  // ============================================================
  // SIZE
  // ============================================================

  let size =
    "SMALL";

  if (
    grade === "A"
  ) {

    size =
      "MEDIUM";

  }

  if (
    grade === "A*"
  ) {

    size =
      "LARGE";

  }

  return {

    asset,
    market,

    grade,
    status,

    entryType,

    entry:
      entryPrice,

    sl,

    tp,

    rr,

    size,

    momentum,

    volRatio,

    score

  };

}

// ================================================================
// SIGNAL MESSAGE
// ================================================================

async function sendSignal(
  s
) {

  let icon = "🚨";

  if (
    s.status ===
    "PARABOLIC"
  ) {

    icon = "🔥";

  }

  const marketIcon =

    s.market === "CRYPTO"

      ? "🪙"

      : s.market === "US"

      ? "🇺🇸"

      : "🇬🇧";

  await send(

`${icon} ${s.status} ${s.grade}

${marketIcon} ${s.asset}

⚡ ENTRY TYPE
${s.entryType}

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

💰 TAKE PROFIT
${formatPrice(
  s.tp,
  s.market
)}

📊 R:R
${s.rr}

💵 SIZE
${s.size}

📈 ${(
  s.momentum * 100
).toFixed(2)}%

📊 VOL
${s.volRatio.toFixed(2)}x

🧠 SCORE
${s.score}

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

  // ============================================================
  // CRYPTO
  // ============================================================

  if (
    ENABLE_CRYPTO
  ) {

    for (
      const pair of CRYPTO_PAIRS
    ) {

      if (
        cooldown(
          pair,
          alerts,
          "CRYPTO"
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

      if (
        signal
      ) {

        results.push(
          signal
        );

      }

    }

  }

  // ============================================================
  // US
  // ============================================================

  if (
    ENABLE_US &&
    isUSMarketOpen()
  ) {

    for (
      const stock of STOCK_POOL
    ) {

      if (
        cooldown(
          stock,
          alerts,
          "US"
        )
      ) {

        continue;

      }

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

      if (
        signal
      ) {

        results.push(
          signal
        );

      }

    }

  }

  // ============================================================
  // LSE
  // ============================================================

  if (
    ENABLE_LSE &&
    isLSEOpen()
  ) {

    for (
      const stock of LSE_POOL
    ) {

      if (
        cooldown(
          stock,
          alerts,
          "LSE"
        )
      ) {

        continue;

      }

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

      if (
        signal
      ) {

        results.push(
          signal
        );

      }

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

    await sendSignal(
      s
    );

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

  }

  catch (e) {

    console.log(
      "RUN ERROR:",
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
    "SNIPER V53 RUNNING 🚀"
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

`🚀 SNIPER V53 LIVE

✅ crypto + US + LSE
✅ institutional continuation logic
✅ breakout hold confirmation
✅ trend alignment
✅ execution-aware entries
✅ RR filtering
✅ fake breakout reduction

🎯 quality continuation setups only`

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
