const https = require("https");
const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SCAN_INTERVAL = 5 * 60 * 1000;
const SIGNAL_FILE = "signals.json";
const TTL = 4 * 60 * 60 * 1000;

const STOCKS = [
  "NVDA","AMD","TSLA","META","AAPL","MSFT","AMZN",
  "PLTR","COIN","MSTR","SMCI","ARM","IONQ","APP",
  "GOOGL","NFLX","SNOW","CRWD","ZS","SHOP"
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("Telegram not configured");
    return;
  }

  const body = JSON.stringify({ chat_id: CHAT_ID, text });

  const req = https.request({
    hostname: "api.telegram.org",
    path: "/bot" + BOT_TOKEN + "/sendMessage",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  });

  req.on("error", err => console.error("Telegram error:", err.message));
  req.write(body);
  req.end();
}

let lastHeartbeatDay = null;
let lastSentSignal = null;

function sendHeartbeat() {
  const day = new Date().toDateString();
  if (day !== lastHeartbeatDay) {
    sendTelegram("🔎 Sniper active — scanning " + STOCKS.length + " stocks + crypto");
    lastHeartbeatDay = day;
  }
}

function httpGet(url, retries = 2) {
  return new Promise(resolve => {
    const attempt = (n) => {
      let u;
      try {
        u = new URL(url);
      } catch {
        return resolve(null);
      }

      https.get({
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { "User-Agent": "Mozilla/5.0" }
      }, res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            if (n < retries) return attempt(n + 1);
            resolve(null);
          }
        });
      }).on("error", () => {
        if (n < retries) return attempt(n + 1);
        resolve(null);
      });
    };

    attempt(0);
  });
}

function ema(arr, p) {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let val = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
  }
  return val;
}

function atr(c, p = 14) {
  if (c.length < p + 1) return null;
  const trs = [];
  for (let i = 1; i < c.length; i++) {
    const prev = c[i - 1];
    const curr = c[i];
    trs.push(Math.max(
      curr.h - curr.l,
      Math.abs(curr.h - prev.c),
      Math.abs(curr.l - prev.c)
    ));
  }
  return trs.slice(-p).reduce((a, b) => a + b, 0) / p;
}

function resistanceZone(highs) {
  let best = { level: 0, count: 0 };
  for (const h of highs) {
    const cluster = highs.filter(x => Math.abs(x - h) / h < 0.006);
    if (cluster.length > best.count) {
      best = {
        level: cluster.reduce((a, b) => a + b, 0) / cluster.length,
        count: cluster.length
      };
    }
  }
  return best;
}

async function getStockCandles(sym) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + sym + "?interval=1h&range=1mo";
  const d = await httpGet(url);

  const r = d && d.chart && d.chart.result && d.chart.result[0];
  if (!r || !r.indicators) return null;

  const q = r.indicators.quote[0];
  const candles = [];

  for (let i = 0; i < (q.close?.length || 0); i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null) continue;
    candles.push({
      o: q.open?.[i] ?? q.close[i],
      h: q.high[i],
      l: q.low[i],
      c: q.close[i],
      v: q.volume?.[i] ?? 0
    });
  }

  return candles.length > 50 ? candles : null;
}

async function getPairs() {
  const d = await httpGet("https://api.binance.com/api/v3/ticker/24hr");

  if (!Array.isArray(d)) {
    console.log("Binance fallback");
    return ["BTCUSDT","ETHUSDT","SOLUSDT"];
  }

  return d
    .filter(x => x?.symbol?.endsWith("USDT"))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 50)
    .map(x => x.symbol);
}

function runAnalysis(c, sym, type) {
  const closes = c.map(x => x.c);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);

  if (!e50 || !e200) return null;
  if (!(closes.at(-1) > e50 && e50 > e200)) return null;

  const highs = c.slice(-40).map(x => x.h);
  const { level, count } = resistanceZone(highs);

  const last = c.at(-1);
  const prev = c.slice(-41, -1);
  if (!last || prev.length === 0) return null;

  const avgVol = prev.reduce((a, x) => a + x.v, 0) / prev.length;
  const body = (last.c - last.o) / ((last.h - last.l) || 1);

  if (count < 4 || last.v < avgVol * 2 || body < 0.5) return null;

  const a = atr(c.slice(-30));
  const sl = a ? last.c - 1.5 * a : last.c * 0.97;
  const tp = a ? last.c + 3 * a : last.c * 1.06;

  const confidence = Math.min(100, Math.round(
    (Math.min(count, 6) / 6) * 40 +
    (Math.min(last.v / avgVol, 4) / 4) * 40 +
    body * 20
  ));

  return {
    asset: sym,
    entry: last.c,
    sl: +sl.toFixed(4),
    tp: +tp.toFixed(4),
    confidence,
    time: Date.now()
  };
}

function loadSignals() {
  try {
    const d = JSON.parse(fs.readFileSync(SIGNAL_FILE, "utf8"));
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

function saveSignal(sig) {
  let data = loadSignals();
  data = data.filter(x => Date.now() - x.time < TTL);

  if (data.find(x => x.asset === sig.asset)) return false;

  data.push(sig);
  fs.writeFileSync(SIGNAL_FILE, JSON.stringify(data, null, 2));
  return true;
}

function formatSignal(s) {
  const bars = "█".repeat(Math.round(s.confidence / 10)) +
               "░".repeat(10 - Math.round(s.confidence / 10));

  return "🚀 TRADE SIGNAL — " + s.asset + "\n\n" +
    "🎯 Entry: " + s.entry + "\n" +
    "🛑 Stop: " + s.sl + "\n" +
    "💰 Target: " + s.tp + "\n\n" +
    "Confidence:\n" +
    bars + " " + s.confidence + "%";
}

async function scan() {
  console.log("Scan running...");
  sendHeartbeat();

  const pairs = await getPairs();
  const results = [];

  for (const p of pairs) {
    const r = await analyseCrypto(p);
    if (r) results.push(r);
    await sleep(80);
  }

  for (const s of STOCKS) {
    const r = await analyseStock(s);
    if (r) results.push(r);
    await sleep(80);
  }

  if (!results.length) {
    console.log("No signals");
    return;
  }

  results.sort((a, b) => b.confidence - a.confidence);

  const best = results.find(x => x.confidence >= 80);
  if (!best) return;

  if (saveSignal(best) && best.asset !== lastSentSignal) {
    sendTelegram(formatSignal(best));
    lastSentSignal = best.asset;
    console.log("Sent:", best.asset);
  }
}

async function analyseCrypto(sym) {
  const raw = await httpGet("https://api.binance.com/api/v3/klines?symbol=" + sym + "&interval=1h&limit=220");
  if (!Array.isArray(raw)) return null;

  const c = raw.map(k => ({
    o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]
  }));

  return runAnalysis(c, sym, "crypto");
}

async function analyseStock(sym) {
  const c = await getStockCandles(sym);
  if (!c) return null;
  return runAnalysis(c, sym, "stock");
}

async function run() {
  console.log("Sniper started");

  if (!fs.existsSync(SIGNAL_FILE)) {
    fs.writeFileSync(SIGNAL_FILE, "[]");
  }

  await scan();
  setInterval(scan, SCAN_INTERVAL);
}

run();
