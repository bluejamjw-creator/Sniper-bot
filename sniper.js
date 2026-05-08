// ================================================================
// SNIPER V80 HUNTER EDITION
// Adaptive momentum hunter + narrative-aware scanner
// Dynamic sector rotation + explosive runner detector
// Momentum Ignition setup type
// CoinGecko + Finnhub + Top Movers integration
// TwelveData primary / Alpha Vantage failover
// Trading coach lessons on every signal and close
// Candle caching + API optimisation
// All V79 logic preserved
// ================================================================

console.log("🚀 SNIPER V80 HUNTER EDITION STARTING...");

const fs    = require("fs");
const path  = require("path");
const axios = require("axios");
const express = require("express");
const ws    = require("ws");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = process.env.PORT || 3000;

app.get("/",       (_req, res) => res.status(200).send("SNIPER V80 alive"));
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
const MAX_CONCURRENT_REQUESTS  = 4;

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

// ── Sector symbol maps ───────────────────────────────────────────
const SECTOR_SYMBOLS = {
  AI:       ["NVDA", "PLTR", "AMD", "SMCI", "MSFT", "META", "GOOGL", "IONQ", "CRWD", "ANET"],
  GOLD:     ["NEM", "GOLD", "AEM", "WPM", "KGC", "SIL"],
  SILVER:   ["SIL", "WPM", "PAAS", "AG"],
  CRYPTO:   ["COIN", "MSTR", "RIOT", "CLSK"],
  ENERGY:   ["XOM", "CVX", "SLB", "HAL", "MPC"],
  DEFENSE:  ["LMT", "RTX", "NOC", "GD", "AVAV"],
  ROBOTICS: ["ROK", "ISRG", "TER", "FANUY"],
  NUCLEAR:  ["CCJ", "NNE", "SMR", "UUUU", "DNN", "OKLO"]
};

const NARRATIVE_KEYWORDS = {
  AI:       ["artificial intelligence", "ai chip", "machine learning", "llm", "gpu", "nvidia", "generative ai", "foundation model", "openai", "chatgpt"],
  GOLD:     ["gold price", "gold rally", "bullion", "gold futures", "precious metals", "safe haven", "gold hits"],
  SILVER:   ["silver price", "silver rally", "industrial metals", "silver futures"],
  CRYPTO:   ["bitcoin", "ethereum", "crypto rally", "btc", "eth", "digital assets", "blockchain", "crypto surge"],
  ENERGY:   ["oil price", "crude", "energy rally", "opec", "natural gas", "refinery", "brent"],
  DEFENSE:  ["defense spending", "military", "nato", "geopolitical", "weapons", "pentagon", "war", "conflict"],
  ROBOTICS: ["robotics", "automation", "humanoid", "manufacturing robot", "cobots", "boston dynamics"],
  NUCLEAR:  ["nuclear energy", "uranium", "small modular reactor", "smr", "nuclear power", "fission"]
};

const CRYPTO_AI_NAMES = ["RENDERUSDT", "FETUSDT", "NEARUSDT", "TAOUSDT", "AGIXUSDT", "OCEANUSDT"];

// ── Static fallback pools ────────────────────────────────────────
const STATIC_CRYPTO_FALLBACK = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT",
  "AVAXUSDT", "SUIUSDT", "NEARUSDT", "RENDERUSDT",
  "TONUSDT", "ONDOUSDT"
];

const STATIC_STOCK_FALLBACK = [
  "GEV", "AVAV", "IONQ", "ASTS", "NVDA", "AVGO", "VRT",
  "AMAT", "KLAC", "LRCX", "ETN", "DOV", "CIEN", "COHR", "PLTR",
  "AMD", "TSM", "ASML", "ANET", "CRWD", "MSFT", "META", "AMZN",
  "APP", "MSTR", "COIN", "QQQ", "SMH"
];

const LSE_POOL = ["RR.LON", "BA.LON", "SHEL.LON", "LSEG.LON", "BARC.LON"];

// ── Dynamic pools ────────────────────────────────────────────────
let STOCK_POOL   = [...STATIC_STOCK_FALLBACK];
let CRYPTO_PAIRS = [...STATIC_CRYPTO_FALLBACK];
let HOT_SECTORS  = [];

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
  return h >= 6 && h < 22;
}

function isUSMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return m >= 810 && m < 1200;
}

function isLSEMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return m >= 420 && m < 990;
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
    const high      = candles[i].high;
    const low       = candles[i].low;
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
      .map(c => {
        const sym = (c?.item?.symbol || "").toUpperCase();
        return sym ? sym + "USDT" : null;
      })
      .filter(Boolean)
      .slice(0, 12);
    console.log("🪙 CoinGecko trending:", symbols.join(", ") || "none");
    return symbols;
  } catch (e) {
    console.log("CoinGecko failed:", e.message);
    return [];
  }
}

