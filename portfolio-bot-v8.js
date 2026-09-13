'use strict';

/**
 * HUNTER V13 — CRYPTO EARLY-MOVE DISCOVERY + LEARNING ENGINE
 *
 * User-facing lifecycle:
 *   OPEN -> HOLD -> CLOSE
 *
 * North star:
 *   Identify cryptocurrencies before +10%, +50%, +100% and +150% moves.
 *
 * Architecture:
 *   Broad universe
 *       ->
 *   Closed-candle feature extraction
 *       ->
 *   Persistent observation history
 *       ->
 *   Outcome measurement
 *       ->
 *   Historical learning
 *       ->
 *   Continuation vs exhaustion classification
 *       ->
 *   Cream-of-the-crop ranking
 *       ->
 *   OPEN / HOLD / CLOSE
 *
 * IMPORTANT:
 * - Crypto only.
 * - No stock logic.
 * - No order execution.
 * - No invented trade prices.
 * - Uses existing Railway environment variables.
 * - Broad scanning is separate from user-facing alerts.
 * - Every valid observation is retained for learning.
 */

const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const ENV = {
  BOT_TOKEN:
    process.env.BOT_TOKEN,

  BLUEJAM_CHAT_ID:
    process.env.BLUEJAM_CHAT_ID ||
    process.env.CHAT_ID,

  CHANNEL_CHAT_ID:
    process.env.CHANNEL_CHAT_ID,

  SUPABASE_URL:
    process.env.SUPABASE_URL ||
    process.env.SUPABASE_PROJECT_URL,

  SUPABASE_KEY:
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
  /*
   * Hunter is deliberately slower than a pure execution bot.
   * The purpose is discovery + learning rather than order execution.
   */
  cycleMs:
    15 * 60 * 1000,

  /*
   * Broad crypto universe.
   */
  minAssets: 120,
  targetAssets: 160,
  maxAssets: 200,

  /*
   * 400 x 15m = 100 hours.
   *
   * This gives enough candle history for the +96h (+150%) outcome
   * horizon while preserving a useful pre-move feature window.
   */
  candleLimit: 400,
  minCandles: 60,

  batchSize: 8,
  batchPauseMs: 500,

  requestTimeoutMs: 12000,
  maxRetries: 2,

  universeRefreshMs:
    30 * 60 * 1000,

  /*
   * User-facing lifecycle controls.
   */
  openCooldownMs:
    6 * 60 * 60 * 1000,

  holdCooldownMs:
    8 * 60 * 60 * 1000,

  reopenCooldownMs:
    12 * 60 * 60 * 1000,

  closeCooldownMs:
    60 * 60 * 1000,

  maxOpenPositions: 3,

  holdMinScoreImprovement:
    0.05,

  /*
   * Learning.
   */
  openSimilarityThreshold:
    0.70,

  /*
   * Bootstrap is deliberately expressed as 0-1.
   * creamScore is expressed as 0-100.
   */
  openBootstrapScore:
    0.82,

  minPositiveExamples:
    20,

  /*
   * Cream-of-the-crop alert layer.
   */
  creamMinScore:
    82,

  creamMaxOpenPerCycle:
    2,

  /*
   * Minimum fresh movement.
   */
  creamMinRet15m:
    0.001,

  creamMinRet1h:
    0.003,

  creamMinRet4h:
    0.015,

  /*
   * Participation requirements.
   */
  creamMinVolumeRatio:
    2.0,

  creamMinVolumeAcceleration:
    1.20,

  creamMinBuyPressure:
    1.25,

  creamMinRelativeStrength:
    0.01,

  /*
   * Structure.
   */
  creamMinBaseQuality:
    0.50,

  creamMinMoveQuality:
    0.55,

  /*
   * These are no longer simple hard "do not alert" ceilings.
   *
   * They are used by isTooLate() to distinguish:
   *
   *   large + accelerating
   *
   * from:
   *
   *   large + exhausted.
   */
  creamMaxRet4h:
    0.50,

  creamMaxRet24h:
    0.60,

  creamMaxExhaustion:
    0.80,

  continuationMinScore:
    0.60,

  continuationMinMomentumAcceleration:
    1.25,

  continuationMinVolumeAcceleration:
    1.50,

  continuationMinBuyPressure:
    1.50,

  continuationMinRelativeStrength:
    0.02,

  /*
   * Longest learning horizon is 96h.
   * 120h gives a 24h safety buffer.
   */
  learningLookbackHours:
    120,

  /*
   * Universe liquidity floor.
   */
  minQuoteVolume24h:
    250000,

  /*
   * Outcome horizons.
   */
  horizons: {
    10: 24,
    50: 48,
    100: 72,
    150: 96,
  },

  /*
   * Feature vector.
   *
   * DO NOT change ordering without deliberately versioning the
   * learning dataset.
   */
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

let supabase =
  null;

if (
  ENV.SUPABASE_URL &&
  ENV.SUPABASE_KEY
) {
  supabase =
    createClient(
      ENV.SUPABASE_URL,
      ENV.SUPABASE_KEY,
      {
        auth: {
          autoRefreshToken:
            false,

          persistSession:
            false,
        },
      }
    );
}

const STATE = {
  cycleRunning:
    false,

  cycle:
    0,

  universe:
    [],

  universeAt:
    0,

  active:
    new Map(),

  providerHealth:
    new Map(),

  featureCache:
    new Map(),

  learning:
    null,

  btcRisk:
    null,
};

function sleep(
  ms
) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function num(
  value,
  fallback = 0
) {
  const n =
    Number(value);

  return Number.isFinite(
    n
  )
    ? n
    : fallback;
}

function clamp(
  value,
  low,
  high
) {
  return Math.max(
    low,
    Math.min(
      high,
      value
    )
  );
}

function pct(
  value
) {
  return (
    num(value) * 100
  );
}

function safePct(
  a,
  b
) {
  return b
    ? (a - b) / b
    : 0;
}

function avg(
  values
) {
  return values.length
    ? values.reduce(
        (
          x,
          y
        ) =>
          x + y,
        0
      ) /
        values.length
    : 0;
}

function median(
  values
) {
  if (
    !values.length
  ) {
    return 0;
  }

  const sorted =
    [
      ...values,
    ].sort(
      (
        a,
        b
      ) =>
        a - b
    );

  const middle =
    Math.floor(
      sorted.length / 2
    );

  return (
    sorted.length % 2
      ? sorted[middle]
      : (
          sorted[
            middle - 1
          ] +
          sorted[
            middle
          ]
        ) / 2
  );
}

function round(
  value,
  decimals = 4
) {
  const power =
    10 ** decimals;

  return (
    Math.round(
      num(value) *
        power
    ) / power
  );
}

function iso(
  ms = Date.now()
) {
  return new Date(
    ms
  ).toISOString();
}

function baseSymbol(
  symbol
) {
  return String(symbol)
    .replace(
      /USDT$/i,
      ''
    )
    .toUpperCase();
}

function providerMark(
  name,
  ok,
  error = ''
) {
  const provider =
    STATE.providerHealth.get(
      name
    ) || {
      ok: 0,
      fail: 0,
    };

  if (ok) {
    provider.ok++;
    provider.lastOk =
      Date.now();
  } else {
    provider.fail++;
    provider.lastFail =
      Date.now();

    provider.lastError =
      error;
  }

  STATE.providerHealth.set(
    name,
    provider
  );
}

function jsonSafe(
  value
) {
  try {
    JSON.stringify(
      value
    );

    return value;
  } catch {
    return null;
  }
}

/* ============================================================
 * HTTP
 * ========================================================== */

function httpGet(
  url,
  headers = {}
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      const request =
        https.get(
          url,
          {
            headers: {
              'User-Agent':
                'Hunter-V13/1.0',

              ...headers,
            },

            timeout:
              CONFIG.requestTimeoutMs,
          },

          response => {
            let body =
              '';

            response.on(
              'data',
              chunk => {
                body +=
                  chunk;
              }
            );

            response.on(
              'end',
              () => {
                const status =
                  response.statusCode ||
                  0;

                if (
                  status < 200 ||
                  status >= 300
                ) {
                  reject(
                    new Error(
                      `HTTP ${status} from ${url}`
                    )
                  );

                  return;
                }

                try {
                  resolve(
                    JSON.parse(
                      body
                    )
                  );
                } catch {
                  resolve(
                    body
                  );
                }
              }
            );
          }
        );

      request.on(
        'timeout',
        () => {
          request.destroy(
            new Error(
              `Timeout fetching ${url}`
            )
          );
        }
      );

      request.on(
        'error',
        reject
      );
    }
  );
}

/* ============================================================
 * PROVIDER HEALTH
 * ========================================================== */

function getProviderStats() {
  const result =
    {};

  for (
    const [
      name,
      stats,
    ] of STATE.providerHealth
  ) {
    result[name] =
      {
        ok:
          stats.ok || 0,

        fail:
          stats.fail || 0,

        lastOk:
          stats.lastOk
            ? iso(
                stats.lastOk
              )
            : null,

        lastFail:
          stats.lastFail
            ? iso(
                stats.lastFail
              )
            : null,

        lastError:
          stats.lastError ||
          null,
      };
  }

  return result;
}

/* ============================================================
 * BYBIT
 * ========================================================== */

