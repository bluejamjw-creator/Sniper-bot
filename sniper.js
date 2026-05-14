// ================================================================
// SNIPER V91 -- MOMENTUM MATURITY ENGINE
// ----------------------------------------------------------------
// V89 stable base preserved: BST time, named gates, 15-min crypto,
// dynamic injection, market open/close alerts, dedup, graceful shutdown
//
// New in V90 -- complete analysis layer rebuild:
//
// DUAL-MODE SCANNER
//   Mode 1 -- Trend Continuation (crypto, large-cap stocks, ETFs)
//     Standard EMA structure, breakout distance, volume confirmation
//   Mode 2 -- Momentum Runner (HIGH_BETA stocks + dynamically injected)
//     Gap detection, opening range, ATR-relative thresholds,
//     relaxed EMA, adaptive extension limits
//
// MOVE MATURITY ENGINE
//   getMoveMaturity()     -- base / expansion / continuation / climax
//   getMomentumProfile()  -- accelerating vs decelerating candles
//   getVolumeProfile()    -- single breakout spike vs climax volume
//   getMoveInATRUnits()   -- extension relative to volatility not fixed %
//   isParabolicExhaustion() -- hard block when all exhaustion signals align
//   isFirstPullbackContinuation() -- catches Stage 3 entries
//
// SCORING OVERHAUL
//   24hr boost REPLACED with maturity-aware bonus/penalty
//   Climax stage = -15 points
//   Expansion stage = +12 points (best entry)
//   ATR units > 6 = -12 points (too extended)
//   Single volume spike = +8 (early breakout)
//   5+ high vol bars = -8 (climax buying)
//
// HIGH_BETA adaptive thresholds
//   ASTS, RKLB, LUNR, IONQ, OKLO, SMR, AVAV, ACHR, MSTR, COIN
//   Extension limit: 30% opening / 20% normal (vs 18%/10%)
//   Momentum cap: 20% opening / 12% normal
//   Breakout distance: 12% (vs 4%)
//   Score threshold: 74 (vs 80)
//
// GAP_CONTINUATION setup type
//   Gap 5%+ from prior close + opening volume 3x+ average
//   Entry on consolidation break above gap candle high
//   SL below gap candle low
//   Separate from breakout/pullback logic
//
// PARABOLIC EXHAUSTION HARD BLOCK
//   OSMO +200% = exhaustion score 8-9 = blocked
//   SUI +11% building = exhaustion score 0-1 = passes
// ================================================================

console.log("🚀 SNIPER V91 STARTING...");

const fs    = require("fs");
const path  = require("path");
const axios = require("axios");
const express = require("express");
const ws    = require("ws");
const { createClient } = require("@supabase/supabase-js");

axios.defaults.timeout = 15000;

const app  = express();
const PORT = process.env.PORT || 3000;

app.get("/",       (_req, res) => res.status(200).send("SNIPER V91 alive"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime(), running, ready, shuttingDown }));
app.get("/ready",  (_req, res) => (ready && !shuttingDown) ? res.status(200).send("ready") : res.status(503).send("not ready"));

// ── Environment ──────────────────────────────────────────────────
const BOT_TOKEN             = process.env.BOT_TOKEN             || "";
const CHAT_ID               = process.env.CHAT_ID               || ""; // private DM -- receives everything
const CHANNEL_ID            = process.env.CHANNEL_CHAT_ID       || ""; // BareTradeSignals -- receives intel + signals + closes
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
realtime: { transport: ws }  // required for Node 20 -- native WebSocket not available
})
: null;

if (supabaseEnabled) {
  console.log("✅ Supabase enabled -- " + SUPABASE_URL);
} else {
console.log("⚠️ Supabase DISABLED -- using local JSON (check SUPABASE_URL and SUPABASE_SERVICE_KEY)");
}

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

const SCAN_INTERVAL_MS         = 60000;  // 1-min scans -- momentum systems need speed
const POOL_REFRESH_INTERVAL_MS = 3600000;
const MAX_CONCURRENT_REQUESTS  = 2;  // Basic 8 TwelveData plan -- 2 concurrent keeps us under 8/min
const STARTUP_DELAY_MS         = 5000;
const REQUEST_DELAY_MS         = 250;
const SCAN_TIMEOUT_MS          = 55000;  // must be less than scan interval
const SHUTDOWN_EXIT_MS         = 5000;
const CACHE_TTL_MS             = 4 * 60 * 1000;
const CACHE_CLEANUP_MS         = 10 * 60 * 1000;
const MAX_SIGNAL_AGE_MINUTES   = 2;      // freshness protection -- reject stale candles

const CRYPTO_COOLDOWN = 2;
const US_COOLDOWN     = 4;
const LSE_COOLDOWN    = 6;

const BREAKOUT_LOOKBACK = 10;
const MIN_RR            = 1.5;
const TARGET_R          = 1.5;

// ── Thresholds ───────────────────────────────────────────────────
// Crypto 15-min
const CRYPTO_15M_MIN_MOMENTUM    = 0.003; // was 0.008 -- 0.3% threshold, 0.8% was blocking all overnight crypto
const CRYPTO_15M_BREAKOUT_VOL    = 1.60;
const CRYPTO_15M_PULLBACK_VOL    = 1.20;
const CRYPTO_15M_EXTENSION_LIMIT = 0.08;
const CRYPTO_15M_BREAKOUT_DIST   = 0.03;
const CRYPTO_15M_MIN_PULLBACK    = 0.005;
const CRYPTO_15M_MAX_MOMENTUM    = 0.06;
const CRYPTO_PENDING_EXPIRY_HRS  = 2;

// Standard US stocks (Mode 1)
const US_BREAKOUT_VOL_STD    = 1.40;
const US_PULLBACK_VOL_STD    = 1.20;
const EXTENSION_LIMIT_US_STD = 0.12; // was 0.10 -- regular session stocks can extend more
const BREAKOUT_DIST_US_STD   = 0.04;
const MOMENTUM_CAP_US_STD    = 0.08;
const MIN_US_MOMENTUM        = 0;    // no minimum -- EMA structure and setup checks do the filtering
const MIN_PULLBACK_MOM_US    = 0.002; // only pullbacks need some direction

// HIGH_BETA stocks (Mode 2) -- adaptive thresholds
const US_BREAKOUT_VOL_HB    = 1.20; // lower -- these have inherent volume
const US_PULLBACK_VOL_HB    = 1.10;
const EXTENSION_LIMIT_HB    = 0.20;
const EXTENSION_LIMIT_HB_OW = 0.35; // was 0.30 -- open momentum regularly overshoots
const BREAKOUT_DIST_HB      = 0.12; // 12% -- gaps exceed standard 4%
const MOMENTUM_CAP_HB       = 0.12; // 12% normal, 20% opening window
const MOMENTUM_CAP_HB_OW    = 0.20;
const MIN_US_SCORE_HB       = 74;   // lower score floor for high-beta

// LSE -- UK large caps are slow grinders, not momentum runners
const LSE_BREAKOUT_VOL    = 1.05;  // was 1.15
const LSE_PULLBACK_VOL    = 1.05;
const BREAKOUT_DIST_LSE   = 0.025;
const EXTENSION_LIMIT_LSE = 0.06;
const MOMENTUM_CAP_LSE    = 0.04;
const MIN_LSE_MOMENTUM    = 0.0025; // was 0.004 -- UK stocks grind slowly
const MIN_PULLBACK_MOM_LSE = 0.0025;

const STOCK_MOMENTUM_OVERRIDE_ENABLED = true;
const STOCK_OVERRIDE_MIN_MOMENTUM     = 0.015;
const STOCK_OVERRIDE_MIN_VOL          = 1.40;
const STOCK_OVERRIDE_MAX_DISTANCE     = 0.025;

const MIN_GLOBAL_SCORE = 74;
const MIN_CRYPTO_SCORE = 76;
const MIN_US_SCORE     = 76;
const MIN_LSE_SCORE    = 64;  // UK large caps score lower -- needs wider floor

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
const FORCE_CLOSE_HOURS    = 4;
const FORCE_CLOSE_PROGRESS = 0.2;

const MAX_POSITIONS = { CRYPTO: 1, US: 1, LSE: 1 };

// ── HIGH_BETA stock classification ───────────────────────────────
// These assets behave differently -- gap-and-go, high volatility,
// rarely retest EMA20 cleanly. Mode 2 scanner applies to these.
const HIGH_BETA_STOCKS = new Set([
"ASTS","RKLB","LUNR","IONQ","OKLO","SMR","AVAV","ACHR",
"MSTR","COIN","PLTR","CRWD","MARA","RIOT","CLSK","TSLA",
"NVDA","AMD","SMCI","SOUN","PTON","UPST","OPEN","HOOD"
]);

function isHighBeta(symbol) { return HIGH_BETA_STOCKS.has(symbol); }

// ── API rotation ─────────────────────────────────────────────────
const API_LIMITS = { twelvedata: 700, alphavantage: 20 };
let apiUsage     = { twelvedata: 0, alphavantage: 0, resetDay: -1 };
let apiRotateIdx = 0;
let finnhubBlockedUntil = 0;

// ── Regime override ──────────────────────────────────────────────
const REGIME_OVERRIDE_MIN_VOL      = 1.6;  // lowered -- more crypto gets through neutral BTC
const REGIME_OVERRIDE_MIN_MOMENTUM = 0.010; // 1.0% on 15-min candle

// ── 24hr momentum cache (used for maturity detection, not direct scoring) ──
const crypto24hrCache = new Map();
const CRYPTO_24HR_TTL = 15 * 60 * 1000;

// ── Dynamic injection ────────────────────────────────────────────
const DYNAMIC_INJECTION_THRESHOLD = 5;
const DYNAMIC_INJECTION_TTL_MS    = 2 * 60 * 60 * 1000;
const dynamicInjections           = new Map();

// ── Narrative change detection ───────────────────────────────────
let lastNarrativeState = { sectors: "", stockMovers: "", cryptoMovers: "" };

// ── Sector maps ──────────────────────────────────────────────────
const SECTOR_SYMBOLS = {
// US sectors
AI:         ["NVDA","PLTR","AMD","SMCI","MSFT","META","GOOGL","IONQ","CRWD","ANET"],
GOLD:       ["NEM","GOLD","AEM","WPM","KGC","SIL"],
SILVER:     ["SIL","WPM","PAAS","AG"],
CRYPTO:     ["COIN","MSTR","RIOT","CLSK"],
ENERGY:     ["XOM","CVX","SLB","HAL","MPC"],
DEFENSE:    ["LMT","RTX","NOC","GD","AVAV"],
ROBOTICS:   ["ROK","ISRG","TER"],
NUCLEAR:    ["CCJ","NNE","SMR","UUUU","DNN","OKLO"],
// UK sectors
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

// ── Static pools ─────────────────────────────────────────────────
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

// Expanded LSE pool -- 15 stocks covering banks, energy, miners, defense, telco
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

// ── Runtime state ────────────────────────────────────────────────
let running         = false;
let refreshingPools = false;
let shuttingDown    = false;
let ready           = false;
let fatalTriggered  = false;
let btcTrend        = "neutral";
let cycleCount      = 0;
let lastSignalTime    = 0;
let lastWatchlistTime = Date.now(); // init to now -- prevents watchlist spam on boot
let lastWatchlistKey  = "";         // content fingerprint -- prevents identical repeat alerts

// In-memory cache -- persists across scan cycles even when Supabase/local JSON fails
// This is the primary dedup layer; Supabase is secondary persistence
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

// ── Utilities ────────────────────────────────────────────────────
function nowIso()         { return new Date().toISOString(); }
function log(...args)     { console.log([${nowIso()}], ...args); }
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
if (market === "LSE") return \u00a3${value.toFixed(2)};
if (value >= 1) return $${value.toFixed(2)};
return $${value.toFixed(4)};
}

function escapeHtml(v) {
return String(v).replace(/&/g,"&").replace(/</g,"<").replace(/>/g,">");
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
const temp = ${file}.tmp;
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
const timer = new Promise((_,reject) => { timeout = setTimeout(() => reject(new Error(Timeout: ${label})), ms); });
try { return await Promise.race([promise, timer]); }
finally { clearTimeout(timeout); }
}

