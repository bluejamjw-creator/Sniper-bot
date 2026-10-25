'use strict';
/**
 * hunter_trend.js — HUNTER TREND LANE (V16)
 *
 * The "Opportunity Engine" / portfolio-manager Hunter (hunter_pm), ported
 * into Hunter V16 as a second lane next to the crypto early-move lane.
 * Same process, own state, own tables (trend_*). Loaded by
 * portfolio-bot-v8.js:  require('./hunter_trend.js').start({ db, notify, ... })
 *
 * What it does (from the original, kept as written unless noted):
 *  1. SCAN every 10 min: scores crypto (24/7), US stocks and LSE shares
 *     (only while their market is open) with the original 12-engine Hunter
 *     score on 15-minute candles: market context, structure, participation,
 *     momentum, stage, execution, risk, stability, edge vs the field,
 *     competition, confidence, conviction.
 *  2. LEADERBOARD: every 30 min the ranked scores are saved (trend_leaderboard).
 *  3. WATCHLIST LIFECYCLE: clean setups scoring 62–68 are tracked
 *     EARLY → DEVELOPING → CONFIRMED and posted when added, when they improve
 *     5+ points or come within 2 points of the BUY line, and when removed.
 *  4. MOMENTUM EVENTS: a scored asset (55+) jumping 5%+ since the last scan
 *     is posted once per day.
 *  5. PORTFOLIO MANAGER (daily, first scan after 09:00 UTC): OPEN / HOLD /
 *     CLOSE on daily candles. OPEN needs: score 60+ in 2 of the last 3
 *     snapshots and rising, peak 62+, 2+ top-5 appearances in 14 days, price
 *     above the 50-day average, within 25% of the 52-week high, 52-week
 *     range 30%+, 20-day above 50-day average, no distribution cluster,
 *     liquid. HOLD is silent. CLOSE on: ATR trailing stop (3x stocks, 4x
 *     crypto), swing-low break, price under the 50-day average on selling,
 *     4 distribution days in 10 / 3 in 5, score collapse (after a 14-day
 *     grace period). A low-volume pullback never triggers a close.
 *     The two price stops (ATR, swing low) are also checked every scan,
 *     as the original header intended.
 *
 * Fixes vs the original:
 *  - htfContextModifier() was called but never defined: every asset with a
 *    pre-score of 55+ threw and was dropped as an "Error" — i.e. the strong
 *    ones. Defined here (small +/- for 4h/12h trend agreement).
 *  - OPEN message referenced an undefined `entry` and crashed after the
 *    position was saved (you were never told). Entry price is now recorded.
 *  - Positions keep history (no upsert-over-symbol), with entry/exit price
 *    and % return, so the lane can be judged on results.
 *  - "52-week high" used 60 days; now ~1 year of daily data.
 *  - US/LSE hours follow New York / London time (clock changes), 2026–27 holidays.
 *  - Watchlist events are posted (the original only logged them).
 *  - Stops rounded by price size (a $0.03 coin kept a $0.03 stop before).
 *  - Max 8 open positions; 1 new OPEN per daily run (original rule).
 *  - Telegram/Supabase/Alpaca removed: Discord via Hunter, Neon tables,
 *    Yahoo (stocks) with FMP / Alpaca fallbacks, Binance/Bybit (crypto).
 *  - SNIPER regime advisory dropped (SNIPER's table is in another database).
 *
 * Switch off with TREND_LANE=off.
 */

// ============================================================
// CONFIG
// ============================================================

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

const CONFIG = {
  WEIGHTS: {
    marketContext: 0.08, structure: 0.12, participation: 0.13, momentum: 0.12,
    executionQuality: 0.22, risk: 0.10, stage: 0.08, edge: 0.15,
  },
  THRESHOLDS: {
    hunterScoreElite: 80, hunterScoreGood: 68, hunterScoreWatch: 62,
    confidenceMinimum: 55, convictionMinimum: 50, executionHardFloor: 55,
    edgeMinimumOverField: 4, competitionGap: 5, competitionBonus: 8,
  },
  MIN_DOLLAR_VOLUME: 500_000,
  cycleMs: Number(env('TREND_CYCLE_MIN', 10)) * 60_000,
  snapshotEveryMs: 30 * 60_000,
  dailyRunUtcHour: Number(env('TREND_DAILY_HOUR_UTC', 9)),
  maxOpenPositions: Number(env('TREND_MAX_OPEN', 8)),
  maxOpensPerRun: Number(env('TREND_MAX_OPENS_PER_RUN', 1)),
  maxWatchPostsPerDay: Number(env('TREND_WATCH_MAX_POSTS_DAY', 12)),
  leaderboardRetentionDays: 21,
  concurrency: 3,
};

const PM = {
  OPEN_MIN_SCORE: 60, OPEN_SCORE_SNAPSHOTS: 3, OPEN_SCORE_MIN_COUNT: 2,
  OPEN_52W_MAX_PCT_FROM_HIGH: 25, OPEN_52W_MIN_RANGE_PCT: 30,
  OPEN_MIN_HUNTER_SCORE_PEAK: 62, OPEN_TOP5_MIN_COUNT: 2,
  OPEN_CRYPTO_MIN_VOL_USD: 10_000_000, OPEN_STOCK_MIN_PRICE: 15,
  OPEN_STOCK_MIN_ADV: 500_000, OPEN_LSE_MIN_ADV: 200_000,
  HOLD_MA50_BUFFER_PCT: 3, HOLD_MAX_DIST_DAYS: 10, HOLD_DIST_CLUSTER_MAX: 3,
  HOLD_NEW_POSITION_GRACE: 14,
  CLOSE_ATR_MULT_STOCK: 3.0, CLOSE_ATR_MULT_CRYPTO: 4.0, CLOSE_ATR_MULT_LSE: 3.0,
  CLOSE_DIST_COUNT: 4, CLOSE_DIST_CLUSTER: 3, CLOSE_SCORE_FLOOR: 40,
  CLOSE_SCORE_DROP_FROM_PEAK: 25,
  WATCH_MIN_SCORE: 55, WATCH_TOP5_MIN: 1, WATCH_MAX_SCORE_BELOW_OPEN: 8,
  WATCH_STALE_DAYS: 3, LEADERBOARD_DAYS: 14, DAILY_CANDLES: 300,
};

const FSM_FLOOR = 55, FSM_DEVELOPING = 3, FSM_CONFIRMED = 5, FSM_CONFIRM_SCORE = 65, FSM_DROP_SCANS = 2;
const WATCHLIST_UPDATE_SCORE_DELTA = 5, WATCHLIST_NEAR_TRIGGER_GAP = 2, WATCHLIST_REMOVE_SCORE_DROP = 10;
const WATCHLIST_DEGRADED_STAGES = new Set(['SLEEPING', 'FAILURE', 'EXHAUSTION']);
const WATCHLIST_STALE_MS = 12 * 3600_000;
const MOMENTUM_SCORE_MIN = 55, MOMENTUM_MOVE_PCT = 5;

// ── Universe (original lists; override with TREND_CRYPTO / TREND_US / TREND_LSE, comma-separated) ──
const CORE_CRYPTO = [...new Set([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'LINKUSDT', 'AAVEUSDT',
  'UNIUSDT', 'ONDOUSDT', 'HYPEUSDT', 'ARBUSDT', 'SUIUSDT', 'TAOUSDT',
  'RENDERUSDT', 'AVAXUSDT', 'NEARUSDT', 'PENDLEUSDT',
  'ENAUSDT', 'JUPUSDT', 'INJUSDT', 'APTUSDT', 'CRVUSDT', 'STRKUSDT', 'XRPUSDT', 'LDOUSDT',
  'ADAUSDT', 'DOTUSDT', 'OPUSDT', 'SEIUSDT', 'FETUSDT', 'ICPUSDT',
  'VIRTUALUSDT', 'KASUSDT', 'TIAUSDT', 'IMXUSDT',
])];
const CORE_US = [
  'NVDA', 'AMD', 'AVGO', 'TSM', 'ASML', 'AMAT', 'LRCX', 'MRVL', 'MU', 'ARM', 'SMCI', 'VRT', 'ANET', 'GEV', 'ETN',
  'PLTR', 'APP', 'CRWV', 'NOW', 'CRM', 'SNOW', 'DDOG',
  'RTX', 'LMT', 'NOC', 'LHX', 'GD', 'KTOS', 'COIN', 'HOOD', 'RKLB', 'ASTS',
  'CEG', 'OKLO', 'PWR', 'VST', 'XOM', 'CVX', 'LLY', 'NVO', 'UNH', 'ISRG', 'HIMS',
  'UBER', 'SHOP', 'MELI', 'NFLX', 'RDDT', 'JPM', 'GS',
];
const CORE_LSE = [
  'SHEL.L', 'RIO.L', 'AZN.L', 'HSBA.L', 'BP.L', 'GLEN.L', 'AAL.L', 'BARC.L', 'LLOY.L', 'NWG.L',
  'STAN.L', 'GSK.L', 'REL.L', 'BA.L', 'RR.L', 'HIK.L', 'ANTO.L', 'FRES.L', 'BAB.L',
];
// (original had HSBC.L — Yahoo lists HSBC on the LSE as HSBA.L)

const SECTOR_MAP = {
  NVDA: 'AI_HW', AMD: 'AI_HW', AVGO: 'AI_HW', TSM: 'AI_HW', ASML: 'AI_HW', AMAT: 'AI_HW', LRCX: 'AI_HW', MRVL: 'AI_HW',
  MU: 'AI_HW', ARM: 'AI_HW', SMCI: 'AI_HW', VRT: 'AI_HW', ANET: 'AI_HW', GEV: 'AI_HW', ETN: 'AI_HW',
  PLTR: 'AI_SW', APP: 'AI_SW', CRWV: 'AI_SW', NOW: 'AI_SW', CRM: 'AI_SW', SNOW: 'AI_SW', DDOG: 'AI_SW',
  RTX: 'DEFENCE', LMT: 'DEFENCE', NOC: 'DEFENCE', LHX: 'DEFENCE', GD: 'DEFENCE', KTOS: 'DEFENCE', 'BA.L': 'DEFENCE', 'RR.L': 'DEFENCE',
  COIN: 'CRYPTO_INFRA', HOOD: 'CRYPTO_INFRA', RKLB: 'SPACE', ASTS: 'SPACE',
  CEG: 'POWER', OKLO: 'POWER', PWR: 'POWER', VST: 'POWER', XOM: 'ENERGY', CVX: 'ENERGY',
  LLY: 'HEALTH', NVO: 'HEALTH', UNH: 'HEALTH', ISRG: 'HEALTH', HIMS: 'HEALTH',
  UBER: 'GROWTH', SHOP: 'GROWTH', MELI: 'GROWTH', NFLX: 'GROWTH', RDDT: 'GROWTH',
  'RIO.L': 'LSE_MINING', 'GLEN.L': 'LSE_MINING', 'AAL.L': 'LSE_MINING', 'ANTO.L': 'LSE_MINING', 'FRES.L': 'LSE_MINING',
  'HSBA.L': 'LSE_BANK', 'BARC.L': 'LSE_BANK', 'LLOY.L': 'LSE_BANK', 'NWG.L': 'LSE_BANK', 'STAN.L': 'LSE_BANK',
  BTCUSDT: 'CRYPTO_L1', ETHUSDT: 'CRYPTO_L1', SOLUSDT: 'CRYPTO_L1', AVAXUSDT: 'CRYPTO_L1', ADAUSDT: 'CRYPTO_L1',
  ARBUSDT: 'CRYPTO_L2', OPUSDT: 'CRYPTO_L2', SUIUSDT: 'CRYPTO_L1', APTUSDT: 'CRYPTO_L1', NEARUSDT: 'CRYPTO_L1',
  SEIUSDT: 'CRYPTO_L1', TIAUSDT: 'CRYPTO_L1', KASUSDT: 'CRYPTO_L1', XRPUSDT: 'CRYPTO_L1', BNBUSDT: 'CRYPTO_L1', DOTUSDT: 'CRYPTO_L1',
  HYPEUSDT: 'CRYPTO_DEFI', AAVEUSDT: 'CRYPTO_DEFI', UNIUSDT: 'CRYPTO_DEFI', PENDLEUSDT: 'CRYPTO_DEFI', LDOUSDT: 'CRYPTO_DEFI',
  ENAUSDT: 'CRYPTO_DEFI', JUPUSDT: 'CRYPTO_DEFI', INJUSDT: 'CRYPTO_DEFI', ONDOUSDT: 'CRYPTO_RWA',
  TAOUSDT: 'CRYPTO_AI', FETUSDT: 'CRYPTO_AI', RENDERUSDT: 'CRYPTO_AI', VIRTUALUSDT: 'CRYPTO_AI',
  LINKUSDT: 'CRYPTO_INFRA', ICPUSDT: 'CRYPTO_INFRA', IMXUSDT: 'CRYPTO_GAMING',
};
const SECTOR_LABELS = {
  AI_HW: 'AI Hardware', AI_SW: 'AI Software', DEFENCE: 'Defence', SPACE: 'Space', CRYPTO_INFRA: 'Crypto Infrastructure',
  CRYPTO_DEFI: 'Crypto DeFi', CRYPTO_L1: 'Crypto L1', CRYPTO_L2: 'Crypto L2', CRYPTO_AI: 'Crypto AI', CRYPTO_RWA: 'Crypto RWA',
  CRYPTO_GAMING: 'Crypto Gaming', POWER: 'Power & Energy', ENERGY: 'Energy', HEALTH: 'Healthcare', GROWTH: 'Consumer Growth',
  LSE_MINING: 'LSE Mining', LSE_BANK: 'LSE Banking',
};
const L1_SECTORS = new Set(['CRYPTO_L1', 'CRYPTO_L2']);

