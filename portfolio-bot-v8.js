// ================================================================
// PORTFOLIO BOT V10 — MONTHLY PIE MANAGER
// Trading 212 stock pie + Revolut crypto pie
// V10: Maximum quality filters for long-hold positions
//   Stocks: 1.2x vol min, positive 5d, +5% 20d, above trend averages
//   Crypto: 1.2x vol min, positive 5d, +8% 20d, above 10-day average
//   Pie size reduced to 4 assets each — best only
// ================================================================

console.log("🥧 PORTFOLIO BOT V10 STARTING...");

const fs    = require("fs");
const path  = require("path");
const axios = require("axios");
const express = require("express");

const app  = express();
const PORT = process.env.PORT || 3001;

app.get("/",       (_req, res) => res.status(200).send("PORTFOLIO BOT V10 alive"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ── Environment ──────────────────────────────────────────────────
const BOT_TOKEN             = process.env.BOT_TOKEN             || "";
const CHAT_ID               = process.env.CHAT_ID               || "";
const TWELVE_DATA_API_KEY   = process.env.TWELVE_DATA_API_KEY   || "";
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY || "";
const FINNHUB_API_KEY       = process.env.FINNHUB_API_KEY       || "";
const COINGECKO_API_KEY     = process.env.COINGECKO_API_KEY     || "";

// ── Budget ───────────────────────────────────────────────────────
const MONTHLY_BUDGET   = Number(process.env.MONTHLY_BUDGET || 200);
const STOCK_BUDGET     = Math.round(MONTHLY_BUDGET * 0.60); // £120
const CRYPTO_BUDGET    = Math.round(MONTHLY_BUDGET * 0.40); // £80
const PIE_SIZE_STOCKS  = 4; // V10: tighter — best 4 only
const PIE_SIZE_CRYPTO  = 4; // V10: tighter — best 4 only

// ── Schedule ─────────────────────────────────────────────────────
// Monthly review: 1st of month at 08:00 UTC
// Weekly swap check: every Monday at 08:00 UTC
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour, act on schedule

// ── Data dir ─────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PIE_FILE = path.join(DATA_DIR, "pie_state.json");

// ── Candidate pools ──────────────────────────────────────────────
const STOCK_CANDIDATES = [
  "NVDA", "PLTR", "AMD", "ASTS", "IONQ", "AVGO", "VRT", "MSFT",
  "META", "AMZN", "APP", "MSTR", "COIN", "CRWD", "ANET",
  "SMH",  "AMAT", "KLAC", "GEV",  "AVAV", "ETN",  "TSM",
  "ASML", "LRCX", "QQQ", "SMCI", "NEM",  "CCJ",  "OKLO", "SMR"
];

const CRYPTO_CANDIDATES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "RENDERUSDT", "NEARUSDT",
  "LINKUSDT", "AVAXUSDT", "SUIUSDT", "TONUSDT",   "ONDOUSDT",
  "FETUSDT",  "INJUSDT",  "TIAUSDT", "ARBUSDT",   "OPUSDT"
];

// ── Sector maps (shared with sniper logic) ───────────────────────
const SECTOR_SYMBOLS = {
  AI:       ["NVDA", "PLTR", "AMD", "SMCI", "MSFT", "META", "IONQ", "CRWD", "ANET"],
  GOLD:     ["NEM",  "GOLD", "AEM", "WPM",  "KGC"],
  CRYPTO:   ["COIN", "MSTR", "RIOT"],
  ENERGY:   ["XOM",  "CVX",  "SLB"],
  DEFENSE:  ["LMT",  "RTX",  "AVAV"],
  NUCLEAR:  ["CCJ",  "NNE",  "SMR", "OKLO"],
  ROBOTICS: ["ROK",  "ISRG", "TER"]
};

const CRYPTO_AI_NAMES = ["RENDERUSDT", "FETUSDT", "NEARUSDT", "TAOUSDT"];

// ── Narrative keywords ───────────────────────────────────────────
const NARRATIVE_KEYWORDS = {
  AI:       ["artificial intelligence", "ai chip", "machine learning", "gpu", "nvidia", "generative ai", "openai"],
  GOLD:     ["gold price", "gold rally", "bullion", "precious metals", "safe haven"],
  CRYPTO:   ["bitcoin", "ethereum", "crypto rally", "btc", "digital assets"],
  ENERGY:   ["oil price", "crude", "opec", "natural gas"],
  DEFENSE:  ["defense spending", "military", "nato", "geopolitical", "war"],
  NUCLEAR:  ["nuclear energy", "uranium", "small modular reactor", "smr"],
  ROBOTICS: ["robotics", "automation", "humanoid"]
};

// ── Utilities ────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function nowStr() {
  return new Date().toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

function escapeHtml(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function lines(parts) { return parts.filter(Boolean).join("\n"); }

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadPieState() {
  try { return JSON.parse(fs.readFileSync(PIE_FILE, "utf8")); }
  catch { return { stocks: [], crypto: [], lastMonthly: null, lastWeekly: null }; }
}

function savePieState(state) {
  ensureDir();
  fs.writeFileSync(PIE_FILE, JSON.stringify(state, null, 2));
}

// ── Telegram ─────────────────────────────────────────────────────
async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) { console.log(msg); return; }
  try {
    // Split long messages to avoid Telegram 4096 char limit
    const chunks = [];
    let current  = "";
    for (const line of msg.split("\n")) {
      if ((current + "\n" + line).length > 3800) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + "\n" + line : line;
      }
    }
    if (current) chunks.push(current);

    for (const chunk of chunks) {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID, text: chunk, parse_mode: "HTML"
      }, { timeout: 10000 });
      if (chunks.length > 1) await sleep(500);
    }
  } catch (e) { console.log("TELEGRAM ERROR:", e.message); }
}

