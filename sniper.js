// ================================================================
// SNIPER V76
// Clean trade engine with balanced selectivity
// ================================================================

console.log("SNIPER V76 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => res.status(200).send("SNIPER V76 alive"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const supabaseEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

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
const ENABLE_LSE = true;

const SCAN_INTERVAL_MS = 300000;
const MAX_CONCURRENT_REQUESTS = 4;

const CRYPTO_COOLDOWN = 2;
const US_COOLDOWN = 4;
const LSE_COOLDOWN = 6;

const BREAKOUT_LOOKBACK = 10;

const BREAKOUT_MAX_DISTANCE_CRYPTO = 0.015;
const BREAKOUT_MAX_DISTANCE_US = 0.02;
const BREAKOUT_MAX_DISTANCE_LSE = 0.025;

const CRYPTO_PULLBACK_VOL = 1.10;
const US_PULLBACK_VOL = 1.15;
const LSE_PULLBACK_VOL = 1.05;

const CRYPTO_BREAKOUT_VOL = 1.30;
const US_BREAKOUT_VOL = 1.15;
const LSE_BREAKOUT_VOL = 1.10;

const STOCK_MOMENTUM_OVERRIDE_ENABLED = true;
const STOCK_OVERRIDE_MIN_MOMENTUM = 0.01;
const STOCK_OVERRIDE_MIN_VOL = 1.20;
const STOCK_OVERRIDE_MAX_DISTANCE = 0.02;

const EXTENSION_HARD_LIMIT_CRYPTO = 0.12;
const EXTENSION_HARD_LIMIT_US = 0.10;
const EXTENSION_HARD_LIMIT_LSE = 0.08;

const MIN_RR = 1.5;
const TARGET_R = 1.5;

const MIN_GLOBAL_SCORE = 72;
const MIN_US_SCORE = 74;
const MIN_LSE_SCORE = 70;

const PENDING_EXPIRY_HOURS_CRYPTO = 4;
const PENDING_EXPIRY_HOURS_US = 12;
const PENDING_EXPIRY_HOURS_LSE = 24;

const MAX_MOMENTUM_BAR_CRYPTO = 0.12;
const MAX_MOMENTUM_BAR_US = 0.05;
const MAX_MOMENTUM_BAR_LSE = 0.04;

const MIN_US_MOMENTUM = 0.01;
const MIN_LSE_MOMENTUM = 0.005;
const MIN_PULLBACK_MOMENTUM_CRYPTO = 0.008;
const MIN_PULLBACK_MOMENTUM_US = 0.01;
const MIN_PULLBACK_MOMENTUM_LSE = 0.005;

const MIN_CANDLES = 60;
const ATR_PERIOD = 14;
const ATR_PULLBACK_MULTIPLIER = 1.2;
const ATR_BREAKOUT_MULTIPLIER = 1.5;

const REPLACEMENT_SCORE_GAP = 6;
const REPLACEMENT_STALE_HOURS = 6;
const REPLACEMENT_PROTECT_TP_PROGRESS = 0.7;
const REPLACEMENT_STALL_PROGRESS = 0.3;

const FORCE_CLOSE_HOURS = 6;
const FORCE_CLOSE_PROGRESS = 0.3;

const MAX_POSITIONS = {
  CRYPTO: 1,
  US: 1,
  LSE: 1
};

const CRYPTO_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","LINKUSDT",
  "AVAXUSDT","SUIUSDT","NEARUSDT","RENDERUSDT",
  "TONUSDT","ONDOUSDT"
];

const STOCK_POOL = [
  "GEV","AVAV","IONQ","ASTS","NVDA","AVGO","VRT",
  "AMAT","KLAC","LRCX","ETN","DOV","CIEN","COHR","PLTR",
  "AMD","TSM","ASML","ANET","CRWD","MSFT","META","AMZN","APP","MSTR","COIN","QQQ","SMH"
];

const LSE_POOL = [
  "RR.LON","BA.LON","SHEL.LON","LSEG.LON","BARC.LON"
];

let running = false;
let cycleCount = 0;
let btcTrend = "neutral";
let qqqTrend = "neutral";

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

