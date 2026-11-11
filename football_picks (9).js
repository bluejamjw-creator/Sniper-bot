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
  version: 'v2.1', // v2.1: + League One/Two, Scotland, Netherlands, Belgium, Portugal, Turkey, Greece; odds only for passed leagues. v2: v2: model blended with the market (weight tuned on 2024/25 only), exchange commission, tested on unseen seasons
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
  tuneSeason: '2425',               // blend weight chosen here only
  backtestSeasons: ['2526', '2627'], // judged here only (never seen by the tuning)
  blendGrid: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
  defaultBlend: 0.2,                 // UEFA / INTL until they have their own record
  commission: { betfair_ex_uk: 0.05, betfair_ex_eu: 0.05, smarkets: 0.02, matchbook: 0.02 },
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
  // V2.1: lower / smaller leagues, where bookmakers price less sharply.
  { group: 'DOMESTIC', key: 'soccer_england_league1', label: 'League One', fd: 'E2', af: 41 },
  { group: 'DOMESTIC', key: 'soccer_england_league2', label: 'League Two', fd: 'E3', af: 42 },
  { group: 'DOMESTIC', key: 'soccer_spl', label: 'Scottish Premiership', fd: 'SC0', af: 179 },
  { group: 'DOMESTIC', key: 'soccer_netherlands_eredivisie', label: 'Eredivisie', fd: 'N1', af: 88 },
  { group: 'DOMESTIC', key: 'soccer_belgium_first_div', label: 'Belgian Pro League', fd: 'B1', af: 144 },
  { group: 'DOMESTIC', key: 'soccer_portugal_primeira_liga', label: 'Primeira Liga', fd: 'P1', af: 94 },
  { group: 'DOMESTIC', key: 'soccer_turkey_super_league', label: 'Super Lig', fd: 'T1', af: 203 },
  { group: 'DOMESTIC', key: 'soccer_greece_super_league', label: 'Greek Super League', fd: 'G1', af: 197 },
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
  nap: env('FOOTY_NAP', 'on') !== 'off',
  dailyNap: env('FOOTY_DAILY_NAP', 'off') === 'on', // 3 Nov: off — only genuine (value) opportunities are posted
  napCalls: Number(env('FOOTY_NAP_CALLS', 12)), // odds credits per day for the NAP search
};

let DB = null;
const STATE = { oddsRemaining: null, oddsUsed: null, audit: null, backtest: null, intlElo: null, clubElo: null, domestic: new Map(), lastPickDay: '', lastNapDay: '', lastSettleHour: '', valueRule: undefined, ticking: false };
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
// Best price per outcome AFTER exchange commission (what you'd actually receive).
function bestPrices(event) {
  const out = { home: null, draw: null, away: null };
  for (const bk of event.bookmakers || []) {
    const mk = (bk.markets || []).find(m => m.key === 'h2h');
    if (!mk) continue;
    const c = MODEL.commission[bk.key] || 0;
    for (const o of mk.outcomes || []) {
      const side = o.name === event.home_team ? 'home' : o.name === event.away_team ? 'away' : /draw/i.test(o.name) ? 'draw' : null;
      if (!side || !(o.price > 1)) continue;
      const net = 1 + (o.price - 1) * (1 - c);
      if (!out[side] || net > out[side].price) out[side] = { price: round(net, 3), quoted: o.price, book: bk.title || bk.key, at: mk.last_update || bk.last_update };
    }
  }
  return out;
}
// Market consensus: each bookmaker's de-margined probabilities, averaged.
function marketConsensus(event) {
  const acc = { home: 0, draw: 0, away: 0 }; let nb = 0;
  for (const bk of event.bookmakers || []) {
    const mk = (bk.markets || []).find(m => m.key === 'h2h');
    if (!mk) continue;
    const pr = {};
    for (const o of mk.outcomes || []) {
      const side = o.name === event.home_team ? 'home' : o.name === event.away_team ? 'away' : /draw/i.test(o.name) ? 'draw' : null;
      if (side && o.price > 1) pr[side] = { price: o.price };
    }
    const m = marketProbs(pr);
    if (!m) continue;
    acc.home += m.home; acc.draw += m.draw; acc.away += m.away; nb++;
  }
  return nb ? { home: acc.home / nb, draw: acc.draw / nb, away: acc.away / nb, books: nb } : null;
}
function blend(model, market, w) {
  return { home: w * model.home + (1 - w) * market.home, draw: w * model.draw + (1 - w) * market.draw, away: w * model.away + (1 - w) * market.away };
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
    return { side: s, p, d, quoted: prices[s].quoted ?? d, ev, evLow, book: prices[s].book, at: prices[s].at, minPrice: (1 + MODEL.minEV) / p };
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
          avg: { home: n(r.AvgH) || n(r.BbAvH), draw: n(r.AvgD) || n(r.BbAvD), away: n(r.AvgA) || n(r.BbAvA) },
          max: { home: n(r.MaxH) || n(r.BbMxH), draw: n(r.MaxD) || n(r.BbMxD), away: n(r.MaxA) || n(r.BbMxA) },
          ou: { avgOver: n(r['Avg>2.5']) || n(r['BbAv>2.5']), avgUnder: n(r['Avg<2.5']) || n(r['BbAv<2.5']), maxOver: n(r['Max>2.5']) || n(r['BbMx>2.5']), maxUnder: n(r['Max<2.5']) || n(r['BbMx<2.5']), b365Over: n(r['B365>2.5']), b365Under: n(r['B365<2.5']) },
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
  const seasons = [MODEL.tuneSeason, ...MODEL.backtestSeasons];
  const target = rows.filter(r => seasons.includes(r.season));
  const byWeek = new Map();
  for (const r of target) { const wk = Math.floor((r.t - 4 * DAY) / (7 * DAY)); if (!byWeek.has(wk)) byWeek.set(wk, []); byWeek.get(wk).push(r); }
  const preds = [];
  for (const [wk, games] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
    const asOf = wk * 7 * DAY + 4 * DAY;
    await new Promise(r => setImmediate(r)); // let Hunter's other work run between weekly refits
    const fit = fitPoisson(rows, asOf);
    for (const g of games) {
      const pr = predictDomestic(fit, g.home, g.away);
      if (!pr.ok || !g.b365.home || !g.b365.draw || !g.b365.away) continue;
      const prices = { home: { price: g.b365.home }, draw: { price: g.b365.draw }, away: { price: g.b365.away } };
      preds.push({ g, season: g.season, model: pr, market: marketProbs(prices), prices, res: g.hg > g.ag ? 'home' : g.hg === g.ag ? 'draw' : 'away' });
    }
  }
  const ll = (list, fn) => list.length ? list.reduce((s, x) => s - Math.log(Math.max(1e-9, fn(x)[x.res])), 0) / list.length : null;
  // 1. Choose the blend weight on the tuning season ONLY (log loss).
  const tune = preds.filter(x => x.season === MODEL.tuneSeason);
  let w = MODEL.defaultBlend, best = Infinity;
  for (const cand of MODEL.blendGrid) { const v = ll(tune, x => blend(x.model, x.market, cand)); if (v !== null && v < best) { best = v; w = cand; } }
  // 2. Judge on the unseen seasons with that fixed weight.
  const test = preds.filter(x => MODEL.backtestSeasons.includes(x.season));
  const bets = [];
  for (const x of test) {
    const ev = evaluate(blend(x.model, x.market, w), x.prices);
    if (!ev.qualifies) continue;
    const s = ev.best.side;
    const clv = x.g.close[s] ? ev.best.d / x.g.close[s] - 1 : null;
    bets.push({ t: x.g.t, side: s, d: ev.best.d, ev: ev.best.ev, fragile: ev.fragile, won: x.res === s, profit: x.res === s ? ev.best.d - 1 : -1, clv });
  }
  return {
    w, bets, predicted: test.length, tunePredicted: tune.length,
    logLoss: ll(test, x => blend(x.model, x.market, w)), modelLogLoss: ll(test, x => x.model), marketLogLoss: ll(test, x => x.market),
  };
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
    leagues[c.key] = { label: c.label, blendWeight: r.w, ...sm, logLoss: round(r.logLoss), modelLogLoss: round(r.modelLogLoss), marketLogLoss: round(r.marketLogLoss), predicted: r.predicted, pass };
  }
  const capped = applyDailyCap(all);
  const ws = Object.values(leagues).map(l => l.blendWeight).filter(Number.isFinite).sort((a, b) => a - b);
  const medianW = ws.length ? ws[Math.floor(ws.length / 2)] : MODEL.defaultBlend;
  const result = { at: new Date().toISOString(), model: MODEL.version, tuneSeason: MODEL.tuneSeason, testSeasons: MODEL.backtestSeasons, price: 'Bet365 pre-match (football-data.co.uk)', medianBlendWeight: medianW, leagues, portfolioCapped3: summariseBets(capped) };
  log(`BACKTEST ${JSON.stringify(result)}`);
  return result;
}