async function bybitSpotTickers() {
  try {
    const url =
      'https://api.bybit.com/v5/market/tickers?category=spot';

    const data =
      await httpGet(
        url
      );

    providerMark(
      'bybit-tickers',
      true
    );

    return (
      data?.result?.list ||
      []
    )
      .filter(
        item =>
          String(
            item.symbol ||
              ''
          ).endsWith(
            'USDT'
          )
      )
      .map(
        item => ({
          symbol:
            String(
              item.symbol
            ),

          quoteVolume:
            num(
              item.turnover24h
            ),

          price:
            num(
              item.lastPrice
            ),

          change24h:
            num(
              item.price24hPcnt
            ),
        })
      )
      .filter(
        item =>
          item.price >
            0 &&
          item.quoteVolume >
            0
      );
  } catch (
    error
  ) {
    providerMark(
      'bybit-tickers',
      false,
      error.message
    );

    return [];
  }
}

async function bybitSpotExchangeInfo() {
  try {
    const url =
      'https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000';

    const data =
      await httpGet(
        url
      );

    providerMark(
      'bybit-symbols',
      true
    );

    return (
      data?.result?.list ||
      []
    )
      .filter(
        item =>
          item.quoteCoin ===
          'USDT' &&
          item.status ===
          'Trading'
      )
      .map(
        item =>
          String(
            item.symbol
          )
      );
  } catch (
    error
  ) {
    providerMark(
      'bybit-symbols',
      false,
      error.message
    );

    return [];
  }
}

async function binanceSpotTickers() {
  try {
    const url =
      'https://api.binance.com/api/v3/ticker/24hr';

    const data =
      await httpGet(
        url
      );

    providerMark(
      'binance-tickers',
      true
    );

    return Array.isArray(
      data
    )
      ? data
          .filter(
            item =>
              String(
                item.symbol ||
                  ''
              ).endsWith(
                'USDT'
              )
          )
          .map(
            item => ({
              symbol:
                String(
                  item.symbol
                ),

              quoteVolume:
                num(
                  item.quoteVolume
                ),

              price:
                num(
                  item.lastPrice
                ),

              change24h:
                num(
                  item.priceChangePercent
                ) / 100,
            })
          )
          .filter(
            item =>
              item.price >
                0 &&
              item.quoteVolume >
                0
          )
      : [];
  } catch (
    error
  ) {
    providerMark(
      'binance-tickers',
      false,
      error.message
    );

    return [];
  }
}

async function binanceSpotExchangeInfo() {
  try {
    const url =
      'https://api.binance.com/api/v3/exchangeInfo';

    const data =
      await httpGet(
        url
      );

    providerMark(
      'binance-symbols',
      true
    );

    return (
      data?.symbols ||
      []
    )
      .filter(
        item =>
          item.quoteAsset ===
            'USDT' &&
          item.status ===
            'TRADING' &&
          item.isSpotTradingAllowed !==
            false
      )
      .map(
        item =>
          String(
            item.symbol
          )
      );
  } catch (
    error
  ) {
    providerMark(
      'binance-symbols',
      false,
      error.message
    );

    return [];
  }
}

async function okxSpotTickers() {
  try {
    const url =
      'https://www.okx.com/api/v5/market/tickers?instType=SPOT';

    const data =
      await httpGet(
        url
      );

    providerMark(
      'okx-tickers',
      true
    );

    return (
      data?.data ||
      []
    )
      .filter(
        item =>
          String(
            item.instId ||
              ''
          ).endsWith(
            '-USDT'
          )
      )
      .map(
        item => ({
          symbol:
            String(
              item.instId
            ).replace(
              '-USDT',
              'USDT'
            ),

          quoteVolume:
            num(
              item.volCcy24h
            ) *
            num(
              item.last
            ),

          price:
            num(
              item.last
            ),

          change24h:
            num(
              item.sodUtc0
            ) > 0
              ? num(
                  item.last
                ) /
                  num(
                    item.sodUtc0
                  ) -
                1
              : 0,
        })
      )
      .filter(
        item =>
          item.price >
            0 &&
          item.quoteVolume >
            0
      );
  } catch (
    error
  ) {
    providerMark(
      'okx-tickers',
      false,
      error.message
    );

    return [];
  }
}

/* ============================================================
 * UNIVERSE
 * ========================================================== */

