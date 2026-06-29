// ============================================================
// THE HUNTER — BareTradeSignals Opportunity Engine
// Deploys as: portfolio-bot-v8.js on Railway
// Philosophy: Search the market. Reject almost everything.
//             Find the one opportunity worth hunting.
// ============================================================

'use strict';

const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws'); // required: Node 20 has no native WebSocket, Supabase realtime needs this

// Moved to top of file (was previously declared near the leadership
// system ~3000 lines down). Needed early now: provider-failure logs are
// stamped with INSTANCE_ID so duplicate-instance/overlap sanity checks
// can correlate exactly which process fired which outbound request,
// including calls made during the startup health check — before the
// leadership system itself even runs.
const INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

// ============================================================
// SECTION 1: CONFIGURATION
// ============================================================

const CONFIG = {
  WEIGHTS: {
    marketContext:    0.08,
    structure:        0.12,
    participation:    0.13,
    momentum:         0.12,
    executionQuality: 0.22,
    risk:             0.10,
    stage:            0.08,
    edge:             0.15,
  },
  THRESHOLDS: {
    hunterScoreElite:       88,
    hunterScoreGood:        78,
    // Raised from 65 → 75 per explicit request: Hunter was firing on too
    // many mid-tier candidates, creating FOMO pressure when the person
    // already had an open position elsewhere. A 65-score WATCH and a
    // 74-score WATCH looked identical in urgency despite very different
    // signal quality. Raising the floor means only genuinely strong,
    // close-to-trigger candidates enter the watchlist at all — rare
    // events, not routine scan output.
    hunterScoreWatch:       75,
    confidenceMinimum:      63,
    convictionMinimum:      65,
    executionHardFloor:     60,
    edgeMinimumOverField:   8,     // reduced from 12 — calibrate against outcomes
    competitionGap:         5,     // now a BONUS threshold, not a hard gate
    competitionBonus:       10,    // score bonus when beating #2 by 5+ pts
  },
  // Per-symbol cooldown (ms) + elite override
  SYMBOL_COOLDOWN_MS:     10_800_000, // 3h per symbol
  ELITE_SCORE_OVERRIDE:   10,         // fire if new score beats last by 10+ pts
  // Regime-aware cycle timing
  // TEMPORARY DIAGNOSTIC SETTING — per duplicate-instance/request-volume
  // sanity check. All intervals widened to 5 minutes regardless of regime.
  // Purpose: if Binance 418 bans and Bybit 403s stop/reduce at this lower
  // request volume, that's evidence the bans are volume-triggered rather
  // than a hard geo-block. Revert to 90s/180s/180s once this test is done
  // — see CONFIG values below (kept commented for easy restore).
  CYCLE_MS_BULL:        300_000,      // was 90_000 — TEMP for sanity check
  CYCLE_MS_NEUTRAL:     300_000,      // was 180_000 — TEMP for sanity check
  CYCLE_MS_BEAR:        300_000,      // was 180_000 — TEMP for sanity check
  // RESTORE AFTER TEST:
  // CYCLE_MS_BULL:        90_000,
  // CYCLE_MS_NEUTRAL:     180_000,
  // CYCLE_MS_BEAR:        180_000,
  CYCLE_MS:             300_000,      // default until regime known
  MAX_ALERTS_PER_DAY:   6,
  ALERT_COOLDOWN_MS:    10_800_000,   // 3 hours between alerts
  NO_TRADE_COOLDOWN_MS: 14_400_000,   // 4 hours between no-trade messages
  DYNAMIC_MOVE_PCT:     4.0,
  DYNAMIC_VOL_MULT:     2.0,
  DYNAMIC_EXPIRY_MS:    14_400_000,   // 4 hours
  NO_TRADE_EVERY_N:     30,           // legacy — now time-based too
  CANDLE_LIMIT:         100,
  MIN_DOLLAR_VOLUME:    500_000,
};

// ============================================================
// SECTION 2: ASSET UNIVERSE
// ============================================================

// ============================================================
// HUNTER UNIVERSE — refreshed per audit (2026-06-19)
// Joint Sniper + Claude audit. Corrections applied:
//   - GLNC.L → GLEN.L (was an invalid ticker)
//   - ANA.L removed (resolved to Japanese airline cross-listing, not
//     the intended UK name — needs confirmation before re-adding)
//   - MRVL promoted to A+ tier (was incorrectly downgraded — has
//     produced real moves, e.g. +13%, that Hunter should be catching)
//   - PLTR kept at A — relative strength + institutional sponsorship
//     matter more for Hunter's purpose than "trend cleanliness" alone
//   - SMCI kept at B — liquid AI-infra name, not the 2024 volatility
//     profile; comparable to AMD, not a lottery-ticket name
//   - JPM, GS, XOM added — improves regime detection by giving Hunter
//     visibility into financials/energy leadership vs semis weakness
// Universe expansion (2026-06-22):
//   - 13 additional liquid crypto assets added (all confirmed on
//     Bybit/Binance): TON, TRX, DOGE, ADA, NEAR, INJ, HBAR, JTO,
//     WLD, APT, FET, TIA, FIL — expanding from 15 to 28 crypto assets
//   - Purpose: capture assets like TON that produce moves Hunter
//     currently cannot see because they are outside the universe
// Universe v2 (2026-06-23):
//   Philosophy: Hunter detects LEADERSHIP EMERGENCE, not best companies.
//   Rebuilt around themes where rotation signals appear first.
//   Crypto: 28 → 21 (tighter, narrative-focused)
//   US stocks: 50 → 37 (broader themes, less AI-infra concentration)
//   LSE: retained but unchanged (18 stocks, UK market hours only)
//   Active universe: 21 crypto (24/7) + 37 US (market hours) = 58 assets
// ============================================================

const CORE_CRYPTO = [
  // Core leaders — deepest liquidity, benchmark regime signals
  'BTCUSDT','ETHUSDT','SOLUSDT',
  // AI / Compute narrative
  'TAOUSDT','FETUSDT',
  // DeFi — on-chain institutional flow
  'ONDOUSDT','LINKUSDT','MORPHOUSDT','PENDLEUSDT',
  // Cycle Planner coins — required for weekly report
  'AAVEUSDT','AVAXUSDT','XRPUSDT','TIAUSDT',
  // Emerging L1 / Infrastructure
  'SUIUSDT','SEIUSDT','INJUSDT','NEARUSDT','TONUSDT',
  // Narrative rotation — where leadership shifts first
  'HYPEUSDT','JUPUSDT','ENAUSDT','ZROUSDT','GRASSUSDT',
  // Regime breadth
  'HBARUSDT','QNTUSDT',
];

const CORE_US_STOCKS = [
  // AI Infrastructure — core compute + networking
  'NVDA','AVGO','ANET','VRT','TSM','AMD','ARM','CRDO',
  // AI Software — SaaS leadership indicators
  'PLTR','CRWD','DDOG','SNOW',
  // AI Applications — emerging leadership
  'SOUN','TEM','APP',
  // Space — new frontier theme
  'RKLB','LUNR','ASTS',
  // Nuclear / Power — energy infrastructure leadership
  'OKLO','LEU','BWXT','NNE','SMR','CEG','ETN','PWR','FIX',
  // Defence — institutional sponsorship + geopolitical theme
  'RTX','AVAV','KTOS',
  // Consumer / Growth — rotation detection
  'HOOD','UBER','DUOL','HIMS',
  // Quantum — speculative leadership signals
  'IONQ',
  // Meta / Platforms — regime breadth
  'META','MSFT',
];

const CORE_LSE_STOCKS = [
  // Tier A — deepest LSE liquidity + clean trend
  'SHEL.L','RIO.L','AZN.L','HSBC.L',
  // Tier B — liquid, decent structure
  'BP.L','GLEN.L','AAL.L','BARC.L','LLOY.L','NWG.L','STAN.L',
  'GSK.L','REL.L','BA.L','RR.L','HIK.L',
  // Tier C — thinner liquidity or more commodity/single-asset driven
  'BAB.L','ANTO.L','FRES.L',
  // ANA.L removed — unresolved ticker, needs confirmation before re-adding
];
// ============================================================
// SECTION 3: ENVIRONMENT & CLIENTS
// ============================================================

const ENV = {
  BOT_TOKEN:              process.env.BOT_TOKEN,
  // Accept BLUEJAM_CHAT_ID or fall back to legacy CHAT_ID
  BLUEJAM_CHAT_ID:        process.env.BLUEJAM_CHAT_ID || process.env.CHAT_ID,
  CHANNEL_CHAT_ID:        process.env.CHANNEL_CHAT_ID,
  ALPACA_API_KEY:         process.env.ALPACA_API_KEY,
  ALPACA_SECRET_KEY:      process.env.ALPACA_SECRET_KEY,
  ALPACA_BASE_URL:        process.env.ALPACA_BASE_URL || 'https://data.alpaca.markets',
  FINNHUB_API_KEY:        process.env.FINNHUB_API_KEY || process.env.FINNHUB_KEY,
  // Accept all common Supabase key name variants
  SUPABASE_URL:           process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL,
  SUPABASE_SERVICE_KEY:   process.env.SUPABASE_SERVICE_ROLE_KEY
                            || process.env.SUPABASE_SERVICE_KEY
                            || process.env.SUPABASE_KEY
                            || process.env.SUPABASE_ANON_KEY,
  COINGECKO_API_KEY:      process.env.COINGECKO_API_KEY || process.env.COINGECKO_KEY,
  HUNTER_LIVE:            process.env.HUNTER_LIVE === 'true',
};

let supabase = null;
if (ENV.SUPABASE_URL && ENV.SUPABASE_SERVICE_KEY) {
  try {
    // Node 20 has no native WebSocket. Supabase's RealtimeClient constructs
    // itself on createClient() regardless of whether realtime is used —
    // {realtime:{enabled:false}} does NOT prevent this. Must pass the ws
    // package explicitly as the transport, per Supabase's own error message.
    supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_KEY, {
      auth:      { persistSession: false, autoRefreshToken: false },
      realtime:  { transport: ws },
    });
    console.log('✅ Supabase client initialised (ws transport)');
  } catch (err) {
    console.error('Supabase init failed:', err.message);
    supabase = null;
  }
}

// ============================================================
// SECTION 4: STATE
// ============================================================

const STATE = {
  cycleCount:           0,
  alertsToday:          0,
  alertDateKey:         '',
  lastAlertTime:        0,
  lastNoTradeTime:      0,
  symbolLastAlert:      new Map(), // symbol -> { time, score } for per-symbol cooldown
  rejectionStats:       new Map(), // reason -> count for threshold tuning
  alertFingerprints:    new Map(), // fingerprint -> sentAt timestamp (30min dedup window)
  leaderboard:          [],        // top candidates from last scan for leaderboard report
  lastLeaderboardTime:  0,         // last time leaderboard was sent
  watchLastScores:      new Map(), // legacy — superseded by watchlistState below
  watchlistState:       new Map(), // symbol -> { score, stage, status, lastAlertTime, lastAlertScore }
  buyConfirmTracker:    new Map(), // symbol -> { firstSeenCycle, firstSeenScore, consecutiveCycles }
  dynamicAssets:        new Map(),
  hunterSlots:          new Map(),
  candidateHistory:     [],
  fieldAverage:         0,
  fieldBest:            null,
  fieldSecondBest:      null,
  btcRegime:            'NEUTRAL',
  qqqRegime:            'NEUTRAL',
  qqqRegimeStale:       false,    // true when US market closed or fetch failed — label not live
  cryptoBreadth:        50,
  lastScan:             null,
  currentCycleMs:       300_000,
};


// ============================================================
// SECTION 5: HTTP UTILITIES
// ============================================================

// httpGet now throws a structured HttpError on non-2xx responses and
// network failures, instead of silently resolving bad data or letting
// fetchers swallow everything in catch{}. This is what makes provider
// outages diagnosable: 403 (geo-block), 429 (rate limit), DNS failures,
// and timeouts now produce distinct, loggable error types.
class HttpError extends Error {
  constructor(message, { statusCode, code, host } = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode || null; // HTTP status, e.g. 403, 429
    this.code = code || null;             // Node error code, e.g. ENOTFOUND, ECONNRESET
    this.host = host || null;
  }
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(new HttpError(`Invalid URL: ${e.message}`, { code: 'INVALID_URL' }));
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      headers:  { 'User-Agent': 'TheHunter/1.0', ...headers },
    };
    const req = lib.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        const status = res.statusCode;
        // Non-2xx — reject with structured info instead of silently resolving
        if (status < 200 || status >= 300) {
          return reject(new HttpError(
            `HTTP ${status} from ${parsed.hostname} (${elapsed}ms)`,
            { statusCode: status, host: parsed.hostname }
          ));
        }
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); } // some endpoints return plain text/empty on success
      });
    });
    req.on('error', (err) => {
      // Node-level errors: ENOTFOUND (DNS), ECONNRESET, ECONNREFUSED, etc.
      reject(new HttpError(
        `${err.code || 'NETWORK_ERROR'} connecting to ${parsed.hostname}: ${err.message}`,
        { code: err.code, host: parsed.hostname }
      ));
    });
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new HttpError(`Timeout (10s) connecting to ${parsed.hostname}`, { code: 'ETIMEDOUT', host: parsed.hostname }));
    });
  });
}

// ── Provider health tracker ─────────────────────────────────────────
const providerHealth = new Map(); // provider -> { lastError, lastErrorTime, failCount, lastSuccessTime }

function recordProviderFailure(provider, err) {
  const entry = providerHealth.get(provider) || { failCount: 0, lastSuccessTime: null };
  entry.failCount++;
  entry.lastError = {
    message:    err?.message || String(err),
    statusCode: err?.statusCode || null,
    code:       err?.code || null,
    host:       err?.host || null,
  };
  entry.lastErrorTime = Date.now();
  providerHealth.set(provider, entry);
  const detail = [
    err?.statusCode ? `status=${err.statusCode}` : null,
    err?.code ? `code=${err.code}` : null,
    err?.host ? `host=${err.host}` : null,
  ].filter(Boolean).join(' ');
  log(`⚠️  ${provider} FAILED — ${err?.message || err} ${detail ? `(${detail})` : ''} [instance=${INSTANCE_ID}]`);
}

function recordProviderSuccess(provider) {
  const entry = providerHealth.get(provider) || { failCount: 0 };
  entry.lastSuccessTime = Date.now();
  providerHealth.set(provider, entry);
}

