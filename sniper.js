// ================================================================
// SNIPER V74
// 5-minute scan engine + one-best-per-market allocator
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

console.log("ðŸš€ SNIPER V74 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => res.status(200).send("SNIPER V74 alive"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

const FILES = {
  alerts: path.join(DATA_DIR, "alerts.json"),
  trades: path.join(DATA_DIR, "trades.json")
};

const ACCOUNT_BALANCE = 10000;
const BASE_RISK_PER_TRADE = 0.01;
const MAX_PORTFOLIO_RISK = 0.05;

const ENABLE_CRYPTO = true;
const ENABLE_US = true;
const ENABLE_LSE = false;

const SCAN_INTERVAL_MS = 300000;
const MAX_CONCURRENT_REQUESTS = 4;

const CRYPTO_COOLDOWN = 4;
const STOCK_COOLDOWN = 4;

const BREAKOUT_LOOKBACK = 10;
const BREAKOUT_MAX_DISTANCE = 0.015;
const STOCK_BREAKOUT_MAX_DISTANCE = 0.02;
const STOCK_BREAKOUT_MAX_DISTANCE_OVERRIDE = 0.03;

const CRYPTO_PULLBACK_VOL = 1.10;
const STOCK_PULLBACK_VOL = 1.00;

const CRYPTO_BREAKOUT_VOL = 1.30;
const STOCK_BREAKOUT_VOL = 1.05;

const EXTENSION_HARD_LIMIT_CRYPTO = 0.12;
const EXTENSION_HARD_LIMIT_STOCK = 0.10;
const EXTENSION_HARD_LIMIT_LSE = 0.08;

const MIN_RR = 1.8;
const TARGET_R = 2.0;

const PENDING_EXPIRY_HOURS_CRYPTO = 6;
const PENDING_EXPIRY_HOURS_STOCK = 12;
const PENDING_EXPIRY_HOURS_LSE = 48;

const MAX_MOMENTUM_BAR = 0.12;
const MIN_CANDLES = 60;

const ATR_PERIOD = 14;
const ATR_PULLBACK_MULTIPLIER = 1.2;
const ATR_BREAKOUT_MULTIPLIER = 1.5;

const STOCK_MOMENTUM_OVERRIDE_PCT = 0.01;
const STOCK_MOMENTUM_OVERRIDE_VOL = 1.2;

const CRYPTO_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","LINKUSDT",
  "XRPUSDT","AVAXUSDT","SUIUSDT","NEARUSDT","RENDERUSDT"
];

const STOCK_POOL = [
  "NVDA","AVGO","AMD","TSM","ASML","ANET","VRT","PLTR",
  "CRWD","MSFT","META","AMZN","APP","MSTR","COIN","QQQ","SMH"
];

const BASE_STOCK_POOL = [
  "NVDA","AMD","TSLA","COIN","MSTR",
  "PLTR","SMCI","SHOP","ROKU","NET",
  "CRWD","SNOW","META","AMZN","QQQ"
];

const LSE_POOL = ["RR.LON","BA.LON","SHEL.LON","LSEG.LON","BARC.LON"];

const DYNAMIC_STOCK_UNIVERSE = true;
const MAX_DYNAMIC_STOCKS = 20;

const MAX_POSITIONS = {
  CRYPTO: 1,
  US: 1,
  LSE: 0
};

const REPLACEMENT_SCORE_GAP = 8;
const REPLACEMENT_STALE_HOURS = 6;
const REPLACEMENT_PROTECT_TP_PROGRESS = 0.7;
const REPLACEMENT_STALL_PROGRESS = 0.3;

let running = false;
let btcTrend = "neutral";
let qqqTrend = "neutral";
let cycleCount = 0;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of Object.values(FILES)) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[]");
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
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return NaN;
  const k = 2 / (period + 1);
  let out = clean[0];
  for (let i = 1; i < clean.length; i++) out = clean[i] * k + out * (1 - k);
  return out;
}

function hoursAgo(ts) {
  if (!ts) return Infinity;
  return (Date.now() - new Date(ts).getTime()) / 36e5;
}

function formatPrice(value, market) {
  if (!Number.isFinite(value)) return "n/a";
  if (market === "LSE") return `Â£${value.toFixed(2)}`;
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
  return market === "CRYPTO" ? CRYPTO_PULLBACK_VOL : STOCK_PULLBACK_VOL;
}

function breakoutVolForMarket(market) {
  return market === "CRYPTO" ? CRYPTO_BREAKOUT_VOL : STOCK_BREAKOUT_VOL;
}

