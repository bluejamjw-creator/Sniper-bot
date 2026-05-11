// ================================================================
// PORTFOLIO INTELLIGENCE BOT V13
// Not a pie picker. A smart market observer.
// ----------------------------------------------------------------
// Monday 08:00 UK  — Weekly market briefing
// 1st of month     — Monthly portfolio snapshot
// Every hour       — Radar scan (strong setups on daily candles)
// Any time         — Threshold alerts (-10% drop / +20% pump)
// ================================================================

console.log("📊 PORTFOLIO INTELLIGENCE BOT V13 STARTING...");

const fs      = require("fs");
const path    = require("path");
const axios   = require("axios");
const express = require("express");

axios.defaults.timeout = 15000;

const app  = express();
const PORT = process.env.PORT || 3001;
let   server;

app.get("/",       (_req, res) => res.status(200).send("PORTFOLIO INTELLIGENCE V13 alive"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

// ── Environment ──────────────────────────────────────────────────
const BOT_TOKEN           = process.env.BOT_TOKEN           || "";
const CHAT_ID             = process.env.CHAT_ID             || "";
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const FINNHUB_API_KEY     = process.env.FINNHUB_API_KEY     || "";

// ── State files ──────────────────────────────────────────────────
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "intel_state.json");
const RADAR_FILE = path.join(DATA_DIR, "radar_state.json");

// ── Your watchlist — edit to match your actual holdings ──────────
const WATCH_CRYPTO = [
  "BTCUSDT","ETHUSDT","SOLUSDT","SUIUSDT","ONDOUSDT",
  "TIAUSDT","INJUSDT","OPUSDT","ARBUSDT","RENDERUSDT"
];
const WATCH_STOCKS = [
  "NVDA","PLTR","AMD","ASTS","SMH","ASML","VRT","APP"
];

// ── Radar candidates ─────────────────────────────────────────────
const CRYPTO_CANDIDATES = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","AVAXUSDT",
  "LINKUSDT","NEARUSDT","RENDERUSDT","SUIUSDT","TONUSDT",
  "ONDOUSDT","ARBUSDT","OPUSDT","INJUSDT","TIAUSDT",
  "STRKUSDT","JUPUSDT","FETUSDT","AKTUSDT","EIGENUSDT"
];
const STOCK_CANDIDATES = [
  "NVDA","PLTR","AMD","ASTS","IONQ","MSFT","META",
  "AMZN","APP","MSTR","COIN","QQQ","SMH","AVGO",
  "VRT","CRWD","AMAT","GEV","AVAV","OKLO","RKLB"
];

// ── Sector maps ──────────────────────────────────────────────────
const SECTOR_SYMBOLS = {
  AI:       ["NVDA","PLTR","AMD","SMCI","MSFT","META","IONQ","CRWD","ANET"],
  GOLD:     ["NEM","GOLD","AEM","WPM","KGC"],
  CRYPTO:   ["COIN","MSTR","RIOT"],
  ENERGY:   ["XOM","CVX","SLB","HAL"],
  DEFENSE:  ["LMT","RTX","NOC","GD","AVAV"],
  NUCLEAR:  ["CCJ","NNE","SMR","OKLO"],
  ROBOTICS: ["ROK","ISRG","TER"]
};

const NARRATIVE_KEYWORDS = {
  AI:       ["artificial intelligence","ai chip","machine learning","gpu","nvidia","openai"],
  GOLD:     ["gold price","gold rally","bullion","precious metals","safe haven"],
  CRYPTO:   ["bitcoin","ethereum","crypto rally","btc","digital assets"],
  ENERGY:   ["oil price","crude","opec","natural gas"],
  DEFENSE:  ["defense spending","military","nato","geopolitical","war"],
  NUCLEAR:  ["nuclear energy","uranium","small modular reactor","smr"],
  ROBOTICS: ["robotics","automation","humanoid"]
};

// ── Thresholds ───────────────────────────────────────────────────
const THRESHOLD_DROP  = -0.10; // -10% triggers drop alert
const THRESHOLD_PUMP  =  0.20; // +20% triggers pump alert
const RADAR_SCORE_MIN = 75;
const RADAR_MOM20_MIN = 5;     // 5%+ 20-day momentum %
const RADAR_COOLDOWN  = 6;     // hours
const CHECK_INTERVAL  = 60 * 60 * 1000;

// ── Utilities ────────────────────────────────────────────────────
function nowIso()    { return new Date().toISOString(); }
function log(...a)   { console.log(`[${nowIso()}]`, ...a); }
function sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }
function escH(v)     { return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE,"utf8")); }
  catch { return { lastWeekly: null, lastMonthly: null }; }
}
function saveState(s) { ensureDir(); fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2)); }