async function safeRun(name, fn) {
try { return await fn(); }
catch (err) { log(SAFE RUN ERROR (${name}):, err?.message||err); return null; }
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

// ── BST-accurate UK time ─────────────────────────────────────────
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

// ── Named gates ──────────────────────────────────────────────────
function shouldScanCrypto()       { return ENABLE_CRYPTO && isCryptoWindowOpen(); }
function shouldScanUS()           { return ENABLE_US  && isWeekday() && isUSMarketOpen(); }
function shouldScanLSE()          { return ENABLE_LSE && isWeekday() && isLSEMarketOpen(); }
function shouldSendStockAlerts()  { return isWeekday() && (isUSMarketOpen() || isLSEMarketOpen()); }
function shouldSendCryptoAlerts() { return isCryptoWindowOpen(); }

// ── Market hours ─────────────────────────────────────────────────
function isMarketOpen(market) {
const mins = getUkMinutes();
if (market === "CRYPTO") return mins >= 360 && mins < 1320;
if (isWeekend()) return false;
if (market === "US")  return mins >= 870 && mins < 1260;
if (market === "LSE") return mins >= 480 && mins < 990;
return false;
}

function isCryptoWindowOpen() { return true; } // 24/7 -- no time restriction
function isUSMarketOpen()     { return isMarketOpen("US"); }
function isLSEMarketOpen()    { return isMarketOpen("LSE"); }

function isUSOpeningWindow() {
if (isWeekend()) return false;
const m = getUkMinutes();
return m >= 870 && m < 960;
}

// ── API management ───────────────────────────────────────────────
function resetApiUsageIfNewDay() {
const day = new Date().getUTCDate();
if (apiUsage.resetDay !== day) {
apiUsage = { twelvedata:0, alphavantage:0, resetDay:day };
apiRotateIdx = 0;
log("🔄 API usage reset");
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
finnhubBlockedUntil = Date.now() + minutes601000;
log(\u26a0\ufe0f Finnhub blocked ${minutes} mins);
}

async function safeRequest(fn, label = "request") {
try {
await throttle();
return await fn();
} catch (e) {
const msg = e?.message||"Unknown";
if ((msg.includes("429")||e?.response?.status===429) && label.toLowerCase().includes("finnhub")) blockFinnhub();
log(\u26a0\ufe0f ${label} failed: ${msg});
return null;
}
}

// ── Supabase ─────────────────────────────────────────────────────
async function loadAlerts() {
if (!supabaseEnabled) return loadLocal(FILES.alerts, []);
try {
const { data, error } = await retry(() =>
supabase.from("alerts").select("*").order("sentAt",{ascending:false}).limit(1000)
);
if (error) {
log(❌ Supabase loadAlerts error: ${error.message} -- falling back to local);
return loadLocal(FILES.alerts, []);
}
return Array.isArray(data) ? data : [];
} catch (e) {
log(❌ Supabase loadAlerts exception: ${e.message} -- falling back to local);
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
log(❌ Supabase loadTrades error: ${error.message} -- falling back to local);
return loadLocal(FILES.trades, []);
}
return Array.isArray(data) ? data : [];
} catch (e) {
log(❌ Supabase loadTrades exception: ${e.message} -- falling back to local);
return loadLocal(FILES.trades, []);
}
}

async function saveAlerts(alerts) {
const b = Array.isArray(alerts) ? alerts.slice(-1000) : [];
saveLocal(FILES.alerts, b); // always save locally as backup
if (!supabaseEnabled) return;
try {
const { error } = await retry(() => supabase.from("alerts").upsert(b, { onConflict: "id" }));
if (error) {
log(❌ Supabase saveAlerts error: ${error.message} (code: ${error.code}));
} else {
log(✅ Supabase alerts saved (${b.length} records));
}
} catch (e) {
log(❌ Supabase saveAlerts exception: ${e.message});
}
}

async function saveTrades(trades) {
const b = Array.isArray(trades) ? trades.slice(-1000) : [];
saveLocal(FILES.trades, b); // always save locally as backup
if (!supabaseEnabled) return;
try {
const { error } = await retry(() => supabase.from("trades").upsert(b, { onConflict: "id" }));
if (error) {
log(❌ Supabase saveTrades error: ${error.message} (code: ${error.code}));
} else {
log(✅ Supabase trades saved (${b.length} records));
}
} catch (e) {
log(❌ Supabase saveTrades exception: ${e.message});
}
}

// ── Telegram ─────────────────────────────────────────────────────
// sendPrivate(msg)  -- your personal DM only. EVERYTHING goes here.
// sendChannel(msg)  -- BareTradeSignals channel only. Signals + intel + closes.
//
// Call sites:
//   sendPrivate  -- boot, market open/close, fills, errors, system messages
//   sendChannel  -- market intel, trade signals, close results
//   both         -- call sendPrivate then sendChannel where needed

async function sendPrivate(msg) {
if (!BOT_TOKEN || !CHAT_ID) { log(msg); return; }
try {
await retry(() => axios.post(https://api.telegram.org/bot${BOT_TOKEN}/sendMessage, {
chat_id: CHAT_ID, text: msg, parse_mode: "HTML"
}, { timeout: 10000 }));
} catch (e) { log(TELEGRAM PRIVATE ERROR: ${e.message}); }
}

async function sendChannel(msg) {
if (!BOT_TOKEN || !CHANNEL_ID) return; // silently skip if no channel configured
try {
await retry(() => axios.post(https://api.telegram.org/bot${BOT_TOKEN}/sendMessage, {
chat_id: CHANNEL_ID, text: msg, parse_mode: "HTML"
}, { timeout: 10000 }));
} catch (e) { log(TELEGRAM CHANNEL ERROR: ${e.message}); }
}

// Convenience -- sends to BOTH private and channel
async function sendBoth(msg) {
await sendPrivate(msg);
await sleep(300);
await sendChannel(msg);
}

// ── ATR ──────────────────────────────────────────────────────────
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

// ================================================================
// MOVE MATURITY ENGINE -- V90 core innovation
// ================================================================

// Stage classification based on ATR expansion ratio
// Compares recent volatility to historical baseline
function getMoveMaturity(candles) {
if (!candles || candles.length < 35) return "unknown";
const atrCurrent  = calculateATR(candles.slice(-15), 14);
const atrBaseline = calculateATR(candles.slice(-35, -15), 14);
if (!atrCurrent || !atrBaseline || atrBaseline === 0) return "unknown";

const atrRatio = atrCurrent / atrBaseline;

if (atrRatio < 1.2) return "base";          // Stage 1 -- consolidating, flat
if (atrRatio < 2.0) return "expansion";     // Stage 2 -- first leg, best entry
if (atrRatio < 3.2) return "continuation";  // Stage 3 -- healthy trend, good entry
return "climax";                             // Stage 4 -- exhaustion risk, penalise
}

// Is momentum accelerating (candles getting bigger) or decelerating?
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

// How many consecutive bars above 2x average volume? (1 = breakout, 5+ = climax)
function getVolumeProfile(candles) {
if (!candles || candles.length < 20) return { highVolBars: 0, singleSpike: false };
const volumes    = candles.slice(-10).map(c => c.volume);
const avgVol     = avg(candles.slice(-30, -10).map(c => c.volume));
const highVolBars = volumes.filter(v => v > avgVol*2).length;
const singleSpike = highVolBars === 1; // breakout candle only -- early stage
return { highVolBars, singleSpike, avgVol };
}

// How big is the 24hr move measured in ATR units (volatility-adjusted)
function getMoveInATRUnits(pct24h, candles) {
const atrBaseline = calculateATR(candles.slice(-35, -15), 14);
const price       = candles.at(-1)?.close;
if (!atrBaseline || !price || price === 0) return 0;
const atrPct = atrBaseline / price;
return atrPct > 0 ? Math.abs(pct24h) / atrPct : 0;
}

// Hard block: returns true when asset shows exhaustion across multiple signals
// OSMO +200% = exhaustion score 8-9 -> blocked
// SUI +11% building = exhaustion score 0-1 -> passes
function isParabolicExhaustion(candles, pct24h, regime = "neutral") {
if (!candles || candles.length < 35) return false;
const maturity    = getMoveMaturity(candles);
const volProfile  = getVolumeProfile(candles);
const profile     = getMomentumProfile(candles);
const atrUnits    = getMoveInATRUnits(pct24h, candles);

let exhaustionScore = 0;
if (maturity === "climax")            exhaustionScore += 3;
if (atrUnits > 6)                     exhaustionScore += 3;
else if (atrUnits > 4)                exhaustionScore += 2;
if (volProfile.highVolBars >= 5)      exhaustionScore += 2;
else if (volProfile.highVolBars >= 3) exhaustionScore += 1;
if (profile.decelerating)             exhaustionScore += 1;

if (exhaustionScore >= 5) {
log(🚫 Parabolic exhaustion (score=${exhaustionScore} maturity=${maturity} atrUnits=${atrUnits.toFixed(1)} highVolBars=${volProfile.highVolBars}));
return true;
}
return false;
}

// Detects Stage 3 entry: big candle -> consolidation -> continuation
// The most reliable missed entry in the current system
function isFirstPullbackContinuation(candles) {
if (!candles || candles.length < 15) return false;
const recent  = candles.slice(-10);
const volumes = recent.map(c => c.volume);
const avgVol  = avg(candles.slice(-30, -10).map(c => c.volume));
if (avgVol === 0) return false;

// Find the expansion candle -- highest volume in window
let expansionIdx = 0, maxVol = 0;
for (let i = 0; i < recent.length - 2; i++) {
if (volumes[i] > maxVol) { maxVol = volumes[i]; expansionIdx = i; }
}

if (maxVol < avgVol * 2.5)               return false; // No real expansion
if (expansionIdx > recent.length - 4)    return false; // Too recent, no pullback yet

// Volume tapering after expansion = consolidation
const postVols    = volumes.slice(expansionIdx+1);
const taperExists = postVols.some(v => v < maxVol * 0.5);

// Price held above expansion candle open (with tolerance)
const expansionClose = recent[expansionIdx].close;
const currentClose   = recent.at(-1).close;
const priceHeld      = currentClose > expansionClose * 0.97;

return taperExists && priceHeld;
}

// Gap detection: first candle vs prior candle -- did price gap up?
function detectGap(candles) {
if (!candles || candles.length < 3) return { gapped: false, gapPct: 0 };
// In a session open, compare first few candles to prior session
// Use close of candle[n-6] as "prior close" proxy
const priorClose   = candles.at(-7)?.close;
const openingClose = candles.at(-5)?.close; // a few candles in
if (!priorClose || !openingClose || priorClose === 0) return { gapped: false, gapPct: 0 };
const gapPct = (openingClose - priorClose) / priorClose;
return { gapped: gapPct >= 0.05, gapPct };
}

// Opening drive: directional move in first few candles
function isOpeningDrive(candles) {
if (!isUSOpeningWindow()) return false;
const recent = candles.slice(-5);
if (recent.length < 3) return false;
const first   = recent[0].close;
const current = recent.at(-1).close;
if (!first || first === 0) return false;
return (current - first) / first > 0.02;
}