function loadLocal(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveLocal(file, data) {
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

async function loadAlerts() {
  if (!supabaseEnabled) return loadLocal(FILES.alerts, []);
  try {
    const { data, error } = await retry(() =>
      supabase
        .from("alerts")
        .select("*")
        .order("sentAt", { ascending: false })
        .limit(500)
    );
    if (error) throw error;
    return data || [];
  } catch {
    return loadLocal(FILES.alerts, []);
  }
}

async function loadTrades() {
  if (!supabaseEnabled) return loadLocal(FILES.trades, []);
  try {
    const { data, error } = await retry(() =>
      supabase
        .from("trades")
        .select("*")
        .order("sentAt", { ascending: false })
        .limit(500)
    );
    if (error) throw error;
    return data || [];
  } catch {
    return loadLocal(FILES.trades, []);
  }
}

async function saveAlerts(alerts) {
  if (!supabaseEnabled) {
    saveLocal(FILES.alerts, alerts);
    return;
  }
  try {
    const { error } = await retry(() =>
      supabase.from("alerts").upsert(alerts, { onConflict: "id" })
    );
    if (error) throw error;
    saveLocal(FILES.alerts, alerts);
  } catch {
    saveLocal(FILES.alerts, alerts);
  }
}

async function saveTrades(trades) {
  if (!supabaseEnabled) {
    saveLocal(FILES.trades, trades);
    return;
  }
  try {
    const { error } = await retry(() =>
      supabase.from("trades").upsert(trades, { onConflict: "id" })
    );
    if (error) throw error;
    saveLocal(FILES.trades, trades);
  } catch {
    saveLocal(FILES.trades, trades);
  }
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
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
  if (market === "LSE") return `£${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function marketCooldownHours(market) {
  if (market === "CRYPTO") return CRYPTO_COOLDOWN;
  if (market === "LSE") return LSE_COOLDOWN;
  return US_COOLDOWN;
}

function pendingExpiryHours(market) {
  if (market === "CRYPTO") return PENDING_EXPIRY_HOURS_CRYPTO;
  if (market === "LSE") return PENDING_EXPIRY_HOURS_LSE;
  return PENDING_EXPIRY_HOURS_US;
}

function breakoutDistanceLimitForMarket(market) {
  if (market === "CRYPTO") return BREAKOUT_MAX_DISTANCE_CRYPTO;
  if (market === "LSE") return BREAKOUT_MAX_DISTANCE_LSE;
  return BREAKOUT_MAX_DISTANCE_US;
}

function breakoutVolForMarket(market) {
  if (market === "CRYPTO") return CRYPTO_BREAKOUT_VOL;
  if (market === "LSE") return LSE_BREAKOUT_VOL;
  return US_BREAKOUT_VOL;
}

function pullbackVolForMarket(market) {
  if (market === "CRYPTO") return CRYPTO_PULLBACK_VOL;
  if (market === "LSE") return LSE_PULLBACK_VOL;
  return US_PULLBACK_VOL;
}

function extensionLimitForMarket(market) {
  if (market === "CRYPTO") return EXTENSION_HARD_LIMIT_CRYPTO;
  if (market === "LSE") return EXTENSION_HARD_LIMIT_LSE;
  return EXTENSION_HARD_LIMIT_US;
}

function maxMomentumBarForMarket(market) {
  if (market === "CRYPTO") return MAX_MOMENTUM_BAR_CRYPTO;
  if (market === "LSE") return MAX_MOMENTUM_BAR_LSE;
  return MAX_MOMENTUM_BAR_US;
}

function minMomentumForMarket(market) {
  if (market === "US") return MIN_US_MOMENTUM;
  if (market === "LSE") return MIN_LSE_MOMENTUM;
  return 0;
}

function minPullbackMomentumForMarket(market) {
  if (market === "CRYPTO") return MIN_PULLBACK_MOMENTUM_CRYPTO;
  if (market === "LSE") return MIN_PULLBACK_MOMENTUM_LSE;
  return MIN_PULLBACK_MOMENTUM_US;
}

function minScoreForSignal(signal) {
  if (signal.market === "CRYPTO") {
    return btcTrend === "strong_bull" ? 70 : 75;
  }
  if (signal.market === "LSE") return MIN_LSE_SCORE;
  return MIN_US_SCORE;
}

function classifyRegime(ema20, ema50, price) {
  if (!Number.isFinite(ema20) || !Number.isFinite(ema50) || !Number.isFinite(price) || ema50 === 0) {
    return "neutral";
  }
  const spread = (ema20 - ema50) / ema50;
  if (ema20 > ema50 && price > ema20) return spread >= 0.02 ? "strong_bull" : "bull";
  if (spread <= -0.02) return "risk_off";
  return "neutral";
}

function regimePass(market) {
  if (market === "CRYPTO") return btcTrend === "bull" || btcTrend === "strong_bull";
  if (market === "US") return qqqTrend !== "risk_off";
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

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

function cooldown(asset, alerts, market) {
  const last = [...alerts].reverse().find(x => x.asset === asset);
  if (!last) return false;
  return hoursAgo(last.sentAt) < marketCooldownHours(market);
}

function getOpenTradeInMarket(trades, market) {
  return trades.find(t => t.market === market && t.status === "FILLED" && t.outcome === "OPEN");
}

function dedupeOpenTradeExists(asset, trades) {
  return trades.some(t => t.asset === asset && t.status === "FILLED" && t.outcome === "OPEN");
}

function currentTradeProgress(trade, price) {
  if (!trade) return 0;
  const denom = trade.tp - trade.entry;
  if (!Number.isFinite(price) || !Number.isFinite(denom) || denom <= 0) return 0;
  return (price - trade.entry) / denom;
}

function shouldReplaceTrade(newSignal, currentTrade, livePrice) {
  if (!currentTrade) return true;
  const progress = currentTradeProgress(currentTrade, livePrice);
  if (progress > REPLACEMENT_PROTECT_TP_PROGRESS) return false;
  const scoreBetter = newSignal.score > (currentTrade.score || 0) + REPLACEMENT_SCORE_GAP;
  const stale = hoursAgo(currentTrade.filledAt) > REPLACEMENT_STALE_HOURS;
  const stalling = progress < REPLACEMENT_STALL_PROGRESS;
  return scoreBetter && (stale || stalling);
}

function shouldForceClose(trade, livePrice) {
  const progress = currentTradeProgress(trade, livePrice);
  return hoursAgo(trade.filledAt) > FORCE_CLOSE_HOURS && progress < FORCE_CLOSE_PROGRESS;
}

function getOpenRiskFraction(trades) {
  return trades
    .filter(t => t.status === "FILLED" && t.outcome === "OPEN")
    .reduce((sum, t) => sum + (t.riskFraction || 0), 0);
}

function adjustRiskByScore(score) {
  if (score >= 85) return 1.5;
  if (score >= 76) return 1.2;
  return 1.0;
}

function adjustRiskByAsset(asset, baseRisk) {
  const highVol = ["ASTS", "IONQ", "AVAV"];
  if (highVol.includes(asset)) return baseRisk * 0.7;
  return baseRisk;
}

function getRiskFractionForSignal(signal) {
  const base = BASE_RISK_PER_TRADE * adjustRiskByScore(signal.score);
  return adjustRiskByAsset(signal.asset, base);
}

function calculatePositionSize(signal) {
  const riskFraction = getRiskFractionForSignal(signal);
  const riskAmount = ACCOUNT_BALANCE * riskFraction;
  const riskPerUnit = signal.entry - signal.sl;
  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) return 0;
  return riskAmount / riskPerUnit;
}

function pickBestPerMarket(results) {
  const best = {};
  for (const s of results.sort((a, b) => b.score - a.score)) {
    if (!best[s.market]) best[s.market] = s;
  }
  return Object.values(best);
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
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minuteOfDay >= 420 && minuteOfDay < 990;
}

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
          text: msg,
          parse_mode: "HTML"
        },
        {
          timeout: 10000,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        }
      )
    );
  } catch (e) {
    console.log("TELEGRAM ERROR:", e.message);
  }
}

async function fetchCrypto(symbol) {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/klines", {
        params: { symbol, interval: "1h", limit: 120 },
        timeout: 12000
      })
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
    if (data?.status === "error") return null;
    if (!Array.isArray(data?.values)) return null;
    return data.values
      .map(row => ({
        close: +row.close,
        high: +row.high,
        low: +row.low,
        volume: +row.volume
      }))
      .filter(x => Number.isFinite(x.close) && Number.isFinite(x.high) && Number.isFinite(x.low));
  } catch {
    return null;
  }
}

async function fetchUSData(symbol) {
  return fetchTwelveSeries(symbol, "1h", 120);
}

async function fetchLSEData(symbol) {
  return fetchTwelveSeries(symbol, "1h", 120);
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

    const { data } = await retry(() =>
      axios.get("https://api.twelvedata.com/price", {
        params: { symbol: asset, apikey: TWELVE_DATA_API_KEY },
        timeout: 12000
      })
    );
    if (data?.status === "error") return null;
    return +data.price;
  } catch {
    return null;
  }
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
  if (!candles || candles.length < MIN_CANDLES) return null;
  if (!regimePass(market)) return null;

  const closes = candles.map(x => x.close);
  const highs = candles.map(x => x.high);
  const lows = candles.map(x => x.low);
  const volumes = candles.map(x => x.volume || 0);

  const last = closes.at(-1);
  const prev = closes.at(-2);
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) return null;

  const momentum = (last - prev) / prev;
  if (momentum <= 0 || momentum > maxMomentumBarForMarket(market)) return null;
  if (momentum < minMomentumForMarket(market)) return null;

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

  const strongMomentumOverride =
    market === "US" &&
    STOCK_MOMENTUM_OVERRIDE_ENABLED &&
    momentum >= STOCK_OVERRIDE_MIN_MOMENTUM &&
    volRatio >= STOCK_OVERRIDE_MIN_VOL &&
    last > ema20 &&
    ema20 > ema50 &&
    breakoutDistance <= STOCK_OVERRIDE_MAX_DISTANCE;

  const breakoutSignal =
    last > breakoutLevel &&
    breakoutDistance <= breakoutDistanceLimitForMarket(market) &&
    volRatio >= breakoutVolForMarket(market);

  const nearEMA20 =
    market === "CRYPTO"
      ? Math.abs(last - ema20) / ema20 <= 0.025
      : market === "LSE"
        ? Math.abs(last - ema20) / ema20 <= 0.025
        : Math.abs(last - ema20) / ema20 <= 0.02;

  const pulledBackRecently = closes.slice(-6, -1).some(c => c <= ema20 * 1.01);
  const pullbackSignal =
    nearEMA20 &&
    pulledBackRecently &&
    volRatio >= pullbackVolForMarket(market);

  if (!pullbackSignal && !breakoutSignal && !strongMomentumOverride) return null;

  let setupType =
    pullbackSignal && !breakoutSignal
      ? "PULLBACK_CONTINUATION"
      : strongMomentumOverride
        ? "MOMENTUM_BREAKOUT"
        : "BREAKOUT_CONTINUATION";

  if (setupType === "PULLBACK_CONTINUATION" && momentum < minPullbackMomentumForMarket(market)) {
    return null;
  }

  let entryType = setupType === "PULLBACK_CONTINUATION" ? "LIMIT BUY" : "STOP BUY";
  let entry = setupType === "PULLBACK_CONTINUATION" ? ema20 * 1.002 : breakoutLevel * 1.0015;

  if (pullbackSignal && momentum > 0.01 && volRatio > 1.2 && market !== "LSE") {
    setupType = "MOMENTUM_CONTINUATION";
    entryType = "MARKET BUY";
    entry = last;
  }

  const atr = calculateATR(candles, ATR_PERIOD);
  if (!atr || atr <= 0) return null;

  const swingLow = Math.min(...lows.slice(-6));
  const sl =
    setupType === "PULLBACK_CONTINUATION"
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
  if (volRatio > 1.4) score += 5;
  if (volRatio > 1.7) score += 4;

  if (momentum > 0.01) score += 8;
  if (momentum > 0.015) score += 4;

  if (setupType === "BREAKOUT_CONTINUATION") score += 10;
  if (setupType === "PULLBACK_CONTINUATION") score += 8;
  if (setupType === "MOMENTUM_BREAKOUT") score += 13;
  if (setupType === "MOMENTUM_CONTINUATION") score += 13;

  if (market === "CRYPTO") score += 5;
  if (market === "US") score += 4;
  if (market === "LSE") score += 2;

  if (market === "CRYPTO" && btcTrend === "strong_bull") score += 5;
  if (market === "US" && qqqTrend === "bull") score += 3;
  if (market === "US" && qqqTrend === "strong_bull") score += 5;

  if (["NVDA","AVGO","GEV","VRT"].includes(asset)) score += 4;
  if (["ASTS","IONQ","AVAV"].includes(asset)) score += 2;
  if (["TONUSDT","ONDOUSDT"].includes(asset) && momentum > 0.02) score += 6;

  let grade = "B";
  if (score >= 85) grade = "A*";
  else if (score >= 78) grade = "A";

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
    strongMomentumOverride,
    regime: market === "CRYPTO" ? btcTrend : market === "US" ? qqqTrend : "LSE_ALLOWED"
  };
}

function buildSignalMessage(signal, size, riskFraction) {
  const icon = signal.market === "CRYPTO" ? "🪙" : signal.market === "US" ? "🇺🇸" : "🇬🇧";
  return [
    `🚨 <b>${signal.grade}</b>`,
    ``,
    `${icon} <b>${signal.asset}</b>`,
    `${signal.setupType}`,
    `${signal.entryType}`,
    ``,
    `Entry: <b>${formatPrice(signal.entry, signal.market)}</b>`,
    `SL: <b>${formatPrice(signal.sl, signal.market)}</b>`,
    `TP: <b>${formatPrice(signal.tp, signal.market)}</b>`,
    `R:R: <b>${signal.rr}</b>`,
    `Score: <b>${signal.score}</b>`,
    `Volume: <b>${signal.volRatio.toFixed(2)}x</b>`,
    `Risk: <b>${(riskFraction * 100).toFixed(2)}%</b>`,
    `Size: <b>${size.toFixed(2)}</b>`
  ].join("
");
}

async function scan() {
  const alerts = await loadAlerts();
  const trades = await loadTrades();
  const results = [];

  async function processAsset(asset, market, fetcher) {
    if (cooldown(asset, alerts, market)) return;
    if (dedupeOpenTradeExists(asset, trades)) return;
    const candles = await fetcher(asset);
    const signal = analyse(asset, candles, market);
    if (signal) results.push(signal);
  }

  if (ENABLE_CRYPTO) {
    await mapWithConcurrency(CRYPTO_PAIRS, MAX_CONCURRENT_REQUESTS, asset =>
      processAsset(asset, "CRYPTO", fetchCrypto)
    );
  }

  if (ENABLE_US && isUSMarketOpen()) {
    await mapWithConcurrency(STOCK_POOL, MAX_CONCURRENT_REQUESTS, asset =>
      processAsset(asset, "US", fetchUSData)
    );
  }

  if (ENABLE_LSE && isLSEOpen()) {
    await mapWithConcurrency(LSE_POOL, MAX_CONCURRENT_REQUESTS, asset =>
      processAsset(asset, "LSE", fetchLSEData)
    );
  }

  const filtered = results.filter(signal => signal.score >= MIN_GLOBAL_SCORE);
  return pickBestPerMarket(filtered);
}

async function processSignals(signals) {
  const alerts = await loadAlerts();
  const trades = await loadTrades();

  for (const signal of signals) {
    if (!MAX_POSITIONS[signal.market]) continue;

    const minScore = minScoreForSignal(signal);
    if (signal.score < minScore) continue;

    const currentTrade = getOpenTradeInMarket(trades, signal.market);

    const riskFraction = getRiskFractionForSignal(signal);
    if (!currentTrade && (getOpenRiskFraction(trades) + riskFraction) > MAX_PORTFOLIO_RISK) {
      continue;
    }

    let replacementNote = null;

    if (currentTrade) {
      const livePrice = await fetchLivePrice(currentTrade.asset, currentTrade.market);
      if (!shouldReplaceTrade(signal, currentTrade, livePrice)) {
        continue;
      }

      const currentRiskAmt = currentTrade.entry - currentTrade.sl;
      currentTrade.status = "CLOSED";
      currentTrade.outcome = "REPLACED";
      currentTrade.closedAt = nowIso();
      currentTrade.closePrice = Number.isFinite(livePrice) ? livePrice : currentTrade.lastCheckPrice;
      currentTrade.cancelReason = "REPLACED_BY_BETTER_SIGNAL";
      currentTrade.rCaptured =
        currentRiskAmt > 0 && Number.isFinite(livePrice)
          ? +(((livePrice - currentTrade.entry) / currentRiskAmt)).toFixed(2)
          : null;

      replacementNote = [
        `♻️ <b>REPLACED</b>`,
        `${currentTrade.asset} → ${signal.asset}`,
        `Old score: ${currentTrade.score}`,
        `New score: ${signal.score}`
      ].join("
");
    }

    const size = calculatePositionSize(signal);
    const riskPerUnit = signal.entry - signal.sl;
    const riskAmount = size * riskPerUnit;

    if (!Number.isFinite(size) || size <= 0) continue;

    if (replacementNote) await send(replacementNote);
    await send(buildSignalMessage(signal, size, riskFraction));

    const sentAt = nowIso();
    const createdPrice = await fetchLivePrice(signal.asset, signal.market);

    alerts.push({
      id: `${signal.asset}-${sentAt}`,
      asset: signal.asset,
      sentAt
    });

    trades.push({
      id: `${signal.asset}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      asset: signal.asset,
      market: signal.market,
      setupType: signal.setupType,
      entryType: signal.entryType,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      rrPlanned: signal.rr,
      score: signal.score,
      regimeAtEntry: signal.regime,
      volRatioAtEntry: signal.volRatio,
      atrAtEntry: signal.atr,
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
      riskPct: riskPerUnit / signal.entry
    });
  }

  await saveAlerts(alerts);
  await saveTrades(trades);
}

