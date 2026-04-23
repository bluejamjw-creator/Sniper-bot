// ================================================================
// SNIPER V35.1
// Stable Elite Momentum Scanner
// Optimised For Railway Stability
// Crypto + US Stocks + LSE
// ================================================================

console.log("🚀 SNIPER V35.1 STARTING...");

process.on("unhandledRejection", err => {
  console.error("UNHANDLED:", err);
});

process.on("uncaughtException", err => {
  console.error("UNCAUGHT:", err);
});

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
  trades: path.join(
    DATA_DIR,
    "trades.json"
  ),

  alerts: path.join(
    DATA_DIR,
    "alerts.json"
  )
};

// ================================================================
// STRATEGY
// ================================================================

const MAX_SIGNALS_PER_CYCLE = 3;

const MAX_OPEN_TRADES = 4;

const MIN_SCORE = 58;

const COOLDOWN_HOURS = 4;

const MIN_MOMENTUM = 0.001;

const MAX_MOMENTUM = 0.15;

const MIN_VOL_RATIO = 1.02;

const BREAKOUT_BUFFER = 1.0;

const MAX_TRADE_HOURS = 24;

const ENABLE_STOCKS = true;

const ENABLE_LSE = true;

// ================================================================
// STOCKS
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
  "UBER",
  "NFLX"

];

const LSE_POOL = [

  "RR.L",
  "BARC.L",
  "LLOY.L",
  "BP.L",
  "SHEL.L"

];

// ================================================================

let running = false;

let btcTrend = "neutral";

let GBP = 0.79;

let lastHeartbeatHour = null;

let lastUsOpenDay = null;

let lastLseOpenDay = null;

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
      FILES.trades
    )
  ) {

    fs.writeFileSync(
      FILES.trades,
      "[]"
    );

  }

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

}

function load(
  file,
  fallback = []
) {

  try {

    if (
      !fs.existsSync(file)
    ) {

      return fallback;

    }

    const raw =
      fs.readFileSync(
        file,
        "utf8"
      ).trim();

    if (!raw) {

      return fallback;

    }

    return JSON.parse(raw);

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
    ) / arr.length
  );

}

function ema(
  values,
  period
) {

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
      new Date(ts).getTime()
    ) / 36e5
  );

}

function fmtGBP(v) {

  return `£${Number(v).toFixed(2)}`;

}

function fmtUSD(v) {

  return `$${Number(v).toFixed(2)}`;

}