// Maturity-aware score bonus -- REPLACES the old 24hr boost
// Rewards early stage, penalises climax
function getMomentumMaturityBonus(candles, pct24h, symbol) {
if (!candles || candles.length < 35) return 0;

const maturity    = getMoveMaturity(candles);
const profile     = getMomentumProfile(candles);
const volProfile  = getVolumeProfile(candles);

// Change 3: use RECENT 4h move instead of lagging 24hr figure
// 16 x 15-min candles = 4 hours -- measures current expansion quality
const recentMove = candles.length >= 16
? (candles.at(-1).close - candles.at(-16).close) / candles.at(-16).close
: pct24h;
const atrUnits = getMoveInATRUnits(recentMove, candles);

let bonus = 0;

// Stage bonus/penalty
if (maturity === "expansion")    bonus += 12; // Stage 2 -- best entry
if (maturity === "continuation") bonus += 8;  // Stage 3 -- still good
if (maturity === "base")         bonus += 4;  // Stage 1 -- early
if (maturity === "climax")       bonus -= 10; // was -15 -- penalised but not always fatal

// ATR units -- volatility-adjusted extension
if (atrUnits > 6)      bonus -= 10; // was -12
else if (atrUnits > 4) bonus -= 5;  // was -6
else if (atrUnits > 2) bonus += 4;
else                   bonus += 8;

// Volume quality
if (volProfile.highVolBars >= 5)      bonus -= 8;  // Climax buying
else if (volProfile.highVolBars >= 3) bonus += 4;  // Sustained
else if (volProfile.singleSpike)      bonus += 8;  // Single breakout spike -- early

// Acceleration bonus (only reward if not in climax)
if (profile.accelerating && maturity !== "climax") bonus += 6;
if (profile.decelerating)                           bonus -= 4;

// First pullback continuation bonus
if (isFirstPullbackContinuation(candles)) bonus += 8;

log(📊 ${symbol} maturity=${maturity} atrUnits=${atrUnits.toFixed(1)} highVol=${volProfile.highVolBars} bonus=${bonus});
return bonus;
}

// ── Regime ───────────────────────────────────────────────────────
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

// ── 24hr momentum cache ──────────────────────────────────────────
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
log(📊 24hr momentum cached for ${crypto24hrCache.size} pairs);
} catch (e) { log("24hr cache failed:", e.message); }
}

function get24hrMomentum(symbol) {
const entry = crypto24hrCache.get(symbol);
if (!entry || Date.now()-entry.ts > CRYPTO_24HR_TTL) return null;
return entry.pct;
}

// ── Dynamic injection -- silent ───────────────────────────────────
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
log(🗑️ Injection expired: ${sym});
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
log(💉 Injected: ${t.symbol} +${(+t.priceChangePercent).toFixed(1)}%);
}
} catch (e) { log("Dynamic injection failed:", e.message); }
}

// ── CoinGecko ────────────────────────────────────────────────────
async function getTrendingCoins() {
const result = await safeRequest(() =>
axios.get("https://api.coingecko.com/api/v3/search/trending", {
headers: COINGECKO_API_KEY ? {"x-cg-demo-api-key": COINGECKO_API_KEY} : {},
timeout: 12000
}), "CoinGecko"
);
if (!result?.data?.coins) return [];
const pairs = result.data.coins
.map(c => { const s=(c?.item?.symbol||"").toUpperCase(); return s?${s}USDT:null; })
.filter(Boolean).slice(0, 12);
log("🪙 CoinGecko trending:", pairs.join(", ")||"none");
return pairs;
}

// ── Finnhub ──────────────────────────────────────────────────────
async function getTrendingStocks() {
if (isWeekend() || !canUseFinnhub()) return [...STATIC_STOCK_FALLBACK];
const result = await safeRequest(() =>
axios.get("https://finnhub.io/api/v1/stock/symbol", {
params: {exchange:"US", token:FINNHUB_API_KEY}, timeout:15000
}), "Finnhub symbols"
);
const data = result?.data;
if (!Array.isArray(data)) return [...STATIC_STOCK_FALLBACK];
const filtered = data
.filter(s => s.type==="Common Stock" && isCleanTicker(s.symbol) && s.mic && ["XNYS","XNAS"].includes(s.mic))
.map(s => s.symbol).slice(0, 10);
const core = ["NVDA","PLTR","AMD","ASTS","IONQ","MSFT","META","AMZN","APP","MSTR","COIN","QQQ","SMH","AVGO","VRT"];
return dedup([...core, ...filtered]).slice(0, 25);
}

async function getTopMovers() {
if (isWeekend() || !canUseFinnhub()) return { syms:[], pcts:{} };
const candidates = ["NVDA","ASTS","IONQ","PLTR","AMD","COIN","MSTR","AVAV","SMR","OKLO","CRWD","APP","RKLB","LUNR","ACHR","MRNA","INTC","SMCI","TSLA"];
const movers = [];
await mapWithConcurrency(candidates, 4, async sym => {
const result = await safeRequest(() =>
axios.get("https://finnhub.io/api/v1/quote", {
params: {symbol:sym, token:FINNHUB_API_KEY}, timeout:8000
}), Finnhub quote ${sym}
);
const changePct = result?.data?.dp;
if (Number.isFinite(changePct) && changePct > 3) {
movers.push({ sym, changePct });
log(🚀 Mover: ${sym} +${changePct.toFixed(2)}%);
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
log("🧠 Hot sectors:", active.join(", ")||"none");
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

// ── LSE mover scanner ────────────────────────────────────────────
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
log(🇬🇧 LSE mover: ${sym} +${pct.toFixed(1)}%);
}
} catch { /* skip */ }
});
return movers.sort((a,b) => b.changePct - a.changePct);
}

// Group LSE movers by sector for cleaner intel presentation
function getLSESectorSummary(lseMovers) {
const sectorMap = {
"Banks":   ["BARC.L","LLOY.L","NWG.L","STAN.L"],
"Energy":  ["SHEL.L","BP.L"],
"Miners":  ["RIO.L","GLEN.L","AAL.L"],
"Defense": ["BA.L","RR.L"],
"Telco":   ["VOD.L"]
};
const active = [];
for (const [sector, syms] of Object.entries(sectorMap)) {
const moving = lseMovers.filter(m => syms.includes(m.sym));
if (moving.length >= 1) active.push(sector);
}
return active;
}

// ── Watchlist building alert ─────────────────────────────────────
// Fires when assets are building toward a signal but haven't confirmed yet
// Max once per hour, only if content has changed, only if quiet for 90+ mins
async function sendWatchlistAlert(alerts, trades) {
if (isWeekend() && !isCryptoWindowOpen()) return;

// Hard gate -- max once per hour regardless
if (lastWatchlistTime > 0 && Date.now() - lastWatchlistTime < 60 * 60 * 1000) return;

const watching = [];

// Crypto -- check for assets near breakout
if (isCryptoWindowOpen()) {
for (const sym of CRYPTO_PAIRS.slice(0, 15)) {
try {
if (cooldown(sym, alerts, "CRYPTO")) continue;
if (trades.some(t => t.asset===sym && (t.status==="PENDING"||(t.status==="FILLED"&&t.outcome==="OPEN")))) continue;
const candles = await fetchCrypto(sym);
if (!candles || candles.length < 60) continue;
const closes  = candles.map(x=>x.close);
const volumes = candles.map(x=>x.volume||0);
const last    = closes.at(-1);
const ema20v  = ema(closes, 20);
const ema50v  = ema(closes, 50);
const avgVol  = avg(volumes.slice(-21,-1));
const volRat  = avgVol > 0 ? volumes.at(-1)/avgVol : 0;
const distFromEMA = Math.abs(last - ema20v) / ema20v;
const nearEMA     = distFromEMA < 0.025;
const risingEMA   = ema20v > ema50v;
const volBuilding = volRat >= 1.2 && volRat < 1.6;
if (nearEMA && risingEMA && volBuilding) {
const name = sym.replace("USDT","");
watching.push({ label: \uD83E\uDE99 <b>${escapeHtml(name)}</b> \u2014 pullback to EMA, key: name });
}
} catch { /* skip */ }
}
}

// US stocks -- near setups
if (isWeekday() && isUSMarketOpen()) {
for (const sym of STOCK_POOL.slice(0, 12)) {
try {
if (cooldown(sym, alerts, "US")) continue;
if (trades.some(t => t.asset===sym && (t.status==="PENDING"||(t.status==="FILLED"&&t.outcome==="OPEN")))) continue;
const candles = await fetchUSData(sym);
if (!candles || candles.length < 60) continue;
const closes  = candles.map(x=>x.close);
const volumes = candles.map(x=>x.volume||0);
const last    = closes.at(-1);
const ema20v  = ema(closes, 20);
const ema50v  = ema(closes, 50);
const avgVol  = avg(volumes.slice(-21,-1));
const volRat  = avgVol > 0 ? volumes.at(-1)/avgVol : 0;
const distFromEMA = Math.abs(last - ema20v) / ema20v;
const nearEMA     = distFromEMA < 0.02;
const risingEMA   = ema20v > ema50v && last > ema20v;
const volBuilding = volRat >= 1.1 && volRat < 1.4;
if (nearEMA && risingEMA && volBuilding) {
watching.push({ label: \uD83C\uDDFA\uD83C\uDDF8 <b>${escapeHtml(sym)}</b> \u2014 near EMA, building, key: sym });
}
} catch { /* skip */ }
}
}

if (watching.length === 0) return;

// Content dedup -- don't resend if same assets as last time
const contentKey = watching.map(w => w.key).slice(0, 6).join(",");
if (contentKey === lastWatchlistKey) {
log(👀 Watchlist unchanged -- suppressed);
return;
}

lastWatchlistKey  = contentKey;
lastWatchlistTime = Date.now();

const parts = [
\uD83D\uDC40 <b>WATCHLIST BUILDING</b>,
,   `Setups forming \u2014 no confirmed entry yet:`,   
];
parts.push(...watching.slice(0, 5).map(w =>   ${w.label}));
parts.push(``, \uD83D\uDCA1 Entry alert fires when breakout confirms);
await safeRun("watchlistAlert", () => sendBoth(lines(parts)));
log(👀 Watchlist sent -- ${watching.length} setups);
}

// ── Narrative change detection ───────────────────────────────────
function narrativeHasChanged(sectors, stockMovers, cryptoMovers, lseMovers = []) {
const newState = {
sectors:      sectors.join(","),
stockMovers:  stockMovers.slice(0,6).join(","),
cryptoMovers: cryptoMovers.map(c=>c.symbol).join(","),
lseMovers:    lseMovers.map(m=>m.sym).join(",")
};
const changed =
newState.sectors      !== lastNarrativeState.sectors      ||
newState.stockMovers  !== lastNarrativeState.stockMovers  ||
newState.cryptoMovers !== lastNarrativeState.cryptoMovers ||
newState.lseMovers    !== lastNarrativeState.lseMovers;
if (changed) lastNarrativeState = { ...lastNarrativeState, ...newState };
return changed;
}

// ── Narrative alert ──────────────────────────────────────────────
async function sendNarrativeAlert(topMovers, cryptoMovers, stockMoverPcts = {}, lseMovers = []) {
if (!Array.isArray(topMovers))    topMovers    = [];
if (!Array.isArray(cryptoMovers)) cryptoMovers = [];
if (!Array.isArray(lseMovers))    lseMovers    = [];

const parts = ["\uD83E\uDDE0\uD83D\uDD25 <b>MARKET INTEL UPDATE</b>", ""];

if (!isWeekend() && HOT_SECTORS.length > 0) {
// Filter to US-only sectors for this section
const usSectors = HOT_SECTORS.filter(s => !s.startsWith("UK_"));
if (usSectors.length > 0) {
parts.push("<b>Active narratives:</b>");
for (const s of usSectors) {
const syms = (SECTOR_SYMBOLS[s]||[]).slice(0,4).join(", ");
parts.push(  \uD83D\uDCCC <b>${escapeHtml(s)}</b> \u2192 ${escapeHtml(syms)});
}
parts.push("");
}
}

if (!isWeekend() && topMovers.length > 0) {
parts.push("\uD83C\uDDFA\uD83C\uDDF8 <b>Hot stocks right now:</b>");
for (const sym of topMovers.slice(0,5)) {
parts.push(  \uD83D\uDE80 <b>${escapeHtml(sym)}</b> \u2014 gaining momentum);
}
parts.push("");
}

// LSE section -- group by sector for UK personality
if (!isWeekend() && isLSEMarketOpen() && lseMovers.length > 0) {
const activeSectors = getLSESectorSummary(lseMovers);
parts.push("\uD83C\uDDEC\uD83C\uDDE7 <b>FTSE strength building:</b>");
if (activeSectors.length > 0) {
parts.push(  \uD83D\uDCC8 ${activeSectors.join(" \u2022 ")});
}
for (const m of lseMovers.slice(0,4)) {
parts.push(  \uD83D\uDCCA <b>${escapeHtml(m.sym)}</b> +${m.changePct.toFixed(1)}%);
}
parts.push("");
}

if (cryptoMovers.length > 0) {
parts.push("\uD83E\uDE99 <b>Crypto moving right now:</b>");
for (const c of cryptoMovers) {
const sym = c.symbol.replace("USDT","");
const tag = c.changePct >= 15 ? "\uD83D\uDD25 explosive move"
: c.changePct >= 8  ? "\u26A1 strong momentum"
: "\uD83D\uDCC8 building momentum";
parts.push(  \uD83D\uDCCA <b>${escapeHtml(sym)}</b> \u2014 ${tag});
}
parts.push("");
parts.push("\uD83D\uDCA1 Entry alert fires if breakout confirmed on next scan");
}

if (parts.length <= 2) return;
parts.push(\uD83D\uDD0D Scanning ${isWeekend() ? CRYPTO_PAIRS.length+" crypto pairs only" : STOCK_POOL.length+" stocks \u2022 "+CRYPTO_PAIRS.length+" crypto pairs \u2022 "+LSE_POOL.length+" LSE stocks"});
await safeRun("telegramNarrative", () => sendBoth(lines(parts)));
}

