// ================================================================
// SNIPER V70 HYBRID WORKER
// Worker architecture + tiny health server for Railway
//
// DATA
// - CRYPTO: Binance public market data
// - US/LSE: Twelve Data API
//
// REQUIRED ENV
// - BOT_TOKEN
// - CHAT_ID
// - TWELVE_DATA_API_KEY
//
// OPTIONAL ENV
// - PORT
// - DATA_DIR
// ================================================================

console.log("🚀 SNIPER V70 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");

// ================================================================
// HEALTH SERVER
// ================================================================

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  res.status(200).send("SNIPER V70 alive");
});

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

// ================================================================
// CONFIG
// ================================================================

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const FILES = {
  alerts: path.join(DATA_DIR, "alerts.json"),
  trades: path.join(DATA_DIR, "trades.json")
};

// ================================================================
// SETTINGS
// ================================================================

const ENABLE_CRYPTO = true;
const ENABLE_US = true;
const ENABLE_LSE = false;

const MAX_SIGNALS = 8;
const SCAN_INTERVAL_MS = 900000; // 15 mins
const MAX_CONCURRENT_REQUESTS = 4;

const CRYPTO_COOLDOWN = 4;
const STOCK_COOLDOWN = 6;

const BREAKOUT_LOOKBACK = 10;
const BREAKOUT_MAX_DISTANCE = 0.015;

const CRYPTO_PULLBACK_VOL = 1.10;
const STOCK_PULLBACK_VOL = 1.00;

const CRYPTO_BREAKOUT_VOL = 1.30;
const STOCK_BREAKOUT_VOL = 1.15;

const EXTENSION_HARD_LIMIT_CRYPTO = 0.12;
const EXTENSION_HARD_LIMIT_STOCK = 0.10;
const EXTENSION_HARD_LIMIT_LSE = 0.08;

const MIN_RR = 1.8;
const TARGET_R = 2.0;

const PENDING_EXPIRY_HOURS_CRYPTO = 12;
const PENDING_EXPIRY_HOURS_STOCK = 48;
const PENDING_EXPIRY_HOURS_LSE = 72;

const MAX_MOMENTUM_BAR = 0.12;
const MIN_CANDLES = 60;

const ATR_PERIOD = 14;
const ATR_PULLBACK_MULTIPLIER = 1.2;
const ATR_BREAKOUT_MULTIPLIER = 1.5;

// ================================================================
// UNIVERSE
// ================================================================

const CRYPTO_PAIRS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "LINKUSDT",
  "XRPUSDT",
  "AVAXUSDT",
  "SUIUSDT",
  "NEARUSDT",
  "RENDERUSDT"
];

const STOCK_POOL = [
  "NVDA",
  "AVGO",
  "AMD",
  "TSM",
  "ASML",
  "ANET",
  "VRT",
  "PLTR",
  "CRWD",
  "MSFT",
  "META",
  "AMZN",
  "APP",
  "MSTR",
  "COIN",
  "QQQ",
  "SMH"
];

const LSE_POOL = [
  "RR.LON",
  "BA.LON",
  "SHEL.LON",
  "LSEG.LON",
  "BARC.LON"
];

// ================================================================
// GLOBAL STATE
// ================================================================

let running = false;
let btcTrend = "neutral";
let qqqTrend = "neutral";
let cycleCount = 0;
let lastCycleStartedAt = null;
let lastCycleFinishedAt = null;

// ================================================================
// HELPERS
// ================================================================

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  for (const file of Object.values(FILES)) {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, "[]");
    }
  }
}

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.log(`LOAD ERROR ${file}:`, e.message);
    return fallback;
  }
}

function save(file, data) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

async function retry(fn, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(delay * Math.pow(2, i));
    }
  }
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let out = values[0];
  for (let i = 1; i < values.length; i++) {
    out = values[i] * k + out * (1 - k);
  }
  return out;
}

function hoursAgo(ts) {
  return (Date.now() - new Date(ts).getTime()) / 36e5;
}

