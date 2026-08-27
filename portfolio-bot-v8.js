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
    // ── Calibrated Aug 2026 ──────────────────────────────────
    // Top scores in current market: 65-72 range.
    // Previous thresholds (78/75) were never reachable — no signals fired.
    // New thresholds match actual market output while maintaining quality.
    hunterScoreElite:       80,   // was 88 — fire immediately, no confirmation needed
    hunterScoreGood:        68,   // was 78 — primary BUY threshold
    hunterScoreWatch:       62,   // was 75 — watchlist entry
    confidenceMinimum:      60,   // was 63
    convictionMinimum:      62,   // was 65
    executionHardFloor:     55,   // was 60
    edgeMinimumOverField:   6,    // was 8 — field avg is 57, top is 68, gap is ~11
    competitionGap:         5,
    competitionBonus:       8,
  },
  // Per-symbol cooldown (ms) + elite override
  SYMBOL_COOLDOWN_MS:     86_400_000, // 24h per symbol — one alert per day max
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
  ALERT_COOLDOWN_MS:    86_400_000,   // 24 hours between alerts
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

// ============================================================
// FIXED UNIVERSE — last updated August 2026
// Run hunter_universe_prompt.txt every 3-4 months in Perplexity
// and Gemini to refresh this list.
// ============================================================

const CORE_CRYPTO = [
  // Market cap anchors — always tracked
  'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT',

  // L1 / L2 Infrastructure
  'AVAXUSDT','ADAUSDT','DOTUSDT','ARBUSDT','OPUSDT',
  'SUIUSDT','SEIUSDT','NEARUSDT','APTUSDT','INJUSDT',

  // AI & DePIN
  'TAOUSDT','FETUSDT','RENDERUSDT','ICPUSDT',

  // DeFi blue chips
  'LINKUSDT','AAVEUSDT','UNIUSDT','PENDLEUSDT','ONDOUSDT',
  'LDOUSDT',
  // Note: MKRUSDT removed — delisted from Bybit perpetuals, CoinGecko only

  // High-momentum narratives
  'HYPEUSDT','JUPUSDT','ENAUSDT','VIRTUALUSDT','KASUSDT',

  // Cycle Planner core
  'TIAUSDT','IMXUSDT',
];

const CORE_US_STOCKS = [
  // AI Semiconductors — the engine room
  'NVDA','AMD','AVGO','TSM','ASML','AMAT','LRCX','MRVL','MU','QCOM','ARM',

  // AI Infrastructure & Networking
  'ANET','VRT','SMCI','CRWV',

  // AI Software & Platforms
  'PLTR','APP','DUOL','MSFT','GOOGL','META','AMZN','ORCL','NOW','CRM','SNOW','DDOG',

  // Cybersecurity
  'CRWD','PANW','NET',

  // Defence & Aerospace
  'RTX','LMT','NOC','LHX','GD','HII','GE','HWM','KTOS','RKLB','ASTS',

  // Energy — power infrastructure
  'XOM','CVX','COP','SLB','OXY','VST','CEG','GEV','OKLO','ETN','PWR',

  // Healthcare & Biotech
  'LLY','NVO','UNH','ISRG','TMO','ABBV','MRK','REGN',

  // Financials
  'JPM','GS','MS','BLK','KKR','APO','COIN','HOOD',

  // Consumer & Growth
  'UBER','HIMS','SHOP','MELI','NFLX','RDDT',

  // Industrials
  'URI','TT',
];

