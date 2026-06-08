// ================================================================
// PARABOLIC TRADE FINDER
// Scans US stocks + crypto for explosive parabolic moves
// Alerts to Bluejam (private) for testing
// ----------------------------------------------------------------
// Scans every 5 minutes during market hours
// Crypto: 24/7
// Criteria: price up 8%+, volume 4x+, 3+ consecutive green candles
// ================================================================

console.log("🚀 PARABOLIC TRADE FINDER STARTING...");

const axios   = require("axios");
const express = require("express");

axios.defaults.timeout = 12000;

const app  = express();
const PORT = process.env.PORT || 3002;

app.get("/",       (_req, res) => res.status(200).send("PARABOLIC FINDER alive"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

// ── Environment ──────────────────────────────────────────────────
const BOT_TOKEN          = process.env.BOT_TOKEN          || "";
const BLUEJAM_CHAT_ID    = process.env.BLUEJAM_CHAT_ID    || process.env.CHAT_ID || "";
const ALPACA_API_KEY     = process.env.ALPACA_API_KEY     || "";
const ALPACA_SECRET_KEY  = process.env.ALPACA_SECRET_KEY  || "";
const FINNHUB_API_KEY    = process.env.FINNHUB_API_KEY    || "";

// ── Scan universe ─────────────────────────────────────────────────
const US_STOCKS = [
  // Mega cap + momentum
  "NVDA","PLTR","AMD","MSFT","META","AMZN","TSLA","AAPL","GOOGL",
  // High beta / space / defense
  "ASTS","IONQ","RKLB","LUNR","OKLO","SMR","AVAV","ACHR","SPCX",
  // AI / infra
  "MSTR","COIN","CRWD","APP","AVGO","VRT","GEV","ANET",
  // Biotech / momentum
  "MRNA","HIMS","SMCI","SOUN","MARA","RIOT","CLSK",
];

const CRYPTO_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","AVAXUSDT",
  "LINKUSDT","NEARUSDT","RENDERUSDT","SUIUSDT","TONUSDT",
  "ONDOUSDT","ARBUSDT","INJUSDT","JUPUSDT","FETUSDT",
  "EIGENUSDT","STRKUSDT","TIAUSDT","AAVEUSDT","UNIUSDT",
];

// ── Thresholds ────────────────────────────────────────────────────
const US_MIN_MOVE_PCT    = 0.06;  // 6%+ move
const CRYPTO_MIN_MOVE_PCT = 0.08; // 8%+ move for crypto
const MIN_VOL_RATIO      = 3.0;   // 3x+ average volume
const MIN_CONSEC_GREEN   = 2;     // at least 2 consecutive green candles
const COOLDOWN_MS        = 4 * 60 * 60 * 1000; // 4hr cooldown per asset

// ── State ─────────────────────────────────────────────────────────
const alerted = new Map(); // asset → timestamp of last alert

// ── Logging ───────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ── Telegram ──────────────────────────────────────────────────────
async function sendBluejam(text) {
  if (!BOT_TOKEN || !BLUEJAM_CHAT_ID) { log(`[TELEGRAM] ${text}`); return; }
  try {
    const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
    for (const chunk of chunks) {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: BLUEJAM_CHAT_ID, text: chunk, parse_mode: "HTML"
      });
    }
  } catch (e) { log(`Telegram error: ${e.message}`); }
}

// ── Market hours check ────────────────────────────────────────────
function isUSMarketOpen() {
  const now = new Date();
  const ukHour = now.getUTCHours() + 1; // approximate UK time
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const ukMins = now.getUTCHours() * 60 + now.getUTCMinutes() + 60;
  return ukMins >= 870 && ukMins <= 1320; // 14:30 - 22:00 UK
}