// ============================================================
// STATE + WIRING
// ============================================================

const STATE = {
  btcRegime: 'NEUTRAL', qqqRegime: 'NEUTRAL', qqqRegimeStale: true, cryptoBreadth: 50,
  fieldAverage: 55, candidateHistory: [], cycleCount: 0, btcScoreHistory: [],
  symbolScoreHistory: new Map(), candidateStates: new Map(), watchlistState: new Map(),
  lastPrices: new Map(), lastSnapshotAt: 0, running: false, lastScan: null,
  watchPosts: { day: '', n: 0 }, momentumSent: new Set(), provider: {},
};

let DB = null;
let NOTIFY = async (text) => console.log(text);
let REVOLUT_BASES = async () => null;

function log(msg) { console.log(`[TREND] ${msg}`); }

// ============================================================
// HELPERS
// ============================================================

function clamp(v, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }
function round2(v) { return Math.round(v * 100) / 100; }
function roundPrice(v) {
  if (!Number.isFinite(v)) return v;
  if (v >= 100) return Math.round(v * 100) / 100;
  if (v >= 10) return Math.round(v * 1000) / 1000;
  if (v >= 1) return Math.round(v * 10000) / 10000;
  if (v >= 0.01) return Math.round(v * 100000) / 100000;
  return Number(v.toPrecision(4));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assetTypeOf = s => (s.endsWith('USDT') ? 'crypto' : s.endsWith('.L') ? 'lse' : 'us');
const flagOf = t => (t === 'crypto' ? '🪙' : t === 'lse' ? '🇬🇧' : '🇺🇸');
const labelOf = s => s.replace(/USDT$/, '').replace(/\.L$/, '');
function fmtPx(v, t) {
  if (!Number.isFinite(v)) return 'n/a';
  const p = roundPrice(v);
  return t === 'lse' ? `${p}p` : `$${p}`;
}
function sectorLine(symbol) {
  const s = SECTOR_MAP[symbol];
  return s ? `Sector: ${SECTOR_LABELS[s] || s.replace(/_/g, ' ')}` : '';
}
function utcDay(d = new Date()) { return d.toISOString().slice(0, 10); }

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const lastHit = new Map();
async function httpGet(url, headers = {}, { gapMs = 0, timeoutMs = 15000 } = {}) {
  const host = new URL(url).hostname;
  if (gapMs) {
    const wait = (lastHit.get(host) || 0) + gapMs - Date.now();
    lastHit.set(host, Date.now() + Math.max(0, wait));
    if (wait > 0) await sleep(wait);
  }
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    const p = (STATE.provider[host] ||= { ok: 0, fail: 0 });
    if (!res.ok) { p.fail++; return null; }
    p.ok++;
    return await res.json();
  } catch {
    (STATE.provider[host] ||= { ok: 0, fail: 0 }).fail++;
    return null;
  }
}

// ============================================================
// MARKET HOURS (New York / London local time — follows clock changes)
// ============================================================

const US_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
const US_EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);
const UK_HOLIDAYS = new Set([
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
]);

function localParts(tz, d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday: parts.weekday };
}

function isMarketOpen(assetType, d = new Date()) {
  if (assetType === 'crypto') return true;
  if (assetType === 'us') {
    const p = localParts('America/New_York', d);
    if (p.weekday === 'Sat' || p.weekday === 'Sun' || US_HOLIDAYS.has(p.date)) return false;
    const close = US_EARLY_CLOSE.has(p.date) ? 13 * 60 : 16 * 60;
    return p.minutes >= 9 * 60 + 30 && p.minutes < close;
  }
  if (assetType === 'lse') {
    const p = localParts('Europe/London', d);
    if (p.weekday === 'Sat' || p.weekday === 'Sun' || UK_HOLIDAYS.has(p.date)) return false;
    return p.minutes >= 8 * 60 && p.minutes < 16 * 60 + 30;
  }
  return false;
}

// ============================================================
// DATA — CANDLES
// ============================================================

function cleanCandles(rows) {
  return rows.filter(c => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0 && Number.isFinite(c.volume))
    .sort((a, b) => a.time - b.time);
}

async function bybitKlines(symbol, interval, limit) {
  const d = await httpGet(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const list = d && d.result && d.result.list;
  if (!Array.isArray(list) || !list.length) return null;
  return cleanCandles(list.map(c => ({ time: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] })));
}

async function binanceKlines(symbol, interval, limit) {
  const d = await httpGet(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!Array.isArray(d) || !d.length) return null;
  return cleanCandles(d.map(c => ({ time: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] })));
}

