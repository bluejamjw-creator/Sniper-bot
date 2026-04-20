const https = require("https");
const fs    = require("fs");
const yf    = require("yahoo-finance2").default;

// ── CONFIG ──────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN;
const CHAT_ID       = process.env.CHAT_ID;
const SCAN_INTERVAL = 5 * 60 * 1000;
const SIGNAL_FILE   = "signals.json";
const TTL           = 4 * 60 * 60 * 1000;

// ── STOCK UNIVERSE ──────────────────
const STOCKS = [
  "NVDA","AMD","TSLA","META","AAPL","MSFT","AMZN",
  "PLTR","COIN","MSTR","SMCI","ARM","IONQ","APP",
  "GOOGL","NFLX","SNOW","CRWD","ZS","SHOP"
];

// ── HEARTBEAT ───────────────────────
let lastHeartbeatDay = null;

function sendHeartbeat() {
  const day = new Date().toDateString();
  if (day !== lastHeartbeatDay) {
    sendTelegram(`🔎 Sniper active — scanning ${STOCKS.length} stocks + 50 crypto`);
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
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers:  { "User-Agent": "Mozilla/5.0" }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on("error", reject);
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
function atr(c, p = 14) {
  const trs = c.slice(1).map((x, i) => {
    const prev = c[i];
    return Math.max(x.h - x.l, Math.abs(x.h - prev.c), Math.abs(x.l - prev.c));
  });
  if (trs.length < p) return null;
  return trs.slice(-p).reduce((a, b) => a + b, 0) / p;
}

// ── RESISTANCE ──────────────────────
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

  data = data.filter(x => Date.now() - x.time < TTL);

  const existing = data.find(x => x.asset === sig.asset);
  if (existing) {
    if (existing.mode === "trade" && sig.mode === "elite") {
      data = data.filter(x => x.asset !== sig.asset);
    } else {
      return false;
    }
  }

  data.push(sig);
  if (data.length > 50) data = data.slice(-50);
  fs.writeFileSync(SIGNAL_FILE, JSON.stringify(data, null, 2));
  return true;
}

// ── CRYPTO PAIRS ────────────────────
async function getPairs() {
  const d = await httpGet("https://api.binance.com/api/v3/ticker/24hr");
  if (!d) return [];

  const STABLES = new Set(["USDC","BUSD","TUSD","DAI","FDUSD","USDP"]);

  return d
    .filter(x =>
      x.symbol.endsWith("USDT") &&
      !STABLES.has(x.symbol.replace("USDT", "")) &&
      parseFloat(x.quoteVolume) > 5_000_000
    )
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 50)
    .map(x => x.symbol);
}

// ── SCORE ────────────────────────────
function scoreSignal(s) {
  const modeBonus = s.mode === "elite" ? 30 : 0;
  return Math.min(s.touches, 6) * 10
       + Math.min(s.volRatio, 5) * 8   // FIX 4: volRatio now numeric, no parseFloat needed
       + modeBonus;
}

// ── CORE ANALYSIS ENGINE ─────────────
function runAnalysis(c, sym, type, mode) {
  const closes = c.map(x => x.c);

  const e50  = ema(closes, 50);
  const e200 = ema(closes, 200);
  if (!e50 || !e200) return null;
  if (!(closes.at(-1) > e50 && e50 > e200)) return null;

  const highs = c.slice(-40).map(x => x.h);
  const { level: zone, count: touches } = resistanceZone(highs);

  const last   = c.at(-1);
  const prev   = c.slice(-41, -1);
  const avgVol = prev.reduce((a, x) => a + x.v, 0) / prev.length;
  const body   = (last.c - last.o) / (last.h - last.l || 1);

  if (mode === "elite") {
    if (touches < (type === "crypto" ? 5 : 4)) return null;
    if (!(last.c > zone && last.v > avgVol * (type === "crypto" ? 2.5 : 2.0))) return null;
    if (body < 0.5) return null;
    if ((last.c - zone) / zone > 0.03) return null;
  }

  if (mode === "trade") {
    if (touches < 3) return null;
    if (!(last.c > zone && last.v > avgVol * 1.5)) return null;
    if (body < 0.4) return null;
  }

  const a  = atr(c.slice(-30));
  const sl = a ? last.c - 1.5 * a : last.c * 0.97;
  const tp = a ? last.c + 3.0 * a : last.c * 1.06;

  // Confidence score 0-100
  const confidence = Math.min(100, Math.round(
    (Math.min(touches, 6) / 6) * 40 +
    (Math.min(last.v / avgVol, 4) / 4) * 40 +
    (body * 20)
  ));

  return {
    type,
    asset:      sym,
    entry:      last.c,
    zone:       +zone.toFixed(4),
    touches,
    volRatio:   +(last.v / avgVol).toFixed(2),  // FIX 4: numeric, not string
    sl:         +sl.toFixed(4),
    tp:         +tp.toFixed(4),
    rr:         "2:1",
    mode,
    confidence,
    time:       Date.now()
  };
}

