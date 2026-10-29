'use strict';
/**
 * crypto_replay.js — one-off 12-month replay of crypto ENTRY rules (no live effect)
 *
 * Started from portfolio-bot-v8.js. Runs once per REPLAY_VERSION in the
 * background, then saves results to Neon (hunter_kv-style table replay_kv,
 * key 'crypto_replay_<version>') and logs a summary. Nothing is traded or posted.
 *
 * Design (pre-registered so it can't be tuned after the fact):
 *  - Universe: Hunter's current Revolut-tradable coins (survivorship caveat:
 *    coins delisted during the year are missing).
 *  - Data: Binance 15-minute candles, last 365 days. Decisions on each completed
 *    candle; ENTRY at the NEXT candle's open (no look-ahead).
 *  - Exit for every rule: fixed −14% stop / +20% target (Hunter's live bracket),
 *    checked on 15m highs/lows; if both are touched in one candle it counts as
 *    the STOP (conservative). Positions still open after 30 days exit at the close.
 *  - One open trade per coin; no re-entry until it closes.
 *  - Costs: results shown before costs and after 0.2% (Revolut X–like) and
 *    1.5% (Revolut app spread–like) round trip.
 *  - Split: first 8 months = development, last 4 months = untouched holdout.
 *  - Uncertainty: per-week block standard error (trades in the same week are
 *    correlated), 95% interval on average net return per trade.
 *  - Portfolio version: Hunter's real limits (max 3 open, 1 new per 15m),
 *    best-ranked candidate first, compounding equal 1/3 slots.
 *
 * Rules (from our audit + the research review):
 *  R0  any coin, any time (drift benchmark: what does buying at random give?)
 *  R1  V16.3 live filter without the cream score: ATR(15m) ≥ 1%, 24h +4–10%
 *  R1b R1 without the 10% veto: ATR ≥ 1%, 24h ≥ +4%
 *  R2  cross-sectional leader: 1h > 0, 4h > 0, 4h return in top 20% of coins, 4h > BTC 4h
 *  R3  R2 + breakout: close above the highest high of the previous 16 candles
 *  R4  R2 + volume: last hour's volume ≥ 1.5× the median of the same hour over the prior 7 days
 *  R5  R2 + BTC filter: BTC 4h return > 0
 *  R6  R1 + R2 combined
 * (Hunter's cream score can't be replayed faithfully — it uses the live learned
 *  model — so it's judged on forward data instead.)
 */

const REPLAY_VERSION = 'v1';
const DAY = 86400000, C15 = 900000;
const CFG = {
  days: Number(process.env.REPLAY_DAYS || 365),
  stopPct: 14, targetPct: 20, maxHoldDays: 30,
  costs: [0, 0.2, 1.5],
  devFraction: 8 / 12,
  maxOpen: 3,
  concurrency: 4,
};

let DB = null;
const log = m => console.log(`[REPLAY] ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- data
async function fetchKlines(symbol, startMs, endMs) {
  const out = [];
  let from = startMs;
  while (from < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&startTime=${from}&endTime=${endMs}&limit=1000`;
    let rows = null;
    for (let attempt = 0; attempt < 3 && !rows; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (res.status === 429 || res.status === 418) { await sleep(30000); continue; }
        if (!res.ok) return out.length ? out : null;
        rows = await res.json();
      } catch { await sleep(2000); }
    }
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) out.push([+r[0], +r[1], +r[2], +r[3], +r[4], +r[5]]);
    from = rows[rows.length - 1][0] + C15;
    if (rows.length < 1000) break;
    await sleep(120);
  }
  return out;
}

// Align every coin to one 15m time grid (Float32 arrays to keep memory small).
function toSeries(rows, grid) {
  const n = grid.length;
  const s = { o: new Float32Array(n), h: new Float32Array(n), l: new Float32Array(n), c: new Float32Array(n), v: new Float32Array(n), ok: new Uint8Array(n) };
  const idx = new Map(rows.map((r, i) => [r[0], i]));
  for (let t = 0; t < n; t++) {
    const i = idx.get(grid[t]);
    if (i === undefined) continue;
    const r = rows[i];
    s.o[t] = r[1]; s.h[t] = r[2]; s.l[t] = r[3]; s.c[t] = r[4]; s.v[t] = r[5]; s.ok[t] = 1;
  }
  return s;
}

