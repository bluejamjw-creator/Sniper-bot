// ================================================================
// SNIPER V86
// + Narrative alert only fires when something actually changes
// + Narrative alert suppressed outside 08:00-21:00 UK and weekends
// + Crypto movers added to narrative alert with % context
// + Momentum watch — heating up alerts Crypto 5%+ / Stocks 3%+
// + Exceptional crypto override: 1.5% candle + 1.8x vol
// + Rejection logging so we can diagnose why signals fail
// + All V85 logic: signal-only Telegram, API rotation, Yahoo fallback
// ================================================================

console.log("🚀 SNIPER V86 STARTING...");

const fs    = require("fs");
const path  = require("path");
const axios = require("axios");
const express = require("express");
const ws    = require("ws");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = process.env.PORT || 3000;

app.get("/",       (_req, res) => res.status(200).send("SNIPER V86 alive"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

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
const FILES = {
  alerts: path.join(DATA_DIR, "alerts.json"),
  trades: path.join(DATA_DIR, "trades.json")
};

// ── Trading constants ────────────────────────────────────────────
const ACCOUNT_BALANCE      = 10000;
const BASE_RISK_PER_TRADE  = 0.01;
const MAX_PORTFOLIO_RISK   = 0.05;

const ENABLE_CRYPTO = true;
const ENABLE_US     = true;
const ENABLE_LSE    = true;

const SCAN_INTERVAL_MS         = 300000;
const POOL_REFRESH_INTERVAL_MS = 3600000;
const MAX_CONCURRENT_REQUESTS  = 3;

const CRYPTO_COOLDOWN = 2;
const US_COOLDOWN     = 4;
const LSE_COOLDOWN    = 6;

const BREAKOUT_LOOKBACK = 10;

const BREAKOUT_MAX_DISTANCE_CRYPTO = 0.03;
const BREAKOUT_MAX_DISTANCE_US     = 0.04;
const BREAKOUT_MAX_DISTANCE_LSE    = 0.04;

const CRYPTO_PULLBACK_VOL = 1.20;
const US_PULLBACK_VOL     = 1.20;
const LSE_PULLBACK_VOL    = 1.10;

const CRYPTO_BREAKOUT_VOL = 1.60;
const US_BREAKOUT_VOL     = 1.40;
const LSE_BREAKOUT_VOL    = 1.25;

const STOCK_MOMENTUM_OVERRIDE_ENABLED = true;
const STOCK_OVERRIDE_MIN_MOMENTUM     = 0.015;
const STOCK_OVERRIDE_MIN_VOL          = 1.40;
const STOCK_OVERRIDE_MAX_DISTANCE     = 0.025;

const EXTENSION_HARD_LIMIT_CRYPTO = 0.12;
const EXTENSION_HARD_LIMIT_US     = 0.10;
const EXTENSION_HARD_LIMIT_LSE    = 0.08;

const MIN_RR   = 1.5;
const TARGET_R = 1.5;

const MIN_GLOBAL_SCORE = 78;
const MIN_US_SCORE     = 80;
const MIN_LSE_SCORE    = 76;

const PENDING_EXPIRY_HOURS_CRYPTO = 4;
const PENDING_EXPIRY_HOURS_US     = 12;
const PENDING_EXPIRY_HOURS_LSE    = 24;

const MAX_MOMENTUM_BAR_CRYPTO = 0.12;
const MAX_MOMENTUM_BAR_US     = 0.08;
const MAX_MOMENTUM_BAR_LSE    = 0.04;

const MIN_US_MOMENTUM  = 0.015;
const MIN_LSE_MOMENTUM = 0.008;

const MIN_PULLBACK_MOMENTUM_CRYPTO = 0.010;
const MIN_PULLBACK_MOMENTUM_US     = 0.015;
const MIN_PULLBACK_MOMENTUM_LSE    = 0.008;

const MIN_CANDLES             = 60;
const ATR_PERIOD              = 14;
const ATR_PULLBACK_MULTIPLIER = 1.2;
const ATR_BREAKOUT_MULTIPLIER = 1.5;
const ATR_IGNITION_MULTIPLIER = 1.8;

const REPLACEMENT_SCORE_GAP           = 6;
const REPLACEMENT_STALE_HOURS         = 6;
const REPLACEMENT_STALL_PROGRESS      = 0.3;
const REPLACEMENT_PROTECT_TP_PROGRESS = 0.7;

const FORCE_CLOSE_HOURS    = 4;
const FORCE_CLOSE_PROGRESS = 0.2;

const MAX_POSITIONS = { CRYPTO: 1, US: 1, LSE: 1 };

// ── API rotation — daily usage tracking ─────────────────────────
// TwelveData free: 800 credits/day
// Alpha Vantage free: 25 requests/day
// Rotate between them — neither gets exhausted
const API_LIMITS = { twelvedata: 700, alphavantage: 20 };
let apiUsage     = { twelvedata: 0, alphavantage: 0, resetDay: -1 };
let apiRotateIdx = 0; // which API to use next for each symbol

function resetApiUsageIfNewDay() {
  const day = new Date().getUTCDate();
  if (apiUsage.resetDay !== day) {
    apiUsage = { twelvedata: 0, alphavantage: 0, resetDay: day };
    apiRotateIdx = 0;
    console.log("🔄 API usage counters reset for new day");
  }
}

function pickApiForSymbol() {
  resetApiUsageIfNewDay();
  const tdOk = TWELVE_DATA_API_KEY && apiUsage.twelvedata < API_LIMITS.twelvedata;
  const avOk = ALPHA_VANTAGE_API_KEY && apiUsage.alphavantage < API_LIMITS.alphavantage;

  if (!tdOk && !avOk) return "yahoo";   // both exhausted — use free fallback
  if (!tdOk)          return "alphavantage";
  if (!avOk)          return "twelvedata";

  // Both available — alternate per symbol to spread load
  apiRotateIdx++;
  return apiRotateIdx % 2 === 0 ? "twelvedata" : "alphavantage";
}

// ── Sector / narrative maps ──────────────────────────────────────
const SECTOR_SYMBOLS = {
  AI:       ["NVDA", "PLTR", "AMD", "SMCI", "MSFT", "META", "GOOGL", "IONQ", "CRWD", "ANET"],
  GOLD:     ["NEM", "GOLD", "AEM", "WPM", "KGC", "SIL"],
  SILVER:   ["SIL", "WPM", "PAAS", "AG"],
  CRYPTO:   ["COIN", "MSTR", "RIOT", "CLSK"],
  ENERGY:   ["XOM", "CVX", "SLB", "HAL", "MPC"],
  DEFENSE:  ["LMT", "RTX", "NOC", "GD", "AVAV"],
  ROBOTICS: ["ROK", "ISRG", "TER"],
  NUCLEAR:  ["CCJ", "NNE", "SMR", "UUUU", "DNN", "OKLO"]
};

const NARRATIVE_KEYWORDS = {
  AI:       ["artificial intelligence", "ai chip", "machine learning", "llm", "gpu", "nvidia", "generative ai", "foundation model", "openai", "chatgpt"],
  GOLD:     ["gold price", "gold rally", "bullion", "gold futures", "precious metals", "safe haven", "gold hits"],
  SILVER:   ["silver price", "silver rally", "industrial metals", "silver futures"],
  CRYPTO:   ["bitcoin", "ethereum", "crypto rally", "btc", "eth", "digital assets", "blockchain", "crypto surge"],
  ENERGY:   ["oil price", "crude", "energy rally", "opec", "natural gas", "refinery", "brent"],
  DEFENSE:  ["defense spending", "military", "nato", "geopolitical", "weapons", "pentagon", "war", "conflict"],
  ROBOTICS: ["robotics", "automation", "humanoid", "manufacturing robot", "cobots"],
  NUCLEAR:  ["nuclear energy", "uranium", "small modular reactor", "smr", "nuclear power", "fission"]
};

const CRYPTO_AI_NAMES = ["RENDERUSDT", "FETUSDT", "NEARUSDT", "TAOUSDT", "AGIXUSDT", "OCEANUSDT"];

// ── Static pools ─────────────────────────────────────────────────
// Kept to 25 core names — reduces API calls to stay in free limits
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

// ── Dynamic pools ────────────────────────────────────────────────
let STOCK_POOL   = [...new Set(STATIC_STOCK_FALLBACK)];
let CRYPTO_PAIRS = [...STATIC_CRYPTO_FALLBACK];
let HOT_SECTORS  = [];

// ── Acceptable ticker pattern — NYSE/NASDAQ only, no OTC junk ───
const CLEAN_TICKER = /^[A-Z]{1,5}$/;
const OTC_SUFFIXES = ["F", "Y", "PK"]; // foreign ADRs and OTC indicators

function isCleanTicker(sym) {
  if (!CLEAN_TICKER.test(sym)) return false;
  if (sym.length === 5 && OTC_SUFFIXES.some(s => sym.endsWith(s))) return false;
  return true;
}

// ── Runtime state ────────────────────────────────────────────────
let running       = false;
let btcTrend      = "neutral";
let qqqTrend      = "neutral";
let marketWasOpen = { CRYPTO: false, US: false, LSE: false };

// ── Candle cache ─────────────────────────────────────────────────
const candleCache  = new Map();
const CACHE_TTL_MS = 4 * 60 * 1000;

function getCached(key) {
  const entry = candleCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { candleCache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  candleCache.set(key, { ts: Date.now(), data });
}

// ── Utilities ────────────────────────────────────────────────────
function nowIso()   { return new Date().toISOString(); }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }
function dedup(arr) { return [...new Set(arr.filter(Boolean))]; }
function avg(arr)   { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function lines(parts) { return parts.join(String.fromCharCode(10)); }

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
    catch (e) {
      if (i === retries) throw e;
      await sleep(delay * Math.pow(2, i));
    }
  }
}

// ── Supabase / persistence ───────────────────────────────────────
async function loadAlerts() {
  if (!supabaseEnabled) return loadLocal(FILES.alerts, []);
  try {
    const { data, error } = await retry(() =>
      supabase.from("alerts").select("*").order("sentAt", { ascending: false }).limit(500)
    );
    if (error) throw error;
    return data || [];
  } catch { return loadLocal(FILES.alerts, []); }
}

async function loadTrades() {
  if (!supabaseEnabled) return loadLocal(FILES.trades, []);
  try {
    const { data, error } = await retry(() =>
      supabase.from("trades").select("*").order("sentAt", { ascending: false }).limit(500)
    );
    if (error) throw error;
    return data || [];
  } catch { return loadLocal(FILES.trades, []); }
}

async function saveAlerts(alerts) {
  if (!supabaseEnabled) { saveLocal(FILES.alerts, alerts); return; }
  try {
    const { error } = await retry(() =>
      supabase.from("alerts").upsert(alerts, { onConflict: "id" })
    );
    if (error) throw error;
    saveLocal(FILES.alerts, alerts);
  } catch { saveLocal(FILES.alerts, alerts); }
}

async function saveTrades(trades) {
  if (!supabaseEnabled) { saveLocal(FILES.trades, trades); return; }
  try {
    const { error } = await retry(() =>
      supabase.from("trades").upsert(trades, { onConflict: "id" })
    );
    if (error) throw error;
    saveLocal(FILES.trades, trades);
  } catch { saveLocal(FILES.trades, trades); }
}

// ── Market helpers ───────────────────────────────────────────────
function marketCooldownHours(market) {
  if (market === "CRYPTO") return CRYPTO_COOLDOWN;
  if (market === "LSE")    return LSE_COOLDOWN;
  return US_COOLDOWN;
}

function pendingExpiryHours(market) {
  if (market === "CRYPTO") return PENDING_EXPIRY_HOURS_CRYPTO;
  if (market === "LSE")    return PENDING_EXPIRY_HOURS_LSE;
  return PENDING_EXPIRY_HOURS_US;
}

function breakoutDistanceLimitForMarket(market) {
  if (market === "CRYPTO") return BREAKOUT_MAX_DISTANCE_CRYPTO;
  if (market === "LSE")    return BREAKOUT_MAX_DISTANCE_LSE;
  return BREAKOUT_MAX_DISTANCE_US;
}

function breakoutVolForMarket(market) {
  if (market === "CRYPTO") return CRYPTO_BREAKOUT_VOL;
  if (market === "LSE")    return LSE_BREAKOUT_VOL;
  return US_BREAKOUT_VOL;
}

function pullbackVolForMarket(market) {
  if (market === "CRYPTO") return CRYPTO_PULLBACK_VOL;
  if (market === "LSE")    return LSE_PULLBACK_VOL;
  return US_PULLBACK_VOL;
}

function extensionLimitForMarket(market) {
  if (market === "CRYPTO") return EXTENSION_HARD_LIMIT_CRYPTO;
  if (market === "LSE")    return EXTENSION_HARD_LIMIT_LSE;
  return EXTENSION_HARD_LIMIT_US;
}

function maxMomentumBarForMarket(market) {
  if (market === "CRYPTO") return MAX_MOMENTUM_BAR_CRYPTO;
  if (market === "LSE")    return MAX_MOMENTUM_BAR_LSE;
  return MAX_MOMENTUM_BAR_US;
}

function minMomentumForMarket(market) {
  if (market === "US")  return MIN_US_MOMENTUM;
  if (market === "LSE") return MIN_LSE_MOMENTUM;
  return 0;
}

function minPullbackMomentumForMarket(market) {
  if (market === "CRYPTO") return MIN_PULLBACK_MOMENTUM_CRYPTO;
  if (market === "LSE")    return MIN_PULLBACK_MOMENTUM_LSE;
  return MIN_PULLBACK_MOMENTUM_US;
}

function isCryptoWindowOpen() {
  const h = new Date().getUTCHours();
  return h >= 5 && h < 21; // 06:00–22:00 UK BST
}

function isUSMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return m >= 810 && m < 1200; // 14:30–21:00 UK BST = 13:30–20:00 UTC
}

