// =====================================================================================
// portfolio-bot-v8.js — fomo-watch v3.1 🏹 (fomoapi.io + on-chain wallet watch via Helius, alerts to Discord; temporarily replacing Hunter — Hunter backup: portfolio-bot-v8-hunter-backup.js)
// Follows consistently profitable Fomo traders and alerts the private Telegram channel
// when 3+ of them buy the same token within 4 hours. Observation mode tracks every
// alert's outcome for 7 days and sends a weekly evidence report (Sunday ~18:00 UK).
//
// Single file, no npm packages. Needs Node 22.13+ (built-in SQLite and WebSocket).
//   node portfolio-bot-v8.js          run the bot
//   node portfolio-bot-v8.js probe    check the fomoapi.io key, data shapes and live feed (~750 credits)
//   node portfolio-bot-v8.js onchain  check the Helius key and decode a few real trader transactions (~30 credits)
//   node portfolio-bot-v8.js report   print the evidence report
//
// Data: fomoapi.io (Fomo leaderboard, trader positions, live buy feed over WebSocket;
//       free key = 250,000 credits/month) and DexScreener for prices.
// Storage: SQLite at DB_PATH (put on a Railway volume mounted at /data).
// The bot never crash-loops: if the key is missing or the API is down it logs why and retries.
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
  FOMOAPI_KEY: str('FOMOAPI_KEY', ''),                 // free key from fomoapi.io/dashboard (required)
  FOMOAPI_BASE_URL: str('FOMOAPI_BASE_URL', 'https://api.fomoapi.io'),
  FOMOAPI_WS_URL: str('FOMOAPI_WS_URL', 'wss://api.fomoapi.io/ws/alerts'),
  // Falls back to Hunter's variable names, so it runs in the Sniper-bot service with no new Telegram variables.
  TELEGRAM_BOT_TOKEN: str('TELEGRAM_BOT_TOKEN', str('BOT_TOKEN', '')),
  TELEGRAM_CHANNEL_ID: str('TELEGRAM_CHANNEL_ID', str('CHANNEL_CHAT_ID', '')), // private channel, e.g. -100xxxxxxxxxx
  // Discord: when set, alerts go here instead of Telegram (ALSO_TELEGRAM=1 posts to both).
  DISCORD_WEBHOOK_URL: str('DISCORD_WEBHOOK_URL', ''),
  ALSO_TELEGRAM: bool('ALSO_TELEGRAM', false),
  DB_PATH: str('DB_PATH', '/data/fomo-watch.db'),       // Railway volume mounted at /data
  DEXSCREENER_BASE_URL: str('DEXSCREENER_BASE_URL', 'https://api.dexscreener.com'),

  // On-chain wallet watch (optional, recommended): free key from helius.dev. Sees every Solana buy.
  HELIUS_API_KEY: str('HELIUS_API_KEY', ''),
  HELIUS_RPC_URL: str('HELIUS_RPC_URL', 'https://mainnet.helius-rpc.com/?api-key='),
  HELIUS_WS_URL: str('HELIUS_WS_URL', 'wss://mainnet.helius-rpc.com/?api-key='),
  HELIUS_DAILY_TX_CAP: num('HELIUS_DAILY_TX_CAP', 25000), // ~750k/month, inside the free plan's 1M credits
  SOLANA_TX_VERSION: num('SOLANA_TX_VERSION', 1),         // highest Solana transaction format the bot reads
  HELIUS_KEEPALIVE_SECONDS: num('HELIUS_KEEPALIVE_SECONDS', 50),

  // --- Mode ---  OBSERVATION: alerts tagged as observations. LIVE: tagged as buy alerts. Tracking on in both.
  MODE: str('MODE', 'OBSERVATION').toUpperCase(),

  // --- Who to follow ("consistent winners") ---
  TRACKED_MAX: num('TRACKED_MAX', 30),
  MIN_WIN_RATE: num('MIN_WIN_RATE', 55),               // % of recent closed positions in profit
  MIN_CLOSED_FOR_WIN_RATE: num('MIN_CLOSED_FOR_WIN_RATE', 10), // fewer closed positions than this = win rate not judged
  MIN_TRADES: num('MIN_TRADES', 20),                   // trades on the 30d board — filters one-lucky-trade wallets
  LEADERBOARD_DEPTH: num('LEADERBOARD_DEPTH', 150),
  REFRESH_TRADERS_HOURS: num('REFRESH_TRADERS_HOURS', 24),
  WIN_RATE_REFRESH_DAYS: num('WIN_RATE_REFRESH_DAYS', 7), // each trader's win rate costs 250 credits, so weekly

  // --- Trigger: several top traders agree ---
  MIN_TRADERS: num('MIN_TRADERS', 3),
  WINDOW_HOURS: num('WINDOW_HOURS', 4),
  MIN_BUY_USD: num('MIN_BUY_USD', 100),
  REALERT_HOURS: num('REALERT_HOURS', 24),
  UPGRADE_ALERT_AT: num('UPGRADE_ALERT_AT', 5),
  EXCLUDE_SYMBOLS: str('EXCLUDE_SYMBOLS', 'SOL,WSOL,USDC,USDT,ETH,WETH,CBBTC,WBTC,DAI,USDE,PYUSD')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),

  // --- API budget (fomoapi.io free key: 250,000 credits/month, 20 requests/min) ---
  DAILY_CREDIT_BUDGET: num('DAILY_CREDIT_BUDGET', 7000), // ~210k/month, leaves headroom
  MIN_REQUEST_GAP_MS: num('MIN_REQUEST_GAP_MS', 3500),   // ~17 requests/min, under the 20/min limit
  WS_SILENCE_RECONNECT_SECONDS: num('WS_SILENCE_RECONNECT_SECONDS', 600), // reconnect if the feed goes quiet
  BACKFILL_MAX_PER_DAY: num('BACKFILL_MAX_PER_DAY', 12), // REST catch-up after a feed drop (125 credits each)

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

