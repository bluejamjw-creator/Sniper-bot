// =======================
// SNIPER V6 (API + BOT)
// =======================

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");

// =======================
// EXPRESS SERVER (DASHBOARD API)
// =======================
const app = express();
const PORT = process.env.PORT || 3000;

// =======================
// ENV
// =======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DATA_DIR = process.env.DATA_DIR || ".";

const SIGNAL_FILE = path.join(DATA_DIR, "signals.json");
const TRADES_FILE = path.join(DATA_DIR, "trades.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");

// =======================
// SETTINGS
// =======================
const MIN_CONFIDENCE = 60;
const MAX_ALERTS = 3;
const COOLDOWN_HOURS = 4;

const START_BALANCE = 50;
const RISK_PCT = 0.02;

// =======================
// STORAGE
// =======================
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(SIGNAL_FILE)) fs.writeFileSync(SIGNAL_FILE, "[]");
if (!fs.existsSync(TRADES_FILE)) fs.writeFileSync(TRADES_FILE, "[]");
if (!fs.existsSync(STATS_FILE))
  fs.writeFileSync(STATS_FILE, JSON.stringify({ balance: START_BALANCE }, null, 2));

const load = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f));
  } catch {
    return [];
  }
};

const save = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

// =======================
// TELEGRAM
// =======================
async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: msg,
    });
  } catch {}
}

// =======================
// PRICE FETCH
// =======================
async function getPrice(symbol) {
  try {
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`
    );
    return data.chart.result[0].meta.regularMarketPrice;
  } catch {
    return null;
  }
}

// =======================
// EMA
// =======================
function ema(v, p) {
  const k = 2 / (p + 1);
  let e = v[0];
  for (let i = 1; i < v.length; i++) e = v[i] * k + e * (1 - k);
  return e;
}

// =======================
// ANALYSIS
// =======================
function analyse(symbol, closes) {
  if (!closes || closes.length < 30) return null;

  const last = closes.at(-1);
  const prev = closes.at(-2);

  const high = Math.max(...closes.slice(-20));
  const low = Math.min(...closes.slice(-20));

  const ema20 = ema(closes.slice(-20), 20);
  const ema50 = ema(closes.slice(-50), 50);

  if (ema20 <= ema50) return null;

  const momentum = (last - prev) / prev;
  const range = (high - low) / low;

  const entry = last;
  const sl = entry * 0.95;
  const tp = entry * 1.10;

  const rr = (tp - entry) / (entry - sl);
  if (rr < 1.3) return null;

  let score = 0;

  if (ema20 > ema50) score += 20;
  if (momentum > 0.02) score += 20;
  if (last > high * 0.97) score += 20;
  if (range > 0.05) score += 20;

  if (score < MIN_CONFIDENCE) return null;

  return {
    asset: symbol,
    entry,
    sl,
    tp,
    confidence: score,
    time: Date.now(),
  };
}

// =======================
// FETCH
// =======================
async function fetch(symbol) {
  try {
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`
    );

    return data.chart.result[0].indicators.quote[0].close;
  } catch {
    return null;
  }
}

// =======================
// WATCHLIST
// =======================
const WATCHLIST = ["MSTR", "PLTR", "AMD", "SMH"];

// =======================
// SCAN
// =======================
async function scan() {
  const results = [];

  for (const s of WATCHLIST) {
    const data = await fetch(s);
    const res = analyse(s, data);
    if (res) results.push(res);
  }

  const ranked = results.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_ALERTS);

  const signals = load(SIGNAL_FILE);
  const trades = load(TRADES_FILE);
  const stats = load(STATS_FILE);

  for (const s of ranked) {
    const alreadyOpen = trades.find((x) => x.asset === s.asset && x.status === "open");
    if (alreadyOpen) continue;

    const risk = stats.balance * RISK_PCT;
    const size = risk / (s.entry - s.sl);

    trades.push({
      ...s,
      size,
      status: "open",
      highest: s.entry,
    });

    save(TRADES_FILE, trades);

    await send(
`🚨 TRADE SIGNAL

${s.asset}
Entry: ${s.entry.toFixed(2)}
SL: ${s.sl.toFixed(2)}
TP: ${s.tp.toFixed(2)}`
    );
  }
}

// =======================
// TRADE MANAGEMENT
// =======================
async function manageTrades() {
  const trades = load(TRADES_FILE);
  const stats = load(STATS_FILE);

  for (const t of trades) {
    if (t.status !== "open") continue;

    const price = await getPrice(t.asset);
    if (!price) continue;

    if (price >= t.tp) {
      t.status = "closed";
      stats.balance *= 1.05;
      send(`💰 TP ${t.asset}`);
    }

    if (price <= t.sl) {
      t.status = "closed";
      stats.balance *= 0.98;
      send(`❌ SL ${t.asset}`);
    }
  }

  save(TRADES_FILE, trades);
  save(STATS_FILE, stats);
}

// =======================
// API ROUTES
// =======================

// health check
app.get("/", (req, res) => {
  res.send("Sniper Bot API Running 🚀");
});

// trades
app.get("/trades", (req, res) => {
  res.json(load(TRADES_FILE));
});

// stats
app.get("/stats", (req, res) => {
  res.json(load(STATS_FILE));
});

// =======================
// RUN BOT LOOP
// =======================
async function runCycle() {
  console.log("=== SNIPER CYCLE ===");
  await scan();
  await manageTrades();
}

setInterval(runCycle, 300000); // 5 min
runCycle();

// =======================
// START SERVER
// =======================
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