function loadRadarState() {
  try { return JSON.parse(fs.readFileSync(RADAR_FILE,"utf8")); }
  catch { return {}; }
}
function saveRadarState(s) { ensureDir(); fs.writeFileSync(RADAR_FILE, JSON.stringify(s,null,2)); }

function hoursAgo(ts) {
  if (!ts) return Infinity;
  return (Date.now() - new Date(ts).getTime()) / 36e5;
}

function getUkParts() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday:"short", hour:"2-digit", minute:"2-digit",
    day:"2-digit", month:"short", hour12: false
  });
  const map = {};
  for (const p of fmt.formatToParts(new Date())) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return map;
}

function isWeekend()     { const d = getUkParts().weekday; return d === "Sat" || d === "Sun"; }
function getUkMins()     { const p = getUkParts(); return Number(p.hour)*60 + Number(p.minute); }
function isCryptoHours() { const m = getUkMins(); return m >= 360 && m < 1320; }
function isStockHours()  { return !isWeekend() && getUkMins() >= 870 && getUkMins() < 1260; }
function isMonday8am()   { const p = getUkParts(); return p.weekday === "Mon" && Number(p.hour) === 8; }

function isFirstOfMonth8am() {
  const p = getUkParts();
  return new Date().getUTCDate() === 1 && Number(p.hour) === 8;
}

async function retry(fn, retries=2, delay=1000) {
  for (let i=0; i<=retries; i++) {
    try { return await fn(); }
    catch(e) { if(i===retries) throw e; await sleep(delay * Math.pow(2,i)); }
  }
}

async function safeRun(name, fn) {
  try { return await fn(); }
  catch(e) { log(`ERROR (${name}):`, e?.message||e); return null; }
}

// ── Telegram ─────────────────────────────────────────────────────
async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) { log(msg); return; }
  try {
    const chunks = [];
    let cur = "";
    for (const line of msg.split("\n")) {
      if ((cur+"\n"+line).length > 3800) { chunks.push(cur); cur = line; }
      else cur = cur ? cur+"\n"+line : line;
    }
    if (cur) chunks.push(cur);
    for (const chunk of chunks) {
      await retry(() => axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID, text: chunk, parse_mode: "HTML"
      }, { timeout: 10000 }));
      if (chunks.length > 1) await sleep(500);
    }
  } catch(e) { log("TELEGRAM ERROR:", e.message); }
}

// ── Data fetching ────────────────────────────────────────────────
async function fetchBinance24hr(symbols) {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/ticker/24hr", { timeout: 12000 })
    );
    if (!Array.isArray(data)) return {};
    const result = {};
    for (const t of data) {
      if (symbols.includes(t.symbol)) {
        result[t.symbol] = { pct24: +t.priceChangePercent/100, price: +t.lastPrice, volume: +t.quoteVolume };
      }
    }
    return result;
  } catch { return {}; }
}

async function fetchDailyCandles(symbol, isCrypto) {
  if (isCrypto) {
    try {
      const { data } = await retry(() =>
        axios.get("https://data-api.binance.vision/api/v3/klines", {
          params: { symbol, interval: "1d", limit: 30 }, timeout: 12000
        })
      );
      return data.map(k => ({ close: +k[4], high: +k[2], low: +k[3], volume: +k[5] }));
    } catch { return null; }
  }
  if (TWELVE_DATA_API_KEY) {
    try {
      const { data } = await retry(() =>
        axios.get("https://api.twelvedata.com/time_series", {
          params: { symbol, interval:"1day", outputsize:30, order:"ASC", apikey: TWELVE_DATA_API_KEY },
          timeout: 15000
        })
      );
      if (data?.status !== "error" && Array.isArray(data?.values)) {
        return data.values.map(r => ({ close:+r.close, high:+r.high, low:+r.low, volume:+r.volume }))
          .filter(x => Number.isFinite(x.close));
      }
    } catch { /* fall through */ }
  }
  try {
    const { data } = await retry(() =>
      axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
        params: { interval:"1d", range:"1mo" }, headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000
      })
    );
    const r = data?.chart?.result?.[0];
    if (!r) return null;
    const q = r.indicators?.quote?.[0];
    return (r.timestamp||[]).map((_,i) => ({
      close: q.close[i]||0, high: q.high[i]||0, low: q.low[i]||0, volume: q.volume[i]||0
    })).filter(x => x.close > 0);
  } catch { return null; }
}

