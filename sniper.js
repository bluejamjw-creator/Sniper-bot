// SNIPER V92 -- INFRASTRUCTURE STABILIZATION RELEASE
// ----------------------------------------------------------------
// Built from the provided V91 base plus the agreed V92 patch plan.
// Focus: stability, data efficiency, rate control, cache hygiene.
//
// V92 changes:
// - Volume handling rebuilt with valid-volume window + range proxy fallback
// - setupType crash fixed via defensive default initialization
// - Premarket US data forced to Yahoo to reduce TwelveData burn
// - QQQ trend uses Yahoo premarket instead of consuming TD unnecessarily
// - Real TwelveData minute limiter added
// - US scan interval slowed from 60s -> 120s
// - US opening-window cache keys split by session type
// - US stock pool reduced from 25 -> 15 for current API tier
// - Position limits increased to 2 for CRYPTO and US
//
// IMPORTANT:
// The original user paste was truncated before the end of the V91 file.
// This V92 file therefore preserves all visible V91 code exactly where possible,
// and includes clearly marked integration points for the remaining functions.
// If you paste your full V91 source, I can merge these changes into the exact full file.

console.log("ðŸš€ SNIPER V92 STARTING...");

const fs    = require("fs");
const path  = require("path");
const axios = require("axios");
const express = require("express");
const ws    = require("ws");
const { createClient } = require("@supabase/supabase-js");

axios.defaults.timeout = 15000;

const app  = express();
const PORT = process.env.PORT || 3000;

app.get("/",       (_req, res) => res.status(200).send("SNIPER V92 alive"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime(), running, ready, shuttingDown }));
app.get("/ready",  (_req, res) => (ready && !shuttingDown) ? res.status(200).send("ready") : res.status(503).send("not ready"));

// â”€â”€ Environment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const BOT_TOKEN             = process.env.BOT_TOKEN             || "";
const CHAT_ID               = process.env.CHAT_ID               || "";
const CHANNEL_ID            = process.env.CHANNEL_CHAT_ID       || "";
const TWELVE_DATA_API_KEY   = process.env.TWELVE_DATA_API_KEY   || "";
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY || "";
const FINNHUB_API_KEY       = process.env.FINNHUB_API_KEY       || "";
const COINGECKO_API_KEY     = process.env.COINGECKO_API_KEY     || "";
const SUPABASE_URL          = process.env.SUPABASE_URL          || "";
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY  || "";

const supabaseEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      realtime: { transport: ws }
    })
  : null;

