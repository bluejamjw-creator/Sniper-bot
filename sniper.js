console.log("🚀 SNIPER V87 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const ws = require("ws");
const { createClient } = require("@supabase/supabase-js");

axios.defaults.timeout = 15000;

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY || "";
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const supabaseEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { realtime: { transport: ws } })
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
const POOL_REFRESH_INTERVAL_MS = 3600000;
const MAX_CONCURRENT_REQUESTS = 3;
const STARTUP_DELAY_MS = 5000;
const REQUEST_DELAY_MS = 250;
const SCAN_TIMEOUT_MS = 240000;
const SHUTDOWN_EXIT_MS = 5000;
const CACHE_TTL_MS = 4 * 60 * 1000;
const CACHE_CLEANUP_MS = 10 * 60 * 1000;

const CRYPTO_COOLDOWN = 2;
const US_COOLDOWN = 4;
const LSE_COOLDOWN = 6;

const BREAKOUT_LOOKBACK = 10;

const BREAKOUT_MAX_DISTANCE_CRYPTO = 0.03;
const BREAKOUT_MAX_DISTANCE_US = 0.04;
const BREAKOUT_MAX_DISTANCE_LSE = 0.04;

const CRYPTO_PULLBACK_VOL = 1.20;
const US_PULLBACK_VOL = 1.20;
const LSE_PULLBACK_VOL = 1.10;

const CRYPTO_BREAKOUT_VOL = 1.60;
const US_BREAKOUT_VOL = 1.40;
const LSE_BREAKOUT_VOL = 1.25;

const STOCK_MOMENTUM_OVERRIDE_ENABLED = true;
const STOCK_OVERRIDE_MIN_MOMENTUM = 0.015;
const STOCK_OVERRIDE_MIN_VOL = 1.40;
const STOCK_OVERRIDE_MAX_DISTANCE = 0.025;

const EXTENSION_HARD_LIMIT_CRYPTO = 0.12;
const EXTENSION_HARD_LIMIT_US = 0.10;
const EXTENSION_HARD_LIMIT_LSE = 0.08;

const MIN_RR = 1.5;
const TARGET_R = 1.5;

const MIN_GLOBAL_SCORE = 78;
const MIN_US_SCORE = 80;
const MIN_LSE_SCORE = 76;

const PENDING_EXPIRY_HOURS_CRYPTO = 4;
const PENDING_EXPIRY_HOURS_US = 12;
const PENDING_EXPIRY_HOURS_LSE = 24;

const MAX_MOMENTUM_BAR_CRYPTO = 0.12;
const MAX_MOMENTUM_BAR_US = 0.08;
const MAX_MOMENTUM_BAR_LSE = 0.04;

const MIN_US_MOMENTUM = 0.015;
const MIN_LSE_MOMENTUM = 0.008;

const MIN_PULLBACK_MOMENTUM_CRYPTO = 0.010;
const MIN_PULLBACK_MOMENTUM_US = 0.015;
const MIN_PULLBACK_MOMENTUM_LSE = 0.008;

const MIN_CANDLES = 60;
const ATR_PERIOD = 14;
const ATR_PULLBACK_MULTIPLIER = 1.2;
const ATR_BREAKOUT_MULTIPLIER = 1.5;
const ATR_IGNITION_MULTIPLIER = 1.8;

const REPLACEMENT_SCORE_GAP = 6;
const REPLACEMENT_STALE_HOURS = 6;
const REPLACEMENT_STALL_PROGRESS = 0.3;
const REPLACEMENT_PROTECT_TP_PROGRESS = 0.7;

const FORCE_CLOSE_HOURS = 4;
const FORCE_CLOSE_PROGRESS = 0.2;

const MAX_POSITIONS = { CRYPTO: 1, US: 1, LSE: 1 };

const API_LIMITS = { twelvedata: 700, alphavantage: 20 };
let apiUsage = { twelvedata: 0, alphavantage: 0, resetDay: -1 };
let apiRotateIdx = 0;
let finnhubBlockedUntil = 0;

const REGIME_OVERRIDE_MIN_VOL = 2.0;
const REGIME_OVERRIDE_MIN_MOMENTUM = 0.025;

const SECTOR_SYMBOLS = {
  AI: ["NVDA", "PLTR", "AMD", "SMCI", "MSFT", "META", "GOOGL", "IONQ", "CRWD", "ANET"],
  GOLD: ["NEM", "GOLD", "AEM", "WPM", "KGC", "SIL"],
  SILVER: ["SIL", "WPM", "PAAS", "AG"],
  CRYPTO: ["COIN", "MSTR", "RIOT", "CLSK"],
  ENERGY: ["XOM", "CVX", "SLB", "HAL", "MPC"],
  DEFENSE: ["LMT", "RTX", "NOC", "GD", "AVAV"],
  ROBOTICS: ["ROK", "ISRG", "TER"],
  NUCLEAR: ["CCJ", "NNE", "SMR", "UUUU", "DNN", "OKLO"]
};

const NARRATIVE_KEYWORDS = {
  AI: ["artificial intelligence", "ai chip", "machine learning", "llm", "gpu", "nvidia", "generative ai", "foundation model", "openai", "chatgpt"],
  GOLD: ["gold price", "gold rally", "bullion", "gold futures", "precious metals", "safe haven", "gold hits"],
  SILVER: ["silver price", "silver rally", "industrial metals", "silver futures"],
  CRYPTO: ["bitcoin", "ethereum", "crypto rally", "btc", "eth", "digital assets", "blockchain", "crypto surge"],
  ENERGY: ["oil price", "crude", "energy rally", "opec", "natural gas", "refinery", "brent"],
  DEFENSE: ["defense spending", "military", "nato", "geopolitical", "weapons", "pentagon", "war", "conflict"],
  ROBOTICS: ["robotics", "automation", "humanoid", "manufacturing robot", "cobots"],
  NUCLEAR: ["nuclear energy", "uranium", "small modular reactor", "smr", "nuclear power", "fission"]
};

const CRYPTO_AI_NAMES = ["RENDERUSDT", "FETUSDT", "NEARUSDT", "TAOUSDT", "AGIXUSDT", "OCEANUSDT"];

const STATIC_CRYPTO_FALLBACK = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT",
  "AVAXUSDT", "SUIUSDT", "NEARUSDT", "RENDERUSDT",
  "TONUSDT", "ONDOUSDT"
];

const STATIC_STOCK_FALLBACK = [
  "NVDA", "PLTR", "AMD", "ASTS", "IONQ", "MSFT", "META",
  "AMZN", "APP", "MSTR", "COIN", "QQQ", "SMH", "AVGO",
  "VRT", "CRWD", "AMAT", "GEV", "AVAV", "OKLO", "RKLB",
  "LUNR", "ASTS", "ETN", "ANET"
];

const LSE_POOL = ["RR.LON", "BA.LON", "SHEL.LON", "LSEG.LON", "BARC.LON"];

const CLEAN_TICKER = /^[A-Z]{1,5}$/;
const OTC_SUFFIXES = ["F", "Y", "PK"];

let STOCK_POOL = [...new Set(STATIC_STOCK_FALLBACK)];
let CRYPTO_PAIRS = [...STATIC_CRYPTO_FALLBACK];
let HOT_SECTORS = [];

let running = false;
let refreshingPools = false;
let shuttingDown = false;
let ready = false;
let fatalTriggered = false;
let btcTrend = "neutral";
let qqqTrend = "neutral";
let marketWasOpen = { CRYPTO: false, US: false, LSE: false };

const candleCache = new Map();
let cacheCleanupTimer = null;
let cycleTimer = null;
let refreshTimer = null;
let server = null;

