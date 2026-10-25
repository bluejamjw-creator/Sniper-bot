'use strict';
/**
 * football_picks.js — HUNTER FOOTY PICKS (v1, paper phase)
 *
 * Fourth module in the Hunter process. Value singles on the full-time 1X2
 * market (90 minutes) for:
 *   DOMESTIC  Premier League, Championship, La Liga, Serie A, Bundesliga, Ligue 1
 *   UEFA      Champions League, Europa League, Conference League
 *   INTL      World Cup + Euro qualifiers, Nations League, World Cup, Euros
 *   (friendlies: never picked)
 *
 * Funnel: competition tested → reliable data → model probability → current,
 * timestamped bookmaker price → EV ≥ +5% → max 1 per match, 3 per day.
 *   EV = p × d − 1 (at the actual offered price).  Minimum price d_min = 1.05 / p.
 *   Fragile = EV turns negative if p is 3 points lower (flagged, ranked lower).
 *
 * Models (v1, frozen):
 *   DOMESTIC: Dixon–Coles style Poisson (attack/defence per team, home
 *     advantage per league, time decay ξ = 0.0019/day, ρ = −0.08), refitted
 *     from football-data.co.uk results. A league is ENABLED for posting only
 *     if its walk-forward backtest (2024/25, 2025/26, 2026/27 to date) at
 *     Bet365's pre-match price shows ≥ 100 bets, ROI > 0 and positive average
 *     closing-line value. Otherwise picks are recorded on paper only.
 *   UEFA: ClubElo ratings → Poisson score model (expected score matched).
 *   INTL: our own World-Football-Elo-style ratings from all international
 *     results since 1990 (martj42 dataset) → same Poisson mapping.
 *   UEFA and INTL have no free historical odds, so they stay paper-only and
 *   are judged on their own forward record.
 *
 * Data: The Odds API (fixtures + UK prices + final scores; budgeted against
 * the free monthly allowance), API-Football (coverage audit + fallback),
 * football-data.co.uk, ClubElo, martj42/international_results.
 *
 * FOOTY_POSTS=on enables Discord posts (DISCORD_WEBHOOK_FOOTY) for groups
 * that have passed their test. Default: paper only. FOOTY_PICKS=off disables.
 */

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

const MODEL = Object.freeze({
  version: 'v1',
  market: 'h2h (90-minute 1X2)',
  minEV: 0.05,
  fragileShift: 0.03,
  maxPerDay: 3,
  xi: 0.0019,
  rho: -0.08,
  shrinkMatches: 4,
  minTeamMatches: 6,
  trainDays: 900,
  maxGoals: 10,
  eloGoals: { club: 2.7, intl: 2.5 },
  eloHome: { club: 65, intl: 100 },
  backtestSeasons: ['2425', '2526', '2627'],
  historySeasons: ['2223', '2324', '2425', '2526', '2627'],
  pass: { minBets: 100, minROI: 0, minCLV: 0 },
  decisionWindowH: 24,
});

const COMPS = [
  // group, Odds API key, label, football-data code, API-Football league id
  { group: 'DOMESTIC', key: 'soccer_epl', label: 'Premier League', fd: 'E0', af: 39 },
  { group: 'DOMESTIC', key: 'soccer_efl_champ', label: 'Championship', fd: 'E1', af: 40 },
  { group: 'DOMESTIC', key: 'soccer_spain_la_liga', label: 'La Liga', fd: 'SP1', af: 140 },
  { group: 'DOMESTIC', key: 'soccer_italy_serie_a', label: 'Serie A', fd: 'I1', af: 135 },
  { group: 'DOMESTIC', key: 'soccer_germany_bundesliga', label: 'Bundesliga', fd: 'D1', af: 78 },
  { group: 'DOMESTIC', key: 'soccer_france_ligue_one', label: 'Ligue 1', fd: 'F1', af: 61 },
  { group: 'UEFA', key: 'soccer_uefa_champs_league', label: 'Champions League', af: 2 },
  { group: 'UEFA', key: 'soccer_uefa_europa_league', label: 'Europa League', af: 3 },
  { group: 'UEFA', key: 'soccer_uefa_europa_conference_league', label: 'Conference League', af: 848 },
  { group: 'INTL', key: 'soccer_fifa_world_cup_qualifiers_europe', label: 'World Cup qualifiers (Europe)', af: 32 },
  { group: 'INTL', key: 'soccer_uefa_euro_qualification', label: 'Euro qualifiers', af: 960 },
  { group: 'INTL', key: 'soccer_uefa_nations_league', label: 'Nations League', af: 5 },
  { group: 'INTL', key: 'soccer_fifa_world_cup', label: 'World Cup', af: 1 },
  { group: 'INTL', key: 'soccer_uefa_european_championship', label: 'European Championship', af: 4 },
  { group: 'FRIENDLY', key: 'soccer_international_friendlies', label: 'International friendlies', af: 10 },
];

const CFG = {
  oddsKey: process.env.ODDS_API_KEY,
  afKey: process.env.API_FOOTBALL_KEY,
  webhook: process.env.DISCORD_WEBHOOK_FOOTY,
  posts: /^(on|true|live)$/i.test(env('FOOTY_POSTS', 'off')),
  pickHourUK: Number(env('FOOTY_PICK_HOUR_UK', 11)),
  oddsReserve: Number(env('FOOTY_ODDS_RESERVE', 40)),
};