// ---------------------------------------------------------------- features (only past data at each t)
function features(s) {
  const n = s.c.length;
  const f = { r1: new Float32Array(n).fill(NaN), r4: new Float32Array(n).fill(NaN), r24: new Float32Array(n).fill(NaN), atr: new Float32Array(n).fill(NaN), brk: new Uint8Array(n), vol: new Float32Array(n).fill(NaN) };
  const ret = (t, k) => (t >= k && s.ok[t] && s.ok[t - k] && s.c[t - k] > 0 ? s.c[t] / s.c[t - k] - 1 : NaN);
  let atr = NaN;
  const hourVol = new Float32Array(n); // volume of the hour ending at t
  for (let t = 0; t < n; t++) {
    f.r1[t] = ret(t, 4); f.r4[t] = ret(t, 16); f.r24[t] = ret(t, 96);
    if (t > 0 && s.ok[t] && s.ok[t - 1]) {
      const tr = Math.max(s.h[t] - s.l[t], Math.abs(s.h[t] - s.c[t - 1]), Math.abs(s.l[t] - s.c[t - 1]));
      atr = Number.isNaN(atr) ? tr : (atr * 13 + tr) / 14;
      if (t >= 14 && s.c[t] > 0) f.atr[t] = atr / s.c[t];
    }
    if (t >= 16 && s.ok[t]) { let hh = 0; for (let k = 1; k <= 16; k++) hh = Math.max(hh, s.h[t - k]); f.brk[t] = s.c[t] > hh ? 1 : 0; }
    if (t >= 3) hourVol[t] = s.v[t] + s.v[t - 1] + s.v[t - 2] + s.v[t - 3];
    if (t >= 96 * 7 + 3) {
      const same = [];
      for (let d = 1; d <= 7; d++) same.push(hourVol[t - 96 * d]);
      same.sort((a, b) => a - b);
      const med = (same[3] + same[3]) / 2;
      f.vol[t] = med > 0 ? hourVol[t] / med : NaN;
    }
  }
  return f;
}

// ---------------------------------------------------------------- rules
const RULES = {
  R0: () => true,
  R1: (x) => x.atr >= 0.01 && x.r24 >= 0.04 && x.r24 <= 0.10,
  R1b: (x) => x.atr >= 0.01 && x.r24 >= 0.04,
  R2: (x) => x.r1 > 0 && x.r4 > 0 && x.rank >= 0.8 && x.r4 > x.btc4,
  R3: (x) => RULES.R2(x) && x.brk === 1,
  R4: (x) => RULES.R2(x) && x.vol >= 1.5,
  R5: (x) => RULES.R2(x) && x.btc4 > 0,
  R6: (x) => RULES.R1(x) && RULES.R2(x),
};

// ---------------------------------------------------------------- simulation
function exitTrade(s, tEntry) {
  const entry = s.o[tEntry];
  if (!(entry > 0)) return null;
  const stop = entry * (1 - CFG.stopPct / 100), target = entry * (1 + CFG.targetPct / 100);
  const last = Math.min(s.c.length - 1, tEntry + CFG.maxHoldDays * 96);
  for (let t = tEntry; t <= last; t++) {
    if (!s.ok[t]) continue;
    const hitS = s.l[t] <= stop, hitT = s.h[t] >= target;
    if (hitS) return { t, ret: -CFG.stopPct, how: 'SL' };          // both touched -> stop (conservative)
    if (hitT) return { t, ret: CFG.targetPct, how: 'TP' };
  }
  if (last >= s.c.length - 1 && last < tEntry + CFG.maxHoldDays * 96) return { t: last, ret: (s.c[last] / entry - 1) * 100, how: 'OPEN_AT_END' };
  return { t: last, ret: (s.c[last] / entry - 1) * 100, how: 'TIMEOUT' };
}

