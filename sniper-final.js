const https = require("https");
const fs    = require("fs");
const yf    = require("yahoo-finance2").default;

// ── CONFIG ──────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN;
const CHAT_ID       = process.env.CHAT_ID;
const SCAN_INTERVAL = 5 * 60 * 1000;

const SIGNAL_FILE   = "signals.json";
const JOURNAL_FILE  = "journal.json";

const TTL = 4 * 60 * 60 * 1000;

// ── RISK ────────────────────────────
const PORTFOLIO_SIZE = 10000;
const BASE_RISK      = 0.01;

// ── STOCKS ──────────────────────────
const STOCKS = [
  "NVDA","AMD","TSLA","META","AAPL","MSFT","AMZN",
  "PLTR","COIN","MSTR","SMCI","ARM","IONQ","APP",
  "GOOGL","NFLX","SNOW","CRWD","ZS","SHOP"
];

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
  });

  req.on("error", () => {});
  req.write(body);
  req.end();
}

// ── HTTP ────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search
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
  let val = arr.slice(0, p).reduce((a,b)=>a+b)/p;

  for (let i = p; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
  }

  return val;
}

// ── ATR ─────────────────────────────
function atr(c, p=14) {
  const trs = c.slice(1).map((x,i)=>{
    const prev = c[i];
    return Math.max(x.h-x.l, Math.abs(x.h-prev.c), Math.abs(x.l-prev.c));
  });
  if (trs.length < p) return null;
  return trs.slice(-p).reduce((a,b)=>a+b)/p;
}

// ── RESISTANCE ──────────────────────
function resistanceZone(highs, tol=0.006) {
  let best = {level:0,count:0};
  for (const h of highs) {
    const c = highs.filter(x => Math.abs(x-h)/h < tol);
    if (c.length > best.count) {
      best = {
        level: c.reduce((a,b)=>a+b)/c.length,
        count: c.length
      };
    }
  }
  return best;
}

// ── POSITION SIZE ───────────────────
function size(entry, sl, risk) {
  const r = Math.abs(entry - sl);
  if (!r) return 0;
  return Math.round((risk / r) * 100) / 100;
}

// ── FILES ───────────────────────────
function load(file) {
  try { return JSON.parse(fs.readFileSync(file,"utf8")); }
  catch { return []; }
}

function save(file,data) {
  fs.writeFileSync(file, JSON.stringify(data,null,2));
}

// ── SIGNAL STORE ────────────────────
function saveSignal(s) {
  let d = load(SIGNAL_FILE);
  d = d.filter(x => Date.now()-x.time < TTL);

  if (d.find(x => x.asset === s.asset && x.type === s.type)) return false;

  d.push(s);
  save(SIGNAL_FILE,d);
  return true;
}

// ── TRADE TRACKING ──────────────────
async function updateTrades() {
  let j = load(JOURNAL_FILE);

  for (const t of j) {
    if (t.status !== "open") continue;

    let price = null;

    if (t.asset.endsWith("USDT")) {
      const d = await httpGet(
        `https://api.binance.com/api/v3/ticker/price?symbol=${t.asset}`
      );
      if (d) price = parseFloat(d.price);
    } else {
      try {
        const q = await yf.quote(t.asset);
        price = q.regularMarketPrice;
      } catch {}
    }

    if (!price) continue;

    if (price <= t.sl) {
      t.status = "loss";
    } else if (price >= t.tp) {
      t.status = "win";
    }
  }

  save(JOURNAL_FILE,j);
}

// ── CONFIDENCE SCORE ────────────────
function scoreSetup(touches, vol) {
  let score = touches * 10 + vol * 8;

  if (score >= 80) return "A+";
  if (score >= 65) return "A";
  return "B";
}

// ── ANALYSIS ENGINE ────────────────
function runAnalysis(c, sym, type) {
  const closes = c.map(x=>x.c);

  const e50 = ema(closes,50);
  const e200 = ema(closes,200);
  if (!e50 || !e200) return null;
  if (!(closes.at(-1) > e50 && e50 > e200)) return null;

  const highs = c.slice(-40).map(x=>x.h);
  const {level:zone,count:touches} = resistanceZone(highs);

  const last = c.at(-1);
  const prev = c.slice(-41,-1);
  const avgVol = prev.reduce((a,x)=>a+x.v,0)/prev.length;

  const volRatio = last.v / avgVol;

  const volMult = type === "crypto" ? 2.2 : 1.4;

  if (touches < (type==="crypto"?4:3)) return null;
  if (!(last.c > zone && volRatio > volMult)) return null;

  const a = atr(c.slice(-30));
  const sl = a ? last.c-1.5*a : last.c*0.97;
  const tp = a ? last.c+3*a : last.c*1.06;

  return {
    asset:sym,
    type,
    entry:last.c,
    sl:+sl.toFixed(4),
    tp:+tp.toFixed(4),
    volRatio:volRatio.toFixed(2),
    touches,
    confidence:scoreSetup(touches, volRatio),
    time:Date.now()
  };
}

// ── DATA SOURCES ────────────────────
async function analyseCrypto(sym) {
  const raw = await httpGet(
    `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=220`
  );
  if (!raw) return null;

  const c = raw.map(k=>({
    o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]
  }));

  return runAnalysis(c, sym, "crypto");
}

async function analyseStock(sym) {
  try {
    const data = await yf.chart(sym, { range:"3mo", interval:"1h" });
    const candles = data.quotes;
    if (!candles || candles.length < 100) return null;

    const c = candles.map(x=>({
      o:x.open,h:x.high,l:x.low,c:x.close,v:x.volume
    }));

    return runAnalysis(c, sym, "stock");

  } catch { return null; }
}

// ── PAIRS ───────────────────────────
async function getPairs() {
  const d = await httpGet("https://api.binance.com/api/v3/ticker/24hr");
  if (!d) return [];

  return d
    .filter(x=>x.symbol.endsWith("USDT") && +x.quoteVolume > 5_000_000)
    .sort((a,b)=>b.quoteVolume-a.quoteVolume)
    .slice(0,40)
    .map(x=>x.symbol);
}

// ── SCAN ────────────────────────────
async function scan() {
  console.log(`\n[${new Date().toISOString()}] Scan`);

  const pairs = await getPairs();
  const setups = [];

  // crypto
  for (const p of pairs) {
    const s = await analyseCrypto(p);
    if (s) setups.push(s);
  }

  // stocks
  for (const s of STOCKS) {
    const st = await analyseStock(s);
    if (st) setups.push(st);
  }

  console.log(`Found ${setups.length} setups`);

  await updateTrades();

  if (!setups.length) return;

  // sort best
  setups.sort((a,b)=>b.volRatio-a.volRatio);

  const best = setups[0];

  if (saveSignal(best)) {

    const risk = PORTFOLIO_SIZE * BASE_RISK;
    const qty  = size(best.entry, best.sl, risk);

    sendTelegram(
`🚀 ${best.asset} (${best.type}) — ${best.confidence}

Entry: ${best.entry}
SL: ${best.sl}
TP: ${best.tp}

Size: ${qty}
Risk: £${risk.toFixed(2)}`
    );
  }
}

// ── RUN ─────────────────────────────
async function run() {
  if (!fs.existsSync(SIGNAL_FILE)) fs.writeFileSync(SIGNAL_FILE,"[]");
  if (!fs.existsSync(JOURNAL_FILE)) fs.writeFileSync(JOURNAL_FILE,"[]");

  await scan();
  setInterval(scan,SCAN_INTERVAL);
}

run();