function formatPrice(value, market) {
  if (!Number.isFinite(value)) return "n/a";
  if (market === "LSE") return `£${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function marketCooldownHours(market) {
  return market === "CRYPTO" ? CRYPTO_COOLDOWN : STOCK_COOLDOWN;
}

function pendingExpiryHours(market) {
  if (market === "CRYPTO") return PENDING_EXPIRY_HOURS_CRYPTO;
  if (market === "LSE") return PENDING_EXPIRY_HOURS_LSE;
  return PENDING_EXPIRY_HOURS_STOCK;
}

function extensionLimitForMarket(market) {
  if (market === "CRYPTO") return EXTENSION_HARD_LIMIT_CRYPTO;
  if (market === "LSE") return EXTENSION_HARD_LIMIT_LSE;
  return EXTENSION_HARD_LIMIT_STOCK;
}

function pullbackVolForMarket(market) {
  return market === "CRYPTO"
    ? CRYPTO_PULLBACK_VOL
    : STOCK_PULLBACK_VOL;
}

function breakoutVolForMarket(market) {
  return market === "CRYPTO"
    ? CRYPTO_BREAKOUT_VOL
    : STOCK_BREAKOUT_VOL;
}

function cooldown(asset, alerts, market) {
  const found = [...alerts].reverse().find(x => x.asset === asset);
  if (!found) return false;
  return hoursAgo(found.sentAt) < marketCooldownHours(market);
}

function dedupeOpenTradeExists(asset, trades) {
  return trades.some(
    t =>
      t.asset === asset &&
      (t.status === "PENDING" || t.status === "FILLED") &&
      t.outcome === "OPEN"
  );
}

function classifyRegime(ema20, ema50, price) {
  if (!Number.isFinite(ema20) || !Number.isFinite(ema50) || !Number.isFinite(price) || ema50 === 0) {
    return "neutral";
  }

  const spread = (ema20 - ema50) / ema50;

  if (ema20 > ema50 && price > ema20) {
    if (spread >= 0.02) return "strong_bull";
    return "bull";
  }

  if (ema20 > ema50) return "neutral";
  if (spread <= -0.02) return "risk_off";
  return "neutral";
}

function regimePass(market) {
  if (market === "CRYPTO") {
    return btcTrend === "bull" || btcTrend === "strong_bull";
  }

  if (market === "US") {
    return qqqTrend === "bull" || qqqTrend === "strong_bull";
  }

  return true;
}

function calculateATR(candles, period = ATR_PERIOD) {
  if (!candles || candles.length < period + 1) return null;

  const trValues = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    if (
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(prevClose)
    ) continue;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trValues.push(tr);
  }

  if (trValues.length < period) return null;

  let atr = avg(trValues.slice(0, period));
  for (let i = period; i < trValues.length; i++) {
    atr = ((atr * (period - 1)) + trValues[i]) / period;
  }

  return atr;
}

async function mapWithConcurrency(items, limit, asyncFn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await asyncFn(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}

// ================================================================
// MARKET HOURS
// ================================================================

function isUSMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;

  const minuteOfDay =
    now.getUTCHours() * 60 + now.getUTCMinutes();

  return minuteOfDay >= 810 && minuteOfDay < 1200;
}

function isLSEOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;

  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const today = `${yyyy}-${mm}-${dd}`;

  const ukBankHolidays = [
    "2026-01-01","2026-04-03","2026-04-06","2026-05-04",
    "2026-05-25","2026-08-31","2026-12-25","2026-12-28"
  ];

  if (ukBankHolidays.includes(today)) return false;

  const minuteOfDay =
    now.getUTCHours() * 60 + now.getUTCMinutes();

  return minuteOfDay >= 420 && minuteOfDay < 950;
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
    await retry(() =>
      axios.post(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          chat_id: CHAT_ID,
          text: msg
        },
        { timeout: 10000 }
      )
    );
  } catch (e) {
    console.log("TELEGRAM ERROR:", e.message);
  }
}

// ================================================================
// DATA FETCH
// ================================================================

async function fetchCrypto(symbol) {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/klines", {
        params: {
          symbol,
          interval: "1h",
          limit: 120
        },
        timeout: 12000
      })
    );

    return data.map(k => ({
      close: +k[4],
      high: +k[2],
      low: +k[3],
      volume: +k[5]
    }));
  } catch (e) {
    console.log(`CRYPTO ERROR ${symbol}`, e.response?.status || "", e.message);
    return null;
  }
}

async function fetchTwelveSeries(symbol, interval = "1h", outputsize = 120) {
  if (!TWELVE_DATA_API_KEY) return null;

  try {
    const { data } = await retry(() =>
      axios.get("https://api.twelvedata.com/time_series", {
        params: {
          symbol,
          interval,
          outputsize,
          order: "ASC",
          apikey: TWELVE_DATA_API_KEY
        },
        timeout: 15000
      })
    );

    if (data?.status === "error") {
      console.log(`TWELVE DATA ERROR ${symbol}`, data.message || "unknown");
      return null;
    }

    if (!Array.isArray(data?.values)) return null;

    return data.values.map(row => ({
      close: +row.close,
      high: +row.high,
      low: +row.low,
      volume: +row.volume
    })).filter(x =>
      Number.isFinite(x.close) &&
      Number.isFinite(x.high) &&
      Number.isFinite(x.low)
    );
  } catch (e) {
    console.log(`TWELVE DATA ERROR ${symbol}`, e.response?.status || "", e.message);
    return null;
  }
}

async function fetchUSData(symbol) {
  return fetchTwelveSeries(symbol, "1h", 120);
}

async function fetchLSEData(symbol) {
  return fetchTwelveSeries(symbol, "1day", 120);
}

async function fetchLivePrice(asset, market) {
  try {
    if (market === "CRYPTO") {
      const { data } = await retry(() =>
        axios.get("https://data-api.binance.vision/api/v3/ticker/price", {
          params: { symbol: asset },
          timeout: 10000
        })
      );
      return +data.price;
    }

    if (!TWELVE_DATA_API_KEY) return null;

    const { data } = await retry(() =>
      axios.get("https://api.twelvedata.com/price", {
        params: {
          symbol: asset,
          apikey: TWELVE_DATA_API_KEY
        },
        timeout: 12000
      })
    );

    if (data?.status === "error") {
      console.log(`TWELVE PRICE ERROR ${asset}`, data.message || "unknown");
      return null;
    }

    return +data.price;
  } catch (e) {
    console.log(`LIVE PRICE ERROR ${asset}`, e.response?.status || "", e.message);
    return null;
  }
}

// ================================================================
// REGIME
// ================================================================

async function updateBTCTrend() {
  const candles = await fetchCrypto("BTCUSDT");
  if (!candles) return;

  const closes = candles.map(x => x.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  btcTrend = classifyRegime(ema20, ema50, closes.at(-1));
}

async function updateQQQTrend() {
  if (!ENABLE_US || !isUSMarketOpen()) {
    qqqTrend = "neutral";
    return;
  }

  const candles = await fetchUSData("QQQ");
  if (!candles) {
    qqqTrend = "neutral";
    return;
  }

  const closes = candles.map(x => x.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  qqqTrend = classifyRegime(ema20, ema50, closes.at(-1));
}

// ================================================================
// ANALYSIS
// ================================================================

function analyse(asset, candles, market) {
  if (!candles || candles.length < MIN_CANDLES) return null;
  if (!regimePass(market)) return null;

  const closes = candles.map(x => x.close);
  const highs = candles.map(x => x.high);
  const lows = candles.map(x => x.low);
  const volumes = candles.map(x => x.volume || 0);

  const last = closes.at(-1);
  const prev = closes.at(-2);

  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) {
    return null;
  }

  const momentum = (last - prev) / prev;
  if (momentum <= 0 || momentum > MAX_MOMENTUM_BAR) {
    return null;
  }

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema20Prev = ema(closes.slice(0, -1), 20);

  const strongTrend =
    ema20 > ema50 &&
    last > ema20 &&
    ema20 > ema20Prev;

  if (!strongTrend) return null;

  const avgVol = avg(volumes.slice(-21, -1));
  const currentVol = volumes.at(-1);
  const volRatio = avgVol > 0 ? currentVol / avgVol : 0;

  const extension = (last - ema20) / ema20;
  if (extension > extensionLimitForMarket(market)) {
    return null;
  }

  const breakoutLevel =
    Math.max(...highs.slice(-BREAKOUT_LOOKBACK, -1));

  const breakoutDistance =
    breakoutLevel > 0
      ? (last - breakoutLevel) / breakoutLevel
      : 0;

  const breakoutSignal =
    last > breakoutLevel &&
    breakoutDistance <= BREAKOUT_MAX_DISTANCE &&
    volRatio >= breakoutVolForMarket(market);

  const nearEMA20 =
    market === "CRYPTO"
      ? Math.abs(last - ema20) / ema20 <= 0.025
      : Math.abs(last - ema20) / ema20 <= 0.02;

  const pulledBackRecently =
    closes.slice(-6, -1).some(c => c <= ema20 * 1.01);

  const pullbackSignal =
    nearEMA20 &&
    pulledBackRecently &&
    volRatio >= pullbackVolForMarket(market);

  if (!pullbackSignal && !breakoutSignal) {
    return null;
  }

  let setupType;
  let entryType;
  let entry;

  if (pullbackSignal && !breakoutSignal) {
    setupType = "PULLBACK_CONTINUATION";
    entryType = "LIMIT BUY";
    entry = ema20 * 1.002;
  } else {
    setupType = "BREAKOUT_CONTINUATION";
    entryType = "STOP BUY";
    entry = breakoutLevel * 1.0015;
  }

  const atr = calculateATR(candles, ATR_PERIOD);
  if (!atr || atr <= 0) return null;

  const swingLow = Math.min(...lows.slice(-6));

  let sl;
  if (setupType === "PULLBACK_CONTINUATION") {
    sl = Math.min(
      swingLow - atr * ATR_PULLBACK_MULTIPLIER,
      entry - atr * ATR_PULLBACK_MULTIPLIER
    );
  } else {
    sl = Math.min(
      swingLow - atr * ATR_BREAKOUT_MULTIPLIER,
      entry - atr * ATR_BREAKOUT_MULTIPLIER
    );
  }

  if (!Number.isFinite(sl) || sl >= entry) {
    return null;
  }

  const riskAmt = entry - sl;
  const riskPct = riskAmt / entry;

  if (riskPct <= 0 || riskPct > 0.12) {
    return null;
  }

  const tp = entry + (riskAmt * TARGET_R);
  const rewardPct = (tp - entry) / entry;
  const rr = +(rewardPct / riskPct).toFixed(1);

  if (rr < MIN_RR) {
    return null;
  }

  let score = 50;
  if (volRatio > 1.3) score += 10;
  if (volRatio > 1.6) score += 5;
  if (momentum > 0.01) score += 8;
  if (setupType === "BREAKOUT_CONTINUATION") score += 10;
  if (setupType === "PULLBACK_CONTINUATION") score += 8;
  if (market === "CRYPTO") score += 5;
  if (market === "US") score += 5;
  if (market === "CRYPTO" && btcTrend === "strong_bull") score += 5;
  if (market === "US" && qqqTrend === "strong_bull") score += 5;

  let grade = "B";
  if (score >= 85) grade = "A*";
  else if (score >= 72) grade = "A";

  return {
    asset,
    market,
    grade,
    setupType,
    status: "CONFIRMED",
    entryType,
    entry,
    sl,
    tp,
    rr,
    score,
    momentum,
    volRatio,
    breakoutDistance,
    atr,
    regime:
      market === "CRYPTO"
        ? btcTrend
        : market === "US"
        ? qqqTrend
        : "local"
  };
}

// ================================================================
// SIGNAL
// ================================================================

async function sendSignal(s) {
  const marketIcon =
    s.market === "CRYPTO"
      ? "🪙"
      : s.market === "US"
      ? "🇺🇸"
      : "🇬🇧";

  await send(
`🚨 ${s.grade}

${marketIcon} ${s.asset}
🧠 ${s.setupType}
⚡ ${s.entryType}

🎯 ENTRY
${formatPrice(s.entry, s.market)}

🛑 STOP
${formatPrice(s.sl, s.market)}

💰 TARGET
${formatPrice(s.tp, s.market)}

📊 R:R ${s.rr}
📈 ${(s.momentum * 100).toFixed(2)}%
📊 VOL ${s.volRatio.toFixed(2)}x
📏 ATR ${s.atr.toFixed(4)}
🌍 REGIME ${s.regime}
🧠 SCORE ${s.score}`
  );
}

// ================================================================
// SCAN
// ================================================================

async function scan() {
  const alerts = load(FILES.alerts, []);
  const trades = load(FILES.trades, []);
  const results = [];

  async function processAsset(asset, market, fetcher) {
    if (cooldown(asset, alerts, market)) return;
    if (dedupeOpenTradeExists(asset, trades)) return;

    const candles = await fetcher(asset);
    const signal = analyse(asset, candles, market);

    if (signal) results.push(signal);
  }

  if (ENABLE_CRYPTO) {
    await mapWithConcurrency(
      CRYPTO_PAIRS,
      MAX_CONCURRENT_REQUESTS,
      asset => processAsset(asset, "CRYPTO", fetchCrypto)
    );
  }

  if (ENABLE_US && isUSMarketOpen()) {
    await mapWithConcurrency(
      STOCK_POOL,
      MAX_CONCURRENT_REQUESTS,
      asset => processAsset(asset, "US", fetchUSData)
    );
  }

  if (ENABLE_LSE && isLSEOpen()) {
    await mapWithConcurrency(
      LSE_POOL,
      MAX_CONCURRENT_REQUESTS,
      asset => processAsset(asset, "LSE", fetchLSEData)
    );
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SIGNALS);
}

// ================================================================
// PROCESS SIGNALS
// ================================================================

async function processSignals(signals) {
  const alerts = load(FILES.alerts, []);
  const trades = load(FILES.trades, []);

  for (const s of signals) {
    await sendSignal(s);

    const sentAt = nowIso();
    const createdPrice = await fetchLivePrice(s.asset, s.market);

    alerts.push({
      asset: s.asset,
      sentAt
    });

    trades.push({
      id: `${s.asset}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      asset: s.asset,
      market: s.market,
      setupType: s.setupType,
      entryType: s.entryType,
      entry: s.entry,
      sl: s.sl,
      tp: s.tp,
      rrPlanned: s.rr,
      score: s.score,
      regimeAtEntry: s.regime,
      volRatioAtEntry: s.volRatio,
      atrAtEntry: s.atr,
      sentAt,
      filledAt: null,
      closedAt: null,
      cancelReason: null,
      status: "PENDING",
      outcome: "OPEN",
      fillPrice: null,
      closePrice: null,
      rCaptured: null,
      createdPrice: Number.isFinite(createdPrice) ? createdPrice : null,
      lastCheckPrice: Number.isFinite(createdPrice) ? createdPrice : null,
      maePrice: null,
      mfePrice: null,
      maeR: null,
      mfeR: null
    });
  }

  save(FILES.alerts, alerts);
  save(FILES.trades, trades);
}