const CORE_LSE_STOCKS = [
  // Defence — structural growth
  'BA.L','RR.L',

  // Mining & Materials — commodity cycle
  'RIO.L','GLEN.L','AAL.L','ANTO.L','FRES.L',

  // Energy
  'SHEL.L','BP.L',

  // Financials
  'HSBC.L','BARC.L','LLOY.L','NWG.L','STAN.L','LSEG.L',

  // Healthcare & Pharma
  'AZN.L','GSK.L',

  // Industrial & Growth
  'REL.L','WEIR.L','DGE.L','ULVR.L',
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
  FMP_API_KEY:            process.env.FMP_API_KEY || process.env.FMP_KEY,
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

// Price-aware rounding for stop/entry/TP levels.
// round2() collapses stop=entry on low-price assets (e.g. $0.03 tokens)
// because 2 decimal places can't represent the ATR-sized difference.
// This uses enough precision to keep stop strictly below entry.
function roundPrice(v) {
  if (!Number.isFinite(v)) return v;
  if (v >= 1000) return Math.round(v * 100) / 100;   // 2dp: $59,851.12
  if (v >= 100)  return Math.round(v * 100) / 100;   // 2dp: $148.20
  if (v >= 10)   return Math.round(v * 1000) / 1000; // 3dp: $12.345
  if (v >= 1)    return Math.round(v * 10000) / 10000; // 4dp: $1.2345
  return Math.round(v * 100000) / 100000;             // 5dp: $0.03456
}

// ============================================================
// SECTION 6: DATA FETCHERS — CRYPTO (Bybit primary, Binance fallback)
// NOTE: Railway IPs are US-based; Binance blocks US ranges.
//       Bybit has no geo-restrictions — it is the primary source.
// ============================================================

// Symbols delisted from Bybit perpetuals — skip directly to CoinGecko/Binance
const BYBIT_EXCLUDED = new Set(['MKRUSDT','MATICUSDT','LUNAUSDT']);

async function fetchBybitCandles(symbol, interval = '15', limit = 100) {
  if (BYBIT_EXCLUDED.has(symbol)) return null; // skip to fallback
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
  // Market cap anchors
  'BTCUSDT':     'bitcoin',
  'ETHUSDT':     'ethereum',
  'SOLUSDT':     'solana',
  'BNBUSDT':     'binancecoin',
  'XRPUSDT':     'ripple',
  // L1 / L2
  'ADAUSDT':     'cardano',
  'AVAXUSDT':    'avalanche-2',
  'DOTUSDT':     'polkadot',
  'ARBUSDT':     'arbitrum',
  'OPUSDT':      'optimism',
  'SUIUSDT':     'sui',
  'SEIUSDT':     'sei-network',
  'NEARUSDT':    'near',
  'APTUSDT':     'aptos',
  'INJUSDT':     'injective-protocol',
  // AI & DePIN
  'TAOUSDT':     'bittensor',
  'FETUSDT':     'fetch-ai',
  'RENDERUSDT':  'render-token',
  'ICPUSDT':     'internet-computer',
  // DeFi
  'LINKUSDT':    'chainlink',
  'AAVEUSDT':    'aave',
  'UNIUSDT':     'uniswap',
  'PENDLEUSDT':  'pendle',
  'ONDOUSDT':    'ondo-finance',
  'LDOUSDT':     'lido-dao',
  'MKRUSDT':     'maker',
  // High momentum
  'HYPEUSDT':    'hyperliquid',
  'JUPUSDT':     'jupiter-exchange-solana',
  'ENAUSDT':     'ethena',
  'VIRTUALUSDT': 'virtual-protocol',
  'KASUSDT':     'kaspa',
  // Cycle Planner
  'TIAUSDT':     'celestia',
  'IMXUSDT':     'immutable-x',
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
  // Yahoo Finance sometimes silently returns data for a different symbol
  // when the LSE ticker isn't found (e.g. BA.L falling back to BA/Boeing).
  // Validate the response actually matches the requested symbol.
  try {
    const range = '5d';
    const url   = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=15m&range=${range}`;
    const data  = await httpGet(url);
    const result = data?.chart?.result?.[0];
    if (!result) {
      recordProviderFailure('Yahoo', new Error(`${symbol}: no result`));
      return null;
    }

    // Validate Yahoo returned the correct symbol
    const returnedSymbol = result.meta?.symbol || '';
    if (returnedSymbol && returnedSymbol.toUpperCase() !== symbol.toUpperCase()) {
      log(`⚠️  LSE symbol mismatch: requested ${symbol}, Yahoo returned ${returnedSymbol} — skipping`);
      recordProviderFailure('Yahoo', new Error(`${symbol}: returned ${returnedSymbol} instead`));
      return null;
    }

    // Also validate it's actually an LSE symbol (should contain . or be GBP quoted)
    const currency = result.meta?.currency || '';
    if (currency && !['GBp','GBP','GBX','p'].includes(currency)) {
      log(`⚠️  LSE currency mismatch: ${symbol} returned currency ${currency} — likely wrong symbol`);
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

// ── Finnhub: company news (last 7 days) ─────────────────────────
async function fetchFinnhubNews(symbol) {
  if (!ENV.FINNHUB_API_KEY) return [];
  try {
    const to   = new Date().toISOString().slice(0,10);
    const from = new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
    const url  = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${ENV.FINNHUB_API_KEY}`;
    const res  = await httpGet(url);
    const data = JSON.parse(res);
    if (!Array.isArray(data)) return [];
    return data.slice(0,3).map(n => ({
      headline: n.headline,
      source:   n.source,
      date:     new Date(n.datetime * 1000).toISOString().slice(0,10),
    }));
  } catch (err) {
    log(`⚠️  Finnhub news ${symbol}: ${err.message}`);
    return [];
  }
}

// ── Finnhub: recent earnings ─────────────────────────────────────
async function fetchFinnhubEarnings(symbol) {
  if (!ENV.FINNHUB_API_KEY) return null;
  try {
    const url  = `https://finnhub.io/api/v1/stock/earnings?symbol=${symbol}&token=${ENV.FINNHUB_API_KEY}`;
    const res  = await httpGet(url);
    const data = JSON.parse(res);
    if (!Array.isArray(data) || !data.length) return null;
    const sorted = [...data].sort((a,b) => new Date(b.period) - new Date(a.period));
    const latest = sorted[0];
    const daysAgo = Math.round((Date.now() - new Date(latest.period).getTime()) / 86400000);
    return {
      date:       latest.period,
      daysAgo,
      surprise:   latest.surprisePercent != null ? round2(latest.surprisePercent) : null,
      epsActual:  latest.actual  || null,
      epsEstimate:latest.estimate || null,
    };
  } catch (err) {
    log(`⚠️  Finnhub earnings ${symbol}: ${err.message}`);
    return null;
  }
}

// ── Finnhub: live quote ──────────────────────────────────────────
async function fetchFinnhubQuote(symbol) {
  if (!ENV.FINNHUB_API_KEY) return null;
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${ENV.FINNHUB_API_KEY}`;
    const res = await httpGet(url);
    const d   = JSON.parse(res);
    if (!d || !d.c) return null;
    return {
      price:     d.c,
      changePct: round2(d.dp),
      prevClose: d.pc,
    };
  } catch (err) {
    log(`⚠️  Finnhub quote ${symbol}: ${err.message}`);
    return null;
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

  // ── SAME-DAY REALITY CHECK ────────────────────────────────
  // If today's candle is down significantly, the score must
  // reflect it — regardless of the 5-day window.
  // This is why a stock down 8% today cannot score well.
  const lastCandle   = candles[candles.length - 1];
  const todayChange  = lastCandle
    ? ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100
    : 0;
  const HARSH_DROP   = -5;  // -5% or worse today = hard penalty
  const MODERATE_DROP = -2; // -2% to -5% today = moderate penalty

  if (todayChange <= HARSH_DROP) {
    // Hard cap — a stock down 5%+ today cannot show as improving
    score_parts.push(10);
    reasons.push(`Down ${round2(todayChange)}% today — momentum overridden`);
    // Skip remaining momentum checks — result already decided
    const avg = score_parts.reduce((a, b) => a + b, 0) / score_parts.length;
    return { score: round2(avg), reasons };
  }

  const roc5 = ((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100;
  if (roc5 >= 3) { score_parts.push(90); reasons.push(`Strong momentum +${round2(roc5)}%`); }
  else if (roc5 >= 1.5) { score_parts.push(70); reasons.push(`Positive momentum +${round2(roc5)}%`); }
  else if (roc5 >= 0) { score_parts.push(50); }
  else { score_parts.push(20); reasons.push(`Negative momentum ${round2(roc5)}%`); }

  // Moderate drop today — apply a penalty but don't override completely
  if (todayChange <= MODERATE_DROP) {
    score_parts.push(15);
    reasons.push(`Down ${round2(todayChange)}% today — momentum dampened`);
  }

  const roc5prev = closes.length >= 11
    ? ((closes[closes.length - 6] - closes[closes.length - 11]) / closes[closes.length - 11]) * 100
    : roc5;
  if (roc5 > roc5prev + 0.5) { score_parts.push(80); reasons.push('Momentum accelerating'); }
  else if (roc5 > roc5prev) { score_parts.push(60); }
  else { score_parts.push(40); reasons.push('Momentum decelerating'); }

  // RSI — original logic restored (divergence reverted 2026-07-05)
  // Divergence filter removed: insufficient outcome data to validate.
  // Will revisit once hunter_alerts has 30+ resolved observations.
  const rsiLast = rsi[rsi.length - 1];
  if (rsiLast >= 55 && rsiLast <= 75) { score_parts.push(80); reasons.push(`RSI ${round2(rsiLast)} — bullish zone`); }
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
      entryPrice     = roundPrice(Math.min(last, (e20 + vwapLast) / 2));
      chaseLimit     = round2(entryPrice * 1.0025);
      cancelCondition = `Cancel if price closes above $${round2(last * 1.015)} before entry, or setup not triggered within 4 hours`;
      executionPlan   = `Entry zone: $${entryPrice}. Do not chase above $${chaseLimit} (0.25% max). Cancel if price closes above $${round2(last * 1.015)} before entry. Setup expires end of session if not triggered.`;
      executionScore  = 88;
      break;
    }

    case SETUP_TYPES.BREAKOUT_CONTINUATION: {
      orderType      = ORDER_TYPES.STOP;
      entryPrice     = roundPrice(nearestResistance * 1.001);
      entryZoneLow   = round2(nearestResistance);
      entryZoneHigh  = round2(nearestResistance * 1.005);
      chaseLimit     = round2(entryPrice * 1.003);
      cancelCondition = `Do not enter if breakout candle closes back below $${round2(nearestResistance)}. Cancel if not triggered within 2 hours.`;
      executionPlan   = `Entry zone: $${entryPrice} (just above resistance $${round2(nearestResistance)}). Only fills if level actually breaks. Cancel immediately if price closes back below resistance. Do not anticipate — wait for confirmation.`;
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
      executionPlan   = `Entry zone: $${entryPrice}. Cancel if not filled within 2 hours.`;
      executionScore  = 60;
    }
  }

  const entryRef   = entryPrice || execution.entry;
  const atrForStop = atr[atr.length - 1];
  const SL_ATR_MULT  = 1.8;
  const TP1_ATR_MULT = 3.0;
  const TP2_ATR_MULT = 6.0;
  const stopFromEntry = roundPrice(entryRef - atrForStop * SL_ATR_MULT);
  const t1FromEntry   = roundPrice(entryRef + atrForStop * TP1_ATR_MULT);
  const t2FromEntry   = roundPrice(entryRef + atrForStop * TP2_ATR_MULT);
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
    allScores.executionQuality >= 55 &&  // lowered from 65 — weekend data is thinner
    allScores.structure >= 50 &&         // lowered from 55
    allScores.risk >= 50 &&
    stability >= 45                      // lowered from 60 — Bybit failures reduce stability unfairly
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

  // ── FIXED UNIVERSE ────────────────────────────────────────
  // Hunter uses curated fixed lists only. Deep score history
  // on known assets beats dynamic discovery of unknown ones.
  // Lists reviewed every 3-4 months via hunter_universe_prompt.
  const cryptoSymbols = CORE_CRYPTO;
  const usSymbols     = usOpen  ? CORE_US_STOCKS  : [];
  const lseSymbols    = lseOpen ? CORE_LSE_STOCKS : [];

  if (!usOpen)  log(`⏸️  US market closed — skipping US assets`);
  if (!lseOpen) log(`⏸️  LSE market closed — skipping LSE assets`);
  log(`🔍 Universe: ${cryptoSymbols.length} crypto / ${usSymbols.length} US / ${lseSymbols.length} LSE`);

  const universe = [
    ...cryptoSymbols.map(s => ({ symbol: s, type: 'crypto' })),
    ...usSymbols.map(s     => ({ symbol: s, type: 'us' })),
    ...lseSymbols.map(s    => ({ symbol: s, type: 'lse' })),
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

      if (adjustedScore >= CONFIG.THRESHOLDS.hunterScoreElite) decision = 'OPEN';
      else if (adjustedScore >= CONFIG.THRESHOLDS.hunterScoreGood) decision = 'OPEN';
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

  const buys   = finalCandidates.filter((c) => c.decision === 'OPEN');
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

  log(`Scan complete: ${totalAssets} analysed, ${buys.length} OPEN signals, ${watches.length} WATCH`);

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

      // ── REAL-TIME MOVE ALERT ────────────────────────────────
      // Fire immediately when score 65+ preceded a positive move.
      // One alert per symbol per day. Positive moves only.
      // This replaces the Friday scan — catches moves as they happen.
      if (prior.score >= 65 && movePct > 0 && ENV.BLUEJAM_CHAT_ID) {
        const alertKey = `move_alert_${symbol}_${new Date().toISOString().slice(0,10)}`;
        let alreadySent = false;
        if (supabase) {
          try {
            const { data: existing } = await supabase
              .from('hunter_calibration')
              .select('id')
              .eq('id', alertKey)
              .single();
            alreadySent = !!existing;
          } catch { /* not found = not sent */ }
        }

        if (!alreadySent) {
          const assetType  = symbol.endsWith('USDT') ? 'crypto' : symbol.endsWith('.L') ? 'lse' : 'us';
          const flag       = assetType === 'crypto' ? '🪙' : assetType === 'lse' ? '🇬🇧' : '🇺🇸';
          const label      = symbol.replace('USDT','').replace('.L','');
          const moveEmoji  = absMove >= 8 ? '🚀' : absMove >= 5 ? '📈' : '⬆️';
          const sector     = SECTOR_MAP[symbol];
          const sectorLine = sector ? `Sector: ${sector.replace(/_/g,' ')}` : '';
          const regimeLine = STATE.btcRegime === 'BULL' ? '✅ BTC BULL — conditions favour this move' : `🟡 BTC ${STATE.btcRegime}`;

          const msg = [
            `${moveEmoji} POTENTIAL OPEN — ${flag} ${label}`,
            ``,
            `Hunter scored ${round2(prior.score)} before this move.`,
            `Move: +${round2(movePct)}% (${absMove >= 8 ? 'major' : absMove >= 5 ? 'significant' : 'notable'})`,
            ``,
            `From $${prior.price} → $${round2(currentPrice)}`,
            regimeLine,
            sectorLine,
            ``,
            `Score 65+ before a move is the pattern Hunter tracks.`,
            `——————————`,
            `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
            `📸 @baretradesignals 🏹`,
          ].filter(Boolean).join('\n');

          await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
          log(`📲 Open alert sent: ${symbol} +${round2(movePct)}% (score was ${round2(prior.score)})`);

          // Mark as sent
          if (supabase) {
            try {
              await supabase.from('hunter_calibration').upsert({
                id: alertKey,
                recorded_at: new Date().toISOString(),
                top_score: round2(prior.score),
                top_symbol: symbol,
                field_avg: 0, candidate_count: 0,
                btc_regime: STATE.btcRegime,
                qqq_regime: STATE.qqqRegime,
                market_open_count: 0, buy_count: 0, watch_count: 0,
              });
            } catch { /* best effort */ }
          }
        }
      }
      // ──────────────────────────────────────────────────────

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

  // ── MINIMUM DISTANCE FLOORS ──────────────────────────────────
  // If geometry is too tight to be tradeable, suppress the alert.
  // Do not send bad levels — send nothing.
  const MIN_DIST = {
    crypto: { sl: 2.5, tp1: 2.5, tp2: 5.0, rr: 2.0 },
    us:     { sl: 1.5, tp1: 3.0, tp2: 6.0, rr: 2.0 },
    lse:    { sl: 2.0, tp1: 3.0, tp2: 6.0, rr: 2.0 },
  };
  const floors = MIN_DIST[assetType] || MIN_DIST.crypto;
  const slPctAbs  = Math.abs(slPct);
  const tp1PctAbs = Math.abs(tp1Pct);
  const tp2PctAbs = Math.abs(tp2Pct);

  if (slPctAbs  < floors.sl) {
    log(`🚫 ALERT SUPPRESSED: ${symbol} SL distance ${slPctAbs}% < minimum ${floors.sl}%`);
    return null;
  }
  if (tp1PctAbs < floors.tp1) {
    log(`🚫 ALERT SUPPRESSED: ${symbol} TP1 distance ${tp1PctAbs}% < minimum ${floors.tp1}%`);
    return null;
  }
  if (tp2PctAbs < floors.tp2) {
    log(`🚫 ALERT SUPPRESSED: ${symbol} TP2 distance ${tp2PctAbs}% < minimum ${floors.tp2}%`);
    return null;
  }
  if (rr < floors.rr) {
    log(`🚫 ALERT SUPPRESSED: ${symbol} R:R ${rr} < minimum ${floors.rr}`);
    return null;
  }
  // ─────────────────────────────────────────────────────────────

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

  // Clean BUY alert — what to do, why, and where to exit
  const label       = symbol.replace('USDT', '');
  const sector      = SECTOR_MAP[symbol] || null;
  const sectorLine  = sector ? `Sector: ${sector.replace('_',' ')}` : '';
  const regimeLine  = (STATE.btcRegime === 'BULL' && (STATE.qqqRegime === 'BULL' || symbol.endsWith('USDT')))
    ? `✅ Market conditions: BULLISH`
    : `🟡 Market conditions: MIXED — keep position small`;
  const volLine     = relVol >= 2.0 ? `Volume: ${relVol}× above normal — strong institutional flow`
                    : relVol >= 1.5 ? `Volume: ${relVol}× above normal — above average interest`
                    : `Volume: normal — momentum-driven, not volume-driven`;

  const lines = [
    `🟢 OPEN — ${flag} ${label}`,
    ``,
    `Entry:  $${entry}`,
    `Stop:   $${stop}  (${Math.abs(slPct)}% risk)`,
    `Target: $${tp2}  (+${tp2Pct}%)`,
    `R:R:    ${rr}`,
    ``,
    volLine,
    regimeLine,
    sectorLine,
    ``,
    `Hunter score: ${round2(finalScore)}`,
    ``,
    `——————————`,
    `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
    `📸 @baretradesignals 🏹`,
  ].filter(Boolean);

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
    `Needs improvement in ${drags.slice(0,2).map(d=>d.name).join(' + ')} to reach OPEN threshold.`,
    ``,
    `💰 If it triggers: Entry ${formatPrice(entry, assetType)}  🛡️ Stop ${formatPrice(stop, assetType)}  🎯 T1 ${formatPrice(t1, assetType)}  ⚖️ R:R ${rr}:1`,
    ``,
    `——————————`,
    `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
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
    `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
    ``,
    `📸 Analysis by @baretradesignals 🏹`,
  );

  return lines.join('\n');
}

// ============================================================
// DAILY LEADERBOARD — one message per market per day
// Crypto: 08:00 UTC  |  LSE: 16:30 UTC  |  US: 21:00 UTC
// Shows today's top 5 + week-to-date rankings
// ============================================================


// ============================================================
// COMBINED DAILY BRIEF
// Fires twice daily — 08:00 UTC (morning) and 21:30 UTC (evening)
// One message, all three markets combined.
// Weekends: crypto only, stocks show last known position greyed out.
// ============================================================

async function fireCombinedBrief(session) {
  if (!supabase) return;
  const isWeekend  = [0, 6].includes(new Date().getUTCDay());
  const dateStr    = new Date().toISOString().slice(0, 10);
  const sessionLabel = session === 'morning' ? '🌅 MORNING' : '🌆 EVENING';
  const regimeStr  = `BTC ${STATE.btcRegime === 'BULL' ? '🟢' : STATE.btcRegime === 'BEAR' ? '🔴' : '🟡'} · QQQ ${STATE.qqqRegimeStale ? '⚪ CLOSED' : STATE.qqqRegime === 'BULL' ? '🟢' : STATE.qqqRegime === 'BEAR' ? '🔴' : '🟡'}`;

  // Load last 48h of leaderboard data — enough for trends
  const since = new Date(Date.now() - 48 * 3600000).toISOString();
  const { data, error } = await supabase
    .from('hunter_leaderboard_history')
    .select('symbol, asset_type, score, rank, snapshot_id, snapshot_time')
    .gte('snapshot_time', since)
    .order('snapshot_time', { ascending: true });

  if (error || !data?.length) {
    log('BRIEF: no leaderboard data');
    return;
  }

  // Build per-symbol avg score and trend
  const symbolMap = new Map();
  for (const row of data) {
    if (!symbolMap.has(row.symbol)) {
      symbolMap.set(row.symbol, {
        symbol:    row.symbol,
        assetType: row.asset_type,
        scores:    [],
        ranks:     [],
      });
    }
    const d = symbolMap.get(row.symbol);
    d.scores.push(parseFloat(row.score));
    d.ranks.push(row.rank);
  }

  function avgScore(d) {
    return round2(d.scores.reduce((a,b)=>a+b,0)/d.scores.length);
  }
  function trend(d) {
    if (d.scores.length < 4) return '→';
    const first = d.scores.slice(0, Math.floor(d.scores.length/2));
    const last  = d.scores.slice(Math.floor(d.scores.length/2));
    const firstAvg = first.reduce((a,b)=>a+b,0)/first.length;
    const lastAvg  = last.reduce((a,b)=>a+b,0)/last.length;
    const delta = lastAvg - firstAvg;
    if (delta >= 3)  return '⏫';
    if (delta >= 1)  return '🔼';
    if (delta <= -3) return '⏬';
    if (delta <= -1) return '🔽';
    return '→';
  }
  function sniperTag(symbol) {
    const r = getSniperRegime(symbol);
    if (!r) return '';
    if (r.regime === 'TRENDING') return ' ⚡';
    if (r.regime === 'ROTATING') return ' 🔄';
    if (r.regime === 'DEAD_CAT') return ' ☠️';
    return '';
  }
  const flagFor = t => t === 'crypto' ? '🪙' : t === 'lse' ? '🇬🇧' : '🇺🇸';

  // Rank all assets by avg score
  const all = [...symbolMap.values()].filter(d => d.scores.length >= 2);
  all.sort((a,b) => avgScore(b) - avgScore(a));

  // Top 5 per class
  const cryptoTop = all.filter(d => d.assetType === 'crypto').slice(0,5);
  const usTop     = all.filter(d => d.assetType === 'us').slice(0,5);
  const lseTop    = all.filter(d => d.assetType === 'lse').slice(0,5);

  const lines = [
    `🏹 BARETRADESIGNALS — ${sessionLabel} ${dateStr}`,
    `${regimeStr}`,
    ``,
  ];

  // Crypto — always shown
  if (cryptoTop.length) {
    lines.push(`🪙 CRYPTO`);
    cryptoTop.forEach((d,i) => {
      const label = d.symbol.replace('USDT','').padEnd(7);
      const score = `[${avgScore(d)}]`;
      const t     = trend(d);
      const st    = sniperTag(d.symbol);
      lines.push(`${i+1}. ${label} ${score} ${t}${st}`);
    });
    lines.push('');
  }

  // US — show with "market closed" note on weekends
  if (usTop.length) {
    const closedNote = isWeekend ? ' (market closed)' : '';
    lines.push(`🇺🇸 US STOCKS${closedNote}`);
    usTop.forEach((d,i) => {
      const label = d.symbol.padEnd(7);
      const score = `[${avgScore(d)}]`;
      const t     = isWeekend ? '—' : trend(d);
      lines.push(`${i+1}. ${label} ${score} ${t}`);
    });
    lines.push('');
  }

  // LSE — show with "market closed" note on weekends
  if (lseTop.length) {
    const closedNote = isWeekend ? ' (market closed)' : '';
    lines.push(`🇬🇧 LSE${closedNote}`);
    lseTop.forEach((d,i) => {
      const label = d.symbol.replace('.L','').padEnd(7);
      const score = `[${avgScore(d)}]`;
      const t     = isWeekend ? '—' : trend(d);
      lines.push(`${i+1}. ${label} ${score} ${t}`);
    });
    lines.push('');
  }

  lines.push(`——————————`);
  lines.push(`⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`);
  lines.push(`📸 @baretradesignals 🏹`);

  const msg = lines.join('\n');
  if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
  log(`📊 Combined ${session} brief sent`);
}

// fireDailyLeaderboard kept for backwards compatibility with any internal calls
async function fireDailyLeaderboard(market) {
  // Redirects to combined brief — market param ignored
  await fireCombinedBrief('morning');
}





// ============================================================

// ============================================================

// ============================================================
// SECTION 27: DYNAMIC UNIVERSE ENGINE
// Replaces fixed CORE_CRYPTO / CORE_US_STOCKS / CORE_LSE_STOCKS.
//
// Sources (all free tier):
//   Crypto  → CoinGecko /coins/markets (top gainers + volume)
//             Bybit /v5/market/tickers (24h gainers, no auth)
//   US      → FMP /gainers + /actives (FMP_API_KEY in Railway)
//             Alpaca /v2/screener/stocks (already have key)
//   LSE     → Yahoo Finance screener (.L suffix)
//             FMP /gainers filtered to LSE
//
// Flow (every UNIVERSE_REFRESH_CYCLES scan cycles):
//   1. Fetch top movers from each source
//   2. Quality filter (price, volume, liquidity floors)
//   3. Deduplicate across sources
//   4. Write top 20 per class to hunter_dynamic_universe (Supabase)
//   5. runFullScan() reads from this table instead of hardcoded arrays
//
// Fallback: if fetch fails, use previous snapshot from Supabase.
// ============================================================

const DYN = {
  // How often to refresh the universe (every N scan cycles)
  UNIVERSE_REFRESH_CYCLES:   4,

  // How many assets to keep per class after scoring
  TOP_N_CRYPTO:             25,
  TOP_N_US:                 25,
  TOP_N_LSE:                20,

  // Crypto quality floors
  CRYPTO_MIN_MARKET_CAP_M: 200,    // $200M minimum market cap — filters micro/meme coins
  CRYPTO_MIN_VOL_24H_M:     20,    // $20M minimum 24h volume
  CRYPTO_MIN_PRICE:       0.001,   // filter dust/dead coins

  // US stock quality floors
  US_MIN_PRICE:             10,    // $10 minimum
  US_MIN_VOL_1M:           200_000, // 200k shares avg daily volume
  US_MAX_CHANGE_PCT:        50,    // filter obvious pump-and-dumps (>50% in a day)
  US_MIN_CHANGE_PCT:        -15,   // don't scan stuff in freefall

  // LSE quality floors
  LSE_MIN_PRICE_GBP:         1,    // 1p minimum (GBX)
  LSE_MIN_VOL:             50_000,

  // Stale protection — if universe not refreshed in N hours, fall back to prior
  MAX_STALE_HOURS:            6,
};

// In-memory cache so we don't re-fetch every cycle
let _dynamicUniverse = {
  crypto: [],
  us:     [],
  lse:    [],
  fetchedAt: 0,
};

// ── CRYPTO UNIVERSE FETCHER ───────────────────────────────────

async function fetchDynamicCrypto() {
  const results = new Map(); // symbol (XYZUSDT) → { symbol, source, vol24hUSD, marketCapM, change24h }

  // Source 1: Bybit top tickers (public, no auth, covers all listed perpetuals)
  try {
    const url  = 'https://api.bybit.com/v5/market/tickers?category=linear';
    const data = await httpGet(url);
    const list = data?.result?.list || [];

    for (const t of list) {
      const sym = t.symbol;
      if (!sym.endsWith('USDT')) continue;
      const vol24h    = parseFloat(t.turnover24h || 0);     // USD volume
      const change24h = parseFloat(t.price24hPcnt || 0) * 100;
      const price     = parseFloat(t.lastPrice    || 0);

      if (price     < DYN.CRYPTO_MIN_PRICE)      continue;
      if (vol24h    < DYN.CRYPTO_MIN_VOL_24H_M * 1e6) continue;
      if (!isFinite(change24h))                  continue;

      results.set(sym, {
        symbol:    sym,
        source:    'bybit',
        vol24hUSD: vol24h,
        change24h: round2(change24h),
        price,
      });
    }
    log(`DYN: Bybit returned ${results.size} crypto candidates`);
  } catch (err) {
    log(`DYN: Bybit fetch error: ${err.message}`);
  }

  // Source 2: CoinGecko top by volume + 24h change (supplements with market cap data)
  try {
    const key     = ENV.COINGECKO_API_KEY ? `&x_cg_demo_api_key=${ENV.COINGECKO_API_KEY}` : '';
    const url     = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1&price_change_percentage=24h${key}`;
    const coins   = await httpGet(url);

    if (Array.isArray(coins)) {
      for (const c of coins) {
        const sym = `${c.symbol?.toUpperCase()}USDT`;
        if (!sym || sym.length > 20) continue;

        const marketCapM = (c.market_cap || 0) / 1e6;
        const vol24hUSD  = c.total_volume || 0;
        const change24h  = c.price_change_percentage_24h || 0;
        const price      = c.current_price || 0;

        if (marketCapM < DYN.CRYPTO_MIN_MARKET_CAP_M) continue;
        if (vol24hUSD  < DYN.CRYPTO_MIN_VOL_24H_M * 1e6) continue;
        if (price      < DYN.CRYPTO_MIN_PRICE)      continue;

        // Enrich existing entry or add new
        if (results.has(sym)) {
          results.get(sym).marketCapM = round2(marketCapM);
        } else {
          results.set(sym, {
            symbol: sym, source: 'coingecko',
            vol24hUSD, marketCapM: round2(marketCapM),
            change24h: round2(change24h), price,
          });
        }
      }
      log(`DYN: CoinGecko enriched, total crypto candidates: ${results.size}`);
    }
  } catch (err) {
    log(`DYN: CoinGecko fetch error: ${err.message}`);
  }

  // Always include BTC and ETH regardless of filters (regime anchors)
  for (const anchor of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    if (!results.has(anchor)) {
      results.set(anchor, { symbol: anchor, source: 'anchor', vol24hUSD: 1e10, change24h: 0, price: 1 });
    }
  }

  // ── HARD EXCLUSIONS ─────────────────────────────────────────
  // Remove stablecoins, wrapped tokens, and obvious junk
  const STABLE_EXCLUDE = new Set([
    'USDCUSDT','USDTUSDT','BUSDUSDT','TUSDUSDT','DAIUSDT','FRAXUSDT',
    'USDPUSDT','FDUSDUSDT','PYUSDUSDT','EURCUSDT','GBPUSDT',
    'WBTCUSDT','WETHUSDT','STETHUSDT','CBETHUSDT','RETHUSDT',
  ]);

  // Only keep coins that CoinGecko has validated (have market cap data)
  // This filters out the Bybit micro-cap meme coins that have no CG entry
  const cgValidated = new Set(
    [...results.values()]
      .filter(c => c.marketCapM != null && c.marketCapM >= DYN.CRYPTO_MIN_MARKET_CAP_M)
      .map(c => c.symbol)
  );

  // Also keep BTC/ETH/SOL anchors regardless
  const ANCHORS = new Set(['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT']);

  const filtered = [...results.values()].filter(c => {
    if (STABLE_EXCLUDE.has(c.symbol)) return false;   // stablecoins out
    if (ANCHORS.has(c.symbol))        return true;    // anchors always in
    if (!cgValidated.has(c.symbol))   return false;   // must be CG validated
    if (c.vol24hUSD < DYN.CRYPTO_MIN_VOL_24H_M * 1e6) return false; // volume floor
    return true;
  });

  // Sort: blend volume rank + absolute 24h change (want both movers AND liquid names)
  const sorted = filtered.sort((a, b) => {
    const scoreA = (a.vol24hUSD / 1e8) + Math.abs(a.change24h) * 2;
    const scoreB = (b.vol24hUSD / 1e8) + Math.abs(b.change24h) * 2;
    return scoreB - scoreA;
  });

  log(`DYN: Crypto after quality filter: ${sorted.length} from ${results.size} candidates`);
  return sorted.slice(0, DYN.TOP_N_CRYPTO).map(c => c.symbol);
}

// ── US STOCK UNIVERSE FETCHER ─────────────────────────────────

async function fetchDynamicUS() {
  const results = new Map(); // symbol → { symbol, source, changesPct, volume, price }

  const FMP_KEY = process.env.FMP_API_KEY || process.env.FMP_KEY || '';

  // Source 1: FMP biggest gainers (free tier)
  if (FMP_KEY) {
    try {
      const url  = `https://financialmodelingprep.com/api/v3/stock_market/gainers?apikey=${FMP_KEY}`;
      const data = await httpGet(url);
      if (Array.isArray(data)) {
        for (const s of data) {
          const sym    = s.symbol;
          const price  = parseFloat(s.price || 0);
          const change = parseFloat(s.changesPercentage || 0);
          const vol    = parseInt(s.volume || 0, 10);

          if (!sym || sym.includes('.') || sym.length > 5) continue; // skip LSE/ETFs in this source
          if (price  < DYN.US_MIN_PRICE)          continue;
          if (vol    < DYN.US_MIN_VOL_1M)         continue;
          if (change > DYN.US_MAX_CHANGE_PCT)      continue; // likely pump
          if (change < DYN.US_MIN_CHANGE_PCT)      continue; // freefall

          results.set(sym, { symbol: sym, source: 'fmp_gainers', changesPct: round2(change), volume: vol, price });
        }
        log(`DYN: FMP gainers: ${results.size} US candidates`);
      }
    } catch (err) {
      log(`DYN: FMP gainers error: ${err.message}`);
    }

    // Source 2: FMP most active by volume (catches steady leaders that aren't big % movers)
    try {
      const url  = `https://financialmodelingprep.com/api/v3/stock_market/actives?apikey=${FMP_KEY}`;
      const data = await httpGet(url);
      if (Array.isArray(data)) {
        for (const s of data) {
          const sym   = s.symbol;
          const price = parseFloat(s.price || 0);
          const vol   = parseInt(s.volume || 0, 10);
          const change = parseFloat(s.changesPercentage || 0);

          if (!sym || sym.includes('.') || sym.length > 5) continue;
          if (price  < DYN.US_MIN_PRICE)  continue;
          if (vol    < DYN.US_MIN_VOL_1M) continue;

          if (!results.has(sym)) {
            results.set(sym, { symbol: sym, source: 'fmp_actives', changesPct: round2(change), volume: vol, price });
          }
        }
        log(`DYN: FMP actives added, total US candidates: ${results.size}`);
      }
    } catch (err) {
      log(`DYN: FMP actives error: ${err.message}`);
    }
  } else {
    log('DYN: No FMP_API_KEY — US stock discovery limited to Alpaca screener');
  }

  // Source 3: Alpaca most active (already have key, supplements FMP)
  try {
    const url  = `${ENV.ALPACA_BASE_URL}/v1beta1/screener/stocks/most-actives?by=volume&top=50`;
    const data = await httpGet(url, {
      'APCA-API-KEY-ID':     ENV.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': ENV.ALPACA_SECRET_KEY,
    });
    const most = data?.most_actives || data?.actives || [];
    for (const s of most) {
      const sym   = s.symbol;
      const price = parseFloat(s.close || s.price || 0);
      const vol   = parseInt(s.volume || 0, 10);
      if (!sym || sym.length > 5) continue;
      if (price < DYN.US_MIN_PRICE)  continue;
      if (vol   < DYN.US_MIN_VOL_1M) continue;
      if (!results.has(sym)) {
        results.set(sym, { symbol: sym, source: 'alpaca', changesPct: 0, volume: vol, price });
      }
    }
    log(`DYN: Alpaca actives added, total US candidates: ${results.size}`);
  } catch (err) {
    log(`DYN: Alpaca screener error: ${err.message}`);
  }

  // Exclude obvious non-stocks: ETFs, leveraged funds, warrants
  const ETF_PATTERNS = /^(SPY|QQQ|IWM|DIA|GLD|SLV|TLT|HYG|LQD|XL[A-Z]|ARK[A-Z]|TQQQ|SQQQ|UVXY|SVXY|SPXL|SPXS|SOXL|SOXS|LABU|LABD)/;
  const filtered = [...results.values()].filter(s => !ETF_PATTERNS.test(s.symbol));

  // Sort by volume (steady compounders show up consistently)
  const sorted = filtered.sort((a, b) => b.volume - a.volume);

  return sorted.slice(0, DYN.TOP_N_US).map(s => s.symbol);
}

