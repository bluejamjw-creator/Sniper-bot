// ================================================================
// SNIPER V29 ELITE
// Elite breakout scanner
// Crypto + US Stocks + LSE Stocks
// High-quality setups only
// Re-breakout detection
// TP1 / TP2 targets
// Trailing stop alerts
// Anti-spam protection
// Railway safe
// ================================================================

console.log("🚀 SNIPER V29 ELITE STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

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

const FILES = {
  trades: path.join(DATA_DIR, "trades.json"),
  alerts: path.join(DATA_DIR, "alerts.json")
};

// ================================================================
// SETTINGS
// ================================================================

const MAX_SIGNALS = 2;
const MAX_OPEN_TRADES = 5;

const MIN_SCORE = 82;

const CRYPTO_COOLDOWN_HOURS = 4;
const STOCK_COOLDOWN_HOURS = 12;

const MIN_MOMENTUM = 0.004;
const MAX_MOMENTUM = 0.18;

const MIN_VOL_RATIO = 1.8;

const BREAKOUT_BUFFER = 1.002;

const ENABLE_STOCKS = true;

// ================================================================
// US STOCKS
// ================================================================

const US_STOCKS = [

  "NVDA",
  "TSLA",
  "AMD",
  "PLTR",
  "META",
  "AMZN",
  "GOOG",
  "COIN",
  "MSTR",
  "SMCI",
  "NFLX",
  "SHOP",
  "HOOD",
  "SNOW"

];

// ================================================================
// LSE
// ================================================================

const LSE_STOCKS = [

  "RR.L",
  "BARC.L",
  "LLOY.L",
  "BP.L",
  "SHEL.L",
  "VOD.L",
  "HSBA.L",
  "NWG.L",
  "TSCO.L",
  "GLEN.L"

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

  "RNDRUSDT",
  "TAOUSDT",
  "ARKMUSDT",
  "TIAUSDT",
  "JUPUSDT",

  "ONDOUSDT",
  "SPKUSDT"

];

// ================================================================

let running = false;

let btcTrend = "neutral";

let GBP = 0.79;

// ================================================================

function nowIso() {
  return new Date().toISOString();
}

// ================================================================

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

// ================================================================

function load(file, fallback) {

  try {

    if (!fs.existsSync(file)) {
      return fallback;
    }

    const raw =
      fs.readFileSync(file, "utf8").trim();

    if (!raw) {
      return fallback;
    }

    return JSON.parse(raw);

  } catch {

    return fallback;

  }

}

// ================================================================

function save(file, data) {

  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2)
  );

}

// ================================================================

function avg(arr) {

  return (
    arr.reduce((a, b) => a + b, 0) /
    arr.length
  );

}

// ================================================================

function ema(values, period) {

  const k = 2 / (period + 1);

  let out = values[0];

  for (let i = 1; i < values.length; i++) {

    out =
      values[i] * k +
      out * (1 - k);

  }

  return out;

}

// ================================================================

function hoursAgo(ts) {

  return (
    (Date.now() -
      new Date(ts).getTime()) /
    36e5
  );

}

// ================================================================

function fmtGBP(v) {

  if (v < 1) {
    return `£${Number(v).toFixed(4)}`;
  }

  return `£${Number(v).toFixed(2)}`;

}

// ================================================================

function fmtUSD(v) {

  return `$${Number(v).toFixed(2)}`;

}

// ================================================================

function toGBP(v) {

  return v * GBP;

}

// ================================================================
// US MARKET SESSION
// ================================================================