let DB = null;
const STATE = { oddsRemaining: null, oddsUsed: null, audit: null, backtest: null, intlElo: null, clubElo: null, domestic: new Map(), lastPickDay: '', ticking: false };
const log = m => console.log(`[FOOTY] ${m}`);
const round = (v, d = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const DAY = 86400000;

// ---------------------------------------------------------------- HTTP
async function getJson(url, headers = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    const rem = res.headers.get('x-requests-remaining');
    if (rem !== null && /the-odds-api/.test(url)) { STATE.oddsRemaining = Number(rem); STATE.oddsUsed = Number(res.headers.get('x-requests-used')); }
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (e) { return { status: 0, body: null, error: e.message }; }
}
async function getText(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}
const ODDS = 'https://api.the-odds-api.com/v4';
const oddsUrl = (path, q = {}) => `${ODDS}${path}?${new URLSearchParams({ apiKey: CFG.oddsKey, ...q })}`;

// ---------------------------------------------------------------- CSV
function parseCsv(text) {
  if (!text) return [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const head = splitCsvLine(lines[0]);
  return lines.slice(1).map(l => { const c = splitCsvLine(l); const o = {}; head.forEach((h, i) => { o[h] = c[i]; }); return o; });
}
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function fdDate(s) {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return Date.UTC(y, Number(m[2]) - 1, Number(m[1]));
}
const n = v => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };

// ---------------------------------------------------------------- team names
const ALIASES = {
  'man united': 'manchester united', 'man utd': 'manchester united', 'man city': 'manchester city', 'nottm forest': 'nottingham forest',
  forest: 'nottingham forest', wolves: 'wolverhampton wanderers', spurs: 'tottenham hotspur', 'sheffield weds': 'sheffield wednesday',
  qpr: 'queens park rangers', 'ath madrid': 'atletico madrid', atletico: 'atletico madrid', espanol: 'espanyol', 'mgladbach': 'borussia monchengladbach',
  gladbach: 'borussia monchengladbach', 'paris sg': 'paris saint germain', psg: 'paris saint germain', 'st etienne': 'saint etienne',
  'crvena zvezda': 'red star belgrade', olympiakos: 'olympiacos', 'slavia praha': 'slavia prague', 'sparta praha': 'sparta prague',
  kobenhavn: 'copenhagen', 'bodoe glimt': 'bodo glimt', 'sporting': 'sporting lisbon', 'inter': 'inter milan', 'milan': 'ac milan',
  'leverkusen': 'bayer leverkusen', 'bayern': 'bayern munich', 'dortmund': 'borussia dortmund', 'salzburg': 'red bull salzburg',
  'usa': 'united states', 'korea republic': 'south korea', 'czechia': 'czech republic', 'turkiye': 'turkey', 'ivory coast': "cote d'ivoire",
};
function norm(name) {
  let s = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[.'’`]/g, '').replace(/[/&-]/g, ' ').replace(/\band\b/g, ' ').replace(/[^a-z0-9 ]/g, ' ');
  s = s.split(/\s+/).filter(t => t && !['fc', 'afc', 'cf', 'sc', 'ac', 'as', 'ssc', 'rc', 'cd', 'ud', 'sv', 'vfl', 'vfb', 'tsg', 'fsv', 'bsc', 'osc', 'ogc', 'stade', 'de', 'calcio', 'club', '1', '04', '05', '1899', '1846', '1909', '1910', '1913'].includes(t)).join(' ');
  return ALIASES[s] ? norm2(ALIASES[s]) : s;
}
function norm2(s) { return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
// Match an Odds API team to a name in our ratings: exact normalised, then unique token-prefix containment.
function matchTeam(name, candidates) {
  const target = norm(name);
  const normed = candidates.map(c => ({ c, k: norm(c) }));
  const exact = normed.filter(x => x.k === target);
  if (exact.length === 1) return exact[0].c;
  const tt = target.split(' ');
  const contains = (shortT, longT) => shortT.every(s => longT.some(l => l.startsWith(s)));
  const hits = normed.filter(x => { const ct = x.k.split(' '); return ct.length <= tt.length ? contains(ct, tt) : contains(tt, ct); });
  return hits.length === 1 ? hits[0].c : null;
}

// ---------------------------------------------------------------- Poisson model (domestic)
function fitPoisson(matches, asOf) {
  // matches: [{t, home, away, hg, ag}] strictly before asOf
  const teams = new Map();
  const data = [];
  for (const m of matches) {
    if (m.t >= asOf || asOf - m.t > MODEL.trainDays * DAY) continue;
    const w = Math.exp(-MODEL.xi * ((asOf - m.t) / DAY));
    data.push({ ...m, w });
    for (const tm of [m.home, m.away]) { const s = teams.get(tm) || { n: 0, recent: 0 }; s.n++; if (asOf - m.t < 365 * DAY) s.recent++; teams.set(tm, s); }
  }
  if (data.length < 50) return null;
  const att = new Map(), def = new Map();
  for (const t of teams.keys()) { att.set(t, 1); def.set(t, 1); }
  let H = 1.3;
  const k = MODEL.shrinkMatches;
  for (let it = 0; it < 40; it++) {
    const num = new Map(), den = new Map();
    for (const m of data) {
      const eh = H * def.get(m.away), ea = def.get(m.home);
      num.set(m.home, (num.get(m.home) || 0) + m.w * m.hg); den.set(m.home, (den.get(m.home) || 0) + m.w * eh);
      num.set(m.away, (num.get(m.away) || 0) + m.w * m.ag); den.set(m.away, (den.get(m.away) || 0) + m.w * ea);
    }
    for (const t of teams.keys()) att.set(t, (num.get(t) + k) / (den.get(t) + k));
    const meanA = [...att.values()].reduce((a, b) => a + b, 0) / att.size;
    for (const t of teams.keys()) att.set(t, att.get(t) / meanA);
    const num2 = new Map(), den2 = new Map();
    for (const m of data) {
      num2.set(m.away, (num2.get(m.away) || 0) + m.w * m.hg); den2.set(m.away, (den2.get(m.away) || 0) + m.w * H * att.get(m.home));
      num2.set(m.home, (num2.get(m.home) || 0) + m.w * m.ag); den2.set(m.home, (den2.get(m.home) || 0) + m.w * att.get(m.away));
    }
    for (const t of teams.keys()) def.set(t, (num2.get(t) + k) / (den2.get(t) + k));
    let hn = 0, hd = 0;
    for (const m of data) { hn += m.w * m.hg; hd += m.w * att.get(m.home) * def.get(m.away); }
    H = hn / hd;
  }
  const avgAway = data.reduce((s, m) => s + m.w * m.ag, 0) / data.reduce((s, m) => s + m.w * att.get(m.away) * def.get(m.home), 0);
  return { att, def, H, A: avgAway, teams, asOf };
}

function scoreMatrixProbs(lh, la, rho = MODEL.rho) {
  const pois = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
  let ph = 0, pd = 0, pa = 0;
  for (let i = 0; i <= MODEL.maxGoals; i++) for (let j = 0; j <= MODEL.maxGoals; j++) {
    let p = pois(lh, i) * pois(la, j);
    if (i === 0 && j === 0) p *= 1 - lh * la * rho;
    else if (i === 0 && j === 1) p *= 1 + lh * rho;
    else if (i === 1 && j === 0) p *= 1 + la * rho;
    else if (i === 1 && j === 1) p *= 1 - rho;
    if (i > j) ph += p; else if (i === j) pd += p; else pa += p;
  }
  const s = ph + pd + pa;
  return { home: ph / s, draw: pd / s, away: pa / s };
}

function predictDomestic(fit, home, away) {
  if (!fit) return { ok: false, reason: 'no fit' };
  const sh = fit.teams.get(home), sa = fit.teams.get(away);
  if (!sh || !sa) return { ok: false, reason: 'team not in history' };
  if (sh.recent < MODEL.minTeamMatches || sa.recent < MODEL.minTeamMatches) return { ok: false, reason: 'too few recent matches' };
  const lh = fit.H * fit.att.get(home) * fit.def.get(away);
  const la = fit.A * fit.att.get(away) * fit.def.get(home);
  return { ok: true, lh, la, ...scoreMatrixProbs(lh, la) };
}

// ---------------------------------------------------------------- Elo -> probabilities
function eloProbs(dr, total) {
  const We = 1 / (1 + 10 ** (-dr / 400));
  let lo = -total + 0.05, hi = total - 0.05, p = null;
  for (let i = 0; i < 50; i++) {
    const s = (lo + hi) / 2;
    p = scoreMatrixProbs((total + s) / 2, (total - s) / 2);
    if (p.home + 0.5 * p.draw < We) lo = s; else hi = s;
  }
  return p;
}

// International Elo (World Football Elo method).
function intlK(t) {
  if (/fifa world cup$/i.test(t)) return 60;
  if (/qualification/i.test(t)) return 40;
  if (/uefa euro$|copa america|african cup of nations$|afc asian cup$|confederations cup|gold cup$/i.test(t)) return 50;
  if (/friendly/i.test(t)) return 20;
  return 30;
}
function buildIntlElo(rows) {
  const elo = new Map();
  const get = t => elo.get(t) ?? 1500;
  const games = new Map();
  for (const r of rows) {
    const hs = Number(r.home_score), as = Number(r.away_score);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    const h = r.home_team, a = r.away_team, neutral = String(r.neutral).toUpperCase() === 'TRUE';
    const dr = get(h) + (neutral ? 0 : MODEL.eloHome.intl) - get(a);
    const We = 1 / (1 + 10 ** (-dr / 400));
    const W = hs > as ? 1 : hs === as ? 0.5 : 0;
    const gd = Math.abs(hs - as);
    const G = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    const delta = intlK(r.tournament || '') * G * (W - We);
    elo.set(h, get(h) + delta); elo.set(a, get(a) - delta);
    games.set(h, (games.get(h) || 0) + 1); games.set(a, (games.get(a) || 0) + 1);
  }
  return { elo, games };
}

// ---------------------------------------------------------------- odds helpers
function bestPrices(event) {
  const out = { home: null, draw: null, away: null };
  for (const bk of event.bookmakers || []) {
    const mk = (bk.markets || []).find(m => m.key === 'h2h');
    if (!mk) continue;
    for (const o of mk.outcomes || []) {
      const side = o.name === event.home_team ? 'home' : o.name === event.away_team ? 'away' : /draw/i.test(o.name) ? 'draw' : null;
      if (!side || !(o.price > 1)) continue;
      if (!out[side] || o.price > out[side].price) out[side] = { price: o.price, book: bk.title || bk.key, at: mk.last_update || bk.last_update };
    }
  }
  return out;
}
function marketProbs(prices) {
  if (!prices.home || !prices.draw || !prices.away) return null;
  const inv = { home: 1 / prices.home.price, draw: 1 / prices.draw.price, away: 1 / prices.away.price };
  const s = inv.home + inv.draw + inv.away;
  return { home: inv.home / s, draw: inv.draw / s, away: inv.away / s, overround: s };
}

// Evaluate a match: best outcome by EV; qualification + fragility.
function evaluate(probs, prices) {
  const opts = ['home', 'draw', 'away'].filter(s => prices[s]).map(s => {
    const p = probs[s], d = prices[s].price;
    const ev = p * d - 1, evLow = (p - MODEL.fragileShift) * d - 1;
    return { side: s, p, d, ev, evLow, book: prices[s].book, at: prices[s].at, minPrice: (1 + MODEL.minEV) / p };
  }).sort((a, b) => b.ev - a.ev);
  const best = opts[0] || null;
  return { best, qualifies: Boolean(best && best.ev >= MODEL.minEV), fragile: Boolean(best && best.evLow < 0) };
}

function rankAndCap(cands) {
  return [...cands].sort((a, b) => (a.fragile - b.fragile) || b.best.ev - a.best.ev).slice(0, MODEL.maxPerDay);
}

// ---------------------------------------------------------------- historical domestic data + backtest
async function loadDomesticHistory() {
  const out = new Map();
  for (const c of COMPS.filter(x => x.fd)) {
    const rows = [];
    for (const s of MODEL.historySeasons) {
      const csv = await getText(`https://www.football-data.co.uk/mmz4281/${s}/${c.fd}.csv`);
      for (const r of parseCsv(csv)) {
        const t = fdDate(r.Date);
        const hg = Number(r.FTHG), ag = Number(r.FTAG);
        if (!t || !r.HomeTeam || !Number.isFinite(hg) || r.FTHG === '' || r.FTHG === undefined) continue;
        rows.push({ season: s, t, home: r.HomeTeam, away: r.AwayTeam, hg, ag,
          b365: { home: n(r.B365H), draw: n(r.B365D), away: n(r.B365A) },
          close: { home: n(r.B365CH) || n(r.AvgCH) || n(r.PSCH), draw: n(r.B365CD) || n(r.AvgCD) || n(r.PSCD), away: n(r.B365CA) || n(r.AvgCA) || n(r.PSCA) } });
      }
    }
    rows.sort((a, b) => a.t - b.t);
    out.set(c.key, rows);
    log(`history ${c.label}: ${rows.length} matches`);
  }
  return out;
}

async function backtestLeague(rows) {
  const test = rows.filter(r => MODEL.backtestSeasons.includes(r.season));
  const byWeek = new Map();
  for (const r of test) { const wk = Math.floor((r.t - 4 * DAY) / (7 * DAY)); if (!byWeek.has(wk)) byWeek.set(wk, []); byWeek.get(wk).push(r); }
  const bets = [];
  let ll = 0, llMkt = 0, nPred = 0;
  for (const [wk, games] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
    const asOf = wk * 7 * DAY + 4 * DAY;
    await new Promise(r => setImmediate(r)); // let Hunter's other work run between weekly refits
    const fit = fitPoisson(rows, asOf);
    for (const g of games) {
      const pr = predictDomestic(fit, g.home, g.away);
      if (!pr.ok || !g.b365.home || !g.b365.draw || !g.b365.away) continue;
      const res = g.hg > g.ag ? 'home' : g.hg === g.ag ? 'draw' : 'away';
      const mk = marketProbs({ home: { price: g.b365.home }, draw: { price: g.b365.draw }, away: { price: g.b365.away } });
      ll += -Math.log(Math.max(1e-9, pr[res])); llMkt += -Math.log(Math.max(1e-9, mk[res])); nPred++;
      const ev = evaluate(pr, { home: { price: g.b365.home }, draw: { price: g.b365.draw }, away: { price: g.b365.away } });
      if (!ev.qualifies) continue;
      const s = ev.best.side;
      const clv = g.close[s] ? ev.best.d / g.close[s] - 1 : null;
      bets.push({ t: g.t, side: s, d: ev.best.d, ev: ev.best.ev, fragile: ev.fragile, won: res === s, profit: res === s ? ev.best.d - 1 : -1, clv });
    }
  }
  return { bets, logLoss: nPred ? ll / nPred : null, marketLogLoss: nPred ? llMkt / nPred : null, predicted: nPred };
}

function summariseBets(bets) {
  const nB = bets.length;
  const profit = bets.reduce((s, b) => s + b.profit, 0);
  const clvs = bets.filter(b => b.clv !== null);
  return { bets: nB, wins: bets.filter(b => b.won).length, profit: round(profit, 2), roi: nB ? round(profit / nB, 4) : null, avgCLV: clvs.length ? round(clvs.reduce((s, b) => s + b.clv, 0) / clvs.length, 4) : null, avgOdds: nB ? round(bets.reduce((s, b) => s + b.d, 0) / nB, 2) : null };
}

function applyDailyCap(allBets) {
  const byDay = new Map();
  for (const b of allBets) { const d = Math.floor(b.t / DAY); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(b); }
  const kept = [];
  for (const list of byDay.values()) kept.push(...[...list].sort((a, b) => (a.fragile - b.fragile) || b.ev - a.ev).slice(0, MODEL.maxPerDay));
  return kept;
}

async function runBacktest(history) {
  const leagues = {};
  const all = [];
  for (const c of COMPS.filter(x => x.fd)) {
    const rows = history.get(c.key) || [];
    if (rows.length < 300) { leagues[c.key] = { label: c.label, error: `only ${rows.length} historical matches` }; continue; }
    const r = await backtestLeague(rows);
    r.bets.forEach(b => { b.league = c.key; });
    all.push(...r.bets);
    const sm = summariseBets(r.bets);
    const pass = sm.bets >= MODEL.pass.minBets && sm.roi > MODEL.pass.minROI && sm.avgCLV !== null && sm.avgCLV > MODEL.pass.minCLV;
    leagues[c.key] = { label: c.label, ...sm, logLoss: round(r.logLoss), marketLogLoss: round(r.marketLogLoss), predicted: r.predicted, pass };
  }
  const capped = applyDailyCap(all);
  const result = { at: new Date().toISOString(), model: MODEL.version, seasons: MODEL.backtestSeasons, price: 'Bet365 pre-match (football-data.co.uk)', leagues, portfolioCapped3: summariseBets(capped) };
  log(`BACKTEST ${JSON.stringify(result)}`);
  return result;
}

// ---------------------------------------------------------------- ratings loaders
async function loadClubElo() {
  const day = new Date().toISOString().slice(0, 10);
  const rows = parseCsv(await getText(`http://api.clubelo.com/${day}`));
  const m = new Map();
  for (const r of rows) if (r.Club && Number(r.Elo)) m.set(r.Club, Number(r.Elo));
  log(`ClubElo: ${m.size} clubs`);
  return m.size ? m : null;
}
async function loadIntlElo() {
  const rows = parseCsv(await getText('https://raw.githubusercontent.com/martj42/international_results/master/results.csv'))
    .filter(r => r.date >= '1990-01-01').sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) return null;
  const r = buildIntlElo(rows);
  log(`international Elo: ${r.elo.size} teams from ${rows.length} results`);
  return r;
}

// ---------------------------------------------------------------- audit
async function runAudit() {
  const audit = { at: new Date().toISOString(), odds: {}, apiFootball: {} };
  if (CFG.oddsKey) {
    const r = await getJson(oddsUrl('/sports', { all: 'true' })); // free: no quota cost
    const keys = new Map((Array.isArray(r.body) ? r.body : []).map(s => [s.key, s]));
    for (const c of COMPS) audit.odds[c.key] = keys.has(c.key) ? (keys.get(c.key).active ? 'active' : 'listed, not active now') : 'NOT AVAILABLE';
    audit.oddsStatus = r.status;
    audit.oddsRemaining = STATE.oddsRemaining;
    audit.otherSoccerKeys = [...keys.keys()].filter(k => /^soccer_/.test(k) && !COMPS.some(c => c.key === k)).slice(0, 80);
  }
  if (CFG.afKey) {
    const h = { 'x-apisports-key': CFG.afKey };
    const st = await getJson('https://v3.football.api-sports.io/status', h);
    audit.apiFootball.status = st.body && st.body.response ? { plan: st.body.response.subscription?.plan, requests: st.body.response.requests } : { http: st.status, errors: st.body?.errors };
    const today = new Date().toISOString().slice(0, 10);
    const fx = await getJson(`https://v3.football.api-sports.io/fixtures?date=${today}`, h);
    const errs = fx.body && fx.body.errors && Object.keys(fx.body.errors).length ? fx.body.errors : null;
    const leagues = new Set((fx.body?.response || []).map(f => f.league?.id));
    audit.apiFootball.todayFixtures = { http: fx.status, errors: errs, total: fx.body?.response?.length ?? null, ourLeaguesToday: COMPS.filter(c => leagues.has(c.af)).map(c => c.label) };
  }
  STATE.audit = audit;
  await kvSet('audit', audit);
  await kvSet('model_config', MODEL);
  log(`COVERAGE AUDIT ${JSON.stringify(audit)}`);
  return audit;
}

// ---------------------------------------------------------------- DB helpers
async function kvSet(key, value) { if (DB) await DB.from('football_kv').upsert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }, { onConflict: 'key' }); }
async function kvGet(key) { if (!DB) return null; const { data } = await DB.from('football_kv').select('value').eq('key', key).maybeSingle(); try { return data ? JSON.parse(data.value) : null; } catch { return null; } }
const ukDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
const ukHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(d));
const ukTime = t => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(t);