function getProviderHealthSummary() {
  const lines = [];
  for (const [provider, h] of providerHealth.entries()) {
    const lastErr = h.lastError
      ? `${h.lastError.statusCode || h.lastError.code || 'ERR'}: ${h.lastError.message}`
      : 'none';
    const sinceSuccess = h.lastSuccessTime ? `${Math.round((Date.now() - h.lastSuccessTime) / 60000)}m ago` : 'never';
    lines.push(`  ${provider}: fails=${h.failCount} lastErr="${lastErr}" lastOk=${sinceSuccess}`);
  }
  return lines.join('\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

function formatPrice(price, assetType) {
  if (!price || !Number.isFinite(price)) return 'N/A';
  if (assetType === 'lse') {
    if (price >= 100) return `${price.toFixed(0)}p`;
    return `${price.toFixed(1)}p`;
  }
  if (assetType === 'crypto') {
    if (price >= 1000) return `$${price.toFixed(2)}`;
    if (price >= 1)    return `$${price.toFixed(3)}`;
    return `$${price.toFixed(5)}`;
  }
  return `$${price.toFixed(2)}`;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// ============================================================
// SECTION 6: DATA FETCHERS — CRYPTO (Bybit primary, Binance fallback)
// NOTE: Railway IPs are US-based; Binance blocks US ranges.
//       Bybit has no geo-restrictions — it is the primary source.
// ============================================================

async function fetchBybitCandles(symbol, interval = '15', limit = 100) {
  try {
    const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const data = await httpGet(url);
    if (data?.result?.list && data.result.list.length > 0) {
      recordProviderSuccess('Bybit');
      return data.result.list.reverse().map((c) => ({
        time:   parseInt(c[0]),
        open:   parseFloat(c[1]),
        high:   parseFloat(c[2]),
        low:    parseFloat(c[3]),
        close:  parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    }
    recordProviderFailure('Bybit', new Error(`Empty or malformed response: ${JSON.stringify(data).slice(0,200)}`));
    return null;
  } catch (err) {
    recordProviderFailure('Bybit', err);
    return null;
  }
}

async function fetchBinanceCandles(symbol, interval = '15m', limit = 100) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const raw = await httpGet(url);
    if (!Array.isArray(raw) || raw.length === 0) {
      recordProviderFailure('Binance', new Error('Empty or non-array response (likely geo-blocked)'));
      return null;
    }
    recordProviderSuccess('Binance');
    return raw.map((c) => ({
      time:   c[0],
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  } catch (err) {
    recordProviderFailure('Binance', err);
    return null;
  }
}

async function fetchCoinGeckoPrice(coinId) {
  try {
    const key = ENV.COINGECKO_API_KEY ? `&x_cg_demo_api_key=${ENV.COINGECKO_API_KEY}` : '';
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true${key}`;
    const data = await httpGet(url);
    if (!data?.[coinId]) {
      recordProviderFailure('CoinGecko', new Error(`No data for ${coinId} in response`));
      return null;
    }
    recordProviderSuccess('CoinGecko');
    return data[coinId];
  } catch (err) {
    recordProviderFailure('CoinGecko', err);
    return null;
  }
}

const COINGECKO_OHLC_MIN_INTERVAL_MS = 60_000; // max once per 60s
let _lastCoinGeckoOHLCCall = 0;

async function fetchCoinGeckoOHLC(coinId, days = 2) {
  const now = Date.now();
  if (now - _lastCoinGeckoOHLCCall < COINGECKO_OHLC_MIN_INTERVAL_MS) {
    const waitMs = COINGECKO_OHLC_MIN_INTERVAL_MS - (now - _lastCoinGeckoOHLCCall);
    log(`⏳ CoinGecko-OHLC rate-gate: skipping call, ${Math.round(waitMs/1000)}s until next allowed`);
    return null;
  }
  _lastCoinGeckoOHLCCall = now;
  try {
    const keyParam = ENV.COINGECKO_API_KEY ? `&x_cg_demo_api_key=${ENV.COINGECKO_API_KEY}` : '';
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}${keyParam}`;
    const raw = await httpGet(url);
    if (!Array.isArray(raw) || raw.length === 0) {
      recordProviderFailure('CoinGecko-OHLC', new Error(`Empty response for ${coinId}`));
      return null;
    }
    recordProviderSuccess('CoinGecko-OHLC');
    return raw.map((c) => ({
      time:   c[0],
      open:   c[1],
      high:   c[2],
      low:    c[3],
      close:  c[4],
      volume: 1,
    }));
  } catch (err) {
    recordProviderFailure('CoinGecko-OHLC', err);
    return null;
  }
}

async function fetchCoinGeckoMarketChart(coinId, days = 3) {
  try {
    const keyParam = ENV.COINGECKO_API_KEY ? `&x_cg_demo_api_key=${ENV.COINGECKO_API_KEY}` : '';
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=hourly${keyParam}`;
    const data = await httpGet(url);
    if (!data?.prices?.length) return null;
    const prices  = data.prices;
    const volumes = data.total_volumes || [];
    return prices.map((p, i) => {
      const price = p[1];
      const vol   = volumes[i]?.[1] || 1;
      return {
        time:   p[0],
        open:   i > 0 ? prices[i-1][1] : price,
        high:   price * 1.002,
        low:    price * 0.998,
        close:  price,
        volume: vol,
      };
    });
  } catch {
    return null;
  }
}

async function fetchCryptoCandles(symbol) {
  let candles = await fetchBybitCandles(symbol, '15', 100);
  if (candles && candles.length >= 20) return candles;
  candles = await fetchBinanceCandles(symbol, '15m', 100);
  if (candles && candles.length >= 20) return candles;
  return null;
}

const BYBIT_TO_COINGECKO = {
  'BTCUSDT': 'bitcoin', 'ETHUSDT': 'ethereum', 'SOLUSDT': 'solana',
  'BNBUSDT': 'binancecoin', 'XRPUSDT': 'ripple', 'ADAUSDT': 'cardano',
  'AVAXUSDT': 'avalanche-2', 'DOTUSDT': 'polkadot', 'LINKUSDT': 'chainlink',
  'MATICUSDT': 'matic-network', 'NEARUSDT': 'near', 'ATOMUSDT': 'cosmos',
  'APTUSDT': 'aptos', 'ARBUSDT': 'arbitrum', 'OPUSDT': 'optimism',
  'INJUSDT': 'injective-protocol', 'SUIUSDT': 'sui', 'ONDOUSDT': 'ondo-finance',
  'FETUSDT': 'fetch-ai', 'RENDERUSDT': 'render-token',
};

// ============================================================
// SECTION 7: DATA FETCHERS — US STOCKS (Alpaca primary)
// ============================================================

let _alpacaBaseUrlWarned = false;

async function fetchAlpacaBars(symbol, timeframe = '15Min', limit = 100) {
  try {
    if (!ENV.ALPACA_API_KEY) {
      recordProviderFailure('Alpaca', new Error('ALPACA_API_KEY not set'));
      return null;
    }
    let base = (ENV.ALPACA_BASE_URL || 'https://data.alpaca.markets').replace(/\/$/, '');
    if (base.includes('paper-api.alpaca.markets') || base.includes('api.alpaca.markets')) {
      if (!_alpacaBaseUrlWarned) {
        log(`🚨 MISCONFIGURED ALPACA_BASE_URL: "${base}" is the TRADING API, not market data.`);
        log(`   Market data lives at https://data.alpaca.markets — auto-correcting for this session.`);
        log(`   Fix permanently: update ALPACA_BASE_URL in Railway to https://data.alpaca.markets`);
        _alpacaBaseUrlWarned = true;
      }
      base = 'https://data.alpaca.markets';
    }
    base = base.replace(/\/v2$/, '');
    const end   = new Date().toISOString();
    const start = new Date(Date.now() - 86400000 * 5).toISOString();
    const url   = `${base}/v2/stocks/${symbol}/bars?timeframe=${timeframe}&start=${start}&end=${end}&limit=${limit}&feed=sip&sort=asc`;
    const data  = await httpGet(url, {
      'APCA-API-KEY-ID':     ENV.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': ENV.ALPACA_SECRET_KEY,
    });
    if (!data?.bars?.length) {
      recordProviderFailure('Alpaca', new Error(`No bars for ${symbol}: ${JSON.stringify(data).slice(0,200)}`));
      return null;
    }
    recordProviderSuccess('Alpaca');
    return data.bars.map((b) => ({
      time:   new Date(b.t).getTime(),
      open:   b.o,
      high:   b.h,
      low:    b.l,
      close:  b.c,
      volume: b.v,
    }));
  } catch (err) {
    recordProviderFailure('Alpaca', err);
    return null;
  }
}

async function fetchYahooCandles(symbol, interval = '15m') {
  try {
    const range = '5d';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    const data = await httpGet(url);
    const result = data?.chart?.result?.[0];
    if (!result) {
      const errInfo = data?.chart?.error ? JSON.stringify(data.chart.error) : 'no result in response';
      recordProviderFailure('Yahoo', new Error(`${symbol}: ${errInfo}`));
      return null;
    }
    recordProviderSuccess('Yahoo');
    const { timestamp, indicators } = result;
    const q = indicators.quote[0];
    return timestamp.map((t, i) => ({
      time:   t * 1000,
      open:   q.open[i],
      high:   q.high[i],
      low:    q.low[i],
      close:  q.close[i],
      volume: q.volume[i],
    })).filter((c) => c.close && c.volume);
  } catch (err) {
    recordProviderFailure('Yahoo', err);
    return null;
  }
}

async function fetchUSStockCandles(symbol) {
  let candles = await fetchAlpacaBars(symbol);
  if (!candles || candles.length < 20) {
    candles = await fetchYahooCandles(symbol);
  }
  return candles;
}

async function fetchLSECandles(symbol) {
  return fetchYahooCandles(symbol);
}

// ============================================================
// SECTION 8: DATA FETCHERS — MARKET CONTEXT
// ============================================================

async function fetchBTCRegime() {
  try {
    let candles = await fetchBybitCandles('BTCUSDT', '60', 60);
    if (!candles || candles.length < 20) {
      candles = await fetchBybitCandles('BTCUSDT', '15', 100);
    }
    if (!candles || candles.length < 20) {
      log('  BTC: Bybit failed, trying CoinGecko OHLC (1 credit)');
      candles = await fetchCoinGeckoOHLC('bitcoin', 3);
    }
    if (!candles || candles.length < 20) {
      log(`⚠️  BTC regime: no data — keeping ${STATE.btcRegime}`);
      return STATE.btcRegime || 'NEUTRAL';
    }
    const closes = candles.map((c) => c.close);
    const ema20  = calcEMA(closes, 20);
    const ema50  = calcEMA(closes, Math.min(50, closes.length - 1));
    const last   = closes[closes.length - 1];
    const e20    = ema20[ema20.length - 1];
    const e50    = ema50[ema50.length - 1];
    log(`  BTC: ${candles.length} candles, $${round2(last)}, EMA20=$${round2(e20)}, EMA50=$${round2(e50)}`);
    if (last > e20 && e20 > e50) return 'BULL';
    if (last < e20 && e20 < e50) return 'BEAR';
    return 'NEUTRAL';
  } catch (err) {
    log(`⚠️  BTC regime error: ${err.message}`);
    return STATE.btcRegime || 'NEUTRAL';
  }
}

async function fetchQQQRegime() {
  if (!isMarketOpen('us')) {
    STATE.qqqRegimeStale = true;
    log(`⚠️  QQQ regime: US market closed — marking stale (was ${STATE.qqqRegime})`);
    return STATE.qqqRegime || 'NEUTRAL';
  }
  try {
    let candles = await fetchAlpacaBars('QQQ', '1Hour', 60);
    if (!candles || candles.length < 20) {
      candles = await fetchAlpacaBars('QQQ', '15Min', 80);
    }
    if (!candles || candles.length < 20) {
      candles = await fetchYahooCandles('QQQ', '1h');
    }
    if (!candles || candles.length < 20) {
      STATE.qqqRegimeStale = true;
      log(`⚠️  QQQ regime: no data from any source during market hours — keeping ${STATE.qqqRegime} (marked stale)`);
      return STATE.qqqRegime || 'NEUTRAL';
    }
    const closes = candles.map((c) => c.close);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, Math.min(50, closes.length - 1));
    const last  = closes[closes.length - 1];
    const e20   = ema20[ema20.length - 1];
    const e50   = ema50[ema50.length - 1];
    log(`  QQQ data: ${candles.length} candles, last=$${round2(last)}, EMA20=$${round2(e20)}, EMA50=$${round2(e50)}`);
    STATE.qqqRegimeStale = false;
    if (last > e20 && e20 > e50) return 'BULL';
    if (last < e20 && e20 < e50) return 'BEAR';
    return 'NEUTRAL';
  } catch (err) {
    STATE.qqqRegimeStale = true;
    log(`⚠️  QQQ regime error: ${err.message} (marked stale)`);
    return STATE.qqqRegime || 'NEUTRAL';
  }
}

async function fetchCryptoBreadth() {
  const spot = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
                'ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT'];
  let bullCount = 0, checked = 0;
  for (const sym of spot) {
    try {
      const c = await fetchBybitCandles(sym, '15', 40);
      if (!c || c.length < 20) { await sleep(200); continue; }
      const closes = c.map((x) => x.close);
      const ema20  = calcEMA(closes, 20);
      if (closes[closes.length - 1] > ema20[ema20.length - 1]) bullCount++;
      checked++;
    } catch { /* skip */ }
    await sleep(200);
  }
  if (checked === 0) {
    log(`⚠️  Breadth: Bybit unavailable — keeping ${STATE.cryptoBreadth}%`);
    return STATE.cryptoBreadth || 50;
  }
  const breadth = Math.round((bullCount / checked) * 100);
  log(`  Breadth: ${bullCount}/${checked} above EMA20 = ${breadth}%`);
  return breadth;
}

async function fetchFinnhubMovers() {
  try {
    if (!ENV.FINNHUB_API_KEY) return [];
    const url = `https://finnhub.io/api/v1/stock/market-status?exchange=US&token=${ENV.FINNHUB_API_KEY}`;
    await httpGet(url);
    return [];
  } catch {
    return [];
  }
}

// ============================================================
// SECTION 9: TECHNICAL INDICATORS
// ============================================================

function calcEMA(prices, period) {
  if (prices.length < period) return prices.map(() => prices[prices.length - 1]);
  const k = 2 / (period + 1);
  const result = [];
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) result.push(ema);
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcSMA(prices, period) {
  return prices.map((_, i) => {
    if (i < period - 1) return null;
    return prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function calcVWAP(candles) {
  let cumTPV = 0, cumVol = 0;
  return candles.map((c) => {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
    return cumVol > 0 ? cumTPV / cumVol : c.close;
  });
}

function calcATR(candles, period = 14) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  const result = [];
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) result.push(atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    result.push(atr);
  }
  return result;
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return prices.map(() => 50);
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  const result = new Array(period + 1).fill(50);
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(clamp(100 - 100 / (1 + rs)));
  }
  return result;
}

function calcBollingerBands(prices, period = 20, stdMult = 2) {
  const sma = calcSMA(prices, period);
  return prices.map((_, i) => {
    if (i < period - 1) return { upper: null, mid: null, lower: null, width: null };
    const slice = prices.slice(i - period + 1, i + 1);
    const mean = sma[i];
    const std = Math.sqrt(slice.reduce((s, p) => s + (p - mean) ** 2, 0) / period);
    return {
      upper: mean + stdMult * std,
      mid:   mean,
      lower: mean - stdMult * std,
      width: (2 * stdMult * std) / mean,
    };
  });
}

function calcMACD(prices, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(prices, fast);
  const emaSlow = calcEMA(prices, slow);
  const macdLine = emaFast.map((f, i) => f - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signal);
  const histogram = macdLine.map((m, i) => m - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

function calcVolumeSMA(volumes, period = 20) {
  return calcSMA(volumes, period);
}

function detectResistanceLevels(candles, lookback = 30) {
  const highs = candles.slice(-lookback).map((c) => c.high);
  const levels = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
        highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      levels.push(highs[i]);
    }
  }
  return levels;
}

function detectSupportLevels(candles, lookback = 30) {
  const lows = candles.slice(-lookback).map((c) => c.low);
  const levels = [];
  for (let i = 2; i < lows.length - 2; i++) {
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
        lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      levels.push(lows[i]);
    }
  }
  return levels;
}

// ============================================================
// SECTION 10: ENGINE 1 — MARKET CONTEXT (weight 0.08)
// ============================================================

function scoreMarketContext(assetType) {
  let score = 50;
  const reasons = [];

  if (STATE.btcRegime === 'BULL') {
    score += assetType === 'crypto' ? 20 : 5;
    reasons.push('BTC in bull structure');
  } else if (STATE.btcRegime === 'BEAR') {
    score -= assetType === 'crypto' ? 20 : 5;
    reasons.push('BTC in bear structure');
  }

  if (!STATE.qqqRegimeStale) {
    if (STATE.qqqRegime === 'BULL') {
      score += (assetType === 'us' || assetType === 'lse') ? 20 : 5;
      reasons.push('QQQ in bull structure');
    } else if (STATE.qqqRegime === 'BEAR') {
      score -= (assetType === 'us' || assetType === 'lse') ? 20 : 5;
      reasons.push('QQQ in bear structure');
    }
  }

  if (assetType === 'crypto') {
    if (STATE.cryptoBreadth >= 70) { score += 15; reasons.push('Broad crypto strength'); }
    else if (STATE.cryptoBreadth <= 30) { score -= 15; reasons.push('Crypto breadth weak'); }
  }

  if (assetType === 'us') {
    if (isMarketOpen('us')) {
      score += 10; reasons.push('US market open');
    } else {
      score -= 20;
      reasons.push(isUSMarketHoliday() ? 'US market closed (holiday)' : 'US market closed');
    }
  } else if (assetType === 'lse') {
    if (isMarketOpen('lse')) {
      score += 10; reasons.push('LSE market open');
    } else {
      score -= 20;
      reasons.push(isUKMarketHoliday() ? 'LSE market closed (holiday)' : 'LSE market closed');
    }
  } else {
    const hour = new Date().getUTCHours();
    if ((hour >= 7 && hour <= 9) || (hour >= 13 && hour <= 15)) {
      score += 10; reasons.push('High-activity crypto window');
    }
  }

  return { score: clamp(score), reasons };
}

// ============================================================
// MARKET HOLIDAY CALENDARS — US (NYSE/Nasdaq) and UK (LSE)
// ============================================================

const US_MARKET_HOLIDAYS_2026 = new Set([
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed, July 4 falls on Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas Day
]);

const US_MARKET_EARLY_CLOSE_2026 = new Set([
  '2026-11-25', // Day before Thanksgiving
  '2026-12-24', // Christmas Eve
]);

const UK_MARKET_HOLIDAYS_2026 = new Set([
  '2026-01-01', // New Year's Day
  '2026-04-03', // Good Friday
  '2026-04-06', // Easter Monday
  '2026-05-04', // Early May Bank Holiday
  '2026-05-25', // Spring Bank Holiday
  '2026-08-31', // Summer Bank Holiday
  '2026-12-25', // Christmas Day
  '2026-12-28', // Boxing Day (observed, Dec 26 falls on Saturday)
]);

function getUtcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function isUSMarketHoliday(date = new Date()) {
  return US_MARKET_HOLIDAYS_2026.has(getUtcDateString(date));
}

function isUKMarketHoliday(date = new Date()) {
  return UK_MARKET_HOLIDAYS_2026.has(getUtcDateString(date));
}

function isMarketOpen(assetType) {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const totalMin = hour * 60 + minute;
  const day = now.getUTCDay();

  if (day === 0 || day === 6) return assetType === 'crypto';

  if (assetType === 'us') {
    if (isUSMarketHoliday(now)) return false;
    return totalMin >= 13*60+30 && totalMin < 20*60;
  }
  if (assetType === 'lse') {
    if (isUKMarketHoliday(now)) return false;
    return totalMin >= 8*60 && totalMin < 16*60+30;
  }
  return true;
}

// ============================================================
// SECTION 11: ENGINE 2 — STRUCTURE (weight 0.12)
// ============================================================

function scoreStructure(candles) {
  const score_parts = [];
  const reasons = [];

  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const vwap  = calcVWAP(candles);
  const bb    = calcBollingerBands(closes);
  const e20   = ema20[ema20.length - 1];
  const e50   = ema50[ema50.length - 1];
  const vwapLast = vwap[vwap.length - 1];

  if (last > e20 && e20 > e50) {
    score_parts.push(85); reasons.push('Price > EMA20 > EMA50 (bullish stack)');
  } else if (last > e20 && e20 < e50) {
    score_parts.push(60); reasons.push('Price above EMA20, mixed stack');
  } else if (last < e20 && e20 < e50) {
    score_parts.push(20); reasons.push('Bearish EMA stack');
  } else {
    score_parts.push(45); reasons.push('Mixed EMA structure');
  }

  if (last > vwapLast) {
    score_parts.push(75); reasons.push('Trading above VWAP');
  } else {
    score_parts.push(35); reasons.push('Trading below VWAP');
  }

  const bbLast = bb[bb.length - 1];
  if (bbLast.width !== null) {
    const avgWidth = bb.slice(-20).filter((b) => b.width).reduce((s, b) => s + b.width, 0) / 20;
    if (bbLast.width < avgWidth * 0.7) {
      score_parts.push(80); reasons.push('BB compression — coiling for move');
    } else if (bbLast.width > avgWidth * 1.5) {
      score_parts.push(40); reasons.push('BB expanded — volatile');
    } else {
      score_parts.push(60);
    }
  }

  const recentLows = candles.slice(-6).map((c) => c.low);
  let higherLows = 0;
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i] > recentLows[i - 1]) higherLows++;
  }
  if (higherLows >= 4) { score_parts.push(85); reasons.push('Strong higher lows pattern'); }
  else if (higherLows >= 2) { score_parts.push(65); }
  else { score_parts.push(35); }

  const levels = detectResistanceLevels(candles);
  const nearResistance = levels.some((l) => l > last && l < last * 1.02);
  if (nearResistance) { score_parts.push(35); reasons.push('Near resistance — caution'); }
  else { score_parts.push(70); }

  const score = clamp(score_parts.reduce((a, b) => a + b, 0) / score_parts.length);
  return { score, reasons };
}

// ============================================================
// SECTION 12: ENGINE 3 — PARTICIPATION (weight 0.13)
// ============================================================

function scoreParticipation(candles) {
  const score_parts = [];
  const reasons = [];

  const volumes = candles.map((c) => c.volume);
  const closes  = candles.map((c) => c.close);
  const volSMA  = calcVolumeSMA(volumes, 20);

  const lastVol = volumes[volumes.length - 1];
  const smaVol  = volSMA[volSMA.length - 1];
  const prevVol = volumes[volumes.length - 2];

  const relVol = smaVol > 0 ? lastVol / smaVol : 1;
  if (relVol >= 3) { score_parts.push(95); reasons.push(`Relative volume ${round2(relVol)}x — exceptional`); }
  else if (relVol >= 2) { score_parts.push(80); reasons.push(`Relative volume ${round2(relVol)}x — strong`); }
  else if (relVol >= 1.5) { score_parts.push(65); reasons.push(`Relative volume ${round2(relVol)}x`); }
  else if (relVol >= 1) { score_parts.push(50); }
  else { score_parts.push(25); reasons.push('Below-average volume'); }

  const volAccel = prevVol > 0 ? lastVol / prevVol : 1;
  if (volAccel >= 2) { score_parts.push(85); reasons.push('Volume accelerating'); }
  else if (volAccel >= 1.3) { score_parts.push(65); }
  else { score_parts.push(45); }

  const dollarVol = lastVol * closes[closes.length - 1];
  if (dollarVol >= CONFIG.MIN_DOLLAR_VOLUME * 10) { score_parts.push(90); reasons.push('Very high dollar volume'); }
  else if (dollarVol >= CONFIG.MIN_DOLLAR_VOLUME) { score_parts.push(65); }
  else { score_parts.push(20); reasons.push('Low dollar volume — liquidity risk'); }

  const last5 = candles.slice(-5);
  const bullVol = last5.filter((c) => c.close > c.open).reduce((s, c) => s + c.volume, 0);
  const totalVol = last5.reduce((s, c) => s + c.volume, 0);
  const buyRatio = totalVol > 0 ? bullVol / totalVol : 0.5;
  if (buyRatio >= 0.7) { score_parts.push(80); reasons.push('Dominant buying pressure'); }
  else if (buyRatio >= 0.55) { score_parts.push(60); }
  else { score_parts.push(30); reasons.push('Selling pressure present'); }

  const score = clamp(score_parts.reduce((a, b) => a + b, 0) / score_parts.length);
  return { score, reasons };
}

// ============================================================
// SECTION 13: ENGINE 4 — MOMENTUM (weight 0.12)
// ============================================================

function scoreMomentum(candles) {
  const score_parts = [];
  const reasons = [];

  const closes = candles.map((c) => c.close);
  const rsi    = calcRSI(closes);
  const macd   = calcMACD(closes);
  const last   = closes[closes.length - 1];

  const roc5 = ((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100;
  if (roc5 >= 3) { score_parts.push(90); reasons.push(`Strong momentum +${round2(roc5)}%`); }
  else if (roc5 >= 1.5) { score_parts.push(70); reasons.push(`Positive momentum +${round2(roc5)}%`); }
  else if (roc5 >= 0) { score_parts.push(50); }
  else { score_parts.push(20); reasons.push(`Negative momentum ${round2(roc5)}%`); }

  const roc5prev = closes.length >= 11
    ? ((closes[closes.length - 6] - closes[closes.length - 11]) / closes[closes.length - 11]) * 100
    : roc5;
  if (roc5 > roc5prev + 0.5) { score_parts.push(80); reasons.push('Momentum accelerating'); }
  else if (roc5 > roc5prev) { score_parts.push(60); }
  else { score_parts.push(40); reasons.push('Momentum decelerating'); }

  // RSI with pivot-based bearish divergence (Plex formula, 2026-06-29)
  // PivotHigh(i) = 1 if High_i = max(High_{i-2}..High_{i+2}) — L=2, R=2
  // BearishDiv = price makes HH at pivot but RSI makes LH at same pivot
  // Guardrail: prior RSI pivot must be >=65 (ignore mid-range noise)
  const rsiLast = rsi[rsi.length - 1];
  const highs   = candles.map(c => c.high);
  const pivotIdxs = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] >= highs[i-1] && highs[i] >= highs[i-2] &&
        highs[i] >= highs[i+1] && highs[i] >= highs[i+2]) {
      pivotIdxs.push(i);
    }
  }
  let bearishDiv = false;
  if (pivotIdxs.length >= 2) {
    const h1 = pivotIdxs[pivotIdxs.length - 2];
    const h2 = pivotIdxs[pivotIdxs.length - 1];
    const barsBetween = h2 - h1;
    // Spacing guard: min=5 bars (avoid noise), max=30 bars (keep relevant)
    if (barsBetween >= 5 && barsBetween <= 30) {
      const priceHH          = highs[h2] > highs[h1];
      const rsiLH            = rsi[h2] < rsi[h1];
      const priorRSIElevated = rsi[h1] >= 65;
      bearishDiv = priceHH && rsiLH && priorRSIElevated;
    }
  }

  if (bearishDiv) {
    score_parts.push(25); reasons.push(`RSI ${round2(rsiLast)} — bearish divergence (pivot-confirmed)`);
  } else if (rsiLast >= 55 && rsiLast <= 75) { score_parts.push(80); reasons.push(`RSI ${round2(rsiLast)} — bullish zone`); }
  else if (rsiLast > 75) { score_parts.push(45); reasons.push(`RSI ${round2(rsiLast)} — overbought`); }
  else if (rsiLast >= 45) { score_parts.push(55); }
  else { score_parts.push(25); reasons.push(`RSI ${round2(rsiLast)} — weak`); }

  const hist = macd.histogram;
  const lastHist = hist[hist.length - 1];
  const prevHist = hist[hist.length - 2];
  if (lastHist > 0 && lastHist > prevHist) { score_parts.push(80); reasons.push('MACD histogram rising'); }
  else if (lastHist > 0) { score_parts.push(60); }
  else { score_parts.push(30); reasons.push('MACD below zero'); }

  let consec = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) consec++;
    else break;
  }
  if (consec >= 4) { score_parts.push(85); reasons.push(`${consec} consecutive green candles`); }
  else if (consec >= 2) { score_parts.push(65); }
  else { score_parts.push(40); }

  const roc20 = ((last - closes[closes.length - 21]) / closes[closes.length - 21]) * 100;
  if (roc20 > 15) { score_parts.push(30); reasons.push('Potentially extended — 20-period move large'); }
  else if (roc20 > 8) { score_parts.push(55); }
  else { score_parts.push(70); reasons.push('Fresh move — not extended'); }

  const score = clamp(score_parts.reduce((a, b) => a + b, 0) / score_parts.length);
  return { score, reasons };
}

// ============================================================
// SECTION 14: ENGINE 5 — STAGE CLASSIFICATION (weight 0.08)
// ============================================================

function classifyStage(candles) {
  const closes  = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ema20   = calcEMA(closes, 20);
  const ema50   = calcEMA(closes, 50);
  const rsi     = calcRSI(closes);
  const bb      = calcBollingerBands(closes);
  const volSMA  = calcVolumeSMA(volumes, 20);

  const last      = closes[closes.length - 1];
  const e20       = ema20[ema20.length - 1];
  const e50       = ema50[ema50.length - 1];
  const rsiLast   = rsi[rsi.length - 1];
  const bbLast    = bb[bb.length - 1];
  const relVol    = volumes[volumes.length - 1] / (volSMA[volSMA.length - 1] || 1);
  const avgWidth  = bb.slice(-20).filter((b) => b.width).reduce((s, b) => s + b.width, 0) / 20;
  const compressed = bbLast.width < avgWidth * 0.7;
  const roc3 = ((last - closes[closes.length - 4]) / closes[closes.length - 4]) * 100;

  let stage = 'WAITING';
  let stageScore = 60;

  if (rsiLast < 40 && last < e50) {
    stage = 'SLEEPING'; stageScore = 45;
  } else if (compressed && relVol < 1.2 && Math.abs(roc3) < 1) {
    stage = 'LOADING'; stageScore = 72;
  } else if (compressed && relVol >= 1.2 && last > e20) {
    stage = 'READY'; stageScore = 85;
  } else if (roc3 > 2 && relVol >= 1.5 && last > e20) {
    stage = 'BREAKING'; stageScore = 92;
  } else if (roc3 > 1 && relVol >= 1.2 && last > e20 && e20 > e50) {
    stage = 'RUNNING'; stageScore = 78;
  } else if (rsiLast > 75 || (last > e20 * 1.08)) {
    stage = 'EXHAUSTION'; stageScore = 25;
  } else if (last < e20 && roc3 < -2) {
    stage = 'FAILURE'; stageScore = 10;
  }

  return { stage, stageScore, score: clamp(stageScore) };
}