// ── Finnhub: trending stocks ─────────────────────────────────────
async function getTrendingStocks() {
  if (!FINNHUB_API_KEY) {
    console.log("No FINNHUB_API_KEY — using fallback stock pool");
    return [...STATIC_STOCK_FALLBACK];
  }
  try {
    const { data } = await retry(() =>
      axios.get("https://finnhub.io/api/v1/stock/symbol", {
        params: { exchange: "US", token: FINNHUB_API_KEY },
        timeout: 15000
      })
    );
    if (!Array.isArray(data)) throw new Error("Invalid Finnhub response");
    const filtered = data
      .filter(s => s.type === "Common Stock" && /^[A-Z]{1,5}$/.test(s.symbol))
      .map(s => s.symbol)
      .slice(0, 25);
    const core = [
      "NVDA", "PLTR", "AMD", "ASTS", "IONQ", "MSFT", "META", "AMZN",
      "COIN", "MSTR", "QQQ", "SMH", "AVGO", "VRT", "CRWD", "APP"
    ];
    const merged = dedup([...core, ...filtered]).slice(0, 40);
    console.log(`📈 Finnhub stocks loaded: ${merged.length} symbols`);
    return merged;
  } catch (e) {
    console.log("Finnhub stocks failed:", e.message, "— using fallback");
    return [...STATIC_STOCK_FALLBACK];
  }
}

// ── Top gainers engine ───────────────────────────────────────────
async function getTopMovers() {
  if (!FINNHUB_API_KEY) return [];
  try {
    const candidates = [
      "NVDA", "ASTS", "IONQ", "PLTR", "AMD", "COIN", "MSTR",
      "AVAV", "SMR", "OKLO", "CRWD", "APP", "RKLB", "LUNR", "ACHR"
    ];
    const movers = [];
    await mapWithConcurrency(candidates, 4, async sym => {
      try {
        const { data } = await axios.get("https://finnhub.io/api/v1/quote", {
          params: { symbol: sym, token: FINNHUB_API_KEY },
          timeout: 8000
        });
        const changePct = data?.dp;
        if (Number.isFinite(changePct) && changePct > 3) {
          movers.push({ sym, changePct });
          console.log(`🚀 Top mover: ${sym} +${changePct.toFixed(2)}%`);
        }
      } catch { /* skip individual failures */ }
    });
    return movers.sort((a, b) => b.changePct - a.changePct).map(m => m.sym);
  } catch (e) {
    console.log("Top movers failed:", e.message);
    return [];
  }
}

// ── Narrative detection ──────────────────────────────────────────
async function detectHotSectors() {
  if (!FINNHUB_API_KEY) {
    console.log("No FINNHUB_API_KEY — skipping narrative detection");
    return [];
  }
  try {
    const { data } = await retry(() =>
      axios.get("https://finnhub.io/api/v1/news", {
        params: { category: "general", token: FINNHUB_API_KEY },
        timeout: 12000
      })
    );
    if (!Array.isArray(data)) return [];
    const text = data
      .slice(0, 60)
      .map(n => ((n.headline || "") + " " + (n.summary || "")).toLowerCase())
      .join(" ");
    const scores = {};
    for (const [sector, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
      scores[sector] = keywords.filter(kw => text.includes(kw)).length;
    }
    const active = Object.entries(scores)
      .filter(([, score]) => score >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([sector]) => sector);
    console.log("🧠 Hot sectors:", active.join(", ") || "none");
    return active;
  } catch (e) {
    console.log("Narrative detection failed:", e.message);
    return [];
  }
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
    const syms = SECTOR_SYMBOLS[sector] || [];
    sectorInjected.push(...syms);
    console.log(`💉 Injecting ${sector}: ${syms.join(", ")}`);
  }

  STOCK_POOL = dedup([...trendingStocks, ...topMovers, ...sectorInjected]).slice(0, 50);

  console.log(`✅ Pools ready — Crypto: ${CRYPTO_PAIRS.length}, Stocks: ${STOCK_POOL.length}, Sectors: ${HOT_SECTORS.join(", ") || "none"}`);

  if (HOT_SECTORS.length > 0 || topMovers.length > 0) {
    await sendNarrativeAlert(topMovers);
  }
}

// ── Narrative Telegram alert ─────────────────────────────────────
async function sendNarrativeAlert(topMovers) {
  if (!Array.isArray(topMovers)) topMovers = [];
  const sectorLines = HOT_SECTORS.map(s => {
    const syms = (SECTOR_SYMBOLS[s] || []).slice(0, 4).join(", ");
    return `  📌 <b>${escapeHtml(s)}</b> \u2192 ${escapeHtml(syms)}`;
  });
  const moverLine = topMovers.length > 0
    ? ["\n\uD83D\uDE80 <b>Top movers injected:</b> " + escapeHtml(topMovers.slice(0, 6).join(", "))]
    : [];
  await send(lines([
    "\uD83E\uDDE0\uD83D\uDD25 <b>MARKET NARRATIVES DETECTED</b>",
    "",
    ...(sectorLines.length > 0 ? sectorLines : ["  No strong narratives this cycle"]),
    ...moverLine,
    "",
    `\uD83D\uDD0D Stock pool: <b>${escapeHtml(String(STOCK_POOL.length))}</b> symbols`,
    `\uD83E\uDE99 Crypto pool: <b>${escapeHtml(String(CRYPTO_PAIRS.length))}</b> pairs`
  ]));
}