// ── Dynamic pool refresh ─────────────────────────────────────────
async function refreshDynamicPools(forceNarrativeAlert = false) {
if (refreshingPools || shuttingDown) { if (refreshingPools) log("Pool refresh skipped"); return; }
refreshingPools = true;
try {
log("🔄 Refreshing pools...");
const trendingCoins = await getTrendingCoins();
CRYPTO_PAIRS = dedup([...STATIC_CRYPTO_FALLBACK, ...trendingCoins]).slice(0, 22);
await refresh24hrMomentum();

if (!isWeekend()) {  
  HOT_SECTORS = await detectHotSectors();  
  const [trendingStocks, topMoversResult, lseMovers] = await Promise.all([  
    getTrendingStocks(),  
    getTopMovers(),  
    isLSEMarketOpen() ? getLSEMovers() : Promise.resolve([])  
  ]);  
  const topMovers      = topMoversResult.syms || [];  
  const stockMoverPcts = topMoversResult.pcts || {};  
  const sectorInjected = [];  
  for (const sector of HOT_SECTORS) {  
    const syms = (SECTOR_SYMBOLS[sector]||[]).filter(isCleanTicker);  
    sectorInjected.push(...syms);  
  }  
  STOCK_POOL = dedup([...trendingStocks, ...topMovers, ...sectorInjected]).slice(0, 25);  
  log(`✅ Pools -- Crypto: ${CRYPTO_PAIRS.length}, Stocks: ${STOCK_POOL.length}, LSE movers: ${lseMovers.length}`);  

  if (shouldSendStockAlerts()) {  
    const cryptoMovers = await getCryptoMovers();  
    if (forceNarrativeAlert || narrativeHasChanged(HOT_SECTORS, topMovers, cryptoMovers, lseMovers)) {  
      await sendNarrativeAlert(topMovers, cryptoMovers, stockMoverPcts, lseMovers);  
    }  
  }  
} else {  
  log(`✅ Weekend -- Crypto: ${CRYPTO_PAIRS.length} pairs`);  
  const cryptoMovers = await getCryptoMovers();  
  if (forceNarrativeAlert || (narrativeHasChanged([],[],cryptoMovers,[]) && shouldSendCryptoAlerts())) {  
    await sendNarrativeAlert([], cryptoMovers);  
  }  
}  

log(`📊 API -- TD: ${apiUsage.twelvedata}/${API_LIMITS.twelvedata}, AV: ${apiUsage.alphavantage}/${API_LIMITS.alphavantage}`);

} finally {
refreshingPools = false;
}
}

// ── Market open/close alerts + forced pool refresh ───────────────────────
async function checkMarketAlerts() {
const checks = [
{ key:"CRYPTO", isOpen:isCryptoWindowOpen },
{ key:"US",     isOpen:isUSMarketOpen     },
{ key:"LSE",    isOpen:isLSEMarketOpen    }
];
for (const { key, isOpen } of checks) {
const nowOpen = isOpen();
if (nowOpen && !marketWasOpen[key]) {
log(🟢 ${key} open -- forcing pool refresh);
await safeRun(poolRefreshOn${key}Open, () => refreshDynamicPools(true));
// Crypto is 24/7 -- no open/close messages needed
if (key !== "CRYPTO") {
const msgs = {
US:  \uD83D\uDFE2\uD83C\uDDFA\uD83C\uDDF8 <b>US MARKET OPEN</b>\n\u23F0 14:30\u201321:00 UK\n\uD83D\uDCE1 QQQ trend: <b>${escapeHtml(qqqTrend.replace("_"," ").toUpperCase())}</b>\n\uD83D\uDD0D ${STOCK_POOL.length} stocks in pool,
LSE: \uD83D\uDFE2\uD83C\uDDEC\uD83C\uDDE7 <b>LSE MARKET OPEN</b>\n\u23F0 08:00\u201316:30 UK\n\uD83D\uDD0D ${LSE_POOL.length} stocks in pool
};
await safeRun(open${key}, () => sendBoth(msgs[key]));
}
}
if (!nowOpen && marketWasOpen[key]) {
log(🔴 ${key} closed);
// Crypto is 24/7 -- no open/close messages needed
if (key !== "CRYPTO") {
const msgs = {
US:  \uD83D\uDD34\uD83C\uDDFA\uD83C\uDDF8 <b>US MARKET CLOSED</b>\n\uD83C\uDFC1 See you at 14:30 UK tomorrow,
LSE: \uD83D\uDD34\uD83C\uDDEC\uD83C\uDDE7 <b>LSE MARKET CLOSED</b>\n\uD83C\uDFC1 See you at 08:00 UK tomorrow
};
await safeRun(close${key}, () => sendBoth(msgs[key]));
}
}
marketWasOpen[key] = nowOpen;
}
}

// ── Data fetching ────────────────────────────────────────────────
async function fetchCrypto(symbol) {
const cacheKey = crypto_15m_${symbol};
const cached   = getCached(cacheKey);
if (cached) return cached;
try {
const { data } = await retry(() =>
axios.get("https://data-api.binance.vision/api/v3/klines", {
params: {symbol, interval:"15m", limit:100}, timeout:12000
})
);
const candles = data.map(k => ({close:+k[4],high:+k[2],low:+k[3],volume:+k[5]}));
setCache(cacheKey, candles);
return candles;
} catch { return null; }
}

async function fetchCrypto1h(symbol) {
const cacheKey = crypto_1h_${symbol};
const cached   = getCached(cacheKey);
if (cached) return cached;
try {
const { data } = await retry(() =>
axios.get("https://data-api.binance.vision/api/v3/klines", {
params: {symbol, interval:"1h", limit:70}, timeout:12000
})
);
const candles = data.map(k => ({close:+k[4],high:+k[2],low:+k[3],volume:+k[5]}));
setCache(cacheKey, candles);
return candles;
} catch { return null; }
}

async function fetchTwelveDataSeries(symbol, interval="1h", outputsize=70) {
if (!TWELVE_DATA_API_KEY) return null;
try {
const { data } = await retry(() =>
axios.get("https://api.twelvedata.com/time_series", {
params: {symbol,interval,outputsize,order:"ASC",apikey:TWELVE_DATA_API_KEY},
timeout:15000
})
);
if (data?.status==="error" || !Array.isArray(data?.values)) return null;
apiUsage.twelvedata++;
return data.values
.map(row => ({close:+row.close,high:+row.high,low:+row.low,volume:+row.volume}))
.filter(x => Number.isFinite(x.close) && Number.isFinite(x.high) && Number.isFinite(x.low));
} catch { return null; }
}

async function fetchAlphaVantageSeries(symbol, interval="60min") {
if (!ALPHA_VANTAGE_API_KEY) return null;
try {
const { data } = await retry(() =>
axios.get("https://www.alphavantage.co/query", {
params: {function:"TIME_SERIES_INTRADAY",symbol,interval,outputsize:"compact",apikey:ALPHA_VANTAGE_API_KEY},
timeout:15000
})
);
const series = data[Time Series (${interval})];
if (!series) return null;
apiUsage.alphavantage++;
return Object.entries(series)
.sort(([a],[b]) => new Date(a)-new Date(b))
.map(([,v]) => ({close:+v["4. close"],high:+v["2. high"],low:+v["3. low"],volume:+v["5. volume"]}))
.filter(x => Number.isFinite(x.close));
} catch { return null; }
}

async function fetchYahooFinanceSeries(symbol, interval="1h") {
const yahooInterval = interval==="15min"?"15m":"1h";
const range         = yahooInterval==="15m"?"5d":"30d";
try {
const { data } = await retry(() =>
axios.get(https://query1.finance.yahoo.com/v8/finance/chart/${symbol}, {
params: {interval:yahooInterval,range,includePrePost:false},
headers: {"User-Agent":"Mozilla/5.0"}, timeout:15000
})
);
const result = data?.chart?.result?.[0];
if (!result) return null;
const q = result.indicators?.quote?.[0];
if (!q) return null;
return (result.timestamp||[])
.map((_,i) => ({close:q.close[i]||0,high:q.high[i]||0,low:q.low[i]||0,volume:q.volume[i]||0}))
.filter(x => Number.isFinite(x.close) && x.close>0);
} catch (e) { log(Yahoo failed ${symbol}:, e.message); return null; }
}

async function fetchUSData(symbol) {
const use15min = isUSOpeningWindow();
const interval = use15min ? "15min" : "1h";
const cacheKey = us_${symbol}_${interval};
const cached   = getCached(cacheKey);
if (cached) return cached;
resetApiUsageIfNewDay();
const api = pickApiForSymbol();
let candles = null;
if (api === "twelvedata") {
candles = await fetchTwelveDataSeries(symbol, interval, use15min?40:70);
if (!candles) candles = await fetchAlphaVantageSeries(symbol, use15min?"15min":"60min");
} else if (api === "alphavantage") {
candles = await fetchAlphaVantageSeries(symbol, use15min?"15min":"60min");
if (!candles) candles = await fetchTwelveDataSeries(symbol, interval, use15min?40:70);
}
if (!candles) { log(🆓 Yahoo for ${symbol}); candles = await fetchYahooFinanceSeries(symbol, interval); }
if (candles) setCache(cacheKey, candles);
return candles;
}

async function fetchLSEData(symbol) {
const cacheKey = lse_${symbol};
const cached   = getCached(cacheKey);
if (cached) return cached;
let candles = await fetchTwelveDataSeries(symbol,"1h",70);
if (!candles) candles = await fetchYahooFinanceSeries(symbol,"1h");
if (candles) setCache(cacheKey, candles);
return candles;
}

async function fetchLivePrice(asset, market) {
try {
if (market === "CRYPTO") {
const { data } = await retry(() =>
axios.get("https://data-api.binance.vision/api/v3/ticker/price", {
params:{symbol:asset}, timeout:10000
})
);
return +data.price;
}
if (TWELVE_DATA_API_KEY) {
try {
const { data } = await retry(() =>
axios.get("https://api.twelvedata.com/price", {
params:{symbol:asset,apikey:TWELVE_DATA_API_KEY}, timeout:12000
})
);
if (data?.status!=="error") { apiUsage.twelvedata++; return +data.price; }
} catch { /* fall through / }
}
if (ALPHA_VANTAGE_API_KEY) {
try {
const { data } = await retry(() =>
axios.get("https://www.alphavantage.co/query", {
params:{function:"GLOBAL_QUOTE",symbol:asset,apikey:ALPHA_VANTAGE_API_KEY}, timeout:12000
})
);
const price = +data?.["Global Quote"]?.["05. price"];
if (Number.isFinite(price)) { apiUsage.alphavantage++; return price; }
} catch { / fall through */ }
}
const { data } = await retry(() =>
axios.get(https://query1.finance.yahoo.com/v8/finance/chart/${asset}, {
params:{interval:"1m",range:"1d"}, headers:{"User-Agent":"Mozilla/5.0"}, timeout:10000
})
);
const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
return Number.isFinite(price) ? price : null;
} catch { return null; }
}