// ── Cooldown check ────────────────────────────────────────────────
function isOnCooldown(asset) {
  const last = alerted.get(asset);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

// ── Fetch Alpaca 15-min bars for US stocks ────────────────────────
async function fetchAlpacaBars(symbol, limit = 20) {
  if (!ALPACA_API_KEY) return null;
  try {
    const resp = await axios.get(
      `https://data.alpaca.markets/v2/stocks/${symbol}/bars`,
      {
        params: { timeframe: "15Min", limit, feed: "sip" },
        headers: {
          "APCA-API-KEY-ID":     ALPACA_API_KEY,
          "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
        },
        timeout: 8000,
      }
    );
    return resp.data?.bars || null;
  } catch (e) {
    return null;
  }
}

// ── Fetch Binance 15-min candles for crypto ───────────────────────
async function fetchBinanceCandles(symbol, limit = 20) {
  try {
    const resp = await axios.get("https://api.binance.com/api/v3/klines", {
      params: { symbol, interval: "15m", limit },
      timeout: 8000,
    });
    return (resp.data || []).map(c => ({
      o: parseFloat(c[1]),
      h: parseFloat(c[2]),
      l: parseFloat(c[3]),
      c: parseFloat(c[4]),
      v: parseFloat(c[5]),
    }));
  } catch (e) {
    return null;
  }
}

// ── Fetch Finnhub quote for quick price check ─────────────────────
async function fetchFinnhubQuote(symbol) {
  if (!FINNHUB_API_KEY) return null;
  try {
    const resp = await axios.get("https://finnhub.io/api/v1/quote", {
      params: { symbol, token: FINNHUB_API_KEY },
      timeout: 5000,
    });
    return resp.data;
  } catch (e) { return null; }
}

// ── Parabolic analysis ────────────────────────────────────────────
function analyzeParabolic(candles, minMovePct) {
  if (!candles || candles.length < 5) return null;

  const last    = candles.at(-1);
  const open20  = candles.at(-20)?.o || candles[0].o;

  // Session move from earliest candle open
  const sessionMove = (last.c - open20) / open20;

  // Average volume (excluding last 3 candles)
  const historicalCandles = candles.slice(0, -3);
  const avgVol = historicalCandles.length > 0
    ? historicalCandles.reduce((s, c) => s + c.v, 0) / historicalCandles.length
    : 0;
  const lastVol = last.v;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 0;

  // Count consecutive green candles from the end
  let consecGreen = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].c > candles[i].o) consecGreen++;
    else break;
  }

  // Recent high velocity — last 3 candles move
  const recentMove = candles.length >= 4
    ? (last.c - candles.at(-4).o) / candles.at(-4).o
    : sessionMove;

  // Parabolic score
  let score = 0;
  if (sessionMove >= 0.15)  score += 30;
  else if (sessionMove >= 0.10) score += 20;
  else if (sessionMove >= minMovePct) score += 10;

  if (volRatio >= 8)  score += 30;
  else if (volRatio >= 5) score += 20;
  else if (volRatio >= MIN_VOL_RATIO) score += 10;

  if (consecGreen >= 4) score += 20;
  else if (consecGreen >= MIN_CONSEC_GREEN) score += 10;

  if (recentMove >= 0.05) score += 10;

  // Must pass minimum criteria
  if (sessionMove < minMovePct) return null;
  if (volRatio < MIN_VOL_RATIO) return null;
  if (consecGreen < MIN_CONSEC_GREEN) return null;

  return {
    sessionMove,
    volRatio,
    consecGreen,
    recentMove,
    price: last.c,
    score,
  };
}

// ── Format parabolic alert ────────────────────────────────────────
function buildAlert(asset, market, result) {
  const movePct   = (result.sessionMove * 100).toFixed(1);
  const recentPct = (result.recentMove * 100).toFixed(1);
  const volX      = result.volRatio.toFixed(1);
  const price     = result.price < 1
    ? `$${result.price.toFixed(4)}`
    : `$${result.price.toFixed(2)}`;

  const emoji = result.score >= 70 ? "🚀🔥" : result.score >= 50 ? "🚀" : "📈";
  const marketFlag = market === "CRYPTO" ? "🪙 CRYPTO" : "🇺🇸 US";
  const sym = asset.replace("USDT", "");

  return [
    `${emoji} <b>PARABOLIC DETECTED</b>`,
    ``,
    `${marketFlag} | <b>${sym}</b>`,
    ``,
    `📈 Session move:   <b>+${movePct}%</b>`,
    `⚡ Recent (3 bars): <b>+${recentPct}%</b>`,
    `📊 Volume:          <b>${volX}x avg</b>`,
    `🟢 Consecutive:     <b>${result.consecGreen} green candles</b>`,
    `💵 Price:           <b>${price}</b>`,
    `⭐ Parabolic score: <b>${result.score}/90</b>`,
    ``,
    `⚠️ <i>Parabolic alert — high risk, extended move. Not a signal.</i>`,
    `——————————`,
    `⚠️ Educational market commentary only · Not personalised investment advice · @baretradesignals`,
  ].join("\n");
}