// ============================================================
// SECTION 15: ENGINE 6 — EXECUTION QUALITY (weight 0.22 — highest)
// ============================================================

function scoreExecutionQuality(candles) {
  const score_parts = [];
  const reasons = [];

  const closes = candles.map((c) => c.close);
  const ema20  = calcEMA(closes, 20);
  const vwap   = calcVWAP(candles);
  const atr    = calcATR(candles);

  const last     = closes[closes.length - 1];
  const e20      = ema20[ema20.length - 1];
  const vwapLast = vwap[vwap.length - 1];
  const atrLast  = atr[atr.length - 1];
  const lastCandle = candles[candles.length - 1];

  const pctAboveEMA = ((last - e20) / e20) * 100;
  if (pctAboveEMA >= 0 && pctAboveEMA <= 1.5) {
    score_parts.push(90); reasons.push('Tight to EMA20 — ideal entry zone');
  } else if (pctAboveEMA > 1.5 && pctAboveEMA <= 3) {
    score_parts.push(65); reasons.push('Slightly extended from EMA20');
  } else if (pctAboveEMA > 3) {
    score_parts.push(30); reasons.push(`Extended ${round2(pctAboveEMA)}% from EMA20 — risky entry`);
  } else {
    score_parts.push(40); reasons.push('Below EMA20 — structure weak');
  }

  const pctAboveVWAP = ((last - vwapLast) / vwapLast) * 100;
  if (pctAboveVWAP >= 0 && pctAboveVWAP <= 1.5) {
    score_parts.push(85); reasons.push('Close to VWAP — good R:R anchor');
  } else if (pctAboveVWAP > 1.5 && pctAboveVWAP <= 3) {
    score_parts.push(60);
  } else if (pctAboveVWAP > 3) {
    score_parts.push(25); reasons.push(`${round2(pctAboveVWAP)}% above VWAP — stretched`);
  } else {
    score_parts.push(50);
  }

  const stopDistance = atrLast * 1.5;
  const stopPrice    = last - stopDistance;
  const t1Price      = last + atrLast * 2;
  const t2Price      = last + atrLast * 4;
  const rrRatio      = stopDistance > 0 ? (t1Price - last) / stopDistance : 0;

  if (rrRatio >= 2.5) {
    score_parts.push(90); reasons.push(`R:R ${round2(rrRatio)}:1 — excellent`);
  } else if (rrRatio >= 1.8) {
    score_parts.push(70); reasons.push(`R:R ${round2(rrRatio)}:1 — acceptable`);
  } else if (rrRatio >= 1.3) {
    score_parts.push(45); reasons.push(`R:R ${round2(rrRatio)}:1 — marginal`);
  } else {
    score_parts.push(15); reasons.push(`R:R ${round2(rrRatio)}:1 — poor`);
  }

  const candleRange = lastCandle.high - lastCandle.low;
  const closePosition = candleRange > 0 ? (lastCandle.close - lastCandle.low) / candleRange : 0.5;
  const upperWick = candleRange > 0 ? (lastCandle.high - lastCandle.close) / candleRange : 0;

  if (closePosition >= 0.7 && upperWick <= 0.2) {
    score_parts.push(85); reasons.push('Strong bullish candle close');
  } else if (closePosition >= 0.5) {
    score_parts.push(60);
  } else {
    score_parts.push(25); reasons.push('Weak candle close — selling pressure visible');
  }

  const score = clamp(score_parts.reduce((a, b) => a + b, 0) / score_parts.length);
  return {
    score, reasons, stopPrice, t1Price, t2Price, rrRatio,
    stopDistance, entry: last,
  };
}

// ============================================================
// SECTION 15b: EXECUTION ENGINE — ORDER TYPE & ENTRY METHOD
// ============================================================

const SETUP_TYPES = {
  PULLBACK_CONTINUATION: 'PULLBACK_CONTINUATION',
  BREAKOUT_CONTINUATION: 'BREAKOUT_CONTINUATION',
  MOMENTUM_IGNITION:     'MOMENTUM_IGNITION',
  PARABOLIC_EXTENSION:   'PARABOLIC_EXTENSION',
};

const ORDER_TYPES = {
  LIMIT:      'LIMIT',
  STOP:       'STOP',
  MARKET:     'MARKET',
  STOP_LIMIT: 'STOP_LIMIT',
  NO_ENTRY:   'NO_ENTRY',
};

const MAX_SPREAD_FOR_MARKET = 0.004;

function classifySetupType(candles, stageInfo) {
  const closes  = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ema20   = calcEMA(closes, 20);
  const volSMA  = calcVolumeSMA(volumes, 20);
  const rsi     = calcRSI(closes);
  const bb      = calcBollingerBands(closes);

  const last     = closes[closes.length - 1];
  const e20      = ema20[ema20.length - 1];
  const relVol   = volumes[volumes.length - 1] / (volSMA[volSMA.length - 1] || 1);
  const rsiLast  = rsi[rsi.length - 1];
  const bbLast   = bb[bb.length - 1];
  const avgWidth = bb.slice(-20).filter((b) => b.width).reduce((s, b) => s + b.width, 0) / 20;

  const roc3 = closes.length >= 4
    ? ((last - closes[closes.length - 4]) / closes[closes.length - 4]) * 100 : 0;
  const roc6 = closes.length >= 7
    ? ((last - closes[closes.length - 7]) / closes[closes.length - 7]) * 100 : 0;

  // Two-of-three parabolic gate (Plex formula, 2026-06-29)
  // EXT_t = 1(RSI>78) + 1(ROC6>8) + 1(RVOL≥2.0)
  // PARABOLIC_BLOCK = 1 if EXT_t >= 2
  // Fixes: old all-three let near-parabolic moves through as PULLBACK_CONTINUATION
  // RVOL: 10-bar prior average excluding current bar (per Plex formula)
  const volSMA10 = volumes.length >= 11
    ? volumes.slice(-11, -1).reduce((a,b) => a+b, 0) / 10
    : (volSMA[volSMA.length-1] || 1);
  const rvolPlex = volSMA10 > 0 ? volumes[volumes.length-1] / volSMA10 : relVol;

  const extRSI   = rsiLast > 78;
  const extROC   = roc6 > 8.0;
  const extVol   = rvolPlex >= 2.0;
  const extCount = (extRSI ? 1 : 0) + (extROC ? 1 : 0) + (extVol ? 1 : 0);
  if (extCount >= 2) {
    return SETUP_TYPES.PARABOLIC_EXTENSION;
  }

  const resistanceLevels = detectResistanceLevels(candles);
  const nearBreakout = resistanceLevels.some((l) => last >= l * 0.995 && last <= l * 1.015);
  const compressed = bbLast.width !== null && bbLast.width < avgWidth * 0.75;
  if ((nearBreakout || compressed) && relVol >= 1.3 && stageInfo.stage === 'BREAKING') {
    return SETUP_TYPES.BREAKOUT_CONTINUATION;
  }

  if (roc3 >= 2.5 && relVol >= 2.5 && rsiLast >= 60) {
    return SETUP_TYPES.MOMENTUM_IGNITION;
  }

  return SETUP_TYPES.PULLBACK_CONTINUATION;
}

function buildExecutionPlan(candles, setupType, execution, assetType) {
  const last       = execution.entry;
  const atr        = calcATR(candles);
  const atrLast    = atr[atr.length - 1];
  const lastCandle = candles[candles.length - 1];
  const spread     = (lastCandle.high - lastCandle.low) / last;

  const resistanceLevels  = detectResistanceLevels(candles);
  const nearestResistance = resistanceLevels
    .filter((l) => l > last)
    .sort((a, b) => a - b)[0] || last * 1.005;

  let orderType, entryPrice, entryZoneLow, entryZoneHigh;
  let chaseLimit, cancelCondition, executionPlan, executionScore;
  let rejectEntry = false, rejectReason = '';

  switch (setupType) {

    case SETUP_TYPES.PULLBACK_CONTINUATION: {
      orderType = ORDER_TYPES.LIMIT;
      const ema20arr = calcEMA(candles.map((c) => c.close), 20);
      const e20      = ema20arr[ema20arr.length - 1];
      const vwap     = calcVWAP(candles);
      const vwapLast = vwap[vwap.length - 1];
      entryZoneLow   = round2(Math.min(e20, vwapLast) * 0.998);
      entryZoneHigh  = round2(last);
      entryPrice     = round2(Math.min(last, (e20 + vwapLast) / 2));
      chaseLimit     = round2(entryPrice * 1.0025);
      cancelCondition = `Cancel if price closes above $${round2(last * 1.015)} before entry, or setup not triggered within 4 hours`;
      executionPlan   = `Place BUY LIMIT at $${entryPrice}. Do not chase above $${chaseLimit} (0.25% max). Cancel if price closes above $${round2(last * 1.015)} before entry. Setup expires end of session if not triggered.`;
      executionScore  = 88;
      break;
    }

    case SETUP_TYPES.BREAKOUT_CONTINUATION: {
      orderType      = ORDER_TYPES.STOP;
      entryPrice     = round2(nearestResistance * 1.001);
      entryZoneLow   = round2(nearestResistance);
      entryZoneHigh  = round2(nearestResistance * 1.005);
      chaseLimit     = round2(entryPrice * 1.003);
      cancelCondition = `Do not enter if breakout candle closes back below $${round2(nearestResistance)}. Cancel if not triggered within 2 hours.`;
      executionPlan   = `Place BUY STOP at $${entryPrice} (just above resistance $${round2(nearestResistance)}). Only fills if level actually breaks. Cancel immediately if price closes back below resistance. Do not anticipate — wait for confirmation.`;
      executionScore  = 75;
      break;
    }

    case SETUP_TYPES.MOMENTUM_IGNITION: {
      if (spread > MAX_SPREAD_FOR_MARKET) {
        rejectEntry    = true;
        rejectReason   = `Spread ${round2(spread * 100)}% exceeds MARKET order threshold — execution quality too poor`;
        orderType      = ORDER_TYPES.NO_ENTRY;
        executionScore = 15;
      } else {
        orderType      = ORDER_TYPES.MARKET;
        entryPrice     = round2(last);
        entryZoneLow   = round2(last);
        entryZoneHigh  = round2(last * 1.005);
        chaseLimit     = null;
        cancelCondition = `Abort if spread widens above 0.4% at execution. Momentum decays fast — if not in within 1 candle, reassess.`;
        executionPlan   = `Enter at MARKET immediately. Spread ${round2(spread * 100)}% — within threshold. Speed is priority. Abort if spread widens at execution.`;
        executionScore  = 70;
      }
      break;
    }

    case SETUP_TYPES.PARABOLIC_EXTENSION: {
      rejectEntry    = true;
      rejectReason   = 'Parabolic extension — trade already happened. Wait for pullback to EMA20/VWAP before considering entry.';
      orderType      = ORDER_TYPES.NO_ENTRY;
      entryPrice     = null;
      chaseLimit     = null;
      cancelCondition = 'N/A — no entry on parabolic extension';
      executionPlan   = 'NO ENTRY. Parabolic extension detected. Wait for consolidation or pullback to EMA20/VWAP. Reassess next session.';
      executionScore  = 0;
      break;
    }

    default: {
      orderType      = ORDER_TYPES.LIMIT;
      entryPrice     = round2(last);
      entryZoneLow   = round2(last * 0.998);
      entryZoneHigh  = round2(last * 1.002);
      chaseLimit     = round2(last * 1.003);
      cancelCondition = 'Cancel if price moves more than 1.5% against entry before fill';
      executionPlan   = `Place BUY LIMIT at $${entryPrice}. Cancel if not filled within 2 hours.`;
      executionScore  = 60;
    }
  }

  const entryRef   = entryPrice || execution.entry;
  const atrForStop = atr[atr.length - 1];
  const SL_ATR_MULT  = 1.8;
  const TP1_ATR_MULT = 3.0;
  const TP2_ATR_MULT = 6.0;
  const stopFromEntry = round2(entryRef - atrForStop * SL_ATR_MULT);
  const t1FromEntry   = round2(entryRef + atrForStop * TP1_ATR_MULT);
  const t2FromEntry   = round2(entryRef + atrForStop * TP2_ATR_MULT);
  const rrFromEntry   = atrForStop > 0 ? round2((t1FromEntry - entryRef) / (atrForStop * SL_ATR_MULT)) : 0;

  if (!rejectEntry && stopFromEntry >= entryRef) {
    rejectEntry  = true;
    rejectReason = `Invalid trade structure: stop $${stopFromEntry} >= entry $${entryRef} — ATR too small relative to price`;
    log(`🚫 INVALID STRUCTURE ${setupType}: stop ${stopFromEntry} >= entry ${entryRef}`);
  }

  return {
    setupType, orderType, entryPrice: entryRef, entryZoneLow, entryZoneHigh,
    stopPrice: stopFromEntry, t1Price: t1FromEntry, t2Price: t2FromEntry, rrRatio: rrFromEntry,
    chaseLimit, cancelCondition, executionPlan, executionScore,
    rejectEntry, rejectReason,
    spread: round2(spread * 100),
  };
}

function runExecutionEngine(candles, stageInfo, executionQuality, assetType) {
  const setupType  = classifySetupType(candles, stageInfo);
  const plan       = buildExecutionPlan(candles, setupType, executionQuality, assetType);
  const blendedScore = clamp(executionQuality.score * 0.6 + plan.executionScore * 0.4);
  return {
    ...plan,
    engine6Score: executionQuality.score,
    blendedScore,
    hardReject:   plan.rejectEntry,
  };
}

// ============================================================
// SECTION 16: ENGINE 7 — RISK (weight 0.10)
// ============================================================

function scoreRisk(candles, assetType) {
  const score_parts = [];
  const reasons = [];

  const closes  = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const atr     = calcATR(candles);

  const last    = closes[closes.length - 1];
  const atrLast = atr[atr.length - 1];
  const atrPct  = (atrLast / last) * 100;

  const avgDollarVol = volumes.slice(-20).reduce((s, v, i) => {
    return s + v * closes[closes.length - 20 + i];
  }, 0) / 20;

  if (avgDollarVol >= CONFIG.MIN_DOLLAR_VOLUME * 5) {
    score_parts.push(90); reasons.push('High liquidity');
  } else if (avgDollarVol >= CONFIG.MIN_DOLLAR_VOLUME) {
    score_parts.push(65);
  } else {
    score_parts.push(20); reasons.push('Low liquidity — execution risk');
  }

  const spreadProxy = ((candles[candles.length - 1].high - candles[candles.length - 1].low) / last) * 100;
  if (spreadProxy <= 0.3) { score_parts.push(90); }
  else if (spreadProxy <= 0.8) { score_parts.push(65); }
  else { score_parts.push(30); reasons.push('Wide spread — slippage risk'); }

  if (atrPct <= 1.5) { score_parts.push(80); reasons.push('Low ATR — controlled volatility'); }
  else if (atrPct <= 3) { score_parts.push(60); }
  else if (atrPct <= 5) { score_parts.push(40); }
  else { score_parts.push(15); reasons.push(`High ATR ${round2(atrPct)}% — elevated risk`); }

  const recentHigh = Math.max(...closes.slice(-20));
  const drawdown   = ((recentHigh - last) / recentHigh) * 100;
  if (drawdown <= 3) { score_parts.push(75); }
  else if (drawdown <= 8) { score_parts.push(50); }
  else { score_parts.push(25); reasons.push(`${round2(drawdown)}% off recent high`); }

  const score = clamp(score_parts.reduce((a, b) => a + b, 0) / score_parts.length);
  return { score, reasons };
}

// ============================================================
// SECTION 17: ENGINE 8 — DECISION STABILITY
// ============================================================

function scoreDecisionStability(candles, baseScores) {
  const reasons = [];
  let stabilityScore = 100;

  const priceStressCandles = candles.map((c, i) => {
    if (i < candles.length - 3) return c;
    return { ...c, close: c.close * 0.98, low: Math.min(c.low, c.close * 0.98) };
  });
  const stressedExec = scoreExecutionQuality(priceStressCandles);
  if (stressedExec.score < CONFIG.THRESHOLDS.executionHardFloor) {
    stabilityScore -= 30; reasons.push('Fails 2% price stress test');
  }

  const volStressCandles = candles.map((c, i) => {
    if (i < candles.length - 3) return c;
    return { ...c, volume: c.volume * 0.5 };
  });
  const stressedPart = scoreParticipation(volStressCandles);
  if (stressedPart.score < 40) {
    stabilityScore -= 20; reasons.push('Participation collapses under volume stress');
  }

  if (STATE.btcRegime === 'BULL') {
    const origBTC = STATE.btcRegime;
    STATE.btcRegime = 'NEUTRAL';
    const stressedCtx = scoreMarketContext('crypto');
    STATE.btcRegime = origBTC;
    if (stressedCtx.score < 40) {
      stabilityScore -= 15; reasons.push('Setup depends heavily on BTC strength');
    }
  }

  if (stabilityScore >= 85) reasons.push('Setup robust across stress scenarios');
  else if (stabilityScore >= 60) reasons.push('Setup stable with minor stress sensitivity');

  return { score: clamp(stabilityScore), reasons };
}

// ============================================================
// SECTION 18: ENGINE 9 — EDGE SCORE
// ============================================================

function scoreEdge(hunterScore) {
  const fieldAvg = STATE.fieldAverage || 50;
  const edge = hunterScore - fieldAvg;
  const reasons = [];

  let score = 50;
  if (edge >= 25) { score = 95; reasons.push(`${round2(edge)} points above field average — exceptional edge`); }
  else if (edge >= CONFIG.THRESHOLDS.edgeMinimumOverField) { score = 75; reasons.push(`${round2(edge)} points above field — solid edge`); }
  else if (edge >= 5) { score = 55; reasons.push(`${round2(edge)} points above field — marginal edge`); }
  else { score = 25; reasons.push(`Only ${round2(edge)} points above field — insufficient edge`); }

  return { score: clamp(score), edge, reasons };
}

// ============================================================
// SECTION 19: ENGINE 10 — COMPETITION ENGINE
// ============================================================

function scoreCompetition(symbol, hunterScore) {
  const candidates = STATE.candidateHistory.slice(-50);
  if (candidates.length < 2) return { score: 70, gap: 0, rank: 1, reasons: ['Insufficient field data'] };

  const sorted = [...candidates].sort((a, b) => b.hunterScore - a.hunterScore);
  const rank   = sorted.findIndex((c) => c.symbol === symbol) + 1;
  const best   = sorted[0];
  const second = sorted[1];

  const gap = rank === 1
    ? hunterScore - (second?.hunterScore || 0)
    : best.hunterScore - hunterScore;

  const reasons = [];
  let score = 50;

  if (rank === 1 && gap >= CONFIG.THRESHOLDS.competitionGap) {
    score = 90; reasons.push(`Ranked #1, beats #2 by ${round2(gap)} pts`);
  } else if (rank === 1) {
    score = 60; reasons.push(`Ranked #1 but gap to #2 only ${round2(gap)} pts`);
  } else if (rank <= 3) {
    score = 45; reasons.push(`Ranked #${rank} — not clear best`);
  } else {
    score = 20; reasons.push(`Ranked #${rank} — better setups exist`);
  }

  return { score: clamp(score), gap, rank, reasons };
}

// ============================================================
// SECTION 20: ENGINE 11 — CONFIDENCE
// ============================================================

function scoreConfidence(allScores) {
  const W = CONFIG.WEIGHTS;
  const weightMap = {
    marketContext:    W.marketContext,
    structure:        W.structure,
    participation:    W.participation,
    momentum:         W.momentum,
    stage:            W.stage,
    executionQuality: W.executionQuality,
    risk:             W.risk,
  };

  const entries = Object.entries(allScores).filter(([k, v]) => typeof v === 'number' && weightMap[k] !== undefined);
  const totalWeight = entries.reduce((s, [k]) => s + weightMap[k], 0);

  let logSum = 0;
  for (const [k, v] of entries) {
    const safe = Math.max(v, 1);
    logSum += weightMap[k] * Math.log(safe);
  }
  const geomMean = Math.exp(logSum / totalWeight);

  const scores = entries.map(([, v]) => v);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const minScore = Math.min(...scores);
  const stdDev = Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length);

  const reasons = [];
  const gap = mean - geomMean;
  if (minScore < 45) reasons.push(`Weak engine dragging confidence (min=${round2(minScore)})`);
  else if (gap < 3) reasons.push('Signals highly aligned');
  else if (gap < 8) reasons.push('Good signal alignment');
  else reasons.push('Some engines notably weaker — confidence reduced');

  return { score: clamp(geomMean), stdDev, mean, minScore, reasons };
}

// ============================================================
// SECTION 21: ENGINE 12 — CONVICTION
// ============================================================

function scoreConviction(allScores, stage, stability) {
  let conviction = 50;
  const reasons = [];

  if (allScores.executionQuality < CONFIG.THRESHOLDS.executionHardFloor) {
    return { score: 10, reasons: ['HARD GATE: Execution quality below floor'] };
  }
  if (stage === 'SLEEPING' || stage === 'FAILURE' || stage === 'EXHAUSTION') {
    return { score: 10, reasons: [`HARD GATE: Stage is ${stage}`] };
  }
  if (stability < 50) {
    return { score: 15, reasons: ['HARD GATE: Setup unstable under stress'] };
  }

  if (allScores.structure >= 75) { conviction += 10; reasons.push('Strong structure'); }
  if (allScores.participation >= 70) { conviction += 10; reasons.push('Solid participation'); }
  if (allScores.momentum >= 70) { conviction += 10; reasons.push('Clear momentum'); }
  if (allScores.marketContext >= 65) { conviction += 8; reasons.push('Supportive context'); }
  if (allScores.executionQuality >= 75) { conviction += 15; reasons.push('High-quality execution entry'); }

  if (allScores.risk < 50) { conviction -= 15; reasons.push('Risk profile weak'); }
  if (allScores.marketContext < 40) { conviction -= 10; reasons.push('Context unfavorable'); }

  const passesFinalTest = (
    allScores.executionQuality >= 65 &&
    allScores.structure >= 55 &&
    allScores.risk >= 50 &&
    stability >= 60
  );

  if (!passesFinalTest) {
    conviction = Math.min(conviction, 50);
    reasons.push('FAILS final conviction test — would not be happy with loss tomorrow');
  } else {
    reasons.push('Passes final conviction test');
  }

  return { score: clamp(conviction), passesFinalTest, reasons };
}

