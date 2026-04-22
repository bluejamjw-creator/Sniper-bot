// ================================================================
// SNIPER V24.1
// 90%+ alerts only
// Crypto + Stocks + Portfolio Swaps
// Duplicate suppression, cooldowns, clear labels
// ================================================================

console.log("🚀 SNIPER V24.1 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const DATA_DIR = process.env.DATA_DIR || "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TRADES_FILE = path.join(DATA_DIR, "trades.json");
const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");

const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 90);
const MAX_SIGNALS = Number(process.env.MAX_SIGNALS || 1);
const MAX_OPEN_TRADES = Number(process.env.MAX_OPEN_TRADES || 1);
const COOLDOWN_HOURS = Number(process.env.COOLDOWN_HOURS || 24);
const SIGNAL_BROADCAST_COOLDOWN_MIN = Number(process.env.SIGNAL_BROADCAST_COOLDOWN_MIN || 60);

const MAX_MIN_STAKE = Number(process.env.MAX_MIN_STAKE || 200);
const MIN_MOMENTUM = Number(process.env.MIN_MOMENTUM || 0.0002);
const MIN_VOL_RATIO = Number(process.env.MIN_VOL_RATIO || 1.15);
const BREAKOUT_BUFFER = Number(process.env.BREAKOUT_BUFFER || 1.0);

const SPREAD_PCT = Number(process.env.SPREAD_PCT || 0.02);
const MIN_PROFIT_GBP = Number(process.env.MIN_PROFIT_GBP || 2);
const MIN_PROFIT_BUFFER = Number(process.env.MIN_PROFIT_BUFFER || 0.04);
const MIN_STAKE_BUFFER_MULT = Number(process.env.MIN_STAKE_BUFFER_MULT || 1.3);

const REVOLUT_PLAN = (process.env.REVOLUT_PLAN || "standard").toLowerCase();
const MONTHLY_VOLUME_GBP = Number(process.env.MONTHLY_VOLUME_GBP || 0);

const ENABLE_STOCKS = String(process.env.ENABLE_STOCKS || "true").toLowerCase() === "true";
const ENABLE_PORTFOLIO_SWAPS = String(process.env.ENABLE_PORTFOLIO_SWAPS || "true").toLowerCase() === "true";

const BLOCKED_ASSETS = new Set(
  String(process.env.BLOCKED_ASSETS || "")
    .split(",")
    .map(x => x.trim().toUpperCase())
    .filter(Boolean)
);

const STOCK_POOL = [
  "AAPL","MSFT","NVDA","TSLA","AMD","META","GOOG","AMZN",
  "PLTR","COIN","MSTR","SMCI","NFLX","CRM","ADBE","INTC",
  "BA","DIS","PYPL","UBER","SHOP","SQ","ROKU","SNOW"
];

const STATIC_CRYPTO_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT",
  "DOGEUSDT","AVAXUSDT","LINKUSDT","ADAUSDT","NEARUSDT",
  "DOTUSDT","TRXUSDT","APTUSDT","ARBUSDT","OPUSDT",
  "SUIUSDT","INJUSDT","SEIUSDT","ATOMUSDT","AAVEUSDT",
  "PEPEUSDT","PAXGUSDT"
];

const BINANCE_BASES = [
  "https://data-api.binance.vision",
  "https://api.binance.com"
];

let GBP = 0.79;
let btcTrend = "neutral";
let running = false;
let lastBroadcastAt = 0;
let lastDebug = {
  scannedCrypto: 0,
  scannedStocks: 0,
  passed: 0,
  rejected: {},
  source: "none",
  btcTrend: "neutral",
  updatedAt: null
};

const load = f => {
  try {
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return [];
  }
};

const save = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