if (supabaseEnabled) {
  console.log(`âœ… Supabase enabled -- ${SUPABASE_URL}`);
} else {
  console.log("âš ï¸ Supabase DISABLED -- using local JSON (check SUPABASE_URL and SUPABASE_SERVICE_KEY)");
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILES    = {
  alerts: path.join(DATA_DIR, "alerts.json"),
  trades: path.join(DATA_DIR, "trades.json")
};

// â”€â”€ Core constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ACCOUNT_BALANCE     = 10000;
const BASE_RISK_PER_TRADE = 0.01;
const MAX_PORTFOLIO_RISK  = 0.05;

const ENABLE_CRYPTO = true;
const ENABLE_US     = true;
const ENABLE_LSE    = true;

const SCAN_INTERVAL_MS         = 120000; // V92: slowed from 60s to reduce redundant rescans
const POOL_REFRESH_INTERVAL_MS = 3600000;
const MAX_CONCURRENT_REQUESTS  = 2;
const STARTUP_DELAY_MS         = 5000;
const REQUEST_DELAY_MS         = 250;
const SCAN_TIMEOUT_MS          = 55000;
const SHUTDOWN_EXIT_MS         = 5000;
const CACHE_TTL_MS             = 4 * 60 * 1000;
const CACHE_CLEANUP_MS         = 10 * 60 * 1000;
const MAX_SIGNAL_AGE_MINUTES   = 2;

const CRYPTO_COOLDOWN = 2;
const US_COOLDOWN     = 4;
const LSE_COOLDOWN    = 6;

const BREAKOUT_LOOKBACK = 10;
const MIN_RR            = 1.5;
const TARGET_R          = 1.5;

// â”€â”€ Thresholds â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CRYPTO_15M_MIN_MOMENTUM    = 0.003;
const CRYPTO_15M_BREAKOUT_VOL    = 1.60;
const CRYPTO_15M_PULLBACK_VOL    = 1.20;
const CRYPTO_15M_EXTENSION_LIMIT = 0.08;
const CRYPTO_15M_BREAKOUT_DIST   = 0.03;
const CRYPTO_15M_MIN_PULLBACK    = 0.005;
const CRYPTO_15M_MAX_MOMENTUM    = 0.06;
const CRYPTO_PENDING_EXPIRY_HRS  = 2;

const US_BREAKOUT_VOL_STD    = 1.40;
const US_PULLBACK_VOL_STD    = 1.20;
const EXTENSION_LIMIT_US_STD = 0.12;
const BREAKOUT_DIST_US_STD   = 0.04;
const MOMENTUM_CAP_US_STD    = 0.08;
const MIN_US_MOMENTUM        = 0;
const MIN_PULLBACK_MOM_US    = 0.002;

const US_BREAKOUT_VOL_HB    = 1.20;
const US_PULLBACK_VOL_HB    = 1.10;
const EXTENSION_LIMIT_HB    = 0.20;
const EXTENSION_LIMIT_HB_OW = 0.35;
const BREAKOUT_DIST_HB      = 0.12;
const MOMENTUM_CAP_HB       = 0.12;
const MOMENTUM_CAP_HB_OW    = 0.20;
const MIN_US_SCORE_HB       = 74;

const LSE_BREAKOUT_VOL     = 1.05;
const LSE_PULLBACK_VOL     = 1.05;
const BREAKOUT_DIST_LSE    = 0.025;
const EXTENSION_LIMIT_LSE  = 0.06;
const MOMENTUM_CAP_LSE     = 0.04;
const MIN_LSE_MOMENTUM     = 0.0025;
const MIN_PULLBACK_MOM_LSE = 0.0025;

const STOCK_MOMENTUM_OVERRIDE_ENABLED = true;
const STOCK_OVERRIDE_MIN_MOMENTUM     = 0.015;
const STOCK_OVERRIDE_MIN_VOL          = 1.40;
const STOCK_OVERRIDE_MAX_DISTANCE     = 0.025;

const MIN_GLOBAL_SCORE = 74;
const MIN_CRYPTO_SCORE = 76;
const MIN_US_SCORE     = 76;
const MIN_LSE_SCORE    = 64;

const PENDING_EXPIRY_HOURS_US  = 12;
const PENDING_EXPIRY_HOURS_LSE = 24;
const MIN_CANDLES              = 60;
const ATR_PERIOD               = 14;
const ATR_PULLBACK_MULTIPLIER  = 1.2;
const ATR_BREAKOUT_MULTIPLIER  = 1.5;
const ATR_IGNITION_MULTIPLIER  = 1.8;

const REPLACEMENT_SCORE_GAP           = 6;
const REPLACEMENT_STALE_HOURS         = 3;
const REPLACEMENT_STALL_PROGRESS      = 0.3;
const REPLACEMENT_PROTECT_TP_PROGRESS = 0.7;
const FORCE_CLOSE_HOURS               = 4;
const FORCE_CLOSE_PROGRESS            = 0.2;

const MAX_POSITIONS = { CRYPTO: 2, US: 2, LSE: 1 }; // V92

const HIGH_BETA_STOCKS = new Set([
  "ASTS","RKLB","LUNR","IONQ","OKLO","SMR","AVAV","ACHR",
  "MSTR","COIN","PLTR","CRWD","MARA","RIOT","CLSK","TSLA",
  "NVDA","AMD","SMCI","SOUN","PTON","UPST","OPEN","HOOD"
]);

function isHighBeta(symbol) { return HIGH_BETA_STOCKS.has(symbol); }

const API_LIMITS = { twelvedata: 700, alphavantage: 20 };
let apiUsage     = { twelvedata: 0, alphavantage: 0, resetDay: -1 };
let apiRotateIdx = 0;
let finnhubBlockedUntil = 0;

const REGIME_OVERRIDE_MIN_VOL      = 1.6;
const REGIME_OVERRIDE_MIN_MOMENTUM = 0.010;

const crypto24hrCache = new Map();
const CRYPTO_24HR_TTL = 15 * 60 * 1000;

const DYNAMIC_INJECTION_THRESHOLD = 5;
const DYNAMIC_INJECTION_TTL_MS    = 2 * 60 * 60 * 1000;
const dynamicInjections           = new Map();

let lastNarrativeState = { sectors: "", stockMovers: "", cryptoMovers: "" };

const SECTOR_SYMBOLS = {
  AI:         ["NVDA","PLTR","AMD","SMCI","MSFT","META","GOOGL","IONQ","CRWD","ANET"],
  GOLD:       ["NEM","GOLD","AEM","WPM","KGC","SIL"],
  SILVER:     ["SIL","WPM","PAAS","AG"],
  CRYPTO:     ["COIN","MSTR","RIOT","CLSK"],
  ENERGY:     ["XOM","CVX","SLB","HAL","MPC"],
  DEFENSE:    ["LMT","RTX","NOC","GD","AVAV"],
  ROBOTICS:   ["ROK","ISRG","TER"],
  NUCLEAR:    ["CCJ","NNE","SMR","UUUU","DNN","OKLO"],
  UK_BANKS:   ["BARC.L","LLOY.L","NWG.L","STAN.L"],
  UK_ENERGY:  ["SHEL.L","BP.L"],
  UK_MINERS:  ["RIO.L","GLEN.L","AAL.L"],
  UK_DEFENSE: ["BA.L"],
  UK_TELCO:   ["VOD.L"]
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

const STATIC_CRYPTO_FALLBACK = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","AVAXUSDT",
  "LINKUSDT","NEARUSDT","RENDERUSDT","SUIUSDT","TONUSDT",
  "ONDOUSDT","ARBUSDT","OPUSDT","INJUSDT","TIAUSDT",
  "STRKUSDT","JUPUSDT","FETUSDT","AKTUSDT","EIGENUSDT"
];

const STATIC_STOCK_FALLBACK = [
  "NVDA","PLTR","AMD","ASTS","IONQ","MSFT","META",
  "AMZN","APP","MSTR","COIN","QQQ","SMH","AVGO",
  "VRT","CRWD","AMAT","GEV","AVAV","OKLO","RKLB",
  "LUNR","ETN","ANET"
];

const LSE_POOL = [
  "RR.L","BA.L","SHEL.L","BARC.L","LLOY.L",
  "NWG.L","BP.L","RIO.L","GLEN.L","AAL.L",
  "TSCO.L","VOD.L","LSEG.L","STAN.L","PRU.L"
];

const CLEAN_TICKER = /^[A-Z]{1,5}$/;
const OTC_SUFFIXES = ["F","Y","PK"];

let STOCK_POOL   = [...new Set(STATIC_STOCK_FALLBACK)];
let CRYPTO_PAIRS = [...STATIC_CRYPTO_FALLBACK];
let HOT_SECTORS  = [];

let running         = false;
let refreshingPools = false;
let shuttingDown    = false;
let ready           = false;
let fatalTriggered  = false;
let btcTrend        = "neutral";
let cycleCount      = 0;
let lastSignalTime    = 0;
let lastWatchlistTime = Date.now();
let lastWatchlistKey  = "";

let _alertsCache = null;
let _tradesCache = null;

async function loadAlertsCached() {
  if (_alertsCache !== null) return _alertsCache;
  _alertsCache = await loadAlerts();
  return _alertsCache;
}

async function loadTradesCached() {
  if (_tradesCache !== null) return _tradesCache;
  _tradesCache = await loadTrades();
  return _tradesCache;
}

async function saveAlertsCached(alerts) {
  _alertsCache = alerts;
  await saveAlerts(alerts);
}

async function saveTradesCached(trades) {
  _tradesCache = trades;
  await saveTrades(trades);
}

let qqqTrend        = "neutral";
let marketWasOpen   = { CRYPTO: false, US: false, LSE: false };

const candleCache     = new Map();
let cacheCleanupTimer = null;
let cycleTimer        = null;
let refreshTimer      = null;
let server            = null;

// V92: real TD minute limiter
let tdMinuteWindow = {
  minute: -1,
  count: 0
};

function canUseTwelveData() {
  const nowMinute = Math.floor(Date.now() / 60000);
  if (tdMinuteWindow.minute !== nowMinute) {
    tdMinuteWindow.minute = nowMinute;
    tdMinuteWindow.count = 0;
  }
  return tdMinuteWindow.count < 7;
}

function markTwelveDataUse() {
  tdMinuteWindow.count++;
}

function nowIso()         { return new Date().toISOString(); }
function log(...args)     { console.log(`[${nowIso()}]`, ...args); }
function sleep(ms)        { return new Promise(r => setTimeout(r, ms)); }
async function throttle() { await sleep(REQUEST_DELAY_MS); }
function dedup(arr)       { return [...new Set(arr.filter(Boolean))]; }
function avg(arr)         { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

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
    catch (e) { if (i === retries) throw e; await sleep(delay * Math.pow(2,i)); }
  }
}

