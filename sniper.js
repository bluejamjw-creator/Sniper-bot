// ================================================================
// SNIPER V25
// Cleaner alerts
// Better breakout filtering
// Reduced fakeouts
// Crypto + Stocks
// ================================================================

console.log("🚀 SNIPER V25 STARTING...");

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

const DATA_DIR = "./data";

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const TRADES_FILE = path.join(DATA_DIR, "trades.json");
const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");

// ================================================================
// SETTINGS
// ================================================================

const MIN_CONFIDENCE = 84;

const MAX_SIGNALS = 3;
const MAX_OPEN_TRADES = 3;

const COOLDOWN_HOURS = 24;

const MIN_MOMENTUM = 0.003;
const MAX_MOMENTUM = 0.08;

const MIN_VOL_RATIO = 1.35;

const BREAKOUT_BUFFER = 1.002;

const MAX_MIN_STAKE = 120;
const MIN_PROFIT_GBP = 3;

const ENABLE_STOCKS = true;

// ================================================================
// POOLS
// ================================================================

const STOCK_POOL = [
  "AAPL","MSFT","NVDA","TSLA","AMD",
  "META","GOOG","AMZN","PLTR","COIN",
  "MSTR","SMCI","NFLX","CRM","ADBE",
  "INTC","BA","DIS","PYPL","UBER",
  "SHOP","ROKU","SNOW"
];

const CRYPTO_PAIRS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "SUIUSDT",
  "INJUSDT",
  "AAVEUSDT",
  "SEIUSDT",
  "PEPEUSDT"
];

// ================================================================
// STATE
// ================================================================

let running = false;

let btcTrend = "neutral";

let GBP = 0.79;

// ================================================================
// HELPERS
// ================================================================

function nowIso() {
  return new Date().toISOString();
}

function load(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function fmtGBP(v) {
  return `£${Number(v).toFixed(2)}`;
}

function fmtUSD(v) {
  return `$${Number(v).toFixed(2)}`;
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(values, period) {
  const k = 2 / (period + 1);

  let ema = values[0];

  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

function hoursAgo(ts) {
  return (Date.now() - new Date(ts).getTime()) / 36e5;
}

// ================================================================
// TELEGRAM
// ================================================================

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: msg
      }
    );
  } catch (e) {
    console.error("TELEGRAM ERROR:", e.message);
  }
}

// ================================================================
// FX
// ================================================================

async function updateFX() {
  try {
    const { data } = await axios.get(
      "https://open.er-api.com/v6/latest/USD"
    );

    if (data?.rates?.GBP) {
      GBP = data.rates.GBP;
    }
  } catch {}
}

function toGBP(v) {
  return v * GBP;
}

// ================================================================
// FETCH CRYPTO
// ================================================================

async function fetchCrypto(symbol) {

  const { data } = await axios.get(
    "https://api.binance.com/api/v3/klines",
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
    volume: +k[5]
  }));
}

// ================================================================
// FETCH STOCK
// ================================================================

async function fetchStock(symbol) {

  try {

    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,
      {
        params: {
          range: "3mo",
          interval: "1d"
        }
      }
    );

    const result = data.chart.result[0];

    const quote = result.indicators.quote[0];

    return quote.close.map((c, i) => ({
      close: +c,
      high: +quote.high[i],
      volume: +(quote.volume[i] || 0)
    }))
    .filter(x => x.close);

  } catch {

    return null;

  }

}

// ================================================================
// BTC TREND
// ================================================================

async function updateBTCTrend() {

  try {

    const candles = await fetchCrypto("BTCUSDT");

    const closes = candles.map(c => c.close);

    const ema20 = ema(closes.slice(-30), 20);

    const ema50 = ema(closes.slice(-60), 50);

    const price = closes.at(-1);

    if (price > ema20 && ema20 > ema50) {
      btcTrend = "bullish";
    }
    else {
      btcTrend = "neutral";
    }

  } catch {

    btcTrend = "neutral";

  }

}

