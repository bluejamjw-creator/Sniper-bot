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
    confidenceMinimum:      70,
    convictionMinimum:      65,
    executionHardFloor:     60,
    edgeMinimumOverField:   12,
    competitionGap:         5,
  },
  CYCLE_MS:             90_000,
  MAX_ALERTS_PER_DAY:   6,
  ALERT_COOLDOWN_MS:    10_800_000, // 3 hours
  DYNAMIC_MOVE_PCT:     4.0,
  DYNAMIC_VOL_MULT:     2.0,
  DYNAMIC_EXPIRY_MS:    14_400_000, // 4 hours
  NO_TRADE_EVERY_N:     30,
  CANDLE_LIMIT:         100,
  MIN_DOLLAR_VOLUME:    500_000,
};

// ============================================================
// SECTION 2: ASSET UNIVERSE
// ============================================================

const CORE_CRYPTO = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  'ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT',
  'NEARUSDT','ATOMUSDT','APTUSDT','ARBUSDT','OPUSDT',
  'INJUSDT','SUIUSDT','SEIUSDT','TIAUSDT','ONDOUSDT',
  'WLDUSDT','FETUSDT','RENDERUSDT','JUPUSDT',
];

const CORE_US_STOCKS = [
  'NVDA','AMD','TSLA','AAPL','MSFT','GOOGL','AMZN','META',
  'PLTR','COIN','MSTR','APP','IONQ','RGTI','QUBT','CRWD',
  'SMCI','ARM','ASML','TSM','AVGO','QCOM','MU','INTC',
  'HOOD','RKLB','LUNR','DJT','SOUN','BBAI','ACHR','JOBY',
];

const CORE_LSE_STOCKS = [
  'ANTO.L','AZN.L','BP.L','HSBA.L','LLOY.L','RIO.L',
  'SHEL.L','ULVR.L','VOD.L','BT-A.L','GSK.L','REL.L',
  'BATS.L','DGE.L','EXPN.L','III.L','IMB.L','JET.L',
  'LGEN.L','MNG.L','PRU.L',
];

// ============================================================
// SECTION 3: ENVIRONMENT & CLIENTS
// ============================================================

const ENV = {
  BOT_TOKEN:              process.env.BOT_TOKEN,
  BLUEJAM_CHAT_ID:        process.env.BLUEJAM_CHAT_ID,
  CHANNEL_CHAT_ID:        process.env.CHANNEL_CHAT_ID,
  ALPACA_API_KEY:         process.env.ALPACA_API_KEY,
  ALPACA_SECRET_KEY:      process.env.ALPACA_SECRET_KEY,
  FINNHUB_API_KEY:        process.env.FINNHUB_API_KEY,
  SUPABASE_URL:           process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY:   process.env.SUPABASE_SERVICE_ROLE_KEY,
  HUNTER_LIVE:            process.env.HUNTER_LIVE === 'true',
};

let supabase = null;
if (ENV.SUPABASE_URL && ENV.SUPABASE_SERVICE_KEY) {
  supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_KEY);
}

// ============================================================
// SECTION 4: STATE
// ============================================================

const STATE = {
  cycleCount:        0,
  alertsToday:       0,
  alertDateKey:      '',
  lastAlertTime:     0,
  dynamicAssets:     new Map(), // symbol -> { addedAt, expires }
  hunterSlots:       new Map(), // symbol -> { score, addedAt }
  candidateHistory:  [],        // last N scored candidates
  fieldAverage:      0,
  fieldBest:         null,
  fieldSecondBest:   null,
  btcRegime:         'NEUTRAL',
  qqqRegime:         'NEUTRAL',
  cryptoBreadth:     50,
  lastScan:          null,
};

// ============================================================
// SECTION 5: HTTP UTILITIES
// ============================================================

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
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
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// ============================================================
// SECTION 6: DATA FETCHERS — CRYPTO (Binance primary)
// ============================================================