// fomoapi.io's exact response shapes aren't all documented, so every reader tries
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

    -- Per-trader win rate from recent closed positions (cached; each check costs credits).
    CREATE TABLE IF NOT EXISTS trader_stats (handle TEXT PRIMARY KEY, win_rate REAL, closed_n INTEGER, checked_at INTEGER NOT NULL);

    -- Transactions already decoded by the on-chain watcher (prevents double counting after restarts).
    CREATE TABLE IF NOT EXISTS seen_sigs (sig TEXT PRIMARY KEY, ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS seen_sigs_ts ON seen_sigs (ts);

    -- API usage and fetch health (saturated = some buys in that window may be missing).
    CREATE TABLE IF NOT EXISTS fetch_log (ts INTEGER NOT NULL, endpoint TEXT NOT NULL, status INTEGER, rows INTEGER, saturated INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS fetch_log_ts ON fetch_log (ts);
  `);
  // Columns added after the first release (older databases on the volume get them here).
  for (const ddl of ['ALTER TABLE traders ADD COLUMN sol_wallets TEXT']) {
    try { db.exec(ddl); } catch { /* already there */ }
  }
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
// SECTION 4 — FOMOAPI.IO CLIENT (enforces the free key's credit budget and rate limit)
// Credit costs: leaderboard / positions = 250, alerts catch-up = 125. The live WebSocket feed
// is separate (Section 9).
// =====================================================================================

let lastRequestAt = 0;
let requestChain = Promise.resolve();

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const creditsUsed = () => Number(kvGet(`credits:${utcDay()}`) || 0);
function creditsLeftToday() {
  if (kvGet(`credits_exhausted:${utcDay()}`)) return 0;
  return Math.max(0, CFG.DAILY_CREDIT_BUDGET - creditsUsed());
}

class ApiError extends Error {
  constructor(status, msg, body) {
    super(msg);
    this.status = status;
    this.body = body;
  }
}

// Network errors from fetch() say only "fetch failed"; the real reason is in e.cause.
function netReason(e) {
  const c = e && e.cause;
  if (!c) return e && e.message;
  return [c.code, c.message].filter(Boolean).join(' ') || e.message;
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

async function apiGet(urlPath, estCost = 250) {
  if (!CFG.FOMOAPI_KEY) throw new ApiError(401, 'FOMOAPI_KEY is not set', null);
  if (creditsLeftToday() < estCost) throw new ApiError(402, 'Daily credit budget used (resets 00:00 UTC)', null);

  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await queued(() => fetch(CFG.FOMOAPI_BASE_URL + urlPath, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${CFG.FOMOAPI_KEY}` },
        signal: AbortSignal.timeout(20000),
      }));
    } catch (e) {
      log.warn(`fomoapi ${urlPath.split('?')[0]} network error: ${netReason(e)}`);
      await sleep(5000 * (attempt + 1));
      continue;
    }
    const cost = toNum(res.headers.get('x-credits-cost')) ?? (res.ok ? estCost : 0);
    if (cost) kvSet(`credits:${utcDay()}`, creditsUsed() + cost);
    const remaining = toNum(res.headers.get('x-credits-remaining'));
    if (remaining !== undefined) kvSet('credits_remaining', remaining);

    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    db.prepare('INSERT INTO fetch_log (ts, endpoint, status, rows) VALUES (?, ?, ?, ?)').run(Date.now(), urlPath.split('?')[0], res.status, cost || 0);

    if (res.ok) return json;
    if (res.status === 402) {
      kvSet(`credits_exhausted:${utcDay()}`, '1');
      throw new ApiError(402, 'fomoapi.io credits used up', json);
    }
    if (res.status === 401 || res.status === 403) throw new ApiError(401, 'fomoapi.io key rejected — check FOMOAPI_KEY', json);
    if (res.status === 404) throw new ApiError(404, `fomoapi ${urlPath} -> 404`, json);
    if (res.status === 429 || res.status >= 500) {
      const backoff = res.status === 429 ? 30000 : 5000 * (attempt + 1);
      log.warn(`fomoapi ${urlPath.split('?')[0]} -> ${res.status}, retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      continue;
    }
    throw new ApiError(res.status, `fomoapi ${urlPath} -> ${res.status}`, json);
  }
  throw new ApiError(503, `fomoapi ${urlPath} failed after retries`, null);
}

const qs = (params) => {
  const e = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return e.length ? '?' + new URLSearchParams(e.map(([k, v]) => [k, String(v)])).toString() : '';
};

const fomo = {
  status: () => fetch(`${CFG.FOMOAPI_BASE_URL}/status`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()),
  leaderboard: (window, limit) => apiGet(`/v2/leaderboard/${window}${qs({ limit })}`, 250),
  positions: (handle) => apiGet(`/v2/users/${encodeURIComponent(handle)}/positions`, 250),
  alerts: (params) => apiGet(`/v2/alerts${qs(params)}`, 125),
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
        symbol: best.baseToken.symbol,
      });
    }
  }
  return out;
}
const getPrice = async (chain, mint) => (await getPrices(chain, [mint])).get(mint);

// =====================================================================================
// SECTION 6 — OUTPUT: DISCORD (preferred) or TELEGRAM
// Messages are written once as Telegram-style HTML. When DISCORD_WEBHOOK_URL is set they go to
// Discord only (converted to Discord markdown); set ALSO_TELEGRAM=1 to post to both.
// =====================================================================================

async function tgSend(html) {
  if (!CFG.DISCORD_WEBHOOK_URL) return telegramSend(html);
  const ok = await discordSend(html);
  if (CFG.ALSO_TELEGRAM) await telegramSend(html);
  return ok;
}

// Telegram HTML -> Discord markdown. Text is escaped so handles like @some_trader don't turn italic.
function htmlToDiscord(html) {
  const unent = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const escMd = (s) => unent(s).replace(/([\\*_~`|])/g, '\\$1');
  let out = '';
  let inCode = false;
  const re = /<(\/?)(b|i|code|a)(?:\s+href="([^"]*)")?>|<[^>]+>/g;
  let last = 0;
  let linkHref = null;
  let m;
  while ((m = re.exec(html))) {
    const text = html.slice(last, m.index);
    out += inCode ? unent(text) : escMd(text);
    last = re.lastIndex;
    const [, close, tag, href] = m;
    if (!tag) continue; // unknown tag: drop it
    if (tag === 'b') out += '**';
    else if (tag === 'i') out += '*';
    else if (tag === 'code') { out += '`'; inCode = !close; }
    else if (tag === 'a') {
      if (!close) { linkHref = unent(href || ''); out += '['; }
      else { out += linkHref ? `](<${linkHref}>)` : ']'; linkHref = null; }
    }
  }
  out += inCode ? unent(html.slice(last)) : escMd(html.slice(last));
  return out;
}

// Split on line breaks so no piece exceeds Discord's 2,000-character limit.
function splitForDiscord(text, max = 1900) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { parts.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line.slice(0, max);
  }
  if (cur) parts.push(cur);
  return parts;
}

async function discordSend(html) {
  let allOk = true;
  for (const content of splitForDiscord(htmlToDiscord(html))) {
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const res = await fetch(CFG.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // No pings, no link previews.
          body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: 4 }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) { ok = true; break; }
        const body = await res.json().catch(() => ({}));
        if (res.status === 429) { await sleep(Math.ceil((body.retry_after || 2) * 1000)); continue; }
        log.error(`Discord ${res.status}`, body.message || '');
        if (res.status === 401 || res.status === 404) log.error('Discord webhook rejected — check DISCORD_WEBHOOK_URL');
        break;
      } catch (e) {
        log.warn('Discord send failed', e.message);
        await sleep(3000);
      }
    }
    if (!ok) allOk = false;
  }
  return allOk;
}

