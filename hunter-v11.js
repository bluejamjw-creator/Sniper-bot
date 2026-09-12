'use strict';

/**
 * HUNTER V11
 * Crypto-only early-move discovery + learning engine.
 *
 * Purpose:
 *   Identify crypto assets showing the earliest measurable signs of
 *   potentially developing into +10%, +50%, +100% and +150%+ moves.
 *
 * User-facing lifecycle:
 *   OPEN / HOLD / CLOSE
 *
 * Important:
 *   - Crypto only
 *   - No stocks
 *   - No Alpaca
 *   - No Finnhub
 *   - No Yahoo
 *   - No order execution
 *   - No conventional portfolio BUY scoring
 *   - Minimum 100 crypto assets
 *   - Dynamic universe discovery
 *
 * Existing Railway environment variables only.
 */

const https = require('https');

const ENV = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  BLUEJAM_CHAT_ID:
    process.env.BLUEJAM_CHAT_ID || process.env.CHAT_ID,
  CHANNEL_CHAT_ID:
    process.env.CHANNEL_CHAT_ID,

  SUPABASE_URL:
    process.env.SUPABASE_URL ||
    process.env.SUPABASE_PROJECT_URL,

  SUPABASE_SERVICE_KEY:
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY,

  COINGECKO_API_KEY:
    process.env.COINGECKO_API_KEY ||
    process.env.COINGECKO_KEY,

  HUNTER_LIVE:
    process.env.HUNTER_LIVE === 'true',
};

const CONFIG = {
  VERSION: 'HUNTER V11',

  SCAN_INTERVAL_MS: 15 * 60 * 1000,

  MIN_CRYPTO_ASSETS: 100,
  TARGET_CRYPTO_ASSETS: 150,
  MAX_CRYPTO_ASSETS: 200,

  CANDLE_INTERVAL: '15',
  CANDLE_LIMIT: 400,

  CONCURRENCY: 8,
  BATCH_DELAY_MS: 500,

  UNIVERSE_REFRESH_MS: 60 * 60 * 1000,

  MIN_QUOTE_VOLUME_USD: 100000,

  OPEN_COOLDOWN_MS: 60 * 60 * 1000,
  HOLD_COOLDOWN_MS: 4 * 60 * 60 * 1000,
  CLOSE_COOLDOWN_MS: 30 * 60 * 1000,

  TARGETS: {
    T10: {
      pct: 10,
      hours: 24,
    },
    T50: {
      pct: 50,
      hours: 48,
    },
    T100: {
      pct: 100,
      hours: 72,
    },
    T150: {
      pct: 150,
      hours: 96,
    },
  },

  BOOTSTRAP_OPEN_SCORE: 0.72,

  LEARNED_OPEN_SIMILARITY: 0.64,
  LEARNED_OPEN_CONTRAST: 0.04,

  CLOSE_SCORE: 0.45,
  CLOSE_SIMILARITY: 0.48,

  HOLD_SCORE: 0.68,
  HOLD_SIMILARITY: 0.58,

  MAX_PREMOVE_4H_PCT: 15,
  MAX_PREMOVE_24H_PCT: 35,

  MAX_LEARNING_EXAMPLES: 4000,

  PROVIDERS: {
    BYBIT: 'BYBIT',
    BINANCE: 'BINANCE',
    OKX: 'OKX',
  },
};

