// ============================================================
//  SNIPER BOT v2  —  Crypto + Stocks
//  Crypto  : Binance 1h klines  (EMA stack, clustered resistance,
//             volume breakout, body quality, ATR-scaled targets)
//  Stocks  : Yahoo Finance daily (EMA50 trend, 20d resistance
//             cluster, volume surge, ATR stops, sector context)
// ============================================================

const { spawn } = require("child_process");
const fs        = require("fs");
const https     = require("https");

// ── Python companion ────────────────────────────────────────
const pythonProcess = spawn("python3", ["portfolio_bot.py"]);
pythonProcess.stdout.on("data", d => console.log(`PYTHON: ${d}`));
pythonProcess.stderr.on("data", d => console.error(`PYTHON ERR: ${d}`));
pythonProcess.on("exit", code => {
  console.error(`Python exited (${code}) — restarting in 5s`);
  setTimeout(() => spawn("python3", ["portfolio_bot.py"]), 5000);
});

// ── Config ──────────────────────────────────────────────────
const BOT_TOKEN      = process.env.BOT_TOKEN;
const CHAT_ID        = process.env.CHAT_ID;
const CRYPTO_EVERY   = 5;   // minutes
const STOCK_EVERY    = 15;  // minutes (markets only)
const SIGNAL_TTL_MS  = 4 * 60 * 60 * 1000; // 4 hours before re-alerting same asset

// ── Watchlists ───────────────────────────────────────────────
const CRYPTO_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT",
  "AVAXUSDT","DOGEUSDT","LINKUSDT","INJUSDT","SEIUSDT",
  "SUIUSDT","TIAUSDT","JUPUSDT","RENDERUSDT","BNBUSDT"
];

const STOCK_SYMBOLS = [
  "NVDA","PLTR","GEV","VRT","MSFT","AAPL","META","TSLA",
  "AMD","SMCI","ARM","MSTR","COIN","HOOD","IONQ"
];

// ── HTTP helper ──────────────────────────────────────────────
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
          res.on("data", c => (raw += c));
          res.on("end", () => {
            try { resolve(JSON.parse(raw)); }
            catch { reject(new Error("JSON parse error")); }
          });
        }
      ).on("error", err => {
        if (n > 1) {
          console.warn(`Retrying ${url} (${n - 1} left)`);
          setTimeout(() => attempt(n - 1), 1500);
        } else {
          reject(err);
        }
      });
    };
    attempt(retries);
  });
}

// ── Telegram ─────────────────────────────────────────────────
function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" });
  return new Promise(resolve => {
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      },
      res => {
        res.on("data", () => {});
        res.on("end", resolve);
      }
    );
    req.on("error", e => console.error("Telegram error:", e.message));
    req.write(body);
    req.end();
  });
}

// ── Signal store ─────────────────────────────────────────────
const SIGNALS_FILE = "signals.json";

function loadSignals() {
  try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, "utf8")); }
  catch { return []; }
}

function saveSignal(signal) {
  let signals = loadSignals();

  // Remove stale entry for this asset (TTL expired)
  signals = signals.filter(
    s => !(s.asset === signal.asset && Date.now() - s.time > SIGNAL_TTL_MS)
  );

  // Skip if still active
  if (signals.find(s => s.asset === signal.asset)) return false;

  signals.push(signal);
  if (signals.length > 50) signals = signals.slice(-50);
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signals, null, 2));
  return true; // new signal
}

// ════════════════════════════════════════════════════════════
//  SHARED MATHS
// ════════════════════════════════════════════════════════════

function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) val = arr[i] * k + val * (1 - k);
  return val;
}

/** Average True Range */
function atr(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
  });
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * Cluster-based resistance zone finder.
 * Groups highs within `tolerance` of each other and returns
 * the densest cluster's level and touch count.
 */
function resistanceZone(highs, tolerance = 0.008) {
  let best = { level: 0, count: 0 };
  for (const h of highs) {
    const cluster = highs.filter(x => Math.abs(x - h) / h < tolerance);
    if (cluster.length > best.count) {
      best = {
        level: cluster.reduce((a, b) => a + b, 0) / cluster.length, // zone midpoint
        count: cluster.length
      };
    }
  }
  return best;
}

// ════════════════════════════════════════════════════════════
//  CRYPTO ANALYSER
// ════════════════════════════════════════════════════════════