// ── Scan US stocks ────────────────────────────────────────────────
async function scanUS() {
  if (!isUSMarketOpen()) return;
  log(`📈 Scanning ${US_STOCKS.length} US stocks for parabolic moves...`);

  const results = [];

  for (const symbol of US_STOCKS) {
    if (isOnCooldown(symbol)) continue;
    try {
      const bars = await fetchAlpacaBars(symbol, 20);
      if (!bars || bars.length < 5) continue;

      // Convert Alpaca bars to standard format
      const candles = bars.map(b => ({
        o: b.o, h: b.h, l: b.l, c: b.c, v: b.v
      }));

      const result = analyzeParabolic(candles, US_MIN_MOVE_PCT);
      if (result) {
        results.push({ asset: symbol, market: "US", result });
        log(`🚀 PARABOLIC: ${symbol} +${(result.sessionMove*100).toFixed(1)}% vol=${result.volRatio.toFixed(1)}x score=${result.score}`);
      }
    } catch (e) {
      // silent fail per asset
    }
    await new Promise(r => setTimeout(r, 200)); // rate limit
  }

  // Sort by score, alert top 3
  results.sort((a, b) => b.result.score - a.result.score);
  for (const { asset, market, result } of results.slice(0, 3)) {
    alerted.set(asset, Date.now());
    await sendBluejam(buildAlert(asset, market, result));
    await new Promise(r => setTimeout(r, 1000));
  }

  if (results.length === 0) log("No US parabolic moves detected");
}

// ── Scan crypto ───────────────────────────────────────────────────
async function scanCrypto() {
  log(`🪙 Scanning ${CRYPTO_PAIRS.length} crypto pairs for parabolic moves...`);

  const results = [];

  for (const symbol of CRYPTO_PAIRS) {
    if (isOnCooldown(symbol)) continue;
    try {
      const candles = await fetchBinanceCandles(symbol, 20);
      if (!candles || candles.length < 5) continue;

      const result = analyzeParabolic(candles, CRYPTO_MIN_MOVE_PCT);
      if (result) {
        results.push({ asset: symbol, market: "CRYPTO", result });
        log(`🚀 PARABOLIC: ${symbol} +${(result.sessionMove*100).toFixed(1)}% vol=${result.volRatio.toFixed(1)}x score=${result.score}`);
      }
    } catch (e) {
      // silent fail per asset
    }
    await new Promise(r => setTimeout(r, 150));
  }

  results.sort((a, b) => b.result.score - a.result.score);
  for (const { asset, market, result } of results.slice(0, 3)) {
    alerted.set(asset, Date.now());
    await sendBluejam(buildAlert(asset, market, result));
    await new Promise(r => setTimeout(r, 1000));
  }

  if (results.length === 0) log("No crypto parabolic moves detected");
}

// ── Master scan ───────────────────────────────────────────────────
async function scan() {
  try {
    await scanCrypto();
    if (isUSMarketOpen()) await scanUS();
  } catch (e) {
    log(`Scan error: ${e.message}`);
  }
}

// ── Startup message ───────────────────────────────────────────────
async function startup() {
  const msg = [
    `🚀 <b>PARABOLIC TRADE FINDER — LIVE</b>`,
    ``,
    `Scanning for explosive moves:`,
    `🇺🇸 US stocks: ${US_STOCKS.length} assets (market hours only)`,
    `🪙 Crypto: ${CRYPTO_PAIRS.length} pairs (24/7)`,
    ``,
    `Criteria:`,
    `• US: 6%+ move, 3x+ volume, 2+ green candles`,
    `• Crypto: 8%+ move, 3x+ volume, 2+ green candles`,
    `• 4hr cooldown per asset`,
    `• Top 3 alerts per scan cycle`,
    ``,
    `Scanning every 5 minutes. Bluejam-only mode.`,
  ].join("\n");
  await sendBluejam(msg);
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const srv = app.listen(PORT, () => log(`Server on port ${PORT}`));

  await startup();
  await scan(); // immediate first scan

  // Crypto: every 5 mins
  setInterval(scanCrypto, 5 * 60 * 1000);

  // US stocks: every 5 mins but gated by market hours
  setInterval(() => {
    if (isUSMarketOpen()) scanUS();
  }, 5 * 60 * 1000);

  process.on("SIGTERM", () => {
    log("SIGTERM received");
    srv.close(() => process.exit(0));
  });
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
