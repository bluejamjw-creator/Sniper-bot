// =====================================================================================
// portfolio-bot-v8.js — fomo-watch 🏹 (temporarily replacing Hunter; Hunter backup: portfolio-bot-v8-hunter-backup.js)
// Follows consistently profitable Fomo traders and alerts the private Telegram channel
// when 3+ of them buy the same token within 4 hours. Observation mode tracks every
// alert's outcome for 7 days and sends a weekly evidence report (Sunday ~18:00 UK).
//
// Single file, no npm packages. Needs Node 22.13+ (built-in SQLite).
//   node portfolio-bot-v8.js          run the bot
//   node portfolio-bot-v8.js probe    print the live cope.capital response shapes (uses 3 calls)
//   node portfolio-bot-v8.js report   print the evidence report
//
// Data: cope.capital (independent API on Fomo's leaderboard + on-chain wallets, free tier)
//       and DexScreener for prices. Storage: SQLite at DB_PATH (put on a Railway volume).
// =====================================================================================

'use strict';
process.removeAllListeners('warning'); // hide node:sqlite "experimental" warning
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

const fs = require('node:fs');
const path = require('node:path');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error(`portfolio-bot-v8.js (fomo-watch) needs Node 22.13 or newer (built-in SQLite). This is Node ${process.versions.node}. On Railway, set NODE_VERSION=22.`);
  process.exit(1);
}

// =====================================================================================
// SECTION 1 — CONFIG (every value can be overridden with a Railway variable of the same name)
// =====================================================================================

