'use strict';

/**
 * HUNTER V12 — crypto-only early-move discovery + learning engine
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

  candleLimit: 400,
  minCandles: 60,

  batchSize: 8,
  batchPauseMs: 500,

  requestTimeoutMs: 12000,
  maxRetries: 2,

  universeRefreshMs: 30 * 60 * 1000,

  openCooldownMs: 6 * 60 * 60 * 1000,
  holdCooldownMs: 8 * 60 * 60 * 1000,
  reopenCooldownMs: 12 * 60 * 60 * 1000,
  closeCooldownMs: 60 * 60 * 1000,

  maxOpenPositions: 3,
  holdMinScoreImprovement: 0.05,

  openSimilarityThreshold: 0.70,
  openBootstrapScore: 0.82,
  minPositiveExamples: 20,

  creamMinScore: 82,
  creamMaxOpenPerCycle: 2,

  creamMinRet15m: 0.001,
  creamMinRet1h: 0.003,
  creamMinRet4h: 0.015,

  creamMinVolumeRatio: 2.0,
  creamMinVolumeAcceleration: 1.20,

  creamMinBuyPressure: 1.25,
  creamMinRelativeStrength: 0.01,

  creamMinBaseQuality: 0.50,
  creamMinMoveQuality: 0.55,

  creamMaxRet4h: 0.20,
  creamMaxRet24h: 0.25,

  creamMaxExhaustion: 0.65,

  // Must cover the longest +150% learning horizon (96h)
  // plus a useful safety buffer.
  learningLookbackHours: 120,

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

  active: new Map(),

  providerHealth: new Map(),

  featureCache: new Map(),

  learning: null,
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
          'User-Agent': 'Hunter/12.0 crypto-only',
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

  const eligible = [...merged.values()]
    .filter(
      item =>
        !banned.test(item.symbol) &&
        item.quoteVolume >=
          CONFIG.minQuoteVolume24h
    );

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
      `Universe only ${selected.length}; minimum is ${CONFIG.minAssets}`
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
        .slice(0, -1)
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

    volumeProfile:
      clamp(
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
          ignoreDuplicates: true,
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

async function getLearningModel() {
  const empty = {
    byTarget: {
      10: [],
      50: [],
      100: [],
      150: [],
    },

    negatives: [],

    counts: {
      10: 0,
      50: 0,
      100: 0,
      150: 0,
      negative: 0,
    },
  };

  if (!supabase) {
    return empty;
  }

  const {
    data,
    error,
  } =
    await supabase
      .from(
        'hunter_v11_examples'
      )
      .select(
        'feature_vector,outcome_10,outcome_50,outcome_100,outcome_150'
      )
      .order(
        'timestamp',
        {
          ascending: false,
        }
      )
      .limit(4000);

  if (error) {
    console.error(
      `[DB] hunter_v11_examples: ${error.message}`
    );

    return empty;
  }

  const model = empty;

  for (
    const row of data || []
  ) {
    const vector =
      Array.isArray(
        row.feature_vector
      )
        ? row.feature_vector
        : null;

    if (
      !vector ||
      vector.length !==
        CONFIG.featureNames.length
    ) {
      continue;
    }

    if (
      row.outcome_10 === true
    ) {
      model.byTarget[10]
        .push(vector);
    }

    if (
      row.outcome_50 === true
    ) {
      model.byTarget[50]
        .push(vector);
    }

    if (
      row.outcome_100 === true
    ) {
      model.byTarget[100]
        .push(vector);
    }

    if (
      row.outcome_150 === true
    ) {
      model.byTarget[150]
        .push(vector);
    }

    if (
      row.outcome_10 === false
    ) {
      model.negatives.push(
        vector
      );
    }
  }

  for (
    const target of
    [10, 50, 100, 150]
  ) {
    model.counts[target] =
      model.byTarget[target]
        .length;
  }

  model.counts.negative =
    model.negatives.length;

  return model;
}

function topSimilarity(
  vector,
  examples,
  limit = 12
) {
  if (
    !examples?.length
  ) {
    return null;
  }

  const compatible =
    examples.filter(
      candidate =>
        Array.isArray(
          candidate
        ) &&
        candidate.length ===
          vector.length
    );

  if (!compatible.length) {
    return null;
  }

  const similarities =
    compatible
      .map(
        candidate =>
          cosine(
            vector,
            candidate
          )
      )
      .sort(
        (a, b) => b - a
      )
      .slice(0, limit);

  return avg(
    similarities
  );
}

function learnedSimilarity(
  vector,
  model
) {
  const similarities = {
    10:
      topSimilarity(
        vector,
        model.byTarget[10]
      ),

    50:
      topSimilarity(
        vector,
        model.byTarget[50]
      ),

    100:
      topSimilarity(
        vector,
        model.byTarget[100]
      ),

    150:
      topSimilarity(
        vector,
        model.byTarget[150]
      ),
  };

  const available =
    Object.values(
      similarities
    ).filter(
      value => value != null
    );

  if (!available.length) {
    return {
      similarity: null,
      contrast: null,
      targetSimilarities:
        similarities,
      mode: 'BOOTSTRAP',
    };
  }

  const counts = {
    10:
      model.byTarget[10]
        .length,

    50:
      model.byTarget[50]
        .length,

    100:
      model.byTarget[100]
        .length,

    150:
      model.byTarget[150]
        .length,
  };

  const matureTargets =
    Object.values(
      counts
    ).filter(
      value =>
        value >=
        CONFIG.minPositiveExamples
    ).length;

  if (
    matureTargets === 0
  ) {
    return {
      similarity: null,
      contrast: null,
      targetSimilarities:
        similarities,
      mode: 'BOOTSTRAP',
    };
  }

  const best =
    Math.max(
      ...available
    );

  let contrast = null;

  if (
    model.negatives.length
  ) {
    const negativeSimilarity =
      topSimilarity(
        vector,
        model.negatives
      );

    contrast =
      best -
      negativeSimilarity;
  }

  return {
    similarity: best,
    contrast,
    targetSimilarities:
      similarities,
    mode: 'LEARNED',
  };
}

async function labelRecentExamples(
  symbol,
  candles
) {
  if (
    !supabase ||
    !candles?.length
  ) {
    return;
  }

  const oldest =
    Date.now() -
    CONFIG.learningLookbackHours *
      3600000;

  const {
    data,
    error,
  } =
    await supabase
      .from(
        'hunter_v11_examples'
      )
      .select(
        'id,timestamp,price,outcome_10,outcome_50,outcome_100,outcome_150'
      )
      .eq(
        'symbol',
        symbol
      )
      .gte(
        'timestamp',
        iso(oldest)
      )
      .is(
        'resolved_at',
        null
      )
      .order(
        'timestamp',
        {
          ascending: true,
        }
      )
      .limit(100);

  if (
    error ||
    !data?.length
  ) {
    return;
  }

  for (
    const example of data
  ) {
    const timestamp =
      new Date(
        example.timestamp
      ).getTime();

    const ageHours =
      (Date.now() -
        timestamp) /
      3600000;

    const updates = {};

    let allResolved = true;

    for (
      const [
        target,
        hours,
      ] of Object.entries(
        CONFIG.horizons
      )
    ) {
      const column =
        `outcome_${target}`;

      if (
        example[column] !==
        null
      ) {
        continue;
      }

      if (
        ageHours < hours
      ) {
        allResolved = false;
        continue;
      }

      const end =
        timestamp +
        hours * 3600000;

      const future =
        candles.filter(
          candle =>
            candle.time >=
              timestamp &&
            candle.time <=
              end
        );

      const maxPrice =
        future.length
          ? Math.max(
              ...future.map(
                candle =>
                  candle.high
              )
            )
          : example.price;

      const minPrice =
        future.length
          ? Math.min(
              ...future.map(
                candle =>
                  candle.low
              )
            )
          : example.price;

      const threshold =
        example.price *
        (1 +
          Number(target) /
            100);

      updates[column] =
        maxPrice >=
        threshold;

      if (
        target === '10'
      ) {
        updates.mfe_pct_24h =
          ((maxPrice -
            example.price) /
            example.price) *
          100;

        updates.mae_pct_24h =
          ((minPrice -
            example.price) /
            example.price) *
          100;
      }

      const hit =
        future.find(
          candle =>
            candle.high >=
            threshold
        );

      if (hit) {
        updates[
          `time_to_${target}_min`
        ] =
          Math.max(
            0,
            (hit.time -
              timestamp) /
              60000
          );
      }
    }

    if (
      Object.keys(
        updates
      ).length
    ) {
      const resolved =
        allResolved ||
        [
          '10',
          '50',
          '100',
          '150',
        ].every(
          key =>
            updates[
              `outcome_${key}`
            ] !==
              undefined ||
            example[
              `outcome_${key}`
            ] !== null
        );

      await dbUpdate(
        'hunter_v11_examples',
        {
          id:
            example.id,
        },
        {
          ...updates,
          resolved_at:
            resolved
              ? iso()
              : null,
        }
      );
    }
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

  let score =
    historical * 25 +
    momentum * 20 +
    volume * 15 +
    buying * 15 +
    structure * 10 +
    relative * 10 +
    early * 5;

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
    return {
      blocked: true,
      penalty: 25,
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

function creamGate(
  f,
  learning,
  btcRisk
) {
  const reasons = [];

  if (
    f.ret15m <
    CONFIG.creamMinRet15m
  ) {
    reasons.push('15m');
  }

  if (
    f.ret1h <
    CONFIG.creamMinRet1h
  ) {
    reasons.push('1h');
  }

  if (
    f.ret4h <
    CONFIG.creamMinRet4h
  ) {
    reasons.push('4h');
  }

  if (
    f.volumeRatio <
    CONFIG.creamMinVolumeRatio
  ) {
    reasons.push('volume');
  }

  if (
    f.volumeAcceleration <
    CONFIG.creamMinVolumeAcceleration
  ) {
    reasons.push('volume acceleration');
  }

  if (
    f.buyPressure <
    CONFIG.creamMinBuyPressure
  ) {
    reasons.push('buying');
  }

  if (
    f.relativeStrength <
    CONFIG.creamMinRelativeStrength
  ) {
    reasons.push('BTC relative strength');
  }

  if (
    f.ret4h >
    CONFIG.creamMaxRet4h
  ) {
    reasons.push('too far 4h');
  }

  if (
    f.ret24h >
    CONFIG.creamMaxRet24h
  ) {
    reasons.push('too far 24h');
  }

  if (
    f.parabolicExhaustion >
    CONFIG.creamMaxExhaustion
  ) {
    reasons.push('exhaustion');
  }

  if (
    f.baseQuality <
      CONFIG.creamMinBaseQuality &&
    !f.firstPullbackContinuation
  ) {
    reasons.push('structure');
  }

  if (
    f.momentumProfile <
    0.05
  ) {
    reasons.push('momentum');
  }

  if (
    f.volumeProfile <
    0
  ) {
    reasons.push('volume profile');
  }

  if (
    btcRisk?.blocked
  ) {
    reasons.push('BTC risk-off');
  }

  if (
    learning.mode === 'LEARNED'
  ) {
    if (
      learning.similarity <
      CONFIG.openSimilarityThreshold
    ) {
      reasons.push('learning similarity');
    }

    if (
      learning.contrast == null ||
      learning.contrast <
        0.08
    ) {
      reasons.push('learning contrast');
    }
  }

  return {
    pass:
      reasons.length === 0,
    reasons,
  };
}

function candidatePriority(
  detection
) {
  let score =
    detection.creamScore;

  const f =
    detection.features;

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

    timestamp:
      features.candleTime,
  };

  return detection;
}

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

      learned_similarity:
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

      mode:
        detection.learning.mode,

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

function openCandidate(
  detection,
  btcRisk
) {
  const f =
    detection.features;

  const learning =
    detection.learning;

  const gate =
    creamGate(
      f,
      learning,
      btcRisk
    );

  if (!gate.pass) {
    return {
      eligible: false,
      reasons: gate.reasons,
    };
  }

  if (
    detection.creamScore <
    CONFIG.creamMinScore
  ) {
    return {
      eligible: false,
      reasons: ['cream score'],
    };
  }

  return {
    eligible: true,
    reasons: [],
  };
}

async function canOpen(
  symbol
) {
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
  }

  return {
    ok: true,
  };
}

async function openPosition(
  detection
) {
  const f =
    detection.features;

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

        opened_price:
          f.currentPrice,

        last_price:
          f.currentPrice,

        last_score:
          detection.creamScore,

        highest_price:
          f.currentPrice,

        lowest_price:
          f.currentPrice,

        metadata: {
          stage:
            detection.stage,

          provider:
            detection.provider,

          learning:
            detection.learning,

          bootstrap:
            detection.bootstrapScore,

          feature_vector:
            detection.vector,
        },
      }
    );

  const position =
    row || {
      symbol:
        detection.symbol,

      status:
        'OPEN',

      opened_at:
        iso(),

      opened_price:
        f.currentPrice,

      last_price:
        f.currentPrice,

      last_score:
        detection.creamScore,

      highest_price:
        f.currentPrice,

      lowest_price:
        f.currentPrice,
    };

  STATE.active.set(
    detection.symbol,
    position
  );

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
      `🟢 HUNTER OPEN`,
      ``,
      `${detection.symbol}`,
      `Price: ${f.currentPrice}`,
      ``,
      `Cream Score: ${detection.creamScore.toFixed(1)}/100`,
      `Stage: ${detection.stage}`,
      ``,
      `15m: ${pct(f.ret15m).toFixed(1)}%`,
      `1h: ${pct(f.ret1h).toFixed(1)}%`,
      `4h: ${pct(f.ret4h).toFixed(1)}%`,
      `24h: ${pct(f.ret24h).toFixed(1)}%`,
      ``,
      `Volume: ${f.volumeRatio.toFixed(2)}x`,
      `Vol accel: ${f.volumeAcceleration.toFixed(2)}x`,
      `Buy pressure: ${f.buyPressure.toFixed(2)}x`,
      `BTC RS: ${pct(f.relativeStrength).toFixed(1)}%`,
      ``,
      `Base quality: ${(f.baseQuality * 100).toFixed(0)}%`,
      `Exhaustion: ${(f.parabolicExhaustion * 100).toFixed(0)}%`,
      `Learning: ${detection.learning.mode}`,
      `Similarity: ${
        detection.learning.similarity == null
          ? 'BOOTSTRAP'
          : detection.learning.similarity.toFixed(3)
      }`,
      `Contrast: ${
        detection.learning.contrast == null
          ? 'BOOTSTRAP'
          : detection.learning.contrast.toFixed(3)
      }`,
      bestTarget
        ? `Best learned target: +${bestTarget[0]}%`
        : `Best learned target: building`,
    ].join('\n');

  await insertAlert(
    detection.symbol,
    'OPEN',
    message,
    null,
    {
      creamScore:
        detection.creamScore,

      stage:
        detection.stage,

      learning:
        detection.learning,

      features:
        detection.features,
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
      position.opened_price,
      f.currentPrice
    );

  const move =
    safePct(
      f.currentPrice,
      opened
    );

  const highest =
    Math.max(
      num(
        position.highest_price,
        opened
      ),
      f.currentPrice
    );

  const lowest =
    Math.min(
      num(
        position.lowest_price,
        opened
      ),
      f.currentPrice
    );

  await dbUpdate(
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

      highest_price:
        highest,

      lowest_price:
        lowest,

      metadata: {
        stage:
          detection.stage,

        latest_features:
          detection.features,

        learning:
          detection.learning,
      },
    }
  );

  return {
    move,
    highest,
    lowest,
  };
}

async function closePosition(
  position,
  detection,
  reason
) {
  const f =
    detection.features;

  const opened =
    num(
      position.opened_price,
      f.currentPrice
    );

  const move =
    safePct(
      f.currentPrice,
      opened
    );

  await dbUpdate(
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

      closed_price:
        f.currentPrice,

      realised_move_pct:
        move * 100,

      close_reason:
        reason,

      last_price:
        f.currentPrice,

      last_score:
        detection.creamScore,
    }
  );

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
    null,
    {
      reason,
      movePct:
        move * 100,
      features:
        detection.features,
    }
  );

  await alertUser(message);
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

  // Protect the thesis when the asset has
  // clearly reached the long-term Hunter objective.
  if (
    result.move >= 1.50
  ) {
    await closePosition(
      position,
      detection,
      '150% target reached'
    );

    return true;
  }

  // Hard thesis failure.
  if (
    f.ret1h <= -0.04 &&
    f.ret4h <= -0.06
  ) {
    await closePosition(
      position,
      detection,
      'momentum failure'
    );

    return true;
  }

  if (
    f.ret4h <= -0.08
  ) {
    await closePosition(
      position,
      detection,
      '4h structure failure'
    );

    return true;
  }

  if (
    f.parabolicExhaustion >=
      0.90 &&
    f.momentumProfile < 0
  ) {
    await closePosition(
      position,
      detection,
      'parabolic exhaustion'
    );

    return true;
  }

  const previousScore =
    num(
      position.last_score,
      detection.creamScore
    );

  const scoreDrop =
    previousScore -
    detection.creamScore;

  const thesisWeak =
    detection.creamScore <
      58 &&
    f.momentumProfile <
      -0.10;

  const severeDeterioration =
    detection.creamScore <
      50 &&
    scoreDrop >= 15;

  if (
    thesisWeak ||
    severeDeterioration
  ) {
    await closePosition(
      position,
      detection,
      severeDeterioration
        ? 'cream score deterioration'
        : 'thesis weakened'
    );

    return true;
  }

  // HOLD is deliberately much harder to trigger
  // than OPEN. It exists to tell the user that an
  // existing thesis is strengthening, not to create noise.
  const holdEligible =
    detection.creamScore >= 82 &&
    f.ret1h > 0 &&
    f.ret4h > 0 &&
    f.volumeRatio >= 1.5 &&
    f.volumeAcceleration >= 1.1 &&
    f.buyPressure >= 1.20 &&
    f.relativeStrength >= 0 &&
    f.parabolicExhaustion < 0.75;

  const lastHold =
    await getLastAction(
      detection.symbol,
      'HOLD'
    );

  let holdCooldown = false;

  if (lastHold) {
    holdCooldown =
      Date.now() -
        new Date(
          lastHold.timestamp
        ).getTime() <
      CONFIG.holdCooldownMs;
  }

  if (
    holdEligible &&
    !holdCooldown &&
    detection.creamScore >=
      previousScore +
        CONFIG.holdMinScoreImprovement *
          100
  ) {
    const message =
      [
        `🟡 HUNTER HOLD`,
        ``,
        `${detection.symbol}`,
        `Price: ${f.currentPrice}`,
        `Cream Score: ${detection.creamScore.toFixed(1)}/100`,
        `Stage: ${detection.stage}`,
        ``,
        `1h: ${pct(f.ret1h).toFixed(1)}%`,
        `4h: ${pct(f.ret4h).toFixed(1)}%`,
        `24h: ${pct(f.ret24h).toFixed(1)}%`,
        `Volume: ${f.volumeRatio.toFixed(2)}x`,
        `Buy pressure: ${f.buyPressure.toFixed(2)}x`,
        ``,
        `Thesis strengthening.`,
      ].join('\n');

    await insertAlert(
      detection.symbol,
      'HOLD',
      message,
      null,
      {
        creamScore:
          detection.creamScore,

        previousScore,
        stage:
          detection.stage,
      }
    );

    await alertUser(message);
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

  console.log(
    `[HUNTER] Universe refreshed: ${universe.length} assets`
  );

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

async function persistDetections(
  detections
) {
  for (
    const detection of detections
  ) {
    try {
      const snapshot =
        await saveSnapshot(
          detection.asset,
          detection.features,
          detection.bootstrapScore,
          detection.learning.similarity,
          detection.learning.mode
        );

      const example =
        await createExample(
          snapshot?.id || null,
          detection.asset,
          detection.features
        );

      await saveDetection(
        detection
      );

      /*
       * Labeling is done against the same
       * asset's current candle history.
       * This means Hunter continually converts
       * yesterday's observations into training data.
       */
      await labelRecentExamples(
        detection.symbol,
        detection.candles
      );

      void example;
    } catch (error) {
      console.error(
        `[HUNTER] Persistence ${detection.symbol}: ${error.message}`
      );
    }
  }
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
  const existingOpenCount =
    STATE.active.size;

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

    const btcRisk =
      btcRiskState(
        btcFeatures
      );

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

    // Persist everything — even assets that
    // never come close to an alert threshold.
    // That is the learning engine.
    await persistDetections(
      detections
    );

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
    'HUNTER V12 — CRYPTO EARLY-MOVE LEARNING ENGINE'
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