async function discoverUniverse() {
  const [
    bybit,
    binance,
    okx,
  ] =
    await Promise.all([
      bybitSpotTickers(),
      binanceSpotTickers(),
      okxSpotTickers(),
    ]);

  const binanceSymbols =
    new Set(
      await binanceSpotExchangeInfo()
    );

  const bybitSymbols =
    new Set(
      await bybitSpotExchangeInfo()
    );

  const merged =
    new Map();

  for (
    const ticker of [
      ...bybit,
      ...binance,
      ...okx,
    ]
  ) {
    const symbol =
      ticker.symbol;

    const existing =
      merged.get(
        symbol
      );

    if (
      existing
    ) {
      existing.quoteVolume =
        Math.max(
          existing.quoteVolume,
          ticker.quoteVolume
        );

      existing.change24h =
        avg([
          existing.change24h,
          ticker.change24h,
        ]);

      existing.bybit =
        existing.bybit ||
        bybitSymbols.has(
          symbol
        );

      existing.binance =
        existing.binance ||
        binanceSymbols.has(
          symbol
        );

      existing.okx =
        existing.okx ||
        okx.some(
          item =>
            item.symbol ===
            symbol
        );
    } else {
      merged.set(
        symbol,
        {
          symbol,
          quoteVolume:
            ticker.quoteVolume,

          change24h:
            ticker.change24h,

          bybit:
            bybitSymbols.has(
              symbol
            ),

          binance:
            binanceSymbols.has(
              symbol
            ),

          okx:
            okx.some(
              item =>
                item.symbol ===
                symbol
            ),
        }
      );
    }
  }

  /*
   * Pull the persistent denylist.
   *
   * This means a symbol rejected by previous analysis or operational
   * review stays excluded without hard-coding the decision in JavaScript.
   */
  let denylist =
    new Set();

  if (
    supabase
  ) {
    const {
      data: denied,
    } =
      await supabase
        .from(
          'hunter_v11_denylist'
        )
        .select(
          'symbol'
        );

    denylist =
      new Set(
        (
          denied ||
          []
        ).map(
          row =>
            String(
              row.symbol
            ).toUpperCase()
        )
      );
  }

  /*
   * Stablecoins and fiat-pegged products are not useful candidates
   * for Hunter's large-move discovery objective.
   */
  const blockedStableBases =
    new Set([
      'USDC',
      'FDUSD',
      'TUSD',
      'DAI',
      'USDE',
      'USDD',
      'USD1',
      'PYUSD',
      'EUR',
      'EURC',
    ]);

  /*
   * Leveraged/synthetic products.
   */
  const banned =
    /((UP|DOWN|BULL|BEAR)USDT$)|(^1000)/i;

  const eligible =
    [
      ...merged.values(),
    ].filter(
      item =>
        !banned.test(
          item.symbol
        ) &&

        !denylist.has(
          item.symbol
        ) &&

        !blockedStableBases.has(
          baseSymbol(
            item.symbol
          )
        ) &&

        item.quoteVolume >=
          CONFIG.minQuoteVolume24h
    );

  const byLiquidity =
    [
      ...eligible,
    ].sort(
      (
        a,
        b
      ) =>
        b.quoteVolume -
        a.quoteVolume
    );

  const byMovement =
    [
      ...eligible,
    ].sort(
      (
        a,
        b
      ) => {
        const movementA =
          Math.abs(
            a.change24h
          ) *
          Math.log10(
            1 +
              a.quoteVolume
          );

        const movementB =
          Math.abs(
            b.change24h
          ) *
          Math.log10(
            1 +
              b.quoteVolume
          );

        return (
          movementB -
          movementA
        );
      }
    );

  /*
   * Keep a broad liquid core while reserving part of the universe
   * for assets already showing abnormal movement.
   */
  const selectedMap =
    new Map();

  for (
    const asset of
      byLiquidity.slice(
        0,
        140
      )
  ) {
    selectedMap.set(
      asset.symbol,
      asset
    );
  }

  for (
    const asset of
      byMovement.slice(
        0,
        80
      )
  ) {
    selectedMap.set(
      asset.symbol,
      asset
    );
  }

  const selected =
    [
      ...selectedMap.values(),
    ].slice(
      0,
      CONFIG.maxAssets
    );

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

/* ============================================================
 * CANDLES
 * ========================================================== */

function normaliseCandles(
  rows
) {
  return rows
    .map(
      candle => ({
        time:
          num(
            candle.time
          ),

        open:
          num(
            candle.open
          ),

        high:
          num(
            candle.high
          ),

        low:
          num(
            candle.low
          ),

        close:
          num(
            candle.close
          ),

        volume:
          num(
            candle.volume
          ),
      })
    )
    .filter(
      candle =>
        candle.time &&
        candle.close >
          0 &&
        candle.high >=
          candle.low
    )
    .sort(
      (
        a,
        b
      ) =>
        a.time -
        b.time
    );
}

async function bybitCandles(
  symbol,
  limit =
    CONFIG.candleLimit
) {
  const url =
    `https://api.bybit.com/v5/market/kline` +
    `?category=spot` +
    `&symbol=${encodeURIComponent(
      symbol
    )}` +
    `&interval=15` +
    `&limit=${limit}`;

  try {
    const data =
      await httpGet(
        url
      );

    providerMark(
      'bybit-candles',
      true
    );

    const rows =
      data?.result?.list ||
      [];

    return normaliseCandles(
      rows.map(
        row => ({
          time:
            num(
              row[0]
            ),

          open:
            num(
              row[1]
            ),

          high:
            num(
              row[2]
            ),

          low:
            num(
              row[3]
            ),

          close:
            num(
              row[4]
            ),

          volume:
            num(
              row[5]
            ),
        })
      ).reverse()
    );
  } catch (
    error
  ) {
    providerMark(
      'bybit-candles',
      false,
      error.message
    );

    return null;
  }
}

async function binanceCandles(
  symbol,
  limit =
    CONFIG.candleLimit
) {
  const url =
    `https://api.binance.com/api/v3/klines` +
    `?symbol=${encodeURIComponent(
      symbol
    )}` +
    `&interval=15m` +
    `&limit=${limit}`;

  try {
    const raw =
      await httpGet(
        url
      );

    if (
      !Array.isArray(
        raw
      )
    ) {
      return null;
    }

    providerMark(
      'binance-candles',
      true
    );

    return normaliseCandles(
      raw.map(
        candle => ({
          time:
            num(
              candle[0]
            ),

          open:
            num(
              candle[1]
            ),

          high:
            num(
              candle[2]
            ),

          low:
            num(
              candle[3]
            ),

          close:
            num(
              candle[4]
            ),

          volume:
            num(
              candle[5]
            ),
        })
      )
    );
  } catch (
    error
  ) {
    providerMark(
      'binance-candles',
      false,
      error.message
    );

    return null;
  }
}

async function okxCandles(
  symbol,
  limit =
    CONFIG.candleLimit
) {
  const instId =
    symbol.replace(
      /USDT$/i,
      '-USDT'
    );

  const url =
    `https://www.okx.com/api/v5/market/candles` +
    `?instId=${encodeURIComponent(
      instId
    )}` +
    `&bar=15m` +
    `&limit=${Math.min(
      limit,
      300
    )}`;

  try {
    const data =
      await httpGet(
        url
      );

    providerMark(
      'okx-candles',
      true
    );

    const rows =
      data?.data ||
      [];

    return normaliseCandles(
      rows.map(
        row => ({
          time:
            num(
              row[0]
            ),

          open:
            num(
              row[1]
            ),

          high:
            num(
              row[2]
            ),

          low:
            num(
              row[3]
            ),

          close:
            num(
              row[4]
            ),

          volume:
            num(
              row[5]
            ),
        })
      ).reverse()
    );
  } catch (
    error
  ) {
    providerMark(
      'okx-candles',
      false,
      error.message
    );

    return null;
  }
}

async function candlesFor(
  symbol
) {
  const providers = [
    [
      'BYBIT',
      () =>
        bybitCandles(
          symbol
        ),
    ],

    [
      'BINANCE',
      () =>
        binanceCandles(
          symbol
        ),
    ],

    [
      'OKX',
      () =>
        okxCandles(
          symbol
        ),
    ],
  ];

  let lastError =
    null;

  for (
    const [
      name,
      loader,
    ] of providers
  ) {
    for (
      let attempt = 0;
      attempt <=
        CONFIG.maxRetries;
      attempt++
    ) {
      try {
        const candles =
          await loader();

        if (
          candles &&
          candles.length >=
            CONFIG.minCandles
        ) {
          /*
           * Do not allow an incomplete current candle to become a feature.
           *
           * 15m candles are aligned to the quarter-hour. The last candle
           * is removed if its close time has not yet passed.
           */
          const currentBucket =
            Math.floor(
              Date.now() /
                900000
            ) *
            900000;

          const closed =
            candles.filter(
              candle =>
                candle.time <
                currentBucket
            );

          if (
            closed.length >=
            CONFIG.minCandles
          ) {
            return {
              provider:
                name,

              candles:
                closed,
            };
          }
        }
      } catch (
        error
      ) {
        lastError =
          error;
      }

      if (
        attempt <
        CONFIG.maxRetries
      ) {
        await sleep(
          500 *
          (
            attempt +
            1
          )
        );
      }
    }
  }

  throw (
    lastError ||
    new Error(
      `No candle provider available for ${symbol}`
    )
  );
}

/* ============================================================
 * FEATURE ENGINE
 * ========================================================== */

function trueRange(
  current,
  previous
) {
  if (
    !previous
  ) {
    return (
      current.high -
      current.low
    );
  }

  return Math.max(
    current.high -
      current.low,

    Math.abs(
      current.high -
        previous.close
    ),

    Math.abs(
      current.low -
        previous.close
    )
  );
}

function getMoveMaturity(
  candles
) {
  if (
    candles.length <
    20
  ) {
    return 0;
  }

  const start =
    candles.at(
      -20
    ).close;

  const end =
    candles.at(
      -1
    ).close;

  if (
    !start ||
    !end
  ) {
    return 0;
  }

  return (
    end /
      start
  ) - 1;
}

function getMomentumProfile(
  candles
) {
  if (
    candles.length <
    12
  ) {
    return 0;
  }

  const recent =
    candles
      .slice(
        -4
      )
      .map(
        candle =>
          candle.close
      );

  const prior =
    candles
      .slice(
        -12,
        -4
      )
      .map(
        candle =>
          candle.close
      );

  const recentReturn =
    recent.length >=
    2
      ? recent.at(
          -1
        ) /
          recent[0] -
        1
      : 0;

  const priorReturn =
    prior.length >=
    2
      ? prior.at(
          -1
        ) /
          prior[0] -
        1
      : 0;

  return clamp(
    (
      recentReturn -
      priorReturn
    ) *
      10,
    -1,
    1
  );
}

function getVolumeProfile(
  candles
) {
  if (
    candles.length <
    20
  ) {
    return 0;
  }

  const recent =
    avg(
      candles
        .slice(
          -4
        )
        .map(
          candle =>
            candle.volume
        )
    );

  const prior =
    avg(
      candles
        .slice(
          -16,
          -4
        )
        .map(
          candle =>
            candle.volume
        )
    );

  if (
    prior <=
    0
  ) {
    return 0;
  }

  return clamp(
    Math.log(
      recent /
        prior
    ),
    -1,
    1
  );
}

function getMoveAtrUnits(
  candles
) {
  if (
    candles.length <
    20
  ) {
    return 0;
  }

  const ranges =
    candles
      .slice(
        -15
      )
      .map(
        (
          candle,
          index
        ) =>
          trueRange(
            candle,
            candles[
              Math.max(
                0,
                candles.length -
                  15 +
                  index -
                  1
              )
            ]
          )
      );

  const atr =
    avg(
      ranges
    );

  if (
    atr <=
    0
  ) {
    return 0;
  }

  const move =
    candles.at(
      -1
    ).close -
    candles.at(
      -16
    ).close;

  return (
    move /
    atr
  );
}

function isParabolicExhaustion(
  candles
) {
  if (
    candles.length <
    24
  ) {
    return 0;
  }

  const returns =
    [];

  for (
    let i =
      Math.max(
        1,
        candles.length -
          16
      );
    i <
    candles.length;
    i++
  ) {
    const previous =
      candles[
        i - 1
      ].close;

    const current =
      candles[
        i
      ].close;

    if (
      previous >
      0
    ) {
      returns.push(
        current /
          previous -
        1
      );
    }
  }

  const positive =
    returns.filter(
      value =>
        value >
        0
    );

  const averagePositive =
    avg(
      positive
    );

  const recent =
    avg(
      returns.slice(
        -4
      )
    );

  const prior =
    avg(
      returns.slice(
        -12,
        -4
      )
    );

  const atrUnits =
    Math.abs(
      getMoveAtrUnits(
        candles
      )
    );

  let score =
    0;

  if (
    averagePositive >
    0.01
  ) {
    score +=
      0.20;
  }

  if (
    recent >
      prior *
        1.75 &&
    recent >
      0
  ) {
    score +=
      0.20;
  }

  if (
    atrUnits >
    8
  ) {
    score +=
      0.20;
  }

  if (
    atrUnits >
    12
  ) {
    score +=
      0.20;
  }

  const latest =
    returns.at(
      -1
    ) || 0;

  if (
    latest <
      0 &&
    averagePositive >
      0.015
  ) {
    score +=
      0.20;
  }

  return clamp(
    score,
    0,
    1
  );
}

function isFirstPullbackContinuation(
  candles
) {
  if (
    candles.length <
    16
  ) {
    return false;
  }

  const highs =
    candles
      .slice(
        -12,
        -3
      )
      .map(
        candle =>
          candle.high
      );

  const highest =
    Math.max(
      ...highs
    );

  const recentLow =
    Math.min(
      ...candles
        .slice(
          -3
        )
        .map(
          candle =>
            candle.low
        )
    );

  const latest =
    candles.at(
      -1
    ).close;

  if (
    highest <=
    0
  ) {
    return false;
  }

  const pullback =
    recentLow /
      highest -
    1;

  const recovery =
    latest /
      recentLow -
    1;

  return (
    pullback <=
      -0.015 &&
    pullback >=
      -0.12 &&
    recovery >=
      0.01
  );
}

function baseStructureQuality(
  candles
) {
  if (
    candles.length <
    24
  ) {
    return 0;
  }

  const base =
    candles.slice(
      -24,
      -6
    );

  const lows =
    base.map(
      candle =>
        candle.low
    );

  const highs =
    base.map(
      candle =>
        candle.high
    );

  const minLow =
    Math.min(
      ...lows
    );

  const maxHigh =
    Math.max(
      ...highs
    );

  const range =
    maxHigh -
    minLow;

  if (
    range <=
    0
  ) {
    return 0;
  }

  const closes =
    base.map(
      candle =>
        candle.close
    );

  let higherLowCount =
    0;

  for (
    let i = 1;
    i <
      lows.length;
    i++
  ) {
    if (
      lows[i] >
      lows[
        i - 1
      ]
    ) {
      higherLowCount++;
    }
  }

  const closeStability =
    1 -
    clamp(
      avg(
        closes.map(
          close =>
            Math.abs(
              close -
                avg(
                  closes
                )
            ) /
            range
        )
      ),
      0,
      1
    );

  const higherLowScore =
    higherLowCount /
    Math.max(
      1,
      lows.length -
        1
    );

  return clamp(
    higherLowScore *
      0.6 +
      closeStability *
      0.4,
    0,
    1
  );
}

function buildFeatures(
  candles,
  btcCandles
) {
  if (
    candles.length <
    32
  ) {
    return null;
  }

  const latest =
    candles.at(
      -1
    );

  const price =
    latest.close;

  if (
    !Number.isFinite(
      price
    ) ||
    price <=
    0
  ) {
    return null;
  }

  function returnOver(
    bars
  ) {
    if (
      candles.length <=
      bars
    ) {
      return 0;
    }

    const previous =
      candles[
        candles.length -
          1 -
          bars
      ].close;

    return previous >
      0
      ? price /
          previous -
        1
      : 0;
  }

  const ret15m =
    returnOver(
      1
    );

  const ret1h =
    returnOver(
      4
    );

  const ret2h =
    returnOver(
      8
    );

  const ret4h =
    returnOver(
      16
    );

  const ret8h =
    returnOver(
      32
    );

  const ret12h =
    returnOver(
      48
    );

  const ret24h =
    returnOver(
      96
    );

  const recentVolumes =
    candles
      .slice(
        -4
      )
      .map(
        candle =>
          candle.volume
      );

  const priorVolumes =
    candles
      .slice(
        -20,
        -4
      )
      .map(
        candle =>
          candle.volume
      );

  const recentVolume =
    avg(
      recentVolumes
    );

  const priorVolume =
    avg(
      priorVolumes
    );

  const volumeRatio =
    priorVolume >
    0
      ? recentVolume /
        priorVolume
      : 0;

  const recentVolumeShort =
    avg(
      candles
        .slice(
          -2
        )
        .map(
          candle =>
            candle.volume
        )
    );

  const earlierVolumeShort =
    avg(
      candles
        .slice(
          -8,
          -2
        )
        .map(
          candle =>
            candle.volume
        )
    );

  const volumeAcceleration =
    earlierVolumeShort >
    0
      ? recentVolumeShort /
        earlierVolumeShort
      : 0;

  const buyVolumes =
    candles
      .slice(
        -8
      )
      .map(
        candle => {
          const range =
            candle.high -
            candle.low;

          if (
            range <=
            0
          ) {
            return 0;
          }

          const closePosition =
            (
              candle.close -
              candle.low
            ) /
            range;

          return (
            candle.volume *
            closePosition
          );
        }
      );

  const sellVolumes =
    candles
      .slice(
        -8
      )
      .map(
        candle => {
          const range =
            candle.high -
            candle.low;

          if (
            range <=
            0
          ) {
            return 0;
          }

          const closePosition =
            (
              candle.high -
              candle.close
            ) /
            range;

          return (
            candle.volume *
            closePosition
          );
        }
      );

  const buyPressure =
    sum(
      buyVolumes
    ) /
    Math.max(
      1,
      sum(
        sellVolumes
      )
    );

  const recentRange =
    avg(
      candles
        .slice(
          -4
        )
        .map(
          candle =>
            candle.high -
            candle.low
        )
    );

  const priorRange =
    avg(
      candles
        .slice(
          -16,
          -4
        )
        .map(
          candle =>
            candle.high -
            candle.low
        )
    );

  const rangeExpansion =
    priorRange >
    0
      ? recentRange /
        priorRange
      : 0;

  const rangeCompression =
    priorRange >
    0
      ? 1 -
        recentRange /
          priorRange
      : 0;

  const higherLow =
    (() => {
      const lows =
        candles
          .slice(
            -6,
            -1
          )
          .map(
            candle =>
              candle.low
          );

      return (
        lows.length >=
          3 &&
        lows.at(
          -1
        ) >
          lows.at(
            -2
          ) &&
        lows.at(
          -2
        ) >
          lows.at(
            -3
          )
      );
    })();

  const priceCompression =
    avg(
      candles
        .slice(
          -5,
          -1
        )
        .map(
          candle =>
            Math.abs(
              candle.close -
                candle.open
            ) /
            (
              candle.close ||
              1
            )
        )
    );

  const btcPrice =
    btcCandles?.at(
      -1
    )?.close ||
    0;

  const btc4h =
    btcCandles &&
    btcCandles.length >
      16
      ? btcPrice /
          btcCandles[
            btcCandles.length -
              17
          ].close -
        1
      : 0;

  const relativeStrength =
    ret4h -
    btc4h;

  const returns =
    [];

  for (
    let i =
      Math.max(
        1,
        candles.length -
          16
      );
    i <
      candles.length;
    i++
  ) {
    const previous =
      candles[
        i - 1
      ].close;

    const current =
      candles[
        i
      ].close;

    if (
      previous >
      0
    ) {
      returns.push(
        current /
          previous -
        1
      );
    }
  }

  const momentumRecent =
    avg(
      returns.slice(
        -4
      )
    );

  const momentumPrior =
    avg(
      returns.slice(
        -12,
        -4
      )
    );

  const momentumAcceleration =
    momentumPrior !==
      0
      ? momentumRecent /
        momentumPrior
      : 0;

  const compression =
    priorRange >
    0
      ? 1 -
        recentRange /
          priorRange
      : 0;

  const maturity =
    getMoveMaturity(
      candles
    );

  const momentumProfile =
    getMomentumProfile(
      candles
    );

  const volumeProfile =
    getVolumeProfile(
      candles
    );

  const moveAtrUnits =
    getMoveAtrUnits(
      candles
    );

  const parabolicExhaustion =
    isParabolicExhaustion(
      candles
    );

  const firstPullbackContinuation =
    isFirstPullbackContinuation(
      candles
    );

  const baseQuality =
    baseStructureQuality(
      candles
    );

  const range =
    latest.high -
    latest.low;

  const closePosition =
    range >
    0
      ? (
          latest.close -
          latest.low
        ) /
        range
      : 0.5;

  const previousHigh =
    Math.max(
      ...candles
        .slice(
          -12,
          -1
        )
        .map(
          candle =>
            candle.high
        )
    );

  const breakoutProximity =
    previousHigh >
    0
      ? price /
          previousHigh -
        1
      : 0;

  const slopeStart =
    candles[
      Math.max(
        0,
        candles.length -
          20
      )
    ].close;

  const trendSlope =
    slopeStart >
    0
      ? price /
          slopeStart -
        1
      : 0;

  const atrValues =
    candles
      .slice(
        -15
      )
      .map(
        (
          candle,
          index
        ) =>
          trueRange(
            candle,
            candles[
              Math.max(
                0,
                candles.length -
                  15 +
                  index -
                  1
              )
            ]
          )
      );

  const atr =
    avg(
      atrValues
    );

  const atrPct =
    price >
    0
      ? atr /
        price
      : 0;

  return {
    ret15m,
    ret1h,
    ret2h,
    ret4h,
    ret8h,
    ret12h,
    ret24h,

    volumeRatio,
    volumeAcceleration,

    buyPressure,

    rangeExpansion,
    rangeCompression:
      compression,

    higherLow,

    priceCompression,

    relativeStrength,

    momentumAcceleration,

    closePosition,

    breakoutProximity,

    trendSlope,

    atrPct,

    moveAtrUnits,

    momentumProfile,

    volumeProfile,

    parabolicExhaustion,

    firstPullbackContinuation,

    baseQuality,

    maturity,

    currentPrice:
      price,

    candleTime:
      latest.time,
  };
}

/* ============================================================
 * VECTOR
 * ========================================================== */

function featureVector(
  features
) {
  return CONFIG.featureNames.map(
    name =>
      num(
        features[
          name
        ]
      )
  );
}

/* ============================================================
 * SCORING
 * ========================================================== */

function bootstrapEvidence(
  f
) {
  const momentum =
    clamp(
      (
        f.ret1h /
          0.06 +
        f.ret4h /
          0.12 +
        f.momentumProfile +
        f.momentumAcceleration /
          3
      ) /
        4,
      0,
      1
    );

  const volume =
    clamp(
      (
        Math.log(
          Math.max(
            1,
            f.volumeRatio
          )
        ) /
          Math.log(
            6
          ) +
        Math.log(
          Math.max(
            1,
            f.volumeAcceleration
          )
        ) /
          Math.log(
            3
          )
      ) /
        2,
      0,
      1
    );

  const buying =
    clamp(
      (
        f.buyPressure -
        1
      ) /
        2,
      0,
      1
    );

  const structure =
    clamp(
      (
        f.baseQuality +
        (
          f.higherLow
            ? 0.2
            : 0
        ) +
        f.closePosition +
        clamp(
          f.breakoutProximity *
            10,
          0,
          1
        )
      ) /
        3.2,
      0,
      1
    );

  const relative =
    clamp(
      (
        f.relativeStrength +
        0.01
      ) /
        0.08,
      0,
      1
    );

  const early =
    clamp(
      1 -
        Math.abs(
          f.ret24h
        ) /
          0.60,
      0,
      1
    );

  const exhaustionPenalty =
    clamp(
      f.parabolicExhaustion,
      0,
      1
    );

  const raw =
    momentum *
      0.28 +
    volume *
      0.22 +
    buying *
      0.20 +
    structure *
      0.12 +
    relative *
      0.10 +
    early *
      0.08;

  return clamp(
    raw -
      exhaustionPenalty *
        0.10,
    0,
    1
  );
}

function earlyStageScore(
  f
) {
  let score =
    0;

  if (
    f.ret15m >
    0
  ) {
    score +=
      0.15;
  }

  if (
    f.ret1h >
    0
  ) {
    score +=
      0.20;
  }

  if (
    f.ret4h >
    0
  ) {
    score +=
      0.20;
  }

  if (
    f.ret4h >=
      0.015 &&
    f.ret4h <=
      0.10
  ) {
    score +=
      0.15;
  }

  if (
    f.ret24h >=
      0 &&
    f.ret24h <=
      0.25
  ) {
    score +=
      0.10;
  }

  if (
    f.firstPullbackContinuation
  ) {
    score +=
      0.10;
  }

  if (
    f.baseQuality >=
    0.60
  ) {
    score +=
      0.10;
  }

  return clamp(
    score,
    0,
    1
  );
}

function continuationStrength(
  f
) {
  let score =
    0;

  /*
   * A continuing move must show progress in multiple dimensions.
   *
   * A raw +30% move alone does not qualify.
   */

  if (
    f.ret1h >=
    0.08
  ) {
    score +=
      0.15;
  } else if (
    f.ret1h >=
    0.04
  ) {
    score +=
      0.08;
  }

  if (
    f.ret4h >=
    0.15
  ) {
    score +=
      0.15;
  } else if (
    f.ret4h >=
    0.08
  ) {
    score +=
      0.08;
  }

  if (
    f.momentumProfile >=
    0.15
  ) {
    score +=
      0.15;
  }

  if (
    f.momentumAcceleration >=
    CONFIG.continuationMinMomentumAcceleration
  ) {
    score +=
      0.15;
  }

  if (
    f.volumeAcceleration >=
    CONFIG.continuationMinVolumeAcceleration
  ) {
    score +=
      0.15;
  }

  if (
    f.buyPressure >=
    CONFIG.continuationMinBuyPressure
  ) {
    score +=
      0.10;
  }

  if (
    f.relativeStrength >=
    CONFIG.continuationMinRelativeStrength
  ) {
    score +=
      0.10;
  }

  if (
    f.higherLow ||
    f.firstPullbackContinuation
  ) {
    score +=
      0.10;
  }

  return clamp(
    score,
    0,
    1
  );
}

function isTooLate(
  f
) {
  const continuation =
    continuationStrength(
      f
    );

  /*
   * Huge 4h move is only automatically late when the actual momentum
   * and participation have deteriorated.
   */
  if (
    f.ret4h >
      CONFIG.creamMaxRet4h &&
    f.momentumProfile <
      -0.20 &&
    f.momentumAcceleration <=
      0 &&
    f.volumeAcceleration <
      1.25
  ) {
    return {
      tooLate:
        true,

      reason:
        'parabolic exhaustion',

      continuation,
    };
  }

  /*
   * 24h extension followed by a reversing 4h structure.
   */
  if (
    f.ret24h >
      CONFIG.creamMaxRet24h &&
    f.ret4h <
      0
  ) {
    return {
      tooLate:
        true,

      reason:
        '24h extended, 4h reversing',

      continuation,
    };
  }

  /*
   * Large move with weakening momentum and weak participation.
   */
  if (
    f.ret4h >
      0.40 &&
    f.momentumProfile <
      0 &&
    f.buyPressure <
      CONFIG.continuationMinBuyPressure
  ) {
    return {
      tooLate:
        true,

      reason:
        'extended with weak participation',

      continuation,
    };
  }

  /*
   * High exhaustion is not sufficient by itself.
   * We require fading momentum as well.
   */
  if (
    f.parabolicExhaustion >=
      CONFIG.creamMaxExhaustion &&
    f.momentumAcceleration <=
      0 &&
    f.ret1h <=
      0
  ) {
    return {
      tooLate:
        true,

      reason:
        'exhaustion with fading momentum',

      continuation,
    };
  }

  /*
   * Preserve the anti-chase rule for truly extended moves.
   */
  if (
    f.ret4h >
      0.50 &&
    continuation <
      CONFIG.continuationMinScore
  ) {
    return {
      tooLate:
        true,

      reason:
        'too extended without continuation',

      continuation,
    };
  }

  return {
    tooLate:
      false,

    continuation,
  };
}

function creamScore(
  f,
  learning
) {
  const historical =
    learning.mode ===
    'LEARNED'
      ? clamp(
          learning.similarity ||
            0,
          0,
          1
        )
      : bootstrapEvidence(
          f
        );

  const momentum =
    avg([
      clamp(
        (
          f.ret1h +
          0.01
        ) /
          0.06,
        0,
        1
      ),

      clamp(
        (
          f.ret4h +
          0.02
        ) /
          0.12,
        0,
        1
      ),

      clamp(
        (
          f.momentumProfile +
          1
        ) /
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
          Math.log(
            6
          ),
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
          Math.log(
            3
          ),
        0,
        1
      ),

      clamp(
        (
          f.volumeProfile +
          1
        ) /
          2,
        0,
        1
      ),
    ]);

  const buying =
    clamp(
      (
        f.buyPressure -
        1
      ) /
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

      f.higherLow
        ? 1
        : 0,

      clamp(
        f.closePosition,
        0,
        1
      ),

      clamp(
        (
          f.breakoutProximity -
          0.90
        ) /
          0.10,
        0,
        1
      ),

      f.firstPullbackContinuation
        ? 1
        : 0,
    ]);

  const relative =
    clamp(
      (
        f.relativeStrength +
        0.01
      ) /
        0.08,
      0,
      1
    );

  const early =
    earlyStageScore(
      f
    );

  const continuation =
    continuationStrength(
      f
    );

  let score =
    historical *
      25 +
    momentum *
      20 +
    volume *
      15 +
    buying *
      15 +
    structure *
      10 +
    relative *
      10 +
    early *
      5;

  /*
   * Continuation bonus.
   *
   * This is deliberately small.
   * The percentage move itself must never dominate Hunter.
   */
  score +=
    continuation *
    5;

  /*
   * Learned positive-vs-negative contrast.
   */
  if (
    learning.mode ===
      'LEARNED' &&
    learning.contrast !=
      null
  ) {
    score +=
      clamp(
        learning.contrast /
          0.10,
        0,
        1
      ) *
      5;
  }

  /*
   * Exhaustion remains a penalty.
   * It is simply no longer an automatic rejection by itself.
   */
  if (
    f.parabolicExhaustion >=
    0.50
  ) {
    score -=
      (
        f.parabolicExhaustion -
        0.50
      ) *
      30;
  }

  /*
   * Moderate anti-chase penalty.
   * The gate decides whether a strong continuation is actually too late.
   */
  if (
    f.ret4h >
      0.15
  ) {
    score -=
      (
        f.ret4h -
        0.15
      ) *
      80;
  }

  if (
    f.ret24h >
      0.20
  ) {
    score -=
      (
        f.ret24h -
        0.20
      ) *
      50;
  }

  if (
    f.momentumProfile <
    -0.25
  ) {
    score -=
      8;
  }

  if (
    f.relativeStrength <
    0
  ) {
    score -=
      5;
  }

  return clamp(
    score,
    0,
    100
  );
}

