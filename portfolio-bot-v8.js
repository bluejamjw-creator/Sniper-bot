/**
 * portfolio-bot-v8.js — PART 1 of 3
 *
 * Fixes two correctness gaps in the TP/SL-hit detection added
 * last pass, both flagged by further review and verified before
 * fixing rather than assumed:
 *
 * To deploy:
 *   cat portfolio-bot-v8.part1.js portfolio-bot-v8.part2.js \
 *       portfolio-bot-v8.part3.js > portfolio-bot-v8.js
 *
 * 1. INTRABAR HIGH/LOW, not just candle close. A real Revolut
 *    bracket order triggers the instant price touches it —
 *    checking only the 15m candle's close price could miss a
 *    stop that wicked through and recovered before the candle
 *    closed. calcFeatures() now also returns currentHigh/
 *    currentLow (previously only currentPrice/close was kept);
 *    evaluateOpenPosition() checks high>=takeProfitPrice and
 *    low<=stopLossPrice instead of currentPrice against both.
 *    Verified the current candle actually carries real high/low
 *    (not just close) before writing this, rather than assuming
 *    it did.
 *
 * 2. AMBIGUOUS same-candle handling. If a single 15m candle
 *    touches both levels, OHLC data alone can't tell which
 *    happened first — that answer only lives in Revolut's own
 *    order history, which Hunter has no access to. Recording an
 *    unqualified TP or SL in that case would be a guess dressed
 *    up as fact. Now recorded as close_reason 'AMBIGUOUS (both
 *    SL and TP touched same candle)', with the SL price used
 *    for the recorded return so anything built on top (win
 *    rate, avg return) stays conservative rather than
 *    optimistic on an unknown.
 *
 * 3. closePosition() now takes an optional exitPrice — TP/SL/
 *    ambiguous closes pass the actual triggered level (what a
 *    real fill would be), not wherever the candle's close
 *    happens to land, which can differ meaningfully from the
 *    trigger price on a wick.
 *
 * 4. Weekly report now says plainly what it measures: market
 *    price against the fixed levels set at open, NOT confirmed
 *    Revolut fills. A full manual-confirmation workflow (did you
 *    actually place each trade?) was proposed alongside this
 *    but is NOT built — it would need the bot to listen for
 *    Telegram replies, which this codebase has no
 *    infrastructure for at all (it only ever pushes messages
 *    out). That's a separate, larger feature, not something to
 *    half-build inside this pass — flagging it rather than
 *    adding a broker_execution_status column that would just
 *    sit permanently unpopulated.
 *
 * Verified before shipping: ran the intrabar tpTouched/
 *    slTouched logic through four scenarios by hand (wick-hits-
 *    SL-but-closes-fine, normal-still-open, big-candle-hits-
 *    both, clean-TP) — all four came out correct.
 */
'use strict';

/**
 * HUNTER V14.2 — crypto-only early-move discovery + learning engine
 *
 * User-facing lifecycle: OPEN -> HOLD -> CLOSE
 * Targets: +10%, +50%, +100%, +150%+
 * Universe: 120 minimum, 160 target, 200 maximum liquid USDT assets.
 *
 * IMPORTANT:
 * - No stock functionality.
 * - No execution / order placement.
 * - No invented entry/stop prices.
 * - Uses only existing Railway environment variables.
 * - Every scored asset gets a historical snapshot; snapshots are append-only.
 * - Learning labels are produced from subsequent market observations.
 * - Before enough labelled history exists, Hunter operates in bootstrap mode.
 */

const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const ENV = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  BLUEJAM_CHAT_ID: process.env.BLUEJAM_CHAT_ID || process.env.CHAT_ID,
  CHANNEL_CHAT_ID: process.env.CHANNEL_CHAT_ID,
  SUPABASE_URL: process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL,
  SUPABASE_KEY:
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY,
  COINGECKO_API_KEY: process.env.COINGECKO_API_KEY || process.env.COINGECKO_KEY,
  HUNTER_LIVE: process.env.HUNTER_LIVE === 'true',
};

const CONFIG = {
  cycleMs: 15 * 60 * 1000,

  minAssets: 120,
  targetAssets: 160,
  maxAssets: 200,

  // 520 x 15m = 130h, covering the 120h learning window with buffer.
  candleLimit: 520,
  minCandles: 60,

  batchSize: 8,
  batchPauseMs: 500,

  requestTimeoutMs: 12000,
  maxRetries: 2,

  universeRefreshMs: 30 * 60 * 1000,

  // Optional Revolut X eligibility filter. Fails open on outage.
  revolutUniverseEnabled: true,
  revolutApiUrl: 'https://revx.revolut.com/api/1.0/public/configuration/pairs',
  revolutUniverseRefreshMs: 6 * 60 * 60 * 1000,

  openCooldownMs: 6 * 60 * 60 * 1000,
  holdCooldownMs: 8 * 60 * 60 * 1000,
  reopenCooldownMs: 90 * 60 * 1000,
  closeCooldownMs: 60 * 60 * 1000,

  maxOpenPositions: 10,
  holdMinScoreImprovement: 0.05,

  openSimilarityThreshold: 0.70,
  openBootstrapScore: 0.55,
  minPositiveExamples: 20,

  creamMinScore: 70,
  creamMaxOpenPerCycle: 2,

  creamMinRet15m: 0.001,
  creamMinRet1h: 0.003,
  creamMinRet4h: 0.015,

  creamMinVolumeRatio: 2.0,
  creamMinVolumeAcceleration: 1.20,

  creamMinBuyPressure: 1.25,
  creamMinRelativeStrength: 0.01,

  creamMinBaseQuality: 0.40,
  creamMinMoveQuality: 0.55,

  // These are no longer hard 'do not alert' ceilings. They feed the
  // continuation-vs-exhaustion test below. A strong move can still qualify
  // if participation and momentum are accelerating rather than fading.
  creamMaxRet4h: 0.50,
  creamMaxRet24h: 0.60,

  creamMaxExhaustion: 0.85,
  continuationMinScore: 0.60,
  continuationMinMomentumAcceleration: 1.25,
  continuationMinVolumeAcceleration: 1.50,
  continuationMinBuyPressure: 1.50,
  continuationMinRelativeStrength: 0.02,

  // ADDED: the progressive lifecycle tier ladder (was entirely missing
  // from this deployed build). Score only ratchets a position UP through
  // these; each tier carries a soft stop (needs momentum + higher-low
  // confirmation to trigger — see evaluateOpenPosition) and a hard
  // backstop (unconditional). Percentages backtested against real
  // B3/CVC/FIL/PUNDIX/VTHO snapshot history before being added here.
  TIERS: [
    { min: 90, name: 'PARABOLIC_HOLD', soft: 0.030, hard: 0.12 },
    { min: 85, name: 'HOLD_85',        soft: 0.045, hard: 0.14 },
    { min: 80, name: 'HOLD_80',        soft: 0.060, hard: 0.16 },
    { min: 75, name: 'HOLD_75',        soft: 0.080, hard: 0.18 },
    { min: 70, name: 'OPEN_70',        soft: 0.100, hard: 0.20 },
  ],

  // ADDED: used by the BTC risk softening below — RISK-OFF now raises
  // this relative-strength bar instead of hard-blocking every candidate.
  btcSevereMinRelativeStrength: 0.03,

  // ADDED: paired with reopenCooldownMs (already deployed) so a symbol
  // can't re-open on the tail of the same swing that just stopped it
  // out — see hasScoreResetSince().
  reopenScoreResetFloor: 0.50,

  // Detection is broad; Telegram selection is narrow.
  alertMinReadiness: 55,
  alertMinSignals: 4,
  alertLearnedSimilarity: 0.55,
  alertLearnedContrast: 0.02,



  // Must cover the longest +150% learning horizon (96h)
  // plus a useful safety buffer.
  learningLookbackHours: 120,
  learningExamplesPerClass: 800,

  minQuoteVolume24h: 250000,

  horizons: {
    10: 24,
    50: 48,
    100: 72,
    150: 96,
  },

  featureNames: [
    'ret15m',
    'ret1h',
    'ret2h',
    'ret4h',
    'ret8h',
    'ret12h',
    'ret24h',
    'volumeRatio',
    'volumeAcceleration',
    'buyPressure',
    'rangeExpansion',
    'rangeCompression',
    'higherLow',
    'priceCompression',
    'relativeStrength',
    'momentumAcceleration',
    'closePosition',
    'breakoutProximity',
    'trendSlope',
    'atrPct',
    'moveAtrUnits',
    'momentumProfile',
    'volumeProfile',
    'parabolicExhaustion',
    'firstPullbackContinuation',
    'baseQuality',
  ],

  providers: [
    'bybit',
    'binance',
    'okx',
  ],
};

let supabase = null;

if (ENV.SUPABASE_URL && ENV.SUPABASE_KEY) {
  supabase = createClient(
    ENV.SUPABASE_URL,
    ENV.SUPABASE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}

const STATE = {
  cycleRunning: false,
  cycle: 0,

  universe: [],
  universeAt: 0,

  revolutBases: null,
  revolutBasesAt: 0,

  active: new Map(),

  providerHealth: new Map(),

  featureCache: new Map(),

  learning: null,
  btcRisk: null,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function pct(value) {
  return num(value) * 100;
}

function safePct(a, b) {
  return b ? (a - b) / b : 0;
}

function avg(values) {
  return values.length
    ? values.reduce((x, y) => x + y, 0) / values.length
    : 0;
}

function sum(values) {
  return (values || []).reduce((total, value) => total + num(value), 0);
}

function nowIso(date = new Date()) {
  return iso(date);
}

function median(values) {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, decimals = 4) {
  const power = 10 ** decimals;
  return Math.round(num(value) * power) / power;
}

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function baseSymbol(symbol) {
  return String(symbol)
    .replace(/USDT$/i, '')
    .toUpperCase();
}

function providerMark(name, ok, error = '') {
  const provider = STATE.providerHealth.get(name) || {
    ok: 0,
    fail: 0,
  };

  if (ok) {
    provider.ok++;
    provider.lastOk = Date.now();
  } else {
    provider.fail++;
    provider.lastFail = Date.now();
    provider.lastError = String(error);
  }

  STATE.providerHealth.set(name, provider);
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;

    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }

    const req = https.get(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Hunter/13.1 crypto-only',
          'Accept': 'application/json',
          ...headers,
        },
      },
      response => {
        let body = '';

        response.setEncoding('utf8');

        response.on('data', chunk => {
          body += chunk;
        });

        response.on('end', () => {
          const status = response.statusCode || 0;

          if (status < 200 || status >= 300) {
            const error = new Error(
              `HTTP ${status} from ${parsed.hostname}`
            );

            error.statusCode = status;
            reject(error);
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(
              new Error(
                `Invalid JSON from ${parsed.hostname}`
              )
            );
          }
        });
      }
    );

    req.on('error', reject);

    req.setTimeout(
      CONFIG.requestTimeoutMs,
      () => {
        req.destroy();
        reject(
          new Error(`Timeout ${parsed.hostname}`)
        );
      }
    );
  });
}

async function getJson(url, headers = {}) {
  let lastError;

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      return await httpGet(url, headers);
    } catch (error) {
      lastError = error;

      if (attempt < CONFIG.maxRetries) {
        await sleep(500 * (attempt + 1));
      }
    }
  }

  throw lastError;
}

// ----------------------------- Telegram -----------------------------

async function telegram(
  text,
  chatId = ENV.BLUEJAM_CHAT_ID
) {
  if (!ENV.BOT_TOKEN || !chatId) {
    return false;
  }

  const body = JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });

  return new Promise(resolve => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${ENV.BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      response => {
        let bodyText = '';

        response.on('data', chunk => {
          bodyText += chunk;
        });

        response.on('end', () => {
          resolve(
            response.statusCode >= 200 &&
            response.statusCode < 300
          );
        });
      }
    );

    req.on('error', () => resolve(false));

    req.setTimeout(
      10000,
      () => {
        req.destroy();
        resolve(false);
      }
    );

    req.write(body);
    req.end();
  });
}

async function alertUser(text) {
  if (!ENV.HUNTER_LIVE) {
    console.log(
      '[HUNTER] HUNTER_LIVE=false — alert suppressed'
    );
    return;
  }

  await telegram(
    text,
    ENV.BLUEJAM_CHAT_ID
  );

  if (ENV.CHANNEL_CHAT_ID) {
    await telegram(
      text,
      ENV.CHANNEL_CHAT_ID
    );
  }
}

// ----------------------------- Market discovery -----------------------------

async function bybitSpotTickers() {
  try {
    const data = await getJson(
      'https://api.bybit.com/v5/market/tickers?category=spot'
    );

    const list = Array.isArray(data?.result?.list)
      ? data.result.list
      : [];

    providerMark(
      'bybit-tickers',
      true
    );

    return list
      .map(item => ({
        symbol: String(item.symbol || ''),
        quoteVolume: num(item.turnover24h),
        price: num(item.lastPrice),
        change24h: num(item.price24hPcnt),
      }))
      .filter(
        item =>
          item.symbol.endsWith('USDT') &&
          item.price > 0 &&
          item.quoteVolume > 0
      );
  } catch (error) {
    providerMark(
      'bybit-tickers',
      false,
      error.message
    );

    return [];
  }
}

async function fetchRevolutTradableBases() {
  const now = Date.now();

  if (
    STATE.revolutBases &&
    now - STATE.revolutBasesAt < CONFIG.revolutUniverseRefreshMs
  ) {
    return STATE.revolutBases;
  }

  try {
    const data = await getJson(CONFIG.revolutApiUrl);

    // FIXED: this previously assumed an array response, which is why
    // the filter has been failing every cycle since deployment ("empty
    // Revolut pairs list" in the logs). The actual shape, confirmed
    // against developer.revolut.com's own documented example response,
    // is a flat object keyed by pair symbol:
    //   { "BTC/USD": { "base": "BTC", "quote": "USD", "status": "active" },
    //     "ETH/EUR": { "base": "ETH", "quote": "EUR", "status": "active" } }
    // The array-based branch is kept as a defensive fallback in case the
    // API ever wraps the response, but the primary path now matches the
    // confirmed real shape. Also now respects each pair's status field
    // so an inactive-but-still-configured pair isn't treated as
    // tradeable.
    const entries =
      Array.isArray(data)
        ? data.map(pair => [pair.symbol || pair.pair || '', pair])
        : Object.entries(data || {});

    const bases = new Set(
      entries
        .filter(([, pair]) => !pair.status || pair.status === 'active')
        .map(([key, pair]) => {
          const direct = pair.base || pair.base_currency || pair.baseCurrency;
          if (direct) return String(direct).toUpperCase();
          const split = String(key).split(/[/-]/)[0];
          return split ? split.toUpperCase() : null;
        })
        .filter(Boolean)
    );

    if (!bases.size) throw new Error('empty Revolut pairs list');

    providerMark('revolut-universe', true);
    STATE.revolutBases = bases;
    STATE.revolutBasesAt = now;
    return bases;
  } catch (error) {
    providerMark('revolut-universe', false, error.message);
    console.error(`[HUNTER] Revolut universe unavailable; filter skipped: ${error.message}`);
    return STATE.revolutBases;
  }
}