async function telegramSend(html) {
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
//   1. Profitable on BOTH the 7d and 30d Fomo leaderboards. One great week isn't enough —
//      that's the luck filter.
//   2. At least MIN_TRADES trades on the 30d board (filters one-lucky-trade wallets).
//   3. Win rate >= MIN_WIN_RATE across their most recent closed positions (checked weekly per
//      trader; judged only when there are MIN_CLOSED_FOR_WIN_RATE+ closed positions).
//   4. Ranked: 30-day rank, then win rate. Keep TRACKED_MAX.
// =====================================================================================

const HANDLE_KEYS = ['handle', 'username', 'user.handle', 'trader.handle'];
const PNL_KEYS = ['pnlUsd', 'pnl_usd', 'pnl', 'realizedPnlUsd'];
const TRADES_KEYS = ['trades', 'numTrades', 'swapCount', 'trade_count'];
const RANK_KEYS = ['rank', 'position'];

// A leaderboard row's Solana wallet(s). The field may be a string, an array, or objects.
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function solanaWallets(r) {
  const raw = first(r, ['wallets.solana', 'wallets.sol', 'solana', 'solanaWallet', 'solana_wallet']);
  const list = (Array.isArray(raw) ? raw : [raw]).map((w) => (w && typeof w === 'object' ? first(w, ['address', 'wallet', 'pubkey']) : w));
  return [...new Set(list.filter((w) => typeof w === 'string' && SOL_ADDR_RE.test(w)))];
}

function readBoard(body) {
  const map = new Map();
  pickArray(body, ['traders', 'data', 'items', 'results', 'leaderboard']).forEach((r, i) => {
    const h = normHandle(first(r, HANDLE_KEYS));
    if (!h) return;
    map.set(h, {
      rank: toNum(first(r, RANK_KEYS)) ?? i + 1,
      pnl: toNum(first(r, PNL_KEYS)),
      trades: toNum(first(r, TRADES_KEYS)),
      userId: first(r, ['userId', 'user_id', 'id']),
      solWallets: solanaWallets(r),
    });
  });
  return map;
}

// Win rate over the trader's recent closed positions (the endpoint returns open positions plus
// the 25 most recent closed trades).
function winRateFromPositions(body) {
  const rows = pickArray(body, ['positions', 'trades', 'data', 'items', 'results']);
  const closed = rows.filter((p) => {
    const st = String(first(p, ['status']) || '').toLowerCase();
    return st ? st === 'closed' : Boolean(first(p, ['closedAt', 'closed_at']));
  });
  const pnls = closed.map((p) => toNum(first(p, ['realizedPnlUsd', 'realized_pnl_usd', 'pnlUsd', 'pnl']))).filter((x) => x !== undefined);
  if (!pnls.length) return { win: undefined, closedN: 0 };
  return { win: (pnls.filter((x) => x > 0).length / pnls.length) * 100, closedN: pnls.length };
}

function passesStats(t) {
  if (t.trades !== undefined && t.trades < CFG.MIN_TRADES) return false;
  if (t.win !== undefined && t.closedN >= CFG.MIN_CLOSED_FOR_WIN_RATE && t.win < CFG.MIN_WIN_RATE) return false;
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

async function cachedWinRate(handle) {
  const row = db.prepare('SELECT * FROM trader_stats WHERE handle = ?').get(handle);
  if (row && Date.now() - row.checked_at < CFG.WIN_RATE_REFRESH_DAYS * D) {
    return { win: row.win_rate ?? undefined, closedN: row.closed_n ?? 0 };
  }
  if (creditsLeftToday() < 1000) return row ? { win: row.win_rate ?? undefined, closedN: row.closed_n ?? 0 } : { win: undefined, closedN: 0 };
  try {
    const r = winRateFromPositions(await fomo.positions(handle));
    db.prepare(`INSERT INTO trader_stats (handle, win_rate, closed_n, checked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(handle) DO UPDATE SET win_rate = excluded.win_rate, closed_n = excluded.closed_n, checked_at = excluded.checked_at`)
      .run(handle, r.win ?? null, r.closedN, Date.now());
    return r;
  } catch (e) {
    log.debug(`positions ${handle} failed`, e.message);
    return row ? { win: row.win_rate ?? undefined, closedN: row.closed_n ?? 0 } : { win: undefined, closedN: 0 };
  }
}

async function refreshTraders() {
  const started = Date.now();
  let lb7 = new Map();
  let lb30 = new Map();
  try { lb7 = readBoard(await fomo.leaderboard('7d', CFG.LEADERBOARD_DEPTH)); } catch (e) { log.warn('7d leaderboard failed', e.message); }
  try { lb30 = readBoard(await fomo.leaderboard('30d', CFG.LEADERBOARD_DEPTH)); } catch (e) { log.warn('30d leaderboard failed', e.message); }
  if (!lb7.size && !lb30.size) throw new Error('both leaderboards unavailable');

  const cands = new Map();
  const add = (h, reason) => {
    const a = lb7.get(h) || {};
    const b = lb30.get(h) || {};
    cands.set(h, {
      handle: h,
      both: lb7.has(h) && lb30.has(h),
      rank7: lb7.has(h) ? a.rank : undefined,
      rank30: lb30.has(h) ? b.rank : undefined,
      pnl7: a.pnl,
      pnl30: b.pnl,
      trades: b.trades ?? a.trades,
      solWallets: [...new Set([...(b.solWallets || []), ...(a.solWallets || [])])],
      reason,
    });
  };
  for (const h of lb7.keys()) {
    if (!lb30.has(h)) continue;
    const p7 = lb7.get(h).pnl;
    const p30 = lb30.get(h).pnl;
    if ((p7 === undefined || p7 > 0) && (p30 === undefined || p30 > 0)) add(h, 'top 7d + top 30d');
  }
  // Fallback if the boards barely overlap: take the strongest 30d names.
  if (cands.size < 5) {
    log.warn(`Only ${cands.size} traders on both boards; adding top 30d names`);
    for (const [h, v] of lb30) if (!cands.has(h) && (v.pnl === undefined || v.pnl > 0)) add(h, 'top 30d (fallback)');
  }

  // Win rates for the strongest candidates (cached weekly).
  const ordered = [...cands.values()].filter((c) => c.trades === undefined || c.trades >= CFG.MIN_TRADES).sort(rankSort);
  for (const c of ordered.slice(0, Math.ceil(CFG.TRACKED_MAX * 1.5))) {
    const r = await cachedWinRate(c.handle);
    c.win = r.win;
    c.closedN = r.closedN;
  }

  const selected = ordered.filter(passesStats).sort(rankSort).slice(0, CFG.TRACKED_MAX);
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
      INSERT INTO traders (handle, active, win_rate, trades, pnl_7d, pnl_30d, rank_7d, rank_30d, reason, selected_at, updated_at, sol_wallets)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(handle) DO UPDATE SET active = 1, win_rate = excluded.win_rate, trades = excluded.trades,
        pnl_7d = excluded.pnl_7d, pnl_30d = excluded.pnl_30d, rank_7d = excluded.rank_7d, rank_30d = excluded.rank_30d,
        reason = excluded.reason, updated_at = excluded.updated_at, sol_wallets = excluded.sol_wallets`);
    for (const c of selected) {
      const win = c.closedN >= CFG.MIN_CLOSED_FOR_WIN_RATE ? c.win : undefined;
      up.run(c.handle, win ?? null, c.trades ?? null, c.pnl7 ?? null, c.pnl30 ?? null, c.rank7 ?? null, c.rank30 ?? null, c.reason, now, now,
        c.solWallets && c.solWallets.length ? JSON.stringify(c.solWallets) : null);
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
  const withWallets = selected.filter((c) => c.solWallets && c.solWallets.length).length;
  log.info(`Following ${selected.length} traders, ${withWallets} with Solana wallets (7d board ${lb7.size}, 30d board ${lb30.size}; +${added} −${dropped}) in ${Math.round((Date.now() - started) / 1000)}s · credits used today ${creditsUsed()}`);
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
// SECTION 9 — WATCHER (live buy feed → followed traders' buys → agreement → alert)
// Buys arrive over fomoapi.io's WebSocket feed as they happen. After a disconnect or restart
// it catches up once over REST, so nothing inside the 4h window is missed.
// =====================================================================================

const CHAIN_IDS = { 1399811149: 'solana', 4663: 'robinhood', 8453: 'base', 1: 'ethereum', 56: 'bsc' };

let trackedCache = { at: 0, set: new Set() };
function trackedSet() {
  if (Date.now() - trackedCache.at > MIN) trackedCache = { at: Date.now(), set: new Set(currentHandles()) };
  return trackedCache.set;
}

function parseBuy(r) {
  const chainId = toNum(first(r, ['chainId', 'chain_id', 'networkId']));
  const tokenObj = r && typeof r.token === 'object' ? r.token : null;
  return {
    action: String(first(r, ['alertType', 'side', 'action', 'kind']) || '').toLowerCase(),
    ts: toMs(first(r, ['execTs', 'ts', 'timestamp', 'blockTs', 'createdAt', 'time'])),
    handle: normHandle(first(r, ['trader.handle', 'handle', 'username']) ?? (typeof r.trader === 'string' ? r.trader : undefined)),
    chain: String(first(r, ['chain', 'network']) || CHAIN_IDS[chainId] || 'solana').toLowerCase(),
    mint: String(first(r, ['tokenAddress', 'token_address', 'token.address', 'mint', 'token_mint']) || ''),
    symbol: tokenObj ? first(tokenObj, ['symbol', 'ticker']) : (typeof r.token === 'string' ? r.token : first(r, ['symbol', 'token_symbol'])),
    // The feed's usdValue isn't always the fill size; prefer tradeUsd when present.
    usd: toNum(first(r, ['tradeUsd', 'usdValue', 'usd', 'usd_amount'])),
    // Transaction hash first, so the same buy seen by both the feed and the on-chain watcher is one row.
    id: first(r, ['txHash', 'signature', 'eventId', 'tradeId', 'id']),
  };
}

// A buy from the fomoapi.io feed. Solana buys by traders the on-chain watcher already covers are
// skipped while that watcher is healthy (it sees every buy, not just the large ones).
function ingestBuy(raw) {
  const b = parseBuy(raw);
  if (b.ts && b.ts > Number(kvGet('last_buy_seen_ts') || 0)) kvSet('last_buy_seen_ts', Math.min(b.ts, Date.now()));
  if (b.chain === 'solana' && onchainCovers(b.handle)) return false;
  return storeBuy(b);
}

// Store one buy if it's from a followed trader and passes the filters. Returns true if new.
function storeBuy(b) {
  if (b.action && !['buy', 'bought', 'swap_in', 'whale'].includes(b.action)) return false;
  if (!b.handle || !trackedSet().has(b.handle) || !b.mint) return false;
  const ts = b.ts || Date.now();
  if (ts < Date.now() - CFG.WINDOW_HOURS * H) return false;
  if (b.usd !== undefined && b.usd < CFG.MIN_BUY_USD) return false;
  if (b.symbol && CFG.EXCLUDE_SYMBOLS.includes(String(b.symbol).toUpperCase())) return false;
  const id = b.id ? `${b.id}:${b.handle}:${b.mint}` : `${b.handle}:${b.mint}:${ts}:${b.usd}`;
  const res = db.prepare('INSERT OR IGNORE INTO buys (id, ts, handle, chain, mint, symbol, usd) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, ts, b.handle, b.chain, b.mint, b.symbol ?? null, b.usd ?? null);
  if (res.changes) log.info(`buy: @${b.handle} ${b.symbol || b.mint.slice(0, 6)} ${fmtUsd(b.usd)} (${b.chain})`);
  return Boolean(res.changes);
}

// Run detection shortly after new buys, batching bursts.
let detectTimer = null;
function scheduleDetect() {
  if (detectTimer) return;
  detectTimer = setTimeout(() => {
    detectTimer = null;
    detect().catch((e) => log.error('detect failed', e.message));
  }, 5000);
}

// REST catch-up for anything missed while the feed was down (or before a restart).
async function backfill() {
  const key = `backfills:${utcDay()}`;
  const done = Number(kvGet(key) || 0);
  if (done >= CFG.BACKFILL_MAX_PER_DAY) { log.debug('backfill limit reached today'); return 0; }
  const floor = Date.now() - CFG.WINDOW_HOURS * H;
  const since = Math.max(floor, Number(kvGet('last_buy_seen_ts') || 0) - 5 * MIN);
  kvSet(key, done + 1);
  let body;
  try {
    body = await fomo.alerts({ type: 'buy', since: Math.floor(since / 1000), limit: 100 });
  } catch (e) {
    log.warn('backfill failed', e.message);
    return 0;
  }
  let n = 0;
  for (const r of pickArray(body, ['alerts', 'data', 'items', 'results', 'events'])) if (ingestBuy(r)) n++;
  log.info(`backfill: ${n} missed followed buys recovered`);
  if (n) await detect();
  return n;
}

// --- Live feed ---
const feed = { ws: null, lastMsgAt: 0, attempts: 0, connectedOnce: false, stopped: false, everConnected: false };

function connectFeed() {
  if (feed.stopped || !CFG.FOMOAPI_KEY) return;
  const url = `${CFG.FOMOAPI_WS_URL}?${new URLSearchParams({ key: CFG.FOMOAPI_KEY, type: 'buy' })}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    log.error('feed: could not open WebSocket', e.message);
    return reconnectLater();
  }
  feed.ws = ws;
  feed.lastMsgAt = Date.now();

  ws.addEventListener('open', () => {
    const wasDown = feed.connectedOnce;
    feed.connectedOnce = true;
    feed.everConnected = true;
    feed.attempts = 0;
    log.info(wasDown ? 'feed: reconnected' : 'feed: connected to live buy feed');
    backfill().catch(() => {});
  });

  ws.addEventListener('message', (ev) => {
    feed.lastMsgAt = Date.now();
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    const items = Array.isArray(msg) ? msg : [msg];
    let fresh = false;
    for (const m of items) {
      const kind = String(m.type || m.event || '').toLowerCase();
      if (kind === 'welcome' || kind === 'subscribed' || kind === 'ping' || kind === 'pong') { log.debug(`feed: ${kind}`); continue; }
      if (kind === 'error') { log.warn('feed error message', JSON.stringify(m).slice(0, 300)); continue; }
      const payload = m.alert || m.data || m;
      if (ingestBuy(payload)) fresh = true;
    }
    if (fresh) scheduleDetect();
  });

  ws.addEventListener('close', (ev) => {
    if (feed.ws !== ws) return;
    feed.ws = null;
    log.warn(`feed: closed (${ev.code}${ev.reason ? ' ' + ev.reason : ''})`);
    if (ev.code === 4001 || ev.code === 4003 || ev.code === 1008) log.error('feed: key refused — check FOMOAPI_KEY');
    reconnectLater();
  });

  ws.addEventListener('error', (ev) => {
    log.warn('feed: socket error', (ev && ev.message) || '');
  });
}

function reconnectLater() {
  if (feed.stopped) return;
  feed.attempts++;
  const delay = Math.min(5 * MIN, 5000 * 2 ** Math.min(feed.attempts - 1, 6));
  setTimeout(connectFeed, delay);
}

// Reconnect if the feed has gone silent (a half-open socket can look connected).
function feedWatchdog() {
  if (!feed.ws) return;
  if (Date.now() - feed.lastMsgAt > CFG.WS_SILENCE_RECONNECT_SECONDS * 1000) {
    log.warn('feed: no messages for a while — reconnecting');
    try { feed.ws.close(); } catch {}
  }
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
  if (!t.symbol && p && p.symbol) t.symbol = p.symbol; // on-chain buys arrive without a ticker

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
// SECTION 9b — ON-CHAIN WALLET WATCH (Helius, Solana)
// Subscribes to every followed trader's Solana wallet and decodes each transaction itself, so
// it sees every buy (not only the larger ones the fomoapi.io feed carries).
//   logsSubscribe(wallet) → new transaction signature → getTransaction → token/SOL balance changes
//   → "spent SOL/USDC/USDT, received token X" = a buy of X worth $Y.
// Credits (free plan 1M/month): ~1 per transaction fetched. A daily cap keeps it well inside that.
// If the key is missing, the cap is hit or the connection drops, the fomoapi.io feed covers again.
// =====================================================================================

const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
// Programs that never mean a swap on their own: plain transfers, token accounts, fees, memos.
const PLUMBING_PROGRAMS = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'ComputeBudget111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TuqgktG3BqyCqiQDgdV6Uf',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

const chainWatch = {
  ws: null,
  wantedKey: '',          // wallet set the current connection subscribed to
  subs: new Map(),        // subscription id -> { wallet, handle }
  pending: new Map(),     // request id -> { wallet, handle }
  nextId: 1,
  lastMsgAt: 0,
  connectedAt: 0,
  downSince: 0,
  attempts: 0,
  stopped: false,
  solPrice: undefined,
  solPriceAt: 0,
  queue: [],
  queued: new Set(),
  working: false,
};

const heliusOn = () => Boolean(CFG.HELIUS_API_KEY);
// Last time anything (a notification or a keepalive reply) came back on the Helius link.
const chainLastHeard = () => Math.max(chainWatch.alive || 0, chainWatch.lastMsgAt || 0);
const heliusRpcUrl = () => `${CFG.HELIUS_RPC_URL}${CFG.HELIUS_API_KEY}`;
const heliusWsUrl = () => `${CFG.HELIUS_WS_URL}${CFG.HELIUS_API_KEY}`;
const heliusUsed = () => Number(kvGet(`helius:${utcDay()}`) || 0);
const heliusCapped = () => heliusUsed() >= CFG.HELIUS_DAILY_TX_CAP;

// Wallets of the traders currently followed: Map(wallet -> handle).
function watchedWallets() {
  const out = new Map();
  for (const r of db.prepare('SELECT handle, sol_wallets FROM traders WHERE active = 1 AND sol_wallets IS NOT NULL').all()) {
    let list = [];
    try { list = JSON.parse(r.sol_wallets); } catch {}
    for (const w of list) if (SOL_ADDR_RE.test(w)) out.set(w, r.handle);
  }
  return out;
}

// True when the on-chain watcher is live and subscribed to this trader's wallet.
function onchainCovers(handle) {
  if (!chainWatch.ws || !chainWatch.connectedAt || heliusCapped()) return false;
  if (Date.now() - chainLastHeard() > 15 * MIN) return false;
  for (const s of chainWatch.subs.values()) if (s.handle === handle) return true;
  return false;
}

async function heliusRpc(method, params) {
  if (heliusCapped()) throw new ApiError(402, 'Helius daily cap reached', null);
  kvSet(`helius:${utcDay()}`, heliusUsed() + 1);
  const res = await fetch(heliusRpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 || res.status === 403) throw new ApiError(401, 'Helius key rejected — check HELIUS_API_KEY', null);
  if (res.status === 429) throw new ApiError(429, 'Helius rate limited', null);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new ApiError(res.status, `Helius ${method}: ${(body.error && body.error.message) || res.status}`, body);
  return body.result;
}

async function refreshSolPrice() {
  if (chainWatch.solPrice && Date.now() - chainWatch.solPriceAt < 5 * MIN) return chainWatch.solPrice;
  const q = await getPrice('solana', WSOL).catch(() => undefined);
  if (q && q.price > 1) { chainWatch.solPrice = q.price; chainWatch.solPriceAt = Date.now(); }
  return chainWatch.solPrice;
}

// Did this transaction call anything beyond transfers/fees? (Skips plain sends without fetching.)
function looksLikeSwap(logs) {
  for (const line of logs || []) {
    const m = /^Program (\S+) invoke/.exec(line);
    if (m && !PLUMBING_PROGRAMS.has(m[1])) return true;
  }
  return false;
}

// Turn a getTransaction (jsonParsed) result into a buy by `wallet`, or null.
function decodeSwap(tx, wallet, solPrice) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const meta = tx.meta;
  const msgObj = (tx.transaction && tx.transaction.message) || {};
  const loaded = meta.loadedAddresses || {};
  const rawKeys = msgObj.accountKeys
    || [...(msgObj.staticAccountKeys || []), ...(loaded.writable || []), ...(loaded.readonly || [])];
  const keys = rawKeys.map((k) => (typeof k === 'string' ? k : k && k.pubkey));
  const idx = keys.indexOf(wallet);

  // Native SOL change (fee added back when the wallet paid it — fees aren't money spent on the token).
  let sol = 0;
  if (idx >= 0 && meta.preBalances && meta.postBalances) {
    sol = (meta.postBalances[idx] - meta.preBalances[idx]) / 1e9;
    if (idx === 0 && meta.fee) sol += meta.fee / 1e9;
  }

  // Token changes for accounts owned by the wallet.
  const delta = new Map();
  const add = (b, sign) => {
    if (!b || b.owner !== wallet) return;
    const amt = Number(b.uiTokenAmount && (b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount));
    if (!Number.isFinite(amt)) return;
    delta.set(b.mint, (delta.get(b.mint) || 0) + sign * amt);
  };
  for (const b of meta.preTokenBalances || []) add(b, -1);
  for (const b of meta.postTokenBalances || []) add(b, +1);

  sol += delta.get(WSOL) || 0;
  delta.delete(WSOL);
  let stableSpent = 0;
  for (const m of STABLES) {
    const d = delta.get(m) || 0;
    if (d < 0) stableSpent += -d;
    delta.delete(m);
  }
  const solSpent = sol < 0 ? -sol : 0;

  const received = [...delta.entries()].filter(([, d]) => d > 0);
  if (!received.length) return null;                 // a sell, a send, or nothing for this wallet
  if (solSpent < 0.001 && stableSpent < 0.5) return null; // received without paying SOL/USD: transfer, airdrop or token→token

  received.sort((a, b) => b[1] - a[1]);
  const usd = (Number.isFinite(solPrice) ? solSpent * solPrice : 0) + stableSpent;
  return {
    mint: received[0][0],
    usd: usd > 0 ? usd : undefined,
    ts: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
  };
}

// Fetch + decode one signature (queued, one at a time, to stay inside the free plan's rate limit).
function enqueueSig(sig, wallet, handle) {
  if (chainWatch.queued.has(sig)) return;
  if (db.prepare('SELECT 1 FROM seen_sigs WHERE sig = ?').get(sig)) return;
  chainWatch.queued.add(sig);
  chainWatch.queue.push({ sig, wallet, handle });
  drainQueue();
}

async function drainQueue() {
  if (chainWatch.working) return;
  chainWatch.working = true;
  try {
    while (chainWatch.queue.length) {
      const job = chainWatch.queue.shift();
      if (heliusCapped()) {
        log.warn('Helius daily cap reached — the fomoapi.io feed covers until 00:00 UTC');
        chainWatch.queue.length = 0;
        chainWatch.queued.clear();
        break;
      }
      try {
        await processSig(job);
      } catch (e) {
        if (e.status === 429) { chainWatch.queue.unshift(job); await sleep(2000); continue; }
        log.warn(`on-chain: ${job.sig.slice(0, 8)}… failed: ${e.message}`);
      }
      // Released only after processing, so a repeat notification mid-fetch isn't fetched twice.
      chainWatch.queued.delete(job.sig);
      await sleep(150);
    }
  } finally {
    chainWatch.working = false;
  }
}

async function processSig({ sig, wallet, handle }) {
  const tx = await heliusRpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: CFG.SOLANA_TX_VERSION, commitment: 'confirmed' }]);
  if (!tx) return; // not yet available; the next notification or catch-up will retry
  db.prepare('INSERT OR IGNORE INTO seen_sigs (sig, ts) VALUES (?, ?)').run(sig, Date.now());
  const buy = decodeSwap(tx, wallet, await refreshSolPrice());
  if (!buy) return;
  if (storeBuy({ action: 'buy', ts: buy.ts, handle, chain: 'solana', mint: buy.mint, symbol: undefined, usd: buy.usd, id: sig })) scheduleDetect();
}

