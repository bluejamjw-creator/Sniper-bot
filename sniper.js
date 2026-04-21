// ============================
// SNIPER V16 (MULTI-EXCHANGE)
// ============================

console.log("🚀 SNIPER V16 MULTI-EXCHANGE STARTING...");

const axios = require("axios");
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================
// STORAGE
// ============================

const DATA_DIR = "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TRADES_FILE = path.join(DATA_DIR, "trades.json");

const load = f => {
  try {
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return [];
  }
};

const save = (f, d) => {
  fs.writeFileSync(f, JSON.stringify(d, null, 2));
};

// ============================
// TELEGRAM
// ============================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

async function send(msg) {
  if (!BOT_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: msg,
    });
  } catch {}
}

// ============================
// HELPERS
// ============================

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function rsi(values, period = 14) {
  let gain = 0, loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gain += diff;
    else loss -= diff;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - (100 / (1 + rs));
}

// ============================
// MULTI-EXCHANGE SYMBOL FETCH
// ============================

async function getTopCrypto() {

  // BINANCE
  try {
    const { data } = await axios.get("https://api.binance.me/api/v3/ticker/24hr");
    console.log("✅ Using Binance");

    return data
      .filter(x => x.symbol.endsWith("USDT"))
      .sort((a,b)=>parseFloat(b.priceChangePercent)-parseFloat(a.priceChangePercent))
      .slice(0,20)
      .map(x => x.symbol.replace("USDT",""));

  } catch {}

  // KUCOIN
  try {
    const { data } = await axios.get("https://api.kucoin.com/api/v1/market/allTickers");
    console.log("✅ Using KuCoin");

    return data.data.ticker
      .filter(x => x.symbol.endsWith("-USDT"))
      .slice(0,20)
      .map(x => x.symbol.replace("-USDT",""));

  } catch {}

  // COINGECKO
  try {
    const { data } = await axios.get(
      "https://api.coingecko.com/api/v3/coins/markets",
      { params: { vs_currency: "usd", order: "volume_desc", per_page: 20 } }
    );
    console.log("✅ Using CoinGecko");

    return data.map(x => x.symbol.toUpperCase());

  } catch {}

  console.log("❌ ALL DATA SOURCES FAILED");
  return [];
}

// ============================
// FETCH DATA (BINANCE STYLE)
// ============================

async function fetchCrypto(symbol) {
  try {
    const { data } = await axios.get(
      "https://api.binance.me/api/v3/klines",
      { params: { symbol: `${symbol}USDT`, interval: "15m", limit: 120 } }
    );

    return {
      closes: data.map(x => Number(x[4])).filter(Number.isFinite),
      volume: data.map(x => Number(x[5])).filter(Number.isFinite)
    };
  } catch {
    return null;
  }
}

// ============================
// ANALYSIS ENGINE
// ============================

function analyse(symbol, data) {

  if (!data || data.closes.length < 50) return null;

  const closes = data.closes;
  const volume = data.volume;

  const last = closes.at(-1);
  const prev = closes.at(-2);

  const ema9 = ema(closes.slice(-30), 9);
  const ema21 = ema(closes.slice(-50), 21);

  if (ema9 <= ema21) return null;

  const momentum = (last - prev) / prev;
  if (momentum < 0.002) return null;

  const high = Math.max(...closes.slice(-20));
  if (last < high * 0.985) return null;

  const r = rsi(closes);
  if (r > 70 || r < 50) return null;

  const avgVol = volume.slice(-20).reduce((a,b)=>a+b,0)/20;
  if (volume.at(-1) < avgVol * 1.3) return null;

  let confidence = 70;
  if (momentum > 0.004) confidence += 10;

  return {
    asset: symbol,
    entry: last,
    sl: last * 0.965,
    tp: last * 1.1,
    confidence
  };
}

// ============================
// SCAN
// ============================

async function scan() {

  const symbols = await getTopCrypto();
  const results = [];

  for (const s of symbols) {
    const data = await fetchCrypto(s);
    const r = analyse(s, data);
    if (r) results.push(r);
  }

  return results.sort((a,b)=>b.confidence-a.confidence).slice(0,3);
}

// ============================
// MAIN LOOP
// ============================

let running = false;

async function runCycle() {
  if (running) return;
  running = true;

  try {
    console.log("=== V16 SCAN ===");

    const signals = await scan();
    const trades = load(TRADES_FILE);

    console.log("Signals:", signals.length);

    for (const s of signals) {

      if (trades.find(t => t.asset === s.asset && t.status !== "closed"))
        continue;

      trades.push({ ...s, status: "open" });

      await send(
`🚨 V16 SIGNAL

${s.asset}
Confidence: ${s.confidence}

Entry: ${s.entry.toFixed(2)}
SL: ${s.sl.toFixed(2)}
TP: ${s.tp.toFixed(2)}`
      );
    }

    save(TRADES_FILE, trades);

  } catch (e) {
    console.error("ERROR:", e.message);
  }

  running = false;
}

setInterval(runCycle, 300000);
runCycle();

// ============================
// API
// ============================

app.get("/", (req,res)=>{
  res.send("SNIPER V16 RUNNING 🚀");
});

app.listen(PORT, "0.0.0.0", ()=>{
  console.log("API running on port", PORT);
});
