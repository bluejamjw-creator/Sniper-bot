// ============================================================
//  SNIPER BOT v4 — FINAL (SMART SCANNER + HEARTBEAT + HOURS)
// ============================================================

const { spawn } = require("child_process");
const fs        = require("fs");
const https     = require("https");

// ── Python companion ─────────────────────────────────────────
function startPython() {
  const p = spawn("python3", ["portfolio_bot.py"]);

  p.stdout.on("data", d => console.log(`PYTHON: ${d}`));
  p.stderr.on("data", d => console.error(`PYTHON ERR: ${d}`));

  p.on("exit", () => {
    console.error("Python exited — restarting in 5s");
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

// ── Heartbeat tracking ──────────────────────────────────────
let lastHeartbeatDay = null;

// ── HTTP helper ─────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(JSON.parse(data)));
    }).on("error", reject);
  });
}

// ── Telegram ────────────────────────────────────────────────
function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text });

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

// ── Signal storage ──────────────────────────────────────────
const FILE = "signals.json";

function loadSignals() {
  try { return JSON.parse(fs.readFileSync(FILE)); }
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

  fs.writeFileSync(FILE, JSON.stringify(signals, null, 2));
  return true;
}

// ════════════════════════════════════════════════════════════
//  HEARTBEAT + HOURS
// ════════════════════════════════════════════════════════════

function sendDailyHeartbeat() {
  const now = new Date();
  const uk = new Date(now.toLocaleString("en-GB", { timeZone: "Europe/London" }));
  const day = uk.toDateString();

  if (lastHeartbeatDay !== day) {
    sendTelegram("🔎 Sniper active — scanning markets today");
    lastHeartbeatDay = day;
  }
}

function withinTradingHours() {
  const now = new Date();
  const uk = new Date(now.toLocaleString("en-GB", { timeZone: "Europe/London" }));
  const hour = uk.getHours();
  return hour >= 6 && hour < 21; // 6am–9pm UK
}

// ════════════════════════════════════════════════════════════
//  STAGE 1 — UNIVERSE BUILDERS
// ════════════════════════════════════════════════════════════

async function getTopCryptoPairs() {
  const data = await httpGet("https://api.binance.com/api/v3/ticker/24hr");

  return data
    .filter(x => x.symbol.endsWith("USDT"))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, 40)
    .map(x => x.symbol);
}

async function getTopStocks() {
  try {
    const data = await httpGet(
      "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers"
    );

    return data.finance.result[0].quotes
      .slice(0, 30)
      .map(x => x.symbol);

  } catch {
    return [
      "NVDA","AMD","PLTR","META","TSLA",
      "SMCI","ARM","COIN","MSTR","HOOD",
      "IONQ","GEV","MSFT","AAPL"
    ];
  }
}

// ════════════════════════════════════════════════════════════
//  STAGE 2 — SNIPER LOGIC
// ════════════════════════════════════════════════════════════

function ema(arr, p) {
  if (arr.length < p) return null;
  const k = 2/(p+1);
  let val = arr.slice(0,p).reduce((a,b)=>a+b)/p;
  for (let i=p;i<arr.length;i++) val = arr[i]*k + val*(1-k);
  return val;
}

function scoreSignal(s) {
  return Math.min(s.touches,6)*10 + Math.min(parseFloat(s.volRatio),5)*8;
}

async function analyseCrypto(sym) {
  try {
    const d = await httpGet(
      `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=120`
    );

    const closes = d.map(k => +k[4]);
    const vols   = d.map(k => +k[5]);

    const e50 = ema(closes,50);
    const e200 = ema(closes,200);

    if (!e50 || !e200) return null;
    if (!(closes.at(-1) > e50 && e50 > e200)) return null;

    const volRatio = vols.at(-1) / (vols.slice(-20).reduce((a,b)=>a+b)/20);
    if (volRatio < 2) return null;

    return {
      type:"crypto",
      asset:sym,
      touches:3,
      volRatio:volRatio.toFixed(2)
    };

  } catch { return null; }
}

async function analyseStock(sym) {
  try {
    const d = await httpGet(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3mo`
    );

    const c = d.chart.result[0].indicators.quote[0].close.filter(Boolean);

    const e20 = ema(c,20);
    const e50 = ema(c,50);

    if (!e20 || !e50) return null;
    if (!(c.at(-1) > e20 && e20 > e50)) return null;

    return {
      type:"stock",
      asset:sym,
      touches:3,
      volRatio:2
    };

  } catch { return null; }
}

// ════════════════════════════════════════════════════════════
//  SCANS
// ════════════════════════════════════════════════════════════

async function scanCrypto() {
  sendDailyHeartbeat();

  console.log("🔍 Scanning crypto...");
  const pairs = await getTopCryptoPairs();

  const results = [];
  for (const sym of pairs) {
    const s = await analyseCrypto(sym);
    if (s) results.push(s);
  }

  if (!results.length) return;

  results.sort((a,b)=>scoreSignal(b)-scoreSignal(a));
  const best = results[0];

  if (withinTradingHours()) {
    if (saveSignal({ ...best, time: Date.now() })) {
      sendTelegram(`🚀 ${best.asset} breakout`);
    }
  }
}

async function scanStocks() {
  sendDailyHeartbeat();

  console.log("🔍 Scanning stocks...");
  const stocks = await getTopStocks();

  const results = [];
  for (const sym of stocks) {
    const s = await analyseStock(sym);
    if (s) results.push(s);
  }

  if (!results.length) return;

  results.sort((a,b)=>scoreSignal(b)-scoreSignal(a));
  const best = results[0];

  if (withinTradingHours()) {
    if (saveSignal({ ...best, time: Date.now() })) {
      sendTelegram(`📈 ${best.asset} breakout`);
    }
  }
}

// ════════════════════════════════════════════════════════════
//  MAIN
// ════════════════════════════════════════════════════════════

async function main() {
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE,"[]");

  console.log("🚀 SNIPER v4 LIVE");

  await scanCrypto();
  await scanStocks();

  setInterval(scanCrypto, CRYPTO_EVERY * 60 * 1000);
  setInterval(scanStocks, STOCK_EVERY  * 60 * 1000);
}

main();