// ================================================================
// ANALYSE
// ================================================================

function analyse(asset, candles, type) {

  if (!candles || candles.length < 50) {
    return null;
  }

  const closes = candles.map(c => c.close);

  const highs = candles.map(c => c.high);

  const vols = candles.map(c => c.volume);

  const last = closes.at(-1);

  const prev = closes.at(-2);

  const ema9 = ema(closes.slice(-30), 9);

  const ema21 = ema(closes.slice(-50), 21);

  const momentum = (last - prev) / prev;

  if (momentum < MIN_MOMENTUM) {
    return null;
  }

  if (momentum > MAX_MOMENTUM) {
    return null;
  }

  const priorHigh = Math.max(...highs.slice(-20, -1));

  const breakout = last > priorHigh * BREAKOUT_BUFFER;

  if (!breakout) {
    return null;
  }

  const avgVol = avg(vols.slice(-20));

  const volRatio = vols.at(-1) / avgVol;

  if (volRatio < MIN_VOL_RATIO) {
    return null;
  }

  if (last > ema9 * 1.05) {
    return null;
  }

  let confidence = 50;

  if (ema9 > ema21) confidence += 15;

  if (breakout) confidence += 20;

  if (volRatio > 1.5) confidence += 10;

  if (momentum > 0.01) confidence += 10;

  if (type === "crypto" && btcTrend === "bullish") {
    confidence += 10;
  }

  confidence = Math.min(confidence, 99);

  if (confidence < MIN_CONFIDENCE) {
    return null;
  }

  const stopPct =
    type === "crypto"
      ? 0.035
      : 0.04;

  const takePct =
    type === "crypto"
      ? 0.10
      : 0.088;

  const entry = last;

  const sl = entry * (1 - stopPct);

  const tp = entry * (1 + takePct);

  const riskReward =
    (tp - entry) /
    (entry - sl);

  const minStake =
    type === "crypto"
      ? MIN_PROFIT_GBP / takePct
      : 0;

  if (type === "crypto" && minStake > MAX_MIN_STAKE) {
    return null;
  }

  return {
    asset,
    type,
    confidence,
    breakout,
    entry,
    sl,
    tp,
    volRatio,
    minStake,
    riskReward
  };

}

// ================================================================
// ALERT FILTERS
// ================================================================

function hasOpenTrade(asset, trades) {

  return trades.some(
    t =>
      t.asset === asset &&
      t.status === "open"
  );

}

function alertedRecently(asset, alerts) {

  const found =
    alerts.find(a => a.asset === asset);

  if (!found) return false;

  return hoursAgo(found.sentAt) < COOLDOWN_HOURS;

}

// ================================================================
// MAIN SCAN
// ================================================================

async function scan() {

  const trades = load(TRADES_FILE);

  const alerts = load(ALERTS_FILE);

  const results = [];

  if (
    trades.filter(t => t.status === "open").length
    >= MAX_OPEN_TRADES
  ) {
    return [];
  }

  // ============================================================
  // CRYPTO
  // ============================================================

  for (const pair of CRYPTO_PAIRS) {

    if (hasOpenTrade(pair, trades)) {
      continue;
    }

    if (alertedRecently(pair, alerts)) {
      continue;
    }

    try {

      const candles = await fetchCrypto(pair);

      const signal =
        analyse(pair, candles, "crypto");

      if (signal) {
        results.push(signal);
      }

    } catch {}

  }

  // ============================================================
  // STOCKS
  // ============================================================

  if (ENABLE_STOCKS) {

    for (const stock of STOCK_POOL) {

      if (hasOpenTrade(stock, trades)) {
        continue;
      }

      if (alertedRecently(stock, alerts)) {
        continue;
      }

      try {

        const candles =
          await fetchStock(stock);

        const signal =
          analyse(stock, candles, "stock");

        if (signal) {
          results.push(signal);
        }

      } catch {}

    }

  }

  return results
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_SIGNALS);

}