// ---------------------------------------------------------------- live evaluation
function probabilitiesFor(comp, ev) {
  const home = ev.home_team, away = ev.away_team;
  if (comp.group === 'DOMESTIC') {
    const fit = STATE.domestic.get(comp.key);
    if (!fit) return { ok: false, reason: 'no model for league' };
    const names = [...fit.teams.keys()];
    const h = matchTeam(home, names), a = matchTeam(away, names);
    if (!h || !a) return { ok: false, reason: `team name not matched (${!h ? home : away})` };
    return { ...predictDomestic(fit, h, a), model: 'poisson' };
  }
  if (comp.group === 'UEFA') {
    if (!STATE.clubElo) return { ok: false, reason: 'ClubElo unavailable' };
    const names = [...STATE.clubElo.keys()];
    const h = matchTeam(home, names), a = matchTeam(away, names);
    if (!h || !a) return { ok: false, reason: `team name not matched (${!h ? home : away})` };
    return { ok: true, ...eloProbs(STATE.clubElo.get(h) + MODEL.eloHome.club - STATE.clubElo.get(a), MODEL.eloGoals.club), model: 'clubelo' };
  }
  if (comp.group === 'INTL') {
    if (!STATE.intlElo) return { ok: false, reason: 'international ratings unavailable' };
    const names = [...STATE.intlElo.elo.keys()];
    const h = matchTeam(home, names), a = matchTeam(away, names);
    if (!h || !a) return { ok: false, reason: `team name not matched (${!h ? home : away})` };
    if ((STATE.intlElo.games.get(h) || 0) < 20 || (STATE.intlElo.games.get(a) || 0) < 20) return { ok: false, reason: 'too few internationals on record' };
    // Neutral venue is unknown from the odds feed; qualifiers/Nations League are home games, tournaments mostly neutral.
    const neutral = /world_cup$|european_championship$/.test(comp.key);
    return { ok: true, ...eloProbs(STATE.intlElo.elo.get(h) + (neutral ? 0 : MODEL.eloHome.intl) - STATE.intlElo.elo.get(a), MODEL.eloGoals.intl), model: 'intl-elo', neutral };
  }
  return { ok: false, reason: 'friendly — never picked' };
}