const num = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Config ${name} must be a number, got "${v}"`);
  return n;
};
const str = (name, def) => (process.env[name] === undefined || process.env[name] === '' ? def : process.env[name]);
const bool = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const CFG = {
  // --- Secrets / wiring ---
  COPE_API_KEY: str('COPE_API_KEY', ''),              // auto-registered on first run if empty
  COPE_BASE_URL: str('COPE_BASE_URL', 'https://api.cope.capital'),
  // Falls back to Hunter's variable names, so it runs in the Sniper-bot service with no new variables.
  TELEGRAM_BOT_TOKEN: str('TELEGRAM_BOT_TOKEN', str('BOT_TOKEN', '')),
  TELEGRAM_CHANNEL_ID: str('TELEGRAM_CHANNEL_ID', str('CHANNEL_CHAT_ID', '')), // private channel, e.g. -100xxxxxxxxxx
  DB_PATH: str('DB_PATH', '/data/fomo-watch.db'),       // Railway volume mounted at /data
  DEXSCREENER_BASE_URL: str('DEXSCREENER_BASE_URL', 'https://api.dexscreener.com'),

  // --- Mode ---  OBSERVATION: alerts tagged as observations. LIVE: tagged as buy alerts. Tracking on in both.
  MODE: str('MODE', 'OBSERVATION').toUpperCase(),

  // --- Who to follow ("consistent winners") ---
  TRACKED_MAX: num('TRACKED_MAX', 30),
  MIN_WIN_RATE: num('MIN_WIN_RATE', 55),               // % — applied when the API reports it
  MIN_TRADES: num('MIN_TRADES', 20),                   // closed trades — filters one-lucky-trade wallets
  LEADERBOARD_DEPTH: num('LEADERBOARD_DEPTH', 150),
  REFRESH_TRADERS_HOURS: num('REFRESH_TRADERS_HOURS', 24),

  // --- Trigger: several top traders agree ---
  MIN_TRADERS: num('MIN_TRADERS', 3),
  WINDOW_HOURS: num('WINDOW_HOURS', 4),
  MIN_BUY_USD: num('MIN_BUY_USD', 100),
  REALERT_HOURS: num('REALERT_HOURS', 24),
  UPGRADE_ALERT_AT: num('UPGRADE_ALERT_AT', 5),
  EXCLUDE_SYMBOLS: str('EXCLUDE_SYMBOLS', 'SOL,WSOL,USDC,USDT,ETH,WETH,CBBTC,WBTC,DAI,USDE,PYUSD')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),

  // --- API budget (cope.capital free tier: 250 counted calls/day, 10 req/min) ---
  DAILY_COUNTED_BUDGET: num('DAILY_COUNTED_BUDGET', 230),
  MIN_REQUEST_GAP_MS: num('MIN_REQUEST_GAP_MS', 6500),
  POLL_SECONDS: num('POLL_SECONDS', 180),
  ACTIVITY_LIMIT: num('ACTIVITY_LIMIT', 100),
  ACTIVITY_OVERLAP_SECONDS: num('ACTIVITY_OVERLAP_SECONDS', 120),

  // --- Outcome tracking ---
  OUTCOME_CHECK_MINUTES: num('OUTCOME_CHECK_MINUTES', 15),
  OUTCOME_TRACK_DAYS: num('OUTCOME_TRACK_DAYS', 7),

  // --- Reports / housekeeping ---
  WEEKLY_REPORT: bool('WEEKLY_REPORT', true),
  RETENTION_DAYS: num('RETENTION_DAYS', 60),
  SIGNATURE: str('SIGNATURE', '🏹'),
  LOG_LEVEL: str('LOG_LEVEL', 'info'),
};

const MIN = 60 * 1000;
const H = 60 * MIN;
const D = 24 * H;

// =====================================================================================
// SECTION 2 — LOGGING & HELPERS
// =====================================================================================

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function logOut(level, msg, extra) {
  if (LEVELS[level] < (LEVELS[CFG.LOG_LEVEL] ?? 20)) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  const tail = extra === undefined ? '' : ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
  (level === 'error' || level === 'warn' ? console.error : console.log)(line + tail);
}
const log = {
  debug: (m, e) => logOut('debug', m, e),
  info: (m, e) => logOut('info', m, e),
  warn: (m, e) => logOut('warn', m, e),
  error: (m, e) => logOut('error', m, e),
};

// cope.capital's exact response shapes aren't fully documented, so every reader tries
// several likely field names. Run `node portfolio-bot-v8.js probe` to see the real shapes.
function pickArray(body, keys = ['data', 'items', 'results', 'activity', 'trades', 'traders', 'leaderboard', 'events']) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const k of keys) if (Array.isArray(body[k])) return body[k];
  for (const k of keys) {
    const inner = body[k];
    if (inner && typeof inner === 'object') for (const k2 of keys) if (Array.isArray(inner[k2])) return inner[k2];
  }
  return [];
}

function first(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    let v = obj;
    for (const p of k.split('.')) v = v == null ? undefined : v[p];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function toNum(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[%,$\s]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

// Timestamps appear as both seconds (poll) and milliseconds (activity) in the docs.
function toMs(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

// Win rate may come as 0.68 or 68.
function toPct(v) {
  const n = toNum(v);
  if (n === undefined) return undefined;
  return n <= 1 && n >= 0 ? n * 100 : n;
}

const normHandle = (h) => (h ? String(h).trim().replace(/^@/, '').toLowerCase() : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtUsd(n) {
  if (n === undefined || n === null || !Number.isFinite(n)) return '?';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
function fmtPrice(p) {
  if (p === undefined || p === null || !Number.isFinite(p)) return '?';
  return p >= 1 ? `$${p.toFixed(4)}` : `$${p.toPrecision(4)}`;
}
function fmtPct(p, digits = 0) {
  if (p === undefined || p === null || !Number.isFinite(p)) return '?';
  return `${p >= 0 ? '+' : ''}${p.toFixed(digits)}%`;
}
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return rm ? `${h}h ${rm}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function median(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return undefined;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// =====================================================================================
// SECTION 3 — DATABASE (SQLite)
// =====================================================================================

let db;

function dbOpen(dbPath = CFG.DB_PATH) {
  if (db) return db;
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log.warn(`Created ${dir}. If this isn't a Railway volume, history will be lost on every redeploy.`);
    }
  }
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);

    -- The followed set. active = 1 for the current list.
    CREATE TABLE IF NOT EXISTS traders (
      handle TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1,
      win_rate REAL, trades INTEGER, pnl_7d REAL, pnl_30d REAL, rank_7d INTEGER, rank_30d INTEGER,
      reason TEXT, selected_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );

    -- Every qualifying buy by a followed trader (deduped). Pruned after RETENTION_DAYS.
    CREATE TABLE IF NOT EXISTS buys (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, handle TEXT NOT NULL, chain TEXT NOT NULL,
      mint TEXT NOT NULL, symbol TEXT, usd REAL
    );
    CREATE INDEX IF NOT EXISTS buys_mint_ts ON buys (chain, mint, ts);
    CREATE INDEX IF NOT EXISTS buys_ts ON buys (ts);

    -- One row per alert. This is the evidence table.
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL, mode TEXT NOT NULL, chain TEXT NOT NULL, mint TEXT NOT NULL, symbol TEXT,
      n_traders INTEGER NOT NULL, handles TEXT NOT NULL, total_usd REAL,
      first_buy_ts INTEGER, last_buy_ts INTEGER,
      lag_ms INTEGER,                 -- alert time minus first tracked buy (how late you are)
      entry_price REAL, entry_mcap REAL, entry_liq REAL, entry_vol24 REAL,
      pair_created_at INTEGER, price_change_1h REAL,
      upgraded_at INTEGER, upgraded_n INTEGER, telegram_ok INTEGER,
      p_1h REAL, p_4h REAL, p_24h REAL, p_72h REAL, p_7d REAL,   -- % return at each checkpoint
      max_price REAL, max_price_ts INTEGER, min_price REAL, min_before_max REAL,
      last_price REAL, last_checked_at INTEGER, price_misses INTEGER DEFAULT 0,
      done INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS alerts_token ON alerts (chain, mint, created_at);
    CREATE INDEX IF NOT EXISTS alerts_open ON alerts (done, created_at);

    -- API usage and fetch health (saturated = some buys in that window may be missing).
    CREATE TABLE IF NOT EXISTS fetch_log (ts INTEGER NOT NULL, endpoint TEXT NOT NULL, status INTEGER, rows INTEGER, saturated INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS fetch_log_ts ON fetch_log (ts);
  `);
  return db;
}

function kvGet(k) {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return r ? r.v : undefined;
}
function kvSet(k, v) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}
function dbClose() {
  if (db) db.close();
  db = undefined;
}

// =====================================================================================
// SECTION 4 — COPE.CAPITAL CLIENT (enforces the free tier's daily budget and rate limit)
// =====================================================================================

const COUNTED = [/^\/v1\/activity(\?|$)/, /^\/v1\/leaderboard/, /^\/v1\/tokens\//];
let apiKey = '';
let lastRequestAt = 0;
let requestChain = Promise.resolve();

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const budgetUsed = () => Number(kvGet(`budget:${utcDay()}`) || 0);
function budgetLeft() {
  if (kvGet(`budget_exhausted:${utcDay()}`)) return 0;
  return Math.max(0, CFG.DAILY_COUNTED_BUDGET - budgetUsed());
}
function msUntilUtcMidnight(t = Date.now()) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - t;
}

class CopeError extends Error {
  constructor(status, msg, body) {
    super(msg);
    this.status = status;
    this.body = body;
  }
}

// All requests go through one queue with a minimum gap between them.
function queued(fn) {
  const run = requestChain.then(async () => {
    const wait = lastRequestAt + CFG.MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  requestChain = run.catch(() => {});
  return run;
}

async function rawRequest(method, urlPath, body, { auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = `Bearer ${apiKey}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(CFG.COPE_BASE_URL + urlPath, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function copeRequest(method, urlPath, body) {
  const counted = COUNTED.some((re) => re.test(urlPath));
  if (counted && budgetLeft() <= 0) throw new CopeError(402, 'Daily counted-call budget used', null);

  for (let attempt = 0; attempt < 3; attempt++) {
    const { status, json } = await queued(() => rawRequest(method, urlPath, body));
    if (counted && status !== 429) kvSet(`budget:${utcDay()}`, budgetUsed() + 1);
    db.prepare('INSERT INTO fetch_log (ts, endpoint, status) VALUES (?, ?, ?)').run(Date.now(), urlPath.split('?')[0], status);

    if (status >= 200 && status < 300) return json;
    if (status === 402) {
      kvSet(`budget_exhausted:${utcDay()}`, '1');
      throw new CopeError(402, 'Free daily calls used up (resets 00:00 UTC)', json);
    }
    if (status === 401) throw new CopeError(401, 'cope.capital API key rejected — check COPE_API_KEY', json);
    if (status === 429 || status >= 500) {
      const backoff = status === 429 ? 30000 : 5000 * (attempt + 1);
      log.warn(`cope ${urlPath.split('?')[0]} -> ${status}, retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      continue;
    }
    throw new CopeError(status, `cope ${urlPath} -> ${status}`, json);
  }
  throw new CopeError(503, `cope ${urlPath} failed after retries`, null);
}

async function ensureCopeKey() {
  apiKey = CFG.COPE_API_KEY || kvGet('cope_api_key') || '';
  if (apiKey) return apiKey;
  log.info('No COPE_API_KEY set — registering a free cope.capital key');
  const { status, json } = await queued(() =>
    rawRequest('POST', '/v1/register', { agent_name: 'fomo-watch', description: 'Personal convergence alert bot' }, { auth: false }));
  const key = json && (json.api_key || json.apiKey || json.key || (json.data && json.data.api_key));
  if (status >= 300 || !key) throw new CopeError(status, 'cope.capital registration failed', json);
  apiKey = key;
  kvSet('cope_api_key', key);
  log.warn(`Registered cope.capital key. Copy it into the COPE_API_KEY Railway variable: ${key}`);
  return key;
}

const qs = (params) => {
  const e = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return e.length ? '?' + new URLSearchParams(e.map(([k, v]) => [k, String(v)])).toString() : '';
};

const cope = {
  leaderboard: (timeframe, limit) => copeRequest('GET', `/v1/leaderboard${qs({ timeframe, limit })}`),
  searchTraders: (params) => copeRequest('GET', `/v1/traders/search${qs(params)}`),
  handleStats: (handle) => copeRequest('GET', `/v1/handle/${encodeURIComponent(handle)}/stats`),
  poll: (since) => copeRequest('GET', `/v1/activity/poll${qs({ since })}`),
  activity: (params) => copeRequest('GET', `/v1/activity${qs(params)}`),
};

// =====================================================================================
// SECTION 5 — PRICES (DexScreener: free, no key, up to 30 tokens per call)
// =====================================================================================

const CHAIN_MAP = { sol: 'solana', solana: 'solana', base: 'base', eth: 'ethereum', ethereum: 'ethereum', bsc: 'bsc', bnb: 'bsc', arbitrum: 'arbitrum', hyperevm: 'hyperevm' };
const dexChain = (c) => CHAIN_MAP[String(c || '').toLowerCase()] || String(c || '').toLowerCase();
const sameAddr = (chain, a, b) => (dexChain(chain) === 'solana' ? a === b : String(a).toLowerCase() === String(b).toLowerCase());

// Returns Map(mint -> { price, mcap, liq, vol24, pairCreatedAt, change1h, url })
async function getPrices(chain, mints) {
  const out = new Map();
  const unique = [...new Set(mints)];
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    let pairs;
    try {
      const res = await fetch(`${CFG.DEXSCREENER_BASE_URL}/tokens/v1/${dexChain(chain)}/${batch.join(',')}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { log.warn(`dexscreener ${res.status} for ${chain}`); continue; }
      pairs = await res.json();
    } catch (e) {
      log.warn('dexscreener request failed', e.message);
      continue;
    }
    if (!Array.isArray(pairs)) pairs = (pairs && pairs.pairs) || [];
    for (const mint of batch) {
      // Deepest pool where this token is the base token.
      const best = pairs
        .filter((p) => p && p.baseToken && sameAddr(chain, p.baseToken.address, mint))
        .sort((a, b) => (toNum(b.liquidity && b.liquidity.usd) || 0) - (toNum(a.liquidity && a.liquidity.usd) || 0))[0];
      const price = best && toNum(best.priceUsd);
      if (!price) continue;
      out.set(mint, {
        price,
        mcap: toNum(best.marketCap) ?? toNum(best.fdv),
        liq: toNum(best.liquidity && best.liquidity.usd),
        vol24: toNum(best.volume && best.volume.h24),
        pairCreatedAt: toNum(best.pairCreatedAt),
        change1h: toNum(best.priceChange && best.priceChange.h1),
        url: best.url,
      });
    }
  }
  return out;
}
const getPrice = async (chain, mint) => (await getPrices(chain, [mint])).get(mint);

// =====================================================================================
// SECTION 6 — TELEGRAM
// =====================================================================================

async function tgSend(html) {
  if (!CFG.TELEGRAM_BOT_TOKEN || !CFG.TELEGRAM_CHANNEL_ID) {
    log.warn('Telegram not configured — message only logged:\n' + html.replace(/<[^>]+>/g, ''));
    return false;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${CFG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CFG.TELEGRAM_CHANNEL_ID, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return true;
      const body = await res.json().catch(() => ({}));
      if (res.status === 429) {
        await sleep(((body.parameters && body.parameters.retry_after) || 5) * 1000);
        continue;
      }
      log.error(`Telegram ${res.status}`, body.description || '');
      return false;
    } catch (e) {
      log.warn('Telegram send failed', e.message);
      await sleep(3000);
    }
  }
  return false;
}

// =====================================================================================
// SECTION 7 — TRADER SELECTION ("consistent winners", refreshed daily)
//   1. Profitable on BOTH the 7d and 30d Fomo leaderboards (or in a win-rate search AND on
//      one of those boards). One great day isn't enough — that's the luck filter.
//   2. Win rate >= MIN_WIN_RATE and >= MIN_TRADES closed trades when the API reports them.
//   3. Ranked: on both boards first, then 30-day rank, then win rate. Keep TRACKED_MAX.
// =====================================================================================

const HANDLE_KEYS = ['handle', 'username', 'fomo_handle', 'user.handle', 'user.username', 'name'];
const PNL_KEYS = ['pnl', 'pnl_usd', 'total_pnl', 'realized_pnl', 'profit', 'pnlUsd'];
const WIN_KEYS = ['win_rate', 'winRate', 'win_pct', 'stats.win_rate'];
const TRADES_KEYS = ['trades', 'total_trades', 'trade_count', 'tradeCount', 'num_trades', 'closed_trades', 'stats.total_trades'];
const RANK_KEYS = ['rank', 'position', 'place'];

function readBoard(body) {
  const map = new Map();
  pickArray(body).forEach((r, i) => {
    const h = normHandle(first(r, HANDLE_KEYS));
    if (!h) return;
    map.set(h, {
      rank: toNum(first(r, RANK_KEYS)) ?? i + 1,
      pnl: toNum(first(r, PNL_KEYS)),
      win: toPct(first(r, WIN_KEYS)),
      trades: toNum(first(r, TRADES_KEYS)),
    });
  });
  return map;
}

function passesStats(t) {
  if (t.win !== undefined && t.win < CFG.MIN_WIN_RATE) return false;
  if (t.trades !== undefined && t.trades < CFG.MIN_TRADES) return false;
  return true;
}

function rankSort(a, b) {
  if (a.both !== b.both) return a.both ? -1 : 1;
  const ra = a.rank30 ?? a.rank7 ?? 999;
  const rb = b.rank30 ?? b.rank7 ?? 999;
  if (ra !== rb) return ra - rb;
  return (b.win ?? 0) - (a.win ?? 0);
}

const currentHandles = () => db.prepare('SELECT handle FROM traders WHERE active = 1').all().map((r) => r.handle);

function traderInfo(handles) {
  if (!handles.length) return new Map();
  const rows = db.prepare(`SELECT * FROM traders WHERE handle IN (${handles.map(() => '?').join(',')})`).all(...handles);
  return new Map(rows.map((r) => [r.handle, r]));
}

async function refreshTraders() {
  const started = Date.now();
  let lb7 = new Map();
  let lb30 = new Map();
  let search = new Map();
  try { lb7 = readBoard(await cope.leaderboard('7d', CFG.LEADERBOARD_DEPTH)); } catch (e) { log.warn('7d leaderboard failed', e.message); }
  try { lb30 = readBoard(await cope.leaderboard('30d', CFG.LEADERBOARD_DEPTH)); } catch (e) { log.warn('30d leaderboard failed', e.message); }
  try {
    search = readBoard(await cope.searchTraders({ min_win_rate: CFG.MIN_WIN_RATE, min_trades: CFG.MIN_TRADES, sort_by: 'pnl', limit: 100 }));
  } catch (e) { log.warn('trader search failed', e.message); }

  const cands = new Map();
  const add = (h, reason) => {
    const a = lb7.get(h) || {};
    const b = lb30.get(h) || {};
    const s = search.get(h) || {};
    cands.set(h, {
      handle: h,
      both: lb7.has(h) && lb30.has(h),
      rank7: lb7.has(h) ? a.rank : undefined,
      rank30: lb30.has(h) ? b.rank : undefined,
      pnl7: a.pnl,
      pnl30: b.pnl,
      win: s.win ?? b.win ?? a.win,
      trades: s.trades ?? b.trades ?? a.trades,
      reason,
    });
  };

  for (const h of lb7.keys()) {
    if (!lb30.has(h)) continue;
    const p7 = lb7.get(h).pnl;
    const p30 = lb30.get(h).pnl;
    if ((p7 === undefined || p7 > 0) && (p30 === undefined || p30 > 0)) add(h, 'top 7d + top 30d');
  }
  for (const h of search.keys()) {
    if (!cands.has(h) && (lb30.has(h) || lb7.has(h))) add(h, `win-rate search + ${lb30.has(h) ? '30d' : '7d'} board`);
  }
  // Fallback if the boards came back empty or in an unexpected shape: use search alone.
  if (cands.size < 5 && search.size) {
    log.warn(`Only ${cands.size} board-confirmed traders; falling back to win-rate search results`);
    for (const h of search.keys()) if (!cands.has(h)) add(h, 'win-rate search (fallback)');
  }

  // Fill missing win rate / trade count from the per-trader stats endpoint (free).
  const toEnrich = [...cands.values()].sort(rankSort)
    .filter((c) => c.win === undefined || c.trades === undefined)
    .slice(0, Math.ceil(CFG.TRACKED_MAX * 1.5));
  for (const c of toEnrich) {
    try {
      const st = await cope.handleStats(c.handle);
      const body = st && (st.data || st.stats || st);
      c.win = c.win ?? toPct(first(body, WIN_KEYS));
      c.trades = c.trades ?? toNum(first(body, TRADES_KEYS));
    } catch (e) {
      log.debug(`stats ${c.handle} failed`, e.message);
    }
  }

  const selected = [...cands.values()].filter(passesStats).sort(rankSort).slice(0, CFG.TRACKED_MAX);
  if (!selected.length) {
    log.warn('Trader refresh produced 0 traders — keeping the previous list');
    return currentHandles();
  }

  const now = Date.now();
  const prev = new Set(currentHandles());
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE traders SET active = 0').run();
    const up = db.prepare(`
      INSERT INTO traders (handle, active, win_rate, trades, pnl_7d, pnl_30d, rank_7d, rank_30d, reason, selected_at, updated_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(handle) DO UPDATE SET active = 1, win_rate = excluded.win_rate, trades = excluded.trades,
        pnl_7d = excluded.pnl_7d, pnl_30d = excluded.pnl_30d, rank_7d = excluded.rank_7d, rank_30d = excluded.rank_30d,
        reason = excluded.reason, updated_at = excluded.updated_at`);
    for (const c of selected) {
      up.run(c.handle, c.win ?? null, c.trades ?? null, c.pnl7 ?? null, c.pnl30 ?? null, c.rank7 ?? null, c.rank30 ?? null, c.reason, now, now);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  kvSet('traders_refreshed_at', now);

  const next = new Set(selected.map((c) => c.handle));
  const added = [...next].filter((h) => !prev.has(h)).length;
  const dropped = [...prev].filter((h) => !next.has(h)).length;
  log.info(`Following ${selected.length} traders (boards: 7d=${lb7.size}, 30d=${lb30.size}, search=${search.size}; +${added} −${dropped}) in ${Math.round((Date.now() - started) / 1000)}s`);
  return [...next];
}

// =====================================================================================
// SECTION 8 — ALERT MESSAGES (each alert explains the pattern behind it)
// =====================================================================================

function lessons(a) {
  const out = [];
  const ageMs = a.pair_created_at ? a.created_at - a.pair_created_at : undefined;

  // How late are you?
  if (Number.isFinite(a.price_change_1h) && a.price_change_1h >= 30) {
    out.push(`Already ${fmtPct(a.price_change_1h)} in the last hour. Copy-traders get hurt chasing vertical candles — experienced traders wait for the first pullback to hold, or skip.`);
  } else if (Number.isFinite(a.lag_ms) && a.lag_ms >= 2 * H) {
    out.push(`First tracked buy was ${fmtDuration(a.lag_ms)} ago. The earliest buyers have the edge; the later you are, the more of the move is already priced in.`);
  }

  // Liquidity: can you get in and out?
  if (Number.isFinite(a.entry_liq)) {
    if (a.entry_liq < 25000) {
      out.push(`Thin pool (${fmtUsd(a.entry_liq)} liquidity). Your own buy moves the price and selling can be worse. A common rule: keep a position under ~1% of pool liquidity.`);
    } else if (Number.isFinite(a.entry_mcap) && a.entry_mcap > 0 && a.entry_liq / a.entry_mcap < 0.05) {
      out.push(`Liquidity is only ${((a.entry_liq / a.entry_mcap) * 100).toFixed(1)}% of market cap — the price can fall a long way on modest selling.`);
    }
  }

  // Token age: survival risk
  if (Number.isFinite(ageMs)) {
    if (ageMs < D) out.push(`Token is ${fmtDuration(ageMs)} old. Most new tokens collapse within days; many traders wait to see it survive 48h before sizing up.`);
    else if (ageMs > 30 * D) out.push(`Established token (${fmtDuration(ageMs)} old) — slower multiples than fresh launches, but less rug risk.`);
  }

  // Conviction quality
  const amounts = (a.buys || []).map((b) => b.usd).filter(Number.isFinite);
  const total = amounts.reduce((s, x) => s + x, 0);
  if (amounts.length && total > 0) {
    const top = Math.max(...amounts);
    if (top / total > 0.7) out.push(`One trader put in ${Math.round((top / total) * 100)}% of the money — this is closer to following one person than a real consensus.`);
  }
  if (a.n_traders >= 5 || total >= 20000) {
    out.push(`Strong agreement: ${a.n_traders} independent winners, ${fmtUsd(total)} combined. Breadth of buyers matters more than any single size.`);
  }
  if (Number.isFinite(a.entry_mcap) && a.entry_mcap >= 50e6) {
    out.push(`Larger cap (${fmtUsd(a.entry_mcap)}): deeper liquidity, smaller upside multiples.`);
  }

  out.push('Next signal to watch: the same traders selling. When the buyers who triggered this start exiting, the thesis is weakening.');
  return out;
}

const symLabel = (a) => (a.symbol ? `$${esc(a.symbol)}` : esc(a.mint.slice(0, 6) + '…'));
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '?');
const pctOrQ = (x) => (Number.isFinite(x) ? `${Math.round(x)}%` : '?');

function alertMessage(a) {
  const head = a.mode === 'LIVE' ? '🟢 <b>Buy alert</b> · Fomo convergence' : '👀 <b>Observation</b> · Fomo convergence';
  const span = Number.isFinite(a.first_buy_ts) && Number.isFinite(a.last_buy_ts) ? fmtDuration(a.last_buy_ts - a.first_buy_ts) : '?';
  const lines = [head, '', `<b>${symLabel(a)}</b> (${esc(capFirst(a.chain))})`, `${a.n_traders} followed traders bought within ${span}`, ''];
  for (const b of a.buys) {
    const t = b.trader || {};
    const bits = [];
    if (Number.isFinite(t.win_rate)) bits.push(`win ${Math.round(t.win_rate)}%`);
    if (Number.isFinite(t.rank_30d)) bits.push(`30d #${t.rank_30d}`);
    lines.push(`• @${esc(b.handle)} — ${fmtUsd(b.usd)}${bits.length ? ` <i>(${bits.join(', ')})</i>` : ''}`);
  }
  lines.push('');
  lines.push(`Price ${fmtPrice(a.entry_price)} · MCap ${fmtUsd(a.entry_mcap)} · Liq ${fmtUsd(a.entry_liq)}`);
  const age = a.pair_created_at ? `Pair age ${fmtDuration(a.created_at - a.pair_created_at)} · ` : '';
  lines.push(`${age}1h ${fmtPct(a.price_change_1h)} · First buy ${fmtDuration(a.lag_ms)} ago`);
  lines.push(`<code>${esc(a.mint)}</code>`);
  if (a.url) lines.push(`<a href="${esc(a.url)}">Chart</a>`);
  lines.push('');
  lines.push('<b>Why this fired</b>');
  lines.push(`Several consistently profitable wallets (good 7d <i>and</i> 30d PnL) bought the same token within ${CFG.WINDOW_HOURS}h without coordinating. That's "smart-money convergence" — the more buyers and the tighter the window, the stronger it usually is.`);
  lines.push('');
  lines.push('<b>What to read from it</b>');
  for (const l of lessons(a)) lines.push(`• ${l}`);
  lines.push('');
  lines.push(CFG.SIGNATURE);
  return lines.join('\n');
}

function upgradeMessage(a, newN, newHandles, priceNow) {
  const move = Number.isFinite(priceNow) && a.entry_price ? (priceNow / a.entry_price - 1) * 100 : undefined;
  return [
    `⬆️ <b>${symLabel(a)}</b>: now ${newN} followed traders (was ${a.n_traders})`,
    `New: ${newHandles.map((h) => '@' + esc(h)).join(', ')}`,
    `Since first alert: ${fmtPct(move)}`,
    '',
    move !== undefined && move > 50
      ? 'Late joiners after a big move are often the ones others exit into. Agreement growing is good; agreement growing <i>after</i> the pump is weaker.'
      : 'More independent winners joining after the first signal is a stronger pattern than the first cluster alone.',
    '',
    CFG.SIGNATURE,
  ].join('\n');
}

function weeklyMessage(r) {
  const lines = [`📊 <b>Fomo watch — weekly evidence</b> (${CFG.MODE === 'LIVE' ? 'live' : 'observation'} mode)`, ''];
  lines.push(`This week: ${r.weekAlerts} alerts · following ${r.following} traders`);
  if (r.saturatedPct > 0) lines.push(`Fetch saturation ${r.saturatedPct.toFixed(0)}% (some buys may have been missed)`);
  lines.push('');
  if (!r.matured) {
    lines.push('No alerts have finished their 24h window yet — nothing to judge.');
  } else {
    lines.push(`<b>All-time, ${r.matured} alerts with ≥24h of data</b>`);
    lines.push(`Median at 24h: ${fmtPct(r.med24)} · at 7d: ${fmtPct(r.med7d)}`);
    lines.push(`Peak reached +25%: ${pctOrQ(r.hit25)} · +50%: ${pctOrQ(r.hit50)} · 2x: ${pctOrQ(r.hit100)}`);
    lines.push(`Down 50%+ at 7d: ${pctOrQ(r.rug50)}`);
    lines.push(`Median dip before the peak: ${fmtPct(r.medDip)}`);
    for (const [title, groups] of [['By number of traders', r.byN], ['By liquidity at alert', r.byLiq]]) {
      if (!groups.length) continue;
      lines.push('', `<b>${title}</b>`);
      for (const g of groups) lines.push(`${g.label}: ${g.n} alerts · median 24h ${fmtPct(g.med24)} · +50% hit ${pctOrQ(g.hit50)}`);
    }
    lines.push('');
    lines.push(r.matured < 30
      ? `Small sample (${r.matured}). Wait for 30+ before drawing conclusions or changing thresholds.`
      : 'Enough data to start comparing groups. Change one threshold at a time.');
  }
  lines.push('', CFG.SIGNATURE);
  return lines.join('\n');
}

// =====================================================================================
// SECTION 9 — WATCHER (reads followed traders' buys, detects agreement, sends alerts)
// =====================================================================================

let lastFetchAt = 0;

function parseBuy(r) {
  return {
    action: String(first(r, ['action', 'side', 'type', 'direction']) || '').toLowerCase(),
    ts: toMs(first(r, ['timestamp', 'ts', 'block_time', 'blockTime', 'created_at', 'time', 'executed_at'])),
    handle: normHandle(first(r, ['handle', 'username', 'fomo_handle', 'trader', 'user.handle'])),
    chain: String(first(r, ['chain', 'network', 'chain_id']) || 'solana').toLowerCase(),
    mint: String(first(r, ['token_mint', 'mint', 'token_address', 'tokenAddress', 'token.mint', 'token.address', 'address']) || ''),
    symbol: first(r, ['token_symbol', 'symbol', 'token.symbol', 'ticker']),
    usd: toNum(first(r, ['usd_amount', 'usd', 'amount_usd', 'usdAmount', 'value_usd', 'volume_usd'])),
    tx: first(r, ['signature', 'tx_hash', 'txHash', 'tx', 'txid', 'transaction', 'id']),
  };
}

// Spread the day's counted calls evenly until 00:00 UTC.
function fetchGapMs(now = Date.now()) {
  const left = budgetLeft() - 5; // keep a few for the daily trader refresh
  if (left <= 0) return Infinity;
  return Math.max(MIN, msUntilUtcMidnight(now) / left);
}

async function watchTick() {
  const tracked = new Set(currentHandles());
  if (!tracked.size) { log.warn('No traders followed yet; skipping activity'); return; }

  const lastTs = Number(kvGet('last_activity_ts') || 0);
  const sinceMs = Math.max(Date.now() - CFG.WINDOW_HOURS * H, lastTs - CFG.ACTIVITY_OVERLAP_SECONDS * 1000);
  const sinceSec = Math.floor(sinceMs / 1000);

  // Free poll first: only spend a counted call when something has happened.
  try {
    const p = await cope.poll(sinceSec);
    if (toNum(first(p, ['count', 'new', 'total', 'data.count'])) === 0) { log.debug('poll: nothing new'); return; }
  } catch (e) {
    if (e.status === 401) throw e;
    log.debug('poll failed, falling through to activity', e.message);
  }

  const gap = fetchGapMs();
  if (Date.now() - lastFetchAt < gap) { log.debug('budget pacing: waiting'); return; }

  let body;
  try {
    lastFetchAt = Date.now();
    body = await cope.activity({ since: sinceSec, action: 'buy', min_usd: CFG.MIN_BUY_USD, limit: CFG.ACTIVITY_LIMIT });
  } catch (e) {
    if (e.status === 402) { log.info('Daily free calls used; waiting for 00:00 UTC reset'); return; }
    throw e;
  }

  const rows = pickArray(body);
  const saturated = rows.length >= CFG.ACTIVITY_LIMIT ? 1 : 0;
  db.prepare("UPDATE fetch_log SET rows = ?, saturated = ? WHERE rowid = (SELECT MAX(rowid) FROM fetch_log WHERE endpoint = '/v1/activity')")
    .run(rows.length, saturated);
  if (saturated) log.warn(`activity returned the full limit (${rows.length}); some buys in this window may be missing`);

  const ins = db.prepare('INSERT OR IGNORE INTO buys (id, ts, handle, chain, mint, symbol, usd) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let maxTs = lastTs;
  let kept = 0;
  for (const r of rows) {
    const b = parseBuy(r);
    if (b.ts && b.ts > maxTs) maxTs = b.ts;
    if (b.action && !['buy', 'swap_in', 'bought'].includes(b.action)) continue;
    if (!b.handle || !tracked.has(b.handle) || !b.mint || !b.ts) continue;
    if (b.usd !== undefined && b.usd < CFG.MIN_BUY_USD) continue;
    if (b.symbol && CFG.EXCLUDE_SYMBOLS.includes(String(b.symbol).toUpperCase())) continue;
    const id = b.tx ? `${b.tx}:${b.handle}:${b.mint}` : `${b.handle}:${b.mint}:${b.ts}:${b.usd}`;
    kept += Number(ins.run(id, b.ts, b.handle, b.chain, b.mint, b.symbol ?? null, b.usd ?? null).changes || 0);
  }
  if (maxTs > lastTs) kvSet('last_activity_ts', Math.min(maxTs, Date.now()));
  log.info(`activity: ${rows.length} rows, ${kept} new followed buys · budget left ${budgetLeft()}`);

  await detect();
}

async function detect(now = Date.now()) {
  const rows = db.prepare(`
    SELECT chain, mint, handle, MAX(symbol) AS symbol, MIN(ts) AS first_ts, MAX(ts) AS last_ts, SUM(COALESCE(usd, 0)) AS usd
    FROM buys WHERE ts >= ? GROUP BY chain, mint, handle`).all(now - CFG.WINDOW_HOURS * H);

  const tokens = new Map();
  for (const r of rows) {
    const k = `${r.chain}|${r.mint}`;
    if (!tokens.has(k)) tokens.set(k, { chain: r.chain, mint: r.mint, symbol: r.symbol, buys: [] });
    const t = tokens.get(k);
    if (!t.symbol && r.symbol) t.symbol = r.symbol;
    t.buys.push({ handle: r.handle, usd: r.usd, first_ts: r.first_ts, last_ts: r.last_ts });
  }

  const fired = [];
  for (const t of tokens.values()) {
    if (t.buys.length < CFG.MIN_TRADERS) continue;
    const recent = db.prepare('SELECT * FROM alerts WHERE chain = ? AND mint = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1')
      .get(t.chain, t.mint, now - CFG.REALERT_HOURS * H);
    if (recent) { await maybeUpgrade(recent, t, now); continue; }
    fired.push(await fireAlert(t, now));
  }
  return fired;
}

async function fireAlert(t, now) {
  t.buys.sort((a, b) => b.usd - a.usd);
  const info = traderInfo(t.buys.map((b) => b.handle));
  for (const b of t.buys) b.trader = info.get(b.handle);
  const firstTs = Math.min(...t.buys.map((b) => b.first_ts));
  const lastTs = Math.max(...t.buys.map((b) => b.last_ts));
  const p = await getPrice(t.chain, t.mint).catch(() => undefined);

  const a = {
    created_at: now,
    mode: CFG.MODE === 'LIVE' ? 'LIVE' : 'OBSERVATION',
    chain: t.chain, mint: t.mint, symbol: t.symbol,
    n_traders: t.buys.length, buys: t.buys,
    total_usd: t.buys.reduce((s, b) => s + (b.usd || 0), 0),
    first_buy_ts: firstTs, last_buy_ts: lastTs, lag_ms: now - firstTs,
    entry_price: p && p.price, entry_mcap: p && p.mcap, entry_liq: p && p.liq, entry_vol24: p && p.vol24,
    pair_created_at: p && p.pairCreatedAt, price_change_1h: p && p.change1h, url: p && p.url,
  };

  const res = db.prepare(`
    INSERT INTO alerts (created_at, mode, chain, mint, symbol, n_traders, handles, total_usd, first_buy_ts, last_buy_ts, lag_ms,
      entry_price, entry_mcap, entry_liq, entry_vol24, pair_created_at, price_change_1h, max_price, max_price_ts, min_price, min_before_max, last_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    a.created_at, a.mode, a.chain, a.mint, a.symbol ?? null, a.n_traders, JSON.stringify(t.buys.map((b) => b.handle)), a.total_usd,
    a.first_buy_ts, a.last_buy_ts, a.lag_ms, a.entry_price ?? null, a.entry_mcap ?? null, a.entry_liq ?? null, a.entry_vol24 ?? null,
    a.pair_created_at ?? null, a.price_change_1h ?? null,
    a.entry_price ?? null, a.entry_price ? now : null, a.entry_price ?? null, a.entry_price ?? null, a.entry_price ?? null);

  const ok = await tgSend(alertMessage(a));
  db.prepare('UPDATE alerts SET telegram_ok = ? WHERE id = ?').run(ok ? 1 : 0, Number(res.lastInsertRowid));
  log.info(`ALERT ${a.symbol || a.mint} ${a.chain}: ${a.n_traders} traders, ${Math.round(a.total_usd)} USD, lag ${Math.round(a.lag_ms / 60000)}m`);
  return a;
}

async function maybeUpgrade(alert, t, now) {
  if (alert.upgraded_at || t.buys.length < CFG.UPGRADE_ALERT_AT || t.buys.length <= alert.n_traders) return;
  const prev = new Set(JSON.parse(alert.handles));
  const newHandles = t.buys.map((b) => b.handle).filter((h) => !prev.has(h));
  if (!newHandles.length) return;
  const p = await getPrice(t.chain, t.mint).catch(() => undefined);
  await tgSend(upgradeMessage(alert, t.buys.length, newHandles, p && p.price));
  db.prepare('UPDATE alerts SET upgraded_at = ?, upgraded_n = ? WHERE id = ?').run(now, t.buys.length, alert.id);
  log.info(`UPGRADE ${alert.symbol || alert.mint}: ${alert.n_traders} -> ${t.buys.length}`);
}

// =====================================================================================
// SECTION 10 — OUTCOME TRACKING (returns at checkpoints, peak, dip before peak)
// =====================================================================================

const CHECKPOINTS = [['p_1h', 1 * H], ['p_4h', 4 * H], ['p_24h', 24 * H], ['p_72h', 72 * H], ['p_7d', 168 * H]];

async function checkOutcomes(now = Date.now()) {
  const open = db.prepare('SELECT * FROM alerts WHERE done = 0').all();
  if (!open.length) return 0;

  const byChain = new Map();
  for (const a of open) {
    if (!byChain.has(a.chain)) byChain.set(a.chain, []);
    byChain.get(a.chain).push(a);
  }

  let updated = 0;
  for (const [chain, alerts] of byChain) {
    const quotes = await getPrices(chain, alerts.map((a) => a.mint));
    for (const a of alerts) {
      const q = quotes.get(a.mint);
      const age = now - a.created_at;
      if (!q) {
        const misses = (a.price_misses || 0) + 1;
        // No pool for ~6h straight after the first day: liquidity is gone — stop tracking.
        const dead = misses >= 24 && age > D;
        db.prepare('UPDATE alerts SET price_misses = ?, done = ? WHERE id = ?').run(misses, dead || age >= CFG.OUTCOME_TRACK_DAYS * D ? 1 : 0, a.id);
        if (dead) log.info(`outcome: ${a.symbol || a.mint} has no liquid pool any more — closed`);
        continue;
      }
      const price = q.price;
      const entry = a.entry_price || price; // backfill if the token wasn't indexed at alert time
      const set = { last_price: price, last_checked_at: now, price_misses: 0 };
      if (!a.entry_price) Object.assign(set, { entry_price: price, max_price: price, max_price_ts: now, min_price: price, min_before_max: price });

      const minSoFar = Math.min(a.min_price ?? price, price);
      set.min_price = minSoFar;
      if (price > (a.max_price ?? 0)) Object.assign(set, { max_price: price, max_price_ts: now, min_before_max: minSoFar });
      for (const [col, at] of CHECKPOINTS) {
        if (age >= at && (a[col] === null || a[col] === undefined)) set[col] = (price / entry - 1) * 100;
      }
      if (age >= CFG.OUTCOME_TRACK_DAYS * D) set.done = 1;

      const cols = Object.keys(set);
      db.prepare(`UPDATE alerts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), a.id);
      updated++;
    }
  }
  return updated;
}

function prune(now = Date.now()) {
  const a = db.prepare('DELETE FROM buys WHERE ts < ?').run(now - CFG.RETENTION_DAYS * D);
  const b = db.prepare('DELETE FROM fetch_log WHERE ts < ?').run(now - 14 * D);
  if (a.changes || b.changes) log.info(`housekeeping: removed ${a.changes} old buys, ${b.changes} old fetch logs`);
}

// =====================================================================================
// SECTION 11 — EVIDENCE REPORT
// =====================================================================================

const rateOf = (rows, pred) => (rows.length ? (rows.filter(pred).length / rows.length) * 100 : undefined);
const groupStats = (rows, label) => ({ label, n: rows.length, med24: median(rows.map((r) => r.p_24h)), hit50: rateOf(rows, (r) => r.mfe >= 50) });

function buildReport(now = Date.now()) {
  const weekAlerts = db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE created_at >= ?').get(now - 7 * D).n;
  const following = db.prepare('SELECT COUNT(*) AS n FROM traders WHERE active = 1').get().n;
  const fl = db.prepare("SELECT COUNT(*) AS n, SUM(saturated) AS s FROM fetch_log WHERE endpoint = '/v1/activity' AND ts >= ? AND rows IS NOT NULL").get(now - 7 * D);

  const rows = db.prepare('SELECT * FROM alerts WHERE p_24h IS NOT NULL AND entry_price > 0').all().map((r) => ({
    ...r,
    mfe: r.max_price ? (r.max_price / r.entry_price - 1) * 100 : undefined,
    dip: r.min_before_max ? (r.min_before_max / r.entry_price - 1) * 100 : undefined,
  }));
  const with7d = rows.filter((r) => r.p_7d !== null);

  const byN = [
    groupStats(rows.filter((r) => r.n_traders === 3), '3 traders'),
    groupStats(rows.filter((r) => r.n_traders === 4), '4 traders'),
    groupStats(rows.filter((r) => r.n_traders >= 5), '5+ traders'),
  ].filter((g) => g.n > 0);
  const byLiq = [
    groupStats(rows.filter((r) => (r.entry_liq ?? 0) < 25000), 'Under $25k'),
    groupStats(rows.filter((r) => r.entry_liq >= 25000 && r.entry_liq < 100000), '$25k–100k'),
    groupStats(rows.filter((r) => r.entry_liq >= 100000), '$100k+'),
  ].filter((g) => g.n > 0);

  return {
    weekAlerts,
    following,
    saturatedPct: fl.n ? ((fl.s || 0) / fl.n) * 100 : 0,
    matured: rows.length,
    med24: median(rows.map((r) => r.p_24h)),
    med7d: median(with7d.map((r) => r.p_7d)),
    hit25: rateOf(rows, (r) => r.mfe >= 25),
    hit50: rateOf(rows, (r) => r.mfe >= 50),
    hit100: rateOf(rows, (r) => r.mfe >= 100),
    rug50: rateOf(with7d, (r) => r.p_7d <= -50),
    medDip: median(rows.map((r) => r.dip)),
    byN: byN.length > 1 ? byN : [],
    byLiq: byLiq.length > 1 ? byLiq : [],
  };
}

// =====================================================================================
// SECTION 12 — SCHEDULER (startup is silent on Telegram)
// =====================================================================================

function londonNow(t = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
}

function every(name, ms, fn, { immediate = true } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (e) {
      log.error(`${name} failed: ${e.message}`);
      if (e.status === 401) log.error('Fix COPE_API_KEY in Railway variables, then redeploy.');
    } finally { running = false; }
  };
  if (immediate) run();
  return setInterval(run, ms);
}

