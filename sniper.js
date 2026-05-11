// ================================================================
// SNIPER V88 — DEFINITIVE MERGE
// ----------------------------------------------------------------
// Foundation : V87 stable engine
//   graceful shutdown, safeRun, withTimeout, cycleLoop,
//   Finnhub rate-limit blocking, /ready endpoint, refreshingPools guard
// From user's independent build:
//   ✦ Intl.DateTimeFormat BST-accurate UK time (handles clock changes)
//   ✦ Named shouldScan/shouldSend gate functions for clarity
// New in V88:
//   ✦ Crypto scans 15-min candles — catches moves as they happen
//   ✦ Expanded pool: 20 core crypto coins
//   ✦ 24-hr momentum awareness — 5/10/20% day boosts score
//   ✦ Weekend mode — crypto only, no stock noise
//   ✦ Momentum watch — heating up alerts before entry signals
//       Crypto ≥5% / Stocks ≥3% | max once per asset per 2 hrs
//   ✦ Narrative alert change-detection — fires only when something
//       actually changes, suppressed outside stock hours + weekends
//   ✦ Crypto movers in narrative alert with % + momentum tag
//   ✦ Regime override: 1.2% candle + 1.8× vol on 15-min
//   ✦ Rejection logging — logs WHY each signal fails
// ================================================================

console.log("🚀 SNIPER V88 STARTING...");

const fs    = require("fs");
const path  = require("path");
const axios = require("axios");
const express = require("express");
const ws    = require("ws");
const { createClient } = require("@supabase/supabase-js");

axios.defaults.timeout = 15000;

const app  = express();
const PORT = process.env.PORT || 3000;

app.get("/",       (_req, res) => res.status(200).send("SNIPER V88 alive"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime(), running, ready, shuttingDown }));
app.get("/ready",  (_req, res) => (ready && !shuttingDown) ? res.status(200).send("ready") : res.status(503).send("not ready"));

// ── Environment ──────────────────────────────────────────────────
const BOT_TOKEN             = process.env.BOT_TOKEN             || "";
const CHAT_ID               = process.env.CHAT_ID               || "";
const TWELVE_DATA_API_KEY   = process.env.TWELVE_DATA_API_KEY   || "";
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY || "";
const FINNHUB_API_KEY       = process.env.FINNHUB_API_KEY       || "";
const COINGECKO_API_KEY     = process.env.COINGECKO_API_KEY     || "";
const SUPABASE_URL          = process.env.SUPABASE_URL          || "";
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY  || "";

const supabaseEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { realtime: { transport: ws } })
  : null;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILES    = {
  alerts: path.join(DATA_DIR, "alerts.json"),
  trades: path.join(DATA_DIR, "trades.json")
};

// ── Core constants ───────────────────────────────────────────────
const ACCOUNT_BALANCE     = 10000;
const BASE_RISK_PER_TRADE = 0.01;
const MAX_PORTFOLIO_RISK  = 0.05;

const ENABLE_CRYPTO = true;
const ENABLE_US     = true;
const ENABLE_LSE    = true;

const SCAN_INTERVAL_MS         = 300000;
const POOL_REFRESH_INTERVAL_MS = 3600000;
const MAX_CONCURRENT_REQUESTS  = 3;
const STARTUP_DELAY_MS         = 5000;
const REQUEST_DELAY_MS         = 250;
const SCAN_TIMEOUT_MS          = 240000;
const SHUTDOWN_EXIT_MS         = 5000;
const CACHE_TTL_MS             = 4 * 60 * 1000;
const CACHE_CLEANUP_MS         = 10 * 60 * 1000;

const CRYPTO_COOLDOWN = 2;
const US_COOLDOWN     = 4;
const LSE_COOLDOWN    = 6;

const BREAKOUT_LOOKBACK = 10;

// ── V88: 15-min crypto thresholds ───────────────────────────────
const CRYPTO_15M_MIN_MOMENTUM   = 0.008;  // 0.8% per 15-min candle
const CRYPTO_15M_BREAKOUT_VOL   = 1.60;
const CRYPTO_15M_PULLBACK_VOL   = 1.20;
const CRYPTO_15M_MAX_MOMENTUM   = 0.06;   // cap at 6% — if bigger, already extended
const CRYPTO_15M_EXTENSION_LIMIT = 0.08;
const CRYPTO_15M_BREAKOUT_DIST  = 0.03;
const CRYPTO_15M_MIN_PULLBACK   = 0.005;
const CRYPTO_PENDING_EXPIRY_HRS = 2;      // moves fast on 15-min

// ── US/LSE stock thresholds (1-hr unchanged) ─────────────────────
const US_BREAKOUT_VOL           = 1.40;
const US_PULLBACK_VOL           = 1.20;
const LSE_BREAKOUT_VOL          = 1.25;
const LSE_PULLBACK_VOL          = 1.10;
const BREAKOUT_MAX_DISTANCE_US  = 0.04;
const BREAKOUT_MAX_DISTANCE_LSE = 0.04;
const EXTENSION_HARD_LIMIT_US   = 0.10;
const EXTENSION_HARD_LIMIT_LSE  = 0.08;
const MAX_MOMENTUM_BAR_US       = 0.08;
const MAX_MOMENTUM_BAR_LSE      = 0.04;
const MIN_US_MOMENTUM           = 0.015;
const MIN_LSE_MOMENTUM          = 0.008;
const MIN_PULLBACK_MOMENTUM_US  = 0.015;
const MIN_PULLBACK_MOMENTUM_LSE = 0.008;

const STOCK_MOMENTUM_OVERRIDE_ENABLED = true;
const STOCK_OVERRIDE_MIN_MOMENTUM     = 0.015;
const STOCK_OVERRIDE_MIN_VOL          = 1.40;
const STOCK_OVERRIDE_MAX_DISTANCE     = 0.025;

const MIN_RR   = 1.5;
const TARGET_R = 1.5;

const MIN_GLOBAL_SCORE = 78;
const MIN_CRYPTO_SCORE = 78;
const MIN_US_SCORE     = 80;
const MIN_LSE_SCORE    = 76;

const PENDING_EXPIRY_HOURS_US  = 12;
const PENDING_EXPIRY_HOURS_LSE = 24;

const MIN_CANDLES             = 60;
const ATR_PERIOD              = 14;
const ATR_PULLBACK_MULTIPLIER = 1.2;
const ATR_BREAKOUT_MULTIPLIER = 1.5;
const ATR_IGNITION_MULTIPLIER = 1.8;

const REPLACEMENT_SCORE_GAP           = 6;
const REPLACEMENT_STALE_HOURS         = 3;
const REPLACEMENT_STALL_PROGRESS      = 0.3;
const REPLACEMENT_PROTECT_TP_PROGRESS = 0.7;

const FORCE_CLOSE_HOURS    = 4;
const FORCE_CLOSE_PROGRESS = 0.2;

const MAX_POSITIONS = { CRYPTO: 1, US: 1, LSE: 1 };

// ── API rotation ─────────────────────────────────────────────────
const API_LIMITS = { twelvedata: 700, alphavantage: 20 };
let apiUsage     = { twelvedata: 0, alphavantage: 0, resetDay: -1 };
let apiRotateIdx = 0;
let finnhubBlockedUntil = 0;

// ── Regime override (V88: lower thresholds for 15-min) ───────────
const REGIME_OVERRIDE_MIN_VOL      = 1.8;
const REGIME_OVERRIDE_MIN_MOMENTUM = 0.012; // 1.2% on 15-min candle

// ── 24hr momentum boost ──────────────────────────────────────────
const crypto24hrCache = new Map();
const CRYPTO_24HR_TTL = 15 * 60 * 1000;

// ── Momentum watch ───────────────────────────────────────────────
const MOMENTUM_WATCH_CRYPTO_THRESHOLD = 5;   // 5%+ 24hr
const MOMENTUM_WATCH_STOCK_THRESHOLD  = 3;   // 3%+ today
const MOMENTUM_WATCH_COOLDOWN_MS      = 2 * 60 * 60 * 1000;
const momentumWatchSent               = new Map();

// ── Narrative change detection ───────────────────────────────────
let lastNarrativeState = { sectors: "", stockMovers: "", cryptoMovers: "" };

// ── Sector / narrative maps ──────────────────────────────────────
const SECTOR_SYMBOLS = {
  AI:       ["NVDA","PLTR","AMD","SMCI","MSFT","META","GOOGL","IONQ","CRWD","ANET"],
  GOLD:     ["NEM","GOLD","AEM","WPM","KGC","SIL"],
  SILVER:   ["SIL","WPM","PAAS","AG"],
  CRYPTO:   ["COIN","MSTR","RIOT","CLSK"],
  ENERGY:   ["XOM","CVX","SLB","HAL","MPC"],
  DEFENSE:  ["LMT","RTX","NOC","GD","AVAV"],
  ROBOTICS: ["ROK","ISRG","TER"],
  NUCLEAR:  ["CCJ","NNE","SMR","UUUU","DNN","OKLO"]
};

const NARRATIVE_KEYWORDS = {
  AI:       ["artificial intelligence","ai chip","machine learning","llm","gpu","nvidia","generative ai","openai","chatgpt"],
  GOLD:     ["gold price","gold rally","bullion","precious metals","safe haven"],
  SILVER:   ["silver price","silver rally","industrial metals"],
  CRYPTO:   ["bitcoin","ethereum","crypto rally","btc","eth","digital assets","blockchain","crypto surge"],
  ENERGY:   ["oil price","crude","energy rally","opec","natural gas"],
  DEFENSE:  ["defense spending","military","nato","geopolitical","weapons","pentagon","war"],
  ROBOTICS: ["robotics","automation","humanoid","manufacturing robot"],
  NUCLEAR:  ["nuclear energy","uranium","small modular reactor","smr","nuclear power"]
};

const CRYPTO_AI_NAMES = ["RENDERUSDT","FETUSDT","NEARUSDT","TAOUSDT","AGIXUSDT","OCEANUSDT","AKTUSDT"];

// ── V88: Expanded static crypto pool — 20 core coins ────────────
const STATIC_CRYPTO_FALLBACK = [
  "BTCUSDT",    // Bitcoin — market leader
  "ETHUSDT",    // Ethereum — base layer
  "SOLUSDT",    // Solana — high-perf L1
  "BNBUSDT",    // BNB — exchange momentum
  "AVAXUSDT",   // Avalanche — L1
  "LINKUSDT",   // Chainlink — oracle
  "NEARUSDT",   // NEAR — AI blockchain
  "RENDERUSDT", // Render — AI/GPU compute
  "SUIUSDT",    // Sui — fast L1
  "TONUSDT",    // Toncoin — Telegram ecosystem
  "ONDOUSDT",   // Ondo — RWA leader
  "ARBUSDT",    // Arbitrum — L2
  "OPUSDT",     // Optimism — L2
  "INJUSDT",    // Injective — DeFi L1
  "TIAUSDT",    // Celestia — modular
  "STRKUSDT",   // Starknet — ZK L2
  "JUPUSDT",    // Jupiter — Solana DEX
  "FETUSDT",    // Fetch.ai — AI agent
  "AKTUSDT",    // Akash — decentralised compute
  "EIGENUSDT"   // EigenLayer — restaking
];