// ── Data fetching: crypto ────────────────────────────────────────
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
  } catch { return null; }
}

// ── Data fetching: TwelveData ────────────────────────────────────
async function fetchTwelveDataSeries(symbol, interval, outputsize) {
  if (!interval)    interval    = "1h";
  if (!outputsize)  outputsize  = 70;
  if (!TWELVE_DATA_API_KEY) return null;
  try {
    const { data } = await retry(() =>
      axios.get("https://api.twelvedata.com/time_series", {
        params: { symbol, interval, outputsize, order: "ASC", apikey: TWELVE_DATA_API_KEY },
        timeout: 15000
      })
    );
    if (data?.status === "error" || !Array.isArray(data?.values)) return null;
    return data.values
      .map(row => ({ close: +row.close, high: +row.high, low: +row.low, volume: +row.volume }))
      .filter(x => Number.isFinite(x.close) && Number.isFinite(x.high) && Number.isFinite(x.low));
  } catch { return null; }
}

// ── Data fetching: Alpha Vantage ─────────────────────────────────
async function fetchAlphaVantageSeries(symbol) {
  if (!ALPHA_VANTAGE_API_KEY) return null;
  try {
    const { data } = await retry(() =>
      axios.get("https://www.alphavantage.co/query", {
        params: {
          function: "TIME_SERIES_INTRADAY",
          symbol,
          interval: "60min",
          outputsize: "compact",
          apikey: ALPHA_VANTAGE_API_KEY
        },
        timeout: 15000
      })
    );
    const series = data["Time Series (60min)"];
    if (!series) return null;
    return Object.entries(series)
      .sort(([a], [b]) => new Date(a) - new Date(b))
      .map(([, v]) => ({
        close:  +v["4. close"],
        high:   +v["2. high"],
        low:    +v["3. low"],
        volume: +v["5. volume"]
      }))
      .filter(x => Number.isFinite(x.close));
  } catch { return null; }
}

async function fetchUSData(symbol) {
  const cacheKey = `us_${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  let candles = await fetchTwelveDataSeries(symbol, "1h", 70);
  if (!candles) {
    console.log(`\u26A0\uFE0F TwelveData failed for ${symbol} \u2014 trying Alpha Vantage`);
    candles = await fetchAlphaVantageSeries(symbol);
    if (candles) console.log(`\u2705 Alpha Vantage fallback OK for ${symbol}`);
  }
  if (candles) setCache(cacheKey, candles);
  return candles;
}

async function fetchLSEData(symbol) {
  const cacheKey = `lse_${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const candles = await fetchTwelveDataSeries(symbol, "1h", 70);
  if (candles) setCache(cacheKey, candles);
  return candles;
}

// ── Live price with failover ─────────────────────────────────────
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
    return +data.price;
  } catch { return null; }
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
      console.log(`\u26A0\uFE0F TwelveData live price failed ${asset} \u2014 trying Alpha Vantage`);
      price = await fetchLivePriceAlphaVantage(asset);
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
  if (btcTrend !== prev) console.log(`\uD83D\uDCE1 BTC trend: ${prev} \u2192 ${btcTrend}`);
}

async function updateQQQTrend() {
  if (!ENABLE_US || !isUSMarketOpen()) { qqqTrend = "neutral"; return; }
  const candles = await fetchUSData("QQQ");
  if (!candles) { qqqTrend = "neutral"; return; }
  const closes = candles.map(x => x.close);
  const prev   = qqqTrend;
  qqqTrend = classifyRegime(ema(closes, 20), ema(closes, 50), closes.at(-1));
  if (qqqTrend !== prev) console.log(`\uD83D\uDCE1 QQQ trend: ${prev} \u2192 ${qqqTrend}`);
}

