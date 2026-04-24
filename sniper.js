// ================================================================
// SNIPER V34
// ELITE MOMENTUM SCANNER
// CRYPTO + US + LSE
// PREMARKET + BREAKOUT CONFIRMATION
// ADVANCED TRADE MANAGEMENT
// ================================================================

console.log("🚀 SNIPER V45 STARTING...");

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

const MAX_SIGNALS = 10;

const CRYPTO_COOLDOWN = 2;

const STOCK_COOLDOWN = 1;

const BREAKOUT_BUFFER = 0.995;

const MAX_MOMENTUM = 0.35;

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
  "XRPUSDT",
  "DOGEUSDT",

  "AVAXUSDT",
  "LINKUSDT",
  "INJUSDT",
  "SUIUSDT",

  "SEIUSDT",
  "PEPEUSDT",

  "FETUSDT",
  "RENDERUSDT",

  "TAOUSDT",
  "ONDOUSDT",

  "HBARUSDT",
  "ENSUSDT",

  "DYDXUSDT",
  "UNIUSDT",

  "ETCUSDT"

];

// ================================================================
// US STOCKS
// ================================================================

const STOCK_POOL = [

  "AMD",
  "NVDA",
  "PLTR",
  "TSLA",

  "META",
  "AMZN",
  "MSFT",
  "GOOG",

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

  "BARC.L",
  "LLOY.L",
  "RR.L",

  "BP.L",
  "SHEL.L",

  "HSBA.L",

  "RIO.L"

];

// ================================================================

let running = false;

let btcTrend = "neutral";

let usMarketWasOpen = false;

let lseMarketWasOpen = false;

let lastStatusHour = null;

// ================================================================
// STATS
// ================================================================

const stats = {

  scanned: 0,

  signals: 0,

  watch: 0,

  moving: 0

};

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

function hoursOpen(
  ts
) {

  return (

    Date.now() - ts

  ) / 36e5;

}

function formatPrice(
  value,
  currency
) {

  const gbp =
    value * 0.75;

  if (value >= 1000) {

    return `${currency}${value.toFixed(0)}`;

  }

  if (value >= 1) {

    return `${currency}${value.toFixed(2)} | £${gbp.toFixed(2)}`;

  }

  return `${currency}${value.toFixed(4)} | £${gbp.toFixed(4)}`;

}

function getRisk(
  entry,
  sl
) {

  const risk =

    (
      (entry - sl) /
      entry
    ) * 100;

  if (risk < 3) {
    return "LOW";
  }

  if (risk <= 5) {
    return "MED";
  }

  return "HIGH";

}

// ================================================================
// MARKET HOURS
// ================================================================

function isUSMarketOpen() {

  const now =
    new Date();

  const h =
    now.getHours();

  const d =
    now.getDay();

  if (
    d === 0 ||
    d === 6
  ) {
    return false;
  }

  return (
    h >= 14 &&
    h < 21
  );

}

function isUSPremarket() {

  const now =
    new Date();

  const h =
    now.getHours();

  const d =
    now.getDay();

  if (
    d === 0 ||
    d === 6
  ) {
    return false;
  }

  return (
    h >= 12 &&
    h < 14
  );

}