const STATIC_STOCK_FALLBACK = [
  "NVDA","PLTR","AMD","ASTS","IONQ","MSFT","META",
  "AMZN","APP","MSTR","COIN","QQQ","SMH","AVGO",
  "VRT","CRWD","AMAT","GEV","AVAV","OKLO","RKLB",
  "LUNR","ETN","ANET"
];

const LSE_POOL = ["RR.LON","BA.LON","SHEL.LON","LSEG.LON","BARC.LON"];

const CLEAN_TICKER = /^[A-Z]{1,5}$/;
const OTC_SUFFIXES = ["F","Y","PK"];

let STOCK_POOL   = [...new Set(STATIC_STOCK_FALLBACK)];
let CRYPTO_PAIRS = [...STATIC_CRYPTO_FALLBACK];
let HOT_SECTORS  = [];

// ── Runtime state ────────────────────────────────────────────────
let running         = false;
let refreshingPools = false;
let shuttingDown    = false;
let ready           = false;
let fatalTriggered  = false;
let btcTrend        = "neutral";
let qqqTrend        = "neutral";
let marketWasOpen   = { CRYPTO: false, US: false, LSE: false };

const candleCache     = new Map();
let cacheCleanupTimer = null;
let cycleTimer        = null;
let refreshTimer      = null;
let server            = null;

// ── Utilities ────────────────────────────────────────────────────
function nowIso()         { return new Date().toISOString(); }
function log(...args)     { console.log(`[${nowIso()}]`, ...args); }
function sleep(ms)        { return new Promise(r => setTimeout(r, ms)); }
async function throttle() { await sleep(REQUEST_DELAY_MS); }
function dedup(arr)       { return [...new Set(arr.filter(Boolean))]; }
function avg(arr)         { return arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0; }

// ── UK time helpers (BST-accurate via Intl) ──────────────────────
// Uses Europe/London so BST/GMT transitions are handled automatically
// No more "an hour off" when clocks change in October
function getUkNowParts() {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone:  "Europe/London",
    weekday:   "short",
    hour:      "2-digit",
    minute:    "2-digit",
    hour12:    false
  });
  const parts = formatter.formatToParts(new Date());
  const map   = {};
  for (const p of parts) { if (p.type !== "literal") map[p.type] = p.value; }
  return map;
}

function getUkDayIndex() {
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[getUkNowParts().weekday] ?? 0;
}

function getUkMinutes() {
  const { hour, minute } = getUkNowParts();
  return Number(hour) * 60 + Number(minute);
}

function isWeekend()   { const d = getUkDayIndex(); return d === 0 || d === 6; }
function isWeekday()   { return !isWeekend(); }