async function withTimeout(promise, ms, label) {
  let timeout;
  const timer = new Promise((_,reject) => { timeout = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms); });
  try { return await Promise.race([promise, timer]); }
  finally { clearTimeout(timeout); }
}

async function safeRun(name, fn) {
  try { return await fn(); }
  catch (err) { log(`SAFE RUN ERROR (${name}):`, err?.message||err); return null; }
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
  for (const [key,value] of candleCache.entries()) {
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

function getUkNowParts() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday:"short", hour:"2-digit", minute:"2-digit", hour12: false
  });
  const map = {};
  for (const p of fmt.formatToParts(new Date())) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return map;
}

function getUkDayIndex() {
  const map = { Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6 };
  return map[getUkNowParts().weekday] ?? 0;
}

function getUkMinutes() {
  const { hour, minute } = getUkNowParts();
  return Number(hour)*60 + Number(minute);
}

function isWeekend()  { const d = getUkDayIndex(); return d===0||d===6; }
function isWeekday()  { return !isWeekend(); }

function shouldScanCrypto()       { return ENABLE_CRYPTO && isCryptoWindowOpen(); }
function shouldScanUS()           { return ENABLE_US  && isWeekday() && isUSMarketOpen(); }
function shouldScanLSE()          { return ENABLE_LSE && isWeekday() && isLSEMarketOpen(); }
function shouldSendStockAlerts()  { return isWeekday() && (isUSMarketOpen() || isLSEMarketOpen()); }
function shouldSendCryptoAlerts() { return isCryptoWindowOpen(); }

function isMarketOpen(market) {
  const mins = getUkMinutes();
  if (market === "CRYPTO") return mins >= 360 && mins < 1320;
  if (isWeekend()) return false;
  if (market === "US")  return mins >= 870 && mins < 1260;
  if (market === "LSE") return mins >= 480 && mins < 990;
  return false;
}

function isCryptoWindowOpen() { return true; }
function isUSMarketOpen()     { return isMarketOpen("US"); }
function isLSEMarketOpen()    { return isMarketOpen("LSE"); }

function isUSOpeningWindow() {
  if (isWeekend()) return false;
  const m = getUkMinutes();
  return m >= 870 && m < 960;
}