function isUSOpeningWindow() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return m >= 810 && m < 900; // 14:30–16:00 UK = 13:30–15:00 UTC
}

function isLSEMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return m >= 420 && m < 930; // 08:00–16:30 UK BST = 07:00–15:30 UTC
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
  if (market === "US")     return qqqTrend !== "risk_off";
  return true;
}

function minScoreForMarket(market) {
  if (market === "CRYPTO") return btcTrend === "strong_bull" ? 76 : 80;
  if (market === "LSE")    return MIN_LSE_SCORE;
  return MIN_US_SCORE;
}

function calculateATR(candles, period) {
  if (!period) period = ATR_PERIOD;
  if (!candles || candles.length < period + 1) return null;
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high, low = candles[i].low, prevClose = candles[i - 1].close;
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
      const i = index++;
      results[i] = await asyncFn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ── Telegram ─────────────────────────────────────────────────────
async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) { console.log(msg); return; }
  try {
    await retry(() =>
      axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID, text: msg, parse_mode: "HTML"
      }, { timeout: 10000 })
    );
  } catch (e) { console.log("TELEGRAM ERROR:", e.message); }
}

// ── CoinGecko ────────────────────────────────────────────────────
async function getTrendingCoins() {
  try {
    const headers = COINGECKO_API_KEY ? { "x-cg-demo-api-key": COINGECKO_API_KEY } : {};
    const { data } = await retry(() =>
      axios.get("https://api.coingecko.com/api/v3/search/trending", { headers, timeout: 12000 })
    );
    const symbols = (data?.coins || [])
      .map(c => { const s = (c?.item?.symbol || "").toUpperCase(); return s ? s + "USDT" : null; })
      .filter(Boolean).slice(0, 12);
    console.log("🪙 CoinGecko trending:", symbols.join(", ") || "none");
    return symbols;
  } catch (e) { console.log("CoinGecko failed:", e.message); return []; }
}

