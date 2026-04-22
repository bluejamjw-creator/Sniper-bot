// ================================================================
// SNIPER V23
// Adaptive momentum + stake tuning, no-lookahead breakout logic,
// Binance public market-data host, KuCoin fallback, BTC trend backup
// ================================================================

console.log("🚀 SNIPER V23 STARTING...");

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

const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 46);
const MAX_SIGNALS = Number(process.env.MAX_SIGNALS || 3);
const MAX_MIN_STAKE = Number(process.env.MAX_MIN_STAKE || 200);
const MIN_MOMENTUM = Number(process.env.MIN_MOMENTUM || 0.00015);
const MIN_VOL_RATIO = Number(process.env.MIN_VOL_RATIO || 1.0);
const BREAKOUT_BUFFER = Number(process.env.BREAKOUT_BUFFER || 0.995);

const SPREAD_PCT = Number(process.env.SPREAD_PCT || 0.02);
const MIN_PROFIT_GBP = Number(process.env.MIN_PROFIT_GBP || 2);
const MIN_PROFIT_BUFFER = Number(process.env.MIN_PROFIT_BUFFER || 0.04);
const MIN_STAKE_BUFFER_MULT = Number(process.env.MIN_STAKE_BUFFER_MULT || 1.3);

const REVOLUT_PLAN = (process.env.REVOLUT_PLAN || "standard").toLowerCase();
const MONTHLY_VOLUME_GBP = Number(process.env.MONTHLY_VOLUME_GBP || 0);

const STATIC_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT",
  "DOGEUSDT","AVAXUSDT","LINKUSDT","ADAUSDT","NEARUSDT",
  "DOTUSDT","TRXUSDT","APTUSDT","ARBUSDT","OPUSDT",
  "SUIUSDT","INJUSDT","SEIUSDT","ATOMUSDT","AAVEUSDT"
];

const BINANCE_BASES = [
  "https://data-api.binance.vision",
  "https://api.binance.com"
];