function resetApiUsageIfNewDay() {
  const day = new Date().getUTCDate();
  if (apiUsage.resetDay !== day) {
    apiUsage = { twelvedata:0, alphavantage:0, resetDay:day };
    apiRotateIdx = 0;
    log("ðŸ”„ API usage reset");
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
  finnhubBlockedUntil = Date.now() + minutes*60*1000;
  log(`âš ï¸ Finnhub blocked ${minutes} mins`);
}

async function safeRequest(fn, label = "request") {
  try {
    await throttle();
    return await fn();
  } catch (e) {
    const msg = e?.message||"Unknown";
    if ((msg.includes("429")||e?.response?.status===429) && label.toLowerCase().includes("finnhub")) blockFinnhub();
    log(`âš ï¸ ${label} failed: ${msg}`);
    return null;
  }
}

async function loadAlerts() {
  if (!supabaseEnabled) return loadLocal(FILES.alerts, []);
  try {
    const { data, error } = await retry(() =>
      supabase.from("alerts").select("*").order("sentAt",{ascending:false}).limit(1000)
    );
    if (error) {
      log(`âŒ Supabase loadAlerts error: ${error.message} -- falling back to local`);
      return loadLocal(FILES.alerts, []);
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    log(`âŒ Supabase loadAlerts exception: ${e.message} -- falling back to local`);
    return loadLocal(FILES.alerts, []);
  }
}

async function loadTrades() {
  if (!supabaseEnabled) return loadLocal(FILES.trades, []);
  try {
    const { data, error } = await retry(() =>
      supabase.from("trades").select("*").order("sentAt",{ascending:false}).limit(1000)
    );
    if (error) {
      log(`âŒ Supabase loadTrades error: ${error.message} -- falling back to local`);
      return loadLocal(FILES.trades, []);
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    log(`âŒ Supabase loadTrades exception: ${e.message} -- falling back to local`);
    return loadLocal(FILES.trades, []);
  }
}

async function saveAlerts(alerts) {
  const b = Array.isArray(alerts) ? alerts.slice(-1000) : [];
  saveLocal(FILES.alerts, b);
  if (!supabaseEnabled) return;
  try {
    const { error } = await retry(() => supabase.from("alerts").upsert(b, { onConflict: "id" }));
    if (error) log(`âŒ Supabase saveAlerts error: ${error.message} (code: ${error.code})`);
    else log(`âœ… Supabase alerts saved (${b.length} records)`);
  } catch (e) {
    log(`âŒ Supabase saveAlerts exception: ${e.message}`);
  }
}

async function saveTrades(trades) {
  const b = Array.isArray(trades) ? trades.slice(-1000) : [];
  saveLocal(FILES.trades, b);
  if (!supabaseEnabled) return;
  try {
    const { error } = await retry(() => supabase.from("trades").upsert(b, { onConflict: "id" }));
    if (error) log(`âŒ Supabase saveTrades error: ${error.message} (code: ${error.code})`);
    else log(`âœ… Supabase trades saved (${b.length} records)`);
  } catch (e) {
    log(`âŒ Supabase saveTrades exception: ${e.message}`);
  }
}

async function sendPrivate(msg) {
  if (!BOT_TOKEN || !CHAT_ID) { log(msg); return; }
  try {
    await retry(() => axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID, text: msg, parse_mode: "HTML"
    }, { timeout: 10000 }));
  } catch (e) { log(`TELEGRAM PRIVATE ERROR: ${e.message}`); }
}

async function sendChannel(msg) {
  if (!BOT_TOKEN || !CHANNEL_ID) return;
  try {
    await retry(() => axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHANNEL_ID, text: msg, parse_mode: "HTML"
    }, { timeout: 10000 }));
  } catch (e) { log(`TELEGRAM CHANNEL ERROR: ${e.message}`); }
}

async function sendBoth(msg) {
  await sendPrivate(msg);
  await sleep(300);
  await sendChannel(msg);
}

function calculateATR(candles, period = ATR_PERIOD) {
  if (!candles || candles.length < period+1) return null;
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i], prevClose = candles[i-1].close;
    if (!Number.isFinite(high)||!Number.isFinite(low)||!Number.isFinite(prevClose)) continue;
    trValues.push(Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose)));
  }
  if (trValues.length < period) return null;
  let atr = avg(trValues.slice(0, period));
  for (let i = period; i < trValues.length; i++) atr = ((atr*(period-1))+trValues[i])/period;
  return atr;
}

function getMoveMaturity(candles) {
  if (!candles || candles.length < 35) return "unknown";
  const atrCurrent  = calculateATR(candles.slice(-15), 14);
  const atrBaseline = calculateATR(candles.slice(-35, -15), 14);
  if (!atrCurrent || !atrBaseline || atrBaseline === 0) return "unknown";
  const atrRatio = atrCurrent / atrBaseline;
  if (atrRatio < 1.2) return "base";
  if (atrRatio < 2.0) return "expansion";
  if (atrRatio < 3.2) return "continuation";
  return "climax";
}

function getMomentumProfile(candles) {
  if (!candles || candles.length < 8) return { accelerating: false, decelerating: false };
  const recent = candles.slice(-7);
  const bodies  = recent.map((c,i) => {
    if (i === 0) return 0;
    const prev = recent[i-1].close;
    return prev > 0 ? Math.abs(c.close - prev) / prev : 0;
  }).slice(1);
  const firstHalf  = avg(bodies.slice(0, 3));
  const secondHalf = avg(bodies.slice(3));
  return {
    accelerating: secondHalf > firstHalf * 1.2,
    decelerating: secondHalf < firstHalf * 0.7,
    firstHalf,
    secondHalf
  };
}

function getVolumeProfile(candles) {
  if (!candles || candles.length < 20) return { highVolBars: 0, singleSpike: false };
  const volumes    = candles.slice(-10).map(c => c.volume);
  const avgVol     = avg(candles.slice(-30, -10).map(c => c.volume));
  const highVolBars = volumes.filter(v => v > avgVol*2).length;
  const singleSpike = highVolBars === 1;
  return { highVolBars, singleSpike, avgVol };
}

function getMoveInATRUnits(pctMove, candles) {
  const atrBaseline = calculateATR(candles.slice(-35, -15), 14);
  const price       = candles.at(-1)?.close;
  if (!atrBaseline || !price || price === 0) return 0;
  const atrPct = atrBaseline / price;
  return atrPct > 0 ? Math.abs(pctMove) / atrPct : 0;
}

function isParabolicExhaustion(candles, pct24h, regime = "neutral") {
  if (!candles || candles.length < 35) return false;
  const maturity    = getMoveMaturity(candles);
  const volProfile  = getVolumeProfile(candles);
  const profile     = getMomentumProfile(candles);
  const atrUnits    = getMoveInATRUnits(pct24h, candles);

  let exhaustionScore = 0;
  if (maturity === "climax")            exhaustionScore += 3;
  if (atrUnits > 6)                      exhaustionScore += 3;
  else if (atrUnits > 4)                 exhaustionScore += 2;
  if (volProfile.highVolBars >= 5)       exhaustionScore += 2;
  else if (volProfile.highVolBars >= 3)  exhaustionScore += 1;
  if (profile.decelerating)              exhaustionScore += 1;

  if (exhaustionScore >= 5) {
    log(`ðŸš« Parabolic exhaustion (score=${exhaustionScore} maturity=${maturity} atrUnits=${atrUnits.toFixed(1)} highVolBars=${volProfile.highVolBars})`);
    return true;
  }
  return false;
}