// ── LSE UNIVERSE FETCHER ──────────────────────────────────────

async function fetchDynamicLSE() {
  const results = new Map();

  const FMP_KEY = process.env.FMP_API_KEY || process.env.FMP_KEY || '';

  // Source 1: FMP gainers filtered to LSE (.L suffix)
  if (FMP_KEY) {
    try {
      const url  = `https://financialmodelingprep.com/api/v3/stock_market/gainers?apikey=${FMP_KEY}`;
      const data = await httpGet(url);
      if (Array.isArray(data)) {
        for (const s of data) {
          const sym    = s.symbol;
          if (!sym?.endsWith('.L')) continue;
          const price  = parseFloat(s.price || 0);
          const change = parseFloat(s.changesPercentage || 0);
          const vol    = parseInt(s.volume || 0, 10);
          if (price < DYN.LSE_MIN_PRICE_GBP) continue;
          if (vol   < DYN.LSE_MIN_VOL)       continue;
          results.set(sym, { symbol: sym, source: 'fmp_lse', changesPct: round2(change), volume: vol, price });
        }
      }
      log(`DYN: FMP LSE gainers: ${results.size} candidates`);
    } catch (err) {
      log(`DYN: FMP LSE error: ${err.message}`);
    }
  }

  // Source 2: Yahoo Finance — FTSE 100 components via summary (no key needed)
  // Fetch a known list of high-liquidity LSE names as a reliable base
  const LSE_ANCHORS = [
    'SHEL.L','RIO.L','AZN.L','HSBC.L','BP.L','GLEN.L','AAL.L',
    'BARC.L','LLOY.L','NWG.L','STAN.L','GSK.L','REL.L','BA.L',
    'RR.L','HIK.L','ANTO.L','FRES.L','BAB.L',
  ];

  // Add anchors that aren't already captured from FMP
  for (const sym of LSE_ANCHORS) {
    if (!results.has(sym)) {
      results.set(sym, { symbol: sym, source: 'anchor', changesPct: 0, volume: 1e6, price: 100 });
    }
  }

  // Source 3: Yahoo Finance gainers for UK market
  try {
    const url  = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&scrIds=day_gainers&count=50&region=GB&lang=en-GB';
    const data = await httpGet(url, { 'User-Agent': 'Mozilla/5.0' });
    const quotes = data?.finance?.result?.[0]?.quotes || [];
    for (const q of quotes) {
      const sym = q.symbol;
      if (!sym?.endsWith('.L')) continue;
      const price  = parseFloat(q.regularMarketPrice || 0);
      const vol    = parseInt(q.regularMarketVolume || 0, 10);
      const change = parseFloat(q.regularMarketChangePercent || 0);
      if (price < DYN.LSE_MIN_PRICE_GBP) continue;
      if (vol   < DYN.LSE_MIN_VOL)       continue;
      if (!results.has(sym)) {
        results.set(sym, { symbol: sym, source: 'yahoo_lse', changesPct: round2(change), volume: vol, price });
      }
    }
    log(`DYN: Yahoo LSE added, total LSE candidates: ${results.size}`);
  } catch (err) {
    log(`DYN: Yahoo LSE error: ${err.message}`);
  }

  const sorted = [...results.values()].sort((a, b) => b.volume - a.volume);
  return sorted.slice(0, DYN.TOP_N_LSE).map(s => s.symbol);
}

// ── SUPABASE PERSISTENCE ──────────────────────────────────────

async function saveDynamicUniverse(crypto, us, lse) {
  if (!supabase) return;
  try {
    const now  = new Date().toISOString();
    const rows = [
      ...crypto.map((sym, i) => ({ symbol: sym, asset_type: 'crypto', rank: i + 1, fetched_at: now })),
      ...us.map((sym, i)     => ({ symbol: sym, asset_type: 'us',     rank: i + 1, fetched_at: now })),
      ...lse.map((sym, i)    => ({ symbol: sym, asset_type: 'lse',    rank: i + 1, fetched_at: now })),
    ];

    // Wipe and reinsert — small table, simplest approach
    await supabase.from('hunter_dynamic_universe').delete().neq('symbol', '___NEVER___');
    await supabase.from('hunter_dynamic_universe').insert(rows);
    log(`DYN: Saved ${crypto.length} crypto / ${us.length} US / ${lse.length} LSE to Supabase`);
  } catch (err) {
    log(`DYN: saveDynamicUniverse error: ${err.message}`);
  }
}

async function loadDynamicUniverseFromSupabase() {
  if (!supabase) return null;
  try {
    const staleThreshold = new Date(Date.now() - DYN.MAX_STALE_HOURS * 3600000).toISOString();
    const { data, error } = await supabase
      .from('hunter_dynamic_universe')
      .select('symbol, asset_type, rank, fetched_at')
      .gte('fetched_at', staleThreshold)
      .order('rank', { ascending: true });

    if (error || !data?.length) return null;

    const crypto = data.filter(r => r.asset_type === 'crypto').map(r => r.symbol);
    const us     = data.filter(r => r.asset_type === 'us').map(r => r.symbol);
    const lse    = data.filter(r => r.asset_type === 'lse').map(r => r.symbol);

    if (crypto.length === 0 && us.length === 0 && lse.length === 0) return null;
    return { crypto, us, lse };
  } catch (err) {
    log(`DYN: loadDynamicUniverse error: ${err.message}`);
    return null;
  }
}

// ── MAIN UNIVERSE REFRESH ─────────────────────────────────────
// Called from runFullScan() every UNIVERSE_REFRESH_CYCLES cycles.
// Returns { crypto, us, lse } arrays of symbols.

async function refreshDynamicUniverse() {
  log('🔄 Refreshing dynamic universe...');

  const [crypto, us, lse] = await Promise.all([
    fetchDynamicCrypto().catch(err => { log(`DYN: crypto fetch failed: ${err.message}`); return []; }),
    fetchDynamicUS().catch(err      => { log(`DYN: US fetch failed: ${err.message}`);     return []; }),
    fetchDynamicLSE().catch(err     => { log(`DYN: LSE fetch failed: ${err.message}`);    return []; }),
  ]);

  // If any class comes back empty, try loading from Supabase fallback
  const fallback = await loadDynamicUniverseFromSupabase();

  const final = {
    crypto: crypto.length >= 5  ? crypto : (fallback?.crypto || []),
    us:     us.length     >= 5  ? us     : (fallback?.us     || []),
    lse:    lse.length    >= 3  ? lse    : (fallback?.lse    || []),
  };

  // Update in-memory cache
  _dynamicUniverse = { ...final, fetchedAt: Date.now() };

  // Persist to Supabase
  await saveDynamicUniverse(final.crypto, final.us, final.lse);

  log(`🔄 Dynamic universe: ${final.crypto.length} crypto / ${final.us.length} US / ${final.lse.length} LSE`);
  return final;
}

// ── UNIVERSE ACCESSOR ─────────────────────────────────────────
// Called by runFullScan() to get the current universe.
// Refreshes if stale or on first call.

async function getDynamicUniverse() {
  const stale = Date.now() - _dynamicUniverse.fetchedAt > DYN.MAX_STALE_HOURS * 3600000;
  const empty = _dynamicUniverse.crypto.length === 0;

  if (stale || empty) {
    // Try Supabase first (fast, no API calls)
    const cached = await loadDynamicUniverseFromSupabase();
    if (cached && cached.crypto.length >= 5) {
      _dynamicUniverse = { ...cached, fetchedAt: Date.now() };
      log(`DYN: Loaded universe from Supabase cache`);
      return cached;
    }
    // Full refresh
    return await refreshDynamicUniverse();
  }

  return {
    crypto: _dynamicUniverse.crypto,
    us:     _dynamicUniverse.us,
    lse:    _dynamicUniverse.lse,
  };
}
// SECTION 26: HUNTER INTELLIGENCE ENGINE
// Full-universe alerts — not limited to the fixed watchlist.
// Reads hunter_leaderboard_history without any universe filter.
//
// Five capabilities:
//   1. New entrant alert  — any symbol entering top 10 for
//      the first time in 14 days → immediate Bluejam flag
//   2. Top-3 breakout    — symbol enters top 3 from outside
//      previous snapshot's top 3 → immediate flag
//   3. Divergence alert  — high Hunter flow but weak price
//      movement → early entry signal
//   4. Weekly momentum   — persistence + trend + rotation
//      combined score, fired Friday with weekly reports
//   5. Cross-asset rotation — crypto vs stocks regime shift
//      detected over 3+ consecutive snapshots → flag
//
// Schedule:
//   • New entrant + top-3 + divergence → every scan cycle
//     (deduplicated via hunter_calibration sent-flag)
//   • Weekly momentum + rotation summary → Friday 11-13 UTC
// ============================================================

// ── CONFIG ───────────────────────────────────────────────────
const INTEL = {
  LOOKBACK_DAYS:          14,   // days of history to scan
  NEW_ENTRANT_TOP_N:      10,   // flag first appearance in top N
  TOP3_RANK_THRESHOLD:     3,   // breakout threshold
  DIVERGENCE_MIN_SCORE:   65,   // minimum score for divergence check
  DIVERGENCE_MIN_TOP5:     3,   // top-5 appearances this week to qualify
  DIVERGENCE_MAX_PRICE_PCT: 2,  // price move below this % = divergence
  MOMENTUM_TOP5_WEIGHT:   0.4,  // weekly momentum formula weights
  MOMENTUM_TREND_WEIGHT:  0.4,
  MOMENTUM_ROTATION_WEIGHT: 0.2,
  ROTATION_CONSEC_SNAPS:   3,   // consecutive snapshots needed for rotation signal
  ROTATION_THRESHOLD:      5,   // avg score swing between asset classes
  ALERT_COOLDOWN_HOURS:   24,   // don't re-alert same symbol within N hours
};

// ── HELPERS ──────────────────────────────────────────────────

function intelFlagFor(assetType) {
  return assetType === 'crypto' ? '🪙' : assetType === 'lse' ? '🇬🇧' : '🇺🇸';
}

function intelCooldownKey(type, symbol) {
  return `intel_${type}_${symbol}_${new Date().toISOString().slice(0, 10)}`;
}

async function intelAlreadySent(key) {
  if (!supabase) return false;
  try {
    const { data } = await supabase
      .from('hunter_calibration')
      .select('id')
      .eq('id', key)
      .single();
    return !!data;
  } catch { return false; }
}

async function intelMarkSent(key) {
  if (!supabase) return;
  try {
    await supabase.from('hunter_calibration').upsert({
      id:               key,
      recorded_at:      new Date().toISOString(),
      top_score:        0,
      top_symbol:       'INTEL_SENT',
      field_avg:        0,
      candidate_count:  0,
      btc_regime:       STATE.btcRegime  || 'UNKNOWN',
      qqq_regime:       STATE.qqqRegime  || 'UNKNOWN',
      market_open_count: 0,
      buy_count:        0,
      watch_count:      0,
    });
  } catch { /* best effort */ }
}

// ── DATA LOADER ───────────────────────────────────────────────
// Loads full leaderboard history with NO universe filter.
// Returns Map: symbol → { assetType, snapshots: [{score,rank,snapshotId,time}] }

async function intelLoadFullHistory(days = INTEL.LOOKBACK_DAYS) {
  if (!supabase) return new Map();
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data, error } = await supabase
      .from('hunter_leaderboard_history')
      .select('symbol, asset_type, score, rank, snapshot_id, snapshot_time')
      .gte('snapshot_time', since)
      .order('snapshot_time', { ascending: true });

    if (error || !data?.length) return new Map();

    const map = new Map();
    for (const row of data) {
      if (!map.has(row.symbol)) {
        map.set(row.symbol, { assetType: row.asset_type, snapshots: [] });
      }
      map.get(row.symbol).snapshots.push({
        score:      parseFloat(row.score),
        rank:       row.rank,
        snapshotId: row.snapshot_id,
        time:       row.snapshot_time,
      });
    }
    return map;
  } catch (err) {
    log(`INTEL: loadFullHistory error: ${err.message}`);
    return new Map();
  }
}

// Build ordered list of unique snapshot IDs (oldest → newest)
function intelGetSnapshotOrder(symbolMap) {
  const ids = new Set();
  for (const { snapshots } of symbolMap.values()) {
    for (const s of snapshots) ids.add(s.snapshotId);
  }
  // Sort by time embedded in the first occurrence
  const idList = [...ids];
  // Pull time from first symbol that has this snapshot
  const idTimes = new Map();
  for (const { snapshots } of symbolMap.values()) {
    for (const s of snapshots) {
      if (!idTimes.has(s.snapshotId)) idTimes.set(s.snapshotId, s.time);
    }
  }
  return idList.sort((a, b) => new Date(idTimes.get(a)) - new Date(idTimes.get(b)));
}


// ── INTEL BLOCKLIST ───────────────────────────────────────────
// Micro-caps and meme coins confirmed to float on weekends.
// Updated when new junk appears in alerts.
const INTEL_BLOCKLIST = new Set([
  // Confirmed micro-caps / meme coins
  'SAFEUSDT','BLENDUSDT','ACHUSDT','TRIAUSDT','SENTUSDT',
  'DEGENUSDT','BANKUSDT','HOMEUSDT','ICNTUSDT','WAXPUSDT',
  'HFTUSDT','ZEREBROUSDT','COTIUSDT','GIGGLEUSDT','MATICUSDT',
  // Stablecoins
  'USDCUSDT','USDTUSDT','BUSDUSDT','TUSDUSDT','DAIUSDT','USD1USDT',
  // New confirmed junk from dynamic universe (Aug 2026)
  'BEATUSDT','BTWUSDT','PUMPUSDT','ANTFUNUSDT','DEXEUSDT',
  'DASHUSDT','JSTUSDT','LITUSDT','ZECUSDT','PENGUUSDT',
]);

// ── 1. NEW ENTRANT ALERT ─────────────────────────────────────
// Symbol appears in top 10 for the first time in LOOKBACK_DAYS.
// Fires once per symbol per day.

async function runNewEntrantAlerts(symbolMap, snapshots) {
  if (!ENV.BLUEJAM_CHAT_ID) return;

  // No intelligence alerts on weekends — rankings are meaningless when markets are quiet
  const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    log('INTEL: Weekend — new entrant alerts suppressed');
    return;
  }

  // Get the 2 most recent snapshot IDs
  const recent2 = snapshots.slice(-2);
  if (recent2.length < 2) return;
  const [prevSnapId, latestSnapId] = recent2;

  // Symbols in latest snapshot, top 10 — with minimum score gate
  const MIN_ALERT_SCORE = 62; // never alert on garbage scores
  const latestTop10 = new Map();
  for (const [sym, { assetType, snapshots: snaps }] of symbolMap.entries()) {
    const latest = snaps.find(s => s.snapshotId === latestSnapId);
    if (latest && latest.rank <= INTEL.NEW_ENTRANT_TOP_N && latest.score >= MIN_ALERT_SCORE) {
      latestTop10.set(sym, { assetType, rank: latest.rank, score: latest.score });
    }
  }

  // Filter blocklist
  for (const sym of INTEL_BLOCKLIST) latestTop10.delete(sym);

  // Symbols that appeared in ANY snapshot before the latest
  const everSeen = new Set();
  for (const [sym, { snapshots: snaps }] of symbolMap.entries()) {
    const beforeLatest = snaps.filter(s => s.snapshotId !== latestSnapId);
    if (beforeLatest.some(s => s.rank <= INTEL.NEW_ENTRANT_TOP_N)) {
      everSeen.add(sym);
    }
  }

  // New entrants = in latest top 10 but never seen in top 10 before
  for (const [sym, { assetType, rank, score }] of latestTop10.entries()) {
    if (everSeen.has(sym)) continue; // not new

    const key = intelCooldownKey('newentrant', sym);
    if (await intelAlreadySent(key)) continue;

    const flag = intelFlagFor(assetType);
    const label = sym.replace('USDT', '');
    const msg = [
      `🆕 NEW ENTRANT DETECTED`,
      ``,
      `${flag} ${label} has entered the Hunter Top 10 for the first time.`,
      ``,
      `Rank:  #${rank}`,
      `Score: ${round2(score)}`,
      ``,
      `Hunter has not seen this asset in the top 10 in the last ${INTEL.LOOKBACK_DAYS} days.`,
      `This is an early signal — watch for confirmation over the next 2–3 scans.`,
      ``,
      `——————————`,
      `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
      `📸 @baretradesignals 🏹`,
    ].join('\n');

    await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
    await intelMarkSent(key);
    log(`INTEL: 🆕 New entrant alert sent for ${sym}`);
    await sleep(500);
  }
}

// ── 2. TOP-3 BREAKOUT ALERT ───────────────────────────────────
// Symbol enters top 3 but was NOT in top 3 in the previous snapshot.
// Fires once per symbol per day.

async function runTop3BreakoutAlerts(symbolMap, snapshots) {
  if (!ENV.BLUEJAM_CHAT_ID) return;

  // No top-3 alerts on weekends — micro-caps float to top when liquid coins go quiet
  const dayOfWeek = new Date().getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    log('INTEL: Weekend — top-3 breakout alerts suppressed');
    return;
  }

  const recent2 = snapshots.slice(-2);
  if (recent2.length < 2) return;
  const [prevSnapId, latestSnapId] = recent2;

  // Top 3 in latest snapshot — minimum score gate
  const MIN_ALERT_SCORE = 62;
  const latestTop3 = new Map();
  for (const [sym, { assetType, snapshots: snaps }] of symbolMap.entries()) {
    const latest = snaps.find(s => s.snapshotId === latestSnapId);
    if (latest && latest.rank <= INTEL.TOP3_RANK_THRESHOLD && latest.score >= MIN_ALERT_SCORE) {
      latestTop3.set(sym, { assetType, rank: latest.rank, score: latest.score });
    }
  }

  // Filter blocklist
  for (const sym of INTEL_BLOCKLIST) latestTop3.delete(sym);

  // Top 3 in previous snapshot
  const prevTop3 = new Set();
  for (const [sym, { snapshots: snaps }] of symbolMap.entries()) {
    const prev = snaps.find(s => s.snapshotId === prevSnapId);
    if (prev && prev.rank <= INTEL.TOP3_RANK_THRESHOLD) prevTop3.add(sym);
  }

  for (const [sym, { assetType, rank, score }] of latestTop3.entries()) {
    if (prevTop3.has(sym)) continue; // was already in top 3

    const key = intelCooldownKey('top3', sym);
    if (await intelAlreadySent(key)) continue;

    const flag  = intelFlagFor(assetType);
    const label = sym.replace('USDT', '');

    // Get prior rank for context
    const data      = symbolMap.get(sym);
    const prevSnap  = data?.snapshots.find(s => s.snapshotId === prevSnapId);
    const priorRank = prevSnap ? `#${prevSnap.rank}` : 'outside top 10';

    const msg = [
      `🚀 TOP 3 BREAKOUT`,
      ``,
      `${flag} ${label} has broken into the Hunter Top 3.`,
      ``,
      `Now:   #${rank}  (score ${round2(score)})`,
      `Prior: ${priorRank}`,
      ``,
      `This asset was outside the top 3 in the previous scan and has now moved in.`,
      `Watch for trend confirmation — this is where leadership often emerges.`,
      ``,
      `——————————`,
      `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
      `📸 @baretradesignals 🏹`,
    ].join('\n');

    await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
    await intelMarkSent(key);
    log(`INTEL: 🚀 Top-3 breakout alert sent for ${sym}`);
    await sleep(500);
  }
}

// ── 3. DIVERGENCE ALERT ───────────────────────────────────────
// High Hunter flow (score ≥65, top-5 appearances ≥3 this week)
// but price movement < 2% over the same window.
// This is the early entry signal — price hasn't moved yet but
// Hunter is seeing institutional flow building.
// Fires once per symbol per day maximum.

async function runDivergenceAlerts(symbolMap) {
  if (!ENV.BLUEJAM_CHAT_ID) return;

  const weekAgo   = new Date(Date.now() - 7 * 86400000).toISOString();

  for (const [sym, { assetType, snapshots }] of symbolMap.entries()) {
    // Only look at this week's snapshots
    const weekSnaps = snapshots.filter(s => s.time >= weekAgo);
    if (weekSnaps.length < 3) continue;

    const currentScore = weekSnaps[weekSnaps.length - 1].score;
    if (currentScore < INTEL.DIVERGENCE_MIN_SCORE) continue;

    const top5count = weekSnaps.filter(s => s.rank <= 5).length;
    if (top5count < INTEL.DIVERGENCE_MIN_TOP5) continue;

    // Fetch price data to check actual movement
    const candles = await fetchDailyCandles(sym, assetType).catch(() => []);
    if (candles.length < 5) continue;

    const weekCandles = candles.slice(-7);
    const firstClose  = weekCandles[0].close;
    const lastClose   = weekCandles[weekCandles.length - 1].close;
    const pricePctMove = Math.abs((lastClose - firstClose) / firstClose * 100);

    // Divergence = high flow but LOW price movement
    // Suppress if price has already moved (>2%) — not a divergence
    if (pricePctMove >= INTEL.DIVERGENCE_MAX_PRICE_PCT) continue;

    // Suppress if price is DOWN on the week — that's weakness not divergence
    const weekChange = (lastClose - firstClose) / firstClose * 100;
    if (weekChange < -1) continue; // down more than 1% this week = not divergence

    // Suppress if today's candle is down significantly — same reality check as scorer
    const lastCandle   = candles[candles.length - 1];
    const todayChange  = lastCandle
      ? ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100
      : 0;
    if (todayChange < -2) continue; // down 2%+ today = skip

    const key = intelCooldownKey('divergence', sym);
    if (await intelAlreadySent(key)) continue;

    const flag  = intelFlagFor(assetType);
    const label = sym.replace('USDT', '');

    const msg = [
      `📡 DIVERGENCE SIGNAL`,
      ``,
      `${flag} ${label}`,
      ``,
      `Hunter score:     ${round2(currentScore)}`,
      `Top-5 this week:  ${top5count} appearances`,
      `Price move (7d):  +${round2(pricePctMove)}%`,
      ``,
      `Hunter is seeing momentum build before the price has moved.`,
      `This pattern often comes before a meaningful move.`,
      `Worth watching — not a signal to act on yet.`,
      ``,
      `——————————`,
      `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
      `📸 @baretradesignals 🏹`,
    ].join('\n');

    await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
    await intelMarkSent(key);
    log(`INTEL: 📡 Divergence alert sent for ${sym}`);
    await sleep(800); // slightly longer — fetched candle data
  }
}