function moveStage(
  f
) {
  if (
    f.parabolicExhaustion >=
      0.70 &&
    f.momentumProfile <
      0
  ) {
    return 'CLIMAX RISK';
  }

  if (
    f.firstPullbackContinuation
  ) {
    return 'FIRST PULLBACK';
  }

  if (
    f.ret1h >=
      0.015 &&
    f.volumeAcceleration >=
      1.5 &&
    f.momentumProfile >
      0.10
  ) {
    return 'ACCELERATING';
  }

  return 'BUILDING';
}

function btcRiskState(
  btcFeatures
) {
  if (
    !btcFeatures
  ) {
    return {
      blocked:
        false,

      penalty:
        0,

      label:
        'UNKNOWN',
    };
  }

  const ret1 =
    btcFeatures.ret1h;

  const ret4 =
    btcFeatures.ret4h;

  if (
    ret1 <=
      -0.025 &&
    ret4 <=
      -0.04
  ) {
    return {
      blocked:
        true,

      penalty:
        25,

      label:
        'RISK-OFF',
    };
  }

  if (
    ret1 <=
      -0.015 ||
    ret4 <=
      -0.025
  ) {
    return {
      blocked:
        false,

      penalty:
        10,

      label:
        'WEAK',
    };
  }

  if (
    ret1 >=
      0.01 ||
    ret4 >=
      0.02
  ) {
    return {
      blocked:
        false,

      penalty:
        -3,

      label:
        'SUPPORTIVE',
    };
  }

  return {
    blocked:
      false,

    penalty:
      0,

    label:
      'NEUTRAL',
  };
}