// ── Market open/close alerts ─────────────────────────────────────
function buildMarketOpenMessage(market) {
  if (market === "CRYPTO") {
    return lines([
      "\uD83D\uDFE2\uD83D\uDE80 <b>CRYPTO WINDOW OPEN</b>", "",
      "\u23F0 Scanning 06:00\u201322:00 UTC",
      "\uD83D\uDCE1 BTC trend: <b>" + escapeHtml(btcTrend.toUpperCase()) + "</b>",
      "\uD83D\uDD0D Pairs active: " + escapeHtml(String(CRYPTO_PAIRS.length))
    ]);
  }
  if (market === "US") {
    return lines([
      "\uD83D\uDFE2\uD83D\uDCC8 <b>US MARKET OPEN</b>", "",
      "\u23F0 NYSE/NASDAQ session live",
      "\uD83D\uDCE1 QQQ trend: <b>" + escapeHtml(qqqTrend.toUpperCase()) + "</b>",
      "\uD83D\uDD0D Stocks in pool: " + escapeHtml(String(STOCK_POOL.length))
    ]);
  }
  return lines([
    "\uD83D\uDFE2\uD83C\uDFE6 <b>LSE MARKET OPEN</b>", "",
    "\u23F0 London session live",
    "\uD83D\uDD0D Stocks in pool: " + escapeHtml(String(LSE_POOL.length))
  ]);
}

function buildMarketCloseMessage(market) {
  if (market === "CRYPTO") return lines(["\uD83D\uDD34\uD83D\uDCA4 <b>CRYPTO WINDOW CLOSED</b>", "", "\uD83D\uDE34 Scanning paused until 06:00 UTC"]);
  if (market === "US")     return lines(["\uD83D\uDD34\uD83D\uDCC9 <b>US MARKET CLOSED</b>", "", "\uD83C\uDFC1 NYSE/NASDAQ session ended"]);
  return lines(["\uD83D\uDD34\uD83C\uDFE6 <b>LSE MARKET CLOSED</b>", "", "\uD83C\uDFC1 London session ended"]);
}

async function checkMarketAlerts() {
  const checks = [
    { key: "CRYPTO", isOpen: isCryptoWindowOpen },
    { key: "US",     isOpen: isUSMarketOpen     },
    { key: "LSE",    isOpen: isLSEMarketOpen    }
  ];
  for (const { key, isOpen } of checks) {
    const nowOpen = isOpen();
    if (nowOpen  && !marketWasOpen[key]) await send(buildMarketOpenMessage(key));
    if (!nowOpen &&  marketWasOpen[key]) await send(buildMarketCloseMessage(key));
    marketWasOpen[key] = nowOpen;
  }
}

// ── Narrative / AI heat scoring ──────────────────────────────────
function getNarrativeBonus(asset) {
  let bonus = 0;
  const sym = asset.replace("USDT", "");
  for (const sector of HOT_SECTORS) {
    if ((SECTOR_SYMBOLS[sector] || []).includes(sym)) {
      bonus += 6;
      console.log(`\uD83D\uDD25 Narrative +6 for ${asset} (${sector})`);
    }
  }
  if (HOT_SECTORS.includes("AI") && CRYPTO_AI_NAMES.includes(asset)) {
    bonus += 5;
    console.log(`\uD83E\uDD16 AI crypto +5 for ${asset}`);
  }
  return bonus;
}

// ── Emoji helpers ────────────────────────────────────────────────
function gradeEmoji(grade) {
  if (grade === "A*") return "\uD83D\uDC8E\uD83D\uDD25";
  if (grade === "A")  return "\uD83D\uDE80\u26A1";
  return "\uD83D\uDCC8";
}

function setupEmoji(t) {
  if (t === "BREAKOUT_CONTINUATION") return "\uD83D\uDCA5";
  if (t === "PULLBACK_CONTINUATION") return "\uD83C\uDFAF";
  if (t === "MOMENTUM_BREAKOUT")     return "\uD83D\uDD25";
  if (t === "MOMENTUM_IGNITION")     return "\u26A1";
  return "\uD83D\uDCCA";
}

function marketEmoji(m) {
  if (m === "CRYPTO") return "\uD83E\uDE99";
  if (m === "US")     return "\uD83C\uDDFA\uD83C\uDDF8";
  if (m === "LSE")    return "\uD83C\uDDEC\uD83C\uDDE7";
  return "\uD83D\uDCCA";
}