// ── 4. WEEKLY MOMENTUM SCORE ──────────────────────────────────
// Fired Friday alongside weekly reports.
// Formula per symbol:
//   persistence  = top-5 appearances / total snapshots this week  (0-1)
//   trend        = (last score - first score this week) / 100     (signed, -1 to +1)
//   rotation     = entered top 5 from outside? 1 = yes, 0 = no
//   momentumScore = (persistence × 0.4 + trendNorm × 0.4 + rotation × 0.2) × 100

async function fireWeeklyMomentumReport(symbolMap) {
  if (!ENV.BLUEJAM_CHAT_ID) return;

  const weekAgo    = new Date(Date.now() - 7 * 86400000).toISOString();
  const twoWeekAgo = new Date(Date.now() - 14 * 86400000).toISOString();

  const scores = [];

  for (const [sym, { assetType, snapshots }] of symbolMap.entries()) {
    const weekSnaps     = snapshots.filter(s => s.time >= weekAgo);
    const priorSnaps    = snapshots.filter(s => s.time >= twoWeekAgo && s.time < weekAgo);

    if (weekSnaps.length < 2) continue;

    const totalSnaps    = weekSnaps.length;
    const top5count     = weekSnaps.filter(s => s.rank <= 5).length;
    const persistence   = top5count / totalSnaps;

    const firstScore    = weekSnaps[0].score;
    const lastScore     = weekSnaps[weekSnaps.length - 1].score;
    const trendRaw      = (lastScore - firstScore) / 100; // -1 to +1
    const trendNorm     = Math.max(-1, Math.min(1, trendRaw));

    // Rotation: was outside top 5 last week but entered top 5 this week
    const inTop5LastWeek = priorSnaps.some(s => s.rank <= 5);
    const inTop5ThisWeek = weekSnaps.some(s => s.rank <= 5);
    const rotation       = (!inTop5LastWeek && inTop5ThisWeek) ? 1 : 0;

    const momentumScore = round2(
      (persistence * INTEL.MOMENTUM_TOP5_WEIGHT
      + ((trendNorm + 1) / 2) * INTEL.MOMENTUM_TREND_WEIGHT  // normalise to 0-1
      + rotation * INTEL.MOMENTUM_ROTATION_WEIGHT) * 100
    );

    if (momentumScore < 20) continue; // filter noise

    scores.push({
      sym, assetType, momentumScore,
      lastScore: round2(lastScore),
      top5count, rotation: rotation === 1,
      trend: round2(lastScore - firstScore),
    });
  }

  if (scores.length === 0) {
    log('INTEL: No momentum scores to report');
    return;
  }

  // Sort by momentum score desc, take top 10 per asset class
  const crypto = scores.filter(s => s.assetType === 'crypto').sort((a, b) => b.momentumScore - a.momentumScore).slice(0, 5);
  const us     = scores.filter(s => s.assetType === 'us').sort((a, b) => b.momentumScore - a.momentumScore).slice(0, 5);
  const lse    = scores.filter(s => s.assetType === 'lse').sort((a, b) => b.momentumScore - a.momentumScore).slice(0, 5);

  const formatRow = (s) => {
    const label    = s.sym.replace('USDT', '');
    const flag     = intelFlagFor(s.assetType);
    const rotation = s.rotation ? ' 🔄' : '';
    const trend    = s.trend >= 0 ? `▲ +${s.trend}` : `▼ ${s.trend}`;
    return `${flag} ${label.padEnd(8)} [${s.momentumScore}]  ${trend}${rotation}`;
  };

  const lines = [
    `📊 WEEKLY MOMENTUM SCORES`,
    `${new Date().toISOString().slice(0, 10)}`,
    ``,
    `Persistence × Trend × Rotation — full universe`,
    `🔄 = rotated IN from outside top 5 this week`,
    ``,
  ];

  if (crypto.length) {
    lines.push(`🌐 CRYPTO`);
    crypto.forEach(s => lines.push(formatRow(s)));
    lines.push('');
  }
  if (us.length) {
    lines.push(`🇺🇸 US`);
    us.forEach(s => lines.push(formatRow(s)));
    lines.push('');
  }
  if (lse.length) {
    lines.push(`🇬🇧 LSE`);
    lse.forEach(s => lines.push(formatRow(s)));
    lines.push('');
  }

  lines.push(`——————————`);
  lines.push(`⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`);
  lines.push(`📸 @baretradesignals 🏹`);

  await sendTelegram(lines.join('\n'), ENV.BLUEJAM_CHAT_ID);
  log('INTEL: 📊 Weekly momentum report sent');
}

// ── 5. CROSS-ASSET ROTATION ALERT ────────────────────────────
// Tracks crypto vs stock/LSE average score per snapshot.
// When crypto avg rises while stock avg falls (or vice versa)
// over ROTATION_CONSEC_SNAPS consecutive snapshots → flag.
// Fires once per day maximum.

async function runRotationAlert(symbolMap, orderedSnapshots) {
  if (!ENV.BLUEJAM_CHAT_ID) return;

  const key = `intel_rotation_${new Date().toISOString().slice(0, 10)}`;
  if (await intelAlreadySent(key)) return;

  // Need at least N+1 snapshots
  const needed = INTEL.ROTATION_CONSEC_SNAPS + 1;
  if (orderedSnapshots.length < needed) return;

  const recentSnaps = orderedSnapshots.slice(-needed);

  // Per snapshot: avg crypto score, avg stock score (us + lse combined)
  const snapAvgs = recentSnaps.map(snapId => {
    const cryptoScores = [];
    const stockScores  = [];
    for (const { assetType, snapshots } of symbolMap.values()) {
      const snap = snapshots.find(s => s.snapshotId === snapId);
      if (!snap) continue;
      if (assetType === 'crypto') cryptoScores.push(snap.score);
      else stockScores.push(snap.score);
    }
    const cryptoAvg = cryptoScores.length
      ? cryptoScores.reduce((a, b) => a + b, 0) / cryptoScores.length : null;
    const stockAvg = stockScores.length
      ? stockScores.reduce((a, b) => a + b, 0) / stockScores.length : null;
    return { snapId, cryptoAvg, stockAvg };
  });

  // Check for consistent rotation over last N snapshots
  const evalSnaps = snapAvgs.slice(-INTEL.ROTATION_CONSEC_SNAPS);
  const first = snapAvgs[0]; // baseline

  const cryptoRising = evalSnaps.every(s => s.cryptoAvg != null && first.cryptoAvg != null && s.cryptoAvg > first.cryptoAvg);
  const stockFalling = evalSnaps.every(s => s.stockAvg  != null && first.stockAvg  != null && s.stockAvg  < first.stockAvg);
  const cryptoFalling = evalSnaps.every(s => s.cryptoAvg != null && first.cryptoAvg != null && s.cryptoAvg < first.cryptoAvg);
  const stockRising   = evalSnaps.every(s => s.stockAvg  != null && first.stockAvg  != null && s.stockAvg  > first.stockAvg);

  const latestAvg = snapAvgs[snapAvgs.length - 1];
  const cryptoDelta = latestAvg.cryptoAvg && first.cryptoAvg
    ? round2(latestAvg.cryptoAvg - first.cryptoAvg) : 0;
  const stockDelta  = latestAvg.stockAvg  && first.stockAvg
    ? round2(latestAvg.stockAvg  - first.stockAvg)  : 0;

  const cryptoInStocksOut = cryptoRising && stockFalling
    && Math.abs(cryptoDelta) >= INTEL.ROTATION_THRESHOLD
    && Math.abs(stockDelta)  >= INTEL.ROTATION_THRESHOLD;

  const stocksInCryptoOut = stockRising && cryptoFalling
    && Math.abs(cryptoDelta) >= INTEL.ROTATION_THRESHOLD
    && Math.abs(stockDelta)  >= INTEL.ROTATION_THRESHOLD;

  if (!cryptoInStocksOut && !stocksInCryptoOut) return;

  const direction = cryptoInStocksOut
    ? `🌐 Crypto rotating IN · Stocks rotating OUT`
    : `🇺🇸 Stocks rotating IN · Crypto rotating OUT`;

  const msg = [
    `🔄 REGIME ROTATION DETECTED`,
    ``,
    direction,
    ``,
    `Over the last ${INTEL.ROTATION_CONSEC_SNAPS} consecutive scans:`,
    `Crypto avg score:  ${cryptoDelta >= 0 ? '+' : ''}${cryptoDelta} pts`,
    `Stock avg score:   ${stockDelta  >= 0 ? '+' : ''}${stockDelta} pts`,
    ``,
    `This is a cross-asset flow signal — money appears to be moving`,
    `between asset classes. Not a single-asset signal.`,
    ``,
    `——————————`,
    `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
    `📸 @baretradesignals 🏹`,
  ].join('\n');

  await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
  await intelMarkSent(key);
  log(`INTEL: 🔄 Rotation alert sent — ${cryptoInStocksOut ? 'crypto in' : 'stocks in'}`);
}

// ── MAIN INTELLIGENCE RUNNER ──────────────────────────────────
// Called every scan cycle. Individual functions handle their
// own deduplication via hunter_calibration sent-flags.

async function runHunterIntelligence() {
  if (!supabase) return;
  log('🧠 Hunter Intelligence running...');

  try {
    const symbolMap        = await intelLoadFullHistory(INTEL.LOOKBACK_DAYS);
    if (symbolMap.size === 0) { log('INTEL: no data'); return; }

    const orderedSnapshots = intelGetSnapshotOrder(symbolMap);
    if (orderedSnapshots.length < 2) { log('INTEL: insufficient snapshots'); return; }

    // Run per-scan alerts (all deduplicated internally)
    await runNewEntrantAlerts(symbolMap, orderedSnapshots);
    await runTop3BreakoutAlerts(symbolMap, orderedSnapshots);
    await runRotationAlert(symbolMap, orderedSnapshots);

    // Divergence — slightly heavier (fetches candles) so only run every 4th cycle
    if (STATE.cycleCount % 4 === 0) {
      await runDivergenceAlerts(symbolMap);
    }

    log('🧠 Hunter Intelligence complete');
  } catch (err) {
    log(`INTEL: runHunterIntelligence error: ${err.message}`);
  }
}

// fireWeeklyMomentumReport is called separately from the Friday
// weekly report block in mainCycle — see wiring below.
// SECTION 25b: PORTFOLIO MANAGER — OPEN / HOLD / CLOSE engine
// Replaces: runPortfolioWatch() (5-state score-only system)
// Philosophy: scan-led discovery, three actions only, silent
//             HOLD by default, close only on objective failure.
// Fires: daily at 09:00 UTC + every scan cycle for open positions
// Supabase tables: portfolio_positions, portfolio_decisions,
//                  portfolio_watchlist
// ============================================================

// ── PORTFOLIO CONFIG ─────────────────────────────────────────
// All thresholds here. Change numbers, not logic.
const PM = {
  // OPEN gates
  OPEN_MIN_SCORE:           60,   // minimum Hunter score (2 of last 3 snapshots)
  OPEN_SCORE_SNAPSHOTS:      3,   // how many recent snapshots to check
  OPEN_SCORE_MIN_COUNT:      2,   // how many of those must be >= OPEN_MIN_SCORE
  OPEN_TREND_SNAPSHOTS:      3,   // snapshots used to confirm score is rising not falling
  OPEN_52W_MAX_PCT_FROM_HIGH: 25, // price must be within X% of 52-week high
  OPEN_52W_MIN_RANGE_PCT:    30,  // 52w high must be at least X% above 52w low
  OPEN_MIN_HUNTER_SCORE_PEAK: 62, // peak score in window must clear this
  OPEN_TOP5_MIN_COUNT:        2,  // must have appeared in top 5 at least this many times
  OPEN_CRYPTO_MIN_VOL_USD: 10_000_000, // 24h volume minimum for crypto ($10M)
  OPEN_STOCK_MIN_PRICE:      15,  // US stocks: min price
  OPEN_STOCK_MIN_ADV:   500_000,  // US stocks: avg daily volume
  OPEN_LSE_MIN_ADV:     200_000,  // LSE: avg daily volume

  // HOLD — thresholds before a warning is generated
  HOLD_MA50_BUFFER_PCT:       3,  // allow price to be 3% below 50MA before flagging
  HOLD_MAX_DIST_DAYS:       10,   // distribution days allowed in 10 sessions
  HOLD_DIST_CLUSTER_DAYS:    5,   // cluster window for heavy distribution check
  HOLD_DIST_CLUSTER_MAX:     3,   // max dist days in cluster window before warning
  HOLD_MAX_SCORE_DROP:       15,  // score can drop this many pts from peak before warning
  HOLD_SCORE_FLOOR:          40,  // consecutive sessions below this = concern
  HOLD_SCORE_FLOOR_SESSIONS:  2,  // how many consecutive sessions below floor = concern
  HOLD_NEW_POSITION_GRACE:   14,  // days — don't close a new position on score alone

  // CLOSE triggers
  CLOSE_ATR_MULT_STOCK:     3.0,  // trailing stop: N * ATR below peak close (stocks)
  CLOSE_ATR_MULT_CRYPTO:    4.0,  // trailing stop: N * ATR below peak close (crypto)
  CLOSE_ATR_MULT_LSE:       3.0,  // trailing stop for LSE
  CLOSE_DIST_COUNT:           4,  // distribution days in 10 sessions → close
  CLOSE_DIST_CLUSTER:         3,  // distribution days in 5 sessions → close
  CLOSE_SCORE_FLOOR:         40,  // score below this for N sessions
  CLOSE_SCORE_FLOOR_SESSIONS: 2,  // consecutive sessions below floor → close
  CLOSE_SCORE_DROP_FROM_PEAK: 25, // score has dropped this much from position peak → close
  CLOSE_BREAKOUT_FAIL_SESSIONS: 5,// sessions to check for failed breakout return

  // WATCHLIST
  WATCH_MIN_SCORE:           55,  // minimum score to enter watchlist
  WATCH_TOP5_MIN:             1,  // must appear in top 5 at least once
  WATCH_MAX_SCORE_BELOW_OPEN: 8,  // within 8 pts of OPEN threshold to watch
  WATCH_STALE_DAYS:           3,  // remove from watchlist if not seen for N days

  // DATA LOOKBACK
  LEADERBOARD_DAYS:          14,  // days of leaderboard history to analyse
  DAILY_CANDLE_DAYS:         60,  // days of daily candles to fetch for MA/ATR
};

// ── SUPABASE HELPERS ─────────────────────────────────────────

async function pmGetOpenPositions() {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('portfolio_positions')
      .select('*')
      .eq('status', 'open')
      .order('opened_at', { ascending: true });
    if (error) { log(`PM: getOpenPositions error: ${error.message}`); return []; }
    return data || [];
  } catch (err) {
    log(`PM: getOpenPositions exception: ${err.message}`);
    return [];
  }
}

async function pmGetWatchlist() {
  if (!supabase) return [];
  try {
    const staleThreshold = new Date(Date.now() - PM.WATCH_STALE_DAYS * 86400000).toISOString();
    const { data, error } = await supabase
      .from('portfolio_watchlist')
      .select('*')
      .gte('last_seen', staleThreshold);
    if (error) { log(`PM: getWatchlist error: ${error.message}`); return []; }
    return data || [];
  } catch (err) {
    log(`PM: getWatchlist exception: ${err.message}`);
    return [];
  }
}

async function pmOpenPosition(symbol, assetType, score, atrStop, swingLowStop, entryEvidence) {
  if (!supabase) return;
  try {
    const now = new Date().toISOString();
    await supabase.from('portfolio_positions').upsert({
      symbol,
      asset_type:       assetType,
      status:           'open',
      opened_at:        now,
      entry_score:      round2(score),
      peak_score:       round2(score),
      atr_stop:         atrStop   ? round2(atrStop)   : null,
      swing_low_stop:   swingLowStop ? round2(swingLowStop) : null,
      entry_evidence:   JSON.stringify(entryEvidence),
      updated_at:       now,
    }, { onConflict: 'symbol' });

    await supabase.from('portfolio_decisions').insert({
      symbol,
      asset_type:   assetType,
      decision:     'OPEN',
      score:        round2(score),
      evidence:     JSON.stringify(entryEvidence),
      decided_at:   now,
    });
    log(`PM: ✅ OPEN logged for ${symbol}`);
  } catch (err) {
    log(`PM: pmOpenPosition error: ${err.message}`);
  }
}

async function pmUpdatePositionPeak(symbol, newPeakScore, newAtrStop) {
  if (!supabase) return;
  try {
    const updates = { updated_at: new Date().toISOString() };
    if (newPeakScore != null) updates.peak_score = round2(newPeakScore);
    if (newAtrStop   != null) updates.atr_stop   = round2(newAtrStop);
    await supabase.from('portfolio_positions')
      .update(updates)
      .eq('symbol', symbol)
      .eq('status', 'open');
  } catch (err) {
    log(`PM: pmUpdatePositionPeak error: ${err.message}`);
  }
}

async function pmClosePosition(symbol, assetType, score, reason, evidence) {
  if (!supabase) return;
  try {
    const now = new Date().toISOString();
    await supabase.from('portfolio_positions')
      .update({ status: 'closed', closed_at: now, close_reason: reason, updated_at: now })
      .eq('symbol', symbol)
      .eq('status', 'open');

    await supabase.from('portfolio_decisions').insert({
      symbol,
      asset_type:   assetType,
      decision:     'CLOSE',
      score:        round2(score),
      evidence:     JSON.stringify({ reason, ...evidence }),
      decided_at:   now,
    });
    log(`PM: 🔴 CLOSE logged for ${symbol} — ${reason}`);
  } catch (err) {
    log(`PM: pmClosePosition error: ${err.message}`);
  }
}

async function pmLogHold(symbol, assetType, score, evidence) {
  if (!supabase) return;
  try {
    await supabase.from('portfolio_decisions').insert({
      symbol,
      asset_type:   assetType,
      decision:     'HOLD',
      score:        round2(score),
      evidence:     JSON.stringify(evidence),
      decided_at:   new Date().toISOString(),
    });
  } catch (err) {
    log(`PM: pmLogHold error: ${err.message}`);
  }
}

async function pmUpsertWatchlist(symbol, assetType, score, reason) {
  if (!supabase) return;
  try {
    await supabase.from('portfolio_watchlist').upsert({
      symbol,
      asset_type:   assetType,
      last_score:   round2(score),
      last_seen:    new Date().toISOString(),
      watch_reason: reason,
    }, { onConflict: 'symbol' });
  } catch (err) {
    log(`PM: pmUpsertWatchlist error: ${err.message}`);
  }
}

async function pmRemoveFromWatchlist(symbol) {
  if (!supabase) return;
  try {
    await supabase.from('portfolio_watchlist').delete().eq('symbol', symbol);
  } catch (err) {
    log(`PM: pmRemoveFromWatchlist error: ${err.message}`);
  }
}

// ── DAILY CANDLE FETCHER ─────────────────────────────────────
// Fetches daily OHLCV candles. Used for MA/ATR/structure checks.
// Returns array of { open, high, low, close, volume, time } newest-last.

async function fetchDailyCandles(symbol, assetType) {
  try {
    if (assetType === 'crypto') {
      // Bybit daily candles
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=D&limit=${PM.DAILY_CANDLE_DAYS}`;
      const data = await httpGet(url);
      if (data?.result?.list?.length) {
        return data.result.list
          .map(c => ({
            time:   parseInt(c[0]),
            open:   parseFloat(c[1]),
            high:   parseFloat(c[2]),
            low:    parseFloat(c[3]),
            close:  parseFloat(c[4]),
            volume: parseFloat(c[5]),
          }))
          .reverse(); // Bybit returns newest-first
      }
    } else if (assetType === 'us') {
      // Alpaca daily bars
      const end   = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - PM.DAILY_CANDLE_DAYS * 86400000).toISOString().slice(0, 10);
      const url   = `${ENV.ALPACA_BASE_URL}/v2/stocks/${symbol}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${PM.DAILY_CANDLE_DAYS}&adjustment=raw&feed=iex`;
      const data  = await httpGet(url, {
        'APCA-API-KEY-ID':     ENV.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': ENV.ALPACA_SECRET_KEY,
      });
      if (data?.bars?.length) {
        return data.bars.map(b => ({
          time:   new Date(b.t).getTime(),
          open:   b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
        }));
      }
    } else if (assetType === 'lse') {
      // Yahoo Finance daily for LSE
      const ySymbol = symbol.replace('.L', '.L');
      const url     = `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=1d&range=3mo`;
      const data    = await httpGet(url, { 'User-Agent': 'Mozilla/5.0' });
      const result  = data?.chart?.result?.[0];
      if (result?.timestamp?.length) {
        const q = result.indicators.quote[0];
        return result.timestamp.map((t, i) => ({
          time:   t * 1000,
          open:   q.open[i], high: q.high[i], low: q.low[i],
          close:  q.close[i], volume: q.volume[i],
        })).filter(c => c.close != null);
      }
    }
  } catch (err) {
    log(`PM: fetchDailyCandles(${symbol}) error: ${err.message}`);
  }
  return [];
}