function toGBP(v) {

  return v * GBP;

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
// FX
// ================================================================

async function updateFX() {

  try {

    const { data } =
      await axios.get(

        "https://open.er-api.com/v6/latest/USD",

        {
          timeout: 10000
        }

      );

    if (
      data?.rates?.GBP
    ) {

      GBP =
        data.rates.GBP;

    }

  } catch (e) {

    console.log(
      "FX ERROR:",
      e.message
    );

  }

}

// ================================================================
// CRYPTO DISCOVERY
// ================================================================

async function getCryptoUniverse() {

  try {

    const { data } =
      await axios.get(

        "https://api.binance.com/api/v3/ticker/24hr",

        {
          timeout: 15000
        }

      );

    return data

      .filter(x =>
        x.symbol.endsWith(
          "USDT"
        )
      )

      .filter(
        x =>
          Number(
            x.quoteVolume
          ) > 3000000
      )

      .sort(
        (a, b) =>
          Number(
            b.quoteVolume
          ) -
          Number(
            a.quoteVolume
          )
      )

      .slice(0, 25)

      .map(
        x => x.symbol
      );

  } catch (e) {

    console.log(
      "UNIVERSE ERROR:",
      e.message
    );

    return [

      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
      "XRPUSDT",
      "DOGEUSDT"

    ];

  }

}

// ================================================================
// FETCH DATA
// ================================================================

async function fetchCrypto(
  symbol
) {

  const { data } =
    await axios.get(

      "https://api.binance.com/api/v3/klines",

      {
        params: {

          symbol,

          interval: "1h",

          limit: 120

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

async function fetchYahoo(
  symbol
) {

  try {

    const { data } =
      await axios.get(

        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,

        {
          params: {

            range: "1mo",

            interval: "1h"

          },

          timeout: 15000
        }

      );

    const result =
      data?.chart?.result?.[0];

    const quote =
      result?.indicators?.quote?.[0];

    if (
      !quote?.close?.length
    ) {

      return null;

    }

    return quote.close

      .map((c, i) => ({

        close: +c,

        high:
          +quote.high?.[i],

        volume:
          +(quote.volume?.[i] || 0)

      }))

      .filter(
        x => x.close
      );

  } catch (e) {

    console.log(
      "YAHOO ERROR:",
      symbol,
      e.message
    );

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
        x => x.close
      );

    const ema20 =
      ema(
        closes.slice(-30),
        20
      );

    const ema50 =
      ema(
        closes.slice(-60),
        50
      );

    const price =
      closes.at(-1);

    btcTrend =

      (
        price > ema20 &&
        ema20 > ema50
      )

      ? "bullish"

      : "neutral";

  } catch (e) {

    console.log(
      "BTC ERROR:",
      e.message
    );

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

  if (
    !candles ||
    candles.length < 50
  ) {

    console.log(
      asset,
      "REJECT short candles"
    );

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

  const ema9 =
    ema(
      closes.slice(-30),
      9
    );

  const ema21 =
    ema(
      closes.slice(-50),
      21
    );

  const momentum =
    (
      last - prev
    ) / prev;

  if (

    momentum <
      MIN_MOMENTUM ||

    momentum >
      MAX_MOMENTUM

  ) {

    return null;

  }

  const priorHigh =
    Math.max(
      ...highs.slice(
        -10,
        -1
      )
    );

  if (

    last <=
    priorHigh *
      BREAKOUT_BUFFER

  ) {

    return null;

  }

  const avgVol =
    avg(
      vols.slice(-20)
    );

  if (!avgVol) {

    return null;

  }

  const volRatio =
    vols.at(-1) /
    avgVol;

  if (
    volRatio <
    MIN_VOL_RATIO
  ) {

    return null;

  }

  let score = 50;

  if (
    ema9 > ema21
  ) {

    score += 10;

  }

  if (
    volRatio > 1.1
  ) {

    score += 8;

  }

  if (
    momentum > 0.003
  ) {

    score += 8;

  }

  if (

    type === "crypto" &&

    btcTrend === "bullish"

  ) {

    score += 10;

  }

  if (
    score < MIN_SCORE
  ) {

    return null;

  }

  const entry =
    last;

  const sl =
    entry * 0.97;

  const tp =
    entry * 1.08;

  return {

    asset,

    type,

    score,

    entry,

    sl,

    tp,

    volRatio,

    momentum

  };

}

// ================================================================
// FILTERS
// ================================================================

function hasOpenTrade(
  asset,
  trades
) {

  return trades.some(

    t =>

      t.asset === asset &&

      t.status === "open"

  );

}

function cooldownActive(
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

  const trades =
    load(
      FILES.trades
    );

  const alerts =
    load(
      FILES.alerts
    );

  const results = [];

  const openTrades =
    trades.filter(
      t =>
        t.status === "open"
    ).length;

  if (
    openTrades >=
    MAX_OPEN_TRADES
  ) {

    return [];

  }

  // CRYPTO

  const pairs =
    await getCryptoUniverse();

  for (
    const pair of pairs
  ) {

    try {

      if (
        hasOpenTrade(
          pair,
          trades
        )
      ) {
        continue;
      }

      if (
        cooldownActive(
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
          "crypto"
        );

      if (signal) {

        results.push(
          signal
        );

      }

    } catch (e) {

      console.log(
        "CRYPTO SCAN ERROR:",
        pair,
        e.message
      );

    }

  }

  // STOCKS

  if (
    ENABLE_STOCKS
  ) {

    for (
      const stock of STOCK_POOL
    ) {

      try {

        const candles =
          await fetchYahoo(
            stock
          );

        const signal =
          analyse(
            stock,
            candles,
            "stock"
          );

        if (signal) {

          results.push(
            signal
          );

        }

      } catch (e) {

        console.log(
          "STOCK ERROR:",
          stock,
          e.message
        );

      }

    }

  }

  // LSE

  if (
    ENABLE_LSE
  ) {

    for (
      const stock of LSE_POOL
    ) {

      try {

        const candles =
          await fetchYahoo(
            stock
          );

        const signal =
          analyse(
            stock,
            candles,
            "lse"
          );

        if (signal) {

          results.push(
            signal
          );

        }

      } catch (e) {

        console.log(
          "LSE ERROR:",
          stock,
          e.message
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
      MAX_SIGNALS_PER_CYCLE
    );

}

// ================================================================
// SIGNALS
// ================================================================

async function processSignals(
  signals
) {

  const trades =
    load(
      FILES.trades
    );

  const alerts =
    load(
      FILES.alerts
    );

  for (
    const s of signals
  ) {

    const msg =
`🚨 BREAKOUT ALERT

${s.asset}

Score:
${s.score}

Entry:
${s.type === "crypto"
? fmtGBP(toGBP(s.entry))
: fmtUSD(s.entry)}

TP:
${s.type === "crypto"
? fmtGBP(toGBP(s.tp))
: fmtUSD(s.tp)}

SL:
${s.type === "crypto"
? fmtGBP(toGBP(s.sl))
: fmtUSD(s.sl)}

Volume:
${s.volRatio.toFixed(2)}x

Momentum:
${(
  s.momentum * 100
).toFixed(2)}%

BTC:
${btcTrend}`;

    await send(msg);

    trades.push({

      ...s,

      status: "open",

      createdAt:
        nowIso()

    });

    alerts.push({

      asset: s.asset,

      sentAt:
        nowIso()

    });

  }

  save(
    FILES.trades,
    trades
  );

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

    await updateFX();

    await updateBTCTrend();

    const signals =
      await scan();

    console.log(
      "Signals:",
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

app.get(
  "/",
  (_req, res) => {

    res.send(
      "SNIPER V35.1 RUNNING"
    );

  }
);

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

    await send(`🚀 SNIPER V35.1 LIVE`);

    runCycle();

    setInterval(
      runCycle,
      600000
    );

  }
);