async function yahooChart(symbol, interval, range) {
  const d = await httpGet(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`, {}, { gapMs: 250 });
  const r = d && d.chart && d.chart.result && d.chart.result[0];
  if (!r || !Array.isArray(r.timestamp)) return null;
  // Yahoo can silently answer for a different listing (BA.L -> BA): reject mismatches.
  const meta = r.meta || {};
  if (meta.symbol && meta.symbol.toUpperCase() !== symbol.toUpperCase()) return null;
  if (symbol.endsWith('.L') && meta.currency && !['GBp', 'GBP', 'GBX', 'p'].includes(meta.currency)) return null;
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  return cleanCandles(r.timestamp.map((t, i) => ({ time: t * 1000, open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i] ?? 0 })));
}

async function alpacaBars(symbol, timeframe, days) {
  const k = process.env.ALPACA_API_KEY, s = process.env.ALPACA_SECRET_KEY;
  if (!k || !s) return null;
  const start = new Date(Date.now() - days * 86400000).toISOString();
  const d = await httpGet(`https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=${timeframe}&start=${start}&limit=1000&feed=iex&adjustment=split&sort=asc`,
    { 'APCA-API-KEY-ID': k, 'APCA-API-SECRET-KEY': s });
  if (!d || !Array.isArray(d.bars) || !d.bars.length) return null;
  return cleanCandles(d.bars.map(b => ({ time: new Date(b.t).getTime(), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })));
}

async function fmpDaily(symbol) {
  const key = process.env.FMP_API_KEY || process.env.FMP_KEY;
  if (!key) return null;
  const from = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const d = await httpGet(`https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${encodeURIComponent(symbol)}&from=${from}&apikey=${encodeURIComponent(key)}`);
  const rows = Array.isArray(d) ? d : (d && Array.isArray(d.historical) ? d.historical : null);
  if (!rows || !rows.length) return null;
  return cleanCandles(rows.map(r => ({ time: new Date(r.date).getTime(), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume })));
}

// Intraday (15m) for scoring — original sources, minus Alpaca as primary.
async function fetchIntraday(symbol, type) {
  if (type === 'crypto') {
    let c = await bybitKlines(symbol, '15', 100);
    if (!c || c.length < 50) c = await binanceKlines(symbol, '15m', 100);
    return c;
  }
  let c = await yahooChart(symbol, '15m', '5d');
  if ((!c || c.length < 50) && type === 'us') c = await alpacaBars(symbol, '15Min', 7);
  return c;
}

// Daily candles for the portfolio manager (~1 year).
const dailyCache = new Map();
async function fetchDailyCandles(symbol, type) {
  const hit = dailyCache.get(symbol);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.candles;
  let c = null;
  if (type === 'crypto') {
    c = await binanceKlines(symbol, '1d', PM.DAILY_CANDLES);
    if (!c || c.length < 60) c = await bybitKlines(symbol, 'D', PM.DAILY_CANDLES);
  } else {
    c = await yahooChart(symbol, '1d', '1y');
    if ((!c || c.length < 60) && type === 'us') c = await fmpDaily(symbol);
    if ((!c || c.length < 60) && type === 'us') c = await alpacaBars(symbol, '1Day', 400);
  }
  c = c || [];
  dailyCache.set(symbol, { at: Date.now(), candles: c });
  return c;
}

// ============================================================
// INDICATORS (original)
// ============================================================

function calcEMA(prices, period) {
  if (prices.length < period) return prices.map(() => prices[prices.length - 1]);
  const k = 2 / (period + 1);
  const result = [];
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) result.push(ema);
  for (let i = period; i < prices.length; i++) { ema = prices[i] * k + ema * (1 - k); result.push(ema); }
  return result;
}
function calcSMA(prices, period) {
  return prices.map((_, i) => (i < period - 1 ? null : prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period));
}
function calcVWAP(candles) {
  let tpv = 0, vol = 0;
  return candles.map(c => { tpv += ((c.high + c.low + c.close) / 3) * c.volume; vol += c.volume; return vol > 0 ? tpv / vol : c.close; });
}
function calcATR(candles, period = 14) {
  const trs = candles.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))));
  const result = [];
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) result.push(atr);
  for (let i = period; i < trs.length; i++) { atr = (atr * (period - 1) + trs[i]) / period; result.push(atr); }
  return result;
}
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return prices.map(() => 50);
  const ch = prices.slice(1).map((p, i) => p - prices[i]);
  let g = 0, l = 0;
  for (let i = 0; i < period; i++) { if (ch[i] > 0) g += ch[i]; else l += Math.abs(ch[i]); }
  g /= period; l /= period;
  const result = new Array(period + 1).fill(50);
  for (let i = period; i < ch.length; i++) {
    g = (g * (period - 1) + (ch[i] > 0 ? ch[i] : 0)) / period;
    l = (l * (period - 1) + (ch[i] < 0 ? -ch[i] : 0)) / period;
    result.push(clamp(100 - 100 / (1 + (l === 0 ? 100 : g / l))));
  }
  return result;
}
function calcBollingerBands(prices, period = 20, mult = 2) {
  const sma = calcSMA(prices, period);
  return prices.map((_, i) => {
    if (i < period - 1) return { upper: null, mid: null, lower: null, width: null };
    const slice = prices.slice(i - period + 1, i + 1), m = sma[i];
    const sd = Math.sqrt(slice.reduce((s, p) => s + (p - m) ** 2, 0) / period);
    return { upper: m + mult * sd, mid: m, lower: m - mult * sd, width: (2 * mult * sd) / m };
  });
}
function calcMACD(prices, fast = 12, slow = 26, signal = 9) {
  const f = calcEMA(prices, fast), s = calcEMA(prices, slow);
  const line = f.map((v, i) => v - s[i]);
  const sig = calcEMA(line, signal);
  return { macdLine: line, signalLine: sig, histogram: line.map((m, i) => m - sig[i]) };
}
function detectResistanceLevels(candles, lookback = 30) {
  const h = candles.slice(-lookback).map(c => c.high), out = [];
  for (let i = 2; i < h.length - 2; i++) if (h[i] > h[i - 1] && h[i] > h[i - 2] && h[i] > h[i + 1] && h[i] > h[i + 2]) out.push(h[i]);
  return out;
}

// ============================================================
// SCORING ENGINES (original logic)
// ============================================================

function scoreMarketContext(assetType) {
  let score = 50;
  const reasons = [];
  if (STATE.btcRegime === 'BULL') { score += assetType === 'crypto' ? 15 : 5; reasons.push('BTC in bull structure'); }
  else if (STATE.btcRegime === 'BEAR') { score -= assetType === 'crypto' ? 15 : 5; reasons.push('BTC in bear structure'); }
  if (!STATE.qqqRegimeStale) {
    if (STATE.qqqRegime === 'BULL') { score += assetType === 'crypto' ? 5 : 20; reasons.push('QQQ in bull structure'); }
    else if (STATE.qqqRegime === 'BEAR') { score -= assetType === 'crypto' ? 5 : 20; reasons.push('QQQ in bear structure'); }
  }
  if (assetType === 'crypto') {
    if (STATE.cryptoBreadth >= 70) { score += 10; reasons.push('Broad crypto strength'); }
    else if (STATE.cryptoBreadth <= 30) { score -= 10; reasons.push('Crypto breadth weak'); }
    const h = new Date().getUTCHours();
    if ((h >= 7 && h <= 9) || (h >= 13 && h <= 15)) { score += 10; reasons.push('High-activity crypto window'); }
  } else if (isMarketOpen(assetType)) { score += 10; reasons.push(`${assetType.toUpperCase()} market open`); }
  else { score -= 20; reasons.push(`${assetType.toUpperCase()} market closed`); }
  return { score: clamp(score), reasons };
}

function scoreStructure(candles) {
  const parts = [], reasons = [];
  const closes = candles.map(c => c.close), last = closes[closes.length - 1];
  const e20 = calcEMA(closes, 20).at(-1), e50 = calcEMA(closes, 50).at(-1), vw = calcVWAP(candles).at(-1);
  const bb = calcBollingerBands(closes);
  if (last > e20 && e20 > e50) { parts.push(85); reasons.push('Price > EMA20 > EMA50 (bullish stack)'); }
  else if (last > e20 && e20 < e50) { parts.push(60); reasons.push('Price above EMA20, mixed stack'); }
  else if (last < e20 && e20 < e50) { parts.push(20); reasons.push('Bearish EMA stack'); }
  else { parts.push(45); reasons.push('Mixed EMA structure'); }
  if (last > vw) { parts.push(75); reasons.push('Trading above VWAP'); } else { parts.push(35); reasons.push('Trading below VWAP'); }
  const bbLast = bb.at(-1);
  if (bbLast.width !== null) {
    const avgW = bb.slice(-20).filter(b => b.width).reduce((s, b) => s + b.width, 0) / 20;
    if (bbLast.width < avgW * 0.7) { parts.push(80); reasons.push('BB compression — coiling for move'); }
    else if (bbLast.width > avgW * 1.5) { parts.push(40); reasons.push('BB expanded — volatile'); }
    else parts.push(60);
  }
  const lows = candles.slice(-6).map(c => c.low);
  let hl = 0;
  for (let i = 1; i < lows.length; i++) if (lows[i] > lows[i - 1]) hl++;
  if (hl >= 4) { parts.push(85); reasons.push('Strong higher lows pattern'); } else if (hl >= 2) parts.push(65); else parts.push(35);
  const near = detectResistanceLevels(candles).some(l => l > last && l < last * 1.02);
  if (near) { parts.push(35); reasons.push('Near resistance — caution'); } else parts.push(70);
  return { score: clamp(parts.reduce((a, b) => a + b, 0) / parts.length), reasons };
}

function scoreParticipation(candles) {
  const parts = [], reasons = [];
  const vols = candles.map(c => c.volume), closes = candles.map(c => c.close);
  const lastVol = vols.at(-1), smaVol = calcSMA(vols, 20).at(-1), prevVol = vols.at(-2);
  const relVol = smaVol > 0 ? lastVol / smaVol : 1;
  if (relVol >= 3) { parts.push(95); reasons.push(`Relative volume ${round2(relVol)}x — exceptional`); }
  else if (relVol >= 2) { parts.push(80); reasons.push(`Relative volume ${round2(relVol)}x — strong`); }
  else if (relVol >= 1.5) { parts.push(65); reasons.push(`Relative volume ${round2(relVol)}x`); }
  else if (relVol >= 1) parts.push(50);
  else { parts.push(25); reasons.push('Below-average volume'); }
  const acc = prevVol > 0 ? lastVol / prevVol : 1;
  if (acc >= 2) { parts.push(85); reasons.push('Volume accelerating'); } else if (acc >= 1.3) parts.push(65); else parts.push(45);
  const dv = lastVol * closes.at(-1);
  const dvs = candles.slice(-20).map(c => c.volume * c.close);
  const dvAvg = dvs.reduce((a, b) => a + b, 0) / dvs.length;
  const rdv = dvAvg > 0 ? dv / dvAvg : 1;
  if (rdv >= 2) { parts.push(90); reasons.push(`Dollar volume ${round2(rdv)}x own avg — surge`); }
  else if (rdv >= 1.3) { parts.push(70); reasons.push(`Dollar volume ${round2(rdv)}x own avg`); }
  else if (rdv >= 0.8) parts.push(50);
  else if (dv >= CONFIG.MIN_DOLLAR_VOLUME) { parts.push(35); reasons.push('Dollar volume below own avg'); }
  else { parts.push(20); reasons.push('Low dollar volume — liquidity risk'); }
  const last5 = candles.slice(-5);
  const bull = last5.filter(c => c.close > c.open).reduce((s, c) => s + c.volume, 0);
  const tot = last5.reduce((s, c) => s + c.volume, 0);
  const br = tot > 0 ? bull / tot : 0.5;
  if (br >= 0.7) { parts.push(80); reasons.push('Dominant buying pressure'); } else if (br >= 0.55) parts.push(60); else { parts.push(30); reasons.push('Selling pressure present'); }
  return { score: clamp(parts.reduce((a, b) => a + b, 0) / parts.length), reasons };
}

function scoreMomentum(candles) {
  const parts = [], reasons = [];
  const closes = candles.map(c => c.close), last = closes.at(-1);
  const lc = candles.at(-1);
  const today = lc ? ((lc.close - lc.open) / lc.open) * 100 : 0;
  if (today <= -5) { reasons.push(`Down ${round2(today)}% this bar — momentum overridden`); return { score: 10, reasons }; }
  const roc5 = ((last - closes.at(-6)) / closes.at(-6)) * 100;
  if (roc5 >= 3) { parts.push(90); reasons.push(`Strong momentum +${round2(roc5)}%`); }
  else if (roc5 >= 1.5) { parts.push(70); reasons.push(`Positive momentum +${round2(roc5)}%`); }
  else if (roc5 >= 0) parts.push(50);
  else { parts.push(20); reasons.push(`Negative momentum ${round2(roc5)}%`); }
  if (today <= -2) { parts.push(15); reasons.push(`Down ${round2(today)}% this bar — momentum dampened`); }
  const roc5prev = closes.length >= 11 ? ((closes.at(-6) - closes.at(-11)) / closes.at(-11)) * 100 : roc5;
  if (roc5 > roc5prev + 0.5) { parts.push(80); reasons.push('Momentum accelerating'); } else if (roc5 > roc5prev) parts.push(60); else { parts.push(40); reasons.push('Momentum decelerating'); }
  const rsi = calcRSI(closes).at(-1);
  if (rsi >= 55 && rsi <= 75) { parts.push(80); reasons.push(`RSI ${round2(rsi)} — bullish zone`); }
  else if (rsi > 75) { parts.push(45); reasons.push(`RSI ${round2(rsi)} — overbought`); }
  else if (rsi >= 45) parts.push(55);
  else { parts.push(25); reasons.push(`RSI ${round2(rsi)} — weak`); }
  const hist = calcMACD(closes).histogram;
  if (hist.at(-1) > 0 && hist.at(-1) > hist.at(-2)) { parts.push(80); reasons.push('MACD histogram rising'); } else if (hist.at(-1) > 0) parts.push(60); else { parts.push(30); reasons.push('MACD below zero'); }
  let consec = 0;
  for (let i = candles.length - 1; i >= 0; i--) { if (candles[i].close > candles[i].open) consec++; else break; }
  if (consec >= 4) { parts.push(85); reasons.push(`${consec} consecutive green candles`); } else if (consec >= 2) parts.push(65); else parts.push(40);
  const roc20 = ((last - closes.at(-21)) / closes.at(-21)) * 100;
  if (roc20 > 15) { parts.push(30); reasons.push('Potentially extended — 20-period move large'); } else if (roc20 > 8) parts.push(55); else { parts.push(70); reasons.push('Fresh move — not extended'); }
  return { score: clamp(parts.reduce((a, b) => a + b, 0) / parts.length), reasons };
}

function classifyStage(candles) {
  const closes = candles.map(c => c.close), vols = candles.map(c => c.volume);
  const last = closes.at(-1), e20 = calcEMA(closes, 20).at(-1), e50 = calcEMA(closes, 50).at(-1);
  const rsi = calcRSI(closes).at(-1), bb = calcBollingerBands(closes), bbLast = bb.at(-1);
  const relVol = vols.at(-1) / (calcSMA(vols, 20).at(-1) || 1);
  const avgW = bb.slice(-20).filter(b => b.width).reduce((s, b) => s + b.width, 0) / 20;
  const compressed = bbLast.width < avgW * 0.7;
  const roc3 = ((last - closes.at(-4)) / closes.at(-4)) * 100;
  let stage = 'WAITING', s = 60;
  if (rsi < 40 && last < e50) { stage = 'SLEEPING'; s = 45; }
  else if (compressed && relVol < 1.2 && Math.abs(roc3) < 1) { stage = 'LOADING'; s = 72; }
  else if (compressed && relVol >= 1.2 && last > e20) { stage = 'READY'; s = 85; }
  else if (roc3 > 2 && relVol >= 1.5 && last > e20) { stage = 'BREAKING'; s = 92; }
  else if (roc3 > 1 && relVol >= 1.2 && last > e20 && e20 > e50) { stage = 'RUNNING'; s = 78; }
  else if (rsi > 75 || last > e20 * 1.08) { stage = 'EXHAUSTION'; s = 25; }
  else if (last < e20 && roc3 < -2) { stage = 'FAILURE'; s = 10; }
  return { stage, stageScore: s, score: clamp(s) };
}

function scoreExecutionQuality(candles) {
  const parts = [], reasons = [];
  const closes = candles.map(c => c.close), last = closes.at(-1);
  const e20 = calcEMA(closes, 20).at(-1), vw = calcVWAP(candles).at(-1), atr = calcATR(candles).at(-1);
  const lc = candles.at(-1);
  const aboveEma = ((last - e20) / e20) * 100;
  if (aboveEma >= 0 && aboveEma <= 1.5) { parts.push(90); reasons.push('Tight to EMA20 — ideal entry zone'); }
  else if (aboveEma > 1.5 && aboveEma <= 3) { parts.push(65); reasons.push('Slightly extended from EMA20'); }
  else if (aboveEma > 3) { parts.push(30); reasons.push(`Extended ${round2(aboveEma)}% from EMA20 — risky entry`); }
  else { parts.push(40); reasons.push('Below EMA20 — structure weak'); }
  const aboveVw = ((last - vw) / vw) * 100;
  if (aboveVw >= 0 && aboveVw <= 1.5) { parts.push(85); reasons.push('Close to VWAP — good R:R anchor'); }
  else if (aboveVw > 1.5 && aboveVw <= 3) parts.push(60);
  else if (aboveVw > 3) { parts.push(25); reasons.push(`${round2(aboveVw)}% above VWAP — stretched`); }
  else parts.push(50);
  const stopDist = atr * 1.5;
  const rr = stopDist > 0 ? (atr * 2) / stopDist : 0;
  if (rr >= 2.5) { parts.push(90); reasons.push(`R:R ${round2(rr)}:1 — excellent`); }
  else if (rr >= 1.8) { parts.push(70); reasons.push(`R:R ${round2(rr)}:1 — acceptable`); }
  else if (rr >= 1.3) { parts.push(45); reasons.push(`R:R ${round2(rr)}:1 — marginal`); }
  else { parts.push(15); reasons.push(`R:R ${round2(rr)}:1 — poor`); }
  const range = lc.high - lc.low;
  const closePos = range > 0 ? (lc.close - lc.low) / range : 0.5;
  const wick = range > 0 ? (lc.high - lc.close) / range : 0;
  if (closePos >= 0.7 && wick <= 0.2) { parts.push(85); reasons.push('Strong bullish candle close'); } else if (closePos >= 0.5) parts.push(60); else { parts.push(25); reasons.push('Weak candle close — selling pressure visible'); }
  return { score: clamp(parts.reduce((a, b) => a + b, 0) / parts.length), reasons, entry: last, stopDistance: stopDist };
}

const SETUP = { PULLBACK: 'PULLBACK_CONTINUATION', BREAKOUT: 'BREAKOUT_CONTINUATION', IGNITION: 'MOMENTUM_IGNITION', PARABOLIC: 'PARABOLIC_EXTENSION' };

function classifySetupType(candles, stageInfo) {
  const closes = candles.map(c => c.close), vols = candles.map(c => c.volume);
  const last = closes.at(-1);
  const volSMA = calcSMA(vols, 20).at(-1) || 1;
  const relVol = vols.at(-1) / volSMA;
  const rsi = calcRSI(closes).at(-1);
  const bb = calcBollingerBands(closes), bbLast = bb.at(-1);
  const avgW = bb.slice(-20).filter(b => b.width).reduce((s, b) => s + b.width, 0) / 20;
  const roc3 = closes.length >= 4 ? ((last - closes.at(-4)) / closes.at(-4)) * 100 : 0;
  const roc6 = closes.length >= 7 ? ((last - closes.at(-7)) / closes.at(-7)) * 100 : 0;
  const v10 = vols.length >= 11 ? vols.slice(-11, -1).reduce((a, b) => a + b, 0) / 10 : volSMA;
  const rvol = v10 > 0 ? vols.at(-1) / v10 : relVol;
  if ((rsi > 78) + (roc6 > 8) + (rvol >= 2) >= 2) return SETUP.PARABOLIC;
  const nearBreakout = detectResistanceLevels(candles).some(l => last >= l * 0.995 && last <= l * 1.015);
  const compressed = bbLast.width !== null && bbLast.width < avgW * 0.75;
  if ((nearBreakout || compressed) && relVol >= 1.3 && stageInfo.stage === 'BREAKING') return SETUP.BREAKOUT;
  if (roc3 >= 2.5 && relVol >= 2.5 && rsi >= 60) return SETUP.IGNITION;
  return SETUP.PULLBACK;
}

function runExecutionEngine(candles, stageInfo, execution) {
  const setupType = classifySetupType(candles, stageInfo);
  const lc = candles.at(-1);
  const spread = (lc.high - lc.low) / execution.entry;
  let executionScore = 60, reject = false, rejectReason = '';
  if (setupType === SETUP.PULLBACK) executionScore = 88;
  else if (setupType === SETUP.BREAKOUT) executionScore = 75;
  else if (setupType === SETUP.IGNITION) {
    if (spread > 0.004) { reject = true; rejectReason = `Spread ${round2(spread * 100)}% too wide for a market entry`; executionScore = 15; } else executionScore = 70;
  } else if (setupType === SETUP.PARABOLIC) { reject = true; rejectReason = 'Parabolic extension — the move has already happened'; executionScore = 0; }
  const atr = calcATR(candles).at(-1);
  if (!reject && !(execution.entry - atr * 1.8 < execution.entry)) { reject = true; rejectReason = 'Invalid structure: ATR too small relative to price'; }
  return { setupType, entryPrice: execution.entry, executionScore, blendedScore: clamp(execution.score * 0.6 + executionScore * 0.4), hardReject: reject, rejectReason };
}

function scoreRisk(candles) {
  const parts = [], reasons = [];
  const closes = candles.map(c => c.close), vols = candles.map(c => c.volume), last = closes.at(-1);
  const atrPct = (calcATR(candles).at(-1) / last) * 100;
  const avgDv = vols.slice(-20).reduce((s, v, i) => s + v * closes[closes.length - 20 + i], 0) / 20;
  if (avgDv >= CONFIG.MIN_DOLLAR_VOLUME * 5) { parts.push(90); reasons.push('High liquidity'); } else if (avgDv >= CONFIG.MIN_DOLLAR_VOLUME) parts.push(65); else { parts.push(20); reasons.push('Low liquidity — execution risk'); }
  const spr = ((candles.at(-1).high - candles.at(-1).low) / last) * 100;
  if (spr <= 0.3) parts.push(90); else if (spr <= 0.8) parts.push(65); else { parts.push(30); reasons.push('Wide spread — slippage risk'); }
  if (atrPct <= 1.5) { parts.push(80); reasons.push('Low ATR — controlled volatility'); } else if (atrPct <= 3) parts.push(60); else if (atrPct <= 5) parts.push(40); else { parts.push(15); reasons.push(`High ATR ${round2(atrPct)}% — elevated risk`); }
  const hi = Math.max(...closes.slice(-20));
  const dd = ((hi - last) / hi) * 100;
  if (dd <= 3) parts.push(75); else if (dd <= 8) parts.push(50); else { parts.push(25); reasons.push(`${round2(dd)}% off recent high`); }
  return { score: clamp(parts.reduce((a, b) => a + b, 0) / parts.length), reasons };
}

function scoreDecisionStability(candles) {
  const reasons = [];
  let s = 100;
  const pStress = candles.map((c, i) => (i < candles.length - 3 ? c : { ...c, close: c.close * 0.98, low: Math.min(c.low, c.close * 0.98) }));
  if (scoreExecutionQuality(pStress).score < CONFIG.THRESHOLDS.executionHardFloor) { s -= 30; reasons.push('Fails 2% price stress test'); }
  const vStress = candles.map((c, i) => (i < candles.length - 3 ? c : { ...c, volume: c.volume * 0.5 }));
  if (scoreParticipation(vStress).score < 40) { s -= 20; reasons.push('Participation collapses under volume stress'); }
  if (STATE.btcRegime === 'BULL') {
    STATE.btcRegime = 'NEUTRAL';
    const ctx = scoreMarketContext('crypto');
    STATE.btcRegime = 'BULL';
    if (ctx.score < 40) { s -= 15; reasons.push('Setup depends heavily on BTC strength'); }
  }
  return { score: clamp(s), reasons };
}

function scoreEdge(score) {
  const edge = score - (STATE.fieldAverage || 50);
  let s = 25;
  if (edge >= 25) s = 95; else if (edge >= CONFIG.THRESHOLDS.edgeMinimumOverField) s = 75; else if (edge >= 5) s = 55;
  return { score: clamp(s), edge };
}

function scoreCompetition(symbol, hunterScore) {
  const c = STATE.candidateHistory.slice(-50);
  if (c.length < 2) return { score: 70, gap: 0, rank: 1 };
  const sorted = [...c].sort((a, b) => b.hunterScore - a.hunterScore);
  const rank = sorted.findIndex(x => x.symbol === symbol) + 1;
  const gap = rank === 1 ? hunterScore - (sorted[1]?.hunterScore || 0) : sorted[0].hunterScore - hunterScore;
  let s = 20;
  if (rank === 1 && gap >= CONFIG.THRESHOLDS.competitionGap) s = 90; else if (rank === 1) s = 60; else if (rank <= 3) s = 45;
  return { score: clamp(s), gap, rank };
}

function scoreConfidence(raw) {
  const W = CONFIG.WEIGHTS;
  const entries = Object.entries(raw).filter(([k, v]) => typeof v === 'number' && W[k] !== undefined && k !== 'edge');
  const tw = entries.reduce((s, [k]) => s + W[k], 0);
  const geo = Math.exp(entries.reduce((s, [k, v]) => s + W[k] * Math.log(Math.max(v, 1)), 0) / tw);
  return { score: clamp(geo), minScore: Math.min(...entries.map(([, v]) => v)) };
}

function scoreConviction(raw, stage, stability) {
  if (raw.executionQuality < CONFIG.THRESHOLDS.executionHardFloor) return { score: 10, passesFinalTest: false };
  if (WATCHLIST_DEGRADED_STAGES.has(stage)) return { score: 10, passesFinalTest: false };
  if (stability < 50) return { score: 15, passesFinalTest: false };
  let c = 50;
  if (raw.structure >= 75) c += 10;
  if (raw.participation >= 70) c += 10;
  if (raw.momentum >= 70) c += 10;
  if (raw.marketContext >= 65) c += 8;
  if (raw.executionQuality >= 75) c += 15;
  if (raw.risk < 50) c -= 15;
  if (raw.marketContext < 40) c -= 10;
  const pass = raw.executionQuality >= 55 && raw.structure >= 50 && raw.risk >= 50 && stability >= 45;
  if (!pass) c = Math.min(c, 50);
  return { score: clamp(c), passesFinalTest: pass };
}

// 4h/12h agreement — the original called this but never defined it, so every
// asset with a pre-score of 55+ errored out. A small modifier, not a gate.
function htfContextModifier(trend4h, trend12h, direction) {
  let m = 0;
  for (const [t, w] of [[trend4h, 2], [trend12h, 2]]) {
    if (!t || t === 'flat') continue;
    m += t === direction ? w : -(w + 1);
  }
  return Math.max(-6, Math.min(4, m));
}

async function fetchHTFTrend(symbol, type) {
  let c4 = null, c12 = null;
  if (type === 'crypto') {
    const [a, b] = await Promise.all([bybitKlines(symbol, '240', 20), bybitKlines(symbol, '720', 20)]);
    c4 = a && a.map(c => c.close); c12 = b && b.map(c => c.close);
  } else {
    const h = await yahooChart(symbol, '1h', '5d');
    const closes = h ? h.map(c => c.close) : [];
    if (closes.length >= 8) { c4 = closes.slice(-8); c12 = closes.slice(-24); }
  }
  const dir = arr => {
    if (!arr || arr.length < 4) return 'flat';
    const mid = Math.floor(arr.length / 2);
    const a = arr.slice(0, mid).reduce((s, v) => s + v, 0) / mid;
    const b = arr.slice(mid).reduce((s, v) => s + v, 0) / (arr.length - mid);
    const pct = ((b - a) / a) * 100;
    return pct >= 1 ? 'up' : pct <= -1 ? 'down' : 'flat';
  };
  return { trend4h: dir(c4), trend12h: dir(c12) };
}

async function scoreAsset(symbol, type, candlesIn = null) {
  try {
    const candles = candlesIn || await fetchIntraday(symbol, type);
    if (!candles || candles.length < 50) return { symbol, assetType: type, rejectReason: 'Insufficient data', preEdgeScore: 0 };
    const ctx = scoreMarketContext(type);
    const structure = scoreStructure(candles);
    const part = scoreParticipation(candles);
    const momentum = scoreMomentum(candles);
    const stageInfo = classifyStage(candles);
    const execution = scoreExecutionQuality(candles);
    const execEngine = runExecutionEngine(candles, stageInfo, execution);
    const risk = scoreRisk(candles);
    const price = candles.at(-1).close;
    if (execEngine.hardReject) return { symbol, assetType: type, rejectReason: execEngine.rejectReason, preEdgeScore: 0, price, execEngine };
    const raw = {
      marketContext: ctx.score, structure: structure.score, participation: part.score, momentum: momentum.score,
      stage: stageInfo.score, executionQuality: execEngine.blendedScore, risk: risk.score,
    };
    const preApprox = structure.score * 0.15 + part.score * 0.15 + momentum.score * 0.15 + execEngine.blendedScore * 0.2 + risk.score * 0.1;
    let htfMod = 0;
    if (preApprox >= 55) {
      try {
        const htf = await fetchHTFTrend(symbol, type);
        htfMod = htfContextModifier(htf.trend4h, htf.trend12h, momentum.score >= 50 ? 'up' : 'down');
      } catch { /* non-blocking */ }
    }
    const W = CONFIG.WEIGHTS;
    const sum = raw.marketContext * W.marketContext + raw.structure * W.structure + raw.participation * W.participation +
      raw.momentum * W.momentum + raw.executionQuality * W.executionQuality + raw.risk * W.risk + raw.stage * W.stage;
    const wNoEdge = Object.values(W).reduce((a, b) => a + b, 0) - W.edge;
    const preEdgeScore = clamp(sum / wNoEdge + htfMod);
    const stability = scoreDecisionStability(candles);
    return {
      symbol, assetType: type, price, preEdgeScore, htfMod, rawScores: raw, stageInfo, execEngine, stability,
      confidence: scoreConfidence(raw), conviction: scoreConviction(raw, stageInfo.stage, stability.score),
      reasons: [...structure.reasons, ...part.reasons, ...momentum.reasons].slice(0, 6),
    };
  } catch (err) {
    return { symbol, assetType: type, rejectReason: `Error: ${err.message}`, preEdgeScore: 0 };
  }
}

// ============================================================
// REGIMES (BTC, QQQ, crypto breadth)
// ============================================================

async function fetchBTCRegime() {
  let c = await bybitKlines('BTCUSDT', '60', 60);
  if (!c || c.length < 20) c = await binanceKlines('BTCUSDT', '1h', 60);
  if (!c || c.length < 20) return STATE.btcRegime;
  const closes = c.map(x => x.close), last = closes.at(-1);
  const e20 = calcEMA(closes, 20).at(-1), e50 = calcEMA(closes, Math.min(50, closes.length - 1)).at(-1);
  const ch24 = ((last - (closes.length >= 24 ? closes.at(-24) : closes[0])) / (closes.length >= 24 ? closes.at(-24) : closes[0])) * 100;
  if (last > e20 && e20 > e50 && ch24 > -1) return 'BULL';
  if ((last < e20 && e20 < e50) || ch24 <= -1) return 'BEAR';
  return 'NEUTRAL';
}

async function fetchQQQRegime() {
  if (!isMarketOpen('us')) { STATE.qqqRegimeStale = true; return STATE.qqqRegime; }
  let c = await yahooChart('QQQ', '1h', '1mo');
  if (!c || c.length < 20) c = await alpacaBars('QQQ', '1Hour', 20);
  if (!c || c.length < 20) { STATE.qqqRegimeStale = true; return STATE.qqqRegime; }
  const closes = c.map(x => x.close), last = closes.at(-1);
  const e20 = calcEMA(closes, 20).at(-1), e50 = calcEMA(closes, Math.min(50, closes.length - 1)).at(-1);
  STATE.qqqRegimeStale = false;
  if (last > e20 && e20 > e50) return 'BULL';
  if (last < e20 && e20 < e50) return 'BEAR';
  return 'NEUTRAL';
}

async function fetchCryptoBreadth() {
  const majors = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'SUIUSDT'];
  let up = 0, n = 0;
  for (const s of majors) {
    const c = await bybitKlines(s, '15', 40);
    if (!c || c.length < 20) continue;
    const closes = c.map(x => x.close);
    if (closes.at(-1) > calcEMA(closes, 20).at(-1)) up++;
    n++;
  }
  return n ? Math.round((up / n) * 100) : STATE.cryptoBreadth;
}

// ============================================================
// UNIVERSE
// ============================================================

function listFromEnv(key, fallback) {
  const v = process.env[key];
  return v ? v.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : fallback;
}

async function buildUniverse() {
  let crypto = listFromEnv('TREND_CRYPTO', CORE_CRYPTO);
  try {
    const bases = await REVOLUT_BASES();
    if (bases && bases.size) crypto = crypto.filter(s => bases.has(s.replace(/USDT$/, '')));
  } catch { /* Revolut list unavailable: keep the curated list */ }
  const us = isMarketOpen('us') ? listFromEnv('TREND_US', CORE_US) : [];
  const lse = isMarketOpen('lse') ? listFromEnv('TREND_LSE', CORE_LSE) : [];
  return [
    ...crypto.map(symbol => ({ symbol, type: 'crypto' })),
    ...us.map(symbol => ({ symbol, type: 'us' })),
    ...lse.map(symbol => ({ symbol, type: 'lse' })),
  ];
}

// ============================================================
// SCAN (field analysis + decisions — original logic)
// ============================================================

async function runScan(universeIn = null) {
  STATE.cycleCount++;
  const [btc, qqq, breadth] = await Promise.all([
    fetchBTCRegime(), fetchQQQRegime(),
    STATE.cycleCount % 10 === 1 ? fetchCryptoBreadth() : Promise.resolve(STATE.cryptoBreadth),
  ]);
  STATE.btcRegime = btc; STATE.qqqRegime = qqq; STATE.cryptoBreadth = breadth;

  const universe = universeIn || await buildUniverse();
  const results = await mapLimit(universe, CONFIG.concurrency, a => scoreAsset(a.symbol, a.type));

  const valid = results.filter(r => r.preEdgeScore > 0).map(r => r.preEdgeScore);
  const real = valid.filter(s => s !== 50);
  const field = real.length >= 10 ? real : valid;
  STATE.fieldAverage = field.length ? field.reduce((a, b) => a + b, 0) / field.length : 55;

  const scored = results.filter(r => r.preEdgeScore > 0).map(r => {
    const edgeResult = scoreEdge(r.preEdgeScore);
    return { ...r, edgeResult, hunterScore: clamp(r.preEdgeScore * (1 - CONFIG.WEIGHTS.edge) + edgeResult.score * CONFIG.WEIGHTS.edge) };
  }).sort((a, b) => b.hunterScore - a.hunterScore);
  STATE.candidateHistory = scored.map(s => ({ symbol: s.symbol, hunterScore: s.hunterScore }));

  const btcNow = scored.find(s => s.symbol === 'BTCUSDT')?.hunterScore || 0;
  const btcPrior = STATE.btcScoreHistory.length ? STATE.btcScoreHistory.at(-1) : btcNow;
  const btcSurging = btcNow - btcPrior >= 8 && btcNow >= 60;
  STATE.btcScoreHistory = [...STATE.btcScoreHistory, btcNow].slice(-5);

  const T = CONFIG.THRESHOLDS;
  const candidates = scored.map(r => {
    const comp = scoreCompetition(r.symbol, r.hunterScore);
    let base = r.hunterScore * 0.9 + comp.score * 0.1;
    if (btcSurging && r.symbol !== 'BTCUSDT' && L1_SECTORS.has(SECTOR_MAP[r.symbol])) base = Math.min(100, base + 8);
    const finalScore = clamp(base);
    const flags = [];
    const execFloor = [SETUP.BREAKOUT, SETUP.IGNITION].includes(r.execEngine?.setupType) ? 50 : T.executionHardFloor;
    if ((r.rawScores.executionQuality || 0) < execFloor) flags.push('execution');
    if ((r.confidence.score || 0) < T.confidenceMinimum) flags.push('confidence');
    if ((r.conviction.score || 0) < T.convictionMinimum) flags.push('conviction');
    if ((r.edgeResult.edge || 0) < T.edgeMinimumOverField) flags.push('edge');
    if ((r.rawScores.structure || 0) < 55) flags.push('structure');
    if ((r.rawScores.risk || 0) < 50) flags.push('risk');
    if (comp.rank > 5) flags.push(`rank#${comp.rank}`);
    let decision = 'OBSERVE';
    if (!flags.length) {
      let adj = finalScore;
      if (comp.rank === 1 && comp.gap >= T.competitionGap) adj = Math.min(100, adj + T.competitionBonus);
      decision = adj >= T.hunterScoreGood ? 'OPEN' : adj >= T.hunterScoreWatch ? 'WATCH' : 'DEVELOPING';
    } else if (finalScore >= 65) decision = 'CONFIRMED';
    else if (finalScore >= 55) decision = 'DEVELOPING';
    return { ...r, comp, finalScore, decision, flags };
  }).sort((a, b) => b.finalScore - a.finalScore);

  const stats = { crypto: [0, 0], us: [0, 0], lse: [0, 0] };
  for (const r of results) if (stats[r.assetType]) stats[r.assetType][r.preEdgeScore > 0 || (r.rejectReason && !/Insufficient|Error/.test(r.rejectReason)) ? 0 : 1]++;
  const top = candidates.slice(0, 3).map(c => `${labelOf(c.symbol)} ${round2(c.finalScore)}`).join(', ');
  log(`scan ${STATE.cycleCount}: BTC=${btc} QQQ=${STATE.qqqRegimeStale ? 'closed' : qqq} breadth=${breadth}% · scored crypto ${stats.crypto[0]}/${stats.crypto[0] + stats.crypto[1]}, US ${stats.us[0]}/${stats.us[0] + stats.us[1]}, LSE ${stats.lse[0]}/${stats.lse[0] + stats.lse[1]} · field ${round2(STATE.fieldAverage)} · top ${top || 'none'}`);

  STATE.lastScan = { at: Date.now(), candidates, results };
  return STATE.lastScan;
}