function nowIso() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[${nowIso()}]`, ...args);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function throttle() {
  await sleep(REQUEST_DELAY_MS);
}

function isWeekend() {
  const day = new Date().getUTCDay();
  return day === 0 || day === 6;
}

function getUtcMinutes() {
  const now = new Date();
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

function dedup(arr) {
  return [...new Set(arr.filter(Boolean))];
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function lines(parts) {
  return parts.join("
");
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

function atomicWriteFile(file, content) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

function saveLocal(file, data) {
  atomicWriteFile(file, JSON.stringify(data, null, 2));
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

async function withTimeout(promise, ms, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    clearTimeout(timeout);
  }
}

async function safeRun(name, fn) {
  try {
    return await fn();
  } catch (err) {
    log(`SAFE RUN ERROR (${name}):`, err && err.message ? err.message : err);
    return null;
  }
}

function getCached(key) {
  const entry = candleCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    candleCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  candleCache.set(key, { ts: Date.now(), data });
}

function cleanupCandleCache() {
  const now = Date.now();
  for (const [key, value] of candleCache.entries()) {
    if (!value?.ts || now - value.ts > CACHE_TTL_MS) {
      candleCache.delete(key);
    }
  }
}

function clearRuntimeTimers() {
  if (cycleTimer) {
    clearTimeout(cycleTimer);
    cycleTimer = null;
  }
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (cacheCleanupTimer) {
    clearInterval(cacheCleanupTimer);
    cacheCleanupTimer = null;
  }
}

function resetApiUsageIfNewDay() {
  const day = new Date().getUTCDate();
  if (apiUsage.resetDay !== day) {
    apiUsage = { twelvedata: 0, alphavantage: 0, resetDay: day };
    apiRotateIdx = 0;
    log("🔄 API usage counters reset for new day");
  }
}

function pickApiForSymbol() {
  resetApiUsageIfNewDay();
  const tdOk = TWELVE_DATA_API_KEY && apiUsage.twelvedata < API_LIMITS.twelvedata;
  const avOk = ALPHA_VANTAGE_API_KEY && apiUsage.alphavantage < API_LIMITS.alphavantage;
  if (!tdOk && !avOk) return "yahoo";
  if (!tdOk) return "alphavantage";
  if (!avOk) return "twelvedata";
  apiRotateIdx++;
  return apiRotateIdx % 2 === 0 ? "twelvedata" : "alphavantage";
}

function canUseFinnhub() {
  return !!FINNHUB_API_KEY && Date.now() > finnhubBlockedUntil;
}

function blockFinnhub(minutes = 30) {
  finnhubBlockedUntil = Date.now() + minutes * 60 * 1000;
  log(`⚠️ Finnhub blocked for ${minutes} mins`);
}

async function safeRequest(fn, label = "request") {
  try {
    await throttle();
    return await fn();
  } catch (e) {
    const msg = e?.message || "Unknown error";
    if ((msg.includes("429") || e?.response?.status === 429) && label.toLowerCase().includes("finnhub")) {
      blockFinnhub();
    }
    log(`⚠️ ${label} failed: ${msg}`);
    return null;
  }
}

async function loadAlerts() {
  if (!supabaseEnabled) return loadLocal(FILES.alerts, []);
  try {
    const { data, error } = await retry(() =>
      supabase.from("alerts").select("*").order("sentAt", { ascending: false }).limit(1000)
    );
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  } catch {
    return loadLocal(FILES.alerts, []);
  }
}

async function loadTrades() {
  if (!supabaseEnabled) return loadLocal(FILES.trades, []);
  try {
    const { data, error } = await retry(() =>
      supabase.from("trades").select("*").order("sentAt", { ascending: false }).limit(1000)
    );
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  } catch {
    return loadLocal(FILES.trades, []);
  }
}

async function saveAlerts(alerts) {
  const bounded = Array.isArray(alerts) ? alerts.slice(-1000) : [];
  if (!supabaseEnabled) {
    saveLocal(FILES.alerts, bounded);
    return;
  }
  try {
    const { error } = await retry(() =>
      supabase.from("alerts").upsert(bounded, { onConflict: "id" })
    );
    if (error) throw error;
    saveLocal(FILES.alerts, bounded);
  } catch {
    saveLocal(FILES.alerts, bounded);
  }
}

async function saveTrades(trades) {
  const bounded = Array.isArray(trades) ? trades.slice(-1000) : [];
  if (!supabaseEnabled) {
    saveLocal(FILES.trades, bounded);
    return;
  }
  try {
    const { error } = await retry(() =>
      supabase.from("trades").upsert(bounded, { onConflict: "id" })
    );
    if (error) throw error;
    saveLocal(FILES.trades, bounded);
  } catch {
    saveLocal(FILES.trades, bounded);
  }
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

function isMarketOpen(market) {
  const mins = getUtcMinutes();
  if (market === "CRYPTO") return mins >= 300 && mins < 1260;
  if (isWeekend()) return false;
  if (market === "US") return mins >= 810 && mins < 1200;
  if (market === "LSE") return mins >= 420 && mins < 930;
  return false;
}

function isCryptoWindowOpen() {
  return isMarketOpen("CRYPTO");
}

function isUSMarketOpen() {
  return isMarketOpen("US");
}

function isLSEMarketOpen() {
  return isMarketOpen("LSE");
}

function isUSOpeningWindow() {
  if (isWeekend()) return false;
  const mins = getUtcMinutes();
  return mins >= 810 && mins < 900;
}

function classifyRegime(ema20Val, ema50Val, price) {
  if (!Number.isFinite(ema20Val) || !Number.isFinite(ema50Val) || !Number.isFinite(price) || ema50Val === 0) return "neutral";
  const spread = (ema20Val - ema50Val) / ema50Val;
  if (ema20Val > ema50Val && price > ema20Val) return spread >= 0.02 ? "strong_bull" : "bull";
  if (spread <= -0.02) return "risk_off";
  return "neutral";
}

function regimePass(market) {
  if (market === "CRYPTO") return btcTrend === "bull" || btcTrend === "strong_bull";
  if (market === "US") return qqqTrend !== "risk_off";
  return true;
}

function minScoreForMarket(market) {
  if (market === "CRYPTO") return btcTrend === "strong_bull" ? 76 : 80;
  if (market === "LSE") return MIN_LSE_SCORE;
  return MIN_US_SCORE;
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
    while (index < items.length && !shuttingDown) {
      const i = index++;
      results[i] = await asyncFn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
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

function countPendingTradesByMarket(trades, market) {
  return trades.filter(t => t.market === market && t.status === "PENDING").length;
}

function countOpenTradesByMarket(trades, market) {
  return trades.filter(t => t.market === market && t.status === "FILLED" && t.outcome === "OPEN").length;
}

function getOpenRiskFraction(trades) {
  return trades
    .filter(t => t.status === "FILLED" && t.outcome === "OPEN")
    .reduce((sum, t) => sum + (t.riskFraction || 0), 0);
}

function progressToTarget(trade, livePrice) {
  const denom = trade.tp - trade.entry;
  if (!Number.isFinite(livePrice) || !Number.isFinite(denom) || denom <= 0) return 0;
  return (livePrice - trade.entry) / denom;
}

function shouldReplaceTrade(newSignal, currentTrade, livePrice) {
  if (!currentTrade || !Number.isFinite(livePrice)) return false;
  const progress = progressToTarget(currentTrade, livePrice);
  const stale = hoursAgo(currentTrade.filledAt || currentTrade.sentAt) > REPLACEMENT_STALE_HOURS;
  const notProgressing = progress < REPLACEMENT_STALL_PROGRESS;
  const protectedWinner = progress >= REPLACEMENT_PROTECT_TP_PROGRESS;
  return (
    newSignal.score >= (currentTrade.score || 0) + REPLACEMENT_SCORE_GAP &&
    !protectedWinner &&
    (stale || notProgressing)
  );
}

function shouldForceClose(trade, livePrice) {
  if (!Number.isFinite(livePrice)) return false;
  const openHours = hoursAgo(trade.filledAt || trade.sentAt);
  const progress = progressToTarget(trade, livePrice);
  return openHours > FORCE_CLOSE_HOURS && progress < FORCE_CLOSE_PROGRESS;
}

function adjustRiskByScore(score) {
  if (score >= 85) return 1.5;
  if (score >= 78) return 1.2;
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

function isCleanTicker(sym) {
  if (!CLEAN_TICKER.test(sym)) return false;
  if (sym.length === 5 && OTC_SUFFIXES.some(s => sym.endsWith(s))) return false;
  return true;
}

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) {
    log(msg);
    return true;
  }
  await retry(() =>
    axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: msg,
      parse_mode: "HTML"
    }, { timeout: 10000 })
  );
  return true;
}

async function getTrendingCoins() {
  const result = await safeRequest(() =>
    axios.get("https://api.coingecko.com/api/v3/search/trending", {
      headers: COINGECKO_API_KEY ? { "x-cg-demo-api-key": COINGECKO_API_KEY } : {},
      timeout: 12000
    }), "CoinGecko"
  );
  if (!result?.data?.coins) return [];
  const pairs = result.data.coins
    .map(c => {
      const sym = (c?.item?.symbol || "").toUpperCase();
      return sym ? `${sym}USDT` : null;
    })
    .filter(Boolean)
    .slice(0, 12);
  log("🪙 CoinGecko trending:", pairs.join(", ") || "none");
  return pairs;
}

async function getTrendingStocks() {
  if (!canUseFinnhub()) {
    log("⚠️ Finnhub cooling down — using fallback stock pool");
    return [...STATIC_STOCK_FALLBACK];
  }
  const result = await safeRequest(() =>
    axios.get("https://finnhub.io/api/v1/stock/symbol", {
      params: { exchange: "US", token: FINNHUB_API_KEY },
      timeout: 15000
    }), "Finnhub symbols"
  );
  const data = result?.data;
  if (!Array.isArray(data)) return [...STATIC_STOCK_FALLBACK];
  const filtered = data
    .filter(s => s.type === "Common Stock" && isCleanTicker(s.symbol) && s.mic && ["XNYS", "XNAS"].includes(s.mic))
    .map(s => s.symbol)
    .slice(0, 10);
  const core = [
    "NVDA", "PLTR", "AMD", "ASTS", "IONQ", "MSFT", "META",
    "AMZN", "APP", "MSTR", "COIN", "QQQ", "SMH", "AVGO", "VRT"
  ];
  const merged = dedup([...core, ...filtered]).slice(0, 25);
  log(`📈 Stock pool: ${merged.length} clean symbols`);
  return merged;
}

async function getTopMovers() {
  if (!canUseFinnhub()) return [];
  try {
    const candidates = ["NVDA", "ASTS", "IONQ", "PLTR", "AMD", "COIN", "MSTR", "AVAV", "SMR", "OKLO", "CRWD", "APP", "RKLB", "LUNR", "ACHR"];
    const movers = [];
    await mapWithConcurrency(candidates, 4, async sym => {
      const result = await safeRequest(() =>
        axios.get("https://finnhub.io/api/v1/quote", {
          params: { symbol: sym, token: FINNHUB_API_KEY },
          timeout: 8000
        }), `Finnhub quote ${sym}`
      );
      const changePct = result?.data?.dp;
      if (Number.isFinite(changePct) && changePct > 3) {
        movers.push({ sym, changePct });
        log(`🚀 Top mover: ${sym} +${changePct.toFixed(2)}%`);
      }
    });
    return movers.sort((a, b) => b.changePct - a.changePct).map(m => m.sym);
  } catch (e) {
    log("Top movers failed:", e.message);
    return [];
  }
}

async function detectHotSectors() {
  if (!canUseFinnhub()) return [];
  const result = await safeRequest(() =>
    axios.get("https://finnhub.io/api/v1/news", {
      params: { category: "general", token: FINNHUB_API_KEY },
      timeout: 12000
    }), "Finnhub news"
  );
  const data = result?.data;
  if (!Array.isArray(data)) return [];
  const text = data.slice(0, 60)
    .map(n => ((n.headline || "") + " " + (n.summary || "")).toLowerCase())
    .join(" ");
  const scores = {};
  for (const [sector, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
    scores[sector] = keywords.filter(kw => text.includes(kw)).length;
  }
  const active = Object.entries(scores)
    .filter(([, s]) => s >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);
  log("🧠 Hot sectors:", active.join(", ") || "none");
  return active;
}

async function sendNarrativeAlert(topMovers) {
  if (!Array.isArray(topMovers)) topMovers = [];
  const sectorLines = HOT_SECTORS.map(s => {
    const syms = (SECTOR_SYMBOLS[s] || []).slice(0, 4).join(", ");
    return `  📌 <b>${escapeHtml(s)}</b> → ${escapeHtml(syms)}`;
  });
  const moverLine = topMovers.length > 0
    ? ["", "🚀 <b>Top movers injected:</b> " + escapeHtml(topMovers.slice(0, 6).join(", "))]
    : [];
  const message = lines([
    "🧠🔥 <b>MARKET NARRATIVES DETECTED</b>",
    "",
    ...(sectorLines.length > 0 ? sectorLines : ["  No strong narratives this cycle"]),
    ...moverLine,
    "",
    `🔍 Stock pool: <b>${escapeHtml(String(STOCK_POOL.length))}</b> symbols`,
    `🪙 Crypto pool: <b>${escapeHtml(String(CRYPTO_PAIRS.length))}</b> pairs`
  ]);
  await safeRun("telegramNarrative", async () => send(message));
}

async function refreshDynamicPools() {
  if (refreshingPools || shuttingDown) {
    if (refreshingPools) log("⚠️ Pool refresh skipped — already running");
    return;
  }
  refreshingPools = true;
  try {
    log("🔄 Refreshing dynamic pools...");
    const trendingCoins = await getTrendingCoins();
    CRYPTO_PAIRS = dedup([...STATIC_CRYPTO_FALLBACK, ...trendingCoins]).slice(0, 15);
    HOT_SECTORS = await detectHotSectors();
    const [trendingStocks, topMovers] = await Promise.all([getTrendingStocks(), getTopMovers()]);
    const sectorInjected = [];
    for (const sector of HOT_SECTORS) {
      const syms = (SECTOR_SYMBOLS[sector] || []).filter(isCleanTicker);
      sectorInjected.push(...syms);
      log(`💉 Injecting ${sector}: ${syms.join(", ")}`);
    }
    STOCK_POOL = dedup([...trendingStocks, ...topMovers, ...sectorInjected]).slice(0, 25);
    log(`✅ Pools ready — Crypto: ${CRYPTO_PAIRS.length}, Stocks: ${STOCK_POOL.length}`);
    log(`📊 API usage today — TwelveData: ${apiUsage.twelvedata}/${API_LIMITS.twelvedata}, AlphaVantage: ${apiUsage.alphavantage}/${API_LIMITS.alphavantage}`);
    if (HOT_SECTORS.length > 0 || topMovers.length > 0) {
      await sendNarrativeAlert(topMovers);
    }
  } finally {
    refreshingPools = false;
  }
}

async function fetchCrypto(symbol) {
  const cacheKey = `crypto_${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/klines", {
        params: { symbol, interval: "1h", limit: 70 },
        timeout: 12000
      })
    );
    const candles = data.map(k => ({ close: +k[4], high: +k[2], low: +k[3], volume: +k[5] }));
    setCache(cacheKey, candles);
    return candles;
  } catch {
    return null;
  }
}