// ── Core analysis ────────────────────────────────────────────────
function analyse(asset, candles, market) {
  if (!candles || candles.length < MIN_CANDLES) return null;
  if (!regimePass(market)) return null;

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

  const extension = (last - ema20) / ema20;
  if (extension > extensionLimitForMarket(market)) return null;

  const breakoutLevel    = Math.max(...highs.slice(-BREAKOUT_LOOKBACK, -1));
  const breakoutDistance = breakoutLevel > 0 ? (last - breakoutLevel) / breakoutLevel : 0;

  // ── Expanding range detection ───────────────────────────────
  const recentRanges = highs.slice(-5, -1).map((h, i) => h - lows.slice(-5, -1)[i]).filter(Number.isFinite);
  const priorRanges  = highs.slice(-10, -5).map((h, i) => h - lows.slice(-10, -5)[i]).filter(Number.isFinite);
  const recentRange  = avg(recentRanges);
  const priorRange   = avg(priorRanges);
  const expandingRange = recentRange > 0 && priorRange > 0 && recentRange > priorRange * 1.3;

  // ── MOMENTUM IGNITION ───────────────────────────────────────
  const ignitionSignal = momentum > 0.025 && volRatio > 2.0 && last > ema20 && expandingRange;

  // ── MOMENTUM BREAKOUT OVERRIDE ──────────────────────────────
  const strongMomentumOverride =
    market === "US" && STOCK_MOMENTUM_OVERRIDE_ENABLED &&
    momentum >= STOCK_OVERRIDE_MIN_MOMENTUM &&
    volRatio >= STOCK_OVERRIDE_MIN_VOL &&
    breakoutDistance <= STOCK_OVERRIDE_MAX_DISTANCE;

  // ── BREAKOUT ────────────────────────────────────────────────
  const breakoutSignal =
    last > breakoutLevel &&
    breakoutDistance <= breakoutDistanceLimitForMarket(market) &&
    volRatio >= breakoutVolForMarket(market) &&
    momentum >= minMomentumForMarket(market);

  // ── PULLBACK ────────────────────────────────────────────────
  const nearEMAThreshold   = market === "US" ? 0.02 : 0.025;
  const nearEMA20          = Math.abs(last - ema20) / ema20 <= nearEMAThreshold;
  const pulledBackRecently = closes.slice(-6, -1).some(c => c <= ema20 * 1.01);
  const pullbackSignal     = nearEMA20 && pulledBackRecently && volRatio >= pullbackVolForMarket(market);

  if (!pullbackSignal && !breakoutSignal && !strongMomentumOverride && !ignitionSignal) return null;

  // ── Setup type priority ─────────────────────────────────────
  let setupType = "BREAKOUT_CONTINUATION";
  if (pullbackSignal && !breakoutSignal && !ignitionSignal) setupType = "PULLBACK_CONTINUATION";
  if (strongMomentumOverride && !ignitionSignal)            setupType = "MOMENTUM_BREAKOUT";
  if (ignitionSignal)                                        setupType = "MOMENTUM_IGNITION";

  if (setupType === "PULLBACK_CONTINUATION" && momentum < minPullbackMomentumForMarket(market)) return null;

  // Momentum cap — ignition allowed higher
  const momentumCap = setupType === "MOMENTUM_IGNITION" ? 0.20 : maxMomentumBarForMarket(market);
  if (momentum > momentumCap) return null;

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

  // Volume
  if (volRatio > 1.2) score += 6;
  if (volRatio > 1.4) score += 6;
  if (volRatio > 1.6) score += 4;
  if (volRatio > 2.0) { score += 5; console.log(`\uD83D\uDCA5 Vol explosion ${asset}: ${volRatio.toFixed(2)}x`); }
  if (volRatio > 3.0) { score += 5; console.log(`\uD83D\uDEA8 Institutional vol ${asset}: ${volRatio.toFixed(2)}x`); }

  // Momentum
  if (momentum > 0.025) score += 10;
  else if (momentum > 0.015) score += 8;
  else if (momentum > 0.008) score += 4;

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

  // Breakout quality
  if (breakoutDistance > 0 && breakoutDistance <= 0.01) score += 4;

  // Expanding range bonus
  if (expandingRange) score += 4;

  // Narrative
  score += getNarrativeBonus(asset);

  let grade = "B";
  if (score >= 85) grade = "A*";
  else if (score >= 78) grade = "A";

  if (score >= MIN_GLOBAL_SCORE) {
    console.log(`\u2705 ${asset} ${market} ${setupType} score=${score} grade=${grade} vol=${volRatio.toFixed(2)}x mom=${(momentum * 100).toFixed(2)}%`);
  }

  return {
    asset, market, grade, setupType, status: "CONFIRMED",
    entryType, entry, sl, tp, rr, score, momentum, volRatio,
    breakoutDistance, atr,
    regime: market === "CRYPTO" ? btcTrend : market === "US" ? qqqTrend : "LSE_LOCAL"
  };
}