function breakoutDistanceLimitForMarket(market) {
  if (market === "US") return STOCK_BREAKOUT_MAX_DISTANCE;
  return BREAKOUT_MAX_DISTANCE;
}

function cooldown(asset, alerts, market) {
  const found = [...alerts].reverse().find(x => x.asset === asset);
  if (!found) return false;
  return hoursAgo(found.sentAt) < marketCooldownHours(market);
}

function dedupeOpenTradeExists(asset, trades) {
  return trades.some(t => t.asset === asset && t.status === "FILLED" && t.outcome === "OPEN");
}

function classifyRegime(ema20, ema50, price) {
  if (!Number.isFinite(ema20) || !Number.isFinite(ema50) || !Number.isFinite(price) || ema50 === 0) return "neutral";
  const spread = (ema20 - ema50) / ema50;
  if (ema20 > ema50 && price > ema20) return spread >= 0.02 ? "strong_bull" : "bull";
  if (ema20 > ema50) return "neutral";
  if (spread <= -0.02) return "risk_off";
  return "neutral";
}

function regimePass(market) {
  if (market === "CRYPTO") return btcTrend === "bull" || btcTrend === "strong_bull";
  if (market === "US") return qqqTrend === "bull" || qqqTrend === "strong_bull";
  return true;
}

function calculateATR(candles, period = ATR_PERIOD) {
  if (!candles || candles.length < period + 1) return null;
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) continue;
    trValues.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trValues.length < period) return null;
  let atr = avg(trValues.slice(0, period));
  for (let i = period; i < trValues.length; i++) atr = ((atr * (period - 1)) + trValues[i]) / period;
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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function safePctChange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return (a - b) / b;
}

function getCurrentOpenTradeInBucket(trades, market) {
  return trades.find(t => t.market === market && t.status === "FILLED" && t.outcome === "OPEN");
}

function getSlotKey(market) {
  if (market === "CRYPTO") return "CRYPTO";
  if (market === "US") return "US";
  if (market === "LSE") return "LSE";
  return null;
}

function currentTradeProgress(trade, price) {
  if (!trade) return 0;
  const denom = trade.tp - trade.entry;
  if (!Number.isFinite(price) || !Number.isFinite(denom) || denom <= 0) return 0;
  return (price - trade.entry) / denom;
}

function shouldReplaceTrade(newSignal, currentTrade, price) {
  if (!currentTrade) return true;
  const progress = currentTradeProgress(currentTrade, price);
  if (progress > REPLACEMENT_PROTECT_TP_PROGRESS) return false;
  const scoreBetter = newSignal.score > (currentTrade.score || 0) + REPLACEMENT_SCORE_GAP;
  const isStalling = progress < REPLACEMENT_STALL_PROGRESS;
  const stale = hoursAgo(currentTrade.filledAt) > REPLACEMENT_STALE_HOURS;
  return scoreBetter && (isStalling || stale);
}

function pickBestPerMarket(results) {
  const best = {};
  for (const s of results.sort((a, b) => b.score - a.score)) {
    if (!best[s.market]) best[s.market] = s;
  }
  return Object.values(best);
}

function getBestSignalByMarket(signals, market) {
  return signals.filter(s => s.market === market).sort((a, b) => b.score - a.score)[0] || null;
}

function adjustRiskByScore(score) {
  if (score >= 90) return 1.5;
  if (score >= 78) return 1.2;
  return 1.0;
}

function getRiskFractionForSignal(signal) {
  return BASE_RISK_PER_TRADE * adjustRiskByScore(signal.score);
}

function calculatePositionSize(signal) {
  const riskFraction = getRiskFractionForSignal(signal);
  const riskAmount = ACCOUNT_BALANCE * riskFraction;
  const riskPerUnit = signal.entry - signal.sl;
  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) return 0;
  return riskAmount / riskPerUnit;
}

function getOpenRiskFraction(trades) {
  return trades.filter(t => t.status === "FILLED" && t.outcome === "OPEN").reduce((sum, t) => sum + (t.riskFraction || 0), 0);
}

function isCorrelated(assetA, assetB) {
  const cryptoMajors = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const semis = ["NVDA", "AMD", "AVGO", "TSM", "ASML", "SMH"];
  return (cryptoMajors.includes(assetA) && cryptoMajors.includes(assetB)) || (semis.includes(assetA) && semis.includes(assetB));
}

function hasCorrelatedOpenTrade(asset, trades) {
  return trades.some(t => t.status === "FILLED" && t.outcome === "OPEN" && isCorrelated(asset, t.asset));
}

function isUSMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
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
  const ukBankHolidays = ["2026-01-01","2026-04-03","2026-04-06","2026-05-04","2026-05-25","2026-08-31","2026-12-25","2026-12-28"];
  if (ukBankHolidays.includes(today)) return false;
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minuteOfDay >= 420 && minuteOfDay < 950;
}

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(msg);
    return;
  }
  try {
    await retry(() => axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: CHAT_ID, text: msg }, { timeout: 10000 }));
  } catch (e) {
    console.log("TELEGRAM ERROR:", e.message);
  }
}

async function fetchCrypto(symbol) {
  try {
    const { data } = await retry(() => axios.get("https://data-api.binance.vision/api/v3/klines", { params: { symbol, interval: "1h", limit: 120 }, timeout: 12000 }));
    return data.map(k => ({ close: +k[4], high: +k[2], low: +k[3], volume: +k[5] }));
  } catch (e) {
    console.log(`CRYPTO ERROR ${symbol}`, e.response?.status || "", e.message);
    return null;
  }
}

async function fetchTwelveSeries(symbol, interval = "1h", outputsize = 120) {
  if (!TWELVE_DATA_API_KEY) return null;
  try {
    const { data } = await retry(() => axios.get("https://api.twelvedata.com/time_series", { params: { symbol, interval, outputsize, order: "ASC", apikey: TWELVE_DATA_API_KEY }, timeout: 15000 }));
    if (data?.status === "error") {
      console.log(`TWELVE DATA ERROR ${symbol}`, data.message || "unknown");
      return null;
    }
    if (!Array.isArray(data?.values)) return null;
    return data.values.map(row => ({ close: +row.close, high: +row.high, low: +row.low, volume: +row.volume })).filter(x => Number.isFinite(x.close) && Number.isFinite(x.high) && Number.isFinite(x.low));
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
      const { data } = await retry(() => axios.get("https://data-api.binance.vision/api/v3/ticker/price", { params: { symbol: asset }, timeout: 10000 }));
      return +data.price;
    }
    if (!TWELVE_DATA_API_KEY) return null;
    const { data } = await retry(() => axios.get("https://api.twelvedata.com/price", { params: { symbol: asset, apikey: TWELVE_DATA_API_KEY }, timeout: 12000 }));
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

async function fetchTopUSStocks() {
  if (!TWELVE_DATA_API_KEY) return [];
  try {
    const { data } = await retry(() => axios.get("https://api.twelvedata.com/stocks", { params: { country: "United States", apikey: TWELVE_DATA_API_KEY }, timeout: 15000 }));
    if (!Array.isArray(data?.data)) return [];
    return data.data.map(s => s.symbol).filter(Boolean);
  } catch (e) {
    console.log("DYNAMIC STOCK FETCH ERROR:", e.message);
    return [];
  }
}

async function buildDynamicStockPool() {
  const apiSymbols = await fetchTopUSStocks();
  const seed = apiSymbols.length ? Array.from(new Set([...BASE_STOCK_POOL, ...apiSymbols.slice(0, 60)])) : BASE_STOCK_POOL;
  const scored = [];

  await mapWithConcurrency(seed, 4, async symbol => {
    const candles = await fetchUSData(symbol);
    if (!candles || candles.length < 70) return;
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume || 0);
    const last = closes.at(-1), prev = closes.at(-2), d21 = closes.at(-21), d63 = closes.at(-63);
    if (!Number.isFinite(last) || !Number.isFinite(prev) || !Number.isFinite(d21) || !Number.isFinite(d63)) return;
    const ema20v = ema(closes, 20), ema50v = ema(closes, 50);
    if (!Number.isFinite(ema20v) || !Number.isFinite(ema50v)) return;
    const momentum1d = safePctChange(last, prev), momentum1m = safePctChange(last, d21), momentum3m = safePctChange(last, d63);
    if (momentum1d === null || momentum1m === null || momentum3m === null) return;
    const avgVol = avg(volumes.slice(-21, -1));
    const currentVol = volumes.at(-1);
    const volRatio = avgVol > 0 ? currentVol / avgVol : 0;
    if (momentum1d < 0.005 || momentum1m <= 0 || momentum3m <= 0 || last < ema20v || last < ema50v || volRatio < 1.02) return;
    const score = momentum1d * 40 + momentum1m * 25 + momentum3m * 20 + Math.min(volRatio, 3) * 10 + (last > ema20v ? 3 : 0) + (last > ema50v ? 2 : 0);
    scored.push({ symbol, score });
  });

  const dynamicPool = scored.sort((a, b) => b.score - a.score).slice(0, MAX_DYNAMIC_STOCKS).map(x => x.symbol);
  return dynamicPool.length ? dynamicPool : STOCK_POOL;
}