async function binanceSpotExchangeInfo() {
  try {
    const data = await getJson(
      'https://api.binance.com/api/v3/exchangeInfo'
    );

    providerMark(
      'binance-exchange',
      true
    );

    return (data?.symbols || [])
      .filter(
        item =>
          item.status === 'TRADING' &&
          item.quoteAsset === 'USDT' &&
          item.isSpotTradingAllowed !== false
      )
      .map(item => item.symbol);
  } catch (error) {
    providerMark(
      'binance-exchange',
      false,
      error.message
    );

    return [];
  }
}

async function binanceSpotTickers() {
  try {
    const data = await getJson(
      'https://api.binance.com/api/v3/ticker/24hr'
    );

    providerMark(
      'binance-tickers',
      true
    );

    return Array.isArray(data)
      ? data
          .filter(
            item =>
              String(item.symbol || '')
                .endsWith('USDT')
          )
          .map(item => ({
            symbol: String(item.symbol),
            quoteVolume: num(item.quoteVolume),
            price: num(item.lastPrice),
            change24h:
              num(item.priceChangePercent) / 100,
          }))
          .filter(
            item =>
              item.price > 0 &&
              item.quoteVolume > 0
          )
      : [];
  } catch (error) {
    providerMark(
      'binance-tickers',
      false,
      error.message
    );

    return [];
  }
}

async function discoverUniverse() {
  const bybit = await bybitSpotTickers();
  const binance = await binanceSpotTickers();

  const binanceSymbols = new Set(
    await binanceSpotExchangeInfo()
  );

  const merged = new Map();

  for (const ticker of bybit) {
    const symbol = ticker.symbol;

    merged.set(
      symbol,
      {
        symbol,
        quoteVolume: ticker.quoteVolume,
        change24h: ticker.change24h,
        bybit: true,
        binance: binanceSymbols.has(symbol),
      }
    );
  }

  for (const ticker of binance) {
    const existing = merged.get(ticker.symbol);

    if (existing) {
      existing.quoteVolume = Math.max(
        existing.quoteVolume,
        ticker.quoteVolume
      );

      existing.change24h =
        (existing.change24h +
          ticker.change24h) / 2;

      existing.binance = true;
    } else {
      merged.set(
        ticker.symbol,
        {
          symbol: ticker.symbol,
          quoteVolume: ticker.quoteVolume,
          change24h: ticker.change24h,
          bybit: false,
          binance: true,
        }
      );
    }
  }

  // Remove leveraged/synthetic products.
  const banned =
    /((UP|DOWN|BULL|BEAR)USDT$)|(^1000)/i;

  let denylist = new Set();
  if (supabase) {
    const { data: denied } = await supabase
      .from('hunter_v11_denylist')
      .select('symbol');
    denylist = new Set((denied || []).map(row => String(row.symbol).toUpperCase()));
  }

  const blockedStableBases = new Set([
    'USDC','FDUSD','TUSD','DAI','USDE','USDD','USD1','PYUSD','EUR','EURC',
  ]);

  const preRevolut = [...merged.values()]
    .filter(
      item =>
        !banned.test(item.symbol) &&
        !denylist.has(item.symbol) &&
        !blockedStableBases.has(baseSymbol(item.symbol)) &&
        item.quoteVolume >= CONFIG.minQuoteVolume24h
    );

  const revolutBases = CONFIG.revolutUniverseEnabled
    ? await fetchRevolutTradableBases()
    : null;

  const eligible = preRevolut.filter(item =>
    !revolutBases || revolutBases.has(baseSymbol(item.symbol))
  );

  if (CONFIG.revolutUniverseEnabled) {
    console.log(
      revolutBases
        ? `[HUNTER] Revolut filter: ${revolutBases.size} bases known; dropped ${preRevolut.length - eligible.length}/${preRevolut.length}`
        : '[HUNTER] Revolut filter inactive this cycle (no cached list)'
    );
  }

  const byLiquidity = [...eligible]
    .sort(
      (a, b) =>
        b.quoteVolume -
        a.quoteVolume
    );

  const byMovement = [...eligible]
    .sort((a, b) => {
      const movementA =
        Math.abs(a.change24h) *
        Math.log10(
          1 + a.quoteVolume
        );

      const movementB =
        Math.abs(b.change24h) *
        Math.log10(
          1 + b.quoteVolume
        );

      return movementB - movementA;
    });

  /*
   * Keep a broad liquid core, but deliberately reserve
   * part of the universe for assets already displaying
   * abnormal movement.
   */
  const selectedMap = new Map();

  for (
    const asset of byLiquidity.slice(0, 140)
  ) {
    selectedMap.set(
      asset.symbol,
      asset
    );
  }

  for (
    const asset of byMovement.slice(0, 80)
  ) {
    selectedMap.set(
      asset.symbol,
      asset
    );
  }

  const selected = [
    ...selectedMap.values(),
  ].slice(0, CONFIG.maxAssets);

  if (
    selected.length <
    CONFIG.minAssets
  ) {
    throw new Error(
      `Universe only ${selected.length}; minimum is ${CONFIG.minAssets}` + (revolutBases ? ` (Revolut filter active, ${revolutBases.size} bases)` : ` (Revolut filter inactive)`) 
    );
  }

  return selected;
}

// ----------------------------- Candles -----------------------------

function normaliseCandles(rows) {
  return rows
    .map(candle => ({
      time: num(candle.time),
      open: num(candle.open),
      high: num(candle.high),
      low: num(candle.low),
      close: num(candle.close),
      volume: num(candle.volume),
    }))
    .filter(
      candle =>
        candle.time &&
        candle.close > 0 &&
        candle.high >= candle.low
    )
    .sort(
      (a, b) =>
        a.time - b.time
    );
}

async function bybitCandles(
  symbol,
  limit = CONFIG.candleLimit
) {
  const url =
    `https://api.bybit.com/v5/market/kline` +
    `?category=spot` +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&interval=15` +
    `&limit=${limit}`;

  try {
    const data = await getJson(url);
    const list = data?.result?.list;

    if (
      !Array.isArray(list) ||
      !list.length
    ) {
      throw new Error('empty');
    }

    providerMark(
      'bybit',
      true
    );

    return normaliseCandles(
      list
        .map(candle => ({
          time: num(candle[0]),
          open: num(candle[1]),
          high: num(candle[2]),
          low: num(candle[3]),
          close: num(candle[4]),
          volume: num(candle[5]),
        }))
        .slice(0, -1)
    );
  } catch (error) {
    providerMark(
      'bybit',
      false,
      error.message
    );

    return null;
  }
}

async function binanceCandles(
  symbol,
  limit = CONFIG.candleLimit
) {
  const url =
    `https://api.binance.com/api/v3/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=15m` +
    `&limit=${limit}`;

  try {
    const data = await getJson(url);

    if (
      !Array.isArray(data) ||
      !data.length
    ) {
      throw new Error('empty');
    }

    providerMark(
      'binance',
      true
    );

    return normaliseCandles(
      data
        .map(candle => ({
          time: num(candle[0]),
          open: num(candle[1]),
          high: num(candle[2]),
          low: num(candle[3]),
          close: num(candle[4]),
          volume: num(candle[5]),
        }))
        .slice(0, -1)
    );
  } catch (error) {
    providerMark(
      'binance',
      false,
      error.message
    );

    return null;
  }
}

async function okxCandles(
  symbol,
  limit = CONFIG.candleLimit
) {
  const instrument =
    `${baseSymbol(symbol)}-USDT`;

  const url =
    `https://www.okx.com/api/v5/market/candles` +
    `?instId=${encodeURIComponent(instrument)}` +
    `&bar=15m` +
    `&limit=${Math.min(limit, 300)}`;

  try {
    const data = await getJson(url);

    if (
      !Array.isArray(data?.data) ||
      !data.data.length
    ) {
      throw new Error('empty');
    }

    providerMark(
      'okx',
      true
    );

    return normaliseCandles(
      data.data
        .map(candle => ({
          time: num(candle[0]),
          open: num(candle[1]),
          high: num(candle[2]),
          low: num(candle[3]),
          close: num(candle[4]),
          volume: num(candle[5]),
          confirm: candle[8],
        }))
        .filter(
          candle =>
            candle.confirm !== '0' &&
            candle.confirm !== 0
        )
    );
  } catch (error) {
    providerMark(
      'okx',
      false,
      error.message
    );

    return null;
  }
}

async function candlesFor(symbol) {
  for (const provider of CONFIG.providers) {
    let candles = null;

    if (provider === 'bybit') {
      candles =
        await bybitCandles(symbol);
    }

    if (provider === 'binance') {
      candles =
        await binanceCandles(symbol);
    }

    if (provider === 'okx') {
      candles =
        await okxCandles(symbol);
    }

    if (
      candles &&
      candles.length >=
        CONFIG.minCandles
    ) {
      return {
        candles,
        provider,
      };
    }
  }

  return null;
}

// ----------------------------- Features -----------------------------

function candleAtOrBefore(
  candles,
  targetMs
) {
  for (
    let i = candles.length - 1;
    i >= 0;
    i--
  ) {
    if (
      candles[i].time <= targetMs
    ) {
      return candles[i];
    }
  }

  return candles[0];
}

function returnFrom(
  candles,
  barsAgo
) {
  if (
    candles.length <= barsAgo
  ) {
    return 0;
  }

  return safePct(
    candles[candles.length - 1].close,
    candles[
      candles.length - 1 - barsAgo
    ].close
  );
}

function trueRange(
  candle,
  previousClose
) {
  if (!previousClose) {
    return candle.high - candle.low;
  }

  return Math.max(
    candle.high - candle.low,
    Math.abs(
      candle.high -
        previousClose
    ),
    Math.abs(
      candle.low -
        previousClose
    )
  );
}

function getMoveMaturity(candles) {
  const n = candles.length;

  if (n < 24) {
    return {
      base: 1,
      expansion: 0,
      continuation: 0,
      climax: 0,
    };
  }

  const last =
    candles[n - 1];

  const ret4 = safePct(
    last.close,
    candles[
      Math.max(0, n - 17)
    ].close
  );

  const ret1 = safePct(
    last.close,
    candles[
      Math.max(0, n - 5)
    ].close
  );

  const recentRange = avg(
    candles
      .slice(-6, -1)
      .map(
        candle =>
          (candle.high -
            candle.low) /
          (candle.close || 1)
      )
  );

  const priorRange = avg(
    candles
      .slice(-21, -6)
      .map(
        candle =>
          (candle.high -
            candle.low) /
          (candle.close || 1)
      )
  );

  const recentVol = avg(
    candles
      .slice(-6, -1)
      .map(
        candle => candle.volume
      )
  );

  const priorVol = avg(
    candles
      .slice(-21, -6)
      .map(
        candle => candle.volume
      )
  );  const volRatio =
    priorVol > 0
      ? recentVol / priorVol
      : 1;

  const expansion =
    ret1 > 0.015 &&
    ret4 > 0.03 &&
    (priorRange === 0 ||
      recentRange >= priorRange * 1.15) &&
    volRatio >= 1.25;

  const climax =
    ret4 > 0.12 &&
    (
      volRatio >= 2.5 ||
      recentRange >=
        Math.max(priorRange, 1e-9) * 2.0
    );

  const continuation =
    ret4 > 0.05 &&
    !climax &&
    ret1 > 0 &&
    volRatio >= 0.9;

  const base =
    !expansion &&
    !climax &&
    !continuation;

  return {
    base: base ? 1 : 0,
    expansion: expansion ? 1 : 0,
    continuation: continuation ? 1 : 0,
    climax: climax ? 1 : 0,
  };
}

function getMomentumProfile(candles) {
  const bars =
    candles.slice(-9, -1);

  if (bars.length < 6) return 0;

  const changes = bars
    .map((c, i) =>
      i
        ? safePct(
            c.close,
            bars[i - 1].close
          )
        : 0
    )
    .slice(1);

  const midpoint =
    Math.floor(changes.length / 2);

  const early =
    avg(changes.slice(0, midpoint));

  const late =
    avg(changes.slice(midpoint));

  const green =
    changes.filter(x => x > 0).length /
    Math.max(changes.length, 1);

  return clamp(
    (late - early) / 0.01,
    -2,
    2
  ) * 0.5 + (green - 0.5);
}

function getVolumeProfile(candles) {
  const bars =
    candles.slice(-12, -1);

  if (bars.length < 6) return 0;

  const vols =
    bars.map(c => c.volume);

  const med =
    median(vols);

  if (!med) return 0;

  const highVolBars =
    bars.filter(
      c => c.volume >= med * 2
    ).length;

  const latestRatio =
    bars.at(-1).volume / med;

  const midpoint =
    Math.floor(vols.length / 2);

  const early =
    avg(vols.slice(0, midpoint));

  const late =
    avg(vols.slice(midpoint));

  return clamp(
    (latestRatio >= 2 ? 0.8 : 0) +
      (late > early * 1.2 ? 0.5 : 0) -
      highVolBars * 0.18,
    -2,
    2
  );
}

function getMoveAtrUnits(candles) {
  const n =
    candles.length;

  const tr = [];

  for (
    let i = Math.max(1, n - 15);
    i < n;
    i++
  ) {
    tr.push(
      trueRange(
        candles[i],
        candles[i - 1].close
      )
    );
  }

  const atr =
    avg(tr);

  const price =
    candles[n - 1].close;

  const atrPct =
    price > 0
      ? atr / price
      : 0;

  const move4 =
    safePct(
      price,
      candles[
        Math.max(0, n - 17)
      ].close
    );

  return {
    atrPct,
    moveAtrUnits:
      atrPct > 0
        ? move4 / atrPct
        : 0,
  };
}

function isParabolicExhaustion(
  candles,
  maturity,
  moveAtrUnits
) {
  const last =
    candles.at(-1);

  const recent =
    candles.slice(-6, -1);

  if (
    !last ||
    recent.length < 4
  ) {
    return 0;
  }

  const ret4 =
    safePct(
      last.close,
      candles[
        Math.max(
          0,
          candles.length - 17
        )
      ].close
    );

  const avgBody =
    avg(
      recent.map(
        c =>
          Math.abs(
            c.close - c.open
          ) /
          (c.close || 1)
      )
    );

  const latestBody =
    Math.abs(
      last.close - last.open
    ) /
    (last.close || 1);

  const wick =
    (last.high - last.close) /
    (last.close || 1);

  let score = 0;

  if (ret4 > 0.20) score++;
  if (moveAtrUnits > 6) score++;
  if (maturity.climax) score++;

  if (
    latestBody >
    Math.max(avgBody, 1e-9) * 2.2
  ) {
    score++;
  }

  if (wick > 0.015) score++;

  return clamp(
    score / 5,
    0,
    1
  );
}