// ---------------------------------------------------------------- ratings loaders
async function loadClubElo() {
  let rows = [];
  for (const back of [0, 1, 2]) {
    const day = new Date(Date.now() - back * DAY).toISOString().slice(0, 10);
    for (const proto of ['http', 'https']) {
      rows = parseCsv(await getText(`${proto}://api.clubelo.com/${day}`));
      if (rows.length > 100) break;
    }
    if (rows.length > 100) break;
  }
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

// Paper-first rule (29 Oct): with 14 leagues tested, one can pass by luck. A league
// that passes its backtest must ALSO earn a forward paper record before it posts:
// ≥ 28 days since it first passed, ≥ 20 settled paper picks, and those picks
// beat the closing price on average (CLV > 0).
const FORWARD = { minDays: 28, minPicks: 20, minCLV: 0 };
async function forwardRecord(key) {
  if (!DB) return null;
  const since = await kvGet(`pass_since_${key}`);
  const { data } = await DB.from('football_candidates').select('best_price, close_price, status').eq('competition', key).eq('selected', true).eq('status', 'settled');
  const rows = data || [];
  const clvs = rows.filter(r => r.close_price > 1).map(r => r.best_price / r.close_price - 1);
  return { since, days: since ? (Date.now() - Date.parse(since)) / DAY : 0, picks: rows.length, clv: clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null };
}
async function groupCanPost(comp) {
  if (!CFG.posts) return false;
  if (comp.group !== 'DOMESTIC') return false; // UEFA / INTL / friendlies: paper until their forward record is reviewed
  const bt = STATE.backtest && STATE.backtest.leagues && STATE.backtest.leagues[comp.key];
  if (!(bt && bt.pass)) return false;
  const fr = await forwardRecord(comp.key);
  return Boolean(fr && fr.days >= FORWARD.minDays && fr.picks >= FORWARD.minPicks && fr.clv !== null && fr.clv > FORWARD.minCLV);
}

async function dailyRun(day) {
  if (!CFG.oddsKey) return;
  const now = Date.now();
  const all = [];
  for (const comp of COMPS) {
    if (STATE.oddsRemaining !== null && STATE.oddsRemaining <= CFG.oddsReserve && comp.group !== 'DOMESTIC') { log(`odds budget low (${STATE.oddsRemaining}) — skipping ${comp.label}`); continue; }
    if (STATE.audit && STATE.audit.odds && STATE.audit.odds[comp.key] === 'NOT AVAILABLE') continue;
    // V2.1: only spend odds credits where a pick is possible — domestic leagues that
    // passed their backtest. UEFA / INTL borrow a near-zero model weight, so they can't
    // produce model-based value; FOOTY_PAPER_ALL=on tracks them anyway.
    if (process.env.FOOTY_PAPER_ALL !== 'on') {
      if (comp.group !== 'DOMESTIC') continue;
      const bt = STATE.backtest && STATE.backtest.leagues && STATE.backtest.leagues[comp.key];
      if (!bt || !bt.pass) continue;
    }
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
      const raw = probabilitiesFor(comp, ev);
      const market = marketConsensus(ev);
      const bt = STATE.backtest && STATE.backtest.leagues && STATE.backtest.leagues[comp.key];
      const w = bt && Number.isFinite(bt.blendWeight) ? bt.blendWeight : (STATE.backtest && Number.isFinite(STATE.backtest.medianBlendWeight) ? STATE.backtest.medianBlendWeight : MODEL.defaultBlend);
      const probs = raw.ok && market ? { ...raw, ...blend(raw, market, w), raw: { home: raw.home, draw: raw.draw, away: raw.away }, market, w } : raw.ok ? { ok: false, reason: 'no market consensus' } : raw;
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
  const postable = new Map();
  for (const r of selected) if (!postable.has(r.comp.key)) postable.set(r.comp.key, await groupCanPost(r.comp));
  const posting = selected.filter(r => postable.get(r.comp.key));
  log(`${day}: ${all.length} matches evaluated, ${qualifiers.length} qualified, ${selected.length} selected (${posting.length} postable) · odds credits left ${STATE.oddsRemaining}`);
  if (DB) {
    for (const r of all) {
      await DB.from('football_candidates').upsert({
        id: `${r.ev.id}`, decided_day: day, competition: r.comp.key, grp: r.comp.group, home: r.ev.home_team, away: r.ev.away_team, kickoff: new Date(r.t).toISOString(),
        model: r.probs.model || null, p_home: round(r.probs.home), p_draw: round(r.probs.draw), p_away: round(r.probs.away),
        blend_w: r.probs.w ?? null, raw_home: round(r.probs.raw?.home), raw_draw: round(r.probs.raw?.draw), raw_away: round(r.probs.raw?.away),
        mkt_home: round(r.probs.market?.home), mkt_draw: round(r.probs.market?.draw), mkt_away: round(r.probs.market?.away),
        price_home: r.prices.home?.price ?? null, price_draw: r.prices.draw?.price ?? null, price_away: r.prices.away?.price ?? null,
        best_side: r.best?.side ?? null, best_price: r.best?.d ?? null, best_book: r.best?.book ?? null, ev: round(r.best?.ev), ev_low: round(r.best?.evLow), min_price: round(r.best?.minPrice, 3),
        fragile: r.fragile ?? null, qualifies: Boolean(r.qualifies), selected: selSet.has(r), posted: posting.includes(r), reason: r.reason || null,
        odds_at: r.fetchedAt, status: 'pending', model_version: MODEL.version,
      }, { onConflict: 'id' });
    }
    await kvSet(`day_${day}`, { evaluated: all.length, qualified: qualifiers.length, selected: selected.length, posted: posting.length, oddsRemaining: STATE.oddsRemaining });
  }
  if (CFG.posts && posting.length) await post(picksMessage(day, posting, all.length)); // no daily 'nothing today' posts
  if (CFG.posts && posting.length && NOTIFY && require('./fun_money.js').ON) { try { await NOTIFY(funMessage(posting)); } catch (e) { log(`fun-money post failed: ${e.message}`); } }
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
    lines.push(`Model chance ${round(r.best.p * 100, 1)}% · price ${r.best.quoted} (${r.best.book}${r.best.quoted !== r.best.d ? `, ${r.best.d} after commission` : ''}) · minimum ${round(r.best.minPrice, 2)}`);
    lines.push(`Estimated value +${round(r.best.ev * 100, 1)}%${r.fragile ? ' · fragile (gone if the model is 3 pts too high)' : ''}`);
    lines.push(`Odds checked ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(Date.parse(r.fetchedAt))}`, '');
  });
  lines.push('Level 1-unit singles, tracked and settled. Don\'t take a price below the minimum. Educational only — bet responsibly.');
  return lines.join('\n');
}