// ── Retry ────────────────────────────────────────────────────────
async function retry(fn, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries) throw e;
      await sleep(delay * Math.pow(2, i));
    }
  }
}

// ── Fetch crypto candles (Binance) ───────────────────────────────
async function fetchCryptoCandles(symbol) {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/klines", {
        params: { symbol, interval: "1d", limit: 30 },
        timeout: 12000
      })
    );
    return data.map(k => ({
      close: +k[4], high: +k[2], low: +k[3], volume: +k[5]
    }));
  } catch { return null; }
}

// ── Fetch stock candles (TwelveData → Alpha Vantage) ─────────────
async function fetchStockCandles(symbol) {
  if (TWELVE_DATA_API_KEY) {
    try {
      const { data } = await retry(() =>
        axios.get("https://api.twelvedata.com/time_series", {
          params: {
            symbol, interval: "1day", outputsize: 30,
            order: "ASC", apikey: TWELVE_DATA_API_KEY
          },
          timeout: 15000
        })
      );
      if (data?.status !== "error" && Array.isArray(data?.values)) {
        return data.values.map(r => ({
          close: +r.close, high: +r.high, low: +r.low, volume: +r.volume
        })).filter(x => Number.isFinite(x.close));
      }
    } catch { /* fall through */ }
  }

  if (ALPHA_VANTAGE_API_KEY) {
    try {
      const { data } = await retry(() =>
        axios.get("https://www.alphavantage.co/query", {
          params: {
            function: "TIME_SERIES_DAILY", symbol,
            outputsize: "compact", apikey: ALPHA_VANTAGE_API_KEY
          },
          timeout: 15000
        })
      );
      const series = data["Time Series (Daily)"];
      if (!series) return null;
      return Object.entries(series)
        .sort(([a], [b]) => new Date(a) - new Date(b))
        .slice(-30)
        .map(([, v]) => ({
          close: +v["4. close"], high: +v["2. high"],
          low: +v["3. low"],    volume: +v["5. volume"]
        }))
        .filter(x => Number.isFinite(x.close));
    } catch { /* fall through */ }
  }

  return null;
}

// ── Fetch Finnhub quote (for change %) ───────────────────────────
async function fetchFinnhubQuote(symbol) {
  if (!FINNHUB_API_KEY) return null;
  try {
    const { data } = await retry(() =>
      axios.get("https://finnhub.io/api/v1/quote", {
        params: { symbol, token: FINNHUB_API_KEY },
        timeout: 8000
      })
    );
    return { changePct: data?.dp || 0, price: data?.c || 0 };
  } catch { return null; }
}