// ── Trend updates ────────────────────────────────────────────────
async function updateBTCTrend() {
const candles = await fetchCrypto1h("BTCUSDT");
if (!candles) return;
const closes = candles.map(x=>x.close);
const prev   = btcTrend;
btcTrend = classifyRegime(ema(closes,20), ema(closes,50), closes.at(-1));
if (btcTrend !== prev) log(📡 BTC trend: ${prev} -> ${btcTrend});
}

async function updateQQQTrend() {
if (!ENABLE_US || !isUSMarketOpen()) { qqqTrend="neutral"; return; }
const candles = await fetchUSData("QQQ");
if (!candles) { qqqTrend="neutral"; return; }
const closes = candles.map(x=>x.close);
const prev   = qqqTrend;
qqqTrend = classifyRegime(ema(closes,20), ema(closes,50), closes.at(-1));
if (qqqTrend !== prev) log(📡 QQQ trend: ${prev} -> ${qqqTrend});
}

// ── Narrative bonus ──────────────────────────────────────────────
function getNarrativeBonus(asset) {
let bonus = 0;
const sym = asset.replace("USDT","");
for (const sector of HOT_SECTORS) {
if ((SECTOR_SYMBOLS[sector]||[]).includes(sym)) bonus += 6;
}
if (HOT_SECTORS.includes("AI") && CRYPTO_AI_NAMES.includes(asset)) bonus += 5;
return bonus;
}

// ── Emoji helpers ────────────────────────────────────────────────
function gradeEmoji(g)  { return g==="A*"?"\uD83D\uDC8E\uD83D\uDD25":g==="A"?"\uD83D\uDE80\u26A1":"\uD83D\uDCC8"; }
function setupEmoji(t)  {
const map = {
BREAKOUT_CONTINUATION:  "\uD83D\uDCA5",
PULLBACK_CONTINUATION:  "\uD83C\uDFAF",
MOMENTUM_BREAKOUT:      "\uD83D\uDD25",
MOMENTUM_IGNITION:      "\u26A1",
GAP_CONTINUATION:       "\uD83D\uDE80",
PRE_BREAKOUT_EXPANSION: "\uD83D\uDCC8"  // rising chart -- early stage
};
return map[t] || "\uD83D\uDCCA";
}
function marketEmoji(m) { return m==="CRYPTO"?"\uD83E\uDE99":m==="US"?"\uD83C\uDDFA\uD83C\uDDF8":m==="LSE"?"\uD83C\uDDEC\uD83C\uDDE7":"\uD83D\uDCCA"; }

// ================================================================
// DUAL-MODE ANALYSIS ENGINE
// Mode 1: Trend continuation (crypto, standard stocks, ETFs)
// Mode 2: Momentum runner (HIGH_BETA stocks + gap-up detection)
// ================================================================

function analyse(asset, candles, market) {
if (!candles || candles.length < MIN_CANDLES) {
if (candles) log(⛔ ${asset} -- not enough candles (${candles.length}));
return null;
}

// Freshness check -- reject if last candle is stale (move already happened)
// Only relevant for 15-min candles where timing matters
// Binance timestamps are in ms from kline data but we don't store them
// so we rely on cache TTL (4 min) to keep data fresh enough

const closes  = candles.map(x => x.close);
const highs   = candles.map(x => x.high);
const lows    = candles.map(x => x.low);
const volumes = candles.map(x => x.volume||0);

const last = closes.at(-1);
const prev = closes.at(-2);
if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) return null;

const momentum = (last - prev) / prev;

// ── Mode selection ────────────────────────────────────────────
const inUSOpen  = market === "US" && isUSOpeningWindow();
const highBeta  = market === "US" && isHighBeta(asset);
const useMode2  = highBeta || (market === "US" && inUSOpen && detectGap(candles).gapped);

// ── Parabolic exhaustion hard block ──────────────────────────
const pct24h = market === "CRYPTO" ? (get24hrMomentum(asset) || 0) : 0;
if (isParabolicExhaustion(candles, pct24h, market === "CRYPTO" ? btcTrend : "neutral")) {
log(⛔ ${asset} -- parabolic exhaustion blocked);
return null;
}

// ── Change 1: Momentum decay filter (crypto only) ─────────────
// Catches PARTI/TON/INJ pattern: big 24h move but rolling over now
if (market === "CRYPTO") {
const recent4hHigh     = Math.max(...highs.slice(-16));
const drawdownFromHigh = recent4hHigh > 0 ? (last - recent4hHigh) / recent4hHigh : 0;
const shortMomentum    = closes.at(-3) > 0 ? (closes.at(-1) - closes.at(-3)) / closes.at(-3) : 0;
const mediumMomentum   = closes.at(-8) > 0 ? (closes.at(-1) - closes.at(-8)) / closes.at(-8) : 0;

const momentumDecaying =  
  pct24h > 0.10 &&  
  drawdownFromHigh < -0.04 &&  
  shortMomentum < 0 &&  
  mediumMomentum < 0.03;  

if (momentumDecaying) {  
  log(`🚫 ${asset} -- momentum decay (24h=${(pct24h*100).toFixed(1)}% drawdown=${(drawdownFromHigh*100).toFixed(1)}% shortMom=${(shortMomentum*100).toFixed(2)}%)`);  
  return null;  
}  

// ── Change 2: Lower highs distribution filter ────────────────  
// Asset made a big move but is now forming lower highs = distribution  
const recentHighs = highs.slice(-6);  
if (recentHighs.length >= 6) {  
  const lowerHighs =  
    recentHighs[5] < recentHighs[3] &&  
    recentHighs[3] < recentHighs[1];  

  if (pct24h > 0.08 && lowerHighs) {  
    log(`🚫 ${asset} -- lower highs after expansion (distribution)`);  
    return null;  
  }  
}

}

// ── Minimum momentum ─────────────────────────────────────────
// HIGH_BETA in opening window: lower floor -- stock may be consolidating after big gap
// The day move is real even if this 1h candle looks quiet
const minMomentum = market === "CRYPTO" ? CRYPTO_15M_MIN_MOMENTUM
: (highBeta && inUSOpen) ? 0        // no floor -- EMA + setup do the filtering
: inUSOpen              ? 0.003
: 0;
if (momentum <= minMomentum) {
if (market !== "LSE") log(⛔ ${asset} -- momentum too low (${(momentum*100).toFixed(2)}%));
return null;
}

// ── EMA structure ─────────────────────────────────────────────
const ema20     = ema(closes, 20);
const ema50     = ema(closes, 50);
const ema20Prev = ema(closes.slice(0,-1), 20);

let emaOk;
if (useMode2 && inUSOpen) {
// Mode 2 opening: just needs EMA20 rising and price above EMA50
// Stale EMAs at open don't reflect gap reality
emaOk = ema20 > ema20Prev && last > ema50;
} else if (useMode2) {
// Mode 2 normal: relaxed -- EMA20 above EMA50 enough
emaOk = ema20 > ema50 && ema20 > ema20Prev;
} else {
// Mode 1: full structure
emaOk = ema20 > ema50 && last > ema20 && ema20 > ema20Prev;
}

if (!emaOk) {
log(⛔ ${asset} -- EMA fail (mode=${useMode2?"2":"1"} inUSOpen=${inUSOpen}));
return null;
}

// ── Volume ────────────────────────────────────────────────────
const avgVol   = avg(volumes.slice(-21,-1));
const volRatio = avgVol > 0 ? volumes.at(-1)/avgVol : 0;

// ── Extension limit ───────────────────────────────────────────
const extension = (last - ema20) / ema20;
let extensionLimit;
if (market === "CRYPTO") extensionLimit = CRYPTO_15M_EXTENSION_LIMIT;
else if (highBeta)       extensionLimit = inUSOpen ? EXTENSION_LIMIT_HB_OW : EXTENSION_LIMIT_HB;
else if (inUSOpen)       extensionLimit = 0.18;
else if (market === "US") extensionLimit = 0.10;
else                      extensionLimit = EXTENSION_LIMIT_LSE;

if (extension > extensionLimit) {
log(⛔ ${asset} -- extended ${(extension*100).toFixed(1)}% > ${extensionLimit*100}% (mode=${useMode2?"2":"1"}));
return null;
}

// ── Regime ────────────────────────────────────────────────────
const exceptionalCrypto = market==="CRYPTO" && momentum>=REGIME_OVERRIDE_MIN_MOMENTUM && volRatio>=REGIME_OVERRIDE_MIN_VOL;
if (!regimePass(market) && !exceptionalCrypto) {
log(⛔ ${asset} -- regime blocked);
return null;
}
if (exceptionalCrypto && !regimePass(market)) {
log(⚡ Regime override: ${asset});
}

// ── Breakout / pullback / gap detection ───────────────────────
const breakoutLevel    = Math.max(...highs.slice(-BREAKOUT_LOOKBACK,-1));
const breakoutDistance = breakoutLevel > 0 ? (last - breakoutLevel)/breakoutLevel : 0;

const breakoutDistLimit = market==="CRYPTO" ? CRYPTO_15M_BREAKOUT_DIST
: highBeta          ? BREAKOUT_DIST_HB
: market==="US"     ? BREAKOUT_DIST_US_STD
: BREAKOUT_DIST_LSE;

const breakoutVolNeeded = market==="CRYPTO" ? CRYPTO_15M_BREAKOUT_VOL
: highBeta          ? US_BREAKOUT_VOL_HB
: market==="US"     ? US_BREAKOUT_VOL_STD
: LSE_BREAKOUT_VOL;

const pullbackVolNeeded = market==="CRYPTO" ? CRYPTO_15M_PULLBACK_VOL
: highBeta          ? US_PULLBACK_VOL_HB
: market==="US"     ? US_PULLBACK_VOL_STD
: LSE_PULLBACK_VOL;

const recentRanges   = highs.slice(-5,-1).map((h,i) => h-lows.slice(-5,-1)[i]).filter(Number.isFinite);
const priorRanges    = highs.slice(-10,-5).map((h,i) => h-lows.slice(-10,-5)[i]).filter(Number.isFinite);
const expandingRange = avg(recentRanges)>0 && avg(priorRanges)>0 && avg(recentRanges)>avg(priorRanges)*1.3;

// GAP_CONTINUATION -- Mode 2 only
const { gapped, gapPct } = detectGap(candles);
const gapContinuationSignal = useMode2 && gapped && gapPct >= 0.05 && volRatio >= 2.0 && isOpeningDrive(candles);

// MOMENTUM_IGNITION
const ignitionMomThreshold = market==="CRYPTO" ? 0.02 : (inUSOpen||highBeta) ? 0.015 : 0.025;
const ignitionSignal = momentum > ignitionMomThreshold && volRatio > 2.0 &&
(useMode2 ? true : (last > ema20 && expandingRange));

// MOMENTUM_BREAKOUT
const strongMomentumOverride = market==="US" && STOCK_MOMENTUM_OVERRIDE_ENABLED &&
momentum >= STOCK_OVERRIDE_MIN_MOMENTUM && volRatio >= STOCK_OVERRIDE_MIN_VOL &&
breakoutDistance <= STOCK_OVERRIDE_MAX_DISTANCE;

// BREAKOUT_CONTINUATION
// LSE: allow 0.3% tolerance below high -- UK stocks stall just under resistance before continuing
const breakoutThreshold = market === "LSE" ? breakoutLevel * 0.997 : breakoutLevel;
const breakoutSignal = last >= breakoutThreshold &&
breakoutDistance <= breakoutDistLimit &&
volRatio >= breakoutVolNeeded &&
momentum >= (market==="US" ? MIN_US_MOMENTUM : market==="LSE" ? MIN_LSE_MOMENTUM : 0);

// PULLBACK_CONTINUATION
const nearEMAThreshold   = market==="US" ? 0.02 : 0.025;
const nearEMA20          = Math.abs(last - ema20)/ema20 <= nearEMAThreshold;
const pulledBackRecently = closes.slice(-6,-1).some(c => c <= ema20*1.01);
const pullbackSignal     = nearEMA20 && pulledBackRecently && volRatio >= pullbackVolNeeded;

// First pullback continuation (Stage 3) -- Mode 2
const firstPullbackCont = useMode2 && isFirstPullbackContinuation(candles) && volRatio >= 1.2;

