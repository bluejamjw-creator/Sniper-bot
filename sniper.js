// ================================================================
// SNIPER V75
// Relaxed filter version
// ================================================================

console.log("SNIPER V75 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  res.status(200).send("SNIPER V75 alive");
});

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const supabaseEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

const FILES = {
  alerts: path.join(DATA_DIR, "alerts.json"),
  trades: path.join(DATA_DIR, "trades.json")
};

const MAX_ALERT_ROWS = 500;
const MAX_TRADE_ROWS = 500;

const ACCOUNT_BALANCE = 10000;
const BASE_RISK_PER_TRADE = 0.01;
const MAX_PORTFOLIO_RISK = 0.05;

const ENABLE_CRYPTO = true;
const ENABLE_US = true;
const ENABLE_LSE = true;

const SCAN_INTERVAL_MS = 300000;
const MAX_CONCURRENT_REQUESTS = 4;

const CRYPTO_COOLDOWN = 2;
const STOCK_COOLDOWN = 4;
const LSE_COOLDOWN = 6;

const BREAKOUT_LOOKBACK = 10;
const BREAKOUT_MAX_DISTANCE_CRYPTO = 0.015;
const BREAKOUT_MAX_DISTANCE_STOCK = 0.02;
const BREAKOUT_MAX_DISTANCE_LSE = 0.025;

const CRYPTO_PULLBACK_VOL = 1.10;
const STOCK_PULLBACK_VOL = 1.15;
const LSE_PULLBACK_VOL = 1.05;

const CRYPTO_BREAKOUT_VOL = 1.30;
const STOCK_BREAKOUT_VOL = 1.15;
const LSE_BREAKOUT_VOL = 1.10;

const STOCK_MOMENTUM_OVERRIDE_ENABLED = true;
const STOCK_OVERRIDE_MIN_MOMENTUM = 0.01;
const STOCK_OVERRIDE_MIN_VOL = 1.20;
const STOCK_OVERRIDE_MAX_DISTANCE = 0.02;

const EXTENSION_HARD_LIMIT_CRYPTO = 0.12;
const EXTENSION_HARD_LIMIT_STOCK = 0.10;
const EXTENSION_HARD_LIMIT_LSE = 0.08;

const MIN_RR = 1.5;
const TARGET_R = 1.5;
const MIN_GLOBAL_SCORE = 70;

const PENDING_EXPIRY_HOURS_CRYPTO = 4;
const PENDING_EXPIRY_HOURS_STOCK = 12;
const PENDING_EXPIRY_HOURS_LSE = 24;

const MAX_MOMENTUM_BAR_CRYPTO = 0.12;
const MAX_MOMENTUM_BAR_STOCK = 0.05;
const MAX_MOMENTUM_BAR_LSE = 0.035;
const MIN_CANDLES = 60;

const ATR_PERIOD = 14;
const ATR_PULLBACK_MULTIPLIER = 1.2;
const ATR_BREAKOUT_MULTIPLIER = 1.5;

const CRYPTO_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","LINKUSDT",
  "AVAXUSDT","SUIUSDT","NEARUSDT","RENDERUSDT",
  "TONUSDT","ONDOUSDT"
];

const STOCK_POOL = [
  "GEV","AVAV","IONQ","ASTS","NVDA","AVGO","VRT",
  "AMAT","KLAC","LRCX","ETN","DOV","CIEN","COHR","PLTR",
  "AMD","TSM","ASML","ANET","CRWD","MSFT","META","AMZN","APP","MSTR","COIN","QQQ","SMH"
];

const LSE_POOL = [
  "RR.LON","BA.LON","SHEL.LON","LSEG.LON","BARC.LON"
];

const MAX_POSITIONS = {
  CRYPTO: 1,
  US: 1,
  LSE: 1
};

let running = false;
let btcTrend = "neutral";
let qqqTrend = "neutral";

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function saveLocal(file, data) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
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

async function loadAlerts() {
  if (!supabaseEnabled) return loadLocal(FILES.alerts, []);
  try {
    const { data, error } = await retry(() =>
      supabase.from("alerts").select("*").order("sentAt", { ascending: false }).limit(MAX_ALERT_ROWS)
    );
    if (error) throw error;
    return data || [];
  } catch {
    return loadLocal(FILES.alerts, []);
  }
}

async function loadTrades() {
  if (!supabaseEnabled) return loadLocal(FILES.trades, []);
  try {
    const { data, error } = await retry(() =>
      supabase.from("trades").select("*").order("sentAt", { ascending: false }).limit(MAX_TRADE_ROWS)
    );
    if (error) throw error;
    return data || [];
  } catch {
    return loadLocal(FILES.trades, []);
  }
}