function nowIso() { return new Date().toISOString(); }
function hoursAgo(ts) { return (Date.now() - new Date(ts).getTime()) / 36e5; }
function minsAgo(ts) { return (Date.now() - new Date(ts).getTime()) / 6e4; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function fmtGBP(v) { return `£${Number(v).toFixed(2)}`; }
function isFinitePositive(n) { return Number.isFinite(n) && n > 0; }
function avg(arr) { return arr && arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function incReject(reason) { lastDebug.rejected[reason] = (lastDebug.rejected[reason] || 0) + 1; }

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: msg
    }, { timeout: 15000 });
  } catch (e) {
    console.error("TELEGRAM_ERROR:", e.message);
  }
}

function getRevolutFeePct(plan, monthlyVolumeGBP) {
  const tiers = [
    { max: 10000, standard: 0.0149, plus: 0.0149, premium: 0.0099, metal: 0.0099, ultra: 0.0049 },
    { max: 50000, standard: 0.0129, plus: 0.0129, premium: 0.0079, metal: 0.0079, ultra: 0.0039 },
    { max: 100000, standard: 0.0109, plus: 0.0109, premium: 0.0059, metal: 0.0059, ultra: 0.0029 },
    { max: 250000, standard: 0.0089, plus: 0.0089, premium: 0.0049, metal: 0.0049, ultra: 0.0019 },
    { max: Infinity, standard: 0.0049, plus: 0.0049, premium: 0.0029, metal: 0.0029, ultra: 0.0 }
  ];
  const tier = tiers.find(t => monthlyVolumeGBP < t.max) || tiers[tiers.length - 1];
  return tier[plan] ?? tier.standard;
}

function totalFrictionPct(feePct) { return feePct + feePct + SPREAD_PCT; }
function realBuy(price, feePct) { return price * (1 + feePct + SPREAD_PCT); }
function realSell(price, feePct) { return price * (1 - feePct - SPREAD_PCT); }

function minStakeRequired(entry, tp, feePct) {
  const effectiveEntry = realBuy(entry, feePct);
  const effectiveExit = realSell(tp, feePct);
  const netPct = (effectiveExit - effectiveEntry) / effectiveEntry;
  if (!Number.isFinite(netPct) || netPct <= 0) return Infinity;
  return (MIN_PROFIT_GBP * MIN_STAKE_BUFFER_MULT) / netPct;
}

async function updateFX() {
  try {
    const { data } = await axios.get("https://open.er-api.com/v6/latest/USD", { timeout: 15000 });
    if (data?.rates?.GBP) GBP = data.rates.GBP;
  } catch (e) {
    console.error("FX_ERROR:", e.message);
  }
}

const toGBP = v => v * GBP;

async function safeBinanceGet(endpoint, params = {}) {
  for (const base of BINANCE_BASES) {
    try {
      const { data } = await axios.get(`${base}${endpoint}`, { params, timeout: 10000 });
      return data;
    } catch (e) {
      console.error(`BINANCE_FAIL ${base}${endpoint}:`, e.response?.status || e.code || e.message);
    }
  }
  throw new Error("All Binance endpoints failed");
}

async function getCryptoPairsFromBinance() {
  const data = await safeBinanceGet("/api/v3/ticker/24hr");
  return data
    .filter(x => x.symbol.endsWith("USDT"))
    .filter(x => parseFloat(x.quoteVolume) > 1000000)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 40)
    .map(x => x.symbol);
}

async function fetchCryptoCandles(symbol) {
  const data = await safeBinanceGet("/api/v3/klines", {
    symbol,
    interval: "1h",
    limit: 120
  });
  return data
    .map(k => ({ c: +k[4], h: +k[2], v: +k[5] }))
    .filter(x => isFinitePositive(x.c) && isFinitePositive(x.h) && isFinitePositive(x.v));
}

async function fetchStockCandles(symbol) {
  try {
    const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
      params: { range: "3mo", interval: "1d" },
      timeout: 15000
    });
    const result = data?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    if (!result || !quote) return null;
    const closes = quote.close || [];
    const highs = quote.high || [];
    const vols = quote.volume || [];
    return closes.map((c, i) => ({ c: +c, h: +highs[i], v: +(vols[i] || 0) }))
      .filter(x => isFinitePositive(x.c) && isFinitePositive(x.h));
  } catch (e) {
    console.error("STOCK_FETCH_FAIL:", symbol, e.message);
    return null;
  }
}