function isFirstPullbackContinuation(
  candles
) {
  const n =
    candles.length;

  if (n < 24) return 0;

  const impulse =
    safePct(
      candles[n - 5].close,
      candles[n - 17].close
    );

  const pullback =
    safePct(
      candles[n - 1].close,
      candles[n - 5].close
    );

  const reclaim =
    candles[n - 1].close >
    candles[n - 2].high;

  return (
    impulse > 0.04 &&
    pullback > -0.035 &&
    pullback < 0 &&
    reclaim
  )
    ? 1
    : 0;
}

function baseStructureQuality(
  candles
) {
  const bars =
    candles.slice(-18, -1);

  if (bars.length < 10) {
    return 0;
  }

  const ranges =
    bars.map(
      c =>
        (c.high - c.low) /
        (c.close || 1)
    );

  const first =
    avg(ranges.slice(0, 8));

  const last =
    avg(ranges.slice(-8));

  const lows =
    bars.map(c => c.low);

  const higherLows =
    lows
      .slice(1)
      .filter(
        (x, i) =>
          x > lows[i]
      ).length /
    Math.max(
      lows.length - 1,
      1
    );

  const compression =
    first > 0
      ? clamp(
          1 - last / first,
          0,
          1
        )
      : 0;

  const breakout =
    bars.at(-1).close >
    Math.max(
      ...bars
        .slice(0, -1)
        .map(c => c.high)
    );

  return clamp(
    compression * 0.5 +
      higherLows * 0.4 +
      (breakout ? 0.1 : 0),
    0,
    1
  );
}

function calcFeatures(
  candles,
  btcCandles
) {
  if (
    !candles ||
    candles.length <
      CONFIG.minCandles
  ) {
    return null;
  }

  const n =
    candles.length;

  const c =
    candles[n - 1];

  const closes =
    candles.map(x => x.close);

  const vols =
    candles.map(x => x.volume);

  const ranges =
    candles.map(
      x =>
        (x.high - x.low) /
        (x.close || 1)
    );

  const returns = [];

  for (
    let i = 1;
    i < n;
    i++
  ) {
    returns.push(
      safePct(
        closes[i],
        closes[i - 1]
      )
    );
  }

  const baseVol =
    avg(vols.slice(-21, -1));

  const recentVol =
    avg(vols.slice(-6, -1));

  const priorVol =
    avg(vols.slice(-21, -6));

  const recentRange =
    avg(ranges.slice(-6, -1));

  const priorRange =
    avg(ranges.slice(-21, -6));

  let upVol = 0;
  let downVol = 0;

  const last10 =
    candles.slice(-11, -1);

  for (
    let i = 1;
    i < last10.length;
    i++
  ) {
    if (
      last10[i].close >=
      last10[i - 1].close
    ) {
      upVol +=
        last10[i].volume;
    } else {
      downVol +=
        last10[i].volume;
    }
  }

  const high24 =
    Math.max(
      ...candles
        .slice(-97, -1)
        .map(x => x.high)
    );

  const low24 =
    Math.min(
      ...candles
        .slice(-97, -1)
        .map(x => x.low)
    );

  const range24 =
    high24 - low24;

  const closePosition =
    range24 > 0
      ? (c.close - low24) /
        range24
      : 0.5;

  const breakoutProximity =
    high24 > 0
      ? c.close / high24
      : 0;

  const recentCloses =
    closes.slice(-17, -1);

  const xbar =
    recentCloses.map(
      (_, i) => i
    );

  const xMean =
    avg(xbar);

  const yMean =
    avg(recentCloses);

  let cov = 0;
  let varx = 0;

  for (
    let i = 0;
    i < recentCloses.length;
    i++
  ) {
    cov +=
      (xbar[i] - xMean) *
      (recentCloses[i] - yMean);

    varx +=
      (xbar[i] - xMean) ** 2;
  }

  const slope =
    varx
      ? cov / varx
      : 0;

  const trendSlope =
    yMean
      ? slope / yMean
      : 0;

  const asset4h =
    returnFrom(
      candles,
      16
    );

  const btc4h =
    btcCandles &&
    btcCandles.length > 16
      ? returnFrom(
          btcCandles,
          16
        )
      : 0;

  const relativeStrength =
    asset4h - btc4h;

  const momentumRecent =
    avg(
      returns.slice(-4)
    );

  const momentumPrior =
    avg(
      returns.slice(-12, -4)
    );

  const momentumAcceleration =
    momentumPrior !== 0
      ? momentumRecent /
        momentumPrior
      : 0;

  const last5Low =
    candles
      .slice(-6, -1)
      .map(x => x.low);

  const higherLow =
    last5Low.length >= 3 &&
    last5Low.at(-1) >
      last5Low.at(-2) &&
    last5Low.at(-2) >
      last5Low.at(-3);

  const compression =
    priorRange > 0
      ? 1 -
        recentRange /
          priorRange
      : 0;

  const priceCompression =
    avg(
      candles
        .slice(-5, -1)
        .map(
          x =>
            Math.abs(
              x.close -
                x.open
            ) /
            (x.close || 1)
        )
    );

  const maturity =
    getMoveMaturity(candles);

  const momentumProfile =
    getMomentumProfile(
      candles
    );

  const volumeProfile =
    getVolumeProfile(
      candles
    );

  const atrInfo =
    getMoveAtrUnits(
      candles
    );

  const parabolicExhaustion =
    isParabolicExhaustion(
      candles,
      maturity,
      atrInfo.moveAtrUnits
    );

  const firstPullbackContinuation =
    isFirstPullbackContinuation(
      candles
    );

  const baseQuality =
    baseStructureQuality(
      candles
    );

  const features = {
    ret15m:
      returnFrom(candles, 1),

    ret1h:
      returnFrom(candles, 4),

    ret2h:
      returnFrom(candles, 8),

    ret4h:
      returnFrom(candles, 16),

    ret8h:
      returnFrom(candles, 32),

    ret12h:
      returnFrom(candles, 48),

    ret24h:
      returnFrom(candles, 96),

    volumeRatio:
      baseVol > 0
        ? c.volume / baseVol
        : 1,

    volumeAcceleration:
      priorVol > 0
        ? recentVol /
          priorVol
        : 1,

    buyPressure:
      downVol > 0
        ? upVol / downVol
        : upVol > 0
          ? 3
          : 1,

    rangeExpansion:
      priorRange > 0
        ? recentRange /
          priorRange
        : 1,

    rangeCompression:
      clamp(
        compression,
        -2,
        2
      ),

    higherLow:
      higherLow ? 1 : 0,

    priceCompression,

    relativeStrength,

    momentumAcceleration:
      clamp(
        momentumAcceleration,
        -5,
        5
      ),

    closePosition,

    breakoutProximity,

    trendSlope:
      clamp(
        trendSlope * 100,
        -5,
        5
      ),

    atrPct:
      atrInfo.atrPct,

    moveAtrUnits:
      clamp(
        atrInfo.moveAtrUnits,
        -10,
        10
      ),

    momentumProfile:
      clamp(
        momentumProfile,
        -2,
        2
      ),

    volumeProfile:      clamp(
        volumeProfile,
        -2,
        2
      ),

    parabolicExhaustion,

    firstPullbackContinuation,

    baseQuality,
  };

  return {
    ...features,
    currentPrice:
      c.close,
    currentHigh:
      num(c.high, c.close),
    currentLow:
      num(c.low, c.close),
    candleTime:
      c.time,
  };
}
function featureVector(
  features
) {
  return [
    clamp(
      features.ret15m / 0.03,
      -2,
      2
    ),

    clamp(
      features.ret1h / 0.08,
      -2,
      2
    ),

    clamp(
      features.ret2h / 0.12,
      -2,
      2
    ),

    clamp(
      features.ret4h / 0.20,
      -2,
      2
    ),

    clamp(
      features.ret8h / 0.30,
      -2,
      2
    ),

    clamp(
      features.ret12h / 0.40,
      -2,
      2
    ),

    clamp(
      features.ret24h / 0.60,
      -2,
      2
    ),

    clamp(
      Math.log(
        Math.max(
          features.volumeRatio,
          0.1
        )
      ),
      -2,
      2
    ),

    clamp(
      Math.log(
        Math.max(
          features.volumeAcceleration,
          0.1
        )
      ),
      -2,
      2
    ),

    clamp(
      Math.log(
        Math.max(
          features.buyPressure,
          0.1
        )
      ),
      -2,
      2
    ),

    clamp(
      Math.log(
        Math.max(
          features.rangeExpansion,
          0.1
        )
      ),
      -2,
      2
    ),

    clamp(
      features.rangeCompression,
      -1,
      1
    ),

    features.higherLow,

    clamp(
      features.priceCompression /
        0.03,
      -2,
      2
    ),

    clamp(
      features.relativeStrength /
        0.10,
      -2,
      2
    ),

    clamp(
      features.momentumAcceleration /
        3,
      -2,
      2
    ),

    clamp(
      (features.closePosition -
        0.5) * 2,
      -1,
      1
    ),

    clamp(
      (features.breakoutProximity -
        0.95) /
        0.05,
      -2,
      2
    ),

    clamp(
      features.trendSlope,
      -2,
      2
    ),

    clamp(
      features.atrPct / 0.03,
      -2,
      2
    ),

    clamp(
      features.moveAtrUnits / 6,
      -2,
      2
    ),

    clamp(
      features.momentumProfile,
      -2,
      2
    ),

    clamp(
      features.volumeProfile,
      -2,
      2
    ),

    clamp(
      features.parabolicExhaustion * 2 -
        1,
      -1,
      1
    ),

    features.firstPullbackContinuation,

    clamp(
      features.baseQuality * 2 -
        1,
      -1,
      1
    ),
  ];
}

function cosine(a, b) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length !== b.length ||
    !a.length
  ) {
    return 0;
  }

  let dot = 0;
  let aa = 0;
  let bb = 0;

  for (
    let i = 0;
    i < a.length;
    i++
  ) {
    dot +=
      a[i] * b[i];

    aa +=
      a[i] * a[i];

    bb +=
      b[i] * b[i];
  }

  return aa && bb
    ? dot /
        Math.sqrt(
          aa * bb
        )
    : 0;
}

function bootstrapEvidence(f) {
  const parts = [
    clamp(
      f.volumeRatio / 3,
      0,
      1
    ),

    clamp(
      f.volumeAcceleration / 2,
      0,
      1
    ),

    clamp(
      (f.buyPressure - 1) /
        1.5,
      0,
      1
    ),

    clamp(
      f.relativeStrength /
        0.05,
      0,
      1
    ),

    clamp(
      f.ret1h / 0.05,
      0,
      1
    ),

    clamp(
      f.ret4h / 0.12,
      0,
      1
    ),

    clamp(
      f.rangeExpansion / 1.5,
      0,
      1
    ),

    clamp(
      f.closePosition,
      0,
      1
    ),

    f.higherLow,

    clamp(
      (f.momentumProfile + 1) /
        2,
      0,
      1
    ),

    clamp(
      (f.volumeProfile + 1) /
        2,
      0,
      1
    ),

    f.firstPullbackContinuation,

    clamp(
      f.baseQuality,
      0,
      1
    ),

    1 -
      clamp(
        f.parabolicExhaustion,
        0,
        1
      ),
  ];

  return avg(parts);
}

// portfolio-bot-v8.js — PART 2 of 3. See part 1 for concatenation
// instructions and the full changelog.

// -----------------------------
// Supabase persistence
// -----------------------------

async function dbInsert(
  table,
  row
) {
  if (!supabase) return null;

  const {
    data,
    error,
  } =
    await supabase
      .from(table)
      .insert(row)
      .select()
      .maybeSingle();

  if (error) {
    console.error(
      `[DB] ${table}: ${error.message}`
    );

    return null;
  }

  return data;
}

async function dbUpsert(
  table,
  row,
  onConflict
) {
  if (!supabase) return null;

  const {
    data,
    error,
  } =
    await supabase
      .from(table)
      .upsert(
        row,
        {
          onConflict,
          ignoreDuplicates: false,
        }
      )
      .select()
      .maybeSingle();

  if (error) {
    console.error(
      `[DB] upsert ${table}: ${error.message}`
    );

    return null;
  }

  return data;
}

async function dbUpdate(
  table,
  match,
  row
) {
  if (!supabase) return false;

  let query =
    supabase
      .from(table)
      .update(row);

  for (
    const [key, value] of
    Object.entries(match)
  ) {
    query =
      query.eq(key, value);
  }

  const { error } =
    await query;

  if (error) {
    console.error(
      `[DB] update ${table}: ${error.message}`
    );

    return false;
  }

  return true;
}

async function saveSnapshot(
  asset,
  features,
  bootstrap,
  similarity,
  mode
) {
  return dbUpsert(
    'hunter_v11_snapshots',
    {
      symbol:
        asset.symbol,

      timestamp:
        iso(features.candleTime),

      price:
        features.currentPrice,

      features,

      feature_vector:
        featureVector(features),

      bootstrap_score:
        round(
          bootstrap,
          6
        ),

      learned_similarity:
        similarity == null
          ? null
          : round(
              similarity,
              6
            ),

      detection_mode:
        mode,
    },
    'symbol,timestamp'
  );
}

async function createExample(
  snapshotId,
  asset,
  features
) {
  return dbUpsert(
    'hunter_v11_examples',
    {
      snapshot_id:
        snapshotId || null,

      symbol:
        asset.symbol,

      timestamp:
        iso(features.candleTime),

      feature_vector:
        featureVector(features),

      price:
        features.currentPrice,

      outcome_10: null,
      outcome_50: null,
      outcome_100: null,
      outcome_150: null,

      resolved_at:
        null,
    },
    'symbol,timestamp'
  );
}

async function fetchLearningClass(column, value, cutoff) {
  const { data, error } = await supabase
    .from('hunter_v11_examples')
    .select('feature_vector')
    .eq(column, value)
    .gte('timestamp', iso(cutoff))
    .order('timestamp', { ascending: false })
    .limit(CONFIG.learningExamplesPerClass);

  if (error) {
    console.error(`[DB] learning ${column}=${value}: ${error.message}`);
    return [];
  }

  return (data || [])
    .map(row => row.feature_vector)
    .filter(vector =>
      Array.isArray(vector) &&
      vector.length === CONFIG.featureNames.length &&
      vector.every(Number.isFinite)
    );
}

async function getLearningModel() {
  const empty = {
    byTarget: { 10: [], 50: [], 100: [], 150: [] },
    negativesByTarget: { 10: [], 50: [], 100: [], 150: [] },
    negatives: [],
    counts: {
      10: 0, 50: 0, 100: 0, 150: 0,
      negative: 0,
      negativeByTarget: { 10: 0, 50: 0, 100: 0, 150: 0 },
    },
  };

  if (!supabase) return empty;

  const cutoff = Date.now() - CONFIG.learningLookbackHours * 3600000;
  const targets = [10, 50, 100, 150];
  const [positive, negative] = await Promise.all([
    Promise.all(targets.map(target =>
      fetchLearningClass(`outcome_${target}`, true, cutoff)
    )),
    Promise.all(targets.map(target =>
      fetchLearningClass(`outcome_${target}`, false, cutoff)
    )),
  ]);

  targets.forEach((target, i) => {
    empty.byTarget[target] = positive[i];
    empty.negativesByTarget[target] = negative[i];
    empty.counts[target] = positive[i].length;
    empty.counts.negativeByTarget[target] = negative[i].length;
  });

  empty.negatives = negative.flat();
  empty.counts.negative = empty.negatives.length;
  return empty;
}