// ── TECHNICAL HELPERS (daily timeframe) ─────────────────────

function pmCalcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function pmCalcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high  = candles[i].high;
    const low   = candles[i].low;
    const pClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// Find the most recent significant swing low (last meaningful trough)
// Looks back up to 20 daily bars
function pmFindSwingLow(candles, lookback = 20) {
  const slice = candles.slice(-lookback);
  let lowestLow = Infinity;
  let swingLow  = null;
  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i].low < slice[i - 1].low && slice[i].low < slice[i + 1].low) {
      if (slice[i].low < lowestLow) {
        lowestLow = slice[i].low;
        swingLow  = slice[i].low;
      }
    }
  }
  return swingLow;
}

// Count distribution days in last N candles
// Distribution: close down > 0.2% on volume above prior day's volume
function pmCountDistributionDays(candles, lookback = 10) {
  const slice = candles.slice(-lookback - 1);
  let count   = 0;
  for (let i = 1; i < slice.length; i++) {
    const pctChange = (slice[i].close - slice[i - 1].close) / slice[i - 1].close * 100;
    if (pctChange < -0.2 && slice[i].volume > slice[i - 1].volume) count++;
  }
  return count;
}

// Check if price is in a low-volume pullback (bullish — do not close)
function pmIsLowVolumePullback(candles, lookback = 5) {
  if (candles.length < lookback + 1) return false;
  const recent  = candles.slice(-(lookback + 1));
  const volSMA  = recent.slice(0, -1).reduce((a, c) => a + c.volume, 0) / lookback;
  const lastVol = recent[recent.length - 1].volume;
  const lastPct = (recent[recent.length - 1].close - recent[recent.length - 2].close)
                  / recent[recent.length - 2].close * 100;
  return lastPct < 0 && lastVol < volSMA * 0.8; // price down but volume clearly below average
}


// ============================================================
// SNIPER REGIME READER
// Reads crypto_regimes table written by SNIPER V101.
// Used as a confirmation signal in Hunter's OPEN gate.
// Only used when data is fresh (within 8 days).
// SNIPER writes weekly — so this updates every Sunday.
// ============================================================

const SNIPER_REGIME_CACHE = new Map(); // symbol → { regime, trendScore, rotationScore, rs, date }
let SNIPER_REGIME_LOADED_AT = 0;
const SNIPER_REGIME_TTL_MS  = 4 * 3600000; // refresh cache every 4 hours
const SNIPER_REGIME_MAX_AGE_DAYS = 8; // ignore data older than 8 days

async function loadSniperRegimes() {
  if (!supabase) return;
  if (Date.now() - SNIPER_REGIME_LOADED_AT < SNIPER_REGIME_TTL_MS) return;

  try {
    const staleThreshold = new Date(Date.now() - SNIPER_REGIME_MAX_AGE_DAYS * 86400000).toISOString().slice(0,10);
    const { data, error } = await supabase
      .from('crypto_regimes')
      .select('symbol, date, regime, trend_score, rotation_score, relative_strength, confidence')
      .gte('date', staleThreshold)
      .order('date', { ascending: false });

    if (error || !data?.length) {
      log(`SNIPER: regime data unavailable or stale — skipping`);
      return;
    }

    SNIPER_REGIME_CACHE.clear();
    for (const row of data) {
      if (!SNIPER_REGIME_CACHE.has(row.symbol)) {
        SNIPER_REGIME_CACHE.set(row.symbol, {
          regime:          row.regime,
          trendScore:      parseFloat(row.trend_score || 0),
          rotationScore:   parseFloat(row.rotation_score || 0),
          relativeStrength: parseFloat(row.relative_strength || 0),
          confidence:      parseFloat(row.confidence || 0),
          date:            row.date,
        });
      }
    }

    SNIPER_REGIME_LOADED_AT = Date.now();
    log(`SNIPER: loaded ${SNIPER_REGIME_CACHE.size} regime records (latest: ${data[0]?.date})`);
  } catch (err) {
    log(`SNIPER: loadSniperRegimes error: ${err.message}`);
  }
}

function getSniperRegime(symbol) {
  return SNIPER_REGIME_CACHE.get(symbol) || null;
}

// ── OPEN GATE EVALUATOR ──────────────────────────────────────
// Returns { pass: bool, reasons: string[], gatesFailed: string[] }

function pmEvaluateOpenGates(symbol, assetType, snapshots, candles) {
  const reasons     = [];
  const gatesFailed = [];

  // — Gate 1: Score quality from leaderboard history
  const recentSnaps  = snapshots.slice(-PM.OPEN_SCORE_SNAPSHOTS);
  const aboveMin     = recentSnaps.filter(s => s.score >= PM.OPEN_MIN_SCORE).length;
  const scores       = snapshots.map(s => s.score);
  const peakScore    = Math.max(...scores);
  const last3        = scores.slice(-3);
  const scoreRising  = last3.length >= 2 && last3[last3.length - 1] > last3[0];
  const top5count    = snapshots.filter(s => s.rank <= 5).length;

  if (aboveMin < PM.OPEN_SCORE_MIN_COUNT) {
    gatesFailed.push(`Score gate: only ${aboveMin}/${PM.OPEN_SCORE_SNAPSHOTS} snapshots ≥ ${PM.OPEN_MIN_SCORE}`);
  } else {
    reasons.push(`Score ≥ ${PM.OPEN_MIN_SCORE} in ${aboveMin} of last ${PM.OPEN_SCORE_SNAPSHOTS} snapshots`);
  }

  if (!scoreRising) {
    gatesFailed.push('Score not rising across last 3 snapshots');
  } else {
    reasons.push(`Score trending up: ${round2(last3[0])} → ${round2(last3[last3.length - 1])}`);
  }

  if (peakScore < PM.OPEN_MIN_HUNTER_SCORE_PEAK) {
    gatesFailed.push(`Peak score ${round2(peakScore)} below minimum ${PM.OPEN_MIN_HUNTER_SCORE_PEAK}`);
  } else {
    reasons.push(`Peak score: ${round2(peakScore)}`);
  }

  if (top5count < PM.OPEN_TOP5_MIN_COUNT) {
    gatesFailed.push(`Top-5 appearances: ${top5count} (need ${PM.OPEN_TOP5_MIN_COUNT})`);
  } else {
    reasons.push(`Top-5 appearances: ${top5count}`);
  }

  // — Gate 2: Trend structure (requires daily candles)
  if (candles.length >= 50) {
    const closes    = candles.map(c => c.close);
    const ma20      = pmCalcSMA(closes, 20);
    const ma50      = pmCalcSMA(closes, 50);
    const lastClose = closes[closes.length - 1];
    const high52w   = Math.max(...closes);
    const low52w    = Math.min(...closes);
    const pctFromHigh = (high52w - lastClose) / high52w * 100;
    const rangeExpansion = (high52w - low52w) / low52w * 100;

    if (ma50 && lastClose < ma50) {
      gatesFailed.push(`Price below 50MA ($${round2(lastClose)} < $${round2(ma50)})`);
    } else if (ma50) {
      reasons.push(`Price above 50MA ($${round2(lastClose)} > $${round2(ma50)})`);
    }

    if (pctFromHigh > PM.OPEN_52W_MAX_PCT_FROM_HIGH) {
      gatesFailed.push(`${round2(pctFromHigh)}% below 52-week high (max allowed: ${PM.OPEN_52W_MAX_PCT_FROM_HIGH}%)`);
    } else {
      reasons.push(`Within ${round2(pctFromHigh)}% of 52-week high`);
    }

    if (rangeExpansion < PM.OPEN_52W_MIN_RANGE_PCT) {
      gatesFailed.push(`52w range only ${round2(rangeExpansion)}% (need ${PM.OPEN_52W_MIN_RANGE_PCT}%)`);
    } else {
      reasons.push(`52w range: ${round2(rangeExpansion)}%`);
    }

    if (ma20 && ma50 && ma20 < ma50) {
      gatesFailed.push(`20MA below 50MA — trend not established`);
    } else if (ma20 && ma50) {
      reasons.push(`20MA above 50MA — uptrend confirmed`);
    }
  } else {
    // Not enough candle data — treat as warning not hard block for crypto
    if (assetType !== 'crypto') {
      gatesFailed.push('Insufficient daily candle data for trend check');
    } else {
      reasons.push('Daily candles limited — score-based trend assessment only');
    }
  }

  // — Gate 3: Distribution check (no heavy selling into entry)
  if (candles.length >= 11) {
    const distCount   = pmCountDistributionDays(candles, 10);
    const clusterDist = pmCountDistributionDays(candles, 5);
    if (distCount >= PM.HOLD_MAX_DIST_DAYS) {
      gatesFailed.push(`${distCount} distribution days in last 10 sessions — heavy selling`);
    } else {
      reasons.push(`Distribution days: ${distCount}/10 (acceptable)`);
    }
    if (clusterDist >= PM.HOLD_DIST_CLUSTER_MAX) {
      gatesFailed.push(`${clusterDist} distribution days in last 5 sessions — cluster selling`);
    }
  }

  // — Gate 4: Liquidity (asset-type specific)
  // Candle volume used as proxy for liquidity
  if (candles.length >= 5) {
    const recent5Vol = candles.slice(-5).reduce((a, c) => a + c.volume, 0) / 5;
    if (assetType === 'crypto') {
      const lastClose    = candles[candles.length - 1].close;
      const volUSD       = recent5Vol * lastClose;
      if (volUSD < PM.OPEN_CRYPTO_MIN_VOL_USD) {
        gatesFailed.push(`24h volume ~$${Math.round(volUSD / 1e6)}M below $10M minimum`);
      } else {
        reasons.push(`Volume: ~$${Math.round(volUSD / 1e6)}M (liquid)`);
      }
    } else if (assetType === 'us') {
      const lastClose = candles[candles.length - 1].close;
      if (lastClose < PM.OPEN_STOCK_MIN_PRICE) {
        gatesFailed.push(`Price $${round2(lastClose)} below $${PM.OPEN_STOCK_MIN_PRICE} minimum`);
      }
      if (recent5Vol < PM.OPEN_STOCK_MIN_ADV) {
        gatesFailed.push(`ADV ${Math.round(recent5Vol / 1000)}k below ${PM.OPEN_STOCK_MIN_ADV / 1000}k minimum`);
      } else {
        reasons.push(`ADV: ${Math.round(recent5Vol / 1000)}k shares`);
      }
    } else if (assetType === 'lse') {
      if (recent5Vol < PM.OPEN_LSE_MIN_ADV) {
        gatesFailed.push(`ADV ${Math.round(recent5Vol / 1000)}k below ${PM.OPEN_LSE_MIN_ADV / 1000}k minimum`);
      } else {
        reasons.push(`ADV: ${Math.round(recent5Vol / 1000)}k shares`);
      }
    }
  }

  // ── SNIPER REGIME CONFIRMATION (bonus signal, not a hard gate) ──
  // If SNIPER has recent weekly regime data for this crypto asset,
  // use it to boost or flag the decision. Not a hard gate —
  // missing or stale SNIPER data does not block an OPEN.
  if (assetType === 'crypto') {
    const regime = getSniperRegime(symbol);
    if (regime) {
      // SNIPER is advisory only — Hunter makes the final call.
      // No SNIPER regime can block an OPEN. It adds context only.
      if (regime.regime === 'TRENDING') {
        reasons.push(`SNIPER intel: TRENDING — strong directional bias (trend ${regime.trendScore}, RS ${regime.relativeStrength})`);
      } else if (regime.regime === 'ROTATING') {
        reasons.push(`SNIPER intel: ROTATING — momentum building (rotation ${regime.rotationScore})`);
      } else if (regime.regime === 'DEAD_CAT') {
        reasons.push(`SNIPER intel: ⚠️ DEAD_CAT — SNIPER sees weakness. Hunter disagrees — proceed with caution.`);
      } else if (regime.regime === 'NEUTRAL') {
        reasons.push(`SNIPER intel: NEUTRAL — no directional signal`);
      }
    } else {
      reasons.push(`SNIPER regime: no data (not a blocker)`);
    }
  }

  const pass = gatesFailed.length === 0;
  return { pass, reasons, gatesFailed };
}

// ── CLOSE TRIGGER EVALUATOR ──────────────────────────────────
// Returns { close: bool, reason: string, evidence: object }