function stats(trades, cost) {
  const n = trades.length;
  if (!n) return { trades: 0 };
  const net = trades.map(t => t.ret - cost);
  const mean = net.reduce((a, b) => a + b, 0) / n;
  const wins = trades.filter(t => t.ret - cost > 0).length;
  // weekly block standard error
  const byWeek = new Map();
  trades.forEach((t, i) => { const w = Math.floor(t.time / (7 * DAY)); if (!byWeek.has(w)) byWeek.set(w, []); byWeek.get(w).push(net[i]); });
  const wm = [...byWeek.values()].map(a => a.reduce((x, y) => x + y, 0) / a.length);
  const wmean = wm.reduce((a, b) => a + b, 0) / wm.length;
  const wsd = Math.sqrt(wm.reduce((s2, x) => s2 + (x - wmean) ** 2, 0) / Math.max(1, wm.length - 1));
  const se = wsd / Math.sqrt(wm.length);
  const r = v => Math.round(v * 100) / 100;
  return {
    trades: n, weeks: wm.length, winRate: r((wins / n) * 100), avgNetPct: r(mean), ci95: [r(mean - 1.96 * se), r(mean + 1.96 * se)],
    tp: trades.filter(t => t.how === 'TP').length, sl: trades.filter(t => t.how === 'SL').length, timeout: trades.filter(t => t.how === 'TIMEOUT').length,
    openAtEnd: trades.filter(t => t.how === 'OPEN_AT_END').length,
    avgHoldH: r(trades.reduce((a, t) => a + t.holdH, 0) / n),
  };
}

async function runReplay(series, grid, btc) {
  const syms = Object.keys(series);
  const feats = Object.fromEntries(syms.map(s => [s, features(series[s])]));
  const btcF = btc ? features(btc) : null;
  const n = grid.length;
  const split = grid[Math.floor(n * CFG.devFraction)];
  const perRule = Object.fromEntries(Object.keys(RULES).map(k => [k, []]));
  const busyUntil = Object.fromEntries(Object.keys(RULES).map(k => [k, Object.fromEntries(syms.map(s => [s, -1]))]));
  const portfolio = Object.fromEntries(Object.keys(RULES).map(k => [k, { open: [], equity: 1, peak: 1, maxDD: 0, trades: 0 }]));
  const warm = 96 * 8;
  for (let t = warm; t < n - 1; t++) {
    if (t % 500 === 0) await new Promise(r => setImmediate(r)); // never stall Hunter's live work
    // cross-sectional rank of 4h return at t
    const live = syms.filter(s => series[s].ok[t] && !Number.isNaN(feats[s].r4[t]));
    if (live.length < 10) continue;
    const sorted = [...live].sort((a, b) => feats[a].r4[t] - feats[b].r4[t]);
    const rank = new Map(sorted.map((s, i) => [s, i / (sorted.length - 1)]));
    const btc4 = btcF ? btcF.r4[t] : 0;
    const cands = {};
    for (const s of live) {
      const f = feats[s];
      const x = { r1: f.r1[t], r4: f.r4[t], r24: f.r24[t], atr: f.atr[t], brk: f.brk[t], vol: f.vol[t], rank: rank.get(s), btc4 };
      if ([x.r1, x.r24, x.atr].some(Number.isNaN)) continue;
      for (const [k, rule] of Object.entries(RULES)) {
        if (!rule(x)) continue;
        (cands[k] ||= []).push({ s, rank: x.rank });
        if (busyUntil[k][s] >= t) continue;
        if (k === 'R0' && ((t + s.length) % 96) !== 0) continue; // R0: one random-ish sample per coin per day
        const ex = exitTrade(series[s], t + 1);
        if (!ex) continue;
        busyUntil[k][s] = ex.t;
        perRule[k].push({ time: grid[t + 1], ret: ex.ret, how: ex.how, holdH: ((ex.t - (t + 1)) * 15) / 60, dev: grid[t + 1] < split });
      }
    }
    // portfolio version (Hunter limits: 3 open, 1 new per candle), 0.2% cost
    for (const [k, pf] of Object.entries(portfolio)) {
      pf.open = pf.open.filter(p => { if (p.exitT <= t) { pf.equity *= 1 + ((p.ret - 0.2) / 100) / CFG.maxOpen; pf.trades++; return false; } return true; });
      pf.peak = Math.max(pf.peak, pf.equity); pf.maxDD = Math.max(pf.maxDD, 1 - pf.equity / pf.peak);
      if (pf.open.length >= CFG.maxOpen || k === 'R0') continue;
      const c = (cands[k] || []).filter(x => !pf.open.some(p => p.s === x.s)).sort((a, b) => b.rank - a.rank)[0];
      if (!c) continue;
      const ex = exitTrade(series[c.s], t + 1);
      if (ex) pf.open.push({ s: c.s, exitT: ex.t, ret: ex.ret });
    }
  }
  const out = { rules: {} };
  for (const [k, trades] of Object.entries(perRule)) {
    const dev = trades.filter(x => x.dev), hold = trades.filter(x => !x.dev);
    out.rules[k] = { dev: {}, holdout: {}, portfolio: k === 'R0' ? null : { trades: portfolio[k].trades, returnPct: Math.round((portfolio[k].equity - 1) * 10000) / 100, maxDrawdownPct: Math.round(portfolio[k].maxDD * 10000) / 100 } };
    for (const c of CFG.costs) { out.rules[k].dev[`cost${c}`] = stats(dev, c); out.rules[k].holdout[`cost${c}`] = stats(hold, c); }
  }
  out.splitAt = new Date(split).toISOString();
  return out;
}