function isUsRegularSessionNow() {

  const now = new Date();

  const est = new Date(
    now.toLocaleString(
      "en-US",
      {
        timeZone:
          "America/New_York"
      }
    )
  );

  const day = est.getDay();

  if (day === 0 || day === 6) {
    return false;
  }

  const mins =
    est.getHours() * 60 +
    est.getMinutes();

  return mins >= 570 &&
         mins < 960;

}

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
        }
      }

    );

  return data.map(k => ({

    close: +k[4],

    high: +k[2],

    volume: +k[5]

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
          }
        }

      );

    const result =
      data?.chart?.result?.[0];

    const quote =
      result?.indicators?.quote?.[0];

    if (!quote?.close?.length) {
      return null;
    }

    return quote.close
      .map((c, i) => ({

        close: +c,

        high: +quote.high?.[i],

        volume:
          +(quote.volume?.[i] || 0)

      }))
      .filter(x => x.close);

  } catch {

    return null;

  }

}

// ================================================================

async function updateBTCTrend() {

  try {

    const candles =
      await fetchCrypto(
        "BTCUSDT"
      );

    const closes =
      candles.map(c => c.close);

    const ema20 =
      ema(closes.slice(-30), 20);

    const ema50 =
      ema(closes.slice(-60), 50);

    const price =
      closes.at(-1);

    btcTrend =
      (
        price > ema20 &&
        ema20 > ema50
      )
        ? "bullish"
        : "neutral";

  } catch {

    btcTrend = "neutral";

  }

}

// ================================================================
// SCORE LABEL
// ================================================================

function getScoreLabel(score) {

  if (score >= 90) {
    return "A+";
  }

  if (score >= 86) {
    return "A";
  }

  if (score >= 82) {
    return "B+";
  }

  return "B";

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

  const momentum =
    (last - prev) / prev;

  if (
    momentum < MIN_MOMENTUM ||
    momentum > MAX_MOMENTUM
  ) {
    return null;
  }

  const breakoutLevel =
    Math.max(
      ...highs.slice(-20, -1)
    );

  if (
    last <=
    breakoutLevel *
    BREAKOUT_BUFFER
  ) {
    return null;
  }

  const avgVol =
    avg(vols.slice(-20));

  const volRatio =
    vols.at(-1) / avgVol;

  if (
    volRatio <
    MIN_VOL_RATIO
  ) {
    return null;
  }

  const ema9 =
    ema(closes.slice(-30), 9);

  const ema21 =
    ema(closes.slice(-50), 21);

  // avoid overextended entries

  if (
    last > ema9 * 1.08
  ) {
    return null;
  }

  let score = 60;

  if (ema9 > ema21) {
    score += 10;
  }

  if (volRatio > 2) {
    score += 10;
  }

  if (momentum > 0.015) {
    score += 10;
  }

  if (
    type === "crypto" &&
    btcTrend === "bullish"
  ) {
    score += 5;
  }

  score =
    Math.min(score, 90);

  if (
    score < MIN_SCORE
  ) {
    return null;
  }

  const stopPct =
    type === "crypto"
      ? 0.04
      : 0.035;

  return {

    asset,

    type,

    score,

    entry: last,

    sl:
      last *
      (1 - stopPct),

    tp1:
      last * 1.08,

    tp2:
      last * 1.15,

    volRatio

  };

}

// ================================================================
// COOLDOWN
// ================================================================