// --- Connection ---
function connectChainWatch() {
  if (chainWatch.stopped || !heliusOn()) return;
  const wallets = watchedWallets();
  if (!wallets.size) { log.debug('on-chain: no wallets yet'); return; }
  let ws;
  try { ws = new WebSocket(heliusWsUrl()); } catch (e) { log.error('on-chain: could not open connection', e.message); return chainReconnectLater(); }
  chainWatch.ws = ws;
  chainWatch.subs.clear();
  chainWatch.pending.clear();
  chainWatch.lastMsgAt = Date.now();
  chainWatch.wantedKey = [...wallets.keys()].sort().join(',');

  ws.addEventListener('open', () => {
    const wasDownFor = chainWatch.downSince ? Date.now() - chainWatch.downSince : 0;
    chainWatch.connectedAt = Date.now();
    chainWatch.attempts = 0;
    for (const [wallet, handle] of wallets) {
      const id = chainWatch.nextId++;
      chainWatch.pending.set(id, { wallet, handle });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [wallet] }, { commitment: 'confirmed' }] }));
    }
    const traders = new Set(wallets.values()).size;
    log.info(`on-chain: watching ${wallets.size} wallets of ${traders} traders`);
    const firstConnect = !chainWatch.caughtUpOnce;
    chainWatch.caughtUpOnce = true;
    if (firstConnect || (chainWatch.downSince && wasDownFor > 60 * 1000)) chainCatchUp().catch(() => {});
    chainWatch.downSince = 0;
    // Helius drops connections it thinks are idle; a small message every minute keeps it open.
    clearInterval(chainWatch.keepAlive);
    chainWatch.keepAlive = setInterval(() => {
      if (chainWatch.ws !== ws) return clearInterval(chainWatch.keepAlive);
      try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'keepalive', method: 'getHealth' })); } catch {}
    }, CFG.HELIUS_KEEPALIVE_SECONDS * 1000);
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    chainWatch.alive = Date.now(); // any reply, keepalive included, means the link is up
    if (msg.id === 'keepalive') return;
    chainWatch.lastMsgAt = Date.now();
    if (msg.id && chainWatch.pending.has(msg.id)) {
      const who = chainWatch.pending.get(msg.id);
      chainWatch.pending.delete(msg.id);
      if (msg.error) log.warn(`on-chain: subscribe failed for @${who.handle}: ${msg.error.message}`);
      else chainWatch.subs.set(msg.result, who);
      return;
    }
    if (msg.method !== 'logsNotification' || !msg.params) return;
    const who = chainWatch.subs.get(msg.params.subscription);
    const v = msg.params.result && msg.params.result.value;
    if (!who || !v || v.err || !v.signature) return;
    if (!looksLikeSwap(v.logs)) return;
    enqueueSig(v.signature, who.wallet, who.handle);
  });

  ws.addEventListener('close', (ev) => {
    if (chainWatch.ws !== ws) return;
    chainWatch.ws = null;
    chainWatch.connectedAt = 0;
    chainWatch.downSince = chainWatch.downSince || Date.now();
    log.warn(`on-chain: connection closed (${ev.code}${ev.reason ? ' ' + ev.reason : ''})`);
    if (ev.code === 1008 || ev.code === 4001 || ev.code === 4003) log.error('on-chain: key refused — check HELIUS_API_KEY');
    chainReconnectLater();
  });
  ws.addEventListener('error', () => log.debug('on-chain: socket error'));
}

