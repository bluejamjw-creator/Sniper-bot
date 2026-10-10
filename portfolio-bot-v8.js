/**
 * portfolio-bot-v8.js — PART 1 of 3
 *
 * Follow-up fix, confirmed necessary from live production logs
 * AFTER the dbTimeoutMs fix was already deployed and working.
 *
 * To deploy:
 *   cat portfolio-bot-v8.part1.js portfolio-bot-v8.part2.js \
 *       portfolio-bot-v8.part3.js > portfolio-bot-v8.js
 *
 * WHAT THE LOGS SHOWED: the timeout fix was confirmed working —
 * every failure now reads 'AbortError: This operation was
 * aborted' instead of hanging indefinitely. But cycles were
 * STILL effectively stuck: a continuous 32+ minute run (17:49 to
 * past 18:21, still going) cycling through snapshots -> examples
 * -> detections -> hunter_observation_history, batch after
 * batch, never catching up. Root cause: persistDetections()
 * already batches 8 detections concurrently (an earlier fix,
 * comment timestamped before this session), but WITHIN each
 * detection, saveSnapshot -> createExample -> saveDetection are
 * awaited sequentially — up to 3 x 15s = 45s per detection even
 * with batching, and ~150+ detections per cycle. The 15s cap
 * stopped any single call hanging forever; it didn't cap the
 * total when there are hundreds of doomed calls in a row.
 *
 * Also visible in the same logs: 'Railway rate limit of 500
 * logs/sec reached ... Messages dropped: 354' — the failure
 * logging itself was hitting Railway's own rate limit.
 *
 * FIX: a circuit breaker. dbCircuitOpen()/dbRecordFailure()/
 * dbRecordSuccess() track a consecutive-failure streak across
 * dbInsert/dbUpdate/dbUpsert. 5 consecutive failures (CONFIG.
 * dbCircuitFailureThreshold) trips it; while open, every write
 * fails instantly — no network attempt, no 15s wait, no new log
 * line — for CONFIG.dbCircuitCooldownMs (2 minutes), then resets
 * to try again. A fully-dead database now produces a fast,
 * mostly-silent cycle instead of a 30+ minute one, and cuts the
 * log volume that was itself hitting Railway's rate limit.
 *
 * VERIFIED against the real extracted helper functions (not
 * just reasoning about them) across 5 scenarios: closed before
 * any failures, stays closed through 4 failures, trips exactly
 * on the 5th with the streak reset to 0, stays open through the
 * cooldown window, closes the instant the cooldown passes, and a
 * success resets the streak when closed. All five matched
 * exactly.
 */
/**
 * portfolio-bot-v8.js — PART 1 of 3
 *
 * To deploy:
 *   cat portfolio-bot-v8.part1.js portfolio-bot-v8.part2.js \
 *       portfolio-bot-v8.part3.js > portfolio-bot-v8.js
 *
 * THIS PASS — startup resilience against a transient Supabase
 * failure. Found from the actual crash: 'Startup failed: Unable
 * to load open positions: Gateway Timeout' at loadActivePositions,
 * which threw and killed the process, and Railway then
 * crash-looped on the identical failure the whole time Supabase
 * was down. No trading logic touched — score 70, 10 max
 * positions, 2/cycle, learning, universe, OPEN logic all
 * unchanged, exactly as scoped.
 *
 * 1. loadActivePositions() now retries (3 attempts, 3s/8s
 *    backoff) before giving up, and never throws. On persistent
 *    failure it does NOT pretend zero positions are open —
 *    that would risk a real duplicate if a position was
 *    actually held. Instead it sets STATE.positionStateUnknown
 *    and returns -1.
 *
 * 2. canOpen() refuses every new open while that flag is set —
 *    this is the actual safeguard, not just 'stay alive'.
 *    Scanning, learning, and snapshot persistence all continue
 *    normally throughout.
 *
 * 3. Self-healing: runCycle() retries the load once per cycle
 *    while the flag is set, so recovery doesn't need a manual
 *    Railway restart once Supabase comes back — new opens
 *    resume the moment a load actually succeeds.
 *
 * VERIFIED against the real extracted function with a mocked
 * database in three scenarios: always fails (0 throws, -1
 * returned, flag set, exactly 3 attempts), fails twice then
 * recovers on the 3rd (flag clears, correct count), and
 * immediate success (single call, no wasted retries). All
 * three matched expectations exactly.
 */
