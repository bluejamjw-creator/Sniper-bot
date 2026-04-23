// ================================================================
// SNIPER V28.1 STABLE
// Stable momentum breakout scanner
// Crypto 24/7
// Stocks during US regular hours only
// Cooldown protection
// Anti-spam protection
// Better breakout filtering
// Safer trade handling
// ================================================================

console.log("🚀 SNIPER V28.1 STABLE STARTING...");

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

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

const FILES = {
  alerts: path.join(DATA_DIR, "alerts.json"),
  trades: path.join(DATA_DIR, "trades.json")
};

// ================================================================
// SETTINGS
// ================================================================

const MAX_SIGNALS = 3;
const MAX_OPEN_TRADES = 5;

const MIN_CONFIDENCE = 80;

const COOLDOWN_HOURS = 12;

const MIN_MOMENTUM = 0.0015;
const MAX_MOMENTUM = 0.06;

const MIN_VOL_RATIO = 1.4;

const BREAKOUT_BUFFER = 1.003;
const MIN_BREAKOUT_STRENGTH = 0.004;

const ENABLE_STOCKS = true;

const STOCK_SESSION_MODE = "regular";

// ================================================================
// ASSETS
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
  "NFLX",
  "ADBE",
  "BA",
  "UBER"
];

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
  "AAVEUSDT"
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
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(FILES.alerts)) {
    fs.writeFileSync(FILES.alerts, "[]");
  }

  if (!fs.existsSync(FILES.trades)) {
    fs.writeFileSync(FILES.trades, "[]");
  }
}

