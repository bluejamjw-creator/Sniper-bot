// ================================================================
// SNIPER V23 TEST MODE
// Swing Momentum + Crypto + Stocks + Portfolio Rotation
// ================================================================

console.log("🚀 SNIPER V23 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ================================================================
// TEST MODE
// ================================================================

const TEST_MODE = true;

// ================================================================
// CONFIG
// ================================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const DATA_DIR = "./data";

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const TRADES_FILE = path.join(DATA_DIR, "trades.json");

const MIN_CONFIDENCE = 48;
const MAX_SIGNALS = 3;

const SPREAD_PCT = 0.02;

const MIN_PROFIT_GBP = 1;

const MIN_STAKE_BUFFER_MULT = 1.3;

const MAX_MIN_STAKE = 175;

const REVOLUT_PLAN =
  (process.env.REVOLUT_PLAN || "standard")
    .toLowerCase();

const MONTHLY_VOLUME_GBP =
  Number(process.env.MONTHLY_VOLUME_GBP || 0);

const STATIC_PAIRS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "ADAUSDT",
  "NEARUSDT",
  "SUIUSDT",
  "PEPEUSDT",
  "HBARUSDT",
  "UNIUSDT",
  "ONDOUSDT",
  "TAOUSDT",
  "SEIUSDT",
  "INJUSDT",
  "AAVEUSDT"
];

const BINANCE_BASES = [
  "https://api.binance.com",
  "https://data-api.binance.vision"
];

// ================================================================
// STORAGE
// ================================================================

function load(file) {

  try {

    if (!fs.existsSync(file))
      return [];

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
// TELEGRAM
// ================================================================

async function send(msg) {

  if (!BOT_TOKEN || !CHAT_ID)
    return;

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
      "TELEGRAM_ERROR:",
      e.message
    );

  }
}

// ================================================================
// HELPERS
// ================================================================

function ema(values, period) {

  if (
    !values ||
    values.length < period
  ) return null;

  const k = 2 / (period + 1);

  let e = values[0];

  for (let i = 1; i < values.length; i++) {

    e =
      values[i] * k +
      e * (1 - k);

  }

  return e;
}

function avg(arr) {

  if (!arr || !arr.length)
    return null;

  return (
    arr.reduce((a, b) => a + b, 0)
    / arr.length
  );
}

function clamp(n, min, max) {

  return Math.max(
    min,
    Math.min(max, n)
  );

}

function fmtGBP(v) {

  return `£${Number(v).toFixed(2)}`;

}

// ================================================================
// FEES
// ================================================================

function getRevolutFeePct(
  plan,
  monthlyVolumeGBP
) {

  const tiers = [

    {
      max: 10000,
      standard: 0.0149,
      premium: 0.0099,
      ultra: 0.0049
    },

    {
      max: 50000,
      standard: 0.0129,
      premium: 0.0079,
      ultra: 0.0039
    },

    {
      max: Infinity,
      standard: 0.0049,
      premium: 0.0029,
      ultra: 0
    }

  ];

  const tier =
    tiers.find(
      t => monthlyVolumeGBP < t.max
    ) || tiers[tiers.length - 1];

  return tier[plan]
    ?? tier.standard;

}

function totalFrictionPct(feePct) {

  return (
    feePct +
    feePct +
    SPREAD_PCT
  );

}

function realBuy(price, feePct) {

  return price * (
    1 +
    feePct +
    SPREAD_PCT
  );

}

function realSell(price, feePct) {

  return price * (
    1 -
    feePct -
    SPREAD_PCT
  );

}

function minStakeRequired(
  entry,
  tp,
  feePct
) {

  const effectiveEntry =
    realBuy(entry, feePct);

  const effectiveExit =
    realSell(tp, feePct);

  const netPct =
    (
      effectiveExit -
      effectiveEntry
    ) / effectiveEntry;

  if (netPct <= 0)
    return Infinity;

  return (
    MIN_PROFIT_GBP *
    MIN_STAKE_BUFFER_MULT
  ) / netPct;

}