/**
 * portfolio-bot-v8.js — PART 1 of 3
 *
 * To deploy:
 *   cat portfolio-bot-v8.part1.js portfolio-bot-v8.part2.js \
 *       portfolio-bot-v8.part3.js > portfolio-bot-v8.js
 *
 * THIS PASS — Wealth Engine hardening against database failure.
 * Hunter is unchanged. (The Wealth Engine itself is not yet
 * deployed, so none of this has run live.)
 *
 * Found while investigating a Supabase outage (database out of
 * disk space, crash-looping): the Wealth Engine would have
 * misbehaved badly under exactly that condition.
 *
 * 1. PERSIST BEFORE ALERT. OPEN, WARNING and CLOSE alerts were
 *    sent whether or not the state change actually saved. During
 *    an outage that means an unrecorded 'WEALTH OPEN' alert every
 *    hour, forever. Each path now checks the write succeeded and
 *    suppresses the alert (with a log line) if it didn't — the
 *    same principle Hunter's openPosition() already follows.
 *
 * 2. ERRORS NO LONGER LOOK LIKE 'NOTHING THERE'. currentWealth
 *    Position() returned null on a database error, which the
 *    caller reads as 'no position exists'; countOpenWealth
 *    Positions() returned 0, which reads as 'plenty of free
 *    slots' and would bypass the cap of 6. Both now throw, so
 *    wealthCycle()'s existing per-asset try/catch skips that
 *    asset for the cycle instead.
 *
 * 3. FIXED a hardcoded '0.0%' in the WARNING message (copied
 *    literally from the brief's example). Warnings claimed every
 *    position was flat. Now shows the real return from entry.
 *
 * VERIFIED: ran the real engine code against a mocked database
 * in six scenarios — healthy open (1 alert), insert fails (0),
 * lookup errors (throws, 0), close with failed update (0), close
 * with good update (1), warning (real return shown). All correct.
 *
 * Also cleaned out stacked per-pass header comments that had
 * accumulated across earlier splits (comments only, no code).
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

// =====================================================================
// NEON / POSTGRES ADAPTER
// Replaces @supabase/supabase-js. Exposes the small slice of the
// Supabase query-builder API that Hunter actually uses, over the plain
// `pg` driver, so none of Hunter's query code has to change:
//   from(t).select(cols,{count,head}) .insert(rowOrRows) .update(row)
//   .upsert(row,{onConflict}) .delete({count})
//   .eq .gt .gte .lt .lte .in .not(col,'in','("A","B")')
//   .order(col,{ascending}) .limit(n) .maybeSingle() .single()
//   .abortSignal(signal)
// Every call resolves to { data, error, count } and never throws for a
// database error (same contract as supabase-js).
// =====================================================================

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name) {
  if (!IDENT.test(name)) {
    throw new Error(`invalid identifier: ${name}`);
  }
  return `"${name}"`;
}

function toParam(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function inferPgType(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'double precision';
  if (value !== null && typeof value === 'object') return 'jsonb';
  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)
  ) {
    return 'timestamptz';
  }
  return 'text';
}

function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

class Builder {
  constructor(pool, table) {
    this.pool = pool;
    this.table = table;
    this.op = 'select';
    this.cols = '*';
    this.countMode = null;
    this.head = false;
    this.rows = null;
    this.patch = null;
    this.conflict = null;
    this.wantReturn = false;
    this.filters = [];
    this.orders = [];
    this.limitN = null;
    this.mode = 'many'; // many | maybe | single
    this.signal = null;
  }

  select(cols = '*', opts = {}) {
    if (this.op === 'select') {
      this.cols = cols || '*';
      if (opts.count) this.countMode = opts.count;
      if (opts.head) this.head = true;
    } else {
      // insert/update/upsert(...).select() => RETURNING
      this.wantReturn = true;
      this.cols = cols || '*';
    }
    return this;
  }

  insert(rows) {
    this.op = 'insert';
    this.rows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  upsert(rows, opts = {}) {
    this.op = 'upsert';
    this.rows = Array.isArray(rows) ? rows : [rows];
    this.conflict = opts.onConflict || null;
    this.ignoreDuplicates = Boolean(opts.ignoreDuplicates);
    return this;
  }

  update(patch) {
    this.op = 'update';
    this.patch = patch;
    return this;
  }

  delete(opts = {}) {
    this.op = 'delete';
    if (opts.count) this.countMode = opts.count;
    return this;
  }

  eq(c, v) { this.filters.push({ c, op: '=', v }); return this; }
  neq(c, v) { this.filters.push({ c, op: '<>', v }); return this; }
  gt(c, v) { this.filters.push({ c, op: '>', v }); return this; }
  gte(c, v) { this.filters.push({ c, op: '>=', v }); return this; }
  lt(c, v) { this.filters.push({ c, op: '<', v }); return this; }
  lte(c, v) { this.filters.push({ c, op: '<=', v }); return this; }

  in(c, list) {
    this.filters.push({ c, op: 'IN', v: list });
    return this;
  }

  // Trusted-code-only escape hatch: `sql` must be a constant written in
  // this file (never user data), with ? placeholders for the values.
  whereRaw(sql, values = []) {
    this.filters.push({ raw: sql, values });
    return this;
  }

  // Supports not(col,'in','("A","B")') and not(col,'eq'|'is',value)
  not(c, operator, value) {
    if (operator === 'in') {
      const list = String(value)
        .replace(/^\(|\)$/g, '')
        .split(',')
        .map(s => s.trim().replace(/^"|"$/g, ''))
        .filter(s => s.length);
      this.filters.push({ c, op: 'NOT IN', v: list });
    } else if (operator === 'eq') {
      this.filters.push({ c, op: '<>', v: value });
    } else if (operator === 'is' && value === null) {
      this.filters.push({ c, op: 'IS NOT NULL' });
    } else {
      throw new Error(`unsupported not() operator: ${operator}`);
    }
    return this;
  }

  order(c, opts = {}) {
    this.orders.push({ c, asc: opts.ascending !== false });
    return this;
  }

  limit(n) { this.limitN = n; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  single() { this.mode = 'single'; return this; }
  abortSignal(s) { this.signal = s; return this; }

  _where(params) {
    if (!this.filters.length) return '';
    const parts = this.filters.map(f => {
      if (f.raw) {
        let out = f.raw;
        for (const v of f.values) {
          params.push(toParam(v));
          out = out.replace('?', `$${params.length}`);
        }
        return `(${out})`;
      }
      const col = ident(f.c);
      if (f.op === 'IS NOT NULL') return `${col} IS NOT NULL`;
      if (f.op === 'IN' || f.op === 'NOT IN') {
        if (!f.v.length) return f.op === 'IN' ? 'FALSE' : 'TRUE';
        const ph = f.v.map(x => {
          params.push(toParam(x));
          return `$${params.length}`;
        });
        return `${col} ${f.op} (${ph.join(',')})`;
      }
      params.push(toParam(f.v));
      return `${col} ${f.op} $${params.length}`;
    });
    return ` WHERE ${parts.join(' AND ')}`;
  }

  _selectList() {
    if (this.cols === '*' || !this.cols) return '*';
    return String(this.cols)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(ident)
      .join(',');
  }

  _build() {
    const params = [];
    const t = ident(this.table);
    const ret = this.wantReturn ? ` RETURNING ${this._selectList()}` : '';

    if (this.op === 'select') {
      if (this.head) {
        return { sql: `SELECT count(*)::int AS n FROM ${t}${this._where(params)}`, params, kind: 'count' };
      }
      let sql = `SELECT ${this._selectList()} FROM ${t}${this._where(params)}`;
      if (this.orders.length) {
        sql += ' ORDER BY ' + this.orders
          .map(o => `${ident(o.c)} ${o.asc ? 'ASC' : 'DESC'}`)
          .join(', ');
      }
      const lim = this.mode === 'many' ? this.limitN : Math.min(this.limitN || 2, 2);
      if (lim != null) sql += ` LIMIT ${Number(lim) | 0}`;
      return { sql, params, kind: 'rows' };
    }

    if (this.op === 'insert' || this.op === 'upsert') {
      const keys = [...new Set(this.rows.flatMap(r => Object.keys(r)))];
      const cols = keys.map(ident).join(',');
      const tuples = this.rows.map(r =>
        '(' + keys.map(k => {
          params.push(toParam(r[k]));
          return `$${params.length}`;
        }).join(',') + ')'
      );
      let sql = `INSERT INTO ${t} (${cols}) VALUES ${tuples.join(',')}`;
      if (this.op === 'upsert') {
        const target = (this.conflict || 'id')
          .split(',').map(s => ident(s.trim())).join(',');
        const targetNames = (this.conflict || 'id').split(',').map(s => s.trim());
        const updatable = keys.filter(k => !targetNames.includes(k));
        if (this.ignoreDuplicates || !updatable.length) {
          sql += ` ON CONFLICT (${target}) DO NOTHING`;
        } else {
          sql += ` ON CONFLICT (${target}) DO UPDATE SET ` +
            updatable.map(k => `${ident(k)} = EXCLUDED.${ident(k)}`).join(', ');
        }
      }
      return { sql: sql + ret, params, kind: this.wantReturn ? 'rows' : 'rowcount', writeKeys: keys, writeRows: this.rows };
    }

    if (this.op === 'update') {
      const keys = Object.keys(this.patch);
      const sets = keys.map(k => {
        params.push(toParam(this.patch[k]));
        return `${ident(k)} = $${params.length}`;
      });
      const sql = `UPDATE ${t} SET ${sets.join(', ')}${this._where(params)}${ret}`;
      return { sql, params, kind: this.wantReturn ? 'rows' : 'rowcount', writeKeys: keys, writeRows: [this.patch] };
    }

    if (this.op === 'delete') {
      return { sql: `DELETE FROM ${t}${this._where(params)}`, params, kind: 'rowcount' };
    }

    throw new Error(`unsupported op ${this.op}`);
  }

  async _run(q) {
    if (this.signal && this.signal.aborted) throw abortError();
    const exec = this.pool.query(q.sql, q.params);
    if (!this.signal) return exec;
    exec.catch(() => {}); // an abandoned (aborted) query must not raise unhandled rejections
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) return reject(abortError());
      const onAbort = () => reject(abortError());
      this.signal.addEventListener('abort', onAbort, { once: true });
      exec.then(
        r => { this.signal.removeEventListener('abort', onAbort); resolve(r); },
        e => { this.signal.removeEventListener('abort', onAbort); reject(e); }
      );
    });
  }

  // Self-healing: if a write names a column that does not exist yet,
  // add it (type inferred from the value) and retry once.
  async _addMissingColumns(q) {
    for (const k of q.writeKeys || []) {
      const sample = (q.writeRows || []).map(r => r[k]).find(v => v !== null && v !== undefined);
      await this.pool.query(
        `ALTER TABLE ${ident(this.table)} ADD COLUMN IF NOT EXISTS ${ident(k)} ${inferPgType(sample)}`
      );
    }
  }

  async _exec() {
    let q;
    try {
      q = this._build();
    } catch (e) {
      return { data: null, error: { message: e.message }, count: null };
    }

    let result;
    try {
      try {
        result = await this._run(q);
      } catch (e) {
        if (e && e.code === '42703' && q.writeKeys) {
          await this._addMissingColumns(q);
          result = await this._run(q);
        } else {
          throw e;
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      return {
        data: null,
        error: { message: e.message || String(e), code: e.code },
        count: null,
      };
    }

    if (q.kind === 'count') {
      return { data: null, error: null, count: result.rows[0].n };
    }
    if (q.kind === 'rowcount') {
      return {
        data: null,
        error: null,
        count: this.countMode ? result.rowCount : null,
      };
    }

    const rows = result.rows;
    let count = null;
    if (this.countMode) count = rows.length;

    if (this.mode === 'many') return { data: rows, error: null, count };
    if (this.mode === 'maybe') {
      if (rows.length > 1) {
        return { data: null, error: { message: 'multiple rows returned for maybeSingle()' }, count };
      }
      return { data: rows[0] || null, error: null, count };
    }
    if (rows.length !== 1) {
      return { data: null, error: { message: `expected 1 row, got ${rows.length}` }, count };
    }
    return { data: rows[0], error: null, count };
  }

  then(resolve, reject) {
    return this._exec().then(resolve, reject);
  }
}

function createNeonClient(connectionString, deps = {}) {
  let pool = deps.pool;

  if (!pool) {
    const { Pool, types } = require('pg');

    // Match supabase-js output: timestamps as ISO strings, bigint/numeric as numbers.
    types.setTypeParser(1184, v => new Date(v).toISOString()); // timestamptz
    types.setTypeParser(1114, v => new Date(v + 'Z').toISOString()); // timestamp
    types.setTypeParser(20, v => Number(v)); // int8
    types.setTypeParser(1700, v => Number(v)); // numeric

    pool = new Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000, // allows for Neon scale-to-zero wake-up
      statement_timeout: 20000,
      keepAlive: true,
    });

    pool.on('error', err => {
      console.error(`[DB] pool error: ${err.message}`);
    });
  }

  return {
    from: table => new Builder(pool, table),
    pool,
  };
}



const ENV = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  BLUEJAM_CHAT_ID: process.env.BLUEJAM_CHAT_ID || process.env.CHAT_ID,
  CHANNEL_CHAT_ID: process.env.CHANNEL_CHAT_ID,
  // CHANGED: Hunter now stores its data in Neon (plain Postgres) instead
  // of Supabase. Set NEON_DATABASE_URL in Railway (the pooled connection
  // string from the Neon dashboard). Supabase variables are ignored.
  DATABASE_URL:
    process.env.NEON_DATABASE_URL ||
    process.env.HUNTER_DATABASE_URL,
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

  // ADDED: retention window for raw history. 30 days keeps a full
  // month of real material for exactly the kind of audits this project
  // has relied on (score-bucket analysis, opportunity reconstruction,
  // execution-profile tracing) while bounding growth — this is what
  // actually filled the database (hunter_v11_detections alone reached
  // 230,000+ rows / 450MB with zero retention), not scan frequency or
  // universe size. Does not touch hunter_v11_examples resolution logic
  // (max horizon is 96h, so anything past 30 days is long since
  // resolved) or hunter_observation_history (excluded for now — its
  // exact timestamp column wasn't confirmed while the database was
  // down; add it once that's checked, don't guess a column name).
  // CHANGED for Neon free tier (0.5 GB cap): was 30. Hunter's learning
  // window is 120h (5 days), so 6 days keeps everything it needs.
  retentionDays: 6,

  // ADDED: only detections/observations scoring at least this are stored
  // in full. Low scorers (the other ~85% of the ~150 assets scanned per
  // cycle) still produce a slim snapshot + learning example, which is
  // all the learning needs, but skip the two bulky detail tables.
  persistDetailMinScore: 50,

  // ADDED: caps every dbInsert/dbUpdate/dbUpsert call — see
  // dbTimeoutSignal() for why this exists. 15s is generous for a
  // healthy database and short enough that even a worst-case cycle
  // (every one of 10 open positions timing out) adds minutes, not
  // hours, to a single cycle.
  dbTimeoutMs: 15000,

  // ADDED: circuit breaker thresholds — see STATE.dbConsecutiveFailures.
  // 5 consecutive failures (across any combination of insert/update/
  // upsert calls) is enough to distinguish "database is actually down"
  // from "one request had a bad moment"; 2 minutes is short enough to
  // retry soon if it recovers mid-session, long enough to actually stop
  // the bleeding instead of re-tripping immediately.
  dbCircuitFailureThreshold: 5,
  dbCircuitCooldownMs: 2 * 60 * 1000,

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

  maxOpenPositions: 3,
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
  // CHANGED: was 0.02. Confirmed via live detection data (Sept 19) that
  // learned contrast is coming back negative across virtually every
  // candidate regardless of quality — MORPHOUSDT scored 88/100 with
  // 8-9 signals in ACCELERATING stage and was still blocked at -0.044.
  // Most likely cause: the negative example pool for the +50/+100/+150
  // targets is structurally much larger than the positive pool this
  // early (far more assets fail a big target than hit it), so
  // topSimilarity()'s top-12-average has a bigger candidate set to draw
  // from on the negative side even with averaging, not just a single
  // nearest-neighbor comparison. Not fully confirmed as the sole cause —
  // could also be genuine early-data noise — but the practical effect is
  // undeniable: this gate isn't currently discriminating quality, it's
  // blocking everything unconditionally. Loosened to only catch truly
  // extreme negative contrast rather than the -0.01 to -0.17 range
  // currently observed on legitimate high-scoring candidates. Revisit
  // once the +50/+100/+150 positive example counts grow closer to the
  // negative pool size, or the pool-size asymmetry is fixed directly in
  // topSimilarity()/learnedSimilarity().
  alertLearnedContrast: -0.30,



  // Must cover the longest +150% learning horizon (96h)
  // plus a useful safety buffer.
  learningLookbackHours: 120,
  learningExamplesPerClass: 800,
  eodReportHourUtc: 20, // 20:00 UTC = 21:00 BST / 20:00 GMT
  learningModelRefreshMs: 2 * 60 * 60 * 1000,

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

if (ENV.DATABASE_URL) {
  try {
    supabase = createNeonClient(ENV.DATABASE_URL);
  } catch (error) {
    console.error(
      `[HUNTER] database client failed to initialise: ${error.message}`
    );
  }
}

// ======================= HUNTER STOCKS (embedded) =======================
// Separate US-stock scanner: own tables, own cycle, owner-only alerts.
// Kept self-contained so it can never touch the crypto pipeline. Source
// is also kept standalone in stock-shadow.js for testing.
const STOCKS = (() => {
  const module = { exports: {} };
/**
 * HUNTER STOCKS — separate US-stock scanner, run like production.
 *
 * - Own tables (stock_shadow_*). Never touches hunter_v11_* tables, the
 *   crypto examples, scoring or learning.
 * - Sends OPEN / TP-milestone / CLOSE / end-of-day alerts to the OWNER
 *   chat only (via the notify callback Hunter passes in). No orders.
 *   Must never go to the channel: Finnhub's free plan is personal use and
 *   forbids sharing data or derived results without written approval.
 * - Data: Finnhub FREE plan, /quote only (no candle history), so the
 *   scanner builds its own history by polling ~40 symbols every 15 min
 *   during US hours, paced under the 60 calls/min limit.
 * - Fixed bracket per position (SL from the day's range, TP = 4x SL),
 *   max 3 open at once, 14-day max hold. SL/TP/milestones are judged on
 *   SAMPLED prices (price at each poll), so a spike between polls is
 *   missed and fills on Revolut can differ.
 * - Signals without enough observations are INCOMPLETE, not counted.
 * - Only runs if FINNHUB_API_KEY is set; Hunter loads it in try/catch.
 */