function isFirstPullbackContinuation(candles) {
  if (!candles || candles.length < 15) return false;
  const recent  = candles.slice(-10);
  const volumes = recent.map(c => c.volume);
  const avgVol  = avg(candles.slice(-30, -10).map(c => c.volume));
  if (avgVol === 0) return false;

  let expansionIdx = 0, maxVol = 0;
  for (let i = 0; i < recent.length - 2; i++) {
    if (volumes[i] > maxVol) { maxVol = volumes[i]; expansionIdx = i; }
  }

  if (maxVol < avgVol * 2.5) return false;
  if (expansionIdx > recent.length - 4) return false;

  const postVols    = volumes.slice(expansionIdx+1);
  const taperExists = postVols.some(v => v < maxVol * 0.5);

  const expansionClose = recent[expansionIdx].close;
  const currentClose   = recent.at(-1).close;
  const priceHeld      = currentClose > expansionClose * 0.97;

  return taperExists && priceHeld;
}

function detectGap(candles) {
  if (!candles || candles.length < 3) return { gapped: false, gapPct: 0 };
  const priorClose   = candles.at(-7)?.close;
  const openingClose = candles.at(-5)?.close;
  if (!priorClose || !openingClose || priorClose === 0) return { gapped: false, gapPct: 0 };
  const gapPct = (openingClose - priorClose) / priorClose;
  return { gapped: gapPct >= 0.05, gapPct };
}

function isOpeningDrive(candles) {
  if (!isUSOpeningWindow()) return false;
  const recent = candles.slice(-5);
  if (recent.length < 3) return false;
  const first   = recent[0].close;
  const current = recent.at(-1).close;
  if (!first || first === 0) return false;
  return (current - first) / first > 0.02;
}

function getMomentumMaturityBonus(candles, pct24h, symbol) {
  if (!candles || candles.length < 35) return 0;

  const maturity    = getMoveMaturity(candles);
  const profile     = getMomentumProfile(candles);
  const volProfile  = getVolumeProfile(candles);

  const recentMove = candles.length >= 16
    ? (candles.at(-1).close - candles.at(-16).close) / candles.at(-16).close
    : pct24h;
  const atrUnits = getMoveInATRUnits(recentMove, candles);

  let bonus = 0;
  if (maturity === "expansion")    bonus += 12;
  if (maturity === "continuation") bonus += 8;
  if (maturity === "base")         bonus += 4;
  if (maturity === "climax")       bonus -= 10;

  if (atrUnits > 6)      bonus -= 10;
  else if (atrUnits > 4) bonus -= 5;
  else if (atrUnits > 2) bonus += 4;
  else                   bonus += 8;

  if (volProfile.highVolBars >= 5)      bonus -= 8;
  else if (volProfile.highVolBars >= 3) bonus += 4;
  else if (volProfile.singleSpike)      bonus += 8;

  if (profile.accelerating && maturity !== "climax") bonus += 6;
  if (profile.decelerating)                           bonus -= 4;

  if (isFirstPullbackContinuation(candles)) bonus += 8;

  log(`ðŸ“Š ${symbol} maturity=${maturity} atrUnits=${atrUnits.toFixed(1)} highVol=${volProfile.highVolBars} bonus=${bonus}`);
  return bonus;
}

function classifyRegime(ema20Val, ema50Val, price) {
  if (!Number.isFinite(ema20Val)||!Number.isFinite(ema50Val)||!Number.isFinite(price)||ema50Val===0) return "neutral";
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

function minScoreForMarket(market, symbol = "") {
  if (market === "CRYPTO") return btcTrend === "strong_bull" ? 76 : MIN_CRYPTO_SCORE;
  if (market === "US")     return isHighBeta(symbol) ? MIN_US_SCORE_HB : MIN_US_SCORE;
  return MIN_LSE_SCORE;
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
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, () => worker()));
  return results;
}

async function refresh24hrMomentum() {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/ticker/24hr", { timeout: 12000 })
    );
    if (!Array.isArray(data)) return;
    for (const t of data) {
      if (CRYPTO_PAIRS.includes(t.symbol)) {
        crypto24hrCache.set(t.symbol, { pct: +t.priceChangePercent/100, ts: Date.now() });
      }
    }
    log(`ðŸ“Š 24hr momentum cached for ${crypto24hrCache.size} pairs`);
  } catch (e) { log("24hr cache failed:", e.message); }
}

function get24hrMomentum(symbol) {
  const entry = crypto24hrCache.get(symbol);
  if (!entry || Date.now()-entry.ts > CRYPTO_24HR_TTL) return null;
  return entry.pct;
}

async function injectHotCryptoMovers() {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/ticker/24hr", { timeout: 12000 })
    );
    if (!Array.isArray(data)) return;
    const now = Date.now();
    for (const [sym, ts] of dynamicInjections.entries()) {
      if (now - ts > DYNAMIC_INJECTION_TTL_MS) {
        dynamicInjections.delete(sym);
        if (!STATIC_CRYPTO_FALLBACK.includes(sym)) {
          CRYPTO_PAIRS = CRYPTO_PAIRS.filter(p => p !== sym);
          log(`ðŸ—‘ï¸ Injection expired: ${sym}`);
        }
      }
    }
    const hot = data
      .filter(t =>
        t.symbol.endsWith("USDT") &&
        +t.priceChangePercent >= DYNAMIC_INJECTION_THRESHOLD &&
        !CRYPTO_PAIRS.includes(t.symbol) &&
        +t.quoteVolume > 500000
      )
      .sort((a,b) => +b.priceChangePercent - +a.priceChangePercent)
      .slice(0, 5);
    for (const t of hot) {
      CRYPTO_PAIRS = dedup([...CRYPTO_PAIRS, t.symbol]).slice(0, 30);
      dynamicInjections.set(t.symbol, now);
      log(`ðŸ’‰ Injected: ${t.symbol} +${(+t.priceChangePercent).toFixed(1)}%`);
    }
  } catch (e) { log("Dynamic injection failed:", e.message); }
}

