console.log("🚀 SNIPER V88 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");

axios.defaults.timeout = 15000;

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY || "";
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || "";

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILES = {
  alerts: path.join(DATA_DIR, "alerts.json"),
  trades: path.join(DATA_DIR, "trades.json"),
  movers: path.join(DATA_DIR, "movers.json"),
  narratives: path.join(DATA_DIR, "narratives.json")
};

const ENABLE_CRYPTO = true;
const ENABLE_US = true;
const ENABLE_LSE = true;

const CRYPTO_SCAN_START_UK = 6;
const CRYPTO_SCAN_END_UK = 22;
const LSE_START_UK_HOUR = 8;
const LSE_START_UK_MIN = 0;
const LSE_END_UK_HOUR = 16;
const LSE_END_UK_MIN = 30;
const US_START_UK_HOUR = 14;
const US_START_UK_MIN = 30;
const US_END_UK_HOUR = 21;
const US_END_UK_MIN = 0;

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5000;
const REQUEST_DELAY_MS = 250;
const SHUTDOWN_EXIT_MS = 5000;

const MAX_CONCURRENT_REQUESTS = 3;
const MIN_CANDLES = 60;
const ATR_PERIOD = 14;
const BREAKOUT_LOOKBACK = 10;

const BASE_RISK_PER_TRADE = 0.01;
const ACCOUNT_BALANCE = 10000;
const MAX_PORTFOLIO_RISK = 0.05;
const TARGET_R = 1.5;
const MIN_RR = 1.5;

const CRYPTO_COOLDOWN_HOURS = 2;
const US_COOLDOWN_HOURS = 4;
const LSE_COOLDOWN_HOURS = 6;

const MIN_GLOBAL_SCORE = 78;
const MIN_US_SCORE = 80;
const MIN_LSE_SCORE = 76;

const CACHE_TTL_MS = 4 * 60 * 1000;

const API_LIMITS = { twelvedata: 700, alphavantage: 20 };
let apiUsage = { twelvedata: 0, alphavantage: 0, resetDay: -1 };
let apiRotateIdx = 0;
let finnhubBlockedUntil = 0;

const STATIC_CRYPTO_FALLBACK = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT",
  "AVAXUSDT", "SUIUSDT", "NEARUSDT", "RENDERUSDT",
  "TONUSDT", "ONDOUSDT"
];

const STATIC_STOCK_FALLBACK = [
  "NVDA", "PLTR", "AMD", "ASTS", "IONQ", "MSFT", "META",
  "AMZN", "APP", "MSTR", "COIN", "QQQ", "SMH", "AVGO",
  "VRT", "CRWD", "AMAT", "GEV", "AVAV", "OKLO", "RKLB",
  "LUNR", "ETN", "ANET"
];

const LSE_POOL = ["RR.LON", "BA.LON", "SHEL.LON", "LSEG.LON", "BARC.LON"];

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
  GOLD: ["gold price", "gold rally", "bullion", "gold futures", "precious metals", "safe haven"],
  SILVER: ["silver price", "silver rally", "industrial metals", "silver futures"],
  CRYPTO: ["bitcoin", "ethereum", "crypto rally", "btc", "eth", "digital assets", "blockchain"],
  ENERGY: ["oil price", "crude", "energy rally", "opec", "natural gas", "brent"],
  DEFENSE: ["defense spending", "military", "nato", "geopolitical", "weapons", "war", "conflict"],
  ROBOTICS: ["robotics", "automation", "humanoid", "manufacturing robot", "cobots"],
  NUCLEAR: ["nuclear energy", "uranium", "small modular reactor", "smr", "nuclear power", "fission"]
};

const CRYPTO_AI_NAMES = ["RENDERUSDT", "FETUSDT", "NEARUSDT", "TAOUSDT", "AGIXUSDT", "OCEANUSDT"];
const CLEAN_TICKER = /^[A-Z]{1,5}$/;
const OTC_SUFFIXES = ["F", "Y", "PK"];

let STOCK_POOL = [...new Set(STATIC_STOCK_FALLBACK)];
let CRYPTO_PAIRS = [...STATIC_CRYPTO_FALLBACK];
let HOT_SECTORS = [];