function topSimilarity(vector, examples, limit = 12) {
  if (!examples?.length) return null;

  const similarities = examples
    .filter(candidate =>
      Array.isArray(candidate) && candidate.length === vector.length
    )
    .map(candidate => cosine(vector, candidate))
    .sort((a, b) => b - a)
    .slice(0, limit);

  return similarities.length ? avg(similarities) : null;
}

function learnedSimilarity(vector, model) {
  const targets = [10, 50, 100, 150];
  const targetWeights = { 10: 0.35, 50: 0.30, 100: 0.20, 150: 0.15 };
  const targetSimilarities = {};
  const targetContrasts = {};

  for (const target of targets) {
    const positive = topSimilarity(vector, model.byTarget[target]);
    const negative = topSimilarity(vector, model.negativesByTarget?.[target] || []);
    targetSimilarities[target] = positive;
    targetContrasts[target] =
      positive == null || negative == null ? null : positive - negative;
  }

  const mature = targets.filter(target =>
    targetSimilarities[target] != null &&
    model.counts[target] >= CONFIG.minPositiveExamples
  );

  if (!mature.length) {
    return {
      similarity: null,
      contrast: null,
      targetSimilarities,
      targetContrasts,
      primaryTarget: null,
      mode: 'BOOTSTRAP',
    };
  }

  const weightTotal = mature.reduce((sum, target) => sum + targetWeights[target], 0);
  const weighted = mature.reduce(
    (sum, target) => sum + targetSimilarities[target] * targetWeights[target],
    0
  ) / weightTotal;

  const contrastTargets = mature.filter(target => targetContrasts[target] != null);
  const contrast = contrastTargets.length
    ? contrastTargets.reduce(
        (sum, target) => sum + targetContrasts[target] * targetWeights[target],
        0
      ) / contrastTargets.reduce((sum, target) => sum + targetWeights[target], 0)
    : null;

  const primaryTarget = mature
    .slice()
    .sort((a, b) => targetSimilarities[b] - targetSimilarities[a])[0];

  return {
    similarity: weighted,
    contrast,
    targetSimilarities,
    targetContrasts,
    primaryTarget,
    mode: 'LEARNED',
  };
}

async function labelRecentExamples(symbol, candles) {
  if (!supabase || !candles?.length) return;

  const oldest = Date.now() - CONFIG.learningLookbackHours * 3600000;
  const { data, error } = await supabase
    .from('hunter_v11_examples')
    .select('id,timestamp,price,outcome_10,outcome_50,outcome_100,outcome_150')
    .eq('symbol', symbol)
    .gte('timestamp', iso(oldest))
    .order('timestamp', { ascending: true })
    .limit(150);

  if (error || !data?.length) return;

  for (const example of data) {
    const timestamp = new Date(example.timestamp).getTime();
    const updates = {};

    for (const [target, hours] of Object.entries(CONFIG.horizons)) {
      const column = `outcome_${target}`;
      if (example[column] !== null) continue;
      if ((Date.now() - timestamp) / 3600000 < hours) continue;

      const end = timestamp + hours * 3600000;
      // Example price is the observation candle CLOSE. Strictly later candles
      // are the only valid future observations: no same-candle look-ahead.
      const future = candles.filter(c => c.time > timestamp && c.time <= end);
      if (!future.length) continue;

      const maxPrice = Math.max(...future.map(c => c.high));
      const minPrice = Math.min(...future.map(c => c.low));
      const threshold = example.price * (1 + Number(target) / 100);
      updates[column] = maxPrice >= threshold;

      if (target === '10') {
        updates.mfe_pct_24h = ((maxPrice - example.price) / example.price) * 100;
        updates.mae_pct_24h = ((minPrice - example.price) / example.price) * 100;
      }

      const hit = future.find(c => c.high >= threshold);
      if (hit) {
        updates[`time_to_${target}_min`] = Math.max(0, (hit.time - timestamp) / 60000);
      }
    }

    if (!Object.keys(updates).length) continue;

    const resolved = ['10', '50', '100', '150'].every(target =>
      updates[`outcome_${target}`] !== undefined || example[`outcome_${target}`] !== null
    );

    await dbUpdate(
      'hunter_v11_examples',
      { id: example.id },
      { ...updates, resolved_at: resolved ? iso() : null }
    );
  }
}

// -----------------------------
// State / lifecycle
// -----------------------------

async function getLastAction(
  symbol,
  action
) {
  if (!supabase) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabase
      .from(
        'hunter_v11_alerts'
      )
      .select('*')
      .eq(
        'symbol',
        symbol
      )
      .eq(
        'action',
        action
      )
      .order(
        'timestamp',
        {
          ascending: false,
        }
      )
      .limit(1)
      .maybeSingle();

  return error
    ? null
    : data;
}

async function insertAlert(
  symbol,
  action,
  message,
  detectionId = null,
  metadata = {}
) {
  return dbInsert(
    'hunter_v11_alerts',
    {
      symbol,
      action,
      message,
      detection_id:
        detectionId,

      timestamp:
        iso(),

      metadata,
    }
  );
}

async function currentOpen(
  symbol
) {
  const cached =
    STATE.active.get(
      symbol
    );

  if (cached) {
    return cached;
  }

  if (!supabase) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabase
      .from(
        'hunter_v11_positions'
      )
      .select('*')
      .eq(
        'symbol',
        symbol
      )
      .eq(
        'status',
        'OPEN'
      )
      .order(
        'opened_at',
        {
          ascending: false,
        }
      )
      .limit(1)
      .maybeSingle();

  if (
    !error &&
    data
  ) {
    STATE.active.set(
      symbol,
      data
    );

    return data;
  }

  return null;
    }// -----------------------------
// Cream-of-the-crop scoring
// -----------------------------

function earlyStageScore(f) {
  let score = 0;

  if (f.ret15m > 0) score += 0.15;
  if (f.ret1h > 0) score += 0.20;
  if (f.ret4h > 0) score += 0.20;

  if (
    f.ret4h >= 0.015 &&
    f.ret4h <= 0.10
  ) {
    score += 0.15;
  }

  if (
    f.ret24h >= 0 &&
    f.ret24h <= 0.25
  ) {
    score += 0.10;
  }

  if (f.firstPullbackContinuation) {
    score += 0.10;
  }

  if (
    f.baseQuality >= 0.60
  ) {
    score += 0.10;
  }

  return clamp(score, 0, 1);
}

function creamScore(
  f,
  learning
) {
  const historical =
    learning.mode === 'LEARNED'
      ? clamp(
          learning.similarity || 0,
          0,
          1
        )
      : bootstrapEvidence(f);

  const momentum =
    avg([
      clamp(
        (f.ret1h + 0.01) /
          0.06,
        0,
        1
      ),

      clamp(
        (f.ret4h + 0.02) /
          0.12,
        0,
        1
      ),

      clamp(
        (f.momentumProfile + 1) /
          2,
        0,
        1
      ),

      clamp(
        f.momentumAcceleration /
          3,
        0,
        1
      ),
    ]);

  const volume =
    avg([
      clamp(
        Math.log(
          Math.max(
            f.volumeRatio,
            1
          )
        ) /
          Math.log(6),
        0,
        1
      ),

      clamp(
        Math.log(
          Math.max(
            f.volumeAcceleration,
            1
          )
        ) /
          Math.log(3),
        0,
        1
      ),

      clamp(
        (f.volumeProfile + 1) /
          2,
        0,
        1
      ),
    ]);

  const buying =
    clamp(
      (f.buyPressure - 1) /
        2,
      0,
      1
    );

  const structure =
    avg([
      clamp(
        f.baseQuality,
        0,
        1
      ),

      f.higherLow,

      clamp(
        f.closePosition,
        0,
        1
      ),

      clamp(
        (f.breakoutProximity -
          0.90) /
          0.10,
        0,
        1
      ),

      f.firstPullbackContinuation,
    ]);

  const relative =
    clamp(
      (f.relativeStrength +
        0.01) /
        0.08,
      0,
      1
    );

  const early =
    earlyStageScore(f);

  const continuation =
    continuationStrength(f);

  let score =
    historical * 25 +
    momentum * 20 +
    volume * 15 +
    buying * 15 +
    structure * 10 +
    relative * 10 +
    early * 5;

  // Reward sustained continuation without allowing a raw percentage gain to
  // dominate the score. This is deliberately a modest bonus.
  score += continuation * 5;

  if (
    learning.mode === 'LEARNED' &&
    learning.contrast != null
  ) {
    score +=
      clamp(
        learning.contrast /
          0.10,
        0,
        1
      ) * 5;
  }

  // Heavy penalties are deliberate.
  // Hunter is supposed to find the move,
  // not chase the candle after it has happened.

  if (
    f.parabolicExhaustion >= 0.50
  ) {
    score -=
      (f.parabolicExhaustion -
        0.50) *
      30;
  }

  if (f.ret4h > 0.15) {
    score -=
      (f.ret4h - 0.15) *
      80;
  }

  if (f.ret24h > 0.20) {
    score -=
      (f.ret24h - 0.20) *
      50;
  }

  if (
    f.momentumProfile < -0.25
  ) {
    score -= 8;
  }

  if (
    f.relativeStrength < 0
  ) {
    score -= 5;
  }

  return clamp(
    score,
    0,
    100
  );
}

function moveStage(f) {
  if (
    f.parabolicExhaustion >=
    0.70
  ) {
    return 'CLIMAX RISK';
  }

  if (
    f.firstPullbackContinuation
  ) {
    return 'FIRST PULLBACK';
  }

  if (
    f.ret1h >= 0.015 &&
    f.volumeAcceleration >= 1.5 &&
    f.momentumProfile > 0.10
  ) {
    return 'ACCELERATING';
  }

  return 'BUILDING';
}

function btcRiskState(
  btcFeatures
) {
  if (!btcFeatures) {
    return {
      blocked: false,
      penalty: 0,
      label: 'UNKNOWN',
    };
  }

  const ret1 =
    btcFeatures.ret1h;

  const ret4 =
    btcFeatures.ret4h;

  if (
    ret1 <= -0.025 &&
    ret4 <= -0.04
  ) {
    // CHANGED: was `blocked: true`, which made creamGate() reject every
    // candidate outright whenever BTC was down hard, including strong
    // altcoins actively decoupling from it. `severe` now feeds a raised
    // relative-strength requirement in creamGate() instead of a blanket
    // reject. Penalty raised 25->40 since this no longer disqualifies on
    // its own.
    return {
      blocked: false,
      severe: true,
      penalty: 40,
      label: 'RISK-OFF',
    };
  }

  if (
    ret1 <= -0.015 ||
    ret4 <= -0.025
  ) {
    return {
      blocked: false,
      penalty: 10,
      label: 'WEAK',
    };
  }

  if (
    ret1 >= 0.01 ||
    ret4 >= 0.02
  ) {
    return {
      blocked: false,
      penalty: -3,
      label: 'SUPPORTIVE',
    };
  }

  return {
    blocked: false,
    penalty: 0,
    label: 'NEUTRAL',
  };
}

function continuationStrength(f) {
  let score = 0;

  // A genuinely continuing move should be making progress on several
  // independent dimensions, not simply printing a large percentage gain.
  if (f.ret1h >= 0.08) score += 0.15;
  else if (f.ret1h >= 0.04) score += 0.08;

  if (f.ret4h >= 0.15) score += 0.15;
  else if (f.ret4h >= 0.08) score += 0.08;

  if (f.momentumProfile >= 0.15) score += 0.15;
  if (f.momentumAcceleration >= CONFIG.continuationMinMomentumAcceleration) score += 0.15;
  if (f.volumeAcceleration >= CONFIG.continuationMinVolumeAcceleration) score += 0.15;
  if (f.buyPressure >= CONFIG.continuationMinBuyPressure) score += 0.10;
  if (f.relativeStrength >= CONFIG.continuationMinRelativeStrength) score += 0.10;

  if (f.higherLow || f.firstPullbackContinuation) score += 0.10;

  return clamp(score, 0, 1);
}

function isTooLate(f) {
  const continuation = continuationStrength(f);

  // Very large moves are not automatically late. They become late when
  // follow-through is deteriorating and fresh participation is disappearing.
  if (
    f.ret4h > CONFIG.creamMaxRet4h &&
    f.momentumProfile < -0.20 &&
    f.momentumAcceleration <= 0 &&
    f.volumeAcceleration < 1.25
  ) {
    return { tooLate: true, reason: 'parabolic exhaustion' };
  }

  if (
    f.ret24h > CONFIG.creamMaxRet24h &&
    f.ret4h < 0
  ) {
    return { tooLate: true, reason: '24h extended, 4h reversing' };
  }

  if (
    f.ret4h > 0.40 &&
    f.momentumProfile < 0 &&
    f.buyPressure < CONFIG.continuationMinBuyPressure
  ) {
    return { tooLate: true, reason: 'extended with weak participation' };
  }

  if (
    f.parabolicExhaustion >= CONFIG.creamMaxExhaustion &&
    f.momentumAcceleration <= 0 &&
    f.ret1h <= 0
  ) {
    return { tooLate: true, reason: 'exhaustion with fading momentum' };
  }

  // Preserve the anti-chase rule for an extended move that has not earned
  // continuation status through strong participation.
  if (
    f.ret4h > 0.50 &&
    continuation < CONFIG.continuationMinScore
  ) {
    return { tooLate: true, reason: 'too extended without continuation' };
  }

  return {
    tooLate: false,
    continuation,
  };
}