// ============================================================
// DB HELPERS (Neon via Hunter's supabase-style client)
// ============================================================

async function q(promise, what) {
  try {
    const { data, error } = await promise;
    if (error) { log(`db ${what}: ${error.message || error}`); return null; }
    return data;
  } catch (e) { log(`db ${what}: ${e.message}`); return null; }
}
async function w(promise, what) {
  try {
    const { error } = await promise;
    if (error) { log(`db ${what}: ${error.message || error}`); return false; }
    return true;
  } catch (e) { log(`db ${what}: ${e.message}`); return false; }
}
async function kvGet(key) { const d = await q(DB.from('trend_kv').select('value').eq('key', key).maybeSingle(), 'kvGet'); return d ? d.value : null; }
async function kvSet(key, value) { await w(DB.from('trend_kv').upsert({ key, value: String(value), updated_at: new Date().toISOString() }, { onConflict: 'key' }), 'kvSet'); }

async function saveLeaderboard(candidates) {
  if (!DB || !candidates.length) return;
  const now = new Date().toISOString();
  const id = `lb_${Date.now()}`;
  const rows = candidates.map((c, i) => ({
    snapshot_id: id, snapshot_time: now, rank: i + 1, symbol: c.symbol, asset_type: c.assetType,
    score: round2(c.finalScore), price: c.price, decision: c.decision,
    btc_regime: STATE.btcRegime, qqq_regime: STATE.qqqRegimeStale ? 'CLOSED' : STATE.qqqRegime,
  }));
  await w(DB.from('trend_leaderboard').insert(rows), 'leaderboard insert');
  const cutoff = new Date(Date.now() - CONFIG.leaderboardRetentionDays * 86400000).toISOString();
  if (STATE.cycleCount % 36 === 0) await w(DB.from('trend_leaderboard').delete().lt('snapshot_time', cutoff), 'leaderboard prune');
}