// ============================================================
// SECTION 22: MASTER SCORING ENGINE
// ============================================================

async function scoreAsset(symbol, assetType) {
  try {
    let candles;
    if (assetType === 'crypto') candles = await fetchCryptoCandles(symbol);
    else if (assetType === 'lse')  candles = await fetchLSECandles(symbol);
    else                           candles = await fetchUSStockCandles(symbol);

    if (!candles || candles.length < 50) {
      return { symbol, assetType, decision: 'REJECT', rejectReason: 'Insufficient data', hunterScore: 0 };
    }

    const marketCtx  = scoreMarketContext(assetType);
    const structure  = scoreStructure(candles);
    const part       = scoreParticipation(candles);
    const momentum   = scoreMomentum(candles);
    const stageInfo     = classifyStage(candles);
    const execution     = scoreExecutionQuality(candles);
    const execEngine    = runExecutionEngine(candles, stageInfo, execution, assetType);
    const risk          = scoreRisk(candles, assetType);

    if (execEngine.hardReject) {
      return {
        symbol, assetType, decision: 'REJECT',
        rejectReason: execEngine.rejectReason,
        hunterScore: 0, execEngine,
      };
    }

    const rawScores = {
      marketContext:    marketCtx.score,
      structure:        structure.score,
      participation:    part.score,
      momentum:         momentum.score,
      stage:            stageInfo.score,
      executionQuality: execEngine.blendedScore,
      risk:             risk.score,
    };

    const W = CONFIG.WEIGHTS;
    const weightedSum = (
      rawScores.marketContext    * W.marketContext +
      rawScores.structure        * W.structure +
      rawScores.participation    * W.participation +
      rawScores.momentum         * W.momentum +
      rawScores.executionQuality * W.executionQuality +
      rawScores.risk             * W.risk +
      rawScores.stage            * W.stage
    );
    const weightWithoutEdge = Object.values(W).reduce((a, b) => a + b, 0) - W.edge;
    const preEdgeScore = clamp(weightedSum / weightWithoutEdge);

    const stability = scoreDecisionStability(candles, rawScores);
    const confidence = scoreConfidence(rawScores);
    const conviction = scoreConviction(rawScores, stageInfo.stage, stability.score);

    return {
      symbol,
      assetType,
      preEdgeScore,
      rawScores,
      stageInfo,
      execution,
      execEngine,
      stability,
      confidence,
      conviction,
      reasons: {
        marketContext: marketCtx.reasons,
        structure:     structure.reasons,
        participation: part.reasons,
        momentum:      momentum.reasons,
        stage:         [stageInfo.stage],
        execution:     execution.reasons,
        execEngine:    [execEngine.setupType, execEngine.orderType, execEngine.executionPlan],
        risk:          risk.reasons,
        stability:     stability.reasons,
        confidence:    confidence.reasons,
        conviction:    conviction.reasons,
      },
      candles,
    };
  } catch (err) {
    return { symbol, assetType, decision: 'REJECT', rejectReason: `Error: ${err.message}`, hunterScore: 0 };
  }
}

// ============================================================
// SECTION 23: FIELD ANALYSIS & FINAL DECISION
// ============================================================

async function runFullScan() {
  log('🔍 Hunter scan starting...');

  const refreshBreadth = STATE.cycleCount % 10 === 1;
  const [btcR, qqqR, breadthR] = await Promise.all([
    fetchBTCRegime(),
    fetchQQQRegime(),
    refreshBreadth ? fetchCryptoBreadth() : Promise.resolve(STATE.cryptoBreadth),
  ]);
  STATE.btcRegime    = btcR;
  STATE.qqqRegime    = qqqR;
  STATE.cryptoBreadth = breadthR;
  log(`Market: BTC=${STATE.btcRegime} QQQ=${STATE.qqqRegime} Breadth=${STATE.cryptoBreadth}%`);

  const usOpen  = isMarketOpen('us');
  const lseOpen = isMarketOpen('lse');
  if (!usOpen)  log('⏸️  US market closed (holiday or outside hours) — skipping 37 US assets, saving scan credits');
  if (!lseOpen) log('⏸️  LSE market closed (holiday or outside hours) — skipping 18 LSE assets, saving scan credits');

  const universe = [
    ...CORE_CRYPTO.map((s) => ({ symbol: s, type: 'crypto' })),
    ...(usOpen  ? CORE_US_STOCKS.map((s) => ({ symbol: s, type: 'us' }))   : []),
    ...(lseOpen ? CORE_LSE_STOCKS.map((s) => ({ symbol: s, type: 'lse' })) : []),
    ...[...STATE.dynamicAssets.entries()]
      .filter(([, v]) => Date.now() < v.expires)
      .filter(([, v]) => v.type === 'crypto' || (v.type === 'us' && usOpen) || (v.type === 'lse' && lseOpen))
      .map(([s, v]) => ({ symbol: s, type: v.type })),
    ...[...STATE.hunterSlots.entries()]
      .filter(([, v]) => v.type === 'crypto' || (v.type === 'us' && usOpen) || (v.type === 'lse' && lseOpen))
      .map(([s, v]) => ({ symbol: s, type: v.type })),
  ];

  const totalAssets = universe.length;
  const results = [];
  let rejected = 0;

  for (const asset of universe) {
    const result = await scoreAsset(asset.symbol, asset.type);
    results.push(result);
    await sleep(150);
  }

  const validScores = results
    .filter((r) => r.preEdgeScore > 0 && r.rejectReason !== 'Insufficient data')
    .filter((r) => !r.rejectReason?.startsWith('Error'))
    .map((r) => r.preEdgeScore);
  const realDataScores = validScores.filter((s) => s !== 50);
  const fieldScores = realDataScores.length >= 10 ? realDataScores : validScores;
  STATE.fieldAverage = fieldScores.length
    ? fieldScores.reduce((a, b) => a + b, 0) / fieldScores.length
    : 55;

  const scored = results
    .filter((r) => r.preEdgeScore > 0)
    .map((r) => {
      const edgeResult = scoreEdge(r.preEdgeScore);
      const hunterScore = clamp(
        r.preEdgeScore * (1 - CONFIG.WEIGHTS.edge) +
        edgeResult.score * CONFIG.WEIGHTS.edge
      );
      return { ...r, edgeResult, hunterScore };
    })
    .sort((a, b) => b.hunterScore - a.hunterScore);

  STATE.candidateHistory = scored.map((s) => ({ symbol: s.symbol, hunterScore: s.hunterScore }));
  if (scored.length > 0) STATE.fieldBest = scored[0];
  if (scored.length > 1) STATE.fieldSecondBest = scored[1];

  const withCompetition = scored.map((r) => {
    const comp = scoreCompetition(r.symbol, r.hunterScore);
    const finalScore = clamp(r.hunterScore * 0.9 + comp.score * 0.1);
    return { ...r, comp, finalScore };
  });

  const finalCandidates = withCompetition.map((r) => {
    let decision = 'REJECT';
    const rejectReasons = [];

    if (!isMarketOpen(r.assetType)) {
      rejectReasons.push(`${r.assetType.toUpperCase()} market closed \u2014 cannot execute`);
    }
    else if (r.rawScores?.executionQuality < (
      (r.execEngine?.setupType === 'BREAKOUT_CONTINUATION' || r.execEngine?.setupType === 'MOMENTUM_IGNITION')
        ? 50
        : CONFIG.THRESHOLDS.executionHardFloor
    )) {
      rejectReasons.push(`Execution quality ${round2(r.rawScores.executionQuality)} below floor for ${r.execEngine?.setupType || 'setup'}`);
    }
    else if (r.confidence?.score < CONFIG.THRESHOLDS.confidenceMinimum) {
      rejectReasons.push(`Confidence ${round2(r.confidence.score)} below minimum`);
    }
    else if (r.conviction?.score < CONFIG.THRESHOLDS.convictionMinimum) {
      rejectReasons.push(`Conviction ${round2(r.conviction.score)} below minimum`);
    }
    else if (r.edgeResult?.edge < CONFIG.THRESHOLDS.edgeMinimumOverField) {
      rejectReasons.push(`Edge ${round2(r.edgeResult.edge)} below minimum over field`);
    }
    else if (r.comp?.rank !== 1 && r.comp?.rank !== 0) {
      rejectReasons.push(`Not field leader (rank #${r.comp?.rank}) — better setups exist`);
    }
    else if ((r.rawScores?.structure || 0) < 60) {
      rejectReasons.push(`Structure ${round2(r.rawScores?.structure)} below minimum (60)`);
    }
    else if ((r.rawScores?.risk || 0) < 50) {
      rejectReasons.push(`Risk ${round2(r.rawScores?.risk)} below minimum (50)`);
    }
    else {
      let adjustedScore = r.finalScore;
      if (r.comp?.rank === 1 && (r.comp?.gap || 0) >= CONFIG.THRESHOLDS.competitionGap) {
        adjustedScore = Math.min(100, r.finalScore + CONFIG.THRESHOLDS.competitionBonus);
        r.competitionBonusApplied = CONFIG.THRESHOLDS.competitionBonus;
      }
      r.adjustedScore = round2(adjustedScore);

      if (adjustedScore >= CONFIG.THRESHOLDS.hunterScoreElite) decision = 'BUY';
      else if (adjustedScore >= CONFIG.THRESHOLDS.hunterScoreGood) decision = 'BUY';
      else if (adjustedScore >= CONFIG.THRESHOLDS.hunterScoreWatch) decision = 'WATCH';
      else decision = 'WAIT';
    }

    if (rejectReasons.length > 0) {
      decision = 'REJECT';
      rejected++;
      for (const reason of rejectReasons) {
        const key = reason.split(' ')[0] + ' ' + (reason.split(' ')[1] || '');
        STATE.rejectionStats.set(key, (STATE.rejectionStats.get(key) || 0) + 1);
      }
    }

    return { ...r, decision, rejectReasons };
  });

  const buys   = finalCandidates.filter((c) => c.decision === 'BUY');
  const watches = finalCandidates.filter((c) => c.decision === 'WATCH');

  STATE.lastScan = {
    timestamp:   Date.now(),
    totalAssets,
    rejected:    finalCandidates.filter((c) => c.decision === 'REJECT').length,
    buys,
    watches,
    candidates:  finalCandidates,
    fieldAvg:    STATE.fieldAverage,
  };

  log(`Scan complete: ${totalAssets} analysed, ${buys.length} BUY signals, ${watches.length} WATCH`);

  // ── Data collection stats ────────────────────────────
  const dataStats = { crypto:{ok:0,fail:0}, us:{ok:0,fail:0}, lse:{ok:0,fail:0} };
  for (const r of results) {
    const t = r.assetType || 'unknown';
    if (dataStats[t]) {
      if (r.rejectReason === 'Insufficient data' || r.rejectReason?.startsWith('Error')) dataStats[t].fail++;
      else if (r.preEdgeScore > 0) dataStats[t].ok++;
    }
  }
  log(`  Data: crypto=${dataStats.crypto.ok}ok/${dataStats.crypto.fail}fail US=${dataStats.us.ok}ok/${dataStats.us.fail}fail LSE=${dataStats.lse.ok}ok/${dataStats.lse.fail}fail`);

  // ── Rejection funnel ─────────────────────────────────
  const T = CONFIG.THRESHOLDS;
  const withData = finalCandidates.filter((c) => c.finalScore > 0);
  const funnelMarketOpen  = withData.filter((c) => isMarketOpen(c.assetType));
  const funnelExec        = funnelMarketOpen.filter((c) => (c.rawScores?.executionQuality || 0) >= T.executionHardFloor);
  const funnelConf        = funnelExec.filter((c) => (c.confidence?.score || 0) >= T.confidenceMinimum);
  const funnelConv        = funnelConf.filter((c) => (c.conviction?.score || 0) >= T.convictionMinimum);
  const funnelEdge        = funnelConv.filter((c) => (c.edgeResult?.edge || 0) >= T.edgeMinimumOverField);
  const funnelComp        = funnelEdge.filter((c) => c.comp?.rank === 1 || c.comp?.rank === 0);
  const funnelStructure   = funnelComp.filter((c) => (c.rawScores?.structure || 0) >= 55);
  const funnelRisk        = funnelStructure.filter((c) => (c.rawScores?.risk || 0) >= 50);

  log(`  Funnel: total=${withData.length} → market_open=${funnelMarketOpen.length} → exec≥50/60:${funnelExec.length} → conf≥${T.confidenceMinimum}:${funnelConf.length} → conv≥${T.convictionMinimum}:${funnelConv.length} → edge≥${T.edgeMinimumOverField}:${funnelEdge.length} → rank#1:${funnelComp.length}(+${T.competitionBonus}bonus if gap≥${T.competitionGap}) → str≥55:${funnelStructure.length} → risk≥50:${funnelRisk.length}`);
  log(`  Field: avg=${round2(STATE.fieldAverage)} top=${round2(withData[0]?.finalScore || 0)} gap=${round2((withData[0]?.finalScore||0) - STATE.fieldAverage)} (need +${T.edgeMinimumOverField})`);

  // ── Price-move correlation ────────────────────────────
  for (const c of withData.slice(0, 10)) {
    const price = c.execEngine?.entryPrice || c.execution?.entry || 0;
    if (price > 0) {
      await safeRun('priceMoveTracker', () => trackPriceMoveCorrelation(c.symbol, price, c.finalScore));
    }
  }

  // ── Calibration tracker ───────────────────────────────
  const cryptoTop = withData.filter(c => c.assetType === 'crypto')[0];
  const usTop     = withData.filter(c => c.assetType === 'us')[0];
  const lseTop    = withData.filter(c => c.assetType === 'lse')[0];

  await safeRun('calibrationTracker', () => recordCalibrationSnapshot({
    topScore:      round2(withData[0]?.finalScore || 0),
    topSymbol:     withData[0]?.symbol || null,
    fieldAvg:      round2(STATE.fieldAverage),
    candidateCount: withData.length,
    btcRegime:     STATE.btcRegime,
    qqqRegime:     STATE.qqqRegime,
    marketOpenCount: funnelMarketOpen.length,
    buyCount:      buys.length,
    watchCount:    watches.length,
    cryptoTopScore: cryptoTop ? round2(cryptoTop.finalScore) : null,
    cryptoTopSymbol: cryptoTop?.symbol || null,
    usTopScore:     usTop ? round2(usTop.finalScore) : null,
    usTopSymbol:    usTop?.symbol || null,
    lseTopScore:    lseTop ? round2(lseTop.finalScore) : null,
    lseTopSymbol:   lseTop?.symbol || null,
  }));

  // ── Top 5 candidates ─────────────────────────────────
  const cryptoCount = finalCandidates.filter((c) => c.assetType === 'crypto' && c.finalScore > 0).length;
  const openCount = finalCandidates.filter((c) => c.finalScore > 0 && isMarketOpen(c.assetType)).length;
  if (cryptoCount > 0 && openCount === 0) {
    log('  ⚠️  WARNING: crypto assets scored but isMarketOpen returning false — check asset tags');
  }

  const top5 = [...finalCandidates]
    .filter((c) => c.finalScore > 0 && isMarketOpen(c.assetType))
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 5);

  if (top5.length > 0) {
    log('  Top candidates (open markets):');
    top5.forEach((c, i) => {
      const reason = c.rejectReasons?.length > 0 ? c.rejectReasons[0] : c.decision;
      log(`    #${i+1} ${c.symbol}(${c.assetType}) score=${round2(c.finalScore)} conf=${round2(c.confidence?.score)} conv=${round2(c.conviction?.score)} edge=+${round2(c.edgeResult?.edge)} gap=${round2(c.comp?.gap)} → ${c.decision}: ${reason}`);
    });
  } else {
    log(`  No open-market candidates (crypto=${cryptoCount} scored, open total=${openCount})`);
  }

  // ── Near misses ───────────────────────────────────────
  const nearMisses = finalCandidates
    .filter((c) => c.finalScore > 0 && isMarketOpen(c.assetType))
    .filter((c) => c.decision === 'REJECT' && c.finalScore >= T.hunterScoreGood - 10)
    .filter((c) => c.rejectReasons?.length === 1)
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 3);

  if (nearMisses.length > 0) {
    log('  Near misses (1 gate from BUY):');
    nearMisses.forEach((c) => {
      log(`    ⚡ ${c.symbol} score=${round2(c.finalScore)} — failed: ${c.rejectReasons[0]}`);
    });
  }

  // ── Threshold stress test (every 20 cycles) ──────────
  if (STATE.cycleCount % 20 === 0) {
    [0, 5, 10, 15].forEach((relax) => {
      const tConf = T.confidenceMinimum - relax;
      const tConv = T.convictionMinimum - relax;
      const tEdge = T.edgeMinimumOverField - (relax * 0.4);
      const tGap  = T.competitionGap - (relax * 0.2);
      const passed = finalCandidates.filter((c) =>
        c.finalScore > 0 && isMarketOpen(c.assetType) &&
        (c.rawScores?.executionQuality || 0) >= T.executionHardFloor &&
        (c.confidence?.score || 0) >= tConf &&
        (c.conviction?.score || 0) >= tConv &&
        (c.edgeResult?.edge || 0) >= tEdge &&
        (c.comp?.gap || 0) >= tGap
      ).length;
      log(`  Stress -${relax}%: conf≥${tConf} conv≥${tConv} edge≥${round2(tEdge)} gap≥${round2(tGap)} → ${passed} BUY`);
    });
  }

  // ── DIAGNOSTIC: top candidate full breakdown ──────────
  const sortedByFinal = [...finalCandidates]
    .filter((c) => c.finalScore > 0 && isMarketOpen(c.assetType))
    .sort((a, b) => b.finalScore - a.finalScore);

  if (sortedByFinal.length > 0) {
    const top = sortedByFinal[0];
    log(`  \ud83d\udcca BEST (open market): ${top.symbol} (${top.assetType}) \u2014 finalScore=${round2(top.finalScore)} decision=${top.decision}`);
    log(`     Hunter=${round2(top.finalScore)} Conf=${round2(top.confidence?.score)} Conv=${round2(top.conviction?.score)} Edge=${round2(top.edgeResult?.edge)} Stab=${round2(top.stability?.score)} Rank=#${top.comp?.rank} Gap=${round2(top.comp?.gap)}`);
    log(`     Raw: Ctx=${round2(top.rawScores?.marketContext)} Str=${round2(top.rawScores?.structure)} Part=${round2(top.rawScores?.participation)} Mom=${round2(top.rawScores?.momentum)} Stage=${top.stageInfo?.stage}(${round2(top.rawScores?.stage)}) Exec=${round2(top.rawScores?.executionQuality)} Risk=${round2(top.rawScores?.risk)}`);
    if (top.rejectReasons?.length > 0) {
      log(`     Rejected because: ${top.rejectReasons.join(' | ')}`);
    }
  } else {
    log(`  \ud83d\udcca No candidates from currently-open markets`);
  }

  return STATE.lastScan;
}

// ============================================================
// SECTION 24: DYNAMIC ASSET INJECTION
// ============================================================

async function injectDynamicAssets() {
  try {
    const data = await httpGet('https://api.bybit.com/v5/market/tickers?category=spot');
    if (data?.result?.list) {
      const movers = data.result.list
        .filter((t) => t.symbol.endsWith('USDT'))
        .filter((t) => Math.abs(parseFloat(t.price24hPcnt || 0)) * 100 >= CONFIG.DYNAMIC_MOVE_PCT)
        .filter((t) => parseFloat(t.turnover24h || 0) >= CONFIG.MIN_DOLLAR_VOLUME)
        .filter((t) => parseFloat(t.price24hPcnt || 0) > 0)
        .sort((a, b) => parseFloat(b.price24hPcnt) - parseFloat(a.price24hPcnt))
        .slice(0, 8);

      for (const mover of movers) {
        const pct = round2(parseFloat(mover.price24hPcnt) * 100);
        if (!CORE_CRYPTO.includes(mover.symbol) && !STATE.dynamicAssets.has(mover.symbol)) {
          STATE.dynamicAssets.set(mover.symbol, {
            addedAt: Date.now(),
            expires: Date.now() + CONFIG.DYNAMIC_EXPIRY_MS,
            type: 'crypto',
            pctChange: pct,
          });
          log(`🔥 Dynamic inject: ${mover.symbol} (+${pct}%)`);
        }
      }
    }

    for (const [sym, data] of STATE.dynamicAssets.entries()) {
      if (Date.now() > data.expires) STATE.dynamicAssets.delete(sym);
    }
  } catch (err) {
    log(`Dynamic inject error: ${err.message}`);
  }
}

// ============================================================
// SECTION 25: TELEGRAM MESSENGER
// ============================================================

const FINGERPRINT_TTL_MS = 30 * 60 * 1000;

function checkAndSetFingerprint(symbol, signalType, stage, source) {
  const key = `${symbol}-${signalType}-${stage}`;
  const now = Date.now();

  for (const [fp, ts] of STATE.alertFingerprints.entries()) {
    if (now - ts > FINGERPRINT_TTL_MS) STATE.alertFingerprints.delete(fp);
  }

  if (STATE.alertFingerprints.has(key)) {
    const age = Math.round((now - STATE.alertFingerprints.get(key)) / 1000);
    log(`🚫 DUPLICATE BLOCKED: ${key} (sent ${age}s ago) — source: ${source}`);
    return false;
  }

  STATE.alertFingerprints.set(key, now);
  log(`📤 ALERT SOURCE: ${source} — fingerprint set: ${key}`);
  return true;
}

async function safeRun(label, fn) {
  try {
    return await fn();
  } catch (err) {
    log(`⚠️  safeRun(${label}) failed: ${err?.message || err}`);
    return null;
  }
}