// Change 4: PRE_BREAKOUT_EXPANSION -- catches active expansion before confirmation
// Enters during real-time momentum acceleration, not after it's obvious
const preBreakoutExpansion = market === "CRYPTO" &&
momentum > 0.012 &&
volRatio > 1.8 &&
last > ema20 &&
breakoutDistance > -0.01 &&
breakoutDistance < 0.015 &&
getMoveMaturity(candles) === "expansion";

if (!pullbackSignal && !breakoutSignal && !strongMomentumOverride && !ignitionSignal && !gapContinuationSignal && !firstPullbackCont && !preBreakoutExpansion) {
log(⛔ ${asset} -- no setup (break=${breakoutSignal} pull=${pullbackSignal} gap=${gapContinuationSignal} ign=${ignitionSignal} fpc=${firstPullbackCont} pbe=${preBreakoutExpansion} vol=${volRatio.toFixed(2)}x));
return null;
}

if (gapContinuationSignal)                              setupType = "GAP_CONTINUATION";
else if (ignitionSignal)                                setupType = "MOMENTUM_IGNITION";
else if (preBreakoutExpansion && !ignitionSignal)       setupType = "PRE_BREAKOUT_EXPANSION";
else if (strongMomentumOverride && !ignitionSignal)     setupType = "MOMENTUM_BREAKOUT";
else if (firstPullbackCont && !breakoutSignal)          setupType = "PULLBACK_CONTINUATION";
else if (pullbackSignal && !breakoutSignal)             setupType = "PULLBACK_CONTINUATION";

// Pullback momentum minimum
const minPullbackMom = market==="CRYPTO" ? CRYPTO_15M_MIN_PULLBACK
: market==="US"     ? MIN_PULLBACK_MOM_US
: MIN_PULLBACK_MOM_LSE;
if (setupType==="PULLBACK_CONTINUATION" && momentum < minPullbackMom) return null;

// ── Momentum cap ─────────────────────────────────────────────
const momentumCap = setupType==="MOMENTUM_IGNITION"||setupType==="GAP_CONTINUATION" ? 0.25
: setupType==="PRE_BREAKOUT_EXPANSION" ? 0.04  // tight cap -- must be early
: market==="CRYPTO"  ? CRYPTO_15M_MAX_MOMENTUM
: highBeta           ? (inUSOpen ? MOMENTUM_CAP_HB_OW : MOMENTUM_CAP_HB)
: inUSOpen           ? 0.15
: market==="US"      ? MOMENTUM_CAP_US_STD
: MOMENTUM_CAP_LSE;

if (momentum > momentumCap) {
log(⛔ ${asset} -- momentum cap (${(momentum*100).toFixed(2)}% > ${momentumCap*100}%));
return null;
}

// ── Entry and stops ───────────────────────────────────────────
const entryType = setupType==="PULLBACK_CONTINUATION" ? "LIMIT BUY" : "MARKET BUY";
const entry     = setupType==="PULLBACK_CONTINUATION" ? ema20*1.002 : last;

const atr = calculateATR(candles, ATR_PERIOD);
if (!atr || atr <= 0) return null;

const swingLow = Math.min(...lows.slice(-6));
const atrMult  = setupType==="PULLBACK_CONTINUATION" ? ATR_PULLBACK_MULTIPLIER
: (setupType==="MOMENTUM_IGNITION"||setupType==="GAP_CONTINUATION") ? ATR_IGNITION_MULTIPLIER
: ATR_BREAKOUT_MULTIPLIER;

// GAP_CONTINUATION: SL below gap candle low for tighter stop
let sl;
if (setupType === "GAP_CONTINUATION") {
const gapCandleLow = Math.min(...lows.slice(-6));
sl = gapCandleLow - atr * 0.5;
} else {
sl = Math.min(swingLow - atratrMult, entry - atratrMult);
}

if (!Number.isFinite(sl) || sl >= entry) return null;

const riskAmt = entry - sl;
const riskPct = riskAmt / entry;
if (riskPct <= 0 || riskPct > 0.15) return null; // allow 15% risk for high-beta

const tp = entry + riskAmt * TARGET_R;
const rr = +((((tp - entry)/entry)/riskPct).toFixed(1));
if (rr < MIN_RR) return null;

// ── Scoring ───────────────────────────────────────────────────
let score = 50;

// Volume
if (volRatio > 1.2) score += 6;
if (volRatio > 1.4) score += 6;
if (volRatio > 1.6) score += 4;
if (volRatio > 2.0) score += 5;
if (volRatio > 3.0) score += 5;

// Momentum
const momScale = market==="CRYPTO" || highBeta ? 0.5 : 1;
if (momentum > 0.025momScale)      score += 10;
else if (momentum > 0.015momScale) score += 8;
else if (momentum > 0.008*momScale) score += 4;

// Setup type
if (setupType==="BREAKOUT_CONTINUATION")   score += 10;
if (setupType==="PULLBACK_CONTINUATION")   score += 8;
if (setupType==="MOMENTUM_BREAKOUT")       score += 14;
if (setupType==="MOMENTUM_IGNITION")       score += 18;
if (setupType==="GAP_CONTINUATION")        score += 16;
if (setupType==="PRE_BREAKOUT_EXPANSION")  score += 13; // between breakout and ignition

// Market
if (market==="CRYPTO") score += 5;
if (market==="US")     score += 4;
if (market==="LSE")    score += 2;

// Regime
if (market==="CRYPTO" && btcTrend==="strong_bull") score += 5;
if (market==="US"     && qqqTrend==="bull")        score += 3;
if (market==="US"     && qqqTrend==="strong_bull") score += 5;

// Quality
if (breakoutDistance>0 && breakoutDistance<=0.01) score += 4;
if (expandingRange) score += 4;
if (gapped)         score += 6; // gap adds quality for Mode 2

// Narrative
score += getNarrativeBonus(asset);

// V90: MATURITY-AWARE BONUS -- replaces 24hr raw boost
// Rewards early stage, penalises exhaustion
score += getMomentumMaturityBonus(candles, pct24h, asset);

let grade = "B";
if (score >= 85) grade = "A*";
else if (score >= 78) grade = "A";

// Score floor -- asset-aware
const scoreFloor = minScoreForMarket(market, asset);
if (score < MIN_GLOBAL_SCORE || score < scoreFloor) {
log(⛔ ${asset} -- score ${score} below floor ${scoreFloor} (mode=${useMode2?"2":"1"}));
return null;
}

log(✅ ${asset} ${market} ${setupType} score=${score} grade=${grade} mode=${useMode2?"2":"1"} vol=${volRatio.toFixed(2)}x mom=${(momentum*100).toFixed(2)}%);

// EMA distance -- key metric for detecting chasing entries (Phase 2 evidence collection)
const emaDistPct = ema20 > 0 ? ((last - ema20) / ema20) * 100 : 0;

return {
asset, market, grade, setupType, status:"CONFIRMED",
entryType, entry, sl, tp, rr, score, momentum, volRatio,
breakoutDistance, atr, gapPct, emaDistPct,
regime: market==="CRYPTO" ? btcTrend : market==="US" ? qqqTrend : "LSE_LOCAL"
};
}

// ── Signal messages ──────────────────────────────────────────────
function buildSignalLesson(signal) {
const parts = ["\uD83D\uDCDA <b>TRADE LESSON</b>", ""];
if (signal.setupType === "GAP_CONTINUATION") {
parts.push(\uD83D\uDE80 <b>Gap Continuation</b> \u2014 stock gapped up ${signal.gapPct?(signal.gapPct*100).toFixed(1)+"%":""} at open on strong volume, showing continuation drive. Entering as the opening momentum confirms.);
} else if (signal.setupType === "PRE_BREAKOUT_EXPANSION") {
parts.push("\uD83D\uDCC8 <b>Pre-Breakout Expansion</b> \u2014 momentum actively expanding right now, price sitting just below resistance with volume building. Early entry before the confirmed breakout -- higher risk, cleaner entry.");
} else if (signal.setupType === "BREAKOUT_CONTINUATION") {
parts.push("\uD83D\uDCA5 <b>Breakout Continuation</b> \u2014 price pushed above recent resistance. Market buy gets you in immediately.");
} else if (signal.setupType === "PULLBACK_CONTINUATION") {
parts.push("\uD83C\uDFAF <b>Pullback Continuation</b> \u2014 price dipped back to the 20-period EMA and is bouncing. Lower risk entry within an uptrend.");
} else if (signal.setupType === "MOMENTUM_BREAKOUT") {
parts.push("\uD83D\uDD25 <b>Momentum Breakout</b> \u2014 strong candle with high volume through resistance. Real buying pressure confirmed.");
} else {
parts.push("\u26A1 <b>Momentum Ignition</b> \u2014 explosive early runner. Volume 2x+, accelerating. Higher risk, higher reward \u2014 size carefully.");
}

if (signal.volRatio >= 3.0)      parts.push(\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x</b> \u2014 exceptional. Institutional-level flow.);
else if (signal.volRatio >= 2.0) parts.push(\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x</b> \u2014 very strong. Real conviction.);
else                              parts.push(\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x</b> \u2014 above average. Buyers active.);

if (signal.market === "CRYPTO") {
const pct24 = get24hrMomentum(signal.asset);
if (pct24 && pct24 >= 0.05) {
parts.push(\n\uD83D\uDCC8 <b>24hr: +${(pct24*100).toFixed(1)}%</b> \u2014 building momentum all day.);
}
parts.push(\n\uD83E\uDE99 BTC trend: <b>${btcTrend.replace("_"," ")}</b>);
} else if (signal.market === "US") {
parts.push(\n\uD83C\uDDFA\uD83C\uDDF8 QQQ trend: <b>${qqqTrend.replace("_"," ")}</b>);
}

const matched = HOT_SECTORS.filter(s => (SECTOR_SYMBOLS[s]||[]).includes(signal.asset.replace("USDT","")));
if (matched.length > 0) parts.push(\n\uD83E\uDDE0 <b>Narrative: ${matched.join(", ")}</b> \u2014 sector momentum active.);

if (signal.grade === "A*") parts.push("\n\u2B50 <b>A* grade</b> \u2014 all conditions aligned.");
else if (signal.grade === "A") parts.push("\n\u2B50 <b>A grade</b> \u2014 strong signal.");

parts.push(\n\u26A1 <b>Momentum: ${(signal.momentum*100).toFixed(2)}%</b> on this candle.);
return lines(parts);
}

function buildSignalMessage(signal, size) {
const isMarket  = signal.entryType === "MARKET BUY";
const sym       = signal.asset.replace("USDT","");
const matched   = HOT_SECTORS.filter(s => (SECTOR_SYMBOLS[s]||[]).includes(sym));
const ntag      = matched.length>0 ? \n\uD83E\uDDE0 <b>${escapeHtml(matched.join(" + "))}</b> : "";
const slPct     = (((signal.entry - signal.sl)/signal.entry)*100).toFixed(1);
const tpPct     = (((signal.tp - signal.entry)/signal.entry)*100).toFixed(1);
const riskPct   = (getRiskFractionForSignal(signal)*100).toFixed(1);
return lines([
\uD83D\uDEA8 ${gradeEmoji(signal.grade)} <b>${escapeHtml(signal.grade)} SIGNAL</b>${ntag},
,   `${marketEmoji(signal.market)} <b>${escapeHtml(signal.market)} | ${escapeHtml(signal.asset)}</b>`,   `${setupEmoji(signal.setupType)} ${escapeHtml(signal.setupType)}`,   ,
isMarket ? \u26A1 <b>MARKET BUY NOW</b> ~${escapeHtml(formatPrice(signal.entry, signal.market))} : \uD83D\uDCB0 Limit Entry: ${escapeHtml(formatPrice(signal.entry, signal.market))},
\uD83D\uDEE1\uFE0F SL:    ${escapeHtml(formatPrice(signal.sl, signal.market))} <b>(-${escapeHtml(slPct)}%)</b>,
\uD83C\uDFAF TP:    ${escapeHtml(formatPrice(signal.tp, signal.market))} <b>(+${escapeHtml(tpPct)}%)</b>,
\u2696\uFE0F R:R:   ${escapeHtml(String(signal.rr))},
\u2B50 Score: ${escapeHtml(String(signal.score))},
\uD83D\uDCCA Vol:   ${escapeHtml(signal.volRatio.toFixed(2))}x,
\u26A0\uFE0F Risk:  ${escapeHtml(riskPct)}% of account,
``,
buildSignalLesson(signal)
]);
}

