'use strict';
/**
 * horse_picks.js — HUNTER HORSE PICKS (v1, paper phase)
 *
 * Third module in the Hunter process. UK + Irish racing via The Racing API
 * (free plan: daily racecards + results, basic data). Loaded by
 * portfolio-bot-v8.js: require('./horse_picks.js').start({ db }).
 *
 * Phase 1 (default, HORSE_POSTS unset/off): FIELD AUDIT + PAPER TRIAL.
 *   - Audits which fields the subscription actually supplies, saves the
 *     audit, the frozen model config and sample raw data to Neon (horse_kv).
 *   - Scores and records picks every day, settles them from results,
 *     but posts NOTHING to Discord.
 * Phase 2 (HORSE_POSTS=on, set only after the audit + config are reviewed):
 *   - Posts the day's picks (max 3, NAP marked, or "no selections today")
 *     and the weekly report to DISCORD_WEBHOOK_HORSES.
 *
 * Model v1 (frozen; change = new version, evaluated forward only):
 *   Runner score out of 100:
 *     recent form 35 · official rating 25 · course/distance 15 · freshness 10
 *     · trainer 8 · jockey 7. Components the subscription doesn't supply at
 *     all are disabled for EVERY race (named profile, rescaled to 100);
 *     a component missing for SOME runners of a race => race skipped.
 *   Rating points = max(0, 25 − 1.5 × (top OR in race − horse OR)).
 *   Form: last 6 starts, weights 1, .8, .6, .45, .3, .2. Per start q = (N−p)/(N−1)
 *     when the field size is known from our stored results; otherwise from
 *     the form figure (documented fallback table). F/U/P/R/B/S = 0. ≥3 starts.
 *   Freshness bands: 0–6d 5 · 7–30 10 · 31–60 8 · 61–120 5 · 121–240 2 · >240 0.
 *   C/D: CD 15 · C+D 12 · D 9 · C 6 · none 0.
 *   Trainer/jockey: r = (W14 + 20·r0)/(N14 + 20); points = M·clip(r/2r0, 0, 1),
 *     r0 from results stored before the 14-day window; off until 14 days of results.
 *   Races: GB/IRE, 4–10 runners, non-handicap, every runner ≥3 starts, core
 *     data for every runner, not started, non-runners removed.
 *   Select: top ≥ 75, lead ≥ 8 over runner-up, 1 per race, max 3 per day;
 *     rank by score, then lead, then form points. Highest = NAP.
 *   Settlement: 1 unit win stake. Won / position / void (non-runner) /
 *     unsettled kept separate. Profit only with a starting price in the
 *     results (industry SP). Baseline: top-rated horse in the same races
 *     (ties: the unit is split equally across tied horses).
 */

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

const MODEL = Object.freeze({
  version: 'v1',
  weights: { form: 35, rating: 25, cd: 15, fresh: 10, trainer: 8, jockey: 7 },
  formWeights: [1.0, 0.8, 0.6, 0.45, 0.3, 0.2],
  formFallbackQ: { 1: 1.0, 2: 0.75, 3: 0.6, 4: 0.45, 5: 0.3, 6: 0.2, 7: 0.15, 8: 0.1, 9: 0.05, 0: 0 },
  minStarts: 3,
  ratingPerPoint: 1.5,
  freshBands: [[6, 5], [30, 10], [60, 8], [120, 5], [240, 2], [Infinity, 0]],
  cdPoints: { CD: 15, C_AND_D: 12, D: 9, C: 6, NONE: 0 },
  smoothing: 20,
  humanFormMinDays: 14,
  field: { min: 4, max: 10 },
  regions: ['GB', 'IRE'],
  minScore: 75,
  minGap: 8,
  maxPerDay: 3,
});

const CFG = {
  base: env('RACING_API_BASE', 'https://api.theracingapi.com'),
  user: process.env.RACING_API_USERNAME,
  pass: process.env.RACING_API_PASSWORD,
  webhook: process.env.DISCORD_WEBHOOK_HORSES,
  posts: /^(on|true|live)$/i.test(env('HORSE_POSTS', 'off')),
  pickHourUK: Number(env('HORSE_PICK_HOUR_UK', 11)),
  settleHoursUK: [21, 23],
};