function isLSEOpen() {

  const now =
    new Date();

  const h =
    now.getHours();

  const d =
    now.getDay();

  if (
    d === 0 ||
    d === 6
  ) {
    return false;
  }

  return (
    h >= 8 &&
    h < 16
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
// FETCH STOCKS
// 5m candles for premarket momentum
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

  stats.scanned++;

  if (
    !candles ||
    candles.length < 20
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

  const nearBreakout =

    last >=
    breakout *
      BREAKOUT_BUFFER;

  if (
    !nearBreakout
  ) {
    return null;
  }

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

  const moving =

    momentum > 0.008 &&
    volRatio > 1.15;

  const hot =

    momentum > 0.025 &&
    volRatio > 2;

  if (
    grade === "B" &&
    !moving &&
    !hot
  ) {
    return null;
  }

  let status =
    "WATCH";

  if (
    grade === "A*" &&
    volRatio > 1.8
  ) {

    status =
      "READY";

  }

  const entry =
    last;

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

  stats.signals++;

  if (
    status === "WATCH"
  ) {
    stats.watch++;
  }

  if (moving) {
    stats.moving++;
  }

  return {

    asset,
    market,

    grade,
    status,

    momentum,
    volRatio,

    entry,
    sl,
    tp,

    currency,

    moving,
    hot,

    risk:
      getRisk(
        entry,
        sl
      )

  };

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

  for (const pair of CRYPTO_PAIRS) {

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

    if (signal) {
      results.push(signal);
    }

  }

  // ============================================================
  // US + PREMARKET
  // ============================================================

  if (

    ENABLE_US &&

    (
      isUSMarketOpen() ||
      isUSPremarket()
    )

  ) {

    for (const stock of STOCK_POOL) {

      const candles =
        await fetchStock(
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

  // ============================================================
  // LSE
  // ============================================================

  if (
    ENABLE_LSE &&
    isLSEOpen()
  ) {

    for (const stock of LSE_POOL) {

      const candles =
        await fetchStock(
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

        b.volRatio -
        a.volRatio

    )

    .slice(
      0,
      MAX_SIGNALS
    );

}

// ================================================================
// STATUS
// ================================================================

async function sendStatus() {

  const hour =
    new Date()
      .getHours();

  if (
    lastStatusHour ===
    hour
  ) {
    return;
  }

  lastStatusHour =
    hour;

  await send(

`🔎 STATUS

✅ Crypto
${isUSMarketOpen() || isUSPremarket() ? "✅" : "⏸️"} US
${isLSEOpen() ? "✅" : "⏸️"} LSE

₿ ${btcTrend}

📡 ${stats.scanned}
🚨 ${stats.signals}
👀 ${stats.watch}
📈 ${stats.moving}`

  );

}

// ================================================================
// MARKET OPEN ALERTS
// ================================================================

async function marketOpenCheck() {

  const us =
    isUSMarketOpen();

  const lse =
    isLSEOpen();

  if (
    us &&
    !usMarketWasOpen
  ) {

    await send(

`🇺🇸 US MARKET OPEN`

    );

  }

  if (
    lse &&
    !lseMarketWasOpen
  ) {

    await send(

`🇬🇧 LSE OPEN`

    );

  }

  usMarketWasOpen =
    us;

  lseMarketWasOpen =
    lse;

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
      "READY"
    ) {
      icon = "🚨";
    }

    if (
      s.hot
    ) {
      icon = "🔥";
    }

    if (
      s.moving &&
      s.grade === "B"
    ) {
      icon = "📈";
    }

    await send(

`${icon} ${s.status} ${s.grade}

${s.moving && s.grade === "B"
  ? "Momentum Building\n"
  : ""}${market} ${s.asset}

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

⚠️ ${s.risk}

₿ ${btcTrend}`

    );

    trades.push({

      asset:
        s.asset,

      market:
        s.market,

      entry:
        s.entry,

      sl:
        s.sl,

      tp:
        s.tp,

      currency:
        s.currency,

      status:
        "OPEN",

      entryTime:
        Date.now(),

      createdAt:
        nowIso(),

      highestPrice:
        s.entry,

      breakevenSent:
        false,

      partialSent:
        false,

      stalledSent:
        false

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
      t.status !==
      "OPEN"
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
        await fetchStock(
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
      price >
      t.highestPrice
    ) {

      t.highestPrice =
        price;

    }

    const profitPct =

      (
        (
          price -
          t.entry
        ) /

        t.entry

      ) * 100;

    const hrs =
      hoursOpen(
        t.entryTime
      );

    // ==========================================================
    // BREAKEVEN
    // ==========================================================

    if (

      profitPct >= 4 &&

      !t.breakevenSent

    ) {

      t.breakevenSent =
        true;

      changed = true;

      await send(

`🔒 BREAKEVEN

${t.asset}

📈 +${profitPct.toFixed(2)}%`

      );

    }

    // ==========================================================
    // PARTIALS
    // ==========================================================

    if (

      profitPct >= 6 &&

      !t.partialSent

    ) {

      t.partialSent =
        true;

      changed = true;

      await send(

`💰 PARTIAL PROFIT

${t.asset}

📈 +${profitPct.toFixed(2)}%`

      );

    }

    // ==========================================================
    // STALLED
    // ==========================================================

    if (

      hrs >= 24 &&

      profitPct < 2 &&

      !t.stalledSent

    ) {

      t.stalledSent =
        true;

      changed = true;

      await send(

`⏰ TRADE STALLED

${t.asset}

⏱ ${hrs.toFixed(1)}h

📈 ${profitPct.toFixed(2)}%`

      );

    }

    // ==========================================================
    // TP
    // ==========================================================

    if (
      price >= t.tp
    ) {

      t.status = "TP";

      changed = true;

      await send(

`✅ TP HIT

${t.asset}

💰 ${formatPrice(
  price,
  t.currency
)}`

      );

    }

    // ==========================================================
    // SL
    // ==========================================================

    else if (
      price <= t.sl
    ) {

      t.status = "SL";

      changed = true;

      await send(

`❌ SL HIT

${t.asset}

📉 ${formatPrice(
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

  stats.scanned = 0;
  stats.signals = 0;
  stats.watch = 0;
  stats.moving = 0;

  try {

    ensureFiles();

    await updateBTCTrend();

    await marketOpenCheck();

    const signals =
      await scan();

    console.log(
      `Signals: ${signals.length}`
    );

    await sendStatus();

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
    "SNIPER V45 RUNNING 🚀"
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

`🚀 SNIPER V45 LIVE

✅ Premarket scanning
✅ READY alerts
✅ WATCH alerts
✅ Momentum alerts
✅ TP / SL tracking
✅ Trade management
✅ Market open alerts`

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
