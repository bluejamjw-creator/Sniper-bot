const https = require("https");
const fs    = require("fs");

// ── CONFIG ──────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN;
const CHAT_ID       = process.env.CHAT_ID;
const SCAN_INTERVAL = 5 * 60 * 1000;

const SIGNAL_FILE   = "signals.json";
const JOURNAL_FILE  = "journal.json";

const TTL = 4 * 60 * 60 * 1000;

// ── BASE RISK ───────────────────────
const PORTFOLIO_SIZE = 10000;

const BASE_RISK_PORTFOLIO = 0.01;
const BASE_RISK_TRADE     = 0.005;

// ── AUTO RISK LIMITS ────────────────
const MIN_RISK = 0.005;
const MAX_RISK = 0.02;

// ── HEARTBEAT ───────────────────────
let lastHeartbeatDay = null;

function sendHeartbeat(count) {
const day = new Date().toDateString();
if (day !== lastHeartbeatDay) {
sendTelegram("🔎 Sniper active — scanning ${count} assets");
lastHeartbeatDay = day;
}
}

// ── TELEGRAM ────────────────────────
function sendTelegram(text) {
if (!BOT_TOKEN || !CHAT_ID) return;

const body = JSON.stringify({ chat_id: CHAT_ID, text });

const req = https.request({
hostname: "api.telegram.org",
path: "/bot${BOT_TOKEN}/sendMessage",
method: "POST",
headers: {
"Content-Type": "application/json",
"Content-Length": Buffer.byteLength(body)
}
});

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
let val = arr.slice(0, p).reduce((a,b)=>a+b)/p;
for (let i=p;i<arr.length;i++) {
val = arr[i]k + val(1-k);
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

// ── FILE HELPERS ────────────────────
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
if (d.find(x => x.asset === s.asset)) return false;
d.push(s);
save(SIGNAL_FILE,d);
return true;
}

// ── JOURNAL ─────────────────────────
function logTrade(s) {
let j = load(JOURNAL_FILE);

if (j.find(x => x.asset === s.asset && x.status === "open")) return;

j.push({
asset:s.asset,
entry:s.entry,
sl:s.sl,
tp:s.tp,
time:Date.now(),
status:"open"
});

save(JOURNAL_FILE,j);
}

async function updateTrades() {
let j = load(JOURNAL_FILE);

for (const t of j) {
if (t.status !== "open") continue;

const d = await httpGet(
  `https://api.binance.com/api/v3/ticker/price?symbol=${t.asset}`
);

if (!d) continue;

const price = parseFloat(d.price);

if (price <= t.sl) {
  t.status = "loss";
  t.result = -1;
} else if (price >= t.tp) {
  t.status = "win";
  t.result = 2;
}

}

save(JOURNAL_FILE,j);
}

// ── AUTO RISK ENGINE ────────────────
function getAdjustedRisk(baseRisk) {
const j = load(JOURNAL_FILE);
const recent = j.slice(-10).filter(x => x.status !== "open");

if (recent.length < 5) return baseRisk;

const wins = recent.filter(x=>x.status==="win").length;
const winRate = wins / recent.length;

let adj = baseRisk;

if (winRate > 0.6) adj *= 1.2;
if (winRate < 0.4) adj *= 0.7;

return Math.max(MIN_RISK, Math.min(MAX_RISK, adj));
}

// ── WEEKLY REPORT ───────────────────
function weeklyReport() {
const j = load(JOURNAL_FILE);
const week = Date.now() - 7*86400000;

const t = j.filter(x => x.time >= week && x.status !== "open");
if (!t.length) return;

const wins = t.filter(x=>x.status==="win").length;
const losses = t.filter(x=>x.status==="loss").length;

const totalR = t.reduce((a,x)=>a+(x.result||0),0);
const wr = ((wins/t.length)*100).toFixed(0);

sendTelegram(
`📈 WEEKLY PERFORMANCE

Trades: ${t.length}
Wins: ${wins}
Losses: ${losses}
Win Rate: ${wr}%

Net: ${totalR.toFixed(2)}R`
);
}

// ── PAIRS ───────────────────────────
async function getPairs() {
const d = await httpGet("https://api.binance.com/api/v3/ticker/24hr");
if (!d) return [];

return d
.filter(x=>x.symbol.endsWith("USDT") && +x.quoteVolume > 5_000_000)
.sort((a,b)=>b.quoteVolume-a.quoteVolume)
.slice(0,50)
.map(x=>x.symbol);
}

// ── ANALYSE ─────────────────────────
async function analyse(sym,mode="elite") {
try {
const raw = await httpGet(
"https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=220"
);
if (!raw) return null;

const c = raw.map(k=>({
  o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]
}));

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

const body = (last.c-last.o)/(last.h-last.l||1);

if (mode==="elite") {
  if (touches < 5) return null;
  if (!(last.c > zone && last.v > avgVol*2.5)) return null;
  if (body < 0.55) return null;
  if ((last.c-zone)/zone > 0.025) return null;
}

if (mode==="trade") {
  if (touches < 4) return null;
  if (!(last.c > zone && last.v > avgVol*2.0)) return null;
  if (body < 0.5) return null;
  if ((last.c-zone)/zone > 0.05) return null;
}

const a = atr(c.slice(-30));
const sl = a ? last.c-1.5*a : last.c*0.97;
const tp = a ? last.c+3*a : last.c*1.06;

return {
  type: mode==="elite"?"portfolio":"trade",
  asset:sym,
  entry:last.c,
  sl:+sl.toFixed(6),
  tp:+tp.toFixed(6),
  zone,
  touches,
  volRatio:(last.v/avgVol).toFixed(2),
  time:Date.now()
};

} catch { return null; }
}