let DB = null;
const STATE = { lastDayRun: '', settledAt: new Set(), audit: null, timer: null };
const log = m => console.log(`[HORSES] ${m}`);
const round2 = v => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- API
// The free plan allows 1 request per second: space calls 1.2 s apart and retry once on 429.
let lastCallAt = 0;
async function api(path, params = {}, retry = true) {
  const wait = lastCallAt + 1200 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallAt = Date.now();
  const u = new URL(CFG.base + path);
  for (const [k, v] of Object.entries(params)) [].concat(v).forEach(x => u.searchParams.append(k, x));
  const auth = Buffer.from(`${CFG.user}:${CFG.pass}`).toString('base64');
  try {
    const res = await fetch(u, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    const body = await res.json().catch(() => null);
    if (res.status === 429 && retry) { await new Promise(r => setTimeout(r, 2500)); return api(path, params, false); }
    return { status: res.status, body };
  } catch (e) { return { status: 0, body: null, error: e.message }; }
}

const RACECARD_PATHS = ['/v1/racecards/free'];
const RESULT_PATHS = ['/v1/results/today/free', '/v1/results/free', '/v1/results/today', '/v1/results'];

function listOf(body, keys = ['racecards', 'results', 'races', 'data']) {
  if (Array.isArray(body)) return body;
  for (const k of keys) if (body && Array.isArray(body[k])) return body[k];
  return [];
}

async function fetchRacecards(day = 'today') {
  for (const p of RACECARD_PATHS) {
    const r = await api(p, { day, region_codes: ['gb', 'ire'] });
    if (r.status === 200) return { path: p, races: listOf(r.body), status: 200 };
    const r2 = r.status === 422 || r.status === 400 ? await api(p, { day }) : null;
    if (r2 && r2.status === 200) return { path: p, races: listOf(r2.body), status: 200 };
    log(`racecards ${p} -> HTTP ${r.status}${r2 ? `/${r2.status}` : ''} ${JSON.stringify(r.body || r.error || '').slice(0, 160)}`);
  }
  return { path: null, races: [], status: 'failed' };
}

let RESULTS_PATH = null;
async function fetchResults() {
  const paths = RESULTS_PATH ? [RESULTS_PATH] : RESULT_PATHS;
  for (const p of paths) {
    const r = await api(p, { region: ['gb', 'ire'] });
    if (r.status === 200) { RESULTS_PATH = p; return { path: p, races: listOf(r.body), status: 200 }; }
    log(`results ${p} -> HTTP ${r.status} ${JSON.stringify(r.body || r.error || '').slice(0, 120)}`);
  }
  return { path: null, races: [], status: 'failed' };
}

// ---------------------------------------------------------------- field access (names confirmed by the audit)
const F = {
  raceId: r => r.race_id ?? r.id,
  region: r => String(r.region ?? r.region_code ?? '').toUpperCase(),
  course: r => r.course ?? r.course_name ?? '',
  off: r => r.off_dt ?? r.off_time_iso ?? (r.date && r.off_time ? `${r.date} ${r.off_time}` : r.off_time),
  name: r => r.race_name ?? r.title ?? '',
  type: r => r.type ?? r.race_type ?? '',
  runners: r => (Array.isArray(r.runners) ? r.runners : []),
  isHandicap: r => /handicap|h'cap|hcap/i.test(F.name(r)) || /handicap/i.test(String(r.race_type ?? '')),
  horseId: x => x.horse_id ?? x.id,
  horse: x => x.horse ?? x.name ?? '',
  number: x => x.number ?? x.saddle_cloth ?? null,
  or: x => num(x.ofr ?? x.or ?? x.official_rating),
  form: x => (typeof x.form === 'string' ? x.form : null),
  lastRun: x => num(x.last_run ?? x.days_since_last_run),
  cd: x => cdFlags(x),
  trainerId: x => x.trainer_id ?? x.trainer ?? null,
  jockeyId: x => x.jockey_id ?? x.jockey ?? null,
  nonRunner: x => Boolean(x.non_runner ?? x.nr ?? (String(x.status ?? '').toLowerCase() === 'non-runner')),
  position: x => x.position ?? x.pos ?? null,
  sp: x => x.sp ?? null,
  spDec: x => num(x.sp_dec ?? x.sp_decimal),
};
function num(v) { if (v === null || v === undefined || v === '' || v === '-') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function cdFlags(x) {
  const raw = x.course_distance ?? x.cd ?? x.cd_flags ?? x.course_distance_winner;
  if (raw === undefined || raw === null) return undefined; // not supplied
  const s = String(raw).toUpperCase();
  if (s.includes('CD')) return 'CD';
  const c = /C/.test(s), d = /D/.test(s);
  return c && d ? 'C_AND_D' : d ? 'D' : c ? 'C' : 'NONE';
}

// ---------------------------------------------------------------- audit
function auditCards(races) {
  const fields = {
    official_rating: F.or, form: F.form, last_run: F.lastRun, course_distance: F.cd,
    trainer_id: x => x.trainer_id ?? null, jockey_id: x => x.jockey_id ?? null, horse_id: F.horseId, number: F.number,
  };
  const runners = races.flatMap(F.runners);
  const cov = {};
  for (const [k, fn] of Object.entries(fields)) {
    const have = runners.filter(x => { const v = fn(x); return v !== null && v !== undefined; }).length;
    cov[k] = runners.length ? round2((have / runners.length) * 100) : 0;
  }
  const raceKeys = [...new Set(races.flatMap(r => Object.keys(r)))].sort();
  const runnerKeys = [...new Set(runners.flatMap(x => Object.keys(x)))].sort();
  return { races: races.length, runners: runners.length, coveragePct: cov, raceKeys, runnerKeys, handicaps: races.filter(F.isHandicap).length };
}
function auditResults(races) {
  const runners = races.flatMap(F.runners);
  const pct = fn => (runners.length ? round2((runners.filter(x => fn(x) !== null && fn(x) !== undefined).length / runners.length) * 100) : 0);
  return {
    races: races.length, runners: runners.length,
    coveragePct: { position: pct(F.position), sp: pct(F.sp), sp_dec: pct(F.spDec), horse_id: pct(F.horseId), trainer_id: pct(x => x.trainer_id ?? null), jockey_id: pct(x => x.jockey_id ?? null) },
    raceKeys: [...new Set(races.flatMap(r => Object.keys(r)))].sort(),
    runnerKeys: [...new Set(runners.flatMap(x => Object.keys(x)))].sort(),
  };
}

// Which components the subscription supplies at all (global, not per race).
function profileFrom(audit) {
  const c = audit && audit.coveragePct ? audit.coveragePct : {};
  const on = { form: c.form > 0, rating: c.official_rating > 0, cd: c.course_distance > 0, fresh: c.last_run > 0, trainer: false, jockey: false };
  return on;
}
function profileName(on) {
  const avail = Object.entries(MODEL.weights).filter(([k]) => on[k]).reduce((s, [, w]) => s + w, 0);
  const off = Object.keys(MODEL.weights).filter(k => !on[k]);
  return { name: `${MODEL.version}_core${avail}${off.length ? `_no-${off.join('-')}` : ''}`, available: avail };
}

// ---------------------------------------------------------------- scoring
function formStarts(formStr) {
  if (!formStr) return null;
  const chars = formStr.replace(/[-/\s]/g, '').toUpperCase().split('').filter(ch => /[0-9FUPRBSCL]/.test(ch) && !/[CL]/.test(ch));
  return chars.slice(-6).reverse(); // most recent first
}
function formPoints(formStr) {
  const starts = formStarts(formStr);
  if (!starts || starts.length < MODEL.minStarts) return null;
  let s = 0, w = 0;
  starts.forEach((ch, i) => {
    const q = /[0-9]/.test(ch) ? MODEL.formFallbackQ[Number(ch)] : 0;
    s += MODEL.formWeights[i] * q; w += MODEL.formWeights[i];
  });
  return { points: MODEL.weights.form * (s / w), starts: starts.length, wins: starts.filter(c => c === '1').length };
}
function ratingPoints(or, top) { return Math.max(0, MODEL.weights.rating - MODEL.ratingPerPoint * (top - or)); }
function freshPoints(days) { for (const [max, p] of MODEL.freshBands) if (days <= max) return p; return 0; }

function humanPoints(stats, id, M) {
  if (!stats || !id || !(stats.r0 > 0)) return null;
  const s = stats.by.get(id) || { w: 0, n: 0 };
  const r = (s.w + MODEL.smoothing * stats.r0) / (s.n + MODEL.smoothing);
  return M * Math.max(0, Math.min(1, r / (2 * stats.r0)));
}

// Returns { eligible, reason, scored:[...] } for one race.
function scoreRace(race, on, human) {
  const region = F.region(race);
  if (!MODEL.regions.includes(region)) return { eligible: false, reason: `region ${region || '?'}` };
  if (F.isHandicap(race)) return { eligible: false, reason: 'handicap' };
  const runners = F.runners(race).filter(x => !F.nonRunner(x));
  if (runners.length < MODEL.field.min || runners.length > MODEL.field.max) return { eligible: false, reason: `field ${runners.length}` };
  const off = Date.parse(F.off(race));
  if (Number.isFinite(off) && off <= Date.now()) return { eligible: false, reason: 'started' };
  // Core data for EVERY runner, or skip the race (never score a partial field).
  for (const x of runners) {
    if (on.rating && F.or(x) === null) return { eligible: false, reason: 'unrated runner' };
    if (on.form && !formPoints(F.form(x))) return { eligible: false, reason: 'runner with <3 starts / no form' };
    if (on.fresh && F.lastRun(x) === null) return { eligible: false, reason: 'missing last-run date' };
    if (on.cd && F.cd(x) === undefined) return { eligible: false, reason: 'missing C/D data' };
  }
  const humanOn = Boolean(human && human.trainer && human.jockey);
  const useOn = { ...on, trainer: humanOn, jockey: humanOn };
  const { name: profile, available } = profileName(useOn);
  const top = on.rating ? Math.max(...runners.map(F.or)) : null;
  const scored = runners.map(x => {
    const comp = {};
    const reasons = [];
    if (useOn.form) { const f = formPoints(F.form(x)); comp.recent_form = round2(f.points); if (f.wins) reasons.push(`${f.wins} win${f.wins > 1 ? 's' : ''} in last ${f.starts} runs (${F.form(x)})`); }
    if (useOn.rating) { const or = F.or(x); comp.official_rating = round2(ratingPoints(or, top)); reasons.push(or === top ? `Top-rated in the field (OR ${or})` : `OR ${or}, ${top - or} below the top-rated`); }
    if (useOn.cd) { const k = F.cd(x); comp.course_distance = MODEL.cdPoints[k] ?? 0; if (k === 'CD') reasons.push('Course-and-distance winner'); else if (k === 'C_AND_D') reasons.push('Course winner and distance winner'); else if (k === 'D') reasons.push('Distance winner'); else if (k === 'C') reasons.push('Course winner'); }
    if (useOn.fresh) { const d = F.lastRun(x); comp.freshness = freshPoints(d); reasons.push(`Last ran ${d} days ago`); }
    if (useOn.trainer) { comp.trainer_form = round2(humanPoints(human.trainer, F.trainerId(x), MODEL.weights.trainer)); comp.jockey_form = round2(humanPoints(human.jockey, F.jockeyId(x), MODEL.weights.jockey)); }
    const earned = Object.values(comp).reduce((a, b) => a + b, 0);
    return { horse_id: F.horseId(x), horse: F.horse(x), number: F.number(x), or: F.or(x), components: comp, earned, score: round2((100 * earned) / available), reasons };
  }).sort((a, b) => b.score - a.score || (b.components.recent_form || 0) - (a.components.recent_form || 0));
  return { eligible: true, profile, available, top, scored };
}

function selectPicks(scoredRaces) {
  const cands = [];
  for (const sr of scoredRaces) {
    if (!sr.eligible || sr.scored.length < 2) continue;
    const [a, b] = sr.scored;
    const gap = round2(a.score - b.score);
    if (a.score >= MODEL.minScore && gap >= MODEL.minGap) cands.push({ race: sr.race, profile: sr.profile, available: sr.available, top: sr.top, pick: a, runnerUp: b, gap });
  }
  cands.sort((x, y) => y.pick.score - x.pick.score || y.gap - x.gap || (y.pick.components.recent_form || 0) - (x.pick.components.recent_form || 0));
  return cands.slice(0, MODEL.maxPerDay).map((c, i) => ({ ...c, nap: i === 0 }));
}

// ---------------------------------------------------------------- trainer/jockey stats from stored results
async function humanStats(asOf = new Date()) {
  if (!DB) return null;
  const end14 = new Date(asOf.getTime() - 14 * 86400000).toISOString().slice(0, 10);
  const { data: days } = await DB.from('horse_runner_results').select('race_date').order('race_date', { ascending: true }).limit(1);
  if (!days || !days.length) return null;
  const firstDay = Date.parse(days[0].race_date);
  if ((asOf.getTime() - firstDay) / 86400000 < MODEL.humanFormMinDays + 1) return null;
  const { data: rows } = await DB.from('horse_runner_results').select('race_date, trainer_id, jockey_id, pos_num');
  if (!rows || !rows.length) return null;
  const today = asOf.toISOString().slice(0, 10);
  const earlier = rows.filter(r => r.race_date < end14);
  const window = rows.filter(r => r.race_date >= end14 && r.race_date < today);
  if (!earlier.length) return null;
  const r0 = earlier.filter(r => r.pos_num === 1).length / earlier.length; // baseline from earlier data only
  const build = key => { const by = new Map(); for (const r of window) { const id = r[key]; if (!id) continue; const s = by.get(id) || { w: 0, n: 0 }; s.n++; if (r.pos_num === 1) s.w++; by.set(id, s); } return { r0, by }; };
  return { trainer: build('trainer_id'), jockey: build('jockey_id') };
}

// ---------------------------------------------------------------- DB helpers
async function kvSet(key, value) { if (DB) await DB.from('horse_kv').upsert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, { onConflict: 'key' }); }
async function kvGet(key) { if (!DB) return null; const { data } = await DB.from('horse_kv').select('value').eq('key', key).maybeSingle(); try { return data ? JSON.parse(data.value) : null; } catch { return null; } }
const ukDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
const ukHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(d));