/* ============================================================
 * LEARNING MODEL
 * ========================================================== */

async function getLearningModel() {
  const empty = {
    byTarget: {
      10: [],
      50: [],
      100: [],
      150: [],
    },

    negatives:
      [],

    counts: {
      10: 0,
      50: 0,
      100: 0,
      150: 0,
      negative: 0,
    },
  };

  if (
    !supabase
  ) {
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
          ascending:
            false,
        }
      )
      .limit(
        4000
      );

  if (
    error
  ) {
    console.error(
      `[DB] hunter_v11_examples: ${error.message}`
    );

    return empty;
  }

  const model =
    empty;

  for (
    const row of
      data ||
      []
  ) {
    const vector =
      Array.isArray(
        row.feature_vector
      )
        ? row.feature_vector
        : null;

    /*
     * Ignore historical vectors from an incompatible feature version.
     */
    if (
      !vector ||
      vector.length !==
        CONFIG.featureNames.length
    ) {
      continue;
    }

    if (
      row.outcome_10 ===
      true
    ) {
      model.byTarget[
        10
      ].push(
        vector
      );
    }

    if (
      row.outcome_50 ===
      true
    ) {
      model.byTarget[
        50
      ].push(
        vector
      );
    }

    if (
      row.outcome_100 ===
      true
    ) {
      model.byTarget[
        100
      ].push(
        vector
      );
    }

    if (
      row.outcome_150 ===
      true
    ) {
      model.byTarget[
        150
      ].push(
        vector
      );
    }

    /*
     * +10% is the base negative class.
     * A +50/+100/+150 winner is also a +10 winner.
     */
    if (
      row.outcome_10 ===
      false
    ) {
      model.negatives.push(
        vector
      );
    }
  }

  for (
    const target of [
      10,
      50,
      100,
      150,
    ]
  ) {
    model.counts[
      target
    ] =
      model.byTarget[
        target
      ].length;
  }

  model.counts.negative =
    model.negatives.length;

  return model;
}