async function updateBTCTrend() {
  const candles = await fetchCrypto("BTCUSDT");
  if (!candles) return;
  const closes = candles.map(x => x.close);
  btcTrend = classifyRegime(ema(closes, 20), ema(closes, 50), closes.at(-1));
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
  qqqTrend = classifyRegime(ema(closes, 20), ema(closes, 50), closes.at(-1));
}

function analyse(asset, candles, market) {
  if (!candles || candles.length < MIN_CANDLES || !regimePass(market)) return null;

  const closes = candles.map(x => x.close);
  const highs = candles.map(x => x.high);
  const lows = candles.map(x => x.low);
  const volumes = candles.map(x => x.volume || 0);

  const last = closes.at(-1);
  const prev = closes.at(-2);
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) return null;

  const momentum = (last - prev) / prev;
  if (momentum <= 0 || momentum > MAX_MOMENTUM_BAR) return null;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema20Prev = ema(closes.slice(0, -1), 20);
  if (!(ema20 > ema50 && last > ema20 && ema20 > ema20Prev)) return null;

  const avgVol = avg(volumes.slice(-21, -1));
  const currentVol = volumes.at(-1);
  const volRatio = avgVol > 0 ? currentVol / avgVol : 0;

  const extension = (last - ema20) / ema20;
  if (extension > extensionLimitForMarket(market)) return null;

  const breakoutLevel = Math.max(...highs.slice(-BREAKOUT_LOOKBACK, -1));
  const breakoutDistance = breakoutLevel > 0 ? (last - breakoutLevel) / breakoutLevel : 0;

  const stockMomentumOverride =
    market === "US" &&
    momentum > STOCK_MOMENTUM_OVERRIDE_PCT &&
    volRatio > STOCK_MOMENTUM_OVERRIDE_VOL &&
    breakoutDistance <= STOCK_BREAKOUT_MAX_DISTANCE_OVERRIDE &&
    last > ema20 &&
    ema20 > ema50;

  const breakoutSignal =
    last > breakoutLevel &&
    (breakoutDistance <= breakoutDistanceLimitForMarket(market) || stockMomentumOverride) &&
    volRatio >= breakoutVolForMarket(market);

  const nearEMA20 =
    market === "CRYPTO"
      ? Math.abs(last - ema20) / ema20 <= 0.025
      : Math.abs(last - ema20) / ema20 <= 0.02;

  const pulledBackRecently = closes.slice(-6, -1).some(c => c <= ema20 * 1.01);
  const pullbackSignal = nearEMA20 && pulledBackRecently && volRatio >= pullbackVolForMarket(market);

  if (!pullbackSignal && !breakoutSignal) return null;

  const setupType = pullbackSignal && !breakoutSignal ? "PULLBACK_CONTINUATION" : stockMomentumOverride ? "MOMENTUM_BREAKOUT" : "BREAKOUT_CONTINUATION";
  const entryType = setupType === "PULLBACK_CONTINUATION" ? "LIMIT BUY" : "STOP BUY";
  const entry = setupType === "PULLBACK_CONTINUATION" ? ema20 * 1.002 : breakoutLevel * 1.0015;

  const atr = calculateATR(candles, ATR_PERIOD);
  if (!atr || atr <= 0) return null;

  const swingLow = Math.min(...lows.slice(-6));
  const sl = setupType === "PULLBACK_CONTINUATION"
    ? Math.min(swingLow - atr * ATR_PULLBACK_MULTIPLIER, entry - atr * ATR_PULLBACK_MULTIPLIER)
    : Math.min(swingLow - atr * ATR_BREAKOUT_MULTIPLIER, entry - atr * ATR_BREAKOUT_MULTIPLIER);

  if (!Number.isFinite(sl) || sl >= entry) return null;

  const riskAmt = entry - sl;
  const riskPct = riskAmt / entry;
  if (riskPct <= 0 || riskPct > 0.12) return null;

  const tp = entry + riskAmt * TARGET_R;
  const rr = +((((tp - entry) / entry) / riskPct).toFixed(1));
  if (rr < MIN_RR) return null;

  let score = 50;
  if (volRatio > 1.2) score += 6;
  if (volRatio > 1.3) score += 8;
  if (volRatio > 1.6) score += 5;
  if (momentum > 0.0075) score += 6;
  if (momentum > 0.01) score += 8;
  if (setupType === "BREAKOUT_CONTINUATION") score += 10;
  if (setupType === "PULLBACK_CONTINUATION") score += 8;
  if (setupType === "MOMENTUM_BREAKOUT") score += 14;
  if (market === "CRYPTO") score += 5;
  if (market === "US") score += 5;
  if (market === "CRYPTO" && btcTrend === "strong_bull") score += 5;
  if (market === "US" && qqqTrend === "strong_bull") score += 5;

  let grade = "B";
  if (score >= 88) grade = "A*";
  else if (score >= 74) grade = "A";

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
    regime: market === "CRYPTO" ? btcTrend : market === "US" ? qqqTrend : "local"
  };
}