function groupCanPost(comp) {
  if (!CFG.posts) return false;
  if (comp.group !== 'DOMESTIC') return false; // UEFA / INTL / friendlies: paper until their forward record is reviewed
  const bt = STATE.backtest && STATE.backtest.leagues && STATE.backtest.leagues[comp.key];
  return Boolean(bt && bt.pass);
}

async function dailyRun(day) {
  if (!CFG.oddsKey) return;
  const now = Date.now();
  const all = [];
  for (const comp of COMPS) {
    if (STATE.oddsRemaining !== null && STATE.oddsRemaining <= CFG.oddsReserve && comp.group !== 'DOMESTIC') { log(`odds budget low (${STATE.oddsRemaining}) — skipping ${comp.label}`); continue; }
    if (STATE.audit && STATE.audit.odds && STATE.audit.odds[comp.key] === 'NOT AVAILABLE') continue;
    const evs = await getJson(oddsUrl(`/sports/${comp.key}/events`, { dateFormat: 'iso' })); // free
    const upcoming = (Array.isArray(evs.body) ? evs.body : []).filter(e => { const t = Date.parse(e.commence_time); return t > now && t - now <= MODEL.decisionWindowH * 3600000; });
    if (!upcoming.length) continue;
    if (comp.group === 'FRIENDLY') { log(`${comp.label}: ${upcoming.length} games — tracked, never picked`); continue; }
    const odds = await getJson(oddsUrl(`/sports/${comp.key}/odds`, { regions: 'uk', markets: 'h2h', oddsFormat: 'decimal', dateFormat: 'iso' })); // 1 credit
    const fetchedAt = new Date().toISOString();
    for (const ev of Array.isArray(odds.body) ? odds.body : []) {
      const t = Date.parse(ev.commence_time);
      if (!(t > now && t - now <= MODEL.decisionWindowH * 3600000)) continue;
      const prices = bestPrices(ev);
      const probs = probabilitiesFor(comp, ev);
      const row = { comp, ev, t, prices, probs, fetchedAt };
      if (!probs.ok) { row.reason = probs.reason; all.push(row); continue; }
      if (!prices.home || !prices.draw || !prices.away) { row.reason = 'incomplete prices'; all.push(row); continue; }
      Object.assign(row, evaluate(probs, prices));
      if (!row.qualifies) row.reason = `best EV ${round(row.best.ev * 100, 1)}% < ${MODEL.minEV * 100}%`;
      all.push(row);
    }
  }
  const qualifiers = all.filter(r => r.qualifies);
  const selected = rankAndCap(qualifiers);
  const selSet = new Set(selected);
  const posting = selected.filter(r => groupCanPost(r.comp));
  log(`${day}: ${all.length} matches evaluated, ${qualifiers.length} qualified, ${selected.length} selected (${posting.length} postable) · odds credits left ${STATE.oddsRemaining}`);
  if (DB) {
    for (const r of all) {
      await DB.from('football_candidates').upsert({
        id: `${r.ev.id}`, decided_day: day, competition: r.comp.key, grp: r.comp.group, home: r.ev.home_team, away: r.ev.away_team, kickoff: new Date(r.t).toISOString(),
        model: r.probs.model || null, p_home: round(r.probs.home), p_draw: round(r.probs.draw), p_away: round(r.probs.away),
        price_home: r.prices.home?.price ?? null, price_draw: r.prices.draw?.price ?? null, price_away: r.prices.away?.price ?? null,
        best_side: r.best?.side ?? null, best_price: r.best?.d ?? null, best_book: r.best?.book ?? null, ev: round(r.best?.ev), ev_low: round(r.best?.evLow), min_price: round(r.best?.minPrice, 3),
        fragile: r.fragile ?? null, qualifies: Boolean(r.qualifies), selected: selSet.has(r), posted: posting.includes(r), reason: r.reason || null,
        odds_at: r.fetchedAt, status: 'pending', model_version: MODEL.version,
      }, { onConflict: 'id' });
    }
    await kvSet(`day_${day}`, { evaluated: all.length, qualified: qualifiers.length, selected: selected.length, posted: posting.length, oddsRemaining: STATE.oddsRemaining });
  }
  if (CFG.posts) await post(picksMessage(day, posting, all.length));
  else if (selected.length) log(`(paper) ${picksMessage(day, selected, all.length)}`);
}