async function fetchTwelveDataSeries(symbol, interval = "1h", outputsize = 70) {
  if (!TWELVE_DATA_API_KEY) return null;
  try {
    const { data } = await retry(() =>
      axios.get("https://api.twelvedata.com/time_series", {
        params: { symbol, interval, outputsize, order: "ASC", apikey: TWELVE_DATA_API_KEY },
        timeout: 15000
      })
    );
    if (data?.status === "error" || !Array.isArray(data?.values)) return null;
    apiUsage.twelvedata++;
    return data.values
      .map(row => ({ close: +row.close, high: +row.high, low: +row.low, volume: +row.volume }))
      .filter(x => Number.isFinite(x.close) && Number.isFinite(x.high) && Number.isFinite(x.low));
  } catch {
    return null;
  }
}

async function fetchAlphaVantageSeries(symbol, interval = "60min") {
  if (!ALPHA_VANTAGE_API_KEY) return null;
  try {
    const { data } = await retry(() =>
      axios.get("https://www.alphavantage.co/query", {
        params: { function: "TIME_SERIES_INTRADAY", symbol, interval, outputsize: "compact", apikey: ALPHA_VANTAGE_API_KEY },
        timeout: 15000
      })
    );
    const seriesKey = `Time Series (${interval})`;
    const series = data[seriesKey];
    if (!series) return null;
    apiUsage.alphavantage++;
    return Object.entries(series)
      .sort(([a], [b]) => new Date(a) - new Date(b))
      .map(([, v]) => ({ close: +v["4. close"], high: +v["2. high"], low: +v["3. low"], volume: +v["5. volume"] }))
      .filter(x => Number.isFinite(x.close));
  } catch {
    return null;
  }
}

