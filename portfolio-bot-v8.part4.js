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