// ── Trading coach: signal lesson ─────────────────────────────────
function buildSignalLesson(signal) {
  const parts = ["\uD83D\uDCDA <b>TRADE LESSON</b>", ""];

  if (signal.setupType === "BREAKOUT_CONTINUATION") {
    parts.push("\uD83D\uDCA5 <b>Breakout Continuation</b> \u2014 price pushed above a recent resistance level. We enter as it breaks out expecting momentum to carry it higher. Market buy gets you in immediately rather than waiting and missing the move.");
  } else if (signal.setupType === "PULLBACK_CONTINUATION") {
    parts.push("\uD83C\uDFAF <b>Pullback Continuation</b> \u2014 price dipped back to its 20-period EMA (the trend\u2019s centre line) and is bouncing. Lower-risk entry than a breakout \u2014 buying a dip within an uptrend rather than chasing a spike. The limit order targets that EMA level precisely.");
  } else if (signal.setupType === "MOMENTUM_BREAKOUT") {
    parts.push("\uD83D\uDD25 <b>Momentum Breakout</b> \u2014 strong candle with high volume pushing through resistance. Volume confirms real buying pressure behind the move, not just noise.");
  } else if (signal.setupType === "MOMENTUM_IGNITION") {
    parts.push("\u26A1 <b>Momentum Ignition</b> \u2014 explosive early runner detected BEFORE full breakout confirmation. Volume is over 2x average, price is accelerating and the candle range is expanding. These can move very quickly. Higher risk, higher reward \u2014 size carefully.");
  }

  if (signal.volRatio >= 3.0) {
    parts.push(`\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x average</b> \u2014 exceptional. This level usually means institutional money (large funds) is actively buying. That\u2019s the kind of flow that drives sustained moves.`);
  } else if (signal.volRatio >= 2.0) {
    parts.push(`\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x average</b> \u2014 very strong. Double the norm confirms real conviction behind this move.`);
  } else {
    parts.push(`\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x average</b> \u2014 above normal. Confirms the move has buyers behind it.`);
  }

  if (signal.market === "CRYPTO") {
    if (signal.asset === "BTCUSDT") {
      parts.push("\n\uD83E\uDE99 <b>BTC note</b> \u2014 Bitcoin moves in smaller % than altcoins. 1-2% is a normal day. The SL and TP in dollars look big but as a % they\u2019re tight. Watch percentages not dollar amounts.");
    } else {
      parts.push(`\n\uD83E\uDE99 <b>Altcoin note</b> \u2014 ${signal.asset.replace("USDT", "")} can move 5-15% in a session when BTC is bullish (BTC trend: ${btcTrend.replace("_", " ")}). Altcoins amplify BTC moves.`);
    }
  } else if (signal.market === "US") {
    parts.push(`\n\uD83C\uDDFA\uD83C\uDDF8 <b>US note</b> \u2014 QQQ trend (tech market health gauge) is <b>${qqqTrend.replace("_", " ")}</b>. A strong QQQ reading means the wind is behind individual breakouts.`);
  } else {
    parts.push("\n\uD83C\uDDEC\uD83C\uDDE7 <b>LSE note</b> \u2014 London stocks move more slowly than US or crypto. Expect this to develop over hours rather than minutes.");
  }

  if (HOT_SECTORS.length > 0) {
    const matched = HOT_SECTORS.filter(s => (SECTOR_SYMBOLS[s] || []).includes(signal.asset.replace("USDT", "")));
    if (matched.length > 0) {
      parts.push(`\n\uD83E\uDDE0 <b>Narrative aligned: ${matched.join(", ")}</b> \u2014 institutional money is flowing into this sector right now. Narrative-aligned trades often have stronger follow-through because multiple buyers are piling in for the same reason.`);
    }
  }

  if (signal.grade === "A*") {
    parts.push("\n\u2B50 <b>A* grade</b> \u2014 highest rating the system gives. All conditions aligned: trend, volume, momentum, setup quality. Pay close attention to these.");
  } else if (signal.grade === "A") {
    parts.push("\n\u2B50 <b>A grade</b> \u2014 strong signal. Most conditions met. Well above the minimum threshold.");
  }

  parts.push(`\n\u26A1 <b>Momentum: ${(signal.momentum * 100).toFixed(2)}%</b> \u2014 how much the last hourly candle moved. Above 1% shows real conviction. Above 2.5% is explosive.`);

  return lines(parts);
}