const sideName = (r, s) => (s === 'home' ? `${r.ev.home_team} to win` : s === 'away' ? `${r.ev.away_team} to win` : 'Draw');
function picksMessage(day, picks, evaluated) {
  if (!picks.length) return [`⚽ FOOTY PICKS — ${day}`, '', 'No selections today: nothing cleared the +5% value line at a current price.', `(${evaluated} matches checked.)`].join('\n');
  const lines = [`⚽ FOOTY PICKS — ${day}`, ''];
  picks.forEach((r, i) => {
    lines.push(`${i === 0 ? '⭐ ' : ''}${r.comp.label} · ${ukTime(r.t)}`);
    lines.push(`${r.ev.home_team} v ${r.ev.away_team}`);
    lines.push(`Selection: ${sideName(r, r.best.side)} (90 minutes)`);
    lines.push(`Model chance ${round(r.best.p * 100, 1)}% · price ${r.best.d} (${r.best.book}) · minimum ${round(r.best.minPrice, 2)}`);
    lines.push(`Estimated value +${round(r.best.ev * 100, 1)}%${r.fragile ? ' · fragile (gone if the model is 3 pts too high)' : ''}`);
    lines.push(`Odds checked ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(Date.parse(r.fetchedAt))}`, '');
  });
  lines.push('Level 1-unit singles, tracked and settled. Don\'t take a price below the minimum. Educational only — bet responsibly.');
  return lines.join('\n');
}