const https = require('https');

const DEFAULT_SYMBOLS = [
  'NVDA', 'TSLA', 'AMD', 'PLTR', 'SMCI', 'COIN', 'MSTR', 'HOOD', 'SOFI', 'RIVN',
  'UPST', 'AFRM', 'RKLB', 'IONQ', 'RGTI', 'SOUN', 'HIMS', 'APP', 'CRWD', 'SNOW',
  'DKNG', 'MARA', 'RIOT', 'CLSK', 'BBAI', 'ACHR', 'JOBY', 'LUNR', 'ASTS', 'QBTS',
  'OKLO', 'SMR', 'VST', 'CCJ', 'ENPH', 'PLUG', 'NIO', 'LCID', 'AI', 'U',
];

const CFG = {
  pollMs: 15 * 60 * 1000,
  throttleMs: 1200,            // ~50 calls/min, under the 60/min free limit
  quoteRetentionDays: 5,
  signalWindowDays: 14,        // how long a signal is tracked
  cooldownDays: 5,             // per symbol
  maxSignalsPerDay: 5,
  minDayChange: 3,             // % vs previous close
  maxDayChange: 12,            // above this the move has already happened
  minRangePos: 0.8,            // price in top 20% of the day's range
  targets: [10, 25, 50, 100],
  maxOpen: 3,
  slMinPct: 3, slMaxPct: 8, slRangeMult: 1.5, tpR: 4,
  eodHourUtc: 21, eodMinute: 10,
};

const fmtP = v => {
  const a = Math.abs(v);
  return v.toFixed(a >= 100 ? 2 : a >= 1 ? 3 : 4).replace(/0+$/, '').replace(/\.$/, '');
};
const fmtPct = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

function getJson(url) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: 10000 }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Mon-Fri, roughly 13:25-21:05 UTC (covers US open to close in both EDT and EST).
function usMarketWindow(d = new Date()) {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 13 * 60 + 25 && m <= 21 * 60 + 5;
}