async function sendSignal(s, size, riskFraction, riskPct) {
  const marketIcon = s.market === "CRYPTO" ? "ðŸª™" : s.market === "US" ? "ðŸ‡ºðŸ‡¸" : "ðŸ‡¬ðŸ‡§";
  const slotNote = s.market === "CRYPTO" ? "ðŸš€ SLOT: BEST CRYPTO" : s.market === "US" ? "ðŸš€ SLOT: BEST STOCK" : "";
  await send(`ðŸš¨ ${s.grade}\n\n${marketIcon} ${s.asset}\n${slotNote}\nðŸ§  ${s.setupType}\nâš¡ ${s.entryType}\n\nðŸŽ¯ ENTRY\n${formatPrice(s.entry, s.market)}\n\nðŸ›‘ STOP\n${formatPrice(s.sl, s.market)}\n\nðŸ’° TARGET\n${formatPrice(s.tp, s.market)}\n\nðŸ“Š R:R ${s.rr}\nðŸ“ˆ ${(s.momentum * 100).toFixed(2)}%\nðŸ“Š VOL ${s.volRatio.toFixed(2)}x\nðŸ“ ATR ${s.atr.toFixed(4)}\nðŸŒ REGIME ${s.regime}\nðŸ§  SCORE ${s.score}\n\nðŸ’° POSITION SIZE\n${size.toFixed(2)} units\n\nâš ï¸ ACCOUNT RISK\n${(riskFraction * 100).toFixed(2)}%\n\nðŸ“ STOP DISTANCE\n${(riskPct * 100).toFixed(2)}%`);
}

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
    await mapWithConcurrency(CRYPTO_PAIRS, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset, "CRYPTO", fetchCrypto));
  }

  if (ENABLE_US && isUSMarketOpen()) {
    const activeStockPool = DYNAMIC_STOCK_UNIVERSE ? await buildDynamicStockPool() : STOCK_POOL;
    console.log("ðŸ“Š Active US Pool:", activeStockPool.join(", "));
    await mapWithConcurrency(activeStockPool, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset, "US", fetchUSData));
  }

  if (ENABLE_LSE && isLSEOpen()) {
    await mapWithConcurrency(LSE_POOL, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset, "LSE", fetchLSEData));
  }

  return pickBestPerMarket(results);
}