function alertReadiness(f, learning, btcRisk) {
  const checks = [
    ['15m', f.ret15m > 0],
    ['1h', f.ret1h >= 0.003],
    ['4h', f.ret4h >= 0.01],
    ['volume', f.volumeRatio >= 1.5],
    ['volume acceleration', f.volumeAcceleration >= 1.10],
    ['buying', f.buyPressure >= 1.10],
    ['BTC relative strength', f.relativeStrength >= 0.005],
    ['momentum', f.momentumProfile > 0],
    ['structure', f.higherLow || f.firstPullbackContinuation || f.baseQuality >= 0.45],
  ];

  const signalCount = checks.filter(([, ok]) => ok).length;
  const participation = avg([
    clamp(f.volumeRatio / 3, 0, 1),
    clamp(f.volumeAcceleration / 2, 0, 1),
    clamp((f.buyPressure - 1) / 1.5, 0, 1),
  ]);
  const momentum = avg([
    clamp((f.ret1h + 0.005) / 0.05, 0, 1),
    clamp((f.ret4h + 0.01) / 0.10, 0, 1),
    clamp((f.momentumProfile + 0.5) / 1.5, 0, 1),
    clamp(f.momentumAcceleration / 3, 0, 1),
  ]);
  const structure = avg([
    clamp(f.baseQuality, 0, 1),
    f.higherLow ? 1 : 0,
    f.firstPullbackContinuation ? 1 : 0,
    clamp(f.closePosition, 0, 1),
  ]);
  const relative = clamp((f.relativeStrength + 0.01) / 0.06, 0, 1);
  const freshness = clamp(1 - Math.max(0, f.ret4h - 0.20) / 0.30, 0, 1);
  const continuation = continuationStrength(f);

  let readiness =
    (signalCount / checks.length) * 25 +
    participation * 25 +
    momentum * 20 +
    structure * 12 +
    relative * 10 +
    freshness * 8;

  if (continuation >= CONFIG.continuationMinScore) readiness += 5;
  if (learning.mode === 'LEARNED' && learning.contrast != null) {
    readiness += clamp(learning.contrast / 0.10, -1, 1) * 5;
  }
  if (btcRisk?.severe && f.relativeStrength < CONFIG.btcSevereMinRelativeStrength) {
    readiness -= 10;
  }

  return {
    score: clamp(readiness, 0, 100),
    signalCount,
    signalNames: checks.filter(([, ok]) => ok).map(([name]) => name),
    missing: checks.filter(([, ok]) => !ok).map(([name]) => name),
  };
}

function candidatePriority(
  detection
) {
  let score =
    detection.creamScore;

  const f =
    detection.features;

  score += num(detection.alertReadiness) * 0.10;
  if (f.ret1h > 0 && f.momentumAcceleration > 1.25) score += 2;

  const learning =
    detection.learning;

  // Prefer genuinely accelerating setups
  // over stagnant "technically acceptable" ones.
  if (
    f.momentumAcceleration > 1.25
  ) {
    score += 3;
  }

  if (
    f.volumeAcceleration > 1.5
  ) {
    score += 3;
  }

  if (
    f.firstPullbackContinuation
  ) {
    score += 3;
  }

  if (
    f.baseQuality >= 0.70
  ) {
    score += 2;
  }

  if (
    learning.mode === 'LEARNED' &&
    learning.contrast >= 0.12
  ) {
    score += 3;
  }

  return score;
}

// -----------------------------
// Detection
// -----------------------------

async function analyseAsset(
  asset,
  btcCandles,
  learningModel
) {
  const result =
    await candlesFor(
      asset.symbol
    );

  if (!result) {
    return null;
  }

  const features =
    calcFeatures(
      result.candles,
      btcCandles
    );

  if (!features) {
    return null;
  }

  const vector =
    featureVector(features);

  const learning =
    learnedSimilarity(
      vector,
      learningModel
    );

  const bootstrap =
    bootstrapEvidence(
      features
    );

  const score =
    creamScore(
      features,
      learning
    );

  const stage =
    moveStage(features);

  const readiness =
    alertReadiness(features, learning, STATE.btcRisk);

  const detection = {
    symbol:
      asset.symbol,

    provider:
      result.provider,

    asset,

    candles:
      result.candles,

    features,

    vector,

    bootstrapScore:
      bootstrap,

    creamScore:
      score,

    learning,

    stage,

    alertReadiness: readiness.score,
    signalCount: readiness.signalCount,
    alertSignals: readiness.signalNames,

    timestamp:
      features.candleTime,
  };

  return detection;
}

// -----------------------------
// Measurement / learning persistence
// -----------------------------

async function saveObservationHistory(
  detection,
  btcRisk,
  fieldAverage = null
) {
  if (!supabase) return null;

  const f = detection.features;
  const participation = clamp(
    avg([
      clamp(f.volumeRatio / 4, 0, 1),
      clamp(f.volumeAcceleration / 3, 0, 1),
      clamp((f.buyPressure - 1) / 2, 0, 1),
    ]),
    0,
    1
  ) * 100;

  const momentum = clamp(
    avg([
      clamp((f.ret1h + 0.01) / 0.06, 0, 1),
      clamp((f.ret4h + 0.02) / 0.12, 0, 1),
      clamp((f.momentumProfile + 1) / 2, 0, 1),
      clamp(f.momentumAcceleration / 3, 0, 1),
    ]),
    0,
    1
  ) * 100;

  const structure = clamp(
    avg([
      clamp(f.baseQuality, 0, 1),
      f.higherLow ? 1 : 0,
      clamp(f.closePosition, 0, 1),
      f.firstPullbackContinuation ? 1 : 0,
    ]),
    0,
    1
  ) * 100;

  const row = {
    alert_id: null,
    symbol: detection.symbol,
    asset_type: 'CRYPTO',    setup_type: detection.stage,
    hunter_score: round(detection.creamScore, 4),
    score_strength: round(detection.bootstrapScore * 100, 4),
    score_participation: round(participation, 4),
    score_momentum: round(momentum, 4),
    score_execution: round(structure, 4),
    score_risk: round((1 - f.parabolicExhaustion) * 100, 4),
    score_confidence: detection.learning.similarity == null
      ? round(detection.bootstrapScore * 100, 4)
      : round(detection.learning.similarity * 100, 4),
    score_conviction: detection.learning.contrast == null
      ? round(detection.creamScore, 4)
      : round(clamp(detection.learning.contrast, 0, 1) * 100, 4),
    edge_over_field: fieldAverage == null
      ? null
      : round(detection.creamScore - fieldAverage, 4),
    btc_regime: btcRisk?.label || 'UNKNOWN',
    qqq_regime: 'N/A',
    field_avg_at_alert: fieldAverage,
    outcome: 'PENDING',
    is_resolved: false,
    alerted_at: null,
    calculated_at: iso(detection.timestamp),
    analytics_version: 'v2.0.0',
    formula_version: 'hunter-v14.2',
  };

  return dbInsert(
    'hunter_observation_history',
    row
  );
}
async function updateWatchlist(
  detections,
  btcRisk
) {
  if (!supabase || !detections.length) return;

  const ranked = [...detections]
    .sort((a, b) => b.creamScore - a.creamScore)
    .slice(0, 10);

  const selected = new Set(ranked.map(d => d.symbol));

  for (const detection of ranked) {
    const { data: previous } = await supabase
      .from('hunter_watchlist')
      .select('hunter_score')
      .eq('symbol', detection.symbol)
      .maybeSingle();

    const oldScore = previous?.hunter_score == null
      ? null
      : num(previous.hunter_score);

    const scoreTrend = oldScore == null
      ? 'NEW'
      : detection.creamScore > oldScore + 0.5
        ? 'RISING'
        : detection.creamScore < oldScore - 0.5
          ? 'FALLING'
          : 'STABLE';

    await dbUpsert(
      'hunter_watchlist',
      {
        symbol: detection.symbol,
        asset_type: 'CRYPTO',
        hunter_score: round(detection.creamScore, 4),
        score_trend: scoreTrend,
        btc_regime: btcRisk?.label || 'UNKNOWN',
        qqq_regime: 'N/A',
        last_updated: iso(),
      },
      'symbol'
    );
  }

  // A persistent watchlist should represent the current top candidates,
  // not accumulate stale symbols forever.
  const { data: existing } = await supabase
    .from('hunter_watchlist')
    .select('symbol');

  for (const row of existing || []) {
    if (!selected.has(row.symbol)) {
      await supabase
        .from('hunter_watchlist')
        .delete()
        .eq('symbol', row.symbol);
    }
  }
}

async function persistDynamicUniverse(
  universe
) {
  if (!supabase) return;

  for (let i = 0; i < universe.length; i += 1) {
    const asset = universe[i];
    await dbUpsert(
      'hunter_dynamic_universe',
      {
        symbol: asset.symbol,
        asset_type: 'CRYPTO',
        rank: i + 1,
        fetched_at: iso(),
      },
      'symbol,asset_type'
    );
  }

  const current = new Set(universe.map(asset => asset.symbol));
  const { data: existing } = await supabase
    .from('hunter_dynamic_universe')
    .select('symbol')
    .eq('asset_type', 'CRYPTO');

  for (const row of existing || []) {
    if (!current.has(row.symbol)) {
      await supabase
        .from('hunter_dynamic_universe')
        .delete()
        .eq('symbol', row.symbol)
        .eq('asset_type', 'CRYPTO');
    }
  }
}

function confidenceLabel(n) {
  if (n >= 100) return 'HIGH';
  if (n >= 30) return 'MEDIUM';
  return 'LOW';
}

function rateCI(hits, total) {
  if (!total) return [null, null];
  const p = hits / total;
  const z = 1.96;
  const denom = 1 + z * z / total;
  const centre = (p + z * z / (2 * total)) / denom;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denom;
  return [clamp(centre - margin, 0, 1), clamp(centre + margin, 0, 1)];
}

async function refreshPredictiveStatistics() {
  if (!supabase) return;

  const start = new Date(Date.now() - 7 * 86400000).toISOString();
  const end = nowIso();
  const { data, error } = await supabase
    .from('hunter_observation_history')
    .select('alert_id,hunter_score,tp1_hit,tp2_hit,stopped_out,gain_pct,max_favourable_excursion,max_adverse_excursion,duration_minutes,is_resolved')
    .eq('asset_type', 'CRYPTO')
    .gte('calculated_at', start)
    .lte('calculated_at', end);

  if (error || !data?.length) return;

  const bins = [
    [0, 59], [60, 69], [70, 79], [80, 89], [90, 100],
  ];

  for (const [low, high] of bins) {
    const rows = data.filter(row =>
      num(row.hunter_score) >= low &&
      num(row.hunter_score) <= high
    );

    const resolved = rows.filter(row => row.is_resolved);
    const tp1 = resolved.filter(row => row.tp1_hit === true).length;
    const tp2 = resolved.filter(row => row.tp2_hit === true).length;
    const stopped = resolved.filter(row => row.stopped_out === true).length;
    const tp1CI = rateCI(tp1, resolved.length);
    const tp2CI = rateCI(tp2, resolved.length);
    const gains = resolved.map(r => num(r.gain_pct)).filter(Number.isFinite);
    const mfe = resolved.map(r => num(r.max_favourable_excursion)).filter(Number.isFinite);
    const mae = resolved.map(r => num(r.max_adverse_excursion)).filter(Number.isFinite);
    const duration = resolved.map(r => num(r.duration_minutes)).filter(Number.isFinite);
    const wins = gains.filter(x => x > 0);
    const losses = gains.filter(x => x < 0);

    await dbUpsert(
      'hunter_predictive_statistics',
      {
        period_start: start,
        period_end: end,
        score_bin_low: low,
        score_bin_high: high,
        asset_type: 'CRYPTO',
        alert_count: rows.filter(row => row.alert_id != null).length,
        resolved_count: resolved.length,
        confidence_level: confidenceLabel(resolved.length),
        tp1_rate: resolved.length ? tp1 / resolved.length : null,
        tp1_rate_ci_lower: tp1CI[0],
        tp1_rate_ci_upper: tp1CI[1],
        tp2_rate: resolved.length ? tp2 / resolved.length : null,
        tp2_rate_ci_lower: tp2CI[0],
        tp2_rate_ci_upper: tp2CI[1],
        stop_rate: resolved.length ? stopped / resolved.length : null,
        stop_rate_ci_lower: null,
        stop_rate_ci_upper: null,
        avg_duration_minutes: avg(duration) || null,
        avg_gain_pct: avg(gains) || null,
        avg_loss_pct: avg(losses) || null,
        avg_mfe: avg(mfe) || null,
        avg_mae: avg(mae) || null,
        calculated_at: nowIso(),
        source_max_timestamp: end,
        analytics_version: 'v2.0.0',
        formula_version: 'hunter-v14.2',
      },
      'period_start,score_bin_low,score_bin_high,asset_type'
    );
  }
}

async function labelObservationHistory(
  symbol,
  candles
) {
  if (!supabase || !candles?.length) return;

  const cutoff = new Date(Date.now() - 24 * 3600000).toISOString();
  const { data } = await supabase
    .from('hunter_observation_history')
    .select('id,symbol,calculated_at,hunter_score,is_resolved')
    .eq('symbol', symbol)
    .eq('asset_type', 'CRYPTO')
    .eq('is_resolved', false)
    .lte('calculated_at', cutoff)
    .limit(100);

  for (const row of data || []) {
    const timestamp = new Date(row.calculated_at).getTime();
    const priceCandle = candles.find(c => c.time === timestamp);
    if (!priceCandle || priceCandle.close <= 0) continue;

    const future = candles.filter(c =>
      c.time > priceCandle.time &&
      c.time <= priceCandle.time + 24 * 3600000
    );

    if (!future.length) continue;

    const entry = priceCandle.close;
    const maxPrice = Math.max(...future.map(c => c.high));
    const minPrice = Math.min(...future.map(c => c.low));
    const gainPct = ((future.at(-1).close - entry) / entry) * 100;
    const mfePct = ((maxPrice - entry) / entry) * 100;
    const maePct = ((minPrice - entry) / entry) * 100;
    const tp1Hit = maxPrice >= entry * 1.01;
    const tp2Hit = maxPrice >= entry * 1.03;

    await dbUpdate(
      'hunter_observation_history',
      { id: row.id },
      {
        entry_level: entry,
        tp1: entry * 1.01,
        tp2: entry * 1.03,
        tp1_hit: tp1Hit,
        tp2_hit: tp2Hit,
        stopped_out: null,
        duration_minutes: 1440,
        gain_pct: gainPct,
        max_favourable_excursion: mfePct,
        max_adverse_excursion: maePct,
        outcome: tp2Hit ? 'TP2' : tp1Hit ? 'TP1' : gainPct > 0 ? 'POSITIVE' : 'NEGATIVE',
        is_resolved: true,
        resolved_at: nowIso(),
        calculated_at: nowIso(),
      }
    );
  }
}

// portfolio-bot-v8.js — PART 3 of 3. See part 1 for concatenation
// instructions and the full changelog.

// -----------------------------
// Detection persistence
// -----------------------------

async function saveDetection(
  detection
) {
  if (!supabase) {
    return null;
  }

  return dbInsert(
    'hunter_v11_detections',
    {
      symbol:
        detection.symbol,

      timestamp:
        iso(
          detection.timestamp
        ),

      price:
        detection.features.currentPrice,

      score:
        round(
          detection.creamScore,
          4
        ),

      bootstrap_score:
        round(
          detection.bootstrapScore,
          6
        ),

      similarity:
        detection.learning.similarity ==
        null
          ? null
          : round(
              detection.learning.similarity,
              6
            ),

      contrast:
        detection.learning.contrast ==
        null
          ? null
          : round(
              detection.learning.contrast,
              6
            ),

      stage:
        detection.stage,

      // ADDED: this column already existed on hunter_v11_detections but
      // was never written. detection.reasons is populated just before
      // persistDetections() is called in runCycle() — see that call
      // site. Empty array (fully eligible) stores as null, not ''.
      reason:
        detection.reasons && detection.reasons.length
          ? detection.reasons.join(', ')
          : null,

      features:
        detection.features,

      feature_vector:
        detection.vector,
    }
  );
}

