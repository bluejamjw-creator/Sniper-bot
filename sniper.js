const fs = require("fs");
const path = require("path");
const axios = require("axios");

// =======================
// ENV
// =======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DATA_DIR = process.env.DATA_DIR || ".";
const SIGNAL_FILE = path.join(DATA_DIR, "signals.json");

const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 70);
const MAX_ALERTS = Number(process.env.MAX_ALERTS_PER_SCAN || 2);
const COOLDOWN_HOURS = Number(process.env.COOLDOWN_HOURS || 6);

const ACCOUNT_SIZE = Number(process.env.ACCOUNT_SIZE || 1000);
const RISK_PCT = Number(process.env.RISK_PCT || 0.02);

const REQUEST_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 30 * 60 * 1000;

// =======================
// WATCHLIST
// =======================
const WATCHLIST = {
  stocks: ["SMH", "EQQQ.L", "PLTR", "AMD", "APP", "MSTR", "COIN", "ASTS", "SOUN"],
  crypto: ["SOL", "ETH", "FET", "RNDR"]
};

const CG_IDS = {
  ETH: "ethereum",
  SOL: "solana",
  FET: "fetch-ai",
  RNDR: "render-token"
};

// =======================
// CACHE
// =======================
const CACHE = new Map();

function getCache(key) {
  const item = CACHE.get(key);
  if (!item) return null;
  if (Date.now() - item.t > CACHE_TTL_MS) return null;
  return item.d;
}

function setCache(key, data) {
  CACHE.set(key, { d: data, t: Date.now() });
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of CACHE.entries()) {
    if (now - v.t > CACHE_TTL_MS) {
      CACHE.delete(k);
    }
  }
}, 10 * 60 * 1000);