// ── Detect hot sectors from Finnhub news ─────────────────────────
async function detectHotSectors() {
  if (!FINNHUB_API_KEY) return [];
  try {
    const { data } = await retry(() =>
      axios.get("https://finnhub.io/api/v1/news", {
        params: { category: "general", token: FINNHUB_API_KEY },
        timeout: 12000
      })
    );
    if (!Array.isArray(data)) return [];
    const text = data.slice(0, 60)
      .map(n => ((n.headline || "") + " " + (n.summary || "")).toLowerCase())
      .join(" ");
    const scores = {};
    for (const [sector, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
      scores[sector] = keywords.filter(kw => text.includes(kw)).length;
    }
    return Object.entries(scores)
      .filter(([, s]) => s >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([sector]) => sector);
  } catch { return []; }
}

// ── Score a stock candidate ──────────────────────────────────────
const MIN_STOCK_VOL_RATIO  = 1.2;  // V10: raised from 1.0x
const MIN_STOCK_MOM5       = 0.0;  // must be positive on the week
const MIN_STOCK_MOM20      = 0.05; // must be up at least 5% over 20 days
const MIN_CRYPTO_VOL_RATIO = 1.2;  // V10: raised from 0.8x
const MIN_CRYPTO_MOM20     = 0.08; // must be up at least 8% over 20 days

function scoreStock(symbol, candles, quote, hotSectors) {
  if (!candles || candles.length < 10) return null;

  const closes  = candles.map(x => x.close);
  const volumes = candles.map(x => x.volume || 0);

  const last   = closes.at(-1);
  const prev5  = closes.at(-6);
  const prev20 = closes[0];

  if (!Number.isFinite(last) || !Number.isFinite(prev5) || prev5 <= 0 || prev20 <= 0) return null;

  const mom5  = (last - prev5)  / prev5;
  const mom20 = (last - prev20) / prev20;

  const avgVol     = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
  const currentVol = volumes.at(-1);
  const volRatio   = avgVol > 0 ? currentVol / avgVol : 1;

  // V10: Hard quality gates — all must pass for long-hold suitability
  if (volRatio < MIN_STOCK_VOL_RATIO) {
    console.log(`❌ ${symbol} rejected — vol ${volRatio.toFixed(2)}x < ${MIN_STOCK_VOL_RATIO}x`);
    return null;
  }
  if (mom5 < MIN_STOCK_MOM5) {
    console.log(`❌ ${symbol} rejected — negative 5d momentum (${(mom5*100).toFixed(1)}%)`);
    return null;
  }
  if (mom20 < MIN_STOCK_MOM20) {
    console.log(`❌ ${symbol} rejected — 20d momentum too weak (${(mom20*100).toFixed(1)}% < ${MIN_STOCK_MOM20*100}%)`);
    return null;
  }

  // Must be above both 10-day and 20-day average — confirmed uptrend
  const avg10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const avg20 = closes.reduce((a, b) => a + b, 0) / closes.length;
  if (last < avg10 || last < avg20) {
    console.log(`❌ ${symbol} rejected — below trend averages`);
    return null;
  }
  const aboveTrend = true; // already confirmed above

  let score = 50;

  // Momentum scoring
  if (mom5 > 0.05) score += 15;
  else if (mom5 > 0.02) score += 10;
  else if (mom5 > 0)    score += 5;
  else score -= 10;

  if (mom20 > 0.10) score += 10;
  else if (mom20 > 0.05) score += 6;
  else if (mom20 > 0)    score += 3;
  else score -= 5;

  // Volume
  if (volRatio > 1.5) score += 8;
  else if (volRatio > 1.2) score += 4;

  // Trend
  if (aboveTrend) score += 6;

  // Recent change % from Finnhub
  if (quote && quote.changePct > 3)  score += 8;
  if (quote && quote.changePct > 0)  score += 3;
  if (quote && quote.changePct < -3) score -= 8;

  // Narrative bonus
  const sym = symbol.replace("USDT", "");
  for (const sector of hotSectors) {
    if ((SECTOR_SYMBOLS[sector] || []).includes(sym)) {
      score += 8;
      console.log(`🔥 Narrative +8 for ${symbol} (${sector})`);
      break;
    }
  }

  return {
    symbol,
    score: Math.round(score),
    mom5:  +(mom5  * 100).toFixed(1),
    mom20: +(mom20 * 100).toFixed(1),
    volRatio: +volRatio.toFixed(2),
    price: last
  };
}

// ── Score a crypto candidate ─────────────────────────────────────
function scoreCrypto(symbol, candles, hotSectors) {
  if (!candles || candles.length < 10) return null;

  const closes  = candles.map(x => x.close);
  const volumes = candles.map(x => x.volume || 0);

  const last   = closes.at(-1);
  const prev5  = closes.at(-6);
  const prev20 = closes[0];

  if (!Number.isFinite(last) || !Number.isFinite(prev5) || prev5 <= 0 || prev20 <= 0) return null;

  const mom5  = (last - prev5)  / prev5;
  const mom20 = (last - prev20) / prev20;

  const avgVol     = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
  const currentVol = volumes.at(-1);
  const volRatio   = avgVol > 0 ? currentVol / avgVol : 1;

  // V10: Hard quality gates for long-hold crypto
  if (volRatio < MIN_CRYPTO_VOL_RATIO) {
    console.log(`❌ ${symbol} rejected — vol ${volRatio.toFixed(2)}x < ${MIN_CRYPTO_VOL_RATIO}x`);
    return null;
  }
  if (mom5 < 0) {
    console.log(`❌ ${symbol} rejected — negative 5d momentum (${(mom5*100).toFixed(1)}%)`);
    return null;
  }
  if (mom20 < MIN_CRYPTO_MOM20) {
    console.log(`❌ ${symbol} rejected — 20d momentum too weak (${(mom20*100).toFixed(1)}% < ${MIN_CRYPTO_MOM20*100}%)`);
    return null;
  }

  // Must be above 10-day average
  const avg10      = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const aboveTrend = last > avg10;
  if (!aboveTrend) {
    console.log(`❌ ${symbol} rejected — below 10-day average`);
    return null;
  }

  let score = 50;

  if (mom5 > 0.08)  score += 15;
  else if (mom5 > 0.03) score += 10;
  else if (mom5 > 0)    score += 5;
  else score -= 10;

  if (mom20 > 0.15) score += 10;
  else if (mom20 > 0.08) score += 6;
  else if (mom20 > 0)    score += 3;
  else score -= 5;

  if (volRatio > 1.5) score += 8;
  else if (volRatio > 1.2) score += 4;

  if (aboveTrend) score += 6;

  // AI narrative bonus for AI crypto names
  if (hotSectors.includes("AI") && CRYPTO_AI_NAMES.includes(symbol)) {
    score += 10;
    console.log(`🤖 AI narrative +10 for ${symbol}`);
  }

  // Crypto narrative (BTC/ETH always relevant)
  if (hotSectors.includes("CRYPTO") && ["BTCUSDT", "ETHUSDT"].includes(symbol)) {
    score += 6;
  }

  return {
    symbol,
    score: Math.round(score),
    mom5:  +(mom5  * 100).toFixed(1),
    mom20: +(mom20 * 100).toFixed(1),
    volRatio: +volRatio.toFixed(2),
    price: last
  };
}

// ── Concurrency helper ───────────────────────────────────────────
async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results.filter(Boolean);
}