// ── Named scan / alert gate functions (cleaner than raw booleans) ─
function shouldScanCrypto()             { return ENABLE_CRYPTO && isCryptoWindowOpen(); }
function shouldScanUS()                 { return ENABLE_US && isWeekday() && isUSMarketOpen(); }
function shouldScanLSE()                { return ENABLE_LSE && isWeekday() && isLSEMarketOpen(); }
function shouldSendStockAlerts()        { return isWeekday() && (isUSMarketOpen() || isLSEMarketOpen()); }
function shouldSendCryptoAlerts()       { return isCryptoWindowOpen(); }

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
  if (market === "LSE") return `\u00a3${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function escapeHtml(v) {
  return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function lines(parts) { return parts.join("\n"); }

function ensureFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of Object.values(FILES)) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[]");
  }
}

function loadLocal(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function saveLocal(file, data) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

async function retry(fn, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) { if (i === retries) throw e; await sleep(delay * Math.pow(2, i)); }
  }
}

async function withTimeout(promise, ms, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
  });
  try { return await Promise.race([promise, timer]); }
  finally { clearTimeout(timeout); }
}

async function safeRun(name, fn) {
  try { return await fn(); }
  catch (err) { log(`SAFE RUN ERROR (${name}):`, err?.message || err); return null; }
}

function getCached(key) {
  const entry = candleCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { candleCache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) { candleCache.set(key, { ts: Date.now(), data }); }

function cleanupCandleCache() {
  const now = Date.now();
  for (const [key, value] of candleCache.entries()) {
    if (!value?.ts || now - value.ts > CACHE_TTL_MS) candleCache.delete(key);
  }
}

function clearRuntimeTimers() {
  if (cycleTimer)        { clearTimeout(cycleTimer);         cycleTimer        = null; }
  if (refreshTimer)      { clearTimeout(refreshTimer);       refreshTimer      = null; }
  if (cacheCleanupTimer) { clearInterval(cacheCleanupTimer); cacheCleanupTimer = null; }
}

function isCleanTicker(sym) {
  if (!CLEAN_TICKER.test(sym)) return false;
  if (sym.length === 5 && OTC_SUFFIXES.some(s => sym.endsWith(s))) return false;
  return true;
}

// ── API management ───────────────────────────────────────────────
function resetApiUsageIfNewDay() {
  const day = new Date().getUTCDate();
  if (apiUsage.resetDay !== day) {
    apiUsage = { twelvedata: 0, alphavantage: 0, resetDay: day };
    apiRotateIdx = 0;
    log("🔄 API usage counters reset");
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

function canUseFinnhub() { return !!FINNHUB_API_KEY && Date.now() > finnhubBlockedUntil; }

function blockFinnhub(minutes = 30) {
  finnhubBlockedUntil = Date.now() + minutes * 60 * 1000;
  log(`\u26a0\ufe0f Finnhub blocked ${minutes} mins`);
}

async function safeRequest(fn, label = "request") {
  try {
    await throttle();
    return await fn();
  } catch (e) {
    const msg = e?.message || "Unknown";
    if ((msg.includes("429") || e?.response?.status === 429) && label.toLowerCase().includes("finnhub")) blockFinnhub();
    log(`\u26a0\ufe0f ${label} failed: ${msg}`);
    return null;
  }
}

// ── Supabase / persistence ───────────────────────────────────────
async function loadAlerts() {
  if (!supabaseEnabled) return loadLocal(FILES.alerts, []);
  try {
    const { data, error } = await retry(() =>
      supabase.from("alerts").select("*").order("sentAt", { ascending: false }).limit(1000)
    );
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  } catch { return loadLocal(FILES.alerts, []); }
}

async function loadTrades() {
  if (!supabaseEnabled) return loadLocal(FILES.trades, []);
  try {
    const { data, error } = await retry(() =>
      supabase.from("trades").select("*").order("sentAt", { ascending: false }).limit(1000)
    );
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  } catch { return loadLocal(FILES.trades, []); }
}

async function saveAlerts(alerts) {
  const b = Array.isArray(alerts) ? alerts.slice(-1000) : [];
  if (!supabaseEnabled) { saveLocal(FILES.alerts, b); return; }
  try {
    const { error } = await retry(() => supabase.from("alerts").upsert(b, { onConflict: "id" }));
    if (error) throw error;
    saveLocal(FILES.alerts, b);
  } catch { saveLocal(FILES.alerts, b); }
}

async function saveTrades(trades) {
  const b = Array.isArray(trades) ? trades.slice(-1000) : [];
  if (!supabaseEnabled) { saveLocal(FILES.trades, b); return; }
  try {
    const { error } = await retry(() => supabase.from("trades").upsert(b, { onConflict: "id" }));
    if (error) throw error;
    saveLocal(FILES.trades, b);
  } catch { saveLocal(FILES.trades, b); }
}

// ── Telegram ─────────────────────────────────────────────────────
async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) { log(msg); return; }
  try {
    await retry(() => axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID, text: msg, parse_mode: "HTML"
    }, { timeout: 10000 }));
  } catch (e) { log("TELEGRAM ERROR:", e.message); }
}

// ── Market time helpers ──────────────────────────────────────────
function isMarketOpen(market) {
  const mins = getUkMinutes(); // BST-accurate UK local time
  if (market === "CRYPTO") return mins >= 360 && mins < 1320;  // 06:00–22:00 UK
  if (isWeekend()) return false;
  if (market === "US")  return mins >= 870 && mins < 1260;     // 14:30–21:00 UK
  if (market === "LSE") return mins >= 480 && mins < 990;      // 08:00–16:30 UK
  return false;
}

function isCryptoWindowOpen() { return isMarketOpen("CRYPTO"); }
function isUSMarketOpen()     { return isMarketOpen("US"); }
function isLSEMarketOpen()    { return isMarketOpen("LSE"); }
function isUSOpeningWindow()  {
  if (isWeekend()) return false;
  const m = getUkMinutes();
  return m >= 870 && m < 960; // 14:30–16:00 UK
}

// alertable: weekday stock hours or crypto window
function isAlertableHours(market = "ALL") {
  if (market === "CRYPTO") return isCryptoWindowOpen();
  if (isWeekend()) return false;
  const m = getUkMinutes();
  return m >= 480 && m < 1260; // 08:00–21:00 UK weekdays
}

// ── Regime classification ────────────────────────────────────────
function classifyRegime(ema20Val, ema50Val, price) {
  if (!Number.isFinite(ema20Val) || !Number.isFinite(ema50Val) || !Number.isFinite(price) || ema50Val === 0) return "neutral";
  const spread = (ema20Val - ema50Val) / ema50Val;
  if (ema20Val > ema50Val && price > ema20Val) return spread >= 0.02 ? "strong_bull" : "bull";
  if (spread <= -0.02) return "risk_off";
  return "neutral";
}

function regimePass(market) {
  if (market === "CRYPTO") return btcTrend === "bull" || btcTrend === "strong_bull";
  if (market === "US")     return qqqTrend !== "risk_off";
  return true;
}

function minScoreForMarket(market) {
  if (market === "CRYPTO") return btcTrend === "strong_bull" ? 76 : MIN_CRYPTO_SCORE;
  if (market === "LSE")    return MIN_LSE_SCORE;
  return MIN_US_SCORE;
}

function calculateATR(candles, period = ATR_PERIOD) {
  if (!candles || candles.length < period + 1) return null;
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i], prevClose = candles[i-1].close;
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

// ── Dynamic crypto injection ─────────────────────────────────────
// Assets moving 5%+ on 24hr get injected into CRYPTO_PAIRS
// for active scanning. Dropped after 2 hours if no signal fires.
const DYNAMIC_INJECTION_THRESHOLD = 5;    // 5%+ 24hr triggers injection
const DYNAMIC_INJECTION_TTL_MS    = 2 * 60 * 60 * 1000; // 2 hours
const dynamicInjections = new Map(); // symbol -> injectedAt timestamp

async function injectHotCryptoMovers() {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/ticker/24hr", { timeout: 12000 })
    );
    if (!Array.isArray(data)) return;

    const now = Date.now();

    // Remove expired injections
    for (const [sym, ts] of dynamicInjections.entries()) {
      if (now - ts > DYNAMIC_INJECTION_TTL_MS) {
        dynamicInjections.delete(sym);
        // Remove from pool if not in static fallback
        if (!STATIC_CRYPTO_FALLBACK.includes(sym)) {
          CRYPTO_PAIRS = CRYPTO_PAIRS.filter(p => p !== sym);
          log(`🗑️ Removed expired injection: ${sym}`);
        }
      }
    }

    // Find hot movers not already in pool
    const hot = data
      .filter(t =>
        t.symbol.endsWith("USDT") &&
        +t.priceChangePercent >= DYNAMIC_INJECTION_THRESHOLD &&
        !CRYPTO_PAIRS.includes(t.symbol) &&
        +t.quoteVolume > 500000 // minimum $500k 24hr volume — filters micro caps
      )
      .sort((a, b) => +b.priceChangePercent - +a.priceChangePercent)
      .slice(0, 5); // max 5 injections at once

    for (const t of hot) {
      CRYPTO_PAIRS = dedup([...CRYPTO_PAIRS, t.symbol]).slice(0, 30);
      dynamicInjections.set(t.symbol, now);
      log(`💉 Dynamic injection: ${t.symbol} +${(+t.priceChangePercent).toFixed(1)}% vol=$${(+t.quoteVolume/1e6).toFixed(1)}M`);
      await send(
        `\uD83D\uDC89 <b>${t.symbol.replace("USDT","")} INJECTED INTO SCAN</b>\n` +
        `\uD83D\uDCC8 24hr: <b>+${(+t.priceChangePercent).toFixed(1)}%</b>\n` +
        `\uD83D\uDCA1 Now scanning on 15-min candles \u2014 entry alert fires if breakout confirmed`
      );
    }

  } catch (e) { log("Dynamic injection failed:", e.message); }
}
async function refresh24hrMomentum() {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/ticker/24hr", { timeout: 12000 })
    );
    if (!Array.isArray(data)) return;
    for (const t of data) {
      if (CRYPTO_PAIRS.includes(t.symbol)) {
        crypto24hrCache.set(t.symbol, { pct: +t.priceChangePercent / 100, ts: Date.now() });
      }
    }
    log(`📊 24hr momentum cached for ${crypto24hrCache.size} pairs`);
  } catch (e) { log("24hr cache failed:", e.message); }
}

function get24hrMomentum(symbol) {
  const entry = crypto24hrCache.get(symbol);
  if (!entry || Date.now() - entry.ts > CRYPTO_24HR_TTL) return null;
  return entry.pct; // decimal e.g. 0.25 = 25%
}

// Compute score boost from 24hr momentum
function get24hrScoreBoost(symbol) {
  const pct = get24hrMomentum(symbol);
  if (pct === null) return 0;
  if (pct >= 0.20) { log(`🔥 24hr boost +12 for ${symbol} (${(pct*100).toFixed(1)}% day)`); return 12; }
  if (pct >= 0.10) { log(`⚡ 24hr boost +8 for ${symbol} (${(pct*100).toFixed(1)}% day)`);  return 8;  }
  if (pct >= 0.05) { log(`📈 24hr boost +4 for ${symbol} (${(pct*100).toFixed(1)}% day)`);  return 4;  }
  return 0;
}

// ── CoinGecko trending ───────────────────────────────────────────
async function getTrendingCoins() {
  const result = await safeRequest(() =>
    axios.get("https://api.coingecko.com/api/v3/search/trending", {
      headers: COINGECKO_API_KEY ? { "x-cg-demo-api-key": COINGECKO_API_KEY } : {},
      timeout: 12000
    }), "CoinGecko"
  );
  if (!result?.data?.coins) return [];
  const pairs = result.data.coins
    .map(c => { const s = (c?.item?.symbol || "").toUpperCase(); return s ? `${s}USDT` : null; })
    .filter(Boolean).slice(0, 12);
  log("🪙 CoinGecko trending:", pairs.join(", ") || "none");
  return pairs;
}

// ── Finnhub ──────────────────────────────────────────────────────
async function getTrendingStocks() {
  if (isWeekend() || !canUseFinnhub()) return [...STATIC_STOCK_FALLBACK];
  const result = await safeRequest(() =>
    axios.get("https://finnhub.io/api/v1/stock/symbol", {
      params: { exchange: "US", token: FINNHUB_API_KEY }, timeout: 15000
    }), "Finnhub symbols"
  );
  const data = result?.data;
  if (!Array.isArray(data)) return [...STATIC_STOCK_FALLBACK];
  const filtered = data
    .filter(s => s.type === "Common Stock" && isCleanTicker(s.symbol) && s.mic && ["XNYS","XNAS"].includes(s.mic))
    .map(s => s.symbol).slice(0, 10);
  const core = ["NVDA","PLTR","AMD","ASTS","IONQ","MSFT","META","AMZN","APP","MSTR","COIN","QQQ","SMH","AVGO","VRT"];
  const merged = dedup([...core, ...filtered]).slice(0, 25);
  log(`📈 Stock pool: ${merged.length} symbols`);
  return merged;
}

async function getTopMovers() {
  if (isWeekend() || !canUseFinnhub()) return [];
  const candidates = ["NVDA","ASTS","IONQ","PLTR","AMD","COIN","MSTR","AVAV","SMR","OKLO","CRWD","APP","RKLB","LUNR","ACHR"];
  const movers = [];
  await mapWithConcurrency(candidates, 4, async sym => {
    const result = await safeRequest(() =>
      axios.get("https://finnhub.io/api/v1/quote", {
        params: { symbol: sym, token: FINNHUB_API_KEY }, timeout: 8000
      }), `Finnhub quote ${sym}`
    );
    const changePct = result?.data?.dp;
    if (Number.isFinite(changePct) && changePct > 3) {
      movers.push({ sym, changePct });
      log(`🚀 Top mover: ${sym} +${changePct.toFixed(2)}%`);
    }
  });
  return movers.sort((a, b) => b.changePct - a.changePct).map(m => m.sym);
}

async function detectHotSectors() {
  if (isWeekend() || !canUseFinnhub()) return [];
  const result = await safeRequest(() =>
    axios.get("https://finnhub.io/api/v1/news", {
      params: { category: "general", token: FINNHUB_API_KEY }, timeout: 12000
    }), "Finnhub news"
  );
  const data = result?.data;
  if (!Array.isArray(data)) return [];
  const text = data.slice(0, 60)
    .map(n => ((n.headline || "") + " " + (n.summary || "")).toLowerCase()).join(" ");
  const scores = {};
  for (const [sector, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
    scores[sector] = keywords.filter(kw => text.includes(kw)).length;
  }
  const active = Object.entries(scores)
    .filter(([, s]) => s >= 2).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  log("🧠 Hot sectors:", active.join(", ") || "none");
  return active;
}

// ── Crypto movers for narrative alert ────────────────────────────
// Only shows pairs actually in the scan pool — no false hope
async function getCryptoMovers() {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/ticker/24hr", { timeout: 12000 })
    );
    if (!Array.isArray(data)) return [];
    return data
      .filter(t => CRYPTO_PAIRS.includes(t.symbol) && +t.priceChangePercent >= 5)
      .map(t => ({ symbol: t.symbol, changePct: +t.priceChangePercent }))
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 8);
  } catch { return []; }
}

// ── Narrative change detection ───────────────────────────────────
function narrativeHasChanged(sectors, stockMovers, cryptoMovers) {
  const newState = {
    sectors:      sectors.join(","),
    stockMovers:  stockMovers.slice(0, 6).join(","),
    cryptoMovers: cryptoMovers.map(c => c.symbol).join(",")
  };
  const changed =
    newState.sectors      !== lastNarrativeState.sectors      ||
    newState.stockMovers  !== lastNarrativeState.stockMovers  ||
    newState.cryptoMovers !== lastNarrativeState.cryptoMovers;
  if (changed) lastNarrativeState = newState;
  return changed;
}

// ── Narrative alert — fires only on change, in hours, with crypto ─
async function sendNarrativeAlert(topMovers, cryptoMovers) {
  if (!Array.isArray(topMovers))    topMovers    = [];
  if (!Array.isArray(cryptoMovers)) cryptoMovers = [];

  const parts = ["\uD83E\uDDE0\uD83D\uDD25 <b>MARKET INTEL UPDATE</b>", ""];

  if (!isWeekend() && HOT_SECTORS.length > 0) {
    parts.push("<b>Active narratives:</b>");
    for (const s of HOT_SECTORS) {
      const syms = (SECTOR_SYMBOLS[s] || []).slice(0, 4).join(", ");
      parts.push(`  \uD83D\uDCCC <b>${escapeHtml(s)}</b> \u2192 ${escapeHtml(syms)}`);
    }
    parts.push("");
  }

  if (!isWeekend() && topMovers.length > 0) {
    parts.push("\uD83C\uDDFA\uD83C\uDDF8 <b>Hot stocks right now:</b>");
    for (const sym of topMovers.slice(0, 5)) {
      parts.push(`  \uD83D\uDE80 <b>${escapeHtml(sym)}</b> \u2014 gaining momentum`);
    }
    parts.push("");
  }

  if (cryptoMovers.length > 0) {
    parts.push("\uD83E\uDE99 <b>Crypto moving right now:</b>");
    for (const c of cryptoMovers) {
      const sym  = c.symbol.replace("USDT","");
      const chg  = `+${c.changePct.toFixed(1)}%`;
      const tag  = c.changePct >= 15 ? " \uD83D\uDD25 EXPLOSIVE"
                 : c.changePct >= 8  ? " \u26A1 STRONG"
                 : " \uD83D\uDCC8 MOVING";
      parts.push(`  \uD83D\uDCCA <b>${escapeHtml(sym)}</b> ${escapeHtml(chg)}${tag}`);
    }
    parts.push("");
    parts.push("\uD83D\uDCA1 Entry alert fires if breakout conditions met on next scan");
  }

  if (parts.length <= 2) return; // nothing to say
  parts.push(`\uD83D\uDD0D Scanning ${isWeekend() ? CRYPTO_PAIRS.length + " crypto pairs only" : STOCK_POOL.length + " stocks \u2022 " + CRYPTO_PAIRS.length + " crypto pairs"}`);
  await safeRun("telegramNarrative", () => send(lines(parts)));
}

// ── Dynamic pool refresh ─────────────────────────────────────────
async function refreshDynamicPools() {
  if (refreshingPools || shuttingDown) { if (refreshingPools) log("Pool refresh skipped — already running"); return; }
  refreshingPools = true;
  try {
    log("🔄 Refreshing dynamic pools...");

    // Always refresh crypto pool and 24hr momentum
    const trendingCoins = await getTrendingCoins();
    CRYPTO_PAIRS = dedup([...STATIC_CRYPTO_FALLBACK, ...trendingCoins]).slice(0, 22);
    await refresh24hrMomentum();

    // Stock pool and narratives: weekdays only
    if (!isWeekend()) {
      HOT_SECTORS = await detectHotSectors();
      const [trendingStocks, topMovers] = await Promise.all([getTrendingStocks(), getTopMovers()]);
      const sectorInjected = [];
      for (const sector of HOT_SECTORS) {
        const syms = (SECTOR_SYMBOLS[sector] || []).filter(isCleanTicker);
        sectorInjected.push(...syms);
        log(`💉 Injecting ${sector}: ${syms.join(", ")}`);
      }
      STOCK_POOL = dedup([...trendingStocks, ...topMovers, ...sectorInjected]).slice(0, 25);
      log(`✅ Pools — Crypto: ${CRYPTO_PAIRS.length}, Stocks: ${STOCK_POOL.length}`);

      // Narrative alert: weekday stock hours + change detection
      if (shouldSendStockAlerts()) {
        const cryptoMovers = await getCryptoMovers();
        if (narrativeHasChanged(HOT_SECTORS, topMovers, cryptoMovers)) {
          log("🔔 Narrative changed — sending alert");
          await sendNarrativeAlert(topMovers, cryptoMovers);
        } else {
          log("🔕 Narrative unchanged — silent");
        }
      }
    } else {
      // Weekend: crypto pool only, check if crypto movers worth alerting
      log(`✅ Weekend mode — Crypto pool: ${CRYPTO_PAIRS.length} pairs`);
      const cryptoMovers = await getCryptoMovers();
      if (narrativeHasChanged([], [], cryptoMovers) && shouldSendCryptoAlerts()) {
        log("🔔 Crypto movers changed — sending weekend alert");
        await sendNarrativeAlert([], cryptoMovers);
      } else {
        log("🔕 Crypto unchanged — silent");
      }
    }

    log(`📊 API usage — TD: ${apiUsage.twelvedata}/${API_LIMITS.twelvedata}, AV: ${apiUsage.alphavantage}/${API_LIMITS.alphavantage}`);
  } finally {
    refreshingPools = false;
  }
}

// ── Market open/close Telegram alerts ────────────────────────────
async function checkMarketAlerts() {
  const checks = [
    { key: "CRYPTO", isOpen: isCryptoWindowOpen },
    { key: "US",     isOpen: isUSMarketOpen     },
    { key: "LSE",    isOpen: isLSEMarketOpen    }
  ];
  for (const { key, isOpen } of checks) {
    const nowOpen = isOpen();
    if (nowOpen && !marketWasOpen[key]) {
      log(`🟢 ${key} open`);
      const msgs = {
        CRYPTO: `\uD83D\uDFE2\uD83E\uDE99 <b>CRYPTO WINDOW OPEN</b>\n\u23F0 Scanning 06:00\u201322:00 UK\n\uD83D\uDCE1 BTC trend: <b>${escapeHtml(btcTrend.replace("_"," ").toUpperCase())}</b>\n\uD83D\uDD0D ${CRYPTO_PAIRS.length} pairs active`,
        US:     `\uD83D\uDFE2\uD83C\uDDFA\uD83C\uDDF8 <b>US MARKET OPEN</b>\n\u23F0 14:30\u201321:00 UK\n\uD83D\uDCE1 QQQ trend: <b>${escapeHtml(qqqTrend.replace("_"," ").toUpperCase())}</b>\n\uD83D\uDD0D ${STOCK_POOL.length} stocks in pool`,
        LSE:    `\uD83D\uDFE2\uD83C\uDDEC\uD83C\uDDE7 <b>LSE MARKET OPEN</b>\n\u23F0 08:00\u201316:30 UK\n\uD83D\uDD0D ${LSE_POOL.length} stocks in pool`
      };
      await safeRun(`open${key}`, () => send(msgs[key]));
    }
    if (!nowOpen && marketWasOpen[key]) {
      log(`🔴 ${key} closed`);
      const msgs = {
        CRYPTO: `\uD83D\uDD34\uD83E\uDE99 <b>CRYPTO WINDOW CLOSED</b>\n\uD83D\uDE34 Scanning paused until 06:00 UK`,
        US:     `\uD83D\uDD34\uD83C\uDDFA\uD83C\uDDF8 <b>US MARKET CLOSED</b>\n\uD83C\uDFC1 See you at 14:30 UK tomorrow`,
        LSE:    `\uD83D\uDD34\uD83C\uDDEC\uD83C\uDDE7 <b>LSE MARKET CLOSED</b>\n\uD83C\uDFC1 See you at 08:00 UK tomorrow`
      };
      await safeRun(`close${key}`, () => send(msgs[key]));
    }
    marketWasOpen[key] = nowOpen;
  }
}

// ── Data fetching: crypto 15-min candles (Binance — always free) ──
async function fetchCrypto(symbol) {
  const cacheKey = `crypto_15m_${symbol}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/klines", {
        params: { symbol, interval: "15m", limit: 100 }, // 100 x 15min = 25 hours
        timeout: 12000
      })
    );
    const candles = data.map(k => ({
      close:  +k[4],
      high:   +k[2],
      low:    +k[3],
      volume: +k[5]
    }));
    setCache(cacheKey, candles);
    return candles;
  } catch { return null; }
}