// ── Finnhub: trending stocks (clean tickers only) ────────────────
async function getTrendingStocks() {
  if (!FINNHUB_API_KEY) return [...STATIC_STOCK_FALLBACK];
  try {
    const { data } = await retry(() =>
      axios.get("https://finnhub.io/api/v1/stock/symbol", {
        params: { exchange: "US", token: FINNHUB_API_KEY },
        timeout: 15000
      })
    );
    if (!Array.isArray(data)) throw new Error("Invalid response");

    // V84: strict filter — only clean NYSE/NASDAQ common stocks, no OTC junk
    const filtered = data
      .filter(s =>
        s.type === "Common Stock" &&
        isCleanTicker(s.symbol) &&
        s.mic && ["XNYS", "XNAS"].includes(s.mic) // NYSE or NASDAQ only
      )
      .map(s => s.symbol)
      .slice(0, 10); // only top 10 from Finnhub, rest from core list

    const core = [
      "NVDA", "PLTR", "AMD", "ASTS", "IONQ", "MSFT", "META",
      "AMZN", "APP", "MSTR", "COIN", "QQQ", "SMH", "AVGO", "VRT"
    ];
    const merged = dedup([...core, ...filtered]).slice(0, 25);
    console.log(`📈 Stock pool: ${merged.length} clean symbols`);
    return merged;
  } catch (e) {
    console.log("Finnhub stocks failed:", e.message, "— using fallback");
    return [...STATIC_STOCK_FALLBACK];
  }
}

// ── Narrative change detection ───────────────────────────────────
// Only send narrative alert if something has actually changed
let lastNarrativeState = { sectors: "", stockMovers: "", cryptoMovers: "" };

function narrativeHasChanged(sectors, stockMovers, cryptoMovers) {
  const newState = {
    sectors:      sectors.join(","),
    stockMovers:  stockMovers.slice(0, 6).join(","),
    cryptoMovers: cryptoMovers.map(c => c.symbol).join(",")
  };
  const changed =
    newState.sectors      !== lastNarrativeState.sectors ||
    newState.stockMovers  !== lastNarrativeState.stockMovers ||
    newState.cryptoMovers !== lastNarrativeState.cryptoMovers;
  if (changed) lastNarrativeState = newState;
  return changed;
}

// ── Market hours check for alerts ───────────────────────────────
function isAlertableHours() {
  if (isWeekend()) return false;
  // Only alert during active market hours — LSE open to US close
  // 07:00–20:00 UTC covers LSE open through US close
  const h = new Date().getUTCHours();
  return h >= 7 && h < 20;
}

// ── Top movers (stocks) ──────────────────────────────────────────
async function getTopMovers() {
  if (!FINNHUB_API_KEY) return [];
  try {
    const candidates = ["NVDA", "ASTS", "IONQ", "PLTR", "AMD", "COIN", "MSTR", "AVAV", "SMR", "OKLO", "CRWD", "APP", "RKLB", "LUNR", "ACHR"];
    const movers = [];
    await mapWithConcurrency(candidates, 4, async sym => {
      try {
        const { data } = await axios.get("https://finnhub.io/api/v1/quote", {
          params: { symbol: sym, token: FINNHUB_API_KEY }, timeout: 8000
        });
        const changePct = data?.dp;
        if (Number.isFinite(changePct) && changePct > 3) {
          movers.push({ sym, changePct });
          console.log(`🚀 Top mover: ${sym} +${changePct.toFixed(2)}%`);
        }
      } catch { /* skip */ }
    });
    return movers.sort((a, b) => b.changePct - a.changePct).map(m => m.sym);
  } catch (e) { console.log("Top movers failed:", e.message); return []; }
}

// ── Crypto momentum scanner ──────────────────────────────────────
// Checks 24hr change for crypto pairs in pool — used in narrative alert
async function getCryptoMovers() {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/ticker/24hr", { timeout: 12000 })
    );
    if (!Array.isArray(data)) return [];
    return data
      .filter(t => CRYPTO_PAIRS.includes(t.symbol))
      .map(t => ({ symbol: t.symbol, changePct: +t.priceChangePercent }))
      .filter(t => Number.isFinite(t.changePct) && t.changePct > 3)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 8);
  } catch (e) {
    console.log("Crypto movers check failed:", e.message);
    return [];
  }
}

// ── Narrative detection ──────────────────────────────────────────
async function detectHotSectors() {
  if (!FINNHUB_API_KEY) return [];
  try {
    const { data } = await retry(() =>
      axios.get("https://finnhub.io/api/v1/news", {
        params: { category: "general", token: FINNHUB_API_KEY }, timeout: 12000
      })
    );
    if (!Array.isArray(data)) return [];
    const text = data.slice(0, 60)
      .map(n => ((n.headline || "") + " " + (n.summary || "")).toLowerCase()).join(" ");
    const scores = {};
    for (const [sector, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
      scores[sector] = keywords.filter(kw => text.includes(kw)).length;
    }
    const active = Object.entries(scores)
      .filter(([, s]) => s >= 2).sort((a, b) => b[1] - a[1]).map(([s]) => s);
    console.log("🧠 Hot sectors:", active.join(", ") || "none");
    return active;
  } catch (e) { console.log("Narrative detection failed:", e.message); return []; }
}

// ── Dynamic pool refresh ─────────────────────────────────────────
async function refreshDynamicPools() {
  console.log("🔄 Refreshing dynamic pools...");
  const trendingCoins = await getTrendingCoins();
  CRYPTO_PAIRS = dedup([...STATIC_CRYPTO_FALLBACK, ...trendingCoins]).slice(0, 15);

  HOT_SECTORS = await detectHotSectors();

  const [trendingStocks, topMovers] = await Promise.all([
    getTrendingStocks(),
    getTopMovers()
  ]);

  const sectorInjected = [];
  for (const sector of HOT_SECTORS) {
    const syms = (SECTOR_SYMBOLS[sector] || []).filter(isCleanTicker);
    sectorInjected.push(...syms);
    console.log(`💉 Injecting ${sector}: ${syms.join(", ")}`);
  }

  STOCK_POOL = dedup([...trendingStocks, ...topMovers, ...sectorInjected]).slice(0, 25);

  console.log(`✅ Pools ready — Crypto: ${CRYPTO_PAIRS.length}, Stocks: ${STOCK_POOL.length}`);
  console.log(`📊 API usage — TD: ${apiUsage.twelvedata}/${API_LIMITS.twelvedata}, AV: ${apiUsage.alphavantage}/${API_LIMITS.alphavantage}`);

  // Only send narrative alert during market hours AND if something changed
  if (!isAlertableHours()) {
    console.log("📅 Outside alert hours — skipping narrative alert");
    return;
  }

  const cryptoMovers = await getCryptoMovers();

  if (narrativeHasChanged(HOT_SECTORS, topMovers, cryptoMovers)) {
    console.log("🔔 Narrative state changed — sending alert");
    await sendNarrativeAlert(topMovers, cryptoMovers);
  } else {
    console.log("🔕 Narrative unchanged — skipping alert");
  }
}

async function sendNarrativeAlert(topMovers, cryptoMovers) {
  // V85: Silent — logs only, no Telegram noise
  // Narrative data is used internally for scoring, not for alerts
  if (topMovers.length > 0) {
    console.log("📈 Stock movers:", topMovers.slice(0, 6).join(", "));
  }
  if (Array.isArray(cryptoMovers) && cryptoMovers.length > 0) {
    console.log("🪙 Crypto movers:", cryptoMovers.map(c => `${c.symbol.replace("USDT","")} +${c.changePct.toFixed(1)}%`).join(", "));
  }
}

// ── Data fetching: crypto (Binance — always free) ────────────────
async function fetchCrypto(symbol) {
  const cacheKey = `crypto_${symbol}`;
  const cached = getCached(cacheKey);
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

// ── Data fetching: TwelveData ────────────────────────────────────
async function fetchTwelveDataSeries(symbol, interval, outputsize) {
  if (!interval)   interval   = "1h";
  if (!outputsize) outputsize = 70;
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

// ── Data fetching: Alpha Vantage ─────────────────────────────────
async function fetchAlphaVantageSeries(symbol, interval) {
  if (!interval) interval = "60min";
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
  } catch { return null; }
}

// ── Data fetching: Yahoo Finance (free emergency fallback) ────────
async function fetchYahooFinanceSeries(symbol, interval) {
  // interval: "1h" or "15m"
  const yahooInterval = interval === "15min" ? "15m" : "1h";
  const range         = yahooInterval === "15m" ? "5d" : "30d";
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
      close:  q.close[i]  || 0,
      high:   q.high[i]   || 0,
      low:    q.low[i]    || 0,
      volume: q.volume[i] || 0
    })).filter(x => Number.isFinite(x.close) && x.close > 0);
  } catch (e) {
    console.log(`Yahoo Finance failed for ${symbol}:`, e.message);
    return null;
  }
}