async function recordEvent(kind, c, detail = {}) {
  if (!DB) return;
  await w(DB.from('trend_events').insert({
    kind, symbol: c.symbol, asset_type: c.assetType, score: round2(c.finalScore || 0), price: c.price ?? null,
    detail: JSON.stringify(detail), created_at: new Date().toISOString(),
  }), 'event insert');
}

// ============================================================
// CANDIDATE STATE MACHINE (EARLY -> DEVELOPING -> CONFIRMED)
// ============================================================

function updateCandidateState(symbol, score) {
  const ex = STATE.candidateStates.get(symbol);
  if (score < FSM_FLOOR) {
    if (ex && ++ex.scansBelowFloor >= FSM_DROP_SCANS) { STATE.candidateStates.delete(symbol); return { state: null, transition: 'DROPPED', prev: ex.state }; }
    return { state: ex ? ex.state : null, transition: null };
  }
  if (!ex) {
    STATE.candidateStates.set(symbol, { state: 'EARLY', persistence: 1, firstSeen: Date.now(), peakScore: score, scansBelowFloor: 0 });
    return { state: 'EARLY', transition: 'NEW', prev: null };
  }
  ex.persistence++; ex.peakScore = Math.max(ex.peakScore, score); ex.scansBelowFloor = 0;
  const prev = ex.state;
  if (ex.state === 'EARLY' && ex.persistence >= FSM_DEVELOPING) { ex.state = 'DEVELOPING'; return { state: ex.state, transition: 'EARLY->DEVELOPING', prev }; }
  if (ex.state === 'DEVELOPING' && ex.persistence >= FSM_CONFIRMED && score >= FSM_CONFIRM_SCORE) { ex.state = 'CONFIRMED'; return { state: ex.state, transition: 'DEVELOPING->CONFIRMED', prev }; }
  return { state: ex.state, transition: null, prev };
}

