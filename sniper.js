// ================================================================
// SNIPER V68 PRODUCTION
// CLEAN MOMENTUM PROFIT MACHINE
//
// V68 PRINCIPLES
// - small liquid universe only
// - 2 setups only:
//     1) PULLBACK_CONTINUATION
//     2) BREAKOUT_CONTINUATION
// - clean execution states:
//     PENDING -> FILLED -> CLOSED / CANCELLED
// - no TP/SL before fill
// - simple fixed-R framework
// - regime + trend + volatility + execution integrity
// ================================================================

console.log("🚀 SNIPER V68 STARTING...");

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

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const FILES = {
  alerts: path.join(DATA_DIR, "alerts.json"),
  trades: path.join(DATA_DIR, "trades.json")
};

// ================================================================
// V68 SETTINGS
// ================================================================

const MAX_SIGNALS = 8;

const CRYPTO_COOLDOWN = 4;
const STOCK_COOLDOWN = 6;

const SCAN_INTERVAL_MS = 300000; // 5 min

const BREAKOUT_LOOKBACK = 10;

const CRYPTO_PULLBACK_VOL = 1.10;
const STOCK_PULLBACK_VOL = 1.00;

const CRYPTO_BREAKOUT_VOL = 1.30;
const STOCK_BREAKOUT_VOL = 1.15;

const EXTENSION_HARD_LIMIT_CRYPTO = 0.12;
const EXTENSION_HARD_LIMIT_STOCK  = 0.10;
const EXTENSION_HARD_LIMIT_LSE    = 0.08;

const MIN_RR = 1.8;
const TARGET_R = 2.0;

const PENDING_EXPIRY_HOURS_CRYPTO = 12;
const PENDING_EXPIRY_HOURS_STOCK = 48;
const PENDING_EXPIRY_HOURS_LSE = 72;

const MAX_MOMENTUM_BAR = 0.12;
const MIN_CANDLES = 60;

// ================================================================
// ENABLES
// ================================================================

const ENABLE_CRYPTO = true;
const ENABLE_US = true;
const ENABLE_LSE = true;

// ================================================================
// V68 UNIVERSE
// ================================================================

const CRYPTO_PAIRS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "LINKUSDT",
  "XRPUSDT",
  "AVAXUSDT",
  "SUIUSDT",
  "NEARUSDT",
  "RENDERUSDT"
];

const STOCK_POOL = [
  "NVDA",
  "AVGO",
  "AMD",
  "TSM",
  "ASML",
  "ANET",
  "VRT",
  "PLTR",
  "CRWD",
  "MSFT",
  "META",
  "AMZN",
  "APP",
  "MSTR",
  "COIN",
  "QQQ",
  "SMH"
];

const LSE_POOL = [
  "RR.L",
  "BA.L",
  "SHEL.L",
  "LSEG.L",
  "BARC.L"
];

// ================================================================
// GLOBAL STATE
// ================================================================

let running = false;
let btcTrend = "neutral";
let qqqTrend = "neutral";
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
  if (!Number.isFinite(value)) return "n/a";
  if (market === "LSE") return `£${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function marketCooldownHours(market) {
  return market === "CRYPTO" ? CRYPTO_COOLDOWN : STOCK_COOLDOWN;
}

function pendingExpiryHours(market) {
  if (market === "CRYPTO") return PENDING_EXPIRY_HOURS_CRYPTO;
  if (market === "LSE") return PENDING_EXPIRY_HOURS_LSE;
  return PENDING_EXPIRY_HOURS_STOCK;
}

function extensionLimitForMarket(market) {
  if (market === "CRYPTO") return EXTENSION_HARD_LIMIT_CRYPTO;
  if (market === "LSE") return EXTENSION_HARD_LIMIT_LSE;
  return EXTENSION_HARD_LIMIT_STOCK;
}

function pullbackVolForMarket(market) {
  return market === "CRYPTO"
    ? CRYPTO_PULLBACK_VOL
    : STOCK_PULLBACK_VOL;
}

function breakoutVolForMarket(market) {
  return market === "CRYPTO"
    ? CRYPTO_BREAKOUT_VOL
    : STOCK_BREAKOUT_VOL;
}

function cooldown(asset, alerts, market) {
  const found = [...alerts].reverse().find(x => x.asset === asset);
  if (!found) return false;
  return hoursAgo(found.sentAt) < marketCooldownHours(market);
}

function dedupeOpenTradeExists(asset, trades) {
  return trades.some(
    t =>
      t.asset === asset &&
      (t.status === "PENDING" || t.status === "FILLED") &&
      t.outcome === "OPEN"
  );
}

// ================================================================
// MARKET HOURS
// ================================================================

function isUSMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;

  const minuteOfDay =
    now.getUTCHours() * 60 + now.getUTCMinutes();

  return minuteOfDay >= 810 && minuteOfDay < 1200;
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
    now.getUTCHours() * 60 + now.getUTCMinutes();

  return minuteOfDay >= 420 && minuteOfDay < 950;
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

⚡ V68 active`);
  }
  if (!usOpen && usMarketState) {
    await send(`🇺🇸 US MARKET CLOSED`);
  }

  if (lseOpen && !lseMarketState) {
    await send(`🇬🇧 LSE OPEN

⚡ V68 active`);
  }
  if (!lseOpen && lseMarketState) {
    await send(`🇬🇧 LSE CLOSED`);
  }

  usMarketState = usOpen;
  lseMarketState = lseOpen;
}