// ── Trading coach: close debrief ─────────────────────────────────
function buildCloseLesson(trade, reason, closePrice) {
  const rVal       = Number.isFinite(trade.realizedR) ? +trade.realizedR.toFixed(2) : null;
  const priceMoved = Number.isFinite(closePrice) && Number.isFinite(trade.entry)
    ? ((closePrice - trade.entry) / trade.entry * 100).toFixed(2) : null;
  const hoursHeld  = hoursAgo(trade.filledAt || trade.sentAt).toFixed(1);
  const parts = ["\uD83D\uDCD6 <b>TRADE DEBRIEF</b>", ""];

  if (reason === "TAKE PROFIT") {
    parts.push(`\u2705 <b>Target hit.</b> Price moved ${priceMoved ? priceMoved + "%" : "as expected"} from entry to reach the take profit. The setup worked exactly as intended.`);
    if (rVal !== null) parts.push(`\n\uD83D\uDCCA <b>R value: ${rVal}R</b> \u2014 you made ${rVal}x what you risked. 1.5R means \u00a31 risked = \u00a31.50 gained. Consistently hitting 1.5R+ is what makes a system profitable long-term.`);
  } else if (reason === "STOP LOSS") {
    parts.push(`\uD83D\uDED1 <b>Stop loss triggered.</b> Price moved against the trade${priceMoved ? " by " + Math.abs(+priceMoved) + "%" : ""}. Normal \u2014 even great systems lose 40-50% of trades. The stop is doing its job: protecting your account from bigger losses.`);
    parts.push("\n\uD83D\uDCA1 A stop loss isn\u2019t a failure. It\u2019s risk management working correctly. One loss doesn\u2019t matter \u2014 what matters is losses stay small and wins stay bigger.");
  } else if (reason === "FORCE CLOSE") {
    parts.push(`\u23F1\uFE0F <b>Force closed.</b> Trade open ${hoursHeld} hours without progressing toward target. System cut it to free capital for better opportunities.`);
    parts.push("\n\uD83D\uDCA1 Time is a cost in trading. A sideways trade ties up your capital. Cutting stale trades early is disciplined risk management.");
    if (rVal !== null && rVal > -0.3) parts.push(`\n\uD83D\uDCCA Closed at ${rVal}R \u2014 near breakeven. Could be worse.`);
  } else if (reason === "REPLACED") {
    parts.push("\uD83D\uDD04 <b>Trade replaced.</b> A higher-scoring signal appeared in the same market. Only happens when the new signal scores significantly higher AND this trade wasn\u2019t progressing.");
  } else if (reason === "PENDING_EXPIRED") {
    parts.push("\u231B <b>Order expired.</b> Entry price was never reached within the time window.");
    parts.push("\n\uD83D\uDCA1 A missed trade is not a loss. No money was at risk. Better to expire than chase price after the move has already happened.");
  } else if (reason === "STRUCTURE_INVALID") {
    parts.push("\u26A0\uFE0F <b>Structure invalidated.</b> Price dropped below the stop level before entry filled. Setup broke down \u2014 order cancelled automatically. This protected you from entering a bad trade.");
  } else if (reason === "DRIFTED_TOO_FAR") {
    parts.push("\uD83C\uDF0A <b>Drifted too far.</b> Price moved away from the entry level without filling. Chasing an extended move increases risk \u2014 order cancelled.");
  }

  if (Number.isFinite(trade.maePct) && Number.isFinite(trade.mfePct)) {
    const mae = (trade.maePct * 100).toFixed(2);
    const mfe = (trade.mfePct * 100).toFixed(2);
    parts.push(
      `\n\uD83D\uDCC9 <b>MAE (Max Against): ${mae}%</b> \u2014 furthest price moved against you while in the trade.` +
      `\n\uD83D\uDCC8 <b>MFE (Max Favour): ${mfe}%</b> \u2014 furthest price moved in your favour.` +
      "\nTracking these over time tells you if stops are too tight or if you\u2019re leaving profit on the table."
    );
  }

  return lines(parts);
}