function buildFillMessage(trade, price) {
const slPct = (((price - trade.sl)/price)*100).toFixed(1);
const tpPct = (((trade.tp - price)/price)*100).toFixed(1);
return lines([
\u2705\uD83D\uDD25 <b>FILLED</b>,
,   `${marketEmoji(trade.market)} <b>${escapeHtml(trade.market)} | ${escapeHtml(trade.asset)}</b>`,   `${setupEmoji(trade.setupType)} ${escapeHtml(trade.setupType)}`,   ,
\uD83D\uDCB5 Fill: ${escapeHtml(formatPrice(price, trade.market))},
\uD83D\uDEE1\uFE0F SL:   ${escapeHtml(formatPrice(trade.sl, trade.market))} <b>(-${escapeHtml(slPct)}%)</b>,
\uD83C\uDFAF TP:   ${escapeHtml(formatPrice(trade.tp, trade.market))} <b>(+${escapeHtml(tpPct)}%)</b>,
\u2B50 Score: ${escapeHtml(String(trade.score))}
]);
}

function buildCloseMessage(trade, reason, closePrice) {
const rVal     = Number.isFinite(trade.realizedR) ? +trade.realizedR.toFixed(2) : null;
const pnlPct   = Number.isFinite(closePrice) && Number.isFinite(trade.entry) && trade.entry > 0
? ((closePrice - trade.entry)/trade.entry*100).toFixed(2) : null;
const heldHrs  = hoursAgo(trade.filledAt||trade.sentAt).toFixed(1);
const mae      = Number.isFinite(trade.maePct) ? ${(trade.maePct*100).toFixed(2)}% : "n/a";
const mfe      = Number.isFinite(trade.mfePct) ? ${(trade.mfePct*100).toFixed(2)}% : "n/a";
const isWin    = reason === "TAKE PROFIT";
const isLoss   = reason === "STOP LOSS";
const re       = {"TAKE PROFIT":"\uD83D\uDCB0\u2705","STOP LOSS":"\uD83D\uDED1\u274C","FORCE CLOSE":"\u23F1\uFE0F\uD83D\uDD1A","REPLACED":"\uD83D\uDD04","STRUCTURE_INVALID":"\u26A0\uFE0F","DRIFTED_TOO_FAR":"\uD83C\uDF0A","PENDING_EXPIRED":"\u231B"}[reason] || "\uD83D\uDCCC";
const rLabel   = rVal!==null ? (rVal>0?+${rVal}R:${rVal}R) : "n/a";
const pnlLabel = pnlPct!==null ? (parseFloat(pnlPct)>0?+${pnlPct}%:${pnlPct}%) : "n/a";

const parts = [
${re} <b>${escapeHtml(isWin?"WINNER":isLoss?"STOPPED OUT":reason.replace("_"," "))}</b>,
,   `${marketEmoji(trade.market)} <b>${escapeHtml(trade.market)} | ${escapeHtml(trade.asset)}</b>`,   `${setupEmoji(trade.setupType)} ${escapeHtml(trade.setupType)}`,   ,
\uD83D\uDCB5 Entry:  ${escapeHtml(formatPrice(trade.entry, trade.market))},
\uD83D\uDCB5 Exit:   ${escapeHtml(formatPrice(closePrice, trade.market))},
``,
\uD83D\uDCCA Result: <b>${escapeHtml(pnlLabel)}</b> \u2022 <b>${escapeHtml(rLabel)}</b>,
\u23F1\uFE0F Held:   ${escapeHtml(heldHrs)} hours,
\uD83D\uDCC9 Max against: ${escapeHtml(mae)},
\uD83D\uDCC8 Max in favour: ${escapeHtml(mfe)},
\u2B50 Signal score: ${escapeHtml(String(trade.score))}
];

if (isWin)  parts.push(, `\uD83C\uDF7E <b>Target hit.</b>${rVal?` Made ${rVal}x the risk.`:""} Setup played out as planned.`);   if (isLoss) parts.push(, \uD83D\uDEE1\uFE0F <b>Stop did its job.</b> Loss capped. Capital protected for the next setup.);
if (reason==="FORCE CLOSE")     parts.push(, `\u23F1\uFE0F <b>Force closed.</b> No progress after ${heldHrs}hrs.`);   if (reason==="PENDING_EXPIRED") parts.push(, \u231B <b>Order expired.</b> Entry level never reached.);

if (isWin || isLoss) {
parts.push(``, \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014, \uD83D\uDCF8 <i>Signal by @baretradesignals</i>);
}
return lines(parts);
}

// ── Trade helpers ────────────────────────────────────────────────
function cooldown(asset, alerts, market) {
const last = [...alerts].reverse().find(x => x.asset===asset && x.market===market);
if (!last) return false;
const hrs = market==="CRYPTO"?CRYPTO_COOLDOWN:market==="LSE"?LSE_COOLDOWN:US_COOLDOWN;
const inCooldown = hoursAgo(last.sentAt) < hrs;
if (inCooldown) log(⏳ ${asset} in cooldown);
return inCooldown;
}

function getOpenTradeInMarket(trades, market) {
return trades.find(t => t.market===market && t.status==="FILLED" && t.outcome==="OPEN");
}
function countPendingTradesByMarket(trades, market) {
return trades.filter(t => t.market===market && t.status==="PENDING").length;
}
function countOpenTradesByMarket(trades, market) {
return trades.filter(t => t.market===market && t.status==="FILLED" && t.outcome==="OPEN").length;
}
function getOpenRiskFraction(trades) {
return trades.filter(t => t.status==="FILLED" && t.outcome==="OPEN").reduce((sum,t) => sum+(t.riskFraction||0), 0);
}
function progressToTarget(trade, livePrice) {
const denom = trade.tp - trade.entry;
if (!Number.isFinite(livePrice)||!Number.isFinite(denom)||denom<=0) return 0;
return (livePrice - trade.entry) / denom;
}
function shouldReplaceTrade(newSignal, currentTrade, livePrice) {
if (!currentTrade || !Number.isFinite(livePrice)) return false;
const progress = progressToTarget(currentTrade, livePrice);
const stale    = hoursAgo(currentTrade.filledAt||currentTrade.sentAt) > REPLACEMENT_STALE_HOURS;
return newSignal.score >= (currentTrade.score||0)+REPLACEMENT_SCORE_GAP &&
progress < REPLACEMENT_PROTECT_TP_PROGRESS &&
(stale || progress < REPLACEMENT_STALL_PROGRESS);
}
function shouldForceClose(trade, livePrice) {
if (!Number.isFinite(livePrice)) return false;
return hoursAgo(trade.filledAt||trade.sentAt) > FORCE_CLOSE_HOURS &&
progressToTarget(trade, livePrice) < FORCE_CLOSE_PROGRESS;
}
function getRiskFractionForSignal(signal) {
const base = BASE_RISK_PER_TRADE * (signal.score>=85?1.5:signal.score>=78?1.2:1.0);
return ["ASTS","IONQ","AVAV"].includes(signal.asset) ? base*0.7 : base;
}
function calculatePositionSize(signal) {
const riskFraction = getRiskFractionForSignal(signal);
const riskPerUnit  = signal.entry - signal.sl;
if (!Number.isFinite(riskPerUnit)||riskPerUnit<=0) return 0;
return (ACCOUNT_BALANCE * riskFraction) / riskPerUnit;
}
function pickTopSignals(results) {
// Allow up to 2 US, 1 CRYPTO, 1 LSE -- more signals, more channel activity
// Cooldowns and position limits still prevent actual spam
const byMarket = { US: [], CRYPTO: [], LSE: [] };
for (const s of results.sort((a,b) => b.score - a.score)) {
if (!byMarket[s.market]) byMarket[s.market] = [];
byMarket[s.market].push(s);
}
const selected = [];
// Take top 2 US, top 1 crypto, top 1 LSE
selected.push(...(byMarket.US     || []).slice(0, 2));
selected.push(...(byMarket.CRYPTO || []).slice(0, 1));
selected.push(...(byMarket.LSE    || []).slice(0, 1));
return selected.sort((a,b) => b.score - a.score);
}
function updateTradeExcursion(trade, livePrice) {
if (!Number.isFinite(livePrice)) return;
const adverse   = Math.max(0, (trade.entry - livePrice)/trade.entry);
const favorable = Math.max(0, (livePrice - trade.entry)/trade.entry);
if (!Number.isFinite(trade.maePct)||adverse>trade.maePct)   trade.maePct = adverse;
if (!Number.isFinite(trade.mfePct)||favorable>trade.mfePct) trade.mfePct = favorable;
}

async function closeTrade(trades, trade, closePrice, reason) {
trade.closePrice = closePrice;
trade.closedAt   = nowIso();
trade.status     = "CLOSED";
trade.outcome    = reason;
const riskPerUnit = trade.entry - trade.sl;
trade.realizedR   = Number.isFinite(closePrice) && Number.isFinite(riskPerUnit) && riskPerUnit>0
? (closePrice - trade.entry)/riskPerUnit : null;
await safeRun(close${trade.asset}, () => sendBoth(buildCloseMessage(trade, reason, closePrice)));
await saveTrades(trades);
}

// ── Trade management ─────────────────────────────────────────────
async function manageTrades() {
const trades = await loadTradesCached();
let changed = false;
for (const trade of trades) {
if (shuttingDown) break;
const livePrice = await fetchLivePrice(trade.asset, trade.market);
if (!Number.isFinite(livePrice)) continue;
if (trade.status === "PENDING") {
const ageHours = hoursAgo(trade.sentAt);
const expiry   = trade.market==="CRYPTO"?CRYPTO_PENDING_EXPIRY_HRS:trade.market==="LSE"?PENDING_EXPIRY_HOURS_LSE:PENDING_EXPIRY_HOURS_US;
const filled   = trade.entryType==="MARKET BUY" ? true : livePrice<=trade.entry1.002;
const invalid  = livePrice <= trade.sl;
const drifted  = trade.entryType==="LIMIT BUY" && livePrice>trade.entry1.04;
if (filled) {
trade.status="FILLED"; trade.outcome="OPEN";
trade.fillPrice=livePrice; trade.filledAt=nowIso();
trade.maePct=0; trade.mfePct=0; changed=true;
await safeRun(fill${trade.asset}, () => sendPrivate(buildFillMessage(trade, livePrice)));
continue;
}
if (invalid) {
trade.status="CANCELLED"; trade.outcome="STRUCTURE_INVALID";
trade.closedAt=nowIso(); trade.closePrice=livePrice; changed=true;
await safeRun(invalid${trade.asset}, () => sendPrivate(buildCloseMessage(trade,"STRUCTURE_INVALID",livePrice)));
continue;
}
if (drifted) {
trade.status="CANCELLED"; trade.outcome="DRIFTED_TOO_FAR";
trade.closedAt=nowIso(); trade.closePrice=livePrice; changed=true;
await safeRun(drift${trade.asset}, () => sendPrivate(buildCloseMessage(trade,"DRIFTED_TOO_FAR",livePrice)));
continue;
}
if (ageHours > expiry) {
trade.status="CANCELLED"; trade.outcome="PENDING_EXPIRED";
trade.closedAt=nowIso(); trade.closePrice=livePrice; changed=true;
await safeRun(expired${trade.asset}, () => sendPrivate(buildCloseMessage(trade,"PENDING_EXPIRED",livePrice)));
continue;
}
}
if (trade.status==="FILLED" && trade.outcome==="OPEN") {
updateTradeExcursion(trade, livePrice);
changed = true;
if (livePrice<=trade.sl) { await closeTrade(trades,trade,livePrice,"STOP LOSS");   continue; }
if (livePrice>=trade.tp) { await closeTrade(trades,trade,livePrice,"TAKE PROFIT"); continue; }
if (shouldForceClose(trade,livePrice)) { await closeTrade(trades,trade,livePrice,"FORCE CLOSE"); continue; }
}
}
if (changed) await saveTradesCached(trades);
}