function chainReconnectLater() {
  if (chainWatch.stopped) return;
  chainWatch.attempts++;
  setTimeout(connectChainWatch, Math.min(5 * MIN, 5000 * 2 ** Math.min(chainWatch.attempts - 1, 6)));
}

// After a gap, read each wallet's recent signatures so buys made while disconnected still count.
async function chainCatchUp() {
  const since = Date.now() - CFG.WINDOW_HOURS * H;
  let n = 0;
  for (const [wallet, handle] of watchedWallets()) {
    let sigs;
    try { sigs = await heliusRpc('getSignaturesForAddress', [wallet, { limit: 15, commitment: 'confirmed' }]); } catch (e) { log.debug('catch-up failed', e.message); continue; }
    for (const s of sigs || []) {
      if (s.err || (s.blockTime && s.blockTime * 1000 < since)) continue;
      enqueueSig(s.signature, wallet, handle);
      n++;
    }
    await sleep(150);
  }
  log.info(`on-chain catch-up: ${n} recent transactions queued`);
}

// Every few minutes: reconnect if the followed wallets changed, the link went quiet, or it never started.
function chainWatchdog() {
  if (!heliusOn() || chainWatch.stopped) return;
  const want = [...watchedWallets().keys()].sort().join(',');
  if (!chainWatch.ws) {
    if (want && !chainWatch.attempts) connectChainWatch();
    return;
  }
  if (want !== chainWatch.wantedKey) {
    log.info('on-chain: followed traders changed — resubscribing');
    const old = chainWatch.ws;
    chainWatch.ws = null;
    try { old.close(); } catch {}
    connectChainWatch();
    return;
  }
  // Wallet subscriptions can be silent for a while; a quiet link is refreshed rather than trusted.
  if (Date.now() - chainLastHeard() > 10 * MIN) {
    log.debug('on-chain: no replies for 10 min — refreshing connection');
    try { chainWatch.ws.close(); } catch {}
  }
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
  db.prepare('DELETE FROM seen_sigs WHERE ts < ?').run(now - 8 * D);
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
// SECTION 12 — SCHEDULER (startup is silent on Telegram; problems are logged and retried, never crash)
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
      if (e.status === 401) log.error('Fix FOMOAPI_KEY in Railway variables, then redeploy.');
    } finally { running = false; }
  };
  if (immediate) run();
  return setInterval(run, ms);
}