// ================================================================
// FX
// ================================================================

let GBP = 0.79;

async function updateFX() {

  try {

    const { data } =
      await axios.get(
        "https://open.er-api.com/v6/latest/USD"
      );

    if (data?.rates?.GBP) {
      GBP = data.rates.GBP;
    }

  } catch {}

}

function toGBP(v) {

  return v * GBP;

}

// ================================================================
// BINANCE FETCH
// ================================================================

async function safeBinanceGet(
  endpoint,
  params = {}
) {

  for (const base of BINANCE_BASES) {

    try {

      const { data } =
        await axios.get(
          `${base}${endpoint}`,
          {
            params,
            timeout: 10000
          }
        );

      return data;

    } catch {

      console.log(
        `FAIL ${base}`
      );

    }
  }

  throw new Error(
    "All Binance endpoints failed"
  );

}

// ================================================================
// BTC TREND
// ================================================================

let btcTrend = "neutral";

async function updateBTC() {

  try {

    const data =
      await safeBinanceGet(
        "/api/v3/klines",
        {
          symbol: "BTCUSDT",
          interval: "4h",
          limit: 55
        }
      );

    const closes =
      data.map(x => +x[4]);

    const e20 =
      ema(closes.slice(-30), 20);

    const e50 =
      ema(closes.slice(-50), 50);

    const price =
      closes.at(-1);

    if (
      price > e20 &&
      e20 > e50
    ) {

      btcTrend = "up";

    }

    else if (
      price < e20 &&
      e20 < e50
    ) {

      btcTrend = "down";

    }

    else {

      btcTrend = "neutral";

    }

  } catch {

    btcTrend = "neutral";

  }

}

// ================================================================
// PAIRS
// ================================================================

async function getPairs() {

  try {

    const data =
      await safeBinanceGet(
        "/api/v3/ticker/24hr"
      );

    return data
      .filter(
        x =>
          x.symbol.endsWith(
            "USDT"
          )
      )
      .filter(
        x =>
          parseFloat(
            x.quoteVolume
          ) > 1000000
      )
      .slice(0, 40)
      .map(x => x.symbol);

  } catch {

    return STATIC_PAIRS;

  }

}

// ================================================================
// CANDLES
// ================================================================

async function fetchCandles(
  symbol
) {

  try {

    const data =
      await safeBinanceGet(
        "/api/v3/klines",
        {
          symbol,
          interval: "1h",
          limit: 120
        }
      );

    return data.map(k => ({
      c: +k[4],
      h: +k[2],
      v: +k[5]
    }));

  } catch {

    return null;

  }

}

// ================================================================
// ANALYSIS
// ================================================================