// ---------------------------------------------------------------- orchestration
async function kvGet(key) { if (!DB) return null; const { data } = await DB.from('replay_kv').select('value').eq('key', key).maybeSingle(); return data ? data.value : null; }
async function kvSet(key, value) { if (DB) await DB.from('replay_kv').upsert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, { onConflict: 'key' }); }

async function run(symbols) {
  const end = Math.floor(Date.now() / C15) * C15 - C15;
  const start = end - CFG.days * DAY;
  const grid = []; for (let t = start; t <= end; t += C15) grid.push(t);
  log(`starting: ${symbols.length} coins, ${CFG.days} days, ${grid.length} candles each`);
  const series = {};
  let i = 0, done = 0;
  const fetchOne = async () => {
    while (i < symbols.length) {
      const sym = symbols[i++];
      const rows = await fetchKlines(sym, start, end);
      if (rows && rows.length > 96 * 30) series[sym] = toSeries(rows, grid);
      if (++done % 25 === 0) log(`downloaded ${done}/${symbols.length}`);
    }
  };
  await Promise.all(Array.from({ length: CFG.concurrency }, fetchOne));
  const btcRows = await fetchKlines('BTCUSDT', start, end);
  const btc = btcRows && btcRows.length ? toSeries(btcRows, grid) : null;
  log(`data ready: ${Object.keys(series).length} coins with history`);
  await sleep(10);
  const result = { version: REPLAY_VERSION, at: new Date().toISOString(), coins: Object.keys(series).length, from: new Date(start).toISOString(), to: new Date(end).toISOString(), config: CFG, ...(await runReplay(series, grid, btc)) };
  await kvSet(`crypto_replay_${REPLAY_VERSION}`, result);
  log(`RESULT ${JSON.stringify(result)}`);
  return result;
}

function start(opts = {}) {
  DB = opts.db || null;
  if (process.env.CRYPTO_REPLAY === 'off') return;
  setTimeout(async () => {
    try {
      if (await kvGet(`crypto_replay_${REPLAY_VERSION}`) && process.env.CRYPTO_REPLAY !== 'force') { log(`already done (${REPLAY_VERSION}) — results in replay_kv`); return; }
      const symbols = (opts.universe ? opts.universe() : []).filter(s => /USDT$/.test(s) && s !== 'BTCUSDT');
      if (symbols.length < 20) { log(`universe not ready (${symbols.length}) — will retry next start`); return; }
      await run(symbols);
    } catch (e) { log(`failed: ${e.stack || e.message}`); }
  }, opts.startDelayMs ?? 10 * 60_000);
}

module.exports = { start, run, runReplay, features, exitTrade, stats, toSeries, RULES, CFG, _setDb: d => { DB = d; } };