// =======================
// STORAGE
// =======================
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SIGNAL_FILE)) fs.writeFileSync(SIGNAL_FILE, "[]
", "utf8");

function loadSignals() {
  try {
    return JSON.parse(fs.readFileSync(SIGNAL_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSignals(signals) {
  fs.writeFileSync(
    SIGNAL_FILE,
    JSON.stringify(signals.slice(-100), null, 2) + "
",
    "utf8"
  );
}

// =======================
// TELEGRAM
// =======================
async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: String(msg),
        disable_web_page_preview: true
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

// =======================
// HELPERS
// =======================
function norm(asset) {
  return String(asset || "").toUpperCase().replace("USDT", "");
}

function key(signal) {
  return `${signal.asset}|${signal.entry}|${signal.sl}|${signal.tp}`;
}

function duplicate(signal, list) {
  return list.some((x) => key(x) === key(signal));
}

function cooldown(asset, list) {
  const now = Date.now();
  return list.some(
    (x) =>
      norm(x.asset) === norm(asset) &&
      now - Number(x.time || 0) < COOLDOWN_HOURS * 3600000
  );
}

function safeSeries(closes) {
  if (!Array.isArray(closes)) return null;
  const clean = closes.filter((x) => Number.isFinite(x));
  if (clean.length < 20) return null;
  return clean;
}

function summarise(symbol, closes, source) {
  const clean = safeSeries(closes);
  if (!clean) return null;

  const last20 = clean.slice(-20);
  const last = clean[clean.length - 1];
  const prev = clean[clean.length - 2];

  if (![last, prev].every(Number.isFinite)) return null;

  return {
    symbol,
    source,
    last,
    prev,
    high: Math.max(...last20),
    low: Math.min(...last20),
    sma: last20.reduce((a, b) => a + b, 0) / last20.length
  };
}

function newAbortSignal(timeoutMs) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

async function httpGet(url, config = {}) {
  return axios.get(url, {
    timeout: REQUEST_TIMEOUT_MS,
    signal: newAbortSignal(REQUEST_TIMEOUT_MS),
    ...config
  });
}

function positionSize(entry, sl, accountSize = ACCOUNT_SIZE, riskPct = RISK_PCT) {
  const riskAmount = accountSize * riskPct;
  const riskPerUnit = entry - sl;

  if (!Number.isFinite(riskAmount) || !Number.isFinite(riskPerUnit)) return null;
  if (riskPerUnit <= 0) return null;

  const size = riskAmount / riskPerUnit;

  return {
    size: Number(size.toFixed(4)),
    riskAmount: Number(riskAmount.toFixed(2)),
    riskPerUnit: Number(riskPerUnit.toFixed(2))
  };
}

// =======================
// STOCK FETCH
// =======================
async function fetchStockYahoo(symbol) {
  try {
    const { data } = await httpGet(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`
    );

    const closes =
      data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];

    return summarise(symbol, closes, "Yahoo");
  } catch (e) {
    console.log(`Yahoo failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchStockStooq(symbol) {
  try {
    const { data } = await httpGet(
      `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}&i=d`
    );

    const lines = String(data).trim().split("
").slice(1);
    const closes = lines
      .map((line) => Number(String(line).split(",")[4]))
      .filter((x) => Number.isFinite(x));

    return summarise(symbol, closes, "Stooq");
  } catch (e) {
    console.log(`Stooq failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchStock(symbol) {
  const cacheKey = `stock_${symbol}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const result =
    (await fetchStockYahoo(symbol)) ||
    (await fetchStockStooq(symbol));

  if (result) setCache(cacheKey, result);
  return result;
}

// =======================
// CRYPTO FETCH
// =======================
async function fetchCryptoCoinGecko(symbol) {
  const id = CG_IDS[symbol];
  if (!id) return null;

  try {
    const { data } = await httpGet(
      `https://api.coingecko.com/api/v3/coins/${id}/market_chart`,
      { params: { vs_currency: "usd", days: 30 } }
    );

    const closes = safeSeries((data?.prices || []).map((p) => Number(p[1])));
    if (!closes) return null;

    return summarise(symbol, closes, "CoinGecko");
  } catch (e) {
    console.log(`CoinGecko failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchCryptoBinance(symbol) {
  try {
    const pair = `${symbol}USDT`;
    const { data } = await httpGet(
      `https://api.binance.com/api/v3/klines`,
      { params: { symbol: pair, interval: "1d", limit: 30 } }
    );

    const closes = safeSeries((data || []).map((row) => Number(row[4])));
    if (!closes) return null;

    return summarise(symbol, closes, "Binance");
  } catch (e) {
    console.log(`Binance failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchCrypto(symbol) {
  const cacheKey = `crypto_${symbol}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const result =
    (await fetchCryptoCoinGecko(symbol)) ||
    (await fetchCryptoBinance(symbol));

  if (result) setCache(cacheKey, result);
  return result;
}

// =======================
// SIGNAL LOGIC
// =======================
function buildSignal(market, type) {
  if (!market) return null;

  const entry = market.last;
  const sl = market.low * 0.99;
  const tp = Math.max(market.high * 1.05, entry * 1.08);

  if (![entry, sl, tp].every(Number.isFinite)) return null;
  if (!(entry > 0 && sl > 0 && tp > 0)) return null;
  if (entry <= sl) return null;
  if (Math.abs(entry - sl) < 1e-6) return null;

  const rr = (tp - entry) / (entry - sl);
  if (!Number.isFinite(rr) || rr < 1.4) return null;

  const momentum = (market.last - market.prev) / market.prev;
  const aboveSMA = market.last > market.sma;
  const nearBreakout = entry > market.high * 0.97;

  let conf = 50;
  if (momentum > 0.01) conf += 15;
  if (aboveSMA) conf += 15;
  if (nearBreakout) conf += 20;

  if (conf < MIN_CONFIDENCE) return null;

  return {
    asset: market.symbol,
    entry: +entry.toFixed(2),
    sl: +sl.toFixed(2),
    tp: +tp.toFixed(2),
    confidence: conf,
    type,
    source: market.source,
    rr: Number(rr.toFixed(2)),
    time: Date.now()
  };
}

// =======================
// SCAN
// =======================
async function scan() {
  console.log("Scan start");

  const results = [];

  for (const symbol of WATCHLIST.stocks) {
    const market = await fetchStock(symbol);
    results.push(buildSignal(market, "stock"));
  }

  for (const symbol of WATCHLIST.crypto) {
    const market = await fetchCrypto(symbol);
    results.push(buildSignal(market, "crypto"));
  }

  const ranked = results
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_ALERTS);

  const signals = loadSignals();
  const seen = new Set();

  for (const signal of ranked) {
    if (seen.has(signal.asset)) continue;
    seen.add(signal.asset);

    if (duplicate(signal, signals)) continue;
    if (cooldown(signal.asset, signals)) continue;

    const pos = positionSize(signal.entry, signal.sl);
    if (!pos) continue;

    signals.push(signal);
    saveSignals(signals);

    const icon = signal.type === "crypto" ? "🪙" : "📈";

    await send(
      [
        "🚨 SNIPER SIGNAL",
        `${icon} ${signal.asset} (${signal.confidence}%)`,
        `Source: ${signal.source}`,
        `Entry: ${signal.entry}`,
        `SL: ${signal.sl}`,
        `TP: ${signal.tp}`,
        `RR: ${signal.rr}`,
        `Size: ${pos.size} units`,
        `Risk: £${pos.riskAmount}`
      ].join("
")
    );

    console.log("Signal:", signal.asset);
  }

  console.log("Scan end");
}

// =======================
// RUN ONCE
// =======================
scan().catch((e) => {
  console.error("Fatal error:", e.message);
});