function analyse(
  symbol,
  candles,
  rejected
) {

  if (
    !candles ||
    candles.length < 50
  ) {

    rejected.shortData++;

    return null;

  }

  const feePct =
    getRevolutFeePct(
      REVOLUT_PLAN,
      MONTHLY_VOLUME_GBP
    );

  const closes =
    candles.map(c => c.c);

  const highs =
    candles.map(c => c.h);

  const vols =
    candles.map(c => c.v);

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

  if (
    !last ||
    !prev ||
    !ema9 ||
    !ema21
  ) {

    return null;

  }

  const emaBullish =
    ema9 >
    ema21 * 0.997;

  const priorHigh =
    Math.max(
      ...highs.slice(-21, -1)
    );

  const breakout =
    last >=
    priorHigh * 0.995;

  const momentum =
    (last - prev)
    / prev;

  // TEMP SOFTENED

  if (
    momentum < 0.0002
  ) {

    rejected.lowMomentum++;

    return null;

  }

  const avgVol =
    avg(
      vols.slice(-20)
    );

  const volRatio =
    avgVol
      ? vols.at(-1)
        / avgVol
      : 1;

  let confidence = 45;

  if (emaBullish)
    confidence += 12;

  if (breakout)
    confidence += 15;

  if (
    momentum > 0.001
  )
    confidence += 10;

  if (
    momentum > 0.003
  )
    confidence += 8;

  if (
    volRatio > 1.1
  )
    confidence += 8;

  if (
    btcTrend === "up"
  )
    confidence += 8;

  if (
    btcTrend === "down"
  )
    confidence -= 5;

  confidence =
    Math.round(
      clamp(
        confidence,
        0,
        99
      )
    );

  if (
    confidence <
    MIN_CONFIDENCE
  ) {

    rejected.lowConfidence++;

    return null;

  }

  const frictionPct =
    totalFrictionPct(
      feePct
    );

  // SWING TARGETS

  const minMove =
    frictionPct + 0.08;

  const entry = last;

  const sl =
    entry * 0.96;

  const tp =
    entry *
    (1 + minMove);

  const minStake =
    minStakeRequired(
      entry,
      tp,
      feePct
    );

  if (
    minStake >
    MAX_MIN_STAKE
  ) {

    rejected.highMinStake++;

    return null;

  }

  return {

    asset: symbol,

    entry,

    sl,

    tp,

    confidence,

    minStake,

    volRatio,

    btcTrend,

    breakout

  };

}

// ================================================================
// SCAN
// ================================================================

async function scan() {

  console.log(
    "=== V23 SCAN ==="
  );

  await updateFX();

  await updateBTC();

  const pairs =
    await getPairs();

  console.log(
    `Pairs: ${pairs.length} BTC: ${btcTrend}`
  );

  const rejected = {

    lowMomentum: 0,
    lowConfidence: 0,
    shortData: 0,
    highMinStake: 0

  };

  const results = [];

  for (const p of pairs) {

    const data =
      await fetchCandles(p);

    const r =
      analyse(
        p,
        data,
        rejected
      );

    if (r)
      results.push(r);

  }

  console.log(
    "Rejected:",
    JSON.stringify(rejected)
  );

  return results
    .sort(
      (a, b) =>
        b.confidence -
        a.confidence
    )
    .slice(
      0,
      MAX_SIGNALS
    );

}

// ================================================================
// MAIN LOOP
// ================================================================

let running = false;

async function runCycle() {

  if (running)
    return;

  running = true;

  try {

    const signals =
      await scan();

    // ============================================================
    // TEST ALERTS
    // ============================================================

    if (TEST_MODE) {

      await send(
`🚨 TEST CRYPTO SIGNAL

PEPEUSDT

Type: Swing Breakout
Confidence: 82
Momentum: Strong

This confirms crypto alerts work.
`
      );

      await send(
`📈 TEST STOCK SIGNAL

NVDA

Type: Daily Breakout
Relative Volume: 2.4x

This confirms stock alerts work.
`
      );

      await send(
`🔄 TEST PORTFOLIO ROTATION

Reduce: ADA
Increase: SOL

Reason:
Stronger momentum structure

This confirms portfolio rotation alerts work.
`
      );

    }

    console.log(
      "Signals:",
      signals.length
    );

    const trades =
      load(
        TRADES_FILE
      );

    for (const s of signals) {

      if (
        trades.find(
          t =>
            t.asset ===
              s.asset &&
            t.status !==
              "closed"
        )
      ) {
        continue;
      }

      trades.push({

        ...s,

        status: "open",

        createdAt:
          new Date()
            .toISOString()

      });

      await send(

`🚨 V23 LIVE SIGNAL

${s.asset}

Confidence: ${s.confidence}

BTC Trend: ${s.btcTrend}

Entry:
${fmtGBP(toGBP(s.entry))}

TP:
${fmtGBP(toGBP(s.tp))}

SL:
${fmtGBP(toGBP(s.sl))}

Volume:
${s.volRatio.toFixed(2)}x

Min