// ── BTC trend still uses 1h candles for regime classification ─────
async function fetchCrypto1h(symbol) {
  const cacheKey = `crypto_1h_${symbol}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/klines", {
        params: { symbol, interval: "1h", limit: 70 }, timeout: 12000
      })
    );
    const candles = data.map(k => ({ close: +k[4], high: +k[2], low: +k[3], volume: +k[5] }));
    setCache(cacheKey, candles);
    return candles;
  } catch { return null; }
}

// ── US/LSE data fetching with rotation ──────────────────────────
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
  } catch { return null; }
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
    const series = data[`Time Series (${interval})`];
    if (!series) return null;
    apiUsage.alphavantage++;
    return Object.entries(series)
      .sort(([a], [b]) => new Date(a) - new Date(b))
      .map(([, v]) => ({ close: +v["4. close"], high: +v["2. high"], low: +v["3. low"], volume: +v["5. volume"] }))
      .filter(x => Number.isFinite(x.close));
  } catch { return null; }
}

async function fetchYahooFinanceSeries(symbol, interval = "1h") {
  const yahooInterval = interval === "15min" ? "15m" : "1h";
  const range         = yahooInterval === "15m" ? "5d" : "30d";
  try {
    const { data } = await retry(() =>
      axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
        params: { interval: yahooInterval, range, includePrePost: false },
        headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000
      })
    );
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators?.quote?.[0];
    if (!q) return null;
    return (result.timestamp || [])
      .map((_, i) => ({ close: q.close[i]||0, high: q.high[i]||0, low: q.low[i]||0, volume: q.volume[i]||0 }))
      .filter(x => Number.isFinite(x.close) && x.close > 0);
  } catch (e) { log(`Yahoo failed ${symbol}:`, e.message); return null; }
}

async function fetchUSData(symbol) {
  const use15min = isUSOpeningWindow();
  const interval = use15min ? "15min" : "1h";
  const cacheKey = `us_${symbol}_${interval}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  resetApiUsageIfNewDay();
  const api = pickApiForSymbol();
  let candles = null;
  if (api === "twelvedata") {
    candles = await fetchTwelveDataSeries(symbol, interval, use15min ? 40 : 70);
    if (!candles) candles = await fetchAlphaVantageSeries(symbol, use15min ? "15min" : "60min");
  } else if (api === "alphavantage") {
    candles = await fetchAlphaVantageSeries(symbol, use15min ? "15min" : "60min");
    if (!candles) candles = await fetchTwelveDataSeries(symbol, interval, use15min ? 40 : 70);
  }
  if (!candles) { log(`🆓 Yahoo for ${symbol}`); candles = await fetchYahooFinanceSeries(symbol, interval); }
  if (candles) setCache(cacheKey, candles);
  return candles;
}

async function fetchLSEData(symbol) {
  const cacheKey = `lse_${symbol}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  let candles = await fetchTwelveDataSeries(symbol, "1h", 70);
  if (!candles) candles = await fetchYahooFinanceSeries(symbol, "1h");
  if (candles) setCache(cacheKey, candles);
  return candles;
}

// ── Live price ───────────────────────────────────────────────────
async function fetchLivePrice(asset, market) {
  try {
    if (market === "CRYPTO") {
      const { data } = await retry(() =>
        axios.get("https://data-api.binance.vision/api/v3/ticker/price", {
          params: { symbol: asset }, timeout: 10000
        })
      );
      return +data.price;
    }
    if (TWELVE_DATA_API_KEY) {
      try {
        const { data } = await retry(() =>
          axios.get("https://api.twelvedata.com/price", {
            params: { symbol: asset, apikey: TWELVE_DATA_API_KEY }, timeout: 12000
          })
        );
        if (data?.status !== "error") { apiUsage.twelvedata++; return +data.price; }
      } catch { /* fall through */ }
    }
    if (ALPHA_VANTAGE_API_KEY) {
      try {
        const { data } = await retry(() =>
          axios.get("https://www.alphavantage.co/query", {
            params: { function: "GLOBAL_QUOTE", symbol: asset, apikey: ALPHA_VANTAGE_API_KEY }, timeout: 12000
          })
        );
        const price = +data?.["Global Quote"]?.["05. price"];
        if (Number.isFinite(price)) { apiUsage.alphavantage++; return price; }
      } catch { /* fall through */ }
    }
    const { data } = await retry(() =>
      axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${asset}`, {
        params: { interval: "1m", range: "1d" }, headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000
      })
    );
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return Number.isFinite(price) ? price : null;
  } catch { return null; }
}

// ── Trend updates ────────────────────────────────────────────────
async function updateBTCTrend() {
  const candles = await fetchCrypto1h("BTCUSDT"); // regime uses 1h
  if (!candles) return;
  const closes = candles.map(x => x.close);
  const prev   = btcTrend;
  btcTrend = classifyRegime(ema(closes, 20), ema(closes, 50), closes.at(-1));
  if (btcTrend !== prev) log(`📡 BTC trend: ${prev} → ${btcTrend}`);
}

async function updateQQQTrend() {
  if (!ENABLE_US || !isUSMarketOpen()) { qqqTrend = "neutral"; return; }
  const candles = await fetchUSData("QQQ");
  if (!candles) { qqqTrend = "neutral"; return; }
  const closes = candles.map(x => x.close);
  const prev   = qqqTrend;
  qqqTrend = classifyRegime(ema(closes, 20), ema(closes, 50), closes.at(-1));
  if (qqqTrend !== prev) log(`📡 QQQ trend: ${prev} → ${qqqTrend}`);
}

