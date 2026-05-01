// ================================================================
// SNIPER V67 PRODUCTION
// INSTITUTIONAL MOMENTUM CONTINUATION ENGINE
// CRYPTO + US STOCKS + LSE
//
// V67 FIXES
// - proper trade lifecycle: PENDING -> FILLED -> CLOSED
// - no fake TP/SL before entry fill
// - softer stock filter stack to restore US flow
// - safer HTTP fetch wrapper
// - setup-aware fills and cleaner weekly stats
// ================================================================

console.log("🚀 SNIPER V67 PRODUCTION STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// ================================================================
// CONFIG
// ================================================================

const PORT =
  process.env.PORT || 3000;

const BOT_TOKEN =
  process.env.BOT_TOKEN || "";

const CHAT_ID =
  process.env.CHAT_ID || "";

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const FILES = {
  alerts: path.join(DATA_DIR, "alerts.json"),
  trades: path.join(DATA_DIR, "trades.json")
};

// ================================================================
// SETTINGS
// ================================================================

const MAX_SIGNALS = 12;

const CRYPTO_COOLDOWN = 3;
const STOCK_COOLDOWN = 4;

const MAX_MOMENTUM = 0.18;
const BREAKOUT_THRESHOLD = 0.002;

const CRYPTO_VOL_RATIO_BULL = 1.05;
const CRYPTO_VOL_RATIO_NEUTRAL = 1.12;
const STOCK_MIN_VOL_RATIO = 0.75;

const MIN_RR = 1.2;
const RR_MULTIPLIER = 2.0;
const PARABOLIC_RR_MULTIPLIER = 2.8;

const PARABOLIC_MIN_VOL = 2.0;
const PARABOLIC_MIN_MOMENTUM = 0.03;

const EXTENSION_HARD_LIMIT_CRYPTO = 0.14;
const EXTENSION_HARD_LIMIT_STOCK = 0.12;

const CRYPTO_BREAKOUT_VOL = 1.20;
const CRYPTO_RECLAIM_VOL = 1.05;
const STOCK_BREAKOUT_VOL = 1.00;
const STOCK_RECLAIM_VOL = 0.95;

const RECENT_RUN_MOMENTUM = 0.03;
const RECENT_RUN_BLOCK = 0.10;

const ENABLE_CRYPTO = true;
const ENABLE_US = true;
const ENABLE_LSE = true;

const MAX_OUTCOME_CHECKS_PER_CYCLE = 20;

// ================================================================
// WATCHLISTS
// ================================================================

const CRYPTO_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","LINKUSDT","XRPUSDT",
  "DOGEUSDT","SUIUSDT","TIAUSDT","AVAXUSDT","INJUSDT",
  "JUPUSDT","STXUSDT","POLUSDT","FETUSDT","TAOUSDT",
  "RENDERUSDT","NEARUSDT","ONDOUSDT","LDOUSDT"
];

const STOCK_POOL = [
  "NVDA","AVGO","AMD","MU","TSM","ASML","QCOM","TSEM","MRVL","ARM","CRDO","ALAB",
  "ANET","SMCI","CLS","EQIX",
  "PLTR","CRWD","SNOW","NET",
  "MSFT","AMZN","META","GOOGL","AAPL",
  "GEV","VST","CCJ","NEE","ETN","VRT","CEG",
  "GD","HII","LMT","NOC",
  "JPM","GS",
  "APP","MSTR","COIN","INDA",
  "LLY","NVO",
  "SMH","QQQ","XLK","XLE","IGV"
];

const LSE_POOL = [
  "BA.L","RR.L","NG.L","SSE.L","LSEG.L","EXPN.L",
  "SPX.L","HLMA.L","IMI.L","SMIN.L",
  "SHEL.L","BP.L","GLEN.L","RIO.L",
  "BARC.L","LLOY.L","NWG.L","AZN.L"
];

// ================================================================

let running = false;
let btcTrend = "neutral";
let usMarketState = false;
let lseMarketState = false;

// ================================================================
// HELPERS
// ================================================================

function nowIso() {
  return new Date().toISOString();
}

function ensureFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  for (const file of Object.values(FILES)) {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, "[]");
    }
  }
}

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let out = values[0];
  for (let i = 1; i < values.length; i++) {
    out = values[i] * k + out * (1 - k);
  }
  return out;
}

function hoursAgo(ts) {
  return (Date.now() - new Date(ts).getTime()) / 36e5;
}

function formatPrice(value, market) {
  if (market === "LSE") return `£${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await axios.get(url, options);
    } catch (e) {
      const status = e.response?.status;
      if (status === 429 || status === 403) {
        await sleep(800 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  return null;
}

// ================================================================
// MARKET HOURS
// ================================================================

function isUSMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;

  const minuteOfDay =
    now.getUTCHours() * 60 +
    now.getUTCMinutes();

  return (
    minuteOfDay >= 810 &&
    minuteOfDay < 1200
  );
}

function isLSEOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;

  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const today = `${yyyy}-${mm}-${dd}`;

  const ukBankHolidays = [
    "2026-01-01","2026-04-03","2026-04-06","2026-05-04",
    "2026-05-25","2026-08-31","2026-12-25","2026-12-28",
    "2025-12-25","2025-12-26","2025-01-01","2025-04-18",
    "2025-04-21","2025-05-05","2025-05-26","2025-08-25"
  ];

  if (ukBankHolidays.includes(today)) return false;

  const minuteOfDay =
    now.getUTCHours() * 60 +
    now.getUTCMinutes();

  return (
    minuteOfDay >= 420 &&
    minuteOfDay < 950
  );
}

// ================================================================
// TELEGRAM
// ================================================================

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(msg);
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: msg
      }
    );
  } catch (e) {
    console.log("TELEGRAM ERROR:", e.message);
  }
}

// ================================================================
// MARKET STATUS
// ================================================================

async function marketStatusCheck() {
  const usOpen = isUSMarketOpen();
  const lseOpen = isLSEOpen();

  if (usOpen && !usMarketState) {
    await send(`🇺🇸 US MARKET OPEN

⚡ Momentum scanner active`);
  }

  if (!usOpen && usMarketState) {
    await send(`🇺🇸 US MARKET CLOSED`);
  }

  if (lseOpen && !lseMarketState) {
    await send(`🇬🇧 LSE OPEN

⚡ Momentum scanner active`);
  }

  if (!lseOpen && lseMarketState) {
    await send(`🇬🇧 LSE CLOSED`);
  }

  usMarketState = usOpen;
  lseMarketState = lseOpen;
}

// ================================================================
// FETCHERS
// ================================================================

async function fetchCrypto(symbol) {
  try {
    const res = await fetchWithRetry(
      "https://data-api.binance.vision/api/v3/klines",
      {
        params: {
          symbol,
          interval: "1h",
          limit: 120
        }
      }
    );

    if (!res) return null;

    return res.data.map(k => ({
      close: +k[4],
      high: +k[2],
      low: +k[3],
      volume: +k[5]
    }));
  } catch (e) {
    console.log(`CRYPTO ERROR ${symbol}`, e.message);
    return null;
  }
}

async function fetchYahooUS(symbol) {
  try {
    const res = await fetchWithRetry(
      `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}`,
      {
        params: {
          range: "60d",
          interval: "1h"
        },
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json",
          "Referer": "https://finance.yahoo.com/"
        }
      }
    );

    if (!res) return null;

    const result = res.data?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];

    if (!quote?.close) return null;

    return quote.close
      .map((c, i) => ({
        close: +c,
        high: +quote.high?.[i],
        low: +quote.low?.[i],
        volume: +quote.volume?.[i]
      }))
      .filter(x => Number.isFinite(x.close));
  } catch (e) {
    console.log(`YAHOO ERROR ${symbol}`, e.message);
    return null;
  }
}

async function fetchYahooLSE(symbol) {
  try {
    const res = await fetchWithRetry(
      `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}`,
      {
        params: {
          range: "6mo",
          interval: "1d",
          includePrePost: false,
          events: "div,splits"
        },
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "*/*",
          "Referer": "https://finance.yahoo.com/"
        }
      }
    );

    if (!res) return null;

    const result = res.data?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];

    if (!quote?.close) return null;

    return quote.close
      .map((c, i) => ({
        close: +c,
        high: +quote.high?.[i],
        low: +quote.low?.[i],
        volume: +quote.volume?.[i]
      }))
      .filter(x => Number.isFinite(x.close));
  } catch (e) {
    console.log(`YAHOO ERROR ${symbol}`, e.message);
    return null;
  }
}

async function fetchLivePrice(asset, market) {
  try {
    if (market === "CRYPTO") {
      const res = await fetchWithRetry(
        "https://data-api.binance.vision/api/v3/ticker/price",
        { params: { symbol: asset } }
      );
      return res?.data?.price ? +res.data.price : null;
    }

    const res = await fetchWithRetry(
      `https://query2.finance.yahoo.com/v8/finance/chart/${asset}`,
      {
        params: { range: "1d", interval: "1m" },
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "*/*",
          "Referer": "https://finance.yahoo.com/"
        }
      }
    );

    const closes =
      res?.data?.chart?.result?.[0]
        ?.indicators?.quote?.[0]?.close;

    if (!closes) return null;

    const filtered = closes.filter(Boolean);
    return filtered.length ? +filtered.at(-1) : null;
  } catch (e) {
    console.log(`LIVE PRICE ERROR ${asset}`, e.message);
    return null;
  }
}