function cooldownActive(
  asset,
  type,
  alerts,
  currentPrice
) {

  const last =
    [...alerts]
      .reverse()
      .find(
        a =>
          a.asset === asset
      );

  if (!last) {
    return false;
  }

  const cooldown =
    type === "crypto"
      ? CRYPTO_COOLDOWN_HOURS
      : STOCK_COOLDOWN_HOURS;

  // re-alert if moved +8%

  const movedEnough =
    currentPrice >
    last.entry * 1.08;

  if (movedEnough) {
    return false;
  }

  return (
    hoursAgo(last.sentAt) <
    cooldown
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

  for (
    const pair
    of CRYPTO_PAIRS
  ) {

    try {

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

      if (!signal) {
        continue;
      }

      if (
        cooldownActive(
          pair,
          "crypto",
          alerts,
          signal.entry
        )
      ) {
        continue;
      }

      results.push(signal);

    } catch {}

  }

  // ============================================================
  // US STOCKS
  // ============================================================

  if (
    ENABLE_STOCKS &&
    isUsRegularSessionNow()
  ) {

    for (
      const stock
      of US_STOCKS
    ) {

      try {

        const candles =
          await fetchStock(
            stock
          );

        const signal =
          analyse(
            stock,
            candles,
            "stock"
          );

        if (!signal) {
          continue;
        }

        if (
          cooldownActive(
            stock,
            "stock",
            alerts,
            signal.entry
          )
        ) {
          continue;
        }

        results.push(signal);

      } catch {}

    }

  }

  // ============================================================
  // LSE
  // ============================================================

  for (
    const stock
    of LSE_STOCKS
  ) {

    try {

      const candles =
        await fetchStock(
          stock
        );

      const signal =
        analyse(
          stock,
          candles,
          "stock"
        );

      if (!signal) {
        continue;
      }

      results.push(signal);

    } catch {}

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

  const trades =
    load(
      FILES.trades,
      []
    );

  const alerts =
    load(
      FILES.alerts,
      []
    );

  for (
    const s
    of signals
  ) {

    const entry =
      s.type === "crypto"
        ? fmtGBP(
            toGBP(
              s.entry
            )
          )
        : fmtUSD(
            s.entry
          );

    const sl =
      s.type === "crypto"
        ? fmtGBP(
            toGBP(
              s.sl
            )
          )
        : fmtUSD(
            s.sl
          );

    const tp1 =
      s.type === "crypto"
        ? fmtGBP(
            toGBP(
              s.tp1
            )
          )
        : fmtUSD(
            s.tp1
          );

    const tp2 =
      s.type === "crypto"
        ? fmtGBP(
            toGBP(
              s.tp2
            )
          )
        : fmtUSD(
            s.tp2
          );

    const grade =
      getScoreLabel(
        s.score
      );

    const msg = `

${s.type === "crypto"
  ? "🚀 CRYPTO BREAKOUT"
  : "📈 STOCK BREAKOUT"}

${s.asset}

Setup Grade:
${grade}

Breakout Score:
${s.score}/90

Volume Expansion:
${s.volRatio.toFixed(2)}x

Entry:
${entry}

Stop Loss:
${sl}

TP1:
${tp1}

TP2:
${tp2}

Trend:
${
  s.type === "crypto"
    ? btcTrend.toUpperCase()
    : "BULLISH"
}

Warning:
Do not chase extended candles.

`;

    await send(msg);

    trades.push({

      ...s,

      status: "open",

      createdAt:
        nowIso(),

      tp1Hit: false

    });

    alerts.push({

      asset:
        s.asset,

      entry:
        s.entry,

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
// TRADE MANAGEMENT
// ================================================================

async function manageTrades() {

  const trades =
    load(
      FILES.trades,
      []
    );

  let changed =
    false;

  for (
    const t
    of trades
  ) {

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
        candles.at(-1)
          .close;

      // ========================================================
      // TP1
      // ========================================================

      if (
        !t.tp1Hit &&
        price >= t.tp1
      ) {

        t.tp1Hit =
          true;

        changed =
          true;

        await send(`

🎯 TP1 HIT

${t.asset}

Secure partial profits.

Move stop to breakeven.

`);

      }

      // ========================================================
      // TP2
      // ========================================================

      if (
        price >= t.tp2
      ) {

        t.status =
          "closed";

        t.result =
          "TP2";

        changed =
          true;

        await send(`

🏆 FULL TARGET HIT

${t.asset}

Elite breakout completed.

`);

      }

      // ========================================================
      // STOP LOSS
      // ========================================================

      else if (
        price <= t.sl
      ) {

        t.status =
          "closed";

        t.result =
          "SL";

        changed =
          true;

        await send(`

❌ STOP LOSS HIT

${t.asset}

Trade failed.

`);

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
      "SNIPER V29 ELITE RUNNING 🚀"
    );

  }
);

app.get(
  "/health",
  (_req, res) => {

    res.json({

      status: "ok",

      btcTrend,

      time:
        nowIso()

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
