// ================================================================
// SNIPER V34
// ELITE MOMENTUM BREAKOUT SCANNER
// CLEAN COMPACT ALERTS
// SMART CRYPTO + STOCK FILTERING
// ================================================================

console.log("🚀 SNIPER V39 STARTING...");

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

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";

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

const COOLDOWN_HOURS = 2;

// CRYPTO

const CRYPTO_MIN_MOMENTUM = 0.004;
const CRYPTO_MIN_VOL = 1.15;

// STOCKS

const STOCK_MIN_MOMENTUM = 0.01;
const STOCK_MIN_VOL = 1.05;

// STRICTER AGAIN

const BREAKOUT_BUFFER = 1.0;

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

  "SEIUSDT",
  "PEPEUSDT",
  "FETUSDT",
  "RENDERUSDT",

  "TAOUSDT",
  "ONDOUSDT",
  "NEARUSDT",

  "ADAUSDT",
  "DOTUSDT",

  "TIAUSDT",
  "PYTHUSDT",

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

  "NVDA",
  "TSLA",
  "PLTR",
  "AMD",
  "META",

  "COIN",
  "MSTR",

  "AMZN",
  "AAPL",

  "MSFT"

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

  "HSBA.L"

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

  if (!fs.existsSync(FILES.alerts)) {

    fs.writeFileSync(
      FILES.alerts,
      "[]"
    );

  }

  if (!fs.existsSync(FILES.trades)) {

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

  const gbp =
    value * 0.75;

  if (value >= 1000) {

    return `${currency}${value.toFixed(0)}`;

  }

  if (value >= 1) {

    return `${currency}${value.toFixed(2)} (£${gbp.toFixed(2)})`;

  }

  return `${currency}${value.toFixed(4)} (£${gbp.toFixed(4)})`;

}

function getRisk(entry, sl) {

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

    console.log(
      "Telegram Error:",
      e.message
    );

  }

}

// ================================================================
// FETCH
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

async function fetchYahoo(symbol) {

  try {

    const { data } =

      await axios.get(

        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,

        {

          params: {

            range: "3mo",
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
        high: +quote.high?.[i],
        volume: +quote.volume?.[i]

      }))

      .filter(x => x.close);

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
      c => c.close
    );

  const ema20 =
    ema(closes, 20);

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

  const volRatio =

    vols.at(-1) /

    avg(
      vols.slice(-15)
    );

  const breakout =

    Math.max(
      ...highs.slice(-10)
    );

  const nearBreakout =

    last >=
    breakout *
      BREAKOUT_BUFFER;

  // ============================================================
  // FILTERS
  // ============================================================

  if (market === "CRYPTO") {

    if (
      momentum <
      CRYPTO_MIN_MOMENTUM
    ) {
      return null;
    }

    if (
      volRatio <
      CRYPTO_MIN_VOL
    ) {
      return null;
    }

  } else {

    if (
      momentum <
      STOCK_MIN_MOMENTUM
    ) {
      return null;
    }

    if (
      volRatio <
      STOCK_MIN_VOL
    ) {
      return null;
    }

  }

  if (!nearBreakout) {
    return null;
  }

  // ============================================================
  // SCORE
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

  // ============================================================
  // ONLY GOOD STUFF
  // ============================================================

  if (grade === "B") {
    return null;
  }

  const status =

    grade === "A*"

      ? "READY"

      : "WATCH";

  const entry = last;
  const sl = last * 0.96;
  const tp = last * 1.08;

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

    risk:
      getRisk(
        entry,
        sl
      ),

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
    ) <
    COOLDOWN_HOURS

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

  // ============================================================
  // US
  // ============================================================

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

  // ============================================================
  // LSE
  // ============================================================

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

    const icon =

      s.status === "READY"

        ? "🚨"

        : "👀";

    const market =

      s.market === "CRYPTO"

        ? "🪙"

        : s.market === "US"

        ? "🇺🇸"

        : "🇬🇧";

    const msg =

`${icon} ${s.status} • ${s.grade}

${market} ${s.asset}

🎯 ${formatPrice(s.entry, s.currency)}
🛑 ${formatPrice(s.sl, s.currency)}
💰 ${formatPrice(s.tp, s.currency)}

📈 ${(s.momentum * 100).toFixed(2)}%
📊 ${s.volRatio.toFixed(2)}x
⚠️ ${s.risk}
₿ ${btcTrend}`;

    await send(msg);

    alerts.push({

      asset: s.asset,
      sentAt: nowIso()

    });

    trades.push({

      asset: s.asset,

      market: s.market,

      entry: s.entry,

      sl: s.sl,

      tp: s.tp,

      currency: s.currency,

      status: "OPEN",

      createdAt: nowIso()

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

`✅ TP HIT

${t.asset}

🏆 WIN`

      );

    }

    else if (
      price <= t.sl
    ) {

      t.status = "SL";

      changed = true;

      await send(

`❌ SL HIT

${t.asset}

Trade closed`

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
    "SNIPER V39 RUNNING 🚀"
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

`🚀 SNIPER V39 LIVE

✅ Compact alerts
✅ Smarter filtering
✅ Better crypto quality
✅ Improved stock detection`

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