// ============================================================
// WATCHLIST LIFECYCLE (posted to Discord)
// ============================================================

async function watchPost(text) {
  const day = utcDay();
  if (STATE.watchPosts.day !== day) STATE.watchPosts = { day, n: 0 };
  if (STATE.watchPosts.n >= CONFIG.maxWatchPostsPerDay) return false;
  STATE.watchPosts.n++;
  await NOTIFY(text);
  return true;
}

function fsmTag(symbol) {
  const s = STATE.candidateStates.get(symbol);
  return s ? `${s.state} (${s.persistence} scans)` : 'EARLY';
}

async function processWatchlistLifecycle(candidates) {
  const now = Date.now();
  const buy = CONFIG.THRESHOLDS.hunterScoreGood, watch = CONFIG.THRESHOLDS.hunterScoreWatch;
  const by = new Map(candidates.map(c => [c.symbol, c]));
  const handled = new Set(); // removed/graduated this pass: don't re-add in the same scan

  for (const [symbol, st] of STATE.watchlistState.entries()) {
    const c = by.get(symbol);
    if (!c) {
      if (now - st.lastSeen > WATCHLIST_STALE_MS) STATE.watchlistState.delete(symbol);
      continue;
    }
    st.lastSeen = now;
    const score = c.finalScore, stage = c.stageInfo?.stage || 'UNKNOWN';
    const t = c.assetType;
    if (score >= buy) {
      STATE.watchlistState.delete(symbol);
      handled.add(symbol);
      await watchPost([`🎯 TREND WATCHLIST — ${flagOf(t)} ${labelOf(symbol)} reached ${round2(score)}`, '',
        `Score is past the ${buy} line (from ${round2(st.createdScore)} when added). State: ${fsmTag(symbol)}.`,
        `Price: ${fmtPx(c.price, t)}`, `The daily trend check (after ${CONFIG.dailyRunUtcHour}:00 UTC) decides whether it's an OPEN.`].join('\n'));
      await recordEvent('WATCH_GRADUATED', c, { from: st.createdScore });
      continue;
    }
    const drop = st.peakScore - score;
    const degraded = WATCHLIST_DEGRADED_STAGES.has(stage) && !WATCHLIST_DEGRADED_STAGES.has(st.stage);
    if (drop >= WATCHLIST_REMOVE_SCORE_DROP || degraded) {
      STATE.watchlistState.delete(symbol);
      handled.add(symbol);
      await watchPost([`❌ TREND WATCHLIST — ${flagOf(t)} ${labelOf(symbol)} removed`, '',
        degraded ? `Stage turned ${stage}.` : `Score fell to ${round2(score)} (peak ${round2(st.peakScore)}).`].join('\n'));
      await recordEvent('WATCH_REMOVED', c, { peak: st.peakScore, stage });
      if (DB) await w(DB.from('trend_watchlist').delete().eq('symbol', symbol), 'watch remove');
      continue;
    }
    const gap = buy - score;
    const improved = score >= st.lastAlertScore + WATCHLIST_UPDATE_SCORE_DELTA;
    const nearNow = gap <= WATCHLIST_NEAR_TRIGGER_GAP && st.lastAlertGap > WATCHLIST_NEAR_TRIGGER_GAP;
    if (improved || nearNow) {
      await watchPost([`⬆️ TREND WATCHLIST — ${flagOf(t)} ${labelOf(symbol)} ${round2(st.lastAlertScore)} → ${round2(score)}`, '',
        nearNow ? `Within ${round2(gap)} points of the ${buy} line.` : `Improving. ${round2(gap)} points to go.`,
        `State: ${fsmTag(symbol)} · stage ${stage} · price ${fmtPx(c.price, t)}`].join('\n'));
      st.lastAlertScore = score; st.lastAlertGap = gap;
    }
    st.stage = stage; st.peakScore = Math.max(st.peakScore, score);
  }

  for (const c of candidates) {
    if (c.decision !== 'WATCH' || c.finalScore < watch || c.finalScore >= buy) continue;
    if (STATE.watchlistState.has(c.symbol) || handled.has(c.symbol)) continue;
    const stage = c.stageInfo?.stage || 'UNKNOWN';
    if (WATCHLIST_DEGRADED_STAGES.has(stage)) continue;
    STATE.watchlistState.set(c.symbol, { stage, createdScore: c.finalScore, peakScore: c.finalScore, lastAlertScore: c.finalScore, lastAlertGap: buy - c.finalScore, lastSeen: now });
    const t = c.assetType;
    await watchPost([`👀 TREND WATCHLIST — ${flagOf(t)} ${labelOf(c.symbol)} added at ${round2(c.finalScore)}`, '',
      `Clean setup, ${round2(buy - c.finalScore)} points below the ${buy} line. Stage ${stage} · ${fsmTag(c.symbol)}.`,
      ...(c.reasons || []).slice(0, 3).map(r => `· ${r}`), `Price: ${fmtPx(c.price, t)}`, sectorLine(c.symbol)].filter(Boolean).join('\n'));
    await recordEvent('WATCH_ADDED', c, { stage });
    if (DB) await w(DB.from('trend_watchlist').upsert({ symbol: c.symbol, asset_type: t, last_score: round2(c.finalScore), last_seen: new Date().toISOString(), watch_reason: `${stage} — score ${round2(c.finalScore)}`, source: 'lifecycle' }, { onConflict: 'symbol' }), 'watch add');
  }
}

// ============================================================
// MOMENTUM EVENT LANE
// ============================================================

async function checkMomentumEvents(candidates) {
  const day = utcDay();
  for (const c of candidates) {
    const prior = STATE.lastPrices.get(c.symbol);
    STATE.lastPrices.set(c.symbol, { price: c.price, at: Date.now() });
    if (!prior || !(prior.price > 0) || !(c.price > 0)) continue;
    if (Date.now() - prior.at > 3 * CONFIG.cycleMs) continue; // "since the last scan", not since yesterday
    if (c.finalScore < MOMENTUM_SCORE_MIN) continue;
    const move = ((c.price - prior.price) / prior.price) * 100;
    if (move < MOMENTUM_MOVE_PCT) continue;
    const key = `${c.symbol}:${day}`;
    if (STATE.momentumSent.has(key)) continue;
    STATE.momentumSent.add(key);
    const t = c.assetType;
    await NOTIFY([`🚨 MOMENTUM EVENT — ${flagOf(t)} ${labelOf(c.symbol)}`, '',
      `Up ${round2(move)}% since the last scan (${fmtPx(prior.price, t)} → ${fmtPx(c.price, t)}).`,
      `Hunter score: ${round2(c.finalScore)}`, sectorLine(c.symbol), '',
      'A large abnormal move, not a standard OPEN signal. Tracked for 24h.'].filter(Boolean).join('\n'));
    await recordEvent('MOMENTUM_EVENT', c, { move: round2(move), from: prior.price });
    log(`momentum event ${c.symbol} +${round2(move)}%`);
  }
  if (STATE.momentumSent.size > 500) STATE.momentumSent = new Set([...STATE.momentumSent].filter(k => k.endsWith(day)));
}

// 24h follow-up price for momentum events (evidence for the weekly review).
async function labelEventOutcomes() {
  if (!DB) return;
  const from = new Date(Date.now() - 7 * 86400000).toISOString();
  const to = new Date(Date.now() - 24 * 3600000).toISOString();
  const rows = await q(DB.from('trend_events').select('id, symbol, asset_type, price, created_at, price_24h').eq('kind', 'MOMENTUM_EVENT').gte('created_at', from).lte('created_at', to).limit(50), 'events load');
  for (const r of rows || []) {
    if (r.price_24h != null || !(r.price > 0)) continue;
    const c = await fetchDailyCandles(r.symbol, r.asset_type);
    const px = c.length ? c.at(-1).close : null;
    if (!px) continue;
    await w(DB.from('trend_events').update({ price_24h: px, ret_24h: round2(((px - r.price) / r.price) * 100) }).eq('id', r.id), 'event label');
  }
}

// ============================================================
// PORTFOLIO MANAGER — daily-timeframe technicals (original)
// ============================================================

