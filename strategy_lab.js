'use strict';
/**
 * STRATEGY LAB — one-off (re-runnable) long-history backtests for the three lanes
 * that haven't worked: crypto, US stocks, and the trend lane (individual stocks).
 *
 * Only well-known, published rule families are tested, from a small fixed menu
 * (no parameter hunting): moving-average trend filters, time-series momentum,
 * dual momentum, sector rotation and cross-sectional momentum. Each is compared
 * with simply buying and holding, over the full history AND separately over the
 * first and second halves. A rule only counts as a "winner" if it beats buy-and-hold
 * on risk-adjusted return (Sharpe) and has a smaller worst drop (max drawdown)
 * in BOTH halves — so one lucky period can't carry it.
 *
 * Data: Binance daily candles (crypto, from 2017), Yahoo daily adjusted closes
 * (stocks/ETFs, dividends included). Decisions use the close; the position applies
 * from the next day. Costs: 0.2% per unit traded (crypto), 0.1% (stocks).
 * Results -> replay_kv 'strategy_lab_<version>' and one "[LAB] RESULT" log line.
 *
 * Caveat for the stock-picking test: the universe is today's big companies, which
 * flatters history (survivorship bias). It's flagged in the result.
 */

const LAB_VERSION = 'lab1';
const DAY = 86400000;
let DB = null;
const log = (...a) => console.log('[LAB]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- data
async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (strategy-lab)' }, signal: AbortSignal.timeout(25000) });
      if (res.ok) return await res.json();
      if (res.status === 404 || res.status === 400) return null;
    } catch { /* retry */ }
    await sleep(1000 * (i + 1));
  }
  return null;
}
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

async function yahooDaily(sym) {
  const d = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=max&events=div%7Csplit`);
  await sleep(250);
  const r = d && d.chart && d.chart.result && d.chart.result[0];
  if (!r || !Array.isArray(r.timestamp)) return null;
  const adj = r.indicators && r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose;
  const cl = r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close;
  const px = adj || cl; if (!px) return null;
  const out = [];
  for (let i = 0; i < r.timestamp.length; i++) { const c = Number(px[i]); if (c > 0) out.push({ d: isoDay(r.timestamp[i] * 1000), c }); }
  return out;
}
async function binanceDaily(sym) {
  const out = []; let from = Date.parse('2017-01-01T00:00:00Z');
  for (let k = 0; k < 6; k++) {
    const rows = await getJSON(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1d&startTime=${from}&limit=1000`);
    await sleep(300);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) out.push({ d: isoDay(r[0]), c: Number(r[4]) });
    from = rows[rows.length - 1][0] + DAY;
    if (rows.length < 1000) break;
  }
  if (out.length && out[out.length - 1].d === isoDay(Date.now())) out.pop(); // today's candle is still forming
  return out.length ? out : null;
}

// Align several series on the dates they ALL have.
function align(seriesBySym) {
  const syms = Object.keys(seriesBySym).filter(s => seriesBySym[s] && seriesBySym[s].length);
  if (!syms.length) return { dates: [], px: {} };
  const maps = Object.fromEntries(syms.map(s => [s, new Map(seriesBySym[s].map(x => [x.d, x.c]))]));
  const dates = seriesBySym[syms[0]].map(x => x.d).filter(d => syms.every(s => maps[s].has(d)));
  const px = Object.fromEntries(syms.map(s => [s, dates.map(d => maps[s].get(d))]));
  return { dates, px };
}

// ---------------------------------------------------------------- engine
function sma(arr, t, n) { if (t + 1 < n) return null; let s = 0; for (let i = t - n + 1; i <= t; i++) s += arr[i]; return s / n; }
function ret(arr, t, n) { return t - n >= 0 ? arr[t] / arr[t - n] - 1 : null; }
const monthOf = d => d.slice(0, 7);

/**
 * signal(t) -> { sym: weight } decided at close t (weights sum ≤ 1, rest in cash).
 * schedule 'daily' re-decides every day; 'monthly' only on the last trading day of each month;
 * 'weekly' every 5 trading days.
 */