async function processSignals(signals) {
  const alerts = load(FILES.alerts, []);
  const trades = load(FILES.trades, []);

  const bestCrypto = getBestSignalByMarket(signals, "CRYPTO");
  const bestUS = getBestSignalByMarket(signals, "US");
  const bestLSE = getBestSignalByMarket(signals, "LSE");
  const selectedSignals = [bestCrypto, bestUS, bestLSE].filter(Boolean);

  for (const s of selectedSignals) {
    const slotKey = getSlotKey(s.market);
    if (!slotKey || MAX_POSITIONS[slotKey] === 0) continue;

    const currentTrade = getCurrentOpenTradeInBucket(trades, s.market);

    if (s.market === "CRYPTO" && hasCorrelatedOpenTrade(s.asset, trades) && (!currentTrade || currentTrade.asset !== s.asset)) {
      console.log(`SKIPPED ${s.asset} â€” correlated crypto exposure already open`);
      continue;
    }

    if (s.market === "US" && hasCorrelatedOpenTrade(s.asset, trades) && (!currentTrade || currentTrade.asset !== s.asset)) {
      console.log(`SKIPPED ${s.asset} â€” correlated stock exposure already open`);
      continue;
    }

    const riskFraction = getRiskFractionForSignal(s);
    const size = calculatePositionSize(s);
    const riskPerUnit = s.entry - s.sl;
    const riskAmount = size * riskPerUnit;
    const riskPct = riskPerUnit / s.entry;

    if (!Number.isFinite(size) || size <= 0) {
      console.log(`SKIPPED ${s.asset} â€” invalid position size`);
      continue;
    }

    if (!currentTrade && (getOpenRiskFraction(trades) + riskFraction) > MAX_PORTFOLIO_RISK) {
      console.log(`SKIPPED ${s.asset} â€” portfolio risk maxed`);
      continue;
    }

    let replacementMessage = null;

    if (currentTrade) {
      const livePrice = await fetchLivePrice(currentTrade.asset, currentTrade.market);
      const replace = shouldReplaceTrade(s, currentTrade, livePrice);

      if (!replace) {
        console.log(`â›” IGNORED ${s.asset} â€” current ${s.market} position stronger`);
        continue;
      }

      const currentProgress = currentTradeProgress(currentTrade, livePrice);
      const currentRiskAmt = currentTrade.entry - currentTrade.sl;

      currentTrade.status = "CLOSED";
      currentTrade.outcome = "REPLACED";
      currentTrade.closedAt = nowIso();
      currentTrade.closePrice = Number.isFinite(livePrice) ? livePrice : currentTrade.lastCheckPrice;
      currentTrade.cancelReason = "REPLACED_BY_BETTER_SIGNAL";
      currentTrade.rCaptured = currentRiskAmt > 0 && Number.isFinite(livePrice)
        ? +(((livePrice - currentTrade.entry) / currentRiskAmt)).toFixed(2)
        : null;

      replacementMessage = `ðŸ” REPLACEMENT SIGNAL\n\nCurrent: ${currentTrade.asset} (score ${currentTrade.score}, progress ${(currentProgress * 100).toFixed(0)}%)\nNew: ${s.asset} (score ${s.score})\n\nðŸ‘‰ Action: REPLACE`;
    }

    if (replacementMessage) await send(replacementMessage);
    await sendSignal(s, size, riskFraction, riskPct);

    const sentAt = nowIso();
    const createdPrice = await fetchLivePrice(s.asset, s.market);

    alerts.push({ asset: s.asset, sentAt });

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
      mfeR: null,
      size,
      riskFraction,
      riskAmount,
      riskPct
    });
  }

  save(FILES.alerts, alerts);
  save(FILES.trades, trades);
}

function shouldFillTrade(trade, price) {
  const prev = trade.lastCheckPrice ?? trade.createdPrice;
  if (!Number.isFinite(prev) || !Number.isFinite(price)) return false;
  if (trade.entryType === "LIMIT BUY") return prev > trade.entry && price <= trade.entry;
  if (trade.entryType === "STOP BUY") return prev < trade.entry && price >= trade.entry;
  return false;
}

function shouldCancelPending(trade) {
  return hoursAgo(trade.sentAt) >= pendingExpiryHours(trade.market);
}

function shouldCancelForDrift(trade, price) {
  if (!Number.isFinite(price) || !Number.isFinite(trade.entry) || trade.entry <= 0) return false;
  const distance = (price - trade.entry) / trade.entry;
  if (trade.entryType === "LIMIT BUY") return distance < -0.03;
  if (trade.entryType === "STOP BUY") return distance > 0.03;
  return false;
}

function shouldCancelForStructure(trade, candles) {
  if (!candles || candles.length < 20) return false;
  const closes = candles.map(c => c.close);
  const ema20Value = ema(closes, 20);
  const last = closes.at(-1);
  if (!Number.isFinite(ema20Value) || !Number.isFinite(last)) return false;
  if (trade.setupType === "PULLBACK_CONTINUATION" && last < ema20Value * 0.995) return true;
  if ((trade.setupType === "BREAKOUT_CONTINUATION" || trade.setupType === "MOMENTUM_BREAKOUT")) {
    const breakoutLevel = Math.max(...candles.slice(-10, -1).map(c => c.high));
    if (last < breakoutLevel * 0.985) return true;
  }
  return false;
}

async function fetchCandlesForTrade(trade) {
  if (trade.market === "CRYPTO") return fetchCrypto(trade.asset);
  if (trade.market === "US") return fetchUSData(trade.asset);
  if (trade.market === "LSE") return fetchLSEData(trade.asset);
  return null;
}

function createCandleCache() {
  const cache = {};
  return async function getCandlesCached(asset, market) {
    const key = `${market}-${asset}`;
    if (cache[key]) return cache[key];
    const data = await fetchCandlesForTrade({ asset, market });
    cache[key] = data;
    return data;
  };
}