async function fetchFinnhubQuote(symbol) {
  if (!FINNHUB_API_KEY) return null;
  try {
    const { data } = await retry(() =>
      axios.get("https://finnhub.io/api/v1/quote", {
        params: { symbol, token: FINNHUB_API_KEY }, timeout: 8000
      })
    );
    return { pct: data?.dp||0, price: data?.c||0 };
  } catch { return null; }
}

async function detectSectors() {
  if (!FINNHUB_API_KEY) return [];
  try {
    const { data } = await retry(() =>
      axios.get("https://finnhub.io/api/v1/news", {
        params: { category:"general", token: FINNHUB_API_KEY }, timeout: 12000
      })
    );
    if (!Array.isArray(data)) return [];
    const text = data.slice(0,60)
      .map(n => ((n.headline||"")+" "+(n.summary||"")).toLowerCase()).join(" ");
    const scores = {};
    for (const [sector, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
      scores[sector] = keywords.filter(kw => text.includes(kw)).length;
    }
    return Object.entries(scores).filter(([,s])=>s>=2).sort((a,b)=>b[1]-a[1]).map(([s])=>s);
  } catch { return []; }
}

// ── Score asset on daily candles ─────────────────────────────────
function scoreAsset(candles, hotSectors, symbol) {
  if (!candles || candles.length < 10) return null;
  const closes  = candles.map(x => x.close);
  const volumes = candles.map(x => x.volume||0);
  const last    = closes.at(-1);
  const prev5   = closes.at(-6);
  const prev20  = closes[0];
  if (!Number.isFinite(last) || !prev5 || !prev20 || prev5<=0 || prev20<=0) return null;

  const mom5    = (last - prev5)  / prev5;
  const mom20   = (last - prev20) / prev20;
  const avgVol  = volumes.slice(0,-1).reduce((a,b)=>a+b,0) / (volumes.length-1);
  const volRatio = avgVol > 0 ? volumes.at(-1) / avgVol : 1;
  const avg10   = closes.slice(-10).reduce((a,b)=>a+b,0) / 10;

  let score = 50;
  if (mom5  > 0.08) score += 15; else if (mom5  > 0.03) score += 10; else if (mom5  > 0) score += 5;  else score -= 8;
  if (mom20 > 0.15) score += 10; else if (mom20 > 0.08) score += 6;  else if (mom20 > 0) score += 3;  else score -= 5;
  if (volRatio > 1.5) score += 8; else if (volRatio > 1.2) score += 4;
  if (last > avg10) score += 6;

  const sym = symbol.replace("USDT","");
  for (const sector of hotSectors) {
    if ((SECTOR_SYMBOLS[sector]||[]).includes(sym)) { score += 8; break; }
  }

  return {
    symbol, score: Math.round(score),
    mom5:  +(mom5*100).toFixed(1),
    mom20: +(mom20*100).toFixed(1),
    volRatio: +volRatio.toFixed(2)
  };
}

// ── Radar scan ───────────────────────────────────────────────────
async function runRadarScan() {
  const radarState = loadRadarState();
  const hotSectors = await detectSectors();
  let fired = 0;

  async function checkAsset(symbol, isCrypto) {
    if (fired >= 3) return;
    if (radarState[symbol] && hoursAgo(radarState[symbol]) < RADAR_COOLDOWN) return;
    const candles = await fetchDailyCandles(symbol, isCrypto);
    const result  = scoreAsset(candles, hotSectors, symbol);
    if (!result || result.score < RADAR_SCORE_MIN || result.mom20 < RADAR_MOM20_MIN) return;

    const sym      = symbol.replace("USDT","");
    const mkt      = isCrypto ? "\uD83E\uDE99 Crypto" : "\uD83C\uDDFA\uD83C\uDDF8 Stock";
    const strength = result.score >= 85 ? "\uD83D\uDD25 Very strong" : result.score >= 80 ? "\u26A1 Strong" : "\uD83D\uDCC8 Building";

    await send([
      `\uD83D\uDCE1 <b>PORTFOLIO RADAR</b>`,
      ``,
      `${mkt} \u2022 <b>${escH(sym)}</b>`,
      `\uD83D\uDCC8 5d: ${result.mom5>0?"+":""}${result.mom5}% \u2022 20d: ${result.mom20>0?"+":""}${result.mom20}% \u2022 Vol: ${result.volRatio}x`,
      `\u2B50 Score: ${result.score} \u2014 ${strength}`,
      ``,
      `\uD83D\uDCA1 Worth including in your next portfolio session`
    ].join("\n"));

    radarState[symbol] = nowIso();
    fired++;
    log(`📡 Radar: ${symbol} score=${result.score}`);
  }

  if (isCryptoHours()) {
    for (const sym of CRYPTO_CANDIDATES) {
      await safeRun(`radar_${sym}`, () => checkAsset(sym, true));
      await sleep(200);
    }
  }
  if (!isWeekend()) {
    for (const sym of STOCK_CANDIDATES) {
      await safeRun(`radar_${sym}`, () => checkAsset(sym, false));
      await sleep(300);
    }
  }

  saveRadarState(radarState);
  log(`📡 Radar complete — ${fired} alerts fired`);
}

// ── Threshold alerts ─────────────────────────────────────────────
async function checkThresholds() {
  const cryptoData = await fetchBinance24hr(WATCH_CRYPTO);
  for (const [symbol, d] of Object.entries(cryptoData)) {
    const sym = symbol.replace("USDT","");
    const pct = d.pct24 * 100;
    if (d.pct24 <= THRESHOLD_DROP) {
      await send([
        `\uD83D\uDEA8 <b>PORTFOLIO ALERT \u2014 DROP</b>`,
        ``,
        `\uD83D\uDCC9 <b>${escH(sym)}</b> is down <b>${pct.toFixed(1)}%</b> today`,
        `\uD83D\uDCB5 Price: $${d.price.toFixed(4)}`,
        `\uD83D\uDCA1 Check your position`
      ].join("\n"));
    }
    if (d.pct24 >= THRESHOLD_PUMP) {
      await send([
        `\uD83D\uDE80 <b>PORTFOLIO ALERT \u2014 PUMP</b>`,
        ``,
        `\uD83D\uDCC8 <b>${escH(sym)}</b> is up <b>+${pct.toFixed(1)}%</b> today`,
        `\uD83D\uDCB5 Price: $${d.price.toFixed(4)}`,
        `\uD83D\uDCA1 Consider taking some profit or letting it run`
      ].join("\n"));
    }
  }

  if (!isWeekend() && FINNHUB_API_KEY) {
    for (const sym of WATCH_STOCKS) {
      const q = await safeRun(`q_${sym}`, () => fetchFinnhubQuote(sym));
      if (!q) continue;
      const pct = q.pct;
      if (pct <= THRESHOLD_DROP * 100) {
        await send([
          `\uD83D\uDEA8 <b>PORTFOLIO ALERT \u2014 DROP</b>`,
          ``,
          `\uD83D\uDCC9 <b>${escH(sym)}</b> is down <b>${pct.toFixed(1)}%</b> today`,
          `\uD83D\uDCB5 Price: $${q.price.toFixed(2)}`,
          `\uD83D\uDCA1 Check your position`
        ].join("\n"));
      }
      if (pct >= THRESHOLD_PUMP * 100) {
        await send([
          `\uD83D\uDE80 <b>PORTFOLIO ALERT \u2014 PUMP</b>`,
          ``,
          `\uD83D\uDCC8 <b>${escH(sym)}</b> is up <b>+${pct.toFixed(1)}%</b> today`,
          `\uD83D\uDCB5 Price: $${q.price.toFixed(2)}`,
          `\uD83D\uDCA1 Consider taking some profit or letting it run`
        ].join("\n"));
      }
      await sleep(300);
    }
  }
}

// ── Weekly briefing ──────────────────────────────────────────────
async function sendWeeklyBriefing() {
  log("📋 Weekly briefing...");
  const hotSectors = await detectSectors();
  const cryptoData = await fetchBinance24hr(CRYPTO_CANDIDATES);

  const topCrypto = Object.entries(cryptoData)
    .map(([sym,d]) => ({ sym: sym.replace("USDT",""), pct: d.pct24*100 }))
    .sort((a,b) => b.pct-a.pct).slice(0, 6);

  const parts = [
    `\uD83D\uDCCA <b>WEEKLY MARKET BRIEFING</b>`,
    `<i>${new Date().toLocaleDateString("en-GB",{weekday:"long",day:"2-digit",month:"long",year:"numeric"})}</i>`,
    ``
  ];

  if (hotSectors.length > 0) {
    parts.push(`\uD83E\uDDE0 <b>Active narratives:</b>`);
    for (const s of hotSectors) {
      const syms = (SECTOR_SYMBOLS[s]||[]).slice(0,4).join(", ");
      parts.push(`  \uD83D\uDCCC ${escH(s)} \u2192 ${escH(syms)}`);
    }
    parts.push(``);
  }

  if (topCrypto.length > 0) {
    parts.push(`\uD83E\uDE99 <b>Crypto momentum (24hr leaders):</b>`);
    for (const c of topCrypto) {
      const e = c.pct >= 10 ? "\uD83D\uDD25" : c.pct >= 5 ? "\u26A1" : c.pct >= 0 ? "\uD83D\uDCC8" : "\uD83D\uDCC9";
      parts.push(`  ${e} <b>${escH(c.sym)}</b> ${c.pct>0?"+":""}${c.pct.toFixed(1)}%`);
    }
    parts.push(``);
  }

  parts.push(`\uD83D\uDCA1 <b>Paste this into Claude or ChatGPT:</b>`);
  parts.push(`<i>"These are the active market narratives this week and the top crypto movers. Given my portfolio, what should I be watching and is there anything I should be adjusting?"</i>`);

  await send(parts.join("\n"));
  log("✅ Weekly briefing sent");
}

// ── Monthly snapshot ─────────────────────────────────────────────
async function sendMonthlySnapshot() {
  log("📅 Monthly snapshot...");
  const hotSectors = await detectSectors();
  const cryptoData = await fetchBinance24hr(WATCH_CRYPTO);

  const parts = [
    `\uD83D\uDCC5 <b>MONTHLY PORTFOLIO SNAPSHOT</b>`,
    `<i>${new Date().toLocaleDateString("en-GB",{day:"2-digit",month:"long",year:"numeric"})}</i>`,
    ``
  ];

  const cryptoPerf = Object.entries(cryptoData)
    .map(([sym,d]) => ({ sym: sym.replace("USDT",""), pct: d.pct24*100, price: d.price }))
    .sort((a,b) => b.pct-a.pct);

  if (cryptoPerf.length > 0) {
    parts.push(`\uD83E\uDE99 <b>Your crypto watchlist today:</b>`);
    for (const c of cryptoPerf) {
      const e = c.pct >= 5 ? "\uD83D\uDCC8" : c.pct <= -5 ? "\uD83D\uDCC9" : "\u2194\uFE0F";
      parts.push(`  ${e} <b>${escH(c.sym)}</b>: ${c.pct>0?"+":""}${c.pct.toFixed(1)}%`);
    }
    parts.push(``);
  }

  if (hotSectors.length > 0) {
    parts.push(`\uD83E\uDDE0 <b>Hot sectors:</b> ${escH(hotSectors.join(", "))}`);
    parts.push(``);
  }

  parts.push(`\uD83D\uDCA1 <b>Paste this into Claude or ChatGPT for your monthly review:</b>`);
  parts.push(`<i>"Here is my watchlist performance and current market narrative. What adjustments should I consider for next month?"</i>`);

  await send(parts.join("\n"));
  log("✅ Monthly snapshot sent");
}

// ── Scheduler ────────────────────────────────────────────────────
async function scheduledCheck() {
  const state = loadState();
  const now   = new Date();

  if (isMonday8am()) {
    const last     = state.lastWeekly ? new Date(state.lastWeekly) : null;
    const daysSince = last ? (now - last) / 86400000 : 999;
    if (daysSince >= 6) {
      await safeRun("weeklyBriefing", sendWeeklyBriefing);
      state.lastWeekly = now.toISOString();
      saveState(state);
      return;
    }
  }

  if (isFirstOfMonth8am()) {
    const last = state.lastMonthly ? new Date(state.lastMonthly) : null;
    const sameMonth = last &&
      last.getUTCMonth() === now.getUTCMonth() &&
      last.getUTCFullYear() === now.getUTCFullYear();
    if (!sameMonth) {
      await safeRun("monthlySnapshot", sendMonthlySnapshot);
      state.lastMonthly = now.toISOString();
      saveState(state);
      return;
    }
  }

  await safeRun("radar",      runRadarScan);
  await safeRun("thresholds", checkThresholds);
}

// ── Boot ─────────────────────────────────────────────────────────
ensureDir();

server = app.listen(PORT, "0.0.0.0", async () => {
  log(`📊 Portfolio Intelligence V13 on port ${PORT}`);
  await send([
    `\uD83D\uDCCA <b>PORTFOLIO INTELLIGENCE V13 LIVE</b>`,
    ``,
    `\uD83D\uDCC5 Monday 08:00 \u2014 Weekly market briefing`,
    `\uD83D\uDDD3\uFE0F 1st of month \u2014 Monthly snapshot`,
    `\uD83D\uDCE1 Every hour \u2014 Radar scan (strong daily setups)`,
    `\uD83D\uDEA8 Any time \u2014 Drop -10% or pump +20% on your watchlist`,
    ``,
    `Running first scan now...`
  ].join("\n"));
  await safeRun("bootRadar",      runRadarScan);
  await safeRun("bootThresholds", checkThresholds);
  setInterval(scheduledCheck, CHECK_INTERVAL);
});