async function maybeRefreshTraders() {
  const last = Number(kvGet('traders_refreshed_at') || 0);
  const have = currentHandles().length;
  // Retry every 30 min until a first list exists; then once per REFRESH_TRADERS_HOURS.
  const fresh = have && Date.now() - last < CFG.REFRESH_TRADERS_HOURS * H;
  // The on-chain watch needs wallets; lists saved before it existed have none. Refetch (cheap: win
  // rates are cached) — at most once a day in case the leaderboard doesn't provide them.
  const needWallets = heliusOn() && have && !db.prepare('SELECT 1 FROM traders WHERE active = 1 AND sol_wallets IS NOT NULL').get()
    && kvGet('wallet_refresh_on') !== utcDay();
  if (fresh && !needWallets) return;
  if (needWallets) kvSet('wallet_refresh_on', utcDay());
  await refreshTraders();
  trackedCache.at = 0;
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
  log.info(`daily: fomoapi credits yesterday ${kvGet(`credits:${utcDay(Date.now() - D)}`) || 0} (month remaining ${kvGet('credits_remaining') ?? '?'}) · Helius transactions yesterday ${kvGet(`helius:${utcDay(Date.now() - D)}`) || 0}`);
  prune();
}

async function main() {
  dbOpen();
  log.info(`fomo-watch v3.1 started · mode ${CFG.MODE} · trigger ${CFG.MIN_TRADERS}+ traders in ${CFG.WINDOW_HOURS}h`);
  if (CFG.DISCORD_WEBHOOK_URL) log.info(`alerts → Discord${CFG.ALSO_TELEGRAM ? ' + Telegram' : ''}`);
  else if (CFG.TELEGRAM_BOT_TOKEN && CFG.TELEGRAM_CHANNEL_ID) log.info('alerts → Telegram');
  else log.warn('No Discord webhook or Telegram variables set — alerts will only be logged');

  if (!CFG.FOMOAPI_KEY) {
    // Stay up (no crash loop) and keep saying what's needed.
    const say = () => log.error('FOMOAPI_KEY is not set. Get a free key at fomoapi.io/dashboard and add it as a Railway variable on this service.');
    say();
    setInterval(say, 10 * MIN);
    return;
  }

  try {
    const st = await fomo.status();
    log.info(`fomoapi.io status: ${first(st, ['status']) || JSON.stringify(st).slice(0, 120)}`);
  } catch (e) {
    log.warn(`fomoapi.io status check failed: ${netReason(e)} — will keep retrying`);
  }

  every('traders', 30 * MIN, maybeRefreshTraders);
  connectFeed();
  if (heliusOn()) {
    log.info(`on-chain wallet watch: on (cap ${CFG.HELIUS_DAILY_TX_CAP} transactions/day)`);
    setInterval(chainWatchdog, 2 * MIN);
    setTimeout(chainWatchdog, 20 * 1000);
  } else {
    log.info('on-chain wallet watch: off (set HELIUS_API_KEY to see every buy, not only large ones)');
  }
  setInterval(feedWatchdog, MIN);
  every('outcomes', CFG.OUTCOME_CHECK_MINUTES * MIN, () => checkOutcomes());
  every('detect', 5 * MIN, () => detect(), { immediate: false }); // safety net alongside the live trigger
  every('weekly', 10 * MIN, maybeWeekly);
  every('housekeeping', 60 * MIN, maybeHousekeeping);
}