async function fetchYahooFinanceSeries(symbol, interval) {
  const yahooInterval = interval === "15min" ? "15m" : "1h";
  const range = yahooInterval === "15m" ? "5d" : "30d";
  try {
    const { data } = await retry(() =>
      axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
        params: { interval: yahooInterval, range, includePrePost: false },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 15000
      })
    );
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const timestamps = result.timestamp || [];
    const q = result.indicators?.quote?.[0];
    if (!q) return null;
    return timestamps.map((_, i) => ({
      close: q.close[i] || 0,
      high: q.high[i] || 0,
      low: q.low[i] || 0,
      volume: q.volume[i] || 0
    })).filter(x => Number.isFinite(x.close) && x.close > 0);
  } catch (e) {
    log(`Yahoo Finance failed for ${symbol}:`, e.message);
    return null;
  }
}

async function fetchUSData(symbol) {
  const use15min = isUSOpeningWindow();
  const interval = use15min ? "15min" : "1h";
  const cacheKey = `us_${symbol}_${interval}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  resetApiUsageIfNewDay();
  const api = pickApiForSymbol();
  let candles = null;
  if (api === "twelvedata") {
    candles = await fetchTwelveDataSeries(symbol, interval, use15min ? 40 : 70);
    if (!candles) {
      candles = await fetchAlphaVantageSeries(symbol, use15min ? "15min" : "60min");
      if (candles) log(`↩️ AV fallback for ${symbol}`);
    }
  } else if (api === "alphavantage") {
    candles = await fetchAlphaVantageSeries(symbol, use15min ? "15min" : "60min");
    if (!candles) {
      candles = await fetchTwelveDataSeries(symbol, interval, use15min ? 40 : 70);
      if (candles) log(`↩️ TD fallback for ${symbol}`);
    }
  }
  if (!candles) {
    log(`🆓 Yahoo Finance for ${symbol} (API limits reached or provider failed)`);
    candles = await fetchYahooFinanceSeries(symbol, interval);
  }
  if (candles) setCache(cacheKey, candles);
  return candles;
}

async function fetchLSEData(symbol) {
  const cacheKey = `lse_${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let candles = await fetchTwelveDataSeries(symbol, "1h", 70);
  if (!candles) {
    candles = await fetchYahooFinanceSeries(symbol, "1h");
  }
  if (candles) setCache(cacheKey, candles);
  return candles;
}

async function fetchLivePriceTwelve(asset) {
  if (!TWELVE_DATA_API_KEY) return null;
  try {
    const { data } = await retry(() =>
      axios.get("https://api.twelvedata.com/price", {
        params: { symbol: asset, apikey: TWELVE_DATA_API_KEY },
        timeout: 12000
      })
    );
    if (data?.status === "error") return null;
    apiUsage.twelvedata++;
    return +data.price;
  } catch {
    return null;
  }
}

async function fetchLivePriceAlphaVantage(asset) {
  if (!ALPHA_VANTAGE_API_KEY) return null;
  try {
    const { data } = await retry(() =>
      axios.get("https://www.alphavantage.co/query", {
        params: { function: "GLOBAL_QUOTE", symbol: asset, apikey: ALPHA_VANTAGE_API_KEY },
        timeout: 12000
      })
    );
    const price = +data?.["Global Quote"]?.["05. price"];
    if (Number.isFinite(price)) apiUsage.alphavantage++;
    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

async function fetchLivePriceYahoo(asset) {
  try {
    const { data } = await retry(() =>
      axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${asset}`, {
        params: { interval: "1m", range: "1d" },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000
      })
    );
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
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
    let price = await fetchLivePriceTwelve(asset);
    if (!Number.isFinite(price)) price = await fetchLivePriceAlphaVantage(asset);
    if (!Number.isFinite(price)) price = await fetchLivePriceYahoo(asset);
    return price;
  } catch {
    return null;
  }
}

async function updateBTCTrend() {
  const candles = await fetchCrypto("BTCUSDT");
  if (!candles) return;
  const closes = candles.map(x => x.close);
  const prev = btcTrend;
  btcTrend = classifyRegime(ema(closes, 20), ema(closes, 50), closes.at(-1));
  if (btcTrend !== prev) log(`📡 BTC trend: ${prev} → ${btcTrend}`);
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
  const prev = qqqTrend;
  qqqTrend = classifyRegime(ema(closes, 20), ema(closes, 50), closes.at(-1));
  if (qqqTrend !== prev) log(`📡 QQQ trend: ${prev} → ${qqqTrend}`);
}

function buildMarketOpenMessage(market) {
  if (market === "CRYPTO") {
    return lines([
      "🟢🚀 <b>CRYPTO WINDOW OPEN</b>",
      "",
      "⏰ Scanning 06:00–22:00 UK time",
      `📡 BTC trend: <b>${escapeHtml(btcTrend.toUpperCase())}</b>`,
      `🔍 Pairs active: ${CRYPTO_PAIRS.length}`
    ]);
  }
  if (market === "US") {
    return lines([
      "🟢📈 <b>US MARKET OPEN</b>",
      "",
      "⏰ 14:30–21:00 UK time",
      `📡 QQQ trend: <b>${escapeHtml(qqqTrend.toUpperCase())}</b>`,
      `🔍 Stocks in pool: ${STOCK_POOL.length}`
    ]);
  }
  return lines([
    "🟢🏦 <b>LSE MARKET OPEN</b>",
    "",
    "⏰ 08:00–16:30 UK time",
    `🔍 Stocks in pool: ${LSE_POOL.length}`
  ]);
}

function buildMarketCloseMessage(market) {
  if (market === "CRYPTO") return lines(["🔴💤 <b>CRYPTO WINDOW CLOSED</b>", "", "😴 Scanning paused until 06:00 UK time"]);
  if (market === "US") return lines(["🔴📉 <b>US MARKET CLOSED</b>", "", "🏁 Session ended — see you at 14:30 UK tomorrow"]);
  return lines(["🔴🏦 <b>LSE MARKET CLOSED</b>", "", "🏁 Session ended — see you at 08:00 UK tomorrow"]);
}

async function checkMarketAlerts() {
  const checks = [
    { key: "CRYPTO", isOpen: isCryptoWindowOpen },
    { key: "US", isOpen: isUSMarketOpen },
    { key: "LSE", isOpen: isLSEMarketOpen }
  ];
  for (const { key, isOpen } of checks) {
    const nowOpen = isOpen();
    if (nowOpen && !marketWasOpen[key]) {
      await safeRun(`telegramOpen${key}`, async () => send(buildMarketOpenMessage(key)));
    }
    if (!nowOpen && marketWasOpen[key]) {
      await safeRun(`telegramClose${key}`, async () => send(buildMarketCloseMessage(key)));
    }
    marketWasOpen[key] = nowOpen;
  }
}

function getNarrativeBonus(asset) {
  let bonus = 0;
  const sym = asset.replace("USDT", "");
  for (const sector of HOT_SECTORS) {
    if ((SECTOR_SYMBOLS[sector] || []).includes(sym)) bonus += 6;
  }
  if (HOT_SECTORS.includes("AI") && CRYPTO_AI_NAMES.includes(asset)) bonus += 5;
  return bonus;
}

function gradeEmoji(g) {
  return g === "A*" ? "💎🔥" : g === "A" ? "🚀⚡" : "📈";
}

function setupEmoji(t) {
  if (t === "BREAKOUT_CONTINUATION") return "💥";
  if (t === "PULLBACK_CONTINUATION") return "🎯";
  if (t === "MOMENTUM_BREAKOUT") return "🔥";
  if (t === "MOMENTUM_IGNITION") return "⚡";
  return "📊";
}

function marketEmoji(m) {
  if (m === "CRYPTO") return "🪙";
  if (m === "US") return "🇺🇸";
  if (m === "LSE") return "🇬🇧";
  return "📊";
}

function analyse(asset, candles, market) {
  if (!candles || candles.length < MIN_CANDLES) return null;

  const closes = candles.map(x => x.close);
  const highs = candles.map(x => x.high);
  const lows = candles.map(x => x.low);
  const volumes = candles.map(x => x.volume || 0);

  const last = closes.at(-1);
  const prev = closes.at(-2);
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) return null;

  const momentum = (last - prev) / prev;
  if (momentum <= 0) return null;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema20Prev = ema(closes.slice(0, -1), 20);
  if (!(ema20 > ema50 && last > ema20 && ema20 > ema20Prev)) return null;

  const avgVol = avg(volumes.slice(-21, -1));
  const currentVol = volumes.at(-1);
  const volRatio = avgVol > 0 ? currentVol / avgVol : 0;

  const exceptionalCrypto =
    market === "CRYPTO" &&
    momentum >= REGIME_OVERRIDE_MIN_MOMENTUM &&
    volRatio >= REGIME_OVERRIDE_MIN_VOL;

  if (!regimePass(market) && !exceptionalCrypto) return null;

  if (exceptionalCrypto && !regimePass(market)) {
    log(`⚡ Regime override: ${asset} vol=${volRatio.toFixed(2)}x mom=${(momentum * 100).toFixed(2)}%`);
  }

  const extension = (last - ema20) / ema20;
  if (extension > extensionLimitForMarket(market)) return null;

  const breakoutLevel = Math.max(...highs.slice(-BREAKOUT_LOOKBACK, -1));
  const breakoutDistance = breakoutLevel > 0 ? (last - breakoutLevel) / breakoutLevel : 0;

  const recentRanges = highs.slice(-5, -1).map((h, i) => h - lows.slice(-5, -1)[i]).filter(Number.isFinite);
  const priorRanges = highs.slice(-10, -5).map((h, i) => h - lows.slice(-10, -5)[i]).filter(Number.isFinite);
  const expandingRange = avg(recentRanges) > 0 && avg(priorRanges) > 0 && avg(recentRanges) > avg(priorRanges) * 1.3;

  const ignitionSignal = momentum > 0.025 && volRatio > 2.0 && last > ema20 && expandingRange;
  const strongMomentumOverride =
    market === "US" &&
    STOCK_MOMENTUM_OVERRIDE_ENABLED &&
    momentum >= STOCK_OVERRIDE_MIN_MOMENTUM &&
    volRatio >= STOCK_OVERRIDE_MIN_VOL &&
    breakoutDistance <= STOCK_OVERRIDE_MAX_DISTANCE;

  const breakoutSignal =
    last > breakoutLevel &&
    breakoutDistance <= breakoutDistanceLimitForMarket(market) &&
    volRatio >= breakoutVolForMarket(market) &&
    momentum >= minMomentumForMarket(market);

  const nearEMAThreshold = market === "US" ? 0.02 : 0.025;
  const nearEMA20 = Math.abs(last - ema20) / ema20 <= nearEMAThreshold;
  const pulledBackRecently = closes.slice(-6, -1).some(c => c <= ema20 * 1.01);
  const pullbackSignal = nearEMA20 && pulledBackRecently && volRatio >= pullbackVolForMarket(market);

  if (!pullbackSignal && !breakoutSignal && !strongMomentumOverride && !ignitionSignal) return null;

  let setupType = "BREAKOUT_CONTINUATION";
  if (pullbackSignal && !breakoutSignal && !ignitionSignal) setupType = "PULLBACK_CONTINUATION";
  if (strongMomentumOverride && !ignitionSignal) setupType = "MOMENTUM_BREAKOUT";
  if (ignitionSignal) setupType = "MOMENTUM_IGNITION";

  if (setupType === "PULLBACK_CONTINUATION" && momentum < minPullbackMomentumForMarket(market)) return null;

  const momentumCap = setupType === "MOMENTUM_IGNITION" ? 0.20 : maxMomentumBarForMarket(market);
  if (momentum > momentumCap) return null;

  const entryType = setupType === "PULLBACK_CONTINUATION" ? "LIMIT BUY" : "MARKET BUY";
  const entry = setupType === "PULLBACK_CONTINUATION" ? ema20 * 1.002 : last;

  const atr = calculateATR(candles, ATR_PERIOD);
  if (!atr || atr <= 0) return null;

  const swingLow = Math.min(...lows.slice(-6));
  const atrMult =
    setupType === "PULLBACK_CONTINUATION" ? ATR_PULLBACK_MULTIPLIER
      : setupType === "MOMENTUM_IGNITION" ? ATR_IGNITION_MULTIPLIER
        : ATR_BREAKOUT_MULTIPLIER;

  const sl = Math.min(swingLow - atr * atrMult, entry - atr * atrMult);
  if (!Number.isFinite(sl) || sl >= entry) return null;

  const riskAmt = entry - sl;
  const riskPct = riskAmt / entry;
  if (riskPct <= 0 || riskPct > 0.12) return null;

  const tp = entry + riskAmt * TARGET_R;
  const rr = +((((tp - entry) / entry) / riskPct).toFixed(1));
  if (rr < MIN_RR) return null;

  let score = 50;
  if (volRatio > 1.2) score += 6;
  if (volRatio > 1.4) score += 6;
  if (volRatio > 1.6) score += 4;
  if (volRatio > 2.0) score += 5;
  if (volRatio > 3.0) score += 5;
  if (momentum > 0.025) score += 10;
  else if (momentum > 0.015) score += 8;
  else if (momentum > 0.008) score += 4;
  if (setupType === "BREAKOUT_CONTINUATION") score += 10;
  if (setupType === "PULLBACK_CONTINUATION") score += 8;
  if (setupType === "MOMENTUM_BREAKOUT") score += 14;
  if (setupType === "MOMENTUM_IGNITION") score += 18;
  if (market === "CRYPTO") score += 5;
  if (market === "US") score += 4;
  if (market === "LSE") score += 2;
  if (market === "CRYPTO" && btcTrend === "strong_bull") score += 5;
  if (market === "US" && qqqTrend === "bull") score += 3;
  if (market === "US" && qqqTrend === "strong_bull") score += 5;
  if (breakoutDistance > 0 && breakoutDistance <= 0.01) score += 4;
  if (expandingRange) score += 4;
  score += getNarrativeBonus(asset);

  let grade = "B";
  if (score >= 85) grade = "A*";
  else if (score >= 78) grade = "A";

  if (score >= MIN_GLOBAL_SCORE) {
    log(`✅ ${asset} ${market} ${setupType} score=${score} grade=${grade} vol=${volRatio.toFixed(2)}x mom=${(momentum * 100).toFixed(2)}%`);
  }

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
    regime: market === "CRYPTO" ? btcTrend : market === "US" ? qqqTrend : "LSE_LOCAL"
  };
}

function buildSignalLesson(signal) {
  const parts = ["📚 <b>TRADE LESSON</b>", ""];
  if (signal.setupType === "BREAKOUT_CONTINUATION") {
    parts.push("💥 <b>Breakout Continuation</b> — price pushed above a recent resistance level. We enter as it breaks out expecting momentum to carry it higher. Market buy gets you in immediately rather than waiting and missing the move.");
  } else if (signal.setupType === "PULLBACK_CONTINUATION") {
    parts.push("🎯 <b>Pullback Continuation</b> — price dipped back to its 20-period EMA (the trend’s centre line) and is bouncing. Lower-risk entry than a breakout — buying a dip within an uptrend rather than chasing a spike. The limit order targets that EMA level precisely.");
  } else if (signal.setupType === "MOMENTUM_BREAKOUT") {
    parts.push("🔥 <b>Momentum Breakout</b> — strong candle with high volume pushing through resistance. Volume confirms real buying pressure behind the move, not just noise.");
  } else if (signal.setupType === "MOMENTUM_IGNITION") {
    parts.push("⚡ <b>Momentum Ignition</b> — explosive early runner detected before full breakout confirmation. Volume is over 2x average, price is accelerating and the candle range is expanding. These can move very quickly. Higher risk, higher reward — size carefully.");
  }

  if (signal.volRatio >= 3.0) {
    parts.push(`
📊 <b>Volume ${signal.volRatio.toFixed(2)}x average</b> — exceptional. This level usually means institutional money is actively buying. That’s the kind of flow that drives sustained moves.`);
  } else if (signal.volRatio >= 2.0) {
    parts.push(`
📊 <b>Volume ${signal.volRatio.toFixed(2)}x average</b> — very strong. Double the norm confirms real conviction behind this move.`);
  } else {
    parts.push(`
📊 <b>Volume ${signal.volRatio.toFixed(2)}x average</b> — above normal. Confirms the move has buyers behind it.`);
  }

  if (signal.market === "CRYPTO") {
    if (signal.asset === "BTCUSDT") {
      parts.push("
🪙 <b>BTC note</b> — Bitcoin moves in smaller percentages than altcoins. Watch percentages rather than dollar amounts.");
    } else {
      parts.push(`
🪙 <b>Altcoin note</b> — ${signal.asset.replace("USDT", "")} can move 5-15% in a session when BTC is bullish (BTC trend: ${btcTrend.replace("_", " ")}). Altcoins amplify BTC moves.`);
    }
  } else if (signal.market === "US") {
    parts.push(`
🇺🇸 <b>US note</b> — QQQ trend (tech market health gauge) is <b>${qqqTrend.replace("_", " ")}</b>. A strong QQQ reading means the wind is behind individual breakouts.`);
  } else {
    parts.push("
🇬🇧 <b>LSE note</b> — London stocks move more slowly than US or crypto. Expect this to develop over hours rather than minutes.");
  }

  if (HOT_SECTORS.length > 0) {
    const matched = HOT_SECTORS.filter(s => (SECTOR_SYMBOLS[s] || []).includes(signal.asset.replace("USDT", "")));
    if (matched.length > 0) {
      parts.push(`
🧠 <b>Narrative aligned: ${matched.join(", ")}</b> — institutional money is flowing into this sector right now. Narrative-aligned trades often have stronger follow-through because multiple buyers are piling in for the same reason.`);
    }
  }

  if (signal.grade === "A*") {
    parts.push("
⭐ <b>A* grade</b> — highest rating the system gives. All conditions aligned: trend, volume, momentum, setup quality. Pay close attention to these.");
  } else if (signal.grade === "A") {
    parts.push("
⭐ <b>A grade</b> — strong signal. Most conditions met. Well above the minimum threshold.");
  }

  parts.push(`
⚡ <b>Momentum: ${(signal.momentum * 100).toFixed(2)}%</b> — how much the last hourly candle moved.`);
  parts.push(`🛡️ <b>Risk per unit</b> — the distance between entry and stop defines your risk. Wider stops reduce size; tighter stops increase size.`);
  parts.push(`🎯 <b>Target</b> — this setup is aiming for approximately ${signal.rr}R, meaning reward is about ${signal.rr} times the initial risk if target is reached.`);
  return lines(parts);
}

function buildCloseLesson(trade, reason) {
  const parts = ["🧠 <b>TRADE DEBRIEF</b>", ""];
  if (reason === "TAKE PROFIT") parts.push("💰 <b>Target hit</b> — the setup worked as planned and price reached the predefined objective. This is why we predefine exits before entering.");
  else if (reason === "STOP LOSS") parts.push("🛑 <b>Stop loss hit</b> — the setup failed. Small controlled losses are part of trend trading and protect the account from large damage.");
  else if (reason === "FORCE CLOSE") parts.push("⏱️ <b>Force close</b> — trade stayed open too long without making enough progress. Capital is better recycled into stronger setups.");
  else if (reason === "REPLACED") parts.push("🔄 <b>Replaced</b> — a materially stronger signal appeared in the same market. Reallocation can improve opportunity cost when the original trade is stalling.");
  else if (reason === "STRUCTURE_INVALID") parts.push("⚠️ <b>Structure invalidated</b> — the setup broke before becoming a proper trade. Cancelling invalid ideas preserves discipline.");
  else if (reason === "DRIFTED_TOO_FAR") parts.push("🌊 <b>Drifted too far</b> — price ran away from the planned pullback entry, so the original risk-reward no longer made sense.");
  else if (reason === "PENDING_EXPIRED") parts.push("⌛ <b>Pending expired</b> — the setup did not trigger in time. Good trades usually work within a reasonable window.");
  else parts.push("📌 <b>Trade review</b> — review whether the setup, timing, and market regime were aligned.");

  if (Number.isFinite(trade.realizedR)) {
    parts.push(`
📊 <b>Realized R:</b> ${trade.realizedR.toFixed(2)} — this measures outcome relative to the original risk, making results comparable across assets.`);
  }
  if (Number.isFinite(trade.maePct)) {
    parts.push(`📉 <b>MAE:</b> ${(trade.maePct * 100).toFixed(2)}% — maximum adverse excursion shows how much pain the trade took before exit.`);
  }
  if (Number.isFinite(trade.mfePct)) {
    parts.push(`📈 <b>MFE:</b> ${(trade.mfePct * 100).toFixed(2)}% — maximum favorable excursion shows how much unrealized profit the trade offered.`);
  }
  return lines(parts);
}

function buildSignalMessage(signal, size) {
  const isMarket = signal.entryType === "MARKET BUY";
  return lines([
    `🚨 ${gradeEmoji(signal.grade)} <b>${escapeHtml(signal.grade)} SIGNAL</b>`,
    "",
    `${marketEmoji(signal.market)} <b>${escapeHtml(signal.market)} | ${escapeHtml(signal.asset)}</b>`,
    `${setupEmoji(signal.setupType)} ${escapeHtml(signal.setupType)}`,
    "",
    isMarket ? `⚡ <b>MARKET BUY NOW</b> ~${escapeHtml(formatPrice(signal.entry, signal.market))}` : `💰 Limit Entry: ${escapeHtml(formatPrice(signal.entry, signal.market))}`,
    `🛡️ SL:    ${escapeHtml(formatPrice(signal.sl, signal.market))}`,
    `🎯 TP:    ${escapeHtml(formatPrice(signal.tp, signal.market))}`,
    `⚖️ R:R:   ${escapeHtml(String(signal.rr))}`,
    `⭐ Score: ${escapeHtml(String(signal.score))}`,
    `📊 Vol:   ${escapeHtml(signal.volRatio.toFixed(2))}x`,
    `📐 Size:  ${escapeHtml(size.toFixed(2))}`,
    "",
    buildSignalLesson(signal)
  ]);
}

function buildFillMessage(trade, price) {
  return lines([
    `✅🔥 <b>FILLED</b>`,
    "",
    `${marketEmoji(trade.market)} <b>${escapeHtml(trade.market)} | ${escapeHtml(trade.asset)}</b>`,
    `${setupEmoji(trade.setupType)} ${escapeHtml(trade.setupType)}`,
    "",
    `💵 Fill: ${escapeHtml(formatPrice(price, trade.market))}`,
    `🛡️ SL:   ${escapeHtml(formatPrice(trade.sl, trade.market))}`,
    `🎯 TP:   ${escapeHtml(formatPrice(trade.tp, trade.market))}`,
    `⭐ Score: ${escapeHtml(String(trade.score))}`
  ]);
}

function buildCloseMessage(trade, reason, closePrice) {
  const rVal = Number.isFinite(trade.realizedR) ? trade.realizedR.toFixed(2) : "n/a";
  const mae = Number.isFinite(trade.maePct) ? `${(trade.maePct * 100).toFixed(2)}%` : "n/a";
  const mfe = Number.isFinite(trade.mfePct) ? `${(trade.mfePct * 100).toFixed(2)}%` : "n/a";
  const reasonEmoji = {
    "TAKE PROFIT": "💰✅",
    "STOP LOSS": "🛑❌",
    "FORCE CLOSE": "⏱️🔚",
    "REPLACED": "🔄",
    "STRUCTURE_INVALID": "⚠️",
    "DRIFTED_TOO_FAR": "🌊",
    "PENDING_EXPIRED": "⌛"
  }[reason] || "📌";
  return lines([
    `${reasonEmoji} <b>${escapeHtml(reason)}</b>`,
    "",
    `${marketEmoji(trade.market)} <b>${escapeHtml(trade.market)} | ${escapeHtml(trade.asset)}</b>`,
    `${setupEmoji(trade.setupType)} ${escapeHtml(trade.setupType)}`,
    "",
    `💵 Close: ${escapeHtml(formatPrice(closePrice, trade.market))}`,
    `📊 R: ${escapeHtml(rVal)}`,
    `📉 MAE: ${escapeHtml(mae)}`,
    `📈 MFE: ${escapeHtml(mfe)}`,
    "",
    buildCloseLesson(trade, reason)
  ]);
}

function updateTradeExcursion(trade, livePrice) {
  if (!Number.isFinite(livePrice)) return;
  const adverse = Math.max(0, (trade.entry - livePrice) / trade.entry);
  const favorable = Math.max(0, (livePrice - trade.entry) / trade.entry);
  if (!Number.isFinite(trade.maePct) || adverse > trade.maePct) trade.maePct = adverse;
  if (!Number.isFinite(trade.mfePct) || favorable > trade.mfePct) trade.mfePct = favorable;
}

async function closeTrade(trades, trade, closePrice, reason) {
  trade.closePrice = closePrice;
  trade.closedAt = nowIso();
  trade.status = "CLOSED";
  trade.outcome = reason;
  const riskPerUnit = trade.entry - trade.sl;
  trade.realizedR = Number.isFinite(closePrice) && Number.isFinite(riskPerUnit) && riskPerUnit > 0
    ? (closePrice - trade.entry) / riskPerUnit
    : null;
  await safeRun(`telegramClose${trade.asset}`, async () => {
    await send(buildCloseMessage(trade, reason, closePrice));
  });
  await saveTrades(trades);
}

async function manageTrades() {
  const trades = await loadTrades();
  let changed = false;
  for (const trade of trades) {
    if (shuttingDown) break;
    const livePrice = await fetchLivePrice(trade.asset, trade.market);
    if (!Number.isFinite(livePrice)) continue;

    if (trade.status === "PENDING") {
      const expiryHours = pendingExpiryHours(trade.market);
      const ageHours = hoursAgo(trade.sentAt);
      const filled = trade.entryType === "MARKET BUY"
        ? true
        : trade.entryType === "LIMIT BUY"
          ? livePrice <= trade.entry * 1.002
          : livePrice >= trade.entry;
      const structureInvalid = livePrice <= trade.sl;
      const driftTooFar = trade.entryType === "LIMIT BUY" ? livePrice > trade.entry * 1.04 : false;

      if (filled) {
        trade.status = "FILLED";
        trade.outcome = "OPEN";
        trade.fillPrice = livePrice;
        trade.filledAt = nowIso();
        trade.maePct = 0;
        trade.mfePct = 0;
        changed = true;
        await safeRun(`telegramFill${trade.asset}`, async () => {
          await send(buildFillMessage(trade, livePrice));
        });
        continue;
      }
      if (structureInvalid) {
        trade.status = "CANCELLED";
        trade.outcome = "STRUCTURE_INVALID";
        trade.closedAt = nowIso();
        trade.closePrice = livePrice;
        changed = true;
        await safeRun(`telegramPendingInvalid${trade.asset}`, async () => {
          await send(buildCloseMessage(trade, "STRUCTURE_INVALID", livePrice));
        });
        continue;
      }
      if (driftTooFar) {
        trade.status = "CANCELLED";
        trade.outcome = "DRIFTED_TOO_FAR";
        trade.closedAt = nowIso();
        trade.closePrice = livePrice;
        changed = true;
        await safeRun(`telegramPendingDrift${trade.asset}`, async () => {
          await send(buildCloseMessage(trade, "DRIFTED_TOO_FAR", livePrice));
        });
        continue;
      }
      if (ageHours > expiryHours) {
        trade.status = "CANCELLED";
        trade.outcome = "PENDING_EXPIRED";
        trade.closedAt = nowIso();
        trade.closePrice = livePrice;
        changed = true;
        await safeRun(`telegramPendingExpired${trade.asset}`, async () => {
          await send(buildCloseMessage(trade, "PENDING_EXPIRED", livePrice));
        });
        continue;
      }
    }

    if (trade.status === "FILLED" && trade.outcome === "OPEN") {
      updateTradeExcursion(trade, livePrice);
      changed = true;
      if (livePrice <= trade.sl) {
        await closeTrade(trades, trade, livePrice, "STOP LOSS");
        continue;
      }
      if (livePrice >= trade.tp) {
        await closeTrade(trades, trade, livePrice, "TAKE PROFIT");
        continue;
      }
      if (shouldForceClose(trade, livePrice)) {
        await closeTrade(trades, trade, livePrice, "FORCE CLOSE");
        continue;
      }
    }
  }
  if (changed) await saveTrades(trades);
}

async function scan() {
  const alerts = await loadAlerts();
  const trades = await loadTrades();
  const results = [];

  async function processAsset(asset, market, fetcher) {
    if (cooldown(asset, alerts, market)) return;
    if (trades.some(t => t.asset === asset && (t.status === "PENDING" || (t.status === "FILLED" && t.outcome === "OPEN")))) return;
    const candles = await fetcher(asset);
    const signal = analyse(asset, candles, market);
    if (!signal) return;
    if (signal.score < MIN_GLOBAL_SCORE) return;
    if (signal.score < minScoreForMarket(signal.market)) return;
    results.push(signal);
  }

  if (ENABLE_CRYPTO && isCryptoWindowOpen()) {
    await mapWithConcurrency(CRYPTO_PAIRS, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset, "CRYPTO", fetchCrypto));
  }
  if (ENABLE_US && isUSMarketOpen()) {
    await mapWithConcurrency(STOCK_POOL, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset, "US", fetchUSData));
  }
  if (ENABLE_LSE && isLSEMarketOpen()) {
    await mapWithConcurrency(LSE_POOL, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset, "LSE", fetchLSEData));
  }

  return pickBestPerMarket(results);
}

async function processSignals(signals) {
  const alerts = await loadAlerts();
  const trades = await loadTrades();

  for (const signal of signals) {
    if (signal.score < MIN_GLOBAL_SCORE) continue;
    if (signal.score < minScoreForMarket(signal.market)) continue;

    const existingOpenTrade = getOpenTradeInMarket(trades, signal.market);
    if (existingOpenTrade) {
      const livePrice = await fetchLivePrice(existingOpenTrade.asset, existingOpenTrade.market);
      if (shouldReplaceTrade(signal, existingOpenTrade, livePrice)) {
        await closeTrade(
          trades,
          existingOpenTrade,
          Number.isFinite(livePrice) ? livePrice : existingOpenTrade.entry,
          "REPLACED"
        );
      } else {
        continue;
      }
    }

    if (countOpenTradesByMarket(trades, signal.market) >= MAX_POSITIONS[signal.market]) continue;
    if (countPendingTradesByMarket(trades, signal.market) >= 1) continue;

    const riskFraction = getRiskFractionForSignal(signal);
    const openRisk = getOpenRiskFraction(trades);
    if (openRisk + riskFraction > MAX_PORTFOLIO_RISK) continue;

    const size = calculatePositionSize(signal);
    if (!Number.isFinite(size) || size <= 0) continue;

    const sentAt = nowIso();
    const alertId = `${signal.asset}-${signal.market}-${Math.floor(new Date(sentAt).getTime() / 60000)}`;
    if (alerts.some(a => a.id === alertId)) continue;

    await safeRun(`telegramSignal${signal.asset}`, async () => {
      await send(buildSignalMessage(signal, size));
    });

    alerts.push({
      id: alertId,
      asset: signal.asset,
      market: signal.market,
      sentAt
    });

    trades.push({
      id: `${signal.asset}-${Date.now()}`,
      asset: signal.asset,
      market: signal.market,
      setupType: signal.setupType,
      entryType: signal.entryType,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      rrPlanned: signal.rr,
      score: signal.score,
      volRatio: signal.volRatio,
      momentum: signal.momentum,
      regime: signal.regime,
      sentAt,
      status: "PENDING",
      outcome: "OPEN",
      fillPrice: null,
      closePrice: null,
      closedAt: null,
      filledAt: null,
      maePct: 0,
      mfePct: 0,
      realizedR: null,
      riskFraction
    });
  }

  await saveAlerts(alerts);
  await saveTrades(trades);
}

async function safeCycle() {
  if (running || shuttingDown) return;
  running = true;
  try {
    resetApiUsageIfNewDay();
    await safeRun("updateBTCTrend", updateBTCTrend);
    await safeRun("updateQQQTrend", updateQQQTrend);
    await safeRun("checkMarketAlerts", checkMarketAlerts);
    await safeRun("manageTrades", manageTrades);
    const signals = await withTimeout(safeRun("scan", scan), SCAN_TIMEOUT_MS, "scan cycle");
    if (Array.isArray(signals) && signals.length > 0) {
      await safeRun("processSignals", () => processSignals(signals));
    } else {
      log("NO VALID SIGNALS THIS CYCLE");
    }
  } catch (err) {
    log("MAIN LOOP FAILURE:", err && err.message ? err.message : err);
  } finally {
    running = false;
  }
}

async function cycleLoop() {
  if (shuttingDown) return;
  const started = Date.now();
  await safeCycle();
  const elapsed = Date.now() - started;
  const wait = elapsed >= SCAN_INTERVAL_MS ? 1000 : SCAN_INTERVAL_MS - elapsed;
  cycleTimer = setTimeout(() => {
    void cycleLoop();
  }, wait);
}

async function refreshLoop() {
  if (shuttingDown) return;
  await safeRun("refreshDynamicPools", refreshDynamicPools);
  refreshTimer = setTimeout(() => {
    void refreshLoop();
  }, POOL_REFRESH_INTERVAL_MS);
}

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  clearRuntimeTimers();
  log(`🛑 ${signal} RECEIVED`);
  try {
    await safeRun("saveTradesOnShutdown", async () => {
      const trades = await loadTrades();
      await saveTrades(trades);
    });
    await safeRun("saveAlertsOnShutdown", async () => {
      const alerts = await loadAlerts();
      await saveAlerts(alerts);
    });
    log("💾 STATE SAVED");
  } catch (err) {
    log("SHUTDOWN ERROR:", err && err.message ? err.message : err);
  }

  if (server) {
    await new Promise(resolve => {
      server.close(() => resolve());
      setTimeout(resolve, 2000);
    });
  }

  setTimeout(() => process.exit(signal === "UNCAUGHT_EXCEPTION" ? 1 : 0), SHUTDOWN_EXIT_MS);
}

process.on("unhandledRejection", reason => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", async err => {
  console.error("UNCAUGHT EXCEPTION:", err);
  if (fatalTriggered) return;
  fatalTriggered = true;
  await gracefulShutdown("UNCAUGHT_EXCEPTION");
});

process.on("warning", warning => {
  console.warn("NODE WARNING:", warning);
});

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

app.get("/", (_req, res) => {
  res.status(200).send("SNIPER V87 alive");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime(), running, ready, shuttingDown });
});

app.get("/ready", (_req, res) => {
  if (ready && !shuttingDown) return res.status(200).send("ready");
  return res.status(503).send("not ready");
});

async function startup() {
  log("🚀 SNIPER V87 STARTING");
  ensureFiles();
  await sleep(STARTUP_DELAY_MS);
  await safeRun("initialPoolRefresh", refreshDynamicPools);
  ready = true;
  await safeRun("initialCycle", safeCycle);
  cacheCleanupTimer = setInterval(cleanupCandleCache, CACHE_CLEANUP_MS);
  void cycleLoop();
  void refreshLoop();
  log("✅ SNIPER V87 READY");
}

server = app.listen(PORT, "0.0.0.0", async () => {
  log(`🚀 SERVER ONLINE PORT ${PORT}`);
  await safeRun("startupTelegram", async () => {
    await send(
      "🚀🔥 SNIPER V87 LIVE
" +
      "Stable runtime active
" +
      "Non-overlapping scan engine
" +
      "Graceful shutdown enabled
" +
      "Yahoo fallback active
" +
      "API rotation active"
    );
  });
  await startup();
});