// ── Build pie allocations ────────────────────────────────────────
function buildAllocations(ranked, size) {
  const top = ranked.slice(0, size);
  const totalScore = top.reduce((sum, x) => sum + x.score, 0);
  return top.map(x => ({
    ...x,
    pct: Math.round((x.score / totalScore) * 100)
  }));
}

// ── Format GBP ──────────────────────────────────────────────────
function gbp(amount) {
  return `\u00a3${amount.toFixed(2)}`;
}

// ── Monthly pie message ──────────────────────────────────────────
function buildMonthlyMessage(stockPie, cryptoPie, hotSectors) {
  const parts = [
    "\uD83E\uDD67 <b>MONTHLY PIE UPDATE</b>",
    `<i>${nowStr()}</i>`,
    ""
  ];

  if (hotSectors.length > 0) {
    parts.push(`\uD83E\uDDE0 Active narratives: <b>${escapeHtml(hotSectors.join(", "))}</b>`);
    parts.push("");
  }

  // Stock pie
  parts.push("\uD83C\uDDFA\uD83C\uDDF8 <b>Trading 212 — Stock Pie</b>");
  parts.push(`Budget this month: <b>${gbp(STOCK_BUDGET)}</b>`);
  parts.push("");
  parts.push("<b>What to do:</b> Open Trading 212 \u2192 Your pie \u2192 Edit holdings to match these:");
  parts.push("");

  for (const h of stockPie) {
    const amount = gbp((h.pct / 100) * STOCK_BUDGET);
    const trend  = h.mom5 >= 0 ? "\uD83D\uDCC8" : "\uD83D\uDCC9";
    parts.push(
      `${trend} <b>${escapeHtml(h.symbol)}</b> \u2014 ${h.pct}% \u2248 ${amount}` +
      `\n   5d: ${h.mom5 > 0 ? "+" : ""}${h.mom5}% \u2022 20d: ${h.mom20 > 0 ? "+" : ""}${h.mom20}% \u2022 Vol: ${h.volRatio}x`
    );
  }

  parts.push("");
  parts.push("\uD83D\uDCA1 <b>How to set it up:</b>");
  parts.push("1\uFE0F\u20E3 Open Trading 212 app");
  parts.push("2\uFE0F\u20E3 Go to your pie or create a new one");
  parts.push("3\uFE0F\u20E3 Add each stock above and set the % shown");
  parts.push("4\uFE0F\u20E3 Deposit " + gbp(STOCK_BUDGET) + " and let it auto-invest");
  parts.push("");

  // Crypto pie
  parts.push("\uD83E\uDE99 <b>Revolut — Crypto Pie</b>");
  parts.push(`Budget this month: <b>${gbp(CRYPTO_BUDGET)}</b>`);
  parts.push("");
  parts.push("<b>What to do:</b> Open Revolut \u2192 Crypto \u2192 Buy each coin in these amounts:");
  parts.push("");

  for (const h of cryptoPie) {
    const sym    = h.symbol.replace("USDT", "");
    const amount = gbp((h.pct / 100) * CRYPTO_BUDGET);
    const trend  = h.mom5 >= 0 ? "\uD83D\uDCC8" : "\uD83D\uDCC9";
    parts.push(
      `${trend} <b>${escapeHtml(sym)}</b> \u2014 ${h.pct}% \u2248 ${amount}` +
      `\n   5d: ${h.mom5 > 0 ? "+" : ""}${h.mom5}% \u2022 20d: ${h.mom20 > 0 ? "+" : ""}${h.mom20}% \u2022 Vol: ${h.volRatio}x`
    );
  }

  parts.push("");
  parts.push("\uD83D\uDCA1 <b>How to buy:</b>");
  parts.push("1\uFE0F\u20E3 Open Revolut app");
  parts.push("2\uFE0F\u20E3 Go to Crypto section");
  parts.push("3\uFE0F\u20E3 Buy each coin above with the \u00a3 amount shown");
  parts.push("4\uFE0F\u20E3 That\u2019s it \u2014 check back next month for the review");
  parts.push("");
  parts.push("\u23F0 Next check: in 7 days for swap review");

  return lines(parts);
}