async function fetchBinanceCandles(symbol, interval = '15m', limit = 100) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const raw = await httpGet(url);
    if (!Array.isArray(raw)) return null;
    return raw.map((c) => ({
      time:   c[0],
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  } catch {
    return null;
  }
}

async function fetchBybitCandles(symbol, interval = '15', limit = 100) {
  try {
    const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const data = await httpGet(url);
    if (data?.result?.list) {
      return data.result.list.reverse().map((c) => ({
        time:   parseInt(c[0]),
        open:   parseFloat(c[1]),
        high:   parseFloat(c[2]),
        low:    parseFloat(c[3]),
        close:  parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchCryptoCandles(symbol) {
  let candles = await fetchBinanceCandles(symbol);
  if (!candles || candles.length < 20) {
    candles = await fetchBybitCandles(symbol);
  }
  return candles;
}

// ============================================================
// SECTION 7: DATA FETCHERS — US STOCKS (Alpaca primary)
// ============================================================

async function fetchAlpacaBars(symbol, timeframe = '15Min', limit = 100) {
  try {
    if (!ENV.ALPACA_API_KEY) return null;
    const end = new Date().toISOString();
    const start = new Date(Date.now() - 86400000 * 5).toISOString();
    const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=${timeframe}&start=${start}&end=${end}&limit=${limit}&feed=sip&sort=asc`;
    const data = await httpGet(url, {
      'APCA-API-KEY-ID':     ENV.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': ENV.ALPACA_SECRET_KEY,
    });
    if (!data?.bars?.length) return null;
    return data.bars.map((b) => ({
      time:   new Date(b.t).getTime(),
      open:   b.o,
      high:   b.h,
      low:    b.l,
      close:  b.c,
      volume: b.v,
    }));
  } catch {
    return null;
  }
}

async function fetchYahooCandles(symbol, interval = '15m') {
  try {
    const range = '5d';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    const data = await httpGet(url);
    const result = data?.chart?.result?.[0];
    if (!result) return null;
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
  } catch {
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
    const candles = await fetchBinanceCandles('BTCUSDT', '1h', 50);
    if (!candles || candles.length < 20) return 'NEUTRAL';
    const closes = candles.map((c) => c.close);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    const last = closes[closes.length - 1];
    const e20 = ema20[ema20.length - 1];
    const e50 = ema50[ema50.length - 1];
    if (last > e20 && e20 > e50) return 'BULL';
    if (last < e20 && e20 < e50) return 'BEAR';
    return 'NEUTRAL';
  } catch {
    return 'NEUTRAL';
  }
}

async function fetchQQQRegime() {
  try {
    const candles = await fetchYahooCandles('QQQ', '1h');
    if (!candles || candles.length < 20) return 'NEUTRAL';
    const closes = candles.map((c) => c.close);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    const last = closes[closes.length - 1];
    const e20 = ema20[ema20.length - 1];
    const e50 = ema50[ema50.length - 1];
    if (last > e20 && e20 > e50) return 'BULL';
    if (last < e20 && e20 < e50) return 'BEAR';
    return 'NEUTRAL';
  } catch {
    return 'NEUTRAL';
  }
}

async function fetchCryptoBreadth() {
  const spot = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
                 'ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT'];
  let bullCount = 0;
  for (const sym of spot) {
    try {
      const c = await fetchBinanceCandles(sym, '1h', 30);
      if (!c || c.length < 20) continue;
      const closes = c.map((x) => x.close);
      const ema20 = calcEMA(closes, 20);
      if (closes[closes.length - 1] > ema20[ema20.length - 1]) bullCount++;
    } catch { /* skip */ }
    await sleep(100);
  }
  return Math.round((bullCount / spot.length) * 100);
}

async function fetchFinnhubMovers() {
  try {
    if (!ENV.FINNHUB_API_KEY) return [];
    const url = `https://finnhub.io/api/v1/stock/market-status?exchange=US&token=${ENV.FINNHUB_API_KEY}`;
    await httpGet(url); // connectivity check
    const moversUrl = `https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${ENV.FINNHUB_API_KEY}`;
    // Use news endpoint as proxy for movers
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

  // BTC regime
  if (STATE.btcRegime === 'BULL') {
    score += assetType === 'crypto' ? 20 : 5;
    reasons.push('BTC in bull structure');
  } else if (STATE.btcRegime === 'BEAR') {
    score -= assetType === 'crypto' ? 20 : 5;
    reasons.push('BTC in bear structure');
  }

  // QQQ regime
  if (STATE.qqqRegime === 'BULL') {
    score += assetType === 'stock' ? 20 : 5;
    reasons.push('QQQ in bull structure');
  } else if (STATE.qqqRegime === 'BEAR') {
    score -= assetType === 'stock' ? 20 : 5;
    reasons.push('QQQ in bear structure');
  }

  // Crypto breadth
  if (assetType === 'crypto') {
    if (STATE.cryptoBreadth >= 70) { score += 15; reasons.push('Broad crypto strength'); }
    else if (STATE.cryptoBreadth <= 30) { score -= 15; reasons.push('Crypto breadth weak'); }
  }

  // Session timing (UTC)
  const hour = new Date().getUTCHours();
  if (assetType === 'stock') {
    // US session: 13:30-20:00 UTC, LSE: 08:00-16:30 UTC
    if ((hour >= 13 && hour < 20) || (hour >= 8 && hour < 16)) {
      score += 10; reasons.push('Active session');
    } else {
      score -= 20; reasons.push('Outside liquid hours');
    }
  } else {
    // Crypto: London open overlap 07-09 UTC, NY open 13-15 UTC
    if ((hour >= 7 && hour <= 9) || (hour >= 13 && hour <= 15)) {
      score += 10; reasons.push('High-activity crypto window');
    }
  }

  return { score: clamp(score), reasons };
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

  // EMA alignment
  if (last > e20 && e20 > e50) {
    score_parts.push(85);
    reasons.push('Price > EMA20 > EMA50 (bullish stack)');
  } else if (last > e20 && e20 < e50) {
    score_parts.push(60);
    reasons.push('Price above EMA20, mixed stack');
  } else if (last < e20 && e20 < e50) {
    score_parts.push(20);
    reasons.push('Bearish EMA stack');
  } else {
    score_parts.push(45);
    reasons.push('Mixed EMA structure');
  }

  // VWAP position
  if (last > vwapLast) {
    score_parts.push(75);
    reasons.push('Trading above VWAP');
  } else {
    score_parts.push(35);
    reasons.push('Trading below VWAP');
  }

  // Bollinger compression (coiling)
  const bbLast = bb[bb.length - 1];
  if (bbLast.width !== null) {
    const avgWidth = bb.slice(-20).filter((b) => b.width).reduce((s, b) => s + b.width, 0) / 20;
    if (bbLast.width < avgWidth * 0.7) {
      score_parts.push(80);
      reasons.push('BB compression — coiling for move');
    } else if (bbLast.width > avgWidth * 1.5) {
      score_parts.push(40);
      reasons.push('BB expanded — volatile');
    } else {
      score_parts.push(60);
    }
  }

  // Higher lows pattern (last 5 candles)
  const recentLows = candles.slice(-6).map((c) => c.low);
  let higherLows = 0;
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i] > recentLows[i - 1]) higherLows++;
  }
  if (higherLows >= 4) { score_parts.push(85); reasons.push('Strong higher lows pattern'); }
  else if (higherLows >= 2) { score_parts.push(65); }
  else { score_parts.push(35); }

  // Resistance proximity
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

  const lastVol    = volumes[volumes.length - 1];
  const smaVol     = volSMA[volSMA.length - 1];
  const prevVol    = volumes[volumes.length - 2];

  // Relative volume
  const relVol = smaVol > 0 ? lastVol / smaVol : 1;
  if (relVol >= 3) { score_parts.push(95); reasons.push(`Relative volume ${round2(relVol)}x — exceptional`); }
  else if (relVol >= 2) { score_parts.push(80); reasons.push(`Relative volume ${round2(relVol)}x — strong`); }
  else if (relVol >= 1.5) { score_parts.push(65); reasons.push(`Relative volume ${round2(relVol)}x`); }
  else if (relVol >= 1) { score_parts.push(50); }
  else { score_parts.push(25); reasons.push('Below-average volume'); }

  // Volume acceleration
  const volAccel = prevVol > 0 ? lastVol / prevVol : 1;
  if (volAccel >= 2) { score_parts.push(85); reasons.push('Volume accelerating'); }
  else if (volAccel >= 1.3) { score_parts.push(65); }
  else { score_parts.push(45); }

  // Dollar volume
  const dollarVol = lastVol * closes[closes.length - 1];
  if (dollarVol >= CONFIG.MIN_DOLLAR_VOLUME * 10) { score_parts.push(90); reasons.push('Very high dollar volume'); }
  else if (dollarVol >= CONFIG.MIN_DOLLAR_VOLUME) { score_parts.push(65); }
  else { score_parts.push(20); reasons.push('Low dollar volume — liquidity risk'); }

  // Buying persistence (bullish candles on volume)
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

  // Velocity (rate of change 5 candles)
  const roc5 = ((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100;
  if (roc5 >= 3) { score_parts.push(90); reasons.push(`Strong momentum +${round2(roc5)}%`); }
  else if (roc5 >= 1.5) { score_parts.push(70); reasons.push(`Positive momentum +${round2(roc5)}%`); }
  else if (roc5 >= 0) { score_parts.push(50); }
  else { score_parts.push(20); reasons.push(`Negative momentum ${round2(roc5)}%`); }

  // Acceleration (roc this period vs previous period)
  const roc5prev = closes.length >= 11
    ? ((closes[closes.length - 6] - closes[closes.length - 11]) / closes[closes.length - 11]) * 100
    : roc5;
  if (roc5 > roc5prev + 0.5) { score_parts.push(80); reasons.push('Momentum accelerating'); }
  else if (roc5 > roc5prev) { score_parts.push(60); }
  else { score_parts.push(40); reasons.push('Momentum decelerating'); }

  // RSI
  const rsiLast = rsi[rsi.length - 1];
  if (rsiLast >= 55 && rsiLast <= 75) { score_parts.push(80); reasons.push(`RSI ${round2(rsiLast)} — bullish zone`); }
  else if (rsiLast > 75) { score_parts.push(45); reasons.push(`RSI ${round2(rsiLast)} — overbought`); }
  else if (rsiLast >= 45) { score_parts.push(55); }
  else { score_parts.push(25); reasons.push(`RSI ${round2(rsiLast)} — weak`); }

  // MACD
  const hist = macd.histogram;
  const lastHist = hist[hist.length - 1];
  const prevHist = hist[hist.length - 2];
  if (lastHist > 0 && lastHist > prevHist) { score_parts.push(80); reasons.push('MACD histogram rising'); }
  else if (lastHist > 0) { score_parts.push(60); }
  else { score_parts.push(30); reasons.push('MACD below zero'); }

  // Consecutive bullish candles
  let consec = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) consec++;
    else break;
  }
  if (consec >= 4) { score_parts.push(85); reasons.push(`${consec} consecutive green candles`); }
  else if (consec >= 2) { score_parts.push(65); }
  else { score_parts.push(40); }

  // Move maturity (has it come too far?)
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
  let stageScore = 50;

  if (rsiLast < 40 && last < e50) {
    stage = 'SLEEPING'; stageScore = 20;
  } else if (compressed && relVol < 1.2 && Math.abs(roc3) < 1) {
    stage = 'LOADING'; stageScore = 65;
  } else if (compressed && relVol >= 1.2 && last > e20) {
    stage = 'READY'; stageScore = 80;
  } else if (roc3 > 2 && relVol >= 1.5 && last > e20) {
    stage = 'BREAKING'; stageScore = 90;
  } else if (roc3 > 1 && relVol >= 1.2 && last > e20 && e20 > e50) {
    stage = 'RUNNING'; stageScore = 75;
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

  // EMA extension (how far above EMA20)
  const pctAboveEMA = ((last - e20) / e20) * 100;
  if (pctAboveEMA >= 0 && pctAboveEMA <= 1.5) {
    score_parts.push(90);
    reasons.push('Tight to EMA20 — ideal entry zone');
  } else if (pctAboveEMA > 1.5 && pctAboveEMA <= 3) {
    score_parts.push(65);
    reasons.push('Slightly extended from EMA20');
  } else if (pctAboveEMA > 3) {
    score_parts.push(30);
    reasons.push(`Extended ${round2(pctAboveEMA)}% from EMA20 — risky entry`);
  } else {
    score_parts.push(40);
    reasons.push('Below EMA20 — structure weak');
  }

  // VWAP proximity
  const pctAboveVWAP = ((last - vwapLast) / vwapLast) * 100;
  if (pctAboveVWAP >= 0 && pctAboveVWAP <= 1.5) {
    score_parts.push(85);
    reasons.push('Close to VWAP — good R:R anchor');
  } else if (pctAboveVWAP > 1.5 && pctAboveVWAP <= 3) {
    score_parts.push(60);
  } else if (pctAboveVWAP > 3) {
    score_parts.push(25);
    reasons.push(`${round2(pctAboveVWAP)}% above VWAP — stretched`);
  } else {
    score_parts.push(50);
  }

  // R:R assessment (using ATR)
  const stopDistance = atrLast * 1.5;
  const stopPrice    = last - stopDistance;
  const t1Price      = last + atrLast * 2;
  const t2Price      = last + atrLast * 4;
  const rrRatio      = stopDistance > 0 ? (t1Price - last) / stopDistance : 0;

  if (rrRatio >= 2.5) {
    score_parts.push(90);
    reasons.push(`R:R ${round2(rrRatio)}:1 — excellent`);
  } else if (rrRatio >= 1.8) {
    score_parts.push(70);
    reasons.push(`R:R ${round2(rrRatio)}:1 — acceptable`);
  } else if (rrRatio >= 1.3) {
    score_parts.push(45);
    reasons.push(`R:R ${round2(rrRatio)}:1 — marginal`);
  } else {
    score_parts.push(15);
    reasons.push(`R:R ${round2(rrRatio)}:1 — poor`);
  }

  // Candle quality (close near high, small wick)
  const candleRange = lastCandle.high - lastCandle.low;
  const closePosition = candleRange > 0 ? (lastCandle.close - lastCandle.low) / candleRange : 0.5;
  const upperWick = candleRange > 0 ? (lastCandle.high - lastCandle.close) / candleRange : 0;

  if (closePosition >= 0.7 && upperWick <= 0.2) {
    score_parts.push(85);
    reasons.push('Strong bullish candle close');
  } else if (closePosition >= 0.5) {
    score_parts.push(60);
  } else {
    score_parts.push(25);
    reasons.push('Weak candle close — selling pressure visible');
  }

  const score = clamp(score_parts.reduce((a, b) => a + b, 0) / score_parts.length);
  return {
    score, reasons, stopPrice, t1Price, t2Price, rrRatio,
    stopDistance, entry: last,
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

  // Liquidity
  const avgDollarVol = volumes.slice(-20).reduce((s, v, i) => {
    return s + v * closes[closes.length - 20 + i];
  }, 0) / 20;

  if (avgDollarVol >= CONFIG.MIN_DOLLAR_VOLUME * 5) {
    score_parts.push(90);
    reasons.push('High liquidity');
  } else if (avgDollarVol >= CONFIG.MIN_DOLLAR_VOLUME) {
    score_parts.push(65);
  } else {
    score_parts.push(20);
    reasons.push('Low liquidity — execution risk');
  }

  // Spread proxy (high-low vs close)
  const spreadProxy = ((candles[candles.length - 1].high - candles[candles.length - 1].low) / last) * 100;
  if (spreadProxy <= 0.3) { score_parts.push(90); }
  else if (spreadProxy <= 0.8) { score_parts.push(65); }
  else { score_parts.push(30); reasons.push('Wide spread — slippage risk'); }

  // Volatility (ATR %)
  if (atrPct <= 1.5) { score_parts.push(80); reasons.push('Low ATR — controlled volatility'); }
  else if (atrPct <= 3) { score_parts.push(60); }
  else if (atrPct <= 5) { score_parts.push(40); }
  else { score_parts.push(15); reasons.push(`High ATR ${round2(atrPct)}% — elevated risk`); }

  // Recent drawdown risk
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
  // Simulate adverse scenarios — does the setup survive?
  const reasons = [];
  let stabilityScore = 100;

  // Scenario 1: Price drops 2%
  const priceStressCandles = candles.map((c, i) => {
    if (i < candles.length - 3) return c;
    return { ...c, close: c.close * 0.98, low: Math.min(c.low, c.close * 0.98) };
  });
  const stressedExec = scoreExecutionQuality(priceStressCandles);
  if (stressedExec.score < CONFIG.THRESHOLDS.executionHardFloor) {
    stabilityScore -= 30;
    reasons.push('Fails 2% price stress test');
  }

  // Scenario 2: Volume drops 50%
  const volStressCandles = candles.map((c, i) => {
    if (i < candles.length - 3) return c;
    return { ...c, volume: c.volume * 0.5 };
  });
  const stressedPart = scoreParticipation(volStressCandles);
  if (stressedPart.score < 40) {
    stabilityScore -= 20;
    reasons.push('Participation collapses under volume stress');
  }

  // Scenario 3: BTC weakening impact
  if (STATE.btcRegime === 'BULL') {
    // Simulate neutral BTC
    const origBTC = STATE.btcRegime;
    STATE.btcRegime = 'NEUTRAL';
    const stressedCtx = scoreMarketContext('crypto');
    STATE.btcRegime = origBTC;
    if (stressedCtx.score < 40) {
      stabilityScore -= 15;
      reasons.push('Setup depends heavily on BTC strength');
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
    score = 90;
    reasons.push(`Ranked #1, beats #2 by ${round2(gap)} pts`);
  } else if (rank === 1) {
    score = 60;
    reasons.push(`Ranked #1 but gap to #2 only ${round2(gap)} pts`);
  } else if (rank <= 3) {
    score = 45;
    reasons.push(`Ranked #${rank} — not clear best`);
  } else {
    score = 20;
    reasons.push(`Ranked #${rank} — better setups exist`);
  }

  return { score: clamp(score), gap, rank, reasons };
}

// ============================================================
// SECTION 20: ENGINE 11 — CONFIDENCE
// ============================================================

function scoreConfidence(allScores) {
  const scores = Object.values(allScores).filter((v) => typeof v === 'number');
  const mean   = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length;
  const stdDev = Math.sqrt(variance);

  // High confidence = high mean + low variance (aligned signals)
  const alignmentScore = clamp(mean - stdDev * 0.5);
  const reasons = [];

  if (stdDev < 10) reasons.push('Signals highly aligned');
  else if (stdDev < 20) reasons.push('Good signal alignment');
  else reasons.push('Mixed signals — confidence reduced');

  return { score: clamp(alignmentScore), stdDev, reasons };
}

// ============================================================
// SECTION 21: ENGINE 12 — CONVICTION
// ============================================================

function scoreConviction(allScores, stage, stability) {
  let conviction = 50;
  const reasons = [];

  // Hard gates
  if (allScores.executionQuality < CONFIG.THRESHOLDS.executionHardFloor) {
    return { score: 10, reasons: ['HARD GATE: Execution quality below floor'] };
  }
  if (stage === 'SLEEPING' || stage === 'FAILURE' || stage === 'EXHAUSTION') {
    return { score: 10, reasons: [`HARD GATE: Stage is ${stage}`] };
  }
  if (stability < 50) {
    return { score: 15, reasons: ['HARD GATE: Setup unstable under stress'] };
  }

  // Build conviction
  if (allScores.structure >= 75) { conviction += 10; reasons.push('Strong structure'); }
  if (allScores.participation >= 70) { conviction += 10; reasons.push('Solid participation'); }
  if (allScores.momentum >= 70) { conviction += 10; reasons.push('Clear momentum'); }
  if (allScores.marketContext >= 65) { conviction += 8; reasons.push('Supportive context'); }
  if (allScores.executionQuality >= 75) { conviction += 15; reasons.push('High-quality execution entry'); }

  // Deductions
  if (allScores.risk < 50) { conviction -= 15; reasons.push('Risk profile weak'); }
  if (allScores.marketContext < 40) { conviction -= 10; reasons.push('Context unfavorable'); }

  // Final test: "Would I still be happy with this decision if it loses tomorrow?"
  const passesFinalTest = (
    allScores.executionQuality >= 65 &&
    allScores.structure >= 60 &&
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

    // Run all 12 engines
    const marketCtx  = scoreMarketContext(assetType);
    const structure  = scoreStructure(candles);
    const part       = scoreParticipation(candles);
    const momentum   = scoreMomentum(candles);
    const stageInfo  = classifyStage(candles);
    const execution  = scoreExecutionQuality(candles);
    const risk       = scoreRisk(candles, assetType);

    const rawScores = {
      marketContext:    marketCtx.score,
      structure:        structure.score,
      participation:    part.score,
      momentum:         momentum.score,
      stage:            stageInfo.score,
      executionQuality: execution.score,
      risk:             risk.score,
    };

    // Weighted composite (without edge/competition — those need field context)
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

    // Stability
    const stability = scoreDecisionStability(candles, rawScores);

    // Confidence (signal alignment)
    const confidence = scoreConfidence(rawScores);

    // Conviction
    const conviction = scoreConviction(rawScores, stageInfo.stage, stability.score);

    return {
      symbol,
      assetType,
      preEdgeScore,
      rawScores,
      stageInfo,
      execution,
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

  // Refresh market context
  [STATE.btcRegime, STATE.qqqRegime, STATE.cryptoBreadth] = await Promise.all([
    fetchBTCRegime(),
    fetchQQQRegime(),
    fetchCryptoBreadth(),
  ]);
  log(`Market: BTC=${STATE.btcRegime} QQQ=${STATE.qqqRegime} Breadth=${STATE.cryptoBreadth}%`);

  // Build universe
  const universe = [
    ...CORE_CRYPTO.map((s) => ({ symbol: s, type: 'crypto' })),
    ...CORE_US_STOCKS.map((s) => ({ symbol: s, type: 'us' })),
    ...CORE_LSE_STOCKS.map((s) => ({ symbol: s, type: 'lse' })),
    ...[...STATE.dynamicAssets.entries()]
      .filter(([, v]) => Date.now() < v.expires)
      .map(([s, v]) => ({ symbol: s, type: v.type })),
    ...[...STATE.hunterSlots.entries()]
      .map(([s, v]) => ({ symbol: s, type: v.type })),
  ];

  const totalAssets = universe.length;
  const results = [];
  let rejected = 0;

  // Score all assets (throttled)
  for (const asset of universe) {
    const result = await scoreAsset(asset.symbol, asset.type);
    results.push(result);
    await sleep(150); // rate limit courtesy
  }

  // Update field average from pre-edge scores
  const validScores = results.filter((r) => r.preEdgeScore > 0).map((r) => r.preEdgeScore);
  STATE.fieldAverage = validScores.length
    ? validScores.reduce((a, b) => a + b, 0) / validScores.length
    : 50;

  // Now apply edge + competition scoring to compute final hunterScore
  const scored = results
    .filter((r) => r.preEdgeScore > 0)
    .map((r) => {
      const edgeResult = scoreEdge(r.preEdgeScore);
      // Final hunter score = pre-edge score adjusted by edge component
      const hunterScore = clamp(
        r.preEdgeScore * (1 - CONFIG.WEIGHTS.edge) +
        edgeResult.score * CONFIG.WEIGHTS.edge
      );
      return { ...r, edgeResult, hunterScore };
    })
    .sort((a, b) => b.hunterScore - a.hunterScore);

  // Update candidate history for competition engine
  STATE.candidateHistory = scored.map((s) => ({ symbol: s.symbol, hunterScore: s.hunterScore }));
  if (scored.length > 0) STATE.fieldBest = scored[0];
  if (scored.length > 1) STATE.fieldSecondBest = scored[1];

  // Apply competition scoring to top candidates
  const withCompetition = scored.map((r) => {
    const comp = scoreCompetition(r.symbol, r.hunterScore);
    // Slight competition adjustment to final score
    const finalScore = clamp(r.hunterScore * 0.9 + comp.score * 0.1);
    return { ...r, comp, finalScore };
  });

  // Apply decision logic
  const finalCandidates = withCompetition.map((r) => {
    let decision = 'REJECT';
    const rejectReasons = [];

    // Gate 1: Hard execution floor
    if (r.rawScores?.executionQuality < CONFIG.THRESHOLDS.executionHardFloor) {
      rejectReasons.push(`Execution quality ${round2(r.rawScores.executionQuality)} below hard floor`);
    }
    // Gate 2: Confidence minimum
    else if (r.confidence?.score < CONFIG.THRESHOLDS.confidenceMinimum) {
      rejectReasons.push(`Confidence ${round2(r.confidence.score)} below minimum`);
    }
    // Gate 3: Conviction minimum
    else if (r.conviction?.score < CONFIG.THRESHOLDS.convictionMinimum) {
      rejectReasons.push(`Conviction ${round2(r.conviction.score)} below minimum`);
    }
    // Gate 4: Edge minimum
    else if (r.edgeResult?.edge < CONFIG.THRESHOLDS.edgeMinimumOverField) {
      rejectReasons.push(`Edge ${round2(r.edgeResult.edge)} below minimum over field`);
    }
    // Gate 5: Competition (must beat #2 by 5+ pts)
    else if (r.comp?.rank !== 1 || r.comp?.gap < CONFIG.THRESHOLDS.competitionGap) {
      rejectReasons.push(`Not clear field leader (rank ${r.comp?.rank}, gap ${round2(r.comp?.gap || 0)})`);
    }
    // Gate 6: Final conviction test
    else if (!r.conviction?.passesFinalTest) {
      rejectReasons.push('Fails final conviction test');
    }
    // PASS
    else {
      if (r.finalScore >= CONFIG.THRESHOLDS.hunterScoreElite) decision = 'BUY';
      else if (r.finalScore >= CONFIG.THRESHOLDS.hunterScoreGood) decision = 'BUY';
      else if (r.finalScore >= 65) decision = 'WATCH';
      else decision = 'WAIT';
    }

    if (rejectReasons.length > 0) {
      decision = 'REJECT';
      rejected++;
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
  return STATE.lastScan;
}

// ============================================================
// SECTION 24: DYNAMIC ASSET INJECTION
// ============================================================

async function injectDynamicAssets() {
  try {
    if (!ENV.FINNHUB_API_KEY) return;

    // Check US movers via Finnhub
    const url = `https://finnhub.io/api/v1/stock/market-status?exchange=US&token=${ENV.FINNHUB_API_KEY}`;
    const status = await httpGet(url);
    if (!status?.isOpen) return; // Only inject during market hours

    // Simple crypto dynamic injection via Binance 24hr stats
    const cryptoStats = await httpGet('https://api.binance.com/api/v3/ticker/24hr');
    if (Array.isArray(cryptoStats)) {
      const movers = cryptoStats
        .filter((t) => t.symbol.endsWith('USDT'))
        .filter((t) => parseFloat(t.priceChangePercent) >= CONFIG.DYNAMIC_MOVE_PCT)
        .filter((t) => parseFloat(t.quoteVolume) >= CONFIG.MIN_DOLLAR_VOLUME)
        .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
        .slice(0, 5);

      for (const mover of movers) {
        if (!CORE_CRYPTO.includes(mover.symbol) && !STATE.dynamicAssets.has(mover.symbol)) {
          STATE.dynamicAssets.set(mover.symbol, {
            addedAt: Date.now(),
            expires: Date.now() + CONFIG.DYNAMIC_EXPIRY_MS,
            type: 'crypto',
            pctChange: parseFloat(mover.priceChangePercent),
          });
          log(`🔥 Dynamic inject: ${mover.symbol} (+${round2(parseFloat(mover.priceChangePercent))}%)`);
        }
      }
    }

    // Purge expired dynamic assets
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
  const { symbol, assetType, finalScore, rawScores, stageInfo, execution, confidence, conviction, edgeResult, comp, reasons, rejectReasons } = candidate;

  const tier = finalScore >= CONFIG.THRESHOLDS.hunterScoreElite ? '🎯 ELITE' : '🔥 STRONG';
  const entry = round2(execution.entry);
  const stop  = round2(execution.stopPrice);
  const t1    = round2(execution.t1Price);
  const t2    = round2(execution.t2Price);
  const rr    = round2(execution.rrRatio);

  // Collect key positive reasons
  const positives = [
    ...(reasons.structure || []),
    ...(reasons.participation || []),
    ...(reasons.momentum || []),
    ...(reasons.execution || []),
    ...(reasons.conviction || []),
  ].filter((r) => !r.toLowerCase().includes('fail') && !r.toLowerCase().includes('risk')).slice(0, 5);

  // Key rejection reasons considered
  const rejectionsConsidered = [
    ...(reasons.risk || []),
    ...(reasons.stability || []),
  ].slice(0, 3);

  const msg = [
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `${tier} SIGNAL — THE HUNTER`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `We analysed <b>${scan.totalAssets} assets</b>. <b>${scan.rejected} rejected</b>. This is the one worth hunting.`,
    ``,
    `<b>${symbol}</b> | ${assetType.toUpperCase()} | Stage: ${stageInfo.stage}`,
    ``,
    `📊 <b>SCORES</b>`,
    `Hunter Score: <b>${round2(finalScore)}</b>`,
    `Confidence: <b>${round2(confidence.score)}</b>  |  Conviction: <b>${round2(conviction.score)}</b>`,
    `Edge over field: <b>+${round2(edgeResult.edge)}</b> pts  |  Field rank: <b>#${comp.rank}</b>`,
    ``,
    `📐 <b>EXECUTION</b>`,
    `Entry: <b>${entry}</b>`,
    `Stop: <b>${stop}</b>  |  R:R: <b>${rr}:1</b>`,
    `T1: <b>${t1}</b>  |  T2: <b>${t2}</b>`,
    ``,
    `✅ <b>WHY THIS SETUP</b>`,
    positives.map((r) => `• ${r}`).join('\n'),
    ``,
    `⚠️ <b>CONSIDERED FOR REJECTION</b>`,
    rejectionsConsidered.length > 0
      ? rejectionsConsidered.map((r) => `• ${r}`).join('\n')
      : `• No material rejection factors — clean setup`,
    ``,
    `Component scores: Str:${round2(rawScores.structure)} | Part:${round2(rawScores.participation)} | Mom:${round2(rawScores.momentum)} | Exec:${round2(rawScores.executionQuality)} | Risk:${round2(rawScores.risk)}`,
    ``,
    `<i>BareTradeSignals • The Hunter Engine</i>`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
  ].join('\n');

  return msg;
}

function buildNoTradeMessage(scan) {
  const totalScanned = scan?.totalAssets || '—';
  const cycles = STATE.cycleCount;
  return [
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🕵️ THE HUNTER — NO TRADE`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `The Hunter analysed <b>${totalScanned} assets</b> across ${cycles} cycles.`,
    ``,
    `<b>Nothing offers sufficient edge.</b>`,
    ``,
    `Every candidate was measured across 12 engines. None cleared all gates. The field average sits at <b>${round2(STATE.fieldAverage)}</b> — below the conviction threshold.`,
    ``,
    `No trade is better than a bad trade.`,
    ``,
    `<i>Next scan in 90 seconds. Watching.</i>`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
  ].join('\n');
}

// ============================================================
// SECTION 26: ALERT MANAGER
// ============================================================

function checkAlertCooldown() {
  const today = new Date().toISOString().split('T')[0];
  if (STATE.alertDateKey !== today) {
    STATE.alertDateKey = today;
    STATE.alertsToday = 0;
  }
  if (STATE.alertsToday >= CONFIG.MAX_ALERTS_PER_DAY) return false;
  if (Date.now() - STATE.lastAlertTime < CONFIG.ALERT_COOLDOWN_MS) return false;
  return true;
}

async function fireAlert(candidate, scan) {
  if (!checkAlertCooldown()) {
    log(`Alert suppressed — cooldown/daily limit active`);
    return;
  }

  const msg = buildHunterAlert(candidate, scan);

  // Always send to bluejam (testing)
  if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);

  // Send to channel only if HUNTER_LIVE=true
  if (ENV.HUNTER_LIVE && ENV.CHANNEL_CHAT_ID) {
    await sendTelegram(msg, ENV.CHANNEL_CHAT_ID);
  }

  STATE.alertsToday++;
  STATE.lastAlertTime = Date.now();

  // Store in Supabase learning engine
  await storeAlert(candidate, scan);

  log(`✅ Alert fired for ${candidate.symbol} (score ${round2(candidate.finalScore)})`);
}

async function fireNoTradeMessage(scan) {
  const msg = buildNoTradeMessage(scan);
  if (ENV.BLUEJAM_CHAT_ID) await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
  log('📭 No trade message sent');
}

// ============================================================
// SECTION 27: SUPABASE LEARNING ENGINE
// ============================================================

async function storeAlert(candidate, scan) {
  if (!supabase) return;
  try {
    const { execution, rawScores, confidence, conviction, edgeResult, stageInfo, reasons } = candidate;

    const row = {
      symbol:           candidate.symbol,
      asset_type:       candidate.assetType,
      hunter_score:     round2(candidate.finalScore),
      execution_score:  round2(rawScores.executionQuality),
      structure_score:  round2(rawScores.structure),
      momentum_score:   round2(rawScores.momentum),
      participation_score: round2(rawScores.participation),
      risk_score:       round2(rawScores.risk),
      confidence:       round2(confidence.score),
      conviction:       round2(conviction.score),
      edge_over_field:  round2(edgeResult.edge),
      stability_score:  round2(candidate.stability?.score || 0),
      stage:            stageInfo.stage,
      entry_price:      round2(execution.entry),
      stop_price:       round2(execution.stopPrice),
      t1_price:         round2(execution.t1Price),
      t2_price:         round2(execution.t2Price),
      rr_ratio:         round2(execution.rrRatio),
      buy_reasons:      JSON.stringify(reasons),
      reject_reasons:   JSON.stringify(candidate.rejectReasons || []),
      field_avg:        round2(scan.fieldAvg),
      created_at:       new Date().toISOString(),
      // Outcome fields (populated later by outcome tracker)
      target1_hit:      false,
      target2_hit:      false,
      stopped_out:      false,
      outcome_checked:  false,
    };

    const { error } = await supabase.from('hunter_alerts').insert(row);
    if (error) log(`Supabase insert error: ${error.message}`);
    else log(`📚 Alert stored in Supabase`);
  } catch (err) {
    log(`Supabase store error: ${err.message}`);
  }
}

async function trackOutcomes() {
  if (!supabase) return;
  try {
    // Find unresolved alerts within last 24h
    const { data: pending, error } = await supabase
      .from('hunter_alerts')
      .select('*')
      .eq('outcome_checked', false)
      .gte('created_at', new Date(Date.now() - 86400000).toISOString());

    if (error || !pending?.length) return;

    for (const alert of pending) {
      try {
        // Fetch current price
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

        // Mark as checked if old enough (>24h) or targets/stop hit
        const shouldClose = ageMin >= 1440 || target1Hit || stoppedOut;

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

async function mainCycle() {
  STATE.cycleCount++;
  log(`\n════ CYCLE ${STATE.cycleCount} ════`);

  try {
    // Inject dynamic assets every cycle
    await injectDynamicAssets();

    // Run full scan
    const scan = await runFullScan();

    // Decision
    const buys = scan.buys || [];

    if (buys.length > 0) {
      // Take the best candidate
      const best = buys[0];
      log(`🎯 BUY candidate: ${best.symbol} (score ${round2(best.finalScore)})`);

      // Final sanity — competition check
      const secondBest = scan.candidates.filter((c) => c.symbol !== best.symbol)[0];
      const gap = secondBest ? best.finalScore - secondBest.finalScore : 999;

      if (gap >= CONFIG.THRESHOLDS.competitionGap) {
        await fireAlert(best, scan);
      } else {
        log(`Competition gap too small (${round2(gap)}) — holding fire`);
      }
    } else if (scan.watches?.length > 0) {
      log(`👁 ${scan.watches.length} assets on WATCH — not firing`);
    } else {
      log('No viable candidates this cycle');
    }

    // No-trade message every N cycles
    if (STATE.cycleCount % CONFIG.NO_TRADE_EVERY_N === 0 && buys.length === 0) {
      await fireNoTradeMessage(scan);
    }

    // Outcome tracking (every 10 cycles)
    if (STATE.cycleCount % 10 === 0) {
      await trackOutcomes();
    }

  } catch (err) {
    log(`Cycle error: ${err.message}`);
    console.error(err);
  }
}

async function start() {
  log('');
  log('╔══════════════════════════════════╗');
  log('║     THE HUNTER — v1.0.0          ║');
  log('║     BareTradeSignals Engine      ║');
  log('╚══════════════════════════════════╝');
  log('');
  log(`Mode: ${ENV.HUNTER_LIVE ? '🔴 LIVE' : '🟡 BLUEJAM TEST'}`);
  log(`Cycle interval: ${CONFIG.CYCLE_MS / 1000}s`);
  log(`Universe: ${CORE_CRYPTO.length} crypto + ${CORE_US_STOCKS.length} US + ${CORE_LSE_STOCKS.length} LSE`);
  log('');

  if (!ENV.BOT_TOKEN) {
    log('⚠️  WARNING: BOT_TOKEN not set — Telegram disabled');
  }
  if (!supabase) {
    log('⚠️  WARNING: Supabase not configured — learning engine disabled');
  }

  // Initial cycle
  await mainCycle();

  // Subsequent cycles
  setInterval(mainCycle, CONFIG.CYCLE_MS);
}

// Boot
start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