// -----------------------------
// OPEN / HOLD / CLOSE
// -----------------------------

function openCandidate(detection, btcRisk) {
  const f = detection.features;
  const learning = detection.learning;
  const lateCheck = isTooLate(f);
  const readiness = alertReadiness(f, learning, btcRisk);

  detection.alertReadiness = readiness.score;
  detection.signalCount = readiness.signalCount;
  detection.alertSignals = readiness.signalNames;

  const reasons = [];
  if (detection.creamScore < CONFIG.creamMinScore) reasons.push('score below 70');
  if (lateCheck.tooLate) reasons.push(lateCheck.reason);
  if (readiness.signalCount < CONFIG.alertMinSignals) {
    reasons.push(`only ${readiness.signalCount}/${CONFIG.alertMinSignals} alert signals`);
  }
  if (readiness.score < CONFIG.alertMinReadiness) {
    reasons.push(`readiness ${readiness.score.toFixed(1)} < ${CONFIG.alertMinReadiness}`);
  }

  if (learning.mode === 'LEARNED') {
    if (learning.similarity != null && learning.similarity < CONFIG.alertLearnedSimilarity) {
      reasons.push('learned similarity');
    }
    if (learning.contrast != null && learning.contrast < CONFIG.alertLearnedContrast) {
      reasons.push('learned contrast');
    }
  } else if (
    detection.creamScore < 75 &&
    detection.bootstrapScore < CONFIG.openBootstrapScore
  ) {
    reasons.push('bootstrap evidence');
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    readiness: readiness.score,
    signalCount: readiness.signalCount,
  };
}

async function canOpen(
  symbol
) {
  if (!supabase) {
    return { ok: false, reason: 'persistence unavailable' };
  }

  const existing =
    await currentOpen(
      symbol
    );

  if (existing) {
    return {
      ok: false,
      reason: 'already open',
    };
  }

  const lastOpen =
    await getLastAction(
      symbol,
      'OPEN'
    );

  if (lastOpen) {
    const elapsed =
      Date.now() -
      new Date(
        lastOpen.timestamp
      ).getTime();

    if (
      elapsed <
      CONFIG.openCooldownMs
    ) {
      return {
        ok: false,
        reason: 'open cooldown',
      };
    }
  }

  const lastClose =
    await getLastAction(
      symbol,
      'CLOSE'
    );

  if (lastClose) {
    const elapsed =
      Date.now() -
      new Date(
        lastClose.timestamp
      ).getTime();

    if (
      elapsed <
      CONFIG.reopenCooldownMs
    ) {
      return {
        ok: false,
        reason: 're-entry cooldown',
      };
    }

    // ADDED: elapsed time alone isn't enough on its own — a position can
    // close and the same swing can still be running when the cooldown
    // clock runs out. Require at least one scan since the close where
    // the score actually dropped back below the reset floor, proving
    // the setup cooled off rather than just that time passed.
    const reset =
      await hasScoreResetSince(
        symbol,
        lastClose.timestamp
      );

    if (!reset) {
      return {
        ok: false,
        reason: 're-entry cooldown (no score reset since close)',
      };
    }
  }

  return {
    ok: true,
  };
}

// ADDED: has this symbol's score dropped below
// CONFIG.reopenScoreResetFloor at any point since its last close? Used
// by canOpen() so a stopped-out position can't immediately re-open on
// the tail end of the same swing.
async function hasScoreResetSince(
  symbol,
  sinceIso
) {
  if (!supabase) {
    return true;
  }

  const { data, error } =
    await supabase
      .from('hunter_v11_snapshots')
      .select('id')
      .eq('symbol', symbol)
      .gt('timestamp', sinceIso)
      .lt('bootstrap_score', CONFIG.reopenScoreResetFloor)
      .limit(1);

  if (error) {
    console.error(`[DB] hasScoreResetSince: ${error.message}`);
    // Fail open on a DB error rather than permanently locking a symbol
    // out of re-entry because of a transient query failure.
    return true;
  }

  return Boolean(data && data.length);
}

// ADDED: resolves a 0-100 cream score to its lifecycle tier (CONFIG.TIERS).
function tierFor(score100) {
  for (const t of CONFIG.TIERS) {
    if (score100 >= t.min) return t;
  }
  return null;
}

// ADDED: looks up a tier by its stored name (positions.tier is persisted
// as a string).
function tierByName(name) {
  return CONFIG.TIERS.find(t => t.name === name) || CONFIG.TIERS[CONFIG.TIERS.length - 1];
}

// ADDED: is `tier` at least as advanced as `other`? CONFIG.TIERS is
// ordered highest-min-first, so a lower index is more advanced.
function tierAtLeast(tier, other) {
  return CONFIG.TIERS.indexOf(tier) <= CONFIG.TIERS.indexOf(other);
}

// ADDED: classifies a qualifying detection into one of three fixed
// execution profiles for Revolut X's set-once SL/TP order fields.
// Deliberately requires multiple independent signs (not score alone —
// score alone has proven an unreliable ranking signal in this system's
// own data) before granting a wider target. EXCEPTIONAL is meant to be
// rare; if it fires constantly it has stopped meaning anything.
function executionProfile(detection) {
  const f = detection.features;

  // CHANGED: score removed from both signal sets. Verified against real
  // data that entries in the 70-74 band have outperformed 90+ entries
  // in this system — so using score>=80/86 as a classification signal
  // was working against the evidence rather than with it. creamScore
  // still gates whether a detection opens at all (CONFIG.creamMinScore);
  // it's just no longer used to decide HOW FAR a position is allowed to
  // run once open. Runner threshold lowered 7->6 since the set shrank
  // from 9 signals to 8.
  const runnerSignals = [
    f.volumeRatio >= 2.5,
    f.volumeAcceleration >= 1.5,
    f.buyPressure >= 1.5,
    f.relativeStrength >= 0.02,
    f.momentumProfile >= 0.15,
    f.momentumAcceleration >= 1.25,
    f.parabolicExhaustion < 0.60,
    f.baseQuality >= 0.60 || f.firstPullbackContinuation === 1,
  ];
  const runnerCount = runnerSignals.filter(Boolean).length;

  const exceptionalSignals = [
    f.volumeRatio >= 3.0,
    f.volumeAcceleration >= 2.0,
    f.buyPressure >= 1.8,
    f.relativeStrength >= 0.04,
    f.momentumProfile >= 0.30,
    f.momentumAcceleration >= 1.5,
    f.parabolicExhaustion < 0.40,
    f.baseQuality >= 0.70 || f.firstPullbackContinuation === 1,
    f.firstPullbackContinuation === 1 || f.higherLow === 1,
  ];
  const exceptionalCount = exceptionalSignals.filter(Boolean).length;

  // CHANGED: EXCEPTIONAL multiple raised 7->9, and runner threshold
  // check below uses >=6 of 8 (was >=7 of 9) — both per the same
  // evidence-based refinement.
  if (exceptionalCount >= 8) return { label: 'EXCEPTIONAL', multiple: 9 };
  if (runnerCount >= 6) return { label: 'RUNNER', multiple: 6 };
  return { label: 'STANDARD', multiple: 4 };
}

// ADDED: fixed percentage SL/TP for Revolut X's Distance fields, set
// once at open and never touched again. Stop distance scales with the
// coin's own 15m ATR (clamped to a practical 5-14% range); target is
// the stop's own distance multiplied by the profile's R, deliberately
// wide (4R/6R/7R) so it acts as an unattended safety cap rather than a
// normal profit target that would sell a genuine runner early.
function calculateRevolutPercentLevels(detection) {
  const f = detection.features;
  const profile = executionProfile(detection);
  const atrPct = Math.max(0, Number(f.atrPct || 0) * 100);
  const stopAbsPct = Math.round(clamp(atrPct * 2.5, 5, 14));
  const targetPct = Math.min(
    Math.round(stopAbsPct * profile.multiple),
    profile.label === 'EXCEPTIONAL' ? 100 : 80
  );

  const entryPrice = f.currentPrice;

  return {
    profile: profile.label,
    stopLossPct: -stopAbsPct,
    takeProfitPct: targetPct,
    riskReward: profile.multiple,
    stopLossPrice: entryPrice * (1 - stopAbsPct / 100),
    takeProfitPrice: entryPrice * (1 + targetPct / 100),
  };
}

async function openPosition(
  detection
) {
  const f =
    detection.features;

  // ADDED: initial tier/stop state. soft_stop starts wide ("don't choke
  // the trade immediately" at tier 70); hard_stop is the crash backstop
  // underneath it. These columns already exist on hunter_v11_positions.
  // This tier/soft_stop/hard_stop tracking continues to run for every
  // position but no longer decides the close (see evaluateOpenPosition)
  // — it's kept purely as a parallel research signal, since the actual
  // close now happens on Revolut X via the fixed order below, outside
  // Hunter's control.
  const tier =
    tierFor(detection.creamScore) ||
    CONFIG.TIERS[CONFIG.TIERS.length - 1];

  // ADDED: the fixed SL/TP set once at open. stop_loss_price and
  // take_profit_price are the REAL close triggers now — they mirror
  // exactly what gets entered as a Revolut X bracket order, so Hunter's
  // own record of "closed" only means something if it tracks the same
  // price levels the actual order does.
  const levels =
    calculateRevolutPercentLevels(detection);

  const row =
    await dbInsert(
      'hunter_v11_positions',
      {
        symbol:
          detection.symbol,

        status:
          'OPEN',

        opened_at:
          iso(),

        open_price:
          f.currentPrice,

        last_price:
          f.currentPrice,

        last_score:
          detection.creamScore,

        last_similarity:
          detection.learning.similarity,

        last_update:
          iso(),

        detection_id:
          detection.detectionId || null,

        execution_profile:
          levels.profile,

        stop_loss_pct:
          levels.stopLossPct,

        take_profit_pct:
          levels.takeProfitPct,

        stop_loss_price:
          levels.stopLossPrice,

        take_profit_price:
          levels.takeProfitPrice,

        tier:
          tier.name,

        peak_price:
          f.currentPrice,

        peak_score:
          detection.creamScore,

        soft_stop:
          f.currentPrice * (1 - tier.soft),

        hard_stop:
          f.currentPrice * (1 - tier.hard),
      }
    );

  if (!row) {
    throw new Error('OPEN not persisted; alert suppressed');
  }

  const position = row;
  STATE.active.set(detection.symbol, position);

  const targetSimilarities =
    detection.learning
      .targetSimilarities || {};

  const bestTarget =
    Object.entries(
      targetSimilarities
    )
      .filter(
        ([, value]) =>
          value != null
      )
      .sort(
        (a, b) =>
          b[1] - a[1]
      )[0];

  const message =
    [
      `🟢 HUNTER OPEN — REVOLUT X`,
      ``,
      `${baseSymbol(detection.symbol)}`,
      `Profile: ${levels.profile}`,
      `SL: ${levels.stopLossPct}%`,
      `TP: +${levels.takeProfitPct}%  |  ${levels.riskReward}R`,
      ``,
      `Score: ${detection.creamScore.toFixed(0)} • ${detection.stage}`,
    ].join('\n');

  await insertAlert(
    detection.symbol,
    'OPEN',
    message,
    detection.detectionId || null,
    {
      creamScore:
        detection.creamScore,

      stage:
        detection.stage,

      learning:
        detection.learning,

      features:
        detection.features,

      executionLevels:
        levels,
    }
  );

  await alertUser(message);
}

async function updateOpenPosition(
  position,
  detection
) {
  const f =
    detection.features;

  const opened =
    num(
      position.open_price,
      f.currentPrice
    );

  const move =
    safePct(
      f.currentPrice,
      opened
    );

  // ADDED: ratchet peak price, tier, and both stop levels. Tier only
  // ever moves toward more advanced (never back down just because score
  // dipped); stops only ever move up.
  const peakPrice =
    Math.max(
      num(position.peak_price, opened),
      f.currentPrice
    );

  const peakScore =
    Math.max(
      num(position.peak_score, detection.creamScore),
      detection.creamScore
    );

  const storedTier = tierByName(position.tier);
  const currentTier = tierFor(detection.creamScore);
  const tier =
    currentTier && tierAtLeast(currentTier, storedTier)
      ? currentTier
      : storedTier;
  const tierChanged = tier.name !== storedTier.name;

  const softStop =
    Math.max(
      num(position.soft_stop, 0),
      peakPrice * (1 - tier.soft)
    );

  const hardStop =
    Math.max(
      num(position.hard_stop, 0),
      peakPrice * (1 - tier.hard)
    );

  const persisted = await dbUpdate(
    'hunter_v11_positions',
    {
      id:
        position.id,
    },
    {
      last_price:
        f.currentPrice,

      last_score:
        detection.creamScore,

      last_similarity:
        detection.learning.similarity,

      last_update:
        iso(),

      tier:
        tier.name,

      peak_price:
        peakPrice,

      peak_score:
        peakScore,

      soft_stop:
        softStop,

      hard_stop:
        hardStop,
    }
  );

  return {
    move,
    highest: f.currentPrice,
    lowest: f.currentPrice,
    persisted,
    tier,
    tierChanged,
    peakPrice,
    peakScore,
    softStop,
    hardStop,
  };
}

async function closePosition(
  position,
  detection,
  reason,
  exitPrice = null
) {
  const f =
    detection.features;

  const closePrice =
    exitPrice != null
      ? exitPrice
      : f.currentPrice;

  const opened =
    num(
      position.open_price,
      closePrice
    );

  const move =
    safePct(
      closePrice,
      opened
    );

  const persisted = await dbUpdate(
    'hunter_v11_positions',
    {
      id:
        position.id,
    },
    {
      status:
        'CLOSED',

      closed_at:
        iso(),

      close_price:
        closePrice,


      close_reason:
        reason,

      last_price:
        f.currentPrice,

      last_score:
        detection.creamScore,
    }
  );

  if (!persisted) {
    throw new Error('CLOSE not persisted; alert suppressed');
  }

  STATE.active.delete(
    detection.symbol
  );

  const message =
    [
      `🔴 HUNTER CLOSE`,
      ``,
      `${detection.symbol}`,
      `Price: ${f.currentPrice}`,
      `Move: ${pct(move).toFixed(1)}%`,
      ``,
      `Reason: ${reason}`,
      `Cream Score: ${detection.creamScore.toFixed(1)}`,
      `Stage: ${detection.stage}`,
      ``,
      `1h: ${pct(f.ret1h).toFixed(1)}%`,
      `4h: ${pct(f.ret4h).toFixed(1)}%`,
      `24h: ${pct(f.ret24h).toFixed(1)}%`,
    ].join('\n');

  await insertAlert(
    detection.symbol,
    'CLOSE',
    message,
    detection.detectionId || null,
    {
      reason,
      movePct:
        move * 100,
      features:
        detection.features,
    }
  );

  // CHANGED: was `await alertUser(message)` — CLOSE no longer pings
  // Telegram either. With a fixed SL/TP set once at open, Hunter isn't
  // the thing managing the exit — Revolut X's own order is — so a
  // Telegram close notification would just be Hunter narrating a trade
  // it isn't actually executing. The full record (status, close_price,
  // close_reason, move) is still written above for learning/audit.
}