async function updateBTC() {
  try {
    const data = await safeBinanceGet("/api/v3/klines", { symbol: "BTCUSDT", interval: "4h", limit: 55 });
    const closes = data.map(x => +x[4]).filter(isFinitePositive);
    const e20 = ema(closes.slice(-30), 20);
    const e50 = ema(closes.slice(-50), 50);
    const price = closes.at(-1);
    if (!e20 || !e50 || !price) return btcTrend = "neutral";
    if (price > e20 && e20 > e50) btcTrend = "up";
    else if (price < e20 && e20 < e50) btcTrend = "down";
    else btcTrend = "neutral";
  } catch {
    btcTrend = "neutral";
  }
}

function getCategory(asset, type) {
  if (type === "crypto") return "CRYPTO ALERT";
  if (type === "stock") return "STOCK ALERT";
  return "PORTFOLIO SWAP";
}

function analyseAsset(asset, candles, type = "crypto") {
  if (!candles || candles.length < 50) {
    incReject("shortData");
    return null;
  }
  if (BLOCKED_ASSETS.has(asset)) {
    incReject("blockedAsset");
    return null;
  }

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const vols = candles.map(c => c.v || 0);

  const last = closes.at(-1);
  const prev = closes.at(-2);
  const ema9 = ema(closes.slice(-30), 9);
  const ema21 = ema(closes.slice(-50), 21);
  if (!last || !prev || !ema9 || !ema21) {
    incReject("badEma");
    return null;
  }

  const priorHigh = Math.max(...highs.slice(-21, -1));
  const breakout = last > priorHigh * BREAKOUT_BUFFER;
  const momentum = (last - prev) / prev;
  const avgVol20 = avg(vols.slice(-20)) || 1;
  const volRatio = (vols.at(-1) || 1) / avgVol20;
  const emaBullish = ema9 > ema21;

  if (momentum < MIN_MOMENTUM) {
    incReject("lowMomentum");
    return null;
  }
  if (volRatio < MIN_VOL_RATIO) {
    incReject("lowVolRatio");
    return null;
  }

  let confidence = 50;
  if (emaBullish) confidence += 12;
  if (breakout) confidence += 18;
  if (momentum > 0.0025) confidence += 10;
  if (momentum > 0.0050) confidence += 6;
  if (volRatio > 1.25) confidence += 8;
  if (volRatio > 1.75) confidence += 6;
  if (btcTrend === "up" && type === "crypto") confidence += 8;
  if (btcTrend === "down" && type === "crypto") confidence -= 8;
  confidence = clamp(Math.round(confidence), 0, 99);

  if (confidence < MIN_CONFIDENCE) {
    incReject("lowConfidence");
    return null;
  }

  const feePct = type === "crypto" ? getRevolutFeePct(REVOLUT_PLAN, MONTHLY_VOLUME_GBP) : 0;
  const frictionPct = type === "crypto" ? totalFrictionPct(feePct) : 0.003;
  const minMove = frictionPct + MIN_PROFIT_BUFFER;

  const entry = last;
  const sl = type === "crypto" ? entry * 0.975 : entry * 0.97;
  const tp = entry * (1 + minMove);
  const minStake = type === "crypto" ? minStakeRequired(entry, tp, feePct) : 0;

  if (type === "crypto" && (!Number.isFinite(minStake) || minStake > MAX_MIN_STAKE)) {
    incReject("highMinStake");
    return null;
  }

  lastDebug.passed += 1;

  return {
    asset,
    type,
    category: getCategory(asset, type),
    confidence,
    breakout,
    btcTrend: type === "crypto" ? btcTrend : "n/a",
    entry,
    sl,
    tp,
    volRatio,
    feePct,
    minStake,
    grossMovePct: ((tp - entry) / entry) * 100
  };
}