function pmEvaluateCloseTriggers(position, candles, currentScore, peakScoreInPosition) {
  if (!candles || candles.length < 10) {
    return { close: false, reason: null, evidence: { note: 'insufficient candle data' } };
  }

  const closes    = candles.map(c => c.close);
  const lastClose = closes[closes.length - 1];
  const ma20      = pmCalcSMA(closes, 20);
  const ma50      = pmCalcSMA(closes, 50);
  const atr       = pmCalcATR(candles, 14);
  const atrMult   = position.asset_type === 'crypto' ? PM.CLOSE_ATR_MULT_CRYPTO
                  : position.asset_type === 'lse'    ? PM.CLOSE_ATR_MULT_LSE
                  :                                    PM.CLOSE_ATR_MULT_STOCK;

  const evidence = {
    currentScore,
    peakScoreInPosition,
    lastClose: round2(lastClose),
    ma50:      ma50 ? round2(ma50) : null,
    atr:       atr  ? round2(atr)  : null,
  };

  // ── NEW POSITION GRACE PERIOD ──
  // Do not close on score alone within the first 14 days.
  const openedAt   = new Date(position.opened_at).getTime();
  const ageInDays  = (Date.now() - openedAt) / 86400000;
  const inGrace    = ageInDays < PM.HOLD_NEW_POSITION_GRACE;

  // ── LOW VOLUME PULLBACK OVERRIDE ──
  // If price is down but volume is clearly below average, this is healthy —
  // suppress any close that would otherwise trigger.
  const lowVolPullback = pmIsLowVolumePullback(candles, 5);
  if (lowVolPullback) {
    evidence.lowVolPullback = true;
    return { close: false, reason: null, evidence };
  }

  // ── WEEKLY TREND OVERRIDE ──
  // If 20MA > 50MA, the daily uptrend is intact — give extra buffer.
  const weeklyTrendIntact = ma20 && ma50 && ma20 > ma50;
  evidence.weeklyTrendIntact = weeklyTrendIntact;

  // ── TRIGGER 1: ATR Trailing Stop ──
  // From peak close since entry, subtract N × ATR.
  // Only fire if we have an ATR and a stored ATR stop.
  if (atr && position.atr_stop) {
    const atrStop = parseFloat(position.atr_stop);
    if (lastClose < atrStop) {
      return {
        close: true,
        reason: 'ATR trailing stop breached',
        evidence: { ...evidence, atrStop: round2(atrStop), trigger: 'ATR_STOP' },
      };
    }
    evidence.atrStop = round2(atrStop);
  }

  // ── TRIGGER 2: Price below 50MA on above-average volume ──
  if (ma50 && lastClose < ma50 * (1 - PM.HOLD_MA50_BUFFER_PCT / 100)) {
    const distCount = pmCountDistributionDays(candles, 5);
    if (distCount >= 2) {
      if (!weeklyTrendIntact) {
        return {
          close: true,
          reason: `Price ${round2(((ma50 - lastClose) / ma50) * 100)}% below 50MA with ${distCount} distribution days`,
          evidence: { ...evidence, trigger: 'MA50_BREAK_WITH_DISTRIBUTION' },
        };
      }
    }
  }

  // ── TRIGGER 3: Swing low failure ──
  if (position.swing_low_stop) {
    const swingLow = parseFloat(position.swing_low_stop);
    if (lastClose < swingLow) {
      return {
        close: true,
        reason: `Swing low broken — closed $${round2(lastClose)} below $${round2(swingLow)}`,
        evidence: { ...evidence, swingLow: round2(swingLow), trigger: 'SWING_LOW_BREAK' },
      };
    }
    evidence.swingLow = round2(swingLow);
  }

  // ── TRIGGER 4: Distribution day cluster ──
  const dist10 = pmCountDistributionDays(candles, 10);
  const dist5  = pmCountDistributionDays(candles, 5);
  evidence.dist10 = dist10;
  evidence.dist5  = dist5;

  if (dist10 >= PM.CLOSE_DIST_COUNT) {
    return {
      close: true,
      reason: `${dist10} distribution days in last 10 sessions — institutional exit`,
      evidence: { ...evidence, trigger: 'DISTRIBUTION_COUNT' },
    };
  }
  if (dist5 >= PM.CLOSE_DIST_CLUSTER) {
    return {
      close: true,
      reason: `${dist5} distribution days in last 5 sessions — distribution cluster`,
      evidence: { ...evidence, trigger: 'DISTRIBUTION_CLUSTER' },
    };
  }

  // ── TRIGGER 5: Score collapse (not in grace period) ──
  if (!inGrace) {
    const scoreDropFromPeak = peakScoreInPosition - currentScore;
    if (scoreDropFromPeak >= PM.CLOSE_SCORE_DROP_FROM_PEAK && currentScore < PM.CLOSE_SCORE_FLOOR) {
      return {
        close: true,
        reason: `Score collapsed: peak ${round2(peakScoreInPosition)} → current ${round2(currentScore)} (drop: ${round2(scoreDropFromPeak)} pts)`,
        evidence: { ...evidence, scoreDropFromPeak: round2(scoreDropFromPeak), trigger: 'SCORE_COLLAPSE' },
      };
    }
  }

  // ── TRIGGER 6: Score floor — 2 consecutive sessions below 40 ──
  // This is a last resort — only if price is also deteriorating.
  // Not checked in grace period.
  if (!inGrace && currentScore < PM.CLOSE_SCORE_FLOOR) {
    const closesDown = closes.slice(-3);
    const priceDeterioration = closesDown[closesDown.length - 1] < closesDown[0];
    if (priceDeterioration && !weeklyTrendIntact) {
      return {
        close: true,
        reason: `Score ${round2(currentScore)} below floor ${PM.CLOSE_SCORE_FLOOR} with deteriorating price and trend`,
        evidence: { ...evidence, trigger: 'SCORE_AND_PRICE_DETERIORATION' },
      };
    }
  }

  // Mixed evidence = HOLD. Default.
  return { close: false, reason: null, evidence };
}

// ── TELEGRAM MESSAGE BUILDERS ────────────────────────────────

function pmBuildOpenMessage(symbol, assetType, score, reasons, atrStop, swingLow) {
  const flag    = assetType === 'crypto' ? '🪙' : assetType === 'lse' ? '🇬🇧' : '🇺🇸';
  const label   = symbol.replace('USDT', '');
  const stopLine = atrStop   ? `ATR stop:      ${assetType === 'us' || assetType === 'lse' ? '$' : '$'}${round2(atrStop)}` : 'ATR stop:      Calculating';
  const swingLine = swingLow ? `Swing low:     $${round2(swingLow)}` : '';

  const stopDisplay = atrStop ? `Exit if it drops to $${round2(atrStop)}.` : '';
  return [
    `🟢 OPEN — ${flag} ${label}`,
    ``,
    `Entry zone: $${entry}`,
    ``,
    `Why Hunter likes it:`,
    ...reasons.slice(0, 3).map(r => `· ${r}`),
    ``,
    stopDisplay,
    `You will only hear from me again if something changes.`,
    ``,
    `——————————`,
    `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
    `📸 @baretradesignals 🏹`,
  ].filter(Boolean).join('\n');
}

function pmBuildCloseMessage(symbol, assetType, score, reason, position, evidence) {
  const flag    = assetType === 'crypto' ? '🪙' : assetType === 'lse' ? '🇬🇧' : '🇺🇸';
  const label   = symbol.replace('USDT', '');
  const openedAt = new Date(position.opened_at);
  const heldDays = Math.round((Date.now() - openedAt.getTime()) / 86400000);

  const holdVerdict = heldDays >= 14
    ? `Good hold — you held for ${heldDays} days.`
    : `Short hold — ${heldDays} days. Protecting capital is the right move.`;

  return [
    `🔴 CLOSE — ${flag} ${label}`,
    ``,
    `Why: ${reason}`,
    ``,
    `Why: ${reason}`,
    ``,
    holdVerdict,
    ``,
    `No action needed until you see an OPEN signal.`,
    ``,
    `——————————`,
    `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
    `📸 @baretradesignals 🏹`,
  ].join('\n');
}

function pmBuildWeeklyReview(positions, watchlist, marketContext) {
  const lines = [
    `📊 PORTFOLIO REVIEW — ${new Date().toISOString().slice(0, 10)}`,
    ``,
  ];

  if (positions.length === 0) {
    lines.push(`POSITIONS: None open.`);
  } else {
    lines.push(`POSITIONS:`);
    for (const p of positions) {
      const flag  = p.asset_type === 'crypto' ? '🌐' : p.asset_type === 'lse' ? '🇬🇧' : '🇺🇸';
      const label = p.symbol.replace('USDT', '');
      const days  = Math.round((Date.now() - new Date(p.opened_at).getTime()) / 86400000);
      lines.push(`🟡 ${flag} ${label} — HOLD`);
      lines.push(`   Entry score: ${round2(p.entry_score)} · Peak: ${round2(p.peak_score)} · Held: ${days}d`);
      if (p.atr_stop) lines.push(`   ATR stop: $${round2(p.atr_stop)}`);
      lines.push(``);
    }
  }

  if (watchlist.length > 0) {
    lines.push(`WATCHLIST (near OPEN):`);
    for (const w of watchlist) {
      const label = w.symbol.replace('USDT', '');
      lines.push(`👀 ${label} — Score ${round2(w.last_score)} · ${w.watch_reason}`);
    }
    lines.push(``);
  }

  lines.push(`MARKET:`);
  lines.push(`BTC regime:  ${marketContext.btc || 'UNKNOWN'}`);
  lines.push(`QQQ regime:  ${marketContext.qqq || 'UNKNOWN'}`);
  lines.push(``);
  lines.push(`Default is HOLD. No action unless you receive an OPEN or CLOSE.`);
  lines.push(``);
  lines.push(`——————————`);
  lines.push(`⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`);
  lines.push(`📸 @baretradesignals 🎯`);

  return lines.join('\n');
}

// ── MAIN PORTFOLIO MANAGER ───────────────────────────────────

async function runPortfolioManager() {
  if (!supabase) {
    log('PM: no Supabase — skipping');
    return;
  }
  log('💼 Portfolio Manager running...');

  // Load SNIPER regime data for use in OPEN gate decisions
  await loadSniperRegimes();

  // ── 1. LOAD STATE ──
  const [openPositions, watchlist] = await Promise.all([
    pmGetOpenPositions(),
    pmGetWatchlist(),
  ]);

  // ── 2. LOAD LEADERBOARD HISTORY ──
  const since = new Date(Date.now() - PM.LEADERBOARD_DAYS * 86400000).toISOString();
  const { data: allRows, error: lbError } = await supabase
    .from('hunter_leaderboard_history')
    .select('symbol, asset_type, rank, score, snapshot_time')
    .gte('snapshot_time', since)
    .order('snapshot_time', { ascending: true });

  if (lbError || !allRows?.length) {
    log('PM: no leaderboard data — skipping');
    return;
  }

  // Build per-symbol snapshot arrays
  const symbolMap = new Map();
  for (const row of allRows) {
    if (!symbolMap.has(row.symbol)) {
      symbolMap.set(row.symbol, {
        symbol:    row.symbol,
        assetType: row.asset_type,
        snapshots: [],
      });
    }
    symbolMap.get(row.symbol).snapshots.push({
      score: parseFloat(row.score),
      rank:  row.rank,
      time:  row.snapshot_time,
    });
  }

  // ── 3. EVALUATE OPEN POSITIONS — HOLD or CLOSE ──
  for (const position of openPositions) {
    const sym  = position.symbol;
    const data = symbolMap.get(sym);

    if (!data || data.snapshots.length < 2) {
      log(`PM: ${sym} — insufficient snapshot data, defaulting HOLD`);
      continue;
    }

    const currentScore       = data.snapshots[data.snapshots.length - 1].score;
    const peakScoreInHistory = Math.max(...data.snapshots.map(s => s.score));
    const peakInPosition     = Math.max(position.peak_score || position.entry_score, peakScoreInHistory);

    // Fetch daily candles for structural checks
    const candles = await fetchDailyCandles(sym, data.assetType);

    // Update ATR stop if we have candle data and a higher peak
    if (candles.length >= 15) {
      const atr = pmCalcATR(candles, 14);
      const atrMult = data.assetType === 'crypto' ? PM.CLOSE_ATR_MULT_CRYPTO
                    : data.assetType === 'lse'    ? PM.CLOSE_ATR_MULT_LSE
                    :                               PM.CLOSE_ATR_MULT_STOCK;
      if (atr) {
        const lastClose = candles[candles.length - 1].close;
        const newAtrStop = round2(lastClose - atrMult * atr);
        const existingStop = position.atr_stop ? parseFloat(position.atr_stop) : 0;
        // Only raise the stop, never lower it (trailing)
        if (newAtrStop > existingStop) {
          await pmUpdatePositionPeak(sym, peakInPosition, newAtrStop);
          position.atr_stop = newAtrStop; // update in-memory for trigger check
        }
      }
    }

    // Evaluate close triggers
    const closeResult = pmEvaluateCloseTriggers(position, candles, currentScore, peakInPosition);

    if (closeResult.close) {
      // CLOSE
      log(`PM: 🔴 CLOSE triggered for ${sym} — ${closeResult.reason}`);
      await pmClosePosition(sym, data.assetType, currentScore, closeResult.reason, closeResult.evidence);
      await pmRemoveFromWatchlist(sym);

      const msg = pmBuildCloseMessage(sym, data.assetType, currentScore, closeResult.reason, position, closeResult.evidence);
      if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);

    } else {
      // HOLD — silent, just log and update peak if needed
      log(`PM: 🟡 HOLD ${sym} — score ${round2(currentScore)}, no close trigger`);
      if (peakInPosition > (position.peak_score || 0)) {
        await pmUpdatePositionPeak(sym, peakInPosition, null);
      }
      await pmLogHold(sym, data.assetType, currentScore, closeResult.evidence);
    }

    await sleep(500); // rate limiting between position checks
  }

  // ── 4. SCAN FOR OPEN CANDIDATES ──
  // Only consider assets NOT already in an open position
  const openSymbols = new Set(openPositions.map(p => p.symbol));

  const candidates = [];
  for (const [sym, data] of symbolMap.entries()) {
    if (openSymbols.has(sym))                  continue; // already in portfolio
    if (data.snapshots.length < PM.OPEN_SCORE_SNAPSHOTS) continue; // not enough history

    const currentScore = data.snapshots[data.snapshots.length - 1].score;
    const peakScore    = Math.max(...data.snapshots.map(s => s.score));
    const top5count    = data.snapshots.filter(s => s.rank <= 5).length;

    // Quick pre-filter before expensive candle fetch
    if (currentScore < PM.WATCH_MIN_SCORE) continue;
    if (peakScore < PM.OPEN_MIN_HUNTER_SCORE_PEAK) continue;

    candidates.push(data);
  }

  // Sort by current score desc — evaluate best candidates first
  candidates.sort((a, b) => {
    const aScore = a.snapshots[a.snapshots.length - 1].score;
    const bScore = b.snapshots[b.snapshots.length - 1].score;
    return bScore - aScore;
  });

  // Evaluate top candidates for OPEN (limit candle fetches to top 15)
  const toEvaluate = candidates.slice(0, 15);

  for (const data of toEvaluate) {
    const sym          = data.symbol;
    const currentScore = data.snapshots[data.snapshots.length - 1].score;

    // Fetch daily candles
    const candles = await fetchDailyCandles(sym, data.assetType);
    await sleep(300); // rate limiting

    // Evaluate all OPEN gates
    const { pass, reasons, gatesFailed } = pmEvaluateOpenGates(
      sym, data.assetType, data.snapshots, candles
    );

    if (pass) {
      // All gates passed — OPEN
      log(`PM: 🟢 OPEN signal for ${sym} (score ${round2(currentScore)})`);

      // Calculate stops
      let atrStop    = null;
      let swingLow   = null;
      if (candles.length >= 15) {
        const atr     = pmCalcATR(candles, 14);
        const lastCl  = candles[candles.length - 1].close;
        const atrMult = data.assetType === 'crypto' ? PM.CLOSE_ATR_MULT_CRYPTO
                      : data.assetType === 'lse'    ? PM.CLOSE_ATR_MULT_LSE
                      :                               PM.CLOSE_ATR_MULT_STOCK;
        if (atr) atrStop = round2(lastCl - atrMult * atr);
        swingLow = pmFindSwingLow(candles, 20);
      }

      await pmOpenPosition(sym, data.assetType, currentScore, atrStop, swingLow, { reasons });
      await pmRemoveFromWatchlist(sym); // promote from watchlist if it was there

      const msg = pmBuildOpenMessage(sym, data.assetType, currentScore, reasons, atrStop, swingLow);
      if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);

      // Only open one position per run — quality over quantity
      // Remove this break if you want multiple simultaneous positions
      break;

    } else {
      // Gates failed — check if it qualifies for watchlist
      const top5count    = data.snapshots.filter(s => s.rank <= 5).length;
      const gapToOpen    = PM.OPEN_MIN_SCORE - currentScore;
      const nearThreshold = gapToOpen <= PM.WATCH_MAX_SCORE_BELOW_OPEN;

      if (nearThreshold && top5count >= PM.WATCH_TOP5_MIN && currentScore >= PM.WATCH_MIN_SCORE) {
        const watchReason = gatesFailed.length > 0
          ? `Near OPEN: ${gatesFailed[0]}`
          : `Score ${round2(currentScore)} — monitoring`;
        await pmUpsertWatchlist(sym, data.assetType, currentScore, watchReason);
        log(`PM: 👀 WATCHLIST ${sym} — ${watchReason}`);
      }
    }
  }

  // ── 5. SUNDAY WEEKLY REVIEW ──
  const dayOfWeek = new Date().getUTCDay(); // 0 = Sunday
  if (dayOfWeek === 0) {
    const updatedPositions = await pmGetOpenPositions();
    const updatedWatchlist = await pmGetWatchlist();
    const marketCtx = {
      btc: STATE.btcRegime  || 'UNKNOWN',
      qqq: STATE.qqqRegime  || 'UNKNOWN',
    };
    const reviewMsg = pmBuildWeeklyReview(updatedPositions, updatedWatchlist, marketCtx);
    if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(reviewMsg, ENV.BLUEJAM_CHAT_ID);
    log('PM: 📊 Weekly portfolio review sent');
  }

  log('💼 Portfolio Manager complete');
}




// ============================================================
// SECTOR CLASSIFICATION
// Used for sector-risk detection and earnings proximity check
// ============================================================

const SECTOR_MAP = {
  // AI Hardware — most vulnerable to NVDA earnings ripple
  'NVDA':'AI_HW','AMD':'AI_HW','AVGO':'AI_HW','TSM':'AI_HW',
  'ASML':'AI_HW','AMAT':'AI_HW','LRCX':'AI_HW','MRVL':'AI_HW',
  'MU':'AI_HW','ARM':'AI_HW','SMCI':'AI_HW','VRT':'AI_HW',
  'ANET':'AI_HW','GEV':'AI_HW','ETN':'AI_HW',
  // AI Software
  'PLTR':'AI_SW','APP':'AI_SW','CRWV':'AI_SW','NOW':'AI_SW',
  'CRM':'AI_SW','SNOW':'AI_SW','DDOG':'AI_SW',
  // Defence
  'RTX':'DEFENCE','LMT':'DEFENCE','NOC':'DEFENCE','LHX':'DEFENCE',
  'GD':'DEFENCE','HII':'DEFENCE','KTOS':'DEFENCE','BA.L':'DEFENCE',
  'RR.L':'DEFENCE',
  // Crypto infrastructure
  'COIN':'CRYPTO_INFRA','HOOD':'CRYPTO_INFRA',
  // Space
  'RKLB':'SPACE','ASTS':'SPACE',
  // Energy / Power
  'CEG':'POWER','OKLO':'POWER','PWR':'POWER','VST':'POWER',
  'XOM':'ENERGY','CVX':'ENERGY','COP':'ENERGY','SLB':'ENERGY',
  // Healthcare
  'LLY':'HEALTH','NVO':'HEALTH','UNH':'HEALTH','ISRG':'HEALTH',
  'TMO':'HEALTH','MRK':'HEALTH','HIMS':'HEALTH',
  // Consumer / Growth
  'UBER':'GROWTH','DUOL':'GROWTH','SHOP':'GROWTH','MELI':'GROWTH',
  'NFLX':'GROWTH','RDDT':'GROWTH',
  // LSE Mining
  'RIO.L':'LSE_MINING','GLEN.L':'LSE_MINING','AAL.L':'LSE_MINING',
  'ANTO.L':'LSE_MINING','FRES.L':'LSE_MINING',
  // LSE Banks
  'HSBC.L':'LSE_BANK','BARC.L':'LSE_BANK','LLOY.L':'LSE_BANK',
  'NWG.L':'LSE_BANK','STAN.L':'LSE_BANK',
  // Crypto — by narrative
  'BTCUSDT':'CRYPTO_L1','ETHUSDT':'CRYPTO_L1','SOLUSDT':'CRYPTO_L1',
  'AVAXUSDT':'CRYPTO_L1','ADAUSDT':'CRYPTO_L1','ARBUSDT':'CRYPTO_L2',
  'OPUSDT':'CRYPTO_L2','SUIUSDT':'CRYPTO_L1','APTUSDT':'CRYPTO_L1',
  'NEARUSDT':'CRYPTO_L1','SEIUSDT':'CRYPTO_L1',
  'HYPEUSDT':'CRYPTO_DEFI','AAVEUSDT':'CRYPTO_DEFI','UNIUSDT':'CRYPTO_DEFI',
  'PENDLEUSDT':'CRYPTO_DEFI','ONDOUSDT':'CRYPTO_RWA','LDOUSDT':'CRYPTO_DEFI',
  'MKRUSDT':'CRYPTO_DEFI','ENAUSDT':'CRYPTO_DEFI',
  'TAOUSDT':'CRYPTO_AI','FETUSDT':'CRYPTO_AI','RENDERUSDT':'CRYPTO_AI',
  'LINKUSDT':'CRYPTO_INFRA','ICPUSDT':'CRYPTO_INFRA','JUPUSDT':'CRYPTO_DEFI',
  'TIAUSDT':'CRYPTO_L1','IMXUSDT':'CRYPTO_GAMING','KASUSDT':'CRYPTO_L1',
  'VIRTUALUSDT':'CRYPTO_AI','XRPUSDT':'CRYPTO_L1','BNBUSDT':'CRYPTO_L1',
  'DOTUSDT':'CRYPTO_L1','INJUSDT':'CRYPTO_DEFI',
};

