// ============================
// SNIPER V14 (FULL MARKET SCANNER - STABLE)
// ============================

console.log("🚀 SNIPER V14 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// ============================
// SECURITY
// ============================

app.use((req, res, next) => {
  if (["/", "/trades", "/stats"].includes(req.path)) return next();

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

// ============================
// STORAGE
// ============================

const DATA_DIR = process.env.DATA_DIR || "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TRADES_FILE = path.join(DATA_DIR, "trades.json");

const load = (f) => {
  try {
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return [];
  }
};

const save = (f, d) => {
  try {
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
  } catch (e) {
    console.error("SAVE ERROR:", e.message);
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
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: msg,
    });
  } catch {}
}

// ============================
// CRYPTO MOVERS
// ============================

async function getTopCrypto() {
  try {
    const { data } = await axios.get(
      "https://api.binance.com/api/v3/ticker/24hr"
    );

    return data
      .filter((x) => x.symbol.endsWith("USDT"))
      .sort(
        (a, b) =>
          parseFloat(b.priceChangePercent) -
          parseFloat(a.priceChangePercent)
      )
      .slice(0, 25)
      .map((x) => x.symbol.replace("USDT", ""));
  } catch {
    return [];
  }
}

// ============================
// STOCK LIST
// ============================

const STOCK_POOL = [
  "AAPL","MSFT","NVDA","TSLA","AMD","META","GOOG","AMZN",
  "PLTR","COIN","MSTR","SMCI","NFLX","CRM","ADBE","INTC",
  "BA","DIS","PYPL","UBER","SHOP","SQ","ROKU","SNOW"
];

// ============================
// DATA FETCH
// ============================

async function fetchCrypto(symbol) {
  try {
    const { data } = await axios.get(
      "https://api.binance.com/api/v3/klines",
      { params: { symbol: `${symbol}USDT`, interval: "15m", limit: 120 } }
    );
    return data.map((x) => Number(x[4])).filter(Number.isFinite);
  } catch {
    return null;
  }
}

async function fetchStock(symbol) {
  try {
    const { data } = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=15m`
    );

    return data.chart.result[0].indicators.quote[0].close.filter(Number.isFinite);
  } catch {
    return null;
  }
}

// ============================
// ANALYSIS ENGINE (IMPROVED)
// ============================

function analyse(symbol, closes, type) {
  if (!closes || closes.length < 30) return null;

  const last = closes.at(-1);
  const prev = closes.at(-2);
  const base = closes.at(-8);

  if (![last, prev, base].every(Number.isFinite)) return null;
  if (base === 0 || prev === 0) return null;

  const move = (last - base) / base;
  const momentum = (last - prev) / prev;

  const recent = closes.slice(-20);
  const high = Math.max(...recent);
  const low = Math.min(...recent);

  if (!Number.isFinite(high) || !Number.isFinite(low) || low === 0) return null;

  const expansion = (high - low) / low;

  // 🔥 tuned for more signals but still quality
  if (move < 0.02 || momentum < 0.001) return null;

  let confidence = 60;

  if (move > 0.04) confidence += 10;
  if (move > 0.07) confidence += 10;
  if (expansion > 0.035) confidence += 10;
  if (last > high * 0.97) confidence += 10;

  const entry = last;
  const sl = entry * 0.96;
  const tp = entry * 1.08;

  return {
    asset: symbol,
    type,
    entry,
    sl,
    tp,
    confidence,
    move: move * 100,
    breakout: last > high * 0.97,
  };
}

// ============================
// SCANNER (PARALLEL)
// ============================

async function scan() {
  const cryptoSymbols = await getTopCrypto();

  const cryptoPromises = cryptoSymbols.map(async (s) => {
    const data = await fetchCrypto(s);
    return analyse(s, data, "crypto");
  });

  const stockPromises = STOCK_POOL.map(async (s) => {
    const data = await fetchStock(s);
    return analyse(s, data, "stock");
  });

  const results = [
    ...(await Promise.all(cryptoPromises)),
    ...(await Promise.all(stockPromises)),
  ].filter(Boolean);

  return results
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6);
}

// ============================
// TRADE MANAGEMENT
// ============================

async function manage() {
  const trades = load(TRADES_FILE);

  for (const t of trades) {
    if (t.status === "closed") continue;

    try {
      let price;

      if (t.type === "stock") {
        const { data } = await axios.get(
          `https://query1.finance.yahoo.com/v8/finance/chart/${t.asset}?interval=1m&range=1d`
        );
        price = data.chart.result[0].meta.regularMarketPrice;
      } else {
        const { data } = await axios.get(
          `https://api.binance.com/api/v3/ticker/price?symbol=${t.asset}USDT`
        );
        price = Number(data.price);
      }

      if (!Number.isFinite(price)) continue;

      if (price >= t.tp) {
        t.status = "closed";
        t.exit = price;
        t.pnl = price - t.entry;
        await send(`💰 TP HIT: ${t.asset}`);
      } else if (price <= t.sl) {
        t.status = "closed";
        t.exit = price;
        t.pnl = price - t.entry;
        await send(`❌ SL HIT: ${t.asset}`);
      }
    } catch {}
  }

  save(TRADES_FILE, trades);
}

// ============================
// MAIN LOOP
// ============================

async function runCycle() {
  try {
    console.log("=== SNIPER V14 RUNNING ===");

    const signals = await scan();
    const trades = load(TRADES_FILE);

    console.log("Signals found:", signals.length);

    for (const s of signals) {
      if (trades.find((t) => t.asset === s.asset && t.status !== "closed"))
        continue;

      const rr = ((s.tp - s.entry) / (s.entry - s.sl)).toFixed(2);
      const mode = s.breakout ? "BREAKOUT" : "MOMENTUM";

      trades.push({ ...s, status: "open" });

      await send(
`🚨 TRADE SIGNAL

${s.asset} (${s.type.toUpperCase()})
Score: ${s.confidence}
Mode: ${mode}

Entry: ${s.entry.toFixed(2)}
SL: ${s.sl.toFixed(2)}
TP: ${s.tp.toFixed(2)}

RR: ${rr}`
      );
    }

    save(TRADES_FILE, trades);
    await manage();
  } catch (e) {
    console.error("CYCLE ERROR:", e.message);
  }
}

setInterval(runCycle, 300000);
runCycle();

// ============================
// API
// ============================

app.get("/", (req, res) => {
  res.send("Sniper V14 LIVE 🚀");
});

app.get("/trades", (req, res) => {
  res.json(load(TRADES_FILE));
});

app.get("/stats", (req, res) => {
  const trades = load(TRADES_FILE);
  const closed = trades.filter((t) => t.status === "closed");
  const pnl = closed.reduce((a, t) => a + (t.pnl || 0), 0);

  res.json({
    total: trades.length,
    closed: closed.length,
    pnl: pnl.toFixed(2),
  });
});

// ============================
// SERVER
// ============================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running on port ${PORT}`);
});