function cosine(
  a,
  b
) {
  if (
    !Array.isArray(
      a
    ) ||
    !Array.isArray(
      b
    ) ||
    !a.length ||
    a.length !==
      b.length
  ) {
    return 0;
  }

  let dot =
    0;

  let aa =
    0;

  let bb =
    0;

  for (
    let i = 0;
    i <
      a.length;
    i++
  ) {
    const x =
      num(
        a[i]
      );

    const y =
      num(
        b[i]
      );

    dot +=
      x * y;

    aa +=
      x * x;

    bb +=
      y * y;
  }

  if (
    aa <=
      0 ||
    bb <=
      0
  ) {
    return 0;
  }

  return (
    dot /
    (
      Math.sqrt(
        aa
      ) *
      Math.sqrt(
        bb
      )
    )
  );
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

  if (
    !compatible.length
  ) {
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
        (
          a,
          b
        ) =>
          b - a
      )
      .slice(
        0,
        limit
      );

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
        model.byTarget[
          10
        ]
      ),

    50:
      topSimilarity(
        vector,
        model.byTarget[
          50
        ]
      ),

    100:
      topSimilarity(
        vector,
        model.byTarget[
          100
        ]
      ),

    150:
      topSimilarity(
        vector,
        model.byTarget[
          150
        ]
      ),
  };

  const available =
    Object.values(
      similarities
    ).filter(
      value =>
        value !=
        null
    );

  if (
    !available.length
  ) {
    return {
      similarity:
        null,

      contrast:
        null,

      targetSimilarities:
        similarities,

      mode:
        'BOOTSTRAP',
    };
  }

  const counts = {
    10:
      model.byTarget[
        10
      ].length,

    50:
      model.byTarget[
        50
      ].length,

    100:
      model.byTarget[
        100
      ].length,

    150:
      model.byTarget[
        150
      ].length,
  };

  const matureTargets =
    Object.values(
      counts
    ).filter(
      value =>
        value >=
        CONFIG.minPositiveExamples
    ).length;

  /*
   * Do not allow one tiny target class to take over the learned model.
   */
  if (
    matureTargets ===
    0
  ) {
    return {
      similarity:
        null,

      contrast:
        null,

      targetSimilarities:
        similarities,

      mode:
        'BOOTSTRAP',
    };
  }

  const best =
    Math.max(
      ...available
    );

  let contrast =
    null;

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
    similarity:
      best,

    contrast,

    targetSimilarities:
      similarities,

    mode:
      'LEARNED',
  };
}

/* ============================================================
 * SUPABASE HELPERS
 * ========================================================== */