// ================================================================
// DATA FETCH
// ================================================================

async function fetchCrypto(symbol) {
  try {
    const { data } = await axios.get(
      "https://data-api.binance.vision/api/v3/klines",
      {
        params: {
          symbol,
          interval: "1h",
          limit: 120
        }
      }
    );

    return data.map(k => ({
      close: +k[4],
      high: +k[2],
      low: +k[3],
      volume: +k[5]
    }));
  } catch (e) {
    console.log(`CRYPTO ERROR ${symbol}`, e.response?.status || "", e.message);
    return null;
  }
}

async function fetchYahooUS(symbol) {
  try {
    const { data } = await axios.get(
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
        },
        timeout: 12000
      }
    );

    const result = data?.chart?.result?.[0];
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
    console.log(
      `YAHOO ERROR ${symbol}`,
      e.response?.status || "",
      e.response?.data?.chart?.error?.description || e.message
    );
    return null;
  }
}

async function fetchYahooLSE(symbol) {
  try {
    const { data } = await axios.get(
      `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}`,
      {
        params: {
          range: "6mo",
          interval: "1d"
        },
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json",
          "Referer": "https://finance.yahoo.com/"
        },
        timeout: 12000
      }
    );

    const result = data?.chart?.result?.[0];
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
    console.log(
      `YAHOO ERROR ${symbol}`,
      e.response?.status || "",
      e.response?.data?.chart?.error?.description || e.message
    );
    return null;
  }
}

async function fetchLivePrice(asset, market) {
  try {
    if (market === "CRYPTO") {
      const { data } = await axios.get(
        "https://data-api.binance.vision/api/v3/ticker/price",
        { params: { symbol: asset }, timeout: 10000 }
      );
      return +data.price;
    }

    const { data } = await axios.get(
      `https://query2.finance.yahoo.com/v8/finance/chart/${asset}`,
      {
        params: { range: "1d", interval: "1m" },
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json",
          "Referer": "https://finance.yahoo.com/"
        },
        timeout: 10000
      }
    );

    const closes =
      data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;

    if (!closes) return null;

    const valid = closes.filter(Boolean);
    return valid.length ? +valid.at(-1) : null;
  } catch (e) {
    console.log(`LIVE PRICE ERROR ${asset}`, e.response?.status || "", e.message);
    return null;
  }
}

// ================================================================
// REGIME
// ================================================================

