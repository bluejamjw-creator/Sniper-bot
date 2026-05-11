// ================================================================
// PORTFOLIO INTELLIGENCE BOT V14
// Clean intelligence + threshold alerts only
// ------------------------------------------------
// Monday 08:00 UK  — Weekly market briefing
// 1st of month     — Monthly portfolio snapshot
// Any time         — Threshold alerts (-10% / +20%)
// ================================================================

console.log("📊 PORTFOLIO INTELLIGENCE BOT V14 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");

process.on("unhandledRejection", err => {
  console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", err => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

axios.defaults.timeout = 15000;

const app = express();
const PORT = process.env.PORT || 3001;

// ── Health ───────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.status(200).send("PORTFOLIO INTELLIGENCE V14 alive");
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    uptime: process.uptime()
  });
});

// ── Environment ──────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";

// ── Storage ──────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

const STATE_FILE = path.join(DATA_DIR, "intel_state.json");
const ALERT_FILE = path.join(DATA_DIR, "alert_state.json");

// ── Watchlists ──────────────────────────────────────────────────
const WATCH_CRYPTO = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "SUIUSDT",
  "ONDOUSDT",
  "TIAUSDT",
  "INJUSDT",
  "OPUSDT",
  "ARBUSDT",
  "RENDERUSDT"
];

const WATCH_STOCKS = [
  "NVDA",
  "PLTR",
  "AMD",
  "ASTS",
  "SMH",
  "ASML",
  "VRT",
  "APP"
];

// ── Sector maps ──────────────────────────────────────────────────
const SECTOR_SYMBOLS = {
  AI: ["NVDA","PLTR","AMD","MSFT","META","IONQ"],
  CRYPTO: ["COIN","MSTR","RIOT"],
  DEFENSE: ["LMT","RTX","NOC","AVAV"],
  ENERGY: ["XOM","CVX","SLB"],
  NUCLEAR: ["CCJ","SMR","OKLO"]
};

const NARRATIVE_KEYWORDS = {
  AI: [
    "artificial intelligence",
    "ai chip",
    "machine learning",
    "gpu",
    "nvidia"
  ],

  CRYPTO: [
    "bitcoin",
    "ethereum",
    "crypto rally",
    "digital assets"
  ],

  DEFENSE: [
    "defense spending",
    "military",
    "nato"
  ],

  ENERGY: [
    "oil price",
    "crude",
    "opec"
  ],

  NUCLEAR: [
    "nuclear energy",
    "uranium",
    "small modular reactor"
  ]
};

// ── Thresholds ───────────────────────────────────────────────────
const THRESHOLD_DROP = -0.10;
const THRESHOLD_PUMP = 0.20;

const CHECK_INTERVAL = 60 * 60 * 1000;

// ── Utils ────────────────────────────────────────────────────────
function nowIso() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[${nowIso()}]`, ...args);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function escH(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function loadState() {
  return loadJson(STATE_FILE, {
    lastWeekly: null,
    lastMonthly: null
  });
}

function saveState(state) {
  saveJson(STATE_FILE, state);
}

function loadAlertState() {
  return loadJson(ALERT_FILE, {});
}

function saveAlertState(state) {
  saveJson(ALERT_FILE, state);
}

function getUkParts() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour12: false
  });

  const map = {};

  for (const p of fmt.formatToParts(new Date())) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }

  return map;
}

function isWeekend() {
  const d = getUkParts().weekday;
  return d === "Sat" || d === "Sun";
}

function isMonday8am() {
  const p = getUkParts();

  return (
    p.weekday === "Mon" &&
    Number(p.hour) === 8
  );
}

function isFirstOfMonth8am() {
  const p = getUkParts();

  return (
    Number(p.day) === 1 &&
    Number(p.hour) === 8
  );
}

function ukDateKey() {
  const p = getUkParts();

  return `${p.year}-${p.month}-${p.day}`;
}

async function retry(fn, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries) {
        throw e;
      }

      await sleep(delay * Math.pow(2, i));
    }
  }
}

async function safeRun(name, fn) {
  try {
    return await fn();
  } catch (e) {
    log(`ERROR (${name}):`, e?.message || e);
    return null;
  }
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

    for (const line of msg.split("\n")) {

      if ((cur + "\n" + line).length > 3800) {
        chunks.push(cur);
        cur = line;
      } else {
        cur = cur
          ? cur + "\n" + line
          : line;
      }
    }

    if (cur) {
      chunks.push(cur);
    }

    for (const chunk of chunks) {

      await retry(() =>
        axios.post(
          `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          {
            chat_id: CHAT_ID,
            text: chunk,
            parse_mode: "HTML"
          },
          {
            timeout: 10000
          }
        )
      );

      if (chunks.length > 1) {
        await sleep(500);
      }
    }

  } catch (e) {
    log("TELEGRAM ERROR:", e.message);
  }
}