// ── Scan ─────────────────────────────────────────────────────────
async function scan() {
const alerts  = await loadAlerts();
const trades  = await loadTrades();
const results = [];

async function processAsset(asset, market, fetcher) {
if (cooldown(asset, alerts, market)) return;
if (trades.some(t => t.asset===asset && (t.status==="PENDING"||(t.status==="FILLED"&&t.outcome==="OPEN")))) return;
const candles = await fetcher(asset);
if (!candles || candles.length < MIN_CANDLES) {
if (market === "US") log(⚠️ ${asset} -- no candle data (${candles?.length ?? 0} candles));
return;
}
const signal  = analyse(asset, candles, market);
if (!signal) return;
results.push(signal);
}

if (shouldScanCrypto()) {
// Change 5: Crypto breadth filter -- avoid isolated pumps in weak market conditions
// Count how many tracked pairs are green on current 15-min candle
let greenPairs = 0;
let checkedPairs = 0;
for (const sym of CRYPTO_PAIRS.slice(0, 12)) {
try {
const c = await fetchCrypto(sym);
if (c && c.length >= 2) {
checkedPairs++;
if (c.at(-1).close > c.at(-2).close) greenPairs++;
}
} catch { /* skip */ }
}
const breadthOk = checkedPairs < 5 || (greenPairs / checkedPairs) >= 0.30; // 30% -- was 45%, too aggressive
if (!breadthOk) {
log(🚫 Crypto breadth very weak -- ${greenPairs}/${checkedPairs} green -- skipping crypto scan);
} else {
log(📊 Crypto breadth ok -- ${greenPairs}/${checkedPairs} green);
await mapWithConcurrency(CRYPTO_PAIRS, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset,"CRYPTO",fetchCrypto));
}
}
if (shouldScanUS()) {
log(📈 US scan -- ${STOCK_POOL.length} stocks, QQQ=${qqqTrend}, openingWindow=${isUSOpeningWindow()});
await mapWithConcurrency(STOCK_POOL, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset,"US",fetchUSData));
}
if (shouldScanLSE()) {
await mapWithConcurrency(LSE_POOL, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset,"LSE",fetchLSEData));
}

return pickTopSignals(results);
}

// ── Process signals ──────────────────────────────────────────────
async function processSignals(signals) {
const alerts = await loadAlertsCached();
const trades = await loadTradesCached();

for (const signal of signals) {
const existingOpenTrade = getOpenTradeInMarket(trades, signal.market);
if (existingOpenTrade) {
const livePrice = await fetchLivePrice(existingOpenTrade.asset, existingOpenTrade.market);
if (shouldReplaceTrade(signal, existingOpenTrade, livePrice)) {
await closeTrade(trades, existingOpenTrade, Number.isFinite(livePrice)?livePrice:existingOpenTrade.entry, "REPLACED");
} else { continue; }
}

if (countOpenTradesByMarket(trades,signal.market)    >= MAX_POSITIONS[signal.market]) continue;  
if (countPendingTradesByMarket(trades,signal.market) >= 1) continue;  

const riskFraction = getRiskFractionForSignal(signal);  
if (getOpenRiskFraction(trades) + riskFraction > MAX_PORTFOLIO_RISK) continue;  

const size = calculatePositionSize(signal);  
if (!Number.isFinite(size)||size<=0) continue;  

const sentAt  = nowIso();  
const alertId = `${signal.asset}-${signal.market}-${Math.floor(new Date(sentAt).getTime()/(120*60000))}`; // 2hr dedup window  
if (alerts.some(a => a.id===alertId)) { log(`⏳ Dedup blocked ${signal.asset}`); continue; }  
if (trades.some(t => t.asset===signal.asset && t.status==="PENDING")) { log(`⏳ Pending exists ${signal.asset}`); continue; }  

await safeRun(`signal${signal.asset}`, () => sendBoth(buildSignalMessage(signal, size)));  
lastSignalTime = Date.now();  

// Phase 2 evidence logging -- track everything needed for later statistical analysis  
// Do NOT act on this yet. Collect 20-50 signals then look for patterns.  
log(`📋 SIGNAL LOG | ${signal.asset} | setup=${signal.setupType} | btc=${btcTrend} | vol=${signal.volRatio?.toFixed(2)}x | mom=${((signal.momentum||0)*100).toFixed(2)}% | score=${signal.score} | emaDistPct=${signal.emaDistPct?.toFixed(2)||'?'}%`);  

alerts.push({ id:alertId, asset:signal.asset, market:signal.market, sentAt });  
trades.push({  
  id:`${signal.asset}-${Date.now()}`, asset:signal.asset, market:signal.market,  
  setupType:signal.setupType, entryType:signal.entryType,  
  entry:signal.entry, sl:signal.sl, tp:signal.tp,  
  rrPlanned:signal.rr, score:signal.score, volRatio:signal.volRatio,  
  momentum:signal.momentum, regime:signal.regime,  
  sentAt, status:"PENDING", outcome:"OPEN",  
  fillPrice:null, closePrice:null, closedAt:null, filledAt:null,  
  maePct:0, mfePct:0, realizedR:null, riskFraction  
});

}

await saveAlertsCached(alerts);
await saveTradesCached(trades);
}

// ── Main cycle ───────────────────────────────────────────────────
// ── Pre-market mover detection ───────────────────────────────────
// Runs 13:00-14:25 UK on weekdays (US pre-market window)
// Sends a watchlist-style alert flagging HIGH_BETA names up 3%+
// No entry signals -- awareness only. Primes scanner for 14:30 open.

let lastPreMarketAlertTime = 0;
let lastPreMarketKey       = "";

function isPreMarketWindow() {
if (isWeekend()) return false;
const m = getUkMinutes();
return m >= 780 && m < 865; // 13:00-14:25 UK
}

async function fetchPreMarketPrice(symbol) {
try {
const { data } = await retry(() =>
axios.get(https://query1.finance.yahoo.com/v8/finance/chart/${symbol}, {
params: { interval: "1m", range: "1d", includePrePost: true },
headers: { "User-Agent": "Mozilla/5.0" },
timeout: 10000
})
);
const result = data?.chart?.result?.[0];
if (!result) return null;
const meta        = result.meta;
const prePrice    = meta?.preMarketPrice;
const regularPrev = meta?.chartPreviousClose || meta?.previousClose;
if (!prePrice || !regularPrev || regularPrev <= 0) return null;
const changePct = (prePrice - regularPrev) / regularPrev;
return { price: prePrice, prev: regularPrev, changePct };
} catch { return null; }
}

async function sendPreMarketAlert() {
if (!isWeekday() || !isPreMarketWindow()) return;

// Max one alert per hour in the pre-market window
if (Date.now() - lastPreMarketAlertTime < 60 * 60 * 1000) return;

const movers = [];
const watchList = [...HIGH_BETA_STOCKS].slice(0, 20);

for (const sym of watchList) {
try {
const r = await fetchPreMarketPrice(sym);
if (!r) continue;
if (Math.abs(r.changePct) >= 0.03) { // 3%+ move
movers.push({ sym, changePct: r.changePct, price: r.price });
}
} catch { /* skip */ }
}

if (movers.length === 0) return;

// Sort by absolute move
movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

// Content dedup -- same movers = skip
const key = movers.map(m => m.sym).join(",");
if (key === lastPreMarketKey) return;
lastPreMarketKey       = key;
lastPreMarketAlertTime = Date.now();

const moverLines = movers.map(m => {
const pct   = (m.changePct * 100).toFixed(1);
const arrow = m.changePct >= 0 ? "\uD83D\uDFE2" : "\uD83D\uDD34";
const flag  = Math.abs(m.changePct) >= 0.08 ? " \uD83D\uDD25" : Math.abs(m.changePct) >= 0.05 ? " \u26A1" : "";
return ${arrow} <b>${escapeHtml(m.sym)}</b> ${m.changePct>=0?"+":""}${pct}%${flag} -- $${m.price.toFixed(2)} pre-market;
});

const msg = [
\u23F0 <b>PRE-MARKET MOVERS</b> -- ${new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})} UK,
<i>US open in ~${Math.round((865 - getUkMinutes()))} mins</i>,
"",
...moverLines,
"",
"\uD83D\uDCA1 Watch for breakout confirmation at 14:30 open",
"\uD83D\uDD0D Scanner primed -- entry signal fires if setup confirms"
].join("\n");

await sendBoth(msg);
log(⏰ Pre-market alert sent: ${movers.map(m=>${m.sym}${(m.changePct*100).toFixed(1)}%).join(", ")});
}

async function safeCycle() {
if (running||shuttingDown) return;
running = true;
cycleCount++;
try {
resetApiUsageIfNewDay();
await safeRun("btcTrend",         updateBTCTrend);
await safeRun("qqqTrend",         updateQQQTrend);
await safeRun("preMarket",        sendPreMarketAlert);
await safeRun("marketAlerts",     checkMarketAlerts);
await safeRun("dynamicInjection", injectHotCryptoMovers);
await safeRun("manageTrades",     manageTrades);
const signals = await withTimeout(safeRun("scan", scan), SCAN_TIMEOUT_MS, "scan");
if (Array.isArray(signals) && signals.length > 0) {
await safeRun("processSignals", () => processSignals(signals));
} else {
log(NO SIGNALS -- TD=${apiUsage.twelvedata} AV=${apiUsage.alphavantage} BTC=${btcTrend});
// Watchlist: only after 90 mins of no signals, hourly max, content dedup inside
const sinceLastSignal   = lastSignalTime > 0 ? Date.now() - lastSignalTime : Infinity;
const quietEnough       = sinceLastSignal > 90 * 60 * 1000;
if (quietEnough) {
const alerts = await loadAlertsCached();
const trades = await loadTradesCached();
await safeRun("watchlist", () => sendWatchlistAlert(alerts, trades));
}
}
} catch (err) {
log("CYCLE ERROR:", err?.message||err);
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
shuttingDown = true; ready = false;
clearRuntimeTimers();
log(🛑 ${signal} received);
try {
const [trades, alerts] = await Promise.all([loadTrades(), loadAlerts()]);
await Promise.all([saveTrades(trades), saveAlerts(alerts)]);
log("💾 State saved");
} catch (err) { log("Shutdown error:", err?.message||err); }
if (server) await new Promise(resolve => { server.close(resolve); setTimeout(resolve, 2000); });
setTimeout(() => process.exit(signal==="UNCAUGHT_EXCEPTION"?1:0), SHUTDOWN_EXIT_MS);
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
log(🚀 SNIPER V91 on port ${PORT});
await safeRun("bootTelegram", () => sendPrivate(lines([
"\uD83D\uDE80 SNIPER V91 LIVE -- MOMENTUM MATURITY ENGINE",
"",
"Dual-mode scanner: Trend Continuation + Momentum Runner",
"Move maturity: base > expansion > continuation > climax",
"Parabolic exhaustion hard block active",
"Supabase: " + (supabaseEnabled ? "ENABLED" : "DISABLED -- local JSON only"),
"Heating up alerts: permanently removed"
])));

// Supabase connection test
if (supabaseEnabled) {
try {
const { error } = await supabase.from("trades").select("id").limit(1);
if (error) {
log(❌ Supabase connection test FAILED: ${error.message});
await sendPrivate(\u26a0\ufe0f <b>Supabase connection failed</b>\n${error.message}\nFalling back to local JSON.);
} else {
log("✅ Supabase connection test passed");
}
} catch (e) {
log(❌ Supabase connection test exception: ${e.message});
await sendPrivate(\u26a0\ufe0f <b>Supabase connection exception</b>\n${e.message});
}
}
await sleep(STARTUP_DELAY_MS);
await safeRun("initialPools",  refreshDynamicPools);
ready = true;
log("\u2705 SNIPER V91 READY");
await safeRun("initialCycle", safeCycle);
cacheCleanupTimer = setInterval(cleanupCandleCache, CACHE_CLEANUP_MS);
void cycleLoop();
void refreshLoop();
});