function load(file, fallback = []) {
  try {
    if (!fs.existsSync(file)) return fallback;

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) return fallback;

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function avg(arr) {
  if (!arr.length) return 0;

  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(values, period) {
  if (!values.length) return 0;

  const k = 2 / (period + 1);

  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function hoursAgo(ts) {
  return (Date.now() - new Date(ts).getTime()) / 36e5;
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
// MARKET SESSION
// ================================================================

function isUsRegularSessionNow() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);

  const map = {};

  parts.forEach(p => {
    map[p.type] = p.value;
  });

  const day = map.weekday;

  if (day === "Sat" || day === "Sun") {
    return false;
  }

  const hour = Number(map.hour);
  const minute = Number(map.minute);

  const total = hour * 60 + minute;

  return total >= 570 && total < 960;
}

function stockAllowed() {
  if (!ENABLE_STOCKS) return false;

  if (STOCK_SESSION_MODE === "off") return false;

  if (STOCK_SESSION_MODE === "premarket") return true;

  return isUsRegularSessionNow();
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
    console.error("TELEGRAM ERROR:", e.message);
  }
}

// ================================================================
// FX
// ================================================================

async function updateFX() {
  try {
    const { data } = await axios.get(
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
// DATA FETCHING
// ================================================================

async function fetchCrypto(symbol) {
  const { data } = await axios.get(
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
    volume: +k[5]
  }));
}

async function fetchStock(symbol) {
  try {
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,
      {
        params: {
          range: "3mo",
          interval: "1d"
        },
        timeout: 20000
      }
    );

    const result = data?.chart?.result?.[0];

    const quote = result?.indicators?.quote?.[0];

    if (!quote?.close?.length) return null;

    return quote.close.map((c, i) => ({
      close: +c,
      high: +quote.high?.[i],
      volume: +(quote.volume?.[i] || 0)
    })).filter(x => x.close);
  } catch {
    return null;
  }
}

// ================================================================
// BTC TREND
// ================================================================

async function updateBTCTrend() {
  try {
    const candles = await fetchCrypto("BTCUSDT");

    if (!candles || candles.length < 60) {
      btcTrend = "neutral";
      return;
    }

    const closes = candles.map(c => c.close);

    const ema20 = ema(closes.slice(-30), 20);

    const ema50 = ema(closes.slice(-60), 50);

    const last = closes.at(-1);

    btcTrend =
      last > ema20 && ema20 > ema50
        ? "bullish"
        : "neutral";
  } catch {
    btcTrend = "neutral";
  }
}

// ================================================================
// ANALYSIS
// ================================================================

function analyse(asset, candles, type) {
  if (!candles || candles.length < 50) {
    return null;
  }

  const closes = candles.map(c => c.close);

  const highs = candles.map(c => c.high);

  const volumes = candles.map(c => c.volume);

  const last = closes.at(-1);

  const prev = closes.at(-2);

  if (!last || !prev) return null;

  const momentum = (last - prev) / prev;

  if (
    momentum < MIN_MOMENTUM ||
    momentum > MAX_MOMENTUM
  ) {
    return null;
  }

  const ema9 = ema(closes.slice(-30), 9);

  const ema21 = ema(closes.slice(-50), 21);

  if (ema9 <= ema21) {
    return null;
  }

  if (last > ema9 * 1.04) {
    return null;
  }

  const priorHigh = Math.max(
    ...highs.slice(-20, -1)
  );

  if (last <= priorHigh * BREAKOUT_BUFFER) {
    return null;
  }

  const breakoutStrength =
    (last - priorHigh) / priorHigh;

  if (breakoutStrength < MIN_BREAKOUT_STRENGTH) {
    return null;
  }

  const avgVolume = avg(volumes.slice(-20));

  if (!avgVolume) return null;

  const volRatio =
    volumes.at(-1) / avgVolume;

  if (volRatio < MIN_VOL_RATIO) {
    return null;
  }

  let confidence = 50;

  confidence += 15;

  if (volRatio > 1.5) confidence += 10;

  if (momentum > 0.01) confidence += 10;

  if (
    type === "crypto" &&
    btcTrend === "bullish"
  ) {
    confidence += 10;
  }

  confidence = Math.min(confidence, 99);

  if (confidence < MIN_CONFIDENCE) {
    return null;
  }

  const stopPct =
    type === "crypto"
      ? 0.03
      : 0.04;

  const takePct =
    type === "crypto"
      ? 0.06
      : 0.08;

  const entry = last;

  const sl = entry * (1 - stopPct);

  const tp = entry * (1 + takePct);

  const riskReward =
    (tp - entry) /
    (entry - sl);

  if (riskReward < 1.4) {
    return null;
  }

  return {
    asset,
    type,
    confidence,
    entry,
    sl,
    tp,
    volRatio,
    riskReward
  };
}

// ================================================================
// ALERT CONTROL
// ================================================================

function hasOpenTrade(asset, trades) {
  return trades.some(
    t =>
      t.asset === asset &&
      t.status === "open"
  );
}

function cooldownActive(asset, alerts) {
  const found = [...alerts]
    .reverse()
    .find(a => a.asset === asset);

  if (!found) return false;

  return (
    hoursAgo(found.sentAt) <
    COOLDOWN_HOURS
  );
}

// ================================================================
// SCAN
// ================================================================

async function scan() {
  const alerts = load(FILES.alerts);

  const trades = load(FILES.trades);

  const results = [];

  const openTrades =
    trades.filter(
      t => t.status === "open"
    );

  if (
    openTrades.length >=
    MAX_OPEN_TRADES
  ) {
    return [];
  }

  for (const pair of CRYPTO_PAIRS) {
    if (cooldownActive(pair, alerts)) {
      continue;
    }

    if (hasOpenTrade(pair, trades)) {
      continue;
    }

    try {
      const candles =
        await fetchCrypto(pair);

      const signal = analyse(
        pair,
        candles,
        "crypto"
      );

      if (signal) {
        results.push(signal);
      }
    } catch {}
  }

  if (stockAllowed()) {
    for (const stock of STOCK_POOL) {
      if (
        cooldownActive(stock, alerts)
      ) {
        continue;
      }

      if (
        hasOpenTrade(stock, trades)
      ) {
        continue;
      }

      try {
        const candles =
          await fetchStock(stock);

        const signal = analyse(
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
// SIGNALS
// ================================================================

async function processSignals(signals) {
  const alerts = load(FILES.alerts);

  for (const s of signals) {
    const entry =
      s.type === "crypto"
        ? fmtGBP(toGBP(s.entry))
        : fmtUSD(s.entry);

    const sl =
      s.type === "crypto"
        ? fmtGBP(toGBP(s.sl))
        : fmtUSD(s.sl);

    const tp =
      s.type === "crypto"
        ? fmtGBP(toGBP(s.tp))
        : fmtUSD(s.tp);

    const move =
      (
        ((s.tp - s.entry) /
          s.entry) *
        100
      ).toFixed(2);

    const sessionTag =
      s.type === "stock"
        ? "\nSession: REGULAR"
        : "";

    const msg =
`${s.type === "crypto"
  ? "🚀 CRYPTO BREAKOUT"
  : "📈 STOCK BREAKOUT"}${sessionTag}

${s.asset}

Confidence: ${s.confidence}/100

Entry: ${entry}
SL: ${sl}
TP: ${tp}

Potential Move: ${move}%
Volume Ratio: ${s.volRatio.toFixed(2)}x
Risk/Reward: ${s.riskReward.toFixed(2)}R`;

    await send(msg);

    alerts.push({
      asset: s.asset,
      sentAt: nowIso()
    });
  }

  save(FILES.alerts, alerts);
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

    const signals = await scan();

    console.log(
      "Signals:",
      signals.length
    );

    if (signals.length) {
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

app.get("/", (_req, res) => {
  res.send(
    "SNIPER V28.1 STABLE RUNNING 🚀"
  );
});

app.get(
  "/health",
  (_req, res) => {
    res.json({
      status: "ok",
      btcTrend,
      stocksEnabled:
        stockAllowed(),
      time: nowIso()
    });
  }
);

app.get(
  "/alerts",
  (_req, res) => {
    res.json(
      load(FILES.alerts)
    );
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