// ================================================================
// BTC TREND
// ================================================================

async function updateBTCTrend() {
  const candles = await fetchCrypto("BTCUSDT");
  if (!candles) return;

  const closes = candles.map(x => x.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  btcTrend =
    ema20 > ema50
      ? "bullish"
      : "neutral";
}

// ================================================================
// COOLDOWN
// ================================================================

function cooldown(asset, alerts, market) {
  const found = [...alerts].reverse().find(x => x.asset === asset);
  if (!found) return false;

  const limit =
    market === "CRYPTO"
      ? CRYPTO_COOLDOWN
      : STOCK_COOLDOWN;

  return hoursAgo(found.sentAt) < limit;
}

// ================================================================
// ANALYSIS
// ================================================================

function analyse(asset, candles, market) {
  const minCandles =
    market === "CRYPTO" ? 40 :
    market === "LSE" ? 30 :
    40;

  if (!candles || candles.length < minCandles) {
    return null;
  }

  const closes = candles.map(x => x.close);
  const highs = candles.map(x => x.high);
  const lows = candles.map(x => x.low);
  const volumes = candles.map(x => x.volume || 0);

  const last = closes.at(-1);
  const prev = closes.at(-2);

  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) {
    return null;
  }

  const momentum = (last - prev) / prev;

  if (momentum <= 0 || momentum > MAX_MOMENTUM) {
    return null;
  }

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const strongTrend = ema20 > ema50;

  if (!strongTrend) {
    return null;
  }

  const avgVol = avg(volumes.slice(-21, -1));
  const currentVol = volumes.at(-1);
  const volRatio =
    avgVol > 0
      ? currentVol / avgVol
      : 0;

  if (market === "CRYPTO") {
    const requiredVol =
      btcTrend === "bullish"
        ? CRYPTO_VOL_RATIO_BULL
        : CRYPTO_VOL_RATIO_NEUTRAL;

    if (volRatio < requiredVol) return null;
  } else {
    if (volRatio < STOCK_MIN_VOL_RATIO) return null;
  }

  const breakout =
    Math.max(...highs.slice(-10, -1));

  const breakoutStrength =
    (last - breakout) / breakout;

  const breakoutVolRequired =
    market === "CRYPTO"
      ? CRYPTO_BREAKOUT_VOL
      : STOCK_BREAKOUT_VOL;

  const reclaimVolRequired =
    market === "CRYPTO"
      ? CRYPTO_RECLAIM_VOL
      : STOCK_RECLAIM_VOL;

  const breakoutSignal =
    breakoutStrength > BREAKOUT_THRESHOLD &&
    volRatio >= breakoutVolRequired;

  const reclaim =
    last > ema20 &&
    closes.slice(-5, -1).some(c => c < ema20);

  const recentRun =
    (closes.at(-1) / closes.at(-4)) - 1 > RECENT_RUN_BLOCK;

  const nearEMA20 =
    market === "CRYPTO"
      ? ema20 * 1.06
      : ema20 * 1.04;

  const continuation =
    last > ema20 &&
    last > ema50 &&
    closes.slice(-8, -1).some(c => c < nearEMA20) &&
    !reclaim &&
    !recentRun;

  if (!breakoutSignal && !reclaim && !continuation) {
    return null;
  }

  if (
    (reclaim || continuation) &&
    !breakoutSignal &&
    volRatio < reclaimVolRequired
  ) {
    return null;
  }

  if (
    breakoutSignal &&
    recentRun &&
    momentum > RECENT_RUN_MOMENTUM
  ) {
    return null;
  }

  let setupType =
    reclaim
      ? "RECLAIM"
      : continuation
      ? "CONTINUATION"
      : "BREAKOUT";

  const parabolic =
    momentum > PARABOLIC_MIN_MOMENTUM &&
    volRatio > PARABOLIC_MIN_VOL;

  let entry = last;
  let entryType = "STOP BUY";

  const extension = (last - ema20) / ema20;

  const extensionLimit =
    market === "CRYPTO"
      ? EXTENSION_HARD_LIMIT_CRYPTO
      : EXTENSION_HARD_LIMIT_STOCK;

  if (extension > extensionLimit) {
    return null;
  }

  if (parabolic) {
    entryType = "STOP BUY";
    entry = breakout * 1.003;
  } else if (reclaim) {
    entryType = "LIMIT BUY";
    entry = last * 0.994;
  } else if (continuation) {
    entryType = "LIMIT BUY";
    entry = ema20 * 1.003;
  } else if (breakoutSignal) {
    entryType = "STOP BUY";
    entry = breakout * 1.002;
  }

  const recentLow =
    Math.min(...lows.slice(-6));

  let sl;

  if (setupType === "BREAKOUT" || parabolic) {
    sl = recentLow * 0.994;
  } else if (setupType === "RECLAIM") {
    sl = recentLow * 0.996;
  } else {
    sl = recentLow * 0.997;
  }

  if (sl >= entry) {
    return null;
  }

  const riskAmt = entry - sl;
  const riskPct = riskAmt / entry;

  if (riskPct <= 0 || riskPct > 0.12) {
    return null;
  }

  let tp =
    entry + (riskAmt * RR_MULTIPLIER);

  if (parabolic) {
    tp =
      entry + (riskAmt * PARABOLIC_RR_MULTIPLIER);
  }

  const rewardPct = (tp - entry) / entry;
  const rr = +(rewardPct / riskPct).toFixed(1);

  if (rr < MIN_RR) {
    return null;
  }

  let score = 50;

  if (momentum > 0.01) score += 10;
  if (volRatio > 1.3) score += 8;
  if (breakoutSignal) score += 8;
  if (reclaim) score += 12;
  if (continuation) score += 10;
  if (strongTrend) score += 10;

  let grade = "B";
  if (score >= 90) grade = "A*";
  else if (score >= 75) grade = "A";

  return {
    asset,
    market,
    grade,
    setupType,
    status: parabolic ? "PARABOLIC" : "CONFIRMED",
    entryType,
    entry,
    sl,
    tp,
    rr,
    score,
    momentum,
    volRatio
  };
}