// ---------------------------------------------------------------- Discord
async function post(text) {
  if (!CFG.posts) { log(`(paper phase — not posted)\n${text}`); return false; }
  if (!CFG.webhook) { log('DISCORD_WEBHOOK_HORSES not set — not posted'); return false; }
  const safe = String(text).replace(/([\\*_~`|])/g, '\\$1');
  for (let i = 0; i < 3; i++) {
    const res = await fetch(CFG.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: safe.slice(0, 1990), allowed_mentions: { parse: [] }, flags: 4 }), signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (res && res.ok) return true;
    if (res && res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
    log(`Discord post failed (${res ? res.status : 'network'})`);
    return false;
  }
  return false;
}

function fmtOff(race) {
  const t = Date.parse(F.off(race));
  return Number.isFinite(t) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(t) : (race.off_time || '');
}
function picksMessage(day, picks, stats) {
  if (!picks.length) return [`🏇 HORSE PICKS — ${day}`, '', 'No selections today: no race met the model\'s thresholds.', `(${stats.eligible} of ${stats.races} races were eligible to score.)`].join('\n');
  const lines = [`🏇 HORSE PICKS — ${day}`, ''];
  for (const p of picks) {
    lines.push(`${p.nap ? '⭐ NAP — ' : ''}${fmtOff(p.race)} ${F.course(p.race)} — ${p.pick.horse}${p.pick.number ? ` (${p.pick.number})` : ''}`);
    lines.push(`${F.name(p.race)}`);
    lines.push(`Score ${p.pick.score.toFixed(1)}/100, ${p.gap.toFixed(1)} points clear of ${p.runnerUp.horse}`);
    for (const r of p.pick.reasons.slice(0, 3)) lines.push(`· ${r}`);
    lines.push('');
  }
  lines.push(`Model ${picks[0].profile} · level 1-unit win stakes, tracked and settled from results.`, 'Scores rank horses; they are not win chances. Educational only — bet responsibly.');
  return lines.join('\n');
}

// ---------------------------------------------------------------- daily jobs
async function runAudit(cards, results) {
  const audit = { at: new Date().toISOString(), racecards: { path: cards.path, ...auditCards(cards.races) }, results: results ? { path: results.path, ...auditResults(results.races) } : null };
  const on = profileFrom(audit.racecards);
  audit.profile = profileName(on).name;
  audit.componentsOn = on;
  STATE.audit = audit;
  await kvSet('field_audit', audit);
  await kvSet('model_config', MODEL);
  if (cards.races[0]) await kvSet('sample_racecard', cards.races[0]);
  if (results && results.races[0]) await kvSet('sample_result', results.races[0]);
  log(`FIELD AUDIT ${JSON.stringify(audit)}`);
  return audit;
}

async function storeCards(day, races) {
  if (!DB) return;
  const rows = races.map(r => ({ race_id: String(F.raceId(r)), race_date: day, course: F.course(r), region: F.region(r), off_dt: F.off(r) || null, race_name: F.name(r), is_handicap: F.isHandicap(r), field_size: F.runners(r).length, data: JSON.stringify(r), fetched_at: new Date().toISOString() }));
  for (let i = 0; i < rows.length; i += 50) await DB.from('horse_cards').upsert(rows.slice(i, i + 50), { onConflict: 'race_id' });
}

async function makePicks(day) {
  let cards = await fetchRacecards('today');
  if (!cards.races.length) { log(`no racecards (${cards.status})`); return null; }
  const audit = STATE.audit || await runAudit(cards, null);
  const on = audit.componentsOn || profileFrom(audit.racecards);
  if (!on.form || !on.rating) log(`core data missing from the subscription (form=${on.form}, rating=${on.rating}) — no picks possible under v1`);
  await storeCards(day, cards.races);
  const human = await humanStats();
  const score = races => races.map(race => ({ race, ...scoreRace(race, on, human) }));
  let scored = score(cards.races);
  let picks = (on.form && on.rating) ? selectPicks(scored) : [];
  // Re-check non-runners immediately before publication; re-score races whose field changed.
  const fresh = await fetchRacecards('today');
  if (fresh.races.length && picks.length) {
    const byId = new Map(fresh.races.map(r => [String(F.raceId(r)), r]));
    const changed = picks.some(p => { const r = byId.get(String(F.raceId(p.race))); return !r || F.runners(r).filter(x => !F.nonRunner(x)).length !== F.runners(p.race).filter(x => !F.nonRunner(x)).length; });
    if (changed) { scored = score(fresh.races); picks = selectPicks(scored); log('field changed before publication — re-scored'); }
  }
  const skipped = {};
  for (const s of scored) if (!s.eligible) skipped[s.reason] = (skipped[s.reason] || 0) + 1;
  const stats = { races: scored.length, eligible: scored.filter(s => s.eligible).length, skipped };
  log(`${day}: ${stats.races} races, ${stats.eligible} eligible, ${picks.length} picks · skipped ${JSON.stringify(skipped)}`);
  if (DB) {
    for (const p of picks) {
      // baseline: highest official rating in the same race (ties split the unit)
      const rated = p.race ? F.runners(p.race).filter(x => !F.nonRunner(x) && F.or(x) !== null) : [];
      const topOr = rated.length ? Math.max(...rated.map(F.or)) : null;
      const baseline = topOr === null ? { usable: false } : { usable: true, top_or: topOr, horse_ids: rated.filter(x => F.or(x) === topOr).map(F.horseId) };
      await DB.from('horse_picks').insert({
        race_date: day, race_id: String(F.raceId(p.race)), horse_id: String(p.pick.horse_id), horse: p.pick.horse, course: F.course(p.race), off_dt: F.off(p.race) || null,
        race_name: F.name(p.race), model_version: p.profile, available_weight: p.available, score: p.pick.score, runner_up: p.runnerUp.horse, runner_up_score: p.runnerUp.score,
        score_gap: p.gap, components: JSON.stringify(p.pick.components), reasons: JSON.stringify(p.pick.reasons), nap: p.nap, card_snapshot: JSON.stringify(p.race),
        baseline: JSON.stringify(baseline), status: 'pending', posted: CFG.posts, created_at: new Date().toISOString(),
      });
    }
    await kvSet(`day_${day}`, { stats, picks: picks.length, profile: picks[0]?.profile || audit.profile, posts: CFG.posts });
  }
  await post(picksMessage(day, picks, stats));
  return { picks, stats };
}

function posNum(p) { const n = parseInt(String(p ?? ''), 10); return Number.isFinite(n) ? n : null; }

async function collectResults(day) {
  const res = await fetchResults();
  if (!res.races.length) { log(`no results (${res.status})`); return 0; }
  if (!STATE.audit || !STATE.audit.results) { const a = STATE.audit || {}; a.results = { path: res.path, ...auditResults(res.races) }; STATE.audit = a; await kvSet('field_audit', a); if (res.races[0]) await kvSet('sample_result', res.races[0]); log(`RESULTS AUDIT ${JSON.stringify(a.results)}`); }
  if (!DB) return res.races.length;
  for (const race of res.races) {
    const raceId = String(F.raceId(race));
    const runners = F.runners(race);
    await DB.from('horse_results').upsert({ race_id: raceId, race_date: race.date || day, field_size: runners.length, data: JSON.stringify(race), fetched_at: new Date().toISOString() }, { onConflict: 'race_id' });
    for (const x of runners) {
      await DB.from('horse_runner_results').upsert({ id: `${raceId}:${F.horseId(x)}`, race_id: raceId, race_date: race.date || day, horse_id: String(F.horseId(x)), trainer_id: x.trainer_id ?? null, jockey_id: x.jockey_id ?? null, position: String(F.position(x) ?? ''), pos_num: posNum(F.position(x)), field_size: runners.length, sp: F.sp(x), sp_dec: F.spDec(x) }, { onConflict: 'id' });
    }
  }
  return res.races.length;
}

function spToDecimal(sp) {
  if (sp == null) return null;
  const s = String(sp).trim().toUpperCase().replace(/[^0-9/.EVNS]/g, '');
  if (/^EVS?$|^EVENS$/.test(s)) return 2;
  const m = s.match(/^(\d+)\/(\d+)/);
  if (m) return 1 + Number(m[1]) / Number(m[2]);
  const n = Number(s);
  return Number.isFinite(n) && n > 1 ? n : null;
}

async function settle(day) {
  if (!DB) return;
  const { data: picks } = await DB.from('horse_picks').select('*').eq('race_date', day).eq('status', 'pending');
  for (const p of picks || []) {
    const { data: rows } = await DB.from('horse_runner_results').select('*').eq('race_id', p.race_id);
    if (!rows || !rows.length) continue; // stays pending; marked unsettled after the late run
    const me = rows.find(r => r.horse_id === p.horse_id);
    let status, profit = null, spDec = null;
    if (!me) status = 'void';
    else {
      status = me.pos_num === 1 ? 'won' : 'lost';
      spDec = me.sp_dec || spToDecimal(me.sp);
      if (spDec) profit = round2(status === 'won' ? spDec - 1 : -1);
    }
    let base = null;
    try {
      const b = JSON.parse(p.baseline || '{}');
      if (b.usable) {
        const share = 1 / b.horse_ids.length;
        let pr = 0, ok = true;
        for (const id of b.horse_ids) { const r = rows.find(x => x.horse_id === String(id)); if (!r) { continue; } const d = r.sp_dec || spToDecimal(r.sp); if (!d) { ok = false; break; } pr += share * (r.pos_num === 1 ? d - 1 : -1); }
        base = { won: b.horse_ids.some(id => rows.find(x => x.horse_id === String(id) && x.pos_num === 1)), profit: ok ? round2(pr) : null };
      }
    } catch { /* keep null */ }
    await DB.from('horse_picks').update({ status, position: me ? me.position : 'NR', sp: me ? me.sp : null, sp_dec: spDec, profit, baseline_result: JSON.stringify(base), settled_at: new Date().toISOString() }).eq('id', p.id);
  }
  if (ukHour() >= 23) await DB.from('horse_picks').update({ status: 'unsettled', settled_at: new Date().toISOString() }).eq('race_date', day).eq('status', 'pending');
}

async function weeklyReport() {
  if (!DB) return null;
  const { data: all } = await DB.from('horse_picks').select('status, profit, nap, position, model_version, baseline_result, race_date').order('race_date', { ascending: true });
  const done = (all || []).filter(p => p.status === 'won' || p.status === 'lost');
  const lines = ['🏇 HORSE PICKS — WEEKLY REPORT', ''];
  if (!done.length) { lines.push('No settled picks yet.'); return lines.join('\n'); }
  const summarise = (rows, label) => {
    const wins = rows.filter(p => p.status === 'won').length;
    const priced = rows.filter(p => p.profit !== null && p.profit !== undefined);
    const pl = priced.reduce((s, p) => s + Number(p.profit), 0);
    lines.push(`${label}: ${rows.length} settled · ${wins} won (${Math.round((wins / rows.length) * 100)}%)${priced.length ? ` · ${pl >= 0 ? '+' : ''}${round2(pl)} units at SP (${priced.length} priced)` : ' · no SP available'}`);
  };
  summarise(done, 'All picks');
  const naps = done.filter(p => p.nap);
  if (naps.length) summarise(naps, 'NAPs');
  const base = done.map(p => { try { return JSON.parse(p.baseline_result || 'null'); } catch { return null; } }).filter(Boolean);
  if (base.length) {
    const bw = base.filter(b => b.won).length, bp = base.filter(b => b.profit !== null);
    lines.push(`Top-rated baseline (same races): ${bw}/${base.length} won${bp.length ? ` · ${round2(bp.reduce((s, b) => s + b.profit, 0))} units` : ''}`);
  }
  const voids = (all || []).filter(p => p.status === 'void').length, uns = (all || []).filter(p => p.status === 'unsettled').length;
  if (voids || uns) lines.push(`Void (non-runners): ${voids} · unsettled: ${uns}`);
  if (done.length < 200) lines.push('', `Initial review at 200 settled picks (${done.length} so far). Not evidence of profit yet.`);
  return lines.join('\n');
}

async function tick() {
  if (!CFG.user || !CFG.pass) return;
  const day = ukDate(), h = ukHour();
  try {
    if (!STATE.audit) {
      const saved = await kvGet('field_audit');
      if (saved && saved.at && saved.at.slice(0, 10) === new Date().toISOString().slice(0, 10)) STATE.audit = saved;
      else await runAudit(await fetchRacecards('today'), await fetchResults());
    }
    const done = await kvGet(`day_${day}`);
    if (h >= CFG.pickHourUK && h < 20 && !done && STATE.lastDayRun !== day) {
      const ok = await makePicks(day);
      if (ok) STATE.lastDayRun = day; // a failed fetch retries on the next tick instead of giving up for the day
    }
    for (const sh of CFG.settleHoursUK) {
      const key = `${day}:${sh}`;
      if (h >= sh && !STATE.settledAt.has(key)) { STATE.settledAt.add(key); await collectResults(day); await settle(day); }
    }
    if (new Date().getDay() === 1 && h === 9) {
      const key = `report_${day}`;
      if (!(await kvGet(key))) { await kvSet(key, true); const r = await weeklyReport(); if (r) await post(r); }
    }
  } catch (e) { log(`tick error: ${e.stack || e.message}`); }
}

function start(opts = {}) {
  DB = opts.db || null;
  if (!CFG.user || !CFG.pass) { log('RACING_API_USERNAME / RACING_API_PASSWORD not set — horse picks off'); return null; }
  log(`horse picks on · ${CFG.posts ? 'POSTING to Discord' : 'PAPER PHASE (audit + tracking, no posts)'} · picks after ${CFG.pickHourUK}:00 UK · model ${MODEL.version} (min ${MODEL.minScore}, lead ${MODEL.minGap}, max ${MODEL.maxPerDay}/day)`);
  setTimeout(tick, opts.startDelayMs ?? 120_000);
  STATE.timer = setInterval(tick, 10 * 60_000);
  return { tick, STATE };
}

module.exports = { start, tick, MODEL, scoreRace, selectPicks, formPoints, ratingPoints, freshPoints, auditCards, auditResults, profileFrom, profileName, spToDecimal, picksMessage, makePicks, settle, collectResults, weeklyReport, _setDb: d => { DB = d; }, _cfg: CFG, STATE };