// ── Market open/close alerts — with forced pool refresh on open ───
async function checkMarketAlerts() {
  const checks = [
    { key: "CRYPTO", isOpen: isCryptoWindowOpen },
    { key: "US",     isOpen: isUSMarketOpen     },
    { key: "LSE",    isOpen: isLSEMarketOpen    }
  ];
  for (const { key, isOpen } of checks) {
    const nowOpen = isOpen();
    if (nowOpen && !marketWasOpen[key]) {
      log(`🟢 ${key} open — forcing pool refresh`);
      // Force immediate pool refresh so pool is fresh at market open
      await safeRun(`poolRefreshOn${key}Open`, refreshDynamicPools);
      // Build open message with current state
      const openMsgs = {
        CRYPTO: `\uD83D\uDFE2\uD83E\uDE99 <b>CRYPTO WINDOW OPEN</b>\n\u23F0 Scanning 06:00\u201322:00 UK\n\uD83D\uDCE1 BTC trend: <b>${escapeHtml(btcTrend.replace("_"," ").toUpperCase())}</b>\n\uD83D\uDD0D ${CRYPTO_PAIRS.length} pairs active`,
        US:     `\uD83D\uDFE2\uD83C\uDDFA\uD83C\uDDF8 <b>US MARKET OPEN</b>\n\u23F0 14:30\u201321:00 UK\n\uD83D\uDCE1 QQQ trend: <b>${escapeHtml(qqqTrend.replace("_"," ").toUpperCase())}</b>\n\uD83D\uDD0D ${STOCK_POOL.length} stocks in pool`,
        LSE:    `\uD83D\uDFE2\uD83C\uDDEC\uD83C\uDDE7 <b>LSE MARKET OPEN</b>\n\u23F0 08:00\u201316:30 UK\n\uD83D\uDD0D ${LSE_POOL.length} stocks in pool`
      };
      await safeRun(`open${key}`, () => send(openMsgs[key]));
    }
    if (!nowOpen && marketWasOpen[key]) {
      log(`🔴 ${key} closed`);
      const closeMsgs = {
        CRYPTO: `\uD83D\uDD34\uD83E\uDE99 <b>CRYPTO WINDOW CLOSED</b>\n\uD83D\uDE34 Scanning paused until 06:00 UK`,
        US:     `\uD83D\uDD34\uD83C\uDDFA\uD83C\uDDF8 <b>US MARKET CLOSED</b>\n\uD83C\uDFC1 See you at 14:30 UK tomorrow`,
        LSE:    `\uD83D\uDD34\uD83C\uDDEC\uD83C\uDDE7 <b>LSE MARKET CLOSED</b>\n\uD83C\uDFC1 See you at 08:00 UK tomorrow`
      };
      await safeRun(`close${key}`, () => send(closeMsgs[key]));
    }
    marketWasOpen[key] = nowOpen;
  }
}

// ── Narrative bonus ──────────────────────────────────────────────
function getNarrativeBonus(asset) {
  let bonus = 0;
  const sym = asset.replace("USDT","");
  for (const sector of HOT_SECTORS) {
    if ((SECTOR_SYMBOLS[sector] || []).includes(sym)) bonus += 6;
  }
  if (HOT_SECTORS.includes("AI") && CRYPTO_AI_NAMES.includes(asset)) bonus += 5;
  return bonus;
}

// ── Emoji helpers ────────────────────────────────────────────────
function gradeEmoji(g)  { return g === "A*" ? "\uD83D\uDC8E\uD83D\uDD25" : g === "A" ? "\uD83D\uDE80\u26A1" : "\uD83D\uDCC8"; }
function setupEmoji(t)  { return t === "BREAKOUT_CONTINUATION" ? "\uD83D\uDCA5" : t === "PULLBACK_CONTINUATION" ? "\uD83C\uDFAF" : t === "MOMENTUM_BREAKOUT" ? "\uD83D\uDD25" : t === "MOMENTUM_IGNITION" ? "\u26A1" : "\uD83D\uDCCA"; }
function marketEmoji(m) { return m === "CRYPTO" ? "\uD83E\uDE99" : m === "US" ? "\uD83C\uDDFA\uD83C\uDDF8" : m === "LSE" ? "\uD83C\uDDEC\uD83C\uDDE7" : "\uD83D\uDCCA"; }

// ── Core analysis ────────────────────────────────────────────────
function analyse(asset, candles, market) {
  if (!candles || candles.length < MIN_CANDLES) {
    if (candles) log(`⛔ ${asset} — not enough candles (${candles.length})`);
    return null;
  }

  const closes  = candles.map(x => x.close);
  const highs   = candles.map(x => x.high);
  const lows    = candles.map(x => x.low);
  const volumes = candles.map(x => x.volume || 0);

  const last = closes.at(-1);
  const prev = closes.at(-2);
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) return null;

  const momentum = (last - prev) / prev;

  // For crypto on 15-min: minimum momentum is lower
  const minMomentum = market === "CRYPTO" ? CRYPTO_15M_MIN_MOMENTUM : 0;
  if (momentum <= minMomentum) {
    if (market === "CRYPTO") log(`⛔ ${asset} — momentum too low (${(momentum*100).toFixed(2)}% < ${minMomentum*100}%)`);
    return null;
  }

  const ema20     = ema(closes, 20);
  const ema50     = ema(closes, 50);
  const ema20Prev = ema(closes.slice(0, -1), 20);

  if (!(ema20 > ema50 && last > ema20 && ema20 > ema20Prev)) {
    log(`⛔ ${asset} — EMA structure not bullish (ema20=${ema20?.toFixed(4)} ema50=${ema50?.toFixed(4)} last=${last?.toFixed(4)})`);
    return null;
  }

  const avgVol     = avg(volumes.slice(-21, -1));
  const currentVol = volumes.at(-1);
  const volRatio   = avgVol > 0 ? currentVol / avgVol : 0;

  // Extension check — looser during US opening window to catch gap-up stocks
  const extension      = (last - ema20) / ema20;
  const openingWindow  = market === "US" && isUSOpeningWindow();
  const extensionLimit = market === "CRYPTO" ? CRYPTO_15M_EXTENSION_LIMIT
                       : market === "US"     ? (openingWindow ? 0.18 : EXTENSION_HARD_LIMIT_US)
                       : EXTENSION_HARD_LIMIT_LSE;
  if (extension > extensionLimit) {
    log(`⛔ ${asset} — extended ${(extension*100).toFixed(1)}% > ${extensionLimit*100}%${openingWindow ? " (opening window)" : ""}`);
    return null;
  }

  // Exceptional crypto override — bypasses BTC regime when move is strong
  const exceptionalCrypto = market === "CRYPTO" &&
    momentum >= REGIME_OVERRIDE_MIN_MOMENTUM &&
    volRatio >= REGIME_OVERRIDE_MIN_VOL;

  if (!regimePass(market) && !exceptionalCrypto) {
    log(`⛔ ${asset} — regime blocked (btcTrend=${btcTrend} mom=${(momentum*100).toFixed(2)}% vol=${volRatio.toFixed(2)}x need ${REGIME_OVERRIDE_MIN_MOMENTUM*100}%+${REGIME_OVERRIDE_MIN_VOL}x for override)`);
    return null;
  }

  if (exceptionalCrypto && !regimePass(market)) {
    log(`⚡ Regime override: ${asset} vol=${volRatio.toFixed(2)}x mom=${(momentum*100).toFixed(2)}%`);
  }

  // Breakout / pullback detection
  const breakoutLevel    = Math.max(...highs.slice(-BREAKOUT_LOOKBACK, -1));
  const breakoutDistance = breakoutLevel > 0 ? (last - breakoutLevel) / breakoutLevel : 0;

  const breakoutDistLimit = market === "CRYPTO" ? CRYPTO_15M_BREAKOUT_DIST : market === "US" ? BREAKOUT_MAX_DISTANCE_US : BREAKOUT_MAX_DISTANCE_LSE;
  const breakoutVolNeeded = market === "CRYPTO" ? CRYPTO_15M_BREAKOUT_VOL  : market === "US" ? US_BREAKOUT_VOL : LSE_BREAKOUT_VOL;
  const pullbackVolNeeded = market === "CRYPTO" ? CRYPTO_15M_PULLBACK_VOL  : market === "US" ? US_PULLBACK_VOL : LSE_PULLBACK_VOL;

  const recentRanges   = highs.slice(-5, -1).map((h, i) => h - lows.slice(-5, -1)[i]).filter(Number.isFinite);
  const priorRanges    = highs.slice(-10, -5).map((h, i) => h - lows.slice(-10, -5)[i]).filter(Number.isFinite);
  const expandingRange = avg(recentRanges) > 0 && avg(priorRanges) > 0 && avg(recentRanges) > avg(priorRanges) * 1.3;

  const ignitionSignal =
    momentum > (market === "CRYPTO" ? 0.02 : 0.025) &&
    volRatio > 2.0 && last > ema20 && expandingRange;

  const strongMomentumOverride = market === "US" &&
    STOCK_MOMENTUM_OVERRIDE_ENABLED &&
    momentum >= STOCK_OVERRIDE_MIN_MOMENTUM &&
    volRatio >= STOCK_OVERRIDE_MIN_VOL &&
    breakoutDistance <= STOCK_OVERRIDE_MAX_DISTANCE;

  const breakoutSignal = last > breakoutLevel &&
    breakoutDistance <= breakoutDistLimit &&
    volRatio >= breakoutVolNeeded &&
    momentum >= (market === "US" ? MIN_US_MOMENTUM : market === "LSE" ? MIN_LSE_MOMENTUM : 0);

  const nearEMAThreshold   = market === "US" ? 0.02 : 0.025;
  const nearEMA20          = Math.abs(last - ema20) / ema20 <= nearEMAThreshold;
  const pulledBackRecently = closes.slice(-6, -1).some(c => c <= ema20 * 1.01);
  const pullbackSignal     = nearEMA20 && pulledBackRecently && volRatio >= pullbackVolNeeded;

  if (!pullbackSignal && !breakoutSignal && !strongMomentumOverride && !ignitionSignal) {
    log(`⛔ ${asset} — no valid setup (break=${breakoutSignal} pull=${pullbackSignal} mom=${strongMomentumOverride} ign=${ignitionSignal} vol=${volRatio.toFixed(2)}x)`);
    return null;
  }

  let setupType = "BREAKOUT_CONTINUATION";
  if (pullbackSignal && !breakoutSignal && !ignitionSignal) setupType = "PULLBACK_CONTINUATION";
  if (strongMomentumOverride && !ignitionSignal)            setupType = "MOMENTUM_BREAKOUT";
  if (ignitionSignal)                                        setupType = "MOMENTUM_IGNITION";

  const minPullbackMom = market === "CRYPTO" ? CRYPTO_15M_MIN_PULLBACK : market === "US" ? MIN_PULLBACK_MOMENTUM_US : MIN_PULLBACK_MOMENTUM_LSE;
  if (setupType === "PULLBACK_CONTINUATION" && momentum < minPullbackMom) return null;

  const momentumCap = market === "CRYPTO" ? CRYPTO_15M_MAX_MOMENTUM : market === "US" ? MAX_MOMENTUM_BAR_US : MAX_MOMENTUM_BAR_LSE;
  if (setupType !== "MOMENTUM_IGNITION" && momentum > momentumCap) {
    log(`⛔ ${asset} — momentum cap (${(momentum*100).toFixed(2)}% > ${momentumCap*100}%)`);
    return null;
  }

  const entryType = setupType === "PULLBACK_CONTINUATION" ? "LIMIT BUY" : "MARKET BUY";
  const entry     = setupType === "PULLBACK_CONTINUATION" ? ema20 * 1.002 : last;

  const atr = calculateATR(candles, ATR_PERIOD);
  if (!atr || atr <= 0) return null;

  const swingLow = Math.min(...lows.slice(-6));
  const atrMult  = setupType === "PULLBACK_CONTINUATION" ? ATR_PULLBACK_MULTIPLIER
                 : setupType === "MOMENTUM_IGNITION"     ? ATR_IGNITION_MULTIPLIER
                 : ATR_BREAKOUT_MULTIPLIER;

  const sl = Math.min(swingLow - atr * atrMult, entry - atr * atrMult);
  if (!Number.isFinite(sl) || sl >= entry) return null;

  const riskAmt = entry - sl;
  const riskPct = riskAmt / entry;
  if (riskPct <= 0 || riskPct > 0.12) return null;

  const tp = entry + riskAmt * TARGET_R;
  const rr = +((((tp - entry) / entry) / riskPct).toFixed(1));
  if (rr < MIN_RR) return null;

  // ── Scoring ─────────────────────────────────────────────────
  let score = 50;

  // Volume scoring
  if (volRatio > 1.2) score += 6;
  if (volRatio > 1.4) score += 6;
  if (volRatio > 1.6) score += 4;
  if (volRatio > 2.0) score += 5;
  if (volRatio > 3.0) score += 5;

  // Momentum scoring
  if (market === "CRYPTO") {
    // 15-min scale
    if (momentum > 0.03)  score += 10;
    else if (momentum > 0.015) score += 8;
    else if (momentum > 0.008) score += 4;
  } else {
    if (momentum > 0.025) score += 10;
    else if (momentum > 0.015) score += 8;
    else if (momentum > 0.008) score += 4;
  }

  // Setup type
  if (setupType === "BREAKOUT_CONTINUATION") score += 10;
  if (setupType === "PULLBACK_CONTINUATION") score += 8;
  if (setupType === "MOMENTUM_BREAKOUT")     score += 14;
  if (setupType === "MOMENTUM_IGNITION")     score += 18;

  // Market
  if (market === "CRYPTO") score += 5;
  if (market === "US")     score += 4;
  if (market === "LSE")    score += 2;

  // Regime
  if (market === "CRYPTO" && btcTrend === "strong_bull") score += 5;
  if (market === "US"     && qqqTrend === "bull")        score += 3;
  if (market === "US"     && qqqTrend === "strong_bull") score += 5;

  // Quality
  if (breakoutDistance > 0 && breakoutDistance <= 0.01) score += 4;
  if (expandingRange) score += 4;

  // Narrative bonus
  score += getNarrativeBonus(asset);

  // V88: 24hr momentum boost — if coin has been running all day
  score += get24hrScoreBoost(asset);

  let grade = "B";
  if (score >= 85) grade = "A*";
  else if (score >= 78) grade = "A";

  log(`✅ ${asset} ${market} ${setupType} score=${score} grade=${grade} vol=${volRatio.toFixed(2)}x mom=${(momentum*100).toFixed(2)}%`);

  return {
    asset, market, grade, setupType, status: "CONFIRMED",
    entryType, entry, sl, tp, rr, score, momentum, volRatio,
    breakoutDistance, atr,
    regime: market === "CRYPTO" ? btcTrend : market === "US" ? qqqTrend : "LSE_LOCAL"
  };
}