// ── CRYPTO ANALYSIS ─────────────────
async function analyseCrypto(sym, mode) {
  try {
    const raw = await httpGet(
      `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=220`
    );
    if (!raw || raw.length < 210) return null;

    const c = raw.map(k => ({
      o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]
    }));

    return runAnalysis(c, sym, "crypto", mode);
  } catch { return null; }
}

// ── STOCK ANALYSIS ──────────────────
async function analyseStock(sym, mode) {
  try {
    const data    = await yf.chart(sym, { range: "1mo", interval: "1h" });
    const candles = data?.quotes;
    if (!candles || candles.length < 50) return null;

    // FIX 3: only check close != null — avoids rejecting valid zero-volume candles
    const c = candles
      .filter(x => x.close !== null && x.close !== undefined &&
                   x.high  !== null && x.low !== null)
      .map(x => ({ o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume || 0 }));

    if (c.length < 50) return null;

    return runAnalysis(c, sym, "stock", mode);
  } catch { return null; }
}

// ── FORMAT SIGNAL ───────────────────
function formatSignal(s, rank) {
  const emoji = s.mode === "elite" ? "🚀" : "⚡";
  const label = s.mode === "elite" ? "ELITE" : "TRADE";
  const bar   = "█".repeat(Math.round(s.confidence / 10)) +
                "░".repeat(10 - Math.round(s.confidence / 10));

  return (
    `${emoji} #${rank} ${s.asset} — ${label} (${s.type.toUpperCase()})\n\n` +
    `Entry : ${s.entry}\n` +
    `Zone  : ${s.zone} (${s.touches} touches)\n` +
    `Vol   : ${s.volRatio}x avg\n\n` +
    `SL    : ${s.sl}\n` +
    `TP    : ${s.tp}\n` +
    `R:R   : 2:1\n\n` +
    `Confidence: ${bar} ${s.confidence}%`
  );
}

// ── SCAN ────────────────────────────
async function scan() {
  console.log(`\n[${new Date().toISOString()}] Scan starting...`);

  sendHeartbeat();

  const pairs   = await getPairs();
  const results = [];

  // Crypto
  for (const p of pairs) {
    const e = await analyseCrypto(p, "elite");
    if (e) { results.push(e); continue; }
    const t = await analyseCrypto(p, "trade");
    if (t) results.push(t);
  }

  // Stocks
  for (const s of STOCKS) {
    const e = await analyseStock(s, "elite");
    if (e) { results.push(e); continue; }
    const t = await analyseStock(s, "trade");
    if (t) results.push(t);
  }

  console.log(`  Found: ${results.length} signal(s)`);

  if (!results.length) {
    console.log("  No signals this scan.");
    return;
  }

  // Sort best first
  results.sort((a, b) => scoreSignal(b) - scoreSignal(a));

  // FIX 1 & 2 already resolved — volRatio numeric, sort correct
  // Send top 3 strongest
  const top3 = results.slice(0, 3);   // FIX 1: [:3] not [-3:] — best signals
  let sent = 0;

  for (let i = 0; i < top3.length; i++) {
    const sig = top3[i];
    if (saveSignal(sig)) {
      sendTelegram(formatSignal(sig, i + 1));
      console.log(`  → Sent #${i + 1}: ${sig.asset} (${sig.mode}) — confidence ${sig.confidence}%`);
      sent++;
    }
  }

  if (sent === 0) console.log("  All top signals already alerted.");
}

// ── RUN ─────────────────────────────
async function run() {
  console.log("════════════════════════════════════");
  console.log("  SNIPER — ELITE + TRADE");
  console.log(`  ${STOCKS.length} stocks + top 50 crypto`);
  console.log("  Top 3 | Elite overrides trade");
  console.log("  Confidence score | Daily heartbeat");
  console.log("════════════════════════════════════\n");

  if (!fs.existsSync(SIGNAL_FILE)) {
    fs.writeFileSync(SIGNAL_FILE, "[]");
  }

  await scan();
  setInterval(scan, SCAN_INTERVAL);
}

run();