// ================================================================
// TRADE ENGINE
// ================================================================

function shouldFillTrade(trade, price) {
  const prev = trade.lastCheckPrice ?? trade.createdPrice;

  if (!Number.isFinite(prev) || !Number.isFinite(price)) {
    return false;
  }

  if (trade.entryType === "LIMIT BUY") {
    return prev > trade.entry && price <= trade.entry;
  }

  if (trade.entryType === "STOP BUY") {
    return prev < trade.entry && price >= trade.entry;
  }

  return false;
}

function shouldCancelPending(trade) {
  return hoursAgo(trade.sentAt) >= pendingExpiryHours(trade.market);
}

async function checkOutcomes() {
  const trades = load(FILES.trades, []);
  const active = trades.filter(t => t.outcome === "OPEN");

  if (!active.length) return;

  let updated = false;

  for (const trade of active) {
    try {
      const price = await fetchLivePrice(trade.asset, trade.market);
      if (!Number.isFinite(price)) continue;

      const mktIcon =
        trade.market === "CRYPTO" ? "🪙"
        : trade.market === "US" ? "🇺🇸"
        : "🇬🇧";

      if (trade.status === "PENDING" && shouldCancelPending(trade)) {
        trade.status = "CANCELLED";
        trade.outcome = "CANCELLED";
        trade.closedAt = nowIso();
        trade.cancelReason = "ENTRY_NOT_FILLED_IN_TIME";
        trade.lastCheckPrice = price;
        updated = true;

        await send(
`⚪ ENTRY CANCELLED

${mktIcon} ${trade.asset}
🧠 ${trade.setupType}

🎯 Entry never filled in time
🕒 Pending expired`
        );

        continue;
      }

      if (trade.status === "PENDING") {
        if (shouldFillTrade(trade, price)) {
          trade.status = "FILLED";
          trade.filledAt = nowIso();
          trade.fillPrice = price;
          trade.lastCheckPrice = price;
          trade.maePrice = price;
          trade.mfePrice = price;
          updated = true;

          await send(
`✅ ENTRY FILLED

${mktIcon} ${trade.asset}
🧠 ${trade.setupType}
⚡ ${trade.entryType}

🎯 Planned: ${formatPrice(trade.entry, trade.market)}
📍 Fill: ${formatPrice(price, trade.market)}`
          );

          continue;
        }

        trade.lastCheckPrice = price;
        updated = true;
        continue;
      }

      if (trade.status === "FILLED") {
        const riskAmt = trade.entry - trade.sl;

        trade.maePrice =
          trade.maePrice === null
            ? price
            : Math.min(trade.maePrice, price);

        trade.mfePrice =
          trade.mfePrice === null
            ? price
            : Math.max(trade.mfePrice, price);

        if (riskAmt > 0) {
          trade.maeR = +(((trade.maePrice - trade.entry) / riskAmt)).toFixed(2);
          trade.mfeR = +(((trade.mfePrice - trade.entry) / riskAmt)).toFixed(2);
        }

        if (price >= trade.tp) {
          trade.status = "CLOSED";
          trade.outcome = "WIN";
          trade.closedAt = nowIso();
          trade.closePrice = price;
          trade.rCaptured =
            riskAmt > 0
              ? +(((price - trade.entry) / riskAmt)).toFixed(2)
              : null;
          trade.lastCheckPrice = price;
          updated = true;

          await send(
`✅ TARGET HIT

${mktIcon} ${trade.asset}
🧠 ${trade.setupType}

🎯 Entry: ${formatPrice(trade.entry, trade.market)}
📍 Fill: ${formatPrice(trade.fillPrice, trade.market)}
💰 Exit: ${formatPrice(price, trade.market)}

🏆 ${trade.rCaptured ?? trade.rrPlanned}R
📉 MAE ${trade.maeR ?? "n/a"}R
📈 MFE ${trade.mfeR ?? "n/a"}R`
          );

        } else if (price <= trade.sl) {
          trade.status = "CLOSED";
          trade.outcome = "LOSS";
          trade.closedAt = nowIso();
          trade.closePrice = price;
          trade.rCaptured =
            riskAmt > 0
              ? +(((price - trade.entry) / riskAmt)).toFixed(2)
              : -1;
          trade.lastCheckPrice = price;
          updated = true;

          await send(
`❌ STOPPED OUT

${mktIcon} ${trade.asset}
🧠 ${trade.setupType}

🎯 Entry: ${formatPrice(trade.entry, trade.market)}
📍 Fill: ${formatPrice(trade.fillPrice, trade.market)}
🛑 Exit: ${formatPrice(price, trade.market)}

💥 ${trade.rCaptured}R
📉 MAE ${trade.maeR ?? "n/a"}R
📈 MFE ${trade.mfeR ?? "n/a"}R`
          );

        } else {
          trade.lastCheckPrice = price;
          updated = true;
        }
      }

    } catch (e) {
      console.log(`OUTCOME CHECK ERROR ${trade.asset}:`, e.message);
    }
  }

  if (updated) {
    save(FILES.trades, trades);
  }
}