// ── SCAN ────────────────────────────
async function scan() {
console.log("\n[${new Date().toISOString()}] Scan");

const pairs = await getPairs();
sendHeartbeat(pairs.length);

const elite = [];
const trades = [];

for (const p of pairs) {
const e = await analyse(p,"elite");
if (e) elite.push(e);

const t = await analyse(p,"trade");
if (t) trades.push(t);

}

console.log("Elite: ${elite.length} | Trades: ${trades.length}");

await updateTrades();

// ── ELITE
if (elite.length) {
elite.sort((a,b)=>b.volRatio-a.volRatio);
const best = elite[0];

const riskPct = getAdjustedRisk(BASE_RISK_PORTFOLIO);
const risk = PORTFOLIO_SIZE * riskPct;
const qty = size(best.entry,best.sl,risk);

if (saveSignal(best)) {
  logTrade(best);

  sendTelegram(

`🚀 ${best.asset} — PORTFOLIO

Entry: ${best.entry}
SL: ${best.sl}
TP: ${best.tp}

Size: ${qty}
Risk: £${risk.toFixed(2)} (${(riskPct*100).toFixed(2)}%)`
);
}
}

// ── TRADE
if (trades.length) {
trades.sort((a,b)=>b.volRatio-a.volRatio);
const best = trades[0];

const riskPct = getAdjustedRisk(BASE_RISK_TRADE);
const risk = PORTFOLIO_SIZE * riskPct;
const qty = size(best.entry,best.sl,risk);

logTrade(best);

sendTelegram(

`⚡ ${best.asset} — TRADE

Entry: ${best.entry}
SL: ${best.sl}
TP: ${best.tp}

Size: ${qty}
Risk: £${risk.toFixed(2)} (${(riskPct*100).toFixed(2)}%)`
);
}
}

// ── RUN ─────────────────────────────
async function run() {
if (!fs.existsSync(SIGNAL_FILE)) fs.writeFileSync(SIGNAL_FILE,"[]");
if (!fs.existsSync(JOURNAL_FILE)) fs.writeFileSync(JOURNAL_FILE,"[]");

await scan();
setInterval(scan,SCAN_INTERVAL);
setInterval(weeklyReport,86400000);
}

run();
