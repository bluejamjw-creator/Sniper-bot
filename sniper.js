const fs = require("fs");
const path = require("path");
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DATA_DIR = process.env.DATA_DIR || ".";
const SIGNAL_FILE = path.join(DATA_DIR, "signals.json");

const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || "";
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";
const NEWSAPI_KEY = process.env.NEWSAPI_KEY || "";
const THENEWSAPI_KEY = process.env.THENEWSAPI_KEY || "";
const NEWSDATA_KEY = process.env.NEWSDATA_KEY || "";

const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 72);
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 1800);
const MAX_ALERTS_PER_SCAN = Number(process.env.MAX_ALERTS_PER_SCAN || 3);
const ASSET_COOLDOWN_HOURS = Number(process.env.ASSET_COOLDOWN_HOURS || 8);

const WATCHLIST = {
  stocks: ["SMH", "EQQQ.L", "PLTR", "AMD", "APP", "MSTR", "COIN", "ASTS", "SOUN"],
  crypto: ["SOL", "ETH", "FET", "RNDR"]
};

const CRYPTO_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  FET: "fetch-ai",
  RNDR: "render-token"
};

let shuttingDown = false;
let timer = null;

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(SIGNAL_FILE)) {
  fs.writeFileSync(SIGNAL_FILE, "[]\n", "utf8");
}

function londonTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date()).replace(",", "") + " UK";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("Missing BOT_TOKEN or CHAT_ID");
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: String(msg),
        disable_web_page_preview: true
      },
      { timeout: 20000 }
    );
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