function shouldFillTrade(trade, price) {
  const prev = trade.lastCheckPrice ?? trade.createdPrice;
  if (!Number.isFinite(prev) || !Number.isFinite(price)) return false;
  if (trade.entryType === "LIMIT BUY") return prev > trade.entry && price <= trade.entry;
  if (trade.entryType === "STOP BUY") return prev < trade.entry && price >= trade.entry;
  if (trade.entryType === "MARKET BUY") return true;
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

  if (trade.setupType === "PULLBACK_CONTINUATION" && last < ema20Value * 0.995) {
    return true;
  }

  if (
    trade.setupType === "BREAKOUT_CONTINUATION" ||
    trade.setupType === "MOMENTUM_BREAKOUT" ||
    trade.setupType === "MOMENTUM_CONTINUATION"
  ) {
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
  const trades = await loadTrades();
  const active = trades.filter(t => t.outcome === "OPEN");
  if (!active.length) return;

  const getCandlesCached = createCandleCache();
  let updated = false;

  for (const trade of active) {
    try {
      const price = await fetchLivePrice(trade.asset, trade.market);
      if (!Number.isFinite(price)) continue;

      const marketIcon = trade.market === "CRYPTO" ? "🪙" : trade.market === "US" ? "🇺🇸" : "🇬🇧";

      if (trade.status === "PENDING") {
        if (shouldFillTrade(trade, price)) {
          trade.status = "FILLED";
          trade.filledAt = nowIso();
          trade.fillPrice = price;
          trade.lastCheckPrice = price;
          trade.maePrice = price;
          trade.mfePrice = price;
          updated = true;

          await send([
            `✅ <b>ENTRY FILLED</b>`,
            `${marketIcon} <b>${trade.asset}</b>`,
            `${trade.setupType}`,
            `Fill: <b>${formatPrice(price, trade.market)}</b>`
          ].join("
"));
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

          await send([
            `❌ <b>ENTRY CANCELLED</b>`,
            `${marketIcon} <b>${trade.asset}</b>`,
            `Reason: structure invalidated`
          ].join("
"));
          continue;
        }

        if (shouldCancelForDrift(trade, price)) {
          trade.status = "CANCELLED";
          trade.outcome = "CANCELLED";
          trade.closedAt = nowIso();
          trade.cancelReason = "PRICE_DRIFTED_TOO_FAR";
          trade.lastCheckPrice = price;
          updated = true;

          await send([
            `❌ <b>ENTRY CANCELLED</b>`,
            `${marketIcon} <b>${trade.asset}</b>`,
            `Reason: price drifted too far`
          ].join("
"));
          continue;
        }

        if (shouldCancelPending(trade)) {
          trade.status = "CANCELLED";
          trade.outcome = "CANCELLED";
          trade.closedAt = nowIso();
          trade.cancelReason = "ENTRY_NOT_FILLED_IN_TIME";
          trade.lastCheckPrice = price;
          updated = true;

          await send([
            `❌ <b>ENTRY CANCELLED</b>`,
            `${marketIcon} <b>${trade.asset}</b>`,
            `Reason: pending expired`
          ].join("
"));
          continue;
        }

        trade.lastCheckPrice = price;
        updated = true;
        continue;
      }

      if (trade.status === "FILLED") {
        const riskAmt = trade.entry - trade.sl;

        if (shouldForceClose(trade, price)) {
          trade.status = "CLOSED";
          trade.outcome = "FORCED_EXIT";
          trade.closedAt = nowIso();
          trade.closePrice = price;
          trade.lastCheckPrice = price;
          trade.rCaptured = riskAmt > 0 ? +(((price - trade.entry) / riskAmt)).toFixed(2) : null;
          updated = true;

          await send([
            `⏱️ <b>FORCE CLOSED</b>`,
            `${marketIcon} <b>${trade.asset}</b>`,
            `Reason: stale and under 30% progress`
          ].join("
"));
          continue;
        }

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
          trade.lastCheckPrice = price;
          trade.rCaptured = riskAmt > 0 ? +(((price - trade.entry) / riskAmt)).toFixed(2) : null;
          updated = true;

          await send([
            `🎯 <b>TARGET HIT</b>`,
            `${marketIcon} <b>${trade.asset}</b>`,
            `Exit: <b>${formatPrice(price, trade.market)}</b>`,
            `R: <b>${trade.rCaptured}</b>`
          ].join("
"));
          continue;
        }

        if (price <= trade.sl) {
          trade.status = "CLOSED";
          trade.outcome = "LOSS";
          trade.closedAt = nowIso();
          trade.closePrice = price;
          trade.lastCheckPrice = price;
          trade.rCaptured = riskAmt > 0 ? +(((price - trade.entry) / riskAmt)).toFixed(2) : -1;
          updated = true;

          await send([
            `🛑 <b>STOP HIT</b>`,
            `${marketIcon} <b>${trade.asset}</b>`,
            `Exit: <b>${formatPrice(price, trade.market)}</b>`,
            `R: <b>${trade.rCaptured}</b>`
          ].join("
"));
          continue;
        }

        trade.lastCheckPrice = price;
        updated = true;
      }
    } catch (e) {
      console.log(`OUTCOME CHECK ERROR ${trade.asset}:`, e.message);
    }
  }

  if (updated) await saveTrades(trades);
}

async function runCycle() {
  if (running) {
    console.log("Cycle skipped: previous cycle still running");
    return;
  }

  running = true;
  cycleCount += 1;

  try {
    ensureFiles();

    console.log(`Cycle ${cycleCount} started at ${nowIso()}`);

    await updateBTCTrend();
    await updateQQQTrend();
    await checkOutcomes();

    const signals = await scan();
    if (signals.length) {
      await processSignals(signals);
    } else {
      console.log("NO VALID SIGNALS THIS CYCLE");
    }
  } catch (e) {
    console.log("RUN ERROR:", e.stack || e.message);
  } finally {
    running = false;
    console.log(`Cycle ${cycleCount} finished at ${nowIso()}`);
  }
}

process.on("uncaughtException", err => {
  console.log("UNCAUGHT EXCEPTION:", err.stack || err.message);
});

process.on("unhandledRejection", err => {
  console.log("UNHANDLED REJECTION:", err?.stack || err?.message || err);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  process.exit(0);
});

ensureFiles();

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Health server on ${PORT}`);

  await send([
    `🚀 <b>SNIPER V76 LIVE</b>`,
    ``,
    `Balanced selectivity mode`,
    `Crypto regime gated by BTC`,
    `US scans only during market hours`,
    `LSE enabled`,
    `Full trade lifecycle restored`,
    `Supabase + local fallback active`
  ].join("
"));

  await runCycle();

  setInterval(async () => {
    if (!running) await runCycle();
  }, SCAN_INTERVAL_MS);
});
