const https = require("https");
const fs    = require("fs");

// ── CONFIG ──────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN;
const CHAT_ID       = process.env.CHAT_ID;
const SCAN_INTERVAL = 5 * 60 * 1000;
const SIGNAL_FILE   = "signals.json";
const TTL           = 4 * 60 * 60 * 1000;

// ── HEARTBEAT ───────────────────────
let lastHeartbeatDay = null;

function sendHeartbeat(pairCount) {
  const day = new Date().toDateString();
  if (day !== lastHeartbeatDay) {
    sendTelegram(`🔎 Sniper active — scanning ${pairCount} assets`);
    lastHeartbeatDay = day;
  }
}

// ── TELEGRAM ────────────────────────
function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  const body = JSON.stringify({ chat_id: CHAT_ID, text });

  const req = https.request({
    hostname: "api.telegram.org",
    path:     `/bot${BOT_TOKEN}/sendMessage`,
    method:   "POST",
    headers: {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  }, res => res.on("data", () => {}));

  req.on("error", e => console.error("Telegram error:", e.message));
  req.write(body);
  req.end();
}

// ── HTTP ────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(
      {
        hostname: new URL(url).hostname,
        path:     new URL(url).pathname + new URL(url).search,
        headers:  { "User-Agent": "Mozilla/5.0" }
      },
      res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(null); }
        });
      }
    ).on("error", reject);
  });
}

// ── EMA ─────────────────────────────
function ema(arr, p) {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let val = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
  }
  return val;
}

// ── ATR ─────────────────────────────
function atr(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const p = candles[i];
    return Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  });
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── RESISTANCE CLUSTER ──────────────
function resistanceZone(highs, tol = 0.006) {
  let best = { level: 0, count: 0 };
  for (const h of highs) {
    const cluster = highs.filter(x => Math.abs(x - h) / h < tol);
    if (cluster.length > best.count) {
      best = {
        level: cluster.reduce((a, b) => a + b, 0) / cluster.length,
        count: cluster.length
      };
    }
  }
  return best;
}

// ── SIGNAL STORE ────────────────────
function loadSignals() {
  try { return JSON.parse(fs.readFileSync(SIGNAL_FILE, "utf8")); }
  catch { return []; }
}

function saveSignal(sig) {
  let data = loadSignals();
  data = data.filter(s => Date.now() - s.time < TTL);
  if (data.find(s => s.asset === sig.asset)) return false;
  data.push(sig);
  if (data.length > 50) data = data.slice(-50);
  fs.writeFileSync(SIGNAL_FILE, JSON.stringify(data, null, 2));
  return true;
}

// ── DYNAMIC UNIVERSE ────────────────
async function getTopPairs() {
  const data = await httpGet("https://api.binance.com/api/v3/ticker/24hr");
  if (!data) return [];

  const STABLES = new Set(["USDC","BUSD","TUSD","DAI","FDUSD","USDP"]);

  return data
    .filter(x =>
      x.symbol.endsWith("USDT") &&
      !STABLES.has(x.symbol.replace("USDT", "")) &&
      parseFloat(x.quoteVolume) > 5_000_000
    )
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 50)
    .map(x => x.symbol);
}

// ── ELITE FILTER ENGINE ─────────────
async function analyse(symbol) {
  try {
    const raw = await httpGet(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=220`
    );
    if (!raw || raw.length < 210) return null;

    const candles = raw.map(k => ({
      o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]
    }));

    const closes = candles.map(c => c.c);

    // 1. Trend — price > EMA50 > EMA200
    const e50  = ema(closes, 50);
    const e200 = ema(closes, 200);
    if (!e50 || !e200) return null;
    if (!(closes.at(-1) > e50 && e50 > e200)) return null;

    // 2. Clustered resistance — 5+ touches
    const highs = candles.slice(-40).map(c => c.h);
    const { level: zone, count: touches } = resistanceZone(highs);
    if (touches < 5) return null;

    // 3. Breakout + volume — 2.5x average
    const last   = candles.at(-1);
    const prev   = candles.slice(-41, -1);
    const avgVol = prev.reduce((a, c) => a + c.v, 0) / prev.length;
    if (!(last.c > zone && last.v > avgVol * 2.5)) return null;

    // 4. Clean bullish body — 55%+ of range
    const body = (last.c - last.o) / (last.h - last.l || 1);
    if (body < 0.55) return null;

    // 5. Not overextended — within 2.5% of zone
    if ((last.c - zone) / zone > 0.025) return null;

    // ATR targets — 2:1 R:R
    const a  = atr(candles.slice(-30));
    const sl = a ? last.c - 1.5 * a : last.c * 0.97;
    const tp = a ? last.c + 3.0 * a : last.c * 1.06;

    return {
      type:     "crypto",
      asset:    symbol,
      entry:    last.c,
      zone:     +zone.toFixed(6),
      touches,
      volRatio: (last.v / avgVol).toFixed(2),
      sl:       +sl.toFixed(6),
      tp:       +tp.toFixed(6),
      rr:       "2:1",
      time:     Date.now()
    };

  } catch { return null; }
}

// ── SCAN ────────────────────────────
async function scan() {
  console.log(`\n[${new Date().toISOString()}] Scanning...`);

  const pairs = await getTopPairs();
  if (!pairs.length) {
    console.log("  Could not fetch pairs.");
    return;
  }

  sendHeartbeat(pairs.length);

  const results = [];
  for (const p of pairs) {
    const s = await analyse(p);
    if (s) results.push(s);
  }

  console.log(`  Scanned ${pairs.length} pairs — ${results.length} elite setup(s) found`);

  if (!results.length) return;

  results.sort((a, b) => parseFloat(b.volRatio) - parseFloat(a.volRatio));
  const best = results[0];

  if (saveSignal(best)) {
    const msg =
      `🚀 ${best.asset} — ELITE BREAKOUT\n\n` +
      `Entry : ${best.entry}\n` +
      `Zone  : ${best.zone} (${best.touches} touches)\n` +
      `Vol   : ${best.volRatio}x avg\n\n` +
      `SL    : ${best.sl}\n` +
      `TP    : ${best.tp}\n` +
      `R:R   : 2:1`;

    sendTelegram(msg);
    console.log(`  → SENT: ${best.asset}`);
  } else {
    console.log(`  → ${best.asset} already alerted`);
  }
}

// ── MAIN ────────────────────────────
async function run() {
  console.log("════════════════════════════════");
  console.log("  ELITE SNIPER — LIVE");
  console.log("  Top 50 pairs by volume");
  console.log("  5 elite filters");
  console.log("  Daily heartbeat confirmation");
  console.log("════════════════════════════════\n");

  if (!fs.existsSync(SIGNAL_FILE)) {
    fs.writeFileSync(SIGNAL_FILE, "[]");
  }

  await scan();
  setInterval(scan, SCAN_INTERVAL);
}

run();