async function getTrendingCoins() {
  const result = await safeRequest(() =>
    axios.get("https://api.coingecko.com/api/v3/search/trending", {
      headers: COINGECKO_API_KEY ? {"x-cg-demo-api-key": COINGECKO_API_KEY} : {},
      timeout: 12000
    }), "CoinGecko"
  );
  if (!result?.data?.coins) return [];
  const pairs = result.data.coins
    .map(c => { const s=(c?.item?.symbol||"").toUpperCase(); return s?`${s}USDT`:null; })
    .filter(Boolean).slice(0, 12);
  log("ðŸª™ CoinGecko trending:", pairs.join(", ")||"none");
  return pairs;
}

async function getTrendingStocks() {
  if (isWeekend() || !canUseFinnhub()) return [...STATIC_STOCK_FALLBACK].slice(0, 15); // V92 reduced
  const result = await safeRequest(() =>
    axios.get("https://finnhub.io/api/v1/stock/symbol", {
      params: {exchange:"US", token:FINNHUB_API_KEY}, timeout:15000
    }), "Finnhub symbols"
  );
  const data = result?.data;
  if (!Array.isArray(data)) return [...STATIC_STOCK_FALLBACK].slice(0, 15);
  const filtered = data
    .filter(s => s.type==="Common Stock" && isCleanTicker(s.symbol) && s.mic && ["XNYS","XNAS"].includes(s.mic))
    .map(s => s.symbol).slice(0, 10);
  const core = ["NVDA","PLTR","AMD","ASTS","IONQ","MSFT","META","AMZN","APP","MSTR","COIN","QQQ","SMH","AVGO","VRT"];
  return dedup([...core, ...filtered]).slice(0, 15); // V92 reduced from 25
}

async function getTopMovers() {
  if (isWeekend() || !canUseFinnhub()) return { syms:[], pcts:{} };
  const candidates = ["NVDA","ASTS","IONQ","PLTR","AMD","COIN","MSTR","AVAV","SMR","OKLO","CRWD","APP","RKLB","LUNR","ACHR","MRNA","INTC","SMCI","TSLA"];
  const movers = [];
  await mapWithConcurrency(candidates, 4, async sym => {
    const result = await safeRequest(() =>
      axios.get("https://finnhub.io/api/v1/quote", {
        params: {symbol:sym, token:FINNHUB_API_KEY}, timeout:8000
      }), `Finnhub quote ${sym}`
    );
    const changePct = result?.data?.dp;
    if (Number.isFinite(changePct) && changePct > 3) {
      movers.push({ sym, changePct });
      log(`ðŸš€ Mover: ${sym} +${changePct.toFixed(2)}%`);
    }
  });
  movers.sort((a,b) => b.changePct - a.changePct);
  return {
    syms: movers.map(m => m.sym),
    pcts: Object.fromEntries(movers.map(m => [m.sym, m.changePct]))
  };
}

async function detectHotSectors() {
  if (isWeekend() || !canUseFinnhub()) return [];
  const result = await safeRequest(() =>
    axios.get("https://finnhub.io/api/v1/news", {
      params: {category:"general", token:FINNHUB_API_KEY}, timeout:12000
    }), "Finnhub news"
  );
  const data = result?.data;
  if (!Array.isArray(data)) return [];
  const text = data.slice(0,60)
    .map(n => ((n.headline||"")+" "+(n.summary||"")).toLowerCase()).join(" ");
  const scores = {};
  for (const [sector, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
    scores[sector] = keywords.filter(kw => text.includes(kw)).length;
  }
  const active = Object.entries(scores)
    .filter(([,s]) => s>=2).sort((a,b) => b[1]-a[1]).map(([s]) => s);
  log("ðŸ§  Hot sectors:", active.join(", ")||"none");
  return active;
}

async function getCryptoMovers() {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/ticker/24hr", { timeout:12000 })
    );
    if (!Array.isArray(data)) return [];
    return data
      .filter(t => CRYPTO_PAIRS.includes(t.symbol) && +t.priceChangePercent >= 5)
      .map(t => ({ symbol:t.symbol, changePct:+t.priceChangePercent }))
      .sort((a,b) => b.changePct - a.changePct)
      .slice(0, 8);
  } catch { return []; }
}

async function getLSEMovers() {
  const movers = [];
  await mapWithConcurrency(LSE_POOL, 2, async sym => {
    try {
      const candles = await fetchLSEData(sym);
      if (!candles || candles.length < 3) return;
      const last = candles.at(-1)?.close;
      const prev = candles.at(-2)?.close;
      if (!last || !prev || prev === 0) return;
      const pct = ((last - prev) / prev) * 100;
      if (pct >= 1.0) {
        movers.push({ sym, changePct: +pct.toFixed(2) });
        log(`ðŸ‡¬ðŸ‡§ LSE mover: ${sym} +${pct.toFixed(1)}%`);
      }
    } catch {}
  });
  return movers.sort((a,b) => b.changePct - a.changePct);
}