// ================================================================
// SIGNAL MESSAGE
// ================================================================

async function sendSignal(s) {
  const icon =
    s.status === "PARABOLIC"
      ? "🔥"
      : "🚨";

  const marketIcon =
    s.market === "CRYPTO"
      ? "🪙"
      : s.market === "US"
      ? "🇺🇸"
      : "🇬🇧";

  await send(
`${icon} ${s.status} ${s.grade}

${marketIcon} ${s.asset}

🧠 ${s.setupType}
⚡ ${s.entryType}

🎯 ENTRY
${formatPrice(s.entry, s.market)}

🛑 STOP
${formatPrice(s.sl, s.market)}

💰 TARGET
${formatPrice(s.tp, s.market)}

📊 R:R ${s.rr}
📈 ${(s.momentum * 100).toFixed(2)}%
📊 VOL ${s.volRatio.toFixed(2)}x
🧠 SCORE ${s.score}

₿ ${btcTrend}`
  );
}

// ================================================================
// SCAN
// ================================================================

async function scan() {
  const alerts = load(FILES.alerts, []);
  const results = [];

  async function processAsset(asset, market, fetcher) {
    if (cooldown(asset, alerts, market)) return;

    const candles = await fetcher(asset);
    const signal = analyse(asset, candles, market);

    if (signal) {
      results.push(signal);
    }
  }

  if (ENABLE_CRYPTO) {
    for (const pair of CRYPTO_PAIRS) {
      await processAsset(pair, "CRYPTO", fetchCrypto);
    }
  }

  if (ENABLE_US && isUSMarketOpen()) {
    for (const stock of STOCK_POOL) {
      await processAsset(stock, "US", fetchYahooUS);
    }
  }

  if (ENABLE_LSE && isLSEOpen()) {
    for (const stock of LSE_POOL) {
      await processAsset(stock, "LSE", fetchYahooLSE);
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SIGNALS);
}

// ================================================================
// PROCESS SIGNALS
// ================================================================

async function processSignals(signals) {
  const alerts = load(FILES.alerts, []);
  const trades = load(FILES.trades, []);

  for (const s of signals) {
    await sendSignal(s);

    const sentAt = nowIso();

    alerts.push({
      asset: s.asset,
      sentAt
    });

    trades.push({
      id: `${s.asset}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      asset: s.asset,
      market: s.market,
      setupType: s.setupType,
      entryType: s.entryType,
      signalStatus: s.status,
      entry: s.entry,
      sl: s.sl,
      tp: s.tp,
      rr: s.rr,
      score: s.score,
      sentAt,
      status: "PENDING",
      outcome: "OPEN",
      filledAt: null,
      fillPrice: null,
      closedAt: null,
      closePrice: null
    });
  }

  save(FILES.alerts, alerts);
  save(FILES.trades, trades);
}

// ================================================================
// OUTCOME TRACKING
// ================================================================

function shouldFillTrade(trade, price) {
  if (trade.entryType === "LIMIT BUY") {
    return price <= trade.entry;
  }

  if (trade.entryType === "STOP BUY") {
    return price >= trade.entry;
  }

  return false;
}

async function checkOutcomes() {
  const trades = load(FILES.trades, []);

  const openTrades =
    trades.filter(t => t.outcome === "OPEN");

  if (!openTrades.length) return;

  let updated = false;

  for (const trade of openTrades.slice(0, MAX_OUTCOME_CHECKS_PER_CYCLE)) {
    try {
      const price = await fetchLivePrice(trade.asset, trade.market);
      if (!price) continue;

      const mktIcon =
        trade.market === "CRYPTO" ? "🪙"
        : trade.market === "US" ? "🇺🇸"
        : "🇬🇧";

      if (trade.status === "PENDING") {
        if (shouldFillTrade(trade, price)) {
          trade.status = "FILLED";
          trade.filledAt = nowIso();
          trade.fillPrice = price;
          updated = true;

          await send(
`✅ ENTRY FILLED

${mktIcon} ${trade.asset}
🧠 ${trade.setupType}
⚡ ${trade.entryType}

🎯 Entry: ${formatPrice(trade.entry, trade.market)}
📍 Fill: ${formatPrice(price, trade.market)}
📊 R:R ${trade.rr}`
          );
        }

        continue;
      }

      if (trade.status === "FILLED") {
        if (price >= trade.tp) {
          trade.outcome = "WIN";
          trade.status = "CLOSED";
          trade.closedAt = nowIso();
          trade.closePrice = price;
          updated = true;

          await send(
`✅ TARGET HIT

${mktIcon} ${trade.asset}
🧠 ${trade.setupType}

🎯 Entry: ${formatPrice(trade.entry, trade.market)}
📍 Fill: ${formatPrice(trade.fillPrice, trade.market)}
💰 TP hit: ${formatPrice(price, trade.market)}

🏆 +${trade.rr}R captured`
          );

        } else if (price <= trade.sl) {
          trade.outcome = "LOSS";
          trade.status = "CLOSED";
          trade.closedAt = nowIso();
          trade.closePrice = price;
          updated = true;

          await send(
`❌ STOPPED OUT

${mktIcon} ${trade.asset}
🧠 ${trade.setupType}

🎯 Entry: ${formatPrice(trade.entry, trade.market)}
📍 Fill: ${formatPrice(trade.fillPrice, trade.market)}
🛑 SL hit: ${formatPrice(price, trade.market)}

💥 -1R`
          );
        }
      }

    } catch (e) {
      console.log(`OUTCOME CHECK ERROR ${trade.asset}:`, e.message);
    }
  }

  if (updated) {
    save(FILES.trades, trades);
  }
}

// ================================================================
// WEEKLY REPORT
// ================================================================

async function weeklyReport() {
  const now = new Date();

  if (
    now.getUTCDay() !== 1 ||
    now.getUTCHours() !== 7 ||
    now.getUTCMinutes() > 5
  ) {
    return;
  }

  const trades = load(FILES.trades, []);

  const weekAgo =
    Date.now() - 7 * 24 * 60 * 60 * 1000;

  const weekTrades =
    trades.filter(t => new Date(t.sentAt).getTime() > weekAgo);

  const filled =
    weekTrades.filter(t => t.status === "FILLED" || t.status === "CLOSED");

  const closed =
    weekTrades.filter(t => t.outcome === "WIN" || t.outcome === "LOSS");

  const wins =
    closed.filter(t => t.outcome === "WIN");

  const losses =
    closed.filter(t => t.outcome === "LOSS");

  const pending =
    weekTrades.filter(t => t.status === "PENDING");

  const winRate =
    closed.length
      ? Math.round((wins.length / closed.length) * 100)
      : 0;

  const avgRR =
    wins.length
      ? (
          wins.reduce((sum, t) => sum + +t.rr, 0) /
          wins.length
        ).toFixed(1)
      : "0";

  const bestTrade =
    wins.sort((a, b) => +b.rr - +a.rr)[0];

  await send(
`📊 WEEKLY PERFORMANCE

🔔 Signals: ${weekTrades.length}
✅ Filled: ${filled.length}
🕒 Pending: ${pending.length}

🏆 Winners: ${wins.length} (${winRate}%)
❌ Losers: ${losses.length}

📈 Avg RR captured: ${avgRR}R
${bestTrade ? `🥇 Best: ${bestTrade.asset} +${bestTrade.rr}R` : ""}

₿ ${btcTrend}`
  );
}

// ================================================================
// MAIN LOOP
// ================================================================

async function runCycle() {
  if (running) return;
  running = true;

  try {
    ensureFiles();

    await marketStatusCheck();
    await updateBTCTrend();
    await checkOutcomes();
    await weeklyReport();

    const signals = await scan();
    console.log(`Signals: ${signals.length}`);

    if (signals.length) {
      await processSignals(signals);
    }
  } catch (e) {
    console.log("RUN ERROR:", e.stack || e.message);
  } finally {
    running = false;
  }
}

// ================================================================
// API
// ================================================================

app.get("/", (_req, res) => {
  res.send("SNIPER V67 PRODUCTION RUNNING 🚀");
});

// ================================================================
// START
// ================================================================

ensureFiles();

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`API running on ${PORT}`);

  await send(
`🚀 SNIPER V67 PRODUCTION LIVE

✅ proper trade lifecycle: PENDING -> FILLED -> CLOSED
✅ no TP/SL before entry fill
✅ softer US stock filters
✅ dynamic RR targets retained
✅ continuation / reclaim / breakout / parabolic active
✅ weekly report counts real filled trades
✅ crypto + US + LSE enabled
✅ outcome tracking active

🎯 V67 — safer execution logic live`
  );

  setTimeout(runCycle, 5000);
  setInterval(runCycle, 300000);
});