const state = {
  universe: [],
  lastUniverseRefresh: 0,
  running: false,

  positions: new Map(),

  providerStats: {
    BYBIT: {
      success: 0,
      failure: 0,
    },
    BINANCE: {
      success: 0,
      failure: 0,
    },
    OKX: {
      success: 0,
      failure: 0,
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pctChange(current, previous) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return 0;
  }

  return ((current / previous) - 1) * 100;
}

function mean(values) {
  const valid = values.filter(Number.isFinite);

  if (!valid.length) return 0;

  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function median(values) {
  const valid = values
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!valid.length) return 0;

  const middle = Math.floor(valid.length / 2);

  if (valid.length % 2) {
    return valid[middle];
  }

  return (valid[middle - 1] + valid[middle]) / 2;
}

function standardDeviation(values) {
  const valid = values.filter(Number.isFinite);

  if (valid.length < 2) return 0;

  const avg = mean(valid);

  const variance =
    valid.reduce(
      (sum, value) => sum + Math.pow(value - avg, 2),
      0
    ) / valid.length;

  return Math.sqrt(variance);
}

function normalizeSymbol(symbol) {
  if (!symbol) return null;

  return String(symbol)
    .toUpperCase()
    .replace(/[-_]/g, '');
}

function sleepBetweenRequests() {
  return sleep(CONFIG.BATCH_DELAY_MS);
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                        */
/* -------------------------------------------------------------------------- */

function httpRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 15000,
  } = {}
) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);

    const request = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: {
          'User-Agent': 'Hunter-V11/1.0',
          Accept: 'application/json',
          ...headers,
        },
        timeout: timeoutMs,
      },
      response => {
        let data = '';

        response.on('data', chunk => {
          data += chunk;
        });

        response.on('end', () => {
          const status = response.statusCode || 0;

          if (status < 200 || status >= 300) {
            const error = new Error(
              `HTTP ${status}: ${data.slice(0, 500)}`
            );

            error.statusCode = status;
            return reject(error);
          }

          try {
            resolve(JSON.parse(data));
          } catch (error) {
            error.message =
              `Invalid JSON from ${url}: ${error.message}`;

            reject(error);
          }
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(
        new Error(`Request timeout: ${url}`)
      );
    });

    request.on('error', reject);

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

/* -------------------------------------------------------------------------- */
/* Supabase                                                                    */
/* -------------------------------------------------------------------------- */

function supabaseConfigured() {
  return Boolean(
    ENV.SUPABASE_URL &&
    ENV.SUPABASE_SERVICE_KEY
  );
}

async function supabaseRequest(
  table,
  {
    method = 'GET',
    query = '',
    body = null,
    prefer = null,
  } = {}
) {
  if (!supabaseConfigured()) {
    return null;
  }

  const base =
    ENV.SUPABASE_URL.replace(/\/+$/, '');

  const url =
    `${base}/rest/v1/${table}${query}`;

  const headers = {
    apikey: ENV.SUPABASE_SERVICE_KEY,
    Authorization:
      `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  if (prefer) {
    headers.Prefer = prefer;
  }

  return httpRequest(url, {
    method,
    headers,
    body:
      body == null
        ? null
        : JSON.stringify(body),
  });
}

async function supabaseInsert(
  table,
  rows,
  {
    ignoreDuplicates = false,
  } = {}
) {
  if (!supabaseConfigured() || !rows?.length) {
    return null;
  }

  const prefer = ignoreDuplicates
    ? 'resolution=ignore-duplicates,return=minimal'
    : 'return=minimal';

  try {
    return await supabaseRequest(table, {
      method: 'POST',
      body: rows,
      prefer,
    });
  } catch (error) {
    console.error(
      `[SUPABASE INSERT] ${table}:`,
      error.message
    );

    return null;
  }
}

async function supabaseUpsert(
  table,
  rows,
  {
    onConflict,
    ignoreDuplicates = false,
  } = {}
) {
  if (!supabaseConfigured() || !rows?.length) {
    return null;
  }

  const query =
    onConflict
      ? `?on_conflict=${encodeURIComponent(onConflict)}`
      : '';

  const prefer = ignoreDuplicates
    ? 'resolution=ignore-duplicates,return=minimal'
    : 'resolution=merge-duplicates,return=minimal';

  try {
    return await supabaseRequest(table, {
      method: 'POST',
      query,
      body: rows,
      prefer,
    });
  } catch (error) {
    console.error(
      `[SUPABASE UPSERT] ${table}:`,
      error.message
    );

    return null;
  }
}

async function supabaseSelect(
  table,
  query
) {
  if (!supabaseConfigured()) {
    return [];
  }

  try {
    return (
      await supabaseRequest(table, {
        method: 'GET',
        query,
      })
    ) || [];
  } catch (error) {
    console.error(
      `[SUPABASE SELECT] ${table}:`,
      error.message
    );

    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Telegram                                                                    */
/* -------------------------------------------------------------------------- */

async function sendTelegramMessage(
  chatId,
  text
) {
  if (!ENV.BOT_TOKEN || !chatId) {
    return false;
  }

  const url =
    `https://api.telegram.org/bot${ENV.BOT_TOKEN}/sendMessage`;

  try {
    await httpRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    return true;
  } catch (error) {
    console.error(
      '[TELEGRAM]',
      error.message
    );

    return false;
  }
}

async function sendAlert(text) {
  const destinations = [
    ENV.BLUEJAM_CHAT_ID,
    ENV.CHANNEL_CHAT_ID,
  ].filter(Boolean);

  const uniqueDestinations = [
    ...new Set(destinations),
  ];

  if (!uniqueDestinations.length) {
    console.log(
      '[ALERT - NO TELEGRAM DESTINATION]',
      text
    );

    return;
  }

  for (const chatId of uniqueDestinations) {
    await sendTelegramMessage(
      chatId,
      text
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Bybit universe                                                              */
/* -------------------------------------------------------------------------- */

async function fetchBybitTickers() {
  const url =
    'https://api.bybit.com/v5/market/tickers?category=spot';

  try {
    const data = await httpRequest(url);

    if (
      data?.retCode !== 0 ||
      !Array.isArray(data?.result?.list)
    ) {
      throw new Error(
        `Unexpected Bybit ticker response`
      );
    }

    state.providerStats.BYBIT.success++;

    return data.result.list;
  } catch (error) {
    state.providerStats.BYBIT.failure++;

    console.error(
      '[BYBIT TICKERS]',
      error.message
    );

    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Binance universe                                                            */
/* -------------------------------------------------------------------------- */

async function fetchBinanceTickers() {
  const url =
    'https://api.binance.com/api/v3/ticker/24hr';

  try {
    const data = await httpRequest(url);

    if (!Array.isArray(data)) {
      throw new Error(
        'Unexpected Binance ticker response'
      );
    }

    state.providerStats.BINANCE.success++;

    return data;
  } catch (error) {
    state.providerStats.BINANCE.failure++;

    console.error(
      '[BINANCE TICKERS]',
      error.message
    );

    return [];
  }
}

async function fetchBinanceExchangeInfo() {
  const url =
    'https://api.binance.com/api/v3/exchangeInfo';

  try {
    const data = await httpRequest(url);

    if (!Array.isArray(data?.symbols)) {
      throw new Error(
        'Unexpected Binance exchangeInfo response'
      );
    }

    state.providerStats.BINANCE.success++;

    return data.symbols;
  } catch (error) {
    state.providerStats.BINANCE.failure++;

    console.error(
      '[BINANCE EXCHANGE INFO]',
      error.message
    );

    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Universe filtering                                                          */
/* -------------------------------------------------------------------------- */

function isUsableCryptoSymbol(
  symbol
) {
  const s = normalizeSymbol(symbol);

  if (!s) return false;

  if (!s.endsWith('USDT')) {
    return false;
  }

  if (
    s.includes('UPUSDT') ||
    s.includes('DOWNUSDT') ||
    s.includes('BULLUSDT') ||
    s.includes('BEARUSDT')
  ) {
    return false;
  }

  if (
    s.startsWith('1000') ||
    s.startsWith('10000') ||
    s.startsWith('100000')
  ) {
    return false;
  }

  return true;
}

function symbolBase(symbol) {
  return normalizeSymbol(symbol)
    ?.replace(/USDT$/, '');
}

function buildUniverseFromSources(
  bybitTickers,
  binanceTickers,
  binanceInfo
) {
  const candidates = new Map();

  for (const ticker of bybitTickers) {
    const symbol =
      normalizeSymbol(ticker.symbol);

    if (!isUsableCryptoSymbol(symbol)) {
      continue;
    }

    const quoteVolume =
      safeNumber(
        ticker.turnover24h
      );

    const lastPrice =
      safeNumber(
        ticker.lastPrice
      );

    const priceChangePct =
      safeNumber(
        ticker.price24hPcnt
      ) * 100;

    if (
      quoteVolume <
      CONFIG.MIN_QUOTE_VOLUME_USD
    ) {
      continue;
    }

    candidates.set(symbol, {
      symbol,
      base: symbolBase(symbol),
      quoteVolume,
      priceChangePct,
      lastPrice,
      source: 'BYBIT',
    });
  }

  for (const ticker of binanceTickers) {
    const symbol =
      normalizeSymbol(ticker.symbol);

    if (!isUsableCryptoSymbol(symbol)) {
      continue;
    }

    const quoteVolume =
      safeNumber(
        ticker.quoteVolume
      );

    const lastPrice =
      safeNumber(
        ticker.lastPrice
      );

    const priceChangePct =
      safeNumber(
        ticker.priceChangePercent
      );

    if (
      quoteVolume <
      CONFIG.MIN_QUOTE_VOLUME_USD
    ) {
      continue;
    }

    const existing =
      candidates.get(symbol);

    if (existing) {
      existing.quoteVolume =
        Math.max(
          existing.quoteVolume,
          quoteVolume
        );

      existing.priceChangePct =
        Math.max(
          Math.abs(
            existing.priceChangePct
          ),
          Math.abs(
            priceChangePct
          )
        ) *
        Math.sign(
          Math.abs(priceChangePct) >
          Math.abs(existing.priceChangePct)
            ? priceChangePct
            : existing.priceChangePct
        );

      existing.lastPrice =
        existing.lastPrice ||
        lastPrice;

      existing.source =
        'BYBIT+BINANCE';
    } else {
      candidates.set(symbol, {
        symbol,
        base: symbolBase(symbol),
        quoteVolume,
        priceChangePct,
        lastPrice,
        source: 'BINANCE',
      });
    }
  }

  const validBinanceSymbols =
    new Set(
      binanceInfo
        .filter(
          item =>
            item.status === 'TRADING' &&
            item.isSpotTradingAllowed !== false
        )
        .map(
          item =>
            normalizeSymbol(item.symbol)
        )
        .filter(isUsableCryptoSymbol)
    );

  const filtered =
    [...candidates.values()]
      .filter(candidate => {
        if (
          validBinanceSymbols.size === 0
        ) {
          return true;
        }

        return (
          validBinanceSymbols.has(
            candidate.symbol
          ) ||
          candidate.source === 'BYBIT'
        );
      });

  /*
   * Two complementary rankings:
   *
   * 1. Liquidity ranking prevents Hunter becoming a tiny-token casino.
   * 2. Movement ranking prevents Hunter becoming only a large-cap tracker.
   *
   * The union gives us a broad universe containing both liquid assets
   * and assets beginning to show abnormal movement.
   */

  const liquidityRanked =
    [...filtered]
      .sort(
        (a, b) =>
          b.quoteVolume -
          a.quoteVolume
      )
      .slice(0, 140);

  const movementRanked =
    [...filtered]
      .sort((a, b) => {
        const aScore =
          Math.abs(a.priceChangePct) *
          Math.log10(
            Math.max(
              10,
              a.quoteVolume
            )
          );

        const bScore =
          Math.abs(b.priceChangePct) *
          Math.log10(
            Math.max(
              10,
              b.quoteVolume
            )
          );

        return bScore - aScore;
      })
      .slice(0, 80);

  const union =
    new Map();

  for (
    const candidate of [
      ...liquidityRanked,
      ...movementRanked,
    ]
  ) {
    union.set(
      candidate.symbol,
      candidate
    );
  }

  const finalUniverse =
    [...union.values()]
      .sort(
        (a, b) =>
          b.quoteVolume -
          a.quoteVolume
      )
      .slice(
        0,
        CONFIG.MAX_CRYPTO_ASSETS
      )
      .map(
        candidate =>
          candidate.symbol
      );

  return finalUniverse;
}

async function discoverUniverse() {
  console.log(
    '[UNIVERSE] Discovering crypto universe...'
  );

  const [
    bybitTickers,
    binanceTickers,
    binanceInfo,
  ] = await Promise.all([
    fetchBybitTickers(),
    fetchBinanceTickers(),
    fetchBinanceExchangeInfo(),
  ]);

  const universe =
    buildUniverseFromSources(
      bybitTickers,
      binanceTickers,
      binanceInfo
    );

  if (
    universe.length <
    CONFIG.MIN_CRYPTO_ASSETS
  ) {
    throw new Error(
      `Universe only contains ${universe.length} assets; ` +
      `minimum is ${CONFIG.MIN_CRYPTO_ASSETS}`
    );
  }

  state.universe = universe;
  state.lastUniverseRefresh =
    Date.now();

  console.log(
    `[UNIVERSE] ${universe.length} crypto assets selected`
  );

  return universe;
}

/* -------------------------------------------------------------------------- */
/* Bybit candles                                                               */
/* -------------------------------------------------------------------------- */

async function fetchBybitCandles(
  symbol
) {
  const url =
    'https://api.bybit.com/v5/market/kline' +
    `?category=spot` +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${CONFIG.CANDLE_INTERVAL}` +
    `&limit=${CONFIG.CANDLE_LIMIT}`;

  try {
    const data =
      await httpRequest(url);

    if (
      data?.retCode !== 0 ||
      !Array.isArray(
        data?.result?.list
      )
    ) {
      throw new Error(
        `Unexpected Bybit candle response`
      );
    }

    const candles =
      data.result.list
        .map(row => ({
          timestamp:
            safeNumber(row[0]),
          open:
            safeNumber(row[1]),
          high:
            safeNumber(row[2]),
          low:
            safeNumber(row[3]),
          close:
            safeNumber(row[4]),
          volume:
            safeNumber(row[5]),
          quoteVolume:
            safeNumber(row[6]),
        }))
        .filter(
          candle =>
            candle.timestamp &&
            candle.close > 0
        )
        .sort(
          (a, b) =>
            a.timestamp -
            b.timestamp
        );

    /*
     * Bybit's most recent candle can be incomplete.
     * Remove it so all feature calculations are based
     * on closed candles.
     */

    if (candles.length > 1) {
      candles.pop();
    }

    if (candles.length < 50) {
      throw new Error(
        `Too few Bybit candles: ${candles.length}`
      );
    }

    state.providerStats.BYBIT.success++;

    return candles;
  } catch (error) {
    state.providerStats.BYBIT.failure++;

    console.error(
      `[BYBIT CANDLES ${symbol}]`,
      error.message
    );

    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Binance candles                                                             */
/* -------------------------------------------------------------------------- */

async function fetchBinanceCandles(
  symbol
) {
  const url =
    'https://api.binance.com/api/v3/klines' +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=15m` +
    `&limit=${CONFIG.CANDLE_LIMIT}`;

  try {
    const data =
      await httpRequest(url);

    if (!Array.isArray(data)) {
      throw new Error(
        `Unexpected Binance candle response`
      );
    }

    const candles =
      data
        .map(row => ({
          timestamp:
            safeNumber(row[0]),
          open:
            safeNumber(row[1]),
          high:
            safeNumber(row[2]),
          low:
            safeNumber(row[3]),
          close:
            safeNumber(row[4]),
          volume:
            safeNumber(row[5]),
          quoteVolume:
            safeNumber(row[7]),
        }))
        .filter(
          candle =>
            candle.timestamp &&
            candle.close > 0
        )
        .sort(
          (a, b) =>
            a.timestamp -
            b.timestamp
        );

    if (candles.length > 1) {
      candles.pop();
    }

    if (candles.length < 50) {
      throw new Error(
        `Too few Binance candles: ${candles.length}`
      );
    }

    state.providerStats.BINANCE.success++;

    return candles;
  } catch (error) {
    state.providerStats.BINANCE.failure++;

    console.error(
      `[BINANCE CANDLES ${symbol}]`,
      error.message
    );

    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* OKX candles                                                                 */
/* -------------------------------------------------------------------------- */

function toOkxSymbol(symbol) {
  const normalized =
    normalizeSymbol(symbol);

  if (
    !normalized?.endsWith('USDT')
  ) {
    return null;
  }

  return (
    normalized.slice(
      0,
      -4
    ) +
    '-USDT'
  );
}

async function fetchOkxCandles(
  symbol
) {
  const instId =
    toOkxSymbol(symbol);

  if (!instId) {
    return [];
  }

  const url =
    'https://www.okx.com/api/v5/market/candles' +
    `?instId=${encodeURIComponent(instId)}` +
    '&bar=15m' +
    `&limit=${Math.min(
      300,
      CONFIG.CANDLE_LIMIT
    )}`;

  try {
    const data =
      await httpRequest(url);

    if (
      data?.code !== '0' ||
      !Array.isArray(data?.data)
    ) {
      throw new Error(
        `Unexpected OKX candle response`
      );
    }

    const candles =
      data.data
        .map(row => ({
          timestamp:
            safeNumber(row[0]),
          open:
            safeNumber(row[1]),
          high:
            safeNumber(row[2]),
          low:
            safeNumber(row[3]),
          close:
            safeNumber(row[4]),
          volume:
            safeNumber(row[5]),
          quoteVolume:
            safeNumber(row[6]),
        }))
        .filter(
          candle =>
            candle.timestamp &&
            candle.close > 0
        )
        .sort(
          (a, b) =>
            a.timestamp -
            b.timestamp
        );

    if (candles.length > 1) {
      candles.pop();
    }

    if (candles.length < 50) {
      throw new Error(
        `Too few OKX candles: ${candles.length}`
      );
    }

    state.providerStats.OKX.success++;

    return candles;
  } catch (error) {
    state.providerStats.OKX.failure++;

    console.error(
      `[OKX CANDLES ${symbol}]`,
      error.message
    );

    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Candle provider fallback                                                    */
/* -------------------------------------------------------------------------- */

async function fetchCandles(
  symbol
) {
  let candles =
    await fetchBybitCandles(symbol);

  if (candles.length) {
    return {
      provider: CONFIG.PROVIDERS.BYBIT,
      candles,
    };
  }

  await sleepBetweenRequests();

  candles =
    await fetchBinanceCandles(symbol);

  if (candles.length) {
    return {
      provider: CONFIG.PROVIDERS.BINANCE,
      candles,
    };
  }

  await sleepBetweenRequests();

  candles =
    await fetchOkxCandles(symbol);

  if (candles.length) {
    return {
      provider: CONFIG.PROVIDERS.OKX,
      candles,
    };
  }

  return {
    provider: null,
    candles: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Candle helpers                                                              */
/* -------------------------------------------------------------------------- */

function candleCloseAtOffset(
  candles,
  offset
) {
  const index =
    candles.length -
    1 -
    offset;

  if (
    index < 0 ||
    index >= candles.length
  ) {
    return null;
  }

  return candles[index].close;
}

function candleHighAtOffset(
  candles,
  offset
) {
  const index =
    candles.length -
    1 -
    offset;

  if (
    index < 0 ||
    index >= candles.length
  ) {
    return null;
  }

  return candles[index].high;
}

function candleLowAtOffset(
  candles,
  offset
) {
  const index =
    candles.length -
    1 -
    offset;

  if (
    index < 0 ||
    index >= candles.length
  ) {
    return null;
  }

  return candles[index].low;
}

function recentReturns(
  candles
) {
  const current =
    candleCloseAtOffset(
      candles,
      0
    );

  return {
    ret15m:
      pctChange(
        current,
        candleCloseAtOffset(
          candles,
          1
        )
      ),

    ret1h:
      pctChange(
        current,
        candleCloseAtOffset(
          candles,
          4
        )
      ),

    ret2h:
      pctChange(
        current,
        candleCloseAtOffset(
          candles,
          8
        )
      ),

    ret4h:
      pctChange(
        current,
        candleCloseAtOffset(
          candles,
          16
        )
      ),

    ret8h:
      pctChange(
        current,
        candleCloseAtOffset(
          candles,
          32
        )
      ),

    ret12h:
      pctChange(
        current,
        candleCloseAtOffset(
          candles,
          48
        )
      ),

    ret24h:
      pctChange(
        current,
        candleCloseAtOffset(
          candles,
          96
        )
      ),
  };
}

/* -------------------------------------------------------------------------- */
/* Feature calculations                                                        */
/* -------------------------------------------------------------------------- */

function averageVolume(
  candles,
  startOffset,
  length
) {
  const values = [];

  for (
    let i = startOffset;
    i <
      startOffset + length;
    i++
  ) {
    const index =
      candles.length -
      1 -
      i;

    if (index < 0) break;

    values.push(
      safeNumber(
        candles[index].quoteVolume ||
        candles[index].volume
      )
    );
  }

  return mean(values);
}

function calculateVolumeFeatures(
  candles
) {
  const currentIndex =
    candles.length - 1;

  const currentVolume =
    safeNumber(
      candles[currentIndex]
        ?.quoteVolume ||
      candles[currentIndex]
        ?.volume
    );

  const baselineVolume =
    averageVolume(
      candles,
      4,
      20
    );

  const shortVolume =
    averageVolume(
      candles,
      1,
      4
    );

  const previousShortVolume =
    averageVolume(
      candles,
      5,
      4
    );

  const volumeRatio =
    baselineVolume > 0
      ? currentVolume /
        baselineVolume
      : 1;

  const volumeAcceleration =
    previousShortVolume > 0
      ? shortVolume /
        previousShortVolume
      : 1;

  return {
    volumeRatio,
    volumeAcceleration,
  };
}

function calculateBuyPressure(
  candles
) {
  const recent = candles.slice(-16);

  if (!recent.length) {
    return 0.5;
  }

  let weightedBuy = 0;
  let weightedTotal = 0;

  recent.forEach(
    (candle, index) => {
      const range =
        candle.high -
        candle.low;

      if (range <= 0) return;

      const closeLocation =
        (candle.close -
          candle.low) /
        range;

      const weight =
        1 +
        index /
          recent.length;

      weightedBuy +=
        closeLocation *
        weight;

      weightedTotal += weight;
    }
  );

  if (!weightedTotal) {
    return 0.5;
  }

  return clamp(
    weightedBuy /
      weightedTotal
  );
}

function calculateRangeFeatures(
  candles
) {
  const recent =
    candles.slice(-16);

  const ranges =
    recent.map(
      candle =>
        candle.high -
        candle.low
    );

  const avgRange =
    mean(ranges);

  const previous =
    candles.slice(-32, -16);

  const previousRanges =
    previous.map(
      candle =>
        candle.high -
        candle.low
    );

  const previousAvg =
    mean(previousRanges);

  const rangeExpansion =
    previousAvg > 0
      ? avgRange /
        previousAvg
      : 1;

  const shortRange =
    mean(
      ranges.slice(-4)
    );

  const longRange =
    mean(
      ranges.slice(0, 12)
    );

  const rangeCompression =
    longRange > 0
      ? shortRange /
        longRange
      : 1;

  return {
    rangeExpansion,
    rangeCompression,
  };
}

function calculateHigherLow(
  candles
) {
  if (candles.length < 32) {
    return 0;
  }

  const recent =
    candles.slice(-16);

  const previous =
    candles.slice(-32, -16);

  const recentLow =
    Math.min(
      ...recent.map(
        candle => candle.low
      )
    );

  const previousLow =
    Math.min(
      ...previous.map(
        candle => candle.low
      )
    );

  if (
    previousLow <= 0
  ) {
    return 0;
  }

  return pctChange(
    recentLow,
    previousLow
  );
}

function calculatePriceCompression(
  candles
) {
  const recent =
    candles.slice(-16);

  const previous =
    candles.slice(-32, -16);

  if (
    recent.length < 8 ||
    previous.length < 8
  ) {
    return 0;
  }

  const recentHigh =
    Math.max(
      ...recent.map(
        candle => candle.high
      )
    );

  const recentLow =
    Math.min(
      ...recent.map(
        candle => candle.low
      )
    );

  const previousHigh =
    Math.max(
      ...previous.map(
        candle => candle.high
      )
    );

  const previousLow =
    Math.min(
      ...previous.map(
        candle => candle.low
      )
    );

  const recentMid =
    (recentHigh +
      recentLow) /
    2;

  const previousMid =
    (previousHigh +
      previousLow) /
    2;

  if (
    recentMid <= 0 ||
    previousMid <= 0
  ) {
    return 0;
  }

  const recentWidth =
    (recentHigh -
      recentLow) /
    recentMid;

  const previousWidth =
    (previousHigh -
      previousLow) /
    previousMid;

  if (previousWidth <= 0) {
    return 0;
  }

  return (
    1 -
    recentWidth /
      previousWidth
  );
}

function calculateClosePosition(
  candles
) {
  const current =
    candles[candles.length - 1];

  const range =
    current.high -
    current.low;

  if (range <= 0) {
    return 0.5;
  }

  return clamp(
    (current.close -
      current.low) /
      range
  );
}

function calculateBreakoutProximity(
  candles
) {
  if (candles.length < 21) {
    return 0;
  }

  const current =
    candles[candles.length - 1]
      .close;

  const previous =
    candles.slice(-21, -1);

  const resistance =
    Math.max(
      ...previous.map(
        candle => candle.high
      )
    );

  if (resistance <= 0) {
    return 0;
  }

  return clamp(
    1 -
      Math.abs(
        resistance -
          current
      ) /
        resistance *
        10,
    0,
    1
  );
}

function calculateTrendSlope(
  candles
) {
  const recent =
    candles.slice(-32);

  if (recent.length < 8) {
    return 0;
  }

  const prices =
    recent.map(
      candle =>
        Math.log(
          Math.max(
            candle.close,
            1e-12
          )
        )
    );

  const n =
    prices.length;

  const xMean =
    (n - 1) / 2;

  const yMean =
    mean(prices);

  let numerator = 0;
  let denominator = 0;

  for (
    let i = 0;
    i < n;
    i++
  ) {
    const x =
      i - xMean;

    numerator +=
      x *
      (prices[i] -
        yMean);

    denominator +=
      x * x;
  }

  if (!denominator) {
    return 0;
  }

  return (
    numerator /
    denominator
  );
}

function calculateMomentumAcceleration(
  candles
) {
  if (candles.length < 48) {
    return 0;
  }

  const current =
    candles[candles.length - 1]
      .close;

  const oneHourAgo =
    candles[
      candles.length - 5
    ]?.close;

  const fourHoursAgo =
    candles[
      candles.length - 17
    ]?.close;

  const eightHoursAgo =
    candles[
      candles.length - 33
    ]?.close;

  const oneHour =
    pctChange(
      current,
      oneHourAgo
    );

  const previousFourHour =
    pctChange(
      oneHourAgo,
      fourHoursAgo
    );

  const previousEightHour =
    pctChange(
      fourHoursAgo,
      eightHoursAgo
    );

  return (
    oneHour -
    previousFourHour / 4 -
    previousEightHour / 8
  );
        }/* -------------------------------------------------------------------------- */
/* BTC relative strength                                                      */
/* -------------------------------------------------------------------------- */

function calculateRelativeStrength(
  assetCandles,
  btcCandles
) {
  if (
    !assetCandles.length ||
    !btcCandles.length
  ) {
    return 0;
  }

  const assetCurrent =
    assetCandles[
      assetCandles.length - 1
    ]?.close;

  const assetPrevious =
    assetCandles[
      Math.max(
        0,
        assetCandles.length - 17
      )
    ]?.close;

  const btcCurrent =
    btcCandles[
      btcCandles.length - 1
    ]?.close;

  const btcPrevious =
    btcCandles[
      Math.max(
        0,
        btcCandles.length - 17
      )
    ]?.close;

  const assetMove =
    pctChange(
      assetCurrent,
      assetPrevious
    );

  const btcMove =
    pctChange(
      btcCurrent,
      btcPrevious
    );

  return (
    assetMove -
    btcMove
  );
}

/* -------------------------------------------------------------------------- */
/* Full feature calculation                                                   */
/* -------------------------------------------------------------------------- */

function calculateFeatures(
  candles,
  btcCandles = []
) {
  if (
    !candles ||
    candles.length < 100
  ) {
    return null;
  }

  const returns =
    recentReturns(candles);

  const volume =
    calculateVolumeFeatures(
      candles
    );

  const range =
    calculateRangeFeatures(
      candles
    );

  const buyPressure =
    calculateBuyPressure(
      candles
    );

  const higherLow =
    calculateHigherLow(
      candles
    );

  const priceCompression =
    calculatePriceCompression(
      candles
    );

  const closePosition =
    calculateClosePosition(
      candles
    );

  const breakoutProximity =
    calculateBreakoutProximity(
      candles
    );

  const trendSlope =
    calculateTrendSlope(
      candles
    );

  const momentumAcceleration =
    calculateMomentumAcceleration(
      candles
    );

  const relativeStrength =
    btcCandles.length
      ? calculateRelativeStrength(
          candles,
          btcCandles
        )
      : 0;

  return {
    ...returns,

    volumeRatio:
      volume.volumeRatio,

    volumeAcceleration:
      volume.volumeAcceleration,

    buyPressure,

    rangeExpansion:
      range.rangeExpansion,

    rangeCompression:
      range.rangeCompression,

    higherLow,

    priceCompression,

    relativeStrength,

    momentumAcceleration,

    closePosition,

    breakoutProximity,

    trendSlope,
  };
}

/* -------------------------------------------------------------------------- */
/* Feature vector                                                              */
/* -------------------------------------------------------------------------- */

const FEATURE_KEYS = [
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
];

/*
 * Bounded transforms are important because raw crypto values can be wildly
 * different between assets. A +2% move and a +200% move should not cause
 * the vector to explode numerically.
 */

function boundedReturn(value) {
  return Math.tanh(
    safeNumber(value) / 10
  );
}

function boundedRatio(value) {
  return Math.tanh(
    Math.log(
      Math.max(
        0.05,
        safeNumber(value, 1)
      )
    )
  );
}

function boundedPressure(value) {
  return (
    clamp(value) * 2 -
    1
  );
}

function boundedSlope(value) {
  return Math.tanh(
    safeNumber(value) *
      100
  );
}

function buildFeatureVector(
  features
) {
  if (!features) {
    return null;
  }

  return [
    boundedReturn(
      features.ret15m
    ),

    boundedReturn(
      features.ret1h
    ),

    boundedReturn(
      features.ret2h
    ),

    boundedReturn(
      features.ret4h
    ),

    boundedReturn(
      features.ret8h
    ),

    boundedReturn(
      features.ret12h
    ),

    boundedReturn(
      features.ret24h
    ),

    boundedRatio(
      features.volumeRatio
    ),

    boundedRatio(
      features.volumeAcceleration
    ),

    boundedPressure(
      features.buyPressure
    ),

    boundedRatio(
      features.rangeExpansion
    ),

    boundedRatio(
      features.rangeCompression
    ),

    boundedReturn(
      features.higherLow
    ),

    Math.tanh(
      safeNumber(
        features.priceCompression
      )
    ),

    boundedReturn(
      features.relativeStrength
    ),

    boundedReturn(
      features.momentumAcceleration
    ),

    boundedPressure(
      features.closePosition
    ),

    clamp(
      features.breakoutProximity,
      0,
      1
    ),

    boundedSlope(
      features.trendSlope
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/* Vector similarity                                                           */
/* -------------------------------------------------------------------------- */

function cosineSimilarity(
  a,
  b
) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length !== b.length ||
    !a.length
  ) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (
    let i = 0;
    i < a.length;
    i++
  ) {
    const av =
      safeNumber(a[i]);

    const bv =
      safeNumber(b[i]);

    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (
    normA <= 0 ||
    normB <= 0
  ) {
    return 0;
  }

  return clamp(
    dot /
      (
        Math.sqrt(normA) *
        Math.sqrt(normB)
      ),
    -1,
    1
  );
}

/* -------------------------------------------------------------------------- */
/* Bootstrap early-stage signal                                               */
/* -------------------------------------------------------------------------- */

function bootstrapScore(
  features
) {
  if (!features) {
    return 0;
  }

  /*
   * This is deliberately NOT a conventional trade score.
   *
   * It rewards combinations associated with early abnormal behaviour:
   *   - increasing activity
   *   - buying pressure
   *   - improving momentum
   *   - relative strength
   *   - compression / breakout proximity
   *
   * It is only the bootstrap mechanism while Hunter is building
   * historical evidence.
   */

  const volume =
    clamp(
      Math.log(
        Math.max(
          0.25,
          features.volumeRatio
        )
      ) /
        Math.log(5) +
        0.5,
      0,
      1
    );

  const volumeAccel =
    clamp(
      Math.log(
        Math.max(
          0.25,
          features.volumeAcceleration
        )
      ) /
        Math.log(4) +
        0.5,
      0,
      1
    );

  const buying =
    clamp(
      features.buyPressure
    );

  const relative =
    clamp(
      0.5 +
        features.relativeStrength /
          20,
      0,
      1
    );

  const acceleration =
    clamp(
      0.5 +
        features.momentumAcceleration /
          10,
      0,
      1
    );

  const compression =
    clamp(
      0.5 +
        features.priceCompression,
      0,
      1
    );

  const breakout =
    clamp(
      features.breakoutProximity
    );

  const higherLowScore =
    clamp(
      0.5 +
        features.higherLow /
          10,
      0,
      1
    );

  const score =
    volume * 0.18 +
    volumeAccel * 0.14 +
    buying * 0.16 +
    relative * 0.12 +
    acceleration * 0.14 +
    compression * 0.10 +
    breakout * 0.08 +
    higherLowScore * 0.08;

  return clamp(score);
}

/* -------------------------------------------------------------------------- */
/* Learning model                                                              */
/* -------------------------------------------------------------------------- */

async function loadLearningExamples() {
  if (!supabaseConfigured()) {
    return [];
  }

  const query =
    '?select=' +
    'symbol,' +
    'timestamp,' +
    'feature_vector,' +
    'outcome_10,' +
    'outcome_50,' +
    'outcome_100,' +
    'outcome_150,' +
    'mfe_pct_24h,' +
    'mae_pct_24h' +
    '&feature_vector=not.is.null' +
    '&order=timestamp.desc' +
    `&limit=${CONFIG.MAX_LEARNING_EXAMPLES}`;

  const rows =
    await supabaseSelect(
      'hunter_v11_examples',
      query
    );

  return rows
    .map(row => ({
      ...row,
      feature_vector:
        Array.isArray(
          row.feature_vector
        )
          ? row.feature_vector
          : null,
    }))
    .filter(
      row =>
        Array.isArray(
          row.feature_vector
        ) &&
        row.feature_vector.length ===
          FEATURE_KEYS.length
    );
}

function targetExamples(
  examples,
  target
) {
  return examples.filter(
    example =>
      example[target] === true
  );
}

function negativeExamples(
  examples
) {
  return examples.filter(
    example =>
      example.outcome_10 === false
  );
}

function topSimilarity(
  vector,
  examples,
  limit = 20
) {
  if (
    !vector ||
    !examples.length
  ) {
    return 0;
  }

  const similarities =
    examples
      .map(example =>
        cosineSimilarity(
          vector,
          example.feature_vector
        )
      )
      .sort(
        (a, b) => b - a
      )
      .slice(
        0,
        limit
      );

  if (!similarities.length) {
    return 0;
  }

  /*
   * Using the average of the best matches rather than a single nearest
   * neighbour makes the result less sensitive to one strange historical
   * example.
   */

  return clamp(
    mean(similarities)
  );
}

function learnedSimilarity(
  vector,
  examples
) {
  if (
    !vector ||
    !examples.length
  ) {
    return {
      t10: 0,
      t50: 0,
      t100: 0,
      t150: 0,
      negative: 0,
      bestTarget: null,
      bestSimilarity: 0,
      contrast: 0,
    };
  }

  const positive10 =
    targetExamples(
      examples,
      'outcome_10'
    );

  const positive50 =
    targetExamples(
      examples,
      'outcome_50'
    );

  const positive100 =
    targetExamples(
      examples,
      'outcome_100'
    );

  const positive150 =
    targetExamples(
      examples,
      'outcome_150'
    );

  const negatives =
    negativeExamples(
      examples
    );

  const t10 =
    topSimilarity(
      vector,
      positive10
    );

  const t50 =
    topSimilarity(
      vector,
      positive50
    );

  const t100 =
    topSimilarity(
      vector,
      positive100
    );

  const t150 =
    topSimilarity(
      vector,
      positive150
    );

  const negative =
    topSimilarity(
      vector,
      negatives
    );

  const targetScores = [
    {
      name: '10%',
      value: t10,
    },
    {
      name: '50%',
      value: t50,
    },
    {
      name: '100%',
      value: t100,
    },
    {
      name: '150%',
      value: t150,
    },
  ];

  targetScores.sort(
    (a, b) =>
      b.value -
      a.value
  );

  const best =
    targetScores[0];

  return {
    t10,
    t50,
    t100,
    t150,
    negative,

    bestTarget:
      best?.name || null,

    bestSimilarity:
      best?.value || 0,

    contrast:
      (best?.value || 0) -
      negative,
  };
}

/* -------------------------------------------------------------------------- */
/* Historical outcome labelling                                                */
/* -------------------------------------------------------------------------- */

function futureCandlesForWindow(
  candles,
  index,
  maxBars
) {
  return candles.slice(
    index + 1,
    index + 1 + maxBars
  );
}

function outcomeWithin(
  candles,
  index,
  targetPct,
  maxBars
) {
  const entry =
    candles[index]?.close;

  if (
    !Number.isFinite(entry) ||
    entry <= 0
  ) {
    return {
      reached: false,
      bars: null,
    };
  }

  const future =
    futureCandlesForWindow(
      candles,
      index,
      maxBars
    );

  const target =
    entry *
    (
      1 +
      targetPct / 100
    );

  for (
    let i = 0;
    i < future.length;
    i++
  ) {
    if (
      future[i].high >=
      target
    ) {
      return {
        reached: true,
        bars: i + 1,
      };
    }
  }

  return {
    reached: false,
    bars: null,
  };
}

function adverseMove24h(
  candles,
  index
) {
  const entry =
    candles[index]?.close;

  if (
    !Number.isFinite(entry) ||
    entry <= 0
  ) {
    return 0;
  }

  const future =
    futureCandlesForWindow(
      candles,
      index,
      96
    );

  if (!future.length) {
    return 0;
  }

  const lowest =
    Math.min(
      ...future.map(
        candle =>
          candle.low
      )
    );

  return pctChange(
    lowest,
    entry
  );
}

function favourableMove24h(
  candles,
  index
) {
  const entry =
    candles[index]?.close;

  if (
    !Number.isFinite(entry) ||
    entry <= 0
  ) {
    return 0;
  }

  const future =
    futureCandlesForWindow(
      candles,
      index,
      96
    );

  if (!future.length) {
    return 0;
  }

  const highest =
    Math.max(
      ...future.map(
        candle =>
          candle.high
      )
    );

  return pctChange(
    highest,
    entry
  );
}

function buildOutcomeLabels(
  candles,
  index
) {
  const t10 =
    outcomeWithin(
      candles,
      index,
      10,
      96
    );

  const t50 =
    outcomeWithin(
      candles,
      index,
      50,
      192
    );

  const t100 =
    outcomeWithin(
      candles,
      index,
      100,
      288
    );

  const t150 =
    outcomeWithin(
      candles,
      index,
      150,
      384
    );

  /*
   * A result can only be labelled once enough future candles exist.
   */

  const available =
    candles.length -
    index -
    1;

  const resolved10 =
    available >= 96;

  const resolved50 =
    available >= 192;

  const resolved100 =
    available >= 288;

  const resolved150 =
    available >= 384;

  return {
    outcome_10:
      resolved10
        ? t10.reached
        : null,

    outcome_50:
      resolved50
        ? t50.reached
        : null,

    outcome_100:
      resolved100
        ? t100.reached
        : null,

    outcome_150:
      resolved150
        ? t150.reached
        : null,

    mfe_pct_24h:
      resolved10
        ? favourableMove24h(
            candles,
            index
          )
        : null,

    mae_pct_24h:
      resolved10
        ? adverseMove24h(
            candles,
            index
          )
        : null,

    time_to_10_min:
      resolved10 &&
      t10.reached
        ? t10.bars * 15
        : null,

    time_to_50_min:
      resolved50 &&
      t50.reached
        ? t50.bars * 15
        : null,

    time_to_100_min:
      resolved100 &&
      t100.reached
        ? t100.bars * 15
        : null,

    time_to_150_min:
      resolved150 &&
      t150.reached
        ? t150.bars * 15
        : null,

    resolved_at:
      resolved150
        ? nowIso()
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Save snapshot                                                               */
/* -------------------------------------------------------------------------- */

async function saveSnapshot(
  detection
) {
  if (!supabaseConfigured()) {
    return;
  }

  const row = {
    symbol:
      detection.symbol,

    timestamp:
      detection.timestamp,

    price:
      detection.price,

    provider:
      detection.provider,

    features:
      detection.features,

    feature_vector:
      detection.featureVector,

    bootstrap_score:
      detection.bootstrapScore,

    learned_t10:
      detection.learned.t10,

    learned_t50:
      detection.learned.t50,

    learned_t100:
      detection.learned.t100,

    learned_t150:
      detection.learned.t150,

    learned_negative:
      detection.learned.negative,

    learned_best_target:
      detection.learned.bestTarget,

    learned_similarity:
      detection.learned.bestSimilarity,

    learned_contrast:
      detection.learned.contrast,
  };

  await supabaseUpsert(
    'hunter_v11_snapshots',
    [row],
    {
      onConflict:
        'symbol,timestamp',
      ignoreDuplicates:
        true,
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Save detection                                                              */
/* -------------------------------------------------------------------------- */

async function saveDetection(
  detection,
  action,
  reason
) {
  if (!supabaseConfigured()) {
    return;
  }

  await supabaseInsert(
    'hunter_v11_detections',
    [
      {
        symbol:
          detection.symbol,

        timestamp:
          detection.timestamp,

        price:
          detection.price,

        provider:
          detection.provider,

        action,

        reason,

        bootstrap_score:
          detection.bootstrapScore,

        learned_similarity:
          detection.learned.bestSimilarity,

        learned_contrast:
          detection.learned.contrast,

        best_target:
          detection.learned.bestTarget,

        features:
          detection.features,

        feature_vector:
          detection.featureVector,
      },
    ]
  );
}

/* -------------------------------------------------------------------------- */
/* Save learning example                                                       */
/* -------------------------------------------------------------------------- */

async function saveExample(
  detection
) {
  if (!supabaseConfigured()) {
    return;
  }

  await supabaseUpsert(
    'hunter_v11_examples',
    [
      {
        symbol:
          detection.symbol,

        timestamp:
          detection.timestamp,

        price:
          detection.price,

        feature_vector:
          detection.featureVector,

        features:
          detection.features,
      },
    ],
    {
      onConflict:
        'symbol,timestamp',

      ignoreDuplicates:
        true,
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Label historical examples                                                   */
/* -------------------------------------------------------------------------- */

async function labelRecentExamples(
  symbol,
  candles
) {
  if (!supabaseConfigured()) {
    return;
  }

  /*
   * We only need to inspect examples from this symbol.
   * The feature vector was captured when the example was created.
   */

  const query =
    '?select=' +
    'id,' +
    'timestamp,' +
    'outcome_10,' +
    'outcome_50,' +
    'outcome_100,' +
    'outcome_150' +
    `&symbol=eq.${encodeURIComponent(symbol)}` +
    '&resolved_at=is.null' +
    '&order=timestamp.asc' +
    '&limit=200';

  const rows =
    await supabaseSelect(
      'hunter_v11_examples',
      query
    );

  if (!rows.length) {
    return;
  }

  const candleMap =
    new Map(
      candles.map(
        candle => [
          candle.timestamp,
          candle,
        ]
      )
    );

  for (
    const row of rows
  ) {
    const timestamp =
      safeNumber(
        row.timestamp
      );

    let index =
      candles.findIndex(
        candle =>
          candle.timestamp ===
          timestamp
      );

    /*
     * If timestamp precision differs slightly between providers,
     * locate the nearest candle.
     */

    if (index < 0) {
      let bestDistance =
        Infinity;

      for (
        let i = 0;
        i < candles.length;
        i++
      ) {
        const distance =
          Math.abs(
            candles[i].timestamp -
            timestamp
          );

        if (
          distance <
          bestDistance
        ) {
          bestDistance =
            distance;
          index = i;
        }
      }

      if (
        bestDistance >
        15 * 60 * 1000
      ) {
        index = -1;
      }
    }

    if (index < 0) {
      continue;
    }

    const labels =
      buildOutcomeLabels(
        candles,
        index
      );

    /*
     * Only update fields that have actually become resolvable.
     */

    const update = {
      outcome_10:
        labels.outcome_10 !== null
          ? labels.outcome_10
          : row.outcome_10,

      outcome_50:
        labels.outcome_50 !== null
          ? labels.outcome_50
          : row.outcome_50,

      outcome_100:
        labels.outcome_100 !== null
          ? labels.outcome_100
          : row.outcome_100,

      outcome_150:
        labels.outcome_150 !== null
          ? labels.outcome_150
          : row.outcome_150,

      mfe_pct_24h:
        labels.mfe_pct_24h !== null
          ? labels.mfe_pct_24h
          : undefined,

      mae_pct_24h:
        labels.mae_pct_24h !== null
          ? labels.mae_pct_24h
          : undefined,

      time_to_10_min:
        labels.time_to_10_min !== null
          ? labels.time_to_10_min
          : undefined,

      time_to_50_min:
        labels.time_to_50_min !== null
          ? labels.time_to_50_min
          : undefined,

      time_to_100_min:
        labels.time_to_100_min !== null
          ? labels.time_to_100_min
          : undefined,

      time_to_150_min:
        labels.time_to_150_min !== null
          ? labels.time_to_150_min
          : undefined,
    };

    const fullyResolved =
      update.outcome_10 !== null &&
      update.outcome_50 !== null &&
      update.outcome_100 !== null &&
      update.outcome_150 !== null;

    if (fullyResolved) {
      update.resolved_at =
        nowIso();
    }

    Object.keys(update)
      .forEach(key => {
        if (
          update[key] === undefined
        ) {
          delete update[key];
        }
      });

    try {
      await supabaseRequest(
        'hunter_v11_examples',
        {
          method: 'PATCH',

          query:
            `?id=eq.${encodeURIComponent(
              row.id
            )}`,

          body: update,

          prefer:
            'return=minimal',
        }
      );
    } catch (error) {
      console.error(
        `[LABEL ${symbol}]`,
        error.message
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Position persistence                                                        */
/* -------------------------------------------------------------------------- */

async function loadOpenPositions() {
  if (!supabaseConfigured()) {
    return;
  }

  const query =
    '?select=*' +
    '&status=eq.OPEN';

  const rows =
    await supabaseSelect(
      'hunter_v11_positions',
      query
    );

  for (
    const row of rows
  ) {
    state.positions.set(
      row.symbol,
      row
    );
  }

  console.log(
    `[POSITIONS] Loaded ${rows.length} open positions`
  );
}

async function persistOpenPosition(
  detection
) {
  if (!supabaseConfigured()) {
    return;
  }

  const row = {
    symbol:
      detection.symbol,

    status:
      'OPEN',

    opened_at:
      nowIso(),

    entry_price:
      detection.price,

    open_bootstrap_score:
      detection.bootstrapScore,

    open_similarity:
      detection.learned.bestSimilarity,

    open_contrast:
      detection.learned.contrast,

    open_target:
      detection.learned.bestTarget,

    open_features:
      detection.features,

    open_feature_vector:
      detection.featureVector,
  };

  const result =
    await supabaseUpsert(
      'hunter_v11_positions',
      [row],
      {
        onConflict:
          'symbol,status',
      }
    );

  /*
   * Keep local state even when Supabase is unavailable.
   */

  state.positions.set(
    detection.symbol,
    {
      ...row,
      id:
        result?.[0]?.id ||
        null,
    }
  );
}

async function persistClosedPosition(
  symbol,
  price,
  reason
) {
  const existing =
    state.positions.get(
      symbol
    );

  if (!existing) {
    return;
  }

  const movePct =
    pctChange(
      price,
      safeNumber(
        existing.entry_price
      )
    );

  if (supabaseConfigured()) {
    const query =
      `?symbol=eq.${encodeURIComponent(symbol)}` +
      '&status=eq.OPEN';

    try {
      await supabaseRequest(
        'hunter_v11_positions',
        {
          method: 'PATCH',

          query,

          body: {
            status:
              'CLOSED',

            closed_at:
              nowIso(),

            exit_price:
              price,

            move_pct:
              movePct,

            close_reason:
              reason,
          },

          prefer:
            'return=minimal',
        }
      );
    } catch (error) {
      console.error(
        `[POSITION CLOSE ${symbol}]`,
        error.message
      );
    }
  }

  state.positions.delete(
    symbol
  );

  return movePct;
}

/* -------------------------------------------------------------------------- */
/* Alert persistence                                                           */
/* -------------------------------------------------------------------------- */

async function saveAlert(
  detection,
  action,
  reason
) {
  if (!supabaseConfigured()) {
    return;
  }

  await supabaseInsert(
    'hunter_v11_alerts',
    [
      {
        symbol:
          detection.symbol,

        timestamp:
          detection.timestamp,

        action,

        price:
          detection.price,

        reason,

        bootstrap_score:
          detection.bootstrapScore,

        learned_similarity:
          detection.learned.bestSimilarity,

        learned_contrast:
          detection.learned.contrast,

        best_target:
          detection.learned.bestTarget,

        features:
          detection.features,
      },
    ]
  );
}

/* -------------------------------------------------------------------------- */
/* Previous alert lookup                                                       */
/* -------------------------------------------------------------------------- */

async function lastAlertForSymbol(
  symbol,
  action
) {
  if (!supabaseConfigured()) {
    return null;
  }

  const query =
    '?select=timestamp' +
    `&symbol=eq.${encodeURIComponent(symbol)}` +
    `&action=eq.${encodeURIComponent(action)}` +
    '&order=timestamp.desc' +
    '&limit=1';

  const rows =
    await supabaseSelect(
      'hunter_v11_alerts',
      query
    );

  return rows[0] || null;
}

async function alertCooldownActive(
  symbol,
  action,
  cooldownMs
) {
  const previous =
    await lastAlertForSymbol(
      symbol,
      action
    );

  if (!previous) {
    return false;
  }

  const previousTime =
    new Date(
      previous.timestamp
    ).getTime();

  if (
    !Number.isFinite(
      previousTime
    )
  ) {
    return false;
  }

  return (
    Date.now() -
      previousTime <
    cooldownMs
  );
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function fmtPct(
  value,
  digits = 1
) {
  const n =
    safeNumber(value);

  const sign =
    n > 0
      ? '+'
      : '';

  return (
    sign +
    n.toFixed(digits) +
    '%'
  );
}

function fmtNumber(
  value,
  digits = 2
) {
  return safeNumber(
    value
  ).toFixed(digits);
}

function formatOpenAlert(
  detection
) {
  const f =
    detection.features;

  const l =
    detection.learned;

  return [
    `🏹 HUNTER OPEN`,
    ``,
    `${detection.symbol}`,
    `Price: ${detection.price}`,
    ``,
    `15m: ${fmtPct(f.ret15m)}`,
    `1h: ${fmtPct(f.ret1h)}`,
    `4h: ${fmtPct(f.ret4h)}`,
    `12h: ${fmtPct(f.ret12h)}`,
    `24h: ${fmtPct(f.ret24h)}`,
    ``,
    `Volume: ${fmtNumber(f.volumeRatio)}x`,
    `Volume acceleration: ${fmtNumber(f.volumeAcceleration)}x`,
    `Buying pressure: ${Math.round(f.buyPressure * 100)}%`,
    `BTC relative strength: ${fmtPct(f.relativeStrength)}`,
    ``,
    `Learned similarity: ${fmtNumber(l.bestSimilarity, 3)}`,
    `Positive vs negative: ${fmtNumber(l.contrast, 3)}`,
    `Best historical target: ${l.bestTarget || 'building'}`,
    ``,
    `Hunter has detected early-stage behaviour consistent with previous major movers.`,
  ].join('\n');
}

function formatHoldAlert(
  detection,
  position
) {
  const move =
    pctChange(
      detection.price,
      safeNumber(
        position.entry_price
      )
    );

  return [
    `🏹 HUNTER HOLD`,
    ``,
    `${detection.symbol}`,
    `Price: ${detection.price}`,
    `Move since OPEN: ${fmtPct(move)}`,
    ``,
    `1h: ${fmtPct(detection.features.ret1h)}`,
    `4h: ${fmtPct(detection.features.ret4h)}`,
    `Volume: ${fmtNumber(detection.features.volumeRatio)}x`,
    `Buying pressure: ${Math.round(detection.features.buyPressure * 100)}%`,
    ``,
    `Learned similarity: ${fmtNumber(detection.learned.bestSimilarity, 3)}`,
    `Positive vs negative: ${fmtNumber(detection.learned.contrast, 3)}`,
    `Best historical target: ${detection.learned.bestTarget || 'building'}`,
    ``,
    `The Hunter thesis remains supported.`,
  ].join('\n');
}

function formatCloseAlert(
  detection,
  position,
  reason
) {
  const move =
    pctChange(
      detection.price,
      safeNumber(
        position.entry_price
      )
    );

  return [
    `🏹 HUNTER CLOSE`,
    ``,
    `${detection.symbol}`,
    `Price: ${detection.price}`,
    `Move since OPEN: ${fmtPct(move)}`,
    ``,
    `Reason: ${reason}`,
    ``,
    `Learned similarity: ${fmtNumber(detection.learned.bestSimilarity, 3)}`,
    `Current score: ${fmtNumber(detection.bootstrapScore, 3)}`,
  ].join('\n');
    }/* -------------------------------------------------------------------------- */
/* Lifecycle decision engine                                                   */
/* -------------------------------------------------------------------------- */

function lifecycleDecision(
  detection
) {
  const symbol =
    detection.symbol;

  const position =
    state.positions.get(
      symbol
    );

  const score =
    detection.bootstrapScore;

  const similarity =
    detection.learned
      .bestSimilarity;

  const contrast =
    detection.learned
      .contrast;

  /*
   * ------------------------------------------------------------------------
   * No existing position
   * ------------------------------------------------------------------------
   */

  if (!position) {
    /*
     * Primary mechanism once Hunter has enough historical examples.
     *
     * This is deliberately based on similarity to previous movers rather
     * than a conventional "BUY score".
     */

    if (
      similarity >=
        CONFIG.LEARNED_OPEN_SIMILARITY &&
      contrast >
        CONFIG.LEARNED_OPEN_CONTRAST
    ) {
      return {
        action: 'OPEN',
        reason:
          'Learned pattern matches previous major movers',
      };
    }

    /*
     * Bootstrap mechanism.
     *
     * Prevents Hunter from having to wait indefinitely for its first
     * useful historical examples.
     *
     * The pre-move caps are important:
     * Hunter should not simply discover something that has already gone
     * vertical and call that early detection.
     */

    if (
      score >=
        CONFIG.BOOTSTRAP_OPEN_SCORE &&
      detection.features.ret4h <
        CONFIG.MAX_PREMOVE_4H_PCT &&
      detection.features.ret24h <
        CONFIG.MAX_PREMOVE_24H_PCT
    ) {
      return {
        action: 'OPEN',
        reason:
          'Early abnormal behaviour detected while still within pre-move range',
      };
    }

    return {
      action: null,
      reason: null,
    };
  }

  /*
   * ------------------------------------------------------------------------
   * Existing position
   * ------------------------------------------------------------------------
   */

  const moveSinceOpen =
    pctChange(
      detection.price,
      safeNumber(
        position.entry_price
      )
    );

  /*
   * Hard deterioration conditions.
   */

  if (
    detection.features.ret1h <
    -4
  ) {
    return {
      action: 'CLOSE',
      reason:
        '1h momentum deterioration',
    };
  }

  if (
    detection.features.ret4h <
    -8
  ) {
    return {
      action: 'CLOSE',
      reason:
        '4h momentum deterioration',
    };
  }

  /*
   * If the pattern has become materially unlike the historical
   * positive examples AND is no longer showing meaningful early-stage
   * behaviour, the thesis has failed.
   */

  if (
    similarity <
      CONFIG.CLOSE_SIMILARITY &&
    score <
      CONFIG.CLOSE_SCORE
  ) {
    return {
      action: 'CLOSE',
      reason:
        'Historical pattern support has materially deteriorated',
    };
  }

  /*
   * A +150% move has reached the upper end of Hunter's current
   * discovery objective.
   *
   * At that point the early-move thesis has completed.
   */

  if (
    moveSinceOpen >= 150
  ) {
    return {
      action: 'CLOSE',
      reason:
        '150% Hunter objective reached',
    };
  }

  /*
   * Continue holding while the thesis remains strongly supported.
   */

  if (
    score >=
      CONFIG.HOLD_SCORE &&
    similarity >=
      CONFIG.HOLD_SIMILARITY
  ) {
    return {
      action: 'HOLD',
      reason:
        'Hunter thesis remains supported',
    };
  }

  /*
   * No alert if the setup is simply quiet.
   */

  return {
    action: null,
    reason: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Execute lifecycle action                                                    */
/* -------------------------------------------------------------------------- */

async function executeLifecycle(
  detection,
  decision
) {
  if (
    !decision?.action
  ) {
    return;
  }

  const {
    action,
    reason,
  } = decision;

  /*
   * OPEN
   */

  if (
    action === 'OPEN'
  ) {
    const activePosition =
      state.positions.get(
        detection.symbol
      );

    if (activePosition) {
      return;
    }

    const cooldown =
      await alertCooldownActive(
        detection.symbol,
        'OPEN',
        CONFIG.OPEN_COOLDOWN_MS
      );

    if (cooldown) {
      return;
    }

    /*
     * Persist the position before sending the alert.
     *
     * This means a restart after the alert does not lose the fact
     * that Hunter considers the setup OPEN.
     */

    await persistOpenPosition(
      detection
    );

    await saveDetection(
      detection,
      'OPEN',
      reason
    );

    await saveAlert(
      detection,
      'OPEN',
      reason
    );

    await sendAlert(
      formatOpenAlert(
        detection
      )
    );

    return;
  }

  /*
   * HOLD
   */

  if (
    action === 'HOLD'
  ) {
    const position =
      state.positions.get(
        detection.symbol
      );

    if (!position) {
      return;
    }

    const cooldown =
      await alertCooldownActive(
        detection.symbol,
        'HOLD',
        CONFIG.HOLD_COOLDOWN_MS
      );

    if (cooldown) {
      return;
    }

    await saveDetection(
      detection,
      'HOLD',
      reason
    );

    await saveAlert(
      detection,
      'HOLD',
      reason
    );

    await sendAlert(
      formatHoldAlert(
        detection,
        position
      )
    );

    return;
  }

  /*
   * CLOSE
   */

  if (
    action === 'CLOSE'
  ) {
    const position =
      state.positions.get(
        detection.symbol
      );

    if (!position) {
      return;
    }

    const cooldown =
      await alertCooldownActive(
        detection.symbol,
        'CLOSE',
        CONFIG.CLOSE_COOLDOWN_MS
      );

    if (cooldown) {
      return;
    }

    await saveDetection(
      detection,
      'CLOSE',
      reason
    );

    await saveAlert(
      detection,
      'CLOSE',
      reason
    );

    await sendAlert(
      formatCloseAlert(
        detection,
        position,
        reason
      )
    );

    await persistClosedPosition(
      detection.symbol,
      detection.price,
      reason
    );
  }
}

/* -------------------------------------------------------------------------- */
/* BTC reference data                                                          */
/* -------------------------------------------------------------------------- */

let btcReferenceCache = {
  timestamp: 0,
  candles: [],
};

async function getBtcReference() {
  /*
   * BTC is used as the market-relative reference.
   *
   * Cache it for the duration of a scan so Hunter does not request
   * BTC hundreds of times.
   */

  if (
    btcReferenceCache.candles.length &&
    Date.now() -
      btcReferenceCache.timestamp <
      5 * 60 * 1000
  ) {
    return btcReferenceCache.candles;
  }

  const result =
    await fetchCandles(
      'BTCUSDT'
    );

  if (
    !result.candles.length
  ) {
    return [];
  }

  btcReferenceCache = {
    timestamp: Date.now(),
    candles:
      result.candles,
  };

  return result.candles;
}

/* -------------------------------------------------------------------------- */
/* Scan one asset                                                              */
/* -------------------------------------------------------------------------- */

async function scanAsset(
  symbol,
  btcCandles
) {
  const market =
    await fetchCandles(
      symbol
    );

  if (
    !market.candles.length
  ) {
    return null;
  }

  const candles =
    market.candles;

  const features =
    calculateFeatures(
      candles,
      btcCandles
    );

  if (!features) {
    return null;
  }

  const featureVector =
    buildFeatureVector(
      features
    );

  if (!featureVector) {
    return null;
  }

  const bootstrap =
    bootstrapScore(
      features
    );

  /*
   * Learning data is loaded once per scan rather than once per asset.
   * This property is injected later by scanUniverse().
   */

  return {
    symbol,

    timestamp:
      candles[
        candles.length - 1
      ].timestamp,

    price:
      candles[
        candles.length - 1
      ].close,

    provider:
      market.provider,

    candles,

    features,

    featureVector,

    bootstrapScore:
      bootstrap,

    learned: {
      t10: 0,
      t50: 0,
      t100: 0,
      t150: 0,
      negative: 0,
      bestTarget: null,
      bestSimilarity: 0,
      contrast: 0,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Scan concurrency                                                            */
/* -------------------------------------------------------------------------- */

async function mapConcurrent(
  items,
  concurrency,
  worker
) {
  const results =
    new Array(items.length);

  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index =
        nextIndex++;

      if (
        index >=
        items.length
      ) {
        return;
      }

      try {
        results[index] =
          await worker(
            items[index],
            index
          );
      } catch (error) {
        console.error(
          `[WORKER ${items[index]}]`,
          error.message
        );

        results[index] =
          null;
      }
    }
  }

  const workers =
    Math.min(
      concurrency,
      items.length
    );

  await Promise.all(
    Array.from(
      {
        length: workers,
      },
      () => runner()
    )
  );

  return results;
}

/* -------------------------------------------------------------------------- */
/* Scan entire universe                                                        */
/* -------------------------------------------------------------------------- */

async function scanUniverse() {
  console.log(
    `\n==================================================`
  );

  console.log(
    `[${nowIso()}] HUNTER V11 SCAN START`
  );

  console.log(
    `==================================================`
  );

  if (
    !state.universe.length ||
    Date.now() -
      state.lastUniverseRefresh >
      CONFIG.UNIVERSE_REFRESH_MS
  ) {
    await discoverUniverse();
  }

  if (
    state.universe.length <
    CONFIG.MIN_CRYPTO_ASSETS
  ) {
    throw new Error(
      `Universe below minimum: ${state.universe.length}`
    );
  }

  const btcCandles =
    await getBtcReference();

  if (
    !btcCandles.length
  ) {
    throw new Error(
      'Unable to obtain BTC reference candles'
    );
  }

  /*
   * Learning examples are loaded once for the complete scan.
   */

  const learningExamples =
    await loadLearningExamples();

  console.log(
    `[LEARNING] ${learningExamples.length} historical examples loaded`
  );

  const detections =
    await mapConcurrent(
      state.universe,
      CONFIG.CONCURRENCY,
      async symbol => {
        const detection =
          await scanAsset(
            symbol,
            btcCandles
          );

        if (!detection) {
          return null;
        }

        detection.learned =
          learnedSimilarity(
            detection.featureVector,
            learningExamples
          );

        return detection;
      }
    );

  const validDetections =
    detections.filter(
      Boolean
    );

  /*
   * Save every detected asset, not only the top ten.
   *
   * This is critical:
   * a future 100% mover should not disappear from the learning dataset
   * simply because it ranked #11 during an earlier scan.
   */

  for (
    const detection of
      validDetections
  ) {
    await saveSnapshot(
      detection
    );

    await saveExample(
      detection
    );

    /*
     * Label any previous examples for this asset using the newly
     * available future candles.
     */

    await labelRecentExamples(
      detection.symbol,
      detection.candles
    );
  }

  /*
   * Sort only for human-readable diagnostics.
   * It does NOT restrict which assets receive lifecycle evaluation.
   */

  const ranked =
    [...validDetections]
      .sort(
        (a, b) => {
          const aScore =
            Math.max(
              a.bootstrapScore,
              a.learned.bestSimilarity
            );

          const bScore =
            Math.max(
              b.bootstrapScore,
              b.learned.bestSimilarity
            );

          return bScore - aScore;
        }
      );

  console.log(
    `[SCAN] ${validDetections.length}/${state.universe.length} assets processed`
  );

  console.log(
    `[SCAN] Top early-stage candidates:`
  );

  ranked
    .slice(0, 15)
    .forEach(
      (detection, index) => {
        console.log(
          `${String(index + 1).padStart(2, '0')}. ` +
          `${detection.symbol} ` +
          `bootstrap=${detection.bootstrapScore.toFixed(3)} ` +
          `learned=${detection.learned.bestSimilarity.toFixed(3)} ` +
          `contrast=${detection.learned.contrast.toFixed(3)} ` +
          `4h=${fmtPct(detection.features.ret4h)} ` +
          `24h=${fmtPct(detection.features.ret24h)}`
        );
      }
    );

  /*
   * Lifecycle decisions are made for EVERY valid asset.
   */

  for (
    const detection of
      validDetections
  ) {
    const decision =
      lifecycleDecision(
        detection
      );

    if (
      decision.action
    ) {
      console.log(
        `[${decision.action}] ` +
        `${detection.symbol} — ` +
        `${decision.reason}`
      );

      await executeLifecycle(
        detection,
        decision
      );
    }
  }

  console.log(
    `[POSITIONS] ${state.positions.size} active Hunter positions`
  );

  console.log(
    `[PROVIDERS] ` +
    `Bybit ${state.providerStats.BYBIT.success}/${state.providerStats.BYBIT.failure} ` +
    `Binance ${state.providerStats.BINANCE.success}/${state.providerStats.BINANCE.failure} ` +
    `OKX ${state.providerStats.OKX.success}/${state.providerStats.OKX.failure}`
  );

  console.log(
    `[${nowIso()}] HUNTER V11 SCAN COMPLETE`
  );

  console.log(
    `==================================================\n`
  );
}

/* -------------------------------------------------------------------------- */
/* Startup diagnostics                                                         */
/* -------------------------------------------------------------------------- */

function printStartupDiagnostics() {
  console.log(
    `\n==================================================`
  );

  console.log(
    `🏹 HUNTER V11`
  );

  console.log(
    `Crypto-only early-move discovery + learning engine`
  );

  console.log(
    `==================================================`
  );

  console.log(
    `Minimum assets: ${CONFIG.MIN_CRYPTO_ASSETS}`
  );

  console.log(
    `Target assets: ${CONFIG.TARGET_CRYPTO_ASSETS}`
  );

  console.log(
    `Maximum assets: ${CONFIG.MAX_CRYPTO_ASSETS}`
  );

  console.log(
    `Candle timeframe: ${CONFIG.CANDLE_INTERVAL}m`
  );

  console.log(
    `Candle history: ${CONFIG.CANDLE_LIMIT}`
  );

  console.log(
    `Supabase: ${
      supabaseConfigured()
        ? 'configured'
        : 'NOT configured'
    }`
  );

  console.log(
    `Telegram: ${
      ENV.BOT_TOKEN
        ? 'configured'
        : 'NOT configured'
    }`
  );

  console.log(
    `Bluejam chat: ${
      ENV.BLUEJAM_CHAT_ID
        ? 'configured'
        : 'NOT configured'
    }`
  );

  console.log(
    `Channel chat: ${
      ENV.CHANNEL_CHAT_ID
        ? 'configured'
        : 'not configured'
    }`
  );

  console.log(
    `Hunter live flag: ${
      ENV.HUNTER_LIVE
        ? 'true'
        : 'false'
    }`
  );

  console.log(
    `Learning targets: +10% / +50% / +100% / +150%`
  );

  console.log(
    `User actions: OPEN / HOLD / CLOSE`
  );

  console.log(
    `==================================================\n`
  );
}

/* -------------------------------------------------------------------------- */
/* Main loop                                                                   */
/* -------------------------------------------------------------------------- */

async function runHunter() {
  if (state.running) {
    console.log(
      '[MAIN] Previous scan still running; skipping.'
    );

    return;
  }

  state.running = true;

  try {
    await scanUniverse();
  } catch (error) {
    console.error(
      '[HUNTER ERROR]',
      error
    );

    await sendAlert(
      `🏹 HUNTER ERROR\n\n${error.message}`
    );
  } finally {
    state.running = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Graceful shutdown                                                           */
/* -------------------------------------------------------------------------- */

let shutdownStarted =
  false;

async function shutdown(
  signal
) {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;

  console.log(
    `[SHUTDOWN] ${signal}`
  );

  /*
   * There are no open exchange positions because Hunter V11 does not
   * execute trades. Its persisted "OPEN" state is the user's trade
   * lifecycle state, not a broker position.
   */

  process.exit(0);
}

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);

/* -------------------------------------------------------------------------- */
/* Fatal error handling                                                        */
/* -------------------------------------------------------------------------- */

process.on(
  'uncaughtException',
  error => {
    console.error(
      '[UNCAUGHT EXCEPTION]',
      error
    );
  }
);

process.on(
  'unhandledRejection',
  error => {
    console.error(
      '[UNHANDLED REJECTION]',
      error
    );
  }
);

/* -------------------------------------------------------------------------- */
/* Start                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  printStartupDiagnostics();

  await loadOpenPositions();

  /*
   * Run immediately on startup.
   *
   * Then repeat every 15 minutes.
   */

  await runHunter();

  setInterval(
    runHunter,
    CONFIG.SCAN_INTERVAL_MS
  );
}

main().catch(
  error => {
    console.error(
      '[FATAL STARTUP ERROR]',
      error
    );

    process.exit(1);
  }
);
