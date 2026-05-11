// ================================================================
// PORTFOLIO INTELLIGENCE BOT V14
// Radar alerts removed.
// ----------------------------------------------------------------
// Monday 08:00 UK  — Weekly market briefing
// 1st of month     — Monthly portfolio snapshot
// Any time         — Threshold alerts (-10% drop / +20% pump)
// ================================================================

console.log("📊 PORTFOLIO INTELLIGENCE BOT V14 STARTING...");

const fs      = require("fs");
const path    = require("path");
const axios   = require("axios");
const express = require("express");

axios.defaults.timeout = 15000;

const app  = express();
const PORT = process.env.PORT || 3001;
let   server;

app.get("/",       (_req, res) => res.status(200).send("PORTFOLIO INTELLIGENCE V14 alive"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

// ── Environment ──────────────────────────────────────────────────
const BOT_TOKEN           = process.env.BOT_TOKEN           || "";
const CHAT_ID             = process.env.CHAT_ID             || "";
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const FINNHUB_API_KEY     = process.env.FINNHUB_API_KEY     || "";

// ── State files ──────────────────────────────────────────────────
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE  = path.join(DATA_DIR, "intel_state.json");
const ALERTS_FILE = path.join(DATA_DIR, "threshold_alert_state.json");

// ── Your watchlist — edit to match your actual holdings ──────────
const WATCH_CRYPTO = [
  "BTCUSDT","ETHUSDT","SOLUSDT","SUIUSDT","ONDOUSDT",
  "TIAUSDT","INJUSDT","OPUSDT","ARBUSDT","RENDERUSDT"
];
const WATCH_STOCKS = [
  "NVDA","PLTR","AMD","ASTS","SMH","ASML","VRT","APP"
];

// ── Reference pools for weekly/monthly intelligence ──────────────
const CRYPTO_CANDIDATES = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","AVAXUSDT",
  "LINKUSDT","NEARUSDT","RENDERUSDT","SUIUSDT","TONUSDT",
  "ONDOUSDT","ARBUSDT","OPUSDT","INJUSDT","TIAUSDT",
  "STRKUSDT","JUPUSDT","FETUSDT","AKTUSDT","EIGENUSDT"
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
const THRESHOLD_DROP  = -0.10;
const THRESHOLD_PUMP  =  0.20;
const CHECK_INTERVAL  = 60 * 60 * 1000;

// ── Utilities ────────────────────────────────────────────────────
function nowIso()  { return new Date().toISOString(); }
function log(...a) { console.log(`[${nowIso()}]`, ...a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escH(v)   { return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file,"utf8")); }
  catch { return fallback; }
}

function saveJson(file, value) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function loadState() {
  return loadJson(STATE_FILE, { lastWeekly: null, lastMonthly: null });
}

function saveState(s) {
  saveJson(STATE_FILE, s);
}

function loadAlertState() {
  return loadJson(ALERTS_FILE, {});
}

function saveAlertState(s) {
  saveJson(ALERTS_FILE, s);
}

function getUkParts() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday:"short",
    hour:"2-digit",
    minute:"2-digit",
    day:"2-digit",
    month:"2-digit",
    year:"numeric",
    hour12: false
  });
  const map = {};
  for (const p of fmt.formatToParts(new Date())) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return map;
}

function isWeekend() {
  const d = getUkParts().weekday;
  return d === "Sat" || d === "Sun";
}

function isMonday8am() {
  const p = getUkParts();
  return p.weekday === "Mon" && Number(p.hour) === 8;
}

function isFirstOfMonth8am() {
  const p = getUkParts();
  return Number(p.day) === 1 && Number(p.hour) === 8;
}

function ukDateKey() {
  const p = getUkParts();
  return `${p.year}-${p.month}-${p.day}`;
}

async function retry(fn, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries) throw e;
      await sleep(delay * Math.pow(2, i));
    }
  }
}

async function safeRun(name, fn) {
  try { return await fn(); }
  catch (e) { log(`ERROR (${name}):`, e?.message || e); return null; }
}

