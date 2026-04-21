// ============================
// SNIPER V15 (RAILWAY READY)
// ============================

console.log("🚀 SNIPER V15 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ============================
// PROCESS SAFETY
// ============================

process.on("unhandledRejection", err => {
  console.error("UNHANDLED_REJECTION:", err);
});

process.on("uncaughtException", err => {
  console.error("UNCAUGHT_EXCEPTION:", err);
});

// ============================
// STORAGE
// ============================

const DATA_DIR = process.env.DATA_DIR || "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TRADES_FILE = path.join(DATA_DIR, "trades.json");

const load = f => {
  try {
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    console.error("LOAD_ERROR:", e.message);
    return [];
  }
};

const save = (f, d) => {
  try {
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
  } catch (e) {
    console.error("SAVE_ERROR:", e.message);
  }
};

// ============================
// TELEGRAM
// ============================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text: msg },
      { timeout: 15000 }
    );
  } catch (e) {
    console.error("TELEGRAM_ERROR:", e.message);
  }
}

// ============================
// HELPERS
// ============================

function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let out = values[0];
  for (let i = 1; i < values.length; i++) {
    out = values[i] * k + out * (1 - k);
  }
  return out;
}

function rsi(values, period = 14) {
  if (!values || values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (!Number.isFinite(diff)) return null;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function avg(values) {
  if (!values || !values.length) return null;
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// ============================
// DATA FETCH
// ============================

async function fetchCrypto(symbol, interval = "15m", limit = 120) {
  try {
    const { data, headers } = await axios.get(
      "https://api.binance.com/api/v3/klines",
      {
        params: { symbol: `${symbol}USDT`, interval, limit },
        timeout: 15000
      }
    );

    const closes = data.map(x => Number(x[4])).filter(Number.isFinite);
    const volume = data.map(x => Number(x[5])).filter(Number.isFinite);

    return {
      closes,
      volume,
      weight1m: headers["x-mbx-used-weight-1m"] || null
    };
  } catch (e) {
    console.error(`FETCH_${interval}_ERROR ${symbol}:`, e.message);
    return null;
  }
}

async function getTopCrypto(limit = 12) {
  try {
    const { data } = await axios.get(
      "https://api.binance.com/api/v3/ticker/24hr",
      { timeout: 15000 }
    );

    return data
      .filter(x => x.symbol.endsWith("USDT"))
      .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
      .slice(0, limit)
      .map(x => x.symbol.replace("USDT", ""));
  } catch (e) {
    console.error("TOP_CRYPTO_ERROR:", e.message);
    return [];
  }
}

// ============================
// ANALYSIS ENGINE
// ============================

function analyse(symbol, data15, data1h) {
  if (!data15 || !data1h) return null;

  const closes = data15.closes;
  const volume = data15.volume;

  if (!closes || !volume || closes.length < 50 || data1h.closes.length < 50) return null;

  const last = closes.at(-1);
  const prev = closes.at(-2);
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return null;

  const ema9 = ema(closes.slice(-30), 9);
  const ema21 = ema(closes.slice(-50), 21);
  if (!Number.isFinite(ema9) || !Number.isFinite(ema21) || ema9 <= ema21) return null;

  const emaHTF = ema(data1h.closes.slice(-50), 21);
  const lastHTF = data1h.closes.at(-1);
  if (!Number.isFinite(emaHTF) || !Number.isFinite(lastHTF) || lastHTF < emaHTF) return null;

  const momentum = (last - prev) / prev;
  if (momentum < 0.002) return null;

  const high = Math.max(...closes.slice(-20));
  if (!Number.isFinite(high) || last < high * 0.985) return null;

  const r = rsi(closes, 14);
  if (!Number.isFinite(r) || r > 70 || r < 50) return null;

  const avgVol = avg(volume.slice(-20));
  const lastVol = volume.at(-1);
  if (!Number.isFinite(avgVol) || !Number.isFinite(lastVol) || lastVol < avgVol * 1.3) return null;

  let confidence = 70;
  if (momentum > 0.004) confidence += 10;
  if (lastVol > avgVol * 1.6) confidence += 10;

  const entry = last;
  const sl = entry * 0.965;
  const tp = entry * 1.1;

  return {
    asset: symbol,
    type: "crypto",
    entry,
    sl,
    tp,
    confidence,
    momentumPct: +(momentum * 100).toFixed(2),
    rsi: +r.toFixed(2)
  };
}

// ============================
// SCAN
// ============================

async function scan() {
  const symbols = await getTopCrypto(12);
  const results = [];

  for (const s of symbols) {
    const data15 = await fetchCrypto(s, "15m", 120);
    const data1h = await fetchCrypto(s, "1h", 120);

    const signal = analyse(s, data15, data1h);
    if (signal) results.push(signal);
  }

  return results
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

// ============================
// MAIN LOOP
// ============================

let running = false;

async function runCycle() {
  if (running) {
    console.log("SCAN_SKIPPED: previous cycle still running");
    return;
  }

  running = true;

  try {
    console.log("=== V15 SCAN START ===");

    const signals = await scan();
    const trades = load(TRADES_FILE);

    console.log("Signals found:", signals.length);

    for (const s of signals) {
      const exists = trades.find(t => t.asset === s.asset && t.status !== "closed");
      if (exists) continue;

      trades.push({
        ...s,
        status: "open",
        createdAt: new Date().toISOString()
      });

      await send(
`🚨 PRO SIGNAL

${s.asset}
Confidence: ${s.confidence}
Momentum: ${s.momentumPct}%
RSI: ${s.rsi}

Entry: ${s.entry.toFixed(4)}
SL: ${s.sl.toFixed(4)}
TP: ${s.tp.toFixed(4)}`
      );
    }

    save(TRADES_FILE, trades);
    console.log("=== V15 SCAN END ===");
  } catch (e) {
    console.error("RUN_CYCLE_ERROR:", e.message);
  } finally {
    running = false;
  }
}

// ============================
// API
// ============================

app.get("/", (_req, res) => {
  res.status(200).send("SNIPER V15 RUNNING 🚀");
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get("/trades", (_req, res) => {
  res.json(load(TRADES_FILE));
});

// ============================
// SERVER START
// ============================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running on port ${PORT}`);

  runCycle().catch(err => {
    console.error("STARTUP_RUN_ERROR:", err.message);
  });

  setInterval(() => {
    console.log("💓 KEEP ALIVE");
  }, 240000);

  setInterval(() => {
    runCycle().catch(err => {
      console.error("INTERVAL_RUN_ERROR:", err.message);
    });
  }, 300000);
});
