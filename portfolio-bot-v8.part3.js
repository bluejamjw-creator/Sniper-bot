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
