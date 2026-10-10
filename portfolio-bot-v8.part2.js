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
// instructions and the changelog.

// portfolio-bot-v8.js — PART 2 of 3. See part 1 for concatenation
// instructions and the changelog.

// -----------------------------
// portfolio-bot-v8.js — PART 2 of 3. See part 1 for concatenation
// instructions and the changelog.

// Supabase persistence
// -----------------------------

// ADDED: root-cause fix for the 3.4-hour stuck cycle (cycle 300,
// 2026-10-05). None of the three write helpers below had any request
// timeout — when Supabase/PostgREST is degraded but not outright
// erroring, a single `await` can hang indefinitely waiting for a
// response. With a dbUpdate() call per open position per cycle (10
// positions) and no timeout on any of them, a slow database could stall
// an entire cycle for hours, which is exactly what the logs showed
// ("Previous cycle still running; skipping" x9 in a row). This also
// explains part of the renewed egress/log-ingestion spike — a hung
// cycle isn't retrying in a loop, but the underlying connection sits
// open and contributes to both for as long as it's stuck.
// CONFIG.dbTimeoutMs caps any single write at 15s; worst case (every
// one of 10 positions times out) adds ~150s to a cycle, not hours.
// ADDED: circuit-breaker helpers. dbCircuitOpen() is checked first in
// every write function — a true result means skip the network call
// entirely. dbRecordFailure()/dbRecordSuccess() track the consecutive-
// failure streak and trip/reset the breaker.
function dbCircuitOpen() {
  return Date.now() < STATE.dbCircuitOpenUntil;
}

function dbRecordFailure(table) {
  STATE.dbConsecutiveFailures++;

  if (
    STATE.dbConsecutiveFailures >=
    CONFIG.dbCircuitFailureThreshold &&
    !dbCircuitOpen()
  ) {
    STATE.dbCircuitOpenUntil =
      Date.now() + CONFIG.dbCircuitCooldownMs;

    STATE.dbConsecutiveFailures = 0;

    console.error(
      `[DB] circuit breaker OPEN after repeated failures (last: ${table}) — skipping writes for ${CONFIG.dbCircuitCooldownMs / 1000}s`
    );
  }
}

function dbRecordSuccess() {
  STATE.dbConsecutiveFailures = 0;
}

function dbTimeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function dbInsert(
  table,
  row,
  returning = '*'
) {
  if (!supabase) return null;

  // ADDED: fail instantly while the circuit is open — no network
  // attempt, no 15s wait, no new log line for every skipped call.
  if (dbCircuitOpen()) return null;

  const { signal, clear } =
    dbTimeoutSignal(CONFIG.dbTimeoutMs);

  try {
    const {
      data,
      error,
    } =
      await supabase
        .from(table)
        .insert(row)
        .select(returning)
        .maybeSingle()
        .abortSignal(signal);

    if (error) {
      console.error(
        `[DB] ${table}: ${error.message}`
      );

      dbRecordFailure(table);
      return null;
    }

    dbRecordSuccess();
    return data;
  } catch (error) {
    console.error(
      `[DB] ${table}: ${error.message} (timed out after ${CONFIG.dbTimeoutMs}ms)`
    );

    dbRecordFailure(table);
    return null;
  } finally {
    clear();
  }
}

async function dbUpsert(
  table,
  row,
  onConflict,
  returning = '*'
) {
  if (!supabase) return null;

  if (dbCircuitOpen()) return null;

  const { signal, clear } =
    dbTimeoutSignal(CONFIG.dbTimeoutMs);

  try {
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
        .select(returning)
        .maybeSingle()
        .abortSignal(signal);

    if (error) {
      console.error(
        `[DB] upsert ${table}: ${error.message}`
      );

      dbRecordFailure(table);
      return null;
    }

    dbRecordSuccess();
    return data;
  } catch (error) {
    console.error(
      `[DB] upsert ${table}: ${error.message} (timed out after ${CONFIG.dbTimeoutMs}ms)`
    );

    dbRecordFailure(table);
    return null;
  } finally {
    clear();
  }
}

async function dbUpdate(
  table,
  match,
  row
) {
  if (!supabase) return false;

  if (dbCircuitOpen()) return false;

  const { signal, clear } =
    dbTimeoutSignal(CONFIG.dbTimeoutMs);

  try {
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
      await query.abortSignal(signal);

    if (error) {
      console.error(
        `[DB] update ${table}: ${error.message}`
      );

      dbRecordFailure(table);
      return false;
    }

    dbRecordSuccess();
    return true;
  } catch (error) {
    console.error(
      `[DB] update ${table}: ${error.message} (timed out after ${CONFIG.dbTimeoutMs}ms)`
    );

    dbRecordFailure(table);
    return false;
  } finally {
    clear();
  }
}

async function saveSnapshot(
  asset,
  features,
  bootstrap,
  similarity,
  mode,
  keepFeatures = true
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

      // CHANGED: the full features object is only kept for rows that
      // matter; feature_vector alone carries what learning reads.
      features: keepFeatures ? features : null,

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
    'symbol,timestamp',
    'id'
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
    'symbol,timestamp',
    'id'
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

  // ADDED (Neon free-tier egress): the training pool is 8 queries of up
  // to 800 feature vectors each. Re-reading it every 15-minute cycle
  // cost roughly 3 MB per cycle for a pool that changes slowly against a
  // 120h window. Reuse it for CONFIG.learningModelRefreshMs; refresh
  // sooner if the last load came back empty (e.g. a database blip).
  const cached = STATE.learningModelCache;
  if (cached) {
    const age = Date.now() - cached.at;
    const hadData =
      cached.model.counts.negative > 0 ||
      [10, 50, 100, 150].some(t => cached.model.counts[t] > 0);
    const maxAge = hadData
      ? CONFIG.learningModelRefreshMs
      : 15 * 60 * 1000;
    if (age < maxAge) return cached.model;
  }

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
  STATE.learningModelCache = { at: Date.now(), model: empty };
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
    // CHANGED (Neon free-tier egress): this used to pull up to 150 rows
    // per symbol per cycle (~23,000 rows every 15 minutes) even when
    // nothing in them could be resolved yet. Now only rows whose age has
    // reached a horizon that is still unlabelled come back — a handful
    // per symbol. The labelling logic below is unchanged.
    .whereRaw(
      '("timestamp" <= ? AND outcome_10 IS NULL) OR ' +
      '("timestamp" <= ? AND outcome_50 IS NULL) OR ' +
      '("timestamp" <= ? AND outcome_100 IS NULL) OR ' +
      '("timestamp" <= ? AND outcome_150 IS NULL)',
      [
        iso(Date.now() - CONFIG.horizons[10] * 3600000),
        iso(Date.now() - CONFIG.horizons[50] * 3600000),
        iso(Date.now() - CONFIG.horizons[100] * 3600000),
        iso(Date.now() - CONFIG.horizons[150] * 3600000),
      ]
    )
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