function hasOpenTrade(asset, trades) {
  return trades.some(t => t.asset === asset && t.status !== "closed");
}

function alertedRecently(asset, alerts) {
  const last = alerts.filter(a => a.asset === asset).sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];
  if (!last) return false;
  return hoursAgo(last.sentAt) < COOLDOWN_HOURS;
}

function broadcastRecently() {
  return minsAgo(lastBroadcastAt || 0) < SIGNAL_BROADCAST_COOLDOWN_MIN;
}

function saveAlertRecord(signal) {
  const alerts = load(ALERTS_FILE);
  alerts.push({
    asset: signal.asset,
    category: signal.category,
    confidence: signal.confidence,
    sentAt: nowIso()
  });
  save(ALERTS_FILE, alerts.slice(-1000));
}

function buildPortfolioSwapSignal(openTrades) {
  if (!ENABLE_PORTFOLIO_SWAPS) return null;
  if (!openTrades.length) return null;
  const weakest = [...openTrades].sort((a, b) => (a.confidence || 0) - (b.confidence || 0))[0];
  if (!weakest) return null;

  return {
    asset: weakest.asset,
    type: "swap",
    category: "PORTFOLIO SWAP",
    confidence: weakest.confidence || 0,
    breakout: false,
    btcTrend,
    entry: weakest.entry,
    sl: weakest.sl,
    tp: weakest.tp,
    volRatio: weakest.volRatio || 0,
    feePct: weakest.feePct || 0,
    minStake: weakest.minStake || 0,
    grossMovePct: weakest.grossMovePct || 0,
    swapHint: `Capital tied up in ${weakest.asset}. Consider keeping current position instead of opening a new one.`
  };
}

async function scanAll() {
  console.log("=== V24.1 SCAN ===");
  lastDebug = {
    scannedCrypto: 0,
    scannedStocks: 0,
    passed: 0,
    rejected: {},
    source: "none",
    btcTrend: "neutral",
    updatedAt: nowIso()
  };

  await updateFX();
  await updateBTC();
  lastDebug.btcTrend = btcTrend;

  const trades = load(TRADES_FILE);
  const openTrades = trades.filter(t => t.status !== "closed");
  const alerts = load(ALERTS_FILE);
  const results = [];

  if (openTrades.length >= MAX_OPEN_TRADES) {
    incReject("maxOpenTrades");
    const swap = buildPortfolioSwapSignal(openTrades);
    if (swap) results.push(swap);
    return results;
  }

  let cryptoPairs = [];
  try {
    cryptoPairs = await getCryptoPairsFromBinance();
    lastDebug.source = "binance";
  } catch {
    cryptoPairs = STATIC_CRYPTO_PAIRS;
    lastDebug.source = "static";
  }

  for (const pair of cryptoPairs) {
    lastDebug.scannedCrypto += 1;
    if (hasOpenTrade(pair, trades)) {
      incReject("alreadyOpen");
      continue;
    }
    if (alertedRecently(pair, alerts)) {
      incReject("cooldown");
      continue;
    }
    const candles = await fetchCryptoCandles(pair);
    const signal = analyseAsset(pair, candles, "crypto");
    if (signal) results.push(signal);
  }

  if (ENABLE_STOCKS) {
    for (const sym of STOCK_POOL) {
      lastDebug.scannedStocks += 1;
      if (hasOpenTrade(sym, trades)) {
        incReject("alreadyOpen");
        continue;
      }
      if (alertedRecently(sym, alerts)) {
        incReject("cooldown");
        continue;
      }
      const candles = await fetchStockCandles(sym);
      const signal = analyseAsset(sym, candles, "stock");
      if (signal) results.push(signal);
    }
  }

  return results.sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, MAX_SIGNALS);
}