// â”€â”€ V92 DATA FETCHERS / PATCHED FUNCTIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function fetchYahooFinanceSeries(symbol, interval = "15m") {
  try {
    const range = interval === "1h" ? "5d" : "5d";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=true`;
    const { data } = await axios.get(url, { timeout: 12000, headers: { "User-Agent": "Mozilla/5.0" } });
    const result = data?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const quote = result?.indicators?.quote?.[0] || {};
    const candles = timestamps.map((ts, i) => ({
      time: new Date(ts * 1000).toISOString(),
      open: +quote.open?.[i],
      high: +quote.high?.[i],
      low: +quote.low?.[i],
      close: +quote.close?.[i],
      volume: +(quote.volume?.[i] || 0)
    })).filter(c => [c.open,c.high,c.low,c.close].every(Number.isFinite));
    return candles;
  } catch (e) {
    log(`Yahoo series failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchTwelveDataSeries(symbol, interval = "15min", outputsize = 120) {
  if (!TWELVE_DATA_API_KEY) return null;
  if (!canUseTwelveData()) {
    log("â›” TD minute limit reached");
    return null;
  }

  try {
    const { data } = await axios.get("https://api.twelvedata.com/time_series", {
      params: {
        symbol,
        interval,
        outputsize,
        apikey: TWELVE_DATA_API_KEY,
        order: "ASC"
      },
      timeout: 12000
    });

    if (!data || data.status === "error" || !Array.isArray(data.values)) {
      log(`TwelveData failed for ${symbol}: ${data?.message || 'invalid response'}`);
      return null;
    }

    apiUsage.twelvedata++;
    markTwelveDataUse(); // V92: mark exactly once after successful response

    return data.values.map(v => ({
      time: new Date(v.datetime).toISOString(),
      open: +v.open,
      high: +v.high,
      low: +v.low,
      close: +v.close,
      volume: +(v.volume || 0)
    })).filter(c => [c.open,c.high,c.low,c.close].every(Number.isFinite));
  } catch (e) {
    log(`TwelveData exception for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchUSData(symbol) {
  const use15min = isUSOpeningWindow();
  const interval = use15min ? "15m" : "1h";
  const sessionType = isUSOpeningWindow() ? "open" : "normal"; // V92 session-aware cache
  const cacheKey = `us_${symbol}_${interval}_${sessionType}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // V92: force Yahoo premarket / outside RTH to avoid TD burn
  const api = isUSMarketOpen()
    ? pickApiForSymbol()
    : "yahoo";

  let candles = null;

  if (api === "twelvedata") {
    candles = await fetchTwelveDataSeries(symbol, use15min ? "15min" : "1h", 120);
  } else {
    candles = await fetchYahooFinanceSeries(symbol, interval);
  }

  if (candles?.length) setCache(cacheKey, candles);
  return candles;
}

async function fetchLSEData(symbol) {
  const cacheKey = `lse_${symbol}_1h`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const candles = await fetchYahooFinanceSeries(symbol, "1h");
  if (candles?.length) setCache(cacheKey, candles);
  return candles;
}

async function updateQQQTrend() {
  const candles = isUSMarketOpen()
    ? await fetchUSData("QQQ")
    : await fetchYahooFinanceSeries("QQQ", "1h");
  if (!candles || candles.length < 50) return;
  const closes = candles.map(c => c.close);
  const ema20Val = ema(closes.slice(-30), 20);
  const ema50Val = ema(closes.slice(-60), 50);
  qqqTrend = classifyRegime(ema20Val, ema50Val, closes.at(-1));
  log(`ðŸ“ˆ QQQ trend = ${qqqTrend}`);
}

// â”€â”€ V92 analyse() skeleton with exact requested fixes integrated â”€â”€
// NOTE: Because the user's original V91 file was truncated before the full
// analyse() body was provided, this function shows the exact V92 patch blocks
// inserted into a safe structure. Replace your existing analyse() with this
// only if your remaining downstream fields match. Otherwise transplant the
// marked blocks into your full V91 analyse() body.

function analyse(asset, candles, market = "US") {
  if (!candles || candles.length < MIN_CANDLES) return null;

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume || 0);

  const lastClose = closes.at(-1);
  const prevClose = closes.at(-2);
  if (!Number.isFinite(lastClose) || !Number.isFinite(prevClose) || prevClose === 0) return null;

  const momentum = (lastClose - prevClose) / prevClose;
  const ema9  = ema(closes.slice(-20), 9);
  const ema20 = ema(closes.slice(-40), 20);
  const ema50 = ema(closes.slice(-80), 50);
  const atr   = calculateATR(candles, ATR_PERIOD);
  const breakoutLevel = Math.max(...highs.slice(-BREAKOUT_LOOKBACK - 1, -1));
  const breakdownLevel = Math.min(...lows.slice(-BREAKOUT_LOOKBACK - 1, -1));
  const breakoutDistance = breakoutLevel > 0 ? (lastClose - breakoutLevel) / breakoutLevel : 0;
  const extensionFromEma20 = ema20 > 0 ? (lastClose - ema20) / ema20 : 0;
  const regime = classifyRegime(ema20, ema50, lastClose);
  const pct24h = market === "CRYPTO" ? (get24hrMomentum(asset) || 0) : 0;

  // â”€â”€ Volume â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // V92 replacement block
  // Yahoo frequently returns partial/zero volume data.
  // Use valid recent bars only.
  // If volume is unavailable, fall back to range expansion proxy.

  const recentVolumeWindow = volumes.slice(-30);
  const validVolumes = recentVolumeWindow.filter(v => v > 0);

  const avgVol = validVolumes.length >= 5
    ? avg(validVolumes.slice(0, -1))
    : 0;

  const lastVol = volumes.at(-1);

  let volRatio;

  if (avgVol > 0 && lastVol > 0) {
    volRatio = lastVol / avgVol;
  } else {
    const recentRanges = highs.slice(-5).map((h, i) => {
      const low = lows.slice(-5)[i];
      const close = closes.slice(-5)[i] || 1;
      return (h - low) / close;
    });

    const baselineRanges = highs.slice(-20, -5).map((h, i) => {
      const low = lows.slice(-20, -5)[i];
      const close = closes.slice(-20, -5)[i] || 1;
      return (h - low) / close;
    });

    const recentRange = avg(recentRanges);
    const baselineRange = avg(baselineRanges);

    volRatio = baselineRange > 0
      ? recentRange / baselineRange
      : 1.0;

    log(`ðŸ“Š ${asset} volume unavailable -> range proxy ${volRatio.toFixed(2)}x`);
  }

  // â”€â”€ Extension limit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const isHB = market === "US" && isHighBeta(asset);
  const extensionLimit = market === "CRYPTO"
    ? CRYPTO_15M_EXTENSION_LIMIT
    : market === "LSE"
      ? EXTENSION_LIMIT_LSE
      : isHB
        ? (isUSOpeningWindow() ? EXTENSION_LIMIT_HB_OW : EXTENSION_LIMIT_HB)
        : EXTENSION_LIMIT_US_STD;

  const gap = detectGap(candles);
  const openingDrive = isOpeningDrive(candles);
  const gapContinuationSignal = market === "US" && isHB && gap.gapped && volRatio >= 3 && openingDrive;

  let setupType = "BREAKOUT_CONTINUATION"; // V92 crash fix

  if (gapContinuationSignal) {
    setupType = "GAP_CONTINUATION";
  }

  if (extensionFromEma20 > extensionLimit) return null;
  if (isParabolicExhaustion(candles, pct24h, regime)) return null;

  let score = 50;
  if (ema9 > ema20 && ema20 > ema50) score += 10;
  if (lastClose > breakoutLevel) score += 12;
  if (momentum > 0) score += 8;
  if (volRatio > 1.2) score += 8;
  score += getMomentumMaturityBonus(candles, pct24h, asset);

  const rr = atr && atr > 0 ? ((lastClose + atr * TARGET_R) - lastClose) / (lastClose - Math.max(ema20, breakdownLevel)) : 0;
  if (rr < MIN_RR) return null;

  const minScore = minScoreForMarket(market, asset);
  if (score < minScore) return null;

  return {
    asset,
    market,
    score: Math.round(score),
    setupType,
    regime,
    momentum,
    volRatio,
    breakoutLevel,
    lastClose,
    ema9,
    ema20,
    ema50,
    atr,
    rr,
    extensionFromEma20,
    gapPct: gap.gapPct || 0,
    ts: nowIso()
  };
}

// â”€â”€ Runtime placeholders for truncated V91 remainder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function refreshPools() {
  if (refreshingPools) return;
  refreshingPools = true;
  try {
    const [coins, stocks, sectors] = await Promise.all([
      getTrendingCoins(),
      getTrendingStocks(),
      detectHotSectors()
    ]);
    CRYPTO_PAIRS = dedup([...STATIC_CRYPTO_FALLBACK, ...coins]).slice(0, 30);
    STOCK_POOL = dedup(stocks).slice(0, 15); // V92 reduced pool
    HOT_SECTORS = sectors;
    log(`âœ… Pools refreshed: crypto=${CRYPTO_PAIRS.length} us=${STOCK_POOL.length} sectors=${HOT_SECTORS.length}`);
  } finally {
    refreshingPools = false;
  }
}

async function runScanCycle() {
  if (shuttingDown) return;
  cycleCount++;
  log(`ðŸ”„ Scan cycle ${cycleCount} starting`);

  await safeRun("refresh24hrMomentum", refresh24hrMomentum);
  await safeRun("injectHotCryptoMovers", injectHotCryptoMovers);
  await safeRun("updateQQQTrend", updateQQQTrend);

  if (shouldScanUS()) {
    await mapWithConcurrency(STOCK_POOL, MAX_CONCURRENT_REQUESTS, async symbol => {
      const candles = await fetchUSData(symbol);
      const signal = analyse(symbol, candles, "US");
      if (signal) log(`ðŸ“£ US signal ${symbol} ${signal.setupType} score=${signal.score} vol=${signal.volRatio?.toFixed?.(2)}`);
    });
  }

  if (shouldScanLSE()) {
    await mapWithConcurrency(LSE_POOL, 2, async symbol => {
      const candles = await fetchLSEData(symbol);
      const signal = analyse(symbol, candles, "LSE");
      if (signal) log(`ðŸ“£ LSE signal ${symbol} ${signal.setupType} score=${signal.score}`);
    });
  }

  cycleTimer = setTimeout(() => {
    safeRun("runScanCycle", () => withTimeout(runScanCycle(), SCAN_TIMEOUT_MS, "scan cycle"));
  }, SCAN_INTERVAL_MS);
}

async function startup() {
  ensureFiles();
  await loadAlertsCached();
  await loadTradesCached();
  await refreshPools();
  ready = true;
  running = true;
  cacheCleanupTimer = setInterval(cleanupCandleCache, CACHE_CLEANUP_MS);
  refreshTimer = setInterval(() => safeRun("refreshPools", refreshPools), POOL_REFRESH_INTERVAL_MS);
  await sleep(STARTUP_DELAY_MS);
  await runScanCycle();
}

function shutdown(sig = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  running = false;
  log(`ðŸ›‘ Shutdown requested: ${sig}`);
  clearRuntimeTimers();
  setTimeout(() => process.exit(0), SHUTDOWN_EXIT_MS);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", err => {
  log(`ðŸ’¥ uncaughtException: ${err?.stack || err?.message || err}`);
  if (!fatalTriggered) {
    fatalTriggered = true;
    shutdown("uncaughtException");
  }
});
process.on("unhandledRejection", err => log(`âš ï¸ unhandledRejection: ${err?.stack || err}`));

server = app.listen(PORT, async () => {
  log(`âœ… SNIPER V92 listening on :${PORT}`);
  await startup();
});