async function evaluateOpenPosition(
  detection
) {
  const position =
    await currentOpen(
      detection.symbol
    );

  if (!position) {
    return false;
  }

  const result =
    await updateOpenPosition(
      position,
      detection
    );

  const f =
    detection.features;

  if (!result.persisted) {
    console.error(`[HUNTER] Position ${detection.symbol}: state update failed; no lifecycle alert emitted.`);
    return true;
  }

  // REMOVED: the flat "+150% target reached" auto-close directly
  // contradicted the point of the tier system below — don't cap the
  // winner, protect it with a trailing stop and let the coin decide when
  // it's done. A move past 150% now simply advances into
  // PARABOLIC_HOLD (see the tier-change block below) instead of being
  // sold at exactly +150% regardless of what the trend is doing.

  // CHANGED: this whole block used to be four separate close conditions
  // (momentum failure / 4h structure failure / parabolic exhaustion /
  // hard stop) plus a confirmed soft-stop check. All of that assumed
  // Hunter's own decision was what closed the trade. It isn't anymore —
  // once SL/TP are placed as a fixed order on Revolut X at open, THAT
  // order is what actually closes the position, on its own schedule,
  // with no way for Hunter to know about or influence it in between.
  // Any of the old conditions closing Hunter's DB record earlier than
  // the real order would just make the two diverge — the DB would say
  // "closed (parabolic exhaustion)" while the real Revolut position
  // sits open, still running toward its real TP or SL. So the only
  // thing that closes a position now is price actually crossing the
  // same take_profit_price / stop_loss_price stored at open — because
  // that's the only thing that mirrors reality. tier/peak/soft_stop/
  // hard_stop still update every cycle inside updateOpenPosition() above
  // — kept running purely as a parallel research signal (did an adaptive
  // trail exit early/late relative to what actually happened?), not as
  // a close trigger.
  const takeProfitPrice =
    num(position.take_profit_price, null);

  const stopLossPrice =
    num(position.stop_loss_price, null);

  const high =
    num(f.currentHigh, f.currentPrice);

  const low =
    num(f.currentLow, f.currentPrice);

  const tpTouched =
    takeProfitPrice &&
    high >= takeProfitPrice;

  const slTouched =
    stopLossPrice &&
    low <= stopLossPrice;

  // ADDED: both levels touched in the same 15m candle — OHLC data alone
  // can't tell which happened first (the real answer lives in Revolut's
  // own order history, which Hunter has no access to). Recording this
  // as an unqualified TP or SL would be a guess dressed up as fact.
  // Marked ambiguous, using the SL price for the recorded outcome so
  // anything built on top (win rate, avg return) stays conservative
  // rather than optimistic on an unknown.
  if (tpTouched && slTouched) {
    await closePosition(
      position,
      detection,
      'AMBIGUOUS (both SL and TP touched same candle)',
      stopLossPrice
    );

    return true;
  }

  if (tpTouched) {
    await closePosition(
      position,
      detection,
      'TP HIT',
      takeProfitPrice
    );

    return true;
  }

  if (slTouched) {
    await closePosition(
      position,
      detection,
      'SL HIT',
      stopLossPrice
    );

    return true;
  }
  // ADDED: tier progression replaces the old fixed-82 HOLD threshold.
  // updateOpenPosition() already resolved whether this scan advanced the
  // position to a more protective tier (score strengthened) — this just
  // announces it, together with confirmation that price has actually
  // moved favourably since open ("score progression + price progression
  // together", not score alone).
  const opened =
    num(position.open_price, f.currentPrice);

  if (
    result.tierChanged &&
    f.currentPrice > opened
  ) {
    const isParabolic = result.tier.name === 'PARABOLIC_HOLD';

    const message =
      [
        `${isParabolic ? '🚀 HUNTER PARABOLIC HOLD' : '🔵 HUNTER HOLD'}`,
        ``,
        `${detection.symbol}`,
        `Price: ${f.currentPrice}`,
        `Cream Score: ${detection.creamScore.toFixed(1)}/100`,
        `Tier: ${result.tier.name}`,
        ``,
        `Move since open: ${pct(result.move).toFixed(1)}%`,
        `Peak since open: ${pct(safePct(result.peakPrice, opened)).toFixed(1)}%`,
        `Stop raised to: ${result.softStop} (soft) / ${result.hardStop} (hard)`,
        ``,
        `1h: ${pct(f.ret1h).toFixed(1)}%`,
        `4h: ${pct(f.ret4h).toFixed(1)}%`,
        `24h: ${pct(f.ret24h).toFixed(1)}%`,
        `Volume: ${f.volumeRatio.toFixed(2)}x`,
        `Buy pressure: ${f.buyPressure.toFixed(2)}x`,
        ``,
        isParabolic
          ? `Not taking profit here. Trailing tightly, letting it run.`
          : `Thesis strengthening. SL raised, giving it room to continue.`,
      ].join('\n');

    await insertAlert(
      detection.symbol,
      'HOLD',
      message,
      detection.detectionId || null,
      {
        creamScore: detection.creamScore,
        tier: result.tier.name,
        softStop: result.softStop,
        hardStop: result.hardStop,
        stage: detection.stage,
      }
    );

    // CHANGED: was `await alertUser(message)` — HOLD no longer pings
    // Telegram. Tier/stop progression is still tracked and recorded
    // above for learning and audit; only the notification is silenced,
    // per the one-alert-at-open-then-silence policy. This is what a
    // fixed SL/TP order on Revolut X actually needs: Hunter doesn't
    // manage the trade live, so telling you it's doing so is just noise.
  }

  return true;
}

// -----------------------------
// Global ranking
// -----------------------------

async function rankOpenCandidates(
  detections,
  btcRisk
) {
  const candidates = [];

  for (
    const detection of detections
  ) {
    const candidate =
      openCandidate(
        detection,
        btcRisk
      );

    if (
      !candidate.eligible
    ) {
      continue;
    }

    const permission =
      await canOpen(
        detection.symbol
      );

    if (!permission.ok) {
      continue;
    }

    candidates.push({
      ...detection,

      priority:
        candidatePriority(
          detection
        ),
    });
  }

  candidates.sort(
    (a, b) =>
      b.priority -
      a.priority
  );

  return candidates;
}

// -----------------------------
// Cycle
// -----------------------------

async function getBtcCandles() {
  const result =
    await candlesFor(
      'BTCUSDT'
    );

  return result?.candles || null;
}

async function refreshUniverse() {
  const now =
    Date.now();

  if (
    STATE.universe.length >=
      CONFIG.minAssets &&
    now -
      STATE.universeAt <
      CONFIG.universeRefreshMs
  ) {
    return STATE.universe;
  }

  const universe =
    await discoverUniverse();

  STATE.universe =
    universe;

  STATE.universeAt =
    now;

  console.log(`[HUNTER] Universe refreshed: ${universe.length} assets`);
  await persistDynamicUniverse(universe);
  return universe;
}

async function scanUniverse(
  universe,
  btcCandles,
  learningModel
) {
  const detections = [];

  for (
    let i = 0;
    i < universe.length;
    i += CONFIG.batchSize
  ) {
    const batch =
      universe.slice(
        i,
        i +
          CONFIG.batchSize
      );

    const results =
      await Promise.all(
        batch.map(
          asset =>
            analyseAsset(
              asset,
              btcCandles,
              learningModel
            ).catch(
              error => {
                console.error(
                  `[HUNTER] ${asset.symbol}: ${error.message}`
                );

                return null;
              }
            )
        )
      );

    for (
      const detection of results
    ) {
      if (!detection) {
        continue;
      }

      detections.push(
        detection
      );
    }

    if (
      i +
        CONFIG.batchSize <
      universe.length
    ) {
      await sleep(
        CONFIG.batchPauseMs
      );
    }
  }

  return detections;
}

async function persistDetections(detections) {
  if (!detections.length) return;

  const fieldAverage = avg(detections.map(d => d.creamScore));
  const btcRisk = STATE.btcRisk || { label: 'UNKNOWN' };
  const concurrency = 8;

  // Persistence is deliberately concurrent but bounded. The previous
  // one-asset-at-a-time implementation could spend most of a 15-minute
  // cycle waiting on hundreds of independent Supabase round trips.
  for (let i = 0; i < detections.length; i += concurrency) {
    const batch = detections.slice(i, i + concurrency);

    await Promise.all(batch.map(async detection => {
      try {
        const snapshot = await saveSnapshot(
          detection.asset,
          detection.features,
          detection.bootstrapScore,
          detection.learning.similarity,
          detection.learning.mode
        );

        await createExample(
          snapshot?.id || null,
          detection.asset,
          detection.features
        );

        const detectionRow = await saveDetection(detection);
        detection.detectionId = detectionRow?.id || null;

        await saveObservationHistory(
          detection,
          btcRisk,
          fieldAverage
        );

        // Label older examples against this asset's own subsequent candles.
        // This is independent of whether the asset generated an alert.
        await labelRecentExamples(detection.symbol, detection.candles);
        await labelObservationHistory(detection.symbol, detection.candles);
      } catch (error) {
        console.error(
          `[HUNTER] Persistence ${detection.symbol}: ${error.message}`
        );
      }
    }));
  }
}

async function loadActivePositions() {
  STATE.active.clear();
  if (!supabase) return 0;

  const { data, error } = await supabase
    .from('hunter_v11_positions')
    .select('*')
    .eq('status', 'OPEN');

  if (error) {
    throw new Error(`Unable to load open positions: ${error.message}`);
  }

  for (const position of data || []) {
    STATE.active.set(position.symbol, position);
  }

  return STATE.active.size;
}

async function processExistingPositions(
  detections
) {
  for (
    const detection of detections
  ) {
    try {
      await evaluateOpenPosition(
        detection
      );
    } catch (error) {
      console.error(
        `[HUNTER] Position ${detection.symbol}: ${error.message}`
      );
    }
  }
}

async function openBestCandidates(
  detections,
  btcRisk
) {
  const candidates =
    await rankOpenCandidates(
      detections,
      btcRisk
    );

  if (
    !candidates.length
  ) {
    console.log(
      '[HUNTER] No cream candidates this cycle.'
    );

    return [];
  }

  /*
   * Global cap, not per-asset.
   *
   * This is critical:
   * Hunter must choose the very best opportunities
   * from the entire scan, rather than firing because
   * several assets independently pass the threshold.
   */
  let existingOpenCount = STATE.active.size;

  // Re-read the authoritative DB count before allocating slots. This protects
  // against a restart and also reduces the chance of exceeding the global cap
  // if more than one service instance briefly overlaps.
  if (supabase) {
    const { count, error } = await supabase
      .from('hunter_v11_positions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'OPEN');

    if (!error && Number.isFinite(count)) {
      existingOpenCount = count;
    }
  }

  const availableSlots =
    Math.max(
      0,
      CONFIG.maxOpenPositions -
        existingOpenCount
    );

  const slots =
    Math.min(
      availableSlots,
      CONFIG.creamMaxOpenPerCycle
    );

  const selected =
    candidates.slice(
      0,
      slots
    );

  console.log(
    `[HUNTER] Cream candidates=${candidates.length}; selected=${selected.length}; open=${existingOpenCount}/${CONFIG.maxOpenPositions}`
  );

  if (
    candidates.length
  ) {
    console.log(
      '[HUNTER] Top candidates:',
      candidates
        .slice(0, 8)
        .map(
          x =>
            `${x.symbol}:${x.priority.toFixed(1)}`
        )
        .join(' | ')
    );
  }

  for (
    const detection of selected
  ) {
    try {
      await openPosition(
        detection
      );
    } catch (error) {
      console.error(
        `[HUNTER] OPEN ${detection.symbol}: ${error.message}`
      );
    }
  }

  return selected;
}

async function refreshRegimeAndWeeklyStatistics() {
  if (!supabase) return;

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 86400000);
  const startIso = periodStart.toISOString();
  const endIso = periodEnd.toISOString();

  const { data, error } = await supabase
    .from('hunter_observation_history')
    .select('symbol,alert_id,hunter_score,btc_regime,setup_type,tp1_hit,tp2_hit,gain_pct,max_favourable_excursion,max_adverse_excursion,is_resolved,calculated_at')
    .eq('asset_type', 'CRYPTO')
    .gte('calculated_at', startIso)
    .lte('calculated_at', endIso);

  if (error || !data?.length) return;

  const resolved = data.filter(r => r.is_resolved);
  const byRegime = new Map();

  for (const row of data) {
    const key = `${row.btc_regime || 'UNKNOWN'}|${row.setup_type || 'UNKNOWN'}`;
    if (!byRegime.has(key)) byRegime.set(key, []);
    byRegime.get(key).push(row);
  }

  for (const [key, rows] of byRegime) {
    const [btcRegime, setupType] = key.split('|');
    const done = rows.filter(r => r.is_resolved);
    const tp1 = done.filter(r => r.tp1_hit === true).length;
    const tp2 = done.filter(r => r.tp2_hit === true).length;
    const gains = done.map(r => num(r.gain_pct)).filter(Number.isFinite);

    await dbUpsert(
      'hunter_regime_statistics',
      {
        period_start: startIso,
        period_end: endIso,
        btc_regime: btcRegime || 'UNKNOWN',
        qqq_regime: 'N/A',
        asset_type: 'CRYPTO',
        setup_type: setupType || 'UNKNOWN',
        theme: null,
        alert_count: rows.filter(r => r.alert_id != null).length,
        resolved_count: done.length,
        confidence_level: confidenceLabel(done.length),
        tp1_rate: done.length ? tp1 / done.length : null,
        tp1_rate_ci_lower: null,
        tp1_rate_ci_upper: null,
        tp2_rate: done.length ? tp2 / done.length : null,
        tp2_rate_ci_lower: null,
        tp2_rate_ci_upper: null,
        stop_rate: null,
        stop_rate_ci_lower: null,
        stop_rate_ci_upper: null,
        avg_hunter_score: avg(rows.map(r => num(r.hunter_score))) || null,
        avg_duration_minutes: null,
        avg_gain_pct: avg(gains) || null,
        avg_loss_pct: avg(gains.filter(x => x < 0)) || null,
        calculated_at: nowIso(),
        source_max_timestamp: endIso,
        analytics_version: 'v2.0.0',
        formula_version: 'hunter-v14.2',
      },
      'period_start,btc_regime,qqq_regime,asset_type,setup_type,theme'
    );
  }

  const scoreSorted = [...data].sort((a, b) => num(b.hunter_score) - num(a.hunter_score));
  const top5 = [...new Set(scoreSorted.slice(0, 5).map(r => r.symbol))];
  const top10 = [...new Set(scoreSorted.slice(0, 10).map(r => r.symbol))];
  const regimeCounts = {};
  for (const row of data) regimeCounts[row.btc_regime || 'UNKNOWN'] = (regimeCounts[row.btc_regime || 'UNKNOWN'] || 0) + 1;
  const dominantRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'UNKNOWN';
  const highest = scoreSorted[0];

  // Monday-start week, matching the database's weekly reporting semantics.
  const weekStart = new Date(periodEnd);
  const day = weekStart.getUTCDay();
  const delta = day === 0 ? 6 : day - 1;
  weekStart.setUTCDate(weekStart.getUTCDate() - delta);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000 - 1);

  await dbUpsert(
    'hunter_weekly_statistics',
    {
      week_start: weekStart.toISOString().slice(0, 10),
      week_end: weekEnd.toISOString().slice(0, 10),
      btc_regime_dominant: dominantRegime,
      qqq_regime_dominant: 'N/A',
      total_snapshots: data.length,
      universe_size: STATE.universe.length,
      distinct_top5_assets: top5.length,
      distinct_top10_assets: top10.length,
      leader_changes: null,
      stability_label: top5.length <= 3 ? 'STABLE' : top5.length <= 5 ? 'ROTATING' : 'HIGH_ROTATION',
      market_confidence: Math.round(clamp(resolved.length / 100, 0, 1) * 100),
      new_top5_entries: null,
      dropped_top5: null,
      new_top10_entries: null,
      dropped_top10: null,
      asset_rankings: scoreSorted.slice(0, 20).map((r, i) => ({ symbol: r.symbol, rank: i + 1, score: num(r.hunter_score) })),
      champion_symbol: highest?.symbol || null,
      champion_avg_rank: highest ? 1 : null,
      most_persistent_symbol: top5[0] || null,
      biggest_climber_symbol: highest?.symbol || null,
      biggest_climber_places: null,
      biggest_faller_symbol: null,
      biggest_faller_places: null,
      highest_score_symbol: highest?.symbol || null,
      highest_score_value: highest ? num(highest.hunter_score) : null,
      calculated_at: nowIso(),
      source_max_timestamp: endIso,
      analytics_version: 'v2.0.0',
      formula_version: 'hunter-v14.2',
    },
    'week_start'
  );
}