async function ensureSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS stock_shadow_quotes (
    id bigserial PRIMARY KEY,
    symbol text NOT NULL,
    polled_at timestamptz NOT NULL DEFAULT now(),
    quote_time timestamptz,
    price double precision,
    day_high double precision,
    day_low double precision,
    day_open double precision,
    prev_close double precision
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS stock_shadow_quotes_sym_idx ON stock_shadow_quotes (symbol, polled_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stock_shadow_signals (
    id bigserial PRIMARY KEY,
    symbol text NOT NULL,
    signaled_at timestamptz NOT NULL DEFAULT now(),
    ref_price double precision NOT NULL,
    day_change_pct double precision,
    range_pos double precision,
    status text NOT NULL DEFAULT 'TRACKING',
    max_price double precision,
    min_price double precision,
    max_gain_pct double precision,
    max_drawdown_pct double precision,
    hit_10_at timestamptz,
    hit_25_at timestamptz,
    hit_50_at timestamptz,
    hit_100_at timestamptz,
    dd_before_10_pct double precision,
    min_price_pre10 double precision,
    sl_price double precision,
    tp_price double precision,
    tp_milestone double precision DEFAULT 0,
    close_price double precision,
    close_reason text,
    closed_at timestamptz,
    obs_count integer NOT NULL DEFAULT 0,
    last_seen_at timestamptz,
    resolved_at timestamptz
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS stock_shadow_signals_status_idx ON stock_shadow_signals (status, symbol)`);
}

async function ensureEod(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS stock_shadow_eod (day date PRIMARY KEY, sent_at timestamptz NOT NULL DEFAULT now())`);
}

async function fetchQuote(symbol, key) {
  const { status, json } = await getJson(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`
  );
  if (status === 429) return { rateLimited: true };
  if (status === 401 || status === 403) { console.error(`[STOCK-SHADOW] Finnhub auth/entitlement error ${status} for ${symbol}`); return null; }
  if (status !== 200 || !json) { console.error(`[STOCK-SHADOW] ${symbol}: HTTP ${status}`); return null; }
  const ok = [json.c, json.h, json.l, json.pc].every(v => Number.isFinite(v) && v > 0) && json.h >= json.l && json.c <= json.h * 1.0001 && json.c >= json.l * 0.9999;
  if (!ok || !json.t || Math.abs(Date.now() - json.t * 1000) > 10 * 86400000) return null;
  return {
    price: json.c, high: json.h, low: json.l, open: json.o, prevClose: json.pc,
    time: json.t ? new Date(json.t * 1000).toISOString() : null,
  };
}

async function runCycle(db, key, symbols, state, fetcher = fetchQuote, notify = async () => {}) {
  const quotes = new Map();
  let calls = 0;
  for (const sym of symbols) {
    const q = await fetcher(sym, key);
    calls++;
    if (q && q.rateLimited) { console.log('[STOCK-SHADOW] 429 rate limited, ending cycle and pausing 5 min'); state.pauseUntil = Date.now() + 5 * 60000; break; }
    if (q) {
      // Finnhub repeats the last quote when the market is closed/holiday: skip unchanged.
      const last = state.lastQuoteTime.get(sym);
      if (q.time && last === q.time) { await sleep(state.throttleMs); continue; }
      state.lastQuoteTime.set(sym, q.time);
      quotes.set(sym, q);
      await db.from('stock_shadow_quotes').insert({
        symbol: sym, quote_time: q.time, price: q.price, day_high: q.high,
        day_low: q.low, day_open: q.open, prev_close: q.prevClose,
      });
    }
    await sleep(state.throttleMs);
  }

  console.log(`[STOCK-SHADOW] ${calls} API calls, ${quotes.size} fresh quotes`);
  await trackSignals(db, quotes, notify);
  await detectSignals(db, quotes, notify);
  return quotes.size;
}

async function trackSignals(db, quotes, notify = async () => {}) {
  const { data: open, error: eo } = await db.from('stock_shadow_signals')
    .select('id,symbol,signaled_at,ref_price,sl_price,tp_price,tp_milestone,max_price,min_price,min_price_pre10,obs_count,last_seen_at,hit_10_at,hit_25_at,hit_50_at,hit_100_at')
    .eq('status', 'TRACKING');
  if (eo || !open) return;
  const now = new Date();
  for (const s of open) {
    const q = quotes.get(s.symbol);
    const patch = {};
    if (q) {
      const hi = Math.max(q.price, q.high || q.price);
      const lo = Math.min(q.price, q.low || q.price);
      // the day's high/low only count once the signal exists: use the live price
      // plus the day high only if it happened after signal (unknowable) -> price only for lows,
      // price and high for gains is optimistic, so use price only for both.
      const px = q.price;
      patch.obs_count = (s.obs_count || 0) + 1;
      patch.last_seen_at = now.toISOString();
      const pre10 = s.hit_10_at ? s.min_price_pre10 : Math.min(s.min_price_pre10 || s.ref_price, px);
      if (!s.hit_10_at) patch.min_price_pre10 = pre10;
      const maxP = Math.max(s.max_price || s.ref_price, px);
      const minP = Math.min(s.min_price || s.ref_price, px);
      if (maxP !== s.max_price) patch.max_price = maxP;
      if (minP !== s.min_price) patch.min_price = minP;
      patch.max_gain_pct = (maxP / s.ref_price - 1) * 100;
      patch.max_drawdown_pct = (minP / s.ref_price - 1) * 100;
      for (const t of CFG.targets) {
        const col = `hit_${t}_at`;
        if (!s[col] && px >= s.ref_price * (1 + t / 100)) {
          patch[col] = now.toISOString();
          if (t === 10) patch.dd_before_10_pct = (pre10 / s.ref_price - 1) * 100;
        }
      }
      void hi; void lo;

      // Fixed bracket, judged on the sampled price. If one sample is beyond
      // both levels it can only be the SL side (conservative).
      let closeReason = null, closePx = null;
      if (s.sl_price && px <= s.sl_price) { closeReason = 'SL HIT'; closePx = s.sl_price; }
      else if (s.tp_price && px >= s.tp_price) { closeReason = 'TP HIT'; closePx = s.tp_price; }
      if (closeReason) {
        patch.status = 'CLOSED'; patch.close_reason = closeReason; patch.close_price = closePx;
        patch.closed_at = now.toISOString(); patch.resolved_at = now.toISOString();
        await db.from('stock_shadow_signals').update(patch).eq('id', s.id);
        const mv = (closePx / s.ref_price - 1) * 100;
        await notify([
          '🔴 HUNTER STOCKS CLOSE', '', s.symbol,
          `Entry: ${fmtP(s.ref_price)}`, `Exit: ${fmtP(closePx)}`, `Move: ${fmtPct(mv)}`,
          `Held: ${Math.floor((now - new Date(s.signaled_at)) / 3600000)}h | Peak: ${fmtPct((maxP / s.ref_price - 1) * 100)}`,
          '', `Reason: ${closeReason}`, '',
          "Based on Hunter's own polled price — check Revolut for your actual fill.",
        ].join('\n'));
        continue;
      }

      // Take-profit milestones (25/50/75% of the way to TP), once each.
      if (s.tp_price && s.tp_price > s.ref_price) {
        const prog = (px / s.ref_price - 1) / (s.tp_price / s.ref_price - 1) * 100;
        const done = s.tp_milestone || 0;
        const level = [75, 50, 25].find(l => prog >= l && l > done);
        if (level) {
          patch.tp_milestone = level;
          await notify([
            `🎯 HUNTER STOCKS TP MILESTONE — ${level}% of the way`, '', s.symbol,
            `Entry: ${fmtP(s.ref_price)}`, `Now: ${fmtP(px)} (${fmtPct((px / s.ref_price - 1) * 100)})`,
            `TP: ${fmtP(s.tp_price)}`, `SL: ${fmtP(s.sl_price)}`, '',
            "Fixed SL/TP unchanged. If you want to bank some profit early, this is the decision point.",
          ].join('\n'));
        }
      }
    }
    if (now - new Date(s.signaled_at) > CFG.signalWindowDays * 86400000) {
      // Only call it complete if we really watched it: enough polls and no
      // long blind gap at the end. Otherwise it is INCOMPLETE and must not
      // be counted as "never reached the target".
      const lastSeen = patch.last_seen_at || s.last_seen_at;
      const seen = patch.obs_count || s.obs_count || 0;
      const gapDays = lastSeen ? (now - new Date(lastSeen)) / 86400000 : 99;
      patch.status = seen >= 50 && gapDays <= 3 ? 'CLOSED' : 'INCOMPLETE';
      patch.resolved_at = now.toISOString();
      if (patch.status === 'CLOSED') {
        const last = (q && q.price) || s.max_price || s.ref_price;
        patch.close_reason = 'TIMEOUT (14d)'; patch.close_price = last; patch.closed_at = now.toISOString();
        await notify(['⏹ HUNTER STOCKS CLOSE', '', s.symbol, `Entry: ${fmtP(s.ref_price)}`, `Exit: ${fmtP(last)}`,
          `Move: ${fmtPct((last / s.ref_price - 1) * 100)}`, '', 'Reason: TIMEOUT (14 days held, neither SL nor TP hit)'].join('\n'));
      }
    }
    if (Object.keys(patch).length) await db.from('stock_shadow_signals').update(patch).eq('id', s.id);
  }
}

async function detectSignals(db, quotes, notify = async () => {}) {
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
  const { data: today, error: e1 } = await db.from('stock_shadow_signals')
    .select('id').gte('signaled_at', startOfDay.toISOString());
  if (e1) return;
  const { data: openNow, error: e3 } = await db.from('stock_shadow_signals')
    .select('id').eq('status', 'TRACKING');
  if (e3) return;
  let remaining = Math.min(
    CFG.maxSignalsPerDay - (today ? today.length : 0),
    CFG.maxOpen - (openNow ? openNow.length : 0)
  );
  if (remaining <= 0) return;

  const cutoff = new Date(Date.now() - CFG.cooldownDays * 86400000).toISOString();
  const { data: recent, error: e2 } = await db.from('stock_shadow_signals')
    .select('symbol').gte('signaled_at', cutoff);
  if (e2) return;
  const cooling = new Set((recent || []).map(r => r.symbol));

  const cands = [];
  for (const [symbol, q] of quotes) {
    if (cooling.has(symbol) || !q.prevClose) continue;
    const dayChange = (q.price / q.prevClose - 1) * 100;
    const range = (q.high || 0) - (q.low || 0);
    const rangePos = range > 0 ? (q.price - q.low) / range : 0;
    if (dayChange >= CFG.minDayChange && dayChange <= CFG.maxDayChange && rangePos >= CFG.minRangePos) {
      cands.push({ symbol, q, dayChange, rangePos });
    }
  }
  cands.sort((a, b) => b.rangePos * b.dayChange - a.rangePos * a.dayChange);
  for (const c of cands.slice(0, remaining)) {
    const rangePct = ((c.q.high - c.q.low) / c.q.price) * 100;
    const slPct = Math.min(CFG.slMaxPct, Math.max(CFG.slMinPct, rangePct * CFG.slRangeMult));
    const tpPct = slPct * CFG.tpR;
    const slPx = c.q.price * (1 - slPct / 100);
    const tpPx = c.q.price * (1 + tpPct / 100);
    const { error: insErr } = await db.from('stock_shadow_signals').insert({
      symbol: c.symbol, ref_price: c.q.price, day_change_pct: c.dayChange,
      range_pos: c.rangePos, max_price: c.q.price, min_price: c.q.price,
      sl_price: slPx, tp_price: tpPx,
    });
    if (insErr) { console.error(`[STOCK-SHADOW] signal insert failed: ${insErr.message}`); continue; }
    await notify([
      '🟢 HUNTER STOCKS OPEN', '', c.symbol,
      `Entry: ${fmtP(c.q.price)}`,
      `SL: ${fmtP(slPx)} (-${slPct.toFixed(1)}%)`,
      `TP: ${fmtP(tpPx)} (+${tpPct.toFixed(1)}%)`, '',
      `Day: ${fmtPct(c.dayChange)} | near the day's high (${Math.round(c.rangePos * 100)}% of range)`,
      '', "US stocks, Hunter's own polled price (Finnhub). Check Revolut for the live price before acting.",
    ].join('\n'));
    console.log(`[STOCK-SHADOW] signal ${c.symbol} @ ${c.q.price} (day ${c.dayChange.toFixed(1)}%)`);
  }
}

async function eodReport(db, notify) {
  const since = new Date(Date.now() - 20 * 3600000).toISOString();
  const { data: sent, error: se } = await db.from('stock_shadow_eod').select('day').gte('sent_at', since).limit(1);
  if (se || (sent && sent.length)) return;
  const { data: open, error } = await db.from('stock_shadow_signals')
    .select('symbol,ref_price,sl_price,tp_price,max_price,signaled_at').eq('status', 'TRACKING');
  if (error) return;
  const { data: closed } = await db.from('stock_shadow_signals')
    .select('symbol,ref_price,close_price,close_reason').eq('status', 'CLOSED')
    .gte('closed_at', new Date(Date.now() - 24 * 3600000).toISOString());
  const { data: lastQ } = await db.from('stock_shadow_quotes').select('symbol,price,polled_at')
    .gte('polled_at', new Date(Date.now() - 36 * 3600000).toISOString()).order('polled_at', { ascending: false }).limit(400);
  const last = new Map();
  for (const r of lastQ || []) if (!last.has(r.symbol)) last.set(r.symbol, r.price);
  const lines = (open || []).map(p => {
    const px = last.get(p.symbol) || p.ref_price;
    const mv = (px / p.ref_price - 1) * 100;
    const toTp = Math.max(0, Math.round(mv / ((p.tp_price / p.ref_price - 1) * 100) * 100));
    return `${p.symbol}  ${fmtPct(mv)} (peak ${fmtPct((Math.max(p.max_price, px) / p.ref_price - 1) * 100)})  |  ${toTp}% to TP  |  SL ${fmtPct((p.sl_price / p.ref_price - 1) * 100)}  |  ${Math.floor((Date.now() - new Date(p.signaled_at)) / 3600000)}h`;
  });
  const cl = (closed || []).map(p => `${p.symbol} ${fmtPct((p.close_price / p.ref_price - 1) * 100)} — ${p.close_reason}`);
  const text = ['🌙 HUNTER STOCKS END OF DAY', '',
    open && open.length ? `Open positions (${open.length}):` : 'No open stock positions.', ...lines, '',
    cl.length ? 'Closed in last 24h:' : 'No stock closes in last 24h.', ...cl, '',
    "Unrealised, from Hunter's own polled prices — check Revolut."].join('\n');
  const { error: ie } = await db.from('stock_shadow_eod').insert({ day: new Date().toISOString().slice(0, 10) });
  if (ie) return;
  await notify(text);
}

async function prune(db) {
  const cutoff = new Date(Date.now() - CFG.quoteRetentionDays * 86400000).toISOString();
  await db.from('stock_shadow_quotes').delete().lt('polled_at', cutoff);
}

function start(db, opts = {}) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !db || !db.pool) return;
  const symbols = (process.env.STOCK_SHADOW_SYMBOLS
    ? process.env.STOCK_SHADOW_SYMBOLS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_SYMBOLS).slice(0, 50);
  const notify = async text => { try { if (opts.notify) await opts.notify(text); } catch (e) { console.error(`[STOCK-SHADOW] notify failed: ${e.message}`); } };
  const state = { lastQuoteTime: new Map(), throttleMs: CFG.throttleMs, running: false, lastPrune: 0 };

  ensureSchema(db.pool).then(() => ensureEod(db.pool)).then(() => {
    console.log(`[STOCK-SHADOW] started: ${symbols.length} symbols, shadow mode, no alerts`);
    const tick = async () => {
      const d0 = new Date();
      const eodWindow = d0.getUTCDay() >= 1 && d0.getUTCDay() <= 5 && d0.getUTCHours() === CFG.eodHourUtc && d0.getUTCMinutes() >= CFG.eodMinute;
      if (state.running || (!usMarketWindow() && !eodWindow) || Date.now() < (state.pauseUntil || 0)) return;
      state.running = true;
      try {
        const nowD = new Date();
        if (nowD.getUTCDay() >= 1 && nowD.getUTCDay() <= 5 && nowD.getUTCHours() === CFG.eodHourUtc && nowD.getUTCMinutes() >= CFG.eodMinute) {
          await eodReport(db, notify);
        }
        if (usMarketWindow()) {
          const n = await runCycle(db, key, symbols, state, opts.fetcher, notify);
          console.log(`[STOCK-SHADOW] cycle done, ${n} fresh quotes`);
        }
        if (Date.now() - state.lastPrune > 6 * 3600000) { await prune(db); state.lastPrune = Date.now(); }
      } catch (e) {
        console.error(`[STOCK-SHADOW] cycle failed: ${e.message}`);
      } finally {
        state.running = false;
      }
    };
    // Next cycle is scheduled AFTER the current one finishes, aimed at
    // pollMs after the previous start, so cycles never overlap or pile up.
    const loop = async () => {
      const startedAt = Date.now();
      await tick();
      setTimeout(loop, Math.max(30000, CFG.pollMs - (Date.now() - startedAt)));
    };
    loop();
  }).catch(e => console.error(`[STOCK-SHADOW] schema failed, scanner off: ${e.message}`));
}