// ── Momentum watch — heating up alerts ──────────────────────────
function momentumWatchCooledDown(asset) {
  const last = momentumWatchSent.get(asset);
  if (!last) return true;
  return Date.now() - last > MOMENTUM_WATCH_COOLDOWN_MS;
}

async function checkMomentumWatch() {
  const trades = await loadTrades();
  const hasOpenTrade = asset => trades.some(t => t.asset === asset && (t.status === "FILLED" && t.outcome === "OPEN"));

  // Crypto — check during window (weekends included)
  if (shouldSendCryptoAlerts()) {
    try {
      const { data } = await axios.get("https://data-api.binance.vision/api/v3/ticker/24hr", { timeout: 12000 });
      if (Array.isArray(data)) {
        const heating = data
          .filter(t =>
            CRYPTO_PAIRS.includes(t.symbol) &&
            +t.priceChangePercent >= MOMENTUM_WATCH_CRYPTO_THRESHOLD &&
            !hasOpenTrade(t.symbol) &&
            momentumWatchCooledDown(t.symbol)
          )
          .sort((a, b) => +b.priceChangePercent - +a.priceChangePercent)
          .slice(0, 3);

        for (const t of heating) {
          const sym  = t.symbol.replace("USDT","");
          const pct  = (+t.priceChangePercent).toFixed(1);
          const emoji = +t.priceChangePercent >= 15 ? "\uD83D\uDD25" : +t.priceChangePercent >= 8 ? "\u26A1" : "\uD83D\uDCC8";
          const ctx   = +t.priceChangePercent >= 15 ? "explosive move — watching for entry"
                      : +t.priceChangePercent >= 8  ? "strong momentum building"
                      : "gaining momentum";
          await send(lines([
            `${emoji} <b>${escapeHtml(sym)} HEATING UP</b>`,
            ``,
            `\uD83E\uDE99 Crypto \u2022 24hr: <b>+${escapeHtml(pct)}%</b>`,
            `\uD83D\uDCC8 ${escapeHtml(ctx)}`,
            ``,
            `\uD83D\uDCA1 Entry alert fires if breakout confirmed on next scan`
          ]));
          momentumWatchSent.set(t.symbol, Date.now());
          log(`👀 Momentum watch fired: ${t.symbol} +${pct}%`);
        }
      }
    } catch (e) { log("Momentum watch crypto failed:", e.message); }
  }

  // Stocks — weekdays only during US session
  if (shouldSendStockAlerts() && isUSMarketOpen() && canUseFinnhub()) {
    await mapWithConcurrency(STOCK_POOL, 3, async sym => {
      try {
        if (!momentumWatchCooledDown(sym) || hasOpenTrade(sym)) return;
        const result = await safeRequest(() =>
          axios.get("https://finnhub.io/api/v1/quote", {
            params: { symbol: sym, token: FINNHUB_API_KEY }, timeout: 8000
          }), `Finnhub watch ${sym}`
        );
        const changePct = result?.data?.dp;
        if (!Number.isFinite(changePct) || changePct < MOMENTUM_WATCH_STOCK_THRESHOLD) return;
        const emoji = changePct >= 8 ? "\uD83D\uDD25" : changePct >= 5 ? "\u26A1" : "\uD83D\uDCC8";
        const ctx   = changePct >= 8 ? "explosive move — watching for entry"
                    : changePct >= 5 ? "strong momentum building"
                    : "gaining momentum";
        await send(lines([
          `${emoji} <b>${escapeHtml(sym)} HEATING UP</b>`,
          ``,
          `\uD83C\uDDFA\uD83C\uDDF8 US Stock \u2022 Today: <b>+${changePct.toFixed(1)}%</b>`,
          `\uD83D\uDCC8 ${escapeHtml(ctx)}`,
          ``,
          `\uD83D\uDCA1 Entry alert fires if breakout confirmed on next scan`
        ]));
        momentumWatchSent.set(sym, Date.now());
        log(`👀 Momentum watch fired: ${sym} +${changePct.toFixed(1)}%`);
      } catch { /* skip */ }
    });
  }
}

// ── Signal and trade messages ────────────────────────────────────
function buildSignalLesson(signal) {
  const parts = ["\uD83D\uDCDA <b>TRADE LESSON</b>", ""];
  if (signal.setupType === "BREAKOUT_CONTINUATION") {
    parts.push("\uD83D\uDCA5 <b>Breakout Continuation</b> \u2014 price pushed above recent resistance. Market buy gets you in immediately.");
  } else if (signal.setupType === "PULLBACK_CONTINUATION") {
    parts.push("\uD83C\uDFAF <b>Pullback Continuation</b> \u2014 price dipped back to the 20-period EMA and is bouncing. Lower risk entry \u2014 buying a dip within an uptrend.");
  } else if (signal.setupType === "MOMENTUM_BREAKOUT") {
    parts.push("\uD83D\uDD25 <b>Momentum Breakout</b> \u2014 strong candle with high volume through resistance. Volume confirms real buying pressure.");
  } else {
    parts.push("\u26A1 <b>Momentum Ignition</b> \u2014 explosive early runner. Volume 2x+, accelerating, range expanding. Higher risk, higher reward \u2014 size carefully.");
  }

  if (signal.volRatio >= 3.0)      parts.push(`\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x</b> \u2014 exceptional. Institutional-level buying flow.`);
  else if (signal.volRatio >= 2.0) parts.push(`\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x</b> \u2014 very strong. Real conviction behind this move.`);
  else                              parts.push(`\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x</b> \u2014 above average. Buyers are active.`);

  if (signal.market === "CRYPTO") {
    const pct24 = get24hrMomentum(signal.asset);
    if (pct24 && pct24 >= 0.05) {
      parts.push(`\n\uD83D\uDCC8 <b>24hr move: +${(pct24*100).toFixed(1)}%</b> \u2014 this has been building all day. 15-min candle caught the breakout moment.`);
    }
    parts.push(`\n\uD83E\uDE99 BTC trend: <b>${btcTrend.replace("_"," ")}</b>`);
  } else if (signal.market === "US") {
    parts.push(`\n\uD83C\uDDFA\uD83C\uDDF8 QQQ trend: <b>${qqqTrend.replace("_"," ")}</b>`);
  }

  const matched = HOT_SECTORS.filter(s => (SECTOR_SYMBOLS[s]||[]).includes(signal.asset.replace("USDT","")));
  if (matched.length > 0) parts.push(`\n\uD83E\uDDE0 <b>Narrative: ${matched.join(", ")}</b> \u2014 institutional money flowing into this sector.`);

  if (signal.grade === "A*") parts.push("\n\u2B50 <b>A* grade</b> \u2014 all conditions aligned. Pay close attention.");
  else if (signal.grade === "A") parts.push("\n\u2B50 <b>A grade</b> \u2014 strong signal. Well above minimum threshold.");

  parts.push(`\n\u26A1 <b>Momentum: ${(signal.momentum*100).toFixed(2)}%</b> on this candle.`);
  return lines(parts);
}

function buildCloseLesson(trade, reason, closePrice) {
  const rVal       = Number.isFinite(trade.realizedR) ? +trade.realizedR.toFixed(2) : null;
  const priceMoved = Number.isFinite(closePrice) && Number.isFinite(trade.entry) ? ((closePrice - trade.entry) / trade.entry * 100).toFixed(2) : null;
  const hoursHeld  = hoursAgo(trade.filledAt || trade.sentAt).toFixed(1);
  const parts      = ["\uD83D\uDCD6 <b>TRADE DEBRIEF</b>", ""];

  if (reason === "TAKE PROFIT") {
    parts.push(`\u2705 <b>Target hit.</b> Price moved ${priceMoved ? priceMoved + "%" : "as expected"} to reach take profit.`);
    if (rVal !== null) parts.push(`\n\uD83D\uDCCA <b>${rVal}R</b> \u2014 you made ${rVal}x what you risked.`);
  } else if (reason === "STOP LOSS") {
    parts.push(`\uD83D\uDED1 <b>Stop loss triggered.</b>${priceMoved ? " Moved against by " + Math.abs(+priceMoved) + "%." : ""} Normal \u2014 even great systems lose 40-50% of trades. The stop protected the account.`);
  } else if (reason === "FORCE CLOSE") {
    parts.push(`\u23F1\uFE0F <b>Force closed.</b> Open ${hoursHeld} hours without progress. Capital freed for better setups.`);
  } else if (reason === "REPLACED") {
    parts.push("\uD83D\uDD04 <b>Trade replaced.</b> A higher-scoring signal appeared. Only happens when new signal scores significantly better AND this wasn\u2019t progressing.");
  } else if (reason === "PENDING_EXPIRED") {
    parts.push("\u231B <b>Order expired.</b> Entry price was never reached. No money was at risk \u2014 better to expire than chase.");
  } else if (reason === "STRUCTURE_INVALID") {
    parts.push("\u26A0\uFE0F <b>Structure invalidated.</b> Price dropped below stop before entry filled. Protected you from a bad trade.");
  } else if (reason === "DRIFTED_TOO_FAR") {
    parts.push("\uD83C\uDF0A <b>Drifted too far.</b> Price moved away from entry without filling. Chasing increases risk.");
  }

  if (Number.isFinite(trade.maePct) && Number.isFinite(trade.mfePct)) {
    parts.push(`\n\uD83D\uDCC9 MAE: ${(trade.maePct*100).toFixed(2)}% \u2022 \uD83D\uDCC8 MFE: ${(trade.mfePct*100).toFixed(2)}%`);
  }
  return lines(parts);
}