// ================================================================
// MANAGE TRADES
// ================================================================

async function manageTrades() {

  const trades = load(TRADES_FILE);

  let changed = false;

  for (const t of trades) {

    if (t.status !== "open") {
      continue;
    }

    try {

      let candles;

      if (t.type === "crypto") {
        candles = await fetchCrypto(t.asset);
      } else {
        candles = await fetchStock(t.asset);
      }

      const price = candles.at(-1).close;

      if (price >= t.tp) {

        t.status = "closed";

        t.result = "TP";

        t.closedAt = nowIso();

        changed = true;

        await send(
          `💰 TP HIT\n\n${t.asset}`
        );

      }

      else if (price <= t.sl) {

        t.status = "closed";

        t.result = "SL";

        t.closedAt = nowIso();

        changed = true;

        await send(
          `❌ SL HIT\n\n${t.asset}`
        );

      }

    } catch {}

  }

  if (changed) {
    save(TRADES_FILE, trades);
  }

}

// ================================================================
// RUN
// ================================================================

async function runCycle() {

  if (running) return;

  running = true;

  try {

    await updateFX();

    await updateBTCTrend();

    const trades = load(TRADES_FILE);

    const alerts = load(ALERTS_FILE);

    const signals = await scan();

    console.log("Signals:", signals.length);

    for (const s of signals) {

      const entry =
        s.type === "crypto"
          ? fmtGBP(toGBP(s.entry))
          : fmtUSD(s.entry);

      const sl =
        s.type === "crypto"
          ? fmtGBP(toGBP(s.sl))
          : fmtUSD(s.sl);

      const tp =
        s.type === "crypto"
          ? fmtGBP(toGBP(s.tp))
          : fmtUSD(s.tp);

      const slPct =
        (
          ((s.entry - s.sl) / s.entry)
          * 100
        ).toFixed(2);

      const tpPct =
        (
          ((s.tp - s.entry) / s.entry)
          * 100
        ).toFixed(2);

      const quality =
        s.confidence >= 90
          ? "🔥 ELITE"
          : "✅ HIGH QUALITY";

      const msg =

`${s.type === "crypto"
  ? "🚀 CRYPTO BREAKOUT"
  : "📈 STOCK BREAKOUT"} — ${quality}

${s.asset}

Confidence: ${s.confidence}/100

Breakout: YES

Entry: ${entry}

Stop Loss: ${sl}
Risk: -${slPct}%

Take Profit: ${tp}
Potential: +${tpPct}%

Risk/Reward:
${s.riskReward.toFixed(2)}R

Volume Ratio:
${s.volRatio.toFixed(2)}x

${s.type === "crypto"
  ? `BTC Trend: ${btcTrend.toUpperCase()}
Minimum Stake: ${fmtGBP(s.minStake)}`
  : `Asset Type: Equity`}

Status:
🟢 READY`;

      await send(msg);

      trades.push({
        ...s,
        status: "open",
        createdAt: nowIso()
      });

      alerts.push({
        asset: s.asset,
        sentAt: nowIso()
      });

    }

    save(TRADES_FILE, trades);

    save(ALERTS_FILE, alerts);

    await manageTrades();

  }

  catch (e) {

    console.error("RUN ERROR:", e.message);

  }

  finally {

    running = false;

  }

}

// ================================================================
// API
// ================================================================

app.get("/", (_req, res) => {
  res.send("SNIPER V25 RUNNING 🚀");
});

app.get("/health", (_req, res) => {

  res.json({
    status: "ok",
    btcTrend,
    time: nowIso()
  });

});

app.get("/trades", (_req, res) => {
  res.json(load(TRADES_FILE));
});

// ================================================================
// START
// ================================================================

app.listen(PORT, "0.0.0.0", () => {

  console.log(`API running on ${PORT}`);

  runCycle();

  setInterval(runCycle, 300000);

});