function loadSignals() {
  try {
    const raw = fs.readFileSync(SIGNAL_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSignals(signals) {
  fs.writeFileSync(SIGNAL_FILE, JSON.stringify(signals, null, 2) + "\n", "utf8");
}

function normalize(asset) {
  return String(asset || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/USDT$/, "")
    .replace(/^RENDER$/, "RNDR");
}

function signalKey(signal) {
  return [
    normalize(signal.asset),
    Number(signal.entry),
    Number(signal.sl),
    Number(signal.tp)
  ].join("|");
}

function isDuplicate(newSignal, signals) {
  const now = Date.now();
  return signals.some((s) => {
    const sameKey = signalKey(s) === signalKey(newSignal);
    const recent = now - Number(s.time || 0) < 60 * 60 * 1000;
    return sameKey && recent;
  });
}

function isOnCooldown(asset, signals) {
  const now = Date.now();
  const cutoff = ASSET_COOLDOWN_HOURS * 60 * 60 * 1000;
  return signals.some((s) => normalize(s.asset) === normalize(asset) && now - Number(s.time || 0) < cutoff);
}

function summariseSeries(symbol, closes, source) {
  if (!Array.isArray(closes)) return null;
  const clean = closes.filter((x) => Number.isFinite(x));
  if (clean.length < 30) return null;

  const last20 = clean.slice(-20);
  return {
    symbol,
    source,
    closes: clean,
    last: clean[clean.length - 1],
    prev: clean[clean.length - 2],
    high20: Math.max(...last20),
    low20: Math.min(...last20),
    sma20: last20.reduce((a, b) => a + b, 0) / last20.length
  };
}

async function fetchStockYahoo(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
    const { data } = await axios.get(url, { timeout: 20000 });
    const result = data?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    return summariseSeries(symbol, closes, "Yahoo");
  } catch (e) {
    console.log(`Yahoo failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchStockStooq(symbol) {
  try {
    const s = symbol.toLowerCase();
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`;
    const { data } = await axios.get(url, { timeout: 20000 });
    const lines = String(data).trim().split("\n");
    const closes = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      const close = Number(parts[4]);
      if (Number.isFinite(close)) closes.push(close);
    }

    return summariseSeries(symbol, closes, "Stooq");
  } catch (e) {
    console.log(`Stooq failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchStockAlpha(symbol) {
  if (!ALPHA_VANTAGE_KEY) return null;

  try {
    const { data } = await axios.get("https://www.alphavantage.co/query", {
      params: {
        function: "TIME_SERIES_DAILY",
        symbol,
        outputsize: "compact",
        apikey: ALPHA_VANTAGE_KEY
      },
      timeout: 20000
    });

    const series = data?.["Time Series (Daily)"];
    if (!series) return null;

    const closes = Object.keys(series)
      .sort()
      .map((d) => Number(series[d]["4. close"]))
      .filter((x) => Number.isFinite(x));

    return summariseSeries(symbol, closes, "Alpha Vantage");
  } catch (e) {
    console.log(`Alpha Vantage failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchStockFinnhub(symbol) {
  if (!FINNHUB_KEY) return null;

  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 90 * 24 * 60 * 60;

    const { data } = await axios.get("https://finnhub.io/api/v1/stock/candle", {
      params: {
        symbol,
        resolution: "D",
        from,
        to,
        token: FINNHUB_KEY
      },
      timeout: 20000
    });

    if (data?.s !== "ok") return null;
    return summariseSeries(symbol, data.c || [], "Finnhub");
  } catch (e) {
    console.log(`Finnhub failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchStockMarket(symbol) {
  return (
    await fetchStockYahoo(symbol) ||
    await fetchStockStooq(symbol) ||
    await fetchStockAlpha(symbol) ||
    await fetchStockFinnhub(symbol)
  );
}

async function fetchCryptoCoinGecko(symbol) {
  const id = CRYPTO_IDS[normalize(symbol)];
  if (!id) return null;

  try {
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${id}/market_chart`,
      {
        params: { vs_currency: "usd", days: 90, interval: "daily" },
        timeout: 20000
      }
    );

    const closes = (data?.prices || [])
      .map((p) => Number(p[1]))
      .filter((x) => Number.isFinite(x));

    return summariseSeries(symbol, closes, "CoinGecko");
  } catch (e) {
    console.log(`CoinGecko failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchCryptoAlpha(symbol) {
  if (!ALPHA_VANTAGE_KEY) return null;

  try {
    const { data } = await axios.get("https://www.alphavantage.co/query", {
      params: {
        function: "DIGITAL_CURRENCY_DAILY",
        symbol: normalize(symbol),
        market: "USD",
        apikey: ALPHA_VANTAGE_KEY
      },
      timeout: 20000
    });

    const series = data?.["Time Series (Digital Currency Daily)"];
    if (!series) return null;

    const closes = Object.keys(series)
      .sort()
      .map((d) => Number(series[d]["4a. close (USD)"]))
      .filter((x) => Number.isFinite(x));

    return summariseSeries(symbol, closes, "Alpha Vantage");
  } catch (e) {
    console.log(`Alpha crypto failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchCryptoFinnhub(symbol) {
  if (!FINNHUB_KEY) return null;

  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 90 * 24 * 60 * 60;
    const finnhubSymbol = `BINANCE:${normalize(symbol)}USDT`;

    const { data } = await axios.get("https://finnhub.io/api/v1/crypto/candle", {
      params: {
        symbol: finnhubSymbol,
        resolution: "D",
        from,
        to,
        token: FINNHUB_KEY
      },
      timeout: 20000
    });

    if (data?.s !== "ok") return null;
    return summariseSeries(symbol, data.c || [], "Finnhub");
  } catch (e) {
    console.log(`Finnhub crypto failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchCryptoMarket(symbol) {
  return (
    await fetchCryptoCoinGecko(symbol) ||
    await fetchCryptoAlpha(symbol) ||
    await fetchCryptoFinnhub(symbol)
  );
}

async function fetchCryptoFearGreed() {
  try {
    const { data } = await axios.get("https://api.alternative.me/fng/?limit=1", {
      timeout: 15000
    });

    const value = Number(data?.data?.[0]?.value);
    if (!Number.isFinite(value)) return null;

    return {
      value,
      text: data?.data?.[0]?.value_classification || "unknown"
    };
  } catch (e) {
    console.log("Fear & Greed fetch failed:", e.message);
    return null;
  }
}

async function fetchFinnhubCompanyNews(symbol) {
  if (!FINNHUB_KEY) return [];

  try {
    const to = new Date();
    const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const { data } = await axios.get("https://finnhub.io/api/v1/company-news", {
      params: {
        symbol,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        token: FINNHUB_KEY
      },
      timeout: 20000
    });

    return Array.isArray(data) ? data.slice(0, 10) : [];
  } catch (e) {
    console.log(`Finnhub news failed for ${symbol}: ${e.message}`);
    return [];
  }
}

async function fetchNewsApiNews(query) {
  if (!NEWSAPI_KEY) return [];

  try {
    const { data } = await axios.get("https://newsapi.org/v2/everything", {
      params: {
        q: query,
        language: "en",
        sortBy: "publishedAt",
        pageSize: 10,
        apiKey: NEWSAPI_KEY
      },
      timeout: 20000
    });

    return Array.isArray(data?.articles) ? data.articles : [];
  } catch (e) {
    console.log(`NewsAPI failed for ${query}: ${e.message}`);
    return [];
  }
}

async function fetchTheNewsApiNews(query) {
  if (!THENEWSAPI_KEY) return [];

  try {
    const { data } = await axios.get("https://api.thenewsapi.com/v1/news/all", {
      params: {
        api_token: THENEWSAPI_KEY,
        search: query,
        language: "en",
        limit: 10
      },
      timeout: 20000
    });

    return Array.isArray(data?.data) ? data.data : [];
  } catch (e) {
    console.log(`TheNewsAPI failed for ${query}: ${e.message}`);
    return [];
  }
}

async function fetchNewsDataNews(query) {
  if (!NEWSDATA_KEY) return [];

  try {
    const { data } = await axios.get("https://newsdata.io/api/1/latest", {
      params: {
        apikey: NEWSDATA_KEY,
        q: query,
        language: "en"
      },
      timeout: 20000
    });

    return Array.isArray(data?.results) ? data.results.slice(0, 10) : [];
  } catch (e) {
    console.log(`NewsData failed for ${query}: ${e.message}`);
    return [];
  }
}

async function fetchNewsScore(asset, type) {
  const query = type === "crypto" ? `${normalize(asset)} crypto` : asset.replace(".L", "");
  const buckets = await Promise.all([
    fetchNewsApiNews(query),
    fetchTheNewsApiNews(query),
    fetchNewsDataNews(query),
    type === "stock" ? fetchFinnhubCompanyNews(asset) : Promise.resolve([])
  ]);

  const totalArticles = buckets.reduce((sum, arr) => sum + arr.length, 0);

  let score = 0;
  if (totalArticles >= 3) score += 4;
  if (totalArticles >= 6) score += 4;
  if (totalArticles >= 10) score += 4;

  return {
    totalArticles,
    score: clamp(score, 0, 12)
  };
}

function evaluateTechnicals(market) {
  const range = market.high20 - market.low20;
  if (!Number.isFinite(range) || range <= 0) return null;

  const breakoutStrength = (market.last - market.low20) / range;
  const aboveSmaPct = (market.last - market.sma20) / market.sma20;
  const momentumPct = (market.last - market.prev) / market.prev;

  let score = 50;
  const reasons = [];

  if (market.last >= market.high20 * 0.995) {
    score += 20;
    reasons.push("near-breakout");
  } else if (breakoutStrength < 0.35) {
    score -= 20;
    reasons.push("too-close-to-range-low");
  }

  if (momentumPct > 0.01) {
    score += 15;
    reasons.push("positive-momentum");
  } else if (momentumPct < 0) {
    score -= 10;
    reasons.push("negative-momentum");
  }

  if (aboveSmaPct > 0.01) {
    score += 15;
    reasons.push("above-sma20");
  } else if (aboveSmaPct < 0) {
    score -= 15;
    reasons.push("below-sma20");
  }

  return {
    score: clamp(score, 0, 100),
    reasons,
    breakoutStrength,
    aboveSmaPct,
    momentumPct
  };
}

function buildRiskModel(market) {
  const entry = market.last;
  const sl = market.low20 * 0.99;
  const tp = Math.max(market.high20 * 1.05, entry * 1.08);

  const risk = entry - sl;
  const reward = tp - entry;

  if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0 || reward <= 0) {
    return null;
  }

  const rr = reward / risk;

  let score = 0;
  if (rr >= 2.2) score += 18;
  else if (rr >= 1.8) score += 14;
  else if (rr >= 1.5) score += 10;
  else if (rr >= 1.2) score += 5;
  else score -= 15;

  return {
    entry: Number(entry.toFixed(2)),
    sl: Number(sl.toFixed(2)),
    tp: Number(tp.toFixed(2)),
    rr,
    score
  };
}

async function buildSignal(asset, type, market, fearGreed) {
  const technicals = evaluateTechnicals(market);
  if (!technicals) return null;

  const riskModel = buildRiskModel(market);
  if (!riskModel) return null;

  const news = await fetchNewsScore(asset, type);

  let sentimentScore = 0;
  let sentimentText = "";

  if (type === "crypto" && fearGreed) {
    sentimentText = `${fearGreed.value} ${fearGreed.text}`;
    if (fearGreed.value >= 65) sentimentScore += 8;
    else if (fearGreed.value >= 55) sentimentScore += 5;
    else if (fearGreed.value < 35) sentimentScore -= 8;
  }

  const confidence = clamp(
    technicals.score + riskModel.score + news.score + sentimentScore,
    0,
    96
  );

  if (technicals.score < 55) return null;
  if (riskModel.rr < 1.2) return null;
  if (market.last < market.sma20) return null;

  const reasonParts = [...technicals.reasons, `rr:${riskModel.rr.toFixed(2)}`];
  if (news.totalArticles >= 3) reasonParts.push(`news:${news.totalArticles}`);
  if (sentimentText) reasonParts.push(`fng:${sentimentText}`);

  return {
    asset,
    entry: riskModel.entry,
    sl: riskModel.sl,
    tp: riskModel.tp,
    confidence,
    type,
    source: market.source,
    reason: reasonParts.join(", ")
  };
}

function validateSignal(signal) {
  const asset = normalize(signal.asset);
  const entry = Number(signal.entry);
  const sl = Number(signal.sl);
  const tp = Number(signal.tp);
  const confidence = Number(signal.confidence || 0);
  const type = String(signal.type || "unknown").toLowerCase();
  const reason = String(signal.reason || "").trim();
  const source = String(signal.source || "").trim();

  if (!asset) return null;
  if ([entry, sl, tp, confidence].some((v) => Number.isNaN(v))) return null;
  if (entry <= 0 || sl <= 0 || tp <= 0) return null;

  return {
    asset,
    entry,
    sl,
    tp,
    confidence,
    type,
    reason,
    source,
    time: Date.now(),
    time_uk: londonTime()
  };
}

async function scanCandidates() {
  const candidates = [];
  const fearGreed = await fetchCryptoFearGreed();

  for (const symbol of WATCHLIST.stocks) {
    const market = await fetchStockMarket(symbol);
    if (!market) continue;

    const signal = await buildSignal(symbol, "stock", market, null);
    if (signal) candidates.push(signal);
  }

  for (const symbol of WATCHLIST.crypto) {
    const market = await fetchCryptoMarket(symbol);
    if (!market) continue;

    const signal = await buildSignal(symbol, "crypto", market, fearGreed);
    if (signal) candidates.push(signal);
  }

  return candidates;
}

async function publishSignals(candidates) {
  const existingSignals = loadSignals();

  const ranked = candidates
    .filter((c) => c.confidence >= MIN_CONFIDENCE)
    .filter((c) => !isOnCooldown(c.asset, existingSignals))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_ALERTS_PER_SCAN);

  let created = 0;
  let signals = existingSignals;

  for (const candidate of ranked) {
    const enriched = validateSignal(candidate);
    if (!enriched) continue;
    if (isDuplicate(enriched, signals)) continue;

    signals.push(enriched);
    signals = signals.slice(-100);
    saveSignals(signals);

    const icon = enriched.type === "crypto" ? "ðŸª™" : "ðŸ“ˆ";

    const msg = [
      "ðŸš¨ SNIPER SIGNAL",
      enriched.time_uk,
      "",
      `${icon} ${enriched.asset} (${enriched.confidence}%)`,
      `Type: ${enriched.type}`,
      `Source: ${enriched.source || "unknown"}`,
      `Entry: ${enriched.entry}`,
      `SL: ${enriched.sl}`,
      `TP: ${enriched.tp}`,
      `Reason: ${enriched.reason || "n/a"}`
    ].join("\n");

    await send(msg);
    console.log("Signal created:", enriched.asset);
    created += 1;
  }

  return created;
}

async function scanMarkets() {
  console.log(`[${londonTime()}] Scan started`);
  const candidates = await scanCandidates();
  const created = await publishSignals(candidates);
  console.log(`[${londonTime()}] Scan finished - ${created} signal(s) created from ${candidates.length} candidate(s)`);
}

async function loop() {
  if (shuttingDown) return;

  try {
    await scanMarkets();
  } catch (e) {
    console.error("Scan error:", e.message);
  }

  if (!shuttingDown) {
    timer = setTimeout(loop, POLL_SECONDS * 1000);
  }
}

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down sniper...`);
  shuttingDown = true;
  if (timer) clearTimeout(timer);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

loop().catch((e) => {
  console.error("Fatal sniper error:", e);
  process.exit(1);
});