async function dbInsert(
  table,
  row
) {
  if (
    !supabase
  ) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabase
      .from(
        table
      )
      .insert(
        row
      )
      .select()
      .maybeSingle();

  if (
    error
  ) {
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
  if (
    !supabase
  ) {
    return null;
  }

  const {
    data,
    error,
  } =
    await supabase
      .from(
        table
      )
      .upsert(
        row,
        {
          onConflict,
          ignoreDuplicates:
            false,
        }
      )
      .select()
      .maybeSingle();

  if (
    error
  ) {
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
  if (
    !supabase
  ) {
    return false;
  }

  let query =
    supabase
      .from(
        table
      )
      .update(
        row
      );

  for (
    const [
      key,
      value,
    ] of Object.entries(
      match
    )
  ) {
    query =
      query.eq(
        key,
        value
      );
  }

  const {
    error,
  } =
    await query;

  if (
    error
  ) {
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
        iso(
          features.candleTime
        ),

      price:
        features.currentPrice,

      features:
        jsonSafe(
          features
        ),

      feature_vector:
        featureVector(
          features
        ),

      bootstrap_score:
        round(
          bootstrap,
          6
        ),

      learned_similarity:
        similarity ==
        null
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
        snapshotId ||
        null,

      symbol:
        asset.symbol,

      timestamp:
        iso(
          features.candleTime
        ),

      feature_vector:
        featureVector(
          features
        ),

      price:
        features.currentPrice,

      outcome_10:
        null,

      outcome_50:
        null,

      outcome_100:
        null,

      outcome_150:
        null,

      mfe_pct_24h:
        null,

      mae_pct_24h:
        null,

      time_to_10_min:
        null,

      time_to_50_min:
        null,

      time_to_100_min:
        null,

      time_to_150_min:
        null,

      resolved_at:
        null,
    },
    'symbol,timestamp'
  );
}

/* ============================================================
 * OUTCOME LABELING
 * ========================================================== */

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
        iso(
          oldest
        )
      )
      .is(
        'resolved_at',
        null
      )
      .order(
        'timestamp',
        {
          ascending:
            true,
        }
      )
      .limit(
        100
      );

  if (
    error ||
    !data?.length
  ) {
    return;
  }

  for (
    const example of
      data
  ) {
    const timestamp =
      new Date(
        example.timestamp
      ).getTime();

    const ageHours =
      (
        Date.now() -
        timestamp
      ) /
      3600000;

    const updates =
      {};

    let allResolved =
      true;

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
        example[
          column
        ] !== null
      ) {
        continue;
      }

      if (
        ageHours <
        hours
      ) {
        allResolved =
          false;

        continue;
      }

      const end =
        timestamp +
        hours *
          3600000;

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
        (
          1 +
          Number(
            target
          ) /
            100
        );

      updates[
        column
      ] =
        maxPrice >=
        threshold;

      if (
        target ===
        '10'
      ) {
        updates.mfe_pct_24h =
          (
            (
              maxPrice -
              example.price
            ) /
            example.price
          ) *
          100;

        updates.mae_pct_24h =
          (
            (
              minPrice -
              example.price
            ) /
            example.price
          ) *
          100;
      }

      const hit =
        future.find(
          candle =>
            candle.high >=
            threshold
        );

      if (
        hit
      ) {
        updates[
          `time_to_${target}_min`
        ] =
          Math.max(
            0,
            (
              hit.time -
              timestamp
            ) /
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

/* ============================================================
 * DETECTION
 * ========================================================== */

async function analyseAsset(
  asset,
  btcCandles,
  learningModel
) {
  const result =
    await candlesFor(
      asset.symbol
    );

  if (
    !result
  ) {
    return null;
  }

  const features =
    buildFeatures(
      result.candles,
      btcCandles
    );

  if (
    !features
  ) {
    return null;
  }

  const vector =
    featureVector(
      features
    );

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
    moveStage(
      features
    );

  return {
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
}

/* ============================================================
 * DETECTION PERSISTENCE
 * ========================================================== */

async function saveDetection(
  detection
) {
  if (
    !supabase
  ) {
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
        detection.learning
          .similarity ==
        null
          ? null
          : round(
              detection.learning.similarity,
              6
            ),

      contrast:
        detection.learning
          .contrast ==
        null
          ? null
          : round(
              detection.learning.contrast,
              6
            ),

      stage:
        detection.stage,

      features:
        jsonSafe(
          detection.features
        ),

      feature_vector:
        detection.vector,
    }
  );
}

/* ============================================================
 * MEASUREMENT / OBSERVATION HISTORY
 * ========================================================== */

async function saveObservationHistory(
  detection,
  btcRisk,
  fieldAverage =
    null
) {
  if (
    !supabase
  ) {
    return null;
  }

  const f =
    detection.features;

  const participation =
    clamp(
      avg([
        clamp(
          f.volumeRatio /
            4,
          0,
          1
        ),

        clamp(
          f.volumeAcceleration /
            3,
          0,
          1
        ),

        clamp(
          (
            f.buyPressure -
            1
          ) /
            2,
          0,
          1
        ),
      ]),
      0,
      1
    ) *
    100;

  const momentum =
    clamp(
      avg([
        clamp(
          (
            f.ret1h +
            0.01
          ) /
            0.06,
          0,
          1
        ),

        clamp(
          (
            f.ret4h +
            0.02
          ) /
            0.12,
          0,
          1
        ),

        clamp(
          (
            f.momentumProfile +
            1
          ) /
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
      ]),
      0,
      1
    ) *
    100;

  const structure =
    clamp(
      avg([
        clamp(
          f.baseQuality,
          0,
          1
        ),

        f.higherLow
          ? 1
          : 0,

        clamp(
          f.closePosition,
          0,
          1
        ),

        f.firstPullbackContinuation
          ? 1
          : 0,
      ]),
      0,
      1
    ) *
    100;

  const row = {
    /*
     * This table is an observation ledger.
     * It is NOT restricted to Telegram alerts.
     */
    alert_id:
      null,

    symbol:
      detection.symbol,

    asset_type:
      'CRYPTO',

    setup_type:
      detection.stage,

    hunter_score:
      round(
        detection.creamScore,
        4
      ),

    score_strength:
      round(
        detection.bootstrapScore *
          100,
        4
      ),

    score_participation:
      round(
        participation,
        4
      ),

    score_momentum:
      round(
        momentum,
        4
      ),

    score_execution:
      round(
        structure,
        4
      ),

    score_risk:
      round(
        (
          1 -
          f.parabolicExhaustion
        ) *
          100,
        4
      ),

    score_confidence:
      detection.learning
        .similarity ==
      null
        ? round(
            detection.bootstrapScore *
              100,
            4
          )
        : round(
            detection.learning.similarity *
              100,
            4
          ),

    score_conviction:
      detection.learning
        .contrast ==
      null
        ? round(
            detection.creamScore,
            4
          )
        : round(
            clamp(
              detection.learning
                .contrast,
              0,
              1
            ) *
              100,
            4
          ),

    edge_over_field:
      fieldAverage ==
      null
        ? null
        : round(
            detection.creamScore -
              fieldAverage,
            4
          ),

    btc_regime:
      btcRisk?.label ||
      'UNKNOWN',

    /*
     * Hunter is crypto-only.
     * QQQ has no role in this engine.
     */
    qqq_regime:
      'N/A',

    field_avg_at_alert:
      fieldAverage,

    outcome:
      'PENDING',

    is_resolved:
      false,

    alerted_at:
      null,

    analytics_version:
      'v2.0.0',

    formula_version:
      'hunter-v13',
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
  if (
    !supabase ||
    !detections.length
  ) {
    return;
  }

  /*
   * The watchlist is deliberately small.
   *
   * It is not the whole scan universe.
   * It represents the strongest current candidates that are worth
   * preserving as a stateful object across cycles.
   */
  const ranked =
    [
      ...detections,
    ]
      .sort(
        (
          a,
          b
        ) =>
          b.creamScore -
          a.creamScore
      )
      .slice(
        0,
        10
      );

  const selected =
    new Set(
      ranked.map(
        detection =>
          detection.symbol
      )
    );

  for (
    const detection of
      ranked
  ) {
    const {
      data: previous,
    } =
      await supabase
        .from(
          'hunter_watchlist'
        )
        .select(
          'hunter_score'
        )
        .eq(
          'symbol',
          detection.symbol
        )
        .maybeSingle();

    const oldScore =
      previous?.hunter_score ==
      null
        ? null
        : num(
            previous.hunter_score
          );

    const scoreTrend =
      oldScore ==
      null
        ? 'NEW'
        : detection.creamScore >
            oldScore +
              0.5
          ? 'RISING'
          : detection.creamScore <
              oldScore -
                0.5
            ? 'FALLING'
            : 'STABLE';

    await dbUpsert(
      'hunter_watchlist',
      {
        symbol:
          detection.symbol,

        asset_type:
          'CRYPTO',

        hunter_score:
          round(
            detection.creamScore,
            4
          ),

        score_trend:
          scoreTrend,

        btc_regime:
          btcRisk?.label ||
          'UNKNOWN',

        qqq_regime:
          'N/A',

        last_updated:
          iso(),
      },
      'symbol'
    );
  }

  /*
   * Remove stale candidates so the persistent watchlist represents
   * the current top field rather than becoming a historical graveyard.
   */
  const {
    data: existing,
  } =
    await supabase
      .from(
        'hunter_watchlist'
      )
      .select(
        'symbol'
      );

  for (
    const row of
      existing ||
      []
  ) {
    if (
      !selected.has(
        row.symbol
      )
    ) {
      await supabase
        .from(
          'hunter_watchlist'
        )
        .delete()
        .eq(
          'symbol',
          row.symbol
        );
    }
  }
}

async function persistDynamicUniverse(
  universe
) {
  if (
    !supabase
  ) {
    return;
  }

  for (
    let i = 0;
    i <
      universe.length;
    i++
  ) {
    const asset =
      universe[i];

    await dbUpsert(
      'hunter_dynamic_universe',
      {
        symbol:
          asset.symbol,

        asset_type:
          'CRYPTO',

        rank:
          i + 1,

        fetched_at:
          iso(),
      },
      'symbol'
    );
  }
}

function confidenceLabel(
  n
) {
  if (
    n >=
    100
  ) {
    return 'HIGH';
  }

  if (
    n >=
    30
  ) {
    return 'MEDIUM';
  }

  return 'LOW';
}

function rateCI(
  hits,
  total
) {
  if (
    !total
  ) {
    return [
      null,
      null,
    ];
  }

  const p =
    hits /
    total;

  const z =
    1.96;

  const denom =
    1 +
    z *
      z /
      total;

  const centre =
    (
      p +
      z *
        z /
        (
          2 *
          total
        )
    ) /
    denom;

  const margin =
    z *
    Math.sqrt(
      (
        p *
          (
            1 -
            p
          ) +
        z *
          z /
          (
            4 *
            total
          )
      ) /
        total
    ) /
    denom;

  return [
    clamp(
      centre -
        margin,
      0,
      1
    ),

    clamp(
      centre +
        margin,
      0,
      1
    ),
  ];
}

async function refreshPredictiveStatistics() {
  if (
    !supabase
  ) {
    return;
  }

  const start =
    new Date(
      Date.now() -
        7 *
          86400000
    ).toISOString();

  const end =
    nowIso();

  const {
    data,
    error,
  } =
    await supabase
      .from(
        'hunter_observation_history'
      )
      .select(
        'hunter_score,tp1_hit,tp2_hit,stopped_out,gain_pct,max_favourable_excursion,max_adverse_excursion,duration_minutes,is_resolved'
      )
      .eq(
        'asset_type',
        'CRYPTO'
      )
      .gte(
        'calculated_at',
        start
      )
      .lte(
        'calculated_at',
        end
      );

  if (
    error ||
    !data?.length
  ) {
    return;
  }

  const bins = [
    [
      0,
      59,
    ],

    [
      60,
      69,
    ],

    [
      70,
      79,
    ],

    [
      80,
      89,
    ],

    [
      90,
      100,
    ],
  ];

  for (
    const [
      low,
      high,
    ] of bins
  ) {
    const rows =
      data.filter(
        row =>
          num(
            row.hunter_score
          ) >=
            low &&
          num(
            row.hunter_score
          ) <=
            high
      );

    const resolved =
      rows.filter(
        row =>
          row.is_resolved
      );

    const tp1 =
      resolved.filter(
        row =>
          row.tp1_hit ===
          true
      ).length;

    const tp2 =
      resolved.filter(
        row =>
          row.tp2_hit ===
          true
      ).length;

    const stopped =
      resolved.filter(
        row =>
          row.stopped_out ===
          true
      ).length;

    const tp1CI =
      rateCI(
        tp1,
        resolved.length
      );

    const tp2CI =
      rateCI(
        tp2,
        resolved.length
      );

    const gains =
      resolved
        .map(
          row =>
            num(
              row.gain_pct
            )
        )
        .filter(
          Number.isFinite
        );

    const mfe =
      resolved
        .map(
          row =>
            num(
              row.max_favourable_excursion
            )
        )
        .filter(
          Number.isFinite
        );

    const mae =
      resolved
        .map(
          row =>
            num(
              row.max_adverse_excursion
            )
        )
        .filter(
          Number.isFinite
        );

    const duration =
      resolved
        .map(
          row =>
            num(
              row.duration_minutes
            )
        )
        .filter(
          Number.isFinite
        );

    const wins =
      gains.filter(
        value =>
          value >
          0
      );

    const losses =
      gains.filter(
        value =>
          value <
          0
      );

    await dbUpsert(
      'hunter_predictive_statistics',
      {
        period_start:
          start,

        period_end:
          end,

        score_bin_low:
          low,

        score_bin_high:
          high,

        asset_type:
          'CRYPTO',

        alert_count:
          rows.length,

        resolved_count:
          resolved.length,

        confidence_level:
          confidenceLabel(
            resolved.length
          ),

        tp1_rate:
          resolved.length
            ? tp1 /
              resolved.length
            : null,

        tp1_rate_ci_lower:
          tp1CI[0],

        tp1_rate_ci_upper:
          tp1CI[1],

        tp2_rate:
          resolved.length
            ? tp2 /
              resolved.length
            : null,

        tp2_rate_ci_lower:
          tp2CI[0],

        tp2_rate_ci_upper:
          tp2CI[1],

        stop_rate:
          resolved.length
            ? stopped /
              resolved.length
            : null,

        stop_rate_ci_lower:
          null,

        stop_rate_ci_upper:
          null,

        avg_duration_minutes:
          avg(
            duration
          ) ||
          null,

        avg_gain_pct:
          avg(
            gains
          ) ||
          null,

        avg_loss_pct:
          avg(
            losses
          ) ||
          null,

        avg_mfe:
          avg(
            mfe
          ) ||
          null,

        avg_mae:
          avg(
            mae
          ) ||
          null,

        calculated_at:
          nowIso(),

        source_max_timestamp:
          end,

        analytics_version:
          'v2.0.0',

        formula_version:
          'hunter-v13',
      },

      'period_start,score_bin_low,score_bin_high,asset_type'
    );
  }
}

async function labelObservationHistory(
  symbol,
  candles
) {
  if (
    !supabase ||
    !candles?.length
  ) {
    return;
  }

  const cutoff =
    new Date(
      Date.now() -
        24 *
          3600000
    ).toISOString();

  const {
    data,
  } =
    await supabase
      .from(
        'hunter_observation_history'
      )
      .select(
        'id,symbol,calculated_at,hunter_score,is_resolved'
      )
      .eq(
        'symbol',
        symbol
      )
      .eq(
        'asset_type',
        'CRYPTO'
      )
      .eq(
        'is_resolved',
        false
      )
      .lte(
        'calculated_at',
        cutoff
      )
      .limit(
        100
      );

  for (
    const row of
      data ||
      []
  ) {
    const timestamp =
      new Date(
        row.calculated_at
      ).getTime();

    const priceCandle =
      candles.find(
        candle =>
          candle.time >=
          timestamp
      );

    if (
      !priceCandle ||
      priceCandle.close <=
        0
    ) {
      continue;
    }

    const future =
      candles.filter(
        candle =>
          candle.time >=
            timestamp &&
          candle.time <=
            timestamp +
              24 *
                3600000
      );

    if (
      !future.length
    ) {
      continue;
    }

    const entry =
      priceCandle.close;

    const maxPrice =
      Math.max(
        ...future.map(
          candle =>
            candle.high
        )
      );

    const minPrice =
      Math.min(
        ...future.map(
          candle =>
            candle.low
        )
      );

    const gainPct =
      (
        (
          future.at(
            -1
          ).close -
          entry
        ) /
        entry
      ) *
      100;

    const mfePct =
      (
        (
          maxPrice -
          entry
        ) /
        entry
      ) *
      100;

    const maePct =
      (
        (
          minPrice -
          entry
        ) /
        entry
      ) *
      100;

    const tp1Hit =
      maxPrice >=
      entry *
        1.01;

    const tp2Hit =
      maxPrice >=
      entry *
        1.03;

    await dbUpdate(
      'hunter_observation_history',
      {
        id:
          row.id,
      },
      {
        entry_level:
          entry,

        tp1:
          entry *
          1.01,

        tp2:
          entry *
          1.03,

        tp1_hit:
          tp1Hit,

        tp2_hit:
          tp2Hit,

        /*
         * Hunter does not invent a stop level.
         * stopped_out therefore remains null.
         */
        stopped_out:
          null,

        duration_minutes:
          1440,

        gain_pct:
          gainPct,

        max_favourable_excursion:
          mfePct,

        max_adverse_excursion:
          maePct,

        outcome:
          tp2Hit
            ? 'TP2'
            : tp1Hit
              ? 'TP1'
              : gainPct >
                  0
                ? 'POSITIVE'
                : 'NEGATIVE',

        is_resolved:
          true,

        resolved_at:
          nowIso(),

        calculated_at:
          nowIso(),
      }
    );
  }
}      clamp(
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

  const lateCheck =
    isTooLate(f);

  if (lateCheck.tooLate) {
    reasons.push(lateCheck.reason);
  }

  // Low base quality is acceptable when the asset has clearly transitioned
  // into a strong continuation phase. This distinguishes poor early structure
  // from an already-moving asset with exceptional participation.
  if (
    f.baseQuality <
      CONFIG.creamMinBaseQuality &&
    !f.firstPullbackContinuation &&
    (lateCheck.continuation || 0) <
      CONFIG.continuationMinScore
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
) {  const result =
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
    asset_type: 'CRYPTO',
    setup_type: detection.stage,
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
    analytics_version: 'v2.0.0',
    formula_version: 'hunter-v13',
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
      'symbol'
    );
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
    .select('hunter_score,tp1_hit,tp2_hit,stopped_out,gain_pct,max_favourable_excursion,max_adverse_excursion,duration_minutes,is_resolved')
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
        alert_count: rows.length,
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
        formula_version: 'hunter-v13',
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
    const priceCandle = candles.find(c => c.time >= timestamp);
    if (!priceCandle || priceCandle.close <= 0) continue;

    const future = candles.filter(c =>
      c.time >= timestamp &&
      c.time <= timestamp + 24 * 3600000
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

  // Bootstrap OPENs must genuinely clear the bootstrap evidence threshold.
  // Once enough labelled examples exist, historical similarity + contrast
  // become the primary gate instead.
  if (
    learning.mode === 'BOOTSTRAP' &&
    detection.bootstrapScore <
      CONFIG.openBootstrapScore
  ) {
    return {
      eligible: false,
      reasons: ['bootstrap evidence'],
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

      open_price:
        f.currentPrice,

      last_price:
        f.currentPrice,

      last_score:
        detection.creamScore,

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

      last_similarity:
        detection.learning.similarity,

      last_update:
        iso(),
    }
  );

  return {
    move,
    highest: f.currentPrice,
    lowest: f.currentPrice,
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
      position.open_price,
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

      close_price:
        f.currentPrice,


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
    detection.detectionId || null,
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
      detection.detectionId || null,
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

      const detectionRow = await saveDetection(detection);
      detection.detectionId = detectionRow?.id || null;

      const fieldAverage = detections.length
        ? avg(detections.map(d => d.creamScore))
        : null;

      const btcRisk = STATE.btcRisk || { label: 'UNKNOWN' };
      await saveObservationHistory(detection, btcRisk, fieldAverage);

      /*
       * Labeling is done against the same
       * asset's current candle history.
       * This means Hunter continually converts
       * yesterday's observations into training data.
       */
      await labelRecentExamples(detection.symbol, detection.candles);
      await labelObservationHistory(detection.symbol, detection.candles);

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

async function refreshRegimeAndWeeklyStatistics() {
  if (!supabase) return;

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 86400000);
  const startIso = periodStart.toISOString();
  const endIso = periodEnd.toISOString();

  const { data, error } = await supabase
    .from('hunter_observation_history')
    .select('symbol,hunter_score,btc_regime,setup_type,tp1_hit,tp2_hit,gain_pct,max_favourable_excursion,max_adverse_excursion,is_resolved,calculated_at')
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
        alert_count: rows.length,
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
        formula_version: 'hunter-v13',
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
      leader_changes: 0,
      stability_label: top5.length <= 3 ? 'STABLE' : top5.length <= 5 ? 'ROTATING' : 'HIGH_ROTATION',
      market_confidence: Math.round(clamp(resolved.length / 100, 0, 1) * 100),
      new_top5_entries: top5.length,
      dropped_top5: 0,
      new_top10_entries: top10.length,
      dropped_top10: 0,
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
      formula_version: 'hunter-v13',
    },
    'week_start'
  );
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

    // Persist everything — even assets that
    // never come close to an alert threshold.
    // That is the learning engine.
    await persistDetections(detections);
    await updateWatchlist(detections, btcRisk);
    await refreshPredictiveStatistics();
    await refreshRegimeAndWeeklyStatistics();

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
    'HUNTER V13 — CRYPTO EARLY-MOVE LEARNING ENGINE'
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
)
