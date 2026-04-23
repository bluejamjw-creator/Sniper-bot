// ================================================================
// SNIPER V29
// Elite Breakout Scanner
// Crypto + US Stocks + LSE
// Low spam / high quality setups
// Railway-safe
// ================================================================

console.log("🚀 SNIPER V29 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

// ================================================================
// APP
// ================================================================

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

// ================================================================
// FILES
// ================================================================

const FILES = {
  trades: path.join(DATA_DIR, "trades.json"),
  alerts: path.join(DATA_DIR, "alerts.json")
};

// ================================================================
// CONFIG
// ================================================================

const MAX_SIGNALS = 2;
const MAX_OPEN_TRADES = 3;

const MIN_CONFIDENCE = 75;

const MIN_MOMENTUM = 0.002;
const MAX_MOMENTUM = 0.12;

const MIN_VOL_RATIO = 1.18;

const BREAKOUT_BUFFER = 1.001;

const COOLDOWN_HOURS = 4;

const EXECUTION_CHECK_MINUTES = 5;

const OVERNIGHT_HOURS = 8;

const MIN_PROFIT_GBP = 3;

const MAX_MIN_STAKE = 100;

const ENABLE_STOCKS = true;
const ENABLE_LSE = true;

// ================================================================
// STOCKS
// ================================================================

const STOCK_POOL = [

  "AAPL",
  "MSFT",
  "NVDA",
  "TSLA",
  "AMD",

  "META",
  "GOOG",
  "AMZN",
  "PLTR",

  "COIN",
  "MSTR",
  "SMCI",

  "NFLX",
  "CRM",
  "ADBE",

  "UBER",
  "SHOP",
  "SNOW"
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

  "TSCO.L",
  "NWG.L",

  "VOD.L"
];

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
  "BONKUSDT",

  "FETUSDT",
  "TAOUSDT",

  "RNDRUSDT",

  "JUPUSDT",

  "ONDOUSDT",

  "SPKUSDT"
];

// ================================================================

let running = false;

let btcTrend = "neutral";

let GBP = 0.79;

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

  if (!fs.existsSync(FILES.trades)) {
    fs.writeFileSync(FILES.trades, "[]");
  }

  if (!fs.existsSync(FILES.alerts)) {
    fs.writeFileSync(FILES.alerts, "[]");
  }
}

function load(file, fallback) {

  try {

    if (!fs.existsSync(file)) {
      return fallback;
    }

    const raw =
      fs.readFileSync(file, "utf8").trim();

    if (!raw) return fallback;

    return JSON.parse(raw);

  } catch {

    return fallback;
  }
}

function save(file, data) {

  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2)
  );
}

function avg(arr) {

  if (!arr.length) return 0;

  return (
    arr.reduce((a, b) => a + b, 0) /
    arr.length
  );
}