async function checkOutcomes() {
  const trades = load(FILES.trades, []);
  const active = trades.filter(t => t.outcome === "OPEN");
  const getCandlesCached = createCandleCache();
  if (!active.length) return;
  let updated = false;

  for (const trade of active) {
    try {
      const price = await fetchLivePrice(trade.asset, trade.market);
      if (!Number.isFinite(price)) continue;
      const mktIcon = trade.market === "CRYPTO" ? "ðŸª™" : trade.market === "US" ? "ðŸ‡ºðŸ‡¸" : "ðŸ‡¬ðŸ‡§";

      if (trade.status === "PENDING") {
        if (shouldFillTrade(trade, price)) {
          trade.status = "FILLED";
          trade.filledAt = nowIso();
          trade.fillPrice = price;
          trade.lastCheckPrice = price;
          trade.maePrice = price;
          trade.mfePrice = price;
          updated = true;

          await send(`âœ… ENTRY FILLED\n\n${mktIcon} ${trade.asset}\nðŸ§  ${trade.setupType}\nâš¡ ${trade.entryType}\n\nðŸŽ¯ Planned: ${formatPrice(trade.entry, trade.market)}\nðŸ“ Fill: ${formatPrice(price, trade.market)}\nðŸ’° Size: ${trade.size?.toFixed(2) || "n/a"} units\nâš ï¸ Risk: ${trade.riskFraction ? (trade.riskFraction * 100).toFixed(2) : "n/a"}%`);
          continue;
        }

        const candles = await getCandlesCached(trade.asset, trade.market);

        if (shouldCancelForStructure(trade, candles)) {
          trade.status = "CANCELLED";
          trade.outcome = "CANCELLED";
          trade.closedAt = nowIso();
          trade.cancelReason = "STRUCTURE_INVALIDATED";
          trade.lastCheckPrice = price;
          updated = true;

          await send(`âšª ENTRY CANCELLED\n\n${mktIcon} ${trade.asset}\nðŸ§  ${trade.setupType}\n\nðŸ“‰ Structure invalidated before fill`);
          continue;
        }

        if (shouldCancelForDrift(trade, price)) {
          trade.status = "CANCELLED";
          trade.outcome = "CANCELLED";
          trade.closedAt = nowIso();
          trade.cancelReason = "PRICE_DRIFTED_TOO_FAR";
          trade.lastCheckPrice = price;
          updated = true;

          await send(`âšª ENTRY CANCELLED\n\n${mktIcon} ${trade.asset}\nðŸ§  ${trade.setupType}\n\nðŸ“ Price drifted too far from entry\nðŸŽ¯ Entry: ${formatPrice(trade.entry, trade.market)}\nðŸ“ Now: ${formatPrice(price, trade.market)}`);
          continue;
        }

        if (shouldCancelPending(trade)) {
          trade.status = "CANCELLED";
          trade.outcome = "CANCELLED";
          trade.closedAt = nowIso();
          trade.cancelReason = "ENTRY_NOT_FILLED_IN_TIME";
          trade.lastCheckPrice = price;
          updated = true;

          await send(`âšª ENTRY CANCELLED\n\n${mktIcon} ${trade.asset}\nðŸ§  ${trade.setupType}\n\nðŸ•’ Pending expired`);
          continue;
        }

        trade.lastCheckPrice = price;
        updated = true;
        continue;
      }

      if (trade.status === "FILLED") {
        const riskAmt = trade.entry - trade.sl;
        trade.maePrice = trade.maePrice === null ? price : Math.min(trade.maePrice, price);
        trade.mfePrice = trade.mfePrice === null ? price : Math.max(trade.mfePrice, price);

        if (riskAmt > 0) {
          trade.maeR = +(((trade.maePrice - trade.entry) / riskAmt)).toFixed(2);
          trade.mfeR = +(((trade.mfePrice - trade.entry) / riskAmt)).toFixed(2);
        }

        if (price >= trade.tp) {
          trade.status = "CLOSED";
          trade.outcome = "WIN";
          trade.closedAt = nowIso();
          trade.closePrice = price;
          trade.rCaptured = riskAmt > 0 ? +(((price - trade.entry) / riskAmt)).toFixed(2) : null;
          trade.lastCheckPrice = price;
          updated = true;

          await send(`âœ… TARGET HIT\n\n${mktIcon} ${trade.asset}\nðŸ§  ${trade.setupType}\n\nðŸŽ¯ Entry: ${formatPrice(trade.entry, trade.market)}\nðŸ“ Fill: ${formatPrice(trade.fillPrice, trade.market)}\nðŸ’° Exit: ${formatPrice(price, trade.market)}\n\nðŸ† ${trade.rCaptured ?? trade.rrPlanned}R\nðŸ“‰ MAE ${trade.maeR ?? "n/a"}R\nðŸ“ˆ MFE ${trade.mfeR ?? "n/a"}R`);
        } else if (price <= trade.sl) {
          trade.status = "CLOSED";
          trade.outcome = "LOSS";
          trade.closedAt = nowIso();
          trade.closePrice = price;
          trade.rCaptured = riskAmt > 0 ? +(((price - trade.entry) / riskAmt)).toFixed(2) : -1;
          trade.lastCheckPrice = price;
          updated = true;

          await send(`âŒ STOPPED OUT\n\n${mktIcon} ${trade.asset}\nðŸ§  ${trade.setupType}\n\nðŸŽ¯ Entry: ${formatPrice(trade.entry, trade.market)}\nðŸ“ Fill: ${formatPrice(trade.fillPrice, trade.market)}\nðŸ›‘ Exit: ${formatPrice(price, trade.market)}\n\nðŸ’¥ ${trade.rCaptured}R\nðŸ“‰ MAE ${trade.maeR ?? "n/a"}R\nðŸ“ˆ MFE ${trade.mfeR ?? "n/a"}R`);
        } else {
          trade.lastCheckPrice = price;
          updated = true;
        }
      }
    } catch (e) {
      console.log(`OUTCOME CHECK ERROR ${trade.asset}:`, e.message);
    }
  }

  if (updated) save(FILES.trades, trades);
}

