'use strict';
/**
 * BTC TREND — the crypto lane from 12 Nov 2026.
 *
 * Rule (strategy lab winner, 2018–2026, costs included): hold Bitcoin while its daily
 * close is above the average of the previous 50 daily closes; otherwise hold cash.
 * Lab result: 42%/yr vs 24%/yr for just holding, worst drop -59% vs -77%, better in
 * both halves of the history. About 20 switches a year, in the market about half the time.
 *
 * Checked hourly against the last COMPLETED daily candle (00:00 UTC close), so the
 * signal can only change once a day. A change posts BUY or SELL through Hunter's
 * alertUser (which holds overnight messages until 07:00 UK).
 * State lives in replay_kv 'btc_trend_state'. BTC_TREND=off disables.
 */

const N = 50;
let DB = null, NOTIFY = null;
const log = (...a) => console.log('[BTC-TREND]', ...a);

async function fetchDaily() {
  const res = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=60', { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  const now = Date.now();
  // keep only completed candles: [openTime, o, h, l, close, vol, closeTime, ...]
  return rows.filter(r => Number(r[6]) < now).map(r => ({ day: new Date(Number(r[0])).toISOString().slice(0, 10), close: Number(r[4]) }));
}

// Same definition as the lab: close[t] > mean(close[t-49..t]) — the 50 closes up to and including t.
function decide(candles) {
  if (!candles || candles.length < N) return null;
  const last = candles[candles.length - 1];
  const win = candles.slice(-N);
  const sma = win.reduce((a, c) => a + c.close, 0) / N;
  return { day: last.day, close: last.close, sma, above: last.close > sma, gapPct: (last.close / sma - 1) * 100 };
}

const usd = x => `$${Math.round(x).toLocaleString('en-GB')}`;
function buyMessage(d) {
  return ['🟢 BITCOIN — BUY', '', `Bitcoin closed at ${usd(d.close)}, above its 50-day average (${usd(d.sma)}).`,
    'Rule: hold Bitcoin while it stays above that average. You\'ll get a SELL when it closes below.',
    '', 'Tested on 2018–2026: 42% a year vs 24% for just holding, with smaller drops — but it still fell 59% at its worst, so expect losing trades.'].join('\n');
}
function sellMessage(d, state) {
  const pct = state && state.entryPrice ? (d.close / state.entryPrice - 1) * 100 : null;
  return ['🔴 BITCOIN — SELL', '', `Bitcoin closed at ${usd(d.close)}, below its 50-day average (${usd(d.sma)}).`,
    pct === null ? null : `This trade: bought ${usd(state.entryPrice)} on ${state.since} → ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`,
    'Rule: stay in cash until it closes back above the average.'].filter(x => x !== null).join('\n');
}
function statusMessage(d) {
  return ['₿ BITCOIN TREND — now live', '', `Bitcoin's last daily close: ${usd(d.close)} · 50-day average: ${usd(d.sma)} (${d.gapPct >= 0 ? '+' : ''}${d.gapPct.toFixed(1)}%).`,
    d.above ? 'It is ABOVE the average, so the rule says HOLD Bitcoin now. You\'ll get a SELL when it closes below.'
      : 'It is BELOW the average, so the rule says stay in CASH. You\'ll get a BUY when it closes above.',
    '', 'This replaces the small-coin picker. One signal at a time, at most one change a day.'].join('\n');
}

async function getState() {
  if (!DB) return null;
  const { data } = await DB.from('replay_kv').select('value').eq('key', 'btc_trend_state').maybeSingle();
  if (!data) return null;
  try { return typeof data.value === 'string' ? JSON.parse(data.value) : data.value; } catch { return null; }
}
async function setState(s) { if (DB) await DB.from('replay_kv').upsert({ key: 'btc_trend_state', value: JSON.stringify(s), updated_at: new Date().toISOString() }, { onConflict: 'key' }); }

async function tick(fetcher = fetchDaily) {
  const d = decide(await fetcher());
  if (!d) { log('not enough candles'); return null; }
  const state = await getState();
  if (state && state.day === d.day) return { changed: false, d, state }; // already handled this daily close
  const next = { position: d.above ? 'in' : 'out', day: d.day, since: state && state.position === (d.above ? 'in' : 'out') ? state.since : d.day,
    entryPrice: d.above ? (state && state.position === 'in' ? state.entryPrice : d.close) : null };
  let msg = null;
  if (!state) msg = statusMessage(d);
  else if (state.position === 'out' && d.above) msg = buyMessage(d);
  else if (state.position === 'in' && !d.above) msg = sellMessage(d, state);
  await setState(next); // save first so a failed post can't cause a repeat
  log(`${d.day}: close ${Math.round(d.close)} vs 50d avg ${Math.round(d.sma)} → ${next.position.toUpperCase()}${msg ? ' (posted)' : ''}`);
  if (msg && NOTIFY) { try { await NOTIFY(msg); } catch (e) { log(`post failed: ${e.message}`); } }
  return { changed: Boolean(msg), d, state: next, msg };
}

function start(opts = {}) {
  DB = opts.db || null; NOTIFY = opts.notify || null;
  if (process.env.BTC_TREND === 'off') return;
  const run = () => tick().catch(e => log(`failed: ${e.message}`));
  setTimeout(run, opts.startDelayMs ?? 90_000);
  setInterval(run, 60 * 60 * 1000);
}

module.exports = { start, tick, decide, buyMessage, sellMessage, statusMessage, _setDeps: (db, notify) => { DB = db; NOTIFY = notify; } };
