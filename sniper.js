// =======================
// 🚀 SNIPER V6 (FULL SYSTEM)
// =======================

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");

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

if (!fs.existsSync(STATS_FILE)) {
  fs.writeFileSync(
    STATS_FILE,
    JSON.stringify({ balance: START_BALANCE }, null, 2)
  );
}

const load = f => {
  try {
    return JSON.parse(fs.readFileSync(f));
  } catch {
    return [];
  }
};

const save = (f, d) =>
  fs.writeFileSync(f, JSON.stringify(d, null, 2));

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
        text: msg
      }
    );
  } catch {}
}

// =======================
// PRICE FETCH
// =======================
async function getPrice(symbol) {
  try {
    if (["SOL", "ETH", "FET", "RNDR"].includes(symbol)) {
      const { data } = await axios.get(
        `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`
      );
      return Number(data.price);
    }

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
  for (let i = 1; i < v.length; i++) {
    e = v[i] * k + e * (1 - k);
  }
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

  const tp1 = entry * 1.05;
  const tp2 = entry * 1.10;

  const rr = (tp2 - entry) / (entry - sl);
  if (rr < 1.3) return null;

  // 🧠 scoring
  let confidence = 0;

  if ((ema20 - ema50) / ema50 > 0.02) confidence += 25;
  if (momentum > 0.02) confidence += 25;
  if (last > high * 0.97) confidence += 20;
  if (range > 0.07) confidence += 20;

  if (confidence < MIN_CONFIDENCE) return null;

  return {
    asset: symbol,
    entry,
    sl,
    tp1,
    tp2,
    confidence,
    time: Date.now()
  };
}

// =======================
// FETCH DATA
// =======================
async function fetch(symbol) {
  try {
    if (["SOL", "ETH", "FET", "RNDR"].includes(symbol)) {
      const { data } = await axios.get(
        `https://api.binance.com/api/v3/klines`,
        {
          params: {
            symbol: `${symbol}USDT`,
            interval: "4h",
            limit: 50
          }
        }
      );
      return data.map(x => Number(x[4]));
    }

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
const WATCHLIST = [
  "SMH", "PLTR", "AMD", "APP", "MSTR", "ASTS", "SOUN",
  "SOL", "ETH", "FET", "RNDR"
];

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

  const ranked = results
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_ALERTS);

  const signals = load(SIGNAL_FILE);
  const trades = load(TRADES_FILE);
  const stats = load(STATS_FILE);

  for (const s of ranked) {
    const now = Date.now();

    const cooldown = signals.find(x =>
      x.asset === s.asset &&
      (now - x.time) < (COOLDOWN_HOURS * 3600000)
    );

    const alreadyOpen = trades.find(x =>
      x.asset === s.asset &&
      x.status === "open"
    );

    if (cooldown || alreadyOpen) continue;

    const risk = stats.balance * RISK_PCT;
    const size = risk / (s.entry - s.sl);

    // SAVE SIGNAL
    signals.push(s);
    save(SIGNAL_FILE, signals);

    // SAVE TRADE (dashboard-ready)
    trades.push({
      asset: s.asset,
      entry: s.entry,
      exit: null,
      pnl: 0,
      status: "open",
      exitReason: null,
      direction: "LONG",
      date: new Date().toISOString(),

      sl: s.sl,
      tp1: s.tp1,
      tp2: s.tp2,
      confidence: s.confidence,

      size,
      highest: s.entry
    });

    save(TRADES_FILE, trades);

    await send(
`🚨 TRADE SIGNAL

${s.asset} (${s.confidence}%)

Entry: ${s.entry.toFixed(2)}
SL: ${s.sl.toFixed(2)}

TP1: ${s.tp1.toFixed(2)}
TP2: ${s.tp2.toFixed(2)}

Size: ${size.toFixed(2)}`
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

    if (price > t.highest) t.highest = price;

    // BREAKEVEN
    if (price >= t.tp1 && !t.be) {
      t.sl = t.entry;
      t.be = true;
      send(`🔒 BE ${t.asset}`);
    }

    // TAKE PROFIT
    if (price >= t.tp2) {
      t.exit = price;
      t.pnl = (price - t.entry) * t.size;
      t.status = "closed";
      t.exitReason = "TP";

      stats.balance += t.pnl;

      send(`💰 TP ${t.asset} | +£${t.pnl.toFixed(2)} | Bal £${stats.balance.toFixed(2)}`);
      continue;
    }

    // STOP LOSS
    if (price <= t.sl) {
      t.exit = price;
      t.pnl = (price - t.entry) * t.size;
      t.status = "closed";
      t.exitReason = "SL";

      stats.balance += t.pnl;

      send(`❌ SL ${t.asset} | £${t.pnl.toFixed(2)} | Bal £${stats.balance.toFixed(2)}`);
    }
  }

  save(TRADES_FILE, trades);
  save(STATS_FILE, stats);
}

// =======================
// API (FOR DASHBOARD)
// =======================
app.get("/trades", (req, res) => {
  res.json(load(TRADES_FILE));
});

app.get("/stats", (req, res) => {
  res.json(load(STATS_FILE));
});

app.get("/signals", (req, res) => {
  res.json(load(SIGNAL_FILE));
});

app.listen(PORT, () => {
  console.log("🌐 API running on port", PORT);
});

// =======================
// LOOP
// =======================
async function runCycle() {
  await scan();
  await manageTrades();
}

runCycle();
setInterval(runCycle, 300000);

// keep alive
setInterval(() => {}, 60000);
