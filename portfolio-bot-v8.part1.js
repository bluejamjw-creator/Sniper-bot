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