// ── Data ─────────────────────────────────────────────────────────
async function fetchBinance24hr(symbols) {

  try {

    const { data } = await retry(() =>
      axios.get(
        "https://data-api.binance.vision/api/v3/ticker/24hr"
      )
    );

    if (!Array.isArray(data)) {
      return {};
    }

    const result = {};

    for (const t of data) {

      if (symbols.includes(t.symbol)) {

        result[t.symbol] = {
          pct24: +t.priceChangePercent / 100,
          price: +t.lastPrice
        };
      }
    }

    return result;

  } catch {
    return {};
  }
}

async function fetchFinnhubQuote(symbol) {

  if (!FINNHUB_API_KEY) {
    return null;
  }

  try {

    const { data } = await retry(() =>
      axios.get(
        "https://finnhub.io/api/v1/quote",
        {
          params: {
            symbol,
            token: FINNHUB_API_KEY
          }
        }
      )
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

  if (!FINNHUB_API_KEY) {
    return [];
  }

  try {

    const { data } = await retry(() =>
      axios.get(
        "https://finnhub.io/api/v1/news",
        {
          params: {
            category: "general",
            token: FINNHUB_API_KEY
          }
        }
      )
    );

    if (!Array.isArray(data)) {
      return [];
    }

    const text = data
      .slice(0, 60)
      .map(n =>
        (
          (n.headline || "") +
          " " +
          (n.summary || "")
        ).toLowerCase()
      )
      .join(" ");

    const scores = {};

    for (const [sector, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {

      scores[sector] = keywords.filter(
        kw => text.includes(kw)
      ).length;
    }

    return Object
      .entries(scores)
      .filter(([, s]) => s >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([s]) => s);

  } catch {
    return [];
  }
}

// ── Alerts ───────────────────────────────────────────────────────
function alertKey(symbol, type) {
  return `${ukDateKey()}_${symbol}_${type}`;
}

async function checkThresholds() {

  const alertState = loadAlertState();

  // Crypto
  const cryptoData = await fetchBinance24hr(WATCH_CRYPTO);

  for (const [symbol, d] of Object.entries(cryptoData)) {

    const sym = symbol.replace("USDT", "");
    const pct = d.pct24 * 100;

    const dropKey = alertKey(symbol, "DROP");
    const pumpKey = alertKey(symbol, "PUMP");

    if (d.pct24 <= THRESHOLD_DROP) {

      if (!alertState[dropKey]) {

        await send([
          `🚨 <b>PORTFOLIO ALERT — DROP</b>`,
          ``,
          `📉 <b>${escH(sym)}</b> is down <b>${pct.toFixed(1)}%</b> today`,
          `💵 Price: $${d.price.toFixed(4)}`
        ].join("\n"));

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
          `💵 Price: $${d.price.toFixed(4)}`
        ].join("\n"));

        alertState[pumpKey] = nowIso();
      }

    } else {
      delete alertState[pumpKey];
    }
  }

  // Stocks
  if (!isWeekend()) {

    for (const sym of WATCH_STOCKS) {

      const q = await safeRun(
        `quote_${sym}`,
        () => fetchFinnhubQuote(sym)
      );

      if (!q) {
        continue;
      }

      const pct = q.pct;

      const dropKey = alertKey(sym, "DROP");
      const pumpKey = alertKey(sym, "PUMP");

      if (pct <= THRESHOLD_DROP * 100) {

        if (!alertState[dropKey]) {

          await send([
            `🚨 <b>PORTFOLIO ALERT — DROP</b>`,
            ``,
            `📉 <b>${escH(sym)}</b> is down <b>${pct.toFixed(1)}%</b> today`,
            `💵 Price: $${q.price.toFixed(2)}`
          ].join("\n"));

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
            `💵 Price: $${q.price.toFixed(2)}`
          ].join("\n"));

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

  const parts = [
    `📊 <b>WEEKLY MARKET BRIEFING</b>`,
    `<i>${new Date().toLocaleDateString(
      "en-GB",
      {
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric"
      }
    )}</i>`,
    ``
  ];

  if (hotSectors.length > 0) {

    parts.push(`🧠 <b>Active narratives:</b>`);

    for (const s of hotSectors) {

      const syms = (
        SECTOR_SYMBOLS[s] || []
      ).slice(0, 4).join(", ");

      parts.push(
        `• ${escH(s)} → ${escH(syms)}`
      );
    }

    parts.push(``);
  }

  parts.push(
    `💡 Use this in ChatGPT or Claude for portfolio review`
  );

  await send(parts.join("\n"));

  log("✅ Weekly briefing sent");
}

// ── Monthly snapshot ─────────────────────────────────────────────
async function sendMonthlySnapshot() {

  log("📅 Monthly snapshot...");

  const cryptoData = await fetchBinance24hr(
    WATCH_CRYPTO
  );

  const parts = [
    `📅 <b>MONTHLY PORTFOLIO SNAPSHOT</b>`,
    `<i>${new Date().toLocaleDateString(
      "en-GB",
      {
        day: "2-digit",
        month: "long",
        year: "numeric"
      }
    )}</i>`,
    ``
  ];

  const cryptoPerf = Object.entries(cryptoData)
    .map(([sym, d]) => ({
      sym: sym.replace("USDT", ""),
      pct: d.pct24 * 100
    }))
    .sort((a, b) => b.pct - a.pct);

  if (cryptoPerf.length > 0) {

    parts.push(`🪙 <b>Crypto watchlist:</b>`);

    for (const c of cryptoPerf) {

      const e =
        c.pct >= 5 ? "📈" :
        c.pct <= -5 ? "📉" :
        "↔️";

      parts.push(
        `${e} <b>${escH(c.sym)}</b> ${c.pct > 0 ? "+" : ""}${c.pct.toFixed(1)}%`
      );
    }
  }

  await send(parts.join("\n"));

  log("✅ Monthly snapshot sent");
}

// ── Scheduler ────────────────────────────────────────────────────
async function scheduledCheck() {

  const state = loadState();
  const now = new Date();

  if (isMonday8am()) {

    const last = state.lastWeekly
      ? new Date(state.lastWeekly)
      : null;

    const daysSince = last
      ? (now - last) / 86400000
      : 999;

    if (daysSince >= 6) {

      await safeRun(
        "weekly",
        sendWeeklyBriefing
      );

      state.lastWeekly = now.toISOString();

      saveState(state);

      return;
    }
  }

  if (isFirstOfMonth8am()) {

    const last = state.lastMonthly
      ? new Date(state.lastMonthly)
      : null;

    const sameMonth =
      last &&
      last.getUTCMonth() === now.getUTCMonth() &&
      last.getUTCFullYear() === now.getUTCFullYear();

    if (!sameMonth) {

      await safeRun(
        "monthly",
        sendMonthlySnapshot
      );

      state.lastMonthly = now.toISOString();

      saveState(state);

      return;
    }
  }

  await safeRun(
    "thresholds",
    checkThresholds
  );
}

// ── Boot ─────────────────────────────────────────────────────────
ensureDir();

app.listen(PORT, "0.0.0.0", async () => {

  log(`📊 Portfolio Intelligence V14 running on ${PORT}`);

  await send([
    `📊 <b>PORTFOLIO INTELLIGENCE V14 LIVE</b>`,
    ``,
    `📅 Monday 08:00 — Weekly briefing`,
    `🗓️ 1st of month — Monthly snapshot`,
    `🚨 Live threshold alerts active`,
    ``,
    `Running startup check...`
  ].join("\n"));

  await safeRun(
    "startup_thresholds",
    checkThresholds
  );

  setInterval(
    scheduledCheck,
    CHECK_INTERVAL
  );
});