// ── Weekly swap check message ────────────────────────────────────
function buildSwapMessage(currentStocks, currentCrypto, newStockRanked, newCryptoRanked) {
  const parts = [
    "\uD83D\uDD04 <b>WEEKLY SWAP REVIEW</b>",
    `<i>${nowStr()}</i>`,
    ""
  ];

  let swapsFound = false;

  // Stock swaps
  const currentStockSymbols = currentStocks.map(x => x.symbol);
  const stockSwaps = [];

  for (const holding of currentStocks) {
    const refreshed = newStockRanked.find(x => x.symbol === holding.symbol);
    const refreshedScore = refreshed ? refreshed.score : 0;

    // Find a better candidate not already in the pie
    const better = newStockRanked.find(x =>
      !currentStockSymbols.includes(x.symbol) &&
      x.score >= refreshedScore + 15
    );

    if (better) {
      stockSwaps.push({ out: holding, in: better, outScore: refreshedScore });
      swapsFound = true;
    }
  }

  if (stockSwaps.length > 0) {
    parts.push("\uD83C\uDDFA\uD83C\uDDF8 <b>Trading 212 — Suggested Stock Swaps</b>");
    parts.push("");
    for (const sw of stockSwaps.slice(0, 2)) {
      parts.push(
        `\uD83D\uDD34 <b>REMOVE</b> ${escapeHtml(sw.out.symbol)} \u2014 momentum fading (score: ${sw.outScore})`
      );
      parts.push(
        `\uD83D\uDFE2 <b>ADD</b> ${escapeHtml(sw.in.symbol)} \u2014 stronger now (score: ${sw.in.score}, 5d: ${sw.in.mom5 > 0 ? "+" : ""}${sw.in.mom5}%)`
      );
      parts.push(
        `\uD83D\uDCA1 Go to Trading 212 \u2192 Your pie \u2192 Remove ${escapeHtml(sw.out.symbol)}, add ${escapeHtml(sw.in.symbol)} at ${sw.out.pct}%`
      );
      parts.push("");
    }
  } else {
    parts.push("\uD83C\uDDFA\uD83C\uDDF8 <b>Stock Pie</b> \u2014 \u2705 All holdings look solid. No swaps needed.");
    parts.push("");
  }

  // Crypto swaps
  const currentCryptoSymbols = currentCrypto.map(x => x.symbol);
  const cryptoSwaps = [];

  for (const holding of currentCrypto) {
    const refreshed = newCryptoRanked.find(x => x.symbol === holding.symbol);
    const refreshedScore = refreshed ? refreshed.score : 0;

    const better = newCryptoRanked.find(x =>
      !currentCryptoSymbols.includes(x.symbol) &&
      x.score >= refreshedScore + 15
    );

    if (better) {
      cryptoSwaps.push({ out: holding, in: better, outScore: refreshedScore });
      swapsFound = true;
    }
  }

  if (cryptoSwaps.length > 0) {
    parts.push("\uD83E\uDE99 <b>Revolut — Suggested Crypto Swaps</b>");
    parts.push("");
    for (const sw of cryptoSwaps.slice(0, 2)) {
      const outSym = sw.out.symbol.replace("USDT", "");
      const inSym  = sw.in.symbol.replace("USDT", "");
      parts.push(
        `\uD83D\uDD34 <b>SELL</b> ${escapeHtml(outSym)} \u2014 momentum fading (score: ${sw.outScore})`
      );
      parts.push(
        `\uD83D\uDFE2 <b>BUY</b> ${escapeHtml(inSym)} \u2014 stronger now (score: ${sw.in.score}, 5d: ${sw.in.mom5 > 0 ? "+" : ""}${sw.in.mom5}%)`
      );
      parts.push(
        `\uD83D\uDCA1 Go to Revolut \u2192 Crypto \u2192 Sell your ${escapeHtml(outSym)}, buy ${escapeHtml(inSym)} with the proceeds`
      );
      parts.push("");
    }
  } else {
    parts.push("\uD83E\uDE99 <b>Crypto Pie</b> \u2014 \u2705 All holdings look solid. No swaps needed.");
    parts.push("");
  }

  if (!swapsFound) {
    parts.push("\uD83D\uDCAA Everything holding up well. Stay the course.");
  }

  parts.push("\u23F0 Next monthly picks: 1st of next month");

  return lines(parts);
}