module.exports = { start, runCycle, trackSignals, detectSignals, ensureSchema, usMarketWindow, CFG };

  return module.exports;
})();

// Starts only when FINNHUB_API_KEY is set. Alerts go to the OWNER chat
// only (telegram() defaults to it) — never the channel: Finnhub's free
// plan is personal use and forbids sharing its data or derived results.
if (supabase && process.env.FINNHUB_API_KEY) {
  try {
    STOCKS.start(supabase, {
      notify: async text => {
        if (!ENV.HUNTER_LIVE) {
          console.log('[STOCKS] HUNTER_LIVE=false — alert suppressed');
          return;
        }
        await telegram(text);
      },
    });
  } catch (error) {
    console.error(`[HUNTER] stock scanner not started: ${error.message}`);
  }
}

const STATE = {
  cycleRunning: false,
  cycle: 0,

  universe: [],
  universeAt: 0,

  revolutBases: null,
  revolutBasesAt: 0,

  active: new Map(),

  // ADDED: true when loadActivePositions() could not confirm real
  // position state from Supabase at startup (or on retry). While true,
  // canOpen() refuses every new open — not because positions are
  // assumed to be zero, but because we genuinely don't know, and
  // opening blind risks a duplicate on a symbol that's already held.
  // Cleared the moment a load actually succeeds.
  positionStateUnknown: false,

  // ADDED: circuit breaker for the write path. The 15s per-call timeout
  // (dbTimeoutMs) stops any single call hanging forever, but when the
  // database is fully down, persistDetections() still awaits up to 3
  // sequential calls per detection (snapshot -> example -> detection),
  // each able to burn the full 15s, across ~150+ detections — confirmed
  // in production logs as a 30+ minute stuck cycle even with the
  // per-call timeout in place. Once dbConsecutiveFailures crosses
  // CONFIG.dbCircuitFailureThreshold, dbCircuitOpenUntil is set and
  // every write fails instantly (no network attempt, no 15s wait) until
  // that time passes — turning a doomed cycle into a fast one instead
  // of a slow one, and cutting the log volume that was itself hitting
  // Railway's 500 logs/sec rate limit.
  dbConsecutiveFailures: 0,
  dbCircuitOpenUntil: 0,

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

// ADDED: formats a price with decimal places scaled to its magnitude,
// then trims trailing zeros. Needed because Hunter's universe spans
// everything from sub-cent coins (e.g. 0.00000521) to high-value ones
// (e.g. 43000) — a single fixed decimal count would either round small
// coins to something useless or print excessive noise on large ones.
function formatPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n === 0) return String(price);

  const abs = Math.abs(n);
  const decimals =
    abs >= 100 ? 2 :
    abs >= 1 ? 4 :
    abs >= 0.01 ? 6 :
    abs >= 0.0001 ? 8 :
    10;

  return n
    .toFixed(decimals)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
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
    row,
    'id'
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

      // ADDED: live experiment tracking — see the comment where
      // detection.experimentFlags is set, in runCycle(), before
      // persistDetections() is called.
      experiment_flags:
        detection.experimentFlags || null,

      features:
        detection.features,

      feature_vector:
        detection.vector,
    },
    'id'
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

  // ADDED: refuse every new open while loadActivePositions() couldn't
  // confirm real state at startup. This is the actual safeguard against
  // opening a duplicate on a symbol that's secretly already held — not
  // just "stay alive," which alone would let Hunter open blind.
  if (STATE.positionStateUnknown) {
    return {
      ok: false,
      reason: 'position state unconfirmed (db recovery)',
    };
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
  // CHANGED: floor raised 5 -> 7. Audited 41 real positions via their
  // exact detection_id (not a fuzzy timestamp guess) — the formula
  // itself had zero bugs, but raw ATR-implied stops landed below 5% in
  // ~83% of them, so the floor wasn't a rare backstop, it was the
  // typical outcome. ALICE's near-miss (raw 4.95%, stopped out within
  // 0.51% of the actual trigger) is a direct consequence of sitting
  // right at that floor with almost no margin. Lowering the floor
  // would make this worse, not better — several coins had raw values
  // of 1.5-2%, and an unclamped stop that tight would be far too
  // sensitive to ordinary crypto noise. Raising it instead gives real
  // breathing room on the ~83% of trades that were landing at the
  // floor, without changing anything for trades already genuinely
  // above it (their raw ATR value still wins either way).
  const stopAbsPct = Math.round(clamp(atrPct * 2.5, 7, 14));
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

        // ADDED: entry snapshot, so the CLOSE alert and any audit can
        // compare "how it looked when we entered" with "how it ended".
        open_score:
          detection.creamScore,

        open_stage:
          detection.stage,

        open_ret1h:
          f.ret1h,

        open_ret4h:
          f.ret4h,

        open_ret24h:
          f.ret24h,

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
      `Entry: ${formatPrice(f.currentPrice)}`,
      `Profile: ${levels.profile}`,
      `SL: ${levels.stopLossPct}% → ${formatPrice(levels.stopLossPrice)}`,
      `TP: +${levels.takeProfitPct}% → ${formatPrice(levels.takeProfitPrice)}  |  ${levels.riskReward}R`,
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
  // CHANGED: also counts the candle's intrabar high (a close-only peak
  // under-reports real excursion), and the result is written back to
  // the in-memory position below. Previously STATE.active was never
  // refreshed after an update, so every cycle recomputed
  // max(open_price, current_price): the stored peak was whatever the
  // latest price happened to be, not the true high-water mark.
  const peakPrice =
    Math.max(
      num(position.peak_price, opened),
      f.currentPrice,
      num(f.currentHigh, f.currentPrice)
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

  if (persisted) {
    Object.assign(position, {
      last_price: f.currentPrice,
      last_score: detection.creamScore,
      tier: tier.name,
      peak_price: peakPrice,
      peak_score: peakScore,
      soft_stop: softStop,
      hard_stop: hardStop,
    });
  }

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

  // ADDED: how long it was held and how far it ran before closing.
  const heldMs =
    Date.now() - new Date(position.opened_at || Date.now()).getTime();
  const heldH = Math.floor(heldMs / 3600000);
  const heldM = Math.round((heldMs % 3600000) / 60000);
  const peakSeen =
    Math.max(num(position.peak_price, opened), num(f.currentHigh, f.currentPrice));

  const openedLine =
    position.open_score != null
      ? `Opened: score ${num(position.open_score).toFixed(0)} ${position.open_stage || ''} | 4h ${pct(num(position.open_ret4h)).toFixed(1)}% 24h ${pct(num(position.open_ret24h)).toFixed(1)}%`
      : null;

  const message =
    [
      `🔴 HUNTER CLOSE`,
      ``,
      `${baseSymbol(detection.symbol)}`,
      // CHANGED: showed the live feed price next to a Move calculated
      // from the stop/target level, which contradicted each other
      // (e.g. "Price 0.1698 / Move -7.0%"). Now both refer to the exit.
      `Entry: ${formatPrice(opened)}`,
      `Exit: ${formatPrice(closePrice)}`,
      `Move: ${pct(move).toFixed(1)}%`,
      `Held: ${heldH}h ${heldM}m | Peak: +${pct(safePct(peakSeen, opened)).toFixed(1)}%`,
      ``,
      `Reason: ${reason}`,
      ...(openedLine ? [openedLine] : []),
      `Now: score ${detection.creamScore.toFixed(0)} ${detection.stage} | feed ${formatPrice(f.currentPrice)}`,
      ``,
      `1h: ${pct(f.ret1h).toFixed(1)}%`,
      `4h: ${pct(f.ret4h).toFixed(1)}%`,
      `24h: ${pct(f.ret24h).toFixed(1)}%`,
      ``,
      `Based on Hunter's own price feed — check Revolut for your actual fill, they can differ.`,
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

  // CHANGED: re-enabled. Previously silenced on the reasoning that
  // Revolut's own order manages the real exit, not Hunter — true, but
  // it meant Hunter had nothing to say when its calculated close and
  // your actual Revolut fill diverged, which is exactly what happened
  // with ALICE (Hunter never crossed its own SL; Revolut's separately-
  // placed order did). Silence was actively hiding that gap rather
  // than surfacing it. The message above now says plainly this is
  // Hunter's own price feed, not a confirmed Revolut fill.
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
  // ADDED: take-profit milestone alert. The fixed TP can be far away
  // (RUNNER = +42%) and winners have given back large chunks of their
  // peak before reaching it, so this tells the user when a position has
  // covered 25 / 50 / 75% of the distance to its own TP, letting them
  // bank profit manually on Revolut if they prefer. Alert-only: it never
  // changes SL/TP or closes anything. The highest level reached is
  // stored (tp_milestone) so each level fires once, surviving restarts.
  {
    const entryPx = num(position.open_price, f.currentPrice);
    const tpPx = num(position.take_profit_price, null);
    if (tpPx && entryPx && tpPx > entryPx) {
      const tpMove = tpPx / entryPx - 1;
      // Progress uses THIS cycle's price/high only, so a deploy never fires
      // stale alerts for a peak that was reached and given back earlier.
      const reachedPx = Math.max(f.currentPrice, high);
      const bestPx = Math.max(num(position.peak_price, entryPx), reachedPx);
      const progress = (reachedPx / entryPx - 1) / tpMove;
      const done = num(position.tp_milestone, 0);
      const level = [75, 50, 25].find(l => progress * 100 >= l && l > done);
      if (level) {
        const saved = await dbUpdate(
          'hunter_v11_positions',
          { id: position.id },
          { tp_milestone: level }
        );
        if (saved) {
          position.tp_milestone = level;
          const nowMove = pct(safePct(f.currentPrice, entryPx));
          const peakMove = pct(safePct(bestPx, entryPx));
          const slPx = num(position.stop_loss_price, null);
          const msg = [
            `🎯 HUNTER TP MILESTONE — ${level}% of the way`,
            ``,
            `${baseSymbol(detection.symbol)}`,
            `Entry: ${formatPrice(entryPx)}`,
            `Now: ${formatPrice(f.currentPrice)} (${nowMove >= 0 ? '+' : ''}${nowMove.toFixed(1)}%)`,
            `Peak: +${peakMove.toFixed(1)}%`,
            `TP: ${formatPrice(tpPx)} (+${(tpMove * 100).toFixed(1)}%)`,
            ...(slPx ? [`SL: ${formatPrice(slPx)} (${(pct(safePct(slPx, entryPx))).toFixed(1)}%)`] : []),
            ``,
            `Fixed SL/TP are unchanged. If you want to bank some profit before the TP, this is a decision point — Hunter will not close it for you.`,
            `Based on Hunter's own price feed — check Revolut for live price.`,
          ].join('\n');
          await insertAlert(detection.symbol, 'TP_MILESTONE', msg, detection.detectionId || null, { level, progress });
          await alertUser(msg);
        }
      }
    }
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

// portfolio-bot-v8.js — PART 3 of 3. See part 1 for concatenation
// instructions and the changelog.

// portfolio-bot-v8.js — PART 3 of 3. See part 1 for concatenation
// instructions and the changelog.

// -----------------------------
// portfolio-bot-v8.js — PART 3 of 3. See part 1 for concatenation
// instructions and the changelog.

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
          detection.learning.mode,
          detection.creamScore >= CONFIG.persistDetailMinScore
        );

        await createExample(
          snapshot?.id || null,
          detection.asset,
          detection.features
        );

        // CHANGED (Neon free tier): detail rows only for scores worth
        // auditing. Anything that can OPEN (>=70) is always above this.
        if (detection.creamScore >= CONFIG.persistDetailMinScore) {
          const detectionRow = await saveDetection(detection);
          detection.detectionId = detectionRow?.id || null;

          await saveObservationHistory(
            detection,
            btcRisk,
            fieldAverage
          );
        }

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
  if (!supabase) return 0;

  const attempts = 3;
  const delaysMs = [3000, 8000];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { data, error } = await supabase
      .from('hunter_v11_positions')
      .select('*')
      .eq('status', 'OPEN');

    if (!error) {
      // Only replace STATE.active once we actually have a good read —
      // never clear it first and hope, which is what the old version
      // did (clear(), then query, then possibly throw with the map
      // already emptied).
      STATE.active.clear();

      for (const position of data || []) {
        STATE.active.set(position.symbol, position);
      }

      STATE.positionStateUnknown = false;

      return STATE.active.size;
    }

    console.error(
      `[HUNTER] loadActivePositions attempt ${attempt}/${attempts} failed: ${error.message}`
    );

    if (attempt < attempts) {
      await sleep(delaysMs[attempt - 1]);
    }
  }

  // CHANGED: was `throw`, which killed the whole process on a transient
  // Supabase timeout — and since the database was down the whole time
  // anyway, Railway would just crash-loop on the identical failure
  // until it recovered, meaning Hunter did nothing at all in the
  // meantime. Now: stay alive, keep scanning/learning/persisting
  // snapshots normally, but refuse to open anything new until a later
  // load actually succeeds (see canOpen()) — because an empty
  // STATE.active here would be a guess, not a fact, and opening on a
  // symbol that's secretly already held would be a real duplicate.
  console.error(
    '[HUNTER] Could not confirm open positions after retries — staying up, but blocking new opens until position state is confirmed.'
  );

  STATE.positionStateUnknown = true;

  return -1;
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

// ADDED: daily retention job. Deletes rows older than
// CONFIG.retentionDays from the three tables confirmed to have a plain
// `timestamp` column (verified via direct queries this session, not
// assumed) and known to be the actual source of the database-size
// crisis. Deletion is naturally idempotent — if this runs more than
// once within its target hour window (possible since cycles are every
// 15 minutes), later runs just find nothing left to delete, so no
// dedup guard is needed the way the weekly report needed one for
// Telegram sends.
async function pruneOldData() {
  if (!supabase) return;

  const cutoff =
    new Date(Date.now() - CONFIG.retentionDays * 86400000).toISOString();

  const tables = [
    'hunter_v11_snapshots',
    'hunter_v11_detections',
    'hunter_v11_examples',
  ];

  for (const table of tables) {
    try {
      const { error, count } =
        await supabase
          .from(table)
          .delete({ count: 'exact' })
          .lt('timestamp', cutoff);

      if (error) {
        console.error(
          `[HUNTER] pruneOldData ${table} failed: ${error.message}`
        );
      } else {
        console.log(
          `[HUNTER] pruneOldData ${table}: removed ${count ?? 'unknown'} rows older than ${CONFIG.retentionDays}d`
        );
      }
    } catch (error) {
      console.error(
        `[HUNTER] pruneOldData ${table} threw: ${error.message}`
      );
    }
  }

  // ADDED: observation history is keyed by calculated_at, not timestamp.
  try {
    const { error, count } =
      await supabase
        .from('hunter_observation_history')
        .delete({ count: 'exact' })
        .lt('calculated_at', cutoff);

    if (error) {
      console.error(
        `[HUNTER] pruneOldData hunter_observation_history failed: ${error.message}`
      );
    } else {
      console.log(
        `[HUNTER] pruneOldData hunter_observation_history: removed ${count ?? 'unknown'} rows older than ${CONFIG.retentionDays}d`
      );
    }
  } catch (error) {
    console.error(
      `[HUNTER] pruneOldData hunter_observation_history threw: ${error.message}`
    );
  }
}

// ADDED: end-of-day Telegram summary of open positions and the last
// 24h of closes. One cheap query each (open positions are few). Sent
// once per day around CONFIG.eodReportHourUtc; the dedupe guard is the
// 'EOD' row in the alerts table, so restarts/cycles can't repeat it.
async function generateEodReport() {
  if (!supabase) return;

  const since = new Date(Date.now() - 20 * 3600000).toISOString();
  const { data: sent } = await supabase
    .from('hunter_v11_alerts')
    .select('id')
    .eq('action', 'EOD')
    .gte('timestamp', since)
    .limit(1);
  if (sent && sent.length) return;

  const { data: open, error: e1 } = await supabase
    .from('hunter_v11_positions')
    .select('symbol,open_price,last_price,peak_price,take_profit_price,stop_loss_price,opened_at,execution_profile')
    .eq('status', 'OPEN')
    .order('opened_at', { ascending: true });
  if (e1) return;

  const { data: closed, error: e2 } = await supabase
    .from('hunter_v11_positions')
    .select('symbol,open_price,close_price,close_reason')
    .eq('status', 'CLOSED')
    .gte('closed_at', new Date(Date.now() - 24 * 3600000).toISOString());
  if (e2) return;

  const fmt = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const lines = (open || []).map(p => {
    const entry = num(p.open_price, 0);
    const last = num(p.last_price, entry);
    const peak = Math.max(num(p.peak_price, entry), last);
    const tp = num(p.take_profit_price, null);
    const sl = num(p.stop_loss_price, null);
    const move = entry ? (last / entry - 1) * 100 : 0;
    const peakMove = entry ? (peak / entry - 1) * 100 : 0;
    const toTp = tp && entry && tp > entry ? Math.round(Math.max(0, (last / entry - 1) / (tp / entry - 1)) * 100) : null;
    const held = Math.floor((Date.now() - new Date(p.opened_at).getTime()) / 3600000);
    return `${baseSymbol(p.symbol)}  ${fmt(move)} (peak ${fmt(peakMove)})  |  ${toTp != null ? toTp + '% to TP' : 'no TP'}  |  SL ${sl && entry ? fmt((sl / entry - 1) * 100) : 'n/a'}  |  ${held}h`;
  });
  const moves = (open || []).map(p => {
    const entry = num(p.open_price, 0);
    return entry ? (num(p.last_price, entry) / entry - 1) * 100 : 0;
  });
  const avgOpen = moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : 0;

  const closedLines = (closed || []).map(p => {
    const entry = num(p.open_price, 0);
    const mv = entry ? (num(p.close_price, entry) / entry - 1) * 100 : 0;
    return `${baseSymbol(p.symbol)} ${fmt(mv)} — ${p.close_reason}`;
  });

  const text = [
    `🌙 HUNTER END OF DAY`,
    ``,
    open && open.length
      ? `Open positions (${open.length}) — avg ${fmt(avgOpen)}:`
      : `No open positions.`,
    ...lines,
    ``,
    closedLines.length ? `Closed in last 24h:` : `No closes in last 24h.`,
    ...closedLines,
    ``,
    `Unrealised, from Hunter's own price feed — check Revolut for live prices.`,
  ].join('\n');

  await insertAlert('HUNTER', 'EOD', text, null, { open: (open || []).length });
  await alertUser(text);
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
    // ADDED: if startup couldn't confirm position state, don't wait for
    // a manual restart — retry once per cycle here too. A single
    // successful call clears STATE.positionStateUnknown and canOpen()
    // resumes normally on the very same cycle.
    if (STATE.positionStateUnknown) {
      const recovered =
        await loadActivePositions();

      if (recovered >= 0) {
        console.log(
          `[HUNTER] Position state recovered: ${recovered} open`
        );
      } else {
        console.log(
          '[HUNTER] Position state still unconfirmed — new opens remain blocked this cycle.'
        );
      }
    }

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

      // ADDED: live experiment, not a gate. Audit of 1,341 reconstructed
      // opportunities found relativeStrength >= 0.05 at detection time
      // averaged -0.14R (n=395), versus +0.53R for <0.02 (n=224) and
      // +0.29R for 0.02-0.05 (n=722) — real sample sizes, one 11-day
      // window. Recorded here so it can be checked against real outcomes
      // as more data accumulates, without ever affecting eligibility —
      // deliberately NOT added to detection.reasons or gateCheck.
      //
      // Extended per further review: stores the raw value (not just the
      // boolean) so future re-bucketing needs no new migration, a
      // 4-tier bucket for finer-grained analysis, and a before/after
      // hypothetical-priority comparison — candidatePriority() is pure,
      // calling it again here (same pattern as openCandidate() above)
      // to see whether an 8-point penalty would have actually changed
      // which candidates win a slot under the 2-per-cycle cap, not just
      // whether the outcome looks different in isolation. The penalty
      // value (8) is NOT applied to real ranking anywhere below.
      const rs =
        detection.features.relativeStrength;

      const rsBucket =
        rs >= 0.05 ? 'RS_EXTENDED' :
        rs >= 0.02 ? 'RS_HEALTHY' :
        rs > 0 ? 'RS_EARLY' :
        'RS_WEAK';

      const priorityBefore =
        candidatePriority(detection);

      detection.experimentFlags = {
        high_relative_strength:
          rsBucket === 'RS_EXTENDED',
        relative_strength_value:
          rs,
        relative_strength_bucket:
          rsBucket,
        priority_before_penalty:
          priorityBefore,
        priority_after_hypothetical_penalty:
          rsBucket === 'RS_EXTENDED'
            ? priorityBefore - 8
            : priorityBefore,

        // ADDED: late-entry experiment (non-blocking, like the RS flag
        // above). BAND opened after +11.2% in 4h and never rose more than
        // 1.9% before stopping out; DIA opened after +11.9% in 24h. This
        // records, for every detection, whether a "skip coins that have
        // already run" veto would have blocked it, so outcomes can be
        // compared later. It is NOT added to reasons/gateCheck and does
        // not change eligibility or ranking.
        late_entry_ret4h_value:
          detection.features.ret4h,
        late_entry_ret24h_value:
          detection.features.ret24h,
        late_entry_4h_gt_10:
          detection.features.ret4h > 0.10,
        late_entry_24h_gt_15:
          detection.features.ret24h > 0.15,
        late_entry_would_veto:
          detection.features.ret4h > 0.10 ||
          detection.features.ret24h > 0.15,
      };
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

    // ADDED: end-of-day open-positions summary (once per day).
    if (now.getUTCHours() === CONFIG.eodReportHourUtc) {
      try { await generateEodReport(); } catch (e) {
        console.error(`[HUNTER] EOD report failed: ${e.message}`);
      }
    }

    // ADDED: daily retention prune — arbitrary fixed hour (03:00 UTC,
    // away from the Monday weekly-report window), idempotent so the
    // imprecision of running on every cycle within that hour is fine.
    if (now.getUTCHours() === 3) {
      await pruneOldData();
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

// -----------------------------
// Wealth Engine (Phase 1)
// -----------------------------
//
// Crypto-major long-term holder — completely independent of Hunter.
// Shares only: the process, the Supabase client, and alertUser()/
// telegram(). Does not read or write any hunter_v11_* table, does not
// use discoverUniverse(), does not use openCandidate()/creamGate/tier
// logic. Fixed BTC/ETH universe (wealth_assets), daily candles (not
// 15m), a much slower cycle, and an exit rule built around confirmed
// trend deterioration rather than a price bracket — a normal pullback
// must not trigger a close by itself, matching the brief's own
// "0% return must never trigger a close" requirement.

const CONFIG_WEALTH = {
  cycleMs: 60 * 60 * 1000, // hourly — this is not momentum-hunting

  dailyCandleLimit: 260, // >200 for the long moving average + slope lookback

  // Trend-health thresholds. Deliberately asymmetric (hysteresis): the
  // bar to OPEN is higher than the bar to merely avoid WARNING, and the
  // bar to CLOSE is well below the bar that triggers WARNING, so a
  // position doesn't flicker open/closed near one boundary.
  openThreshold: 65,
  warningThreshold: 50,
  closeThreshold: 35,

  // A WARNING needs to persist, not fire on one noisy daily candle.
  warningConfirmScans: 2,
  closeConfirmScans: 2,

  // ADDED: explicit portfolio-level cap, ahead of the universe actually
  // growing past BTC/ETH. Previously implicit (2, purely because
  // wealth_assets only had 2 rows and each symbol caps at one position).
  // Enforced in evaluateWealthAsset() by counting ACTIVE/WARNING rows
  // across ALL symbols before opening a new one — a qualifying asset
  // that can't get a slot goes to WATCH instead of being silently
  // dropped, same pattern as the below-threshold case.
  maxOpenPositions: 6,
};

async function binanceDailyCandles(
  symbol,
  limit = CONFIG_WEALTH.dailyCandleLimit
) {
  const url =
    `https://api.binance.com/api/v3/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1d` +
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
      'binance-daily',
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
        .slice(0, -1) // drop the still-forming candle, same convention as binanceCandles()
    );
  } catch (error) {
    providerMark(
      'binance-daily',
      false,
      error.message
    );

    return null;
  }
}

function sma(
  values,
  period,
  endIndex = values.length - 1
) {
  if (endIndex < period - 1) return null;

  let sum = 0;

  for (
    let i = endIndex - period + 1;
    i <= endIndex;
    i++
  ) {
    sum += values[i];
  }

  return sum / period;
}

// Deterministic trend-health score, 0-100. Every component below is a
// plain calculation from the candle data — nothing here is an AI
// judgment call, matching the brief's "AI must not silently invent a
// score" requirement.
function computeTrendHealth(
  candles,
  btcCandles
) {
  const closes =
    candles.map(c => c.close);

  const n =
    closes.length;

  const last =
    closes[n - 1];

  const components = {};
  let score = 0;

  // 1. Price vs long-term (200d) trend — 25 points.
  const ma200 =
    sma(closes, 200, n - 1);

  const longTrendUp =
    ma200 != null &&
    last > ma200;

  components.longTrendUp =
    longTrendUp;

  if (longTrendUp) score += 25;

  // 2. Price vs medium-term (50d) trend — 20 points.
  const ma50 =
    sma(closes, 50, n - 1);

  const mediumTrendUp =
    ma50 != null &&
    last > ma50;

  components.mediumTrendUp =
    mediumTrendUp;

  if (mediumTrendUp) score += 20;

  // 3. 50d MA slope (rising vs falling over the last 20 days) — 15 points.
  const ma50Then =
    sma(closes, 50, Math.max(50, n - 21));

  const maRising =
    ma50 != null &&
    ma50Then != null &&
    ma50 > ma50Then;

  components.maRising =
    maRising;

  if (maRising) score += 15;

  // 4. Higher-highs / higher-lows over the last ~60 days — 15 points.
  // Simple two-half comparison: is the second half's max/min both
  // above the first half's, without needing full swing-point detection.
  const window =
    Math.min(60, n);

  const recent =
    candles.slice(n - window);

  const half =
    Math.floor(window / 2);

  const firstHalf =
    recent.slice(0, half);

  const secondHalf =
    recent.slice(half);

  const higherHighs =
    Math.max(...secondHalf.map(c => c.high)) >
    Math.max(...firstHalf.map(c => c.high));

  const higherLows =
    Math.min(...secondHalf.map(c => c.low)) >
    Math.min(...firstHalf.map(c => c.low));

  components.higherHighsLows =
    higherHighs && higherLows;

  if (higherHighs && higherLows) score += 15;

  // 5. Relative strength vs BTC — 10 points. Skipped (neutral) for BTC
  // itself, since it can't be relatively strong against itself.
  if (btcCandles && btcCandles.length >= window) {
    const btcCloses =
      btcCandles.map(c => c.close);

    const btcN =
      btcCloses.length;

    const assetChange =
      safePct(
        last,
        closes[n - window]
      );

    const btcChange =
      safePct(
        btcCloses[btcN - 1],
        btcCloses[btcN - window]
      );

    const outperforming =
      assetChange > btcChange;

    components.outperformingBtc =
      outperforming;

    if (outperforming) score += 10;
  } else {
    components.outperformingBtc =
      null;

    score += 5; // neutral half-credit — this IS the BTC candle set, or BTC data unavailable
  }

  // 6. Volume confirmation (last 10d avg vs prior 10d avg) — 10 points.
  const volumes =
    candles.map(c => c.volume);

  const recentVol =
    avg(volumes.slice(n - 10));

  const priorVol =
    avg(volumes.slice(n - 20, n - 10));

  const volumeHealthy =
    priorVol > 0 &&
    recentVol >= priorVol * 0.8;

  components.volumeHealthy =
    volumeHealthy;

  if (volumeHealthy) score += 10;

  // 7. Distance from recent high — 5 points. Not too extended.
  const recentHigh =
    Math.max(
      ...candles.slice(n - window).map(c => c.high)
    );

  const distanceFromHighPct =
    safePct(last, recentHigh);

  const notOverextended =
    distanceFromHighPct >= -0.35;

  components.notOverextended =
    notOverextended;

  if (notOverextended) score += 5;

  components.distanceFromHighPct =
    distanceFromHighPct;

  components.ma200 = ma200;
  components.ma50 = ma50;

  return {
    score: clamp(score, 0, 100),
    components,
  };
}

async function loadWealthAssets() {
  if (!supabase) return [];

  const { data, error } =
    await supabase
      .from('wealth_assets')
      .select('symbol')
      .eq('enabled', true);

  if (error) {
    console.error(
      `[WEALTH] loadWealthAssets: ${error.message}`
    );

    return [];
  }

  return (data || []).map(row => row.symbol);
}

async function currentWealthPosition(symbol) {
  if (!supabase) return null;

  const { data, error } =
    await supabase
      .from('wealth_positions')
      .select('*')
      .eq('symbol', symbol)
      .not('state', 'in', '("CLOSED")')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

  if (error) {
    // CHANGED: was `return null`, which callers read as "no position
    // exists" — indistinguishable from "the database is down". During a
    // database outage that would make the engine believe every asset
    // has no position and try to open them all again. Throwing lets the
    // per-asset try/catch in wealthCycle() skip this asset for the
    // cycle instead.
    throw new Error(
      `currentWealthPosition failed: ${error.message}`
    );
  }

  return data;
}

// ADDED: counts ACTIVE/WARNING positions across ALL symbols, not just
// one — used to enforce CONFIG_WEALTH.maxOpenPositions before opening a
// new one.
async function countOpenWealthPositions() {
  if (!supabase) return 0;

  const { count, error } =
    await supabase
      .from('wealth_positions')
      .select('id', { count: 'exact', head: true })
      .in('state', ['ACTIVE', 'WARNING']);

  if (error) {
    // CHANGED: was `return 0`, which would report "no positions open"
    // during an outage and silently bypass the cap. Throw instead — see
    // currentWealthPosition().
    throw new Error(
      `countOpenWealthPositions failed: ${error.message}`
    );
  }

  return count || 0;
}

async function wealthAlert(
  symbol,
  action,
  message,
  positionId,
  metadata
) {
  await dbInsert(
    'wealth_alerts',
    {
      symbol,
      action,
      message,
      position_id: positionId || null,
      metadata: metadata || null,
    }
  );

  await alertUser(message);
}

async function evaluateWealthAsset(symbol, btcCandles) {
  const candles =
    symbol === 'BTCUSDT'
      ? btcCandles
      : await binanceDailyCandles(symbol);

  if (
    !candles ||
    candles.length < 210
  ) {
    console.log(
      `[WEALTH] ${symbol}: insufficient daily history (${candles?.length || 0}), skipping`
    );

    return;
  }

  const price =
    candles[candles.length - 1].close;

  const { score, components } =
    computeTrendHealth(candles, btcCandles);

  await dbInsert(
    'wealth_snapshots',
    {
      symbol,
      timestamp: iso(),
      price,
      trend_health: score,
      components,
    }
  );

  const position =
    await currentWealthPosition(symbol);

  // No open/watch position yet — decide whether to open.
  if (!position || position.state === 'DISCOVERED' || position.state === 'WATCH') {
    const openCount =
      await countOpenWealthPositions();

    const atCapacity =
      openCount >= CONFIG_WEALTH.maxOpenPositions;

    if (
      score >= CONFIG_WEALTH.openThreshold &&
      !atCapacity
    ) {
      const row =
        await dbInsert(
          'wealth_positions',
          {
            symbol,
            state: 'ACTIVE',
            opened_at: iso(),
            open_price: price,
            peak_price: price,
            entry_trend_health: score,
            last_trend_health: score,
            last_update: iso(),
            last_state_change_at: iso(),
          }
        );

      // ADDED: persist-before-alert. dbInsert returns null when the
      // write fails (e.g. the database is down or out of space). Without
      // this check the engine would send a "WEALTH OPEN" alert for a
      // position that was never recorded, then — because nothing was
      // saved — send another identical one on every following cycle.
      // Same principle Hunter's openPosition() already follows.
      if (!row) {
        console.error(
          `[WEALTH] ${symbol} OPEN not persisted; alert suppressed`
        );

        return;
      }

      const message =
        [
          `🔵 WEALTH OPEN`,
          ``,
          `${baseSymbol(symbol)}`,
          `Price: ${formatPrice(price)}`,
          `Trend health: ${score.toFixed(0)}/100`,
          ``,
          `200d trend: ${components.longTrendUp ? 'up' : 'down'}`,
          `50d trend: ${components.mediumTrendUp ? 'up' : 'down'}`,
          `Structure: ${components.higherHighsLows ? 'higher highs/lows' : 'mixed'}`,
          ``,
          `Long-term hold. No fixed take-profit — this closes only on confirmed trend deterioration.`,
        ].join('\n');

      await wealthAlert(
        symbol,
        'OPEN',
        message,
        row?.id,
        { score, components }
      );
    } else {
      // Not yet strong enough, OR qualified but no slot available —
      // sit in WATCH either way, no alert (matches the brief: WATCH is
      // silent, only state transitions that matter to the user generate
      // a message). Logged distinctly so "at capacity" doesn't look
      // identical to "score too low" in Railway logs.
      if (
        score >= CONFIG_WEALTH.openThreshold &&
        atCapacity
      ) {
        console.log(
          `[WEALTH] ${symbol} qualified (${score.toFixed(0)}) but at capacity (${openCount}/${CONFIG_WEALTH.maxOpenPositions}) — held in WATCH`
        );
      }

      if (!position) {
        await dbInsert(
          'wealth_positions',
          {
            symbol,
            state: 'WATCH',
            last_trend_health: score,
            last_update: iso(),
            last_state_change_at: iso(),
          }
        );
      } else {
        await dbUpdate(
          'wealth_positions',
          { id: position.id },
          {
            last_trend_health: score,
            last_update: iso(),
          }
        );
      }
    }

    return;
  }

  // Have an ACTIVE or WARNING position — evaluate for WARNING/CLOSE/recovery.
  const peakPrice =
    Math.max(
      num(position.peak_price, price),
      price
    );

  const previousHealth =
    num(position.last_trend_health, score);

  // CLOSE requires the score to be below closeThreshold AND the 200d
  // trend to actually be broken — a single bad daily candle on an
  // otherwise-intact long-term trend is not enough, matching "0% return
  // must never trigger a close by itself" and "CLOSE requires hard
  // invalidation or multiple confirming conditions."
  const closeConfirmed =
    score < CONFIG_WEALTH.closeThreshold &&
    !components.longTrendUp;

  if (closeConfirmed) {
    const closePersisted = await dbUpdate(
      'wealth_positions',
      { id: position.id },
      {
        state: 'CLOSED',
        closed_at: iso(),
        close_price: price,
        close_reason: 'confirmed trend deterioration',
        last_trend_health: score,
        previous_trend_health: previousHealth,
        peak_price: peakPrice,
        last_update: iso(),
        last_state_change_at: iso(),
      }
    );

    // ADDED: persist-before-alert, same as OPEN above. If the close
    // didn't save, the position is still ACTIVE in the database, so
    // announcing a CLOSE would repeat on every cycle until the write
    // finally succeeded.
    if (!closePersisted) {
      console.error(
        `[WEALTH] ${symbol} CLOSE not persisted; alert suppressed`
      );

      return;
    }

    const returnPct =
      safePct(price, position.open_price) * 100;

    const givebackPct =
      safePct(price, peakPrice) * 100;

    const message =
      [
        `🔴 WEALTH CLOSE`,
        ``,
        `${baseSymbol(symbol)}`,
        `Return from entry: ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%`,
        `Peak since entry: ${formatPrice(peakPrice)}`,
        `Giveback from peak: ${givebackPct.toFixed(1)}%`,
        `Trend health: ${previousHealth.toFixed(0)} -> ${score.toFixed(0)}`,
        ``,
        `Reason: 200d trend broken, confirmed.`,
      ].join('\n');

    await wealthAlert(
      symbol,
      'CLOSE',
      message,
      position.id,
      { returnPct, score, components }
    );

    return;
  }

  const warningNow =
    score < CONFIG_WEALTH.warningThreshold;

  if (
    warningNow &&
    position.state !== 'WARNING'
  ) {
    // FIXED: this line previously had a literal "0.0%" copied from the
    // brief's example text, so every warning claimed the position was
    // flat regardless of its real return. Now computed from the actual
    // entry price.
    const warningReturnPct =
      safePct(price, position.open_price) * 100;

    const message =
      [
        `🟠 WEALTH WARNING`,
        ``,
        `${baseSymbol(symbol)} ${warningReturnPct >= 0 ? '+' : ''}${warningReturnPct.toFixed(1)}% — MOMENTUM FADING`,
        `Trend health: ${previousHealth.toFixed(0)} -> ${score.toFixed(0)}`,
        `200d trend: ${components.longTrendUp ? 'intact' : 'broken'}`,
        `Volume: ${components.volumeHealthy ? 'holding' : 'declining'}`,
        ``,
        `ACTION: HOLD — close confirmation not met.`,
      ].join('\n');

    const warningPersisted = await dbUpdate(
      'wealth_positions',
      { id: position.id },
      {
        state: 'WARNING',
        peak_price: peakPrice,
        last_trend_health: score,
        previous_trend_health: previousHealth,
        warning_count: num(position.warning_count, 0) + 1,
        last_update: iso(),
        last_state_change_at: iso(),
      }
    );

    // ADDED: persist-before-alert — same reasoning as OPEN and CLOSE.
    if (!warningPersisted) {
      console.error(
        `[WEALTH] ${symbol} WARNING not persisted; alert suppressed`
      );

      return;
    }

    await wealthAlert(
      symbol,
      'WARNING',
      message,
      position.id,
      { score, components }
    );

    return;
  }

  if (
    !warningNow &&
    position.state === 'WARNING'
  ) {
    // Recovered — back to ACTIVE, silently (matches the brief: no
    // alert spam, the WARNING->ACTIVE recovery is logged, not pushed).
    await dbUpdate(
      'wealth_positions',
      { id: position.id },
      {
        state: 'ACTIVE',
        peak_price: peakPrice,
        last_trend_health: score,
        previous_trend_health: previousHealth,
        last_update: iso(),
        last_state_change_at: iso(),
      }
    );

    return;
  }

  // No state change — just update the rolling fields.
  await dbUpdate(
    'wealth_positions',
    { id: position.id },
    {
      peak_price: peakPrice,
      last_trend_health: score,
      previous_trend_health: previousHealth,
      last_update: iso(),
    }
  );
}

async function wealthCycle() {
  try {
    const symbols =
      await loadWealthAssets();

    if (!symbols.length) {
      console.log(
        '[WEALTH] no enabled assets configured, skipping cycle'
      );

      return;
    }

    const btcCandles =
      await binanceDailyCandles('BTCUSDT');

    for (const symbol of symbols) {
      try {
        await evaluateWealthAsset(symbol, btcCandles);
      } catch (error) {
        console.error(
          `[WEALTH] ${symbol} evaluation failed: ${error.message}`
        );
      }
    }

    console.log(
      `[WEALTH] cycle complete: ${symbols.length} assets evaluated`
    );
  } catch (error) {
    console.error(
      `[WEALTH] cycle failed: ${error.message}`
    );
  }
}

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
    `[HUNTER] Database (Neon): ${Boolean(supabase)}`
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
      '[HUNTER] Database unavailable (NEON_DATABASE_URL missing?) — learning persistence disabled.'
    );
  }

  if (supabase) {
    const openCount = await loadActivePositions();

    if (openCount >= 0) {
      console.log(`[HUNTER] Restored open positions: ${openCount}`);
    } else {
      console.log(
        '[HUNTER] Starting in degraded mode: position state unconfirmed, new opens blocked until it recovers (retried every cycle).'
      );
    }
  }

  await runCycle();

  setInterval(
    runCycle,
    CONFIG.cycleMs
  );

  // WEALTH ENGINE (Phase 1): independent hourly cycle. Runs once at
  // startup (offset slightly so it doesn't compete with the Hunter
  // cycle's own startup burst), then hourly. A failure here is caught
  // inside wealthCycle() itself and never reaches this Promise chain —
  // it cannot affect Hunter's own interval above.
  setTimeout(
    () => {
      wealthCycle();

      setInterval(
        wealthCycle,
        CONFIG_WEALTH.cycleMs
      );
    },
    60 * 1000
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