function backtest({ dates, px }, signal, { schedule = 'daily', cost = 0.001, warmup = 0 } = {}) {
  const n = dates.length; const eq = new Array(n).fill(1); let w = {}; let trades = 0, inMkt = 0;
  for (let t = Math.max(warmup, 0); t < n - 1; t++) {
    const decide = schedule === 'daily' || (schedule === 'monthly' ? monthOf(dates[t]) !== monthOf(dates[t + 1]) : (t - warmup) % 5 === 0) || t === warmup;
    let costNow = 0;
    if (decide) {
      const nw = signal(t) || {};
      const syms = new Set([...Object.keys(w), ...Object.keys(nw)]);
      let turn = 0; for (const s of syms) turn += Math.abs((nw[s] || 0) - (w[s] || 0));
      if (turn > 1e-9) { trades++; costNow = turn * cost; }
      w = nw;
    }
    let r = 0, exp = 0;
    for (const [s, wt] of Object.entries(w)) { if (!wt) continue; r += wt * (px[s][t + 1] / px[s][t] - 1); exp += wt; }
    if (exp > 0) inMkt++;
    eq[t + 1] = eq[t] * (1 + r) * (1 - costNow);
  }
  return { eq, trades, inMkt, start: Math.max(warmup, 0) };
}
function metrics(dates, eq, from, to, periodsPerYear) {
  if (to - from < 30) return null;
  const rets = []; let peak = eq[from], mdd = 0;
  for (let t = from + 1; t <= to; t++) { rets.push(eq[t] / eq[t - 1] - 1); peak = Math.max(peak, eq[t]); mdd = Math.min(mdd, eq[t] / peak - 1); }
  const years = (Date.parse(dates[to]) - Date.parse(dates[from])) / (365.25 * DAY);
  const total = eq[to] / eq[from];
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  return {
    from: dates[from], to: dates[to],
    cagr: +((Math.pow(total, 1 / Math.max(years, 1e-9)) - 1) * 100).toFixed(1),
    maxDD: +(mdd * 100).toFixed(1),
    sharpe: sd > 0 ? +((mean / sd) * Math.sqrt(periodsPerYear)).toFixed(2) : null,
    total: +((total - 1) * 100).toFixed(0),
  };
}
function evaluate(data, signal, opts, ppy) {
  const bt = backtest(data, signal, opts);
  const s = bt.start, e = data.dates.length - 1, mid = Math.floor((s + e) / 2);
  return {
    full: metrics(data.dates, bt.eq, s, e, ppy), first: metrics(data.dates, bt.eq, s, mid, ppy), second: metrics(data.dates, bt.eq, mid, e, ppy),
    trades: bt.trades, timeInMarket: +((bt.inMkt / Math.max(1, e - s)) * 100).toFixed(0),
  };
}
// Winner = better Sharpe AND smaller drawdown than its benchmark in BOTH halves.
function verdict(res, bench) {
  const ok = h => res[h] && bench[h] && res[h].sharpe !== null && bench[h].sharpe !== null && res[h].sharpe > bench[h].sharpe && res[h].maxDD > bench[h].maxDD;
  return ok('first') && ok('second') ? 'WINNER' : (ok('first') || ok('second')) ? 'mixed' : 'no';
}

// ---------------------------------------------------------------- the menus
function cryptoTests(data) {
  const { px } = data; const B = px.BTCUSDT, E = px.ETHUSDT;
  const above = (a, n) => t => (sma(a, t, n) !== null && a[t] > sma(a, t, n));
  const T = {
    hold_btc: [t => ({ BTCUSDT: 1 }), 'daily'],
    hold_eth: [t => ({ ETHUSDT: 1 }), 'daily'],
    hold_5050: [t => ({ BTCUSDT: 0.5, ETHUSDT: 0.5 }), 'monthly'],
    btc_above_sma50: [t => (above(B, 50)(t) ? { BTCUSDT: 1 } : {}), 'daily'],
    btc_above_sma100: [t => (above(B, 100)(t) ? { BTCUSDT: 1 } : {}), 'daily'],
    btc_above_sma200: [t => (above(B, 200)(t) ? { BTCUSDT: 1 } : {}), 'daily'],
    btc_sma50_over_200: [t => (sma(B, t, 200) !== null && sma(B, t, 50) > sma(B, t, 200) ? { BTCUSDT: 1 } : {}), 'daily'],
    btc_mom90: [t => (ret(B, t, 90) > 0 ? { BTCUSDT: 1 } : {}), 'daily'],
    eth_above_sma100: [t => (above(E, 100)(t) ? { ETHUSDT: 1 } : {}), 'daily'],
    both_above_sma100: [t => ({ ...(above(B, 100)(t) ? { BTCUSDT: 0.5 } : {}), ...(above(E, 100)(t) ? { ETHUSDT: 0.5 } : {}) }), 'daily'],
    dual_mom90_weekly: [t => { const rb = ret(B, t, 90), re = ret(E, t, 90); if (rb === null || re === null) return {}; const best = rb >= re ? 'BTCUSDT' : 'ETHUSDT'; return Math.max(rb, re) > 0 ? { [best]: 1 } : {}; }, 'weekly'],
  };
  const out = {};
  for (const [k, [f, schedule]] of Object.entries(T)) out[k] = evaluate(data, f, { schedule, cost: 0.002, warmup: 200 }, 365);
  for (const k of Object.keys(out)) if (!k.startsWith('hold')) out[k].verdict = verdict(out[k], out[k.startsWith('eth') ? 'hold_eth' : k.startsWith('both') || k.startsWith('dual') ? 'hold_5050' : 'hold_btc']);
  out._benchmark = { btc: 'hold_btc', eth: 'hold_eth', mixed: 'hold_5050' };
  return out;
}