function buildSignalMessage(signal, size) {
  const isMarket  = signal.entryType === "MARKET BUY";
  const sym       = signal.asset.replace("USDT","");
  const matched   = HOT_SECTORS.filter(s => (SECTOR_SYMBOLS[s]||[]).includes(sym));
  const ntag      = matched.length > 0 ? `\n\uD83E\uDDE0 <b>${escapeHtml(matched.join(" + "))}</b>` : "";
  const slPct     = (((signal.entry - signal.sl) / signal.entry) * 100).toFixed(1);
  const tpPct     = (((signal.tp - signal.entry) / signal.entry) * 100).toFixed(1);
  const riskPct   = (getRiskFractionForSignal(signal) * 100).toFixed(1);

  return lines([
    `\uD83D\uDEA8 ${gradeEmoji(signal.grade)} <b>${escapeHtml(signal.grade)} SIGNAL</b>${ntag}`,
    ``,
    `${marketEmoji(signal.market)} <b>${escapeHtml(signal.market)} | ${escapeHtml(signal.asset)}</b>`,
    `${setupEmoji(signal.setupType)} ${escapeHtml(signal.setupType)}`,
    ``,
    isMarket
      ? `\u26A1 <b>MARKET BUY NOW</b> ~${escapeHtml(formatPrice(signal.entry, signal.market))}`
      : `\uD83D\uDCB0 Limit Entry: ${escapeHtml(formatPrice(signal.entry, signal.market))}`,
    `\uD83D\uDEE1\uFE0F SL:    ${escapeHtml(formatPrice(signal.sl, signal.market))} <b>(-${escapeHtml(slPct)}%)</b>`,
    `\uD83C\uDFAF TP:    ${escapeHtml(formatPrice(signal.tp, signal.market))} <b>(+${escapeHtml(tpPct)}%)</b>`,
    `\u2696\uFE0F R:R:   ${escapeHtml(String(signal.rr))}`,
    `\u2B50 Score: ${escapeHtml(String(signal.score))}`,
    `\uD83D\uDCCA Vol:   ${escapeHtml(signal.volRatio.toFixed(2))}x`,
    `\u26A0\uFE0F Risk:  ${escapeHtml(riskPct)}% of account`,
    ``,
    buildSignalLesson(signal)
  ]);
}

function buildFillMessage(trade, price) {
  const slPct = (((price - trade.sl) / price) * 100).toFixed(1);
  const tpPct = (((trade.tp - price) / price) * 100).toFixed(1);
  return lines([
    `\u2705\uD83D\uDD25 <b>FILLED</b>`,
    ``,
    `${marketEmoji(trade.market)} <b>${escapeHtml(trade.market)} | ${escapeHtml(trade.asset)}</b>`,
    `${setupEmoji(trade.setupType)} ${escapeHtml(trade.setupType)}`,
    ``,
    `\uD83D\uDCB5 Fill: ${escapeHtml(formatPrice(price, trade.market))}`,
    `\uD83D\uDEE1\uFE0F SL:   ${escapeHtml(formatPrice(trade.sl, trade.market))} <b>(-${escapeHtml(slPct)}%)</b>`,
    `\uD83C\uDFAF TP:   ${escapeHtml(formatPrice(trade.tp, trade.market))} <b>(+${escapeHtml(tpPct)}%)</b>`,
    `\u2B50 Score: ${escapeHtml(String(trade.score))}`
  ]);
}

function buildCloseMessage(trade, reason, closePrice) {
  const rVal     = Number.isFinite(trade.realizedR) ? +trade.realizedR.toFixed(2) : null;
  const mae      = Number.isFinite(trade.maePct) ? `${(trade.maePct*100).toFixed(2)}%` : "n/a";
  const mfe      = Number.isFinite(trade.mfePct) ? `${(trade.mfePct*100).toFixed(2)}%` : "n/a";
  const pnlPct   = Number.isFinite(closePrice) && Number.isFinite(trade.entry) && trade.entry > 0
    ? ((closePrice - trade.entry) / trade.entry * 100).toFixed(2) : null;
  const heldHrs  = Number.isFinite(hoursAgo(trade.filledAt || trade.sentAt))
    ? hoursAgo(trade.filledAt || trade.sentAt).toFixed(1) : "?";

  const isWin    = reason === "TAKE PROFIT";
  const isLoss   = reason === "STOP LOSS";
  const isMeh    = !isWin && !isLoss;

  const resultEmoji = isWin ? "\uD83D\uDCB0\u2705" : isLoss ? "\uD83D\uDED1\u274C" : "\u23F1\uFE0F";
  const resultLabel = isWin ? "WINNER" : isLoss ? "STOPPED OUT" : reason.replace("_"," ");
  const rLabel      = rVal !== null
    ? (rVal > 0 ? `+${rVal}R` : `${rVal}R`) : "n/a";
  const pnlLabel    = pnlPct !== null
    ? (parseFloat(pnlPct) > 0 ? `+${pnlPct}%` : `${pnlPct}%`) : "n/a";

  const sym = trade.asset.replace("USDT","");

  const parts = [
    `${resultEmoji} <b>${escapeHtml(resultLabel)}</b>`,
    ``,
    `${marketEmoji(trade.market)} <b>${escapeHtml(trade.market)} | ${escapeHtml(trade.asset)}</b>`,
    `${setupEmoji(trade.setupType)} ${escapeHtml(trade.setupType)}`,
    ``,
    `\uD83D\uDCB5 Entry:  ${escapeHtml(formatPrice(trade.entry, trade.market))}`,
    `\uD83D\uDCB5 Exit:   ${escapeHtml(formatPrice(closePrice, trade.market))}`,
    ``,
    `\uD83D\uDCCA Result: <b>${escapeHtml(pnlLabel)}</b> \u2022 <b>${escapeHtml(rLabel)}</b>`,
    `\u23F1\uFE0F Held:   ${escapeHtml(heldHrs)} hours`,
    `\uD83D\uDCC9 Max against: ${escapeHtml(mae)}`,
    `\uD83D\uDCC8 Max in favour: ${escapeHtml(mfe)}`,
    `\u2B50 Signal score: ${escapeHtml(String(trade.score))}`,
  ];

  // Result-specific context
  if (isWin) {
    parts.push(``, `\uD83C\uDF7E <b>Target hit.</b> ${rVal !== null ? `Made ${rVal}x the risk. ` : ""}Setup played out exactly as planned.`);
  } else if (isLoss) {
    parts.push(``, `\uD83D\uDEE1\uFE0F <b>Stop did its job.</b> Loss capped. Capital protected for the next setup.`);
  } else if (reason === "FORCE CLOSE") {
    parts.push(``, `\u23F1\uFE0F <b>Force closed.</b> No progress after ${heldHrs}hrs. Freed capital for better setups.`);
  } else if (reason === "PENDING_EXPIRED") {
    parts.push(``, `\u231B <b>Order expired.</b> Entry level never reached. No capital at risk.`);
  }

  // Instagram line — only on wins and losses
  if (isWin || isLoss) {
    parts.push(
      ``,
      `\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014`,
      `\uD83D\uDCF8 <i>Signal by @tradesfordummies</i>`
    );
  }

  return lines(parts);
}

// ── Trade management helpers ─────────────────────────────────────
function cooldown(asset, alerts, market) {
  // Check alerts for same asset+market combination
  const last = [...alerts].reverse().find(x => x.asset === asset && x.market === market);
  if (!last) return false;
  const cooldownHrs = market === "CRYPTO" ? CRYPTO_COOLDOWN : market === "LSE" ? LSE_COOLDOWN : US_COOLDOWN;
  const inCooldown = hoursAgo(last.sentAt) < cooldownHrs;
  if (inCooldown) log(`⏳ ${asset} in cooldown — last alert ${hoursAgo(last.sentAt).toFixed(1)}h ago`);
  return inCooldown;
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
  return trades.filter(t => t.status === "FILLED" && t.outcome === "OPEN").reduce((sum, t) => sum + (t.riskFraction || 0), 0);
}

function progressToTarget(trade, livePrice) {
  const denom = trade.tp - trade.entry;
  if (!Number.isFinite(livePrice) || !Number.isFinite(denom) || denom <= 0) return 0;
  return (livePrice - trade.entry) / denom;
}

function shouldReplaceTrade(newSignal, currentTrade, livePrice) {
  if (!currentTrade || !Number.isFinite(livePrice)) return false;
  const progress = progressToTarget(currentTrade, livePrice);
  const stale    = hoursAgo(currentTrade.filledAt || currentTrade.sentAt) > REPLACEMENT_STALE_HOURS;
  return newSignal.score >= (currentTrade.score || 0) + REPLACEMENT_SCORE_GAP &&
    progress < REPLACEMENT_PROTECT_TP_PROGRESS &&
    (stale || progress < REPLACEMENT_STALL_PROGRESS);
}

function shouldForceClose(trade, livePrice) {
  if (!Number.isFinite(livePrice)) return false;
  return hoursAgo(trade.filledAt || trade.sentAt) > FORCE_CLOSE_HOURS &&
    progressToTarget(trade, livePrice) < FORCE_CLOSE_PROGRESS;
}

function getRiskFractionForSignal(signal) {
  const base = BASE_RISK_PER_TRADE * (signal.score >= 85 ? 1.5 : signal.score >= 78 ? 1.2 : 1.0);
  return ["ASTS","IONQ","AVAV"].includes(signal.asset) ? base * 0.7 : base;
}

function calculatePositionSize(signal) {
  const riskFraction = getRiskFractionForSignal(signal);
  const riskPerUnit  = signal.entry - signal.sl;
  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) return 0;
  return (ACCOUNT_BALANCE * riskFraction) / riskPerUnit;
}

function pickBestPerMarket(results) {
  const best = {};
  for (const s of results.sort((a, b) => b.score - a.score)) {
    if (!best[s.market]) best[s.market] = s;
  }
  return Object.values(best);
}

function updateTradeExcursion(trade, livePrice) {
  if (!Number.isFinite(livePrice)) return;
  const adverse   = Math.max(0, (trade.entry - livePrice) / trade.entry);
  const favorable = Math.max(0, (livePrice - trade.entry) / trade.entry);
  if (!Number.isFinite(trade.maePct) || adverse   > trade.maePct) trade.maePct = adverse;
  if (!Number.isFinite(trade.mfePct) || favorable > trade.mfePct) trade.mfePct = favorable;
}