function pmSMA(closes, n) { return closes.length < n ? null : closes.slice(-n).reduce((a, b) => a + b, 0) / n; }
function pmATR(candles, n = 14) {
  if (candles.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  const r = trs.slice(-n);
  return r.reduce((a, b) => a + b, 0) / r.length;
}
function pmFindSwingLow(candles, lookback = 20) {
  const s = candles.slice(-lookback);
  let low = null;
  for (let i = 1; i < s.length - 1; i++) if (s[i].low < s[i - 1].low && s[i].low < s[i + 1].low && (low === null || s[i].low < low)) low = s[i].low;
  return low;
}
function pmCountDistributionDays(candles, lookback = 10) {
  const s = candles.slice(-lookback - 1);
  let n = 0;
  for (let i = 1; i < s.length; i++) if (((s[i].close - s[i - 1].close) / s[i - 1].close) * 100 < -0.2 && s[i].volume > s[i - 1].volume) n++;
  return n;
}
function pmIsLowVolumePullback(candles, lookback = 5) {
  if (candles.length < lookback + 1) return false;
  const r = candles.slice(-(lookback + 1));
  const avg = r.slice(0, -1).reduce((a, c) => a + c.volume, 0) / lookback;
  const last = r.at(-1), prev = r.at(-2);
  return (last.close - prev.close) / prev.close < 0 && last.volume < avg * 0.8;
}
const atrMultFor = t => (t === 'crypto' ? PM.CLOSE_ATR_MULT_CRYPTO : t === 'lse' ? PM.CLOSE_ATR_MULT_LSE : PM.CLOSE_ATR_MULT_STOCK);

function pmEvaluateOpenGates(symbol, assetType, snapshots, candles) {
  const reasons = [], failed = [];
  const recent = snapshots.slice(-PM.OPEN_SCORE_SNAPSHOTS);
  const above = recent.filter(s => s.score >= PM.OPEN_MIN_SCORE).length;
  const scores = snapshots.map(s => s.score);
  const peak = Math.max(...scores);
  const last3 = scores.slice(-3);
  const rising = last3.length >= 2 && last3.at(-1) > last3[0];
  const top5 = snapshots.filter(s => s.rank <= 5).length;
  if (above < PM.OPEN_SCORE_MIN_COUNT) failed.push(`Score ≥ ${PM.OPEN_MIN_SCORE} in only ${above} of the last ${PM.OPEN_SCORE_SNAPSHOTS} snapshots`);
  else reasons.push(`Score ≥ ${PM.OPEN_MIN_SCORE} in ${above} of the last ${PM.OPEN_SCORE_SNAPSHOTS} snapshots`);
  if (!rising) failed.push('Score not rising across the last 3 snapshots'); else reasons.push(`Score rising: ${round2(last3[0])} → ${round2(last3.at(-1))}`);
  if (peak < PM.OPEN_MIN_HUNTER_SCORE_PEAK) failed.push(`Peak score ${round2(peak)} below ${PM.OPEN_MIN_HUNTER_SCORE_PEAK}`); else reasons.push(`Peak score ${round2(peak)}`);
  if (top5 < PM.OPEN_TOP5_MIN_COUNT) failed.push(`Top-5 appearances: ${top5} (need ${PM.OPEN_TOP5_MIN_COUNT})`); else reasons.push(`Top-5 appearances in 14 days: ${top5}`);

  if (candles.length >= 50) {
    const closes = candles.map(c => c.close), last = closes.at(-1);
    const ma20 = pmSMA(closes, 20), ma50 = pmSMA(closes, 50);
    const yr = closes.slice(-252);
    const hi = Math.max(...yr), lo = Math.min(...yr);
    const fromHigh = ((hi - last) / hi) * 100, range = ((hi - lo) / lo) * 100;
    if (last < ma50) failed.push(`Price below the 50-day average (${fmtPx(last, assetType)} < ${fmtPx(ma50, assetType)})`); else reasons.push('Price above the 50-day average');
    if (fromHigh > PM.OPEN_52W_MAX_PCT_FROM_HIGH) failed.push(`${round2(fromHigh)}% below the 52-week high (max ${PM.OPEN_52W_MAX_PCT_FROM_HIGH}%)`); else reasons.push(fromHigh < 1 ? 'At its 52-week high' : `Within ${round2(fromHigh)}% of the 52-week high`);
    if (range < PM.OPEN_52W_MIN_RANGE_PCT) failed.push(`52-week range only ${round2(range)}% (need ${PM.OPEN_52W_MIN_RANGE_PCT}%)`); else reasons.push(`52-week range ${round2(range)}%`);
    if (ma20 < ma50) failed.push('20-day average below the 50-day — trend not established'); else reasons.push('20-day average above the 50-day — uptrend');
  } else if (assetType !== 'crypto') failed.push('Not enough daily data for the trend check');
  else reasons.push('Limited daily history — score-based trend only');

  if (candles.length >= 11) {
    const d10 = pmCountDistributionDays(candles, 10), d5 = pmCountDistributionDays(candles, 5);
    if (d10 >= PM.HOLD_MAX_DIST_DAYS) failed.push(`${d10} distribution days in 10 sessions — heavy selling`); else reasons.push(`Distribution days ${d10}/10`);
    if (d5 >= PM.HOLD_DIST_CLUSTER_MAX) failed.push(`${d5} distribution days in 5 sessions — cluster selling`);
  }
  if (candles.length >= 5) {
    const vol5 = candles.slice(-5).reduce((a, c) => a + c.volume, 0) / 5, last = candles.at(-1).close;
    if (assetType === 'crypto') {
      const usd = vol5 * last;
      if (usd < PM.OPEN_CRYPTO_MIN_VOL_USD) failed.push(`Daily volume ~$${Math.round(usd / 1e6)}M below $10M`); else reasons.push(`Daily volume ~$${Math.round(usd / 1e6)}M`);
    } else if (assetType === 'us') {
      if (last < PM.OPEN_STOCK_MIN_PRICE) failed.push(`Price $${round2(last)} below $${PM.OPEN_STOCK_MIN_PRICE}`);
      if (vol5 < PM.OPEN_STOCK_MIN_ADV) failed.push(`Average volume ${Math.round(vol5 / 1000)}k below ${PM.OPEN_STOCK_MIN_ADV / 1000}k`); else reasons.push(`Average volume ${Math.round(vol5 / 1000)}k shares`);
    } else if (vol5 < PM.OPEN_LSE_MIN_ADV) failed.push(`Average volume ${Math.round(vol5 / 1000)}k below ${PM.OPEN_LSE_MIN_ADV / 1000}k`);
    else reasons.push(`Average volume ${Math.round(vol5 / 1000)}k shares`);
  }
  return { pass: failed.length === 0, reasons, gatesFailed: failed };
}

function pmEvaluateCloseTriggers(position, candles, currentScore, peakInPosition) {
  if (!candles || candles.length < 10) return { close: false, evidence: { note: 'insufficient candle data' } };
  const closes = candles.map(c => c.close), last = closes.at(-1);
  const ma20 = pmSMA(closes, 20), ma50 = pmSMA(closes, 50);
  const ev = { currentScore, peakInPosition, lastClose: last, ma50 };
  const inGrace = (Date.now() - new Date(position.opened_at).getTime()) / 86400000 < PM.HOLD_NEW_POSITION_GRACE;
  if (pmIsLowVolumePullback(candles, 5)) return { close: false, evidence: { ...ev, lowVolPullback: true } };
  const trendIntact = ma20 && ma50 && ma20 > ma50;
  if (position.atr_stop && last < Number(position.atr_stop)) return { close: true, reason: 'ATR trailing stop breached', trigger: 'ATR_STOP', evidence: ev };
  if (ma50 && last < ma50 * (1 - PM.HOLD_MA50_BUFFER_PCT / 100) && pmCountDistributionDays(candles, 5) >= 2 && !trendIntact) {
    return { close: true, reason: `Price ${round2(((ma50 - last) / ma50) * 100)}% below the 50-day average on selling`, trigger: 'MA50_BREAK', evidence: ev };
  }
  if (position.swing_low_stop && last < Number(position.swing_low_stop)) return { close: true, reason: `Swing low broken (${fmtPx(Number(position.swing_low_stop), position.asset_type)})`, trigger: 'SWING_LOW_BREAK', evidence: ev };
  const d10 = pmCountDistributionDays(candles, 10), d5 = pmCountDistributionDays(candles, 5);
  if (d10 >= PM.CLOSE_DIST_COUNT) return { close: true, reason: `${d10} distribution days in 10 sessions — sellers in control`, trigger: 'DISTRIBUTION_COUNT', evidence: ev };
  if (d5 >= PM.CLOSE_DIST_CLUSTER) return { close: true, reason: `${d5} distribution days in 5 sessions`, trigger: 'DISTRIBUTION_CLUSTER', evidence: ev };
  if (!inGrace && currentScore != null) {
    if (peakInPosition - currentScore >= PM.CLOSE_SCORE_DROP_FROM_PEAK && currentScore < PM.CLOSE_SCORE_FLOOR) {
      return { close: true, reason: `Score collapsed: ${round2(peakInPosition)} → ${round2(currentScore)}`, trigger: 'SCORE_COLLAPSE', evidence: ev };
    }
    if (currentScore < PM.CLOSE_SCORE_FLOOR && closes.at(-1) < closes.at(-3) && !trendIntact) {
      return { close: true, reason: `Score ${round2(currentScore)} under ${PM.CLOSE_SCORE_FLOOR} with price and trend deteriorating`, trigger: 'SCORE_AND_PRICE', evidence: ev };
    }
  }
  return { close: false, evidence: ev };
}

// ── Position storage ──

async function getOpenPositions() {
  return (await q(DB.from('trend_positions').select('*').eq('status', 'open').order('opened_at', { ascending: true }), 'positions load')) || [];
}

async function openPosition(symbol, type, score, price, atrStop, swingLow, reasons) {
  const now = new Date().toISOString();
  const row = {
    symbol, asset_type: type, status: 'open', opened_at: now, entry_price: price, last_price: price, max_price: price, min_price: price,
    entry_score: round2(score), peak_score: round2(score), atr_stop: atrStop ? roundPrice(atrStop) : null,
    swing_low_stop: swingLow ? roundPrice(swingLow) : null, entry_evidence: JSON.stringify({ reasons }), updated_at: now,
  };
  const ok = await w(DB.from('trend_positions').insert(row), 'position open');
  if (!ok) return false;
  await w(DB.from('trend_decisions').insert({ symbol, asset_type: type, decision: 'OPEN', score: round2(score), price, evidence: JSON.stringify({ reasons }), decided_at: now }), 'decision');
  return true;
}

async function closePosition(pos, price, score, reason, evidence) {
  const now = new Date().toISOString();
  const entry = Number(pos.entry_price);
  const ret = entry > 0 && price > 0 ? round2(((price - entry) / entry) * 100) : null;
  const ok = await w(DB.from('trend_positions').update({ status: 'closed', closed_at: now, exit_price: price, return_pct: ret, close_reason: reason, updated_at: now }).eq('id', pos.id).eq('status', 'open'), 'position close');
  if (!ok) return false;
  await w(DB.from('trend_decisions').insert({ symbol: pos.symbol, asset_type: pos.asset_type, decision: 'CLOSE', score: score != null ? round2(score) : null, price, evidence: JSON.stringify({ reason, ...evidence }), decided_at: now }), 'decision');
  await w(DB.from('trend_watchlist').delete().eq('symbol', pos.symbol), 'watch remove');
  return { ret };
}

// ── Messages ──

const DISCLAIMER = 'Educational analysis only — not financial advice. Capital at risk.';

function openMessage(symbol, type, score, price, reasons, atrStop, swingLow) {
  const stop = Math.max(atrStop || 0, swingLow || 0) || null; // whichever is hit first
  const order = [/Score rising/, /52-week high/, /20-day average above/, /above the 50-day/, /volume/i, /Top-5/, /Peak score/];
  const best = [...reasons].sort((a, b) => {
    const ia = order.findIndex(r => r.test(a)), ib = order.findIndex(r => r.test(b));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  }).slice(0, 5);
  return [
    `🟢 TREND OPEN — ${flagOf(type)} ${labelOf(symbol)}`, '',
    `Entry: around ${fmtPx(price, type)}${type === 'crypto' ? '' : ' (last close — fills at the next open)'}`,
    `Hunter score: ${round2(score)}`,
    sectorLine(symbol) || null, '',
    'Why Hunter likes it:', ...best.map(r => `· ${r}`), '',
    stop ? `Exit if it drops below ${fmtPx(stop, type)} (${round2(((price - stop) / price) * 100)}% below entry). Hunter checks every scan and raises the stop as the trend runs.` : null,
    atrStop && swingLow ? `(ATR stop ${fmtPx(atrStop, type)} · swing low ${fmtPx(swingLow, type)})` : null,
    'A hold-for-the-trend position: you will only hear again on a CLOSE.', '', DISCLAIMER,
  ].filter(x => x !== null).join('\n');
}

function closeMessage(pos, price, reason, ret) {
  const t = pos.asset_type;
  const days = Math.max(0, Math.round((Date.now() - new Date(pos.opened_at).getTime()) / 86400000));
  return [
    `🔴 TREND CLOSE — ${flagOf(t)} ${labelOf(pos.symbol)}`, '',
    `Why: ${reason}`,
    `Entry ${fmtPx(Number(pos.entry_price), t)} → exit ${fmtPx(price, t)}${ret != null ? ` (${ret >= 0 ? '+' : ''}${ret}%)` : ''}`,
    `Held ${days} day${days === 1 ? '' : 's'}.`, '',
    'No action needed until the next OPEN.', '', DISCLAIMER,
  ].join('\n');
}

// ── Live price for open positions (each scan) ──

async function livePrice(pos) {
  const c = STATE.lastScan && STATE.lastScan.results.find(r => r.symbol === pos.symbol && r.price > 0);
  if (c) return c.price;
  if (pos.asset_type === 'crypto') {
    const k = await bybitKlines(pos.symbol, '15', 2);
    return k && k.length ? k.at(-1).close : null;
  }
  return null; // stocks outside market hours: no new price
}

// Price stops each scan (ATR trailing stop, swing low) + mark-to-market.
async function checkOpenPositionStops() {
  if (!DB) return;
  const positions = await getOpenPositions();
  for (const pos of positions) {
    if (pos.asset_type !== 'crypto' && !isMarketOpen(pos.asset_type)) continue;
    const px = await livePrice(pos);
    if (!(px > 0)) continue;
    const patch = { last_price: px, updated_at: new Date().toISOString() };
    if (!(Number(pos.max_price) >= px)) patch.max_price = px;
    if (!(Number(pos.min_price) <= px)) patch.min_price = px;
    const atr = Number(pos.atr_stop), swing = Number(pos.swing_low_stop);
    const hit = atr > 0 && px < atr ? `ATR trailing stop breached (${fmtPx(atr, pos.asset_type)})`
      : swing > 0 && px < swing ? `Swing low broken (${fmtPx(swing, pos.asset_type)})` : null;
    if (hit) {
      log(`stop hit ${pos.symbol} @ ${px}: ${hit}`);
      const done = await closePosition(pos, px, null, hit, { trigger: 'INTRADAY_STOP', price: px });
      if (done) await NOTIFY(closeMessage(pos, px, hit, done.ret));
      continue;
    }
    await w(DB.from('trend_positions').update(patch).eq('id', pos.id), 'mark');
  }
}

// ── Daily run ──

async function loadLeaderboardHistory() {
  const since = new Date(Date.now() - PM.LEADERBOARD_DAYS * 86400000).toISOString();
  const rows = await q(DB.from('trend_leaderboard').select('symbol, asset_type, rank, score, snapshot_time').gte('snapshot_time', since).order('snapshot_time', { ascending: true }), 'leaderboard load');
  const map = new Map();
  for (const r of rows || []) {
    if (!map.has(r.symbol)) map.set(r.symbol, { symbol: r.symbol, assetType: r.asset_type, snapshots: [] });
    map.get(r.symbol).snapshots.push({ score: Number(r.score), rank: Number(r.rank), time: r.snapshot_time });
  }
  return map;
}

async function runPortfolioManager() {
  if (!DB) return;
  log('portfolio manager: daily run');
  const [positions, history] = await Promise.all([getOpenPositions(), loadLeaderboardHistory()]);
  if (!history.size) { log('portfolio manager: no leaderboard history yet — first OPENs need a few days of snapshots'); }

  // 1. HOLD or CLOSE
  for (const pos of positions) {
    const data = history.get(pos.symbol);
    const snaps = data ? data.snapshots : [];
    const current = snaps.length ? snaps.at(-1).score : null;
    const peak = Math.max(Number(pos.peak_score || pos.entry_score || 0), ...snaps.map(s => s.score));
    const candles = await fetchDailyCandles(pos.symbol, pos.asset_type);
    if (candles.length >= 15) {
      const atr = pmATR(candles, 14);
      if (atr) {
        const newStop = roundPrice(candles.at(-1).close - atrMultFor(pos.asset_type) * atr);
        if (newStop > Number(pos.atr_stop || 0)) {
          pos.atr_stop = newStop;
          await w(DB.from('trend_positions').update({ atr_stop: newStop, peak_score: round2(peak), updated_at: new Date().toISOString() }).eq('id', pos.id), 'stop raise');
        }
      }
    }
    const res = pmEvaluateCloseTriggers(pos, candles, current, peak);
    if (res.close) {
      const px = candles.at(-1).close;
      const done = await closePosition(pos, px, current, res.reason, { trigger: res.trigger, ...res.evidence });
      if (done) await NOTIFY(closeMessage(pos, px, res.reason, done.ret));
      log(`CLOSE ${pos.symbol}: ${res.reason}`);
    } else {
      await w(DB.from('trend_decisions').insert({ symbol: pos.symbol, asset_type: pos.asset_type, decision: 'HOLD', score: current, price: candles.at(-1)?.close ?? null, evidence: JSON.stringify(res.evidence), decided_at: new Date().toISOString() }), 'hold');
      log(`HOLD ${pos.symbol} (score ${current ?? 'n/a'})`);
    }
  }

  // 2. OPEN candidates
  const stillOpen = await getOpenPositions();
  const held = new Set(stillOpen.map(p => p.symbol));
  let slots = Math.max(0, CONFIG.maxOpenPositions - stillOpen.length);
  let opened = 0;
  const cands = [...history.values()]
    .filter(d => !held.has(d.symbol) && d.snapshots.length >= PM.OPEN_SCORE_SNAPSHOTS)
    .filter(d => d.snapshots.at(-1).score >= PM.WATCH_MIN_SCORE && Math.max(...d.snapshots.map(s => s.score)) >= PM.OPEN_MIN_HUNTER_SCORE_PEAK)
    .sort((a, b) => b.snapshots.at(-1).score - a.snapshots.at(-1).score)
    .slice(0, 15);

  for (const d of cands) {
    const candles = await fetchDailyCandles(d.symbol, d.assetType);
    const score = d.snapshots.at(-1).score;
    const g = pmEvaluateOpenGates(d.symbol, d.assetType, d.snapshots, candles);
    if (g.pass && slots > 0 && opened < CONFIG.maxOpensPerRun && candles.length) {
      const px = candles.at(-1).close;
      const atr = candles.length >= 15 ? pmATR(candles, 14) : null;
      const atrStop = atr ? px - atrMultFor(d.assetType) * atr : null;
      const swing = pmFindSwingLow(candles, 20);
      if (await openPosition(d.symbol, d.assetType, score, px, atrStop, swing && swing < px ? swing : null, g.reasons)) {
        opened++; slots--;
        await w(DB.from('trend_watchlist').delete().eq('symbol', d.symbol), 'watch remove');
        await NOTIFY(openMessage(d.symbol, d.assetType, score, px, g.reasons, atrStop, swing && swing < px ? swing : null));
        log(`OPEN ${d.symbol} @ ${roundPrice(px)} (score ${round2(score)})`);
      }
    } else if (!g.pass) {
      const top5 = d.snapshots.filter(s => s.rank <= 5).length;
      if (PM.OPEN_MIN_SCORE - score <= PM.WATCH_MAX_SCORE_BELOW_OPEN && top5 >= PM.WATCH_TOP5_MIN) {
        await w(DB.from('trend_watchlist').upsert({ symbol: d.symbol, asset_type: d.assetType, last_score: round2(score), last_seen: new Date().toISOString(), watch_reason: `Near OPEN: ${g.gatesFailed[0]}`, source: 'daily' }, { onConflict: 'symbol' }), 'watch upsert');
      }
    }
  }
  log(`portfolio manager: ${stillOpen.length} held, ${opened} opened, ${cands.length} candidates checked`);

  // 3. Sunday review
  if (new Date().getUTCDay() === 0) await NOTIFY(await weeklyReview());
}

async function weeklyReview() {
  const positions = await getOpenPositions();
  const watch = (await q(DB.from('trend_watchlist').select('*').gte('last_seen', new Date(Date.now() - PM.WATCH_STALE_DAYS * 86400000).toISOString()), 'watch load')) || [];
  const closed = (await q(DB.from('trend_positions').select('symbol, asset_type, return_pct, closed_at, close_reason').eq('status', 'closed').order('closed_at', { ascending: false }).limit(200), 'closed load')) || [];
  const events = (await q(DB.from('trend_events').select('symbol, ret_24h').eq('kind', 'MOMENTUM_EVENT').gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString()), 'events')) || [];
  const lines = [`📊 TREND LANE — WEEKLY REVIEW ${utcDay()}`, ''];
  if (!positions.length) lines.push('Positions: none open.');
  else {
    lines.push('Positions (HOLD):');
    for (const p of positions) {
      const t = p.asset_type, e = Number(p.entry_price), l = Number(p.last_price || e);
      const r = e > 0 ? round2(((l - e) / e) * 100) : 0;
      lines.push(`🟡 ${flagOf(t)} ${labelOf(p.symbol)} ${r >= 0 ? '+' : ''}${r}% · ${Math.round((Date.now() - new Date(p.opened_at).getTime()) / 86400000)}d · stop ${fmtPx(Number(p.atr_stop), t)}`);
    }
  }
  const week = closed.filter(c => Date.now() - new Date(c.closed_at).getTime() < 7 * 86400000);
  if (week.length) {
    lines.push('', 'Closed this week:');
    for (const c of week) lines.push(`${c.return_pct >= 0 ? '✅' : '❌'} ${labelOf(c.symbol)} ${c.return_pct >= 0 ? '+' : ''}${c.return_pct}% — ${c.close_reason}`);
  }
  const done = closed.filter(c => c.return_pct != null);
  if (done.length) {
    const wins = done.filter(c => c.return_pct > 0).length;
    const avg = round2(done.reduce((s, c) => s + Number(c.return_pct), 0) / done.length);
    lines.push('', `Track record: ${done.length} closed · ${Math.round((wins / done.length) * 100)}% winners · average ${avg >= 0 ? '+' : ''}${avg}% per trade${done.length < 20 ? ' (small sample)' : ''}`);
  }
  const ev = events.filter(e => e.ret_24h != null);
  if (ev.length) lines.push(`Momentum events (30d): ${ev.length} · average 24h after: ${round2(ev.reduce((s, e) => s + Number(e.ret_24h), 0) / ev.length)}%`);
  if (watch.length) {
    lines.push('', 'Watchlist (near OPEN):');
    for (const w of watch.slice(0, 8)) lines.push(`👀 ${labelOf(w.symbol)} ${round2(Number(w.last_score))} · ${w.watch_reason}`);
  }
  lines.push('', `BTC ${STATE.btcRegime} · QQQ ${STATE.qqqRegimeStale ? `${STATE.qqqRegime} (closed)` : STATE.qqqRegime}`, 'Default is HOLD. Act only on an OPEN or CLOSE.');
  return lines.join('\n');
}