// ================================================================
// WEEKLY REPORT
// ================================================================

async function weeklyReport() {
  const now = new Date();

  if (
    now.getUTCDay() !== 1 ||
    now.getUTCHours() !== 7 ||
    now.getUTCMinutes() > 5
  ) {
    return;
  }

  const trades = load(FILES.trades, []);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const weekTrades =
    trades.filter(t => new Date(t.sentAt).getTime() > weekAgo);

  const filled =
    weekTrades.filter(t => t.status === "FILLED" || t.status === "CLOSED");

  const closed =
    weekTrades.filter(t => t.outcome === "WIN" || t.outcome === "LOSS");

  const wins =
    closed.filter(t => t.outcome === "WIN");

  const losses =
    closed.filter(t => t.outcome === "LOSS");

  const pending =
    weekTrades.filter(t => t.status === "PENDING");

  const cancelled =
    weekTrades.filter(t => t.status === "CANCELLED");

  const winRate =
    closed.length
      ? Math.round((wins.length / closed.length) * 100)
      : 0;

  const avgWinR =
    wins.length
      ? (
          wins.reduce((sum, t) => sum + (+t.rCaptured || 0), 0) /
          wins.length
        ).toFixed(2)
      : "0";

  const avgLossR =
    losses.length
      ? (
          losses.reduce((sum, t) => sum + (+t.rCaptured || 0), 0) /
          losses.length
        ).toFixed(2)
      : "0";

  const expectancy =
    closed.length
      ? (
          wins.reduce((sum, t) => sum + (+t.rCaptured || 0), 0) +
          losses.reduce((sum, t) => sum + (+t.rCaptured || 0), 0)
        ) / closed.length
      : 0;

  const avgMAE =
    closed.filter(t => Number.isFinite(t.maeR)).length
      ? (
          closed
            .filter(t => Number.isFinite(t.maeR))
            .reduce((sum, t) => sum + t.maeR, 0) /
          closed.filter(t => Number.isFinite(t.maeR)).length
        ).toFixed(2)
      : "0";

  const avgMFE =
    closed.filter(t => Number.isFinite(t.mfeR)).length
      ? (
          closed
            .filter(t => Number.isFinite(t.mfeR))
            .reduce((sum, t) => sum + t.mfeR, 0) /
          closed.filter(t => Number.isFinite(t.mfeR)).length
        ).toFixed(2)
      : "0";

  await send(
`📊 V70 WEEKLY PERFORMANCE

🔔 Signals: ${weekTrades.length}
✅ Filled: ${filled.length}
🕒 Pending: ${pending.length}
⚪ Cancelled: ${cancelled.length}

🏆 Winners: ${wins.length} (${winRate}%)
❌ Losers: ${losses.length}

📈 Avg Win: ${avgWinR}R
📉 Avg Loss: ${avgLossR}R
🧠 Expectancy: ${expectancy.toFixed(2)}R
📉 Avg MAE: ${avgMAE}R
📈 Avg MFE: ${avgMFE}R

₿ BTC regime: ${btcTrend}
📈 QQQ regime: ${qqqTrend}`
  );
}

