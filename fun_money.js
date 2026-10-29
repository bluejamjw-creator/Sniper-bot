'use strict';
/**
 * FUN MONEY — turns every OPEN/CLOSE into "put £X here / you made £Y".
 *
 * FUN_POT (default 100) is the whole pot in £. Each lane stakes a fixed
 * slice of it per pick, sized so that if every lane is full at once the
 * pot is roughly used up and never exceeded by much:
 *   Hunter crypto 7% (up to 3 open) · SNIPER 8% (set in sniper.js)
 *   trend lane 4% · US stocks lane 3% · horse 1% (NAP 2%) · football 1%
 * FUN_MONEY=off removes the lines again.
 */
const POT = Number(process.env.FUN_POT) > 0 ? Number(process.env.FUN_POT) : 100;
const ON = process.env.FUN_MONEY !== 'off';
const PCT = { crypto: 0.07, sniper: 0.08, trend: 0.04, stocks: 0.03, horse: 0.01, horseNap: 0.02, football: 0.01 };

function stake(lane) { return Math.max(1, Math.round(POT * (PCT[lane] || 0.01))); }
function gbp(x) {
  const v = Math.abs(x);
  return `${x < 0 ? '-' : ''}£${v >= 10 ? v.toFixed(0) : v.toFixed(2)}`;
}

/** Lines for an OPEN. lossFrac / winFrac are positive fractions (0.14 = 14%). winFrac null = no fixed target. */
function openLines(lane, lossFrac, winFrac) {
  if (!ON) return [];
  const s = stake(lane);
  const out = ['', `💰 Fun money: put £${s} in`];
  if (Number.isFinite(lossFrac) && lossFrac > 0) out.push(`If the stop hits you lose about ${gbp(s * lossFrac)}`);
  if (Number.isFinite(winFrac) && winFrac > 0) out.push(`If the target hits you win about ${gbp(s * winFrac)}`);
  else if (winFrac === null) out.push('No fixed target — it rides the trend until Hunter says sell');
  return out;
}

/** Line for a CLOSE. retFrac is the move from entry as a fraction (-0.14 = -14%). */
function closeLines(lane, retFrac) {
  if (!ON || !Number.isFinite(retFrac)) return [];
  const pl = stake(lane) * retFrac;
  return ['', `💰 Sell now. On £${stake(lane)} that's ${pl >= 0 ? '+' : ''}${gbp(pl)}`];
}

/** Bet lines (horse/football). odds = decimal price if known. */
function betLine(lane, odds) {
  if (!ON) return '';
  const s = stake(lane);
  const win = Number.isFinite(odds) && odds > 1 ? ` → returns about ${gbp(s * odds)} if it wins` : '';
  return `💰 £${s} win bet${win}`;
}

module.exports = { POT, ON, PCT, stake, gbp, openLines, closeLines, betLine };