async function post(text) {
  if (!CFG.webhook) { log('DISCORD_WEBHOOK_FOOTY not set'); return false; }
  const safe = String(text).replace(/([\\*_~`|])/g, '\\$1');
  for (let i = 0; i < 3; i++) {
    const res = await fetch(CFG.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: safe.slice(0, 1990), allowed_mentions: { parse: [] }, flags: 4 }), signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (res && res.ok) return true;
    if (res && res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
    return false;
  }
  return false;
}

// Closing price for selected picks (20–45 min before kick-off), one odds call per competition.
async function captureClosing() {
  if (!DB || !CFG.oddsKey || (STATE.oddsRemaining !== null && STATE.oddsRemaining <= CFG.oddsReserve)) return;
  const now = Date.now();
  const { data } = await DB.from('football_candidates').select('id, competition, kickoff, best_side, close_price').eq('selected', true).eq('status', 'pending');
  const due = (data || []).filter(r => r.close_price == null && Date.parse(r.kickoff) - now <= 45 * 60000 && Date.parse(r.kickoff) - now >= 10 * 60000);
  for (const key of [...new Set(due.map(r => r.competition))]) {
    const odds = await getJson(oddsUrl(`/sports/${key}/odds`, { regions: 'uk', markets: 'h2h', oddsFormat: 'decimal', dateFormat: 'iso' }));
    const byId = new Map((Array.isArray(odds.body) ? odds.body : []).map(e => [e.id, e]));
    for (const r of due.filter(x => x.competition === key)) {
      const ev = byId.get(r.id);
      const p = ev ? bestPrices(ev)[r.best_side] : null;
      if (p) await DB.from('football_candidates').update({ close_price: p.price, close_at: new Date().toISOString() }).eq('id', r.id);
    }
  }
}

// Settle every evaluated candidate (picks and rejects) from final scores.
async function settle() {
  if (!DB || !CFG.oddsKey) return;
  const now = Date.now();
  const { data } = await DB.from('football_candidates').select('id, competition, kickoff, best_side, best_price, selected').eq('status', 'pending');
  const due = (data || []).filter(r => now - Date.parse(r.kickoff) > 2.5 * 3600000);
  for (const key of [...new Set(due.map(r => r.competition))]) {
    const sc = await getJson(oddsUrl(`/sports/${key}/scores`, { daysFrom: 3, dateFormat: 'iso' })); // 2 credits
    const byId = new Map((Array.isArray(sc.body) ? sc.body : []).map(e => [e.id, e]));
    for (const r of due.filter(x => x.competition === key)) {
      const e = byId.get(r.id);
      if (!e) { if (now - Date.parse(r.kickoff) > 4 * DAY) await DB.from('football_candidates').update({ status: 'unsettled' }).eq('id', r.id); continue; }
      if (!e.completed) continue;
      const g = Object.fromEntries((e.scores || []).map(s => [s.name, Number(s.score)]));
      const hg = g[e.home_team], ag = g[e.away_team];
      if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
      const res = hg > ag ? 'home' : hg === ag ? 'draw' : 'away';
      const profit = r.best_side && r.best_price ? (res === r.best_side ? round(r.best_price - 1, 3) : -1) : null;
      await DB.from('football_candidates').update({ status: 'settled', result: res, home_goals: hg, away_goals: ag, won: r.best_side ? res === r.best_side : null, profit, settled_at: new Date().toISOString() }).eq('id', r.id);
    }
  }
}

async function weeklyReport() {
  if (!DB) return null;
  const { data } = await DB.from('football_candidates').select('grp, competition, selected, qualifies, status, won, profit, best_price, close_price, best_side, p_home, p_draw, p_away, result');
  const rows = (data || []).filter(r => r.status === 'settled');
  const lines = ['⚽ FOOTY PICKS — WEEKLY REPORT', ''];
  const sum = (list, label) => {
    const bets = list.filter(r => r.profit !== null);
    if (!bets.length) return;
    const pl = bets.reduce((s, r) => s + Number(r.profit), 0);
    const clv = bets.filter(r => r.close_price).map(r => r.best_price / r.close_price - 1);
    lines.push(`${label}: ${bets.length} · ${bets.filter(r => r.won).length} won · ${pl >= 0 ? '+' : ''}${round(pl, 2)} units (ROI ${round((pl / bets.length) * 100, 1)}%)${clv.length ? ` · CLV ${round((clv.reduce((a, b) => a + b, 0) / clv.length) * 100, 1)}%` : ''}`);
  };
  for (const g of ['DOMESTIC', 'UEFA', 'INTL']) {
    sum(rows.filter(r => r.grp === g && r.selected), `${g} picks`);
    sum(rows.filter(r => r.grp === g && r.qualifies), `${g} all +5% candidates`);
  }
  const probs = rows.filter(r => r.result && r.p_home != null);
  if (probs.length >= 30) {
    const bands = [[0, 0.3], [0.3, 0.45], [0.45, 0.6], [0.6, 1.01]];
    lines.push('', 'Calibration (all evaluated outcomes):');
    for (const [lo, hi] of bands) {
      const pts = probs.flatMap(r => ['home', 'draw', 'away'].map(s => ({ p: Number(r[`p_${s}`]), hit: r.result === s }))).filter(x => x.p >= lo && x.p < hi);
      if (pts.length) lines.push(`${Math.round(lo * 100)}–${Math.round(Math.min(hi, 1) * 100)}%: predicted ${round((pts.reduce((s, x) => s + x.p, 0) / pts.length) * 100, 1)}%, happened ${round((pts.filter(x => x.hit).length / pts.length) * 100, 1)}% (${pts.length})`);
    }
  }
  if (STATE.backtest) {
    lines.push('', 'Leagues enabled by backtest: ' + (Object.values(STATE.backtest.leagues).filter(l => l.pass).map(l => l.label).join(', ') || 'none yet'));
  }
  lines.push(`Odds API credits left: ${STATE.oddsRemaining ?? '?'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- scheduler
async function refreshModels(force = false) {
  const today = new Date().toISOString().slice(0, 10);
  if (force || STATE.modelsDay !== today) {
    STATE.modelsDay = today;
    const history = await loadDomesticHistory();
    for (const [key, rows] of history) STATE.domestic.set(key, rows.length ? fitPoisson(rows, Date.now()) : null);
    const last = await kvGet('backtest');
    const stale = !last || Date.now() - Date.parse(last.at) > 7 * DAY;
    if (stale) { STATE.backtest = await runBacktest(history); await kvSet('backtest', STATE.backtest); } else STATE.backtest = last;
    STATE.clubElo = await loadClubElo();
    STATE.intlElo = await loadIntlElo();
  }
}

async function tick() {
  if (STATE.ticking || !CFG.oddsKey) return;
  STATE.ticking = true;
  try {
    const day = ukDate(), h = ukHour();
    if (!STATE.audit || STATE.audit.at.slice(0, 10) !== new Date().toISOString().slice(0, 10)) await runAudit();
    await refreshModels();
    if (h >= CFG.pickHourUK && STATE.lastPickDay !== day && !(await kvGet(`day_${day}`))) { STATE.lastPickDay = day; await dailyRun(day); }
    await captureClosing();
    if ([9, 23].includes(h)) await settle();
    if (new Date().getUTCDay() === 1 && h === 9 && !(await kvGet(`report_${day}`))) {
      await kvSet(`report_${day}`, true);
      const r = await weeklyReport();
      if (r) { if (CFG.posts) await post(r); else log(`(paper) ${r}`); }
    }
  } catch (e) { log(`tick error: ${e.stack || e.message}`); }
  finally { STATE.ticking = false; }
}

function start(opts = {}) {
  DB = opts.db || null;
  if (!CFG.oddsKey) { log('ODDS_API_KEY not set — footy picks off'); return null; }
  log(`footy picks on · ${CFG.posts ? 'POSTING (backtest-passed leagues only)' : 'PAPER PHASE (audit + backtest + tracking, no posts)'} · picks after ${CFG.pickHourUK}:00 UK · 1X2, EV ≥ +${MODEL.minEV * 100}%, max ${MODEL.maxPerDay}/day`);
  setTimeout(tick, opts.startDelayMs ?? 150_000);
  setInterval(tick, 10 * 60_000);
  return { tick, STATE };
}

module.exports = {
  start, tick, MODEL, COMPS, STATE, fitPoisson, predictDomestic, scoreMatrixProbs, eloProbs, buildIntlElo, matchTeam, norm,
  bestPrices, marketProbs, evaluate, rankAndCap, backtestLeague, summariseBets, applyDailyCap, parseCsv, fdDate, picksMessage,
  dailyRun, settle, weeklyReport, runBacktest, _setDb: d => { DB = d; }, _cfg: CFG,
};