// ================================================================
// MAIN CYCLE
// ================================================================

async function runCycle() {
  if (running) {
    console.log("⏳ Cycle skipped: previous cycle still running");
    return;
  }

  running = true;
  cycleCount += 1;
  lastCycleStartedAt = nowIso();

  try {
    console.log(`🔄 Cycle ${cycleCount} started at ${lastCycleStartedAt}`);

    ensureFiles();

    await updateBTCTrend();
    await updateQQQTrend();
    await checkOutcomes();

    const signals = await scan();
    console.log(`Signals: ${signals.length}`);

    if (signals.length) {
      await processSignals(signals);
    }

    await weeklyReport();

  } catch (e) {
    console.log("RUN ERROR:", e.stack || e.message);
  } finally {
    lastCycleFinishedAt = nowIso();
    running = false;
    console.log(`✅ Cycle ${cycleCount} finished at ${lastCycleFinishedAt}`);
  }
}

// ================================================================
// PROCESS HARDENING
// ================================================================

process.on("uncaughtException", err => {
  console.log("UNCAUGHT EXCEPTION:", err.stack || err.message);
});

process.on("unhandledRejection", err => {
  console.log("UNHANDLED REJECTION:", err?.stack || err?.message || err);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down worker...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down worker...");
  process.exit(0);
});

// ================================================================
// START V70
// ================================================================

ensureFiles();

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Health server on ${PORT}`);
  console.log("🚀 SNIPER V70 LIVE");

  await send(
`🚀 SNIPER V70 LIVE

✅ hybrid worker mode
✅ Railway health server
✅ Binance crypto data
✅ Twelve Data stocks
✅ cross-through fills
✅ ATR stops
✅ MAE/MFE tracking
✅ protected execution state
✅ atomic file saves
✅ retry protection

🎯 engine active`
  );

  await runCycle();

  setInterval(async () => {
    if (!running) {
      await runCycle();
    } else {
      console.log("⏳ Interval skipped because cycle still running");
    }
  }, SCAN_INTERVAL_MS);
});