// Detect sector concentration — when 3+ assets in same sector
// score highly in the same scan, flag as sector-risk not single signals
function detectSectorRisk(candidates) {
  const sectorCounts = new Map();
  const sectorAssets = new Map();
  for (const c of candidates) {
    if (c.finalScore < 65) continue;
    const sector = SECTOR_MAP[c.symbol];
    if (!sector) continue;
    sectorCounts.set(sector, (sectorCounts.get(sector) || 0) + 1);
    if (!sectorAssets.has(sector)) sectorAssets.set(sector, []);
    sectorAssets.get(sector).push(c.symbol);
  }
  const riskySectors = [];
  for (const [sector, count] of sectorCounts.entries()) {
    if (count >= 3) {
      riskySectors.push({ sector, count, assets: sectorAssets.get(sector) });
    }
  }
  return riskySectors;
}

// Fetch earnings date from Finnhub
// Returns days until next earnings, or null if unknown
async function getDaysToEarnings(symbol) {
  if (!ENV.FINNHUB_API_KEY) return null;
  // Only for US stocks
  if (symbol.endsWith('USDT') || symbol.endsWith('.L')) return null;
  try {
    const from = new Date().toISOString().slice(0,10);
    const to   = new Date(Date.now() + 14*86400000).toISOString().slice(0,10);
    const url  = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${symbol}&token=${ENV.FINNHUB_API_KEY}`;
    const data = await httpGet(url);
    const earns = data?.earningsCalendar;
    if (!earns?.length) return null;
    const next = new Date(earns[0].date).getTime();
    const days = Math.ceil((next - Date.now()) / 86400000);
    return days >= 0 ? days : null;
  } catch { return null; }
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

  const sym   = candidate.symbol;
  const score = candidate.finalScore;
  const assetType = candidate.assetType || 'us';

  // ── REGIME GATE ───────────────────────────────────────────
  // Only fire BUY when both BTC and QQQ are confirmed bullish.
  // Choppy/bearish markets produce false signals regardless of score.
  const btcBull = STATE.btcRegime === 'BULL';
  const qqqBull = STATE.qqqRegime === 'BULL' && !STATE.qqqRegimeStale;
  const cryptoOnly = sym.endsWith('USDT');

  if (cryptoOnly && !btcBull) {
    log(`🚫 ${sym} BUY suppressed — BTC regime is ${STATE.btcRegime} (need BULL)`);
    return;
  }
  if (!cryptoOnly && !btcBull && !qqqBull) {
    log(`🚫 ${sym} BUY suppressed — BTC=${STATE.btcRegime} QQQ=${STATE.qqqRegime} (need at least one BULL)`);
    return;
  }

  // ── EARNINGS PROXIMITY CHECK ──────────────────────────────
  // US stocks: if earnings within 5 days, flag as caution not buy
  let earningsDays = null;
  let earningsWarning = '';
  if (assetType === 'us') {
    earningsDays = await getDaysToEarnings(sym);
    if (earningsDays !== null && earningsDays <= 5) {
      earningsWarning = `⚠️ Earnings in ${earningsDays} day${earningsDays !== 1 ? 's' : ''} — higher risk`;
      log(`⚠️ ${sym} earnings in ${earningsDays} days — warning added to alert`);
    }
  }

  // ── TWO-SCAN CONFIRMATION GATE ────────────────────────────
  const confirmKey = sym;
  const tracker    = STATE.buyConfirmTracker.get(confirmKey);
  const buyThreshold = CONFIG.THRESHOLDS.hunterScoreGood;

  if (!tracker || tracker.lastCycleSeen !== STATE.cycleCount - 1) {
    STATE.buyConfirmTracker.set(confirmKey, {
      firstSeenCycle:    STATE.cycleCount,
      firstSeenScore:    score,
      consecutiveCycles: 1,
      lastCycleSeen:     STATE.cycleCount,
      earningsDays,
    });
    log(`⏳ ${sym} crossed BUY threshold (score ${round2(score)}) — awaiting 2nd-cycle confirmation`);
    return;
  }

  tracker.consecutiveCycles++;
  tracker.lastCycleSeen = STATE.cycleCount;
  if (tracker.consecutiveCycles < 2) return;

  log(`✅ ${sym} confirmed for ${tracker.consecutiveCycles} consecutive cycles — proceeding to alert`);
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
                   : candidate.finalScore >= CONFIG.THRESHOLDS.hunterScoreGood  ? 'OPEN'
                   : 'WATCH';
  if (!checkAndSetFingerprint(candidate.symbol, signalType, stage, 'fireAlert')) {
    return;
  }

  let msg = buildHunterAlert(candidate, scan);
  if (!msg) {
    log(`🚫 Alert build returned null for ${candidate.symbol} — send suppressed`);
    return;
  }

  // Append earnings warning if within 5 days
  if (earningsWarning) {
    msg = msg + `\n\n${earningsWarning}`;
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
  lines.push(`⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`);
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

  // Leaderboard Telegram output suppressed — replaced by weekly report.
  // Still writes to hunter_leaderboard_history for analytics.
  log('📊 Leaderboard snapshot written (Telegram suppressed — weekly report mode)');
}

async function fireNoTradeMessage(scan) {
  // No-trade Telegram suppressed — weekly report mode.
  log('📭 No trade message suppressed (weekly report mode)');
}

// ============================================================

// ============================================================
// WEEKLY LEAGUE TABLE
// Fires every Friday. One combined message — all markets.
// Shows top 10 by avg score this week with position movement
// vs last week (⏫ moved up / ⏬ moved down / — no change).
// ============================================================

async function fireWeeklyLeagueTable() {
  if (!supabase) return;
  log('📅 Building weekly league table...');

  try {
    const now      = new Date();
    const dateStr  = now.toISOString().slice(0, 10);

    // This week and last week windows
    const thisWeekStart = new Date(Date.now() - 7  * 86400000).toISOString();
    const lastWeekStart = new Date(Date.now() - 14 * 86400000).toISOString();

    // Fetch last 14 days so we can compare weeks
    const { data, error } = await supabase
      .from('hunter_leaderboard_history')
      .select('symbol, asset_type, score, snapshot_id, snapshot_time')
      .gte('snapshot_time', lastWeekStart)
      .order('snapshot_time', { ascending: true });

    if (error || !data?.length) {
      log('⚠️  Weekly league table: no data');
      return;
    }

    // Split into this week vs last week rows
    const thisWeekRows = data.filter(r => r.snapshot_time >= thisWeekStart);
    const lastWeekRows = data.filter(r => r.snapshot_time <  thisWeekStart);

    // Build avg score per symbol per week
    function buildAvgScores(rows) {
      const map = new Map();
      for (const row of rows) {
        if (!map.has(row.symbol)) {
          map.set(row.symbol, { symbol: row.symbol, assetType: row.asset_type, scores: [] });
        }
        map.get(row.symbol).scores.push(parseFloat(row.score));
      }
      // Convert to avg score entries
      const entries = [];
      for (const [, d] of map.entries()) {
        if (d.scores.length < 2) continue;
        const avg = round2(d.scores.reduce((a,b)=>a+b,0)/d.scores.length);
        entries.push({ symbol: d.symbol, assetType: d.assetType, avg });
      }
      return entries.sort((a,b) => b.avg - a.avg);
    }

    const thisWeek = buildAvgScores(thisWeekRows);
    const lastWeek = buildAvgScores(lastWeekRows);

    if (!thisWeek.length) {
      log('⚠️  Weekly league table: no this-week data');
      return;
    }

    // Build last week position lookup
    const lastWeekPos = new Map();
    lastWeek.forEach((e, i) => lastWeekPos.set(e.symbol, i + 1));

    // Top 10 this week
    const top10 = thisWeek.slice(0, 10);

    // Movement emoji
    function movement(symbol, thisPos) {
      const lastPos = lastWeekPos.get(symbol);
      if (lastPos == null) return '🆕'; // not in last week's data
      const diff = lastPos - thisPos;   // positive = moved up
      if (diff >= 3)  return '⏫';
      if (diff >= 1)  return '🔼';
      if (diff === 0) return '—';
      if (diff >= -2) return '🔽';
      return '⏬';
    }

    const flagFor = t => t === 'crypto' ? '🪙' : t === 'lse' ? '🇬🇧' : '🇺🇸';

    // ── THIS WEEK TOP 10 ──────────────────────────────────────
    const lines = [
      `🏹 BARETRADESIGNALS LEAGUE TABLE`,
      `${dateStr}  ·  All markets combined`,
      ``,
      `Pos  Asset         Score   Move`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ];

    top10.forEach((e, i) => {
      const pos    = `${i+1}.`.padEnd(4);
      const flag   = flagFor(e.assetType);
      const label  = e.symbol.replace('USDT','').padEnd(7);
      const score  = `[${e.avg}]`.padEnd(8);
      const move   = movement(e.symbol, i+1);
      lines.push(`${pos} ${flag} ${label} ${score} ${move}`);
    });

    // ── BIGGEST MOVERS THIS WEEK ──────────────────────────────
    // Assets that moved up or down the most vs last week
    const movers = thisWeek
      .slice(0, 20) // look at top 20
      .map((e, i) => {
        const lastPos = lastWeekPos.get(e.symbol);
        if (lastPos == null) return null;
        return { ...e, thisPos: i+1, lastPos, diff: lastPos - (i+1) };
      })
      .filter(Boolean);

    const biggestUp   = [...movers].sort((a,b) => b.diff - a.diff).slice(0,3).filter(m => m.diff > 0);
    const biggestDown = [...movers].sort((a,b) => a.diff - b.diff).slice(0,3).filter(m => m.diff < 0);

    if (biggestUp.length || biggestDown.length) {
      lines.push(``, `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    }

    if (biggestUp.length) {
      lines.push(`⏫ BIGGEST MOVERS UP`);
      biggestUp.forEach(m => {
        const label = m.symbol.replace('USDT','');
        lines.push(`${flagFor(m.assetType)} ${label}  #${m.lastPos} → #${m.thisPos}  (+${m.diff} places)`);
      });
    }

    if (biggestDown.length) {
      lines.push(``, `⏬ BIGGEST MOVERS DOWN`);
      biggestDown.forEach(m => {
        const label = m.symbol.replace('USDT','');
        lines.push(`${flagFor(m.assetType)} ${label}  #${m.lastPos} → #${m.thisPos}  (${m.diff} places)`);
      });
    }

    // New entries this week
    const newEntrants = top10.filter(e => !lastWeekPos.has(e.symbol));
    if (newEntrants.length) {
      lines.push(``, `🆕 NEW IN TOP 10`);
      newEntrants.forEach(e => {
        lines.push(`${flagFor(e.assetType)} ${e.symbol.replace('USDT','')}  — not ranked last week`);
      });
    }

    // ── FAST MOVERS OUTSIDE TOP 10 ──────────────────────────
    // Assets ranked 11-30 this week with strong upward momentum
    // vs last week. These are the ones to watch.
    const fastMovers = thisWeek
      .slice(10, 30) // positions 11-30
      .map((e, i) => {
        const thisPos = i + 11;
        const lastPos = lastWeekPos.get(e.symbol);
        if (lastPos == null) return null;
        const diff = lastPos - thisPos; // positive = moving up
        return { ...e, thisPos, lastPos, diff };
      })
      .filter(m => m && m.diff >= 4) // moved up 4+ places
      .sort((a, b) => b.diff - a.diff)
      .slice(0, 5);

    // Also catch assets with rapidly rising avg score this week
    // (new entrants outside top 10 that weren't ranked last week)
    const newHotEntrants = thisWeek
      .slice(10, 25)
      .filter(e => !lastWeekPos.has(e.symbol) && e.avg >= 58)
      .slice(0, 3);

    if (fastMovers.length || newHotEntrants.length) {
      lines.push(``, `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`👀 WATCH LIST — MOVING FAST OUTSIDE TOP 10`);
      lines.push(`These aren't leading yet but are climbing quickly.`);
      lines.push(``);

      fastMovers.forEach(m => {
        const label = m.symbol.replace('USDT','');
        const flag  = flagFor(m.assetType);
        lines.push(`${flag} ${label}  #${m.lastPos} → #${m.thisPos}  ⏫ +${m.diff} places  [${m.avg}]`);
      });

      newHotEntrants.forEach(e => {
        const label = e.symbol.replace('USDT','');
        const flag  = flagFor(e.assetType);
        lines.push(`${flag} ${label}  🆕 New  [${e.avg}]  — wasn't ranked last week`);
      });
    }

    lines.push(``, `——————————`);
    lines.push(`⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`);
    lines.push(`📸 @baretradesignals 🏹`);

    const msg = lines.join('\n');
    if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
    log('📅 Weekly league table sent');

  } catch (err) {
    log(`⚠️  Weekly league table error: ${err.message}`);
  }
}

// WEEKLY REPORT — Hunter Universe (all tracked assets)
// Fires every Friday 11:00–13:00 UTC (12:00–14:00 BST).
// League table: biggest climbers, fallers, most consistent,
// new entrants, dropouts. Built from hunter_leaderboard_history.
// ============================================================

async function fireHunterWeeklyReport() {
  if (!supabase) { log('⚠️  Hunter weekly report skipped — no Supabase'); return; }
  log('📅 Building Hunter weekly report...');

  // Use the current CORE lists — same as what Hunter scans
  const REPORT_UNIVERSE = new Set([
    ...CORE_CRYPTO,
    ...CORE_US_STOCKS,
    ...CORE_LSE_STOCKS,
  ]);

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: allRows, error } = await supabase
    .from('hunter_leaderboard_history')
    .select('symbol, asset_type, rank, score, snapshot_id, snapshot_time')
    .gte('snapshot_time', since)
    .order('snapshot_time', { ascending: true });

  if (error || !allRows?.length) {
    log(`⚠️  Hunter weekly report: no data`);
    return;
  }

  const rows = allRows.filter(r => REPORT_UNIVERSE.has(r.symbol));
  if (!rows.length) { log('⚠️  Hunter weekly report: no universe rows found'); return; }

  const snapshotIds    = [...new Set(rows.map(r => r.snapshot_id))];
  const totalSnapshots = snapshotIds.length;
  const firstSnapshot  = snapshotIds[0];
  const lastSnapshot   = snapshotIds[snapshotIds.length - 1];

  // Build per-symbol stats
  const symbolMap = new Map();
  for (const row of rows) {
    if (!symbolMap.has(row.symbol)) {
      symbolMap.set(row.symbol, {
        symbol: row.symbol, assetType: row.asset_type,
        scores: [], ranks: [],
        top5count: 0, firstScore: null, lastScore: null,
        firstRank: null, lastRank: null,
      });
    }
    const d = symbolMap.get(row.symbol);
    d.scores.push(parseFloat(row.score));
    d.ranks.push(row.rank);
    if (row.rank <= 5) d.top5count++;
    if (row.snapshot_id === firstSnapshot) { d.firstScore = parseFloat(row.score); d.firstRank = row.rank; }
    if (row.snapshot_id === lastSnapshot)  { d.lastScore  = parseFloat(row.score); d.lastRank  = row.rank; }
  }

  const assets = [...symbolMap.values()].filter(d => d.scores.length >= 2);
  const avgScore = d => round2(d.scores.reduce((a,b)=>a+b,0)/d.scores.length);
  const weekDelta = d => (d.lastScore != null && d.firstScore != null) ? round2(d.lastScore - d.firstScore) : 0;

  // ── COMBINED TOP 10 — ranked by avg score this week, all markets ──
  // This is the main table — what you actually want to look at
  const top10 = assets
    .filter(d => d.lastScore != null)
    .sort((a, b) => {
      // Blend avg score + weekly trend (reward consistency + direction)
      const scoreA = avgScore(a) * 0.6 + weekDelta(a) * 2;
      const scoreB = avgScore(b) * 0.6 + weekDelta(b) * 2;
      return scoreB - scoreA;
    })
    .slice(0, 10);

  // ── CLIMBERS & FALLERS — biggest weekly score movement ──
  const withDelta = assets
    .filter(d => d.firstScore != null && d.lastScore != null)
    .map(d => ({ ...d, delta: weekDelta(d) }));
  const climbers = [...withDelta].sort((a,b) => b.delta - a.delta).slice(0, 3);
  const fallers  = [...withDelta].sort((a,b) => a.delta - b.delta).slice(0, 3);

  // Market breadth
  const improved   = assets.filter(d => weekDelta(d) > 0).length;
  const breadthPct = assets.length > 0 ? Math.round((improved / assets.length) * 100) : 0;
  const avgAll     = assets.length ? round2(assets.reduce((s,d)=>s+avgScore(d),0)/assets.length) : 0;
  const structure  = avgAll >= 65 ? 'Strong' : avgAll >= 55 ? 'Moderate' : 'Weak';

  const dateStr = new Date().toISOString().slice(0, 10);
  const btcStr  = STATE.btcRegime === 'BULL' ? '🟢 BULL' : STATE.btcRegime === 'BEAR' ? '🔴 BEAR' : '🟡 NEUTRAL';
  const qqqStr  = STATE.qqqRegimeStale ? '⚪ CLOSED' : STATE.qqqRegime === 'BULL' ? '🟢 BULL' : STATE.qqqRegime === 'BEAR' ? '🔴 BEAR' : '🟡 NEUTRAL';

  const flagFor  = t => t === 'crypto' ? '🪙' : t === 'lse' ? '🇬🇧' : '🇺🇸';
  const trendStr = d => {
    const delta = weekDelta(d);
    if (delta >= 3)  return `▲ +${delta}`;
    if (delta >= 0)  return `→ +${delta}`;
    if (delta >= -3) return `▼ ${delta}`;
    return `▼▼ ${delta}`;
  };
  const persistStr = d => {
    const pct = Math.round((d.top5count / totalSnapshots) * 100);
    return pct >= 60 ? '🔥' : pct >= 30 ? '📈' : '➡️';
  };

  const lines = [
    `🏹 WEEKLY MOMENTUM TABLE`,
    `Week ending ${dateStr} · ${totalSnapshots} scans`,
    ``,
    `BTC ${btcStr}  ·  QQQ ${qqqStr}`,
    `Market structure: ${structure} · Breadth: ${breadthPct}%`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `TOP 10 — ALL MARKETS`,
    ``,
  ];

  top10.forEach((d, i) => {
    const label = d.symbol.replace('USDT','').padEnd(7);
    const flag  = flagFor(d.assetType);
    const trend = trendStr(d);
    const pers  = persistStr(d);
    lines.push(`${i+1}. ${flag} ${label} ${pers} ${trend}  [${avgScore(d)}]`);
  });

  lines.push(``, `━━━━━━━━━━━━━━━━━━`);
  lines.push(`📈 BIGGEST CLIMBERS THIS WEEK`);
  climbers.filter(d => d.delta > 0).forEach(d => {
    lines.push(`${flagFor(d.assetType)} ${d.symbol.replace('USDT','')} ▲ +${d.delta} pts`);
  });

  lines.push(``);
  lines.push(`📉 BIGGEST FALLERS THIS WEEK`);
  fallers.filter(d => d.delta < 0).forEach(d => {
    lines.push(`${flagFor(d.assetType)} ${d.symbol.replace('USDT','')} ▼ ${d.delta} pts`);
  });

  lines.push(``, `━━━━━━━━━━━━━━━━━━`);
  lines.push(`Legend: 🔥 Top-5 >60% of week  📈 Building  ➡️ Steady`);
  lines.push(`[score] = avg Hunter score this week`);
  lines.push(`▲/▼ = score change Mon→Fri`);
  lines.push(``, `——————————`);
  lines.push(`⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`);
  lines.push(`📸 @baretradesignals 🏹`);

  const msg = lines.join('\n');
  if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
  log('📅 Hunter weekly momentum table sent');
}