async function manageTrades() {
  const trades = load(TRADES_FILE);
  let changed = false;

  for (const t of trades) {
    if (t.status === "closed") continue;
    try {
      let price = null;
      if (t.type === "stock" || /^[A-Z.-]{1,8}$/.test(t.asset)) {
        const candles = await fetchStockCandles(t.asset);
        price = candles?.at(-1)?.c;
      } else {
        const candles = await fetchCryptoCandles(t.asset);
        price = candles?.at(-1)?.c;
      }
      if (!Number.isFinite(price)) continue;

      if (price >= t.tp) {
        t.status = "closed";
        t.exit = price;
        t.pnl = price - t.entry;
        t.closedAt = nowIso();
        changed = true;
        await send(`💰 TP HIT: ${t.asset}`);
      } else if (price <= t.sl) {
        t.status = "closed";
        t.exit = price;
        t.pnl = price - t.entry;
        t.closedAt = nowIso();
        changed = true;
        await send(`❌ SL HIT: ${t.asset}`);
      }
    } catch (e) {
      console.error("MANAGE_ERROR:", t.asset, e.message);
    }
  }

  if (changed) save(TRADES_FILE, trades);
}

async function runCycle() {
  if (running) return;
  running = true;

  try {
    const trades = load(TRADES_FILE);
    const signals = await scanAll();

    console.log("Signals:", signals.length);
    console.log("Rejected:", JSON.stringify(lastDebug.rejected));

    for (const s of signals) {
      if (s.category === "PORTFOLIO SWAP") {
        await send(
`🔄 PORTFOLIO SWAP

${s.swapHint}

Open trades: ${load(TRADES_FILE).filter(t => t.status !== "closed").length}/${MAX_OPEN_TRADES}
BTC Trend: ${s.btcTrend}`
        );
        saveAlertRecord(s);
        lastBroadcastAt = Date.now();
        continue;
      }

      if (hasOpenTrade(s.asset, trades)) continue;
      if (alertedRecently(s.asset, load(ALERTS_FILE))) continue;

      const msg =
`${s.category}

${s.asset}
Confidence: ${s.confidence}
Breakout: ${s.breakout ? "YES" : "NO"}
BTC Trend: ${s.btcTrend}

Entry: ${fmtGBP(toGBP(s.entry))}
SL: ${fmtGBP(toGBP(s.sl))}
TP: ${fmtGBP(toGBP(s.tp))}

Gross move: ${s.grossMovePct.toFixed(2)}%
Vol ratio: ${Number(s.volRatio || 0).toFixed(2)}x` +
(s.type === "crypto" ? `
Min Stake: ${fmtGBP(s.minStake)}`
: `
Asset Type: Equity`);

      await send(msg);

      trades.push({
        ...s,
        status: "open",
        createdAt: nowIso()
      });

      saveAlertRecord(s);
      lastBroadcastAt = Date.now();
    }

    save(TRADES_FILE, trades);
    await manageTrades();
  } catch (e) {
    console.error("RUN_ERROR:", e.message);
  } finally {
    running = false;
  }
}

app.get("/", (_req, res) => res.send("SNIPER V24.1 RUNNING 🚀"));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    time: nowIso(),
    gbp: GBP,
    btcTrend,
    source: lastDebug.source
  });
});

app.get("/stats", (_req, res) => {
  const trades = load(TRADES_FILE);
  const closed = trades.filter(t => t.status === "closed");
  const pnl = closed.reduce((a, t) => a + (t.pnl || 0), 0);

  res.json({
    total: trades.length,
    open: trades.filter(t => t.status !== "closed").length,
    closed: closed.length,
    pnl: pnl.toFixed(6),
    scannedCrypto: lastDebug.scannedCrypto,
    scannedStocks: lastDebug.scannedStocks,
    debug: lastDebug
  });
});

app.get("/trades", (_req, res) => res.json(load(TRADES_FILE)));
app.get("/alerts", (_req, res) => res.json(load(ALERTS_FILE)));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running on port ${PORT}`);
  runCycle();
  setInterval(runCycle, 300000);
});