let NOTIFY = null; // Hunter's alertUser: fun-money copy goes to the Hunter channel
function funMessage(picks) {
  const FUN = require('./fun_money.js');
  const out = ['💰 FUN MONEY — FOOTBALL', ''];
  for (const r of picks) out.push(`${r.ev.home_team} v ${r.ev.away_team} · ${ukTime(r.t)}`, `Back: ${sideName(r, r.best.side)} (90 mins) at ${r.best.quoted} or better (never below ${round(r.best.minPrice, 2)})`, FUN.betLine('football', Number(r.best.quoted)), '');
  return out.join('\n').trim();
}
async function post(text) {
  if (NOTIFY) { try { await NOTIFY(text); return true; } catch (e) { log(`Hunter channel post failed: ${e.message}`); return false; } } // 3 Nov: everything to Hunter picks
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
      const ev = byId.get(String(r.id).replace(/^(nap|near|acca)_/, '').replace(/_(home|away)$/, ''));
      const p = ev ? bestPrices(ev)[r.best_side] : null;
      if (p) await DB.from('football_candidates').update({ close_price: p.price, close_at: new Date().toISOString() }).eq('id', r.id);
    }
  }
}

// Settle every evaluated candidate (picks and rejects) from final scores.
async function settle() {
  if (!DB || !CFG.oddsKey || (STATE.oddsRemaining !== null && STATE.oddsRemaining <= 20)) return;
  const now = Date.now();
  const { data } = await DB.from('football_candidates').select('id, competition, kickoff, best_side, best_price, selected, posted, grp, home, away').eq('status', 'pending');
  const settledNow = [];
  // 10 Nov: credits. Posted picks settle hourly (you get the result quickly); everything else
  // (near misses, unposted) settles in two daily batches, which costs a fraction of the credits.
  const h = ukHour();
  const batch = h === 10 || h === 23;
  const due = (data || []).filter(r => now - Date.parse(r.kickoff) > 2.5 * 3600000 && (r.posted || batch));
  for (const key of [...new Set(due.map(r => r.competition))]) {
    const sc = await getJson(oddsUrl(`/sports/${key}/scores`, { daysFrom: 3, dateFormat: 'iso' })); // 2 credits
    const byId = new Map((Array.isArray(sc.body) ? sc.body : []).map(e => [e.id, e]));
    for (const r of due.filter(x => x.competition === key)) {
      const e = byId.get(String(r.id).replace(/^(nap|near|acca)_/, '').replace(/_(home|away)$/, ''));
      if (!e) { if (now - Date.parse(r.kickoff) > 4 * DAY) await DB.from('football_candidates').update({ status: 'unsettled' }).eq('id', r.id); continue; }
      if (!e.completed) continue;
      const g = Object.fromEntries((e.scores || []).map(s => [s.name, Number(s.score)]));
      const hg = g[e.home_team], ag = g[e.away_team];
      if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
      const res = hg > ag ? 'home' : hg === ag ? 'draw' : 'away';
      const profit = r.best_side && r.best_price ? (res === r.best_side ? round(r.best_price - 1, 3) : -1) : null;
      await DB.from('football_candidates').update({ status: 'settled', result: res, home_goals: hg, away_goals: ag, won: r.best_side ? res === r.best_side : null, profit, settled_at: new Date().toISOString() }).eq('id', r.id);
      if (r.posted) settledNow.push({ ...r, hg, ag, won: res === r.best_side });
    }
  }
  if (settledNow.length && CFG.posts) await post(resultsMessage(settledNow));
  return settledNow;
}