const CALIBRATION_TABLE = 'hunter_calibration';

async function recordCalibrationSnapshot(snapshot) {
  if (!supabase) return;
  try {
    const row = {
      id:               `cal_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
      recorded_at:      new Date().toISOString(),
      top_score:        snapshot.topScore,
      top_symbol:       snapshot.topSymbol,
      field_avg:        snapshot.fieldAvg,
      candidate_count:  snapshot.candidateCount,
      btc_regime:       snapshot.btcRegime,
      qqq_regime:       snapshot.qqqRegime,
      market_open_count: snapshot.marketOpenCount,
      buy_count:        snapshot.buyCount,
      watch_count:      snapshot.watchCount,
      crypto_top_score:  snapshot.cryptoTopScore,
      crypto_top_symbol: snapshot.cryptoTopSymbol,
      us_top_score:       snapshot.usTopScore,
      us_top_symbol:      snapshot.usTopSymbol,
      lse_top_score:      snapshot.lseTopScore,
      lse_top_symbol:     snapshot.lseTopSymbol,
    };
    const { error } = await supabase.from(CALIBRATION_TABLE).insert(row);
    if (error && error.code !== '42P01') {
      log(`⚠️  Calibration tracker insert failed: ${error.message}`);
    }
  } catch (err) {
    log(`⚠️  Calibration tracker exception: ${err.message}`);
  }
}

const priceSnapshots = new Map();

async function trackPriceMoveCorrelation(symbol, currentPrice, currentScore) {
  const prior = priceSnapshots.get(symbol);
  if (prior && prior.price > 0) {
    const movePct = ((currentPrice - prior.price) / prior.price) * 100;
    const absMove = Math.abs(movePct);
    if (absMove >= 2) {
      const tier = absMove >= 8 ? 8 : absMove >= 5 ? 5 : 2;
      log(`📈 MOVE DETECTED: ${symbol} ${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}% — score BEFORE move was ${round2(prior.score)} (tier: ${tier}%+)`);
      if (supabase) {
        try {
          await supabase.from(CALIBRATION_TABLE.replace('calibration','moves')).insert({
            id: `move_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
            recorded_at: new Date().toISOString(),
            symbol, move_pct: round2(movePct), move_tier: tier,
            score_before_move: round2(prior.score),
            price_before: prior.price, price_after: currentPrice,
          });
        } catch { /* best effort */ }
      }
    }
  }
  priceSnapshots.set(symbol, { price: currentPrice, score: currentScore, time: Date.now() });
}

async function sendTelegram(text, chatId) {
  try {
    const body = JSON.stringify({
      chat_id:    chatId,
      text:       text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.telegram.org',
        path:     `/bot${ENV.BOT_TOKEN}/sendMessage`,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(JSON.parse(data)));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Telegram timeout')); });
      req.write(body);
      req.end();
    });
  } catch (err) {
    log(`Telegram error: ${err.message}`);
  }
}

function buildHunterAlert(candidate, scan) {
  const {
    symbol, assetType, finalScore, rawScores, stageInfo,
    execution, execEngine, confidence, conviction,
    edgeResult, comp, reasons,
  } = candidate;

  const flagMap   = { crypto: '🌐', us: '🇺🇸', lse: '🇬🇧' };
  const marketMap = { crypto: 'CRYPTO', us: 'US', lse: 'LSE' };
  const flag      = flagMap[assetType]   || '🌐';
  const market    = marketMap[assetType] || assetType.toUpperCase();

  const entry  = round2(execEngine?.entryPrice || execution.entry);
  const stop   = round2(execEngine?.stopPrice  ?? execution.stopPrice);
  const tp1    = round2(execEngine?.t1Price    ?? execution.t1Price);
  const tp2    = round2(execEngine?.t2Price    ?? execution.t2Price);
  const rr     = round2(execEngine?.rrRatio    ?? execution.rrRatio);

  if (stop >= entry) {
    log(`🚫 ALERT DISPLAY BLOCKED: ${symbol} stop=$${stop} >= entry=$${entry}`);
    return null;
  }

  const slPct  = round2(((stop  - entry) / entry) * 100);
  const tp1Pct = round2(((tp1   - entry) / entry) * 100);
  const tp2Pct = round2(((tp2   - entry) / entry) * 100);

  const setupType  = execEngine?.setupType || 'PULLBACK_CONTINUATION';
  const setupLabel = setupType.replace(/_/g, ' ');
  const orderLabel = execEngine?.orderType || 'LIMIT';

  const volumes   = candidate.candles?.map((c) => c.volume) || [];
  const volSMA    = volumes.length >= 20 ? volumes.slice(-20).reduce((a,b) => a+b,0)/20 : 1;
  const relVol    = volSMA > 0 ? round2(volumes[volumes.length-1] / volSMA) : 0;
  const closes    = candidate.candles?.map((c) => c.close) || [entry];
  const candleMom = closes.length >= 2
    ? round2(((closes[closes.length-1] - closes[closes.length-2]) / closes[closes.length-2]) * 100) : 0;

  const regimeIcon = STATE.btcRegime === 'BULL' ? '🟢' : STATE.btcRegime === 'BEAR' ? '🔴' : '🟡';
  const regimeWord = STATE.btcRegime === 'BULL' ? 'BULL' : STATE.btcRegime === 'BEAR' ? 'BEAR' : 'NEUTRAL';
  const btcLabel   = `${regimeIcon} ${regimeWord}`;

  // Dynamic participation narrative
  let partIcon, partLabel;
  if (relVol >= 3)      { partIcon = '🔥'; partLabel = 'Exceptional'; }
  else if (relVol >= 1.8) { partIcon = '📈'; partLabel = 'Strong'; }
  else if (relVol >= 0.9) { partIcon = '➖'; partLabel = 'Average'; }
  else                    { partIcon = '⚠️'; partLabel = 'Light'; }

  const setupAnalysis = {
    PULLBACK_CONTINUATION: 'Pullback into the 20 EMA within an established uptrend. Hunter observes potential continuation from this level.',
    BREAKOUT_CONTINUATION: 'Price testing a key resistance level with volume confirmation. Hunter observes a potential breakout above structure.',
    MOMENTUM_IGNITION:     'Surge in volume and price velocity detected. Hunter observes an accelerating move with strong participation.',
    PARABOLIC_EXTENSION:   'Parabolic extension observed — the primary move appears complete. Hunter is monitoring for consolidation.',
  };
  const analysis = setupAnalysis[setupType] || setupAnalysis.PULLBACK_CONTINUATION;

  // Technical reference bullets (neutral language)
  const refBullets = [];
  if (orderLabel === 'LIMIT') {
    refBullets.push(`• EL: $${entry}`);
    if (execEngine?.chaseLimit) refBullets.push(`• Above $${round2(execEngine.chaseLimit)} the current setup characteristics may no longer apply`);
    refBullets.push(`• If price closes above $${round2(entry * 1.015)} before revisiting the reference area, this analysis becomes invalid`);
    refBullets.push(`• Analysis expires at end of session if conditions do not occur`);
  } else if (orderLabel === 'STOP') {
    refBullets.push(`• EL: $${entry}`);
    refBullets.push(`• Setup characteristics apply only on a confirmed break above this level`);
    refBullets.push(`• If price closes back below the reference level, this analysis becomes invalid`);
  } else {
    refBullets.push(`• EL: $${entry}`);
    refBullets.push(`• Momentum characteristics are time-sensitive — conditions may shift rapidly`);
  }

  // Hunter Intel — only show fields that exist
  const statusTag = finalScore >= CONFIG.THRESHOLDS.hunterScoreGood ? '🔥 BUY'
                  : finalScore >= CONFIG.THRESHOLDS.hunterScoreWatch ? '👁 WATCH'
                  : finalScore >= 65 ? '📡 CLOSE' : '💤 FORMING';
  const intelLines = ['━━━━━━━━━━━━━━━━━━', '🧠 HUNTER INTEL', ''];
  if (comp?.rank) intelLines.push(`🏆 Leaderboard: #${comp.rank}`);
  intelLines.push(`🌐 BTC Regime: ${btcLabel}`);
  intelLines.push(`Status: ${statusTag}`);

  const lines = [
    `🏹 SETUP IDENTIFIED`,
    `AI MARKET ANALYSIS`,
    ``,
    `${flag} ${market} | ${symbol}`,
    `🎯 ${setupLabel}`,
    ``,
    `💰 EL: $${entry}`,
    `🛡️ SL: $${stop} (${slPct}%)`,
    `🎯 TP1: $${tp1} (+${tp1Pct}%)`,
    `🚀 TP2: $${tp2} (+${tp2Pct}%)`,
    `⚖️ Risk / Reward: ${rr}`,
    `⭐ Hunter Score: ${round2(finalScore)}`,
    `📊 Participation: ${relVol}×`,
    ``,
    ...intelLines,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `📚 SETUP ANALYSIS`,
    ``,
    `🎯 ${analysis}`,
    ``,
    `${partIcon} ${partLabel} participation (${relVol}× average volume).`,
    `⚡ Candle momentum: ${candleMom > 0 ? '+' : ''}${candleMom}%`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `📋 TECHNICAL REFERENCE`,
    ``,
    ...refBullets,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `Strength ${round2(rawScores.structure)} | Participation ${round2(rawScores.participation)} | Momentum ${round2(rawScores.momentum)} | Execution ${round2(rawScores.executionQuality)} | Risk ${round2(rawScores.risk)}`,
    `Edge: +${round2(edgeResult.edge)} pts | Confidence: ${round2(confidence.score)} | Conviction: ${round2(conviction.score)}`,
    ``,
    `Hunter has identified statistical edge. Execution remains the trader's decision.`,
    ``,
    `——————————`,
    `⚠️ Educational market analysis only · Not personalised investment advice · Not a recommendation to buy or sell.`,
    ``,
    `📸 Analysis by @baretradesignals 🏹`,
  ];

  return lines.join('\n');
}

function buildWatchAlert(candidate, scan) {
  const { symbol, assetType, finalScore, rawScores, stageInfo, execution, execEngine, confidence, conviction, edgeResult, comp } = candidate;
  const flagMap = { crypto: '🌐', us: '🇺🇸', lse: '🇬🇧' };
  const entry = round2(execEngine?.entryPrice || execution?.entry);
  const stop  = round2(execEngine?.stopPrice  || execution?.stopPrice);
  const t1    = round2(execEngine?.t1Price    || execution?.t1Price);
  const rr    = round2(execEngine?.rrRatio    || execution?.rrRatio);
  const setupLabel = (execEngine?.setupType || 'PULLBACK_CONTINUATION').replace(/_/g, ' ');

  const BASELINE = 70;
  const BUY_THRESHOLD = CONFIG.THRESHOLDS.hunterScoreGood;
  const gap = BUY_THRESHOLD - round2(finalScore);

  const components = [
    { name: 'Structure',     key: 'structure',        score: rawScores?.structure       || 0, weight: 0.12 },
    { name: 'Participation', key: 'participation',     score: rawScores?.participation   || 0, weight: 0.13 },
    { name: 'Momentum',      key: 'momentum',          score: rawScores?.momentum        || 0, weight: 0.12 },
    { name: 'Execution',     key: 'executionQuality',  score: rawScores?.executionQuality|| 0, weight: 0.22 },
    { name: 'Risk',          key: 'risk',              score: rawScores?.risk            || 0, weight: 0.10 },
    { name: 'Market Ctx',    key: 'marketContext',     score: rawScores?.marketContext   || 0, weight: 0.08 },
    { name: 'Stage',         key: 'stage',             score: rawScores?.stage           || 0, weight: 0.08 },
  ];

  const withDrag = components.map(c => ({
    ...c,
    drag: Math.round((BASELINE - c.score) * c.weight * 10) / 10
  }));

  const drags     = withDrag.filter(c => c.drag > 0).sort((a, b) => b.drag - a.drag);
  const strengths = withDrag.filter(c => c.score >= 72).sort((a, b) => b.score - a.score);

  const verdictParts = [];
  if (drags[0]?.name === 'Participation') verdictParts.push('Insufficient market participation');
  else if (drags[0]?.name === 'Momentum') verdictParts.push('Momentum too weak for premium entry');
  else if (drags[0]?.name === 'Structure') verdictParts.push('Structure not fully aligned');
  else if (drags[0]?.name === 'Market Ctx') verdictParts.push('Market context not supportive');
  else if (drags[0]?.name === 'Stage') verdictParts.push('Setup stage not optimal');
  else verdictParts.push('Multiple components below threshold');

  if (drags.length >= 2) {
    if (drags[1]?.name === 'Momentum') verdictParts.push('momentum confirming slowly');
    else if (drags[1]?.name === 'Participation') verdictParts.push('volume not confirming move');
    else if (drags[1]?.name === 'Structure') verdictParts.push('EMA alignment incomplete');
  }
  const verdict = verdictParts.join(' — ');

  const lines = [
    `👁 WATCH SIGNAL — THE HUNTER`,
    ``,
    `${flagMap[assetType] || '🌐'} ${assetType.toUpperCase()} | ${symbol}`,
    `🎯 ${setupLabel} | Stage: ${stageInfo?.stage}`,
    ``,
    `Score: <b>${round2(finalScore)}</b>  Needed: <b>${BUY_THRESHOLD}</b>  Gap: <b>-${gap}</b>`,
    ``,
  ];

  if (drags.length > 0) {
    lines.push(`📉 <b>Biggest drags:</b>`);
    for (const d of drags.slice(0, 3)) {
      lines.push(`  — ${d.name}: ${round2(d.score)} (pulls -${d.drag.toFixed(1)} from score)`);
    }
    lines.push(``);
  }

  if (strengths.length > 0) {
    lines.push(`✅ <b>Strong areas:</b>`);
    if (edgeResult?.edge >= 8) lines.push(`  + Edge: +${round2(edgeResult.edge)} above field`);
    for (const s of strengths.slice(0, 3)) {
      lines.push(`  + ${s.name}: ${round2(s.score)}`);
    }
    lines.push(``);
  }

  lines.push(
    `📋 <b>Verdict:</b>`,
    `${verdict}.`,
    `Needs improvement in ${drags.slice(0,2).map(d=>d.name).join(' + ')} to reach BUY.`,
    ``,
    `💰 If it triggers: Entry ${formatPrice(entry, assetType)}  🛡️ Stop ${formatPrice(stop, assetType)}  🎯 T1 ${formatPrice(t1, assetType)}  ⚖️ R:R ${rr}:1`,
    ``,
    `——————————`,
    `⚠️ Educational market commentary only · Not personalised investment advice`,
    `📸 Analysis by @baretradesignals 🏹`,
  );

  return lines.join('\n');
}

function buildNoTradeMessage(scan) {
  const totalScanned = scan?.totalAssets || '—';
  const cycles       = STATE.cycleCount;
  const allScored    = [...(scan?.candidates || [])].sort((a,b) => b.finalScore - a.finalScore);
  const best         = allScored[0];
  const bestScore    = best ? round2(best.finalScore) : null;
  const bestSymbol   = best?.symbol || null;

  // Dominant missing condition
  const missingLines = [];
  if (best && best.rawScores) {
    if (best.rawScores.momentum < 55)         missingLines.push(`• Stronger momentum`);
    if (best.rawScores.participation < 55)    missingLines.push(`• Better participation`);
    if (best.rawScores.executionQuality < 60) missingLines.push(`• Higher execution quality`);
    if (best.rawScores.structure < 60)        missingLines.push(`• Cleaner structure`);
  }
  if (missingLines.length === 0) missingLines.push(`• Sustained leadership above threshold`);

  const lines = [
    `🏹 MARKET UPDATE — NO TRADE`,
    ``,
    `Hunter analysed:`,
    `📊 ${totalScanned} assets`,
    `🔄 ${cycles} scan cycles`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `🧠 MARKET INTEL`,
    ``,
    `📈 Current conviction: LOW`,
  ];

  if (bestSymbol && bestScore) {
    lines.push(`🏆 Strongest asset: ${bestSymbol} ⭐${bestScore}`);
  }

  lines.push(
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `Still missing:`,
    ...missingLines,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `Hunter continues to monitor the market.`,
    `No opportunity currently offers sufficient statistical edge.`,
    ``,
    `Hunter remains patient. Capital is a position.`,
    ``,
    `——————————`,
    `⚠️ Educational market analysis only · Not personalised investment advice · Not a recommendation to buy or sell.`,
    ``,
    `📸 Analysis by @baretradesignals 🏹`,
  );

  return lines.join('\n');
}

// ============================================================
// SECTION 26: ALERT MANAGER
// ============================================================

function checkAlertCooldown(symbol, newScore) {
  // Reset daily counter at midnight
  const today = new Date().toISOString().split('T')[0];
  if (STATE.alertDateKey !== today) {
    STATE.alertDateKey = today;
    STATE.alertsToday = 0;
  }

  // Hard daily cap
  if (STATE.alertsToday >= CONFIG.MAX_ALERTS_PER_DAY) {
    log(`Alert suppressed — daily limit (${CONFIG.MAX_ALERTS_PER_DAY}) reached`);
    return false;
  }

  // Per-symbol cooldown (not global — one alert in crypto shouldn't block US stocks)
  const last = STATE.symbolLastAlert.get(symbol);
  if (last) {
    const age = Date.now() - last.time;
    if (age < CONFIG.SYMBOL_COOLDOWN_MS) {
      // Elite override: allow fire if new score beats last by 10+ points
      const improvement = newScore - last.score;
      if (newScore >= CONFIG.THRESHOLDS.hunterScoreElite && improvement >= CONFIG.ELITE_SCORE_OVERRIDE) {
        log(`⚡ Elite override: ${symbol} new=${round2(newScore)} prev=${round2(last.score)} (+${round2(improvement)}) — bypassing cooldown`);
        return true;
      }
      log(`Alert suppressed — ${symbol} in per-symbol cooldown (${Math.round(age/60000)}min elapsed, ${Math.round((CONFIG.SYMBOL_COOLDOWN_MS-age)/60000)}min remaining)`);
      return false;
    }
  }
  return true;
}

async function fireAlert(candidate, scan) {
  if (!checkAlertCooldown(candidate.symbol, candidate.finalScore)) {
    return;
  }

  // ── TWO-SCAN CONFIRMATION GATE ───────────────────────────────────────
  const confirmKey = candidate.symbol;
  const tracker = STATE.buyConfirmTracker.get(confirmKey);
  const buyThreshold = CONFIG.THRESHOLDS.hunterScoreGood;

  if (!tracker || tracker.lastCycleSeen !== STATE.cycleCount - 1) {
    STATE.buyConfirmTracker.set(confirmKey, {
      firstSeenCycle: STATE.cycleCount,
      firstSeenScore: candidate.finalScore,
      consecutiveCycles: 1,
      lastCycleSeen: STATE.cycleCount,
    });
    log(`⏳ ${candidate.symbol} crossed BUY threshold (score ${round2(candidate.finalScore)}) — awaiting 2nd-cycle confirmation before alerting`);
    return;
  }

  tracker.consecutiveCycles++;
  tracker.lastCycleSeen = STATE.cycleCount;
  if (tracker.consecutiveCycles < 2) {
    return;
  }
  log(`✅ ${candidate.symbol} confirmed for ${tracker.consecutiveCycles} consecutive cycles — proceeding to alert`);
  STATE.buyConfirmTracker.delete(confirmKey);

  // P1 CRITICAL: Validate trade structure before firing
  const execPlan = candidate.execEngine;
  const execOld  = candidate.execution;
  if (execPlan && execPlan.entryPrice && execPlan.stopPrice) {
    if (execPlan.stopPrice >= execPlan.entryPrice) {
      log(`🚫 TRADE STRUCTURE INVALID (execEngine): ${candidate.symbol} stop=${execPlan.stopPrice} >= entry=${execPlan.entryPrice} — alert suppressed`);
      return;
    }
    if (execPlan.rrRatio < 1.5) {
      log(`🚫 R:R TOO LOW: ${candidate.symbol} R:R=${execPlan.rrRatio} — alert suppressed (min 1.5 required)`);
      return;
    }
  }
  if (execOld && execPlan?.entryPrice && execOld.stopPrice != null) {
    if (execOld.stopPrice >= execPlan.entryPrice) {
      log(`🚫 TRADE STRUCTURE INVALID (legacy execution): ${candidate.symbol} stop=${execOld.stopPrice} >= entry=${execPlan.entryPrice} — alert suppressed`);
      return;
    }
  }

  // Fingerprint dedup — block if identical alert sent in last 30 mins
  const stage = candidate.stageInfo?.stage || 'UNKNOWN';
  const signalType = candidate.finalScore >= CONFIG.THRESHOLDS.hunterScoreElite ? 'BUY_ELITE'
                   : candidate.finalScore >= CONFIG.THRESHOLDS.hunterScoreGood  ? 'BUY'
                   : 'WATCH';
  if (!checkAndSetFingerprint(candidate.symbol, signalType, stage, 'fireAlert')) {
    return;
  }

  const msg = buildHunterAlert(candidate, scan);
  if (!msg) {
    log(`🚫 Alert build returned null for ${candidate.symbol} — send suppressed`);
    return;
  }

  // Always send to bluejam (testing)
  if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);

  // Send to channel only if HUNTER_LIVE=true
  if (ENV.HUNTER_LIVE && ENV.CHANNEL_CHAT_ID) {
    await sendTelegram(msg, ENV.CHANNEL_CHAT_ID);
  }

  STATE.alertsToday++;
  STATE.lastAlertTime = Date.now();
  STATE.symbolLastAlert.set(candidate.symbol, { time: Date.now(), score: candidate.finalScore });

  // Store in Supabase learning engine
  await storeAlert(candidate, scan);

  log(`✅ Alert fired for ${candidate.symbol} (score ${round2(candidate.finalScore)})`);
}

// ═══════════════════════════════════════════════════════════
// WATCHLIST LIFECYCLE ENGINE — event-driven alerts, not scan-driven
// ═══════════════════════════════════════════════════════════

const WATCHLIST_UPDATE_SCORE_DELTA = 5;
const WATCHLIST_NEAR_TRIGGER_GAP   = 2;
const WATCHLIST_REMOVE_SCORE_DROP  = 10;
const WATCHLIST_DEGRADED_STAGES    = new Set(['SLEEPING', 'FAILURE', 'EXHAUSTION']);
const WATCHLIST_STALE_MS           = 4 * 60 * 60 * 1000;