// =====================================================================================
// SECTION 13 — COMMANDS: probe / report
// =====================================================================================

async function probe() {
  dbOpen();
  if (!CFG.FOMOAPI_KEY) throw new Error('FOMOAPI_KEY is not set');
  const shape = (label, body, keys) => {
    const rows = pickArray(body, keys);
    console.log(`\n=== ${label} ===`);
    console.log(`top-level: ${Array.isArray(body) ? 'array' : Object.keys(body || {}).join(', ')}`);
    console.log(`rows: ${rows.length}`);
    console.log('first row:', JSON.stringify(rows[0] ?? body, null, 2).slice(0, 1500));
    return rows;
  };
  try { console.log('\n=== status ===\n', JSON.stringify(await fomo.status()).slice(0, 400)); } catch (e) { console.log('status failed:', netReason(e)); }
  const board = readBoard(await fomo.leaderboard('7d', 3));
  shape('leaderboard 7d', await fomo.leaderboard('30d', 3), ['traders']);
  const top = [...board.keys()][0];
  if (top) {
    const pos = await fomo.positions(top);
    shape(`positions @${top}`, pos, ['positions', 'trades']);
    console.log('computed win rate:', JSON.stringify(winRateFromPositions(pos)));
  }
  console.log('\n=== live feed (listening 60s, first 3 messages) ===');
  await new Promise((resolve) => {
    let n = 0;
    const ws = new WebSocket(`${CFG.FOMOAPI_WS_URL}?${new URLSearchParams({ key: CFG.FOMOAPI_KEY, type: 'buy' })}`);
    const done = () => { try { ws.close(); } catch {} resolve(); };
    ws.addEventListener('open', () => console.log('connected'));
    ws.addEventListener('message', (ev) => {
      console.log(String(ev.data).slice(0, 1200));
      const parsed = (() => { try { return JSON.parse(ev.data); } catch { return null; } })();
      if (parsed && parsed.type === 'alert') console.log('parsed as:', JSON.stringify(parseBuy(parsed.alert || parsed.data || parsed)));
      if (++n >= 3) done();
    });
    ws.addEventListener('close', (ev) => { console.log(`closed ${ev.code} ${ev.reason || ''}`); resolve(); });
    ws.addEventListener('error', () => console.log('socket error'));
    setTimeout(done, 60000);
  });
  console.log(`\nCredits used today: ${creditsUsed()} · month remaining: ${kvGet('credits_remaining') ?? '?'}`);
  if (heliusOn()) await probeOnchain();
}