function resultsMessage(list) {
  const out = ['🏁 FOOTY RESULTS', ''];
  for (const r of list) {
    const team = r.best_side === 'home' ? r.home : r.best_side === 'away' ? r.away : 'Draw';
    out.push(`${r.home} ${r.hg}–${r.ag} ${r.away} · ${String(team).toUpperCase()} to win: ${r.won ? '✅ WON' : '❌ LOST'}${r.won && r.best_price ? ` (${r.best_price})` : ''}`);
  }
  const w = list.filter(r => r.won).length;
  if (list.length > 1) out.push('', `${w} won from ${list.length}`);
  return out.join('\n');
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
  sum(rows.filter(r => r.grp === 'NAP'), 'Price picks');
  sum(rows.filter(r => r.grp === 'NEAR'), 'Near misses (checked, not posted)');
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


// ---------------------------------------------------------------- NAP of the day (market-based)
// The model can't beat the bookmakers (backtest), so the NAP doesn't pretend to. It takes the
// bookmakers' own consensus chance (margin removed, averaged over every UK book) and looks for
// the likeliest home/away winner where one book is offering MORE than that consensus implies.
// That's price-shopping: the best available price against the market's own view.
// pb1 backtest best variant (3 Nov): 131 bets, 56.5% won, +9.3% at best price
const NAP = { minEdge: 0, minP: 0.45, minPrice: 1.5, maxPrice: 2.6, minBooks: 4, minLeadMin: 60, windowH: 30 };
const NAP_ORDER = ['soccer_epl', 'soccer_uefa_champs_league', 'soccer_uefa_europa_league', 'soccer_uefa_nations_league',
  'soccer_fifa_world_cup_qualifiers_europe', 'soccer_uefa_euro_qualification', 'soccer_efl_champ', 'soccer_spain_la_liga',
  'soccer_italy_serie_a', 'soccer_germany_bundesliga', 'soccer_france_ligue_one', 'soccer_uefa_europa_conference_league',
  'soccer_spl', 'soccer_england_league1', 'soccer_netherlands_eredivisie', 'soccer_portugal_primeira_liga',
  'soccer_england_league2', 'soccer_belgium_first_div', 'soccer_turkey_super_league', 'soccer_greece_super_league', 'soccer_fifa_world_cup', 'soccer_uefa_european_championship'];

function napCandidates(comp, ev, now) {
  const t = Date.parse(ev.commence_time);
  if (!(t - now >= NAP.minLeadMin * 60000 && t - now <= NAP.windowH * 3600000)) return [];
  const cons = marketConsensus(ev);
  if (!cons || cons.books < NAP.minBooks) return [];
  const prices = bestPrices(ev);
  return ['home', 'away'].filter(side => prices[side]).map(side => {
    const p = cons[side], d = prices[side].price, q = prices[side].quoted ?? d;
    return { comp, ev, t, side, p, d, quoted: q, book: prices[side].book, edge: p * d - 1, cons, prices, minPrice: 1 / p };
  }).filter(c => c.p >= (STATE.valueRule ? STATE.valueRule.minP : NAP.minP) && c.quoted >= NAP.minPrice && c.quoted <= NAP.maxPrice);
}
// Every home/away side in the window with a market consensus — for the daily "most likely winner".
function allSides(comp, ev, now, windowH = NAP.windowH) {
  const t = Date.parse(ev.commence_time);
  if (!(t - now >= NAP.minLeadMin * 60000 && t - now <= windowH * 3600000)) return [];
  const cons = marketConsensus(ev);
  if (!cons || cons.books < NAP.minBooks) return [];
  const prices = bestPrices(ev);
  return ['home', 'away'].filter(side => prices[side]).map(side => {
    const p = cons[side], d = prices[side].price;
    return { comp, ev, t, side, p, d, quoted: prices[side].quoted ?? d, book: prices[side].book, edge: p * d - 1, cons, prices, minPrice: 1 / p };
  });
}
// Best price-vs-consensus first; among near-ties (within 1%), the likelier winner.
function pickNap(cands) {
  return [...cands].sort((a, b) => (Math.abs(b.edge - a.edge) > 0.01 ? b.edge - a.edge : b.p - a.p))[0] || null;
}
// Every candidate whose best price beats the market's own fair price by 3%+, best first (one per match).
function pickAll(cands) {
  const seen = new Set();
  const sorted = [...cands].sort((a, b) => b.edge - a.edge).filter(c => !seen.has(c.ev.id) && seen.add(c.ev.id));
  // Teams the market rates 45%+ to win, at a price at or above fair (pb1 backtest best). No forced pick.
  if (STATE.valueRule === null) return []; // learner found no profitable value rule
  return sorted.filter(c => c.edge >= (STATE.valueRule ? STATE.valueRule.minEdge : NAP.minEdge));
}

function napMessage(day, list) {
  const out = [`⚽ FOOTY PICKS — ${day}`, ''];
  list.forEach((n, i) => {
    const team = n.side === 'home' ? n.ev.home_team : n.ev.away_team;
    const head = n.kind === 'most' ? '⭐ NAP · MOST LIKELY WINNER: ' : n.kind === 'value' ? '⚽💰 VALUE PICK: ' : (i === 0 ? '⭐ NAP · ' : '⚽ ');
    out.push(`${head}${team.toUpperCase()} TO WIN (90 mins)`,
      `${n.ev.home_team} v ${n.ev.away_team} · ${ukTime(n.t)} · ${n.comp.label}`,
      `Win chance (bookmakers' view) ${round(n.p * 100, 0)}% · best price ${n.quoted} (${n.book})${n.edge >= 0 ? ` · ${round(n.edge * 100, 1)}% above fair` : ''}`, '');
  });
  out.push(list.some(n => n.kind === 'most') ? 'NAP = the team the bookmakers make most likely to win today. Value = likely winners where one bookie pays more than fair. Bet responsibly.' : 'Only posted when a bookie pays more than fair for a likely winner (backtested rule). Take the best price you can. Bet responsibly.');
  return out.join('\n');
}
function napFunMessage(n) {
  const FUN = require('./fun_money.js');
  const team = n.side === 'home' ? n.ev.home_team : n.ev.away_team;
  return ['💰 FUN MONEY — FOOTY NAP', '', `⭐ ${team.toUpperCase()} to win · ${n.ev.home_team} v ${n.ev.away_team} · ${ukTime(n.t)}`,
    FUN.betLine('footballNap', Number(n.quoted)), `Best price ${n.quoted} (${n.book}) — take the best price your bookie offers.`].join('\n');
}

async function napRun(day) {
  const now = Date.now();
  let calls = 0; const cands = [], sides = [];
  const sat = isSaturdayUK(new Date(now));
  const horizonH = sat ? Math.max(NAP.windowH, hoursToMondayUK(now)) : NAP.windowH; // Saturday: look across Sat + Sun for the ACCA
  const comps = NAP_ORDER.map(k => COMPS.find(c => c.key === k)).filter(Boolean);
  for (const comp of comps) {
    if (calls >= CFG.napCalls) break;
    if (STATE.oddsRemaining !== null && STATE.oddsRemaining <= CFG.oddsReserve) { log(`NAP: odds budget low (${STATE.oddsRemaining}) — stopping search`); break; }
    if (STATE.audit && STATE.audit.odds && /NOT AVAILABLE|not active/.test(STATE.audit.odds[comp.key] || '')) continue;
    const evs = await getJson(oddsUrl(`/sports/${comp.key}/events`, { dateFormat: 'iso' })); // free
    const soon = (Array.isArray(evs.body) ? evs.body : []).filter(e => { const t = Date.parse(e.commence_time); return t - now >= NAP.minLeadMin * 60000 && t - now <= horizonH * 3600000; });
    if (!soon.length) continue;
    const odds = await getJson(oddsUrl(`/sports/${comp.key}/odds`, { regions: 'uk', markets: 'h2h', oddsFormat: 'decimal', dateFormat: 'iso' })); // 1 credit
    calls++;
    for (const ev of Array.isArray(odds.body) ? odds.body : []) { cands.push(...napCandidates(comp, ev, now)); sides.push(...allSides(comp, ev, now, horizonH)); }
  }
  // Never re-post a match already picked (the 30h window overlaps tomorrow's run).
  let done = new Set();
  if (DB) { const { data } = await DB.from('football_candidates').select('id').eq('grp', 'NAP'); done = new Set((data || []).map(r => String(r.id))); }
  const fresh = x => !done.has(`nap_${x.ev.id}`);
  // 1) NAP = the most likely winner of the day (highest market win chance), every day there's football.
  const most = CFG.dailyNap ? (sides.filter(fresh).filter(x => x.t - now <= NAP.windowH * 3600000).sort((a, b) => b.p - a.p)[0] || null) : null;
  const acca = sat ? accaLegs(sides) : [];
  if (most) most.kind = 'most';
  // 2) plus any value picks (45%+ chance, best price at or above fair — the backtested rule).
  const value = pickAll(cands.filter(fresh)).filter(x => !most || x.ev.id !== most.ev.id).map(x => ({ ...x, kind: 'value' }));
  const list = [...(most ? [most] : []), ...value];
  const n = list[0] || null;
  log(`NAP ${day}: ${sides.length} sides, ${cands.length} value candidates, ${list.length} picks from ${calls} odds calls · ${n ? `${n.side === 'home' ? n.ev.home_team : n.ev.away_team} @ ${n.quoted} (cons ${round(n.p * 100, 1)}%, edge ${round(n.edge * 100, 1)}%)` : 'none'} · credits left ${STATE.oddsRemaining}`);
  if (DB) {
    for (const n of list) await DB.from('football_candidates').upsert({
      id: `nap_${n.ev.id}`, decided_day: day, competition: n.comp.key, grp: 'NAP', home: n.ev.home_team, away: n.ev.away_team, kickoff: new Date(n.t).toISOString(),
      model: 'market_nap', p_home: round(n.cons.home), p_draw: round(n.cons.draw), p_away: round(n.cons.away),
      mkt_home: round(n.cons.home), mkt_draw: round(n.cons.draw), mkt_away: round(n.cons.away),
      price_home: n.prices.home?.price ?? null, price_draw: n.prices.draw?.price ?? null, price_away: n.prices.away?.price ?? null,
      best_side: n.side, best_price: n.d, best_book: n.book, ev: round(n.edge), min_price: round(n.minPrice, 3),
      qualifies: true, selected: true, posted: Boolean(CFG.posts), reason: n.kind === 'most' ? 'nap_most_likely' : 'value', odds_at: new Date().toISOString(), status: 'pending', model_version: 'nap_v2',
    }, { onConflict: 'id' });
    // Near misses: every likely winner that was checked but not posted, settled later so we can see how they did.
    const picked = new Set(list.map(x => `${x.ev.id}:${x.side}`));
    const { data: nearRows } = await DB.from('football_candidates').select('id').eq('grp', 'NEAR');
    const nearDone = new Set((nearRows || []).map(r => String(r.id)));
    for (const c of cands.filter(fresh).filter(x => !picked.has(`${x.ev.id}:${x.side}`) && !nearDone.has(`near_${x.ev.id}_${x.side}`))) await DB.from('football_candidates').upsert({
      id: `near_${c.ev.id}_${c.side}`, decided_day: day, competition: c.comp.key, grp: 'NEAR', home: c.ev.home_team, away: c.ev.away_team, kickoff: new Date(c.t).toISOString(),
      model: 'market_nap', p_home: round(c.cons.home), p_draw: round(c.cons.draw), p_away: round(c.cons.away),
      mkt_home: round(c.cons.home), mkt_draw: round(c.cons.draw), mkt_away: round(c.cons.away),
      best_side: c.side, best_price: c.d, best_book: c.book, ev: round(c.edge), min_price: round(c.minPrice, 3),
      qualifies: false, selected: false, posted: false, reason: 'near_miss (price below fair)', odds_at: new Date().toISOString(), status: 'pending', model_version: 'nap_v2',
    }, { onConflict: 'id' });
    for (const c of acca) await DB.from('football_candidates').upsert({
      id: `acca_${c.ev.id}_${c.side}`, decided_day: day, competition: c.comp.key, grp: 'ACCA', home: c.ev.home_team, away: c.ev.away_team, kickoff: new Date(c.t).toISOString(),
      model: 'market_acca', p_home: round(c.cons.home), p_draw: round(c.cons.draw), p_away: round(c.cons.away),
      mkt_home: round(c.cons.home), mkt_draw: round(c.cons.draw), mkt_away: round(c.cons.away),
      best_side: c.side, best_price: c.d, best_book: c.book, ev: round(c.edge), min_price: round(c.minPrice, 3),
      qualifies: true, selected: true, posted: Boolean(CFG.posts), reason: 'weekend_acca', odds_at: new Date().toISOString(), status: 'pending', model_version: 'acca_v1',
    }, { onConflict: 'id' });
    await kvSet(`nap_${day}`, { candidates: cands.length, calls, picks: list.map(x => `nap_${x.ev.id}`), oddsRemaining: STATE.oddsRemaining });
  }
  if (acca.length >= ACCA.minLegs) { if (CFG.posts) await post(accaMessage(acca)); else log(`(paper) ${accaMessage(acca)}`); } else if (sat) log(`ACCA: only ${acca.length} legs at ${ACCA.minP * 100}%+ — none posted`);
  if (!n) return null;
  if (CFG.posts) await post(napMessage(day, list)); else log(`(paper) ${napMessage(day, list)}`);
  if (CFG.posts && NOTIFY && require('./fun_money.js').ON) { try { await NOTIFY(napFunMessage(n)); } catch (e) { log(`fun-money post failed: ${e.message}`); } }
  return n;
}

// ---------------------------------------------------------------- price-pick backtest (the rule we actually post)
// Same rule as the live picks: market consensus from the AVERAGE price across bookmakers
// (margin removed), bet the home/away side at the BEST price on offer when the market makes
// it a likely winner and the best price is at or above fair. football-data.co.uk has both.
const PRICE_BT_VERSION = 'pb2';
// The value-pick rule menu the weekly learner chooses from (the NAP itself is always the most likely winner).
const VALUE_RULES = {
  p40_edge0: { minP: 0.40, minEdge: 0 },
  p45_edge0: { minP: 0.45, minEdge: 0 },
  p45_edge1: { minP: 0.45, minEdge: 0.01 },
  p50_edge0: { minP: 0.50, minEdge: 0 },
  p50_edge2: { minP: 0.50, minEdge: 0.02 },
  p55_edge0: { minP: 0.55, minEdge: 0 },
};
// Weekly: pick the variant with the best return at the best price, on 100+ bets, that is
// profitable at the best price AND no worse than -5% at Bet365. None qualifies -> no value picks.
function chooseValueRule(pb) {
  const ok = Object.entries(pb.variants).filter(([, v]) => v.bets >= 100 && v.roiBestPrice > 0 && v.roiBet365 > -5)
    .sort((a, b) => b[1].roiBestPrice - a[1].roiBestPrice);
  return ok.length ? { rule: ok[0][0], ...VALUE_RULES[ok[0][0]], why: `${ok[0][1].bets} past bets, ${ok[0][1].winRate}% won, ${ok[0][1].roiBestPrice}% return at best price` } : { rule: null, why: 'no value rule profitable on 100+ past bets' };
}
function priceBacktest(history, seasons = ['2324', '2425', '2526', '2627']) {
  const variants = VALUE_RULES;
  const out = { version: PRICE_BT_VERSION, at: new Date().toISOString(), seasons, variants: {} };
  for (const [name, v] of Object.entries(variants)) {
    const tally = { bets: 0, wins: 0, profitBest: 0, profitB365: 0, leagues: {} };
    for (const [key, rows] of history) {
      for (const r of rows) {
        if (!seasons.includes(r.season) || !r.avg || !r.max) continue;
        const a = r.avg, m = r.max;
        if (!(a.home > 1 && a.draw > 1 && a.away > 1 && m.home > 1 && m.away > 1)) continue;
        const inv = 1 / a.home + 1 / a.draw + 1 / a.away;
        const pr = { home: 1 / a.home / inv, away: 1 / a.away / inv };
        const res = r.hg > r.ag ? 'home' : r.hg < r.ag ? 'away' : 'draw';
        const opts = ['home', 'away'].map(side => ({ side, p: pr[side], d: m[side], edge: pr[side] * m[side] - 1 }))
          .filter(o => o.p >= v.minP && o.d >= NAP.minPrice && o.d <= NAP.maxPrice && o.edge >= v.minEdge)
          .sort((x, y) => y.edge - x.edge);
        const o = opts[0]; if (!o) continue;
        const won = res === o.side;
        tally.bets++; if (won) tally.wins++;
        tally.profitBest += won ? o.d - 1 : -1;
        const b = r.b365 && r.b365[o.side]; tally.profitB365 += won ? (b > 1 ? b - 1 : o.d - 1) : -1;
        const L = (tally.leagues[key] ||= { bets: 0, profit: 0 }); L.bets++; L.profit += won ? o.d - 1 : -1;
      }
    }
    out.variants[name] = { bets: tally.bets, winRate: tally.bets ? round(tally.wins / tally.bets * 100, 1) : null,
      roiBestPrice: tally.bets ? round(tally.profitBest / tally.bets * 100, 2) : null, roiBet365: tally.bets ? round(tally.profitB365 / tally.bets * 100, 2) : null,
      leagues: Object.fromEntries(Object.entries(tally.leagues).map(([k, l]) => [k, { bets: l.bets, roi: round(l.profit / l.bets * 100, 1) }])) };
  }
  return out;
}

// ---------------------------------------------------------------- weekend ACCA (Saturday 11:00)
// Legs = the teams the bookmakers make most likely to win across Saturday and Sunday:
// 60%+ win chance (margin removed), one per match, best 5. Shows the combined price and chance.
const ACCA = { minP: 0.60, maxLegs: 5, minLegs: 2 };
function isSaturdayUK(d = new Date()) { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' }).format(d) === 'Sat'; }
function hoursToMondayUK(now = Date.now()) {
  for (let h = 1; h <= 72; h++) { const d = new Date(now + h * 3600000); if (new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' }).format(d) === 'Mon') return h; }
  return 48;
}
function accaLegs(sides) {
  const seen = new Set();
  return [...sides].filter(x => x.p >= ACCA.minP).sort((a, b) => b.p - a.p)
    .filter(x => !seen.has(x.ev.id) && seen.add(x.ev.id)).slice(0, ACCA.maxLegs).sort((a, b) => a.t - b.t);
}
function accaMessage(legs) {
  const price = legs.reduce((a, l) => a * Number(l.quoted), 1), chance = legs.reduce((a, l) => a * l.p, 1);
  const out = [`⚽🎟️ WEEKEND FOOTBALL ACCA — ${legs.length}-fold`, ''];
  for (const l of legs) {
    const team = l.side === 'home' ? l.ev.home_team : l.ev.away_team;
    const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(l.t));
    out.push(`${team.toUpperCase()} to win · ${l.ev.home_team} v ${l.ev.away_team} · ${when} · ${l.comp.label}`, `   win chance ${round(l.p * 100, 0)}% · best price ${l.quoted}`);
  }
  out.push('', `Combined: about ${round(price, 2)} at best prices · chance all win ≈ ${round(chance * 100, 0)}%`, 'The likeliest winners of the weekend, by the bookmakers\' own odds. Bet responsibly.');
  return out.join('\n');
}

// ---------------------------------------------------------------- football lab (11 Nov)
// A wider menu of simple, price-based rules on 5 seasons x 14 leagues of football-data.co.uk:
// favourites by strength, underdogs, draws, and over/under 2.5 goals. Each is judged at the
// best price on offer AND at Bet365, over the first two seasons and the last three separately.
// WINNER = profitable at best price in BOTH halves, on 200+ bets, and no worse than -2% at Bet365.
const FOOTY_LAB_VERSION = 'flab1';
function footballLab(history) {
  const FIRST = ['2223', '2324'], SECOND = ['2425', '2526', '2627'];
  const fair3 = a => { const inv = 1 / a.home + 1 / a.draw + 1 / a.away; return { home: 1 / a.home / inv, draw: 1 / a.draw / inv, away: 1 / a.away / inv }; };
  const fair2 = (o, u) => { const inv = 1 / o + 1 / u; return { over: 1 / o / inv, under: 1 / u / inv }; };
  // each rule returns [{ pick, price, b365 }] for a match (pick = 'home'|'draw'|'away'|'over'|'under')
  const side = (r, pk) => ({ pick: pk, price: r.max[pk], b365: r.b365 && r.b365[pk] });
  const rules = {
    fav_60_70: r => { const f = fair3(r.avg); return ['home', 'away'].filter(k => f[k] >= 0.6 && f[k] < 0.7).map(k => side(r, k)); },
    fav_70_plus: r => { const f = fair3(r.avg); return ['home', 'away'].filter(k => f[k] >= 0.7).map(k => side(r, k)); },
    fav_50_60: r => { const f = fair3(r.avg); return ['home', 'away'].filter(k => f[k] >= 0.5 && f[k] < 0.6).map(k => side(r, k)); },
    value_40_fair: r => { const f = fair3(r.avg); return ['home', 'away'].filter(k => f[k] >= 0.4 && r.max[k] >= 1.5 && r.max[k] <= 2.6 && f[k] * r.max[k] >= 1).map(k => side(r, k)); },
    home_underdog_25_40: r => { const f = fair3(r.avg); return f.home >= 0.25 && f.home < 0.4 ? [side(r, 'home')] : []; },
    away_underdog_25_40: r => { const f = fair3(r.avg); return f.away >= 0.25 && f.away < 0.4 ? [side(r, 'away')] : []; },
    draw_close_match: r => { const f = fair3(r.avg); return Math.abs(f.home - f.away) < 0.08 ? [side(r, 'draw')] : []; },
    over25_value: r => { const o = r.ou; if (!(o && o.avgOver > 1 && o.avgUnder > 1 && o.maxOver > 1)) return []; const f = fair2(o.avgOver, o.avgUnder); return f.over * o.maxOver >= 1.02 ? [{ pick: 'over', price: o.maxOver, b365: o.b365Over }] : []; },
    under25_value: r => { const o = r.ou; if (!(o && o.avgOver > 1 && o.avgUnder > 1 && o.maxUnder > 1)) return []; const f = fair2(o.avgOver, o.avgUnder); return f.under * o.maxUnder >= 1.02 ? [{ pick: 'under', price: o.maxUnder, b365: o.b365Under }] : []; },
    over25_likely_60: r => { const o = r.ou; if (!(o && o.avgOver > 1 && o.avgUnder > 1 && o.maxOver > 1)) return []; return fair2(o.avgOver, o.avgUnder).over >= 0.6 ? [{ pick: 'over', price: o.maxOver, b365: o.b365Over }] : []; },
    under25_likely_55: r => { const o = r.ou; if (!(o && o.avgOver > 1 && o.avgUnder > 1 && o.maxUnder > 1)) return []; return fair2(o.avgOver, o.avgUnder).under >= 0.55 ? [{ pick: 'under', price: o.maxUnder, b365: o.b365Under }] : []; },
  };
  const won = (r, pk) => (pk === 'over' ? r.hg + r.ag > 2.5 : pk === 'under' ? r.hg + r.ag < 2.5 : (r.hg > r.ag ? 'home' : r.hg < r.ag ? 'away' : 'draw') === pk);
  const out = { version: FOOTY_LAB_VERSION, at: new Date().toISOString(), firstHalf: FIRST, secondHalf: SECOND, rules: {} };
  for (const [name, rule] of Object.entries(rules)) {
    const t = { first: { bets: 0, wins: 0, pBest: 0, pB365: 0 }, second: { bets: 0, wins: 0, pBest: 0, pB365: 0 } };
    for (const [, rows] of history) for (const r of rows) {
      const half = FIRST.includes(r.season) ? 'first' : SECOND.includes(r.season) ? 'second' : null; if (!half) continue;
      if (!(r.avg && r.avg.home > 1 && r.avg.draw > 1 && r.avg.away > 1 && r.max && r.max.home > 1)) continue;
      for (const b of rule(r)) {
        if (!(b.price > 1)) continue;
        const w = won(r, b.pick), x = t[half];
        x.bets++; if (w) x.wins++;
        x.pBest += w ? b.price - 1 : -1;
        x.pB365 += w ? ((b.b365 > 1 ? b.b365 : b.price) - 1) : -1;
      }
    }
    const f = h => ({ bets: h.bets, winRate: h.bets ? round(h.wins / h.bets * 100, 1) : null, roiBest: h.bets ? round(h.pBest / h.bets * 100, 2) : null, roiB365: h.bets ? round(h.pB365 / h.bets * 100, 2) : null });
    const all = { bets: t.first.bets + t.second.bets, wins: t.first.wins + t.second.wins, pBest: t.first.pBest + t.second.pBest, pB365: t.first.pB365 + t.second.pB365 };
    const res = { first: f(t.first), second: f(t.second), all: f(all) };
    res.verdict = res.all.bets >= 200 && res.first.roiBest > 0 && res.second.roiBest > 0 && res.all.roiB365 > -2 ? 'WINNER' : (res.all.roiBest > 0 ? 'mixed' : 'no');
    out.rules[name] = res;
  }
  return out;
}

// ---------------------------------------------------------------- scheduler
async function refreshModels(force = false) {
  const today = new Date().toISOString().slice(0, 10);
  if (force || STATE.modelsDay !== today) {
    STATE.modelsDay = today;
    const history = await loadDomesticHistory();
    for (const [key, rows] of history) STATE.domestic.set(key, rows.length ? fitPoisson(rows, Date.now()) : null);
    const last = await kvGet('backtest');
    const stale = !last || last.model !== MODEL.version || Date.now() - Date.parse(last.at) > 7 * DAY;
    if (stale) { STATE.backtest = await runBacktest(history); await kvSet('backtest', STATE.backtest); } else STATE.backtest = last;
    { const lastLab = await kvGet('football_lab'); if (!lastLab || lastLab.version !== FOOTY_LAB_VERSION || process.env.FOOTY_LAB === 'force') { const fl = footballLab(history); await kvSet('football_lab', fl); log(`LAB RESULT ${JSON.stringify(Object.fromEntries(Object.entries(fl.rules).map(([k, v]) => [k, { bets: v.all.bets, win: v.all.winRate, roiBest: v.all.roiBest, roiB365: v.all.roiB365, h1: v.first.roiBest, h2: v.second.roiBest, verdict: v.verdict }])))}`); } }
    let lastPb = await kvGet('price_backtest');
    if (!lastPb || lastPb.version !== PRICE_BT_VERSION || Date.now() - Date.parse(lastPb.at) > 7 * DAY) { const pb = priceBacktest(history); await kvSet('price_backtest', pb); lastPb = pb; log(`PRICE BACKTEST ${JSON.stringify(Object.fromEntries(Object.entries(pb.variants).map(([k, v]) => [k, { bets: v.bets, winRate: v.winRate, roiBest: v.roiBestPrice, roiB365: v.roiBet365 }])))}`); }
    { const prev = await kvGet('value_rule'); const ch = chooseValueRule(lastPb);
      STATE.valueRule = ch.rule ? { minP: ch.minP, minEdge: ch.minEdge, rule: ch.rule } : null;
      if (!prev || prev.rule !== ch.rule) { await kvSet('value_rule', { ...ch, at: new Date().toISOString() }); log(`LEARNER value rule ${ch.rule || 'off'}: ${ch.why}`); if (prev && CFG.posts) await post(`🧠 FOOTY MODEL UPDATE\n\nValue picks now use ${ch.rule || 'nothing (switched off)'}: ${ch.why}. The daily NAP is unchanged.`); } }
    // start each passing league's forward paper clock the first time it passes
    for (const [key, l] of Object.entries(STATE.backtest.leagues || {})) {
      if (l.pass && !(await kvGet(`pass_since_${key}`))) { await kvSet(`pass_since_${key}`, new Date().toISOString()); log(`${l.label} passed its backtest — starting a ${FORWARD.minDays}-day paper record before it can post`); }
    }
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
    if (CFG.nap && h >= CFG.pickHourUK && STATE.lastNapDay !== day && !(await kvGet(`nap_${day}`))) { STATE.lastNapDay = day; await napRun(day); }
    await captureClosing();
    if (STATE.lastSettleHour !== `${day}:${h}`) { STATE.lastSettleHour = `${day}:${h}`; await settle(); } // hourly: results posted soon after full time
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
  if (opts.notify) NOTIFY = opts.notify;
  if (!CFG.oddsKey) { log('ODDS_API_KEY not set — footy picks off'); return null; }
  log(`footy picks on · ${CFG.posts ? 'POSTING (backtest-passed leagues only)' : 'PAPER PHASE (audit + backtest + tracking, no posts)'} · picks after ${CFG.pickHourUK}:00 UK · 1X2, EV ≥ +${MODEL.minEV * 100}%, max ${MODEL.maxPerDay}/day · NAP of the day ${CFG.nap ? `ON (up to ${CFG.napCalls} odds calls/day)` : 'off'}`);
  setTimeout(tick, opts.startDelayMs ?? 150_000);
  setInterval(tick, 10 * 60_000);
  return { tick, STATE };
}

module.exports = {
  footballLab, accaLegs, accaMessage, isSaturdayUK, hoursToMondayUK, ACCA, chooseValueRule, VALUE_RULES, napCandidates, allSides, pickNap, pickAll, resultsMessage, priceBacktest, napMessage, napFunMessage, napRun, NAP, funMessage, _setNotify: n => { NOTIFY = n; }, marketConsensus, blend, start, tick, MODEL, COMPS, STATE, fitPoisson, predictDomestic, scoreMatrixProbs, eloProbs, buildIntlElo, matchTeam, norm,
  bestPrices, marketProbs, evaluate, rankAndCap, backtestLeague, summariseBets, applyDailyCap, parseCsv, fdDate, picksMessage,
  dailyRun, settle, weeklyReport, runBacktest, _setDb: d => { DB = d; }, _cfg: CFG,
};