async function updateBTCTrend() {
  const candles = await fetchCrypto("BTCUSDT");
  if (!candles) return;

  const closes = candles.map(x => x.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  btcTrend = ema20 > ema50 ? "bullish" : "neutral";
}

async function updateQQQTrend() {
  if (!ENABLE_US || !isUSMarketOpen()) {
    qqqTrend = "neutral";
    return;
  }

  const candles = await fetchYahooUS("QQQ");
  if (!candles) {
    qqqTrend = "neutral";
    return;
  }

  const closes = candles.map(x => x.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  qqqTrend = ema20 > ema50 ? "bullish" : "neutral";
}

function regimePass(market) {
  if (market === "CRYPTO") return btcTrend === "bullish";
  if (market === "US") return qqqTrend === "bullish";
  return true;
}

// ================================================================
// ANALYSIS
// ================================================================

function analyse(asset, candles, market) {
  if (!candles || candles.length < MIN_CANDLES) return null;
  if (!regimePass(market)) return null;

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
  if (momentum <= 0 || momentum > MAX_MOMENTUM_BAR) {
    return null;
  }

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema20Prev = ema(closes.slice(0, -1), 20);

  const strongTrend =
    ema20 > ema50 &&
    last > ema20 &&
    ema20 > ema20Prev;

  if (!strongTrend) return null;

  const avgVol = avg(volumes.slice(-21, -1));
  const currentVol = volumes.at(-1);
  const volRatio = avgVol > 0 ? currentVol / avgVol : 0;

  const extension = (last - ema20) / ema20;
  if (extension > extensionLimitForMarket(market)) {
    return null;
  }

  const breakoutLevel =
    Math.max(...highs.slice(-BREAKOUT_LOOKBACK, -1));

  const breakoutSignal =
    last > breakoutLevel &&
    volRatio >= breakoutVolForMarket(market);

  const nearEMA20 =
    market === "CRYPTO"
      ? Math.abs(last - ema20) / ema20 <= 0.025
      : Math.abs(last - ema20) / ema20 <= 0.02;

  const pulledBackRecently =
    closes.slice(-6, -1).some(c => c <= ema20 * 1.01);

  const pullbackSignal =
    nearEMA20 &&
    pulledBackRecently &&
    volRatio >= pullbackVolForMarket(market);

  if (!pullbackSignal && !breakoutSignal) {
    return null;
  }

  let setupType;
  let entryType;
  let entry;

  if (pullbackSignal && !breakoutSignal) {
    setupType = "PULLBACK_CONTINUATION";
    entryType = "LIMIT BUY";
    entry = ema20 * 1.002;
  } else {
    setupType = "BREAKOUT_CONTINUATION";
    entryType = "STOP BUY";
    entry = breakoutLevel * 1.0015;
  }

  const swingLow =
    Math.min(...lows.slice(-6));

  const sl =
    setupType === "PULLBACK_CONTINUATION"
      ? swingLow * 0.997
      : swingLow * 0.995;

  if (!Number.isFinite(sl) || sl >= entry) {
    return null;
  }

  const riskAmt = entry - sl;
  const riskPct = riskAmt / entry;

  if (riskPct <= 0 || riskPct > 0.12) {
    return null;
  }

  const tp = entry + (riskAmt * TARGET_R);
  const rewardPct = (tp - entry) / entry;
  const rr = +(rewardPct / riskPct).toFixed(1);

  if (rr < MIN_RR) {
    return null;
  }

  let score = 50;
  if (volRatio > 1.3) score += 10;
  if (volRatio > 1.6) score += 5;
  if (momentum > 0.01) score += 8;
  if (setupType === "BREAKOUT_CONTINUATION") score += 10;
  if (setupType === "PULLBACK_CONTINUATION") score += 8;
  if (market === "CRYPTO") score += 5;
  if (market === "US") score += 5;

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
    regime:
      market === "CRYPTO"
        ? btcTrend
        : market === "US"
        ? qqqTrend
        : "local"
  };
}

// ================================================================
// SIGNAL
// ================================================================

async function sendSignal(s) {
  const marketIcon =
    s.market === "CRYPTO"
      ? "🪙"
      : s.market === "US"
      ? "🇺🇸"
      : "🇬🇧";

  await send(
`🚨 ${s.grade}

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
🌍 REGIME ${s.regime}`
  );
}

// ================================================================
// SCAN
// ================================================================

async function scan() {
  const alerts = load(FILES.alerts, []);
  const trades = load(FILES.trades, []);
  const results = [];

  async function processAsset(asset, market, fetcher) {
    if (cooldown(asset, alerts, market)) return;
    if (dedupeOpenTradeExists(asset, trades)) return;

    const candles = await fetcher(asset);
    const signal = analyse(asset, candles, market);

    if (signal) results.push(signal);
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
      entry: s.entry,
      sl: s.sl,
      tp: s.tp,
      rrPlanned: s.rr,
      score: s.score,
      regimeAtEntry: s.regime,
      volRatioAtEntry: s.volRatio,
      sentAt,
      filledAt: null,
      closedAt: null,
      cancelReason: null,
      status: "PENDING",
      outcome: "OPEN",
      fillPrice: null,
      closePrice: null,
      rCaptured: null
    });
  }

  save(FILES.alerts, alerts);
  save(FILES.trades, trades);
}

// ================================================================
// TRADE STATE ENGINE
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

function shouldCancelPending(trade) {
  return hoursAgo(trade.sentAt) >= pendingExpiryHours(trade.market);
}