let running = false;
let shuttingDown = false;
let ready = false;
let fatalTriggered = false;
let btcTrend = "neutral";
let qqqTrend = "neutral";

let cycleTimer = null;
let refreshTimer = null;
let server = null;

const candleCache = new Map();

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
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function saveLocal(file, data) {
  atomicWriteFile(file, JSON.stringify(data, null, 2));
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

function lines(parts) {
  return parts.join("
");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getUkNowParts() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return map;
}

function getUkDayIndex() {
  const weekday = getUkNowParts().weekday;
  const map = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };
  return map[weekday];
}

function getUkMinutes() {
  const parts = getUkNowParts();
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function isWeekendUk() {
  const day = getUkDayIndex();
  return day === 0 || day === 6;
}

function isWeekdayUk() {
  return !isWeekendUk();
}

function isCryptoWindowOpen() {
  if (!ENABLE_CRYPTO) return false;
  const mins = getUkMinutes();
  return mins >= CRYPTO_SCAN_START_UK * 60 && mins < CRYPTO_SCAN_END_UK * 60;
}

function isLSEMarketOpen() {
  if (!ENABLE_LSE || isWeekendUk()) return false;
  const mins = getUkMinutes();
  const start = LSE_START_UK_HOUR * 60 + LSE_START_UK_MIN;
  const end = LSE_END_UK_HOUR * 60 + LSE_END_UK_MIN;
  return mins >= start && mins < end;
}

function isUSMarketOpen() {
  if (!ENABLE_US || isWeekendUk()) return false;
  const mins = getUkMinutes();
  const start = US_START_UK_HOUR * 60 + US_START_UK_MIN;
  const end = US_END_UK_HOUR * 60 + US_END_UK_MIN;
  return mins >= start && mins < end;
}

function shouldScanCrypto() {
  return isCryptoWindowOpen();
}

function shouldScanStocks() {
  return isWeekdayUk() && (isLSEMarketOpen() || isUSMarketOpen());
}

function shouldSendStockNarrativeAlerts() {
  return isWeekdayUk() && (isLSEMarketOpen() || isUSMarketOpen());
}

function shouldSendCryptoMoversAlerts() {
  return shouldScanCrypto();
}

function shouldSendCryptoHeatingAlerts() {
  return shouldScanCrypto();
}

function marketCooldownHours(market) {
  if (market === "CRYPTO") return CRYPTO_COOLDOWN_HOURS;
  if (market === "LSE") return LSE_COOLDOWN_HOURS;
  return US_COOLDOWN_HOURS;
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

function resetApiUsageIfNewDay() {
  const day = new Date().getUTCDate();
  if (apiUsage.resetDay !== day) {
    apiUsage = { twelvedata: 0, alphavantage: 0, resetDay: day };
    apiRotateIdx = 0;
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

async function safeRun(name, fn) {
  try {
    return await fn();
  } catch (e) {
    log(`SAFE RUN ERROR (${name}):`, e?.message || e);
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

async function loadAlerts() {
  return loadLocal(FILES.alerts, []);
}

async function saveAlerts(alerts) {
  saveLocal(FILES.alerts, alerts.slice(-1000));
}

async function loadTrades() {
  return loadLocal(FILES.trades, []);
}

async function saveTrades(trades) {
  saveLocal(FILES.trades, trades.slice(-1000));
}

async function loadMoversState() {
  return loadLocal(FILES.movers, []);
}

async function saveMoversState(data) {
  saveLocal(FILES.movers, data.slice(-200));
}

async function loadNarrativesState() {
  return loadLocal(FILES.narratives, []);
}

async function saveNarrativesState(data) {
  saveLocal(FILES.narratives, data.slice(-200));
}

async function getTrendingCoins() {
  const result = await safeRequest(() =>
    axios.get("https://api.coingecko.com/api/v3/search/trending", {
      headers: COINGECKO_API_KEY ? { "x-cg-demo-api-key": COINGECKO_API_KEY } : {},
      timeout: 12000
    }), "CoinGecko"
  );
  if (!result?.data?.coins) return [];
  return result.data.coins
    .map(c => {
      const sym = (c?.item?.symbol || "").toUpperCase();
      return sym ? `${sym}USDT` : null;
    })
    .filter(Boolean)
    .slice(0, 12);
}

async function getTrendingStocks() {
  if (!canUseFinnhub()) return [...STATIC_STOCK_FALLBACK];
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
  return dedup([...STATIC_STOCK_FALLBACK, ...filtered]).slice(0, 25);
}

async function getCryptoMovers() {
  const movers = [];
  await mapWithConcurrency(CRYPTO_PAIRS.slice(0, 12), 3, async pair => {
    const candles = await fetchCrypto(pair);
    if (!candles || candles.length < 3) return;
    const last = candles.at(-1)?.close;
    const prev = candles.at(-2)?.close;
    if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) return;
    const pct = ((last - prev) / prev) * 100;
    if (pct >= 2.5) movers.push({ asset: pair, pct });
  });
  return movers.sort((a, b) => b.pct - a.pct);
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
  return Object.entries(scores)
    .filter(([, s]) => s >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);
}

async function sendCryptoMoversAlert(movers) {
  if (!shouldSendCryptoMoversAlerts()) return;
  if (!Array.isArray(movers) || movers.length === 0) return;

  const state = await loadMoversState();
  const key = `${new Date().toISOString().slice(0, 13)}-crypto`;
  if (state.some(x => x.key === key)) return;

  const linesOut = [
    "🪙🔥 <b>CRYPTO MOVERS</b>",
    "",
    ...movers.slice(0, 5).map(m => `🚀 <b>${escapeHtml(m.asset)}</b> +${m.pct.toFixed(2)}%`)
  ];

  await safeRun("telegramCryptoMovers", async () => {
    await send(lines(linesOut));
  });

  state.push({ key, sentAt: nowIso() });
  await saveMoversState(state);
}

async function sendCryptoHeatingAlert(signals) {
  if (!shouldSendCryptoHeatingAlerts()) return;
  const hot = signals.filter(s => s.market === "CRYPTO" && s.score >= 82);
  if (hot.length === 0) return;

  const state = await loadNarrativesState();
  const key = `${new Date().toISOString().slice(0, 13)}-heating`;
  if (state.some(x => x.key === key)) return;

  const msg = lines([
    "♨️🪙 <b>CRYPTO HEATING UP</b>",
    "",
    ...hot.slice(0, 5).map(s => `⚡ <b>${escapeHtml(s.asset)}</b> | score ${s.score} | ${escapeHtml(s.setupType)}`)
  ]);

  await safeRun("telegramCryptoHeating", async () => {
    await send(msg);
  });

  state.push({ key, sentAt: nowIso() });
  await saveNarrativesState(state);
}

async function sendStockNarrativeAlert() {
  if (!shouldSendStockNarrativeAlerts()) return;
  if (!HOT_SECTORS.length) return;

  const msg = lines([
    "🧠📈 <b>STOCK NARRATIVES ACTIVE</b>",
    "",
    ...HOT_SECTORS.map(s => {
      const syms = (SECTOR_SYMBOLS[s] || []).slice(0, 4).join(", ");
      return `📌 <b>${escapeHtml(s)}</b> → ${escapeHtml(syms)}`;
    }),
    "",
    `🔍 Stock pool: <b>${escapeHtml(String(STOCK_POOL.length))}</b>`
  ]);

  await safeRun("telegramStockNarrative", async () => {
    await send(msg);
  });
}

async function refreshDynamicPools() {
  if (shuttingDown) return;

  log("🔄 Refreshing V88 pools...");

  const trendingCoins = await getTrendingCoins();
  CRYPTO_PAIRS = dedup([...STATIC_CRYPTO_FALLBACK, ...trendingCoins]).slice(0, 15);

  if (isWeekendUk()) {
    HOT_SECTORS = [];
    STOCK_POOL = [...STATIC_STOCK_FALLBACK];
    const cryptoMovers = await getCryptoMovers();
    await sendCryptoMoversAlert(cryptoMovers);
    log(`✅ Weekend mode — Crypto: ${CRYPTO_PAIRS.length}, Stocks disabled`);
    return;
  }

  HOT_SECTORS = await detectHotSectors();
  const trendingStocks = await getTrendingStocks();

  const injected = [];
  for (const sector of HOT_SECTORS) {
    injected.push(...(SECTOR_SYMBOLS[sector] || []).filter(isCleanTicker));
  }

  STOCK_POOL = dedup([...trendingStocks, ...injected]).slice(0, 25);

  if (shouldSendStockNarrativeAlerts()) {
    await sendStockNarrativeAlert();
  }

  const cryptoMovers = await getCryptoMovers();
  await sendCryptoMoversAlert(cryptoMovers);

  log(`✅ Weekday mode — Crypto: ${CRYPTO_PAIRS.length}, Stocks: ${STOCK_POOL.length}`);
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
    const candles = data.map(k => ({
      close: +k[4],
      high: +k[2],
      low: +k[3],
      volume: +k[5]
    }));
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
      .map(([, v]) => ({
        close: +v["4. close"],
        high: +v["2. high"],
        low: +v["3. low"],
        volume: +v["5. volume"]
      }))
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

function isUSOpeningWindow() {
  if (isWeekendUk()) return false;
  const mins = getUkMinutes();
  const start = US_START_UK_HOUR * 60 + US_START_UK_MIN;
  return mins >= start && mins < start + 90;
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
    if (!candles) candles = await fetchAlphaVantageSeries(symbol, use15min ? "15min" : "60min");
  } else if (api === "alphavantage") {
    candles = await fetchAlphaVantageSeries(symbol, use15min ? "15min" : "60min");
    if (!candles) candles = await fetchTwelveDataSeries(symbol, interval, use15min ? 40 : 70);
  }

  if (!candles) {
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
  if (!candles) candles = await fetchYahooFinanceSeries(symbol, "1h");

  if (candles) setCache(cacheKey, candles);
  return candles;
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

    let price = null;

    if (TWELVE_DATA_API_KEY) {
      try {
        const { data } = await retry(() =>
          axios.get("https://api.twelvedata.com/price", {
            params: { symbol: asset, apikey: TWELVE_DATA_API_KEY },
            timeout: 12000
          })
        );
        if (data?.status !== "error") {
          apiUsage.twelvedata++;
          price = +data.price;
        }
      } catch {}
    }

    if (!Number.isFinite(price) && ALPHA_VANTAGE_API_KEY) {
      try {
        const { data } = await retry(() =>
          axios.get("https://www.alphavantage.co/query", {
            params: { function: "GLOBAL_QUOTE", symbol: asset, apikey: ALPHA_VANTAGE_API_KEY },
            timeout: 12000
          })
        );
        const p = +data?.["Global Quote"]?.["05. price"];
        if (Number.isFinite(p)) {
          apiUsage.alphavantage++;
          price = p;
        }
      } catch {}
    }

    if (!Number.isFinite(price)) {
      try {
        const { data } = await retry(() =>
          axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${asset}`, {
            params: { interval: "1m", range: "1d" },
            headers: { "User-Agent": "Mozilla/5.0" },
            timeout: 10000
          })
        );
        price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      } catch {}
    }

    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

function classifyRegime(ema20Val, ema50Val, price) {
  if (!Number.isFinite(ema20Val) || !Number.isFinite(ema50Val) || !Number.isFinite(price) || ema50Val === 0) return "neutral";
  const spread = (ema20Val - ema50Val) / ema50Val;
  if (ema20Val > ema50Val && price > ema20Val) return spread >= 0.02 ? "strong_bull" : "bull";
  if (spread <= -0.02) return "risk_off";
  return "neutral";
}

async function updateBTCTrend() {
  const candles = await fetchCrypto("BTCUSDT");
  if (!candles) return;
  const closes = candles.map(x => x.close);
  btcTrend = classifyRegime(ema(closes, 20), ema(closes, 50), closes.at(-1));
}

async function updateQQQTrend() {
  if (!isUSMarketOpen()) {
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

function getNarrativeBonus(asset) {
  let bonus = 0;
  const sym = asset.replace("USDT", "");
  for (const sector of HOT_SECTORS) {
    if ((SECTOR_SYMBOLS[sector] || []).includes(sym)) bonus += 6;
  }
  if (HOT_SECTORS.includes("AI") && CRYPTO_AI_NAMES.includes(asset)) bonus += 5;
  return bonus;
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
  if (!regimePass(market)) return null;

  const avgVol = avg(volumes.slice(-21, -1));
  const currentVol = volumes.at(-1);
  const volRatio = avgVol > 0 ? currentVol / avgVol : 0;

  const breakoutLevel = Math.max(...highs.slice(-BREAKOUT_LOOKBACK, -1));
  const breakoutDistance = breakoutLevel > 0 ? (last - breakoutLevel) / breakoutLevel : 0;

  const breakoutSignal = last > breakoutLevel && breakoutDistance <= 0.04 && volRatio >= 1.4;
  const nearEMA20 = Math.abs(last - ema20) / ema20 <= 0.025;
  const pulledBackRecently = closes.slice(-6, -1).some(c => c <= ema20 * 1.01);
  const pullbackSignal = nearEMA20 && pulledBackRecently && volRatio >= 1.2;
  const ignitionSignal = momentum > 0.025 && volRatio > 2.0;

  if (!pullbackSignal && !breakoutSignal && !ignitionSignal) return null;

  let setupType = "BREAKOUT_CONTINUATION";
  if (pullbackSignal && !breakoutSignal && !ignitionSignal) setupType = "PULLBACK_CONTINUATION";
  if (ignitionSignal) setupType = "MOMENTUM_IGNITION";

  const entryType = setupType === "PULLBACK_CONTINUATION" ? "LIMIT BUY" : "MARKET BUY";
  const entry = setupType === "PULLBACK_CONTINUATION" ? ema20 * 1.002 : last;

  const atr = calculateATR(candles, ATR_PERIOD);
  if (!atr || atr <= 0) return null;

  const swingLow = Math.min(...lows.slice(-6));
  const sl = Math.min(swingLow - atr * 1.3, entry - atr * 1.3);
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
  if (momentum > 0.025) score += 10;
  else if (momentum > 0.015) score += 8;
  else if (momentum > 0.008) score += 4;

  if (setupType === "BREAKOUT_CONTINUATION") score += 10;
  if (setupType === "PULLBACK_CONTINUATION") score += 8;
  if (setupType === "MOMENTUM_IGNITION") score += 18;

  if (market === "CRYPTO") score += 5;
  if (market === "US") score += 4;
  if (market === "LSE") score += 2;

  if (market === "CRYPTO" && btcTrend === "strong_bull") score += 5;
  if (market === "US" && qqqTrend === "bull") score += 3;
  if (market === "US" && qqqTrend === "strong_bull") score += 5;

  score += getNarrativeBonus(asset);

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
    breakoutDistance
  };
}

function adjustRiskByScore(score) {
  if (score >= 85) return 1.5;
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

function cooldown(asset, alerts, market) {
  const last = [...alerts].reverse().find(x => x.asset === asset && x.market === market);
  if (!last) return false;
  return hoursAgo(last.sentAt) < marketCooldownHours(market);
}

function countOpenTradesByMarket(trades, market) {
  return trades.filter(t => t.market === market && t.status === "FILLED" && t.outcome === "OPEN").length;
}

function countPendingTradesByMarket(trades, market) {
  return trades.filter(t => t.market === market && t.status === "PENDING").length;
}

function getOpenRiskFraction(trades) {
  return trades
    .filter(t => t.status === "FILLED" && t.outcome === "OPEN")
    .reduce((sum, t) => sum + (t.riskFraction || 0), 0);
}

function gradeEmoji(g) {
  return g === "A*" ? "💎🔥" : g === "A" ? "🚀⚡" : "📈";
}

function setupEmoji(t) {
  if (t === "BREAKOUT_CONTINUATION") return "💥";
  if (t === "PULLBACK_CONTINUATION") return "🎯";
  if (t === "MOMENTUM_IGNITION") return "⚡";
  return "📊";
}

function marketEmoji(m) {
  if (m === "CRYPTO") return "🪙";
  if (m === "US") return "🇺🇸";
  if (m === "LSE") return "🇬🇧";
  return "📊";
}

function buildSignalLesson(signal) {
  const parts = ["📚 <b>TRADE LESSON</b>", ""];

  if (signal.setupType === "BREAKOUT_CONTINUATION") {
    parts.push("💥 <b>Breakout Continuation</b> — price pushed above a recent resistance level. We enter as it breaks out expecting momentum to carry it higher.");
  } else if (signal.setupType === "PULLBACK_CONTINUATION") {
    parts.push("🎯 <b>Pullback Continuation</b> — price dipped back to its 20-period EMA and is bouncing. Lower-risk entry than chasing a spike.");
  } else if (signal.setupType === "MOMENTUM_IGNITION") {
    parts.push("⚡ <b>Momentum Ignition</b> — explosive early runner detected before full breakout confirmation. These can move fast.");
  }

  parts.push(`📊 <b>Volume ${signal.volRatio.toFixed(2)}x average</b> — confirms participation behind the move.`);

  if (signal.market === "CRYPTO") {
    if (signal.asset === "BTCUSDT") {
      parts.push(`
🪙 <b>BTC note</b> — Bitcoin moves in smaller percentages than altcoins. Watch percentages rather than dollar amounts.`);
    } else {
      parts.push(`🪙 <b>Altcoin note</b> — ${signal.asset.replace("USDT", "")} can move sharply when BTC trend is <b>${escapeHtml(btcTrend.replace("_", " "))}</b>. Altcoins often amplify Bitcoin direction.`);
    }
  } else if (signal.market === "US") {
    parts.push(`🇺🇸 <b>US note</b> — QQQ trend is <b>${escapeHtml(qqqTrend.replace("_", " "))}</b>. A healthy tape improves breakout follow-through.`);
  } else {
    parts.push(`
🇬🇧 <b>LSE note</b> — London stocks move more slowly than US or crypto. Expect this to develop over hours rather than minutes.`);
  }

  if (signal.grade === "A*") {
    parts.push(`
⭐ <b>A* grade</b> — highest rating the system gives. All conditions aligned: trend, volume, momentum, setup quality. Pay close attention to these.`);
  } else if (signal.grade === "A") {
    parts.push(`
⭐ <b>A grade</b> — strong signal. Most conditions met. Well above the minimum threshold.`);
  }

  parts.push(`⚡ <b>Momentum:</b> ${(signal.momentum * 100).toFixed(2)}%`);
  parts.push(`🎯 <b>Target:</b> approx ${signal.rr}R`);

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
    `🛡️ SL: ${escapeHtml(formatPrice(signal.sl, signal.market))}`,
    `🎯 TP: ${escapeHtml(formatPrice(signal.tp, signal.market))}`,
    `⚖️ R:R: ${escapeHtml(String(signal.rr))}`,
    `⭐ Score: ${escapeHtml(String(signal.score))}`,
    `📊 Vol: ${escapeHtml(signal.volRatio.toFixed(2))}x`,
    `📐 Size: ${escapeHtml(size.toFixed(2))}`,
    "",
    buildSignalLesson(signal)
  ]);
}

function updateTradeExcursion(trade, livePrice) {
  if (!Number.isFinite(livePrice)) return;
  const adverse = Math.max(0, (trade.entry - livePrice) / trade.entry);
  const favorable = Math.max(0, (livePrice - trade.entry) / trade.entry);
  if (!Number.isFinite(trade.maePct) || adverse > trade.maePct) trade.maePct = adverse;
  if (!Number.isFinite(trade.mfePct) || favorable > trade.mfePct) trade.mfePct = favorable;
}

function buildCloseMessage(trade, reason, closePrice) {
  const rVal = Number.isFinite(trade.realizedR) ? trade.realizedR.toFixed(2) : "n/a";
  return lines([
    `🔚 <b>${escapeHtml(reason)}</b>`,
    "",
    `${marketEmoji(trade.market)} <b>${escapeHtml(trade.market)} | ${escapeHtml(trade.asset)}</b>`,
    `💵 Close: ${escapeHtml(formatPrice(closePrice, trade.market))}`,
    `📊 R: ${escapeHtml(rVal)}`
  ]);
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
      const filled = trade.entryType === "MARKET BUY"
        ? true
        : livePrice <= trade.entry * 1.002;

      if (filled) {
        trade.status = "FILLED";
        trade.outcome = "OPEN";
        trade.fillPrice = livePrice;
        trade.filledAt = nowIso();
        trade.maePct = 0;
        trade.mfePct = 0;
        changed = true;
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
    }
  }

  if (changed) await saveTrades(trades);
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

function pickBestPerMarket(results) {
  const best = {};
  for (const s of results.sort((a, b) => b.score - a.score)) {
    if (!best[s.market]) best[s.market] = s;
  }
  return Object.values(best);
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

  if (shouldScanCrypto()) {
    await mapWithConcurrency(CRYPTO_PAIRS, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset, "CRYPTO", fetchCrypto));
  }

  if (!isWeekendUk()) {
    if (isUSMarketOpen()) {
      await mapWithConcurrency(STOCK_POOL, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset, "US", fetchUSData));
    }
    if (isLSEMarketOpen()) {
      await mapWithConcurrency(LSE_POOL, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset, "LSE", fetchLSEData));
    }
  }

  return pickBestPerMarket(results);
}

async function processSignals(signals) {
  const alerts = await loadAlerts();
  const trades = await loadTrades();

  for (const signal of signals) {
    if (signal.score < MIN_GLOBAL_SCORE) continue;
    if (signal.score < minScoreForMarket(signal.market)) continue;

    if (countOpenTradesByMarket(trades, signal.market) >= 1) continue;
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
    await safeRun("manageTrades", manageTrades);

    const signals = await safeRun("scan", scan);

    if (Array.isArray(signals) && signals.length > 0) {
      await safeRun("processSignals", () => processSignals(signals));
      await safeRun("cryptoHeating", () => sendCryptoHeatingAlert(signals));
    } else {
      log("NO VALID SIGNALS THIS CYCLE");
    }
  } catch (err) {
    log("MAIN LOOP FAILURE:", err?.message || err);
  } finally {
    running = false;
  }
}

async function cycleLoop() {
  if (shuttingDown) return;
  await safeCycle();
  cycleTimer = setTimeout(() => {
    void cycleLoop();
  }, SCAN_INTERVAL_MS);
}

async function refreshLoop() {
  if (shuttingDown) return;
  await safeRun("refreshDynamicPools", refreshDynamicPools);
  refreshTimer = setTimeout(() => {
    void refreshLoop();
  }, REFRESH_INTERVAL_MS);
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
    log("SHUTDOWN ERROR:", err?.message || err);
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

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

app.get("/", (_req, res) => {
  res.status(200).send("SNIPER V88 alive");
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    uptime: process.uptime(),
    running,
    ready,
    shuttingDown,
    weekendUk: isWeekendUk(),
    cryptoOpen: isCryptoWindowOpen(),
    lseOpen: isLSEMarketOpen(),
    usOpen: isUSMarketOpen()
  });
});

app.get("/ready", (_req, res) => {
  if (ready && !shuttingDown) return res.status(200).send("ready");
  return res.status(503).send("not ready");
});

async function startup() {
  ensureFiles();
  await sleep(STARTUP_DELAY_MS);
  await safeRun("initialPoolRefresh", refreshDynamicPools);
  ready = true;
  await safeRun("initialCycle", safeCycle);
  void cycleLoop();
  void refreshLoop();
  log("✅ SNIPER V88 READY");
}

server = app.listen(PORT, "0.0.0.0", async () => {
  log(`🚀 SERVER ONLINE PORT ${PORT}`);

  await safeRun("startupTelegram", async () => {
    await send(`
🚀🔥 SNIPER V88 LIVE
Weekend logic active
Crypto-only weekends enabled
Weekday session windows enabled
Stock narrative suppression on weekends active
Yahoo fallback active
Graceful shutdown enabled
`);
  });

  await startup();
});