// ============================================================
// MONTHLY REPORT — Hunter Universe
// Fires 1st of each month. Sources directly from production.
// ============================================================

async function fireHunterMonthlyReport() {
  if (!supabase) { log('⚠️  Monthly report skipped — no Supabase'); return; }
  log('📅 Building Hunter monthly report...');

  // Use current CORE lists — same as what Hunter scans
  const REPORT_CRYPTO   = CORE_CRYPTO;
  const REPORT_US       = CORE_US_STOCKS;
  const REPORT_LSE      = CORE_LSE_STOCKS;
  const REPORT_UNIVERSE = new Set([...REPORT_CRYPTO, ...REPORT_US, ...REPORT_LSE]);

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: allRows, error } = await supabase
    .from('hunter_leaderboard_history')
    .select('symbol, asset_type, rank, score, snapshot_id, snapshot_time')
    .gte('snapshot_time', since)
    .order('snapshot_time', { ascending: true });

  if (error || !allRows || allRows.length === 0) {
    log(`⚠️  Monthly report: no data (${error?.message || 'empty'})`);
    return;
  }

  const rows = allRows.filter(r => REPORT_UNIVERSE.has(r.symbol));
  if (rows.length === 0) { log('⚠️  Monthly report: no fixed-universe rows'); return; }

  const allSnapshots   = new Set(rows.map(r => r.snapshot_id));
  const totalSnapshots = allSnapshots.size;
  const snapshotIds    = [...allSnapshots];
  const firstSnapshot  = snapshotIds[0];
  const lastSnapshot   = snapshotIds[snapshotIds.length - 1];

  const symbolMap = new Map();
  for (const row of rows) {
    if (!symbolMap.has(row.symbol)) {
      symbolMap.set(row.symbol, {
        symbol: row.symbol, assetType: row.asset_type,
        ranks: [], scores: [],
        top5count: 0, rank1count: 0,
        firstScore: null, lastScore: null,
      });
    }
    const d = symbolMap.get(row.symbol);
    d.ranks.push(row.rank);
    d.scores.push(parseFloat(row.score));
    if (row.rank <= 5)  d.top5count++;
    if (row.rank === 1) d.rank1count++;
    if (row.snapshot_id === firstSnapshot && d.firstScore === null) d.firstScore = parseFloat(row.score);
    if (row.snapshot_id === lastSnapshot)  d.lastScore = parseFloat(row.score);
  }

  const assets     = [...symbolMap.values()].filter(d => d.ranks.length >= 5);
  const avgRankFn  = d => d.ranks.reduce((a,b)=>a+b,0)/d.ranks.length;
  const avgScoreFn = d => d.scores.reduce((a,b)=>a+b,0)/d.scores.length;

  // Rankings
  const byPersistence = [...assets].sort((a,b) => b.top5count - a.top5count);
  const byAvgRank     = [...assets].sort((a,b) => avgRankFn(a) - avgRankFn(b));
  const champion      = byAvgRank[0];

  // Score trend — top improvers and fallers over the month
  const withTrend = assets
    .filter(d => d.firstScore !== null && d.lastScore !== null)
    .map(d => ({ ...d, trend: round2(d.lastScore - d.firstScore) }))
    .sort((a,b) => b.trend - a.trend);
  const topRisers  = withTrend.slice(0, 3);
  const topFallers = [...withTrend].sort((a,b) => a.trend - b.trend).slice(0, 3);

  // Capital rotation
  const mid = Math.floor(snapshotIds.length / 2);
  const firstHalfIds  = new Set(snapshotIds.slice(0, mid));
  const secondHalfIds = new Set(snapshotIds.slice(mid));
  const rotatingIn = [], rotatingOut = [];
  for (const d of assets) {
    const fa = rows.filter(r => r.symbol===d.symbol && firstHalfIds.has(r.snapshot_id));
    const sa = rows.filter(r => r.symbol===d.symbol && secondHalfIds.has(r.snapshot_id));
    if (!fa.length || !sa.length) continue;
    const fAvg = fa.reduce((s,r)=>s+parseFloat(r.score),0)/fa.length;
    const sAvg = sa.reduce((s,r)=>s+parseFloat(r.score),0)/sa.length;
    const delta = sAvg - fAvg;
    if (delta > 4)       rotatingIn.push({ symbol: d.symbol, delta: round2(delta) });
    else if (delta < -4) rotatingOut.push({ symbol: d.symbol, delta: round2(delta) });
  }
  rotatingIn.sort((a,b) => b.delta - a.delta);
  rotatingOut.sort((a,b) => a.delta - b.delta);

  // Market stats
  const avgScoreAll   = assets.length ? round2(assets.reduce((s,d)=>s+avgScoreFn(d),0)/assets.length) : 0;
  const breadthPct    = assets.length ? Math.round(withTrend.filter(d=>d.trend>0).length/assets.length*100) : 0;
  const marketStr     = avgScoreAll >= 65 ? 'Strong' : avgScoreAll >= 55 ? 'Moderate' : 'Weak';
  const topPersist    = champion ? round2((champion.top5count/totalSnapshots)*100) : 0;
  const confScore     = Math.round((breadthPct*0.4)+(topPersist*0.4)+(avgScoreAll*0.2));
  const hunterConf    = confScore >= 65 ? 'HIGH' : confScore >= 45 ? 'MEDIUM' : 'LOW';

  // Planner guidance — monthly
  const plannerIncrease = rotatingIn.slice(0,3).map(x=>x.symbol.replace('USDT',''));
  const plannerReduce   = rotatingOut.slice(0,3).map(x=>x.symbol.replace('USDT',''));
  const plannerMaintain = byPersistence
    .map(d=>d.symbol.replace('USDT',''))
    .filter(s=>!plannerIncrease.includes(s)&&!plannerReduce.includes(s))
    .slice(0,4);

  const now     = new Date();
  const dateStr = now.toISOString().slice(0,7); // YYYY-MM
  const qqqStr  = STATE.qqqRegimeStale ? '⚪ CLOSED' : STATE.qqqRegime==='BULL'?'🟢 BULL':STATE.qqqRegime==='BEAR'?'🔴 BEAR':'🟡 NEUTRAL';
  const btcStr  = STATE.btcRegime==='BULL'?'🟢 BULL':STATE.btcRegime==='BEAR'?'🔴 BEAR':'🟡 NEUTRAL';

  // PART 1 — MONTHLY INTELLIGENCE
  const part1 = [
    `🏹 HUNTER MONTHLY REPORT`,
    `PART 1 — MARKET INTELLIGENCE`,
    `${dateStr} · ${totalSnapshots} snapshots · 30 days`,
    ``,
    `📊 QQQ: ${qqqStr}   ₿ BTC: ${btcStr}`,
    `🔍 Hunter Confidence: ${hunterConf}`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `🏛 MONTHLY CHAMPION`,
    ``,
  ];

  if (champion) {
    part1.push(`👑 ${champion.symbol.replace('USDT','')} — avg rank ${round2(avgRankFn(champion))}`);
    part1.push(`🥇 #1 Finishes: ${champion.rank1count}`);
    part1.push(`🔥 Top 5: ${champion.top5count}/${totalSnapshots} snapshots`);
    part1.push(`⭐ Avg Score: ${round2(avgScoreFn(champion))}`);
  }

  part1.push(``, `━━━━━━━━━━━━━━━━━━`, `📊 MONTHLY LEAGUE TABLE`, ``);
  part1.push(`🔥 Most Persistent (Top 5):`);
  byPersistence.slice(0,5).forEach(d => {
    const pct = Math.round((d.top5count/totalSnapshots)*100);
    part1.push(`   ${d.symbol.replace('USDT','').padEnd(8)} ${pct}%  avg ⭐${round2(avgScoreFn(d))}`);
  });

  part1.push(``, `📈 Biggest Monthly Risers:`);
  topRisers.forEach(d => part1.push(`   ${d.symbol.replace('USDT','').padEnd(8)} +${d.trend}`));

  part1.push(``, `📉 Biggest Monthly Fallers:`);
  topFallers.forEach(d => part1.push(`   ${d.symbol.replace('USDT','').padEnd(8)} ${d.trend}`));

  part1.push(``, `━━━━━━━━━━━━━━━━━━`, `🌊 CAPITAL ROTATION`, ``);
  if (rotatingIn.length)  part1.push(`🔼 Rotating In:  ${rotatingIn.map(x=>x.symbol.replace('USDT','')).join('  ')}`);
  if (rotatingOut.length) part1.push(`🔽 Rotating Out: ${rotatingOut.map(x=>x.symbol.replace('USDT','')).join('  ')}`);

  part1.push(``, `━━━━━━━━━━━━━━━━━━`, `📊 MARKET STRUCTURE`, ``);
  part1.push(`Structure: ${marketStr}`);
  part1.push(`Breadth: ${breadthPct}% of assets improved over 30 days`);
  part1.push(`Avg Score: ${avgScoreAll}`);

  part1.push(``, `——————————`);
  part1.push(`⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`);
  part1.push(``, `📸 Analysis by @baretradesignals 🏹`);

  // PART 2 — MONTHLY PLANNER GUIDANCE
  const part2 = [
    `🏹 HUNTER MONTHLY REPORT`,
    `PART 2 — PLANNER GUIDANCE`,
    ``,
    `Hunter Confidence: ${hunterConf}`,
    `Hunter Flow Weight: 30%`,
    `Data: ${totalSnapshots} snapshots over 30 days`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `🔼 Increase Hunter Flow Score:`,
  ];
  if (plannerIncrease.length) plannerIncrease.forEach(s => part2.push(`• ${s}`));
  else part2.push(`• None this month`);

  part2.push(``, `➡️ Maintain Hunter Flow Score:`);
  if (plannerMaintain.length) plannerMaintain.forEach(s => part2.push(`• ${s}`));
  else part2.push(`• Hold all current scores`);

  part2.push(``, `🔽 Reduce Hunter Flow Score:`);
  if (plannerReduce.length) plannerReduce.forEach(s => part2.push(`• ${s}`));
  else part2.push(`• None this month`);

  part2.push(
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `Monthly data is more reliable than weekly.`,
    `Only increase conviction when Narrative + Technical also agree.`,
    ``,
    `——————————`,
    `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
    ``,
    `📸 Analysis by @baretradesignals 🏹`,
  );

  const msg1 = part1.join('\n');
  const msg2 = part2.join('\n');

  if (ENV.BLUEJAM_CHAT_ID) {
    await sendTelegram(msg1, ENV.BLUEJAM_CHAT_ID);
    await new Promise(r => setTimeout(r, 2000));
    await sendTelegram(msg2, ENV.BLUEJAM_CHAT_ID);
  }
  if (ENV.HUNTER_LIVE && ENV.CHANNEL_CHAT_ID) {
    await sendTelegram(msg1, ENV.CHANNEL_CHAT_ID);
    await new Promise(r => setTimeout(r, 2000));
    await sendTelegram(msg2, ENV.CHANNEL_CHAT_ID);
  }
  log('📅 Hunter monthly report sent (Part 1 + Part 2)');
}


// ============================================================
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
      id:                  `alert_${candidate.symbol}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
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
    `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
    ``,
    `📸 Analysis by @baretradesignals 🏹`,
  ];

  // Outcome alerts suppressed — weekly report mode.
  // Outcomes still tracked in hunter_alerts for analytics.
  log(`📬 Outcome recorded: ${alert.symbol} ${outcomeType} (${resultStr}) — Telegram suppressed`);
}

async function trackOutcomes() {
  if (!supabase) return;
  try {
    const { data: pending, error } = await supabase
      .from('hunter_alerts')
      .select('*')
      .eq('outcome_checked', false)
      .gte('created_at', new Date(Date.now() - 259200000).toISOString()); // 72h window

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

        // Use all candles since alert creation — not just last 20.
        // 20-candle lookback was missing MFE on trades that moved later.
        const alertTime   = new Date(alert.created_at).getTime();
        const sinceTrade  = candles.filter(c => new Date(c.time || c.timestamp || c.t || 0).getTime() >= alertTime);
        const lookback    = sinceTrade.length >= 2 ? sinceTrade : candles; // fallback if time field missing
        const recentHighs = lookback.map((c) => c.high);
        const recentLows  = lookback.map((c) => c.low);
        const mfe = Math.max(...recentHighs);
        const mae = Math.min(...recentLows);

        const target1Hit  = mfe >= alert.t1_price;
        const target2Hit  = mfe >= alert.t2_price;
        const stoppedOut  = mae <= alert.stop_price;
        const maxGainPct  = ((mfe - alert.entry_price) / alert.entry_price) * 100;
        const maxLossPct  = ((mae - alert.entry_price) / alert.entry_price) * 100;

        // Only close on terminal outcome: TP2 hit, stopped out, or 24h expired.
        // TP1 keeps monitoring — trade still open for TP2.
        const shouldClose = ageMin >= 1440 || target2Hit || stoppedOut;

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

      {
        // Sector risk check — warn if 3+ assets in same sector scoring high
        const sectorRisks = detectSectorRisk(scan.candidates || []);
        for (const risk of sectorRisks) {
          const riskKey = `sector_risk_${risk.sector}_${new Date().toISOString().slice(0,10)}`;
          if (!STATE.sectorRiskSent) STATE.sectorRiskSent = new Set();
          if (!STATE.sectorRiskSent.has(riskKey)) {
            STATE.sectorRiskSent.add(riskKey);
            const sectorMsg = [
              `🔍 CLUSTER SIGNAL — ${risk.sector.replace(/_/g,' ')}`,
              ``,
              `${risk.count} assets in the same sector are all scoring 65+ right now.`,
              `${risk.assets.map(s => s.replace('USDT','')).join(' · ')}`,
              ``,
              `When a whole sector moves together it's usually a macro event,`,
              `earnings catalyst, or rotation — not individual setups.`,
              `Pick the strongest one. Don't spread across all of them.`,
              ``,
              `——————————`,
    `⚠️ BareTradeSignals provides educational market analysis only. Not financial advice. Not a recommendation to buy or sell. Always do your own research. Capital at risk.`,
              `${DISCLAIMER}`,
              `📸 @baretradesignals 🏹`,
            ].join('\n');
            if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(sectorMsg, ENV.BLUEJAM_CHAT_ID);
            log(`⚠️ Sector risk alert sent: ${risk.sector} (${risk.count} assets)`);
          }
        }

        await fireAlert(best, scan);
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
    // Daily leaderboard messages
    {
      const _dh  = new Date().getUTCHours();
      const _dm  = new Date().getUTCMinutes();
      const _dd  = new Date().toISOString().slice(0,10);
      const _day = new Date().getUTCDay(); // 0=Sun, 6=Sat — defined here for weekend guards below

       // Morning brief — 08:00 UTC daily (all markets, crypto always, stocks when open)
       if (_dh === 8 && _dm < 5) {
         const _mk = `daily_morning_${_dd}`;
         let _sent = false;
         if (supabase) { try { const {data:_d} = await supabase.from('hunter_calibration').select('id').eq('id',_mk).single(); _sent=!!_d; } catch {} }
         if (!_sent) {
           await loadSniperRegimes();
           await fireCombinedBrief('morning');
           if (supabase) { try { await supabase.from('hunter_calibration').upsert({id:_mk,recorded_at:new Date().toISOString(),top_score:0,top_symbol:'DAILY_MORNING',field_avg:0,candidate_count:0,btc_regime:STATE.btcRegime,qqq_regime:STATE.qqqRegime,market_open_count:0,buy_count:0,watch_count:0}); } catch {} }
         }
       }
       // Evening brief — 21:30 UTC daily (after US close, full picture)
       // Weekends: crypto only, stocks show last known position
       if (_dh === 21 && _dm >= 30 && _dm < 35) {
         const _ek = `daily_evening_${_dd}`;
         let _sent = false;
         if (supabase) { try { const {data:_d} = await supabase.from('hunter_calibration').select('id').eq('id',_ek).single(); _sent=!!_d; } catch {} }
         if (!_sent) {
           await fireCombinedBrief('evening');
           if (supabase) { try { await supabase.from('hunter_calibration').upsert({id:_ek,recorded_at:new Date().toISOString(),top_score:0,top_symbol:'DAILY_EVENING',field_avg:0,candidate_count:0,btc_regime:STATE.btcRegime,qqq_regime:STATE.qqqRegime,market_open_count:0,buy_count:0,watch_count:0}); } catch {} }
         }
       }
    }

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
        await fireLeaderboardMessage(scan); // Supabase write only — Telegram suppressed inside
        STATE.lastNoTradeTime = Date.now();
      }
    }

    // Outcome tracking (every 10 cycles)
    if (STATE.cycleCount % 10 === 0) {
      await trackOutcomes();
    }

    // Portfolio Watch — daily 09:00 UTC
    {
      const _pw = new Date();
      if (_pw.getUTCHours() === 9 && _pw.getUTCMinutes() < 5) {
        const _pwk = `pw_daily_${_pw.toISOString().slice(0,10)}`;
        let _pws = false;
        if (supabase) { try { const {data:_d} = await supabase.from('hunter_calibration').select('id').eq('id',_pwk).single(); _pws=!!_d; } catch {} }
        if (!_pws) {
          await runPortfolioManager();
          if (supabase) { try { await supabase.from('hunter_calibration').upsert({id:_pwk,recorded_at:new Date().toISOString(),top_score:0,top_symbol:'PW_SENT',field_avg:0,candidate_count:0,btc_regime:STATE.btcRegime,qqq_regime:STATE.qqqRegime,market_open_count:0,buy_count:0,watch_count:0}); } catch {} }
        }
      }
    }

    // Hunter Intelligence — every cycle (internal dedup via calibration flags)
    // Intelligence engine — divergence signals only
    // Fires once per asset per day when Hunter score is high but price hasn't moved
    const _now2       = new Date();
    const _dayOfWeek2 = _now2.getUTCDay();
    const _hour2      = _now2.getUTCHours();
    // Only run once per day mid-morning — not every scan cycle
    if (_dayOfWeek2 !== 0 && _dayOfWeek2 !== 6 && _hour2 >= 9 && _hour2 < 10) {
      try {
        const _divMap = await intelLoadFullHistory(7);
        if (_divMap.size > 0) await runDivergenceAlerts(_divMap);
      } catch (err) {
        log(`INTEL: divergence error: ${err.message}`);
      }
    }

    // Monthly report — 1st of month 11:00-13:00 UTC
    {
      const _mn = new Date();
      if (_mn.getUTCDate() === 1 && _mn.getUTCHours() >= 11 && _mn.getUTCHours() < 13) {
        const _monthKey = `monthly_report_${_mn.getUTCFullYear()}_${String(_mn.getUTCMonth()+1).padStart(2,'0')}`;
        let _monthSent = false;
        if (supabase) {
          try {
            const { data: _md } = await supabase.from('hunter_calibration').select('id').eq('id', _monthKey).single();
            _monthSent = !!_md;
          } catch { /* not found = not sent */ }
        }
        if (!_monthSent) {
          log('📅 1st of month — firing Hunter monthly report');
          // Monthly report suppressed
          if (supabase) {
            try {
              await supabase.from('hunter_calibration').upsert({
                id: _monthKey, recorded_at: new Date().toISOString(),
                top_score: 0, top_symbol: 'MONTHLY_REPORT_SENT',
                field_avg: 0, candidate_count: 0,
                btc_regime: STATE.btcRegime, qqq_regime: STATE.qqqRegime,
                market_open_count: 0, buy_count: 0, watch_count: 0,
              });
            } catch { /* best effort */ }
          }
        }
      }
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
          log('📅 Friday window — firing weekly league table');
          await fireWeeklyLeagueTable();
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