async function maybeRefreshTraders() {
  const last = Number(kvGet('traders_refreshed_at') || 0);
  if (Date.now() - last < CFG.REFRESH_TRADERS_HOURS * H && currentHandles().length) return;
  await refreshTraders();
}

async function maybeWeekly() {
  if (!CFG.WEEKLY_REPORT) return;
  const now = londonNow();
  if (now.weekday !== 'Sun' || now.hour < 18 || kvGet('weekly_sent') === now.date) return;
  kvSet('weekly_sent', now.date);
  await tgSend(weeklyMessage(buildReport()));
  log.info('weekly report sent');
}

async function maybeHousekeeping() {
  const today = new Date().toISOString().slice(0, 10);
  if (kvGet('pruned_on') === today) return;
  kvSet('pruned_on', today);
  prune();
}

async function main() {
  dbOpen();
  await ensureCopeKey();
  log.info(`fomo-watch started · mode ${CFG.MODE} · trigger ${CFG.MIN_TRADERS}+ traders in ${CFG.WINDOW_HOURS}h · budget left today ${budgetLeft()}`);
  if (!CFG.TELEGRAM_BOT_TOKEN || !CFG.TELEGRAM_CHANNEL_ID) log.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID not set — alerts will only be logged');

  await maybeRefreshTraders().catch((e) => log.error('initial trader refresh failed', e.message));

  every('traders', 30 * MIN, maybeRefreshTraders, { immediate: false });
  every('activity', CFG.POLL_SECONDS * 1000, watchTick);
  every('outcomes', CFG.OUTCOME_CHECK_MINUTES * MIN, () => checkOutcomes());
  every('weekly', 10 * MIN, maybeWeekly);
  every('housekeeping', 60 * MIN, maybeHousekeeping);
}