const SECTORS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB'];
function stockTests(data) {
  const { px } = data; const S = px.SPY, Q = px.QQQ;
  const up200 = (a, t) => sma(a, t, 200) !== null && a[t] > sma(a, t, 200);
  const T = {
    hold_spy: [t => ({ SPY: 1 }), 'daily'],
    hold_qqq: [t => ({ QQQ: 1 }), 'daily'],
    spy_above_sma200_daily: [t => (up200(S, t) ? { SPY: 1 } : { SHY: 1 }), 'daily'],
    spy_above_sma200_monthly: [t => (up200(S, t) ? { SPY: 1 } : { SHY: 1 }), 'monthly'],
    qqq_above_sma200_monthly: [t => (up200(Q, t) ? { QQQ: 1 } : { SHY: 1 }), 'monthly'],
    spy_mom12m_monthly: [t => (ret(S, t, 252) > ret(px.SHY, t, 252) ? { SPY: 1 } : { SHY: 1 }), 'monthly'],
    dual_momentum_gem: [t => {
      const rs = ret(S, t, 252), re = ret(px.EFA, t, 252), rc = ret(px.SHY, t, 252);
      if (rs === null || re === null || rc === null) return {};
      return rs > rc ? (rs >= re ? { SPY: 1 } : { EFA: 1 }) : { AGG: 1 };
    }, 'monthly'],
    sectors_top3_6m: [t => {
      const r = SECTORS.map(s => [s, ret(px[s], t, 126)]).filter(x => x[1] !== null).sort((a, b) => b[1] - a[1]).slice(0, 3);
      return Object.fromEntries(r.map(([s]) => [s, 1 / 3]));
    }, 'monthly'],
    sectors_top3_6m_trend: [t => {
      if (!up200(S, t)) return { SHY: 1 };
      const r = SECTORS.map(s => [s, ret(px[s], t, 126)]).filter(x => x[1] !== null).sort((a, b) => b[1] - a[1]).slice(0, 3);
      return Object.fromEntries(r.map(([s]) => [s, 1 / 3]));
    }, 'monthly'],
  };
  const out = {};
  for (const [k, [f, schedule]] of Object.entries(T)) out[k] = evaluate(data, f, { schedule, cost: 0.001, warmup: 260 }, 252);
  for (const k of Object.keys(out)) if (!k.startsWith('hold')) out[k].verdict = verdict(out[k], out[k.startsWith('qqq') ? 'hold_qqq' : 'hold_spy']);
  return out;
}

const US_BIG = ['AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NVDA', 'JPM', 'JNJ', 'XOM', 'PG', 'V', 'MA', 'HD', 'UNH', 'KO', 'PEP', 'MRK', 'ABBV', 'CVX', 'WMT',
  'COST', 'MCD', 'DIS', 'CSCO', 'ORCL', 'INTC', 'ADBE', 'CRM', 'NFLX', 'AMD', 'TXN', 'QCOM', 'HON', 'CAT', 'BA', 'GS', 'MS', 'LLY', 'PFE', 'T'];
const UK_BIG = ['AZN.L', 'SHEL.L', 'HSBA.L', 'ULVR.L', 'BP.L', 'GSK.L', 'RIO.L', 'REL.L', 'DGE.L', 'BATS.L', 'LSEG.L', 'NG.L', 'RR.L', 'BARC.L', 'LLOY.L', 'VOD.L', 'TSCO.L', 'BA.L', 'PRU.L', 'AAL.L'];
function trendTests(data, universe, benchSym) {
  const { px } = data; const U = universe.filter(s => px[s]);
  const mom121 = (s, t) => (t >= 252 ? px[s][t - 21] / px[s][t - 252] - 1 : null);
  const trendUp = (s, t) => sma(px[s], t, 200) !== null && sma(px[s], t, 50) > sma(px[s], t, 200);
  const benchUp = t => sma(px[benchSym], t, 200) !== null && px[benchSym][t] > sma(px[benchSym], t, 200);
  const topK = (t, k) => U.map(s => [s, mom121(s, t)]).filter(x => x[1] !== null).sort((a, b) => b[1] - a[1]).slice(0, k);
  const ew = list => (list.length ? Object.fromEntries(list.map(s => [s, 1 / list.length])) : {});
  const T = {
    hold_equal_weight: [t => ew(U), 'monthly'],
    momentum_top5: [t => ew(topK(t, 5).map(x => x[0])), 'monthly'],
    momentum_top10: [t => ew(topK(t, 10).map(x => x[0])), 'monthly'],
    momentum_top10_market_filter: [t => (benchUp(t) ? ew(topK(t, 10).map(x => x[0])) : {}), 'monthly'],
    trend_50over200_all: [t => ew(U.filter(s => trendUp(s, t))), 'monthly'],
    trend_50over200_top10_mom: [t => ew(topK(t, U.length).filter(([s]) => trendUp(s, t)).slice(0, 10).map(x => x[0])), 'monthly'],
  };
  const out = {};
  for (const [k, [f, schedule]] of Object.entries(T)) out[k] = evaluate(data, f, { schedule, cost: 0.001, warmup: 260 }, 252);
  for (const k of Object.keys(out)) if (k !== 'hold_equal_weight') out[k].verdict = verdict(out[k], out.hold_equal_weight);
  out._caveat = 'Universe = today\'s big companies (survivorship bias flatters all of these, including the benchmark).';
  return out;
}