function ema(values, period) {

  if (!values.length) return 0;

  const k = 2 / (period + 1);

  let out = values[0];

  for (let i = 1; i < values.length; i++) {

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

function minutesAgo(ts) {

  return (
    (Date.now() -
      new Date(ts).getTime()) /
    6e4
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
// SESSION
// ================================================================

function isUsRegularSessionNow() {

  const now = new Date();

  const hour = now.getUTCHours();

  const minute = now.getUTCMinutes();

  const day = now.getUTCDay();

  if (day === 0 || day === 6) {
    return false;
  }

  const total =
    hour * 60 + minute;

  return (
    total >= 13 * 60 + 30 &&
    total <= 20 * 60
  );
}

// ================================================================
// TELEGRAM
// ================================================================

async function send(msg) {

  if (!BOT_TOKEN || !CHAT_ID) {

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
        timeout: 20000
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
          timeout: 15000
        }
      );

    if (data?.rates?.GBP) {

      GBP = data.rates.GBP;
    }

  } catch {}
}

// ================================================================
// FETCH CRYPTO
// ================================================================

async function fetchCrypto(symbol) {

  const { data } =
    await axios.get(

      "https://api.binance.com/api/v3/klines",

      {
        params: {
          symbol,
          interval: "1h",
          limit: 120
        },

        timeout: 20000
      }
    );

  return data.map(k => ({

    close: +k[4],

    high: +k[2],

    volume: +k[5],

    ts: k[0]

  }));
}

// ================================================================
// FETCH STOCK
// ================================================================

async function fetchStock(symbol) {

  try {

    const { data } =
      await axios.get(

        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,

        {
          params: {
            range: "3mo",
            interval: "1d"
          },

          timeout: 20000
        }
      );

    const result =
      data?.chart?.result?.[0];

    const quote =
      result?.indicators?.quote?.[0];

    const timestamps =
      result?.timestamp || [];

    if (!quote?.close?.length) {
      return null;
    }

    return quote.close
      .map((c, i) => ({

        close: +c,

        high:
          +quote.high?.[i],

        volume:
          +(quote.volume?.[i] || 0),

        ts:
          timestamps[i]
            ? timestamps[i] * 1000
            : Date.now()

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

  try {

    const candles =
      await fetchCrypto("BTCUSDT");

    if (!candles ||
        candles.length < 60) {

      btcTrend = "neutral";

      return;
    }

    const closes =
      candles.map(c => c.close);

    const ema20 =
      ema(closes.slice(-30), 20);

    const ema50 =
      ema(closes.slice(-60), 50);

    const price =
      closes.at(-1);

    btcTrend =
      price > ema20 &&
      ema20 > ema50

        ? "bullish"

        : "neutral";

  } catch {

    btcTrend = "neutral";
  }
}

// ================================================================
// ANALYSE
// ================================================================

function analyse(
  asset,
  candles,
  type
) {

  if (!candles ||
      candles.length < 50) {

    return null;
  }

  const closes =
    candles.map(c => c.close);

  const highs =
    candles.map(c => c.high);

  const vols =
    candles.map(c => c.volume);

  const last =
    closes.at(-1);

  const prev =
    closes.at(-2);

  const ema9 =
    ema(closes.slice(-30), 9);

  const ema21 =
    ema(closes.slice(-50), 21);

  const momentum =
    (last - prev) / prev;

  if (
    momentum < MIN_MOMENTUM ||
    momentum > MAX_MOMENTUM
  ) {
    return null;
  }

  const priorHigh =
    Math.max(
      ...highs.slice(-20, -1)
    );

  if (
    last <=
    priorHigh * BREAKOUT_BUFFER
  ) {
    return null;
  }

  const breakoutStrength =

    (last - priorHigh) /
    priorHigh;

  if (breakoutStrength < 0.003) {

    return null;
  }

  const avgVol =
    avg(vols.slice(-20));

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

  // avoid mega overextension

  if (
    last > ema9 * 1.08
  ) {
    return null;
  }

  let confidence = 50;

  if (ema9 > ema21) {
    confidence += 10;
  }

  if (volRatio > 1.5) {
    confidence += 10;
  }

  if (momentum > 0.01) {
    confidence += 10;
  }

  if (breakoutStrength > 0.01) {
    confidence += 10;
  }

  if (
    type === "crypto" &&
    btcTrend === "bullish"
  ) {
    confidence += 10;
  }

  confidence =
    Math.min(confidence, 95);

  if (
    confidence <
    MIN_CONFIDENCE
  ) {
    return null;
  }

  let setupGrade = "B+";

  if (confidence >= 90) {

    setupGrade = "A+";

  } else if (
    confidence >= 82
  ) {

    setupGrade = "A";
  }

  const stopPct =

    type === "crypto"

      ? 0.035

      : 0.04;

  const takePct =

    type === "crypto"

      ? 0.12

      : 0.09;

  const entry = last;

  const sl =
    entry * (1 - stopPct);

  const tp =
    entry * (1 + takePct);

  const riskReward =

    (tp - entry) /
    (entry - sl);

  const minStake =

    type === "crypto"

      ? MIN_PROFIT_GBP /
        takePct

      : 0;

  if (
    type === "crypto" &&
    minStake >
    MAX_MIN_STAKE
  ) {
    return null;
  }

  return {

    asset,

    type,

    confidence,

    setupGrade,

    entry,

    sl,

    tp,

    volRatio,

    riskReward,

    breakoutStrength,

    minStake
  };
}

// ================================================================
// HELPERS
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

function alertCooldownActive(
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
    hoursAgo(found.sentAt) <
    COOLDOWN_HOURS
  );
}

// ================================================================
// SCAN
// ================================================================

async function scan() {

  const trades =
    load(FILES.trades, []);

  const alerts =
    load(FILES.alerts, []);

  const results = [];

  const openTrades =
    trades.filter(

      t =>
        t.status === "open"
    );

  if (
    openTrades.length >=
    MAX_OPEN_TRADES
  ) {
    return [];
  }

  // ====================
  // CRYPTO
  // ====================

  for (const pair of CRYPTO_PAIRS) {

    if (
      hasOpenTrade(pair, trades)
    ) {
      continue;
    }

    if (
      alertCooldownActive(
        pair,
        alerts
      )
    ) {
      continue;
    }

    try {

      const candles =
        await fetchCrypto(pair);

      const signal =
        analyse(
          pair,
          candles,
          "crypto"
        );

      if (signal) {
        results.push(signal);
      }

    } catch {}
  }

  // ====================
  // US STOCKS
  // ====================

  if (
    ENABLE_STOCKS &&
    isUsRegularSessionNow()
  ) {

    for (const stock of STOCK_POOL) {

      if (
        hasOpenTrade(
          stock,
          trades
        )
      ) {
        continue;
      }

      try {

        const candles =
          await fetchStock(stock);

        const signal =
          analyse(
            stock,
            candles,
            "stock"
          );

        if (signal) {
          results.push(signal);
        }

      } catch {}
    }
  }

  // ====================
  // LSE
  // ====================

  if (ENABLE_LSE) {

    for (const stock of LSE_POOL) {

      try {

        const candles =
          await fetchStock(stock);

        const signal =
          analyse(
            stock,
            candles,
            "stock"
          );

        if (signal) {
          results.push(signal);
        }

      } catch {}
    }
  }

  return results

    .sort(

      (a, b) =>

        b.confidence -
        a.confidence
    )

    .slice(0, MAX_SIGNALS);
}

// ================================================================
// PROCESS SIGNALS
// ================================================================

async function processSignals(
  signals
) {

  const trades =
    load(FILES.trades, []);

  const alerts =
    load(FILES.alerts, []);

  for (const s of signals) {

    const entry =

      s.type === "crypto"

        ? fmtGBP(
            toGBP(s.entry)
          )

        : fmtUSD(s.entry);

    const sl =

      s.type === "crypto"

        ? fmtGBP(
            toGBP(s.sl)
          )

        : fmtUSD(s.sl);

    const tp =

      s.type === "crypto"

        ? fmtGBP(
            toGBP(s.tp)
          )

        : fmtUSD(s.tp);

    const tpPct =

      (
        (
          (s.tp - s.entry) /
          s.entry
        ) * 100
      ).toFixed(2);

    const msg = `🚨 BREAKOUT ALERT

${s.asset}

Setup Grade:
${s.setupGrade}

Entry:
${entry}

Stop:
${sl}

Target:
${tp}

Potential Move:
+${tpPct}%

Volume Surge:
${s.volRatio.toFixed(2)}x

Breakout Strength:
${(
  s.breakoutStrength * 100
).toFixed(2)}%

Risk/Reward:
${s.riskReward.toFixed(2)}R

Suggested Stake:
£40 - £80

Status:
Watching for continuation`;

    await send(msg);

    trades.push({

      ...s,

      status: "open",

      createdAt:
        nowIso(),

      overnightSent: false
    });

    alerts.push({

      asset: s.asset,

      sentAt:
        nowIso()
    });
  }

  save(FILES.trades, trades);

  save(FILES.alerts, alerts);
}

// ================================================================
// MANAGE TRADES
// ================================================================

async function manageTrades() {

  const trades =
    load(FILES.trades, []);

  let changed = false;

  for (const t of trades) {

    if (
      t.status !== "open"
    ) {
      continue;
    }

    try {

      const candles =

        t.type === "crypto"

          ? await fetchCrypto(
              t.asset
            )

          : await fetchStock(
              t.asset
            );

      if (
        !candles ||
        !candles.length
      ) {
        continue;
      }

      const price =
        candles.at(-1).close;

      if (price >= t.tp) {

        t.status =
          "closed";

        t.result =
          "TP";

        changed = true;

        await send(

`✅ TARGET HIT

${t.asset}

Winner secured.`
        );

      } else if (
        price <= t.sl
      ) {

        t.status =
          "closed";

        t.result =
          "SL";

        changed = true;

        await send(

`❌ STOP LOSS HIT

${t.asset}`
        );
      }
    } catch {}
  }

  if (changed) {

    save(
      FILES.trades,
      trades
    );
  }
}

// ================================================================
// RUN
// ================================================================

async function runCycle() {

  if (running) return;

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

    if (signals.length) {

      await processSignals(
        signals
      );
    }

    await manageTrades();

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
      "SNIPER V29 RUNNING 🚀"
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

ensureFiles();

app.listen(
  PORT,
  "0.0.0.0",

  () => {

    console.log(
      `API running on ${PORT}`
    );

    runCycle();

    setInterval(
      runCycle,
      300000
    );
  }
);