// ── Core: score all candidates ───────────────────────────────────
async function scoreAllStocks(hotSectors) {
  console.log(`📊 Scoring ${STOCK_CANDIDATES.length} stock candidates...`);
  const scored = [];
  await mapWithConcurrency(STOCK_CANDIDATES, 3, async sym => {
    const [candles, quote] = await Promise.all([
      fetchStockCandles(sym),
      fetchFinnhubQuote(sym)
    ]);
    const result = scoreStock(sym, candles, quote, hotSectors);
    if (result) {
      scored.push(result);
      console.log(`  ${sym}: score=${result.score} mom5=${result.mom5}%`);
    }
    await sleep(300); // rate limit buffer
  });
  return scored.sort((a, b) => b.score - a.score);
}

async function scoreAllCrypto(hotSectors) {
  console.log(`🪙 Scoring ${CRYPTO_CANDIDATES.length} crypto candidates...`);
  const scored = [];
  await mapWithConcurrency(CRYPTO_CANDIDATES, 4, async sym => {
    const candles = await fetchCryptoCandles(sym);
    const result  = scoreCrypto(sym, candles, hotSectors);
    if (result) {
      scored.push(result);
      console.log(`  ${sym}: score=${result.score} mom5=${result.mom5}%`);
    }
  });
  return scored.sort((a, b) => b.score - a.score);
}