async function closeTrade(trades, trade, closePrice, reason) {
  trade.closePrice = closePrice;
  trade.closedAt   = nowIso();
  trade.status     = "CLOSED";
  trade.outcome    = reason;
  const riskPerUnit = trade.entry - trade.sl;
  trade.realizedR   = Number.isFinite(closePrice) && Number.isFinite(riskPerUnit) && riskPerUnit > 0
    ? (closePrice - trade.entry) / riskPerUnit : null;
  await safeRun(`telegramClose${trade.asset}`, () => send(buildCloseMessage(trade, reason, closePrice)));
  await saveTrades(trades);
}

// ── Trade management ─────────────────────────────────────────────
async function manageTrades() {
  const trades = await loadTrades();
  let changed = false;

  for (const trade of trades) {
    if (shuttingDown) break;
    const livePrice = await fetchLivePrice(trade.asset, trade.market);
    if (!Number.isFinite(livePrice)) continue;

    if (trade.status === "PENDING") {
      const ageHours = hoursAgo(trade.sentAt);
      const expiry   = trade.market === "CRYPTO" ? CRYPTO_PENDING_EXPIRY_HRS : trade.market === "LSE" ? PENDING_EXPIRY_HOURS_LSE : PENDING_EXPIRY_HOURS_US;
      const filled   = trade.entryType === "MARKET BUY" ? true : livePrice <= trade.entry * 1.002;
      const invalid  = livePrice <= trade.sl;
      const drifted  = trade.entryType === "LIMIT BUY" && livePrice > trade.entry * 1.04;

      if (filled) {
        trade.status = "FILLED"; trade.outcome = "OPEN";
        trade.fillPrice = livePrice; trade.filledAt = nowIso();
        trade.maePct = 0; trade.mfePct = 0; changed = true;
        await safeRun(`fill${trade.asset}`, () => send(buildFillMessage(trade, livePrice)));
        continue;
      }
      if (invalid) {
        trade.status = "CANCELLED"; trade.outcome = "STRUCTURE_INVALID";
        trade.closedAt = nowIso(); trade.closePrice = livePrice; changed = true;
        await safeRun(`invalid${trade.asset}`, () => send(buildCloseMessage(trade, "STRUCTURE_INVALID", livePrice)));
        continue;
      }
      if (drifted) {
        trade.status = "CANCELLED"; trade.outcome = "DRIFTED_TOO_FAR";
        trade.closedAt = nowIso(); trade.closePrice = livePrice; changed = true;
        await safeRun(`drift${trade.asset}`, () => send(buildCloseMessage(trade, "DRIFTED_TOO_FAR", livePrice)));
        continue;
      }
      if (ageHours > expiry) {
        trade.status = "CANCELLED"; trade.outcome = "PENDING_EXPIRED";
        trade.closedAt = nowIso(); trade.closePrice = livePrice; changed = true;
        await safeRun(`expired${trade.asset}`, () => send(buildCloseMessage(trade, "PENDING_EXPIRED", livePrice)));
        continue;
      }
    }

    if (trade.status === "FILLED" && trade.outcome === "OPEN") {
      updateTradeExcursion(trade, livePrice);
      changed = true;
      if (livePrice <= trade.sl) { await closeTrade(trades, trade, livePrice, "STOP LOSS");   continue; }
      if (livePrice >= trade.tp) { await closeTrade(trades, trade, livePrice, "TAKE PROFIT"); continue; }
      if (shouldForceClose(trade, livePrice)) { await closeTrade(trades, trade, livePrice, "FORCE CLOSE"); continue; }
    }
  }

  if (changed) await saveTrades(trades);
}

// ── Scan ─────────────────────────────────────────────────────────
async function scan() {
  const alerts  = await loadAlerts();
  const trades  = await loadTrades();
  const results = [];

  async function processAsset(asset, market, fetcher) {
    if (cooldown(asset, alerts, market)) return;
    if (trades.some(t => t.asset === asset && (t.status === "PENDING" || (t.status === "FILLED" && t.outcome === "OPEN")))) return;
    const candles = await fetcher(asset);
    const signal  = analyse(asset, candles, market);
    if (!signal) return;
    if (signal.score < MIN_GLOBAL_SCORE) return;
    if (signal.score < minScoreForMarket(signal.market)) return;
    results.push(signal);
  }

  // Crypto: all week during window
  if (shouldScanCrypto()) {
    await mapWithConcurrency(CRYPTO_PAIRS, MAX_CONCURRENT_REQUESTS, asset =>
      processAsset(asset, "CRYPTO", fetchCrypto)
    );
  }

  // Stocks: weekdays only during market hours
  if (shouldScanUS()) {
    await mapWithConcurrency(STOCK_POOL, MAX_CONCURRENT_REQUESTS, asset =>
      processAsset(asset, "US", fetchUSData)
    );
  }
  if (shouldScanLSE()) {
    await mapWithConcurrency(LSE_POOL, MAX_CONCURRENT_REQUESTS, asset =>
      processAsset(asset, "LSE", fetchLSEData)
    );
  }

  return pickBestPerMarket(results);
}

// ── Process signals ──────────────────────────────────────────────
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
        await closeTrade(trades, existingOpenTrade, Number.isFinite(livePrice) ? livePrice : existingOpenTrade.entry, "REPLACED");
      } else { continue; }
    }

    if (countOpenTradesByMarket(trades, signal.market)   >= MAX_POSITIONS[signal.market]) continue;
    if (countPendingTradesByMarket(trades, signal.market) >= 1) continue;

    const riskFraction = getRiskFractionForSignal(signal);
    if (getOpenRiskFraction(trades) + riskFraction > MAX_PORTFOLIO_RISK) continue;

    const size = calculatePositionSize(signal);
    if (!Number.isFinite(size) || size <= 0) continue;

    const sentAt  = nowIso();
    // Dedup window: same asset+market can't fire again within 30 minutes
    const alertId = `${signal.asset}-${signal.market}-${Math.floor(new Date(sentAt).getTime() / (30 * 60000))}`;
    if (alerts.some(a => a.id === alertId)) {
      log(`⏳ Dedup blocked ${signal.asset} — already alerted in this 30-min window`);
      continue;
    }
    // Extra safety — check no pending trade already exists for this asset
    if (trades.some(t => t.asset === signal.asset && t.status === "PENDING")) {
      log(`⏳ Skipping ${signal.asset} — pending trade already exists`);
      continue;
    }

    await safeRun(`signal${signal.asset}`, () => send(buildSignalMessage(signal, size)));

    alerts.push({ id: alertId, asset: signal.asset, market: signal.market, sentAt });
    trades.push({
      id:          `${signal.asset}-${Date.now()}`,
      asset:       signal.asset,
      market:      signal.market,
      setupType:   signal.setupType,
      entryType:   signal.entryType,
      entry:       signal.entry,
      sl:          signal.sl,
      tp:          signal.tp,
      rrPlanned:   signal.rr,
      score:       signal.score,
      volRatio:    signal.volRatio,
      momentum:    signal.momentum,
      regime:      signal.regime,
      sentAt,
      status:      "PENDING",
      outcome:     "OPEN",
      fillPrice:   null,
      closePrice:  null,
      closedAt:    null,
      filledAt:    null,
      maePct:      0,
      mfePct:      0,
      realizedR:   null,
      riskFraction
    });
  }

  await saveAlerts(alerts);
  await saveTrades(trades);
}

// ── Main cycle ───────────────────────────────────────────────────
async function safeCycle() {
  if (running || shuttingDown) return;
  running = true;
  try {
    resetApiUsageIfNewDay();
    await safeRun("btcTrend",         updateBTCTrend);
    await safeRun("qqqTrend",         updateQQQTrend);
    await safeRun("marketAlerts",     checkMarketAlerts);
    await safeRun("dynamicInjection", injectHotCryptoMovers);
    await safeRun("manageTrades",     manageTrades);
    const signals = await withTimeout(safeRun("scan", scan), SCAN_TIMEOUT_MS, "scan");
    if (Array.isArray(signals) && signals.length > 0) {
      await safeRun("processSignals", () => processSignals(signals));
    } else {
      log(`NO VALID SIGNALS — API: TD=${apiUsage.twelvedata} AV=${apiUsage.alphavantage} BTC=${btcTrend}`);
    }
  } catch (err) {
    log("CYCLE ERROR:", err?.message || err);
  } finally {
    running = false;
  }
}

async function cycleLoop() {
  if (shuttingDown) return;
  const started = Date.now();
  await safeCycle();
  const elapsed = Date.now() - started;
  const wait    = elapsed >= SCAN_INTERVAL_MS ? 1000 : SCAN_INTERVAL_MS - elapsed;
  cycleTimer = setTimeout(() => void cycleLoop(), wait);
}

async function refreshLoop() {
  if (shuttingDown) return;
  await safeRun("refreshPools", refreshDynamicPools);
  refreshTimer = setTimeout(() => void refreshLoop(), POOL_REFRESH_INTERVAL_MS);
}

// ── Graceful shutdown ────────────────────────────────────────────
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  ready        = false;
  clearRuntimeTimers();
  log(`🛑 ${signal} received — shutting down`);
  try {
    const [trades, alerts] = await Promise.all([loadTrades(), loadAlerts()]);
    await Promise.all([saveTrades(trades), saveAlerts(alerts)]);
    log("💾 State saved");
  } catch (err) { log("Shutdown error:", err?.message || err); }
  if (server) await new Promise(resolve => { server.close(resolve); setTimeout(resolve, 2000); });
  setTimeout(() => process.exit(signal === "UNCAUGHT_EXCEPTION" ? 1 : 0), SHUTDOWN_EXIT_MS);
}

process.on("unhandledRejection", reason => console.error("UNHANDLED REJECTION:", reason));
process.on("uncaughtException",  async err => {
  console.error("UNCAUGHT EXCEPTION:", err);
  if (fatalTriggered) return;
  fatalTriggered = true;
  await gracefulShutdown("UNCAUGHT_EXCEPTION");
});
process.on("SIGINT",  () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

// ── Boot ─────────────────────────────────────────────────────────
ensureFiles();

server = app.listen(PORT, "0.0.0.0", async () => {
  log(`🚀 Server on port ${PORT}`);
  await safeRun("bootTelegram", () => send(
    "\uD83D\uDE80\uD83D\uDD25 <b>SNIPER V88 LIVE</b>\n" +
    "Telegram: market intel \u2022 open/close \u2022 trade signals only\n" +
    "Pool refresh forced at each market open\n" +
    "Opening window extension limit raised \u2022 Gap-ups now caught\n" +
    "Duplicate signal fix active"
  ));
  await sleep(STARTUP_DELAY_MS);
  await safeRun("initialPools", refreshDynamicPools);
  ready = true;
  log("\u2705 SNIPER V88 READY");
  await safeRun("initialCycle", safeCycle);
  cacheCleanupTimer = setInterval(cleanupCandleCache, CACHE_CLEANUP_MS);
  void cycleLoop();
  void refreshLoop();
});