// ── Message builders ─────────────────────────────────────────────
function buildSignalMessage(signal, size) {
  const isMarket = signal.entryType === "MARKET BUY";
  const sym = signal.asset.replace("USDT", "");
  const matched = HOT_SECTORS.filter(s => (SECTOR_SYMBOLS[s] || []).includes(sym));
  const narrativeTag = matched.length > 0
    ? `\n\uD83E\uDDE0 <b>NARRATIVE: ${escapeHtml(matched.join(" + "))}</b>` : "";
  return lines([
    `\uD83D\uDEA8 ${gradeEmoji(signal.grade)} <b>${escapeHtml(signal.grade)} SIGNAL</b>${narrativeTag}`,
    "",
    `${marketEmoji(signal.market)} <b>${escapeHtml(signal.market)} | ${escapeHtml(signal.asset)}</b>`,
    `${setupEmoji(signal.setupType)} ${escapeHtml(signal.setupType)}`,
    "",
    isMarket
      ? `\u26A1 <b>MARKET BUY NOW</b> ~${escapeHtml(formatPrice(signal.entry, signal.market))}`
      : `\uD83D\uDCB0 Limit Entry: ${escapeHtml(formatPrice(signal.entry, signal.market))}`,
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
  const mae  = Number.isFinite(trade.maePct) ? `${(trade.maePct * 100).toFixed(2)}%` : "n/a";
  const mfe  = Number.isFinite(trade.mfePct) ? `${(trade.mfePct * 100).toFixed(2)}%` : "n/a";
  const reasonEmoji = {
    "TAKE PROFIT":       "\uD83D\uDCB0\u2705",
    "STOP LOSS":         "\uD83D\uDED1\u274C",
    "FORCE CLOSE":       "\u23F1\uFE0F\uD83D\uDD1A",
    "REPLACED":          "\uD83D\uDD04",
    "STRUCTURE_INVALID": "\u26A0\uFE0F",
    "DRIFTED_TOO_FAR":   "\uD83C\uDF0A",
    "PENDING_EXPIRED":   "\u231B"
  }[reason] || "\uD83D\uDCCC";
  return lines([
    `${reasonEmoji} <b>${escapeHtml(reason)}</b>`, "",
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
  const progress        = progressToTarget(currentTrade, livePrice);
  const stale           = hoursAgo(currentTrade.filledAt || currentTrade.sentAt) > REPLACEMENT_STALE_HOURS;
  const notProgressing  = progress < REPLACEMENT_STALL_PROGRESS;
  const protectedWinner = progress >= REPLACEMENT_PROTECT_TP_PROGRESS;
  return (
    newSignal.score >= (currentTrade.score || 0) + REPLACEMENT_SCORE_GAP &&
    !protectedWinner && (stale || notProgressing)
  );
}

function shouldForceClose(trade, livePrice) {
  if (!Number.isFinite(livePrice)) return false;
  return hoursAgo(trade.filledAt || trade.sentAt) > FORCE_CLOSE_HOURS &&
    progressToTarget(trade, livePrice) < FORCE_CLOSE_PROGRESS;
}

function adjustRiskByScore(score) {
  if (score >= 85) return 1.5;
  if (score >= 78) return 1.2;
  return 1.0;
}

function adjustRiskByAsset(asset, baseRisk) {
  if (["ASTS", "IONQ", "AVAV"].includes(asset)) return baseRisk * 0.7;
  return baseRisk;
}

function getRiskFractionForSignal(signal) {
  return adjustRiskByAsset(signal.asset, BASE_RISK_PER_TRADE * adjustRiskByScore(signal.score));
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
  trade.realizedR =
    Number.isFinite(closePrice) && Number.isFinite(riskPerUnit) && riskPerUnit > 0
      ? (closePrice - trade.entry) / riskPerUnit : null;
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

      const filled =
        trade.entryType === "MARKET BUY" ? true
        : trade.entryType === "LIMIT BUY" ? livePrice <= trade.entry * 1.002
        : livePrice >= trade.entry;

      const structureInvalid = livePrice <= trade.sl;
      const driftTooFar      = trade.entryType === "LIMIT BUY" ? livePrice > trade.entry * 1.04 : false;

      if (filled) {
        trade.status    = "FILLED"; trade.outcome = "OPEN";
        trade.fillPrice = livePrice; trade.filledAt = nowIso();
        trade.maePct    = 0; trade.mfePct = 0;
        changed = true;
        await send(buildFillMessage(trade, livePrice));
        continue;
      }
      if (structureInvalid) {
        trade.status = "CANCELLED"; trade.outcome = "STRUCTURE_INVALID";
        trade.closedAt = nowIso(); trade.closePrice = livePrice;
        changed = true; continue;
      }
      if (driftTooFar) {
        trade.status = "CANCELLED"; trade.outcome = "DRIFTED_TOO_FAR";
        trade.closedAt = nowIso(); trade.closePrice = livePrice;
        changed = true; continue;
      }
      if (ageHours > pendingExpiryHours(trade.market)) {
        trade.status = "CANCELLED"; trade.outcome = "PENDING_EXPIRED";
        trade.closedAt = nowIso(); trade.closePrice = livePrice;
        changed = true; continue;
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
    if (trades.some(t => t.asset === asset && t.status === "FILLED" && t.outcome === "OPEN")) return;
    const candles = await fetcher(asset);
    const signal  = analyse(asset, candles, market);
    if (!signal) return;
    if (signal.score < MIN_GLOBAL_SCORE) return;
    if (signal.score < minScoreForMarket(signal.market)) return;
    results.push(signal);
  }

  if (ENABLE_CRYPTO && isCryptoWindowOpen()) {
    await mapWithConcurrency(CRYPTO_PAIRS, MAX_CONCURRENT_REQUESTS, asset =>
      processAsset(asset, "CRYPTO", fetchCrypto)
    );
  }
  if (ENABLE_US && isUSMarketOpen()) {
    await mapWithConcurrency(STOCK_POOL, MAX_CONCURRENT_REQUESTS, asset =>
      processAsset(asset, "US", fetchUSData)
    );
  }
  if (ENABLE_LSE && isLSEMarketOpen()) {
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
        await closeTrade(
          trades, existingOpenTrade,
          Number.isFinite(livePrice) ? livePrice : existingOpenTrade.entry,
          "REPLACED"
        );
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
async function runCycle() {
  if (running) return;
  running = true;
  try {
    ensureFiles();
    await updateBTCTrend();
    await updateQQQTrend();
    await checkMarketAlerts();
    await manageTrades();
    const signals = await scan();
    if (signals.length > 0) {
      await processSignals(signals);
    } else {
      console.log("NO VALID SIGNALS THIS CYCLE");
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
  console.log(`\uD83D\uDE80 Health server on port ${PORT}`);
  await send(
    "\uD83D\uDE80\uD83D\uDD25 SNIPER V80 HUNTER EDITION LIVE\n" +
    "Dynamic pools \u2022 Narrative detection \u2022 Momentum Ignition \u2022 Trade coach active"
  );
  await refreshDynamicPools();
  await runCycle();
  setInterval(async () => { if (!running) await runCycle(); }, SCAN_INTERVAL_MS);
  setInterval(async () => { await refreshDynamicPools(); },   POOL_REFRESH_INTERVAL_MS);
});