// ── Telegram ─────────────────────────────────────────────────────
async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) {
    log(msg);
    return;
  }

  try {
    const chunks = [];
    let cur = "";

    for (const line of msg.split("
")) {
      if ((cur + "
" + line).length > 3800) {
        chunks.push(cur);
        cur = line;
      } else {
        cur = cur ? cur + "
" + line : line;
      }
    }
    if (cur) chunks.push(cur);

    for (const chunk of chunks) {
      await retry(() =>
        axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: CHAT_ID,
          text: chunk,
          parse_mode: "HTML"
        }, { timeout: 10000 })
      );
      if (chunks.length > 1) await sleep(500);
    }
  } catch (e) {
    log("TELEGRAM ERROR:", e.message);
  }
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
        result[t.symbol] = {
          pct24: +t.priceChangePercent / 100,
          price: +t.lastPrice,
          volume: +t.quoteVolume
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

async function fetchFinnhubQuote(symbol) {
  if (!FINNHUB_API_KEY) return null;

  try {
    const { data } = await retry(() =>
      axios.get("https://finnhub.io/api/v1/quote", {
        params: { symbol, token: FINNHUB_API_KEY },
        timeout: 8000
      })
    );
    return {
      pct: data?.dp || 0,
      price: data?.c || 0
    };
  } catch {
    return null;
  }
}

async function detectSectors() {
  if (!FINNHUB_API_KEY) return [];

  try {
    const { data } = await retry(() =>
      axios.get("https://finnhub.io/api/v1/news", {
        params: { category:"general", token: FINNHUB_API_KEY },
        timeout: 12000
      })
    );

    if (!Array.isArray(data)) return [];

    const text = data
      .slice(0, 60)
      .map(n => ((n.headline || "") + " " + (n.summary || "")).toLowerCase())
      .join(" ");

    const scores = {};
    for (const [sector, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
      scores[sector] = keywords.filter(kw => text.includes(kw)).length;
    }

    return Object.entries(scores)
      .filter(([,s]) => s >= 2)
      .sort((a,b) => b[1] - a[1])
      .map(([s]) => s);
  } catch {
    return [];
  }
}

// ── Threshold alerts ─────────────────────────────────────────────
function thresholdKey(symbol, kind) {
  return `${ukDateKey()}_${symbol}_${kind}`;
}

async function checkThresholds() {
  const alertState = loadAlertState();

  const cryptoData = await fetchBinance24hr(WATCH_CRYPTO);
  for (const [symbol, d] of Object.entries(cryptoData)) {
    const sym = symbol.replace("USDT", "");
    const pct = d.pct24 * 100;
    const dropKey = thresholdKey(symbol, "DROP");
    const pumpKey = thresholdKey(symbol, "PUMP");

    if (d.pct24 <= THRESHOLD_DROP) {
      if (!alertState[dropKey]) {
        await send([
          `🚨 <b>PORTFOLIO ALERT — DROP</b>`,
          ``,
          `📉 <b>${escH(sym)}</b> is down <b>${pct.toFixed(1)}%</b> today`,
          `💵 Price: $${d.price.toFixed(4)}`,
          `💡 Check your position`
        ].join("
"));
        alertState[dropKey] = nowIso();
      }
    } else {
      delete alertState[dropKey];
    }

    if (d.pct24 >= THRESHOLD_PUMP) {
      if (!alertState[pumpKey]) {
        await send([
          `🚀 <b>PORTFOLIO ALERT — PUMP</b>`,
          ``,
          `📈 <b>${escH(sym)}</b> is up <b>+${pct.toFixed(1)}%</b> today`,
          `💵 Price: $${d.price.toFixed(4)}`,
          `💡 Consider taking some profit or letting it run`
        ].join("
"));
        alertState[pumpKey] = nowIso();
      }
    } else {
      delete alertState[pumpKey];
    }
  }

  if (!isWeekend() && FINNHUB_API_KEY) {
    for (const sym of WATCH_STOCKS) {
      const q = await safeRun(`q_${sym}`, () => fetchFinnhubQuote(sym));
      if (!q) continue;

      const pct = q.pct;
      const dropKey = thresholdKey(sym, "DROP");
      const pumpKey = thresholdKey(sym, "PUMP");

      if (pct <= THRESHOLD_DROP * 100) {
        if (!alertState[dropKey]) {
          await send([
            `🚨 <b>PORTFOLIO ALERT — DROP</b>`,
            ``,
            `📉 <b>${escH(sym)}</b> is down <b>${pct.toFixed(1)}%</b> today`,
            `💵 Price: $${q.price.toFixed(2)}`,
            `💡 Check your position`
          ].join("
"));
          alertState[dropKey] = nowIso();
        }
      } else {
        delete alertState[dropKey];
      }

      if (pct >= THRESHOLD_PUMP * 100) {
        if (!alertState[pumpKey]) {
          await send([
            `🚀 <b>PORTFOLIO ALERT — PUMP</b>`,
            ``,
            `📈 <b>${escH(sym)}</b> is up <b>+${pct.toFixed(1)}%</b> today`,
            `💵 Price: $${q.price.toFixed(2)}`,
            `💡 Consider taking some profit or letting it run`
          ].join("
"));
          alertState[pumpKey] = nowIso();
        }
      } else {
        delete alertState[pumpKey];
      }

      await sleep(300);
    }
  }

  saveAlertState(alertState);
}

// ── Weekly briefing ──────────────────────────────────────────────
async function sendWeeklyBriefing() {
  log("📋 Weekly briefing...");

  const hotSectors = await detectSectors();
  const cryptoData = await fetchBinance24hr(CRYPTO_CANDIDATES);

  const topCrypto = Object.entries(cryptoData)
    .map(([sym, d]) => ({ sym: sym.replace("USDT",""), pct: d.pct24 * 100 }))
    .sort((a,b) => b.pct - a.pct)
    .slice(0, 6);

  const parts = [
    `📊 <b>WEEKLY MARKET BRIEFING</b>`,
    `<i>${new Date().toLocaleDateString("en-GB", { weekday:"long", day:"2-digit", month:"long", year:"numeric" })}</i>`,
    ``
  ];

  if (hotSectors.length > 0) {
    parts.push(`🧠 <b>Active narratives:</b>`);
    for (const s of hotSectors) {
      const syms = (SECTOR_SYMBOLS[s] || []).slice(0, 4).join(", ");
      parts.push(`• ${escH(s)} → ${escH(syms)}`);
    }
    parts.push(``);
  }

  if (topCrypto.length > 0) {
    parts.push(`🪙 <b>Crypto momentum (24hr leaders):</b>`);
    for (const c of topCrypto) {
      const e = c.pct >= 10 ? "🔥" : c.pct >= 5 ? "⚡" : c.pct >= 0 ? "📈" : "📉";
      parts.push(`${e} <b>${escH(c.sym)}</b> ${c.pct > 0 ? "+" : ""}${c.pct.toFixed(1)}%`);
    }
    parts.push(``);
  }

  parts.push(`💡 <b>Paste this into Claude or ChatGPT:</b>`);
  parts.push(`<i>"These are the active market narratives this week and the top crypto movers. Given my portfolio, what should I be watching and is there anything I should be adjusting?"</i>`);

  await send(parts.join("
"));
  log("✅ Weekly briefing sent");
}

// ── Monthly snapshot ─────────────────────────────────────────────
async function sendMonthlySnapshot() {
  log("📅 Monthly snapshot...");

  const hotSectors = await detectSectors();
  const cryptoData = await fetchBinance24hr(WATCH_CRYPTO);

  const parts = [
    `📅 <b>MONTHLY PORTFOLIO SNAPSHOT</b>`,
    `<i>${new Date().toLocaleDateString("en-GB", { day:"2-digit", month:"long", year:"numeric" })}</i>`,
    ``
  ];

  const cryptoPerf = Object.entries(cryptoData)
    .map(([sym, d]) => ({ sym: sym.replace("USDT",""), pct: d.pct24 * 100, price: d.price }))
    .sort((a,b) => b.pct - a.pct);

  if (cryptoPerf.length > 0) {
    parts.push(`🪙 <b>Your crypto watchlist today:</b>`);
    for (const c of cryptoPerf) {
      const e = c.pct >= 5 ? "📈" : c.pct <= -5 ? "📉" : "↔️";
      parts.push(`${e} <b>${escH(c.sym)}</b>: ${c.pct > 0 ? "+" : ""}${c.pct.toFixed(1)}%`);
    }
    parts.push(``);
  }

  if (hotSectors.length > 0) {
    parts.push(`🧠 <b>Hot sectors:</b> ${escH(hotSectors.join(", "))}`);
    parts.push(``);
  }

  parts.push(`💡 <b>Paste this into Claude or ChatGPT for your monthly review:</b>`);
  parts.push(`<i>"Here is my watchlist performance and current market narrative. What adjustments should I consider for next month?"</i>`);

  await send(parts.join("
"));
  log("✅ Monthly snapshot sent");
}

// ── Scheduler ────────────────────────────────────────────────────
async function scheduledCheck() {
  const state = loadState();
  const now   = new Date();

  if (isMonday8am()) {
    const last = state.lastWeekly ? new Date(state.lastWeekly) : null;
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

  await safeRun("thresholds", checkThresholds);
}

// ── Boot ─────────────────────────────────────────────────────────
ensureDir();

server = app.listen(PORT, "0.0.0.0", async () => {
  log(`📊 Portfolio Intelligence V14 on port ${PORT}`);

  await send([
    `📊 <b>PORTFOLIO INTELLIGENCE V14 LIVE</b>`,
    ``,
    `📅 Monday 08:00 — Weekly market briefing`,
    `🗓️ 1st of month — Monthly snapshot`,
    `🚨 Any time — Drop -10% or pump +20% on your watchlist`,
    ``,
    `Running threshold check now...`
  ].join("
"));

  await safeRun("bootThresholds", checkThresholds);
  setInterval(scheduledCheck, CHECK_INTERVAL);
});