// ---------------------------------------------------------------- run
async function run(fetchers = { yahooDaily, binanceDaily }) {
  const result = { version: LAB_VERSION, at: new Date().toISOString() };
  // crypto
  const cr = { BTCUSDT: await fetchers.binanceDaily('BTCUSDT'), ETHUSDT: await fetchers.binanceDaily('ETHUSDT') };
  const cd = align(cr);
  log(`crypto: ${cd.dates.length} days (${cd.dates[0]} → ${cd.dates[cd.dates.length - 1]})`);
  result.crypto = cd.dates.length > 400 ? cryptoTests(cd) : { error: 'not enough crypto history' };
  // stock ETFs
  const etfSyms = ['SPY', 'QQQ', 'EFA', 'AGG', 'SHY', ...SECTORS];
  const etf = {}; for (const s of etfSyms) etf[s] = await fetchers.yahooDaily(s);
  const ed = align(etf);
  log(`ETFs: ${Object.keys(ed.px).length} series, ${ed.dates.length} common days (${ed.dates[0]} → ${ed.dates[ed.dates.length - 1]})`);
  result.stocks = ed.dates.length > 800 ? stockTests(ed) : { error: 'not enough ETF history' };
  // trend lane: US and UK big stocks, each with its own market filter
  for (const [label, uni, bench] of [['us', US_BIG, 'SPY'], ['uk', UK_BIG, 'ISF.L']]) {
    const raw = {}; for (const s of [...uni, bench]) raw[s] = await fetchers.yahooDaily(s);
    // keep stocks with at least ~10 years so the common window is long
    const longEnough = Object.fromEntries(Object.entries(raw).filter(([, v]) => v && v.length > 2500));
    const td = align(longEnough);
    log(`trend ${label}: ${Object.keys(td.px).length} series, ${td.dates.length} common days (${td.dates[0]} → ${td.dates[td.dates.length - 1]})`);
    result[`trend_${label}`] = td.dates.length > 800 && td.px[bench] ? trendTests(td, uni, bench) : { error: `not enough ${label} history` };
  }
  return result;
}

function summary(result) {
  const pick = sec => (sec && !sec.error ? Object.fromEntries(Object.entries(sec).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, { cagr: v.full && v.full.cagr, maxDD: v.full && v.full.maxDD, sharpe: v.full && v.full.sharpe, verdict: v.verdict || 'benchmark' }])) : sec);
  return { crypto: pick(result.crypto), stocks: pick(result.stocks), trend_us: pick(result.trend_us), trend_uk: pick(result.trend_uk) };
}

async function kvGet(key) { if (!DB) return null; const { data } = await DB.from('replay_kv').select('value').eq('key', key).maybeSingle(); return data ? (typeof data.value === 'string' ? JSON.parse(data.value) : data.value) : null; }
async function kvSet(key, value) { if (DB) await DB.from('replay_kv').upsert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, { onConflict: 'key' }); }

function start(opts = {}) {
  DB = opts.db || null;
  if (process.env.STRATEGY_LAB === 'off') return;
  setTimeout(async () => {
    try {
      const last = await kvGet(`strategy_lab_${LAB_VERSION}`);
      if (last && process.env.STRATEGY_LAB !== 'force') { log(`already run (${last.at}) — STRATEGY_LAB=force to re-run`); return; }
      const result = await run();
      await kvSet(`strategy_lab_${LAB_VERSION}`, result);
      log(`RESULT ${JSON.stringify(summary(result))}`);
    } catch (e) { log(`failed: ${e.stack || e.message}`); }
  }, opts.startDelayMs ?? 3 * 60_000);
}

module.exports = { LAB_VERSION, start, run, align, backtest, metrics, evaluate, verdict, cryptoTests, stockTests, trendTests, summary, sma, ret };