async function checkOutcomes() {
  const trades = load(FILES.trades, []);
  const active = trades.filter(t => t.outcome === "OPEN");

  if (!active.length) return;

  let updated = false;

  for (const trade of active) {
    try {
      const price = await fetchLivePrice(trade.asset, trade.market);
      if (!price) continue;

      const mktIcon =
        trade.market === "CRYPTO" ? "🪙"
        : trade.market === "US" ? "🇺🇸"
        : "🇬🇧";

      // 1) cancel stale pending trades
      if (trade.status === "PENDING" && shouldCancelPending(trade)) {
        trade.status = "CANCELLED";
        trade.outcome = "CANCELLED";
        trade.closedAt = nowIso();
        trade.cancelReason = "ENTRY_NOT_FILLED_IN_TIME";
        updated = true;

        await send(
`⚪ ENTRY CANCELLED

${mktIcon} ${trade.asset}
🧠 ${trade.setupType}

🎯 Entry never filled in time
🕒 Pending expired`
        );

        continue;
      }

      // 2) fill pending trades
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

🎯 Planned: ${formatPrice(trade.entry, trade.market)}
📍 Fill: ${formatPrice(price, trade.market)}`
          );
        }

        continue;
      }

      // 3) manage only filled trades
      if (trade.status === "FILLED") {
        const riskAmt = trade.entry - trade.sl;

        if (price >= trade.tp) {
          trade.status = "CLOSED";
          trade.outcome = "WIN";
          trade.closedAt = nowIso();
          trade.closePrice = price;
          trade.rCaptured =
            riskAmt > 0
              ? +(((price - trade.entry) / riskAmt)).toFixed(2)
              : null;
          updated = true;

          await send(
`✅ TARGET HIT

${mktIcon} ${trade.asset}
🧠 ${trade.setupType}

🎯 Entry: ${formatPrice(trade.entry, trade.market)}
📍 Fill: ${formatPrice(trade.fillPrice, trade.market)}
💰 Exit: ${formatPrice(price, trade.market)}

🏆 ${trade.rCaptured ?? trade.rrPlanned}R`
          );

        } else if (price <= trade.sl) {
          trade.status = "CLOSED";
          trade.outcome = "LOSS";
          trade.closedAt = nowIso();
          trade.closePrice = price;
          trade.rCaptured =
            riskAmt > 0
              ? +(((price - trade.entry) / riskAmt)).toFixed(2)
              : -1;
          updated = true;

          await send(
`❌ STOPPED OUT

${mktIcon} ${trade.asset}
🧠 ${trade.setupType}

🎯 Entry: ${formatPrice(trade.entry, trade.market)}
📍 Fill: ${formatPrice(trade.fillPrice, trade.market)}
🛑 Exit: ${formatPrice(price, trade.market)}

💥 ${trade.rCaptured}R`
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
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

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

  const cancelled =
    weekTrades.filter(t => t.status === "CANCELLED");

  const winRate =
    closed.length
      ? Math.round((wins.length / closed.length) * 100)
      : 0;

  const avgWinR =
    wins.length
      ? (
          wins.reduce((sum, t) => sum + (+t.rCaptured || 0), 0) /
          wins.length
        ).toFixed(2)
      : "0";

  const avgLossR =
    losses.length
      ? (
          losses.reduce((sum, t) => sum + (+t.rCaptured || 0), 0) /
          losses.length
        ).toFixed(2)
      : "0";

  const expectancy =
    closed.length
      ? (
          wins.reduce((sum, t) => sum + (+t.rCaptured || 0), 0) +
          losses.reduce((sum, t) => sum + (+t.rCaptured || 0), 0)
        ) / closed.length
      : 0;

  await send(
`📊 V68 WEEKLY PERFORMANCE

🔔 Signals: ${weekTrades.length}
✅ Filled: ${filled.length}
🕒 Pending: ${pending.length}
⚪ Cancelled: ${cancelled.length}

🏆 Winners: ${wins.length} (${winRate}%)
❌ Losers: ${losses.length}

📈 Avg Win: ${avgWinR}R
📉 Avg Loss: ${avgLossR}R
🧠 Expectancy: ${expectancy.toFixed(2)}R

₿ BTC regime: ${btcTrend}
📈 QQQ regime: ${qqqTrend}`
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
    await updateQQQTrend();
    await checkOutcomes();

    const signals = await scan();
    console.log(`Signals: ${signals.length}`);

    if (signals.length) {
      await processSignals(signals);
    }

    await weeklyReport();

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
  res.send("SNIPER V68 RUNNING 🚀");
});

// ================================================================
// START
// ================================================================

ensureFiles();

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`API running on ${PORT}`);

  await send(
`🚀 SNIPER V68 LIVE

✅ small liquid universe
✅ 2 setups only
✅ regime filter active
✅ PENDING / FILLED / CLOSED / CANCELLED
✅ no TP/SL before fill
✅ fixed-R framework
✅ expectancy tracking live

🎯 V68 clean momentum machine`
  );

  setTimeout(runCycle, 5000);
  setInterval(runCycle, SCAN_INTERVAL_MS);
});