async function saveAlerts(alerts) {
  if (!supabaseEnabled) return saveLocal(FILES.alerts, alerts);
  try {
    const { error } = await retry(() => supabase.from("alerts").upsert(alerts, { onConflict: "id" }));
    if (error) throw error;
    saveLocal(FILES.alerts, alerts);
  } catch {
    saveLocal(FILES.alerts, alerts);
  }
}

async function saveTrades(trades) {
  if (!supabaseEnabled) return saveLocal(FILES.trades, trades);
  try {
    const { error } = await retry(() => supabase.from("trades").upsert(trades, { onConflict: "id" }));
    if (error) throw error;
    saveLocal(FILES.trades, trades);
  } catch {
    saveLocal(FILES.trades, trades);
  }
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
  return (Date.now() - new Date(ts).getTime()) / 36e5;
}

function formatPrice(value, market) {
  if (!Number.isFinite(value)) return "n/a";
  if (market === "LSE") return `£${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function marketCooldownHours(market) {
  if (market === "CRYPTO") return CRYPTO_COOLDOWN;
  if (market === "LSE") return LSE_COOLDOWN;
  return STOCK_COOLDOWN;
}

function breakoutDistanceLimitForMarket(market) {
  if (market === "CRYPTO") return BREAKOUT_MAX_DISTANCE_CRYPTO;
  if (market === "LSE") return BREAKOUT_MAX_DISTANCE_LSE;
  return BREAKOUT_MAX_DISTANCE_STOCK;
}

function breakoutVolForMarket(market) {
  if (market === "CRYPTO") return CRYPTO_BREAKOUT_VOL;
  if (market === "LSE") return LSE_BREAKOUT_VOL;
  return STOCK_BREAKOUT_VOL;
}

function pullbackVolForMarket(market) {
  if (market === "CRYPTO") return CRYPTO_PULLBACK_VOL;
  if (market === "LSE") return LSE_PULLBACK_VOL;
  return STOCK_PULLBACK_VOL;
}

function extensionLimitForMarket(market) {
  if (market === "CRYPTO") return EXTENSION_HARD_LIMIT_CRYPTO;
  if (market === "LSE") return EXTENSION_HARD_LIMIT_LSE;
  return EXTENSION_HARD_LIMIT_STOCK;
}

function maxMomentumBarForMarket(market) {
  if (market === "CRYPTO") return MAX_MOMENTUM_BAR_CRYPTO;
  if (market === "LSE") return MAX_MOMENTUM_BAR_LSE;
  return MAX_MOMENTUM_BAR_STOCK;
}

function classifyRegime(ema20, ema50, price) {
  if (!Number.isFinite(ema20) || !Number.isFinite(ema50) || !Number.isFinite(price) || ema50 === 0) return "neutral";
  const spread = (ema20 - ema50) / ema50;
  if (ema20 > ema50 && price > ema20) return spread >= 0.02 ? "strong_bull" : "bull";
  if (spread <= -0.02) return "risk_off";
  return "neutral";
}

function regimePass(market) {
  if (market === "CRYPTO") return btcTrend === "bull" || btcTrend === "strong_bull";
  if (market === "US") return qqqTrend === "bull" || qqqTrend === "strong_bull";
  return true;
}

function calculateATR(candles, period = ATR_PERIOD) {
  if (!candles || candles.length < period + 1) return null;
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
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

function cooldown(asset, alerts, market) {
  const found = [...alerts].reverse().find(x => x.asset === asset);
  if (!found) return false;
  return hoursAgo(found.sentAt) < marketCooldownHours(market);
}

function dedupeOpenTradeExists(asset, trades) {
  return trades.some(t => t.asset === asset && t.status === "FILLED" && t.outcome === "OPEN");
}

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) return console.log(msg);
  try {
    await retry(() =>
      axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID,
        text: msg,
        parse_mode: "HTML"
      }, { timeout: 10000 })
    );
  } catch (e) {
    console.log("TELEGRAM ERROR:", e.message);
  }
}

async function fetchCrypto(symbol) {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/klines", {
        params: { symbol, interval: "1h", limit: 120 },
        timeout: 12000
      })
    );
    return data.map(k => ({ close: +k[4], high: +k[2], low: +k[3], volume: +k[5] }));
  } catch {
    return null;
  }
}

async function fetchTwelveSeries(symbol, interval = "1h", outputsize = 120) {
  if (!TWELVE_DATA_API_KEY) return null;
  try {
    const { data } = await retry(() =>
      axios.get("https://api.twelvedata.com/time_series", {
        params: { symbol, interval, outputsize, order: "ASC", apikey: TWELVE_DATA_API_KEY },
        timeout: 15000
      })
    );
    if (data?.status === "error" || !Array.isArray(data?.values)) return null;
    return data.values.map(row => ({
      close: +row.close,
      high: +row.high,
      low: +row.low,
      volume: +row.volume
    })).filter(x => Number.isFinite(x.close) && Number.isFinite(x.high) && Number.isFinite(x.low));
  } catch {
    return null;
  }
}

async function fetchUSData(symbol) {
  return fetchTwelveSeries(symbol, "1h", 120);
}

async function fetchLSEData(symbol) {
  return fetchTwelveSeries(symbol, "1h", 120);
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
    const { data } = await retry(() =>
      axios.get("https://api.twelvedata.com/price", {
        params: { symbol: asset, apikey: TWELVE_DATA_API_KEY },
        timeout: 12000
      })
    );
    if (data?.status === "error") return null;
    return +data.price;
  } catch {
    return null;
  }
}

async function updateBTCTrend() {
  const candles = await fetchCrypto("BTCUSDT");
  if (!candles) return;
  const closes = candles.map(x => x.close);
  btcTrend = classifyRegime(ema(closes, 20), ema(closes, 50), closes.at(-1));
}

async function updateQQQTrend() {
  const candles = await fetchUSData("QQQ");
  if (!candles) {
    qqqTrend = "neutral";
    return;
  }
  const closes = candles.map(x => x.close);
  qqqTrend = classifyRegime(ema(closes, 20), ema(closes, 50), closes.at(-1));
}

function analyse(asset, candles, market) {
  if (!candles || candles.length < MIN_CANDLES || !regimePass(market)) return null;

  const closes = candles.map(x => x.close);
  const highs = candles.map(x => x.high);
  const lows = candles.map(x => x.low);
  const volumes = candles.map(x => x.volume || 0);

  const last = closes.at(-1);
  const prev = closes.at(-2);
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) return null;

  const momentum = (last - prev) / prev;
  if (momentum <= 0 || momentum > maxMomentumBarForMarket(market)) return null;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema20Prev = ema(closes.slice(0, -1), 20);
  if (!(ema20 > ema50 && last > ema20 && ema20 > ema20Prev)) return null;

  const avgVol = avg(volumes.slice(-21, -1));
  const currentVol = volumes.at(-1);
  const volRatio = avgVol > 0 ? currentVol / avgVol : 0;

  const extension = (last - ema20) / ema20;
  if (extension > extensionLimitForMarket(market)) return null;

  const breakoutLevel = Math.max(...highs.slice(-BREAKOUT_LOOKBACK, -1));
  const breakoutDistance = breakoutLevel > 0 ? (last - breakoutLevel) / breakoutLevel : 0;

  const strongMomentumOverride =
    market === "US" &&
    STOCK_MOMENTUM_OVERRIDE_ENABLED &&
    momentum > STOCK_OVERRIDE_MIN_MOMENTUM &&
    volRatio > STOCK_OVERRIDE_MIN_VOL &&
    breakoutDistance <= STOCK_OVERRIDE_MAX_DISTANCE;

  const breakoutSignal =
    last > breakoutLevel &&
    breakoutDistance <= breakoutDistanceLimitForMarket(market) &&
    volRatio >= breakoutVolForMarket(market);

  const nearEMA20 = market === "CRYPTO"
    ? Math.abs(last - ema20) / ema20 <= 0.025
    : market === "LSE"
      ? Math.abs(last - ema20) / ema20 <= 0.025
      : Math.abs(last - ema20) / ema20 <= 0.02;

  const pulledBackRecently = closes.slice(-6, -1).some(c => c <= ema20 * 1.01);
  const pullbackSignal = nearEMA20 && pulledBackRecently && volRatio >= pullbackVolForMarket(market);

  if (!pullbackSignal && !breakoutSignal && !strongMomentumOverride) return null;

  let setupType = pullbackSignal && !breakoutSignal
    ? "PULLBACK_CONTINUATION"
    : strongMomentumOverride
      ? "MOMENTUM_BREAKOUT"
      : "BREAKOUT_CONTINUATION";

  if (setupType === "PULLBACK_CONTINUATION" && momentum < (market === "LSE" ? 0.005 : 0.008)) return null;

  let entryType = setupType === "PULLBACK_CONTINUATION" ? "LIMIT BUY" : "STOP BUY";
  let entry = setupType === "PULLBACK_CONTINUATION" ? ema20 * 1.002 : breakoutLevel * 1.0015;

  if (pullbackSignal && momentum > 0.01 && volRatio > 1.2 && market !== "LSE") {
    setupType = "MOMENTUM_CONTINUATION";
    entryType = "MARKET BUY";
    entry = last;
  }

  const atr = calculateATR(candles, ATR_PERIOD);
  if (!atr || atr <= 0) return null;

  const swingLow = Math.min(...lows.slice(-6));
  const sl = setupType === "PULLBACK_CONTINUATION"
    ? Math.min(swingLow - atr * ATR_PULLBACK_MULTIPLIER, entry - atr * ATR_PULLBACK_MULTIPLIER)
    : Math.min(swingLow - atr * ATR_BREAKOUT_MULTIPLIER, entry - atr * ATR_BREAKOUT_MULTIPLIER);

  if (!Number.isFinite(sl) || sl >= entry) return null;

  const riskAmt = entry - sl;
  const riskPct = riskAmt / entry;
  if (riskPct <= 0 || riskPct > 0.12) return null;

  const tp = entry + riskAmt * TARGET_R;
  const rr = +((((tp - entry) / entry) / riskPct).toFixed(1));
  if (rr < MIN_RR) return null;

  let score = 50;
  if (volRatio > 1.2) score += 8;
  if (volRatio > 1.5) score += 4;
  if (momentum > 0.01) score += 8;
  if (setupType === "BREAKOUT_CONTINUATION") score += 10;
  if (setupType === "PULLBACK_CONTINUATION") score += 8;
  if (setupType === "MOMENTUM_BREAKOUT") score += 14;
  if (setupType === "MOMENTUM_CONTINUATION") score += 14;
  if (market === "CRYPTO") score += 5;
  if (market === "US") score += 5;
  if (market === "LSE") score += 2;
  if (market === "CRYPTO" && btcTrend === "strong_bull") score += 5;
  if (market === "US" && qqqTrend === "strong_bull") score += 5;

  let grade = "B";
  if (score >= 85) grade = "A*";
  else if (score >= 72) grade = "A";

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

function calculatePositionSize(signal) {
  const riskAmount = ACCOUNT_BALANCE * BASE_RISK_PER_TRADE;
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

async function scan() {
  const alerts = await loadAlerts();
  const trades = await loadTrades();
  const results = [];

  async function processAsset(asset, market, fetcher) {
    if (cooldown(asset, alerts, market)) return;
    if (dedupeOpenTradeExists(asset, trades)) return;
    const candles = await fetcher(asset);
    const signal = analyse(asset, candles, market);
    if (signal) results.push(signal);
  }

  if (ENABLE_CRYPTO) {
    await mapWithConcurrency(CRYPTO_PAIRS, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset, "CRYPTO", fetchCrypto));
  }

  if (ENABLE_US) {
    await mapWithConcurrency(STOCK_POOL, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset, "US", fetchUSData));
  }

  if (ENABLE_LSE) {
    await mapWithConcurrency(LSE_POOL, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset, "LSE", fetchLSEData));
  }

  return pickBestPerMarket(results.filter(r => r.score >= MIN_GLOBAL_SCORE));
}

async function processSignals(signals) {
  const alerts = await loadAlerts();
  const trades = await loadTrades();

  for (const s of signals) {
    const minScore =
      s.market === "CRYPTO"
        ? (btcTrend === "strong_bull" ? 70 : 75)
        : s.market === "LSE"
          ? 70
          : 74;

    if (s.score < minScore) continue;

    const size = calculatePositionSize(s);
    const sentAt = nowIso();

    await send(`🚨 ${s.grade}

${s.market} ${s.asset}
${s.setupType}
${s.entryType}

ENTRY ${formatPrice(s.entry, s.market)}
STOP ${formatPrice(s.sl, s.market)}
TARGET ${formatPrice(s.tp, s.market)}

R:R ${s.rr}
VOL ${s.volRatio.toFixed(2)}x
SCORE ${s.score}
SIZE ${size.toFixed(2)}`);

    alerts.push({
      id: `${s.asset}-${sentAt}`,
      asset: s.asset,
      sentAt
    });

    trades.push({
      id: `${s.asset}-${Date.now()}`,
      asset: s.asset,
      market: s.market,
      setupType: s.setupType,
      entryType: s.entryType,
      entry: s.entry,
      sl: s.sl,
      tp: s.tp,
      rrPlanned: s.rr,
      score: s.score,
      sentAt,
      status: "PENDING",
      outcome: "OPEN",
      fillPrice: null,
      closePrice: null
    });
  }

  await saveAlerts(alerts);
  await saveTrades(trades);
}

async function runCycle() {
  if (running) return;
  running = true;

  try {
    ensureFiles();
    await updateBTCTrend();
    await updateQQQTrend();
    const signals = await scan();

    if (signals.length) {
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

ensureFiles();

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Health server on ${PORT}`);
  await send("SNIPER V75 LIVE — RELAXED FILTER MODE");
  await runCycle();

  setInterval(async () => {
    if (!running) await runCycle();
  }, SCAN_INTERVAL_MS);
});