// ── Smart US data fetcher with rotation ──────────────────────────
async function fetchUSData(symbol) {
  const use15min   = isUSOpeningWindow();
  const interval   = use15min ? "15min" : "1h";
  const cacheKey   = `us_${symbol}_${interval}`;

  const cached = getCached(cacheKey);
  if (cached) return cached;

  resetApiUsageIfNewDay();
  const api = pickApiForSymbol();

  let candles = null;

  if (api === "twelvedata") {
    candles = await fetchTwelveDataSeries(symbol, interval, use15min ? 40 : 70);
    if (!candles) {
      // TwelveData failed — try the other one
      candles = await fetchAlphaVantageSeries(symbol, use15min ? "15min" : "60min");
      if (candles) console.log(`↩️ AV fallback for ${symbol}`);
    }
  } else if (api === "alphavantage") {
    candles = await fetchAlphaVantageSeries(symbol, use15min ? "15min" : "60min");
    if (!candles) {
      candles = await fetchTwelveDataSeries(symbol, interval, use15min ? 40 : 70);
      if (candles) console.log(`↩️ TD fallback for ${symbol}`);
    }
  }

  // Both paid APIs exhausted — use free Yahoo Finance
  if (!candles) {
    console.log(`🆓 Yahoo Finance for ${symbol} (API limits reached)`);
    candles = await fetchYahooFinanceSeries(symbol, interval);
  }

  if (candles) setCache(cacheKey, candles);
  return candles;
}