async function processWatchlistLifecycle(candidates) {
  if (!ENV.BLUEJAM_CHAT_ID) return;
  const now = Date.now();
  const buyThreshold = CONFIG.THRESHOLDS.hunterScoreGood;
  const watchThreshold = CONFIG.THRESHOLDS.hunterScoreWatch;

  const bySymbol = new Map();
  for (const c of candidates) bySymbol.set(c.symbol, c);

  for (const [symbol, state] of STATE.watchlistState.entries()) {
    const current = bySymbol.get(symbol);

    if (!current) {
      if (now - state.lastSeenTime > WATCHLIST_STALE_MS) {
        STATE.watchlistState.delete(symbol);
        log(`🔇 ${symbol} dropped from watchlist tracking (stale, no data ${Math.round((now-state.lastSeenTime)/60000)}min)`);
      }
      continue;
    }

    const score = current.finalScore;
    const stage = current.stageInfo?.stage || 'UNKNOWN';
    state.lastSeenTime = now;

    if (score >= buyThreshold) {
      STATE.watchlistState.delete(symbol);
      log(`🎯 ${symbol} graduated from watchlist (score ${round2(score)} ≥ ${buyThreshold}) — BUY path handles alerting`);
      continue;
    }

    const dropFromPeak = state.peakScore - score;
    const stageDegraded = WATCHLIST_DEGRADED_STAGES.has(stage) && !WATCHLIST_DEGRADED_STAGES.has(state.stage);
    if (dropFromPeak >= WATCHLIST_REMOVE_SCORE_DROP || stageDegraded) {
      await sendWatchlistRemoved(symbol, current, state);
      STATE.watchlistState.delete(symbol);
      continue;
    }

    const gapToBuy = buyThreshold - score;
    const improvedEnough = score >= state.lastAlertScore + WATCHLIST_UPDATE_SCORE_DELTA;
    const nowNearTrigger = gapToBuy <= WATCHLIST_NEAR_TRIGGER_GAP && state.lastAlertGap > WATCHLIST_NEAR_TRIGGER_GAP;

    if (improvedEnough || nowNearTrigger) {
      await sendWatchlistUpdate(symbol, current, state);
      state.lastAlertScore = score;
      state.lastAlertGap   = gapToBuy;
    }

    state.score    = score;
    state.stage    = stage;
    state.peakScore = Math.max(state.peakScore, score);
  }

  for (const c of candidates) {
    if (c.finalScore < watchThreshold || c.finalScore >= buyThreshold) continue;
    if (STATE.watchlistState.has(c.symbol)) continue;

    const stage = c.stageInfo?.stage || 'UNKNOWN';
    await sendWatchlistCreated(c, stage);
    STATE.watchlistState.set(c.symbol, {
      score: c.finalScore,
      stage,
      createdScore:   c.finalScore,
      peakScore:      c.finalScore,
      lastAlertScore: c.finalScore,
      lastAlertGap:   buyThreshold - c.finalScore,
      lastSeenTime:   now,
      createdAt:      now,
    });
  }
}

async function sendWatchlistCreated(candidate, stage) {
  log(`👀 [INTERNAL] Watchlist CREATED: ${candidate.symbol} @ ${round2(candidate.finalScore)} — no Telegram (WATCH suppressed by design)`);
}

async function sendWatchlistUpdate(symbol, candidate, state) {
  const delta = round2(candidate.finalScore - state.lastAlertScore);
  log(`⬆️ [INTERNAL] Watchlist UPDATE: ${symbol} ${round2(state.lastAlertScore)}→${round2(candidate.finalScore)} (${delta >= 0 ? '+' : ''}${delta}) — no Telegram`);
}

async function sendWatchlistRemoved(symbol, candidate, state) {
  const currentScore = candidate?.finalScore ?? state.score;
  log(`❌ [INTERNAL] Watchlist REMOVED: ${symbol} peak=${round2(state.peakScore)} now=${round2(currentScore)} — no Telegram`);
}

async function fireLeaderboardMessage(scan) {
  const allScored = [...(scan?.candidates || [])].sort((a,b) => b.finalScore - a.finalScore);

  const now     = new Date();
  const timeStr = now.toUTCString().slice(17, 22) + ' UTC';

  const cryptoTop = allScored.filter(c => (c.assetType || c.type) === 'crypto').slice(0, 5);
  const usTop     = allScored.filter(c => (c.assetType || c.type) === 'us').slice(0, 5);
  const lseTop    = allScored.filter(c => (c.assetType || c.type) === 'lse').slice(0, 5);

  const btcWord = STATE.btcRegime === 'BULL' ? '🟢 Bull' : STATE.btcRegime === 'BEAR' ? '🔴 Bear' : '🟡 Neutral';
  const qqqWord = STATE.qqqRegimeStale ? '⚪ Closed'
    : STATE.qqqRegime === 'BULL' ? '🟢 Bull' : STATE.qqqRegime === 'BEAR' ? '🔴 Bear' : '🟡 Neutral';

  const rankEmoji = ['🥇','🥈','🥉','4️⃣','5️⃣'];

  // ── Score velocity + rank delta from leaderboard history ─────────
  const velocityMap  = new Map(); // symbol -> score delta
  const priorRankMap = new Map(); // symbol -> prior rank

  if (supabase && allScored.length > 0) {
    try {
      const symbols = allScored.slice(0, 20).map(c => c.symbol);
      const { data: priorRows } = await supabase
        .from('hunter_leaderboard_history')
        .select('symbol, score, rank, snapshot_id, snapshot_time')
        .in('symbol', symbols)
        .order('snapshot_time', { ascending: false })
        .limit(symbols.length * 3);

      if (priorRows && priorRows.length > 0) {
        const priorSnapshotId = [...new Set(priorRows.map(r => r.snapshot_id))][0];
        const priorBySymbol   = new Map();
        for (const row of priorRows.filter(r => r.snapshot_id === priorSnapshotId)) {
          priorBySymbol.set(row.symbol, { score: parseFloat(row.score), rank: row.rank });
        }
        for (const c of allScored.slice(0, 20)) {
          const prior = priorBySymbol.get(c.symbol);
          if (prior != null) {
            velocityMap.set(c.symbol, round2((c.finalScore || 0) - prior.score));
            priorRankMap.set(c.symbol, prior.rank);
          }
        }
      }
    } catch (err) {
      log(`⚠️  Velocity fetch error: ${err.message}`);
    }
  }
  // Watchlist fallback for velocity
  for (const c of allScored.slice(0, 20)) {
    if (!velocityMap.has(c.symbol)) {
      const tracked = STATE.watchlistState.get(c.symbol);
      if (tracked?.createdScore != null) {
        velocityMap.set(c.symbol, round2((c.finalScore || 0) - tracked.createdScore));
      }
    }
  }

  // Format one row — score + velocity only (clean)
  function fmtRow(c, i) {
    const score = round2(c.finalScore || c.adjustedScore || 0);
    const vel   = velocityMap.get(c.symbol);
    let velStr  = '';
    if (vel != null) {
      if (Math.abs(vel) <= 0.5) velStr = `   ➖`;
      else if (vel > 0)          velStr = `   ▲ +${vel}`;
      else                       velStr = `   ▼ ${vel}`;
    }
    const label = c.symbol.replace('USDT', '').padEnd(10);
    return `${rankEmoji[i] || `${i+1}.`} ${label}  ⭐${score}${velStr}`;
  }

  function avgScore(group) {
    if (!group.length) return 0;
    return round2(group.reduce((s,c) => s + (c.finalScore||0), 0) / group.length);
  }

  const lines = [`🏹 HUNTER LEADERBOARD`, `${timeStr}`, ``];

  if (cryptoTop.length > 0) {
    lines.push(`🪙 CRYPTO   ₿ BTC ${btcWord}`, ``);
    cryptoTop.forEach((c, i) => lines.push(fmtRow(c, i)));
    lines.push(``);
  }
  if (usTop.length > 0) {
    lines.push(`🇺🇸 US STOCKS   📊 QQQ ${qqqWord}`, ``);
    usTop.forEach((c, i) => lines.push(fmtRow(c, i)));
    lines.push(``);
  }
  if (lseTop.length > 0) {
    lines.push(`🇬🇧 LSE`, ``);
    lseTop.forEach((c, i) => lines.push(fmtRow(c, i)));
    lines.push(``);
  }

  // ── HUNTER MARKET INTEL ─────────────────────────────────────────
  lines.push(`━━━━━━━━━━━━━━━━━━`, ``, `🧠 HUNTER MARKET INTEL`, ``);

  // Overall leader
  if (allScored.length > 0) {
    lines.push(`🏆 Overall Leader: ${allScored[0].symbol.replace('USDT','')} ⭐${round2(allScored[0].finalScore)}`);
  }

  // New leaders — in current top 5 per market but not in prior top 5
  const allTop5 = [...cryptoTop, ...usTop, ...lseTop];
  const newLeaders = allTop5.filter(c => {
    const prior = priorRankMap.get(c.symbol);
    return prior == null || prior > 5;
  }).map(c => c.symbol.replace('USDT',''));
  if (newLeaders.length > 0) lines.push(`🆕 New Leaders: ${newLeaders.join(', ')}`);

  // Biggest climber and faller in current top 5 (by rank delta)
  const withRankDelta = allTop5
    .map((c, idx) => {
      const currentRank = idx + 1;
      const priorRank   = priorRankMap.get(c.symbol);
      const delta       = priorRank != null ? priorRank - currentRank : 0; // positive = climbed
      return { symbol: c.symbol, delta };
    })
    .filter(x => x.delta !== 0)
    .sort((a,b) => b.delta - a.delta);

  if (withRankDelta.length > 0 && withRankDelta[0].delta > 0) {
    const climber = withRankDelta[0];
    lines.push(`📈 Biggest Climber: ${climber.symbol.replace('USDT','')} (+${climber.delta} place${climber.delta>1?'s':''})`);
  }
  if (withRankDelta.length > 0 && withRankDelta[withRankDelta.length-1].delta < 0) {
    const faller = withRankDelta[withRankDelta.length-1];
    lines.push(`📉 Biggest Faller: ${faller.symbol.replace('USDT','')} (${faller.delta} place${Math.abs(faller.delta)>1?'s':''})`);
  }

  // Capital rotation — which market avg velocity is highest
  const cryptoVelAvg = cryptoTop.length
    ? round2(cryptoTop.reduce((s,c)=>s+(velocityMap.get(c.symbol)||0),0)/cryptoTop.length) : 0;
  const usVelAvg = usTop.length
    ? round2(usTop.reduce((s,c)=>s+(velocityMap.get(c.symbol)||0),0)/usTop.length) : 0;
  const lseVelAvg = lseTop.length
    ? round2(lseTop.reduce((s,c)=>s+(velocityMap.get(c.symbol)||0),0)/lseTop.length) : 0;

  const velMarkets = [
    { name: 'Crypto', vel: cryptoVelAvg },
    { name: 'US', vel: usVelAvg },
    { name: 'LSE', vel: lseVelAvg },
  ].filter(m => m.vel !== 0).sort((a,b) => b.vel - a.vel);

  if (velMarkets.length >= 2 && Math.abs(velMarkets[0].vel - velMarkets[velMarkets.length-1].vel) > 1) {
    lines.push(`🌊 Capital Rotation: ${velMarkets[velMarkets.length-1].name} → ${velMarkets[0].name}`);
  }

  lines.push(``);
  const hasBuy = allScored.some(c => (c.finalScore||0) >= CONFIG.THRESHOLDS.hunterScoreGood);
  lines.push(hasBuy ? `🔥 Qualifying setup identified — see alert` : `⏳ No qualifying setups identified.`);

  lines.push(``, `——————————`);
  lines.push(`⚠️ Educational market analysis only · Not personalised investment advice · Not a recommendation to buy or sell.`);
  lines.push(``);
  lines.push(`📸 Analysis by @baretradesignals 🏹`);

  // ── Leaderboard history — full universe ──────────────────────────
  if (supabase && allScored.length > 0) {
    try {
      const snapshotId   = `lb_${Date.now()}`;
      const snapshotTime = now.toISOString();
      const rows = allScored.map((c, i) => ({
        snapshot_id:   snapshotId,
        snapshot_time: snapshotTime,
        rank:          i + 1,
        symbol:        c.symbol,
        asset_type:    c.assetType || c.type || 'unknown',
        score:         round2(c.finalScore || c.adjustedScore || 0),
        btc_regime:    STATE.btcRegime,
        qqq_regime:    STATE.qqqRegimeStale ? 'CLOSED' : STATE.qqqRegime,
        cycle_count:   STATE.cycleCount,
      }));
      log(`📊 Writing full leaderboard snapshot: ${rows.length} assets, top=${rows[0]?.symbol} score=${rows[0]?.score}`);
      const { error } = await supabase.from('hunter_leaderboard_history').insert(rows);
      if (error) log(`⚠️  Leaderboard history write FAILED: ${error.message} (code=${error.code})`);
      else log(`📊 Leaderboard snapshot saved (snapshot_id=${snapshotId}, ${rows.length} rows)`);
    } catch (err) {
      log(`⚠️  Leaderboard history error: ${err.message}`);
    }
  } else {
    log(`📊 Leaderboard history skipped — supabase=${!!supabase} scored=${allScored.length}`);
  }

  STATE.leaderboard = allScored.slice(0, 5);

  const msg = lines.join('\n');
  if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
  log('📊 Leaderboard sent');
}

async function fireNoTradeMessage(scan) {
  const msg = buildNoTradeMessage(scan);
  if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
  log('📭 No trade message sent');
}

// ============================================================
// WEEKLY REPORT — Hunter Universe (all tracked assets)
// Fires every Friday 11:00–13:00 UTC (12:00–14:00 BST).
// League table: biggest climbers, fallers, most consistent,
// new entrants, dropouts. Built from hunter_leaderboard_history.
// ============================================================

async function fireHunterWeeklyReport() {
  if (!supabase) { log('⚠️  Hunter weekly report skipped — no Supabase'); return; }
  log('📅 Building Hunter universe weekly report...');

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await supabase
    .from('hunter_leaderboard_history')
    .select('symbol, asset_type, rank, score, snapshot_id, snapshot_time')
    .gte('snapshot_time', since)
    .order('snapshot_time', { ascending: true });

  if (error || !rows || rows.length === 0) {
    log(`⚠️  Hunter weekly report: no data (${error?.message || 'empty'})`);
    return;
  }

  const allSnapshots   = new Set(rows.map(r => r.snapshot_id));
  const totalSnapshots = allSnapshots.size;
  const snapshotIds    = [...allSnapshots];
  const firstSnapshot  = snapshotIds[0];
  const lastSnapshot   = snapshotIds[snapshotIds.length - 1];

  // Per-symbol stats
  const symbolMap = new Map();
  for (const row of rows) {
    if (!symbolMap.has(row.symbol)) {
      symbolMap.set(row.symbol, {
        symbol:     row.symbol,
        assetType:  row.asset_type,
        ranks:  [], scores: [],
        top5count: 0, top10count: 0, rank1count: 0,
        firstRank: null, lastRank: null,
        firstScore: null, lastScore: null,
      });
    }
    const d = symbolMap.get(row.symbol);
    d.ranks.push(row.rank);
    d.scores.push(parseFloat(row.score));
    if (row.rank <= 5)  d.top5count++;
    if (row.rank <= 10) d.top10count++;
    if (row.rank === 1) d.rank1count++;
    if (row.snapshot_id === firstSnapshot) { d.firstRank = row.rank; d.firstScore = parseFloat(row.score); }
    if (row.snapshot_id === lastSnapshot)  { d.lastRank  = row.rank; d.lastScore  = parseFloat(row.score); }
  }

  const assets = [...symbolMap.values()].filter(d => d.ranks.length >= 2);

  const avgRankFn  = d => d.ranks.reduce((a,b)=>a+b,0)/d.ranks.length;
  const avgScoreFn = d => d.scores.reduce((a,b)=>a+b,0)/d.scores.length;

  // Champion — best avg rank across all snapshots
  const champion = [...assets].sort((a,b) => avgRankFn(a) - avgRankFn(b))[0];

  // Most #1 finishes
  const mostWins = [...assets].sort((a,b) => b.rank1count - a.rank1count)[0];

  // Most persistent top 5
  const mostPersistent = [...assets].sort((a,b) => b.top5count - a.top5count).slice(0, 3);

  // Biggest climber / faller by rank delta
  const withDelta = assets
    .filter(d => d.firstRank != null && d.lastRank != null)
    .map(d => ({ ...d, rankDelta: d.firstRank - d.lastRank }))
    .sort((a,b) => b.rankDelta - a.rankDelta);
  const biggestClimber = withDelta[0];
  const biggestFaller  = withDelta[withDelta.length - 1];

  // New entrants / dropouts (top 10)
  const firstTop10 = new Set(rows.filter(r => r.snapshot_id === firstSnapshot && r.rank <= 10).map(r => r.symbol));
  const lastTop10  = new Set(rows.filter(r => r.snapshot_id === lastSnapshot  && r.rank <= 10).map(r => r.symbol));
  const newEntrants = [...lastTop10].filter(s => !firstTop10.has(s)).map(s => s.replace('USDT',''));
  const dropouts    = [...firstTop10].filter(s => !lastTop10.has(s)).map(s => s.replace('USDT',''));

  // Capital rotation — compare avg score first half vs second half per asset type
  const cryptoAssets = assets.filter(d => d.assetType === 'crypto');
  const usAssets     = assets.filter(d => d.assetType === 'us');
  const lseAssets    = assets.filter(d => d.assetType === 'lse');
  const marketAvgScore = m => m.length ? round2(m.reduce((s,d)=>s+avgScoreFn(d),0)/m.length) : 0;
  const marketAvgs = [
    { name: 'Crypto 🪙',     avg: marketAvgScore(cryptoAssets) },
    { name: 'US Stocks 🇺🇸', avg: marketAvgScore(usAssets) },
    { name: 'LSE 🇬🇧',        avg: marketAvgScore(lseAssets) },
  ].filter(m => m.avg > 0).sort((a,b) => b.avg - a.avg);

  // Market breadth — % of assets that improved week over week
  const improved = assets.filter(d => d.lastScore != null && d.firstScore != null && d.lastScore > d.firstScore).length;
  const breadthPct = assets.length > 0 ? Math.round((improved / assets.length) * 100) : 0;

  // Hall of Fame — champion stats
  const hofScore = champion ? round2(
    ((champion.rank1count / totalSnapshots) * 40) +
    ((champion.top5count  / totalSnapshots) * 35) +
    (Math.min(avgScoreFn(champion) / 100, 1) * 25) * 100
  ) : 0;

  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  const lines = [
    `🏹 HUNTER WEEKLY REPORT`,
    `Week ending ${dateStr} · ${totalSnapshots} snapshots`,
    ``,
    `📊 QQQ: ${STATE.qqqRegimeStale ? '⚪ CLOSED' : STATE.qqqRegime === 'BULL' ? '🟢 BULL' : STATE.qqqRegime === 'BEAR' ? '🔴 BEAR' : '🟡 NEUTRAL'}   ₿ BTC: ${STATE.btcRegime === 'BULL' ? '🟢 BULL' : STATE.btcRegime === 'BEAR' ? '🔴 BEAR' : '🟡 NEUTRAL'}`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `🏛 HUNTER HALL OF FAME`,
    ``,
  ];

  if (champion) {
    const label = champion.symbol.replace('USDT','');
    lines.push(`👑 Champion: ${label}`);
    lines.push(`🥇 #1 Finishes: ${champion.rank1count}`);
    lines.push(`🔥 Top 5 Appearances: ${champion.top5count}`);
    lines.push(`⭐ Avg Score: ${round2(avgScoreFn(champion))}`);
    lines.push(`🏅 Hunter Rating: ${hofScore}/100`);
  }

  lines.push(``, `━━━━━━━━━━━━━━━━━━`, `📊 LEAGUE TABLE`, ``);

  if (mostPersistent.length > 0) {
    lines.push(`🔥 Most Persistent Leaders:`);
    mostPersistent.forEach(d => {
      const pct = Math.round((d.top5count / totalSnapshots) * 100);
      lines.push(`   ${d.symbol.replace('USDT','').padEnd(10)} Top 5 in ${pct}% of snapshots`);
    });
    lines.push(``);
  }

  if (mostWins?.rank1count > 0) lines.push(`🏆 Most #1 Finishes: ${mostWins.symbol.replace('USDT','')} (${mostWins.rank1count})`);
  if (biggestClimber?.rankDelta > 0) lines.push(`📈 Biggest Climber: ${biggestClimber.symbol.replace('USDT','')} (▲ ${biggestClimber.rankDelta} places)`);
  if (biggestFaller?.rankDelta < 0)  lines.push(`📉 Biggest Faller: ${biggestFaller.symbol.replace('USDT','')} (▼ ${Math.abs(biggestFaller.rankDelta)} places)`);
  if (newEntrants.length > 0) lines.push(`🆕 New in Top 10: ${newEntrants.join('  ')}`);
  if (dropouts.length > 0)    lines.push(`❌ Dropped: ${dropouts.join('  ')}`);

  lines.push(``, `━━━━━━━━━━━━━━━━━━`, `🌊 MARKET INTELLIGENCE`, ``);

  if (marketAvgs.length > 0) {
    lines.push(`🏆 Strongest Market: ${marketAvgs[0].name}`);
    if (marketAvgs.length > 1) lines.push(`📉 Weakest Market: ${marketAvgs[marketAvgs.length-1].name}`);
  }
  lines.push(`📊 Market Breadth: ${breadthPct}% of tracked assets strengthened this week`);

  // Takeaway — narrative summary
  const leadMarket = marketAvgs[0]?.name || 'Mixed';
  const rotation = marketAvgs.length >= 2 && Math.abs(marketAvgs[0].avg - marketAvgs[marketAvgs.length-1].avg) > 3
    ? `Capital flow favoured ${marketAvgs[0].name} over ${marketAvgs[marketAvgs.length-1].name}.`
    : `Markets moved broadly in line with each other.`;
  const breadthNarrative = breadthPct >= 60 ? `Broad strength across the universe.`
    : breadthPct >= 40 ? `Mixed signals — leadership was selective.`
    : `Narrow leadership — most assets weakened.`;

  lines.push(``, `🎯 Hunter's Weekly Takeaway`);
  lines.push(`${rotation} ${breadthNarrative}${champion ? ` ${champion.symbol.replace('USDT','')} dominated the week.` : ''}`);

  lines.push(``, `——————————`);
  lines.push(`⚠️ Educational market analysis only · Not personalised investment advice · Not a recommendation to buy or sell.`);
  lines.push(``);
  lines.push(`📸 Analysis by @baretradesignals 🏹`);

  const msg = lines.join('\n');
  if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
  if (ENV.HUNTER_LIVE && ENV.CHANNEL_CHAT_ID) await sendTelegram(msg, ENV.CHANNEL_CHAT_ID);
  log('📅 Hunter universe weekly report sent');
}