// ADDED: weekly Telegram performance summary. Deliberately narrower
// than a full trading-analytics suite — with roughly a week of history
// on the new execution-profile system, metrics like max drawdown,
// win/loss streaks, and profit factor would be reporting noise dressed
// up as insight. This covers what's actually measurable and useful now:
// win rate (and separately, TP-hit rate, since a profitable manual
// close isn't the same thing as the fixed order actually being hit),
// best/worst trade, results by execution profile, how far positions
// moved past +10/+25/+50/+100%, and whether any SL-hit position went on
// to reach its own take-profit level anyway (the same "after close"
// check already done manually earlier in this project, now automated).
function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function generateWeeklyReport() {
  if (!supabase) return;

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 86400000);
  const weekStart = periodStart.toISOString().slice(0, 10);

  // Guard against sending more than once per week regardless of cycle
  // timing drift — check before doing any of the (cheap but pointless
  // to repeat) computation below.
  const { data: existing } = await supabase
    .from('hunter_weekly_reports')
    .select('id')
    .eq('week_start', weekStart)
    .limit(1);

  if (existing && existing.length) return;

  const { data: positions, error } = await supabase
    .from('hunter_v11_positions')
    .select('symbol,status,open_price,close_price,close_reason,peak_price,execution_profile,opened_at')
    .gte('opened_at', periodStart.toISOString())
    .lte('opened_at', periodEnd.toISOString());

  if (error || !positions || !positions.length) return;

  const resolved = positions.filter(p => p.status === 'CLOSED');
  const openNow = positions.filter(p => p.status === 'OPEN');

  const withReturn = resolved.map(p => ({
    ...p,
    returnPct: safePct(p.close_price, p.open_price) * 100,
    peakPct: safePct(p.peak_price, p.open_price) * 100,
  }));

  const tpHits = withReturn.filter(p => p.close_reason === 'TP HIT');
  const slHits = withReturn.filter(p => p.close_reason === 'SL HIT');
  const profitWins = withReturn.filter(p => p.returnPct > 0);

  const returns = withReturn.map(p => p.returnPct);
  const avgReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const medianReturn = median(returns);

  const best = withReturn.reduce((a, b) => (!a || b.returnPct > a.returnPct ? b : a), null);
  const worst = withReturn.reduce((a, b) => (!a || b.returnPct < a.returnPct ? b : a), null);

  const byProfile = {};
  for (const p of withReturn) {
    const key = p.execution_profile || 'UNKNOWN';
    (byProfile[key] ||= []).push(p);
  }
  const profileStats = Object.fromEntries(
    Object.entries(byProfile).map(([key, rows]) => [
      key,
      {
        trades: rows.length,
        winRate: Math.round((rows.filter(r => r.returnPct > 0).length / rows.length) * 1000) / 10,
        avgReturn: Math.round((rows.reduce((a, r) => a + r.returnPct, 0) / rows.length) * 10) / 10,
      },
    ])
  );

  // Move capture uses peak_price against ALL positions this week (not
  // just resolved), since a still-open position can still have already
  // touched +25% on its way to wherever it ends up.
  const allPeaks = positions.map(p => safePct(p.peak_price, p.open_price) * 100);
  const moveCapture = {
    reached10: allPeaks.filter(p => p >= 10).length,
    reached25: allPeaks.filter(p => p >= 25).length,
    reached50: allPeaks.filter(p => p >= 50).length,
    reached100: allPeaks.filter(p => p >= 100).length,
  };

  // Premature-close-miss check: of the SL-hit trades, how many had a
  // peak that had already reached (or later data would show reaching)
  // a meaningful gain? peak_price already captures "since open", so a
  // meaningful positive peak alongside an SL-hit close means real
  // volatility, not necessarily a miss — the honest per-symbol check
  // (does price later reach the ORIGINAL take-profit) needs a follow-up
  // snapshot query per symbol, which is exactly what was done manually
  // for LSK/SYN earlier. Kept simple here: count SL-hit trades whose
  // peak before the close already exceeded +25%, as a cheap proxy that
  // doesn't require per-symbol snapshot lookups every week.
  const prematureMisses = slHits.filter(p => p.peakPct >= 25).length;

  const reportText =
    [
      `📊 HUNTER WEEKLY`,
      ``,
      `${weekStart} to ${periodEnd.toISOString().slice(0, 10)}`,
      ``,
      `Opened: ${positions.length}  •  Resolved: ${resolved.length}  •  Open: ${openNow.length}`,
      `Win rate: ${resolved.length ? Math.round((profitWins.length / resolved.length) * 1000) / 10 : 0}%`,
      `TP hit: ${tpHits.length}  •  SL hit: ${slHits.length}`,
      ``,
      `Avg return: ${avgReturn.toFixed(1)}%  •  Median: ${medianReturn == null ? 'n/a' : medianReturn.toFixed(1) + '%'}`,
      best ? `Best: ${baseSymbol(best.symbol)} ${best.returnPct.toFixed(1)}%` : ``,
      worst ? `Worst: ${baseSymbol(worst.symbol)} ${worst.returnPct.toFixed(1)}%` : ``,
      ``,
      `By profile:`,
      ...Object.entries(profileStats).map(
        ([key, s]) => `${key}: ${s.trades} trades • ${s.winRate}% win • ${s.avgReturn >= 0 ? '+' : ''}${s.avgReturn}% avg`
      ),
      ``,
      `Move capture (peak since open):`,
      `+10%: ${moveCapture.reached10}  •  +25%: ${moveCapture.reached25}  •  +50%: ${moveCapture.reached50}  •  +100%: ${moveCapture.reached100}`,
      ``,
      `Possible premature SL (peak was already +25%+): ${prematureMisses}`,
      ``,
      `Note: measures market price against the fixed levels set at open, not confirmed Revolut fills — Hunter can't currently tell which signals were actually acted on.`,
    ]
      .filter(line => line !== ``)
      .join('\n');

  await dbUpsert(
    'hunter_weekly_reports',
    {
      week_start: weekStart,
      week_end: periodEnd.toISOString().slice(0, 10),
      opened_count: positions.length,
      resolved_count: resolved.length,
      open_count: openNow.length,
      tp_hit_count: tpHits.length,
      sl_hit_count: slHits.length,
      profit_win_rate: resolved.length ? (profitWins.length / resolved.length) * 100 : null,
      tp_hit_rate: resolved.length ? (tpHits.length / resolved.length) * 100 : null,
      avg_return_pct: avgReturn,
      median_return_pct: medianReturn,
      best_trade_symbol: best ? best.symbol : null,
      best_trade_return_pct: best ? best.returnPct : null,
      worst_trade_symbol: worst ? worst.symbol : null,
      worst_trade_return_pct: worst ? worst.returnPct : null,
      profile_stats: profileStats,
      move_capture: moveCapture,
      premature_close_misses: prematureMisses,
      report_text: reportText,
    },
    'week_start'
  );

  await alertUser(reportText);
}

async function runCycle() {
  if (
    STATE.cycleRunning
  ) {
    console.log(
      '[HUNTER] Previous cycle still running; skipping.'
    );

    return;
  }

  STATE.cycleRunning =
    true;

  STATE.cycle++;

  const started =
    Date.now();

  console.log(
    `\n========== HUNTER CYCLE ${STATE.cycle} ==========`
  );

  try {
    const universe =
      await refreshUniverse();

    const btcCandles =
      await getBtcCandles();

    if (
      !btcCandles ||
      btcCandles.length <
        CONFIG.minCandles
    ) {
      throw new Error(
        'BTC market reference unavailable'
      );
    }

    const btcFeatures =
      calcFeatures(
        btcCandles,
        btcCandles
      );

    const btcRisk = btcRiskState(btcFeatures);
    STATE.btcRisk = btcRisk;

    console.log(
      `[HUNTER] BTC risk=${btcRisk.label} 1h=${pct(btcFeatures.ret1h).toFixed(2)}% 4h=${pct(btcFeatures.ret4h).toFixed(2)}%`
    );

    const learning =
      await getLearningModel();

    STATE.learning =
      learning;

    console.log(
      `[HUNTER] Learning +10=${learning.counts[10]} +50=${learning.counts[50]} +100=${learning.counts[100]} +150=${learning.counts[150]} negative=${learning.counts.negative}`
    );

    const detections =
      await scanUniverse(
        universe,
        btcCandles,
        learning
      );

    console.log(
      `[HUNTER] Scanned ${universe.length}; valid detections=${detections.length}`
    );

    const notable = [...detections]
      .filter(d => d.creamScore >= CONFIG.creamMinScore)
      .sort((a, b) => b.creamScore - a.creamScore)
      .slice(0, 10);

    if (notable.length) {
      console.log(
        '[HUNTER] 70+ detections:',
        notable.map(d =>
          `${d.symbol}:${d.creamScore.toFixed(1)} readiness=${num(d.alertReadiness).toFixed(1)} signals=${d.signalCount} stage=${d.stage}`
        ).join(' | ')
      );
    }

    // ADDED: compute each detection's pass/fail reasons up front so
    // saveDetection() can persist WHY, not just the score. openCandidate()
    // is a pure function of detection.features/creamScore/bootstrapScore/
    // learning plus btcRisk (no side effects) — it's already called again
    // later when ranking/opening candidates, so this doesn't change any
    // decision, it just captures the reasons before they'd otherwise be
    // thrown away.
    for (const detection of detections) {
      const gateCheck = openCandidate(detection, btcRisk);
      detection.reasons = gateCheck.eligible ? [] : gateCheck.reasons;
    }

    // Persist everything — even assets that
    // never come close to an alert threshold.
    // That is the learning engine.
    await persistDetections(detections);
    await updateWatchlist(detections, btcRisk);
    await refreshPredictiveStatistics();
    await refreshRegimeAndWeeklyStatistics();

    // ADDED: weekly Telegram summary — see generateWeeklyReport() for
    // why this is deliberately narrower than a full analytics suite.
    // Monday 08:00-08:14 UTC is an arbitrary but fixed window; the
    // real guard against duplicate sends is the week_start existence
    // check inside the function itself, not this time window.
    const now = new Date();
    if (now.getUTCDay() === 1 && now.getUTCHours() === 8) {
      await generateWeeklyReport();
    }

    // Existing OPEN positions get evaluated
    // before new positions are considered.
    await processExistingPositions(
      detections
    );

    /*
     * Recalculate available slots after CLOSEs.
     */
    await openBestCandidates(
      detections,
      btcRisk
    );

    const elapsed =
      Date.now() -
      started;

    console.log(
      `[HUNTER] Cycle ${STATE.cycle} complete in ${(elapsed / 1000).toFixed(1)}s`
    );
  } catch (error) {
    console.error(
      `[HUNTER] Cycle failed: ${error.stack || error.message}`
    );
  } finally {
    STATE.cycleRunning =
      false;
  }
}

// -----------------------------
// Startup
// -----------------------------

async function startup() {
  console.log(
    '=================================================='
  );

  console.log(
    'HUNTER V14.2 — CRYPTO EARLY-MOVE LEARNING ENGINE'
  );

  console.log(
    '=================================================='
  );

  console.log(
    `[HUNTER] Live alerts: ${ENV.HUNTER_LIVE}`
  );

  console.log(
    `[HUNTER] Supabase: ${Boolean(supabase)}`
  );

  console.log(
    `[HUNTER] Universe: ${CONFIG.minAssets}-${CONFIG.maxAssets}`
  );

  console.log(
    `[HUNTER] Max open positions: ${CONFIG.maxOpenPositions}`
  );

  console.log(
    `[HUNTER] Max new OPENs/cycle: ${CONFIG.creamMaxOpenPerCycle}`
  );

  console.log(
    `[HUNTER] Cream threshold: ${CONFIG.creamMinScore}/100`
  );

  console.log(
    `[HUNTER] Learning maturity: ${CONFIG.minPositiveExamples} positive examples`
  );

  if (
    !ENV.BOT_TOKEN
  ) {
    console.warn(
      '[HUNTER] BOT_TOKEN missing'
    );
  }

  if (
    !ENV.BLUEJAM_CHAT_ID
  ) {
    console.warn(
      '[HUNTER] BLUEJAM_CHAT_ID / CHAT_ID missing'
    );
  }

  if (
    !supabase
  ) {
    console.warn(
      '[HUNTER] Supabase unavailable — learning persistence disabled.'
    );
  }

  if (supabase) {
    const openCount = await loadActivePositions();
    console.log(`[HUNTER] Restored open positions: ${openCount}`);
  }

  await runCycle();

  setInterval(
    runCycle,
    CONFIG.cycleMs
  );
}

process.on(
  'unhandledRejection',
  error => {
    console.error(
      '[HUNTER] Unhandled rejection:',
      error
    );
  }
);

process.on(
  'uncaughtException',
  error => {
    console.error(
      '[HUNTER] Uncaught exception:',
      error
    );
  }
);

startup().catch(
  error => {
    console.error(
      '[HUNTER] Startup failed:',
      error.stack || error.message
    );

    process.exit(1);
  }
);