// ============================================================
// CYCLE
// ============================================================

async function cycle() {
  if (STATE.running) return;
  STATE.running = true;
  try {
    const scan = await runScan();
    const withData = scan.candidates.filter(c => c.finalScore > 0);
    for (const c of withData) {
      const r = updateCandidateState(c.symbol, c.finalScore);
      if (r.transition === 'DEVELOPING->CONFIRMED') log(`CONFIRMED ${c.symbol} (score ${round2(c.finalScore)})`);
    }
    await processWatchlistLifecycle(withData);
    await checkMomentumEvents(withData);
    if (DB && Date.now() - STATE.lastSnapshotAt >= CONFIG.snapshotEveryMs) {
      await saveLeaderboard(withData);
      STATE.lastSnapshotAt = Date.now();
    }
    if (DB) {
      await checkOpenPositionStops();
      const now = new Date();
      const key = `pm_daily_${utcDay(now)}`;
      if (now.getUTCHours() >= CONFIG.dailyRunUtcHour && !(await kvGet(key))) {
        await kvSet(key, now.toISOString());
        await runPortfolioManager();
        await labelEventOutcomes();
      }
    }
  } catch (e) {
    log(`cycle error: ${e.stack || e.message}`);
  } finally {
    STATE.running = false;
  }
}

function start(opts = {}) {
  DB = opts.db || null;
  if (opts.notify) NOTIFY = opts.notify;
  if (opts.revolutBases) REVOLUT_BASES = opts.revolutBases;
  log(`trend lane on · scan every ${CONFIG.cycleMs / 60000} min · daily OPEN/CLOSE after ${CONFIG.dailyRunUtcHour}:00 UTC · max ${CONFIG.maxOpenPositions} positions · ${DB ? 'Neon' : 'NO DATABASE (scan only)'}`);
  const delay = opts.startDelayMs ?? 90_000;
  const t = setTimeout(() => { cycle(); setInterval(cycle, CONFIG.cycleMs); }, delay);
  if (t.unref && opts.unref) t.unref();
  return { cycle, STATE };
}

module.exports = {
  start, cycle, runScan, scoreAsset, runPortfolioManager, processWatchlistLifecycle, checkMomentumEvents,
  checkOpenPositionStops, pmEvaluateOpenGates, pmEvaluateCloseTriggers, updateCandidateState, htfContextModifier,
  isMarketOpen, weeklyReview, CONFIG, PM, STATE,
  _setDeps(d) { if ('db' in d) DB = d.db; if (d.notify) NOTIFY = d.notify; if (d.revolutBases) REVOLUT_BASES = d.revolutBases; },
};