// ============================================================
// WEEKLY REPORT — Crypto Cycle Planner coins
// Fires every Friday at ~18:00 UTC (end of US session).
// Tracks 11 fixed coins regardless of current Hunter universe.
// Metrics: persistence, score trend, avg score, rank, streaks,
// rotation — weighted toward consistency over peak scores.
// ============================================================

const CYCLE_PLANNER_COINS = [
  'ETHUSDT','SOLUSDT','LINKUSDT','AAVEUSDT','HYPEUSDT',
  'AVAXUSDT','INJUSDT','XRPUSDT','TIAUSDT','SUIUSDT','ONDOUSDT',
];

// Persistence score = weighted composite (0-100)
// 40% top-5 appearances, 25% avg score, 20% avg rank, 15% #1 finishes
function calcPersistenceScore(top5count, totalSnapshots, avgScore, avgRank, rank1count) {
  if (totalSnapshots === 0) return 0;
  const top5pct   = Math.min(top5count / totalSnapshots, 1);   // 0-1
  const scorePct  = Math.min(avgScore / 100, 1);               // 0-1
  const rankPct   = avgRank > 0 ? Math.max(0, 1 - (avgRank - 1) / 57) : 0; // inverted: rank 1 = 1.0
  const rank1pct  = Math.min(rank1count / totalSnapshots, 1);  // 0-1
  return Math.round((top5pct * 40) + (scorePct * 25) + (rankPct * 20) + (rank1pct * 15));
}

// Momentum streak: count of consecutive snapshots with rising score
// Returns positive (improving) or negative (fading)
function calcStreak(scoreHistory) {
  if (scoreHistory.length < 2) return 0;
  // scoreHistory is ordered oldest→newest
  let streak = 0;
  const last = scoreHistory[scoreHistory.length - 1];
  const prev = scoreHistory[scoreHistory.length - 2];
  const direction = last > prev ? 1 : last < prev ? -1 : 0;
  if (direction === 0) return 0;
  for (let i = scoreHistory.length - 1; i >= 1; i--) {
    if ((scoreHistory[i] - scoreHistory[i-1]) * direction > 0) streak += direction;
    else break;
  }
  return streak;
}

// Score trend: slope of scores over the week (positive = improving)
function calcScoreTrend(scoreHistory) {
  if (scoreHistory.length < 3) return 0;
  const n = scoreHistory.length;
  const xMean = (n - 1) / 2;
  const yMean = scoreHistory.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  scoreHistory.forEach((y, x) => {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  });
  return den === 0 ? 0 : round2(num / den); // points per snapshot
}

async function fireWeeklyReport() {
  if (!supabase) { log('⚠️  Cycle Planner report skipped — no Supabase'); return; }
  log('📅 Building Crypto Cycle Planner weekly report...');

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await supabase
    .from('hunter_leaderboard_history')
    .select('symbol, rank, score, snapshot_time, snapshot_id')
    .in('symbol', CYCLE_PLANNER_COINS)
    .gte('snapshot_time', since)
    .order('snapshot_time', { ascending: true });

  if (error || !rows || rows.length === 0) {
    log(`⚠️  Cycle Planner report: no data (${error?.message || 'empty result'})`);
    return;
  }

  const allSnapshots   = new Set(rows.map(r => r.snapshot_id));
  const totalSnapshots = allSnapshots.size;
  const snapshotIds    = [...allSnapshots];
  const firstSnapshot  = snapshotIds[0];
  const lastSnapshot   = snapshotIds[snapshotIds.length - 1];

  // Per-coin stats
  const coinData = {};
  for (const coin of CYCLE_PLANNER_COINS) {
    const coinRows = rows
      .filter(r => r.symbol === coin)
      .sort((a, b) => new Date(a.snapshot_time) - new Date(b.snapshot_time));

    if (coinRows.length === 0) { coinData[coin] = null; continue; }

    const scores    = coinRows.map(r => parseFloat(r.score));
    const ranks     = coinRows.map(r => r.rank);
    const top5rows  = coinRows.filter(r => r.rank <= 5);
    const rank1rows = coinRows.filter(r => r.rank === 1);
    const avgScore  = round2(scores.reduce((a,b)=>a+b,0) / scores.length);
    const avgRank   = round2(ranks.reduce((a,b)=>a+b,0) / ranks.length);
    const peakScore = round2(Math.max(...scores));
    const streak    = calcStreak(scores);
    const trend     = calcScoreTrend(scores);
    const persistence = calcPersistenceScore(top5rows.length, totalSnapshots, avgScore, avgRank, rank1rows.length);

    // Score delta: last score vs first score this week
    const scoreDelta = round2(scores[scores.length-1] - scores[0]);

    const mid       = Math.floor(scores.length / 2);
    const firstAvg  = scores.slice(0, mid).reduce((a,b)=>a+b,0) / (mid || 1);
    const secondAvg = scores.slice(mid).reduce((a,b)=>a+b,0) / (scores.slice(mid).length || 1);
    const rotation  = (secondAvg - firstAvg) > 3 ? 'IN' : (firstAvg - secondAvg) > 3 ? 'OUT' : 'STABLE';
    const direction = trend > 0.5 ? 'Improving' : trend < -0.5 ? 'Weakening' : 'Stable';

    // Was this coin in top 5 in first and last snapshots?
    const inFirstTop5 = coinRows.some(r => r.snapshot_id === firstSnapshot && r.rank <= 5);
    const inLastTop5  = coinRows.some(r => r.snapshot_id === lastSnapshot  && r.rank <= 5);

    coinData[coin] = {
      appearances: coinRows.length, top5count: top5rows.length,
      rank1count: rank1rows.length, avgScore, avgRank, peakScore,
      streak, trend, persistence, scoreDelta, rotation, direction,
      inFirstTop5, inLastTop5,
    };
  }

  // Sort by persistence descending
  const sorted = CYCLE_PLANNER_COINS
    .filter(c => coinData[c] !== null)
    .sort((a,b) => (coinData[b]?.persistence||0) - (coinData[a]?.persistence||0));

  // Intel calculations
  const top3         = sorted.slice(0,3).map(c=>c.replace('USDT',''));
  const inbound      = sorted.filter(c=>coinData[c]?.rotation==='IN').map(c=>c.replace('USDT',''));
  const outbound     = sorted.filter(c=>coinData[c]?.rotation==='OUT').map(c=>c.replace('USDT',''));
  const improving    = sorted.filter(c=>coinData[c]?.direction==='Improving').map(c=>c.replace('USDT',''));
  const streakers    = sorted.filter(c=>(coinData[c]?.streak||0)>=3).map(c=>c.replace('USDT',''));
  const newTop5      = sorted.filter(c=>!coinData[c]?.inFirstTop5 && coinData[c]?.inLastTop5).map(c=>c.replace('USDT',''));
  const droppedTop5  = sorted.filter(c=>coinData[c]?.inFirstTop5 && !coinData[c]?.inLastTop5).map(c=>c.replace('USDT',''));

  // Biggest improver and faller by scoreDelta
  const withDelta = sorted.filter(c=>coinData[c]).map(c=>({label:c.replace('USDT',''), delta:coinData[c].scoreDelta}));
  const bigImprover = withDelta.sort((a,b)=>b.delta-a.delta)[0];
  const bigFaller   = [...withDelta].sort((a,b)=>a.delta-b.delta)[0];

  // Highest score this week
  const peakCoin = sorted.reduce((best,c)=>
    (coinData[c]?.peakScore||0) > (coinData[best]?.peakScore||0) ? c : best, sorted[0]);

  // Market Confidence score (0-100) — avg persistence of top 5 coins
  const top5Coins = sorted.slice(0,5);
  const marketConf = top5Coins.length
    ? Math.round(top5Coins.reduce((s,c)=>s+(coinData[c]?.persistence||0),0)/top5Coins.length)
    : 0;

  // Market structure stats
  const distinctTop5 = new Set(rows.filter(r=>r.rank<=5).map(r=>r.symbol)).size;
  const allTop5scores = rows.filter(r=>r.rank<=5).map(r=>parseFloat(r.score));
  const avgLeaderScore = allTop5scores.length
    ? round2(allTop5scores.reduce((a,b)=>a+b,0)/allTop5scores.length) : 0;

  // Leader changes — count how many times #1 changed hands
  let leaderChanges = 0, lastLeader = null;
  for (const sid of snapshotIds) {
    const topRow = rows.filter(r=>r.snapshot_id===sid && r.rank===1)[0];
    if (topRow && topRow.symbol !== lastLeader) {
      if (lastLeader !== null) leaderChanges++;
      lastLeader = topRow.symbol;
    }
  }

  // Stability: based on leaderChanges and distinctTop5
  const stability = leaderChanges <= 2 && distinctTop5 <= 6 ? 'HIGH'
                  : leaderChanges <= 5 && distinctTop5 <= 9 ? 'MEDIUM' : 'LOW';

  // Calendar actions — based on persistence + rotation + direction
  const actions = { increase: [], maintain: [], watch: [], reduce: [] };
  for (const coin of sorted) {
    const d = coinData[coin];
    if (!d) continue;
    const label = coin.replace('USDT','');
    if (d.persistence >= 70 && d.rotation !== 'OUT' && d.direction !== 'Weakening') {
      actions.increase.push(label);
    } else if (d.persistence >= 50 && d.direction === 'Stable') {
      actions.maintain.push(label);
    } else if (d.persistence >= 35 || d.rotation === 'IN') {
      actions.watch.push(label);
    } else {
      actions.reduce.push(label);
    }
  }

  // Next week watch list — dynamic observations
  const nextWeek = [];
  if (sorted.some(c=>coinData[c]?.rotation==='IN' && coinData[c]?.top5count<3)) {
    const emerging = sorted.filter(c=>coinData[c]?.rotation==='IN' && coinData[c]?.top5count<3).map(c=>c.replace('USDT',''));
    nextWeek.push(`• New leader emerging? Watch: ${emerging.join(', ')}`);
  }
  if (coinData['BTCUSDT'] && coinData['BTCUSDT'].direction === 'Weakening') {
    nextWeek.push(`• BTC losing persistence — monitor for regime shift`);
  }
  for (const c of streakers) {
    nextWeek.push(`• ${c} on a streak — watch for continuation or reversal`);
  }
  if (newTop5.length > 0) {
    nextWeek.push(`• ${newTop5.join(', ')} entered Top 5 — watch for 3+ appearances to confirm`);
  }
  if (nextWeek.length === 0) nextWeek.push(`• No major rotation signals — leadership stable`);

  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const qqqStr  = STATE.qqqRegimeStale ? '⚪ CLOSED'
    : STATE.qqqRegime === 'BULL' ? '🟢 BULL' : STATE.qqqRegime === 'BEAR' ? '🔴 BEAR' : '🟡 NEUTRAL';
  const btcStr  = STATE.btcRegime === 'BULL' ? '🟢 BULL' : STATE.btcRegime === 'BEAR' ? '🔴 BEAR' : '🟡 NEUTRAL';

  const rankEmoji = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','1️⃣1️⃣'];

  const lines = [
    `🏹 HUNTER WEEKLY REPORT`,
    `Crypto Cycle Planner — ${dateStr}`,
    ``,
    `📊 QQQ: ${qqqStr}`,
    `₿ BTC Trend: ${btcStr}`,
    `📅 ${totalSnapshots} snapshots | 7 days`,
    `🎯 Market Confidence: ${marketConf}/100`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `🏆 WEEKLY RANKINGS`,
    ``,
  ];

  sorted.forEach((coin, i) => {
    const d = coinData[coin];
    if (!d) return;
    const label   = coin.replace('USDT','');
    const streakStr = d.streak > 0 ? `🔥 +${d.streak}` : d.streak < 0 ? `🔻 ${d.streak}` : `➖ 0`;
    const rotStr    = d.rotation === 'IN' ? '🔼 IN' : d.rotation === 'OUT' ? '🔽 OUT' : '➡️ STABLE';
    const dirArrow  = d.direction === 'Improving' ? '↑' : d.direction === 'Weakening' ? '↓' : '→';

    lines.push(`${rankEmoji[i] || `${i+1}.`} ${label}`);
    lines.push(`Persistence: ${d.persistence}/100`);
    lines.push(`Avg Score: ${d.avgScore}  Peak: ${d.peakScore}`);
    lines.push(`Top 5: ${d.top5count}/${totalSnapshots}  #1: ${d.rank1count}  Avg Rank: ${d.avgRank}`);
    lines.push(`Trend: ${dirArrow} ${d.direction}  Streak: ${streakStr}  Rotation: ${rotStr}`);
    lines.push(``);
  });

  const missing = CYCLE_PLANNER_COINS.filter(c => coinData[c] === null);
  if (missing.length > 0) {
    lines.push(`⚠️ No data: ${missing.map(c=>c.replace('USDT','')).join(', ')}`, ``);
  }

  // Intel
  lines.push(`━━━━━━━━━━━━━━━━━━`, `🧠 HUNTER INTEL`, ``);
  if (top3.length)        lines.push(`🏆 Most Persistent:`, `${top3.join(' • ')}`, ``);
  if (peakCoin)           lines.push(`🚀 Highest Score This Week:`, `${peakCoin.replace('USDT','')} — ${coinData[peakCoin]?.peakScore}`, ``);
  if (bigImprover?.delta > 0) lines.push(`📈 Biggest Improver:`, `${bigImprover.label} (+${bigImprover.delta})`, ``);
  if (bigFaller?.delta < 0)   lines.push(`📉 Biggest Faller:`, `${bigFaller.label} (${bigFaller.delta})`, ``);
  if (streakers.length)   lines.push(`🔥 Momentum Streaks:`, `${streakers.join(' • ')}`, ``);
  if (inbound.length)     lines.push(`🔼 Capital Rotating In:`, `${inbound.join(' • ')}`, ``);
  if (outbound.length)    lines.push(`🔽 Capital Rotating Out:`, `${outbound.join(' • ')}`, ``);
  if (newTop5.length)     lines.push(`🆕 New Top 5 Entrants:`, `${newTop5.join(' • ')}`, ``);
  if (droppedTop5.length) lines.push(`❌ Dropped From Top 5:`, `${droppedTop5.join(' • ')}`, ``);

  // Market Structure
  lines.push(`━━━━━━━━━━━━━━━━━━`, `📊 MARKET STRUCTURE`, ``);
  lines.push(`Leader Changes: ${leaderChanges}`);
  lines.push(`Distinct Top 5 Assets: ${distinctTop5}`);
  lines.push(`Average Leader Score: ${avgLeaderScore}`);
  lines.push(`Hunter Stability: ${stability}`, ``);

  // Calendar Actions
  lines.push(`━━━━━━━━━━━━━━━━━━`, `🎯 CALENDAR ACTIONS`, ``);
  if (actions.increase.length) lines.push(`Increase Conviction:`, ...actions.increase.map(l=>`• ${l}`), ``);
  if (actions.maintain.length) lines.push(`Maintain:`, ...actions.maintain.map(l=>`• ${l}`), ``);
  if (actions.watch.length)    lines.push(`Watch Closely:`, ...actions.watch.map(l=>`• ${l}`), ``);
  if (actions.reduce.length)   lines.push(`Reduce Conviction:`, ...actions.reduce.map(l=>`• ${l}`), ``);

  // Next Week
  lines.push(`━━━━━━━━━━━━━━━━━━`, `📅 NEXT WEEK TO WATCH`, ``);
  lines.push(...nextWeek, ``);

  // ── Claude Scoring Guidance ─────────────────────────────────────
  // Hunter Confidence = inverse of stability + market confidence composite
  // HIGH: marketConf >= 70 and stability === 'HIGH'
  // LOW:  marketConf <  45 or stability === 'LOW'
  const hunterConfidence = (marketConf >= 70 && stability === 'HIGH') ? 'HIGH'
                         : (marketConf < 45  || stability === 'LOW')  ? 'LOW'
                         : 'MEDIUM';

  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(`🤖 CLAUDE SCORING GUIDANCE`);
  lines.push(``);
  lines.push(`Hunter Confidence: ${hunterConfidence}`);
  lines.push(`Hunter Flow = 30% of total coin score.`);
  lines.push(``);

  if (actions.increase.length) {
    lines.push(`Increase Hunter Flow score:`);
    actions.increase.forEach(l => lines.push(`• ${l}`));
    lines.push(``);
  }
  if (actions.maintain.length) {
    lines.push(`Maintain Hunter Flow score:`);
    actions.maintain.forEach(l => lines.push(`• ${l}`));
    lines.push(``);
  }
  if (actions.reduce.length) {
    lines.push(`Decrease Hunter Flow score:`);
    actions.reduce.forEach(l => lines.push(`• ${l}`));
    lines.push(``);
  }

  // Confidence-dependent instruction
  if (hunterConfidence === 'HIGH') {
    lines.push(`Hunter signal is strong this week. Apply Hunter Flow changes directly.`);
    lines.push(`Still require at least one of Narrative or Technical to confirm before increasing overall conviction.`);
  } else if (hunterConfidence === 'MEDIUM') {
    lines.push(`Hunter signal is mixed. Do not change overall conviction on Hunter Flow alone.`);
    lines.push(`Require confirmation from Plex/Google Narrative OR Technical Structure before adjusting scores.`);
  } else {
    lines.push(`Hunter signal is weak or unstable this week. Treat Hunter Flow as low-weight evidence only.`);
    lines.push(`Only adjust scores where Narrative AND Technical both independently agree.`);
  }

  lines.push(``);
  lines.push(`Only increase overall conviction when at least two of the following align:`);
  lines.push(`• Hunter Flow`);
  lines.push(`• Plex/Google Narrative`);
  lines.push(`• Technical Structure`);

  lines.push(``, `━━━━━━━━━━━━━━━━━━`);
  lines.push(`⚠️ Educational market analysis only · Not personalised investment advice · Not a recommendation to buy or sell.`);
  lines.push(``);
  lines.push(`📸 Analysis by @baretradesignals 🏹`);

  const msg = lines.join('\n');
  if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
  if (ENV.HUNTER_LIVE && ENV.CHANNEL_CHAT_ID) await sendTelegram(msg, ENV.CHANNEL_CHAT_ID);
  log('📅 Crypto Cycle Planner report sent');
}


// ============================================================
// SECTION 27: SUPABASE LEARNING ENGINE
// ============================================================

async function storeAlert(candidate, scan) {
  if (!supabase) return;
  try {
    const { execution, execEngine, rawScores, confidence, conviction, edgeResult, stageInfo, reasons } = candidate;

    const entryRef = execEngine?.entryPrice ?? execution.entry;
    const stopRef  = execEngine?.stopPrice  ?? execution.stopPrice;
    const t1Ref    = execEngine?.t1Price    ?? execution.t1Price;
    const t2Ref    = execEngine?.t2Price    ?? execution.t2Price;
    const rrRef    = execEngine?.rrRatio    ?? execution.rrRatio;

    const row = {
      symbol:              candidate.symbol,
      asset_type:          candidate.assetType,
      hunter_score:        round2(candidate.finalScore),
      execution_score:     round2(rawScores.executionQuality),
      structure_score:     round2(rawScores.structure),
      momentum_score:      round2(rawScores.momentum),
      participation_score: round2(rawScores.participation),
      risk_score:          round2(rawScores.risk),
      confidence:          round2(confidence.score),
      conviction:          round2(conviction.score),
      edge_over_field:     round2(edgeResult.edge),
      stability_score:     round2(candidate.stability?.score || 0),
      stage:               stageInfo.stage,
      entry_price:         round2(entryRef),
      stop_price:          round2(stopRef),
      t1_price:            round2(t1Ref),
      t2_price:            round2(t2Ref),
      rr_ratio:            round2(rrRef),
      buy_reasons:         JSON.stringify(reasons),
      reject_reasons:      JSON.stringify(candidate.rejectReasons || []),
      field_avg:           round2(scan.fieldAvg),
      created_at:          new Date().toISOString(),
      target1_hit:         false,
      target2_hit:         false,
      stopped_out:         false,
      outcome_checked:     false,
      // New columns — regime + setup context for analytics engine
      btc_regime:          STATE.btcRegime || null,
      qqq_regime:          STATE.qqqRegimeStale ? 'CLOSED' : (STATE.qqqRegime || null),
      setup_type:          execEngine?.setupType || null,
      // theme/sector/industry left null — populated later via classification
    };

    const { error } = await supabase.from('hunter_alerts').insert(row);
    if (error) log(`Supabase insert error: ${error.message}`);
    else log(`📚 Alert stored in Supabase`);
  } catch (err) {
    log(`Supabase store error: ${err.message}`);
  }
}