// ── Monthly review ───────────────────────────────────────────────
async function runMonthlyReview() {
  console.log("🥧 Running monthly pie review...");

  const hotSectors = await detectHotSectors();
  console.log("🧠 Hot sectors:", hotSectors.join(", ") || "none");

  const [stockRanked, cryptoRanked] = await Promise.all([
    scoreAllStocks(hotSectors),
    scoreAllCrypto(hotSectors)
  ]);

  const stockPie  = buildAllocations(stockRanked,  PIE_SIZE_STOCKS);
  const cryptoPie = buildAllocations(cryptoRanked, PIE_SIZE_CRYPTO);

  console.log("📈 Stock pie:", stockPie.map(x => `${x.symbol}(${x.pct}%)`).join(", "));
  console.log("🪙 Crypto pie:", cryptoPie.map(x => `${x.symbol.replace("USDT","")}(${x.pct}%)`).join(", "));

  const state = loadPieState();
  state.stocks      = stockPie;
  state.crypto      = cryptoPie;
  state.lastMonthly = new Date().toISOString();
  savePieState(state);

  const msg = buildMonthlyMessage(stockPie, cryptoPie, hotSectors);
  await send(msg);
}

// ── Weekly swap check ────────────────────────────────────────────
async function runWeeklySwapCheck() {
  const state = loadPieState();
  if (!state.stocks.length && !state.crypto.length) {
    console.log("No pie state yet — running monthly review first");
    await runMonthlyReview();
    return;
  }

  console.log("🔄 Running weekly swap check...");

  const hotSectors = await detectHotSectors();

  const [stockRanked, cryptoRanked] = await Promise.all([
    scoreAllStocks(hotSectors),
    scoreAllCrypto(hotSectors)
  ]);

  const msg = buildSwapMessage(state.stocks, state.crypto, stockRanked, cryptoRanked);
  await send(msg);

  state.lastWeekly = new Date().toISOString();
  savePieState(state);
}

// ── Schedule logic ───────────────────────────────────────────────
function isFirstOfMonth() {
  const now = new Date();
  return now.getUTCDate() === 1 && now.getUTCHours() === 8 && now.getUTCMinutes() < 60;
}

function isMonday8am() {
  const now = new Date();
  return now.getUTCDay() === 1 && now.getUTCHours() === 8 && now.getUTCMinutes() < 60;
}

function shouldRunMonthly(state) {
  if (!state.lastMonthly) return true;
  const last = new Date(state.lastMonthly);
  const now  = new Date();
  return isFirstOfMonth() &&
    (now.getUTCFullYear() > last.getUTCFullYear() ||
     now.getUTCMonth()    > last.getUTCMonth());
}

function shouldRunWeekly(state) {
  if (!state.lastWeekly) return isMonday8am();
  const last    = new Date(state.lastWeekly);
  const now     = new Date();
  const daysDiff = (now - last) / (1000 * 60 * 60 * 24);
  return isMonday8am() && daysDiff >= 6;
}

async function scheduledCheck() {
  const state = loadPieState();

  if (shouldRunMonthly(state)) {
    await runMonthlyReview();
    return;
  }

  if (shouldRunWeekly(state)) {
    await runWeeklySwapCheck();
    return;
  }

  console.log(`Portfolio bot idle — next monthly: 1st of month 08:00 UTC | next weekly: Monday 08:00 UTC`);
}

// ── Boot ─────────────────────────────────────────────────────────
ensureDir();

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`🥧 Portfolio Bot V10 health server on port ${PORT}`);
  await send(
    "\uD83E\uDD67 <b>PORTFOLIO BOT V10 LIVE</b>\n" +
    "Maximum quality filters active \u2022 4 picks per pie\n" +
    "Stocks: 1.2x vol \u2022 +5% 20d min \u2022 above trend\n" +
    "Crypto: 1.2x vol \u2022 +8% 20d min \u2022 above trend\n\n" +
    `Budget: ${gbp(STOCK_BUDGET)} stocks \u2022 ${gbp(CRYPTO_BUDGET)} crypto per month\n` +
    "Running initial pie review now..."
  );

  // Run immediately on boot so you get picks straight away
  await runMonthlyReview();

  // Then check hourly whether schedule triggers
  setInterval(scheduledCheck, CHECK_INTERVAL_MS);
});