async function weeklyReport() {
  const now = new Date();
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 7 || now.getUTCMinutes() > 5) return;

  const trades = load(FILES.trades, []);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekTrades = trades.filter(t => new Date(t.sentAt).getTime() > weekAgo);
  const filled = weekTrades.filter(t => t.status === "FILLED" || t.status === "CLOSED");
  const closed = weekTrades.filter(t => t.outcome === "WIN" || t.outcome === "LOSS");
  const wins = closed.filter(t => t.outcome === "WIN");
  const losses = closed.filter(t => t.outcome === "LOSS");
  const pending = weekTrades.filter(t => t.status === "PENDING");
  const cancelled = weekTrades.filter(t => t.status === "CANCELLED");
  const replaced = weekTrades.filter(t => t.outcome === "REPLACED");
  const winRate = closed.length ? Math.round((wins.length / closed.length) * 100) : 0;
  const expectancy = closed.length ? (wins.reduce((sum, t) => sum + (+t.rCaptured || 0), 0) + losses.reduce((sum, t) => sum + (+t.rCaptured || 0), 0)) / closed.length : 0;
  const openRisk = (getOpenRiskFraction(trades) * 100).toFixed(2);

  await send(`ðŸ“Š V74 WEEKLY PERFORMANCE\n\nðŸ”” Signals: ${weekTrades.length}\nâœ… Filled: ${filled.length}\nðŸ•’ Pending: ${pending.length}\nâšª Cancelled: ${cancelled.length}\nðŸ” Replaced: ${replaced.length}\n\nðŸ† Winners: ${wins.length} (${winRate}%)\nâŒ Losers: ${losses.length}\nðŸ§  Expectancy: ${expectancy.toFixed(2)}R\nâš ï¸ Open portfolio risk: ${openRisk}%\n\nâ‚¿ BTC regime: ${btcTrend}\nðŸ“ˆ QQQ regime: ${qqqTrend}`);
}

async function runCycle() {
  if (running) {
    console.log("â³ Cycle skipped: previous cycle still running");
    return;
  }

  running = true;
  cycleCount += 1;

  try {
    console.log(`ðŸ”„ V74 Cycle ${cycleCount} started at ${nowIso()}`);
    ensureFiles();
    await updateBTCTrend();
    await updateQQQTrend();
    await checkOutcomes();
    const signals = await scan();
    console.log(`Signals selected: ${signals.length}`);
    if (signals.length) await processSignals(signals);
    await weeklyReport();
  } catch (e) {
    console.log("RUN ERROR:", e.stack || e.message);
  } finally {
    running = false;
    console.log(`âœ… V74 Cycle ${cycleCount} finished at ${nowIso()}`);
  }
}

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

ensureFiles();

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Health server on ${PORT}`);
  console.log("ðŸš€ SNIPER V74 LIVE");

  await send(`ðŸš€ SNIPER V74 LIVE\n\nâœ… 5-minute scan engine\nâœ… one best crypto per scan\nâœ… one best stock per scan\nâœ… stock momentum breakout mode\nâœ… stock breakout tolerance widened\nâœ… stock breakout volume relaxed\nâœ… replacement-only allocator\nâœ… cross-through fills\nâœ… structure + drift invalidation\nâœ… atomic file saves\nâœ… retry protection\nâœ… portfolio risk controls\n\nðŸŽ¯ engine active`);

  await runCycle();

  setInterval(async () => {
    if (!running) await runCycle();
    else console.log("â³ Interval skipped because cycle still running");
  }, SCAN_INTERVAL_MS);
});