// =====================================================================================
// SECTION 13 — COMMANDS: probe / report
// =====================================================================================

async function probe() {
  dbOpen();
  await ensureCopeKey();
  const shape = (label, body) => {
    const rows = pickArray(body);
    console.log(`\n=== ${label} ===`);
    console.log(`top-level: ${Array.isArray(body) ? 'array' : Object.keys(body || {}).join(', ')}`);
    console.log(`rows: ${rows.length}`);
    console.log('first row:', JSON.stringify(rows[0] ?? body, null, 2).slice(0, 1500));
  };
  const hourAgo = Math.floor(Date.now() / 1000) - 3600;
  shape('leaderboard 7d', await cope.leaderboard('7d', 5));
  shape('traders/search', await cope.searchTraders({ min_win_rate: 55, min_trades: 20, sort_by: 'pnl', limit: 5 }));
  console.log('\n=== activity/poll ===\n', JSON.stringify(await cope.poll(hourAgo)));
  shape('activity (buys, last hour)', await cope.activity({ since: hourAgo, action: 'buy', limit: 5 }));
  console.log(`\nCounted calls left today: ${budgetLeft()}`);
}

if (require.main === module) {
  const cmd = process.argv[2];
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log.info(`${sig} — shutting down`); dbClose(); process.exit(0); });
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', e && e.message));

  if (cmd === 'probe') {
    probe().then(() => process.exit(0)).catch((e) => {
      console.error('probe failed:', e.message, e.body ? JSON.stringify(e.body).slice(0, 500) : '');
      process.exit(1);
    });
  } else if (cmd === 'report') {
    dbOpen();
    console.log(weeklyMessage(buildReport()).replace(/<[^>]+>/g, ''));
  } else {
    main().catch((e) => { log.error('fatal', e.message); process.exit(1); });
  }
}

// Exported for the offline test.
module.exports = {
  dbOpen, kvGet, kvSet, get db() { return db; }, ensureCopeKey, refreshTraders, watchTick, detect, fetchGapMs,
  checkOutcomes, prune, buildReport, weeklyMessage, toMs, toPct,
  _resetPacing: () => { lastFetchAt = 0; },
};
