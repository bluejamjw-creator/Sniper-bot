const https = require("https");
const fs    = require("fs");
const yf    = require("yahoo-finance2").default;

// ── CONFIG ──────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN;
const CHAT_ID       = process.env.CHAT_ID;
const SCAN_INTERVAL = 5 * 60 * 1000;
const SIGNAL_FILE   = "signals.json";
const TTL           = 4 * 60 * 60 * 1000;

// 🔥 NEW — Only send high-quality setups
const MIN_CONFIDENCE = 70;

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
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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
      path: u.pathname + u.search,
      headers: { "User-Agent": "Mozilla/5.0" }
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

  // ✅ FIX — mode-aware duplicate handling
  const existing = data.find(x => x.asset === sig.asset && x.mode === sig.mode);

  if (existing) return false;

  // Elite overrides trade
  const weaker = data.find(x => x.asset === sig.asset && x.mode === "trade");
  if (weaker && sig.mode === "elite") {
    data = data.filter(x => x.asset !== sig.asset);
  }

  data.push(sig);

  if (data.length > 50) data = data.slice(-50);

  fs.writeFileSync(SIGNAL_FILE, JSON.stringify(data, null, 2));
  return true;
}

// ── SCORE ────────────────────────────
function scoreSignal(s) {
  const modeBonus = s.mode === "elite" ? 30 : 0;
  return Math.min(s.touches, 6) * 10 +
         Math.min(s.volRatio, 5) * 8 +
         modeBonus;
}

// ── FORMAT SIGNAL ───────────────────
function formatSignal(s, rank) {
  const emoji = s.mode === "elite" ? "🚀" : "⚡";
  const label = s.mode === "elite" ? "ELITE" : "TRADE";

  // ✅ FIX — safe confidence bar
  const bars = Math.min(10, Math.round(s.confidence / 10));
  const bar  = "█".repeat(bars) + "░".repeat(10 - bars);

  return (
`${emoji} #${rank} ${s.asset} — ${label} (${s.type.toUpperCase()})

Entry : ${s.entry}
SL    : ${s.sl}
TP    : ${s.tp}

Confidence: ${bar} ${s.confidence}%`
  );
}

// ── SCAN ────────────────────────────
async function scan() {
  console.log(`\n[${new Date().toISOString()}] Scan starting...`);

  sendHeartbeat();

  const pairs = await httpGet("https://api.binance.com/api/v3/ticker/24hr");
  if (!pairs) return;

  const topPairs = pairs
    .filter(x => x.symbol.endsWith("USDT") && +x.quoteVolume > 5_000_000)
    .sort((a,b)=>b.quoteVolume-a.quoteVolume)
    .slice(0,50)
    .map(x=>x.symbol);

  const results = [];

  for (const p of topPairs) {
    const raw = await httpGet(
      `https://api.binance.com/api/v3/klines?symbol=${p}&interval=1h&limit=220`
    );
    if (!raw) continue;

    const c = raw.map(k => ({
      o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]
    }));

    const closes = c.map(x=>x.c);
    const e50 = ema(closes,50);
    const e200 = ema(closes,200);

    if (!e50 || !e200) continue;
    if (!(closes.at(-1) > e50 && e50 > e200)) continue;

    const highs = c.slice(-40).map(x=>x.h);
    const {level:zone,count:touches} = resistanceZone(highs);

    const last = c.at(-1);
    const prev = c.slice(-41,-1);
    const avgVol = prev.reduce((a,x)=>a+x.v,0)/prev.length;

    if (!(last.c > zone && last.v > avgVol * 2.5)) continue;

    const a = atr(c.slice(-30));
    const sl = a ? last.c - 1.5*a : last.c * 0.97;
    const tp = a ? last.c + 3*a   : last.c * 1.06;

    const confidence = Math.min(100, Math.round(
      (Math.min(touches,6)/6)*40 +
      (Math.min(last.v/avgVol,4)/4)*40
    ));

    results.push({
      asset:p,
      entry:last.c,
      sl:+sl.toFixed(4),
      tp:+tp.toFixed(4),
      touches,
      volRatio:(last.v/avgVol),
      confidence,
      mode:"elite",
      type:"crypto",
      time:Date.now()
    });
  }

  if (!results.length) return;

  results.sort((a,b)=>scoreSignal(b)-scoreSignal(a));

  // ✅ NEW — only high confidence
  const top = results
    .filter(x => x.confidence >= MIN_CONFIDENCE)
    .slice(0,3);

  for (let i=0;i<top.length;i++) {
    if (saveSignal(top[i])) {
      sendTelegram(formatSignal(top[i], i+1));
    }
  }
}

// ── RUN ─────────────────────────────
async function run() {
  if (!fs.existsSync(SIGNAL_FILE)) {
    fs.writeFileSync(SIGNAL_FILE,"[]");
  }

  await scan();
  setInterval(scan, SCAN_INTERVAL);
}

run();
