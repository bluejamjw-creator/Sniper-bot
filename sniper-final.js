// ============================================================
//  SNIPER BOT v3 — Crypto + Stocks (HIGH QUALITY MODE)
// ============================================================

const { spawn } = require("child_process");
const fs        = require("fs");
const https     = require("https");

// ── Python companion (FIXED RESTART) ─────────────────────────
function startPython() {
  const p = spawn("python3", ["portfolio_bot.py"]);

  p.stdout.on("data", d => console.log(`PYTHON: ${d}`));
  p.stderr.on("data", d => console.error(`PYTHON ERR: ${d}`));

  p.on("exit", code => {
    console.error(`Python exited (${code}) — restarting in 5s`);
    setTimeout(startPython, 5000);
  });
}
startPython();

// ── Config ──────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;

const CRYPTO_EVERY  = 5;
const STOCK_EVERY   = 15;
const SIGNAL_TTL_MS = 4 * 60 * 60 * 1000;

// ── Watchlists ──────────────────────────────────────────────
const CRYPTO_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT",
  "AVAXUSDT","DOGEUSDT","LINKUSDT","INJUSDT","SEIUSDT",
  "SUIUSDT","TIAUSDT","JUPUSDT","RENDERUSDT","BNBUSDT"
];

const STOCK_SYMBOLS = [
  "NVDA","PLTR","GEV","VRT","MSFT","AAPL","META","TSLA",
  "AMD","SMCI","ARM","MSTR","COIN","HOOD","IONQ"
];

// ── HTTP ────────────────────────────────────────────────────
function httpGet(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const parsed = new URL(url);
      https.get(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          headers: { "User-Agent": "Mozilla/5.0" }
        },
        res => {
          let raw = "";
          res.on("data", c => raw += c);
          res.on("end", () => {
            try { resolve(JSON.parse(raw)); }
            catch { reject(new Error("JSON parse error")); }
          });
        }
      ).on("error", err => {
        if (n > 1) setTimeout(() => attempt(n - 1), 1500);
        else reject(err);
      });
    };
    attempt(retries);
  });
}

// ── Telegram ────────────────────────────────────────────────
function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" });
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  });
  req.write(body);
  req.end();
}

// ── Signal Store ────────────────────────────────────────────
const SIGNALS_FILE = "signals.json";

function loadSignals() {
  try { return JSON.parse(fs.readFileSync(SIGNALS_FILE)); }
  catch { return []; }
}

function saveSignal(signal) {
  let signals = loadSignals();

  signals = signals.filter(
    s => !(s.asset === signal.asset && Date.now() - s.time > SIGNAL_TTL_MS)
  );

  if (signals.find(s => s.asset === signal.asset)) return false;

  signals.push(signal);
  if (signals.length > 50) signals = signals.slice(-50);

  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signals, null, 2));
  return true;
}

// ════════════════════════════════════════════════════════════
// MATH
// ════════════════════════════════════════════════════════════

function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
  }
  return val;
}

function atr(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const p = candles[i];
    return Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  });
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function resistanceZone(highs, tolerance = 0.008) {
  let best = { level: 0, count: 0 };
  for (const h of highs) {
    const cluster = highs.filter(x => Math.abs(x - h) / h < tolerance);
    if (cluster.length > best.count) {
      best = {
        level: cluster.reduce((a, b) => a + b, 0) / cluster.length,
        count: cluster.length
      };
    }
  }
  return best;
}

// ════════════════════════════════════════════════════════════
// CRYPTO
// ════════════════════════════════════════════════════════════