// Checks the Helius key and decodes a few real recent transactions of followed traders (~30 credits).
async function probeOnchain() {
  dbOpen();
  if (!heliusOn()) throw new Error('HELIUS_API_KEY is not set');
  console.log('\n=== on-chain (Helius) ===');
  console.log('health:', JSON.stringify(await heliusRpc('getHealth', [])));
  let wallets = watchedWallets();
  if (!wallets.size && CFG.FOMOAPI_KEY) {
    for (const [h, v] of readBoard(await fomo.leaderboard('7d', 10))) for (const w of v.solWallets || []) wallets.set(w, h);
  }
  console.log(`wallets known: ${wallets.size}`);
  const sol = await refreshSolPrice();
  console.log(`SOL price: ${fmtPrice(sol)}`);
  let shown = 0;
  for (const [wallet, handle] of [...wallets].slice(0, 3)) {
    const sigs = await heliusRpc('getSignaturesForAddress', [wallet, { limit: 8 }]);
    console.log(`\n@${handle} ${wallet.slice(0, 6)}… — ${sigs.length} recent transactions`);
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await heliusRpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: CFG.SOLANA_TX_VERSION }]);
      const buy = decodeSwap(tx, wallet, sol);
      const when = s.blockTime ? new Date(s.blockTime * 1000).toISOString().slice(0, 16) : '?';
      console.log(`  ${when}  ${buy ? `BUY ${buy.mint.slice(0, 8)}… ${fmtUsd(buy.usd)}` : 'not a buy'}  ${s.signature.slice(0, 10)}…`);
      shown++;
    }
  }
  console.log('\nlive subscription test (20s):');
  const [w0] = [...wallets.keys()];
  if (w0) {
    await new Promise((resolve) => {
      const ws = new WebSocket(heliusWsUrl());
      const done = () => { try { ws.close(); } catch {} resolve(); };
      ws.addEventListener('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [w0] }, { commitment: 'confirmed' }] })));
      ws.addEventListener('message', (ev) => console.log(' ', String(ev.data).slice(0, 300)));
      ws.addEventListener('close', (ev) => { console.log(`  closed ${ev.code}`); resolve(); });
      ws.addEventListener('error', () => console.log('  socket error'));
      setTimeout(done, 20000);
    });
  }
  console.log(`\nHelius calls today: ${heliusUsed()} (decoded ${shown} transactions)`);
}

if (require.main === module) {
  const cmd = process.argv[2];
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log.info(`${sig} — shutting down`); feed.stopped = true; chainWatch.stopped = true; dbClose(); process.exit(0); });
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', e && e.message));

  if (cmd === 'probe') {
    probe().then(() => process.exit(0)).catch((e) => {
      console.error('probe failed:', e.message, e.body ? JSON.stringify(e.body).slice(0, 500) : '');
      process.exit(1);
    });
  } else if (cmd === 'onchain') {
    probeOnchain().then(() => process.exit(0)).catch((e) => { console.error('on-chain check failed:', e.message); process.exit(1); });
  } else if (cmd === 'report') {
    dbOpen();
    console.log(weeklyMessage(buildReport()).replace(/<[^>]+>/g, ''));
  } else {
    // Never exit on a startup error: log it and keep the process alive so Railway doesn't crash-loop.
    main().catch((e) => {
      log.error(`startup problem: ${e.message} — retrying in 5 minutes`);
      setTimeout(() => main().catch((err) => log.error('startup retry failed', err.message)), 5 * MIN);
    });
  }
}

// Exported for the offline test.
module.exports = {
  dbOpen, kvGet, kvSet, get db() { return db; }, refreshTraders, ingestBuy, backfill, detect, connectFeed, feed,
  checkOutcomes, prune, buildReport, weeklyMessage, toMs, toPct, winRateFromPositions, parseBuy, htmlToDiscord, splitForDiscord,
  decodeSwap, looksLikeSwap, solanaWallets, chainWatch, connectChainWatch, chainWatchdog, onchainCovers, storeBuy,
  _resetTracked: () => { trackedCache.at = 0; },
};