async function sendOutcomeAlert(alert, outcomeType, hitPrice, pctMove) {
  const flagMap   = { crypto: '🌐', us: '🇺🇸', lse: '🇬🇧' };
  const flag      = flagMap[alert.asset_type] || '🌐';
  const isWin     = outcomeType === 'TP1' || outcomeType === 'TP2';
  const icon      = outcomeType === 'TP2' ? '🚀' : outcomeType === 'TP1' ? '📈' : '🛑';
  const label     = outcomeType === 'TP2' ? 'Secondary Target Reached' : outcomeType === 'TP1' ? 'Initial Target Reached' : 'Risk Level Reached';
  const resultStr = isWin ? `+${round2(pctMove)}%` : `${round2(pctMove)}%`;
  const formattedHit   = alert.asset_type === 'lse' ? `${round2(hitPrice)}p`          : `$${round2(hitPrice)}`;
  const formattedEntry = alert.asset_type === 'lse' ? `${round2(alert.entry_price)}p` : `$${round2(alert.entry_price)}`;
  const duration = round2((Date.now() - new Date(alert.created_at).getTime()) / 60000);

  const insight = isWin
    ? `Leadership remained intact after the reference price. The setup thesis was supported by subsequent price action.`
    : `Price reached the risk level before the target. The setup thesis was not confirmed by subsequent price action.`;

  const lines = [
    `🏹 TRADE REVIEW`,
    ``,
    `${icon} ${label}`,
    ``,
    `${flag} ${alert.asset_type.toUpperCase()} | ${alert.symbol}`,
    ``,
    `EL: ${formattedEntry}`,
    `${outcomeType === 'TP1' ? 'Target 1' : outcomeType === 'TP2' ? 'Target 2' : 'Risk Level'}: ${formattedHit}`,
    `Observed Move: ${resultStr}`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `🧠 HUNTER AT OBSERVATION`,
    ``,
    `⭐ Score: ${round2(alert.hunter_score)}`,
    `⏱ Duration: ${duration} min`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `Hunter Insight`,
    `${insight}`,
    ``,
    `Every outcome becomes new data. Hunter learns continuously.`,
    ``,
    `——————————`,
    `⚠️ Educational market analysis only · Not personalised investment advice · Not a recommendation to buy or sell.`,
    ``,
    `📸 Analysis by @baretradesignals 🏹`,
  ];

  const msg = lines.join('\n');
  if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
  if (ENV.HUNTER_LIVE && ENV.CHANNEL_CHAT_ID) await sendTelegram(msg, ENV.CHANNEL_CHAT_ID);
  log(`📬 Outcome alert sent: ${alert.symbol} ${outcomeType} (${resultStr})`);
}

async function trackOutcomes() {
  if (!supabase) return;
  try {
    const { data: pending, error } = await supabase
      .from('hunter_alerts')
      .select('*')
      .eq('outcome_checked', false)
      .gte('created_at', new Date(Date.now() - 86400000).toISOString());

    if (error || !pending?.length) return;

    for (const alert of pending) {
      try {
        let candles;
        if (alert.asset_type === 'crypto') candles = await fetchCryptoCandles(alert.symbol);
        else if (alert.asset_type === 'lse') candles = await fetchLSECandles(alert.symbol);
        else candles = await fetchUSStockCandles(alert.symbol);

        if (!candles?.length) continue;

        const current = candles[candles.length - 1].close;
        const ageMs   = Date.now() - new Date(alert.created_at).getTime();
        const ageMin  = ageMs / 60000;

        const recentHighs = candles.slice(-Math.min(candles.length, 20)).map((c) => c.high);
        const recentLows  = candles.slice(-Math.min(candles.length, 20)).map((c) => c.low);
        const mfe = Math.max(...recentHighs);
        const mae = Math.min(...recentLows);

        const target1Hit  = mfe >= alert.t1_price;
        const target2Hit  = mfe >= alert.t2_price;
        const stoppedOut  = mae <= alert.stop_price;
        const maxGainPct  = ((mfe - alert.entry_price) / alert.entry_price) * 100;
        const maxLossPct  = ((mae - alert.entry_price) / alert.entry_price) * 100;

        const shouldClose = ageMin >= 1440 || target1Hit || stoppedOut;

        const newlyHitT1   = target1Hit  && !alert.target1_hit;
        const newlyHitT2   = target2Hit  && !alert.target2_hit;
        const newlyStopped = stoppedOut  && !alert.stopped_out;

        if (newlyStopped) {
          await sendOutcomeAlert(alert, 'SL', mae, maxLossPct);
        } else if (newlyHitT2) {
          await sendOutcomeAlert(alert, 'TP2', mfe, maxGainPct);
        } else if (newlyHitT1) {
          await sendOutcomeAlert(alert, 'TP1', mfe, maxGainPct);
        }

        const update = {
          current_price:   round2(current),
          mfe_price:       round2(mfe),
          mae_price:       round2(mae),
          max_gain_pct:    round2(maxGainPct),
          max_loss_pct:    round2(maxLossPct),
          target1_hit:     target1Hit,
          target2_hit:     target2Hit,
          stopped_out:     stoppedOut,
          age_minutes:     round2(ageMin),
          outcome_checked: shouldClose,
          updated_at:      new Date().toISOString(),
        };

        await supabase.from('hunter_alerts').update(update).eq('id', alert.id);
        await sleep(200);
      } catch { /* individual failure ok */ }
    }
    log(`📊 Outcome tracking complete`);
  } catch (err) {
    log(`Outcome tracking error: ${err.message}`);
  }
}

// ============================================================
// SECTION 28: MAIN LOOP
// ============================================================

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function getRegimeCycleMs() {
  const btc = STATE.btcRegime;
  const qqq = STATE.qqqRegime;
  if (btc === 'BULL' && qqq === 'BULL') return CONFIG.CYCLE_MS_BULL;
  if (btc === 'BULL' || qqq === 'BULL') return CONFIG.CYCLE_MS_NEUTRAL;
  if (btc === 'BEAR' && qqq === 'BEAR') return CONFIG.CYCLE_MS_BEAR;
  if (btc === 'BEAR' || qqq === 'BEAR') return CONFIG.CYCLE_MS_NEUTRAL;
  return CONFIG.CYCLE_MS_NEUTRAL;
}

async function mainCycle() {
  if (!IS_LEADER) {
    await retryLeadership();
    if (!IS_LEADER) {
      log('⛔ Standby — skipping scan cycle');
      return;
    }
  }

  STATE.cycleCount++;
  log(`\n════ CYCLE ${STATE.cycleCount} ════ | Instance=${INSTANCE_ID}`);

  try {
    await injectDynamicAssets();
    const scan = await runFullScan();
    const buys = scan.buys || [];

    if (buys.length > 0) {
      const best = buys[0];
      log(`🎯 BUY candidate: ${best.symbol} (score ${round2(best.finalScore)})`);

      const secondBest = scan.candidates.filter((c) => c.symbol !== best.symbol)[0];
      const gap = secondBest ? best.finalScore - secondBest.finalScore : 999;

      if (gap >= CONFIG.THRESHOLDS.competitionGap) {
        await fireAlert(best, scan);
      } else {
        log(`Competition gap too small (${round2(gap)}) — holding fire`);
      }
    } else if (scan.watches?.length > 0) {
      log(`👁 ${scan.watches.length} assets on WATCH`);

      STATE.leaderboard = [...(scan.buys || []), ...(scan.watches || [])]
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, 5);

      await processWatchlistLifecycle(scan.watches);
    } else {
      log('No viable candidates this cycle');
    }

    // No-trade message — distributed lock via Supabase prevents both
    // instances firing simultaneously when two Railway deployments run.
    const noTradeAge = Date.now() - STATE.lastNoTradeTime;
    if (buys.length === 0 && noTradeAge >= CONFIG.NO_TRADE_COOLDOWN_MS) {
      let shouldSend = true;
      if (supabase) {
        try {
          const cutoff = new Date(Date.now() - CONFIG.NO_TRADE_COOLDOWN_MS).toISOString();
          const { data: existing } = await supabase
            .from('hunter_lock')
            .select('*')
            .eq('id', 'notrade_lock')
            .single();
          if (existing && existing.heartbeat > cutoff) {
            shouldSend = false;
            log('📭 No-trade suppressed — another instance already sent this cycle');
          } else {
            await supabase.from('hunter_lock').upsert({
              id: 'notrade_lock',
              instance_id: INSTANCE_ID,
              heartbeat: new Date().toISOString(),
              started_at: new Date().toISOString(),
            });
          }
        } catch { /* supabase error — allow send */ }
      }
      if (shouldSend) {
        await fireLeaderboardMessage(scan);
        STATE.lastNoTradeTime = Date.now();
      }
    }

    // Outcome tracking (every 10 cycles)
    if (STATE.cycleCount % 10 === 0) {
      await trackOutcomes();
    }

    // Weekly Crypto Cycle Planner report — Friday 17:00-19:00 UTC
    // Fires once per week. Uses hunter_calibration as a sent-flag so
    // Railway restarts or multiple instances don't double-fire.
    {
      const _now = new Date();
      const _day  = _now.getUTCDay();   // 5 = Friday
      const _hour = _now.getUTCHours();
      if (_day === 5 && _hour >= 11 && _hour < 13) { // 11:00-13:00 UTC = 12:00-14:00 BST (UK Friday lunchtime)
        const _weekKey = `weekly_report_${_now.getUTCFullYear()}_W${String(_now.getUTCMonth()+1).padStart(2,'0')}_${String(_now.getUTCDate()).padStart(2,'0')}`;
        let _alreadySent = false;
        if (supabase) {
          try {
            const { data: _wd } = await supabase
              .from('hunter_calibration')
              .select('id')
              .eq('id', _weekKey)
              .single();
            _alreadySent = !!_wd;
          } catch { /* not found = not sent */ }
        }
        if (!_alreadySent) {
          log('📅 Friday window — firing weekly reports');
          await fireHunterWeeklyReport();
          await fireWeeklyReport();
          if (supabase) {
            try {
              await supabase.from('hunter_calibration').upsert({
                id: _weekKey,
                recorded_at: _now.toISOString(),
                top_score: 0, top_symbol: 'WEEKLY_REPORT_SENT',
                field_avg: 0, candidate_count: 0,
                btc_regime: STATE.btcRegime, qqq_regime: STATE.qqqRegime,
                market_open_count: 0, buy_count: 0, watch_count: 0,
              });
            } catch { /* best effort */ }
          }
        }
      }
    }

    // Provider health summary — every 10 cycles
    if (STATE.cycleCount % 10 === 0 && providerHealth.size > 0) {
      log('🔌 PROVIDER HEALTH:');
      log(getProviderHealthSummary());
    }

    // Rejection reason stats (every 50 cycles)
    if (STATE.cycleCount % 50 === 0 && STATE.rejectionStats.size > 0) {
      const total = [...STATE.rejectionStats.values()].reduce((a, b) => a + b, 0);
      log('📊 REJECTION STATS (threshold calibration):');
      const sorted = [...STATE.rejectionStats.entries()].sort((a, b) => b[1] - a[1]);
      for (const [reason, count] of sorted.slice(0, 8)) {
        log(`   ${reason}: ${count} (${round2(count/total*100)}%)`);
      }
    }

    // Adjust next cycle interval based on current regime
    const newCycleMs = getRegimeCycleMs();
    if (newCycleMs !== STATE.currentCycleMs) {
      STATE.currentCycleMs = newCycleMs;
      const mins = round2(newCycleMs / 60000);
      log(`⏱  Regime changed — next cycle in ${mins} min (${STATE.btcRegime}/${STATE.qqqRegime})`);
      if (STATE._intervalHandle) clearInterval(STATE._intervalHandle);
      STATE._intervalHandle = setInterval(mainCycle, newCycleMs);
    }

  } catch (err) {
    log(`Cycle error: ${err.message}`);
    console.error(err);
  }
}

// ============================================================
// SINGLETON LEADERSHIP LOCK — robust distributed instance control
// ============================================================

let IS_LEADER     = false;
let lockHandle    = null;

const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_CUTOFF_MS       = 90_000;

log(`🚀 Hunter starting | Instance=${INSTANCE_ID}`);

async function claimLeadership() {
  if (!supabase) {
    log('⚠️  No Supabase — leadership lock disabled. Running as leader (watch for duplicates).');
    IS_LEADER = true;
    return true;
  }

  try {
    const staleCutoff = new Date(Date.now() - STALE_CUTOFF_MS).toISOString();

    const { data, error } = await supabase
      .from('hunter_lock')
      .select('*')
      .eq('id', 'singleton')
      .single();

    if (error && error.code !== 'PGRST116') {
      log(`⚠️  Lock read error: ${error.message} — running as leader`);
      IS_LEADER = true;
      return true;
    }

    const isUnclaimed  = !data || data.instance_id === 'unclaimed';
    const isStale      = data && data.heartbeat < staleCutoff;
    const isAlreadyUs  = data && data.instance_id === INSTANCE_ID;

    if (isAlreadyUs) {
      log(`👑 Already leader (${INSTANCE_ID})`);
      IS_LEADER = true;
      return true;
    }

    if (isUnclaimed || isStale) {
      const { error: updateErr } = await supabase
        .from('hunter_lock')
        .update({
          instance_id: INSTANCE_ID,
          heartbeat:   new Date().toISOString(),
        })
        .eq('id', 'singleton');

      if (updateErr) {
        log(`⚠️  Leadership claim failed: ${updateErr.message}`);
        IS_LEADER = false;
        return false;
      }

      log(`👑 Leadership acquired | Instance=${INSTANCE_ID} | was_stale=${isStale}`);
      IS_LEADER = true;
      startHeartbeat();
      return true;
    }

    const age = Math.round((Date.now() - new Date(data.heartbeat).getTime()) / 1000);
    log(`⛔ Standby — active leader: ${data.instance_id} (heartbeat ${age}s ago)`);
    IS_LEADER = false;
    return false;

  } catch (err) {
    log(`⚠️  Leadership claim exception: ${err.message} — running as leader`);
    IS_LEADER = true;
    return true;
  }
}

function startHeartbeat() {
  if (lockHandle) clearInterval(lockHandle);
  lockHandle = setInterval(async () => {
    if (!IS_LEADER || !supabase) return;
    try {
      const { error } = await supabase
        .from('hunter_lock')
        .update({ heartbeat: new Date().toISOString() })
        .eq('id', 'singleton')
        .eq('instance_id', INSTANCE_ID);

      if (error) {
        log(`⚠️  Heartbeat failed: ${error.message}`);
        if (IS_LEADER) {
          log('👑 Leadership lost — stopping scan loop. Entering standby mode.');
          IS_LEADER = false;
          if (STATE._intervalHandle) {
            clearInterval(STATE._intervalHandle);
            STATE._intervalHandle = null;
            STATE._intervalHandle = setInterval(mainCycle, STATE.currentCycleMs);
          }
        }
      }
    } catch (err) {
      log(`⚠️  Heartbeat exception: ${err.message}`);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

async function retryLeadership() {
  if (IS_LEADER) return;
  log('⏳ Standby — retrying leadership claim...');
  const claimed = await claimLeadership();
  if (claimed) {
    log('👑 Promoted to leader — starting scan');
    startHeartbeat();
  }
}

async function releaseLeadership() {
  IS_LEADER = false;
  if (lockHandle) { clearInterval(lockHandle); lockHandle = null; }
  if (!supabase) return;
  try {
    await supabase
      .from('hunter_lock')
      .update({ instance_id: 'unclaimed', heartbeat: new Date(0).toISOString() })
      .eq('id', 'singleton')
      .eq('instance_id', INSTANCE_ID);
    log('👑 Leadership released');
  } catch { /* best effort */ }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('[SIGTERM — releasing leadership and shutting down]');
  await releaseLeadership();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await releaseLeadership();
  process.exit(0);
});

async function start() {
  log('');
  log('╔══════════════════════════════════╗');
  log('║     THE HUNTER — v1.0.0          ║');
  log('║     BareTradeSignals Engine      ║');
  log('╚══════════════════════════════════╝');
  log('');
  log(`Mode: ${ENV.HUNTER_LIVE ? '🔴 LIVE' : '🟡 BLUEJAM TEST'}`);
  log(`Cycle interval: BEAR=${CONFIG.CYCLE_MS_BEAR/1000}s NEUTRAL=${CONFIG.CYCLE_MS_NEUTRAL/1000}s BULL=${CONFIG.CYCLE_MS_BULL/1000}s`);
  log(`Universe: ${CORE_CRYPTO.length} crypto + ${CORE_US_STOCKS.length} US + ${CORE_LSE_STOCKS.length} LSE`);
  log('');

  log('ENV CHECK:');
  log(`  BOT_TOKEN        : ${ENV.BOT_TOKEN        ? '✅' : '❌ missing'}`);
  log(`  BLUEJAM_CHAT_ID  : ${ENV.BLUEJAM_CHAT_ID  ? '✅' : '❌ (tried BLUEJAM_CHAT_ID + CHAT_ID)'}`);
  log(`  CHANNEL_CHAT_ID  : ${ENV.CHANNEL_CHAT_ID  ? '✅' : '⚪ not set'}`);
  log(`  ALPACA_API_KEY   : ${ENV.ALPACA_API_KEY   ? '✅' : '❌ missing'}`);
  log(`  ALPACA_SECRET    : ${ENV.ALPACA_SECRET_KEY ? '✅' : '❌ missing'}`);
  log(`  ALPACA_BASE_URL  : ${ENV.ALPACA_BASE_URL || 'https://data.alpaca.markets (default)'}`);
  log(`  FINNHUB_API_KEY  : ${ENV.FINNHUB_API_KEY  ? '✅' : '⚪ not set'}`);
  log(`  COINGECKO_KEY    : ${ENV.COINGECKO_API_KEY ? '✅' : '⚪ not set (free tier used)'}`);
  log(`  SUPABASE_URL     : ${ENV.SUPABASE_URL     ? '✅' : '❌ missing'}`);
  log(`  SUPABASE_KEY     : ${ENV.SUPABASE_SERVICE_KEY ? '✅' : '❌ (tried SERVICE_ROLE_KEY + SERVICE_KEY + ANON_KEY)'}`);
  log(`  HUNTER_LIVE      : ${ENV.HUNTER_LIVE      ? '🔴 LIVE' : '🟡 bluejam only'}`);
  log('');

  if (!ENV.BOT_TOKEN) log('⚠️  WARNING: BOT_TOKEN not set — Telegram disabled');
  if (!supabase) {
    log('⚠️  WARNING: Supabase not configured — learning engine disabled');
    log('         Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Railway vars');
  }

  // ── RESTART COUNTER ─────────────────────────────────────────────────
  if (supabase) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const restartId = `restart_count_${today}`;
      const { data: existing } = await supabase
        .from('hunter_calibration')
        .select('candidate_count')
        .eq('id', restartId)
        .single();

      const newCount = (existing?.candidate_count || 0) + 1;
      await supabase.from('hunter_calibration').upsert({
        id: restartId,
        recorded_at: new Date().toISOString(),
        top_score: 0, top_symbol: 'RESTART_COUNTER', field_avg: 0,
        candidate_count: newCount, btc_regime: 'N/A', qqq_regime: 'N/A',
        market_open_count: 0, buy_count: 0, watch_count: 0,
      });
      log(`🔄 RESTART COUNT today: ${newCount} (this boot: Instance=${INSTANCE_ID})`);
    } catch (err) {
      log(`⚠️  Restart counter error (non-fatal): ${err.message}`);
    }
  }

  // ── DATA HEALTH CHECK ───────────────────────────────────────────────
  log('🔬 Running data health check...');
  let healthPassed = 0;
  let startupRequestCount = 0;

  startupRequestCount++;
  try {
    const bybitTest = await fetchBybitCandles('BTCUSDT', '15', 10);
    if (bybitTest && bybitTest.length > 0) {
      log(`  Bybit        : ✅ (BTC last: $${round2(bybitTest[bybitTest.length-1].close)})`);
      healthPassed++;
    } else {
      log('  Bybit        : ❌ returned no data');
    }
  } catch (e) { log(`  Bybit        : ❌ ${e.message}`); }

  startupRequestCount++;
  try {
    const alpacaTest = await fetchAlpacaBars('QQQ', '15Min', 5);
    if (alpacaTest && alpacaTest.length > 0) {
      log(`  Alpaca       : ✅ (QQQ last: $${round2(alpacaTest[alpacaTest.length-1].close)})`);
      healthPassed++;
    } else {
      log('  Alpaca       : ❌ returned no data');
    }
  } catch (e) { log(`  Alpaca       : ❌ ${e.message}`); }

  startupRequestCount++;
  try {
    const yahooTest = await fetchYahooCandles('SPY', '15m');
    if (yahooTest && yahooTest.length > 0) {
      log(`  Yahoo        : ✅ (SPY last: $${round2(yahooTest[yahooTest.length-1].close)})`);
      healthPassed++;
    } else {
      log('  Yahoo        : ❌ returned no data');
    }
  } catch (e) { log(`  Yahoo        : ❌ ${e.message}`); }

  startupRequestCount++;
  try {
    const cgTest = await fetchCoinGeckoPrice('bitcoin');
    if (cgTest?.usd) {
      log(`  CoinGecko    : ✅ (BTC: $${round2(cgTest.usd)}, 24h: ${round2(cgTest.usd_24h_change)}%)`);
      healthPassed++;
    } else {
      log('  CoinGecko    : ❌ returned no data');
    }
  } catch (e) { log(`  CoinGecko    : ❌ ${e.message}`); }

  startupRequestCount++;
  try {
    const binanceTest = await fetchBinanceCandles('BTCUSDT', '15m', 5);
    if (binanceTest && binanceTest.length > 0) {
      log(`  Binance      : ✅ (accessible from this server)`);
    } else {
      log('  Binance      : ⚠️  no data (likely geo-blocked — Bybit handles crypto instead)');
    }
  } catch (e) { log(`  Binance      : ⚠️  ${e.message} (expected on Railway US IPs)`); }

  log(`🚀 Startup health check made ${startupRequestCount} outbound requests this boot (Instance=${INSTANCE_ID})`);
  log(`   If this instance has restarted N times today, that's ~${startupRequestCount} × N requests`);
  log(`   from health checks ALONE, before any scan cycle runs. Check Railway's`);
  log(`   deployment history for this service to see actual restart frequency.`);

  log(`Health check: ${healthPassed}/4 primary sources online`);
  if (healthPassed === 0) {
    log('🚨 CRITICAL: No data sources available. Check network settings.');
    log('   If Bybit=403 AND Binance=451 together: this is a Railway IP geo-block,');
    log('   not a code issue. Both exchanges block US-region IPs by default.');
    log('   Fix: Railway dashboard → this service → Settings → Region →');
    log('   switch to "EU West Metal" (Amsterdam). No downtime expected');
    log('   (this service has no attached volume). Binance in particular');
    log('   is very likely to start working from an EU IP — Bybit is less');
    log('   certain but worth testing. Re-run this health check after the');
    log('   region change to confirm.');
  }
  log('');

  await claimLeadership();
  log(`👑 Leader=${IS_LEADER} | Instance=${INSTANCE_ID}`);
  if (!IS_LEADER) {
    log('⛔ Starting in STANDBY mode — will promote if leader goes stale (90s timeout)');
  }

  if (IS_LEADER) {
    await mainCycle();
  }

  STATE.currentCycleMs = CONFIG.CYCLE_MS_BEAR;
  STATE._intervalHandle = setInterval(mainCycle, STATE.currentCycleMs);
}

// Boot
start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