async function analyseCrypto(symbol) {
  try {
    const data = await httpGet(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=220`
    );

    const candles = data.map(k => ({
      o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5]
    }));

    const closes = candles.map(c => c.c);

    const e50 = ema(closes, 50);
    const e200 = ema(closes, 200);
    const price = closes.at(-1);

    if (!e50 || !e200) return null;
    if (!(price > e50 && e50 > e200)) return null;

    const window = candles.slice(-40);
    const highs = window.map(c => c.h);
    const { level: zone, count: touches } = resistanceZone(highs);

    if (touches < 4) return null;

    const last = candles.at(-1);
    const prev = candles.slice(-41, -1);

    const avgVol = prev.reduce((a,c)=>a+c.v,0)/prev.length;

    if (!(last.c > zone && last.v > avgVol * 2.0)) return null;

    // ✅ Fresh breakout
    if (prev.at(-1).c > zone) return null;

    const body = (last.c - last.o) / (last.h - last.l || 1);
    if (body < 0.5) return null;

    if ((last.c - zone) / zone > 0.03) return null;

    const a = atr(candles.slice(-30));
    const sl = a ? last.c - 1.5 * a : last.c * 0.97;
    const tp = a ? last.c + 3 * a : last.c * 1.06;

    return {
      type:"crypto",
      asset:symbol,
      entry:last.c,
      zone,
      touches,
      volRatio:(last.v/avgVol).toFixed(2),
      sl:+sl.toFixed(6),
      tp:+tp.toFixed(6),
      rr:"2:1"
    };

  } catch { return null; }
}

// ════════════════════════════════════════════════════════════
// STOCKS
// ════════════════════════════════════════════════════════════

async function analyseStock(symbol) {
  try {
    const data = await httpGet(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=6mo`
    );

    const r = data?.chart?.result?.[0];
    if (!r) return null;

    const q = r.indicators.quote[0];
    const candles = r.timestamp.map((t,i)=>({
      o:q.open[i],h:q.high[i],l:q.low[i],c:q.close[i],v:q.volume[i]
    })).filter(c=>c.c && c.v);

    if (candles.length < 60) return null;

    const closes = candles.map(c=>c.c);

    const e20 = ema(closes,20);
    const e50 = ema(closes,50);
    const e200 = ema(closes,200);

    if (!(closes.at(-1)>e20 && e20>e50 && e50>e200)) return null;

    const window = candles.slice(-20);
    const highs = window.map(c=>c.h);
    const {level:zone,count:touches} = resistanceZone(highs,0.015);

    if (touches < 4) return null;

    const last = candles.at(-1);
    const prev = candles.slice(-21,-1);

    const avgVol = prev.reduce((a,c)=>a+c.v,0)/prev.length;

    if (!(last.c>zone && last.v>avgVol*1.8)) return null;

    // ✅ Fresh breakout
    if (prev.at(-1).c > zone) return null;

    const body = (last.c-last.o)/(last.h-last.l||1);
    if (body < 0.45) return null;

    if ((last.c-zone)/zone > 0.02) return null;

    const a = atr(candles.slice(-30));
    const sl = a ? last.c - 1.5*a : last.c*0.97;
    const tp = a ? last.c + 3*a : last.c*1.05;

    return {
      type:"stock",
      asset:symbol,
      entry:last.c,
      zone:+zone.toFixed(2),
      touches,
      volRatio:(last.v/avgVol).toFixed(2),
      sl:+sl.toFixed(2),
      tp:+tp.toFixed(2),
      rr:"2:1"
    };

  } catch { return null; }
}

// ════════════════════════════════════════════════════════════
// SCAN
// ════════════════════════════════════════════════════════════

function scoreSignal(s) {
  return Math.min(s.touches,6)*10 + Math.min(parseFloat(s.volRatio),5)*8;
}

async function scanCrypto() {
  const results = [];
  for (const sym of CRYPTO_PAIRS) {
    const s = await analyseCrypto(sym);
    if (s) results.push(s);
  }

  if (!results.length) return;

  results.sort((a,b)=>scoreSignal(b)-scoreSignal(a));
  const best = results[0];

  if (saveSignal({ ...best, time: Date.now() })) {
    sendTelegram(`🚀 ${best.asset} breakout`);
  }
}

async function scanStocks() {
  const results = [];
  for (const sym of STOCK_SYMBOLS) {
    const s = await analyseStock(sym);
    if (s) results.push(s);
  }

  if (!results.length) return;

  results.sort((a,b)=>scoreSignal(b)-scoreSignal(a));
  const best = results[0];

  if (saveSignal({ ...best, time: Date.now() })) {
    sendTelegram(`📈 ${best.asset} breakout`);
  }
}

// ════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════

async function main() {
  if (!fs.existsSync(SIGNALS_FILE)) fs.writeFileSync(SIGNALS_FILE,"[]");

  await scanCrypto();
  await scanStocks();

  setInterval(scanCrypto, CRYPTO_EVERY*60*1000);
  setInterval(scanStocks, STOCK_EVERY*60*1000);
}

main();