async function fetchLSEData(symbol) {
  const cacheKey = `lse_${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  // LSE: use TwelveData only — Yahoo LSE symbols are unreliable
  const candles = await fetchTwelveDataSeries(symbol, "1h", 70);
  if (candles) setCache(cacheKey, candles);
  return candles;
}

// ── Live price fetching ──────────────────────────────────────────
async function fetchLivePriceTwelve(asset) {
  if (!TWELVE_DATA_API_KEY) return null;
  try {
    const { data } = await retry(() =>
      axios.get("https://api.twelvedata.com/price", {
        params: { symbol: asset, apikey: TWELVE_DATA_API_KEY }, timeout: 12000
      })
    );
    if (data?.status === "error") return null;
    apiUsage.twelvedata++;
    return +data.price;
  } catch { return null; }
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
  } catch { return null; }
}

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
    let price = await fetchLivePriceTwelve(asset);
    if (!Number.isFinite(price)) {
      price = await fetchLivePriceYahoo(asset);
    }
    return price;
  } catch { return null; }
}

// ── Trend updates ────────────────────────────────────────────────
async function updateBTCTrend() {
  const candles = await fetchCrypto("BTCUSDT");
  if (!candles) return;
  const closes = candles.map(x => x.close);
  const prev   = btcTrend;
  btcTrend = classifyRegime(ema(closes, 20), ema(closes, 50), closes.at(-1));
  if (btcTrend !== prev) console.log(`📡 BTC trend: ${prev} → ${btcTrend}`);
}

async function updateQQQTrend() {
  if (!ENABLE_US || !isUSMarketOpen()) { qqqTrend = "neutral"; return; }
  const candles = await fetchUSData("QQQ");
  if (!candles) { qqqTrend = "neutral"; return; }
  const closes = candles.map(x => x.close);
  const prev   = qqqTrend;
  qqqTrend = classifyRegime(ema(closes, 20), ema(closes, 50), closes.at(-1));
  if (qqqTrend !== prev) console.log(`📡 QQQ trend: ${prev} → ${qqqTrend}`);
}

// ── Market open/close alerts ─────────────────────────────────────
function buildMarketOpenMessage(market) {
  if (market === "CRYPTO") return lines(["\uD83D\uDFE2\uD83D\uDE80 <b>CRYPTO WINDOW OPEN</b>", "", "\u23F0 Scanning 06:00\u201322:00 UK time", `\uD83D\uDCE1 BTC trend: <b>${escapeHtml(btcTrend.toUpperCase())}</b>`, `\uD83D\uDD0D Pairs active: ${CRYPTO_PAIRS.length}`]);
  if (market === "US")     return lines(["\uD83D\uDFE2\uD83D\uDCC8 <b>US MARKET OPEN</b>", "", "\u23F0 14:30\u201321:00 UK time", `\uD83D\uDCE1 QQQ trend: <b>${escapeHtml(qqqTrend.toUpperCase())}</b>`, `\uD83D\uDD0D Stocks in pool: ${STOCK_POOL.length}`]);
  return lines(["\uD83D\uDFE2\uD83C\uDFE6 <b>LSE MARKET OPEN</b>", "", "\u23F0 08:00\u201316:30 UK time", `\uD83D\uDD0D Stocks in pool: ${LSE_POOL.length}`]);
}

function buildMarketCloseMessage(market) {
  if (market === "CRYPTO") return lines(["\uD83D\uDD34\uD83D\uDCA4 <b>CRYPTO WINDOW CLOSED</b>", "", "\uD83D\uDE34 Scanning paused until 06:00 UK time"]);
  if (market === "US")     return lines(["\uD83D\uDD34\uD83D\uDCC9 <b>US MARKET CLOSED</b>", "", "\uD83C\uDFC1 Session ended \u2014 see you at 14:30 UK tomorrow"]);
  return lines(["\uD83D\uDD34\uD83C\uDFE6 <b>LSE MARKET CLOSED</b>", "", "\uD83C\uDFC1 Session ended \u2014 see you at 08:00 UK tomorrow"]);
}

async function checkMarketAlerts() {
  const checks = [
    { key: "CRYPTO", isOpen: isCryptoWindowOpen },
    { key: "US",     isOpen: isUSMarketOpen     },
    { key: "LSE",    isOpen: isLSEMarketOpen    }
  ];
  for (const { key, isOpen } of checks) {
    const nowOpen = isOpen();
    if (nowOpen  && !marketWasOpen[key]) console.log(`🟢 ${key} market open`);
    if (!nowOpen &&  marketWasOpen[key]) console.log(`🔴 ${key} market closed`);
    marketWasOpen[key] = nowOpen;
  }
}

// ── Narrative bonus ──────────────────────────────────────────────
function getNarrativeBonus(asset) {
  let bonus = 0;
  const sym = asset.replace("USDT", "");
  for (const sector of HOT_SECTORS) {
    if ((SECTOR_SYMBOLS[sector] || []).includes(sym)) { bonus += 6; }
  }
  if (HOT_SECTORS.includes("AI") && CRYPTO_AI_NAMES.includes(asset)) { bonus += 5; }
  return bonus;
}

// ── Emoji helpers ────────────────────────────────────────────────
function gradeEmoji(g)   { return g === "A*" ? "\uD83D\uDC8E\uD83D\uDD25" : g === "A" ? "\uD83D\uDE80\u26A1" : "\uD83D\uDCC8"; }
function setupEmoji(t)   { return t === "BREAKOUT_CONTINUATION" ? "\uD83D\uDCA5" : t === "PULLBACK_CONTINUATION" ? "\uD83C\uDFAF" : t === "MOMENTUM_BREAKOUT" ? "\uD83D\uDD25" : t === "MOMENTUM_IGNITION" ? "\u26A1" : "\uD83D\uDCCA"; }
function marketEmoji(m)  { return m === "CRYPTO" ? "\uD83E\uDE99" : m === "US" ? "\uD83C\uDDFA\uD83C\uDDF8" : m === "LSE" ? "\uD83C\uDDEC\uD83C\uDDE7" : "\uD83D\uDCCA"; }

// ── Exceptional regime override ──────────────────────────────────
// Fires even when BTC trend is neutral if move is strong enough
// Threshold: 1.5% on the hourly candle + 1.8x volume
// This catches altcoin breakouts during ranging BTC
const REGIME_OVERRIDE_MIN_VOL      = 1.8;  // was 2.0
const REGIME_OVERRIDE_MIN_MOMENTUM = 0.015; // was 0.025 — 24hr moves spread across hourly candles

// ── Core analysis ────────────────────────────────────────────────
function analyse(asset, candles, market) {
  if (!candles || candles.length < MIN_CANDLES) return null;

  const closes  = candles.map(x => x.close);
  const highs   = candles.map(x => x.high);
  const lows    = candles.map(x => x.low);
  const volumes = candles.map(x => x.volume || 0);

  const last = closes.at(-1);
  const prev = closes.at(-2);
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) return null;

  const momentum = (last - prev) / prev;
  if (momentum <= 0) return null;

  const ema20     = ema(closes, 20);
  const ema50     = ema(closes, 50);
  const ema20Prev = ema(closes.slice(0, -1), 20);
  if (!(ema20 > ema50 && last > ema20 && ema20 > ema20Prev)) return null;

  const avgVol     = avg(volumes.slice(-21, -1));
  const currentVol = volumes.at(-1);
  const volRatio   = avgVol > 0 ? currentVol / avgVol : 0;

  // Exceptional crypto override — fires regardless of BTC trend
  const exceptionalCrypto =
    market === "CRYPTO" &&
    momentum >= REGIME_OVERRIDE_MIN_MOMENTUM &&
    volRatio >= REGIME_OVERRIDE_MIN_VOL;

  if (!regimePass(market) && !exceptionalCrypto) {
    if (market === "CRYPTO") console.log(`⛔ ${asset} blocked — BTC ${btcTrend}, mom=${(momentum*100).toFixed(2)}% vol=${volRatio.toFixed(2)}x (need ${REGIME_OVERRIDE_MIN_MOMENTUM*100}% + ${REGIME_OVERRIDE_MIN_VOL}x for override)`);
    return null;
  }

  if (exceptionalCrypto && !regimePass(market)) {
    console.log(`⚡ Regime override: ${asset} vol=${volRatio.toFixed(2)}x mom=${(momentum*100).toFixed(2)}%`);
  }

  const extension = (last - ema20) / ema20;
  if (extension > extensionLimitForMarket(market)) return null;

  const breakoutLevel    = Math.max(...highs.slice(-BREAKOUT_LOOKBACK, -1));
  const breakoutDistance = breakoutLevel > 0 ? (last - breakoutLevel) / breakoutLevel : 0;

  const recentRanges   = highs.slice(-5, -1).map((h, i) => h - lows.slice(-5, -1)[i]).filter(Number.isFinite);
  const priorRanges    = highs.slice(-10, -5).map((h, i) => h - lows.slice(-10, -5)[i]).filter(Number.isFinite);
  const expandingRange = avg(recentRanges) > 0 && avg(priorRanges) > 0 && avg(recentRanges) > avg(priorRanges) * 1.3;

  const ignitionSignal       = momentum > 0.025 && volRatio > 2.0 && last > ema20 && expandingRange;
  const strongMomentumOverride = market === "US" && STOCK_MOMENTUM_OVERRIDE_ENABLED && momentum >= STOCK_OVERRIDE_MIN_MOMENTUM && volRatio >= STOCK_OVERRIDE_MIN_VOL && breakoutDistance <= STOCK_OVERRIDE_MAX_DISTANCE;
  const breakoutSignal       = last > breakoutLevel && breakoutDistance <= breakoutDistanceLimitForMarket(market) && volRatio >= breakoutVolForMarket(market) && momentum >= minMomentumForMarket(market);

  const nearEMAThreshold   = market === "US" ? 0.02 : 0.025;
  const nearEMA20          = Math.abs(last - ema20) / ema20 <= nearEMAThreshold;
  const pulledBackRecently = closes.slice(-6, -1).some(c => c <= ema20 * 1.01);
  const pullbackSignal     = nearEMA20 && pulledBackRecently && volRatio >= pullbackVolForMarket(market);

  if (!pullbackSignal && !breakoutSignal && !strongMomentumOverride && !ignitionSignal) return null;

  let setupType = "BREAKOUT_CONTINUATION";
  if (pullbackSignal && !breakoutSignal && !ignitionSignal) setupType = "PULLBACK_CONTINUATION";
  if (strongMomentumOverride && !ignitionSignal)            setupType = "MOMENTUM_BREAKOUT";
  if (ignitionSignal)                                        setupType = "MOMENTUM_IGNITION";

  if (setupType === "PULLBACK_CONTINUATION" && momentum < minPullbackMomentumForMarket(market)) return null;

  const momentumCap = setupType === "MOMENTUM_IGNITION" ? 0.20 : maxMomentumBarForMarket(market);
  if (momentum > momentumCap) return null;

  const entryType = setupType === "PULLBACK_CONTINUATION" ? "LIMIT BUY" : "MARKET BUY";
  const entry     = setupType === "PULLBACK_CONTINUATION" ? ema20 * 1.002 : last;

  const atr = calculateATR(candles, ATR_PERIOD);
  if (!atr || atr <= 0) return null;

  const swingLow = Math.min(...lows.slice(-6));
  const atrMult  = setupType === "PULLBACK_CONTINUATION" ? ATR_PULLBACK_MULTIPLIER : setupType === "MOMENTUM_IGNITION" ? ATR_IGNITION_MULTIPLIER : ATR_BREAKOUT_MULTIPLIER;

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
  if (setupType === "MOMENTUM_BREAKOUT")     score += 14;
  if (setupType === "MOMENTUM_IGNITION")     score += 18;
  if (market === "CRYPTO") score += 5;
  if (market === "US")     score += 4;
  if (market === "LSE")    score += 2;
  if (market === "CRYPTO" && btcTrend === "strong_bull") score += 5;
  if (market === "US"     && qqqTrend === "bull")        score += 3;
  if (market === "US"     && qqqTrend === "strong_bull") score += 5;
  if (breakoutDistance > 0 && breakoutDistance <= 0.01)  score += 4;
  if (expandingRange)  score += 4;
  score += getNarrativeBonus(asset);

  let grade = "B";
  if (score >= 85) grade = "A*";
  else if (score >= 78) grade = "A";

  if (score >= MIN_GLOBAL_SCORE) {
    console.log(`✅ ${asset} ${market} ${setupType} score=${score} grade=${grade} vol=${volRatio.toFixed(2)}x mom=${(momentum*100).toFixed(2)}%`);
  }

  return { asset, market, grade, setupType, status: "CONFIRMED", entryType, entry, sl, tp, rr, score, momentum, volRatio, breakoutDistance, atr, regime: market === "CRYPTO" ? btcTrend : market === "US" ? qqqTrend : "LSE_LOCAL" };
}

// ── Trading coach ────────────────────────────────────────────────
function buildSignalLesson(signal) {
  const parts = ["\uD83D\uDCDA <b>TRADE LESSON</b>", ""];
  if (signal.setupType === "BREAKOUT_CONTINUATION") parts.push("\uD83D\uDCA5 <b>Breakout Continuation</b> \u2014 price pushed above a recent resistance level. Market buy gets you in immediately rather than waiting and missing the move.");
  else if (signal.setupType === "PULLBACK_CONTINUATION") parts.push("\uD83C\uDFAF <b>Pullback Continuation</b> \u2014 price dipped back to its 20-period EMA (the trend\u2019s centre line) and is bouncing. Lower-risk entry \u2014 buying a dip within an uptrend.");
  else if (signal.setupType === "MOMENTUM_BREAKOUT") parts.push("\uD83D\uDD25 <b>Momentum Breakout</b> \u2014 strong candle with high volume pushing through resistance. Volume confirms real buying pressure, not noise.");
  else if (signal.setupType === "MOMENTUM_IGNITION") parts.push("\u26A1 <b>Momentum Ignition</b> \u2014 explosive early runner before full breakout confirmation. Volume 2x+, price accelerating, range expanding. Higher risk, higher reward \u2014 size carefully.");

  if (signal.volRatio >= 3.0)      parts.push(`\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x</b> \u2014 exceptional. Institutional money actively buying.`);
  else if (signal.volRatio >= 2.0) parts.push(`\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x</b> \u2014 very strong. Double the norm confirms real conviction.`);
  else                              parts.push(`\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x</b> \u2014 above normal. Move has buyers behind it.`);

  if (signal.market === "CRYPTO") {
    if (signal.asset === "BTCUSDT") parts.push("\n\uD83E\uDE99 <b>BTC note</b> \u2014 watch percentages not dollar amounts. 1-2% is a normal BTC day.");
    else parts.push(`\n\uD83E\uDE99 <b>Altcoin note</b> \u2014 ${signal.asset.replace("USDT","")} can move 5-15% in a session when BTC is bullish (BTC: ${btcTrend.replace("_"," ")}).`);
  } else if (signal.market === "US") {
    parts.push(`\n\uD83C\uDDFA\uD83C\uDDF8 <b>US note</b> \u2014 QQQ trend is <b>${qqqTrend.replace("_"," ")}</b>. Strong QQQ = wind behind breakouts.`);
  } else {
    parts.push("\n\uD83C\uDDEC\uD83C\uDDE7 <b>LSE note</b> \u2014 London stocks move slower. Expect this to develop over hours.");
  }

  const matched = HOT_SECTORS.filter(s => (SECTOR_SYMBOLS[s]||[]).includes(signal.asset.replace("USDT","")));
  if (matched.length > 0) parts.push(`\n\uD83E\uDDE0 <b>Narrative: ${matched.join(", ")}</b> \u2014 institutional money flowing into this sector right now.`);
  if (signal.grade === "A*") parts.push("\n\u2B50 <b>A* grade</b> \u2014 highest rating. All conditions aligned. Pay close attention.");
  else if (signal.grade === "A") parts.push("\n\u2B50 <b>A grade</b> \u2014 strong signal. Most conditions met.");
  parts.push(`\n\u26A1 <b>Momentum: ${(signal.momentum*100).toFixed(2)}%</b> \u2014 above 1% = conviction. Above 2.5% = explosive.`);
  return lines(parts);
}

function buildCloseLesson(trade, reason, closePrice) {
  const rVal       = Number.isFinite(trade.realizedR) ? +trade.realizedR.toFixed(2) : null;
  const priceMoved = Number.isFinite(closePrice) && Number.isFinite(trade.entry) ? ((closePrice - trade.entry) / trade.entry * 100).toFixed(2) : null;
  const hoursHeld  = hoursAgo(trade.filledAt || trade.sentAt).toFixed(1);
  const parts = ["\uD83D\uDCD6 <b>TRADE DEBRIEF</b>", ""];
  if (reason === "TAKE PROFIT") {
    parts.push(`\u2705 <b>Target hit.</b> Price moved ${priceMoved ? priceMoved + "%" : "as expected"} to reach take profit.`);
    if (rVal !== null) parts.push(`\n\uD83D\uDCCA <b>${rVal}R</b> \u2014 you made ${rVal}x what you risked. Consistently hitting 1.5R+ is what makes a system profitable.`);
  } else if (reason === "STOP LOSS") {
    parts.push(`\uD83D\uDED1 <b>Stop loss triggered.</b> Price moved against the trade${priceMoved ? " by " + Math.abs(+priceMoved) + "%" : ""}. Normal \u2014 great systems lose 40-50% of trades. The stop is doing its job.`);
    parts.push("\n\uD83D\uDCA1 A stop loss isn\u2019t failure. It\u2019s risk management working correctly.");
  } else if (reason === "FORCE CLOSE") {
    parts.push(`\u23F1\uFE0F <b>Force closed.</b> Open ${hoursHeld} hours without progress. Cut to free capital for better opportunities.`);
    parts.push("\n\uD83D\uDCA1 Time is a cost. A sideways trade ties up capital. Cutting stale trades early is disciplined risk management.");
  } else if (reason === "REPLACED") {
    parts.push("\uD83D\uDD04 <b>Trade replaced.</b> Higher-scoring signal appeared. Only happens when new signal scores significantly higher AND this wasn\u2019t progressing.");
  } else if (reason === "PENDING_EXPIRED") {
    parts.push("\u231B <b>Order expired.</b> Entry never reached within time window.\n\uD83D\uDCA1 A missed trade is not a loss. Better to expire than chase.");
  } else if (reason === "STRUCTURE_INVALID") {
    parts.push("\u26A0\uFE0F <b>Structure invalidated.</b> Price dropped below stop before entry. Setup broke down \u2014 protected you from a bad entry.");
  } else if (reason === "DRIFTED_TOO_FAR") {
    parts.push("\uD83C\uDF0A <b>Drifted too far.</b> Price ran away without filling. Chasing extended moves increases risk.");
  }
  if (Number.isFinite(trade.maePct) && Number.isFinite(trade.mfePct)) {
    parts.push(`\n\uD83D\uDCC9 <b>MAE: ${(trade.maePct*100).toFixed(2)}%</b> (max against) \u2022 \uD83D\uDCC8 <b>MFE: ${(trade.mfePct*100).toFixed(2)}%</b> (max favour)\nTracking these tells you if stops are too tight or you\u2019re leaving money on the table.`);
  }
  return lines(parts);
}

// ── Message builders ─────────────────────────────────────────────
function buildSignalMessage(signal, size) {
  const isMarket = signal.entryType === "MARKET BUY";
  const sym = signal.asset.replace("USDT", "");
  const matched = HOT_SECTORS.filter(s => (SECTOR_SYMBOLS[s]||[]).includes(sym));
  const narrativeTag = matched.length > 0 ? `\n\uD83E\uDDE0 <b>NARRATIVE: ${escapeHtml(matched.join(" + "))}</b>` : "";
  return lines([
    `\uD83D\uDEA8 ${gradeEmoji(signal.grade)} <b>${escapeHtml(signal.grade)} SIGNAL</b>${narrativeTag}`, "",
    `${marketEmoji(signal.market)} <b>${escapeHtml(signal.market)} | ${escapeHtml(signal.asset)}</b>`,
    `${setupEmoji(signal.setupType)} ${escapeHtml(signal.setupType)}`, "",
    isMarket ? `\u26A1 <b>MARKET BUY NOW</b> ~${escapeHtml(formatPrice(signal.entry, signal.market))}` : `\uD83D\uDCB0 Limit Entry: ${escapeHtml(formatPrice(signal.entry, signal.market))}`,
    `\uD83D\uDEE1\uFE0F SL:    ${escapeHtml(formatPrice(signal.sl, signal.market))}`,
    `\uD83C\uDFAF TP:    ${escapeHtml(formatPrice(signal.tp, signal.market))}`,
    `\u2696\uFE0F R:R:   ${escapeHtml(String(signal.rr))}`,
    `\u2B50 Score: ${escapeHtml(String(signal.score))}`,
    `\uD83D\uDCCA Vol:   ${escapeHtml(signal.volRatio.toFixed(2))}x`,
    `\uD83D\uDCD0 Size:  ${escapeHtml(size.toFixed(2))}`
  ]);
}

function buildFillMessage(trade, price) {
  return lines([
    `\u2705\uD83D\uDD25 <b>FILLED</b>`, "",
    `${marketEmoji(trade.market)} <b>${escapeHtml(trade.market)} | ${escapeHtml(trade.asset)}</b>`,
    `${setupEmoji(trade.setupType)} ${escapeHtml(trade.setupType)}`, "",
    `\uD83D\uDCB5 Fill: ${escapeHtml(formatPrice(price, trade.market))}`,
    `\uD83D\uDEE1\uFE0F SL:   ${escapeHtml(formatPrice(trade.sl, trade.market))}`,
    `\uD83C\uDFAF TP:   ${escapeHtml(formatPrice(trade.tp, trade.market))}`,
    `\u2B50 Score: ${escapeHtml(String(trade.score))}`
  ]);
}

function buildCloseMessage(trade, reason, closePrice) {
  const rVal = Number.isFinite(trade.realizedR) ? trade.realizedR.toFixed(2) : "n/a";
  const mae  = Number.isFinite(trade.maePct) ? `${(trade.maePct*100).toFixed(2)}%` : "n/a";
  const mfe  = Number.isFinite(trade.mfePct) ? `${(trade.mfePct*100).toFixed(2)}%` : "n/a";
  const re   = { "TAKE PROFIT": "\uD83D\uDCB0\u2705", "STOP LOSS": "\uD83D\uDED1\u274C", "FORCE CLOSE": "\u23F1\uFE0F\uD83D\uDD1A", "REPLACED": "\uD83D\uDD04", "STRUCTURE_INVALID": "\u26A0\uFE0F", "DRIFTED_TOO_FAR": "\uD83C\uDF0A", "PENDING_EXPIRED": "\u231B" }[reason] || "\uD83D\uDCCC";
  return lines([
    `${re} <b>${escapeHtml(reason)}</b>`, "",
    `${marketEmoji(trade.market)} <b>${escapeHtml(trade.market)} | ${escapeHtml(trade.asset)}</b>`,
    `${setupEmoji(trade.setupType)} ${escapeHtml(trade.setupType)}`, "",
    `\uD83D\uDCB5 Close: ${escapeHtml(formatPrice(closePrice, trade.market))}`,
    `\uD83D\uDCCA R: ${escapeHtml(rVal)}`,
    `\uD83D\uDCC9 MAE: ${escapeHtml(mae)}`,
    `\uD83D\uDCC8 MFE: ${escapeHtml(mfe)}`
  ]);
}

// ── Trade helpers ────────────────────────────────────────────────
function cooldown(asset, alerts, market) {
  const last = [...alerts].reverse().find(x => x.asset === asset);
  if (!last) return false;
  return hoursAgo(last.sentAt) < marketCooldownHours(market);
}
function getOpenTradeInMarket(trades, market) { return trades.find(t => t.market === market && t.status === "FILLED" && t.outcome === "OPEN"); }
function countPendingTradesByMarket(trades, market) { return trades.filter(t => t.market === market && t.status === "PENDING").length; }
function countOpenTradesByMarket(trades, market) { return trades.filter(t => t.market === market && t.status === "FILLED" && t.outcome === "OPEN").length; }
function getOpenRiskFraction(trades) { return trades.filter(t => t.status === "FILLED" && t.outcome === "OPEN").reduce((sum, t) => sum + (t.riskFraction || 0), 0); }

function progressToTarget(trade, livePrice) {
  const denom = trade.tp - trade.entry;
  if (!Number.isFinite(livePrice) || !Number.isFinite(denom) || denom <= 0) return 0;
  return (livePrice - trade.entry) / denom;
}

function shouldReplaceTrade(newSignal, currentTrade, livePrice) {
  if (!currentTrade || !Number.isFinite(livePrice)) return false;
  const progress = progressToTarget(currentTrade, livePrice);
  const stale    = hoursAgo(currentTrade.filledAt || currentTrade.sentAt) > REPLACEMENT_STALE_HOURS;
  return newSignal.score >= (currentTrade.score || 0) + REPLACEMENT_SCORE_GAP && progress < REPLACEMENT_PROTECT_TP_PROGRESS && (stale || progress < REPLACEMENT_STALL_PROGRESS);
}

function shouldForceClose(trade, livePrice) {
  if (!Number.isFinite(livePrice)) return false;
  return hoursAgo(trade.filledAt || trade.sentAt) > FORCE_CLOSE_HOURS && progressToTarget(trade, livePrice) < FORCE_CLOSE_PROGRESS;
}

function adjustRiskByScore(score) { return score >= 85 ? 1.5 : score >= 78 ? 1.2 : 1.0; }
function adjustRiskByAsset(asset, baseRisk) { return ["ASTS", "IONQ", "AVAV"].includes(asset) ? baseRisk * 0.7 : baseRisk; }
function getRiskFractionForSignal(signal) { return adjustRiskByAsset(signal.asset, BASE_RISK_PER_TRADE * adjustRiskByScore(signal.score)); }

function calculatePositionSize(signal) {
  const riskFraction = getRiskFractionForSignal(signal);
  const riskPerUnit  = signal.entry - signal.sl;
  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) return 0;
  return (ACCOUNT_BALANCE * riskFraction) / riskPerUnit;
}

function pickBestPerMarket(results) {
  const best = {};
  for (const s of results.sort((a, b) => b.score - a.score)) { if (!best[s.market]) best[s.market] = s; }
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
  trade.realizedR = Number.isFinite(closePrice) && Number.isFinite(riskPerUnit) && riskPerUnit > 0 ? (closePrice - trade.entry) / riskPerUnit : null;
  await send(buildCloseMessage(trade, reason, closePrice));
  await send(buildCloseLesson(trade, reason, closePrice));
  await saveTrades(trades);
}

// ── Trade management ─────────────────────────────────────────────
async function manageTrades() {
  const trades = await loadTrades();
  let changed = false;

  for (const trade of trades) {
    const livePrice = await fetchLivePrice(trade.asset, trade.market);
    if (!Number.isFinite(livePrice)) continue;

    if (trade.status === "PENDING") {
      const ageHours = hoursAgo(trade.sentAt);
      const filled = trade.entryType === "MARKET BUY" ? true : trade.entryType === "LIMIT BUY" ? livePrice <= trade.entry * 1.002 : livePrice >= trade.entry;
      const structureInvalid = livePrice <= trade.sl;
      const driftTooFar = trade.entryType === "LIMIT BUY" ? livePrice > trade.entry * 1.04 : false;

      if (filled) { trade.status = "FILLED"; trade.outcome = "OPEN"; trade.fillPrice = livePrice; trade.filledAt = nowIso(); trade.maePct = 0; trade.mfePct = 0; changed = true; await send(buildFillMessage(trade, livePrice)); continue; }
      if (structureInvalid) { trade.status = "CANCELLED"; trade.outcome = "STRUCTURE_INVALID"; trade.closedAt = nowIso(); trade.closePrice = livePrice; changed = true; continue; }
      if (driftTooFar)      { trade.status = "CANCELLED"; trade.outcome = "DRIFTED_TOO_FAR";   trade.closedAt = nowIso(); trade.closePrice = livePrice; changed = true; continue; }
      if (ageHours > pendingExpiryHours(trade.market)) { trade.status = "CANCELLED"; trade.outcome = "PENDING_EXPIRED"; trade.closedAt = nowIso(); trade.closePrice = livePrice; changed = true; continue; }
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

// ── Momentum watch — heating up alerts ──────────────────────────
// Fires when an asset is moving strongly but hasn't hit signal yet
// Crypto: 5%+ in 24hrs | Stocks: 3%+ today
// Max once per asset per 2 hours
const MOMENTUM_WATCH_CRYPTO_THRESHOLD = 5;   // % 24hr change
const MOMENTUM_WATCH_STOCK_THRESHOLD  = 3;   // % today change
const MOMENTUM_WATCH_COOLDOWN_MS      = 2 * 60 * 60 * 1000; // 2 hours

const momentumWatchSent = new Map(); // asset -> timestamp last alerted

function momentumWatchCooledDown(asset) {
  const last = momentumWatchSent.get(asset);
  if (!last) return true;
  return Date.now() - last > MOMENTUM_WATCH_COOLDOWN_MS;
}

async function checkMomentumWatch() {
  if (isWeekend()) return; // no alerts on weekends

  const trades = await loadTrades();
  const hasOpenTrade = asset => trades.some(t => t.asset === asset && t.status === "FILLED" && t.outcome === "OPEN");

  // ── Crypto momentum watch (Binance 24hr ticker — always free) ───
  if (isCryptoWindowOpen()) {
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
          const sym     = t.symbol.replace("USDT", "");
          const pct     = (+t.priceChangePercent).toFixed(1);
          const emoji   = +t.priceChangePercent >= 15 ? "🔥" : +t.priceChangePercent >= 10 ? "⚡" : "📈";
          const context = +t.priceChangePercent >= 15
            ? "explosive move — entry alert could follow soon"
            : +t.priceChangePercent >= 10
            ? "strong momentum building"
            : "gaining momentum — being watched";

          await send(lines([
            `${emoji} <b>${escapeHtml(sym)} HEATING UP</b>`,
            ``,
            `\uD83E\uDE99 Crypto | 24hr: <b>+${escapeHtml(pct)}%</b>`,
            `\uD83D\uDCC8 ${escapeHtml(context)}`,
            ``,
            `\uD83D\uDCA1 Scanning for breakout entry — alert fires if conditions met`
          ]));

          momentumWatchSent.set(t.symbol, Date.now());
          console.log(`👀 Momentum watch fired: ${t.symbol} +${pct}%`);
        }
      }
    } catch (e) { console.log("Momentum watch crypto failed:", e.message); }
  }

  // ── Stock momentum watch (Finnhub quotes) ────────────────────
  if (isUSMarketOpen() && FINNHUB_API_KEY) {
    await mapWithConcurrency(STOCK_POOL, 3, async sym => {
      try {
        if (!momentumWatchCooledDown(sym) || hasOpenTrade(sym)) return;
        const { data } = await axios.get("https://finnhub.io/api/v1/quote", {
          params: { symbol: sym, token: FINNHUB_API_KEY }, timeout: 8000
        });
        const changePct = data?.dp;
        if (!Number.isFinite(changePct) || changePct < MOMENTUM_WATCH_STOCK_THRESHOLD) return;

        const emoji   = changePct >= 8 ? "🔥" : changePct >= 5 ? "⚡" : "📈";
        const context = changePct >= 8
          ? "explosive move — entry alert could follow soon"
          : changePct >= 5
          ? "strong momentum building"
          : "gaining momentum — being watched";

        await send(lines([
          `${emoji} <b>${escapeHtml(sym)} HEATING UP</b>`,
          ``,
          `\uD83C\uDDFA\uD83C\uDDF8 US Stock | Today: <b>+${changePct.toFixed(1)}%</b>`,
          `\uD83D\uDCC8 ${escapeHtml(context)}`,
          ``,
          `\uD83D\uDCA1 Scanning for breakout entry — alert fires if conditions met`
        ]));

        momentumWatchSent.set(sym, Date.now());
        console.log(`👀 Momentum watch fired: ${sym} +${changePct.toFixed(1)}%`);
      } catch { /* skip individual */ }
    });
  }
}

// ── Scan ─────────────────────────────────────────────────────────
async function scan() {
  const alerts  = await loadAlerts();
  const trades  = await loadTrades();
  const results = [];

  async function processAsset(asset, market, fetcher) {
    if (cooldown(asset, alerts, market)) return;
    if (trades.some(t => t.asset === asset && t.status === "FILLED" && t.outcome === "OPEN")) return;
    const candles = await fetcher(asset);
    const signal  = analyse(asset, candles, market);
    if (!signal) return;
    if (signal.score < MIN_GLOBAL_SCORE) return;
    if (signal.score < minScoreForMarket(signal.market)) return;
    results.push(signal);
  }

  if (ENABLE_CRYPTO && isCryptoWindowOpen()) {
    await mapWithConcurrency(CRYPTO_PAIRS, MAX_CONCURRENT_REQUESTS, a => processAsset(a, "CRYPTO", fetchCrypto));
  }
  if (ENABLE_US && isUSMarketOpen()) {
    await mapWithConcurrency(STOCK_POOL, MAX_CONCURRENT_REQUESTS, a => processAsset(a, "US", fetchUSData));
  }
  if (ENABLE_LSE && isLSEMarketOpen()) {
    await mapWithConcurrency(LSE_POOL, MAX_CONCURRENT_REQUESTS, a => processAsset(a, "LSE", fetchLSEData));
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

    if (countOpenTradesByMarket(trades, signal.market) >= MAX_POSITIONS[signal.market]) continue;
    if (countPendingTradesByMarket(trades, signal.market) >= 1) continue;
    const riskFraction = getRiskFractionForSignal(signal);
    if (getOpenRiskFraction(trades) + riskFraction > MAX_PORTFOLIO_RISK) continue;
    const size = calculatePositionSize(signal);
    if (!Number.isFinite(size) || size <= 0) continue;

    const sentAt = nowIso();
    await send(buildSignalMessage(signal, size));
    await send(buildSignalLesson(signal));

    alerts.push({ id: `${signal.asset}-${sentAt}`, asset: signal.asset, sentAt });
    trades.push({
      id: `${signal.asset}-${Date.now()}`, asset: signal.asset, market: signal.market,
      setupType: signal.setupType, entryType: signal.entryType,
      entry: signal.entry, sl: signal.sl, tp: signal.tp,
      rrPlanned: signal.rr, score: signal.score, volRatio: signal.volRatio,
      momentum: signal.momentum, regime: signal.regime, sentAt,
      status: "PENDING", outcome: "OPEN",
      fillPrice: null, closePrice: null, closedAt: null, filledAt: null,
      maePct: 0, mfePct: 0, realizedR: null, riskFraction
    });
  }

  await saveAlerts(alerts);
  await saveTrades(trades);
}

// ── Main cycle ───────────────────────────────────────────────────
async function runCycle() {
  if (running) return;
  running = true;
  try {
    ensureFiles();
    resetApiUsageIfNewDay();
    await updateBTCTrend();
    await updateQQQTrend();
    await checkMarketAlerts();
    await manageTrades();
    await checkMomentumWatch(); // fires heating up alerts before scanning
    const signals = await scan();
    if (signals.length > 0) {
      await processSignals(signals);
    } else {
      console.log(`NO VALID SIGNALS — API usage: TD=${apiUsage.twelvedata} AV=${apiUsage.alphavantage}`);
    }
  } catch (e) {
    console.log("RUN ERROR:", e.message);
  } finally {
    running = false;
  }
}

// ── Boot ─────────────────────────────────────────────────────────
ensureFiles();

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 Health server on port ${PORT}`);
  await send(
    "\uD83D\uDE80\uD83D\uDD25 SNIPER V86 LIVE\n" +
    "Momentum watch active \u2022 Heating up alerts before entries\n" +
    "Crypto 5%+ \u2022 Stocks 3%+ \u2022 Max once per 2hrs per asset\n" +
    "Signal alerts only otherwise \u2022 Money machine mode"
  );
  await refreshDynamicPools();
  await runCycle();
  setInterval(async () => { if (!running) await runCycle(); }, SCAN_INTERVAL_MS);
  setInterval(async () => { await refreshDynamicPools(); },   POOL_REFRESH_INTERVAL_MS);
});