let GBP = 0.79;
let btcTrend = "neutral";
let running = false;
let lastDebug = {
  scanned: 0,
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

function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function avg(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function fmtGBP(v) {
  return `£${Number(v).toFixed(2)}`;
}

function isFinitePositive(n) {
  return Number.isFinite(n) && n > 0;
}

function incReject(reason) {
  lastDebug.rejected[reason] = (lastDebug.rejected[reason] || 0) + 1;
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

function totalFrictionPct(feePct) {
  return feePct + feePct + SPREAD_PCT;
}

function realBuy(price, feePct) {
  return price * (1 + feePct + SPREAD_PCT);
}

function realSell(price, feePct) {
  return price * (1 - feePct - SPREAD_PCT);
}

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

async function getPairsFromBinance() {
  const data = await safeBinanceGet("/api/v3/ticker/24hr");
  return data
    .filter(x => x.symbol.endsWith("USDT"))
    .filter(x => parseFloat(x.quoteVolume) > 1000000)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 40)
    .map(x => x.symbol);
}

async function getPairsFromKuCoin() {
  const { data } = await axios.get("https://api.kucoin.com/api/v1/market/allTickers", { timeout: 15000 });
  return (data?.data?.ticker || [])
    .filter(x => x.symbol.endsWith("-USDT"))
    .sort((a, b) => parseFloat(b.volValue || 0) - parseFloat(a.volValue || 0))
    .slice(0, 40)
    .map(x => x.symbol.replace("-", ""));
}

async function getPairs() {
  try {
    lastDebug.source = "binance";
    return await getPairsFromBinance();
  } catch (e) {
    console.error("PAIRS_BINANCE_FAIL:", e.message);
  }
  try {
    lastDebug.source = "kucoin";
    return await getPairsFromKuCoin();
  } catch (e) {
    console.error("PAIRS_KUCOIN_FAIL:", e.message);
  }
  lastDebug.source = "static";
  return STATIC_PAIRS;
}

async function fetchCandlesBinance(symbol) {
  const data = await safeBinanceGet("/api/v3/klines", {
    symbol,
    interval: "1h",
    limit: 120
  });
  return data
    .map(k => ({ c: +k[4], h: +k[2], v: +k[5] }))
    .filter(x => isFinitePositive(x.c) && isFinitePositive(x.h) && isFinitePositive(x.v));
}

async function fetchCandlesKuCoin(symbol) {
  const ku = symbol.replace("USDT", "-USDT");
  const { data } = await axios.get("https://api.kucoin.com/api/v1/market/candles", {
    params: { type: "1hour", symbol: ku },
    timeout: 15000
  });
  return (data?.data || [])
    .map(k => ({ c: +k[2], h: +k[3], v: +k[5] }))
    .reverse()
    .filter(x => isFinitePositive(x.c) && isFinitePositive(x.h) && isFinitePositive(x.v));
}

async function fetchCandles(symbol) {
  try { return await fetchCandlesBinance(symbol); } catch (e) { console.error(`CANDLES_BINANCE_FAIL ${symbol}:`, e.message); }
  try { return await fetchCandlesKuCoin(symbol); } catch (e) { console.error(`CANDLES_KUCOIN_FAIL ${symbol}:`, e.message); }
  return null;
}

async function updateBTC() {
  try {
    const data = await safeBinanceGet("/api/v3/klines", {
      symbol: "BTCUSDT",
      interval: "4h",
      limit: 55
    });
    const closes = data.map(x => +x[4]).filter(isFinitePositive);
    const e20 = ema(closes.slice(-30), 20);
    const e50 = ema(closes.slice(-50), 50);
    const price = closes.at(-1);
    if (!e20 || !e50 || !price) return btcTrend = "neutral";
    if (price > e20 && e20 > e50) btcTrend = "up";
    else if (price < e20 && e20 < e50) btcTrend = "down";
    else btcTrend = "neutral";
  } catch (e) {
    console.error("BTC_PRIMARY_FAIL:", e.message);
    try {
      const { data } = await axios.get("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart", {
        params: { vs_currency: "usd", days: 7 },
        timeout: 15000
      });
      const prices = (data?.prices || []).map(x => x[1]).filter(isFinitePositive);
      if (prices.length < 5) return btcTrend = "neutral";
      const e3 = ema(prices.slice(-5), 3);
      const e5 = ema(prices.slice(-5), 5);
      const last = prices.at(-1);
      if (!e3 || !e5 || !last) btcTrend = "neutral";
      else if (last > e3 && e3 > e5) btcTrend = "up";
      else if (last < e3 && e3 < e5) btcTrend = "down";
      else btcTrend = "neutral";
    } catch (err) {
      console.error("COINGECKO_BTC_ERROR:", err.message);
      btcTrend = "neutral";
    }
  }
}

function analyse(symbol, candles) {
  if (!candles || candles.length < 50) {
    incReject("shortData");
    return null;
  }

  const feePct = getRevolutFeePct(REVOLUT_PLAN, MONTHLY_VOLUME_GBP);
  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const vols = candles.map(c => c.v);

  const last = closes.at(-1);
  const prev = closes.at(-2);
  const ema9 = ema(closes.slice(-30), 9);
  const ema21 = ema(closes.slice(-50), 21);

  if (!last || !prev || !ema9 || !ema21) {
    incReject("badEma");
    return null;
  }

  const emaBullish = ema9 > ema21 * 0.997;
  const priorHigh = Math.max(...highs.slice(-21, -1));
  const breakout = last >= priorHigh * BREAKOUT_BUFFER;

  const momentum = (last - prev) / prev;
  if (momentum < MIN_MOMENTUM) {
    incReject("lowMomentum");
    return null;
  }

  const avgVol = avg(vols.slice(-20));
  const volRatio = avgVol ? vols.at(-1) / avgVol : 1;

  let confidence = 42;
  if (emaBullish) confidence += 12;
  if (breakout) confidence += 14;
  if (momentum > 0.0010) confidence += 8;
  if (momentum > 0.0020) confidence += 8;
  if (volRatio >= MIN_VOL_RATIO) confidence += 8;
  if (btcTrend === "up") confidence += 8;
  if (btcTrend === "down") confidence -= 5;

  confidence = Math.round(clamp(confidence, 0, 99));

  if (confidence < MIN_CONFIDENCE) {
    incReject("lowConfidence");
    return null;
  }

  const feeTier = getRevolutFeePct(REVOLUT_PLAN, MONTHLY_VOLUME_GBP);
  const frictionPct = totalFrictionPct(feeTier);
  const minMove = frictionPct + MIN_PROFIT_BUFFER;

  const entry = last;
  const sl = entry * 0.975;
  const tp = entry * (1 + minMove);

  const minStake = minStakeRequired(entry, tp, feeTier);
  if (!Number.isFinite(minStake) || minStake > MAX_MIN_STAKE) {
    incReject("highMinStake");
    return null;
  }

  const grossMovePct = ((tp - entry) / entry) * 100;
  const effectiveEntry = realBuy(entry, feeTier);
  const effectiveExit = realSell(tp, feeTier);
  const netMovePct = ((effectiveExit - effectiveEntry) / effectiveEntry) * 100;

  lastDebug.passed += 1;

  return {
    asset: symbol,
    entry,
    sl,
    tp,
    confidence,
    minStake,
    grossMovePct,
    netMovePct,
    volRatio,
    btcTrend,
    breakout,
    feePct: feeTier,
    frictionPct
  };
}

async function scan() {
  console.log("=== V23 SCAN ===");
  lastDebug = { scanned: 0, passed: 0, rejected: {}, source: "none", btcTrend: "neutral", updatedAt: new Date().toISOString() };
  await updateFX();
  await updateBTC();
  lastDebug.btcTrend = btcTrend;

  const pairs = await getPairs();
  console.log("Pairs:", pairs.length, "Source:", lastDebug.source, "BTC:", btcTrend);

  const results = [];
  for (const p of pairs) {
    lastDebug.scanned += 1;
    const data = await fetchCandles(p);
    const r = analyse(p, data);
    if (r) results.push(r);
  }

  return results
    .sort((a, b) => b.confidence - a.confidence || a.minStake - b.minStake || b.volRatio - a.volRatio)
    .slice(0, MAX_SIGNALS);
}

async function manageTrades() {
  const trades = load(TRADES_FILE);
  let changed = false;

  for (const t of trades) {
    if (t.status === "closed") continue;
    try {
      const candles = await fetchCandles(t.asset);
      const price = candles?.at(-1)?.c;
      if (!Number.isFinite(price)) continue;

      if (price >= t.tp) {
        t.status = "closed";
        t.exit = price;
        t.pnl = price - t.entry;
        t.closedAt = new Date().toISOString();
        changed = true;
        await send(`💰 TP HIT: ${t.asset}`);
      } else if (price <= t.sl) {
        t.status = "closed";
        t.exit = price;
        t.pnl = price - t.entry;
        t.closedAt = new Date().toISOString();
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
    const signals = await scan();
    const trades = load(TRADES_FILE);

    console.log("Signals:", signals.length);
    console.log("Rejected:", JSON.stringify(lastDebug.rejected));

    for (const s of signals) {
      if (trades.find(t => t.asset === s.asset && t.status !== "closed")) continue;

      trades.push({ ...s, status: "open", createdAt: new Date().toISOString() });

      await send(
`🚨 V23 SIGNAL

${s.asset}
Confidence: ${s.confidence}
BTC Trend: ${s.btcTrend}
Breakout: ${s.breakout ? "YES" : "NO"}

Entry: ${fmtGBP(toGBP(s.entry))}
SL: ${fmtGBP(toGBP(s.sl))}
TP: ${fmtGBP(toGBP(s.tp))}

Gross move: ${s.grossMovePct.toFixed(2)}%
Net move est: ${s.netMovePct.toFixed(2)}%
Vol ratio: ${s.volRatio.toFixed(2)}x
Min Stake: ${fmtGBP(s.minStake)}`
      );
    }

    save(TRADES_FILE, trades);
    await manageTrades();
  } catch (e) {
    console.error("RUN_ERROR:", e.message);
  } finally {
    running = false;
  }
}

app.get("/", (_req, res) => res.send("SNIPER V23 RUNNING 🚀"));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString(), gbp: GBP, btcTrend, source: lastDebug.source });
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
    debug: lastDebug
  });
});

app.get("/trades", (_req, res) => res.json(load(TRADES_FILE)));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running ${PORT}`);
  runCycle();
  setInterval(runCycle, 300000);
});