async function analyseCrypto(symbol) {
  try {
    const data = await httpGet(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=220`
    );

    const candles = data.map(k => ({
      o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]
    }));

    const closes = candles.map(c => c.c);

    // ── 1. Trend: price above EMA50 above EMA200 ────────────
    const e50  = ema(closes, 50);
    const e200 = ema(closes, 200);
    const price = closes.at(-1);

    if (!e50 || !e200) return null;
    if (!(price > e50 && e50 > e200)) return null;

    // ── 2. Clustered resistance zone (last 40 candles) ──────
    const window  = candles.slice(-40);
    const highs   = window.map(c => c.h);
    const { level: zone, count: touches } = resistanceZone(highs, 0.008);

    if (touches < 3) return null;

    // ── 3. Breakout above zone ───────────────────────────────
    const last = candles.at(-1);
    const prev = candles.slice(-41, -1);
    const avgVol = prev.reduce((a, c) => a + c.v, 0) / prev.length;

    if (!(last.c > zone && last.v > avgVol * 1.8)) return null;

    // ── 4. Clean bullish body (≥ 50% of range) ──────────────
    const body = (last.c - last.o) / (last.h - last.l || 1);
    if (body < 0.5) return null;

    // ── 5. Not extended: price within 3% of zone ────────────
    if ((last.c - zone) / zone > 0.03) return null;

    // ── 6. ATR-scaled targets ────────────────────────────────
    const a = atr(candles.slice(-30));
    const sl = a ? last.c - 1.5 * a : last.c * 0.97;
    const tp = a ? last.c + 3.0 * a : last.c * 1.06; // 2:1 RR

    return {
      type: "crypto",
      asset: symbol,
      entry: last.c,
      zone,
      touches,
      volRatio: (last.v / avgVol).toFixed(2),
      sl: +sl.toFixed(6),
      tp: +tp.toFixed(6),
      rr: "2:1"
    };

  } catch (e) {
    console.error(`[crypto] ${symbol}: ${e.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
//  STOCK ANALYSER
// ════════════════════════════════════════════════════════════

async function analyseStock(symbol) {
  try {
    // Pull 6 months of daily data for proper EMA + resistance
    const data = await httpGet(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=6mo`
    );

    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp;
    const q = result.indicators.quote[0];

    const candles = timestamps.map((t, i) => ({
      t: t * 1000,
      o: q.open[i],
      h: q.high[i],
      l: q.low[i],
      c: q.close[i],
      v: q.volume[i]
    })).filter(c => c.c && c.h && c.l && c.v); // drop null bars

    if (candles.length < 60) return null;

    const closes = candles.map(c => c.c);

    // ── 1. Trend: EMA20 > EMA50 > EMA200 ────────────────────
    const e20  = ema(closes, 20);
    const e50  = ema(closes, 50);
    const e200 = ema(closes, 200);
    const price = closes.at(-1);

    if (!e20 || !e50 || !e200) return null;
    if (!(price > e20 && e20 > e50 && e50 > e200)) return null;

    // ── 2. Clustered resistance (last 20 trading days) ───────
    const window = candles.slice(-20);
    const highs  = window.map(c => c.h);
    const { level: zone, count: touches } = resistanceZone(highs, 0.015); // wider for stocks

    if (touches < 3) return null;

    // ── 3. Breakout candle ───────────────────────────────────
    const last = candles.at(-1);
    const prev = candles.slice(-21, -1);
    const avgVol = prev.reduce((a, c) => a + c.v, 0) / prev.length;

    if (!(last.c > zone && last.v > avgVol * 1.5)) return null;

    // ── 4. Bullish body ──────────────────────────────────────
    const body = (last.c - last.o) / (last.h - last.l || 1);
    if (body < 0.45) return null;

    // ── 5. Not extended beyond 2% of zone ───────────────────
    if ((last.c - zone) / zone > 0.02) return null;

    // ── 6. ATR-scaled targets ────────────────────────────────
    const a = atr(candles.slice(-30));
    const sl = a ? last.c - 1.5 * a : last.c * 0.97;
    const tp = a ? last.c + 3.0 * a : last.c * 1.05;

    // ── 7. Meta ──────────────────────────────────────────────
    const meta = result.meta;
    const exchange = meta.exchangeName || "";
    const sector   = meta.sector      || "Unknown";

    return {
      type: "stock",
      asset: symbol,
      exchange,
      sector,
      entry: last.c,
      zone: +zone.toFixed(2),
      touches,
      volRatio: (last.v / avgVol).toFixed(2),
      sl: +sl.toFixed(2),
      tp: +tp.toFixed(2),
      rr: "2:1"
    };

  } catch (e) {
    console.error(`[stock] ${symbol}: ${e.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
//  SIGNAL RANKING
//  Score each signal so the best one surfaces first
// ════════════════════════════════════════════════════════════

function scoreSignal(s) {
  let score = 0;
  score += Math.min(s.touches, 6) * 10;           // more touches = stronger zone
  score += Math.min(parseFloat(s.volRatio), 5) * 8; // higher vol surge (capped)
  return score;
}

// ════════════════════════════════════════════════════════════
//  FORMAT TELEGRAM MESSAGE
// ════════════════════════════════════════════════════════════

function formatSignal(s) {
  const emoji = s.type === "crypto" ? "🚀" : "📈";
  const lines = [
    `${emoji} *${s.asset} BREAKOUT*`,
    `Type    : ${s.type.toUpperCase()}`,
    s.exchange ? `Exchange: ${s.exchange}` : null,
    s.sector && s.sector !== "Unknown" ? `Sector  : ${s.sector}` : null,
    ``,
    `Entry   : ${s.entry}`,
    `Zone    : ${s.zone} (${s.touches} touches)`,
    `Vol ×   : ${s.volRatio}x avg`,
    ``,
    `SL      : ${s.sl}`,
    `TP      : ${s.tp}`,
    `R:R     : ${s.rr}`,
  ].filter(Boolean);
  return lines.join("\n");
}

// ════════════════════════════════════════════════════════════
//  MARKET HOURS CHECK  (NYSE 9:30–16:00 ET, Mon–Fri)
// ════════════════════════════════════════════════════════════

function stockMarketOpen() {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  const h   = et.getHours();
  const m   = et.getMinutes();
  const mins = h * 60 + m;

  if (day === 0 || day === 6) return false;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// ════════════════════════════════════════════════════════════
//  SCAN FUNCTIONS
// ════════════════════════════════════════════════════════════

async function scanCrypto() {
  console.log(`\n[${new Date().toISOString()}] Crypto scan...`);
  const results = [];

  for (const sym of CRYPTO_PAIRS) {
    const signal = await analyseCrypto(sym);
    if (signal) {
      console.log(`  ✓ ${sym} — score ${scoreSignal(signal)}`);
      results.push(signal);
    }
  }

  if (results.length === 0) {
    console.log("  No crypto signals this scan.");
    return;
  }

  // Best signal wins
  results.sort((a, b) => scoreSignal(b) - scoreSignal(a));
  const best = results[0];

  const isNew = saveSignal({ ...best, time: Date.now() });
  if (isNew) {
    console.log(`  → Sending: ${best.asset}`);
    await sendTelegram(formatSignal(best));
  } else {
    console.log(`  → ${best.asset} already alerted (within TTL).`);
  }
}

async function scanStocks() {
  if (!stockMarketOpen()) {
    console.log(`[${new Date().toISOString()}] Market closed — skipping stock scan.`);
    return;
  }

  console.log(`\n[${new Date().toISOString()}] Stock scan...`);
  const results = [];

  for (const sym of STOCK_SYMBOLS) {
    const signal = await analyseStock(sym);
    if (signal) {
      console.log(`  ✓ ${sym} — score ${scoreSignal(signal)}`);
      results.push(signal);
    }
  }

  if (results.length === 0) {
    console.log("  No stock signals this scan.");
    return;
  }

  results.sort((a, b) => scoreSignal(b) - scoreSignal(a));
  const best = results[0];

  const isNew = saveSignal({ ...best, time: Date.now() });
  if (isNew) {
    console.log(`  → Sending: ${best.asset}`);
    await sendTelegram(formatSignal(best));
  } else {
    console.log(`  → ${best.asset} already alerted (within TTL).`);
  }
}

// ════════════════════════════════════════════════════════════
//  MAIN
// ════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════");
  console.log("  SNIPER v2 — Crypto + Stocks");
  console.log("═══════════════════════════════════");

  if (!fs.existsSync(SIGNALS_FILE)) fs.writeFileSync(SIGNALS_FILE, "[]");

  // Initial scans
  await scanCrypto();
  await scanStocks();

  // Recurring
  setInterval(scanCrypto, CRYPTO_EVERY * 60 * 1000);
  setInterval(scanStocks, STOCK_EVERY  * 60 * 1000);
}

main().catch(console.error);
