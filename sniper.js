// ================================================================
// SNIPER V101 -- GITHUB PASTE-BOX SPLIT -- PART 1 OF 4
// Paste all 4 parts into the same file, in order, with no extra
// blank lines or edits at the seams. Concatenating parts 1-4
// reconstructs sniper_v101_full.js exactly.
// Fixes HIGH_BETA range-proxy volume fallback -- was gated to
// opening-window only, so real volume-data gaps mid-session
// (AVGO/SMR etc) silently zeroed out volRatio on otherwise-
// passing setups. Now applies whenever HIGH_BETA volume data
// is missing, any time of day. Plus universe expansion, weekly
// persistence report, first-fire/peak-score alerts, safety mode
// alert, ema_fail diagnostics, false_breakout gate, crypto pool
// dynamic fix, V94 reversion, and all prior session fixes.
// ================================================================

// ================================================================
// (legacy marker from the old function-boundary 3-part split -- superseded below)
// New equal-length split boundaries are marked further down with V101 banners.
// Ends after: checkMarketAlerts()
// ================================================================
/*
 * ================================================================
 * BARETRADESIGNALS — SNIPER ENGINE PHILOSOPHY
 * ================================================================
 *
 * The objective is not to find trades.
 * The objective is to reject bad trades.
 *
 * When in doubt: DO NOT ALERT.
 *
 * The engine earns its reputation by saying NO.
 *
 * North star metric: Expected Value per signal
 *   EV = (Win Rate × Avg Win) − (Loss Rate × Avg Loss)
 *
 * Bot A: 80% wins, +2% avg win, -8% avg loss → loses money
 * Bot B: 45% wins, +10% avg win, -3% avg loss → makes money
 *
 * We optimise for Bot B.
 *
 * BTC controls crypto. QQQ controls US stocks.
 * Intel is always educational. Channel always has value.
 * ================================================================
 */
// ================================================================
// SNIPER V99 -- HIERARCHICAL EXIT ENGINE + FOUR MODULE SYSTEM
// ----------------------------------------------------------------
// V99 changes from V98:
//
// MODULE 1 -- HEAT SCORE SYSTEM
//   HEAT_SCORES Map tracks pre-signal conviction per asset
//   Intel mention +20, watchlist hit +15, crypto-intel +20
//   Signal fired +30 (retroactive confirmation)
//   8hr linear decay -- heat fades if move doesn't follow through
//   HOT threshold = 80pts → relaxed breakout distance, priority scan
//   Heat Index posted to channel hourly
//
// MODULE 2 -- LEADER MODE
//   Heat >= 80 + Vol >= 3x + Momentum >= 5% = LEADER
//   Breakout distance limit relaxed 50% for leaders
//   +10 score bonus, shown to subscribers with HOT LEADER tag
//   TON/ONDO pattern -- known movers don't give textbook pullbacks
//
// MODULE 3 -- TRADE STATE ENGINE
//   classifyTradeState() classifies every open crypto trade:
//     HEALTHY_TREND        -- price rising, above entry, progressing
//     HEALTHY_CONSOLIDATION -- flat but structure intact → hold
//     PULLBACK             -- dipped but showed green previously
//     FAILED_BREAKOUT      -- price back below entry with no MFE
//     TREND_FAILURE        -- down 2%+ from entry
//   12hr absolute hard cap for crypto (up from 4hr)
//   Default to patience -- consolidation is not failure
//
// MODULE 4 -- NO REGRET ENGINE
//   passesNoRegretCheck() -- 5 checks before channel send:
//     R:R >= 1.8, momentum positive, no better candidate exists,
//     late breakout with no heat blocked, volume >= 1.2x
//
// MODULE 5 -- OPPORTUNITY RANKING
//   rankOpportunityQuality() composite rank replaces raw score:
//     Heat persistence, move stage, R:R, leader mode, regime
//   pickTopSignals() sorts by rank not score
//
// All V98 preserved:
//   Maturity engine, dual-mode scanner, HIGH_BETA adaptive thresholds,
//   Alpaca SIP, Polygon fallback, Stooq fallback, educated close msgs,
//   all closes to channel, rejection stat logging, BST time
// ================================================================
// V89 stable base preserved: BST time, named gates, 15-min crypto,
// dynamic injection, market open/close alerts, dedup, graceful shutdown
//
// New in V90 -- complete analysis layer rebuild:
//
// DUAL-MODE SCANNER
//   Mode 1 -- Trend Continuation (crypto, large-cap stocks, ETFs)
//     Standard EMA structure, breakout distance, volume confirmation
//   Mode 2 -- Momentum Runner (HIGH_BETA stocks + dynamically injected)
//     Gap detection, opening range, ATR-relative thresholds,
//     relaxed EMA, adaptive extension limits
//
// MOVE MATURITY ENGINE
//   getMoveMaturity()     -- base / expansion / continuation / climax
//   getMomentumProfile()  -- accelerating vs decelerating candles
//   getVolumeProfile()    -- single breakout spike vs climax volume
//   getMoveInATRUnits()   -- extension relative to volatility not fixed %
//   isParabolicExhaustion() -- hard block when all exhaustion signals align
//   isFirstPullbackContinuation() -- catches Stage 3 entries
//
// SCORING OVERHAUL
//   24hr boost REPLACED with maturity-aware bonus/penalty
//   Climax stage = -15 points
//   Expansion stage = +12 points (best entry)
//   ATR units > 6 = -12 points (too extended)
//   Single volume spike = +8 (early breakout)
//   5+ high vol bars = -8 (climax buying)
//
// HIGH_BETA adaptive thresholds
//   ASTS, RKLB, LUNR, IONQ, OKLO, SMR, AVAV, ACHR, MSTR, COIN
//   Extension limit: 30% opening / 20% normal (vs 18%/10%)
//   Momentum cap: 20% opening / 12% normal
//   Breakout distance: 12% (vs 4%)
//   Score threshold: 74 (vs 80)
//
// GAP_CONTINUATION setup type
//   Gap 5%+ from prior close + opening volume 3x+ average
//   Entry on consolidation break above gap candle high
//   SL below gap candle low
//   Separate from breakout/pullback logic
//
// PARABOLIC EXHAUSTION HARD BLOCK
//   OSMO +200% = exhaustion score 8-9 = blocked
//   SUI +11% building = exhaustion score 0-1 = passes
// ================================================================

console.log(`
🚀 SNIPER BUILD INFO
Version:    V101.0 (V100.9 base + crypto_regimes evidence layer, no scoring impact)
Commit:     ${process.env.RAILWAY_GIT_COMMIT_SHA || "unknown"}
Deployed:   ${process.env.RAILWAY_DEPLOYMENT_ID || "unknown"}
Started:    ${new Date().toISOString()}
`);

const fs    = require("fs");
const path  = require("path");
const axios = require("axios");
const express = require("express");
const ws    = require("ws");
const { createClient } = require("@supabase/supabase-js");

axios.defaults.timeout = 15000;

const app  = express();
const PORT = process.env.PORT || 3000;

app.get("/",       (_req, res) => res.status(200).send("SNIPER V100 alive"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime(), running, ready, shuttingDown }));
app.get("/ready",  (_req, res) => (ready && !shuttingDown) ? res.status(200).send("ready") : res.status(503).send("not ready"));

// ── Environment ──────────────────────────────────────────────────
const BOT_TOKEN             = process.env.BOT_TOKEN             || "";
const CHAT_ID               = process.env.CHAT_ID               || ""; // private DM -- receives everything
const CHANNEL_ID            = process.env.CHANNEL_CHAT_ID       || ""; // BareTradeSignals -- receives intel + signals + closes
// Discord -- runs alongside Telegram, not a replacement. Two channels wired
// so far: #signals (fired trades) and #market-intel (narrative/intel alerts).
// #premium-signals and #information intentionally NOT wired yet.
const DISCORD_WEBHOOK_SIGNALS = process.env.DISCORD_WEBHOOK_SIGNALS || "";
const DISCORD_WEBHOOK_INTEL   = process.env.DISCORD_WEBHOOK_INTEL   || "";
const TWELVE_DATA_API_KEY   = process.env.TWELVE_DATA_API_KEY   || "";
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY || "";
const FINNHUB_API_KEY       = process.env.FINNHUB_API_KEY       || "";
const COINGECKO_API_KEY     = process.env.COINGECKO_API_KEY     || "";
const ALPACA_API_KEY    = process.env.ALPACA_API_KEY    || "";
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || "";
const ALPACA_BASE_URL   = process.env.ALPACA_BASE_URL   || "https://paper-api.alpaca.markets";
const POLYGON_API_KEY   = process.env.priceless_hermann || process.env.POLYGON_API_KEY || "";
const POLYGON_BASE_URL  = "https://api.massive.com";
const SUPABASE_URL          = process.env.SUPABASE_URL          || "";
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY  || "";

const supabaseEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      realtime: { transport: ws }  // required for Node 20 -- native WebSocket not available
    })
  : null;

if (supabaseEnabled) {
  console.log(`✅ Supabase enabled -- ${SUPABASE_URL}`);
} else {
  console.log("⚠️ Supabase DISABLED -- using local JSON (check SUPABASE_URL and SUPABASE_SERVICE_KEY)");
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILES    = {
  alerts: path.join(DATA_DIR, "alerts.json"),
  trades: path.join(DATA_DIR, "trades.json")
};

// ── Core constants ───────────────────────────────────────────────
const ACCOUNT_BALANCE     = 10000;
const BASE_RISK_PER_TRADE = 0.01;
const MAX_PORTFOLIO_RISK  = 0.08; // V98: raised from 5% -- allows 2-3 concurrent signals
const MAX_POSITIONS = { CRYPTO: 3, US: 2, LSE: 2 }; // V98: raised for subscription -- subscribers miss signals at 1
const ENABLE_CRYPTO = true;
const ENABLE_US     = true;
const ENABLE_LSE    = true;

const SCAN_INTERVAL_BULL_MS    = 60000;   // 60s in bull market
const SCAN_INTERVAL_BEAR_MS    = 120000;  // 2 mins in bear -- 90s was risking Yahoo rate limits (was 5mins)
const SCAN_INTERVAL_MS         = 60000;   // fallback default

// Returns current scan interval based on macro regime
function getScanInterval() {
  if (isMacroProtecting()) return SCAN_INTERVAL_BEAR_MS;
  return SCAN_INTERVAL_BULL_MS;
}
const POOL_REFRESH_INTERVAL_MS = 3600000;
const MAX_CONCURRENT_REQUESTS  = 1;  // TwelveData Basic 8/min -- serial requests stay well within limit
const STARTUP_DELAY_MS         = 5000;
const REQUEST_DELAY_MS         = 250;
const SCAN_TIMEOUT_MS          = 110000; // V99.1: raised from 75s -- cycle timeouts killing valid signals
const SHUTDOWN_EXIT_MS         = 5000;

// ================================================================
// V100: PREDICT. HUNT. STRIKE. RIDE.
// ================================================================
// SNIPER ENGINE -- priority-driven scanning architecture
// Tier 1 (HOT): heat >= 90  → scan every 12 seconds
// Tier 2 (WARM): heat 40-89 → scan every 30 seconds
// Tier 3 (COLD): everything else → normal 90s cycle
// Market Open Mode: 14:25-15:00 UK → Tier 1 scans every 8 seconds
// ================================================================
const SNIPER_HEAT_THRESHOLD    = 90;   // heat >= 90 = enters Sniper Mode
const SNIPER_LOOP_MS           = 12000; // 12 seconds for HOT assets
const SNIPER_OPEN_LOOP_MS      = 8000;  // 8 seconds during market open mode
const WARM_LOOP_MS             = 30000; // 30 seconds for WARM assets
const WARM_HEAT_THRESHOLD      = 40;   // heat 40-89 = WARM tier
const OPEN_MODE_START_MIN      = 865;  // 14:25 UK in minutes
const OPEN_MODE_END_MIN        = 900;  // 15:00 UK in minutes
const SNIPER_MAX_ASSETS        = 8;    // max assets in Sniper tier at once
const CONVICTION_ALERT_HEAT    = 60;   // heat >= 60 = post SNIPER WATCHING alert
const CACHE_TTL_MS             = 4 * 60 * 1000;
const CACHE_CLEANUP_MS         = 10 * 60 * 1000;
const MAX_SIGNAL_AGE_MINUTES   = 2;      // freshness protection -- reject stale candles

const CRYPTO_COOLDOWN = 2;
const US_COOLDOWN     = 2;  // V95: reduced from 4hrs -- allows re-entry on same name same day
const LSE_COOLDOWN    = 6;

const BREAKOUT_LOOKBACK = 10;
const MIN_RR            = 2.0;  // V100 HARDENED: raised from 1.8 -- EV over win rate
const TARGET_R          = 2.0;  // V100 HARDENED: targets must justify the risk

// ── V102 CANDIDATE: STRUCTURE QUALITY ENGINE ──────────────────────
// Scores the base/breakout structure feeding a setup, on top of the
// existing setup-type + momentum + regime scoring. Logs first,
// scores second, hard-rejects last -- staged rollout per module note.
const STRUCTURE_LOOKBACK = 30;

const STRUCTURE_BONUS_MAX   = 25;
const STRUCTURE_PENALTY_MAX = -25;

// Stocks / LSE
const STOCK_BREAKOUT_VOL_MIN        = 1.5;
const STOCK_BREAKOUT_VOL_STRONG     = 2.0;
const STOCK_BREAKOUT_CLOSE_MIN      = 0.60;
const STOCK_WEAK_CLOSE_MAX          = 0.40;
const STOCK_FOLLOW_THROUGH_VOL_MIN  = 1.2;
const STOCK_FOLLOW_THROUGH_BARS     = 5;
const STOCK_MAX_DISTRIBUTION_20     = 4;
const STOCK_BASE_MIN_BARS           = 10;
const STOCK_MIN_CONTRACTIONS        = 2;
const STOCK_LAST_VS_FIRST_VOL_MAX   = 0.70;
const STOCK_MAX_RETRACE_IMPULSE     = 0.50;

// Crypto
const CRYPTO_BREAKOUT_VOL_MIN       = 2.0;
const CRYPTO_BREAKOUT_VOL_STRONG    = 3.0;
const CRYPTO_CLIMAX_VOL             = 5.0;
const CRYPTO_BREAKOUT_CLOSE_MIN     = 0.50;
const CRYPTO_WEAK_CLOSE_MAX         = 0.50;
const CRYPTO_BASE_MIN_BARS          = 7;
const CRYPTO_MIN_CONTRACTIONS       = 2;
const CRYPTO_LAST_VS_FIRST_VOL_MAX  = 0.60;
const CRYPTO_MAX_RETRACE_IMPULSE    = 0.50;
const CRYPTO_FAIL_RETRACE           = 0.50;

// ── Thresholds ───────────────────────────────────────────────────
// Crypto 15-min
const CRYPTO_15M_MIN_MOMENTUM    = 0.002; // V100: lowered 15% per analysis -- 0.2% threshold catches earlier moves
const CRYPTO_15M_BREAKOUT_VOL    = 1.60;
const CRYPTO_15M_PULLBACK_VOL    = 1.20;
const CRYPTO_15M_EXTENSION_LIMIT = 0.08;
const CRYPTO_15M_BREAKOUT_DIST   = 0.03;
const CRYPTO_15M_MIN_PULLBACK    = 0.005;
const CRYPTO_15M_MAX_MOMENTUM    = 0.09;
const CRYPTO_PENDING_EXPIRY_HRS  = 0.75; // 45 mins -- crypto moves fast, stale limits cancel quickly

// V96: Tightened approved crypto list -- high conviction pairs only
// Removed AVAX, OP, ARB, SEI, APT, ATOM, PEPE, DOGE, XRP, ADA -- too noisy
const APPROVED_CRYPTO_PREFIXES = [
  "BTC","ETH","SOL",
  "LINK","SUI","NEAR","RENDER","ONDO","INJ",
  "TIA","FET","TAO","JUP","TON","BNB",
  "AAVE","UNI","EIGEN",
  "XRP",  // w/e 08-Jun-2026: liquidity magnet on risk-on rotation
  // V100 Sniper universe refresh -- narrative-driven additions
  "HYPE","AVAX","SEI","AERO","WLD","ARB","OP","STRK"
];

function isApprovedCrypto(symbol) {
  return APPROVED_CRYPTO_PREFIXES.some(p => symbol.startsWith(p));
}

// Standard US stocks (Mode 1)
const US_BREAKOUT_VOL_STD    = 1.40;
const US_PULLBACK_VOL_STD    = 1.20;
const EXTENSION_LIMIT_US_STD = 0.12; // was 0.10 -- regular session stocks can extend more
const BREAKOUT_DIST_US_STD   = 0.04;
const MOMENTUM_CAP_US_STD    = 0.08;
const MIN_US_MOMENTUM        = 0;    // no minimum -- EMA structure and setup checks do the filtering
const MIN_PULLBACK_MOM_US    = 0.002; // only pullbacks need some direction

// HIGH_BETA stocks (Mode 2) -- adaptive thresholds
const US_BREAKOUT_VOL_HB    = 1.20; // lower -- these have inherent volume
const US_PULLBACK_VOL_HB    = 1.10;
const EXTENSION_LIMIT_HB    = 0.20;
const EXTENSION_LIMIT_HB_OW = 0.35; // was 0.30 -- open momentum regularly overshoots
const BREAKOUT_DIST_HB      = 0.12; // 12% -- gaps exceed standard 4%
const MOMENTUM_CAP_HB       = 0.12; // 12% normal, 20% opening window
const MOMENTUM_CAP_HB_OW    = 0.20;
const MIN_US_SCORE_HB       = 74;   // V94 baseline (reverted from V97's 65)

// LSE -- UK large caps are slow grinders, not momentum runners
const LSE_BREAKOUT_VOL    = 1.05;  // was 1.15
const LSE_PULLBACK_VOL    = 1.05;
const BREAKOUT_DIST_LSE   = 0.025;
const EXTENSION_LIMIT_LSE = 0.06;
const MOMENTUM_CAP_LSE    = 0.04;
const MIN_LSE_MOMENTUM    = 0.001;  // was 0.0025 -- UK stocks grind at 0.1% per candle
const MIN_PULLBACK_MOM_LSE = 0.001;

const STOCK_MOMENTUM_OVERRIDE_ENABLED = true;
const STOCK_OVERRIDE_MIN_MOMENTUM     = 0.015;
const STOCK_OVERRIDE_MIN_VOL          = 1.40;
const STOCK_OVERRIDE_MAX_DISTANCE     = 0.025;

const MIN_GLOBAL_SCORE = 70; // V94 baseline (reverted from V100's 85)
const MIN_CRYPTO_SCORE = 72; // V94 baseline (reverted from V100's 88)
const MIN_US_SCORE     = 76; // V94 baseline (reverted from 68)
const MIN_LSE_SCORE    = 64; // V94 baseline (reverted from 60)

// V99.1: WIN RATE MODE -- five filters targeting 65-70% win rate
// (1) A* only for crypto (score 100+)
// (2) BTC must be bull -- no neutral override
// (3) Min heat source required before crypto entry
// (4) Dead zone filter: block crypto 01:00-07:00 UK (low vol, stop hunts)
// (5) Two consecutive above-average volume candles required
const CRYPTO_DEAD_ZONE_START = 60;   // 01:00 UK in minutes
const CRYPTO_DEAD_ZONE_END   = 420;  // 07:00 UK in minutes
const MIN_HEAT_FOR_CRYPTO    = 15;   // must have at least one watchlist or intel hit

const PENDING_EXPIRY_HOURS_US  = 12;
const PENDING_EXPIRY_HOURS_LSE = 24;
const MIN_CANDLES              = 40;  // standard requirement
const MIN_CANDLES_OPENING      = 8;   // V98: opening window only has 8-16 bars at 15min -- must accept fewer
const ATR_PERIOD               = 14;
const ATR_PULLBACK_MULTIPLIER  = 1.2;
const ATR_BREAKOUT_MULTIPLIER  = 1.5;
const ATR_IGNITION_MULTIPLIER  = 1.8;

const REPLACEMENT_SCORE_GAP           = 20;  // V98: raised from 6 -- only replace for sublime opportunity (20+ point advantage)
const REPLACEMENT_STALE_HOURS         = 3;
const REPLACEMENT_STALL_PROGRESS      = 0.3;
const REPLACEMENT_PROTECT_TP_PROGRESS = 0.7;
const FORCE_CLOSE_HOURS    = 4;
const FORCE_CLOSE_PROGRESS = 0.2;

// V98: MAX_POSITIONS defined above at line 117

// ── HIGH_BETA stock classification ───────────────────────────────
// These assets behave differently -- gap-and-go, high volatility,
// rarely retest EMA20 cleanly. Mode 2 scanner applies to these.
const HIGH_BETA_STOCKS = new Set([
  "ASTS","RKLB","LUNR","IONQ","OKLO","SMR","NNE","LEU","BWXT","AVAV","KTOS","RCAT",
  "ACHR","JOBY","MSTR","COIN","PLTR","MARA","RIOT","CLSK",
  "NVDA","AMD","AVGO","MRVL","VRT","SMCI","SOUN","BBAI",
  "RGTI","QBTS","ARM"
]);

function isHighBeta(symbol) { return HIGH_BETA_STOCKS.has(symbol); }

// BUG FIX (audit): TOP_HIGHBETA_5M was referenced at the Yahoo 5m→15m
// fallback but never declared anywhere -- guaranteed ReferenceError the
// first time Alpaca failed for a HIGH_BETA symbol. Comment there says
// "top 5 names only", so that's the intended scope.
const TOP_HIGHBETA_5M = [...HIGH_BETA_STOCKS].slice(0, 5);

// ── API rotation ─────────────────────────────────────────────────
const API_LIMITS = { twelvedata: 700, alphavantage: 20 };
let apiUsage     = { twelvedata: 0, alphavantage: 0, resetDay: -1 };

// V98: TwelveData per-minute rate limit guard
// Free tier = 8 requests/minute hard limit
// Without this, opening window hammers 23+ requests and TD returns errors
const TD_PER_MINUTE_LIMIT = 7; // stay under 8 with margin
let tdMinuteWindow = { count: 0, windowStart: 0 };

function canUseTDThisMinute() {
  const now = Date.now();
  if (now - tdMinuteWindow.windowStart > 60000) {
    tdMinuteWindow = { count: 0, windowStart: now };
  }
  if (tdMinuteWindow.count >= TD_PER_MINUTE_LIMIT) {
    log(`⚠️ TD per-minute limit hit (${tdMinuteWindow.count}/${TD_PER_MINUTE_LIMIT}) -- using Yahoo`);
    return false;
  }
  tdMinuteWindow.count++;
  return true;
}
let apiRotateIdx = 0;
let finnhubBlockedUntil = 0;

// ── Regime override ──────────────────────────────────────────────
const REGIME_OVERRIDE_MIN_VOL      = 1.6;  // V94 baseline
const REGIME_OVERRIDE_MIN_MOMENTUM = 0.010; // V94 baseline (1.0% on 15-min candle)

// ── 24hr momentum cache (used for maturity detection, not direct scoring) ──
const crypto24hrCache = new Map();
const CRYPTO_24HR_TTL = 15 * 60 * 1000;

// ── Dynamic injection ────────────────────────────────────────────
const DYNAMIC_INJECTION_THRESHOLD = 5;
const DYNAMIC_INJECTION_TTL_MS    = 2 * 60 * 60 * 1000;
const dynamicInjections           = new Map();

// ── Narrative change detection ───────────────────────────────────
let lastNarrativeState = { sectors: "", stockMovers: "", cryptoMovers: "" };

// ── Rejection stat tracking ──────────────────────────────────────
// V98: tracks why signals are blocked so you can see the bottleneck
// Posted to Bluejam daily at market close
// ── Rejection stat tracking ──────────────────────────────────────
const rejectStats = {};
const rejectByMarket = { CRYPTO: {}, US: {}, LSE: {} };
let rejectStatsDate = new Date().toDateString();
let lastHourlyRejectTime = 0;

// V102: per-asset diagnostic detail for the two dominant early-funnel
// rejects (momentum_low, no_setup) -- the plain counters above tell you
// HOW MANY, this tells you HOW CLOSE. Batched in memory, flushed once
// per scan cycle to sniper_signal_decisions (engine_version='V101') so
// this doesn't add a Supabase round-trip per asset in the hot path.
let rejectDiagnostics = [];

async function flushRejectDiagnostics() {
  if (rejectDiagnostics.length === 0) return;
  const rows = rejectDiagnostics;
  rejectDiagnostics = [];
  if (!supabase) return;
  try {
    const { error } = await retry(() => supabase.from("sniper_signal_decisions").insert(rows));
    if (error) log(`REJECT DIAGNOSTIC INSERT ERROR: ${error.message}`);
  } catch (e) { log(`REJECT DIAGNOSTIC INSERT ERROR: ${e.message}`); }
}

// V102: watchlist appearance log -- batched per watchlist-alert cycle,
// summarized on the Wednesday Bluejam check-in ("what's been on the
// watchlist this week"). Separate table from sniper_signal_decisions
// since this is "seen, not fired" rather than a reject.
let watchlistDiagnostics = [];

async function flushWatchlistDiagnostics() {
  if (watchlistDiagnostics.length === 0) return;
  const rows = watchlistDiagnostics;
  watchlistDiagnostics = [];
  if (!supabase) return;
  try {
    const { error } = await retry(() => supabase.from("watchlist_history").insert(rows));
    if (error) log(`WATCHLIST HISTORY INSERT ERROR: ${error.message}`);
  } catch (e) { log(`WATCHLIST HISTORY INSERT ERROR: ${e.message}`); }
}

// ── V100: Daily stats tracker ─────────────────────────────────
const dailyStats = {
  signalsFired:   0,
  tradesOpened:   0,
  tradesClosed:   0,
  wins:           0,
  losses:         0,
  forceClosed:    0,
  totalPnlPct:    0,
  biggestWin:     null,  // { asset, pct }
  biggestLoss:    null,  // { asset, pct }
  topAssets:      [],    // assets that fired signals today
  btcBullMins:    0,     // minutes BTC was bull
  btcNeutralMins: 0,
  cryptoSkipped:  0,     // breadth blocks
  date:           new Date().toDateString(),
};

function resetDailyStats() {
  dailyStats.signalsFired   = 0;
  dailyStats.tradesOpened   = 0;
  dailyStats.tradesClosed   = 0;
  dailyStats.wins           = 0;
  dailyStats.losses         = 0;
  dailyStats.forceClosed    = 0;
  dailyStats.totalPnlPct    = 0;
  dailyStats.biggestWin     = null;
  dailyStats.biggestLoss    = null;
  dailyStats.topAssets      = [];
  dailyStats.btcBullMins    = 0;
  dailyStats.btcNeutralMins = 0;
  dailyStats.cryptoSkipped  = 0;
  dailyStats.date           = new Date().toDateString();
}

// ── V100: Expected Value tracker -- north star metric ─────────
// EV = (Win Rate × Avg Win) − (Loss Rate × Avg Loss)
// Bot B (45% win, +10% avg, -3% loss) beats Bot A (80% win, +2% avg, -8% loss)
const evStats = {
  wins:       [],
  losses:     [],
  get winRate()  { const t = this.wins.length + this.losses.length; return t > 0 ? this.wins.length / t : 0; },
  get avgWin()   { return this.wins.length   > 0 ? this.wins.reduce((a,b)=>a+b,0)   / this.wins.length   : 0; },
  get avgLoss()  { return this.losses.length > 0 ? this.losses.reduce((a,b)=>a+b,0) / this.losses.length : 0; },
  get ev()       { return (this.winRate * this.avgWin) - ((1 - this.winRate) * Math.abs(this.avgLoss)); },
  get total()    { return this.wins.length + this.losses.length; },
};

// ── V100: Rejection log -- learns which filters earn their keep ─
// After 6 months: know exactly why trades were rejected
// and whether those rejections improved or hurt performance
const rejectionLog   = []; // { ticker, reasons, hunterScore, timestamp }
const MAX_REJECT_LOG = 500;

function logRejection(asset, reasons, hunterScore) {
  if (rejectionLog.length >= MAX_REJECT_LOG) rejectionLog.shift();
  rejectionLog.push({
    ticker:     asset,
    decision:   "REJECT",
    reasons:    [...reasons],
    hunterScore: hunterScore || 0,
    timestamp:  new Date().toISOString(),
  });
  if (reasons.length > 0) {
    log(`📋 REJECT LOG: ${asset} — ${reasons.slice(0,3).join(" | ")}`);
  }
}

function reject(reason, asset = "", market = "") {
  const today = new Date().toDateString();
  if (today !== rejectStatsDate) {
    Object.keys(rejectStats).forEach(k => delete rejectStats[k]);
    Object.keys(rejectByMarket).forEach(m => Object.keys(rejectByMarket[m]).forEach(k => delete rejectByMarket[m][k]));
    rejectStatsDate = today;
  }
  rejectStats[reason] = (rejectStats[reason] || 0) + 1;
  if (market && rejectByMarket[market]) {
    rejectByMarket[market][reason] = (rejectByMarket[market][reason] || 0) + 1;
  }
  if (asset) log(`⛔ ${asset} | reason=${reason}`);
}

async function buildRejectInsightLines() {
  if (!supabaseEnabled) return [];
  try {
    const since = new Date(Date.now() - 24*60*60*1000).toISOString();
    const { data, error } = await retry(() => supabase
      .from("sniper_signal_decisions")
      .select("reason, momentum, volume_ratio, notes")
      .eq("engine_version", "V101")
      .in("reason", ["momentum_low", "no_setup", "ema_fail", "regime"])
      .gte("created_at", since)
    );
    if (error || !data || data.length === 0) return [];

    const momLow   = data.filter(r => r.reason === "momentum_low");
    const noSetup  = data.filter(r => r.reason === "no_setup");
    const emaFail  = data.filter(r => r.reason === "ema_fail");
    const regime   = data.filter(r => r.reason === "regime");
    const lines_ = ["", "🔎 <b>WHAT TO ACTUALLY TWEAK</b>"];

    if (momLow.length > 0) {
      const barelyNeg = momLow.filter(r => r.momentum > -0.001).length;
      const barelyPct = Math.round((barelyNeg / momLow.length) * 100);
      const avgMom = momLow.reduce((s,r) => s + (r.momentum||0), 0) / momLow.length;
      lines_.push(`momentum_low: ${barelyPct}% were within 0.1% of the floor (avg ${(avgMom*100).toFixed(2)}%) -- ${barelyPct >= 70 ? "market genuinely flat, not a strict-gate problem" : "a meaningful chunk were clearly negative, gate looks correctly calibrated"}`);
    }
    if (noSetup.length > 0) {
      const avgVol = noSetup.reduce((s,r) => s + (r.volume_ratio||0), 0) / noSetup.length;
      const nearEmaCount = noSetup.filter(r => (r.notes||"").includes("nearEMA=true")).length;
      const nearEmaPct = Math.round((nearEmaCount / noSetup.length) * 100);
      const clearedVol = noSetup.filter(r => (r.volume_ratio||0) >= 1.5).length;
      const clearedPct = Math.round((clearedVol / noSetup.length) * 100);
      lines_.push(`no_setup: ${nearEmaPct}% were near EMA (right position) but avg volume was only ${avgVol.toFixed(2)}x, only ${clearedPct}% cleared 1.5x -- ${avgVol < 1.3 ? "bottleneck is volume/participation, not setup logic" : "mixed picture, worth a closer look at specific setup thresholds"}`);
    }
    if (emaFail.length > 0) {
      const deltas = emaFail.map(r => {
        const m = (r.notes||"").match(/ema20vsEma50=(-?[\d.]+)%/);
        return m ? parseFloat(m[1]) : null;
      }).filter(v => v !== null);
      const avgDelta = deltas.length ? deltas.reduce((s,v)=>s+v,0)/deltas.length : null;
      const closeCount = deltas.filter(v => Math.abs(v) < 0.3).length;
      const closePct = deltas.length ? Math.round((closeCount/deltas.length)*100) : 0;
      lines_.push(`ema_fail: ${emaFail.length} rejects${avgDelta !== null ? `, avg ema20-vs-ema50 gap ${avgDelta.toFixed(2)}%, ${closePct}% within 0.3% of passing` : ""} -- ${closePct >= 50 ? "trend structure is borderline, not clearly broken" : "trend genuinely not aligned for most of these"}`);
    }
    if (regime.length > 0) {
      const avgMom = regime.reduce((s,r) => s + (r.momentum||0), 0) / regime.length;
      const avgVol = regime.reduce((s,r) => s + (r.volume_ratio||0), 0) / regime.length;
      lines_.push(`regime: ${regime.length} rejects, avg momentum ${(avgMom*100).toFixed(2)}% / avg vol ${avgVol.toFixed(2)}x vs override needs ${(REGIME_OVERRIDE_MIN_MOMENTUM*100).toFixed(1)}%/${REGIME_OVERRIDE_MIN_VOL}x -- ${avgMom >= REGIME_OVERRIDE_MIN_MOMENTUM*0.7 ? "several were close to the override, not deeply blocked" : "regime is the real reason these didn't fire, not close to override"}`);
    }
    return lines_;
  } catch (e) {
    log(`⚠️ Reject insight query failed: ${e.message}`);
    return [];
  }
}

async function sendRejectStatsSummary() {
  const entries = Object.entries(rejectStats).sort((a,b) => b[1]-a[1]);
  if (entries.length === 0) return;
  const parts = [
    "📊 <b>DAILY BLOCK STATS</b>",
    "<i>Why signals were rejected today</i>",
    "",
    ...entries.map(([k,v]) => `  ${escapeHtml(k)}: <b>${v}</b>`),
    ""
  ];
  // Market breakdown
  for (const [mkt, stats] of Object.entries(rejectByMarket)) {
    const mktEntries = Object.entries(stats).sort((a,b) => b[1]-a[1]).slice(0,5);
    if (mktEntries.length === 0) continue;
    parts.push(`<b>${escapeHtml(mkt)}</b>`);
    mktEntries.forEach(([k,v]) => parts.push(`  ${escapeHtml(k)}: <b>${v}</b>`));
    parts.push("");
  }
  parts.push(...(await buildRejectInsightLines()));
  await safeRun("rejectStats", () => sendPrivate(lines(parts)));
}

async function sendEndOfDayReport() {
  // ── V100: End of Day Report ───────────────────────────────────
  // Accurate to the actual session -- pulls real data, not templates.
  // Posted to Bluejam (private) at market close -- not the public channel.

  const trades = await loadTrades();
  const today  = new Date().toDateString();

  // Gather today's closed trades
  const todayTrades = trades.filter(t =>
    t.outcome !== "OPEN" &&
    t.outcome !== "PENDING" &&
    t.closedAt &&
    new Date(t.closedAt).toDateString() === today
  );

  const wins        = todayTrades.filter(t => t.outcome === "WIN"  || t.realizedR > 0);
  const losses      = todayTrades.filter(t => t.outcome === "LOSS" || t.realizedR < 0);
  const openTrades  = trades.filter(t => t.outcome === "OPEN" || t.status === "FILLED");
  const total       = wins.length + losses.length;
  const winRate     = total > 0 ? Math.round((wins.length / total) * 100) : 0;
  const sorted      = [...todayTrades].sort((a,b) => (b.realizedR||0) - (a.realizedR||0));
  const best        = sorted[0];
  const worst       = sorted[sorted.length - 1];

  // ── Real session data ─────────────────────────────────────────
  // BTC / QQQ actual status
  const btcLine = btcTrend === "bull"    ? "₿ BTC: BULL 🟢"
                : btcTrend === "bear"    ? "₿ BTC: BEAR 🔴"
                : "₿ BTC: NEUTRAL 🟡";
  const qqqLine = qqqTrend === "bull"    ? "📈 QQQ: BULL 🟢"
                : qqqTrend === "risk_off" ? "📈 QQQ: RISK OFF 🔴"
                : "📈 QQQ: NEUTRAL 🟡";

  // Reject stats -- what actually blocked signals today
  const rejectEntries = Object.entries(rejectStats).sort((a,b) => b[1]-a[1]);
  const topBlocker    = rejectEntries[0]?.[0] || "none";
  const totalRejects  = rejectEntries.reduce((s,[,v]) => s+v, 0);
  const momLow        = rejectStats["momentum_low"] || 0;
  const macroBlocked  = rejectStats["macro_protection"] || 0;

  // Today's intel movers -- what the scanner actually watched
  const hotAssets  = getHotAssets().slice(0, 6);
  const watchNames = hotAssets.map(a => a.asset.replace("USDT","")).join(", ");

  // ── Condition summary (accurate to real numbers) ──────────────
  let conditionLine;
  if (macroBlocked > 20) {
    conditionLine = `Macro protection fired ${macroBlocked} times — BTC or QQQ not in a confirmed uptrend for most of the session. Scanner correctly held off.`;
  } else if (momLow > 100) {
    conditionLine = `Momentum was weak across most assets — ${momLow} setups rejected for insufficient price movement. Market was choppy rather than trending.`;
  } else if (momLow > 20) {
    conditionLine = `Mixed conditions — some momentum present but not enough assets showing clean directional moves for high-conviction entries.`;
  } else if (totalRejects < 20) {
    conditionLine = `Good conditions today — filters were largely clear. ${totalRejects > 0 ? `Only ${totalRejects} setups rejected across the session.` : "Very few rejections."}`;
  } else {
    conditionLine = `Scanner ran full session. Top blocker: ${topBlocker.replace(/_/g," ")} (${rejectEntries[0]?.[1] || 0} times).`;
  }

  // ── Build report ──────────────────────────────────────────────
  const dateStr = new Date().toLocaleDateString("en-GB", {weekday:"long", day:"numeric", month:"long"});
  const parts   = [
    `📊 <b>DAILY REPORT — ${dateStr}</b>`,
    ``,
    `<b>🌍 Session Overview</b>`,
    `${btcLine} | ${qqqLine}`,
    `${conditionLine}`,
    ``,
  ];

  // What the scanner was watching today (real names)
  if (watchNames) {
    parts.push(`<b>🔥 On the radar today</b>`);
    parts.push(`${watchNames}`);
    parts.push(``);
  }

  // Signals section
  if (total === 0 && openTrades.length === 0) {
    parts.push(`<b>📊 Signals fired: 0</b>`);
    if (macroBlocked > 20) {
      parts.push(`No entries taken — macro gate was protecting capital during uncertain conditions.`);
    } else {
      parts.push(`Scanner was active all session. No setup cleared the full confirmation checklist — momentum, volume, structure, and R:R all have to align. None did today.`);
    }
    parts.push(``);
  } else {
    parts.push(`<b>📊 Today's signals</b>`);
    if (total > 0) {
      parts.push(`✅ Won: ${wins.length}  ❌ Lost: ${losses.length}  📈 Win rate: ${winRate}%`);
    }
    if (openTrades.length > 0) {
      const openList = openTrades.map(t => t.asset.replace("USDT","")).join(", ");
      parts.push(`⏳ Still open: ${openList}`);
    }
    parts.push(``);
  }

  // Best trade
  if (best && best.realizedR > 0) {
    const pct = best.pnlPct ? `+${(best.pnlPct*100).toFixed(1)}%` : `+${best.realizedR.toFixed(1)}R`;
    parts.push(`<b>🏆 Best trade</b>`);
    parts.push(`${best.asset.replace("USDT","")} ${pct} — setup confirmed and played out as planned.`);
    parts.push(``);
  }

  // Worst trade
  if (worst && worst.realizedR < 0) {
    const pct = worst.pnlPct ? `${(worst.pnlPct*100).toFixed(1)}%` : `${worst.realizedR.toFixed(1)}R`;
    const reason = worst.outcome === "FORCE_CLOSE"
      ? "No progress after entry — bot exited early to protect capital."
      : "Stop loss hit. Loss was capped as planned.";
    parts.push(`<b>📉 Toughest trade</b>`);
    parts.push(`${worst.asset.replace("USDT","")} ${pct} — ${reason}`);
    parts.push(``);
  }

  // Tomorrow watchlist (real hot assets)
  if (hotAssets.length > 0) {
    parts.push(`<b>👀 Watching tomorrow</b>`);
    parts.push(`${watchNames}`);
    parts.push(`These showed the most activity today. If conditions align at open, these are first on the list.`);
    parts.push(``);
  }

  parts.push(`——————————`);
  parts.push(`⚠️ <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · @baretradesignals 🎯</i>`);

  await sendPrivate(lines(parts));
  log("📊 End of day report sent (private)");
}

async function sendHourlyRejectSummary() {
  if (!isUSMarketOpen()) return;
  if (Date.now() - lastHourlyRejectTime < 55 * 60 * 1000) return;
  const entries = Object.entries(rejectStats).sort((a,b) => b[1]-a[1]);
  if (entries.length === 0) return;
  lastHourlyRejectTime = Date.now();
  const parts = [
    "📊 <b>US SESSION REJECT SUMMARY</b>",
    "<i>What\'s blocking signals this session</i>",
    "",
    ...entries.slice(0, 8).map(([k,v]) => `  ${escapeHtml(k)}: <b>${v}</b>`),
    ""
  ];
  for (const [mkt, stats] of Object.entries(rejectByMarket)) {
    const mktEntries = Object.entries(stats).sort((a,b) => b[1]-a[1]).slice(0,3);
    if (mktEntries.length === 0) continue;
    parts.push(`<b>${escapeHtml(mkt)}</b>`);
    mktEntries.forEach(([k,v]) => parts.push(`  ${escapeHtml(k)}: <b>${v}</b>`));
    parts.push("");
  }
  await safeRun("hourlyRejects", () => sendPrivate(lines(parts)));
}
let lastNarrativeAlertTime = 0;        // timestamp of last intel post
let lastNarrativeSectors   = "";       // sectors string at last post
let narrativePostCount     = 0;        // posts today
let narrativePostCountDay  = -1;       // day counter for reset

// ── Pre-market price cache ───────────────────────────────────────
// Stores live Finnhub quotes fetched during morning briefing
// Used by analyse() during opening window to detect real moves
// before Yahoo 1h candles catch up
const preMarketPriceCache = new Map(); // sym -> { changePct, price, ts }
const PREMARKET_CACHE_TTL = 30 * 60 * 1000; // 30 mins

function setPreMarketPrice(sym, changePct, price) {
  preMarketPriceCache.set(sym, { changePct, price, ts: Date.now() });
}

function getPreMarketPrice(sym) {
  const entry = preMarketPriceCache.get(sym);
  if (!entry) return null;
  if (Date.now() - entry.ts > PREMARKET_CACHE_TTL) { preMarketPriceCache.delete(sym); return null; }
  return entry;
}

// ── Sector maps ──────────────────────────────────────────────────
const SECTOR_SYMBOLS = {
  // US sectors
  AI:         ["NVDA","PLTR","AMD","SMCI","MSFT","META","GOOGL","IONQ","CRWD","ANET","SOUN"],
  SPACE:      ["RKLB","LUNR","ASTS","ACHR","JOBY","SPCE","SPCX"],
  GOLD:       ["NEM","GOLD","AEM","WPM","KGC","SIL"],
  SILVER:     ["SIL","WPM","PAAS","AG"],
  CRYPTO:     ["COIN","MSTR","RIOT","CLSK","MARA"],
  ENERGY:     ["XOM","CVX","SLB","HAL","MPC"],
  DEFENSE:    ["LMT","RTX","NOC","GD","AVAV"],
  ROBOTICS:   ["ROK","ISRG","TER","TSLA"],
  NUCLEAR:    ["CCJ","NNE","SMR","UUUU","DNN","OKLO"],
  BIOTECH:    ["HIMS","MRNA","NVAX","SAVA","SMMT"],
  // UK sectors
  UK_BANKS:   ["BARC.L","LLOY.L","NWG.L","STAN.L","HSBA.L"],
  UK_ENERGY:  ["SHEL.L","BP.L"],
  UK_MINERS:  ["RIO.L","GLEN.L","AAL.L"],
  UK_DEFENSE: ["BA.L","RR.L"],
  UK_TELCO:   ["VOD.L"]
};

const NARRATIVE_KEYWORDS = {
  AI:       ["artificial intelligence","ai chip","machine learning","llm","gpu","nvidia","generative ai","openai","chatgpt"],
  SPACE:    ["rocket","launch","satellite","space","rocketlab","lunar","spacecraft","orbit","SpaceX"],
  GOLD:     ["gold price","gold rally","bullion","precious metals","safe haven"],
  SILVER:   ["silver price","silver rally","industrial metals"],
  CRYPTO:   ["bitcoin","ethereum","crypto rally","btc","eth","digital assets","blockchain","crypto surge"],
  ENERGY:   ["oil price","crude","energy rally","opec","natural gas"],
  DEFENSE:  ["defense spending","military","nato","geopolitical","weapons","pentagon","war"],
  ROBOTICS: ["robotics","automation","humanoid","manufacturing robot"],
  NUCLEAR:  ["nuclear energy","uranium","small modular reactor","smr","nuclear power"],
  BIOTECH:  ["weight loss","obesity","glp-1","biotech","fda approval","clinical trial","drug approval"]
};

const CRYPTO_AI_NAMES = ["RENDERUSDT","FETUSDT","NEARUSDT","TAOUSDT","AGIXUSDT","OCEANUSDT"];

// ── Static pools ─────────────────────────────────────────────────
const STATIC_CRYPTO_FALLBACK = [
  // Core -- always scan
  "BTCUSDT","ETHUSDT","XRPUSDT",
  // Elite momentum -- best blend of liquidity, narrative, volatility
  "SOLUSDT","SUIUSDT","HYPEUSDT","TAOUSDT","RENDERUSDT","ONDOUSDT","INJUSDT",
  // Strong momentum
  "AAVEUSDT","AVAXUSDT","SEIUSDT","AEROUSDT","WLDUSDT","LINKUSDT",
  // Narrative-active, kept from prior pool
  "NEARUSDT","TONUSDT","ARBUSDT","OPUSDT","TIAUSDT","STRKUSDT","JUPUSDT","FETUSDT","EIGENUSDT",
  "BNBUSDT",
];

const STATIC_STOCK_FALLBACK = [
  // AI infrastructure core
  "NVDA","AMD","AVGO","MRVL","VRT","SMCI",
  // AI application layer
  "PLTR",
  // Nuclear / SMR power -- one of the strongest active narratives
  "SMR","OKLO","NNE","LEU","BWXT",
  // Space
  "RKLB","ASTS","LUNR",
  // Defense / drone warfare -- narrative strength over daily ATR
  "KTOS","AVAV","RCAT",
  // Crypto-proxy equities
  "MARA","RIOT","CLSK","MSTR","COIN",
  // Quantum computing
  "RGTI","IONQ","QBTS",
  // Chips / robotics / eVTOL / speculative AI
  "ARM","JOBY","ACHR","SOUN","BBAI",
];

// LSE pool -- V100 REFRESH: trimmed to highest-beta names only.
// Sniper hunts 5-20% moves; UK blue chips (banks, insurers, oil majors,
// pharma) structurally don't produce that kind of single-day move.
// Kept only the names with genuine commodity/sector volatility.
const LSE_POOL = [
  // Defence & aerospace -- narrative active
  "BA.L","RR.L",
  // Miners -- highest-beta names on the index, commodity-driven swings
  "AAL.L","GLEN.L","FRES.L","RIO.L","ANTO.L",
  // Banking / energy / insurance -- requested additions
  "LLOY.L","SHEL.L","REL.L",
];

const CLEAN_TICKER = /^[A-Z]{1,5}$/;
const OTC_SUFFIXES = ["F","Y","PK"];

let STOCK_POOL   = [...new Set(STATIC_STOCK_FALLBACK)];
let CRYPTO_PAIRS = [...STATIC_CRYPTO_FALLBACK];
let HOT_SECTORS  = [];

// V102: always-scan lists -- merged into every refresh on top of the
// dynamic discovery portion (trendingCoins / trendingStocks+topMovers).
// Not a return to the old crowding-out bug: these are explicit,
// deliberate permanent adds, not the entire static fallback list.
const ALWAYS_SCAN_CRYPTO = ["STRKUSDT","WLDUSDT","UNIUSDT","OPUSDT","NEARUSDT"];
const ALWAYS_SCAN_STOCKS = ["BWXT","UBER","DDOG","SNOW","HOOD","ARM","META","HIMS","CRWD"];

// V98: HEAT SCORE -- tracks assets building momentum before signal fires
// TON was on watchlist + intel all day then ran +14% overnight
// Heat accumulates from: intel mention, watchlist hit, volume spikes, EMA alignment
// High heat = rescan more aggressively, relax breakout distance threshold
const HEAT_SCORES = new Map(); // asset → { score, lastUpdated, mentions }
const HEAT_DECAY_MS = 8 * 60 * 60 * 1000; // heat decays over 8 hours
const HEAT_HOT_THRESHOLD = 80; // above this = HOT ASSET

function addHeat(asset, points, reason) {
  const now = Date.now();
  const existing = HEAT_SCORES.get(asset) || { score: 0, lastUpdated: now, mentions: [] };
  // Apply time decay to existing score
  const ageHrs = (now - existing.lastUpdated) / 3600000;
  const decayed = existing.score * Math.max(0, 1 - (ageHrs / 8));

  // V100 FIX: prevent same-reason repeated mentions from stacking to ceiling.
  // Heat should reflect "is this still interesting RIGHT NOW", not
  // "how many times has intel mentioned this today". Without this,
  // an asset mentioned every cycle for an hour pins at 150 regardless
  // of whether its current candle is green or red.
  const recentSameReason = (existing.mentions || [])
    .filter(m => m.reason === reason && (now - m.time) < 30 * 60000) // last 30 mins
    .length;
  const diminished = recentSameReason >= 2 ? points * 0.3  // 3rd+ mention this half hour barely counts
                    : recentSameReason === 1 ? points * 0.6
                    : points;

  const newScore = Math.min(150, decayed + diminished);
  HEAT_SCORES.set(asset, {
    score: newScore,
    lastUpdated: now,
    mentions: [...(existing.mentions || []).slice(-5), { reason, time: now }]
  });
  if (newScore >= HEAT_HOT_THRESHOLD) {
    log(`🔥 HEAT: ${asset} = ${newScore.toFixed(0)} (${reason}) -- HOT ASSET`);
  }
}

function getHeat(asset) {
  const h = HEAT_SCORES.get(asset);
  if (!h) return 0;
  const ageHrs = (Date.now() - h.lastUpdated) / 3600000;
  return Math.max(0, h.score * (1 - ageHrs / 8));
}

function getHotAssets() {
  return [...HEAT_SCORES.entries()]
    .map(([asset, h]) => ({ asset, heat: getHeat(asset) }))
    .filter(x => x.heat >= HEAT_HOT_THRESHOLD)
    .sort((a, b) => b.heat - a.heat);
}

// ── Runtime state ────────────────────────────────────────────────
let running         = false;
let refreshingPools = false;
let shuttingDown    = false;
let ready           = false;
let fatalTriggered  = false;
let btcTrend        = "neutral";
let cycleCount      = 0;
let lastSignalTime    = 0;
let lastWatchlistTime = Date.now();
let lastWatchlistKey  = "";
const assetFailCooldown = new Map(); // V100: per-asset Yahoo failure cooldown -- prevents retry spam

// In-memory cache -- persists across scan cycles even when Supabase/local JSON fails
// This is the primary dedup layer; Supabase is secondary persistence
let _alertsCache = null;
let _tradesCache = null;

async function loadAlertsCached() {
  if (_alertsCache !== null) return _alertsCache;
  _alertsCache = await loadAlerts();
  return _alertsCache;
}

async function loadTradesCached() {
  if (_tradesCache !== null) return _tradesCache;
  _tradesCache = await loadTrades();
  return _tradesCache;
}

async function saveAlertsCached(alerts) {
  _alertsCache = alerts;
  await saveAlerts(alerts);
}

async function saveTradesCached(trades) {
  _tradesCache = trades;
  await saveTrades(trades);
}
let qqqTrend        = "neutral";
let marketWasOpen   = { CRYPTO: false, US: false, LSE: false };

const candleCache     = new Map();
let cacheCleanupTimer = null;

// ── V100: Regime state ──────────────────────────────────────────
// BTC runs crypto. QQQ runs US stocks. Separate gates, no crossover.
let btcMacroTrend    = "neutral"; // 4h BTC -- crypto gate
let qqqBullCount     = 0;         // consecutive bull readings on QQQ
let macroProtecting  = false;     // true = capital protection active
let lastMacroAlert   = 0;         // throttle protection alerts (3hr)
let lastLeaderboardCheck = 0;     // V101: throttle momentum leaderboard checks (~12 min)
let sniperTimer       = null;  // fast loop timer
let warmTimer         = null;  // warm loop timer
let sniperRunning     = false; // prevent overlapping sniper cycles
let warmRunning       = false; // prevent overlapping warm cycles
let convictionPosted  = new Set(); // assets already posted SNIPER WATCHING today
let convictionDay     = -1;        // day counter for reset
let sniperHitCount    = 0;     // signals fired from sniper loop today
const SNIPER_ASSETS   = new Map(); // asset -> { market, heat, promotedAt }
let cycleTimer        = null;
let refreshTimer      = null;
let server            = null;

// ── Utilities ────────────────────────────────────────────────────
function nowIso()         { return new Date().toISOString(); }
function log(...args)     { console.log(`[${nowIso()}]`, ...args); }
function sleep(ms)        { return new Promise(r => setTimeout(r, ms)); }
async function throttle() { await sleep(REQUEST_DELAY_MS); }
function dedup(arr)       { return [...new Set(arr.filter(Boolean))]; }
function avg(arr)         { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

function ema(values, period) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return NaN;
  const k = 2 / (period + 1);
  let out = clean[0];
  for (let i = 1; i < clean.length; i++) out = clean[i] * k + out * (1 - k);
  return out;
}

function hoursAgo(ts) {
  if (!ts) return Infinity;
  return (Date.now() - new Date(ts).getTime()) / 36e5;
}

function formatPrice(value, market) {
  if (!Number.isFinite(value)) return "n/a";
  if (market === "LSE") return `\u00a3${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function escapeHtml(v) {
  return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function lines(parts) { return parts.join("\n"); }

function ensureFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of Object.values(FILES)) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[]");
  }
}

function loadLocal(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function saveLocal(file, data) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

async function retry(fn, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) { if (i === retries) throw e; await sleep(delay * Math.pow(2,i)); }
  }
}

async function withTimeout(promise, ms, label) {
  let timeout;
  const timer = new Promise((_,reject) => { timeout = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms); });
  try { return await Promise.race([promise, timer]); }
  finally { clearTimeout(timeout); }
}

async function safeRun(name, fn) {
  try { return await fn(); }
  catch (err) { log(`SAFE RUN ERROR (${name}):`, err?.message||err); return null; }
}

function getCached(key) {
  const entry = candleCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { candleCache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) { candleCache.set(key, { ts: Date.now(), data }); }

function cleanupCandleCache() {
  const now = Date.now();
  for (const [key,value] of candleCache.entries()) {
    if (!value?.ts || now - value.ts > CACHE_TTL_MS) candleCache.delete(key);
  }
}

function clearRuntimeTimers() {
  if (cycleTimer)        { clearTimeout(cycleTimer);         cycleTimer        = null; }
  if (refreshTimer)      { clearTimeout(refreshTimer);       refreshTimer      = null; }
  if (cacheCleanupTimer) { clearInterval(cacheCleanupTimer); cacheCleanupTimer = null; }
  if (sniperTimer)       { clearTimeout(sniperTimer);        sniperTimer       = null; } // V100
  if (warmTimer)         { clearTimeout(warmTimer);          warmTimer         = null; } // V100
}

function isCleanTicker(sym) {
  if (!CLEAN_TICKER.test(sym)) return false;
  if (sym.length === 5 && OTC_SUFFIXES.some(s => sym.endsWith(s))) return false;
  return true;
}

// ── BST-accurate UK time ─────────────────────────────────────────
function getUkNowParts() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday:"short", hour:"2-digit", minute:"2-digit", hour12: false
  });
  const map = {};
  for (const p of fmt.formatToParts(new Date())) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return map;
}

function getUkDayIndex() {
  const map = { Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6 };
  return map[getUkNowParts().weekday] ?? 0;
}

function getUkMinutes() {
  const { hour, minute } = getUkNowParts();
  return Number(hour)*60 + Number(minute);
}

function isWeekend()  { const d = getUkDayIndex(); return d===0||d===6; }
function isWeekday()  { return !isWeekend(); }

// ── Market holidays (2026) ──────────────────────────────────────
// V100: prevents wasted scans + stale/misleading intel on market-closed days.
// Crypto has no holidays (24/7) so this only applies to US and LSE.
// Update this list each year -- dates are UK-local calendar dates (YYYY-MM-DD).
function getUkDateString() {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }); // en-CA gives YYYY-MM-DD
  return fmt.format(new Date());
}

const US_MARKET_HOLIDAYS_2026 = new Set([
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King Jr. Day
  "2026-02-16", // Washington's Birthday (Presidents' Day)
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed, July 4 falls on Saturday)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day
]);

const LSE_MARKET_HOLIDAYS_2026 = new Set([
  "2026-01-01", // New Year's Day
  "2026-04-03", // Good Friday
  "2026-04-06", // Easter Monday
  "2026-05-04", // Early May Bank Holiday
  "2026-05-25", // Spring Bank Holiday
  "2026-08-31", // Summer Bank Holiday
  "2026-12-25", // Christmas Day
  "2026-12-28", // Boxing Day (observed)
]);

function isUSMarketHoliday()  { return US_MARKET_HOLIDAYS_2026.has(getUkDateString()); }
function isLSEMarketHoliday() { return LSE_MARKET_HOLIDAYS_2026.has(getUkDateString()); }

// ── Named gates ──────────────────────────────────────────────────
function shouldScanCrypto() {
  if (!ENABLE_CRYPTO || !isCryptoWindowOpen()) return false;
  // V99.1: dead zone filter -- 01:00-07:00 UK has low volume and high stop-hunt risk
  const mins = getUkMinutes();
  if (mins >= CRYPTO_DEAD_ZONE_START && mins < CRYPTO_DEAD_ZONE_END) {
    // Allow scanning if HOT asset exists -- don't miss a TON-style overnight spike
    const hasHotAsset = getHotAssets().some(a => a.heat >= 80);
    if (!hasHotAsset) return false;
    log(`⏰ Dead zone but HOT asset detected -- scanning`);
  }
  return true;
}
function shouldScanUS()           { return ENABLE_US  && isWeekday() && !isUSMarketHoliday()  && isUSMarketOpen(); }
function shouldScanLSE()          { return ENABLE_LSE && isWeekday() && !isLSEMarketHoliday() && isLSEMarketOpen(); }
function shouldSendStockAlerts() {
  if (!isWeekday()) return false;
  if (isUSMarketHoliday() && isLSEMarketHoliday()) return false; // both closed -- no point posting intel
  const mins = getUkMinutes();
  // V99.1: intel fires from LSE open (08:00 UK = 480 mins) through US close (21:00 UK = 1260 mins)
  // Previously only fired during market hours -- now includes US pre-market (14:30) setup window
  // LSE opens 08:00, US pre-market movers visible from 13:00, US opens 14:30, closes 21:00
  return mins >= 480 && mins < 1260;
}
function shouldSendCryptoAlerts() { return isCryptoWindowOpen(); }

// ── Market hours ─────────────────────────────────────────────────
function isMarketOpen(market) {
  const mins = getUkMinutes();
  if (market === "CRYPTO") return mins >= 360 && mins < 1320;
  if (isWeekend()) return false;
  if (market === "US")  return !isUSMarketHoliday()  && mins >= 870 && mins < 1260;
  if (market === "LSE") return !isLSEMarketHoliday() && mins >= 480 && mins < 990;
  return false;
}

function isCryptoWindowOpen() { return true; } // 24/7 -- no time restriction
function isUSMarketOpen()     { return isMarketOpen("US"); }
function isLSEMarketOpen()    { return isMarketOpen("LSE"); }

function isUSOpeningWindow() {
  if (isWeekend()) return false;
  const m = getUkMinutes();
  return m >= 870 && m < 1080; // V96: extended 14:30-18:00 UK -- full active US session
}

// ── API management ───────────────────────────────────────────────
function resetApiUsageIfNewDay() {
  const day = new Date().getUTCDate();
  if (apiUsage.resetDay !== day) {
    apiUsage = { twelvedata:0, alphavantage:0, resetDay:day };
    apiRotateIdx = 0;
    log("🔄 API usage reset");
  }
}

function pickApiForSymbol() {
  resetApiUsageIfNewDay();
  const tdOk = TWELVE_DATA_API_KEY && apiUsage.twelvedata < API_LIMITS.twelvedata;
  const avOk = ALPHA_VANTAGE_API_KEY && apiUsage.alphavantage < API_LIMITS.alphavantage;
  if (!tdOk && !avOk) return "yahoo";
  if (!tdOk) return "alphavantage";
  if (!avOk) return "twelvedata";
  apiRotateIdx++;
  return apiRotateIdx % 2 === 0 ? "twelvedata" : "alphavantage";
}

function canUseFinnhub() { return !!FINNHUB_API_KEY && Date.now() > finnhubBlockedUntil; }
function blockFinnhub(minutes = 10) {
  finnhubBlockedUntil = Date.now() + minutes*60*1000;
  log(`\u26a0\ufe0f Finnhub blocked ${minutes} mins`);
}

async function safeRequest(fn, label = "request") {
  try {
    await throttle();
    return await fn();
  } catch (e) {
    const msg = e?.message||"Unknown";
    if ((msg.includes("429")||e?.response?.status===429) && label.toLowerCase().includes("finnhub")) blockFinnhub();
    log(`\u26a0\ufe0f ${label} failed: ${msg}`);
    return null;
  }
}

// ── Supabase ─────────────────────────────────────────────────────
async function loadAlerts() {
  if (!supabaseEnabled) return loadLocal(FILES.alerts, []);
  try {
    const { data, error } = await retry(() =>
      supabase.from("alerts").select("*").order("sentAt",{ascending:false}).limit(1000)
    );
    if (error) {
      log(`❌ Supabase loadAlerts error: ${error.message} -- falling back to local`);
      return loadLocal(FILES.alerts, []);
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    log(`❌ Supabase loadAlerts exception: ${e.message} -- falling back to local`);
    return loadLocal(FILES.alerts, []);
  }
}

async function loadTrades() {
  if (!supabaseEnabled) return loadLocal(FILES.trades, []);
  try {
    const { data, error } = await retry(() =>
      supabase.from("trades").select("*").order("sentAt",{ascending:false}).limit(1000)
    );
    if (error) {
      log(`❌ Supabase loadTrades error: ${error.message} -- falling back to local`);
      return loadLocal(FILES.trades, []);
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    log(`❌ Supabase loadTrades exception: ${e.message} -- falling back to local`);
    return loadLocal(FILES.trades, []);
  }
}

async function saveAlerts(alerts) {
  const b = Array.isArray(alerts) ? alerts.slice(-1000) : [];
  saveLocal(FILES.alerts, b); // always save locally as backup
  if (!supabaseEnabled) return;
  try {
    const { error } = await retry(() => supabase.from("alerts").upsert(b, { onConflict: "id" }));
    if (error) {
      log(`❌ Supabase saveAlerts error: ${error.message} (code: ${error.code})`);
    } else {
      log(`✅ Supabase alerts saved (${b.length} records)`);
    }
  } catch (e) {
    log(`❌ Supabase saveAlerts exception: ${e.message}`);
  }
}

async function saveTrades(trades) {
  const b = Array.isArray(trades) ? trades.slice(-1000) : [];
  saveLocal(FILES.trades, b); // always save locally as backup
  if (!supabaseEnabled) return;
  try {
    const { error } = await retry(() => supabase.from("trades").upsert(b, { onConflict: "id" }));
    if (error) {
      log(`❌ Supabase saveTrades error: ${error.message} (code: ${error.code})`);
    } else {
      log(`✅ Supabase trades saved (${b.length} records)`);
    }
  } catch (e) {
    log(`❌ Supabase saveTrades exception: ${e.message}`);
  }
}

// ── Telegram ─────────────────────────────────────────────────────
// sendPrivate(msg)  -- your personal DM only. EVERYTHING goes here.
// sendChannel(msg)  -- BareTradeSignals channel only. Signals + intel + closes.
//
// Call sites:
//   sendPrivate  -- boot, market open/close, fills, errors, system messages
//   sendChannel  -- market intel, trade signals, close results
//   both         -- call sendPrivate then sendChannel where needed

async function sendPrivate(msg) {
  if (!BOT_TOKEN || !CHAT_ID) { log(msg); return; }
  try {
    await retry(() => axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID, text: msg, parse_mode: "HTML"
    }, { timeout: 10000 }));
  } catch (e) { log(`TELEGRAM PRIVATE ERROR: ${e.message}`); }
}

async function sendChannel(msg) {
  if (!BOT_TOKEN || !CHANNEL_ID) return; // silently skip if no channel configured
  try {
    await retry(() => axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHANNEL_ID, text: msg, parse_mode: "HTML"
    }, { timeout: 10000 }));
  } catch (e) { log(`TELEGRAM CHANNEL ERROR: ${e.message}`); }
}

// ── Discord (runs alongside Telegram) ───────────────────────────
// Telegram messages are built with HTML parse_mode (<b>, <i>). Discord
// webhooks take plain content with Markdown, so convert rather than
// send raw HTML tags through.
function telegramHtmlToDiscordMarkdown(html) {
  return html
    .replace(/<b>(.*?)<\/b>/gs, "**$1**")
    .replace(/<i>(.*?)<\/i>/gs, "*$1*")
    .replace(/<[^>]+>/g, ""); // strip anything else rather than leak raw tags
}

async function sendDiscord(webhookUrl, msg) {
  if (!webhookUrl) return; // not configured yet -- safe no-op
  try {
    const content = telegramHtmlToDiscordMarkdown(msg).slice(0, 1900); // Discord's 2000-char cap
    await retry(() => axios.post(webhookUrl, { content }, { timeout: 10000 }));
  } catch (e) { log(`DISCORD ERROR: ${e.message}`); }
}

async function sendSignalsChannels(msg) {
  await sendChannel(msg);
  await sendDiscord(DISCORD_WEBHOOK_SIGNALS, msg);
}

async function sendIntelChannels(msg) {
  await sendChannel(msg);
  await sendDiscord(DISCORD_WEBHOOK_INTEL, msg);
}

// Convenience -- sends to BOTH private and channel
async function sendBoth(msg) {
  await sendPrivate(msg);
  await sleep(300);
  await sendChannel(msg);
}

// ── ATR ──────────────────────────────────────────────────────────
function calculateATR(candles, period = ATR_PERIOD) {
  if (!candles || candles.length < period+1) return null;
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i], prevClose = candles[i-1].close;
    if (!Number.isFinite(high)||!Number.isFinite(low)||!Number.isFinite(prevClose)) continue;
    trValues.push(Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose)));
  }
  if (trValues.length < period) return null;
  let atr = avg(trValues.slice(0, period));
  for (let i = period; i < trValues.length; i++) atr = ((atr*(period-1))+trValues[i])/period;
  return atr;
}

// ================================================================
// MOVE MATURITY ENGINE -- V90 core innovation
// ================================================================

// Stage classification based on ATR expansion ratio
// Compares recent volatility to historical baseline
function getMoveMaturity(candles) {
  if (!candles || candles.length < 35) return "unknown";
  const atrCurrent  = calculateATR(candles.slice(-15), 14);
  const atrBaseline = calculateATR(candles.slice(-35, -15), 14);
  if (!atrCurrent || !atrBaseline || atrBaseline === 0) return "unknown";

  const atrRatio = atrCurrent / atrBaseline;

  if (atrRatio < 1.2) return "base";          // Stage 1 -- consolidating, flat
  if (atrRatio < 2.0) return "expansion";     // Stage 2 -- first leg, best entry
  if (atrRatio < 3.2) return "continuation";  // Stage 3 -- healthy trend, good entry
  return "climax";                             // Stage 4 -- exhaustion risk, penalise
}

// Is momentum accelerating (candles getting bigger) or decelerating?
function getMomentumProfile(candles) {
  if (!candles || candles.length < 8) return { accelerating: false, decelerating: false };
  const recent = candles.slice(-7);
  const bodies  = recent.map((c,i) => {
    if (i === 0) return 0;
    const prev = recent[i-1].close;
    return prev > 0 ? Math.abs(c.close - prev) / prev : 0;
  }).slice(1);

  const firstHalf  = avg(bodies.slice(0, 3));
  const secondHalf = avg(bodies.slice(3));

  return {
    accelerating: secondHalf > firstHalf * 1.2,
    decelerating: secondHalf < firstHalf * 0.7,
    firstHalf,
    secondHalf
  };
}

// How many consecutive bars above 2x average volume? (1 = breakout, 5+ = climax)
function getVolumeProfile(candles) {
  if (!candles || candles.length < 20) return { highVolBars: 0, singleSpike: false };
  const volumes    = candles.slice(-10).map(c => c.volume);
  const avgVol     = avg(candles.slice(-30, -10).map(c => c.volume));
  const highVolBars = volumes.filter(v => v > avgVol*2).length;
  const singleSpike = highVolBars === 1; // breakout candle only -- early stage
  return { highVolBars, singleSpike, avgVol };
}

// How big is the 24hr move measured in ATR units (volatility-adjusted)
function getMoveInATRUnits(pct24h, candles) {
  const atrBaseline = calculateATR(candles.slice(-35, -15), 14);
  const price       = candles.at(-1)?.close;
  if (!atrBaseline || !price || price === 0) return 0;
  const atrPct = atrBaseline / price;
  return atrPct > 0 ? Math.abs(pct24h) / atrPct : 0;
}

// Hard block: returns true when asset shows exhaustion across multiple signals
// OSMO +200% = exhaustion score 8-9 -> blocked
// SUI +11% building = exhaustion score 0-1 -> passes
function isParabolicExhaustion(candles, pct24h, regime = "neutral") {
  if (!candles || candles.length < 35) return false;
  const maturity    = getMoveMaturity(candles);
  const volProfile  = getVolumeProfile(candles);
  const profile     = getMomentumProfile(candles);
  const atrUnits    = getMoveInATRUnits(pct24h, candles);

  let exhaustionScore = 0;
  if (maturity === "climax")            exhaustionScore += 3;
  if (atrUnits > 6)                     exhaustionScore += 3;
  else if (atrUnits > 4)                exhaustionScore += 2;
  if (volProfile.highVolBars >= 5)      exhaustionScore += 2;
  else if (volProfile.highVolBars >= 3) exhaustionScore += 1;
  if (profile.decelerating)             exhaustionScore += 1;

  if (exhaustionScore >= 5) {
    log(`🚫 Parabolic exhaustion (score=${exhaustionScore} maturity=${maturity} atrUnits=${atrUnits.toFixed(1)} highVolBars=${volProfile.highVolBars})`);
    return true;
  }
  return false;
}

// AUDIT FLAG: this was one of two functions both named isFirstPullbackContinuation.
// Because of JS function-declaration hoisting, EVERY call site in the file has
// always silently run the OTHER definition (search "NEAR/JUP pattern" below) --
// this one has been dead code since whenever the second was added. Renamed here
// so it stops shadowing; behavior is UNCHANGED (still dead). Decide if this
// Stage-3-taper logic should replace the live one, run alongside it, or be deleted.
//
// Detects Stage 3 entry: big candle -> consolidation -> continuation
// The most reliable missed entry in the current system
function isFirstPullbackContinuation_STAGE3_TAPER_DEADCODE(candles) {
  if (!candles || candles.length < 15) return false;
  const recent  = candles.slice(-10);
  const volumes = recent.map(c => c.volume);
  const avgVol  = avg(candles.slice(-30, -10).map(c => c.volume));
  if (avgVol === 0) return false;

  // Find the expansion candle -- highest volume in window
  let expansionIdx = 0, maxVol = 0;
  for (let i = 0; i < recent.length - 2; i++) {
    if (volumes[i] > maxVol) { maxVol = volumes[i]; expansionIdx = i; }
  }

  if (maxVol < avgVol * 2.5)               return false; // No real expansion
  if (expansionIdx > recent.length - 4)    return false; // Too recent, no pullback yet

  // Volume tapering after expansion = consolidation
  const postVols    = volumes.slice(expansionIdx+1);
  const taperExists = postVols.some(v => v < maxVol * 0.5);

  // Price held above expansion candle open (with tolerance)
  const expansionClose = recent[expansionIdx].close;
  const currentClose   = recent.at(-1).close;
  const priceHeld      = currentClose > expansionClose * 0.97;

  return taperExists && priceHeld;
}

// Gap detection: first candle vs prior candle -- did price gap up?
function detectGap(candles) {
  if (!candles || candles.length < 3) return { gapped: false, gapPct: 0 };
  // In a session open, compare first few candles to prior session
  // Use close of candle[n-6] as "prior close" proxy
  const priorClose   = candles.at(-7)?.close;
  const openingClose = candles.at(-5)?.close; // a few candles in
  if (!priorClose || !openingClose || priorClose === 0) return { gapped: false, gapPct: 0 };
  const gapPct = (openingClose - priorClose) / priorClose;
  return { gapped: gapPct >= 0.05, gapPct };
}

// ── V102 CANDIDATE: STRUCTURE QUALITY ENGINE -- helpers ────────────
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function safeNum(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function isCryptoMarket(market) {
  return market === "CRYPTO";
}

function getCloseLocationInRange(candle) {
  if (!candle) return 0.5;
  const high = safeNum(candle.high);
  const low = safeNum(candle.low);
  const close = safeNum(candle.close);
  const range = high - low;
  if (!Number.isFinite(range) || range <= 0) return 0.5;
  return clamp((close - low) / range, 0, 1);
}

function getAverageVolumeBeforeIndex(candles, idx, market) {
  const lookback = isCryptoMarket(market) ? 20 : 50;
  const start = Math.max(0, idx - lookback);
  const vols = candles.slice(start, idx).map(c => safeNum(c.volume)).filter(v => v > 0);
  return vols.length ? avg(vols) : 0;
}

function getVolumeRatioAtIndex(candles, idx, market) {
  if (!candles[idx]) return 0;
  const baseVol = getAverageVolumeBeforeIndex(candles, idx, market);
  if (!baseVol) return 0;
  return safeNum(candles[idx].volume) / baseVol;
}

function findRecentBreakoutIndex(candles, lookback = BREAKOUT_LOOKBACK, market = "US") {
  if (!candles || candles.length < lookback + 5) return null;
  const start = Math.max(5, candles.length - lookback - 3);

  for (let i = candles.length - 2; i >= start; i--) {
    const c = candles[i];
    const prev = candles.slice(Math.max(0, i - lookback), i);
    if (!prev.length) continue;

    const priorHigh = Math.max(...prev.map(x => safeNum(x.high)));
    const close = safeNum(c.close);
    const volRatio = getVolumeRatioAtIndex(candles, i, market);

    const minVol = isCryptoMarket(market) ? CRYPTO_BREAKOUT_VOL_MIN : STOCK_BREAKOUT_VOL_MIN;
    if (close > priorHigh && volRatio >= minVol) return i;
  }
  return null;
}

function getPivotLows(values, left = 2, right = 2) {
  const out = [];
  for (let i = left; i < values.length - right; i++) {
    const v = values[i];
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (values[j] <= v) { isLow = false; break; }
    }
    if (isLow) out.push(i);
  }
  return out;
}

function getContractionSegments(baseCandles) {
  if (!baseCandles || baseCandles.length < 6) return [];
  const lows = baseCandles.map(c => safeNum(c.low));
  const highs = baseCandles.map(c => safeNum(c.high));
  const vols = baseCandles.map(c => safeNum(c.volume));
  const pivots = getPivotLows(lows, 2, 2);
  if (pivots.length < 2) return [];

  const segments = [];
  for (let k = 1; k < pivots.length; k++) {
    const a = pivots[k - 1];
    const b = pivots[k];
    const windowHigh = Math.max(...highs.slice(a, b + 1));
    const windowLow = Math.min(...lows.slice(a, b + 1));
    const depth = windowHigh > 0 ? (windowHigh - windowLow) / windowHigh : 0;
    const vol = avg(vols.slice(a, b + 1).filter(v => v > 0));
    segments.push({ start: a, end: b, depth, avgVolume: vol });
  }
  return segments;
}

function analyzeBaseStructure(candles, breakoutIdx, market) {
  if (breakoutIdx == null || breakoutIdx < 6) {
    return {
      baseLengthBars: 0,
      contractionCount: 0,
      contractionDepths: [],
      contractionTightening: false,
      lastVsFirstContractionVol: 1,
      retracePctOfImpulse: 1,
      followThroughCount: 0
    };
  }

  const baseStart = Math.max(0, breakoutIdx - STRUCTURE_LOOKBACK);
  const baseCandles = candles.slice(baseStart, breakoutIdx);
  const baseLengthBars = baseCandles.length;

  const segments = getContractionSegments(baseCandles);
  const contractionDepths = segments.map(s => s.depth).filter(Number.isFinite);
  const contractionCount = contractionDepths.length;

  let contractionTightening = false;
  if (contractionDepths.length >= 2) {
    contractionTightening = true;
    for (let i = 1; i < contractionDepths.length; i++) {
      if (contractionDepths[i] > contractionDepths[i - 1] * 1.05) {
        contractionTightening = false;
        break;
      }
    }
  }

  const firstVol = segments[0]?.avgVolume || 0;
  const lastVol = segments[segments.length - 1]?.avgVolume || 0;
  const lastVsFirstContractionVol = firstVol > 0 ? lastVol / firstVol : 1;

  const breakoutCandle = candles[breakoutIdx];
  const breakoutClose = safeNum(breakoutCandle?.close);

  const baseLow = baseCandles.length ? Math.min(...baseCandles.map(c => safeNum(c.low))) : breakoutClose;
  const baseHigh = baseCandles.length ? Math.max(...baseCandles.map(c => safeNum(c.high))) : breakoutClose;
  const impulse = Math.max(0, baseHigh - baseLow);
  const retracePctOfImpulse = impulse > 0 ? (baseHigh - baseCandles[baseCandles.length - 1].close) / impulse : 0;

  let followThroughCount = 0;
  const maxBars = isCryptoMarket(market) ? 3 : STOCK_FOLLOW_THROUGH_BARS;
  for (let i = breakoutIdx + 1; i < Math.min(candles.length, breakoutIdx + 1 + maxBars); i++) {
    const c = candles[i];
    const volRatio = getVolumeRatioAtIndex(candles, i, market);
    const minVol = isCryptoMarket(market) ? 1.0 : STOCK_FOLLOW_THROUGH_VOL_MIN;
    if (safeNum(c.close) >= breakoutClose && volRatio >= minVol) followThroughCount++;
  }

  return {
    baseLengthBars,
    contractionCount,
    contractionDepths,
    contractionTightening,
    lastVsFirstContractionVol,
    retracePctOfImpulse,
    followThroughCount
  };
}
// ================================================================
// SNIPER V101 -- GITHUB PASTE-BOX SPLIT -- PART 2 OF 4
// Paste all 4 parts into the same file, in order, with no extra
// blank lines or edits at the seams. Concatenating parts 1-4
// reconstructs sniper_v101_full.js exactly.
// Fixes HIGH_BETA range-proxy volume fallback -- was gated to
// opening-window only, so real volume-data gaps mid-session
// (AVGO/SMR etc) silently zeroed out volRatio on otherwise-
// passing setups. Now applies whenever HIGH_BETA volume data
// is missing, any time of day. Plus universe expansion, weekly
// persistence report, first-fire/peak-score alerts, safety mode
// alert, ema_fail diagnostics, false_breakout gate, crypto pool
// dynamic fix, V94 reversion, and all prior session fixes.
// ================================================================

function countDistributionDays(candles, market) {
  if (!candles || candles.length < 3) return 0;
  let count = 0;
  const downPctThreshold = isCryptoMarket(market) ? 0.03 : 0.002;

  for (let i = 1; i < candles.length; i++) {
    const today = candles[i];
    const yesterday = candles[i - 1];
    const prevClose = safeNum(yesterday.close);
    const close = safeNum(today.close);
    const vol = safeNum(today.volume);
    const prevVol = safeNum(yesterday.volume);

    if (!prevClose || !vol || !prevVol) continue;
    const changePct = (close - prevClose) / prevClose;
    if (changePct <= -downPctThreshold && vol > prevVol) count++;
  }
  return count;
}

function detectFalseBreakout(candles, breakoutIdx, market) {
  if (breakoutIdx == null || !candles[breakoutIdx]) {
    return {
      triggered: false,
      lostBreakoutFast: false,
      weakClose: false,
      retracedTooMuch: false
    };
  }

  const breakout = candles[breakoutIdx];
  const breakoutLevel = safeNum(breakout.close);
  const breakoutRangeClose = getCloseLocationInRange(breakout);
  const breakoutVolRatio = getVolumeRatioAtIndex(candles, breakoutIdx, market);

  const weakCloseMax = isCryptoMarket(market) ? CRYPTO_WEAK_CLOSE_MAX : STOCK_WEAK_CLOSE_MAX;
  const weakClose = breakoutRangeClose < weakCloseMax;

  let lostBreakoutFast = false;
  let retracedTooMuch = false;

  const maxBars = 3;
  const peak = safeNum(breakout.high, breakoutLevel);

  for (let i = breakoutIdx + 1; i < Math.min(candles.length, breakoutIdx + 1 + maxBars); i++) {
    const c = candles[i];
    const close = safeNum(c.close);
    const low = safeNum(c.low);

    if (close < breakoutLevel) lostBreakoutFast = true;

    const giveback = peak > breakoutLevel ? (peak - low) / (peak - breakoutLevel || 1) : 0;
    if (isCryptoMarket(market) && giveback >= CRYPTO_FAIL_RETRACE) retracedTooMuch = true;
  }

  const climaxVol = isCryptoMarket(market) ? breakoutVolRatio >= CRYPTO_CLIMAX_VOL : breakoutVolRatio >= 4.0;
  const triggered = weakClose || lostBreakoutFast || retracedTooMuch || climaxVol;

  return {
    triggered,
    lostBreakoutFast,
    weakClose,
    retracedTooMuch,
    climaxVol
  };
}

function scoreStructureQuality(features, market) {
  let score = 0;
  const rejectReasons = [];
  const flags = {};

  const isCrypto = isCryptoMarket(market);
  const breakoutVolMin = isCrypto ? CRYPTO_BREAKOUT_VOL_MIN : STOCK_BREAKOUT_VOL_MIN;
  const breakoutVolStrong = isCrypto ? CRYPTO_BREAKOUT_VOL_STRONG : STOCK_BREAKOUT_VOL_STRONG;
  const breakoutCloseMin = isCrypto ? CRYPTO_BREAKOUT_CLOSE_MIN : STOCK_BREAKOUT_CLOSE_MIN;
  const weakCloseMax = isCrypto ? CRYPTO_WEAK_CLOSE_MAX : STOCK_WEAK_CLOSE_MAX;
  const baseMinBars = isCrypto ? CRYPTO_BASE_MIN_BARS : STOCK_BASE_MIN_BARS;
  const minContractions = isCrypto ? CRYPTO_MIN_CONTRACTIONS : STOCK_MIN_CONTRACTIONS;
  const lastVsFirstVolMax = isCrypto ? CRYPTO_LAST_VS_FIRST_VOL_MAX : STOCK_LAST_VS_FIRST_VOL_MAX;
  const maxRetraceImpulse = isCrypto ? CRYPTO_MAX_RETRACE_IMPULSE : STOCK_MAX_RETRACE_IMPULSE;

  if (features.breakoutVolRatio >= breakoutVolStrong) {
    score += 8;
    flags.strongBreakoutVolume = true;
  } else if (features.breakoutVolRatio >= breakoutVolMin) {
    score += 4;
    flags.okBreakoutVolume = true;
  } else {
    score -= 6;
    flags.weakBreakoutVolume = true;
  }

  if (features.breakoutCloseLocation >= breakoutCloseMin) {
    score += 5;
    flags.strongBreakoutClose = true;
  } else if (features.breakoutCloseLocation < weakCloseMax) {
    score -= 8;
    flags.poorBreakoutClose = true;
    rejectReasons.push("poor_breakout_close");
  }

  if (features.baseLengthBars >= baseMinBars) {
    score += 3;
    flags.baseLengthOk = true;
  } else {
    score -= 4;
    flags.baseTooShort = true;
  }

  if (features.contractionCount >= minContractions) {
    score += 4;
    flags.contractionCountOk = true;
  } else {
    score -= 6;
    flags.weakBase = true;
    rejectReasons.push("weak_base");
  }

  if (features.contractionTightening) {
    score += 4;
    flags.tightening = true;
  } else if (features.contractionCount >= 2) {
    score -= 2;
  }

  if (features.lastVsFirstContractionVol <= lastVsFirstVolMax) {
    score += 4;
    flags.volumeDryUp = true;
  } else {
    score -= 3;
    flags.noVolumeDryUp = true;
  }

  if (features.retracePctOfImpulse <= maxRetraceImpulse) {
    score += 3;
    flags.healthyRetrace = true;
  } else {
    score -= 5;
    flags.deepRetrace = true;
  }

  if (!isCrypto && features.distributionDays20 >= STOCK_MAX_DISTRIBUTION_20) {
    score -= 6;
    flags.distributionCluster = true;
    rejectReasons.push("distribution_cluster");
  }

  if (features.falseBreakout?.triggered) {
    score -= 10;
    flags.falseBreakout = true;
    rejectReasons.push("false_breakout");
  }

  if (features.followThroughCount >= 1) {
    score += 3;
    flags.followThrough = true;
  }

  score = clamp(score, STRUCTURE_PENALTY_MAX, STRUCTURE_BONUS_MAX);

  const grade =
    score >= 15 ? "A" :
    score >= 8  ? "B" :
    score >= 1  ? "C" : "FAIL";

  return { score, grade, rejectReasons: [...new Set(rejectReasons)], flags };
}

// V102 candidate rollout stage. Kept as a pure evidence-gathering /
// hard-safety layer -- does NOT feed the score (V94 reversion has no
// soft-penalty system, and this doesn't reintroduce one). It only ever
// hard-blocks the specific reasons in STRUCTURE_QUALITY_GATE_REASONS below.
const STRUCTURE_QUALITY_MODE = "log";

// The only reasons that actually block a trade right now: false_breakout
// (weak close / lost the level fast / retraced too much / climax volume --
// the exact "buying the peak candle" pattern). weak_base intentionally
// excluded -- that's a different concern (base quality) not raised here.
const STRUCTURE_QUALITY_GATE_REASONS = new Set(["false_breakout"]);

function passesStructureSafetyGates(structureQuality) {
  if (!structureQuality) return { ok: true, reasons: [] };
  const reasons = (structureQuality.rejectReasons || []).filter(r => STRUCTURE_QUALITY_GATE_REASONS.has(r));
  return { ok: reasons.length === 0, reasons };
}

function buildStructureQuality(candles, market) {
  const breakoutIdx = findRecentBreakoutIndex(candles, BREAKOUT_LOOKBACK, market);

  if (breakoutIdx == null) {
    return {
      breakoutIdx: null,
      breakoutVolRatio: 0,
      breakoutCloseLocation: 0.5,
      baseLengthBars: 0,
      contractionCount: 0,
      contractionDepths: [],
      contractionTightening: false,
      lastVsFirstContractionVol: 1,
      retracePctOfImpulse: 1,
      followThroughCount: 0,
      distributionDays20: 0,
      falseBreakout: { triggered: false },
      score: 0,
      grade: "UNKNOWN",
      rejectReasons: [],
      flags: { noBreakoutContext: true }
    };
  }

  const breakoutVolRatio = getVolumeRatioAtIndex(candles, breakoutIdx, market);
  const breakoutCloseLocation = getCloseLocationInRange(candles[breakoutIdx]);
  const base = analyzeBaseStructure(candles, breakoutIdx, market);
  const distributionDays20 = countDistributionDays(candles.slice(-20), market);
  const falseBreakout = detectFalseBreakout(candles, breakoutIdx, market);

  const features = {
    breakoutIdx,
    breakoutVolRatio,
    breakoutCloseLocation,
    distributionDays20,
    falseBreakout,
    ...base
  };

  const scored = scoreStructureQuality(features, market);
  return { ...features, ...scored };
}

// Opening drive: directional move in first few candles
function isOpeningDrive(candles) {
  if (!isUSOpeningWindow()) return false;
  const recent = candles.slice(-5);
  if (recent.length < 3) return false;
  const first   = recent[0].close;
  const current = recent.at(-1).close;
  if (!first || first === 0) return false;
  return (current - first) / first > 0.02;
}

// Maturity-aware score bonus -- REPLACES the old 24hr boost
// Rewards early stage, penalises climax
function getMomentumMaturityBonus(candles, pct24h, symbol) {
  if (!candles || candles.length < 35) return 0;

  const maturity    = getMoveMaturity(candles);
  const profile     = getMomentumProfile(candles);
  const volProfile  = getVolumeProfile(candles);

  // Change 3: use RECENT 4h move instead of lagging 24hr figure
  // 16 x 15-min candles = 4 hours -- measures current expansion quality
  const recentMove = candles.length >= 16
    ? (candles.at(-1).close - candles.at(-16).close) / candles.at(-16).close
    : pct24h;
  const atrUnits = getMoveInATRUnits(recentMove, candles);

  let bonus = 0;

  // P4: PROMOTED MATURITY SCORING -- this is where real edge lives.
  // Most retail systems only measure price/volume. We measure WHERE in the move we are.
  // Expansion and base (early) should be rewarded heavily. Climax should be penalised hard.
  if (maturity === "expansion")    bonus += 20; // Stage 2 -- best entry, was 12
  if (maturity === "continuation") bonus += 10; // Stage 3 -- still good, was 8
  if (maturity === "base")         bonus += 8;  // Stage 1 -- early, was 4
  if (maturity === "climax")       bonus -= 18; // Buying exhaustion, was -10

  // ATR units -- volatility-adjusted extension
  if (atrUnits > 6)      bonus -= 10; // was -12
  else if (atrUnits > 4) bonus -= 5;  // was -6
  else if (atrUnits > 2) bonus += 4;
  else                   bonus += 8;

  // Volume quality
  if (volProfile.highVolBars >= 5)      bonus -= 8;  // Climax buying
  else if (volProfile.highVolBars >= 3) bonus += 4;  // Sustained
  else if (volProfile.singleSpike)      bonus += 8;  // Single breakout spike -- early

  // Acceleration bonus (only reward if not in climax)
  if (profile.accelerating && maturity !== "climax") bonus += 6;
  if (profile.decelerating)                           bonus -= 4;

  // First pullback continuation bonus
  if (isFirstPullbackContinuation(candles)) bonus += 8;

  log(`📊 ${symbol} maturity=${maturity} atrUnits=${atrUnits.toFixed(1)} highVol=${volProfile.highVolBars} bonus=${bonus}`);
  return bonus;
}

// ── Regime ───────────────────────────────────────────────────────
function classifyRegime(ema20Val, ema50Val, price) {
  if (!Number.isFinite(ema20Val)||!Number.isFinite(ema50Val)||!Number.isFinite(price)||ema50Val===0) return "neutral";
  const spread = (ema20Val - ema50Val) / ema50Val;
  if (ema20Val > ema50Val && price > ema20Val) return spread >= 0.02 ? "strong_bull" : "bull";
  // V100: lowered risk_off from -2% to -1% -- catches bear earlier, stops false neutral readings
  if (spread <= -0.01 || price < ema50Val * 0.97) return "risk_off";
  return "neutral";
}

// V100: is the market in genuine capital protection mode?
// V100: Clean regime separation
// BTC controls crypto. QQQ controls US stocks. No crossover.
// Intel is always educational -- channel always has value.

function isCryptoBlocked() {
  // Block crypto if BTC 1h OR 4h is bearish
  return btcTrend === "risk_off" || btcMacroTrend === "risk_off";
}

function isUSBlocked() {
  // V102 fix: US market is closed on weekends -- QQQ trend state just
  // carries Friday's last reading forward, so without this the market
  // update alert was reporting stale Friday conditions as if live.
  if (isWeekend()) return false;
  // Block US if QQQ is risk_off
  if (qqqTrend === "risk_off") return true;
  // Also block if QQQ hasn't been stable bull for 2+ readings
  // Prevents firing into choppy opens (bull->neutral->bull oscillation)
  return qqqBullCount < 2;
}

function isMarketBlocked(market) {
  if (market === "CRYPTO") return isCryptoBlocked();
  if (market === "US")     return isUSBlocked();
  return false; // LSE uses own regime
}

function isMacroProtecting() {
  return isCryptoBlocked() || isUSBlocked();
}

function getProtectionReason(market) {
  if (market === "CRYPTO") {
    if (btcMacroTrend === "risk_off") return "Bitcoin is in a multi-day downtrend (4h bearish)";
    if (btcTrend === "risk_off")      return "Bitcoin trend has turned bearish";
    return "Bitcoin conditions are unfavourable";
  }
  if (market === "US") {
    if (qqqTrend === "risk_off") return "US market trend has turned bearish — QQQ declining";
    if (qqqBullCount < 2)        return "US market too choppy — waiting for a stable trend";
    return "US market conditions are unfavourable";
  }
  return "Market conditions are unfavourable";
}

function regimePass(market) {
  // V94 baseline -- restored hard gate (V98 had neutered this to `return true`)
  if (market === "CRYPTO") return btcTrend === "bull" || btcTrend === "strong_bull";
  if (market === "US")     return qqqTrend !== "risk_off";
  return true;
}

function regimePassRelaxed(market, setupType, volRatio) {
  // V98: allow BREAKOUT_CONTINUATION on neutral BTC if volume is exceptional
  // NEAR +9% on 3x volume shouldn't be blocked just because BTC is ranging
  // Only apply for breakout -- pullbacks still need bull BTC
  if (market === "CRYPTO" && setupType === "BREAKOUT_CONTINUATION" && volRatio >= 2.0) {
    return btcTrend !== "risk_off"; // allow on neutral, block on risk_off only
  }
  return regimePass(market);
}

function minScoreForMarket(market, symbol = "") {
  if (market === "CRYPTO") return btcTrend === "strong_bull" ? 76 : MIN_CRYPTO_SCORE;
  if (market === "US")     return isHighBeta(symbol) ? MIN_US_SCORE_HB : MIN_US_SCORE;
  return MIN_LSE_SCORE;
}

async function mapWithConcurrency(items, limit, asyncFn) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length && !shuttingDown) {
      const i = index++;
      results[i] = await asyncFn(items[i], i);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, () => worker()));
  return results;
}

// ── 24hr momentum cache ──────────────────────────────────────────
async function refresh24hrMomentum() {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/ticker/24hr", { timeout: 12000 })
    );
    if (!Array.isArray(data)) return;
    for (const t of data) {
      if (CRYPTO_PAIRS.includes(t.symbol)) {
        crypto24hrCache.set(t.symbol, { pct: +t.priceChangePercent/100, ts: Date.now() });
      }
    }
    log(`📊 24hr momentum cached for ${crypto24hrCache.size} pairs`);
  } catch (e) { log("24hr cache failed:", e.message); }
}

function get24hrMomentum(symbol) {
  const entry = crypto24hrCache.get(symbol);
  if (!entry || Date.now()-entry.ts > CRYPTO_24HR_TTL) return null;
  return entry.pct;
}

// ── Dynamic injection -- silent ───────────────────────────────────
async function injectHotCryptoMovers() {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/ticker/24hr", { timeout: 12000 })
    );
    if (!Array.isArray(data)) return;
    const now = Date.now();
    for (const [sym, ts] of dynamicInjections.entries()) {
      if (now - ts > DYNAMIC_INJECTION_TTL_MS) {
        dynamicInjections.delete(sym);
        if (!STATIC_CRYPTO_FALLBACK.includes(sym)) {
          CRYPTO_PAIRS = CRYPTO_PAIRS.filter(p => p !== sym);
          log(`🗑️ Injection expired: ${sym}`);
        }
      }
    }
    const hot = data
      .filter(t =>
        t.symbol.endsWith("USDT") &&
        +t.priceChangePercent >= DYNAMIC_INJECTION_THRESHOLD &&
        !CRYPTO_PAIRS.includes(t.symbol) &&
        +t.quoteVolume > 5000000 &&
        isApprovedCrypto(t.symbol)
      )
      .sort((a,b) => +b.priceChangePercent - +a.priceChangePercent)
      .slice(0, 3);
    for (const t of hot) {
      CRYPTO_PAIRS = dedup([...CRYPTO_PAIRS, t.symbol]).slice(0, 30);
      dynamicInjections.set(t.symbol, now);
      log(`💉 Injected: ${t.symbol} +${(+t.priceChangePercent).toFixed(1)}%`);
    }
  } catch (e) { log("Dynamic injection failed:", e.message); }
}

// ── CoinGecko ────────────────────────────────────────────────────
// Rate limited to max once per 55 minutes -- protects API credits
// Pool refresh fires multiple times at boot and on market events
// Without this gate: 10+ calls/hour possible. With it: max 26/day.
const COINGECKO_MIN_INTERVAL = 55 * 60 * 1000; // 55 minutes
let lastCoinGeckoCall = 0;

async function getTrendingCoins() {
  const now = Date.now();
  if (now - lastCoinGeckoCall < COINGECKO_MIN_INTERVAL) {
    const minsAgo = Math.round((now - lastCoinGeckoCall) / 60000);
    log(`🪙 CoinGecko skipped -- called ${minsAgo}m ago (min interval 55m)`);
    return [];
  }
  lastCoinGeckoCall = now;
  const result = await safeRequest(() =>
    axios.get("https://api.coingecko.com/api/v3/search/trending", {
      headers: COINGECKO_API_KEY ? {"x-cg-demo-api-key": COINGECKO_API_KEY} : {},
      timeout: 12000
    }), "CoinGecko"
  );
  if (!result?.data?.coins) return [];
  const pairs = result.data.coins
    .map(c => { const s=(c?.item?.symbol||"").toUpperCase(); return s?`${s}USDT`:null; })
    .filter(Boolean)
    .filter(sym => isApprovedCrypto(sym)) // V99.1: approved prefixes only -- blocks HYPE, PENGU, ZEC etc
    .slice(0, 12);
  log("🪙 CoinGecko trending:", pairs.join(", ")||"none");
  return pairs;
}

// ── Finnhub ──────────────────────────────────────────────────────
async function getTrendingStocks() {
  // Use static core list only -- the Finnhub symbols endpoint fetches ALL US stocks
  // and triggers rate limiting, blocking Finnhub for 30 mins and killing getTopMovers
  const core = ["NVDA","PLTR","AMD","ASTS","IONQ","MSTR",
    "COIN","QQQ","SMH","AVGO","VRT","CRWD","AMAT","GEV","AVAV","OKLO","RKLB","LUNR","ETN","ANET",
    "JOBY","ACHR","SOUN","SMR","RKLB"];
  return dedup(core).slice(0, 25);
}

async function getTopMovers() {
  if (isWeekend() || !canUseFinnhub()) {
    log(`⚠️ Finnhub blocked or weekend -- skipping top movers (blocked until ${new Date(finnhubBlockedUntil).toISOString()})`);
    return { syms:[], pcts:{} };
  }
  // V100: use STOCK_POOL not hardcoded list -- prevents removed assets like INTC/MRNA appearing as top pick
  const candidates = STOCK_POOL.filter(s => !s.includes(".")).slice(0, 20);
  const movers = [];
  await mapWithConcurrency(candidates, 4, async sym => {
    const result = await safeRequest(() =>
      axios.get("https://finnhub.io/api/v1/quote", {
        params: {symbol:sym, token:FINNHUB_API_KEY}, timeout:8000
      }), `Finnhub quote ${sym}`
    );
    const changePct = result?.data?.dp;
    if (Number.isFinite(changePct) && changePct > 3) {
      movers.push({ sym, changePct });
      log(`🚀 Mover: ${sym} +${changePct.toFixed(2)}%`);
    }
  });
  movers.sort((a,b) => b.changePct - a.changePct);
  return {
    syms: movers.map(m => m.sym),
    pcts: Object.fromEntries(movers.map(m => [m.sym, m.changePct]))
  };
}

async function detectHotSectors() {
  if (isWeekend() || !canUseFinnhub()) {
    log(`⚠️ Finnhub blocked or weekend -- skipping sector detection`);
    return [];
  }
  const result = await safeRequest(() =>
    axios.get("https://finnhub.io/api/v1/news", {
      params: {category:"general", token:FINNHUB_API_KEY}, timeout:12000
    }), "Finnhub news"
  );
  const data = result?.data;
  if (!Array.isArray(data)) return [];
  const text = data.slice(0,60)
    .map(n => ((n.headline||"")+" "+(n.summary||"")).toLowerCase()).join(" ");
  const scores = {};
  for (const [sector, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
    scores[sector] = keywords.filter(kw => text.includes(kw)).length;
  }
  const active = Object.entries(scores)
    .filter(([,s]) => s>=2).sort((a,b) => b[1]-a[1]).map(([s]) => s);
  log("🧠 Hot sectors:", active.join(", ")||"none");
  return active;
}

async function getCryptoMovers() {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/ticker/24hr", { timeout:12000 })
    );
    if (!Array.isArray(data)) return [];
    return data
      .filter(t => CRYPTO_PAIRS.includes(t.symbol) && +t.priceChangePercent >= 5)
      .map(t => ({ symbol:t.symbol, changePct:+t.priceChangePercent }))
      .sort((a,b) => b.changePct - a.changePct)
      .slice(0, 8);
  } catch { return []; }
}

// ── LSE mover scanner ────────────────────────────────────────────
async function getLSEMovers() {
  const movers = [];
  await mapWithConcurrency(LSE_POOL, 2, async sym => {
    try {
      const candles = await fetchLSEData(sym);
      if (!candles || candles.length < 3) return;
      const last = candles.at(-1)?.close;
      const prev = candles.at(-2)?.close;
      if (!last || !prev || prev === 0) return;
      const pct = ((last - prev) / prev) * 100;
      if (pct >= 1.0) {
        movers.push({ sym, changePct: +pct.toFixed(2) });
        log(`🇬🇧 LSE mover: ${sym} +${pct.toFixed(1)}%`);
      }
    } catch { /* skip */ }
  });
  return movers.sort((a,b) => b.changePct - a.changePct);
}

// Group LSE movers by sector for cleaner intel presentation
function getLSESectorSummary(lseMovers) {
  const sectorMap = {
    "Banks":   ["BARC.L","LLOY.L","NWG.L","STAN.L"],
    "Energy":  ["SHEL.L","BP.L"],
    "Miners":  ["RIO.L","GLEN.L","AAL.L"],
    "Defense": ["BA.L","RR.L"],
    "Telco":   ["VOD.L"]
  };
  const active = [];
  for (const [sector, syms] of Object.entries(sectorMap)) {
    const moving = lseMovers.filter(m => syms.includes(m.sym));
    if (moving.length >= 1) active.push(sector);
  }
  return active;
}

// ── Watchlist building alert ─────────────────────────────────────
// Fires when assets are building toward a signal but haven't confirmed yet
// Max once per hour, only if content has changed, only if quiet for 90+ mins
async function sendWatchlistAlert(alerts, trades) {
  if (isWeekend() && !isCryptoWindowOpen()) return;

  // Hard gate -- max once per 3 hours regardless (was 1hr -- too frequent, creates noise)
  if (lastWatchlistTime > 0 && Date.now() - lastWatchlistTime < 3 * 60 * 60 * 1000) return;

  const watching = [];
  // V102: structure-grade watchlist gating -- counters for measuring noise reduction
  const structureStats = { seen: 0, blockedGrade: 0, blockedHardFail: 0, passedUnknown: 0, passedGraded: 0 };

  // ── US stocks FIRST -- checked during market hours AND pre-market window ──
  // Pre-market (13:00-14:30 UK) + market hours (14:30-21:00 UK)
  const ukMins = getUkMinutes();
  const stockWindowOpen = isWeekday() && ukMins >= 780 && ukMins < 1260; // 13:00-21:00 UK
  if (stockWindowOpen) {
    for (const sym of [...HIGH_BETA_STOCKS].slice(0, 20)) {
      try {
        if (cooldown(sym, alerts, "US")) continue;
        if (trades.some(t => t.asset===sym && (t.status==="PENDING"||(t.status==="FILLED"&&t.outcome==="OPEN")))) continue;

        // Check pre-market cache first -- if big pre-market move, flag it
        const pmData = getPreMarketPrice(sym);
        if (pmData && Math.abs(pmData.changePct) >= 3) {
          const arrow = pmData.changePct >= 0 ? "📈" : "📉";
          watching.push({
            label: `\uD83C\uDDFA\uD83C\uDDF8 <b>${escapeHtml(sym)}</b> \u2014 ${arrow} ${pmData.changePct >= 0 ? "+" : ""}${pmData.changePct.toFixed(1)}% pre-market \u2014 watch at open`,
            key: sym,
            priority: Math.abs(pmData.changePct) // higher move = higher priority
          });
          watchlistDiagnostics.push({ symbol: sym, market: "US", reason: "pre-market gap", structure_grade: null });
          continue;
        }

        // Standard EMA structure check
        const candles = await fetchUSData(sym);
        if (!candles || candles.length < 60) continue;
        const closes  = candles.map(x => x.close);
        const volumes = candles.map(x => x.volume || 0);
        const last    = closes.at(-1);
        const ema20v  = ema(closes, 20);
        const ema50v  = ema(closes, 50);
        const avgVol  = avg(volumes.slice(-21, -1));
        const volRat  = avgVol > 0 ? volumes.at(-1) / avgVol : 0;
        const distFromEMA = Math.abs(last - ema20v) / ema20v;

        // Looser thresholds than before -- 3% EMA proximity, any vol building
        const nearEMA     = distFromEMA < 0.03;
        const risingEMA   = ema20v > ema50v && last > ema20v;
        const volBuilding = volRat >= 1.05;

        if (nearEMA && risingEMA && volBuilding) {
          structureStats.seen++;
          const sq = buildStructureQuality(candles, "US");
          const gradeOk = sq.grade === "UNKNOWN" || sq.grade === "A" || sq.grade === "B";
          const hardFail = ["false_breakout", "weak_base", "distribution_cluster"].some(r => sq.rejectReasons.includes(r));
          if (!gradeOk) { structureStats.blockedGrade++; continue; }
          if (hardFail) { structureStats.blockedHardFail++; continue; }
          if (sq.grade === "UNKNOWN") structureStats.passedUnknown++; else structureStats.passedGraded++;
          watching.push({
            label: `\uD83C\uDDFA\uD83C\uDDF8 <b>${escapeHtml(sym)}</b> \u2014 near EMA, vol building ${volRat.toFixed(1)}x${sq.grade !== "UNKNOWN" ? ` \u00B7 structure ${sq.grade}` : ""}`,
            key: sym,
            priority: volRat
          });
          watchlistDiagnostics.push({ symbol: sym, market: "US", reason: "EMA structure", structure_grade: sq.grade });
        }
      } catch { /* skip */ }
    }
  }

  // ── Crypto -- checked 24/7 but only added if stocks didn't fill the list ──
  // ── Crypto -- genuine movers only ───────────────────────────────
  // V100 TIGHTENED: must be above EMA20, uptrend confirmed (EMA20>EMA50),
  // real volume (1.5x+), and positive momentum. No nearEMA, no vol cap.
  if (isCryptoWindowOpen()) {
    for (const sym of CRYPTO_PAIRS.slice(0, 15)) {
      try {
        if (cooldown(sym, alerts, "CRYPTO")) continue;
        if (trades.some(t => t.asset===sym && (t.status==="PENDING"||(t.status==="FILLED"&&t.outcome==="OPEN")))) continue;
        const candles = await fetchCrypto(sym);
        if (!candles || candles.length < 60) continue;
        const closes   = candles.map(x => x.close);
        const volumes  = candles.map(x => x.volume || 0);
        const last     = closes.at(-1);
        const prev     = closes.at(-2);
        const ema20v   = ema(closes, 20);
        const ema50v   = ema(closes, 50);
        const avgVol   = avg(volumes.slice(-21, -1));
        const volRat   = avgVol > 0 ? volumes.at(-1) / avgVol : 0;
        const momentum = prev > 0 ? (last - prev) / prev : 0;
        const aboveEMA  = last > ema20v;
        const risingEMA = ema20v > ema50v;
        const strongVol = volRat >= 1.5;
        const movingUp  = momentum > 0.003;
        if (aboveEMA && risingEMA && strongVol && movingUp) {
          structureStats.seen++;
          const sq = buildStructureQuality(candles, "CRYPTO");
          const gradeOk = sq.grade === "UNKNOWN" || sq.grade === "A" || sq.grade === "B";
          const hardFail = ["false_breakout", "weak_base"].some(r => sq.rejectReasons.includes(r));
          if (!gradeOk) { structureStats.blockedGrade++; continue; }
          if (hardFail) { structureStats.blockedHardFail++; continue; }
          if (sq.grade === "UNKNOWN") structureStats.passedUnknown++; else structureStats.passedGraded++;
          const name    = sym.replace("USDT", "");
          const heatTag = getHeat(sym) >= 60 ? " \uD83D\uDD25" : "";
          watching.push({
            label: `\uD83E\uDE99 <b>${escapeHtml(name)}</b> \u2014 \u26A1 ${(momentum*100).toFixed(2)}% \u00B7 vol ${volRat.toFixed(1)}x${heatTag}${sq.grade !== "UNKNOWN" ? ` \u00B7 structure ${sq.grade}` : ""}`,
            key: name,
            priority: volRat * (1 + momentum * 10)
          });
          watchlistDiagnostics.push({ symbol: name, market: "CRYPTO", reason: "crypto momentum", structure_grade: sq.grade });
        }
      } catch { /* skip */ }
    }
  }

  log(`\uD83D\uDCCA Watchlist structure gate: seen=${structureStats.seen} blockedGrade=${structureStats.blockedGrade} blockedHardFail=${structureStats.blockedHardFail} passedUnknown=${structureStats.passedUnknown} passedGraded=${structureStats.passedGraded}`);
  await safeRun("flushWatchlistDiagnostics", flushWatchlistDiagnostics);

  if (watching.length === 0) return;

  // Sort by priority -- highest move/volume first
  watching.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  // Content dedup -- don't resend if same assets as last time
  const contentKey = watching.map(w => w.key).slice(0, 6).join(",");
  if (contentKey === lastWatchlistKey) {
    log(`👀 Watchlist unchanged -- suppressed`);
    return;
  }

  lastWatchlistKey  = contentKey;
  lastWatchlistTime = Date.now();

  // V98: Heat score -- watchlist mention adds heat
  for (const w of watching.slice(0, 6)) {
    addHeat(w.key, 15, "watchlist");
  }

  const parts = [
    `\uD83D\uDC40 <b>WATCHLIST BUILDING</b>`,
    ``,
    `Setups forming \u2014 no confirmed entry yet:`,
    ``
  ];
  parts.push(...watching.slice(0, 6).map(w => `  ${w.label}`));
  parts.push(``, `\uD83D\uDCA1 Scanner will alert if setup confirms on next cycle`);
  parts.push(``, `\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014`, `\u26A0\uFE0F <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · @baretradesignals 🎯</i>`);
  await safeRun("watchlistAlert", () => sendChannel(lines(parts)));
  log(`👀 Watchlist sent -- ${watching.length} setups (${watching.filter(w=>w.key.length<=5).length} stocks, ${watching.filter(w=>w.key.length>5||w.label.includes("🪙")).length} crypto)`);
}

// ── Narrative change detection ───────────────────────────────────
function narrativeHasChanged(sectors, stockMovers, cryptoMovers, lseMovers = []) {
  const now = Date.now();

  // Reset daily post count
  const today = new Date().getUTCDate();
  if (narrativePostCountDay !== today) {
    narrativePostCount    = 0;
    narrativePostCountDay = today;
  }

  // Hard cap -- max 4 intel posts per day
  if (narrativePostCount >= 4) return false;

  // Minimum 3 hours between posts with same narrative
  const minGap = 3 * 60 * 60 * 1000;
  const sectorsStr = sectors.join(",");
  const timeSinceLast = now - lastNarrativeAlertTime;
  if (timeSinceLast < minGap && sectorsStr === lastNarrativeSectors) return false;

  // Always post if forced (market open) regardless of time gap
  // -- handled by forceNarrativeAlert param in caller

  const newState = {
    sectors:      sectorsStr,
    stockMovers:  stockMovers.slice(0, 6).join(","),
    cryptoMovers: cryptoMovers.map(c => c.symbol).join(","),
    lseMovers:    lseMovers.map(m => m.sym).join(",")
  };

  // Material change check -- not just any difference
  // New sector narrative = always post
  const newSector = newState.sectors !== lastNarrativeState.sectors;

  // Big mover appeared -- stock up 5%+ that wasn't before
  const prevMovers = (lastNarrativeState.stockMovers || "").split(",");
  const newMovers  = newState.stockMovers.split(",");
  const bigNewMover = newMovers.some(s => !prevMovers.includes(s) && s);

  // Crypto explosive move appeared
  const prevCrypto = (lastNarrativeState.cryptoMovers || "").split(",");
  const newCrypto  = newState.cryptoMovers.split(",");
  const newExplosive = newCrypto.some(s => !prevCrypto.includes(s) && s);

  // Minimum gap passed with any change
  const minGapPassed = timeSinceLast >= minGap;
  const anyChange =
    newState.sectors      !== lastNarrativeState.sectors      ||
    newState.stockMovers  !== lastNarrativeState.stockMovers  ||
    newState.cryptoMovers !== lastNarrativeState.cryptoMovers ||
    newState.lseMovers    !== lastNarrativeState.lseMovers;

  const shouldPost = newSector || bigNewMover || newExplosive || (minGapPassed && anyChange);

  if (shouldPost) {
    lastNarrativeState     = { ...lastNarrativeState, ...newState };
    lastNarrativeAlertTime = now;
    lastNarrativeSectors   = sectorsStr;
    narrativePostCount++;
    log(`🧠 Intel post #${narrativePostCount} today (${newSector?"new sector":bigNewMover?"new mover":newExplosive?"explosive crypto":"scheduled"})`);
  }
  return shouldPost;
}

// ── Narrative alert ──────────────────────────────────────────────
async function sendNarrativeAlert(topMovers, cryptoMovers, stockMoverPcts = {}, lseMovers = []) {
  if (!Array.isArray(topMovers))    topMovers    = [];
  if (!Array.isArray(cryptoMovers)) cryptoMovers = [];
  if (!Array.isArray(lseMovers))    lseMovers    = [];

  // V94 baseline -- reverted from the V98+ version which added OPENING BELL
  // variant, BTC/QQQ regime header, ranked strength/heat scoring, DexScreener
  // section, negative-momentum crypto tags, and a "Top pick" selector.
  const parts = ["🧠🔥 <b>MARKET INTEL UPDATE</b>", ""];

  if (!isWeekend() && HOT_SECTORS.length > 0) {
    const usSectors = HOT_SECTORS.filter(s => !s.startsWith("UK_"));
    if (usSectors.length > 0) {
      parts.push("<b>Active narratives:</b>");
      for (const s of usSectors) {
        const syms = (SECTOR_SYMBOLS[s]||[]).slice(0,4).join(", ");
        parts.push(`  📌 <b>${escapeHtml(s)}</b> → ${escapeHtml(syms)}`);
      }
      parts.push("");
    }
  }

  if (!isWeekend() && topMovers.length > 0) {
    parts.push("🇺🇸 <b>Hot stocks right now:</b>");
    for (const sym of topMovers.slice(0,5)) {
      parts.push(`  🚀 <b>${escapeHtml(sym)}</b> — gaining momentum`);
    }
    parts.push("");
  }

  if (!isWeekend() && isLSEMarketOpen() && lseMovers.length > 0) {
    const activeSectors = getLSESectorSummary(lseMovers);
    parts.push("🇬🇧 <b>FTSE strength building:</b>");
    if (activeSectors.length > 0) {
      parts.push(`  📈 ${activeSectors.join(" • ")}`);
    }
    for (const m of lseMovers.slice(0,4)) {
      parts.push(`  📊 <b>${escapeHtml(m.sym)}</b> +${m.changePct.toFixed(1)}%`);
    }
    parts.push("");
  }

  const filteredCryptoMovers = cryptoMovers.filter(c => isApprovedCrypto(c.symbol));

  if (filteredCryptoMovers.length > 0) {
    parts.push("🪙 <b>Crypto moving right now:</b>");
    for (const c of filteredCryptoMovers) {
      const sym = c.symbol.replace("USDT","");
      const tag = c.changePct >= 15 ? "🔥 explosive move"
                : c.changePct >= 8  ? "⚡ strong momentum"
                : "📈 building momentum";
      parts.push(`  📊 <b>${escapeHtml(sym)}</b> — ${tag}`);
    }
    parts.push("");
    parts.push("💡 Entry alert fires if breakout confirmed on next scan");
  }

  if (parts.length <= 2) return;
  parts.push(`🔍 Scanning ${isWeekend() ? CRYPTO_PAIRS.length+" crypto pairs only" : STOCK_POOL.length+" stocks • "+CRYPTO_PAIRS.length+" crypto pairs • "+LSE_POOL.length+" LSE stocks"}`);
  // Discord routing kept (delivery infrastructure, added this session -- not intel content/logic)
  await safeRun("telegramNarrative", () => sendIntelChannels(lines(parts)));
}

// ── Dynamic pool refresh ─────────────────────────────────────────
async function refreshDynamicPools(forceNarrativeAlert = false) {
  if (refreshingPools || shuttingDown) { if (refreshingPools) log("Pool refresh skipped"); return; }
  refreshingPools = true;
  try {
    log("🔄 Refreshing pools...");
    const trendingCoins = await getTrendingCoins();
    // V98: DexScreener removed from pool injection -- returns junk meme tokens
    // HPPCD, JPAJL etc were polluting the scan pool and failing every cycle
    // DexScreener still used for intel early momentum section only
    //
    // BUG FIX: this used to seed every refresh with the full 26-entry
    // STATIC_CRYPTO_FALLBACK list before adding trendingCoins, then cap at 26 --
    // since the static list alone was exactly 26 entries, trendingCoins could
    // NEVER contribute a single new coin regardless of what was actually
    // trending. Now matches STOCK_POOL's pattern exactly: static list is the
    // boot-seed only (see `let CRYPTO_PAIRS = ...` above), refresh is fully
    // dynamic. Minimal 3-coin floor (BTC/ETH/SOL) only if CoinGecko returns
    // fewer than 5 -- a safety net, not a static ceiling.
    CRYPTO_PAIRS = dedup([...ALWAYS_SCAN_CRYPTO, ...trendingCoins]).slice(0, 26);
    if (CRYPTO_PAIRS.length < 5) {
      log(`⚠️ Only ${CRYPTO_PAIRS.length} trending coins returned -- topping up with BTC/ETH/SOL floor`);
      CRYPTO_PAIRS = dedup([...CRYPTO_PAIRS, "BTCUSDT", "ETHUSDT", "SOLUSDT"]).slice(0, 26);
    }
    await refresh24hrMomentum();

    if (!isWeekend()) {
      HOT_SECTORS = await detectHotSectors();
      const [trendingStocks, topMoversResult, lseMovers] = await Promise.all([
        getTrendingStocks(),
        getTopMovers(),
        isLSEMarketOpen() ? getLSEMovers() : Promise.resolve([])
      ]);
      const topMovers      = topMoversResult.syms || [];
      const stockMoverPcts = topMoversResult.pcts || {};
      const sectorInjected = [];
      for (const sector of HOT_SECTORS) {
        const syms = (SECTOR_SYMBOLS[sector]||[]).filter(isCleanTicker);
        sectorInjected.push(...syms);
      }
      STOCK_POOL = dedup([...ALWAYS_SCAN_STOCKS, ...trendingStocks, ...topMovers, ...sectorInjected]).slice(0, 25);
      log(`✅ Pools -- Crypto: ${CRYPTO_PAIRS.length}, Stocks: ${STOCK_POOL.length}, LSE movers: ${lseMovers.length}`);

      if (shouldSendStockAlerts()) {
        const cryptoMovers = await getCryptoMovers();
        if (forceNarrativeAlert || narrativeHasChanged(HOT_SECTORS, topMovers, cryptoMovers, lseMovers)) {
          if (forceNarrativeAlert) {
            // Market open force -- reset timer so it posts immediately
            lastNarrativeAlertTime = 0;
            narrativeHasChanged(HOT_SECTORS, topMovers, cryptoMovers, lseMovers);
          }
          await sendNarrativeAlert(topMovers, cryptoMovers, stockMoverPcts, lseMovers);
        }
      }
    } else {
      log(`✅ Weekend -- Crypto: ${CRYPTO_PAIRS.length} pairs`);
      const cryptoMovers = await getCryptoMovers();
      if (forceNarrativeAlert || (narrativeHasChanged([],[],cryptoMovers,[]) && shouldSendCryptoAlerts())) {
        await sendNarrativeAlert([], cryptoMovers);
      }
    }

    log(`📊 API -- TD: ${apiUsage.twelvedata}/${API_LIMITS.twelvedata}, AV: ${apiUsage.alphavantage}/${API_LIMITS.alphavantage}`);
  } finally {
    refreshingPools = false;
  }
}

// ── V100: Weekly Self-Audit -- every Sunday 21:00 UK ─────────────────────
// Plain English report on filter performance and EV
// "What filter is earning its keep? What filter is costing us winners?"
async function sendWeeklyAudit() {
  const isSunday = new Date().getDay() === 0;
  if (!isSunday) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastWeeklyAuditDate === today) return;
  lastWeeklyAuditDate = today;

  const total   = evStats.total;
  const wr      = (evStats.winRate * 100).toFixed(1);
  const avgW    = (evStats.avgWin  * 100).toFixed(1);
  const avgL    = (evStats.avgLoss * 100).toFixed(1);
  const ev      = (evStats.ev      * 100).toFixed(2);
  const evSign  = parseFloat(ev) >= 0 ? "+" : "";

  // Filter performance from rejection log
  const filterCounts = {};
  for (const r of rejectionLog) {
    for (const reason of r.reasons) {
      filterCounts[reason] = (filterCounts[reason] || 0) + 1;
    }
  }
  const topFilters = Object.entries(filterCounts)
    .sort((a,b) => b[1]-a[1])
    .slice(0, 5);

  // Reject stats
  const totalRejections = Object.values(rejectStats).reduce((a,b)=>a+b, 0);

  const parts = [
    `📊 <b>WEEKLY SELF-AUDIT</b>`,
    `<i>BareTradeSignals — ${new Date().toLocaleDateString("en-GB", {day:"numeric", month:"long", year:"numeric"})}</i>`,
    ``,
    `<b>📈 Performance this week</b>`,
    total > 0
      ? `Signals: ${total} | Win rate: ${wr}% | Avg win: +${avgW}% | Avg loss: ${avgL}%`
      : `No completed trades this week.`,
    total > 0
      ? `<b>Expected Value per signal: ${evSign}${ev}%</b>`
      : ``,
    ``,
    `<b>🔍 Filter activity</b>`,
    `Total rejected this session: ${totalRejections}`,
    ...(topFilters.length > 0
      ? [`Top rejection reasons:`, ...topFilters.map(([r,c]) => `  ${escapeHtml(r)}: ${c}`)]
      : [`No rejection data yet.`]
    ),
    ``,
    `<b>💡 What this means</b>`,
    parseFloat(ev) > 0
      ? `Positive EV — the engine is making correct decisions on average. Keep the filters.`
      : total < 5
      ? `Not enough data yet. Need at least 10 trades to judge filter quality.`
      : `Negative EV — review the loss patterns. Are the losses concentrated in one setup type?`,
    ``,
    `<b>🎯 North star reminder</b>`,
    `Win rate alone means nothing. Expected Value is everything.`,
    `A 45% win rate at +10%/-3% beats an 80% win rate at +2%/-8% every time.`,
    ``,
    `——————————`,
    `⚠️ <i>Educational market commentary only · Not personalised investment advice · @baretradesignals 🎯</i>`,
  ];

  await sendChannel(lines(parts.filter(Boolean)));
  log("📊 Weekly self-audit sent");
}

// ── V101: Weekly regime classification job ────────────────────────
// Same self-gating pattern as sendWeeklyAudit -- called unconditionally
// from checkMarketAlerts() on US close, returns immediately except Sunday.
// Evidence-gathering only. No alerts. No scoring impact.
// ── V101: Performance intel (Wed/Fri/Sun) -- Bluejam only, screenshot-style ──
// Shares the same "intel only, never advice" framing as the channel posts,
// but stays on Bluejam for proofing before any of this goes public.
// Maturity-based caution read uses the existing getMoveMaturity() stages:
//   base/expansion  -> early, room to continue
//   continuation    -> healthy, still fine
//   climax          -> exhaustion risk, flagged cautious

function maturityToCautionLine(maturity) {
  if (maturity === "climax")       return "⚠️ Extended move — caution if still holding, watch for reversal";
  if (maturity === "continuation") return "📈 Healthy trend — still has room if volume holds";
  if (maturity === "expansion")    return "🌱 Early stage — first leg of the move";
  if (maturity === "base")         return "😴 Flat/consolidating — no clear direction yet";
  return "❓ Not enough data to read";
}

// Computes weekly % change + maturity read for a crypto symbol using daily candles.
async function getCryptoWeeklyPerformance(symbol) {
  try {
    const daily = await fetchCryptoDailyWithFallback(symbol, 35);
    if (!daily || daily.length < 8) return null;
    const closes = daily.map(c => c.close);
    const last   = closes.at(-1);
    const weekAgo = closes.at(-8); // 7 days back
    if (!weekAgo || weekAgo <= 0) return null;
    const changePct = ((last - weekAgo) / weekAgo) * 100;
    const maturity  = getMoveMaturity(daily);
    return { symbol: symbol.replace("USDT",""), changePct, maturity };
  } catch (e) {
    log(`⚠️ Weekly perf failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// Computes weekly % change + maturity read for a US stock using daily candles.
async function getStockWeeklyPerformance(symbol) {
  try {
    const daily = await fetchUSDailyForReport(symbol);
    if (!daily || daily.length < 8) return null;
    const closes = daily.map(c => c.close);
    const last   = closes.at(-1);
    const weekAgo = closes.at(-6); // ~5 trading days back
    if (!weekAgo || weekAgo <= 0) return null;
    const changePct = ((last - weekAgo) / weekAgo) * 100;
    const maturity  = getMoveMaturity(daily);
    return { symbol, changePct, maturity };
  } catch (e) {
    log(`⚠️ Weekly perf failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// Shared builder for the Wed/Fri "best performers" style post.
// title/subtitle differ between midweek and full-week framing; everything else is identical.
async function buildPerformanceDigest(title, subtitle) {
  const cryptoUniverse = [...new Set(STATIC_CRYPTO_FALLBACK)];
  const stockUniverse  = [...new Set(STATIC_STOCK_FALLBACK)];

  const cryptoResults = (await Promise.all(cryptoUniverse.map(getCryptoWeeklyPerformance))).filter(Boolean);
  const stockResults  = (await Promise.all(stockUniverse.map(getStockWeeklyPerformance))).filter(Boolean);

  cryptoResults.sort((a,b) => b.changePct - a.changePct);
  stockResults.sort((a,b) => b.changePct - a.changePct);

  const topCrypto = cryptoResults.slice(0, 5);
  const topStocks = stockResults.slice(0, 5);

  const parts = [
    `📊 <b>${title}</b>`,
    `<i>${subtitle} — ${new Date().toLocaleDateString("en-GB", {weekday:"long", day:"numeric", month:"long"})}</i>`,
    ``,
  ];

  if (topCrypto.length > 0) {
    parts.push(`<b>🪙 Top 5 Crypto</b>`);
    for (const c of topCrypto) {
      const sign = c.changePct >= 0 ? "+" : "";
      parts.push(`  <b>${escapeHtml(c.symbol)}</b> ${sign}${c.changePct.toFixed(1)}%`);
      parts.push(`    ${maturityToCautionLine(c.maturity)}`);
    }
    parts.push(``);
  }

  if (topStocks.length > 0) {
    parts.push(`<b>🇺🇸 Top 5 Stocks</b>`);
    for (const s of topStocks) {
      const sign = s.changePct >= 0 ? "+" : "";
      parts.push(`  <b>${escapeHtml(s.symbol)}</b> ${sign}${s.changePct.toFixed(1)}%`);
      parts.push(`    ${maturityToCautionLine(s.maturity)}`);
    }
    parts.push(``);
  }

  if (topCrypto.length === 0 && topStocks.length === 0) {
    parts.push(`No performance data available this run.`);
    parts.push(``);
  }

  parts.push(`——————————`);
  parts.push(`⚠️ <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · Pattern reads only, not predictions</i>`);

  return lines(parts);
}

// V102: "what's been on the watchlist this week" -- summarizes
// watchlist_history since Monday. Only attached to the Wednesday
// check-in, not Friday's week-in-review.
async function buildWatchlistWeekTable() {
  if (!supabaseEnabled) return null;
  const now = new Date();
  const monday = new Date(now);
  const dayOfWeek = monday.getDay(); // 0=Sun..6=Sat
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  monday.setDate(monday.getDate() - diffToMonday);
  monday.setHours(0,0,0,0);

  const { data, error } = await retry(() => supabase
    .from("watchlist_history")
    .select("symbol, market, structure_grade, seen_at")
    .gte("seen_at", monday.toISOString())
    .order("seen_at", { ascending: false })
  );
  if (error || !data || data.length === 0) return null;

  const bySymbol = {};
  for (const row of data) {
    const key = `${row.symbol}|${row.market}`;
    if (!bySymbol[key]) bySymbol[key] = { symbol: row.symbol, market: row.market, count: 0, grades: [], firstSeen: row.seen_at, lastSeen: row.seen_at };
    bySymbol[key].count++;
    if (row.structure_grade) bySymbol[key].grades.push(row.structure_grade);
    if (row.seen_at < bySymbol[key].firstSeen) bySymbol[key].firstSeen = row.seen_at;
    if (row.seen_at > bySymbol[key].lastSeen)  bySymbol[key].lastSeen  = row.seen_at;
  }

  const rows = Object.values(bySymbol).sort((a,b) => b.count - a.count);
  const parts = ["", "📋 <b>On the watchlist this week</b>", ""];
  for (const r of rows.slice(0, 20)) {
    const marketTag = r.market === "CRYPTO" ? "🪙" : r.market === "US" ? "🇺🇸" : "🇬🇧";
    const bestGrade = r.grades.length ? [...new Set(r.grades)].sort().join("/") : "—";
    const firstDate = new Date(r.firstSeen).toLocaleDateString("en-GB", {weekday:"short"});
    parts.push(`  ${marketTag} <b>${escapeHtml(r.symbol)}</b> — seen ${r.count}x since ${firstDate} · structure ${bestGrade}`);
  }
  if (rows.length > 20) parts.push(`  …and ${rows.length - 20} more`);
  return lines(parts);
}

// Wednesday -- midweek check-in. Gated to Wednesday only.
async function sendMidweekCheckin() {
  const isWednesday = new Date().getDay() === 3;
  if (!isWednesday) return;
  // V101 FIX: skip on a US market holiday -- stock performance numbers would
  // be stale (no fresh trading that day), and posting them as if current is
  // misleading. Crypto still trades 24/7 on a US holiday, but the combined
  // post is built around having both, so skip the whole thing rather than
  // post a half-stale digest.
  if (isUSMarketHoliday()) {
    log("🏖️ Midweek check-in skipped -- US market holiday");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (lastMidweekCheckinDate === today) return;
  lastMidweekCheckinDate = today;
  const msg = await buildPerformanceDigest("MIDWEEK CHECK-IN", "How the week's looking so far");
  const watchlistTable = await buildWatchlistWeekTable();
  const fullMsg = watchlistTable ? msg + "\n" + watchlistTable : msg;
  await sendPrivate(fullMsg);
  log("📊 Midweek check-in sent to Bluejam");
}

// Friday -- full week in review. Gated to Friday AND after US market close
// (per request: "Friday needs to be after market close").
async function sendWeekInReview() {
  const isFriday = new Date().getDay() === 5;
  if (!isFriday) return;
  // V101 FIX: if today is a US holiday, isUSMarketOpen() is false all day
  // for the WRONG reason (holiday, not genuine close) -- without this check
  // the post would fire early using yesterday's/stale numbers as if it were
  // a normal post-close Friday.
  if (isUSMarketHoliday()) {
    log("🏖️ Week in review skipped -- US market holiday");
    return;
  }
  if (isUSMarketOpen()) return; // wait for close, don't fire mid-session
  const today = new Date().toISOString().slice(0, 10);
  if (lastWeekInReviewDate === today) return;
  lastWeekInReviewDate = today;
  const msg = await buildPerformanceDigest("WEEK IN REVIEW", "Best performers this week");
  await sendPrivate(msg);
  log("📊 Week in review sent to Bluejam");
}

// Sunday -- "on the radar". Crypto only -- US/LSE markets are closed over the
// weekend so there's no fresh stock data to show; reusing Friday's close would
// just repeat the Week in Review with no new information.
// No holiday check needed here -- crypto trades 24/7, weekends included,
// so there's no equivalent "stale data" risk for this one.
// Pulls from the same regime data the Sunday regime job just classified --
// flags early-stage TRENDING/ROTATING coins with rising recovery_count as
// "patterns forming", not predictions.
// Timing: per request, "neutral time between US and UK subscribers" -- fires
// at 17:00 UK (1020 mins), which is 12:00 ET / late evening UK, a reasonable
// mid-afternoon-to-early-evening slot for both US and UK audiences rather
// than skewing toward either market's open/close schedule.
const ON_THE_RADAR_UK_MINUTES = 1020; // 17:00 UK
async function sendOnTheRadar() {
  const isSunday = new Date().getDay() === 0;
  if (!isSunday) return;
  if (getUkMinutes() < ON_THE_RADAR_UK_MINUTES) return; // wait for the neutral time slot
  const today = new Date().toISOString().slice(0, 10);
  if (lastOnTheRadarDate === today) return;
  lastOnTheRadarDate = today;
  if (!supabaseEnabled) {
    log("⚠️ On The Radar skipped -- Supabase disabled");
    return;
  }

  try {
    // Pull today's freshly-inserted regime rows (the regime job runs first in checkMarketAlerts)
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("crypto_regimes")
      .select("*")
      .eq("date", today);

    if (error) {
      log(`⚠️ On The Radar -- regime fetch error: ${error.message}`);
      return;
    }
    if (!data || data.length === 0) {
      log("⚠️ On The Radar -- no regime data for today, skipping");
      return;
    }

    // Early-stage TRENDING or ROTATING with at least one recovery -- the
    // "watch this, not there yet" tier rather than already-extended movers.
    const interesting = data
      .filter(r => (r.regime === "TRENDING" || r.regime === "ROTATING") && (r.recovery_count || 0) >= 1)
      .sort((a,b) => (b.confidence||0) - (a.confidence||0))
      .slice(0, 8);

    const parts = [
      `👀 <b>ON THE RADAR</b>`,
      `<i>Patterns forming — week ahead</i>`,
      ``,
    ];

    if (interesting.length > 0) {
      for (const r of interesting) {
        const sym = r.symbol.replace("USDT","");
        const regimeTag = r.regime === "TRENDING" ? "📈 Trending" : "🔁 Rotating (repeat pattern)";
        parts.push(`  <b>${escapeHtml(sym)}</b> — ${regimeTag}`);
        parts.push(`    ${r.recovery_count} recovery${r.recovery_count===1?"":"s"} from retrace this cycle`);
        // V101: trend classification -- the "high vs increasing momentum"
        // distinction. Two assets can both clear the regime bar today, but
        // one's conviction is building and the other's is fading.
        const trend = await classifyMomentumTrend(r.symbol);
        if (trend) {
          const trendEmoji = trend.label === "Accelerating" ? "🚀"
                            : trend.label === "Emerging"     ? "🌱"
                            : trend.label === "Holding"      ? "➡️"
                            : trend.label === "Cooling"      ? "🧊"
                            : trend.label === "Breakdown"    ? "📉" : "❓";
          const changeStr = trend.change !== null
            ? ` (${trend.change >= 0 ? "+" : ""}${trend.change} vs yesterday)`
            : "";
          parts.push(`    ${trendEmoji} ${trend.label}${changeStr}`);
        }
      }
      parts.push(``);
      parts.push(`These are showing patterns worth watching — not signals, not predictions.`);
    } else {
      parts.push(`Nothing showing a clear repeating pattern this week.`);
    }

    parts.push(``);
    parts.push(`——————————`);
    parts.push(`⚠️ <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · Pattern observation only</i>`);

    await sendPrivate(lines(parts));
    log(`👀 On The Radar sent to Bluejam -- ${interesting.length} names`);
  } catch (e) {
    log(`⚠️ On The Radar exception: ${e.message}`);
  }
}


// ── V101: Daily momentum snapshots + trend classification ──────
// Doesn't touch detection. Heat/intel already finds the right names --
// this just answers a different question: is THIS asset's conviction
// strengthening or weakening day over day, separate from whether it
// currently clears the "hot" bar. High heat and rising heat are not
// the same thing, and rising heat is usually where the bigger moves
// start (per request: "increasing momentum is usually where the
// biggest moves begin").
//
// Snapshot once per day for every currently-hot asset (heat >= threshold
// right now, OR was hot at any point in the last 24h via HEAT_SCORES map).
// Append-only, same pattern as crypto_regimes -- never upsert, since
// overwriting yesterday's score would destroy the exact comparison this
// is built for.

let lastMomentumSnapshotDate = "";

async function runDailyMomentumSnapshot() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastMomentumSnapshotDate === today) return;
  lastMomentumSnapshotDate = today;
  if (!supabaseEnabled) { log("⚠️ Momentum snapshot skipped -- Supabase disabled"); return; }

  // Snapshot every asset currently tracked in HEAT_SCORES, not just the
  // ones above the hot threshold right now -- an asset cooling from 85
  // to 60 is exactly the "Cooling/Breakdown" case we want to catch, and
  // it would silently vanish from getHotAssets() before we ever recorded
  // the drop if we only snapshotted current hot names.
  const tracked = [...HEAT_SCORES.keys()];
  if (tracked.length === 0) { log("📊 Momentum snapshot -- nothing tracked today, skipping"); return; }

  const rows = tracked.map(asset => ({
    asset,
    date: today,
    score: Math.round(getHeat(asset)),
  })).filter(r => r.score > 0); // don't bother recording fully-decayed zeros

  if (rows.length === 0) { log("📊 Momentum snapshot -- all tracked assets decayed to 0, nothing to record"); return; }

  try {
    const { error } = await retry(() => supabase.from("momentum_snapshots").insert(rows));
    if (error) {
      log(`❌ Supabase momentum snapshot insert error: ${error.message} (code: ${error.code})`);
    } else {
      log(`✅ Momentum snapshot complete -- ${rows.length} assets recorded`);
    }
  } catch (e) {
    log(`⚠️ Momentum snapshot exception: ${e.message}`);
  }
}

// V101: daily price tracking -- separate from score snapshots, this is
// what makes forward-return queries possible (Section C/E of the
// leaderboard audit: "did persistence predict returns"). Tracks price
// for every asset that has EVER appeared in momentum_leaderboard, not
// just currently-tracked ones, because we need price history to keep
// running even after an asset exits the leaderboard -- otherwise "what
// happened to JUP 7 days after detection" becomes unanswerable the
// moment JUP cools off and drops out of HEAT_SCORES.
let lastPriceTrackingDate = "";

async function runDailyPriceTracking() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastPriceTrackingDate === today) return;
  lastPriceTrackingDate = today;
  if (!supabaseEnabled) { log("⚠️ Price tracking skipped -- Supabase disabled"); return; }

  try {
    const { data: assets, error: fetchErr } = await supabase
      .from("momentum_leaderboard")
      .select("asset, market");
    if (fetchErr) { log(`⚠️ Price tracking -- leaderboard fetch error: ${fetchErr.message}`); return; }
    if (!assets || assets.length === 0) { log("📊 Price tracking -- no leaderboard assets yet, skipping"); return; }

    const rows = [];
    for (const { asset, market } of assets) {
      try {
        const candles = market === "CRYPTO"
          ? await fetchCrypto(asset)
          : await fetchUSData(asset);
        const price = candles?.at(-1)?.close;
        if (price && price > 0) {
          rows.push({ asset, date: today, price });
        }
      } catch (e) {
        log(`⚠️ Price tracking failed for ${asset}: ${e.message}`);
      }
    }

    if (rows.length === 0) { log("📊 Price tracking -- no prices fetched, nothing to record"); return; }

    const { error } = await retry(() => supabase.from("momentum_price_tracking").insert(rows));
    if (error) {
      log(`❌ Supabase price tracking insert error: ${error.message} (code: ${error.code})`);
    } else {
      log(`✅ Price tracking complete -- ${rows.length} assets recorded`);
    }
  } catch (e) {
    log(`⚠️ Price tracking exception: ${e.message}`);
  }
}

// Classifies an asset's momentum trend from its recent snapshot history.
// Returns { label, scoreToday, scoreYesterday, change, history } or null
// if there's not enough history yet (first day an asset is tracked).
//
// Labels:
//   Emerging     -- new today, no prior history (score > 0, first appearance)
//   Accelerating -- score rising for 2+ consecutive days
//   Holding      -- score roughly flat (within ±5 pts) day over day
//   Cooling      -- score falling but still above the hot threshold
//   Breakdown    -- score fell below the hot threshold from above it
async function classifyMomentumTrend(asset) {
  if (!supabaseEnabled) return null;
  try {
    const { data, error } = await supabase
      .from("momentum_snapshots")
      .select("date, score")
      .eq("asset", asset)
      .order("date", { ascending: false })
      .limit(5);

    if (error || !data || data.length === 0) return null;

    const history = data.reverse(); // oldest -> newest
    const scoreToday = history.at(-1)?.score ?? 0;
    const scoreYesterday = history.length >= 2 ? history.at(-2).score : null;

    if (scoreYesterday === null) {
      return { label: "Emerging", scoreToday, scoreYesterday: null, change: null, history };
    }

    const change = scoreToday - scoreYesterday;

    let label;
    if (scoreYesterday >= HEAT_HOT_THRESHOLD && scoreToday < HEAT_HOT_THRESHOLD) {
      label = "Breakdown";
    } else if (Math.abs(change) <= 5) {
      label = "Holding";
    } else if (change > 5) {
      // Check for 2+ consecutive rising days to call it "Accelerating"
      // rather than just "Holding" with a small bounce
      const risingStreak = history.length >= 3 &&
        history.at(-1).score > history.at(-2).score &&
        history.at(-2).score > history.at(-3).score;
      label = risingStreak ? "Accelerating" : "Holding";
    } else {
      label = "Cooling";
    }

    return { label, scoreToday, scoreYesterday, change, history };
  } catch (e) {
    log(`⚠️ Momentum trend classification failed for ${asset}: ${e.message}`);
    return null;
  }
}


// ── V101: Momentum Leaderboard ──────────────────────────────────
// "Premier League standings" model, per spec. Runs every scan cycle
// internally (cheap -- just reads HEAT_SCORES, already in memory) but
// only POSTS to Bluejam when something alert-worthy actually changes:
// a new #1, an asset entering/exiting the top 3, a state transition,
// or a streak milestone. No constant feed, no spam.
//
// Language discipline (per explicit instruction): this NEVER says
// "buy", "hold position", "entering", or anything resembling a trade
// action. It reports model state only -- "JUP is ranked #1" not
// "buy JUP". Footer disclaimer is mandatory on every message.
//
// State ladder: Emerging -> Accelerating -> Leader -> Hold -> Cooling -> Exit
// Crucially: streak does NOT reset on a single dip below the Leader
// threshold. It only resets after 2 consecutive scans below the EXIT
// threshold (60) -- the whole point, per the JUP example, is that a
// one-day cooldown inside a real trend doesn't erase the streak.

const LEADERBOARD_LEADER_THRESHOLD  = 80;  // matches HEAT_HOT_THRESHOLD
const LEADERBOARD_HOLD_THRESHOLD    = 70;
const LEADERBOARD_COOLING_THRESHOLD = 60;
const LEADERBOARD_EXIT_SCANS        = 2;   // consecutive scans below 60 before actually exiting

// V101 REFINEMENT: display top 5 crypto, top 3 stocks. Per explicit
// instruction -- a longer list makes "everything look like a leader"
// and defeats the purpose. Internal tracking has no limit (every
// asset above the cooling threshold gets a momentum_leaderboard row
// and full state/streak history); only the PUBLIC-FACING display and
// the top-N change-detection alerts are capped.
const LEADERBOARD_DISPLAY_LIMIT = { CRYPTO: 5, US: 5 };

function scoreToLadderState(score) {
  if (score >= LEADERBOARD_LEADER_THRESHOLD)  return "Leader";
  if (score >= LEADERBOARD_HOLD_THRESHOLD)    return "Hold";
  if (score >= LEADERBOARD_COOLING_THRESHOLD) return "Cooling";
  return "BelowThreshold"; // not a public-facing state -- triggers exit counting
}

function isCryptoAsset(asset) { return asset.endsWith("USDT"); }

// Runs every cycle. Cheap -- HEAT_SCORES is already in memory, no API calls.
// Updates momentum_leaderboard in Supabase and returns a list of
// alert-worthy events for the caller to post (or not).
async function updateMomentumLeaderboard() {
  if (!supabaseEnabled) return [];

  const events = [];
  const trackedAssets = [...HEAT_SCORES.keys()];
  if (trackedAssets.length === 0) return [];

  try {
    const { data: existingRows, error: fetchErr } = await supabase
      .from("momentum_leaderboard")
      .select("*");
    if (fetchErr) {
      log(`⚠️ Leaderboard fetch error: ${fetchErr.message}`);
      return [];
    }
    const existing = new Map((existingRows || []).map(r => [r.asset, r]));

    const upserts = [];

    for (const asset of trackedAssets) {
      const score = Math.round(getHeat(asset));
      const market = isCryptoAsset(asset) ? "CRYPTO" : "US";
      const prior = existing.get(asset);
      const ladderState = scoreToLadderState(score);

      if (!prior) {
        // First time this asset has ever appeared -- Emerging if score is
        // building, straight to Leader if it shows up already hot.
        if (ladderState === "BelowThreshold") continue; // don't track noise below cooling threshold
        const initialState = ladderState === "Leader" ? "Leader" : ladderState === "Hold" ? "Emerging" : "Emerging";
        upserts.push({
          asset, market,
          state: initialState,
          previous_state: null,
          current_score: score,
          streak_scans: 1,
          below_exit_threshold_count: 0,
          first_detected_at: new Date().toISOString(),
          last_updated_at: new Date().toISOString(),
          exited_at: null,
        });
        if (initialState === "Leader") {
          events.push({ type: "new_leader_entry", asset, market, score });
        }
        continue;
      }

      // Existing asset -- apply the decay-not-reset streak rule.
      let newState = prior.state;
      let belowExitCount = prior.below_exit_threshold_count || 0;
      let streak = prior.streak_scans || 1;
      let exitedAt = prior.exited_at;

      if (ladderState === "BelowThreshold") {
        belowExitCount += 1;
        if (belowExitCount >= LEADERBOARD_EXIT_SCANS) {
          // Genuine exit -- 2+ consecutive scans below cooling threshold
          if (prior.state !== "Exit") {
            newState = "Exit";
            exitedAt = new Date().toISOString();
            events.push({ type: "exit", asset, market, score, previousState: prior.state, streak });
          }
          streak = 0; // only NOW does the streak actually reset
        }
        // else: still within grace period, keep prior state and streak alive
      } else {
        belowExitCount = 0; // back above cooling threshold, clear the exit counter
        streak += 1;

        // Accelerating check: was this asset rising into Leader from
        // Emerging/Accelerating, or already an established Leader/Hold
        // moving back up from Cooling?
        if (prior.state === "Exit") {
          // Re-entering after a genuine exit -- fresh Emerging, not a
          // continuation of the old streak.
          newState = ladderState === "Leader" ? "Leader" : "Emerging";
          streak = 1;
        } else if (score > prior.current_score + 5 && (prior.state === "Emerging" || prior.state === "Accelerating")) {
          newState = "Accelerating";
        } else if (ladderState === "Leader") {
          newState = "Leader";
        } else if (ladderState === "Hold") {
          newState = "Hold";
        } else if (ladderState === "Cooling") {
          newState = "Cooling";
        }
      }

      const stateChanged = newState !== prior.state;

      upserts.push({
        asset, market,
        state: newState,
        previous_state: stateChanged ? prior.state : prior.previous_state,
        current_score: score,
        streak_scans: streak,
        below_exit_threshold_count: belowExitCount,
        first_detected_at: prior.first_detected_at,
        last_updated_at: new Date().toISOString(),
        exited_at: exitedAt,
      });

      if (stateChanged && newState !== "Exit") {
        events.push({ type: "state_change", asset, market, from: prior.state, to: newState, score, streak });
      }
      // Streak milestones worth flagging -- 5, 10, 20, 50 scans
      if ([5, 10, 20, 50].includes(streak) && streak !== prior.streak_scans) {
        events.push({ type: "milestone", asset, market, streak, score, state: newState });
      }
    }

    if (upserts.length > 0) {
      const { error: upsertErr } = await retry(() =>
        supabase.from("momentum_leaderboard").upsert(upserts, { onConflict: "asset" })
      );
      if (upsertErr) log(`⚠️ Leaderboard upsert error: ${upsertErr.message}`);
    }

    // Detect top-N entry/exit by comparing ranked lists before/after,
    // per market, using the same display limit as the public leaderboard
    // (5 crypto, 3 stocks) -- so "entered Top 5" alerts match what
    // members actually see on the published table.
    for (const market of ["CRYPTO", "US"]) {
      const limit = LEADERBOARD_DISPLAY_LIMIT[market] || 5;
      const beforeTopN = [...existing.values()]
        .filter(r => r.market === market && r.state !== "Exit")
        .sort((a,b) => b.current_score - a.current_score)
        .slice(0, limit)
        .map(r => r.asset);
      const afterTopNRows = upserts
        .filter(r => r.market === market && r.state !== "Exit")
        .sort((a,b) => b.current_score - a.current_score)
        .slice(0, limit);
      const afterTopN = afterTopNRows.map(r => r.asset);

      const entered = afterTopN.filter(a => !beforeTopN.includes(a));
      const exited  = beforeTopN.filter(a => !afterTopN.includes(a));
      if (entered.length > 0 || exited.length > 0) {
        events.push({ type: "topN_change", market, limit, entered, exited, newTopN: afterTopN, newTopNRows: afterTopNRows });
      }
    }

    return events;
  } catch (e) {
    log(`⚠️ Leaderboard update exception: ${e.message}`);
    return [];
  }
}

const LEADERBOARD_DISCLAIMER = `⚠️ <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · The leaderboard reflects model observations only · @baretradesignals 🎯</i>`;

function stateEmoji(state) {
  return state === "Leader" ? "🔥" : state === "Hold" ? "⚡" : state === "Accelerating" ? "🚀"
       : state === "Emerging" ? "🌱" : state === "Cooling" ? "⚠️" : state === "Exit" ? "🔴" : "❓";
}

// V102: weekly Top 5 momentum digest -- requested as a calmer alternative
// to the real-time leaderboard pings (state_change/exit/topN_change), which
// fire on every small shift and are hard to read as "what actually has
// momentum". This is a single once-a-week snapshot instead. Matches the
// Top 5 scope used by the real-time entry/exit alerts.
async function buildWeeklyTop5Message(market) {
  if (!supabaseEnabled) return null;
  const { data, error } = await supabase
    .from("momentum_leaderboard")
    .select("*")
    .eq("market", market)
    .neq("state", "Exit")
    .order("current_score", { ascending: false })
    .limit(5);

  if (error || !data || data.length === 0) return null;

  const marketLabel = market === "CRYPTO" ? "🔥 CRYPTO -- TOP 5 MOMENTUM" : "📈 US STOCKS -- TOP 5 MOMENTUM";
  const rankEmoji = ["🥇","🥈","🥉","4️⃣","5️⃣"];
  const parts = [`<b>${marketLabel}</b>`, `<i>Weekly snapshot -- ${new Date().toISOString().slice(0,10)}</i>`, ``];

  data.forEach((row, i) => {
    const sym = row.asset.replace("USDT", "");
    parts.push(`${rankEmoji[i]||`${i+1}.`} <b>${escapeHtml(sym)}</b> -- ${stateEmoji(row.state)} ${row.state} (${row.streak_scans} scan${row.streak_scans===1?"":"s"} on board)`);
  });

  parts.push(``, LEADERBOARD_DISCLAIMER);
  return lines(parts);
}

let lastWeeklyTop10Date = "";

async function sendWeeklyTop10Digest() {
  const isFriday = new Date().getDay() === 5;
  if (!isFriday) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastWeeklyTop10Date === today) return;
  lastWeeklyTop10Date = today;

  const cryptoMsg = await buildWeeklyTop5Message("CRYPTO");
  if (cryptoMsg) { await sendPrivate(cryptoMsg); await sleep(500); }
  const usMsg = await buildWeeklyTop5Message("US");
  if (usMsg) await sendPrivate(usMsg);
}

function isFullyBlacked() {
  // On weekends only crypto trades at all, so crypto alone being blocked
  // IS a full blackout. On weekdays, need both markets blocked.
  return isWeekend() ? isCryptoBlocked() : (isCryptoBlocked() && isUSBlocked());
}
// ================================================================
// SNIPER V101 -- GITHUB PASTE-BOX SPLIT -- PART 3 OF 4
// Paste all 4 parts into the same file, in order, with no extra
// blank lines or edits at the seams. Concatenating parts 1-4
// reconstructs sniper_v101_full.js exactly.
// Fixes HIGH_BETA range-proxy volume fallback -- was gated to
// opening-window only, so real volume-data gaps mid-session
// (AVGO/SMR etc) silently zeroed out volRatio on otherwise-
// passing setups. Now applies whenever HIGH_BETA volume data
// is missing, any time of day. Plus universe expansion, weekly
// persistence report, first-fire/peak-score alerts, safety mode
// alert, ema_fail diagnostics, false_breakout gate, crypto pool
// dynamic fix, V94 reversion, and all prior session fixes.
// ================================================================

let lastSafetyModeDate = "";

// V102: daily SAFETY-mode transparency. Silence from the bot is
// otherwise indistinguishable from "nothing to fire on" vs "system
// blocked" -- this makes the blocked case explicit, once per day.
async function sendSafetyModeAlert() {
  if (!isFullyBlacked()) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastSafetyModeDate === today) return;
  lastSafetyModeDate = today;

  const reasons = [];
  if (isCryptoBlocked()) reasons.push(`🪙 CRYPTO: ${getProtectionReason("CRYPTO")}`);
  if (!isWeekend() && isUSBlocked()) reasons.push(`🇺🇸 US: ${getProtectionReason("US")}`);

  const msg = lines([
    "🛑 <b>SNIPER IN SAFETY MODE</b>",
    "",
    "No setups can fire right now -- this is not silence from a quiet market, the system is actively blocking entries.",
    "",
    ...reasons,
    "",
    "This message repeats once daily for as long as safety mode holds."
  ]);
  await safeRun("safetyModeAlert", () => sendPrivate(msg));
}



// V102: weekly persistence report -- which assets fired 10+ times this
// week, ranked by average score. Replaces the manual Supabase pull
// requested to be done every week by hand.
let lastPersistenceReportDate = "";

async function sendWeeklyPersistenceReport() {
  const isFriday = new Date().getDay() === 5;
  if (!isFriday) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastPersistenceReportDate === today) return;
  lastPersistenceReportDate = today;
  if (!supabaseEnabled) return;

  const since = new Date(Date.now() - 7*24*60*60*1000).toISOString();
  const { data, error } = await retry(() => supabase
    .from("trades")
    .select("asset, market, score, setupType, sentAt")
    .gte("sentAt", since)
  );
  if (error || !data || data.length === 0) {
    await sendPrivate("📌 <b>WEEKLY PERSISTENCE REPORT</b>\n\nNo fired signals in the last 7 days -- nothing to rank.");
    return;
  }

  const bySymbol = {};
  for (const row of data) {
    const key = `${row.asset}|${row.market}`;
    if (!bySymbol[key]) bySymbol[key] = { asset: row.asset, market: row.market, count: 0, scoreSum: 0, setups: {} };
    bySymbol[key].count++;
    bySymbol[key].scoreSum += (row.score || 0);
    bySymbol[key].setups[row.setupType] = (bySymbol[key].setups[row.setupType] || 0) + 1;
  }

  const ranked = Object.values(bySymbol)
    .filter(r => r.count >= 10)
    .map(r => ({ ...r, avgScore: r.scoreSum / r.count }))
    .sort((a,b) => b.avgScore - a.avgScore);

  const parts = ["📌 <b>WEEKLY PERSISTENCE REPORT</b>", "<i>Assets that fired 10+ times this week, ranked by avg score</i>", ""];
  if (ranked.length === 0) {
    parts.push("No asset fired 10+ times this week.");
  } else {
    for (const r of ranked.slice(0, 20)) {
      const marketTag = r.market === "CRYPTO" ? "🪙" : r.market === "US" ? "🇺🇸" : "🇬🇧";
      const topSetup = Object.entries(r.setups).sort((a,b)=>b[1]-a[1])[0]?.[0] || "—";
      parts.push(`  ${marketTag} <b>${escapeHtml(r.asset)}</b> — ${r.count}x fired · avg score ${r.avgScore.toFixed(1)} · mostly ${escapeHtml(topSetup)}`);
    }
  }
  await sendPrivate(lines(parts));
}

async function buildLeaderboardMessage(market) {
  if (!supabaseEnabled) return null;
  const limit = LEADERBOARD_DISPLAY_LIMIT[market] || 5;
  const { data, error } = await supabase
    .from("momentum_leaderboard")
    .select("*")
    .eq("market", market)
    .neq("state", "Exit")
    .order("current_score", { ascending: false })
    .limit(limit);

  if (error || !data || data.length === 0) return null;

  const marketLabel = market === "CRYPTO" ? "🔥 CRYPTO LEADERS" : "📈 STOCK LEADERS";
  // Medals for top 3, numbered keycap emoji for 4th/5th (crypto only goes to 5)
  const rankEmoji = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
  const parts = [`<b>${marketLabel}</b>`, ``];

  data.forEach((row, i) => {
    const rank = rankEmoji[i] || `${i+1}.`;
    const sym = row.asset.replace("USDT", "");
    parts.push(`${rank} <b>${escapeHtml(sym)}</b>`);
    parts.push(`   State: ${stateEmoji(row.state)} ${row.state}`);
    parts.push(`   Leaderboard Streak: ${row.streak_scans} scan${row.streak_scans===1?"":"s"}`);
    parts.push(``);
  });

  parts.push(`The ${market === "CRYPTO" ? "Sniper crypto" : "Sniper stock"} model ranks these among the strongest momentum opportunities currently being detected.`);
  parts.push(``);
  parts.push(LEADERBOARD_DISCLAIMER);

  return lines(parts);
}

// Builds and sends an alert for a single event, per the "Premier League
// standings -- only post when something changes" rule. Each event type
// gets its own focused message rather than dumping the whole table.
async function postLeaderboardEvent(event) {
  const sym = event.asset ? event.asset.replace("USDT","") : null;
  const marketLabel = event.market === "CRYPTO" ? "Crypto" : "Stock";
  let msg = null;

  if (event.type === "state_change") {
    const fromLabel = event.from || "New";
    msg = lines([
      `🔥 <b>MOMENTUM STATE CHANGE</b>`,
      ``,
      `<b>${escapeHtml(sym)}</b> (${marketLabel})`,
      `State: ${fromLabel} ➜ ${event.to}`,
      ``,
      event.to === "Cooling"
        ? `Momentum strength has weakened versus recent scans.`
        : event.to === "Accelerating"
        ? `Momentum is building -- rate of increase has picked up.`
        : `Momentum state updated based on the latest scan.`,
      ``,
      LEADERBOARD_DISCLAIMER,
    ]);
  } else if (event.type === "new_leader_entry") {
    msg = lines([
      `🔥 <b>NEW MOMENTUM LEADER</b>`,
      ``,
      `<b>${escapeHtml(sym)}</b> (${marketLabel}) has entered Leader state.`,
      ``,
      LEADERBOARD_DISCLAIMER,
    ]);
  } else if (event.type === "exit") {
    msg = lines([
      `🔴 <b>MOMENTUM LEADERBOARD EXIT</b>`,
      ``,
      `<b>${escapeHtml(sym)}</b> (${marketLabel})`,
      `Removed after ${event.streak} scan${event.streak===1?"":"s"} on the board (was: ${event.previousState}).`,
      ``,
      LEADERBOARD_DISCLAIMER,
    ]);
  } else if (event.type === "milestone") {
    msg = lines([
      `🏆 <b>LEADERBOARD MILESTONE</b>`,
      ``,
      `<b>${escapeHtml(sym)}</b> (${marketLabel}) has held ${event.state} status for ${event.streak} consecutive scans.`,
      ``,
      LEADERBOARD_DISCLAIMER,
    ]);
  } else if (event.type === "topN_change") {
    const limit = event.limit || 5;
    const parts = [`🔥 <b>MOMENTUM LEADERSHIP CHANGE</b>`, ``, `<b>${event.market === "CRYPTO" ? "Crypto" : "Stock"} Top ${limit}</b>`, ``];
    for (const a of event.entered) parts.push(`⬆ ${escapeHtml(a.replace("USDT",""))} enters Top ${limit}`);
    for (const a of event.exited)  parts.push(`⬇ ${escapeHtml(a.replace("USDT",""))} exits Top ${limit}`);
    parts.push(``);
    parts.push(`<b>Current Top ${limit}:</b>`);
    const rankEmoji = ["🥇","🥈","🥉","4️⃣","5️⃣"];
    const rows = event.newTopNRows || (event.newTopN || []).map(a => ({ asset: a, state: null, streak_scans: null }));
    rows.forEach((r,i) => {
      const sym = r.asset.replace("USDT","");
      const detail = r.state ? ` -- ${stateEmoji(r.state)} ${r.state} (${r.streak_scans} scan${r.streak_scans===1?"":"s"})` : "";
      parts.push(`${rankEmoji[i]||`${i+1}.`} <b>${escapeHtml(sym)}</b>${detail}`);
    });
    parts.push(``);
    parts.push(LEADERBOARD_DISCLAIMER);
    msg = lines(parts);
  }

  if (msg) await sendPrivate(msg);
}

// Entry point -- call every scan cycle. Cheap when nothing changes
// (one Supabase read, no writes, no messages sent).
async function runMomentumLeaderboardCheck() {
  try {
    const events = await updateMomentumLeaderboard();
    for (const event of events) {
      await postLeaderboardEvent(event);
      log(`🏆 Leaderboard event: ${event.type} -- ${event.asset || event.market}`);
    }
  } catch (e) {
    log(`⚠️ Leaderboard check exception: ${e.message}`);
  }
}


async function runWeeklyRegimeJob() {
  const isSunday = new Date().getDay() === 0;
  if (!isSunday) return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastRegimeJobDate === today) return;
  lastRegimeJobDate = today;
  if (!supabaseEnabled) { log("⚠️ Regime job skipped -- Supabase disabled"); return; }

  log("📊 Weekly regime classification starting...");

  // Deliberately NOT looping CRYPTO_PAIRS -- that list rotates hourly
  // (trending coins in/out), which would leave gaps in a coin's
  // history every time it drops out of the dynamic pool. The stable
  // curated list is the right universe for a longitudinal table.
  const universe = [...new Set(STATIC_CRYPTO_FALLBACK)];

  const btcDaily = await fetchCryptoDailyWithFallback("BTCUSDT", 250);
  if (!btcDaily || btcDaily.length < 200) {
    log("⚠️ Regime job aborted -- BTC daily history unavailable");
    return;
  }
  const btcCloses = btcDaily.map(c => c.close);

  const rows = [];
  for (const symbol of universe) {
    try {
      const daily = await fetchCryptoDailyWithFallback(symbol, 250);
      if (!daily) { log(`⚠️ ${symbol} -- no daily history, skipping`); continue; }
      const closes = daily.map(c => c.close);
      const dates  = daily.map(c => c.date);
      const row = classifyCoinRegimeRow(symbol, closes, dates, btcCloses);
      rows.push(row);
      log(`📊 ${symbol}: regime=${row.regime} rotation=${row.rotation_score} trend=${row.trend_score} recoveries=${row.recovery_count}`);
    } catch (e) {
      log(`⚠️ Regime classification failed for ${symbol}: ${e.message}`);
    }
  }

  if (rows.length === 0) { log("⚠️ Regime job -- no rows to insert"); return; }

  try {
    // INSERT only -- never upsert. crypto_regimes is append-only,
    // keyed on (symbol, date). Upserting on symbol would overwrite
    // last week's snapshot, destroying the exact history the V101
    // audit depends on.
    const { error } = await retry(() => supabase.from("crypto_regimes").insert(rows));
    if (error) {
      log(`❌ Supabase regime insert error: ${error.message} (code: ${error.code})`);
    } else {
      log(`✅ Regime classification complete -- ${rows.length} rows inserted`);
    }
  } catch (e) {
    log(`❌ Supabase regime insert exception: ${e.message}`);
  }
}

// ── Market open/close alerts + forced pool refresh ───────────────────────
async function checkMarketAlerts() {
  const checks = [
    { key:"CRYPTO", isOpen:isCryptoWindowOpen },
    { key:"US",     isOpen:isUSMarketOpen     },
    { key:"LSE",    isOpen:isLSEMarketOpen    }
  ];
  for (const { key, isOpen } of checks) {
    const nowOpen = isOpen();
    if (nowOpen && !marketWasOpen[key]) {
      log(`🟢 ${key} open -- forcing pool refresh`);
      await safeRun(`poolRefreshOn${key}Open`, () => refreshDynamicPools(true));
      if (key !== "CRYPTO") {
        const msgs = {
          US:  `\uD83D\uDFE2\uD83C\uDDFA\uD83C\uDDF8 <b>US MARKET OPEN</b>\n\uD83D\uDCE1 QQQ trend: <b>${escapeHtml(qqqTrend.replace("_"," ").toUpperCase())}</b>\n\uD83D\uDD0D ${STOCK_POOL.length} stocks in pool`,
          LSE: `\uD83D\uDFE2\uD83C\uDDEC\uD83C\uDDE7 <b>LSE MARKET OPEN</b>\n\uD83D\uDD0D ${LSE_POOL.length} stocks in pool`
        };
        await safeRun(`open${key}`, () => sendChannel(msgs[key]));
        // V98: fire fresh intel at market open -- pre-market intel goes stale by 14:30
        // Subscribers need live conditions at open not estimates from 90 mins earlier
        if (key === "US") {
          await safeRun("openingIntel", () => refreshDynamicPools(true));
        }
      }
    }
    if (!nowOpen && marketWasOpen[key]) {
      log(`🔴 ${key} closed`);
      // Crypto is 24/7 -- no open/close messages needed
      if (key !== "CRYPTO") {
        const msgs = {
          US:  `\uD83D\uDD34\uD83C\uDDFA\uD83C\uDDF8 <b>US MARKET CLOSED</b>`,
          LSE: `\uD83D\uDD34\uD83C\uDDEC\uD83C\uDDE7 <b>LSE MARKET CLOSED</b>`
        };
        await safeRun(`close${key}`, () => sendChannel(msgs[key]));
        // V98: send rejection stats to Bluejam on US close
        if (key === "US") await safeRun("rejectStats", sendRejectStatsSummary);
        // V98: send public performance report to channel on US close
        if (key === "US") await safeRun("perfReport", sendPerformanceReport);
        // V100: send plain English end of day report to Bluejam (private)
        if (key === "US") await safeRun("eodReport",   sendEndOfDayReport);
      }
    }
    marketWasOpen[key] = nowOpen;
  }

  // V101 FIX: the jobs below were previously inside the US open->close
  // TRANSITION block above, which only fires when marketWasOpen flips from
  // true to false. On Sunday, US was already closed from Saturday, so that
  // transition never happens and these never ran -- including the existing
  // Sunday weeklyAudit/regimeJob, which had the same bug. Checking them here,
  // every cycle, fixes this for all of them. Each function still self-gates
  // on day-of-week internally, so this is safe to call repeatedly.
  // V100: weekly self-audit every Sunday
  await safeRun("weeklyAudit", sendWeeklyAudit);
  // V101: weekly regime classification every Sunday
  await safeRun("regimeJob", runWeeklyRegimeJob);
  // V101: daily momentum trend snapshot -- every day, not just Sunday/Friday.
  // This is what makes Emerging/Accelerating/Holding/Cooling/Breakdown
  // possible -- needs a snapshot every single day to compare against.
  await safeRun("momentumSnapshot", runDailyMomentumSnapshot);
  // V101: daily price tracking -- enables forward-return queries for the leaderboard audit
  await safeRun("priceTracking", runDailyPriceTracking);
  // V101: midweek performance check-in -- Wednesday only, Bluejam only
  await safeRun("midweekCheckin", sendMidweekCheckin);
  // V101: full week in review -- Friday, after US close, Bluejam only
  await safeRun("weekInReview", sendWeekInReview);
  await safeRun("weeklyTop10", sendWeeklyTop10Digest);
  await safeRun("weeklyPersistence", sendWeeklyPersistenceReport);
  // V101: on the radar -- Sunday only, crypto only, Bluejam only
  // Runs after regimeJob (called just above) so it reads freshly-inserted rows
  await safeRun("onTheRadar", sendOnTheRadar);
}
// ================================================================
// (legacy marker from the old function-boundary 3-part split -- superseded)
// See the V101 banners below for the current equal-length split points.
// Contains: all data fetchers + full analyse() engine
// ================================================================

// ── Data fetching ────────────────────────────────────────────────
async function fetchCrypto(symbol) {
  const cacheKey = `crypto_15m_${symbol}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/klines", {
        params: {symbol, interval:"15m", limit:100}, timeout:12000
      })
    );
    const candles = data.map(k => ({close:+k[4],high:+k[2],low:+k[3],volume:+k[5]}));
    setCache(cacheKey, candles);
    return candles;
  } catch { return null; }
}

async function fetchCrypto1h(symbol) {
  const cacheKey = `crypto_1h_${symbol}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/klines", {
        params: {symbol, interval:"1h", limit:70}, timeout:12000
      })
    );
    const candles = data.map(k => ({close:+k[4],high:+k[2],low:+k[3],volume:+k[5]}));
    setCache(cacheKey, candles);
    return candles;
  } catch { return null; }
}

// ================================================================
// V101: REGIME CLASSIFICATION (crypto_regimes) -- DATA LAYER
// Evidence-gathering only. No alerts. No scoring impact.
// Requires crypto_regimes.sql to be run in Supabase first.
// ================================================================

// ── Daily candles for regime classification ──────────────────────
// Separate from fetchCrypto/fetchCrypto1h -- those top out around a
// few days of history. Regime classification needs 200+ daily closes.
async function fetchCryptoDaily(symbol, limit = 250) {
  const cacheKey = `crypto_1d_${symbol}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/klines", {
        params: { symbol, interval: "1d", limit }, timeout: 15000
      })
    );
    const candles = data.map(k => ({
      date:  new Date(+k[0]).toISOString().slice(0, 10),
      close: +k[4], high: +k[2], low: +k[3], volume: +k[5]
    }));
    setCache(cacheKey, candles);
    return candles;
  } catch { return null; }
}

async function fetchCryptoDailyWithFallback(symbol, limit = 250) {
  const primary = await fetchCryptoDaily(symbol, limit);
  if (primary && primary.length >= 200) return primary;
  log(`📡 ${symbol} -- Binance daily failed/short, trying Bybit`);
  try {
    const { data } = await retry(() =>
      axios.get("https://api.bybit.com/v5/market/kline", {
        params: { category: "linear", symbol, interval: "D", limit },
        timeout: 15000
      })
    );
    if (data?.retCode !== 0 || !Array.isArray(data?.result?.list)) return primary;
    const candles = data.result.list.reverse().map(k => ({
      date:  new Date(+k[0]).toISOString().slice(0, 10),
      close: +k[4], high: +k[2], low: +k[3], volume: +k[5]
    }));
    return candles.length > (primary?.length || 0) ? candles : primary;
  } catch { return primary; }
}

// ── Regime classification core ────────────────────────────────────
// Self-contained -- deliberately does NOT reuse the global ema()
// above. That one returns a single trailing value for a whole array
// (fine for scoring); this needs the EMA's value at many points in
// time to compute slope, so it needs its own series version.
function regimePctChange(a, b) { return a === 0 ? 0 : (b - a) / a; }
function regimeClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function regimeEmaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function regimeScoreFromSlope(slopePct, extreme = 0.15) {
  const c = regimeClamp(slopePct, -extreme, extreme);
  return ((c + extreme) / (2 * extreme)) * 100;
}

// Standard zigzag -- a new pivot confirms once price reverses by
// `threshold` from the running extreme. Feeds HH/HL scoring and the
// expansion/retracement/recovery counts.
function findRegimeSwings(closes, dates, threshold = 0.08) {
  const swings = [];
  let trend = null, extremeVal = closes[0], extremeIdx = 0;
  for (let i = 1; i < closes.length; i++) {
    const price = closes[i];
    if (trend === null) {
      if (price >= extremeVal * (1 + threshold)) { trend = "up"; extremeVal = price; extremeIdx = i; }
      else if (price <= extremeVal * (1 - threshold)) { trend = "down"; extremeVal = price; extremeIdx = i; }
      else if (price > extremeVal) { extremeVal = price; extremeIdx = i; }
      else if (price < extremeVal) { extremeVal = price; extremeIdx = i; }
      continue;
    }
    if (trend === "up") {
      if (price > extremeVal) { extremeVal = price; extremeIdx = i; }
      else if (price <= extremeVal * (1 - threshold)) {
        swings.push({ idx: extremeIdx, date: dates[extremeIdx], price: extremeVal, type: "high" });
        trend = "down"; extremeVal = price; extremeIdx = i;
      }
    } else {
      if (price < extremeVal) { extremeVal = price; extremeIdx = i; }
      else if (price >= extremeVal * (1 + threshold)) {
        swings.push({ idx: extremeIdx, date: dates[extremeIdx], price: extremeVal, type: "low" });
        trend = "up"; extremeVal = price; extremeIdx = i;
      }
    }
  }
  swings.push({ idx: extremeIdx, date: dates[extremeIdx], price: extremeVal, type: trend === "down" ? "low" : "high" });
  return swings;
}

function regimeLegsFromSwings(swings) {
  const legs = [];
  for (let i = 1; i < swings.length; i++) {
    const from = swings[i - 1], to = swings[i];
    const pct = regimePctChange(from.price, to.price);
    legs.push({ from, to, pct, type: pct >= 0 ? "up" : "down" });
  }
  return legs;
}

function regimeHhHlScore(swings, lookback = 8) {
  const recent = swings.slice(-lookback);
  const highs = recent.filter(s => s.type === "high");
  const lows  = recent.filter(s => s.type === "low");
  let hh = 0, hl = 0;
  for (let i = 1; i < highs.length; i++) if (highs[i].price > highs[i - 1].price) hh++;
  for (let i = 1; i < lows.length; i++)  if (lows[i].price > lows[i - 1].price) hl++;
  const possible = Math.max(highs.length - 1, 0) + Math.max(lows.length - 1, 0);
  if (possible === 0) return 50;
  return ((hh + hl) / possible) * 100;
}

function regimeDistanceFrom200Score(price, ma200) {
  const dist = regimePctChange(ma200, price);
  const c = regimeClamp(dist, -0.3, 0.3);
  return ((c + 0.3) / 0.6) * 100;
}

function calcRegimeTrendScore({ closes, ema50Series, ema200Series, swings, slopeLookback = 20 }) {
  const lastIdx = closes.length - 1;
  const ema50Slope  = regimePctChange(ema50Series[lastIdx - slopeLookback], ema50Series[lastIdx]);
  const ema200Slope = regimePctChange(ema200Series[lastIdx - slopeLookback], ema200Series[lastIdx]);
  const s50  = regimeScoreFromSlope(ema50Slope);
  const s200 = regimeScoreFromSlope(ema200Slope, 0.10);
  const hhhl = regimeHhHlScore(swings);
  const distScore = regimeDistanceFrom200Score(closes[lastIdx], ema200Series[lastIdx]);
  return Math.round(s50 * 0.30 + s200 * 0.25 + hhhl * 0.25 + distScore * 0.20);
}

// recoveryCount = expansions that followed a qualifying retrace.
// The FIRST expansion never counts -- it has nothing to recover from.
// This is the "proven serial offender" metric, not just expansion count.
function calcRegimeRotationScore(legs, { expansionPct = 0.20, retracePct = 0.15 } = {}) {
  const expansions    = legs.filter(l => l.type === "up" && l.pct >= expansionPct);
  const retracements  = legs.filter(l => l.type === "down" && l.pct <= -retracePct);
  let recoveryCount = 0, returnToBase = 0;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.type !== "up" || leg.pct < expansionPct) continue;
    if (i === 0) continue;
    const prevLeg = legs[i - 1];
    if (prevLeg.type === "down" && prevLeg.pct <= -retracePct) {
      recoveryCount++;
      const priorExpansion = legs[i - 2];
      if (priorExpansion && priorExpansion.type === "up") {
        const baseLevel = priorExpansion.from.price;
        const troughLevel = prevLeg.to.price;
        if (Math.abs(regimePctChange(baseLevel, troughLevel)) < 0.15) returnToBase++;
      }
    }
  }

  let score = Math.min(recoveryCount, 4) * 20;
  score += Math.min(returnToBase, 2) * 10;

  return {
    score: Math.min(100, score),
    expansionCount: expansions.length,
    retraceCount: retracements.length,
    recoveryCount,
    avgCycleDays: calcRegimeAvgCycleDays(expansions),
    lastExpansion: expansions[expansions.length - 1] || null,
    lastRetrace: retracements[retracements.length - 1] || null,
  };
}

function calcRegimeAvgCycleDays(expansions) {
  if (expansions.length < 2) return null;
  const starts = expansions.map(e => new Date(e.from.date).getTime());
  let total = 0;
  for (let i = 1; i < starts.length; i++) total += (starts[i] - starts[i - 1]) / 86400000;
  return Math.round(total / (starts.length - 1));
}

function calcRegimeRelativeStrength(coinCloses, btcCloses, days = 90) {
  const cReturn = regimePctChange(coinCloses[coinCloses.length - 1 - days], coinCloses[coinCloses.length - 1]);
  const bReturn = regimePctChange(btcCloses[btcCloses.length - 1 - days], btcCloses[btcCloses.length - 1]);
  const relPerf = cReturn - bReturn;
  const c = regimeClamp(relPerf, -0.5, 0.5);
  return Math.round(((c + 0.5) / 1.0) * 100);
}

function classifyRegimeLabel({ trendScore, rotationScore, relativeStrength }, opts = {}) {
  const {
    trendThreshold = 70,
    rotationThreshold = 60,
    deadCatRelStrength = 30,
    deadCatTrendCeiling = 40,
  } = opts;
  if (trendScore >= trendThreshold) return "TRENDING";
  if (rotationScore >= rotationThreshold) return "ROTATING";
  if (relativeStrength <= deadCatRelStrength && trendScore < deadCatTrendCeiling) return "DEAD_CAT";
  return "NEUTRAL";
}

// Main entry point. Returns a row matching crypto_regimes.sql exactly.
function classifyCoinRegimeRow(symbol, closes, dates, btcCloses) {
  if (closes.length < 200 || btcCloses.length < 200) {
    return {
      symbol, date: dates[dates.length - 1] || null,
      regime: "INSUFFICIENT_DATA", confidence: null,
      trend_score: null, rotation_score: null, relative_strength: null,
      expansion_count: null, retrace_count: null, recovery_count: null,
      last_expansion_days: null, last_retrace_pct: null,
      cycle_count: null, avg_cycle_days: null,
    };
  }

  const ema50Series  = regimeEmaSeries(closes, 50);
  const ema200Series = regimeEmaSeries(closes, 200);
  const swings = findRegimeSwings(closes, dates, 0.08);
  const legs   = regimeLegsFromSwings(swings);

  const trendScore  = calcRegimeTrendScore({ closes, ema50Series, ema200Series, swings });
  const rotation     = calcRegimeRotationScore(legs);
  const relStrength  = calcRegimeRelativeStrength(closes, btcCloses);
  const regime = classifyRegimeLabel({ trendScore, rotationScore: rotation.score, relativeStrength: relStrength });

  const daysSince = sw => sw ? Math.round((new Date(dates[dates.length - 1]) - new Date(sw.to.date)) / 86400000) : null;

  return {
    symbol,
    date: dates[dates.length - 1],
    regime,
    confidence: rotation.recoveryCount + (regime === "TRENDING" ? Math.round(trendScore / 10) : 0),
    trend_score: trendScore,
    rotation_score: rotation.score,
    relative_strength: relStrength,
    expansion_count: rotation.expansionCount,
    retrace_count: rotation.retraceCount,
    recovery_count: rotation.recoveryCount,
    last_expansion_days: daysSince(rotation.lastExpansion),
    last_retrace_pct: rotation.lastRetrace ? Math.round(rotation.lastRetrace.pct * 100) : null,
    cycle_count: rotation.recoveryCount,
    avg_cycle_days: rotation.avgCycleDays,
  };
}
// ================================================================
// END V101 REGIME CLASSIFICATION -- DATA LAYER
// ================================================================

async function fetchCrypto5m(symbol) {
  // V100: 5-minute candles for Sniper Engine execution timing
  // 15m determines trend/bias -- 5m determines the actual entry trigger
  const cacheKey = `crypto_5m_${symbol}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/klines", {
        params: {symbol, interval:"5m", limit:60}, timeout:12000
      })
    );
    const candles = data.map(k => ({
      open:+k[1], close:+k[4], high:+k[2], low:+k[3], volume:+k[5],
      openTime:+k[0]
    }));
    setCache(cacheKey, candles);
    return candles;
  } catch { return null; }
}
// Backup crypto candle source when Binance fails or is slow
// Uses Bybit V5 kline endpoint -- same USDT pairs as Binance
async function fetchBybitCandles(symbol, interval = "15", limit = 100) {
  const cacheKey = `bybit_${interval}_${symbol}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  try {
    const { data } = await retry(() =>
      axios.get("https://api.bybit.com/v5/market/kline", {
        params: { category: "linear", symbol, interval, limit },
        timeout: 12000
      })
    );
    if (data?.retCode !== 0 || !Array.isArray(data?.result?.list)) return null;
    // Bybit returns newest first -- reverse to oldest first
    const candles = data.result.list.reverse().map(k => ({
      close:  +k[4],
      high:   +k[2],
      low:    +k[3],
      volume: +k[5]
    }));
    setCache(cacheKey, candles);
    return candles;
  } catch { return null; }
}

// fetchCrypto with Bybit fallback
async function fetchCryptoWithFallback(symbol) {
  const primary = await fetchCrypto(symbol);
  if (primary && primary.length >= 20) return primary;
  log(`📡 ${symbol} -- Binance failed, trying Bybit`);
  return await fetchBybitCandles(symbol, "15", 100);
}

// ── DexScreener (no key required) ───────────────────────────────
// Early momentum detection -- catches moves before they hit CEX
// Used for trending token discovery to augment crypto pool
let dexScreenerCache = { data: [], ts: 0 };
const DEXSCREENER_TTL = 10 * 60 * 1000; // 10 mins

async function getDexScreenerTrending() {
  if (Date.now() - dexScreenerCache.ts < DEXSCREENER_TTL && dexScreenerCache.data.length > 0) {
    return dexScreenerCache.data;
  }
  try {
    const { data } = await retry(() =>
      axios.get("https://api.dexscreener.com/token-boosts/top/v1", {
        timeout: 10000
      })
    );
    if (!Array.isArray(data)) return [];
    // Extract symbols that match our approved list format
    const trending = data
      .filter(t => t?.tokenAddress && t?.chainId === "solana" || t?.chainId === "ethereum")
      .map(t => t?.header?.replace(/[^A-Z]/g, "") || "")
      .filter(sym => sym.length >= 2 && sym.length <= 8)
      .slice(0, 10);
    dexScreenerCache = { data: trending, ts: Date.now() };
    log(`🦎 DexScreener trending: ${trending.join(", ") || "none"}`);
    return trending;
  } catch (e) {
    log(`⚠️ DexScreener failed: ${e.message}`);
    return [];
  }
}

// ── DexScreener momentum scanner ────────────────────────────────
// Scans top pairs on DexScreener for explosive moves
// Used to detect early ONDO-type narratives before CEX catches up
async function getDexScreenerMomentum() {
  try {
    const { data } = await retry(() =>
      axios.get("https://api.dexscreener.com/latest/dex/search", {
        params: { q: "volume" },
        timeout: 10000
      })
    );
    if (!Array.isArray(data?.pairs)) return [];
    return data.pairs
      .filter(p =>
        p.priceChangeH1 >= 10 &&   // 10%+ in last hour
        p.volume?.h1 >= 500000 &&   // $500k+ volume
        p.liquidity?.usd >= 100000  // $100k+ liquidity (not a rugpull)
      )
      .slice(0, 5)
      .map(p => ({
        symbol: p.baseToken?.symbol || "",
        change1h: p.priceChangeH1,
        volume1h: p.volume?.h1,
        chain: p.chainId
      }));
  } catch { return []; }
}

async function fetchTwelveDataSeries(symbol, interval="1h", outputsize=70) {
  if (!TWELVE_DATA_API_KEY) return null;
  // Hard daily credit guard
  if (apiUsage.twelvedata >= 700) {
    log(`⚠️ TD daily limit reached (${apiUsage.twelvedata}/700) -- using Yahoo`);
    return null;
  }
  // V98: per-minute rate limit guard -- free tier = 8/min hard limit
  if (!canUseTDThisMinute()) return null;
  try {
    const { data } = await retry(() =>
      axios.get("https://api.twelvedata.com/time_series", {
        params: {symbol,interval,outputsize,order:"ASC",apikey:TWELVE_DATA_API_KEY},
        timeout:15000
      })
    );
    // V98: log TD errors so we can see rate limit messages
    if (data?.status==="error") {
      log(`⚠️ TD ERROR ${symbol}: ${data?.message||"unknown"}`);
      return null;
    }
    if (!Array.isArray(data?.values)) return null;
    apiUsage.twelvedata++;
    return data.values
      .map(row => ({close:+row.close,high:+row.high,low:+row.low,volume:+row.volume}))
      .filter(x => Number.isFinite(x.close) && Number.isFinite(x.high) && Number.isFinite(x.low));
  } catch { return null; }
}

async function fetchAlphaVantageSeries(symbol, interval="60min") {
  if (!ALPHA_VANTAGE_API_KEY) return null;
  try {
    const { data } = await retry(() =>
      axios.get("https://www.alphavantage.co/query", {
        params: {function:"TIME_SERIES_INTRADAY",symbol,interval,outputsize:"compact",apikey:ALPHA_VANTAGE_API_KEY},
        timeout:15000
      })
    );
    const series = data[`Time Series (${interval})`];
    if (!series) return null;
    apiUsage.alphavantage++;
    return Object.entries(series)
      .sort(([a],[b]) => new Date(a)-new Date(b))
      .map(([,v]) => ({close:+v["4. close"],high:+v["2. high"],low:+v["3. low"],volume:+v["5. volume"]}))
      .filter(x => Number.isFinite(x.close));
  } catch { return null; }
}

// ── Alpaca Markets (15-min US stock bars) ────────────────────────
// V98: switched from feed=iex to feed=sip with 16-min delayed end
// IEX = single exchange = only 10-16 bars per session (sparse)
// SIP = consolidated all US exchanges = full bars = root cause fix
async function fetchAlpacaBars(symbol, timeframe = "15Min", limit = 60) {
  if (!ALPACA_API_KEY || !ALPACA_SECRET_KEY) return null;
  const cacheKey = `alpaca_${timeframe}_${symbol}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  try {
    // SIP requires end >= 15 mins old on free tier
    // Use 16 min buffer to ensure eligibility
    const endTime   = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const startTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await retry(() =>
      axios.get(`https://data.alpaca.markets/v2/stocks/${symbol}/bars`, {
        params: {
          timeframe,
          start: startTime,
          end:   endTime,
          limit: 1000,       // V98: raised from 60 -- page size not total limit
          adjustment: "raw",
          feed: "sip"
        },
        headers: {
          "APCA-API-KEY-ID":     ALPACA_API_KEY,
          "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY
        },
        timeout: 12000
      })
    );
    if (!Array.isArray(data?.bars) || data.bars.length === 0) return null;
    const candles = data.bars.map(b => ({
      close:  +b.c,
      high:   +b.h,
      low:    +b.l,
      volume: +b.v
    }));
    log(`🦙 Alpaca SIP ${symbol} -- ${candles.length} bars`);
    setCache(cacheKey, candles);
    return candles;
  } catch (e) {
    log(`⚠️ Alpaca failed ${symbol}: ${e.message}`);
    return null;
  }
}

// ── Polygon.io (US stock bars) ───────────────────────────────────
// Better intraday data than Yahoo -- real volume, proper OHLCV
// Used for standard US stocks outside HIGH_BETA opening window
// Free tier: unlimited requests, 15-min delayed data
async function fetchPolygonBars(symbol, timespan = "hour", multiplier = 1, days = 30) {
  if (!POLYGON_API_KEY) return null;
  const cacheKey = `polygon_${timespan}_${symbol}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  try {
    const to   = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
    const { data } = await retry(() =>
      axios.get(`${POLYGON_BASE_URL}/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${from}/${to}`, {
        params: { adjusted: true, sort: "asc", limit: 200, apiKey: POLYGON_API_KEY },
        timeout: 12000
      })
    );
    if (data?.status === "ERROR" || !Array.isArray(data?.results) || data.results.length === 0) {
      if (data?.status === "ERROR") log(`⚠️ Polygon ERROR ${symbol}: ${data?.error||"unknown"}`);
      return null;
    }
    const candles = data.results.map(b => ({
      close:  +b.c,
      high:   +b.h,
      low:    +b.l,
      volume: +b.v
    }));
    log(`🔷 Polygon ${symbol} -- ${candles.length} ${timespan} bars`);
    setCache(cacheKey, candles);
    return candles;
  } catch (e) {
    log(`⚠️ Polygon failed ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchYahooFinanceSeries(symbol, interval="1h") {
  const yahooInterval = interval==="15min"?"15m":interval==="5min"?"5m":interval==="1d"?"1d":"1h";
  const range         = yahooInterval==="5m"?"2d":yahooInterval==="15m"?"10d":yahooInterval==="1d"?"30d":"60d"; // V98: 15m range 2d->10d for more candles
  try {
    const { data } = await retry(() =>
      axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
        params: {interval:yahooInterval,range,includePrePost:false},
        headers: {"User-Agent":"Mozilla/5.0"}, timeout:15000
      })
    );
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators?.quote?.[0];
    if (!q) return null;
    return (result.timestamp||[])
      .map((_,i) => ({close:q.close[i]||0,high:q.high[i]||0,low:q.low[i]||0,volume:q.volume[i]||0}))
      .filter(x => Number.isFinite(x.close) && x.close>0);
  } catch (e) { log(`Yahoo failed ${symbol}:`, e.message); return null; }
}

// V101: daily-bar fetcher for weekly performance reporting (Wed/Fri/Sun intel).
// Reuses fetchYahooFinanceSeries with interval=1d -- separate name so call
// sites are self-documenting. Cache key includes the date so it naturally
// refreshes once per day rather than relying on the short-lived global TTL
// used for live trading candles.
async function fetchUSDailyForReport(symbol) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const cacheKey = `us_daily_report_${symbol}_${dateKey}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const candles = await fetchYahooFinanceSeries(symbol, "1d");
  if (candles) setCache(cacheKey, candles);
  return candles;
}

// V98: Yahoo 5-min aggregated to 15-min for HIGH_BETA during opening window
// No signup needed -- uses Yahoo's free v8 endpoint
// Gives intraday candle structure that 1h candles completely miss
async function fetchYahoo5mAs15m(symbol) {
  try {
    const fiveMin = await fetchYahooFinanceSeries(symbol, "5min");
    if (!fiveMin || fiveMin.length < 3) return null;
    // Aggregate 5-min candles into 15-min candles (3 candles per period)
    const candles = [];
    for (let i = 0; i + 2 < fiveMin.length; i += 3) {
      const group = fiveMin.slice(i, i + 3);
      candles.push({
        close:  group.at(-1).close,
        high:   Math.max(...group.map(c => c.high)),
        low:    Math.min(...group.map(c => c.low)),
        volume: group.reduce((s, c) => s + c.volume, 0)
      });
    }
    return candles.length >= 20 ? candles : null;
  } catch { return null; }
}

// ── Stooq (no key required, delayed intraday) ────────────────────
// Better than Yahoo for fallback -- no rate limiting, delayed OHLCV
// Used when Yahoo throttles standard US stocks
async function fetchStooqBars(symbol) {
  const cacheKey = `stooq_${symbol}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  try {
    const { data } = await retry(() =>
      axios.get(`https://stooq.com/q/d/l/`, {
        params: { s: `${symbol}.us`, i: "d" }, // daily bars
        timeout: 10000,
        responseType: "text"
      })
    );
    if (!data || data.includes("No data")) return null;
    const lines = data.trim().split("\n").slice(1); // skip header
    const candles = lines.map(line => {
      const [date, open, high, low, close, volume] = line.split(",");
      return {
        close:  +close,
        high:   +high,
        low:    +low,
        volume: +volume || 0
      };
    }).filter(x => Number.isFinite(x.close) && x.close > 0);
    if (candles.length === 0) return null;
    log(`📈 Stooq ${symbol} -- ${candles.length} daily bars`);
    setCache(cacheKey, candles);
    return candles;
  } catch { return null; }
}

async function fetchUSData(symbol) {
  const use15min = isUSOpeningWindow();
  const highBetaSym = isHighBeta(symbol);
  const interval = use15min ? "15min" : "1h";
  const cacheKey = `us_${symbol}_${interval}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  resetApiUsageIfNewDay();
  const ukMins = getUkMinutes();
  // Standard US stocks go straight to Yahoo -- no point burning credits on MSFT/AMZN
  const worthTDCredit = highBetaSym || symbol === "QQQ" || symbol === "SPY";
  const inTDWindow = isWeekday() && ukMins >= 840 && ukMins < 930 && apiUsage.twelvedata < 600 && worthTDCredit;
  const api = inTDWindow ? pickApiForSymbol() : "yahoo";

  let candles = null;

  // V98: Alpaca primary for HIGH_BETA during opening window
  // Real 15-min bars -- replaces stale Yahoo 1h completely
  // Falls back to Yahoo 5m→15m, then TwelveData, then Yahoo 1h
  if (use15min && highBetaSym) {
    candles = await fetchAlpacaBars(symbol, "15Min", 60);
    if (candles) {
      setCache(cacheKey, candles);
      return candles;
    }
    // Alpaca failed -- try Yahoo 5m aggregated (top 5 names only)
    if (TOP_HIGHBETA_5M.includes(symbol)) {
      candles = await fetchYahoo5mAs15m(symbol);
      if (candles) {
        log(`📊 ${symbol} -- Yahoo 5m→15m fallback`);
        setCache(cacheKey, candles);
        return candles;
      }
    }
  }

  if (api === "twelvedata") {
    candles = await fetchTwelveDataSeries(symbol, interval, use15min?40:70);
    if (candles) log(`📡 ${symbol} -- TD ${interval} (${candles.length} candles)`);
    if (!candles) candles = await fetchAlphaVantageSeries(symbol, use15min?"15min":"60min");
  } else if (api === "alphavantage") {
    candles = await fetchAlphaVantageSeries(symbol, use15min?"15min":"60min");
    if (!candles) candles = await fetchTwelveDataSeries(symbol, interval, use15min?40:70);
  }
  // V98: Polygon as primary for standard US stocks -- better than Yahoo 1h
  // Real volume data, proper OHLCV, free tier unlimited requests
  if (!candles && !highBetaSym && POLYGON_API_KEY) {
    candles = await fetchPolygonBars(symbol, "hour", 1, 30);
  }
  if (!candles) {
    log(`🆓 Yahoo ${interval} for ${symbol}`);
    candles = await fetchYahooFinanceSeries(symbol, interval);
    if (candles && candles.length > 0) {
      log(`📊 ${symbol} -- Yahoo ${interval} (${candles.length} candles)`);
    } else {
      // Yahoo throttled -- try Polygon then Stooq as backup
      if (!highBetaSym && POLYGON_API_KEY) {
        log(`🔷 Yahoo throttled ${symbol} -- trying Polygon`);
        candles = await fetchPolygonBars(symbol, "hour", 1, 30);
      }
      if (!candles && !highBetaSym) {
        log(`📈 Trying Stooq for ${symbol}`);
        candles = await fetchStooqBars(symbol);
      }
    }
  }
  if (candles) setCache(cacheKey, candles);
  return candles;
}

async function fetchLSEData(symbol) {
  const cacheKey = `lse_${symbol}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;
  // V98: hard 3-second timeout with proper axios timeout -- prevents scan cycle timeouts
  let candles = null;
  try {
    const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.L`, {
      params: {interval:"1h", range:"60d", includePrePost:false},
      headers: {"User-Agent":"Mozilla/5.0"},
      timeout: 3000  // hard 3s -- if Yahoo doesn't respond in 3s skip it
    });
    const result = data?.chart?.result?.[0];
    if (result) {
      const q = result.indicators?.quote?.[0];
      if (q) {
        candles = (result.timestamp||[])
          .map((_,i) => ({close:q.close[i]||0,high:q.high[i]||0,low:q.low[i]||0,volume:q.volume[i]||0}))
          .filter(x => Number.isFinite(x.close) && x.close>0);
      }
    }
  } catch { /* Yahoo timed out or throttled -- fall through to Stooq */ }
  if (!candles || candles.length === 0) {
    try {
      const stooqSym = symbol.replace(".L","").toLowerCase() + ".uk";
      candles = await fetchStooqBars(stooqSym);
    } catch { /* Stooq also failed */ }
  }
  if (candles && candles.length > 0) setCache(cacheKey, candles);
  return candles;
}

async function fetchLivePrice(asset, market) {
  try {
    if (market === "CRYPTO") {
      const { data } = await retry(() =>
        axios.get("https://data-api.binance.vision/api/v3/ticker/price", {
          params:{symbol:asset}, timeout:10000
        })
      );
      return +data.price;
    }
    // TD guard -- only use TD for live prices during opening window and within credit budget
    const ukMins = getUkMinutes();
    const inTDWindow = isWeekday() && ukMins >= 840 && ukMins < 930 && apiUsage.twelvedata < 600;
    if (inTDWindow && TWELVE_DATA_API_KEY) {
      try {
        const { data } = await retry(() =>
          axios.get("https://api.twelvedata.com/price", {
            params:{symbol:asset,apikey:TWELVE_DATA_API_KEY}, timeout:12000
          })
        );
        if (data?.status!=="error") { apiUsage.twelvedata++; return +data.price; }
      } catch { /* fall through */ }
    }
    if (ALPHA_VANTAGE_API_KEY) {
      try {
        const { data } = await retry(() =>
          axios.get("https://www.alphavantage.co/query", {
            params:{function:"GLOBAL_QUOTE",symbol:asset,apikey:ALPHA_VANTAGE_API_KEY}, timeout:12000
          })
        );
        const price = +data?.["Global Quote"]?.["05. price"];
        if (Number.isFinite(price)) { apiUsage.alphavantage++; return price; }
      } catch { /* fall through */ }
    }
    const { data } = await retry(() =>
      axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${asset}`, {
        params:{interval:"1m",range:"1d"}, headers:{"User-Agent":"Mozilla/5.0"}, timeout:10000
      })
    );
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return Number.isFinite(price) ? price : null;
  } catch { return null; }
}

// ── Trend updates ────────────────────────────────────────────────
async function updateBTCTrend() {
  const candles = await fetchCrypto1h("BTCUSDT");
  if (!candles) return;
  const closes = candles.map(x=>x.close);
  const prev   = btcTrend;
  btcTrend = classifyRegime(ema(closes,20), ema(closes,50), closes.at(-1));
  if (btcTrend !== prev) log(`📡 BTC trend: ${prev} -> ${btcTrend}`);
}

// V100: 4h macro trend -- anchors regime against intraday noise
// Fetches 4h BTC candles, updates btcMacroTrend
// Called every refresh cycle (hourly) -- not every scan
async function updateBTCMacroTrend() {
  try {
    const { data } = await retry(() =>
      axios.get("https://data-api.binance.vision/api/v3/klines", {
        params: { symbol:"BTCUSDT", interval:"4h", limit:60 }, timeout:12000
      })
    );
    const closes = data.map(k => +k[4]);
    const prev   = btcMacroTrend;
    btcMacroTrend = classifyRegime(ema(closes,20), ema(closes,50), closes.at(-1));
    if (btcMacroTrend !== prev) {
      log(`📡 BTC MACRO trend (4h): ${prev} -> ${btcMacroTrend}`);
      // Alert on macro regime change
      if (btcMacroTrend === "risk_off") {
        log("🛡️ MACRO PROTECTION ACTIVATED -- 4h BTC bearish");
      } else if (prev === "risk_off") {
        log("✅ MACRO PROTECTION LIFTED -- 4h BTC recovering");
      }
    }
  } catch (err) {
    log(`⚠️ BTC macro trend update failed: ${err?.message||err}`);
  }
}

async function updateQQQTrend() {
  if (!ENABLE_US || !isUSMarketOpen()) {
    // Outside US hours keep last known trend -- neutral suppresses US scores unnecessarily
    return;
  }
  const candles = await fetchUSData("QQQ");
  // V98: if Yahoo fails QQQ fetch, keep last known trend instead of resetting to neutral
  // Yahoo fails frequently on weekends and during rate limiting
  // Resetting to neutral incorrectly suppresses all US stock scores
  if (!candles) {
    log(`⚠️ QQQ fetch failed -- keeping last known trend: ${qqqTrend}`);
    return;
  }
  // V100 FIX: Polygon sometimes returns only 3-8 bars for QQQ when Yahoo is rate-limited.
  // With <30 candles, EMA20/EMA50 are meaningless and classifyRegime returns neutral/risk_off,
  // incorrectly resetting qqqBullCount to 0 and blocking ALL US signals despite a real bull market.
  // Guard: require at least 30 candles before trusting the regime classification.
  if (candles.length < 30) {
    log(`⚠️ QQQ only ${candles.length} candles -- insufficient for EMA, keeping last known trend: ${qqqTrend}`);
    // Still increment bullCount if we were already bull -- don't let bad data kill a confirmed trend
    if (qqqTrend === "bull" || qqqTrend === "strong_bull") {
      qqqBullCount = Math.min(qqqBullCount + 1, 10);
      log(`📊 QQQ stability: ${qqqBullCount} consecutive bull readings (held from prior data)`);
    }
    return;
  }
  const closes = candles.map(x=>x.close);
  const prev   = qqqTrend;
  qqqTrend = classifyRegime(ema(closes,20), ema(closes,50), closes.at(-1));
  if (qqqTrend !== prev) log(`📡 QQQ trend: ${prev} -> ${qqqTrend}`);
  // V100: track consecutive bull readings -- requires stability before US signals fire
  // Prevents firing into choppy opens where QQQ oscillates bull/neutral
  if (qqqTrend === "bull" || qqqTrend === "strong_bull") {
    qqqBullCount = Math.min(qqqBullCount + 1, 10);
  } else {
    qqqBullCount = 0; // reset immediately on any non-bull reading
  }
  log(`📊 QQQ stability: ${qqqBullCount} consecutive bull readings`);
}

// ── Narrative bonus ──────────────────────────────────────────────
// ── Relative strength vs QQQ ─────────────────────────────────────
// Measures how much stronger this stock is vs the index
// SMCI +6% with QQQ +0.5% = relative strength 5.5% = leader
// This is alpha-producing -- institutional money flows to leaders
let _qqqMomentumCache = { mom: 0, ts: 0 };

async function getQQQMomentum() {
  if (Date.now() - _qqqMomentumCache.ts < 5 * 60 * 1000) return _qqqMomentumCache.mom;
  try {
    const candles = await fetchUSData("QQQ");
    if (!candles || candles.length < 2) return 0;
    const mom = (candles.at(-1).close - candles.at(-2).close) / candles.at(-2).close;
    _qqqMomentumCache = { mom, ts: Date.now() };
    return mom;
  } catch { return 0; }
}

function getRelativeStrengthBonus(stockMomentum, qqqMomentum) {
  const relStrength = stockMomentum - qqqMomentum;
  if (relStrength > 0.05)      return 12; // exceptional leader -- 5%+ stronger than QQQ
  if (relStrength > 0.03)      return 8;  // strong leader
  if (relStrength > 0.015)     return 4;  // modest leader
  if (relStrength < -0.02)     return -6; // lagging -- negative signal
  return 0;
}

// ── Momentum persistence (higher lows after expansion) ───────────
// Detects institutional accumulation: big move then higher lows = controlled
// Random pumps make lower lows after expansion = distribution
function getMomentumPersistenceBonus(candles) {
  if (!candles || candles.length < 12) return 0;
  const recent = candles.slice(-8);
  const lows   = recent.map(c => c.low);

  // Check for higher lows pattern in last 6 candles
  let higherLows = 0;
  for (let i = 1; i < lows.length; i++) {
    if (lows[i] > lows[i-1]) higherLows++;
  }

  const ratio = higherLows / (lows.length - 1);
  if (ratio >= 0.75) return 8;  // very persistent -- institutional buying
  if (ratio >= 0.55) return 4;  // moderately persistent
  if (ratio <= 0.25) return -4; // deteriorating -- lower lows forming
  return 0;
}

// ── Trend Resumption detection ───────────────────────────────────
// Gap-day continuation: stock gaps up, holds above session low,
// consolidates for 2-4 candles, then resumes higher
// This is the IONQ/LUNR/ASTS pattern -- no EMA20 proximity needed
// Uses intraday structure: impulse > pause > continuation
function isTrendResumption(candles, inUSOpen, highBeta) {
  if (!highBeta || !inUSOpen) return false;
  if (!candles || candles.length < 10) return false;

  const recent  = candles.slice(-8);
  const closes  = recent.map(c => c.close);
  const highs   = recent.map(c => c.high);
  const lows    = recent.map(c => c.low);
  const volumes = recent.map(c => c.volume || 0);

  // Step 1: Was there an impulsive opening move?
  // First 2 candles should show strong directional move
  const openMove = closes[0] > 0
    ? (closes[1] - closes[0]) / closes[0]
    : 0;
  if (openMove < 0.015) return false; // need 1.5%+ opening impulse

  // Step 2: Did it consolidate? (volume contracted, range tightened)
  const impulseHigh  = Math.max(...highs.slice(0, 3));
  const consoleLows  = lows.slice(2, 6);
  const consoleHighs = highs.slice(2, 6);
  const consoleRange = Math.max(...consoleHighs) - Math.min(...consoleLows);
  const impulseRange = highs[1] - lows[0];
  const consolidated = impulseRange > 0 && consoleRange < impulseRange * 0.6;

  // Step 3: Is price holding above session low? (not giving back the gap)
  const sessionLow  = Math.min(...lows);
  const currentClose = closes.at(-1);
  const holdingGap   = currentClose > sessionLow * 1.01; // 1% above session low

  // Step 4: Is current candle resuming? (green and above consolidation midpoint)
  const consoleMid = (Math.max(...consoleHighs) + Math.min(...consoleLows)) / 2;
  const resuming   = currentClose > consoleMid && closes.at(-1) > closes.at(-2);

  return consolidated && holdingGap && resuming;
}

// ── First Pullback Continuation (Step 5 pattern) ─────────────────
// "I don't want the first 2% of the move. I don't want the last 2%.
//  I want the middle 60-70% where the trend is confirmed."
//
// AUDIT FLAG: this is the definition that has actually been running at every
// call site -- the other isFirstPullbackContinuation (search STAGE3_TAPER
// above) was dead code, shadowed by this one via hoisting. See that comment.
//
// Catches assets that already made a strong move (intel flagged them),
// consolidated/paused, and are now showing renewed upward momentum.
// This is the NEAR/JUP pattern: +6-8% on the day, pause, then a fresh
// up-tick on the most recent candle = buy the continuation, not the spike.
function isFirstPullbackContinuation(candles) {
  if (!candles || candles.length < 10) return false;

  const recent  = candles.slice(-8);
  const closes  = recent.map(c => c.close);
  const highs   = recent.map(c => c.high);
  const lows    = recent.map(c => c.low);

  // Step 1: Was there a prior impulsive move? (look at first half of window)
  const impulseStart = closes[0];
  const impulseHigh  = Math.max(...highs.slice(0, 5));
  const impulseMove  = impulseStart > 0 ? (impulseHigh - impulseStart) / impulseStart : 0;
  if (impulseMove < 0.02) return false; // need 2%+ prior move to qualify as "already moved"

  // Step 2: Did it pause/consolidate after the impulse?
  // Range over candles 4-7 should be tighter than the impulse range
  const impulseRange = impulseHigh - Math.min(...lows.slice(0, 5));
  const pauseHighs   = highs.slice(4, 7);
  const pauseLows    = lows.slice(4, 7);
  const pauseRange   = pauseHighs.length > 0 ? Math.max(...pauseHighs) - Math.min(...pauseLows) : Infinity;
  const consolidated = impulseRange > 0 && pauseRange < impulseRange * 0.65;

  // Step 3: Is price still holding the gains? (not giving back the move)
  const pauseLow    = pauseLows.length > 0 ? Math.min(...pauseLows) : 0;
  const holdingGains = pauseLow > impulseStart * 1.01; // still 1%+ above where impulse started

  // Step 4: Is the current candle resuming upward?
  // Last close above the pause midpoint AND higher than prior close
  const pauseMid = pauseHighs.length > 0
    ? (Math.max(...pauseHighs) + Math.min(...pauseLows)) / 2
    : closes.at(-2);
  const resuming = closes.at(-1) > pauseMid && closes.at(-1) > closes.at(-2);

  return consolidated && holdingGains && resuming;
}

function getNarrativeBonus(asset) {
  let bonus = 0;
  const sym = asset.replace("USDT","");
  for (const sector of HOT_SECTORS) {
    if ((SECTOR_SYMBOLS[sector]||[]).includes(sym)) bonus += 6;
  }
  if (HOT_SECTORS.includes("AI") && CRYPTO_AI_NAMES.includes(asset)) bonus += 5;
  return bonus;
}

// ── Emoji helpers ────────────────────────────────────────────────
function gradeEmoji(g)  { return g==="A*"?"\uD83D\uDC8E\uD83D\uDD25":g==="A"?"\uD83D\uDE80\u26A1":"\uD83D\uDCC8"; }
function setupEmoji(t)  {
  const map = {
    BREAKOUT_CONTINUATION:  "\uD83D\uDCA5",
    PULLBACK_CONTINUATION:  "\uD83C\uDFAF",
    MOMENTUM_BREAKOUT:      "\uD83D\uDD25",
    MOMENTUM_IGNITION:      "\u26A1",
    GAP_CONTINUATION:       "\uD83D\uDE80",
    PRE_BREAKOUT_EXPANSION: "\uD83D\uDCC8",
    TREND_RESUMPTION:       "\uD83D\uDD04"  // resuming after consolidation
  };
  return map[t] || "\uD83D\uDCCA";
}
function marketEmoji(m) { return m==="CRYPTO"?"\uD83E\uDE99":m==="US"?"\uD83C\uDDFA\uD83C\uDDF8":m==="LSE"?"\uD83C\uDDEC\uD83C\uDDE7":"\uD83D\uDCCA"; }

// ================================================================
// DUAL-MODE ANALYSIS ENGINE
// Mode 1: Trend continuation (crypto, standard stocks, ETFs)
// Mode 2: Momentum runner (HIGH_BETA stocks + gap-up detection)
// ================================================================

async function analyse(asset, candles, market, prefetchedQqqMom = null) {
  // V98: opening window stocks only have 8-16 bars at 15min -- use lower minimum
  // (kept -- data-availability handling, not a trading-philosophy filter)
  const inOpeningWindow = market === "US" && isUSOpeningWindow();
  const minCandles = inOpeningWindow ? MIN_CANDLES_OPENING : MIN_CANDLES;
  if (!candles || candles.length < minCandles) {
    if (candles) log(`⛔ ${asset} -- not enough candles (${candles.length} < ${minCandles})`);
    return null;
  }

  // V98: verbose checkpoint logging for HIGH_BETA US stocks (kept -- diagnostic only)
  const isVerbose = market === "US" && isHighBeta(asset);
  const checkpoint = (label, passed, detail = "") => {
    if (!isVerbose) return;
    const icon = passed ? "✓" : "✗";
    log(`  ${icon} ${asset} [${label}]${detail ? " -- " + detail : ""}`);
  };

  let setupType = null;

  const closes  = candles.map(x => x.close);
  const highs   = candles.map(x => x.high);
  const lows    = candles.map(x => x.low);
  const volumes = candles.map(x => x.volume||0);

  const last = closes.at(-1);
  const prev = closes.at(-2);
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) return null;

  const momentum = (last - prev) / prev;

  // ── Mode selection ────────────────────────────────────────────
  const inUSOpen  = market === "US" && isUSOpeningWindow();
  const highBeta  = market === "US" && isHighBeta(asset);
  const useMode2  = highBeta || (market === "US" && inUSOpen && detectGap(candles).gapped);

  // ── Parabolic exhaustion hard block (V94: present) ────────────
  const pct24h = market === "CRYPTO" ? (get24hrMomentum(asset) || 0) : 0;
  if (isParabolicExhaustion(candles, pct24h, market === "CRYPTO" ? btcTrend : "neutral")) {
    log(`⛔ ${asset} -- parabolic exhaustion blocked`);
    return null;
  }

  // ── Momentum decay filter (crypto only) -- V94: present ────────
  if (market === "CRYPTO") {
    const recent4hHigh     = Math.max(...highs.slice(-16));
    const drawdownFromHigh = recent4hHigh > 0 ? (last - recent4hHigh) / recent4hHigh : 0;
    const shortMomentum    = closes.at(-3) > 0 ? (closes.at(-1) - closes.at(-3)) / closes.at(-3) : 0;
    const mediumMomentum   = closes.at(-8) > 0 ? (closes.at(-1) - closes.at(-8)) / closes.at(-8) : 0;

    const momentumDecaying =
      pct24h > 0.10 &&
      drawdownFromHigh < -0.04 &&
      shortMomentum < 0 &&
      mediumMomentum < 0.03;

    if (momentumDecaying) {
      log(`🚫 ${asset} -- momentum decay (24h=${(pct24h*100).toFixed(1)}% drawdown=${(drawdownFromHigh*100).toFixed(1)}% shortMom=${(shortMomentum*100).toFixed(2)}%)`);
      return null;
    }

    // ── Lower highs distribution filter -- V94: present ───────────
    const recentHighs = highs.slice(-6);
    if (recentHighs.length >= 6) {
      const lowerHighs =
        recentHighs[5] < recentHighs[3] &&
        recentHighs[3] < recentHighs[1];

      if (pct24h > 0.08 && lowerHighs) {
        log(`🚫 ${asset} -- lower highs after expansion (distribution)`);
        return null;
      }
    }
  }

  // ── Minimum momentum -- V94: hard reject, no soft-penalty tier ─
  const minMomentum = market === "CRYPTO" ? CRYPTO_15M_MIN_MOMENTUM
                    : (highBeta && inUSOpen) ? 0
                    : inUSOpen              ? 0.003
                    : 0;
  if (momentum <= minMomentum) {
    checkpoint("momentum", false, `${(momentum*100).toFixed(2)}% <= ${(minMomentum*100).toFixed(2)}%`);
    if (market !== "LSE") {
      reject("momentum_low", asset, market);
      rejectDiagnostics.push({
        symbol: asset, asset, market,
        decision: "REJECT", reason: "momentum_low", reject_reason: "momentum_low",
        engine_version: "V101", scan_timestamp: new Date().toISOString(),
        momentum, btc_regime: btcTrend, qqq_regime: qqqTrend,
        notes: `momentum ${(momentum*100).toFixed(3)}% (V94 hard floor ${(minMomentum*100).toFixed(3)}%, no soft penalty)`
      });
    }
    return null;
  }
  checkpoint("momentum", true, `${(momentum*100).toFixed(2)}%`);

  // ── EMA structure -- V94: hard reject, no soft-penalty tier ────
  const ema20     = ema(closes, 20);
  const ema50     = ema(closes, 50);
  const ema20Prev = ema(closes.slice(0,-1), 20);

  let emaOk;
  if (useMode2 && inUSOpen) {
    emaOk = ema20 > ema20Prev && last > ema50;
  } else if (useMode2) {
    emaOk = ema20 > ema50 && ema20 > ema20Prev;
  } else if (market === "LSE") {
    emaOk = ema20 > ema50 && ema20 > ema20Prev;
  } else if (market === "CRYPTO") {
    emaOk = ema20 > ema50 && ema20 > ema20Prev;
  } else {
    emaOk = ema20 > ema50 && last > ema20 && ema20 > ema20Prev;
  }

  if (!emaOk) {
    checkpoint("EMA", false, `ema20=${ema20.toFixed(2)} ema50=${ema50.toFixed(2)} last=${last.toFixed(2)}`);
    reject("ema_fail", asset, market);
    const ema20vs50Pct  = ema50 > 0 ? ((ema20 - ema50) / ema50) * 100 : 0;
    const ema20vsPrevPct = ema20Prev > 0 ? ((ema20 - ema20Prev) / ema20Prev) * 100 : 0;
    const lastVsEma20Pct = ema20 > 0 ? ((last - ema20) / ema20) * 100 : 0;
    rejectDiagnostics.push({
      symbol: asset, asset, market,
      decision: "REJECT", reason: "ema_fail", reject_reason: "ema_fail",
      engine_version: "V101", scan_timestamp: new Date().toISOString(),
      momentum, btc_regime: btcTrend, qqq_regime: qqqTrend,
      notes: `mode=${useMode2?"2":"1"} ema20vsEma50=${ema20vs50Pct.toFixed(2)}% ema20vsPrev=${ema20vsPrevPct.toFixed(2)}% lastVsEma20=${lastVsEma20Pct.toFixed(2)}% `
           + `(need: ${useMode2 && inUSOpen ? "ema20>prev AND last>ema50" : "ema20>ema50 AND ema20>prev" + (market!=="CRYPTO"&&market!=="LSE"&&!useMode2?" AND last>ema20":"")})`
    });
    return null;
  }
  checkpoint("EMA", true);

  // ── Volume -- V94: no two-candle confirmation, no vol-trend penalty ─
  const rawVolumes = volumes.filter(v => v > 0);
  const avgVol   = rawVolumes.length >= 5 ? avg(rawVolumes.slice(-21,-1)) : 0;
  const lastVol  = volumes.at(-1);
  let volRatio;
  if (avgVol > 0 && lastVol > 0) {
    volRatio = lastVol / avgVol;
  } else if (avgVol === 0 && highBeta) {
    // FIX: was gated to `&& inUSOpen`, so real volume-data gaps outside the
    // opening window (e.g. AVGO/SMR mid-session) got no fallback at all and
    // silently failed every volume-gated check on an otherwise-passing setup.
    // The missing-data problem isn't time-of-day specific, so neither should
    // the fallback be.
    const lastRange  = (highs.at(-1) - lows.at(-1)) / (closes.at(-1) || 1);
    const priorRange = avg(highs.slice(-6,-1).map((h,i) => (h - lows.slice(-6,-1)[i]) / (closes.slice(-6,-1)[i] || 1)));
    volRatio = priorRange > 0 ? lastRange / priorRange : 1.0;
    log(`📊 ${asset} -- no volume data, using range proxy volRatio=${volRatio.toFixed(2)}${inUSOpen ? "" : " (outside opening window)"}`);
  } else {
    volRatio = 0;
  }
  if (!Number.isFinite(volRatio) || volRatio < 0) volRatio = 0;

  // ── Extension limit (unchanged -- ATR-adjusted HIGH_BETA logic already matches V94) ─
  const extension = (last - ema20) / ema20;
  let extensionLimit;
  if (market === "CRYPTO") {
    extensionLimit = CRYPTO_15M_EXTENSION_LIMIT;
  } else if (highBeta) {
    const atr = calculateATR(candles, ATR_PERIOD);
    const atrPct = atr && last > 0 ? atr / last : 0;
    const atrUnitsExtended = atrPct > 0 ? extension / atrPct : 99;
    const atrLimit = inUSOpen ? 8 : 5;
    extensionLimit = atrUnitsExtended <= atrLimit
      ? Math.max(inUSOpen ? EXTENSION_LIMIT_HB_OW : EXTENSION_LIMIT_HB, extension + 0.001)
      : inUSOpen ? EXTENSION_LIMIT_HB_OW : EXTENSION_LIMIT_HB;

    const pmData = getPreMarketPrice(asset);
    if (pmData && Math.abs(pmData.changePct) >= 5 && inUSOpen) {
      extensionLimit = Math.max(extensionLimit, 0.50);
      log(`📡 ${asset} -- pre-market gap ${pmData.changePct.toFixed(1)}% -- extension limit widened`);
    }
  } else if (inUSOpen) {
    extensionLimit = 0.18;
  } else if (market === "US") {
    extensionLimit = 0.10;
  } else {
    extensionLimit = EXTENSION_LIMIT_LSE;
  }

  if (extension > extensionLimit) {
    reject("extension", asset, market); return null;
  }

  // ── Regime -- V94: hard gate + exceptionalCrypto override ──────
  // (replaces V101's soft BTC/QQQ score-modifier system entirely)
  const exceptionalCrypto = market === "CRYPTO" && momentum >= REGIME_OVERRIDE_MIN_MOMENTUM && volRatio >= REGIME_OVERRIDE_MIN_VOL;
  if (!regimePass(market) && !exceptionalCrypto) {
    checkpoint("regime", false, `btc=${btcTrend} qqq=${qqqTrend}`);
    reject("regime", asset, market);
    rejectDiagnostics.push({
      symbol: asset, asset, market,
      decision: "REJECT", reason: "regime", reject_reason: "regime",
      engine_version: "V101", scan_timestamp: new Date().toISOString(),
      momentum, volume_ratio: volRatio, btc_regime: btcTrend, qqq_regime: qqqTrend,
      notes: `regimePass=false, exceptionalCrypto=false (need momentum>=${(REGIME_OVERRIDE_MIN_MOMENTUM*100).toFixed(1)}% vol>=${REGIME_OVERRIDE_MIN_VOL}x to override) -- actual mom=${(momentum*100).toFixed(2)}% vol=${volRatio.toFixed(2)}x`
    });
    return null;
  }
  if (exceptionalCrypto && !regimePass(market)) {
    log(`⚡ Regime override: ${asset}`);
  }
  checkpoint("regime", true, `btc=${btcTrend} qqq=${qqqTrend}`);

  // ── Breakout / pullback / gap detection ───────────────────────
  const breakoutLevel    = Math.max(...highs.slice(-BREAKOUT_LOOKBACK,-1));
  const breakoutDistance = breakoutLevel > 0 ? (last - breakoutLevel)/breakoutLevel : 0;

  const breakoutDistLimit = market==="CRYPTO" ? CRYPTO_15M_BREAKOUT_DIST
                          : highBeta          ? BREAKOUT_DIST_HB
                          : market==="US"     ? BREAKOUT_DIST_US_STD
                          : BREAKOUT_DIST_LSE;

  const breakoutVolNeeded = market==="CRYPTO" ? CRYPTO_15M_BREAKOUT_VOL
                          : highBeta          ? US_BREAKOUT_VOL_HB
                          : market==="US"     ? US_BREAKOUT_VOL_STD
                          : LSE_BREAKOUT_VOL;

  const pullbackVolNeeded = market==="CRYPTO" ? CRYPTO_15M_PULLBACK_VOL
                          : highBeta          ? US_PULLBACK_VOL_HB
                          : market==="US"     ? US_PULLBACK_VOL_STD
                          : LSE_PULLBACK_VOL;

  const recentRanges   = highs.slice(-5,-1).map((h,i) => h-lows.slice(-5,-1)[i]).filter(Number.isFinite);
  const priorRanges    = highs.slice(-10,-5).map((h,i) => h-lows.slice(-10,-5)[i]).filter(Number.isFinite);
  const expandingRange = avg(recentRanges)>0 && avg(priorRanges)>0 && avg(recentRanges)>avg(priorRanges)*1.3;

  // GAP_CONTINUATION -- Mode 2 only
  const { gapped, gapPct } = detectGap(candles);
  const gapContinuationSignal = useMode2 && gapped && gapPct >= 0.05 && volRatio >= 2.0 && isOpeningDrive(candles);

  // MOMENTUM_IGNITION -- V94 thresholds (looser than V96+: 2%/1.5%/2.5%, vol>2.0,
  // no BTC-regime sub-requirement, no US-opening timing gate)
  const ignitionMomThreshold = market==="CRYPTO" ? 0.02 : (inUSOpen||highBeta) ? 0.015 : 0.025;
  const ignitionSignal = momentum > ignitionMomThreshold && volRatio > 2.0 &&
    (useMode2 ? true : (last > ema20 && expandingRange));

  // MOMENTUM_BREAKOUT
  const strongMomentumOverride = market==="US" && STOCK_MOMENTUM_OVERRIDE_ENABLED &&
    momentum >= STOCK_OVERRIDE_MIN_MOMENTUM && volRatio >= STOCK_OVERRIDE_MIN_VOL &&
    breakoutDistance <= STOCK_OVERRIDE_MAX_DISTANCE;

  // BREAKOUT_CONTINUATION -- V94: no US-opening 45min wait, no INTEL_STOCKS exemption
  const breakoutThreshold = market === "LSE" ? breakoutLevel * 0.997 : breakoutLevel;
  const breakoutSignal = last >= breakoutThreshold &&
    breakoutDistance <= breakoutDistLimit &&
    volRatio >= breakoutVolNeeded &&
    momentum >= (market==="US" ? MIN_US_MOMENTUM : market==="LSE" ? MIN_LSE_MOMENTUM : 0);

  // PULLBACK_CONTINUATION -- V94: no genuine-dip requirement, no timing gate
  const nearEMAThreshold   = market==="US" ? 0.02 : 0.025;
  const nearEMA20          = Math.abs(last - ema20)/ema20 <= nearEMAThreshold;
  const pulledBackRecently = closes.slice(-6,-1).some(c => c <= ema20*1.01);
  const pullbackSignal     = nearEMA20 && pulledBackRecently && volRatio >= pullbackVolNeeded;

  // First pullback continuation (Stage 3) -- Mode 2
  const firstPullbackCont = useMode2 && isFirstPullbackContinuation(candles) && volRatio >= 1.2;

  // PRE_BREAKOUT_EXPANSION
  const pbeATRUnits = getMoveInATRUnits(pct24h, candles);
  const preBreakoutExpansion = market === "CRYPTO" &&
    momentum > 0.012 &&
    volRatio > 1.8 &&
    last > ema20 &&
    breakoutDistance > -0.01 &&
    breakoutDistance < 0.015 &&
    getMoveMaturity(candles) === "expansion" &&
    regimePass(market) &&
    pbeATRUnits <= 5;

  // V94 setup types only -- no TREND_RESUMPTION, no BROAD_MOMENTUM (both post-V94)
  if (!pullbackSignal && !breakoutSignal && !strongMomentumOverride && !ignitionSignal && !gapContinuationSignal && !firstPullbackCont && !preBreakoutExpansion) {
    if (market === "US" && isHighBeta(asset)) {
      log(`  ✗ ${asset} [setup] | break=${breakoutSignal} pull=${pullbackSignal} ign=${ignitionSignal} gap=${gapContinuationSignal} | vol=${volRatio.toFixed(2)}x breakDist=${(breakoutDistance*100).toFixed(2)}% nearEMA=${nearEMA20}`);
    }
    checkpoint("setup", false, "no pattern detected");
    reject("no_setup", asset, market);
    rejectDiagnostics.push({
      symbol: asset, asset, market,
      decision: "REJECT", reason: "no_setup", reject_reason: "no_setup",
      engine_version: "V101", scan_timestamp: new Date().toISOString(),
      momentum, volume_ratio: volRatio, btc_regime: btcTrend, qqq_regime: qqqTrend,
      notes: `break=${breakoutSignal} pull=${pullbackSignal} ign=${ignitionSignal} gap=${gapContinuationSignal} fpc=${firstPullbackCont} pbe=${preBreakoutExpansion} `
           + `| vol=${volRatio.toFixed(2)}x (breakoutNeed=${breakoutVolNeeded.toFixed(2)} pullbackNeed=${pullbackVolNeeded.toFixed(2)}) `
           + `| breakDist=${(breakoutDistance*100).toFixed(2)}% (limit=${(breakoutDistLimit*100).toFixed(2)}%) `
           + `| nearEMA=${nearEMA20} | mom=${(momentum*100).toFixed(2)}% (V94 baseline, no genuineDip/timing-gate)`
    });
    return null;
  }

  if (gapContinuationSignal)                              setupType = "GAP_CONTINUATION";
  else if (ignitionSignal)                                setupType = "MOMENTUM_IGNITION";
  else if (preBreakoutExpansion && !ignitionSignal)       setupType = "PRE_BREAKOUT_EXPANSION";
  else if (strongMomentumOverride && !ignitionSignal)     setupType = "MOMENTUM_BREAKOUT";
  else if (firstPullbackCont && !breakoutSignal)          setupType = "PULLBACK_CONTINUATION";
  else if (pullbackSignal && !breakoutSignal)             setupType = "PULLBACK_CONTINUATION";
  else if (breakoutSignal)                                setupType = "BREAKOUT_CONTINUATION";

  checkpoint("setup", true, setupType);

  // Pullback momentum minimum (V94: present)
  const minPullbackMom = market==="CRYPTO" ? CRYPTO_15M_MIN_PULLBACK
                       : market==="US"     ? MIN_PULLBACK_MOM_US
                       : MIN_PULLBACK_MOM_LSE;
  if (setupType==="PULLBACK_CONTINUATION" && momentum < minPullbackMom) return null;

  // ── Momentum cap (unchanged -- already matches V94) ────────────
  const momentumCap = setupType==="MOMENTUM_IGNITION"||setupType==="GAP_CONTINUATION" ? 0.25
                    : setupType==="PRE_BREAKOUT_EXPANSION" ? 0.04
                    : market==="CRYPTO"  ? CRYPTO_15M_MAX_MOMENTUM
                    : highBeta           ? (inUSOpen ? MOMENTUM_CAP_HB_OW : MOMENTUM_CAP_HB)
                    : inUSOpen           ? 0.15
                    : market==="US"      ? MOMENTUM_CAP_US_STD
                    : MOMENTUM_CAP_LSE;

  if (momentum > momentumCap) {
    log(`BLOCKED ${asset} | reason=momentumCap | momentum=${(momentum*100).toFixed(2)}% cap=${(momentumCap*100).toFixed(2)}% setup=${setupType}`);
    return null;
  }

  // ── Entry and stops -- V94: simple, no conditional/intel-limit machinery ─
  const entryType = setupType === "PULLBACK_CONTINUATION" ? "LIMIT BUY" : "MARKET BUY";
  const entry     = setupType === "PULLBACK_CONTINUATION" ? ema20 * 1.002 : last;

  const atr = calculateATR(candles, ATR_PERIOD);
  if (!atr || atr <= 0) return null;

  const swingLow = Math.min(...lows.slice(-6));
  const atrMult  = setupType==="PULLBACK_CONTINUATION" ? ATR_PULLBACK_MULTIPLIER
                 : (setupType==="MOMENTUM_IGNITION"||setupType==="GAP_CONTINUATION") ? ATR_IGNITION_MULTIPLIER
                 : ATR_BREAKOUT_MULTIPLIER;

  let sl;
  if (setupType === "GAP_CONTINUATION") {
    const gapCandleLow = Math.min(...lows.slice(-6));
    sl = gapCandleLow - atr * 0.5;
  } else {
    sl = Math.min(swingLow - atr*atrMult, entry - atr*atrMult);
  }

  if (!Number.isFinite(sl) || sl >= entry) return null;

  const riskAmt = entry - sl;
  const riskPct = riskAmt / entry;
  // V94: flat 15% risk cap for everything (no per-market tiering)
  if (riskPct <= 0 || riskPct > 0.15) { reject("risk_pct", asset, market); return null; }

  // V94: uncapped TP (no per-market/regime TP ceiling)
  const tp = entry + riskAmt * TARGET_R;
  const rr = +((((tp - entry)/entry)/riskPct).toFixed(1));
  // V94: flat MIN_RR for all markets (no crypto-specific 1.7 relaxation)
  if (rr < MIN_RR) { reject("rr_too_low", asset, market); return null; }

  // ── Scoring -- V94: no soft-penalty accumulation, no heat/leader bonuses ─
  let score = 50;

  // Volume
  if (volRatio > 1.2) score += 6;
  if (volRatio > 1.4) score += 6;
  if (volRatio > 1.6) score += 4;
  if (volRatio > 2.0) score += 5;
  if (volRatio > 3.0) score += 5;

  // Momentum
  const momScale = market==="CRYPTO" || highBeta ? 0.5 : 1;
  if (momentum > 0.025*momScale)      score += 10;
  else if (momentum > 0.015*momScale) score += 8;
  else if (momentum > 0.008*momScale) score += 4;

  // Setup type -- V94 bonus values (no TREND_RESUMPTION/BROAD_MOMENTUM)
  if (setupType==="BREAKOUT_CONTINUATION")   score += 10;
  if (setupType==="PULLBACK_CONTINUATION")   score += 8;
  if (setupType==="MOMENTUM_BREAKOUT")       score += 14;
  if (setupType==="MOMENTUM_IGNITION")       score += 18;
  if (setupType==="GAP_CONTINUATION")        score += 16;
  if (setupType==="PRE_BREAKOUT_EXPANSION")  score += 13;

  // Market
  if (market==="CRYPTO") score += 5;
  if (market==="US")     score += 4;
  if (market==="LSE")    score += 2;

  // Regime -- V94: simple flat bonus, not the V101 soft-penalty modifier system
  if (market==="CRYPTO" && btcTrend==="strong_bull") score += 5;
  if (market==="US"     && qqqTrend==="bull")        score += 3;
  if (market==="US"     && qqqTrend==="strong_bull") score += 5;

  // Quality
  if (breakoutDistance>0 && breakoutDistance<=0.01) score += 4;
  if (expandingRange) score += 4;
  if (gapped)         score += 6;

  // Narrative (V94: present)
  score += getNarrativeBonus(asset);

  // V90: maturity-aware bonus (V94: present)
  score += getMomentumMaturityBonus(candles, pct24h, asset);

  // V94: relative strength vs QQQ for HIGH_BETA
  if (market === "US" && highBeta) {
    const qqqMom = prefetchedQqqMom !== null ? prefetchedQqqMom : await getQQQMomentum();
    const rsBonus = getRelativeStrengthBonus(momentum, qqqMom);
    if (rsBonus !== 0) log(`📊 ${asset} RS bonus=${rsBonus} (stock=${(momentum*100).toFixed(2)}% QQQ=${(qqqMom*100).toFixed(2)}%)`);
    score += rsBonus;
  }

  // V94: momentum persistence
  score += getMomentumPersistenceBonus(candles);

  // V94: tiered pre-market strength bonus (replaces V95's flat +6 intel-movers bonus)
  if (market === "US" && highBeta && inUSOpen) {
    const pmData = getPreMarketPrice(asset);
    if (pmData) {
      if (pmData.changePct >= 8)      score += 12;
      else if (pmData.changePct >= 5) score += 8;
      else if (pmData.changePct >= 3) score += 4;
      if (pmData.changePct >= 3) log(`📡 ${asset} pre-market +${pmData.changePct.toFixed(1)}% bonus applied`);
    }
  }

  // ── V102 CANDIDATE: STRUCTURE QUALITY ENGINE ─────────────────
  // Kept as pure evidence-gathering infrastructure -- STRUCTURE_QUALITY_MODE
  // stays "log", zero effect on score or rejects. Not a V94-vs-V101 trading
  // decision either way since it changes nothing while dormant.
  const structureQuality = buildStructureQuality(candles, market);
  if (STRUCTURE_QUALITY_MODE !== "log") {
    score += structureQuality.score;
  }
  const structureGate = passesStructureSafetyGates(structureQuality);
  if (!structureGate.ok) {
    for (const reason of structureGate.reasons) reject(reason, asset, market);
    return null;
  }

  // V94 grade thresholds (much lower bar than V101's A*>=100/A>=90)
  let grade = "B";
  if (score >= 85) grade = "A*";
  else if (score >= 78) grade = "A";

  // V94: single simple floor check -- no crypto-grade-suppression, no B-grade
  // hard-suppression (V101 added both; V94 has neither -- B grade fires fine
  // as long as score clears the market floor)
  const scoreFloor = minScoreForMarket(market, asset);
  if (score < MIN_GLOBAL_SCORE || score < scoreFloor) {
    checkpoint("score", false, `${score} < floor (global=${MIN_GLOBAL_SCORE} market=${scoreFloor})`);
    reject(score < MIN_GLOBAL_SCORE ? "global_floor" : "score_floor", asset, market);
    return null;
  }
  checkpoint("score", true, `${score} >= floor ${scoreFloor} grade=${grade}`);

  // EMA distance
  const emaDistPct = ema20 > 0 ? ((last - ema20) / ema20) * 100 : 0;

  // ── EXECUTION ENGINE (V100) -- kept as message-formatting infrastructure,
  // not a trading-philosophy filter. Only touches HOW the entry is placed,
  // not WHETHER it fires. ────────────────────────────────────────
  let execOrderType, execEntryNote, execChaseLimit, execCancelCond, execQuality;

  if (setupType === "PULLBACK_CONTINUATION") {
    execOrderType  = "LIMIT";
    execEntryNote  = `Place BUY LIMIT at $${entry.toFixed(2)}. Do not chase more than 0.25%.`;
    execChaseLimit = entry * 1.0025;
    execCancelCond = `Cancel if price closes above $${(entry * 1.015).toFixed(2)} before entry.`;
    execQuality    = emaDistPct > 3 ? 50 : emaDistPct > 1.5 ? 75 : 95;

  } else if (setupType === "BREAKOUT_CONTINUATION") {
    const stopEntry = breakoutLevel > entry ? breakoutLevel * 1.001 : entry * 1.002;
    execOrderType  = "STOP";
    execEntryNote  = `Place BUY STOP at $${stopEntry.toFixed(2)}. Only enters if breakout confirms.`;
    execChaseLimit = stopEntry * 1.005;
    execCancelCond = `Cancel if price fails to hold above $${(breakoutLevel||entry*1.01).toFixed(2)} within 2 candles.`;
    execQuality    = breakoutDistance < 0.005 ? 90 : breakoutDistance < 0.015 ? 75 : 55;

  } else if (setupType === "MOMENTUM_IGNITION") {
    execOrderType  = "MARKET";
    execEntryNote  = "Market order immediately. Speed over precision on ignition setups.";
    execChaseLimit = entry * 1.01;
    execCancelCond = "Reject if bid/ask spread exceeds 0.3% at time of entry.";
    execQuality    = momentum > 0.03 ? 90 : momentum > 0.015 ? 75 : 60;

  } else if (setupType === "GAP_CONTINUATION") {
    execOrderType  = "LIMIT";
    execEntryNote  = `Place BUY LIMIT at $${entry.toFixed(2)}. Buy the first pullback after the gap.`;
    execChaseLimit = entry * 1.003;
    execCancelCond = `Cancel if price fills the gap below $${sl.toFixed(2)}.`;
    execQuality    = gapPct > 0.05 ? 70 : gapPct > 0.02 ? 85 : 90;

  } else {
    execOrderType  = "MARKET";
    execEntryNote  = "Market order at current price.";
    execChaseLimit = entry * 1.005;
    execCancelCond = "Cancel if price moves more than 0.5% before entry.";
    execQuality    = 75;
  }

  // ── HUNTER SCORE (V100) -- kept as message/ranking infrastructure.
  // Does not gate entry except the execQuality<40 sanity check below,
  // which is an execution-integrity check, not a market-judgment filter.
  const confidenceScore = Math.max(5, Math.min(100, Math.round((score / 130) * 100)));
  const edgeScore       = rr >= 3.0 ? 100 : rr >= 2.5 ? 90 : rr >= 2.0 ? 80 : rr >= 1.8 ? 65 : 40;

  const regimeOk     = market==="CRYPTO" ? (btcTrend==="bull"||btcTrend==="strong_bull") && btcMacroTrend!=="risk_off"
                     : market==="US"     ? (qqqTrend==="bull"||qqqTrend==="strong_bull") && qqqBullCount >= 2
                     : true;
  const heatPts      = Math.min(30, Math.round(getHeat(asset) / 4));
  const regimePts    = regimeOk ? 40 : 10;
  const volPts       = volRatio >= 2.0 ? 30 : volRatio >= 1.5 ? 20 : 10;
  const convictionScore = Math.min(100, regimePts + heatPts + volPts);

  const hunterRaw     = (confidenceScore/100) * (execQuality/100) * (edgeScore/100) * (convictionScore/100);
  const hunterScore   = Math.round(hunterRaw * 100);
  const combinedScore = hunterScore;
  log(`🎯 HUNTER ${asset}: confidence=${confidenceScore} exec=${execQuality} edge=${edgeScore} conviction=${convictionScore} → HUNTER=${hunterScore}`);
  log(`⚡ EXEC ${asset}: order=${execOrderType} execQ=${execQuality} setup=${score} combined=${combinedScore}`);

  if (execQuality < 40) {
    reject("poor_execution_severe", asset, market); return null;
  }

  log(`✅ ${asset} ${market} ${setupType} score=${score} grade=${grade} execQ=${execQuality} hunter=${hunterScore}`);

  return {
    asset, market, grade, setupType, status:"CONFIRMED",
    entryType, entry, sl, tp, rr, score, momentum, volRatio,
    breakoutDistance, atr, gapPct, emaDistPct,
    regime: market==="CRYPTO" ? btcTrend : market==="US" ? qqqTrend : "LSE_LOCAL",
    execOrderType, execEntryNote, execChaseLimit, execCancelCond, execQuality, hunterScore, convictionScore, combinedScore,
    structureScore: structureQuality.score,
    structureGrade: structureQuality.grade,
    structureFlags: structureQuality.flags,
    structureRejectReasons: structureQuality.rejectReasons
  };
}
// ================================================================
// SNIPER V101 -- GITHUB PASTE-BOX SPLIT -- PART 4 OF 4
// Paste all 4 parts into the same file, in order, with no extra
// blank lines or edits at the seams. Concatenating parts 1-4
// reconstructs sniper_v101_full.js exactly.
// Fixes HIGH_BETA range-proxy volume fallback -- was gated to
// opening-window only, so real volume-data gaps mid-session
// (AVGO/SMR etc) silently zeroed out volRatio on otherwise-
// passing setups. Now applies whenever HIGH_BETA volume data
// is missing, any time of day. Plus universe expansion, weekly
// persistence report, first-fire/peak-score alerts, safety mode
// alert, ema_fail diagnostics, false_breakout gate, crypto pool
// dynamic fix, V94 reversion, and all prior session fixes.
// ================================================================

// ================================================================
// (legacy marker from the old function-boundary 3-part split -- superseded)
// See the V101 banners below for the current equal-length split points.
// Contains: signal messages, trade logic, four modules, scan, boot
// ================================================================
// ── Signal messages ──────────────────────────────────────────────
function buildSignalLesson(signal) {
  const parts = ["\uD83D\uDCDA <b>SETUP ANALYSIS</b>", ""];
  if (signal.setupType === "GAP_CONTINUATION") {
    parts.push(`\uD83D\uDE80 <b>Gap Continuation</b> \u2014 algorithm detected a gap at open on strong volume with continuation momentum. The scanner flagged this as a potential continuation structure.`);
  } else if (signal.setupType === "TREND_RESUMPTION") {
    parts.push("\uD83D\uDD04 <b>Trend Resumption</b> \u2014 scanner identified a gap-and-hold pattern. Price consolidated without reverting, suggesting institutional accumulation. Algorithm flagged potential resumption.");
  } else if (signal.setupType === "PRE_BREAKOUT_EXPANSION") {
    parts.push("\uD83D\uDCC8 <b>Pre-Breakout Expansion</b> \u2014 momentum expanding with price approaching resistance on building volume. Algorithm identified this as a potential early setup. Higher risk profile.");
  } else if (signal.setupType === "BREAKOUT_CONTINUATION") {
    parts.push("\uD83D\uDCA5 <b>Breakout Continuation</b> \u2014 scanner detected price clearing recent resistance with volume confirmation. Algorithm flagged as a potential continuation structure.");
  } else if (signal.setupType === "PULLBACK_CONTINUATION") {
    parts.push("\uD83C\uDFAF <b>Pullback Continuation</b> \u2014 algorithm identified a pullback to the 20-period EMA within an uptrend. Scanner flagged potential continuation from this level.");
  } else if (signal.setupType === "MOMENTUM_BREAKOUT") {
    parts.push("\uD83D\uDD25 <b>Momentum Breakout</b> \u2014 strong volume surge through resistance detected. Algorithm confirmed real buying pressure in the structure.");
  } else {
    parts.push("\u26A1 <b>Momentum Ignition</b> \u2014 scanner detected explosive early momentum. Volume significantly elevated. Higher risk profile \u2014 size accordingly.");
  }

  if (signal.volRatio >= 3.0)      parts.push(`\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x</b> \u2014 exceptional relative volume. Strong participation detected.`);
  else if (signal.volRatio >= 2.0) parts.push(`\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x</b> \u2014 significantly above average. Real market conviction.`);
  else                              parts.push(`\n\uD83D\uDCCA <b>Volume ${signal.volRatio.toFixed(2)}x</b> \u2014 above average. Active participation.`);

  if (signal.market === "CRYPTO") {
    const pct24 = get24hrMomentum(signal.asset);
    if (pct24 && pct24 >= 0.05) {
      parts.push(`\n\uD83D\uDCC8 <b>24hr momentum: +${(pct24*100).toFixed(1)}%</b> \u2014 building throughout the session.`);
    }
    parts.push(`\n\uD83E\uDE99 BTC regime: <b>${btcTrend.replace("_"," ")}</b>`);
  } else if (signal.market === "US") {
    parts.push(`\n\uD83C\uDDFA\uD83C\uDDF8 Market regime: <b>${qqqTrend.replace("_"," ")}</b>`);
  }

  const matched = HOT_SECTORS.filter(s => (SECTOR_SYMBOLS[s]||[]).includes(signal.asset.replace("USDT","")));
  if (matched.length > 0) parts.push(`\n\uD83E\uDDE0 <b>Active theme: ${matched.join(", ")}</b> \u2014 sector momentum detected.`);

  if (signal.grade === "A*") parts.push("\n\u2B50 <b>A* grade</b> \u2014 all algorithmic conditions aligned.");
  else if (signal.grade === "A") parts.push("\n\u2B50 <b>A grade</b> \u2014 strong algorithmic signal.");

  parts.push(`\n\u26A1 <b>Candle momentum: ${(signal.momentum*100).toFixed(2)}%</b>`);
  return lines(parts);
}

function buildSignalMessage(signal, size) {
  const sym       = signal.asset.replace("USDT","");
  const matched   = HOT_SECTORS.filter(s => (SECTOR_SYMBOLS[s]||[]).includes(sym));
  const ntag      = matched.length>0 ? `\n🧠 <b>${escapeHtml(matched.join(" + "))}</b>` : "";
  const sniperTag = signal.sniperMode ? `\n🎯 <b>SNIPER ENGINE</b> — heat: ${signal.heat || "HOT"}` : "";
  const slPct     = (((signal.entry - signal.sl)/signal.entry)*100).toFixed(1);
  const tpPct     = (((signal.tp - signal.entry)/signal.entry)*100).toFixed(1);
  const riskPct   = (getRiskFractionForSignal(signal)*100).toFixed(1);

  // V100 Execution Engine -- order type badge
  const execType  = signal.execOrderType || (signal.entryType === "MARKET BUY" ? "MARKET" : "LIMIT");
  const execBadge = execType === "MARKET" ? "⚡ MARKET"
                  : execType === "STOP"   ? "🛑 STOP"
                  : execType === "LIMIT"  ? "💰 LIMIT"
                  : "📋 STOP LIMIT";

  // TP2 = extended target at 3R
  const tp2 = signal.entry + (signal.entry - signal.sl) * 3;
  const tp2Pct = (((tp2 - signal.entry)/signal.entry)*100).toFixed(1);

  return lines([
    `🚨 ${gradeEmoji(signal.grade)} <b>${escapeHtml(signal.grade)} SETUP DETECTED</b>${ntag}${sniperTag}`,
    ``,
    `${marketEmoji(signal.market)} <b>${escapeHtml(signal.market)} | ${escapeHtml(sym)}</b>`,
    `${setupEmoji(signal.setupType)} ${escapeHtml(signal.setupType)}`,
    ``,
    `🎯 <b>Order Type: ${execBadge}</b>`,
    `━━━━━━━━━━━━━━`,
    `💰 Entry   ${escapeHtml(formatPrice(signal.entry, signal.market))}`,
    `🛡️ Stop    ${escapeHtml(formatPrice(signal.sl, signal.market))} <b>(-${escapeHtml(slPct)}%)</b>`,
    `🎯 Target1 ${escapeHtml(formatPrice(signal.tp, signal.market))} <b>(+${escapeHtml(tpPct)}%)</b>`,
    `🚀 Target2 ${escapeHtml(formatPrice(tp2, signal.market))} <b>(+${escapeHtml(tp2Pct)}%)</b>`,
    `⚖️ R:R     ${escapeHtml(String(signal.rr))} | 🎯 Hunter: ${escapeHtml(String(signal.hunterScore || signal.score))}`,
    `━━━━━━━━━━━━━━`,
    `📋 <b>EXECUTION PLAN</b>`,
    `${escapeHtml(signal.execEntryNote || "")}`,
    `${escapeHtml(signal.execCancelCond || "")}`,
    ``,
    `📊 Vol: ${escapeHtml(signal.volRatio.toFixed(2))}x  ⚠️ Risk: ${escapeHtml(riskPct)}% of account`,
    ``,
    buildSignalLesson(signal),
    ``,
    `——————————`,
    `⚠️ <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell</i>`,
    `📸 <i>Analysis by @baretradesignals 🎯</i>`
  ]);
}

function buildFillMessage(trade, price) {
  const slPct = (((price - trade.sl)/price)*100).toFixed(1);
  const tpPct = (((trade.tp - price)/price)*100).toFixed(1);
  return lines([
    `\u2705\uD83D\uDD25 <b>FILLED</b>`,
    ``,
    `${marketEmoji(trade.market)} <b>${escapeHtml(trade.market)} | ${escapeHtml(trade.asset)}</b>`,
    `${setupEmoji(trade.setupType)} ${escapeHtml(trade.setupType)}`,
    ``,
    `\uD83D\uDCB5 Fill: ${escapeHtml(formatPrice(price, trade.market))}`,
    `\uD83D\uDEE1\uFE0F SL:   ${escapeHtml(formatPrice(trade.sl, trade.market))} <b>(-${escapeHtml(slPct)}%)</b>`,
    `\uD83C\uDFAF TP:   ${escapeHtml(formatPrice(trade.tp, trade.market))} <b>(+${escapeHtml(tpPct)}%)</b>`,
    `\u2B50 Score: ${escapeHtml(String(trade.score))}`
  ]);
}

function buildCloseMessage(trade, reason, closePrice) {
  const rVal     = Number.isFinite(trade.realizedR) ? +trade.realizedR.toFixed(2) : null;
  const pnlPct   = Number.isFinite(closePrice) && Number.isFinite(trade.entry) && trade.entry > 0
    ? ((closePrice - trade.entry)/trade.entry*100).toFixed(2) : null;
  const heldHrs  = hoursAgo(trade.filledAt||trade.sentAt).toFixed(1);
  const mae      = Number.isFinite(trade.maePct) ? `${(trade.maePct*100).toFixed(2)}%` : "n/a";
  const mfe      = Number.isFinite(trade.mfePct) ? `${(trade.mfePct*100).toFixed(2)}%` : "n/a";
  const isWin    = reason === "TAKE PROFIT";
  const isLoss   = reason === "STOP LOSS";
  const re       = {"TAKE PROFIT":"\uD83D\uDCB0\u2705","STOP LOSS":"\uD83D\uDED1\u274C","FORCE CLOSE":"\u23F1\uFE0F\uD83D\uDD1A","REPLACED":"\uD83D\uDD04","STRUCTURE_INVALID":"\u26A0\uFE0F","DRIFTED_TOO_FAR":"\uD83C\uDF0A","PENDING_EXPIRED":"\u231B"}[reason] || "\uD83D\uDCCC";
  const rLabel   = rVal!==null ? (rVal>0?`+${rVal}R`:`${rVal}R`) : "n/a";
  const pnlLabel = pnlPct!==null ? (parseFloat(pnlPct)>0?`+${pnlPct}%`:`${pnlPct}%`) : "n/a";

  const parts = [
    `${re} <b>${escapeHtml(isWin?"COMPLETED TRADE":isLoss?"STOPPED OUT":reason.replace("_"," "))}</b>`,
    ``,
    `${marketEmoji(trade.market)} <b>${escapeHtml(trade.market)} | ${escapeHtml(trade.asset)}</b>`,
    `${setupEmoji(trade.setupType)} ${escapeHtml(trade.setupType)}`,
    ``,
    `\uD83D\uDCB5 Entry:  ${escapeHtml(formatPrice(trade.entry, trade.market))}`,
    `\uD83D\uDCB5 Exit:   ${escapeHtml(formatPrice(closePrice, trade.market))}`,
    ``,
    `\uD83D\uDCCA Result: <b>${escapeHtml(pnlLabel)}</b> \u2022 <b>${escapeHtml(rLabel)}</b>`,
    `\u23F1\uFE0F Held:   ${escapeHtml(heldHrs)} hours`,
    `\uD83D\uDCC9 Max against: ${escapeHtml(mae)}`,
    `\uD83D\uDCC8 Max in favour: ${escapeHtml(mfe)}`,
    `\u2B50 Signal score: ${escapeHtml(String(trade.score))}`
  ];

  if (isWin)  parts.push(``, `\u2705 <b>Target reached.</b>${rVal?` Observed outcome: +${rVal}R.`:""} Rule-based exit at objective.`);
  if (isLoss) parts.push(``, `\uD83D\uDEE1\uFE0F <b>Stop level reached.</b> Loss capped. Capital preserved for the next setup.`);
  if (reason==="FORCE CLOSE")     parts.push(``, `\u23F1\uFE0F <b>Position closed.</b> No sufficient progress after ${heldHrs}hrs.`);
  if (reason==="REPLACED")        parts.push(``, `\uD83D\uDD04 <b>Position closed.</b> Scanner identified stronger setup — capital redeployed.`);
  if (reason==="PENDING_EXPIRED") parts.push(``, `\u231B <b>Setup expired.</b> Entry zone never reached.`);

  if (isWin || isLoss) {
    parts.push(``, `\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014`, `\u26A0\uFE0F <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell</i>`, `\uD83D\uDCF8 <i>Analysis by @baretradesignals 🎯</i>`);
  }
  return lines(parts);
}

// ── Trade helpers ────────────────────────────────────────────────
function cooldown(asset, alerts, market) {
  const last = [...alerts].reverse().find(x => x.asset===asset && x.market===market);
  if (!last) return false;
  const hrs = market==="CRYPTO"?CRYPTO_COOLDOWN:market==="LSE"?LSE_COOLDOWN:US_COOLDOWN;
  const inCooldown = hoursAgo(last.sentAt) < hrs;
  if (inCooldown) log(`⏳ ${asset} in cooldown`);
  return inCooldown;
}

function getOpenTradeInMarket(trades, market) {
  return trades.find(t => t.market===market && t.status==="FILLED" && t.outcome==="OPEN");
}
function countPendingTradesByMarket(trades, market) {
  return trades.filter(t => t.market===market && t.status==="PENDING").length;
}
function countOpenTradesByMarket(trades, market) {
  return trades.filter(t => t.market===market && t.status==="FILLED" && t.outcome==="OPEN").length;
}
function getOpenRiskFraction(trades) {
  return trades.filter(t => t.status==="FILLED" && t.outcome==="OPEN").reduce((sum,t) => sum+(t.riskFraction||0), 0);
}
function progressToTarget(trade, livePrice) {
  const denom = trade.tp - trade.entry;
  if (!Number.isFinite(livePrice)||!Number.isFinite(denom)||denom<=0) return 0;
  return (livePrice - trade.entry) / denom;
}
// ================================================================
// V99: TRADE STATE ENGINE
// Classify every open trade each cycle instead of simple time checks
// States: HEALTHY_TREND | HEALTHY_CONSOLIDATION | PULLBACK | FAILED_BREAKOUT | TREND_FAILURE
// Only exit when thesis is genuinely broken
// ================================================================
function classifyTradeState(trade, livePrice) {
  if (!Number.isFinite(livePrice) || !Number.isFinite(trade.entry)) return "UNKNOWN";
  const pricePct  = (livePrice - trade.entry) / trade.entry;
  const ageHrs    = hoursAgo(trade.filledAt || trade.sentAt);
  const mfePct    = trade.mfePct || 0;
  const progress  = progressToTarget(trade, livePrice);

  // How far has price retraced from its best point
  const drawdownFromPeak = mfePct > 0 ? (mfePct - Math.max(0, pricePct)) / mfePct : 0;

  if (pricePct >= 0.01 && progress >= 0.2)               return "HEALTHY_TREND";
  if (pricePct >= 0 && mfePct >= 0.005 && drawdownFromPeak < 0.5) return "HEALTHY_CONSOLIDATION";
  if (pricePct >= -0.005 && ageHrs < 1)                  return "HEALTHY_CONSOLIDATION"; // very early, give benefit of doubt
  if (pricePct < 0 && pricePct > -0.015 && mfePct >= 0.003) return "PULLBACK"; // pulled back but showed green
  if (pricePct < -0.015 && mfePct < 0.003)               return "FAILED_BREAKOUT";
  if (pricePct < -0.02)                                   return "TREND_FAILURE";
  return "HEALTHY_CONSOLIDATION"; // default to patience
}

function shouldReplaceTrade(newSignal, currentTrade, livePrice) {
  if (!currentTrade || !Number.isFinite(livePrice)) return false;
  const progress  = progressToTarget(currentTrade, livePrice);
  const pricePct  = (livePrice - currentTrade.entry) / currentTrade.entry;
  const stale     = hoursAgo(currentTrade.filledAt||currentTrade.sentAt) > REPLACEMENT_STALE_HOURS;
  const inProfit  = pricePct > 0.005; // current trade is 0.5%+ in profit

  // V98: CONSERVATIVE REPLACEMENT
  // ARB was replaced while +1.24% -- then ARB continued another 2-3%
  // New rule: NEVER replace a profitable crypto trade
  // Only replace if: structurally broken + massive score gap
  if (currentTrade.market === "CRYPTO" && inProfit) return false;

  return newSignal.score >= (currentTrade.score||0)+REPLACEMENT_SCORE_GAP &&
    progress < REPLACEMENT_PROTECT_TP_PROGRESS &&
    (stale || progress < REPLACEMENT_STALL_PROGRESS);
}
function shouldForceClose(trade, livePrice) {
  if (!Number.isFinite(livePrice)) return false;
  const ageHrs    = hoursAgo(trade.filledAt || trade.sentAt);
  const ageMins   = ageHrs * 60;
  const mfePct    = trade.mfePct || 0;
  const progress  = progressToTarget(trade, livePrice);
  const pricePct  = (livePrice - trade.entry) / trade.entry;

  // ── CRYPTO: trade state based exits ─────────────────────────────
  // TON/BTC pattern: builds all day, runs overnight
  // Classify state each cycle -- only exit on genuine thesis break
  if (trade.market === "CRYPTO") {
    const state = classifyTradeState(trade, livePrice);
    log(`📊 TRADE STATE: ${trade.asset} = ${state} | age=${ageHrs.toFixed(1)}h | pricePct=${(pricePct*100).toFixed(2)}% | mfe=${(mfePct*100).toFixed(2)}%`);

    if (state === "TREND_FAILURE")      return true;  // thesis broken
    if (state === "FAILED_BREAKOUT" && ageHrs >= 1) return true;  // failed and confirmed
    // BTC regime deteriorated AND losing ground
    if (pricePct < -0.010 && btcTrend === "risk_off") return true;
    // Stale fallback -- only after genuine long hold with zero movement
    if (state === "HEALTHY_CONSOLIDATION" && ageHrs >= 8 && mfePct < 0.003) return true;
    if (ageHrs >= 12) return true;  // absolute hard cap
    return false;
  }

  // ── US/LSE: tighter caps, direction-based ───────────────────────
  if (ageHrs >= 4) return true;

  if (trade.setupType === "MOMENTUM_IGNITION") {
    if (ageMins >= 15 && pricePct < -0.008) return true;
    if (ageMins >= 30 && pricePct < -0.004) return true;
    if (ageMins >= 45 && mfePct < 0.003)    return true;
    if (ageMins >= 60)                       return true;
    return false;
  }

  if (trade.setupType === "GAP_CONTINUATION") {
    if (ageMins >= 20 && pricePct < -0.010) return true;
    if (ageMins >= 60 && mfePct < 0.005)    return true;
    if (ageHrs >= 2)                         return true;
    return false;
  }

  if (trade.setupType === "PRE_BREAKOUT_EXPANSION") {
    if (ageMins >= 30 && pricePct < -0.008) return true;
    if (ageHrs >= 1.5)                       return true;
    return false;
  }

  if (trade.setupType === "BREAKOUT_CONTINUATION") {
    if (ageMins >= 30 && pricePct < -0.010) return true;
    if (ageHrs >= 2 && progress < 0.15)     return true;
    if (ageHrs >= 3)                         return true;
    return false;
  }

  if (trade.setupType === "PULLBACK_CONTINUATION") {
    if (ageMins >= 45 && pricePct < -0.012) return true;
    if (ageHrs >= 3 && progress < 0.15)     return true;
    if (ageHrs >= 4)                         return true;
    return false;
  }

  return ageHrs > FORCE_CLOSE_HOURS && progress < FORCE_CLOSE_PROGRESS;
}
function getRiskFractionForSignal(signal) {
  const base = BASE_RISK_PER_TRADE * (signal.score>=85?1.5:signal.score>=78?1.2:1.0);
  return ["ASTS","IONQ","AVAV"].includes(signal.asset) ? base*0.7 : base;
}
function calculatePositionSize(signal) {
  const riskFraction = getRiskFractionForSignal(signal);
  const riskPerUnit  = signal.entry - signal.sl;
  if (!Number.isFinite(riskPerUnit)||riskPerUnit<=0) return 0;
  return (ACCOUNT_BALANCE * riskFraction) / riskPerUnit;
}
// ================================================================
// ================================================================
// V100 HARDENED: NO REGRET ENGINE
// Hardening Directive: reject bad trades, not find good ones.
// Rule 7: must pass Confidence + Execution + Edge + Hunter Score
// Rule 8: must be meaningfully better than alternatives
// Rule 9: rejection reasons must not outweigh entry reasons
// Rule 10: "If this loses tomorrow, was entering still correct?"
// ================================================================
function passesNoRegretCheck(signal, allSignals) {
  const reasons   = []; // rejection reasons
  const forReasons = []; // entry reasons (Rule 9 balance check)

  // ── ENTRY REASONS (positives) ─────────────────────────────────
  if (signal.score >= 115)                                    forReasons.push("exceptional score");
  if (signal.volRatio >= 2.0)                                 forReasons.push("strong volume participation");
  if (signal.rr >= 2.5)                                       forReasons.push("excellent R:R");
  if (signal.isLeader)                                        forReasons.push("intel-confirmed leader");
  if (getHeat(signal.asset) >= 80)                            forReasons.push("high heat conviction");
  if (signal.setupType === "PULLBACK_CONTINUATION")           forReasons.push("buying the dip not the spike");
  if (signal.execQuality >= 90)                               forReasons.push("clean execution window");

  // ── REJECTION REASONS (Rule 9) ────────────────────────────────

  // P2: "better candidate exists" removed as a VETO -- markets give multiple trades simultaneously.
  // RKLB, PLTR and SMR can all be valid at once. A slightly higher score elsewhere shouldn't
  // invalidate a profitable trade. This is now a ranking bonus in pickTopSignals instead.
  const sameMarket = allSignals.filter(s => s.market === signal.market && s !== signal);
  if (sameMarket.length > 0) {
    const bestOther = Math.max(...sameMarket.map(s => s.hunterScore || s.score));
    const thisScore = signal.hunterScore || signal.score;
    if (bestOther > thisScore + 10) {
      // Log it but don't block -- pickTopSignals ranking handles priority
      forReasons.push(`ranked #2 in market (best=${bestOther.toFixed(0)} this=${thisScore.toFixed(0)})`);
    }
  }

  // Rule 3: Execution quality mandatory >= 75
  if (!signal.execQuality || signal.execQuality < 75) {
    reasons.push(`execution quality too low (${signal.execQuality || 0}/100 < 75)`);
  }

  // Rule 4: Never chase -- price too far from ideal entry
  if (signal.emaDistPct > 3.0) {
    reasons.push(`chasing — price ${signal.emaDistPct.toFixed(1)}% above EMA (max 3%)`);
  }

  // Rule 5: Volume must be increasing (handled in analyse but double-check)
  if (signal.volRatio < 1.3) {
    reasons.push(`volume insufficient (${signal.volRatio?.toFixed(1)}x < 1.3x)`);
  }

  // Rule 6: Never buy exhaustion
  if (signal.setupType === "PARABOLIC_EXTENSION") {
    reasons.push("parabolic extension — trade has already happened");
  }

  // Rule 8: Edge must be meaningful -- marginal advantage = WATCH not BUY
  if (Number.isFinite(signal.rr) && signal.rr < 2.0) {
    reasons.push(`R:R ${signal.rr?.toFixed(1)} below minimum 2.0 — marginal edge`);
  }

  // Rule 10: Regret test -- would a loss here still be the right decision?
  // Fails if: no heat backing, late stage, poor execution all together
  const heat = getHeat(signal.asset);
  const lateStage = signal.score < 105 && heat < 20 && signal.execQuality < 80;
  if (lateStage) {
    reasons.push("fails regret test — low conviction entry with no heat backing");
  }

  // ── Rule 9: Balance check ─────────────────────────────────────
  // Rejection reasons must not outweigh entry reasons
  if (reasons.length >= forReasons.length && reasons.length > 0) {
    log(`🚫 NO REGRET: ${signal.asset} REJECTED — ${reasons.length} reasons against, ${forReasons.length} for`);
    reasons.forEach(r => log(`   ✗ ${r}`));
    logRejection(signal.asset, reasons, signal.hunterScore); // V100: log for self-audit
    return false;
  }

  if (reasons.length > 0) {
    log(`🚫 NO REGRET: ${signal.asset} suppressed — ${reasons.join(", ")}`);
    logRejection(signal.asset, reasons, signal.hunterScore);
    return false;
  }

  log(`✅ NO REGRET: ${signal.asset} ELITE — ${forReasons.length} entry reasons, 0 rejections`);
  forReasons.forEach(r => log(`   ✓ ${r}`));
  return true;
}

// ================================================================
// V99: OPPORTUNITY RANKING ENGINE
// Replace score-only ordering with composite quality rank
// Rewards: clean structure, fresh move stage, room to target,
//          heat persistence, low regret risk
// ================================================================
function rankOpportunityQuality(signal) {
  let rank = signal.score;

  // Heat persistence bonus (already in score but emphasise here)
  const heat = getHeat(signal.asset);
  if (heat >= HEAT_HOT_THRESHOLD) rank += Math.min(10, heat / 10);

  // Fresh move stage bonus -- early moves better than extended
  if (signal.setupType === "PULLBACK_CONTINUATION") rank += 5; // buying dip = better entry
  if (signal.setupType === "MOMENTUM_IGNITION")     rank += 3; // fast move = high conviction
  if (signal.setupType === "BREAKOUT_CONTINUATION") rank -= 2; // chasing breakout = slight penalty

  // Room to target bonus
  if (Number.isFinite(signal.rr)) {
    if (signal.rr >= 2.5) rank += 8;
    else if (signal.rr >= 2.0) rank += 4;
  }

  // Leader mode bonus
  if (signal.isLeader) rank += 10;

  // Regime bonus
  if (signal.market === "CRYPTO" && btcTrend === "strong_bull") rank += 5;
  if (signal.market === "US"     && qqqTrend === "bull")        rank += 5;

  return rank;
}

function pickTopSignals(results) {
  // V99: OPPORTUNITY RANKING -- composite quality rank, not just raw score
  // Apply No Regret check first, then rank by quality, then pick best by market
  const passing = results.filter(s => passesNoRegretCheck(s, results));

  const byMarket = { US: [], CRYPTO: [], LSE: [] };
  for (const s of passing) {
    const rank = rankOpportunityQuality(s);
    s.opportunityRank = rank;
    if (!byMarket[s.market]) byMarket[s.market] = [];
    byMarket[s.market].push(s);
  }

  // Sort each market by opportunity rank not just score
  for (const m of Object.keys(byMarket)) {
    byMarket[m].sort((a, b) => b.opportunityRank - a.opportunityRank);
  }

  // Log ranking for debugging
  for (const m of ["US","CRYPTO","LSE"]) {
    const top = byMarket[m]?.[0];
    if (top) log(`🏆 TOP ${m}: ${top.asset} score=${top.score} rank=${top.opportunityRank?.toFixed(0)}`);
  }

  // V100: Dynamic elite threshold -- relative ranking beats absolute numbers
  // "Is this clearly better than everything else today?"
  // Best setup on a quiet day scores 91 and should fire. Hardcoded 110 would block it.
  const allCandidates = [...(byMarket.US||[]), ...(byMarket.CRYPTO||[]), ...(byMarket.LSE||[])];
  allCandidates.sort((a,b) => (b.hunterScore||b.score||0) - (a.hunterScore||a.score||0));

  const topScore    = allCandidates[0]?.hunterScore  ?? allCandidates[0]?.score  ?? 0;
  const secondScore = allCandidates[1]?.hunterScore  ?? allCandidates[1]?.score  ?? 0;

  // Dynamic threshold: must be clearly better than the field
  // Minimum floor of 55 (multiplicative 55/100 = all components reasonable)
  // Closes gap to second place must be 5+ points
  const eliteThreshold = Math.max(55, secondScore + 5);
  log(`🎯 Elite threshold: ${eliteThreshold.toFixed(0)} (top=${topScore.toFixed(0)} second=${secondScore.toFixed(0)})`);

  // Global comparison: don't force market diversification
  // If crypto has the 3 best opportunities, fire crypto. Market doesn't care about diversification.
  const globalBest = allCandidates.filter(s =>
    (s.hunterScore || s.score || 0) >= eliteThreshold
  );

  // One per market from the global best
  const selected  = [];
  const seenMarkets = new Set();
  for (const s of globalBest) {
    if (!seenMarkets.has(s.market)) {
      selected.push(s);
      seenMarkets.add(s.market);
    }
  }

  if (selected.length === 0) {
    log("🚫 NO ELITE SETUPS -- all candidates below dynamic threshold");
  } else {
    log(`✅ ELITE SETUPS: ${selected.map(s => s.asset + " (" + (s.hunterScore||s.score) + ")").join(", ")}`);
  }

  return selected.sort((a,b) => ((b.hunterScore||b.opportunityRank||0) - (a.hunterScore||a.opportunityRank||0)));
}
function updateTradeExcursion(trade, livePrice) {
  if (!Number.isFinite(livePrice)) return;
  const adverse   = Math.max(0, (trade.entry - livePrice)/trade.entry);
  const favorable = Math.max(0, (livePrice - trade.entry)/trade.entry);
  if (!Number.isFinite(trade.maePct)||adverse>trade.maePct)   trade.maePct = adverse;
  if (!Number.isFinite(trade.mfePct)||favorable>trade.mfePct) trade.mfePct = favorable;
}

async function closeTrade(trades, trade, closePrice, reason) {
  trade.closePrice = closePrice;
  trade.closedAt   = nowIso();
  trade.status     = "CLOSED";
  trade.outcome    = reason;
  const riskPerUnit = trade.entry - trade.sl;
  trade.realizedR   = Number.isFinite(closePrice) && Number.isFinite(riskPerUnit) && riskPerUnit>0
    ? (closePrice - trade.entry)/riskPerUnit : null;
  const isPublicClose = reason === "TAKE PROFIT" || reason === "STOP LOSS" || reason === "FORCE CLOSE";
  // V98: REPLACED also goes to channel if the original trade was sent to subscribers
  // Subscribers need to know the position is closed -- they think it's still running otherwise
  const isPublicReplace = reason === "REPLACED" && trade.sentToChannel;
  if (isPublicClose || isPublicReplace) {
    await safeRun(`close${trade.asset}`, () => sendBoth(buildCloseMessage(trade, reason, closePrice)));
  } else {
    await safeRun(`close${trade.asset}`, () => sendPrivate(buildCloseMessage(trade, reason, closePrice)));
  }
  await saveTrades(trades);
}

// V98: PUBLIC PERFORMANCE TRACKER
// Posted to channel daily -- transparency builds trust and sells subscriptions
async function sendPerformanceReport() {
  try {
    const trades = await loadTradesCached();
    // V99: count trades from V99 launch -- earlier test trades skew the stats
    const v99Launch = new Date("2026-06-07T00:00:00Z").getTime();
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const since = Math.max(v99Launch, thirtyDaysAgo);
    const closed = trades.filter(t =>
      t.status === "CLOSED" &&
      t.sentToChannel === true && // V98: only count trades that went to subscribers
      (t.outcome === "TAKE PROFIT" || t.outcome === "STOP LOSS" || t.outcome === "FORCE CLOSE") &&
      new Date(t.closedAt).getTime() > since
    );
    // V98: minimum 10 closed trades before publishing -- avoid misleading stats on tiny samples
    if (closed.length < 10) {
      log(`📊 Perf report suppressed -- only ${closed.length} closed subscriber trades (need 10+)`);
      return;
    }
    const wins   = closed.filter(t => t.outcome === "TAKE PROFIT").length;
    const losses = closed.filter(t => t.outcome === "STOP LOSS" || t.outcome === "FORCE CLOSE").length;
    const winRate = Math.round((wins / closed.length) * 100);
    log(`📊 Perf report: ${wins}W ${losses}L of ${closed.length} closed -- winRate=${winRate}%`);
    const rValues = closed.filter(t => Number.isFinite(t.realizedR)).map(t => t.realizedR);
    const avgR    = rValues.length > 0 ? (rValues.reduce((a,b) => a+b, 0) / rValues.length).toFixed(2) : "N/A";
    const totalR  = rValues.length > 0 ? rValues.reduce((a,b) => a+b, 0).toFixed(1) : "N/A";
    const parts = [
      "\uD83D\uDCCA <b>30-DAY PERFORMANCE REPORT</b>",
      "<i>Algorithm results \u2014 last 30 days</i>",
      "",
      `\uD83C\uDFAF <b>Win rate: ${winRate}%</b> (${wins}W / ${losses}L)`,
      `\u2696\uFE0F <b>Average R: ${avgR}</b>`,
      `\uD83D\uDCC8 <b>Total R gained: ${totalR}R</b>`,
      `\uD83D\uDD22 <b>Signals tracked: ${closed.length}</b>`,
      "",
      "\u26A0\uFE0F <i>Past performance does not guarantee future results</i>",
      "\uD83D\uDCDA <i>Educational market commentary only \u00B7 @baretradesignals 🎯</i>"
    ];
    await safeRun("perfReport", () => sendPrivate(lines(parts)));
  } catch (e) {
    log(`⚠️ Performance report failed: ${e.message}`);
  }
}

// ── Trade management ─────────────────────────────────────────────
async function manageTrades() {
  const trades = await loadTradesCached();
  let changed = false;
  for (const trade of trades) {
    if (shuttingDown) break;
    const livePrice = await fetchLivePrice(trade.asset, trade.market);
    if (!Number.isFinite(livePrice)) continue;
    if (trade.status === "PENDING") {
      const ageHours = hoursAgo(trade.sentAt);
      const expiry   = trade.market==="CRYPTO"?CRYPTO_PENDING_EXPIRY_HRS:trade.market==="LSE"?PENDING_EXPIRY_HOURS_LSE:PENDING_EXPIRY_HOURS_US;
      const filled   = trade.entryType==="MARKET BUY"      ? true
                     : trade.entryType==="CONDITIONAL BUY" ? livePrice >= trade.entry  // breaks above trigger
                     : livePrice <= trade.entry * 1.002;                                // limit: touches below
      const invalid  = livePrice <= trade.sl;
      const drifted  = trade.entryType==="LIMIT BUY"        && livePrice > trade.entry * 1.04;
      const dropped  = trade.entryType==="CONDITIONAL BUY"  && livePrice < trade.entry * 0.97; // dropped 3% below trigger -- cancel
      if (filled) {
        trade.status="FILLED"; trade.outcome="OPEN";
        trade.fillPrice=livePrice; trade.filledAt=nowIso();
        trade.maePct=0; trade.mfePct=0; changed=true;
        await safeRun(`fill${trade.asset}`, () => sendPrivate(buildFillMessage(trade, livePrice)));
        continue;
      }
      if (invalid) {
        trade.status="CANCELLED"; trade.outcome="STRUCTURE_INVALID";
        trade.closedAt=nowIso(); trade.closePrice=livePrice; changed=true;
        await safeRun(`invalid${trade.asset}`, () => sendPrivate(buildCloseMessage(trade,"STRUCTURE_INVALID",livePrice)));
        continue;
      }
      if (drifted) {
        trade.status="CANCELLED"; trade.outcome="DRIFTED_TOO_FAR";
        trade.closedAt=nowIso(); trade.closePrice=livePrice; changed=true;
        await safeRun(`drift${trade.asset}`, () => sendPrivate(buildCloseMessage(trade,"DRIFTED_TOO_FAR",livePrice)));
        continue;
      }
      if (dropped) {
        trade.status="CANCELLED"; trade.outcome="DRIFTED_TOO_FAR";
        trade.closedAt=nowIso(); trade.closePrice=livePrice; changed=true;
        log(`📉 Conditional dropped: ${trade.asset} -- price fell 3% below trigger`);
        await safeRun(`drop${trade.asset}`, () => sendPrivate(buildCloseMessage(trade,"DRIFTED_TOO_FAR",livePrice)));
        continue;
      }
      if (ageHours > expiry) {
        trade.status="CANCELLED"; trade.outcome="PENDING_EXPIRED";
        trade.closedAt=nowIso(); trade.closePrice=livePrice; changed=true;
        await safeRun(`expired${trade.asset}`, () => sendPrivate(buildCloseMessage(trade,"PENDING_EXPIRED",livePrice)));
        continue;
      }
    }
    if (trade.status==="FILLED" && trade.outcome==="OPEN") {
      updateTradeExcursion(trade, livePrice);
      changed = true;
      const stopHit   = livePrice <= trade.sl;
      const targetHit = livePrice >= trade.tp;
      if (stopHit || targetHit) {
        // V102: confirm before closing -- a single bad/stale price reading
        // (fetchLivePrice has no cross-source validation) shouldn't be able
        // to close a real position. One confirming re-fetch, ~3s later.
        await sleep(3000);
        const confirmPrice = await fetchLivePrice(trade.asset, trade.market);
        if (!Number.isFinite(confirmPrice)) { continue; } // couldn't confirm -- try again next cycle
        if (stopHit && confirmPrice <= trade.sl) { await closeTrade(trades,trade,confirmPrice,"STOP LOSS");   continue; }
        if (targetHit && confirmPrice >= trade.tp) { await closeTrade(trades,trade,confirmPrice,"TAKE PROFIT"); continue; }
        log(`⚠️ ${trade.asset} stop/target reading NOT confirmed on re-fetch (first=${livePrice} confirm=${confirmPrice} sl=${trade.sl} tp=${trade.tp}) -- skipping close, will recheck next cycle`);
      }
      // V102: force-close removed by request -- positions now only close via
      // STOP LOSS / TAKE PROFIT (both confirmation-guarded above), or manually.
      // shouldForceClose() is left defined, just unused, in case this needs
      // reversing -- it was also reading livePrice with no staleness guard,
      // same class of risk as the stop/target bug this session found.
    }
  }
  if (changed) await saveTradesCached(trades);
}

// ── Scan ─────────────────────────────────────────────────────────
async function scan() {
  const alerts  = await loadAlerts();
  const trades  = await loadTrades();
  const results = [];

  // V98: pre-fetch QQQ momentum once per cycle not per asset
  // Reduces async overhead and ensures consistent regime across all assets in scan
  const _qqqMomThisCycle = await getQQQMomentum();

  async function processAsset(asset, market, fetcher) {
    if (cooldown(asset, alerts, market)) return;
    if (trades.some(t => t.asset===asset && (t.status==="PENDING"||(t.status==="FILLED"&&t.outcome==="OPEN")))) return;

    // V100: per-asset failure cooldown -- skip assets that recently failed to return candles
    const failUntil = assetFailCooldown.get(asset);
    if (failUntil && Date.now() < failUntil) return;

    // V96: no re-entry on same asset within 4hrs of a loss
    // Failed momentum clusters -- AVAX failed once, second entry is a chop trap
    const recentLoss = trades.find(t =>
      t.asset === asset &&
      (t.outcome === "STOP_LOSS" || t.outcome === "FORCE_CLOSE" || t.outcome === "REPLACED") &&
      t.closedAt && hoursAgo(t.closedAt) < 4
    );
    if (recentLoss) {
      log(`⛔ ${asset} -- re-entry blocked (${recentLoss.outcome} ${hoursAgo(recentLoss.closedAt).toFixed(1)}hrs ago)`);
      return;
    }
    const candles = await fetcher(asset);
    if (!candles || candles.length < MIN_CANDLES) {
      if (market === "US") log(`⚠️ ${asset} -- no candle data (${candles?.length ?? 0} candles)`);
      // V100: per-asset failure cooldown -- prevents ASTS-style Yahoo retry spam
      // If an asset fails to return candles, skip it for 15 minutes
      assetFailCooldown.set(asset, Date.now() + 15 * 60 * 1000);
      return;
    }
    const signal  = await analyse(asset, candles, market, _qqqMomThisCycle);
    if (!signal) return;
    results.push(signal);
  }

  if (shouldScanCrypto()) {
    // Change 5: Crypto breadth filter -- avoid isolated pumps in weak market conditions
    // Count how many tracked pairs are green on current 15-min candle
    let greenPairs = 0;
    let checkedPairs = 0;
    for (const sym of CRYPTO_PAIRS.slice(0, 12)) {
      try {
        const c = await fetchCrypto(sym);
        if (c && c.length >= 20) {
          checkedPairs++;
          // V100 FIX: use close vs EMA20 for breadth, not last-candle-vs-prior.
          // Single-candle comparison incorrectly fires "weak" during normal 15m pullbacks
          // in a genuine bull session (UNI +13% day but one red 15m candle = "not green").
          // EMA20 alignment correctly measures whether the coin is trending up today.
          const closes = c.map(x => x.close);
          const ema20val = ema(closes, 20);
          if (closes.at(-1) > ema20val) greenPairs++;
        }
      } catch { /* skip */ }
    }
    const breadthOk = checkedPairs < 5 || (greenPairs / checkedPairs) >= 0.30; // 30% -- was 45%, too aggressive
    global.lastCryptoBreadthCount = greenPairs; // V100: expose to analyse() for BROAD_MOMENTUM setup
    if (!breadthOk) {
      // V101 FIX: weak breadth used to skip the ENTIRE crypto scan, silencing
      // genuinely hot individual assets (e.g. EIGEN exploding while 9 other
      // unrelated coins were red). Broad market weakness is a real signal to
      // be cautious about NEW broad-based longs, but it shouldn't blind the
      // scanner to a single asset that's independently moving on its own
      // catalyst. Now: still scan assets already flagged hot by intel/heat,
      // skip only the broad "scan everything" pass.
      const hotSymbols = getHotAssets().map(h => h.asset).filter(s => CRYPTO_PAIRS.includes(s));
      if (hotSymbols.length > 0) {
        log(`🚫 Crypto breadth very weak -- ${greenPairs}/${checkedPairs} green -- skipping broad scan, checking ${hotSymbols.length} hot asset(s) individually: ${hotSymbols.map(s=>s.replace("USDT","")).join(", ")}`);
        await mapWithConcurrency(hotSymbols, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset,"CRYPTO",fetchCryptoWithFallback));
      } else {
        log(`🚫 Crypto breadth very weak -- ${greenPairs}/${checkedPairs} green -- skipping crypto scan (no hot assets to check individually)`);
      }
    } else {
      log(`📊 Crypto breadth ok -- ${greenPairs}/${checkedPairs} green`);
      await mapWithConcurrency(CRYPTO_PAIRS, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset,"CRYPTO",fetchCryptoWithFallback));
    }
  }
  if (shouldScanUS()) {
    log(`📈 US scan -- ${STOCK_POOL.length} stocks, QQQ=${qqqTrend}, openingWindow=${isUSOpeningWindow()}`);
    await mapWithConcurrency(STOCK_POOL, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset,"US",fetchUSData));
  }
  if (shouldScanLSE()) {
    await mapWithConcurrency(LSE_POOL, MAX_CONCURRENT_REQUESTS, asset => processAsset(asset,"LSE",fetchLSEData));
  }

  return pickTopSignals(results);
}

// ── Process signals ──────────────────────────────────────────────
// V102: first-fire + peak-score milestones. Both checked on every real
// fire (rare event, not a hot path) so a per-fire Supabase lookup is fine.
async function checkAssetMilestones(signal) {
  if (!supabaseEnabled) return;
  try {
    // -- First fire ever for this asset --
    const { data: priorFires, error: priorErr } = await retry(() => supabase
      .from("trades")
      .select("id")
      .eq("asset", signal.asset)
      .eq("market", signal.market)
      .limit(1)
    );
    if (!priorErr && priorFires && priorFires.length === 0) {
      const msg = lines([
        "🌟 <b>FIRST FIRE EVER</b>",
        "",
        `<b>${escapeHtml(signal.asset)}</b> (${escapeHtml(signal.market)}) has never fired an ELITE signal before now.`,
        `Setup: ${escapeHtml(signal.setupType)} · Score: ${signal.score} · RR: ${signal.rr}`,
        "",
        "This is the asymmetric-upside case -- a brand new name clearing the bar for the first time."
      ]);
      await safeRun("firstFireAlert", () => sendSignalsChannels(msg));
    }

    // -- Peak score tracking --
    const { data: peakRow, error: peakErr } = await retry(() => supabase
      .from("asset_peak_scores")
      .select("peak_score, peak_date")
      .eq("symbol", signal.asset)
      .eq("market", signal.market)
      .maybeSingle()
    );
    if (peakErr) { log(`⚠️ Peak score lookup error: ${peakErr.message}`); return; }

    const isNewPeak = !peakRow || signal.score > peakRow.peak_score;
    if (isNewPeak) {
      const prevText = peakRow ? `previous peak ${peakRow.peak_score} on ${new Date(peakRow.peak_date).toLocaleDateString("en-GB")}` : "no prior peak on record";
      await retry(() => supabase.from("asset_peak_scores").upsert({
        symbol: signal.asset, market: signal.market,
        peak_score: signal.score, peak_date: new Date().toISOString(),
        setup_type: signal.setupType
      }, { onConflict: "symbol,market" }));

      if (peakRow) { // only alert on a genuine NEW peak, not the first-ever row creation
        const msg = lines([
          "📈 <b>NEW PEAK SCORE</b>",
          "",
          `<b>${escapeHtml(signal.asset)}</b> (${escapeHtml(signal.market)}) just scored <b>${signal.score}</b> -- ${escapeHtml(prevText)}.`,
          `Setup: ${escapeHtml(signal.setupType)}`
        ]);
        await safeRun("peakScoreAlert", () => sendSignalsChannels(msg));
      }
    }
  } catch (e) {
    log(`⚠️ Asset milestone check failed: ${e.message}`);
  }
}

async function processSignals(signals) {
  const alerts = await loadAlertsCached();
  const trades = await loadTradesCached();

  for (const signal of signals) {
    const existingOpenTrade = getOpenTradeInMarket(trades, signal.market);
    if (existingOpenTrade) {
      const livePrice = await fetchLivePrice(existingOpenTrade.asset, existingOpenTrade.market);
      if (shouldReplaceTrade(signal, existingOpenTrade, livePrice)) {
        await closeTrade(trades, existingOpenTrade, Number.isFinite(livePrice)?livePrice:existingOpenTrade.entry, "REPLACED");
      } else { continue; }
    }

    if (countOpenTradesByMarket(trades,signal.market) >= MAX_POSITIONS[signal.market]) continue;
    // V96: strict single pending per market -- crypto especially
    // Too many pending signals = noise, fills never happen, force closes pile up
    const pendingTrades = trades.filter(t => t.market===signal.market && t.status==="PENDING");
    if (pendingTrades.length >= 2) continue; // V98: raised from 1 -- subscription product needs concurrent signals

    const riskFraction = getRiskFractionForSignal(signal);
    if (getOpenRiskFraction(trades) + riskFraction > MAX_PORTFOLIO_RISK) continue;

    const size = calculatePositionSize(signal);
    if (!Number.isFinite(size)||size<=0) continue;

    const sentAt  = nowIso();
    const alertId = `${signal.asset}-${signal.market}-${Math.floor(new Date(sentAt).getTime()/(120*60000))}`; // 2hr dedup window
    if (alerts.some(a => a.id===alertId)) { log(`⏳ Dedup blocked ${signal.asset}`); continue; }
    if (trades.some(t => t.asset===signal.asset && t.status==="PENDING")) { log(`⏳ Pending exists ${signal.asset}`); continue; }

    await safeRun(`signal${signal.asset}`, () => sendSignalsChannels(buildSignalMessage(signal, size)));
    lastSignalTime = Date.now();
    // V98: signal firing adds heat -- confirms momentum is real
    addHeat(signal.asset, 30, "signal-fired");

    // Phase 2 evidence logging -- track everything needed for later statistical analysis
    // Do NOT act on this yet. Collect 20-50 signals then look for patterns.
    log(`📋 SIGNAL LOG | ${signal.asset} | setup=${signal.setupType} | btc=${btcTrend} | vol=${signal.volRatio?.toFixed(2)}x | mom=${((signal.momentum||0)*100).toFixed(2)}% | score=${signal.score} | emaDistPct=${signal.emaDistPct?.toFixed(2)||'?'}%`);

    // V102: first-fire + peak-score milestone checks -- must run BEFORE
    // this asset gets pushed to trades below, otherwise "first fire" would
    // always see itself in the history it's checking against.
    await checkAssetMilestones(signal);

    alerts.push({ id:alertId, asset:signal.asset, market:signal.market, sentAt });
    trades.push({
      id:`${signal.asset}-${Date.now()}`, asset:signal.asset, market:signal.market,
      setupType:signal.setupType, entryType:signal.entryType,
      entry:signal.entry, sl:signal.sl, tp:signal.tp,
      rrPlanned:signal.rr, score:signal.score, volRatio:signal.volRatio,
      momentum:signal.momentum, regime:signal.regime,
      sentAt, status:"PENDING", outcome:"OPEN", sentToChannel:true,
      fillPrice:null, closePrice:null, closedAt:null, filledAt:null,
      maePct:0, mfePct:0, realizedR:null, riskFraction,
      structureScore: signal.structureScore ?? null,
      structureGrade: signal.structureGrade ?? null,
      structureFlags: signal.structureFlags ?? null,
      structureRejectReasons: signal.structureRejectReasons ?? null
    });
  }

  await saveAlertsCached(alerts);
  await saveTradesCached(trades);
}

// ── Main cycle ───────────────────────────────────────────────────
// ── Pre-market mover detection ───────────────────────────────────
// Runs 13:00-14:25 UK on weekdays (US pre-market window)
// Sends a watchlist-style alert flagging HIGH_BETA names up 3%+
// No entry signals -- awareness only. Primes scanner for 14:30 open.

let lastPreMarketAlertTime = 0;
let lastPreMarketKey       = "";

function isPreMarketWindow() {
  if (isWeekend()) return false;
  const m = getUkMinutes();
  return m >= 780 && m < 865; // 13:00-14:25 UK
}

async function fetchPreMarketPrice(symbol) {
  try {
    const { data } = await retry(() =>
      axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
        params: { interval: "1m", range: "1d", includePrePost: true },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000
      })
    );
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta        = result.meta;
    const prePrice    = meta?.preMarketPrice;
    const regularPrev = meta?.chartPreviousClose || meta?.previousClose;
    if (!prePrice || !regularPrev || regularPrev <= 0) return null;
    const changePct = (prePrice - regularPrev) / regularPrev;
    return { price: prePrice, prev: regularPrev, changePct };
  } catch { return null; }
}

async function sendPreMarketAlert() {
  if (!isWeekday() || !isPreMarketWindow()) return;

  // Max one alert per hour in the pre-market window
  if (Date.now() - lastPreMarketAlertTime < 60 * 60 * 1000) return;

  const movers = [];
  const watchList = [...HIGH_BETA_STOCKS].slice(0, 20);

  for (const sym of watchList) {
    try {
      const r = await fetchPreMarketPrice(sym);
      if (!r) continue;
      if (Math.abs(r.changePct) >= 0.03) { // 3%+ move
        movers.push({ sym, changePct: r.changePct, price: r.price });
      }
    } catch { /* skip */ }
  }

  if (movers.length === 0) return;

  // Sort by absolute move
  movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

  // Content dedup -- same movers = skip
  const key = movers.map(m => m.sym).join(",");
  if (key === lastPreMarketKey) return;
  lastPreMarketKey       = key;
  lastPreMarketAlertTime = Date.now();

  const moverLines = movers.map(m => {
    const pct   = (m.changePct * 100).toFixed(1);
    const arrow = m.changePct >= 0 ? "🟢" : "🔴";
    const flag  = m.changePct >= 8 ? " 🔥" : m.changePct >= 5 ? " ⚡" :
                  m.changePct <= -8 ? " 🧊" : m.changePct <= -5 ? " 🥶" : "";
    return `${arrow} <b>${escapeHtml(m.sym)}</b> ${m.changePct>=0?"+":""}${pct}%${flag} -- $${m.price.toFixed(2)} pre-market`;
  });

  const msg = [
    `\u23F0 <b>PRE-MARKET MOVERS</b> -- ${new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})} UK`,
    `<i>US open in ~${Math.round((865 - getUkMinutes()))} mins</i>`,
    "",
    ...moverLines,
    "",
    "\uD83D\uDCA1 Watch for breakout confirmation at 14:30 open",
    "\uD83D\uDD0D Scanner primed -- entry signal fires if setup confirms"
  ].join("\n");

  await sendChannel(msg);
  log(`⏰ Pre-market alert sent: ${movers.map(m=>`${m.sym}${(m.changePct*100).toFixed(1)}%`).join(", ")}`);
}

// ── Morning Movers Briefing ──────────────────────────────────────
// Fires once per day between 08:00-09:00 UK on weekdays
// Shows HIGH_BETA names already moving 3%+ before the US open
// Only covers stocks in HIGH_BETA_STOCKS -- no penny stocks or noise

let lastMorningBriefingDate = "";

// V101: once-per-day guards for weekly/midweek intel jobs.
// Without these, sendMidweekCheckin/sendWeekInReview/sendOnTheRadar/
// sendWeeklyAudit/runWeeklyRegimeJob would fire on EVERY scan cycle (every
// 60-90s) all day on their respective weekday, since they're now called
// every cycle rather than only on the US open->close transition.
let lastMidweekCheckinDate  = "";
let lastWeekInReviewDate    = "";
let lastOnTheRadarDate      = "";
let lastWeeklyAuditDate     = "";
let lastRegimeJobDate       = "";

function isMorningBriefingWindow() {
  if (isWeekend()) return false;
  const m = getUkMinutes();
  return m >= 480 && m < 540; // 08:00-09:00 UK
}

async function sendMorningBriefing() {
  if (!isMorningBriefingWindow()) return;

  // Only once per calendar day
  const today = new Date().toISOString().slice(0, 10);
  if (lastMorningBriefingDate === today) return;

  // V100: skip entirely on US market holidays -- "movers" would be stale
  // 24h-change figures from the last trading session, not live data, and
  // posting them as if fresh is misleading. Saves a scan cycle's worth of credits too.
  if (isUSMarketHoliday()) {
    log("🏖️ Morning briefing skipped -- US market holiday");
    lastMorningBriefingDate = today; // still mark as done so it doesn't retry all day
    return;
  }

  if (!canUseFinnhub()) {
    log("⚠️ Morning briefing skipped -- Finnhub blocked");
    return;
  }

  const movers = [];
  const watchList = [...HIGH_BETA_STOCKS];

  await mapWithConcurrency(watchList, 2, async sym => {
    try {
      const result = await safeRequest(() =>
        axios.get("https://finnhub.io/api/v1/quote", {
          params: { symbol: sym, token: FINNHUB_API_KEY },
          timeout: 8000
        }), `Finnhub morning quote ${sym}`
      );
      const changePct = result?.data?.dp;
      const price     = result?.data?.c;
      if (Number.isFinite(changePct) && Number.isFinite(price) && Math.abs(changePct) >= 3) {
        movers.push({ sym, changePct, price });
        setPreMarketPrice(sym, changePct, price); // feed into opening window scanner
      }
    } catch { /* skip */ }
  });

  if (movers.length === 0) {
    log("📋 Morning briefing: no HIGH_BETA movers 3%+ today");
    lastMorningBriefingDate = today;
    return;
  }

  // V100: positives lead, negatives summarised
  const positives = movers.filter(m => m.changePct >= 3).sort((a,b) => b.changePct - a.changePct);
  const negatives = movers.filter(m => m.changePct < 0).sort((a,b) => a.changePct - b.changePct);
  lastMorningBriefingDate = today;

  const formatMover = m => {
    const pct   = m.changePct.toFixed(1);
    const arrow = m.changePct >= 0 ? "\uD83D\uDCC8" : "\uD83D\uDCC9";
    const elite = m.changePct >= 10 ? " \uD83D\uDD25" : m.changePct >= 7 ? " \u26A1" :
                  m.changePct <= -10 ? " \uD83E\uDDCA" : m.changePct <= -7 ? " \uD83E\uDD76" : "";
    return `${arrow} <b>${escapeHtml(m.sym)}</b> ${m.changePct >= 0 ? "+" : ""}${pct}%${elite} \u2014 $${m.price.toFixed(2)}`;
  };

  const msgParts = [
    `\uD83C\uDF05 <b>MORNING MOVERS</b> \u2014 ${new Date().toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"short", timeZone:"Europe/London" })}`,
    `<i>HIGH_BETA watchlist \u2014 US open in ~${Math.round((870 - getUkMinutes()))} mins</i>`,
    "",
  ];

  // Positives first -- these are the trade candidates
  if (positives.length > 0) {
    msgParts.push(`\uD83D\uDFE2 <b>Pre-market strength:</b>`);
    positives.slice(0, 5).forEach(m => msgParts.push(`  ${formatMover(m)}`));
    msgParts.push("");
  }

  // Negatives summarised -- don't dominate the message
  if (negatives.length > 0) {
    if (negatives.length <= 3) {
      // Few enough to list
      msgParts.push(`\uD83D\uDD34 <b>Under pressure:</b>`);
      negatives.slice(0, 3).forEach(m => msgParts.push(`  ${formatMover(m)}`));
    } else {
      // Too many -- just summarise
      const worstName = negatives[0].sym;
      const worstPct  = negatives[0].changePct.toFixed(1);
      msgParts.push(`\uD83D\uDD34 ${negatives.length} stocks under pressure (worst: ${worstName} ${worstPct}%)`);
    }
    msgParts.push("");
  }

  if (positives.length === 0 && negatives.length > 0) {
    msgParts.push(`\u26A0\uFE0F No pre-market strength detected \u2014 scanner will monitor at open`);
    msgParts.push("");
  }

  msgParts.push(`\uD83D\uDD0D Scanner primes at 14:30 \u2014 entry fires if setup confirms at open`);

  const msg = msgParts.filter(l => l !== undefined).join("\n");
  await sendChannel(msg);
  log(`\uD83C\uDF05 Morning briefing sent: ${movers.length} movers`);
}

// ================================================================
// V100: SNIPER ENGINE
// Predict. Hunt. Strike. Ride.
// ================================================================

// ── Update Sniper roster ─────────────────────────────────────────
// Called every main cycle -- promotes/demotes assets based on heat
function updateSniperRoster() {
  const now = Date.now();

  // Reset conviction posts daily
  const today = new Date().getDate();
  if (convictionDay !== today) {
    convictionPosted.clear();
    convictionDay = today;
    sniperHitCount = 0;
  }

  // Promote HOT assets into Sniper tier
  const hotAssets = getHotAssets().filter(a => a.heat >= SNIPER_HEAT_THRESHOLD);
  for (const { asset } of hotAssets.slice(0, SNIPER_MAX_ASSETS)) {
    if (!SNIPER_ASSETS.has(asset)) {
      // Determine market
      const market = CRYPTO_PAIRS.includes(asset) ? "CRYPTO"
                   : LSE_POOL.includes(asset)      ? "LSE"
                   : "US";
      SNIPER_ASSETS.set(asset, { market, heat: getHeat(asset), promotedAt: now });
      log(`🎯 SNIPER PROMOTED: ${asset} (heat: ${Math.round(getHeat(asset))})`);
    } else {
      // Update heat
      SNIPER_ASSETS.get(asset).heat = getHeat(asset);
    }
  }

  // Demote assets that have cooled below threshold
  for (const [asset, data] of SNIPER_ASSETS.entries()) {
    const currentHeat = getHeat(asset);
    const heldHours   = (now - data.promotedAt) / 3600000;
    if (currentHeat < WARM_HEAT_THRESHOLD || heldHours > 12) {
      SNIPER_ASSETS.delete(asset);
      log(`❄️ SNIPER DEMOTED: ${asset} (heat: ${Math.round(currentHeat)})`);
    }
  }

  // Post conviction alerts for warm assets approaching HOT
  if (shouldSendStockAlerts() || shouldSendCryptoAlerts()) {
    const warmCandidates = [...HEAT_SCORES.entries()]
      .map(([asset]) => ({ asset, heat: getHeat(asset) }))
      .filter(x => x.heat >= CONVICTION_ALERT_HEAT && x.heat < SNIPER_HEAT_THRESHOLD)
      .filter(x => !convictionPosted.has(x.asset))
      .sort((a, b) => b.heat - a.heat)
      .slice(0, 3);

    for (const { asset, heat } of warmCandidates) {
      convictionPosted.add(asset);
      const sym    = asset.replace("USDT", "");
      const mktFlag = CRYPTO_PAIRS.includes(asset) ? "🪙"
                    : LSE_POOL.includes(asset)      ? "🇬🇧"
                    : "🇺🇸";

      // Derive setup description from heat score context
      // At conviction stage we don't have a confirmed setup yet -- describe what's forming
      const sniperData  = SNIPER_ASSETS.get(asset);
      const setupDesc   = sniperData
        ? "pullback to EMA"        // in Sniper tier = pullback/recovery pattern being watched
        : "momentum building";     // warm tier = trend developing

      safeRun("convictionAlert", () => sendChannel(lines([
        `👀 <b>WATCHLIST BUILDING</b>`,
        ``,
        `Setups forming — no confirmed entry yet:`,
        ``,
        `  ${mktFlag} <b>${escapeHtml(sym)}</b> — ${setupDesc}`,
        ``,
        `💡 Scanner will alert if setup confirms on next cycle`,
        `——————————`,
        `⚠️ Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · @baretradesignals 🎯`,
      ])));
      log(`👀 Watchlist alert: ${asset} (heat: ${Math.round(heat)})`);
    }
  }
}

// ── Sniper scan (fast loop) ──────────────────────────────────────
// Scans only HOT assets every 8-12 seconds
// Uses 5m candles for execution timing, 15m for trend bias
// Fires signals to processSignals same as main scanner
async function sniperScan() {
  if (SNIPER_ASSETS.size === 0) return;
  if (shuttingDown) return;

  const alerts = await loadAlerts();
  const trades = await loadTrades();
  const results = [];

  // Pre-fetch QQQ momentum once for this sniper cycle
  const _qqqMom = await getQQQMomentum();

  for (const [asset, data] of SNIPER_ASSETS.entries()) {
    try {
      // Skip if already in a trade or cooldown
      if (cooldown(asset, alerts, data.market)) continue;
      if (trades.some(t => t.asset === asset && (t.status === "PENDING" || (t.status === "FILLED" && t.outcome === "OPEN")))) continue;

      let candles15m, candles5m;

      if (data.market === "CRYPTO") {
        candles15m = await fetchCryptoWithFallback(asset);
        candles5m  = await fetchCrypto5m(asset);
      } else if (data.market === "US") {
        candles15m = await fetchUSData(asset);
        candles5m  = null; // US 5m via Yahoo is too slow for hot loop
      } else {
        candles15m = await fetchLSEData(asset);
        candles5m  = null;
      }

      if (!candles15m || candles15m.length < MIN_CANDLES) continue;

      // V100: Sniper uses 15m for trend/score, 5m for execution timing
      // If 5m data available, check for pullback-and-recovery pattern
      // before passing to main analyse() engine
      if (candles5m && candles5m.length >= 10) {
        const last5m   = candles5m.at(-1);
        const prev5m   = candles5m.at(-2);
        const prev25m  = candles5m.at(-3);

        // Pullback-and-recovery: dip then recovery with volume
        const avg5mVol   = candles5m.slice(-20, -1).reduce((s,c) => s + c.volume, 0) / 19;
        const pullback   = prev5m.close < prev25m.close;                         // price pulled back
        const recovered  = last5m.close > prev5m.close;                          // now recovering
        const volumeOk   = last5m.volume > avg5mVol * 1.2;                       // volume returning
        const momentum5m = (last5m.close - prev5m.close) / prev5m.close;

        // Log the 5m state for diagnostics
        log(`🎯 SNIPER 5m ${asset}: pullback=${pullback} recovered=${recovered} vol=${(last5m.volume/avg5mVol).toFixed(2)}x mom=${(momentum5m*100).toFixed(2)}%`);

        // Skip if in active pullback with no recovery yet
        if (pullback && !recovered) {
          log(`⏳ SNIPER WAITING: ${asset} -- pullback in progress, waiting for recovery`);
          continue;
        }
      }

      // Run through standard analyse() for full quality check
      const signal = await analyse(asset, candles15m, data.market, _qqqMom);
      if (!signal) continue;

      // Tag as sniper signal
      signal.sniperMode  = true;
      signal.heat        = Math.round(data.heat);
      results.push(signal);
      log(`🎯 SNIPER SIGNAL: ${asset} score=${signal.score} grade=${signal.grade}`);

    } catch (err) {
      log(`SNIPER ERROR ${asset}: ${err?.message||err}`);
    }
  }

  if (results.length > 0) {
    sniperHitCount++;
    await safeRun("sniperProcess", () => processSignals(results));
  }
}

// ── Warm scan (medium loop) ──────────────────────────────────────
// Scans assets with heat 40-89 every 30 seconds
async function warmScan() {
  if (shuttingDown) return;

  const warmAssets = [...HEAT_SCORES.entries()]
    .map(([asset]) => ({ asset, heat: getHeat(asset) }))
    .filter(x => x.heat >= WARM_HEAT_THRESHOLD && x.heat < SNIPER_HEAT_THRESHOLD)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, 10);

  if (warmAssets.length === 0) return;

  const alerts  = await loadAlerts();
  const trades  = await loadTrades();
  const results = [];
  const _qqqMom = await getQQQMomentum();

  for (const { asset } of warmAssets) {
    try {
      const market = CRYPTO_PAIRS.includes(asset) ? "CRYPTO"
                   : LSE_POOL.includes(asset)      ? "LSE"
                   : "US";

      if (cooldown(asset, alerts, market)) continue;
      if (trades.some(t => t.asset === asset && (t.status === "PENDING" || (t.status === "FILLED" && t.outcome === "OPEN")))) continue;

      let candles;
      if (market === "CRYPTO") candles = await fetchCryptoWithFallback(asset);
      else if (market === "US") candles = await fetchUSData(asset);
      else candles = await fetchLSEData(asset);

      if (!candles || candles.length < MIN_CANDLES) continue;

      const signal = await analyse(asset, candles, market, _qqqMom);
      if (!signal) continue;

      signal.warmMode = true;
      results.push(signal);
    } catch (err) {
      log(`WARM SCAN ERROR ${asset}: ${err?.message||err}`);
    }
  }

  if (results.length > 0) {
    await safeRun("warmProcess", () => processSignals(results));
  }
}

// ── Sniper loop ──────────────────────────────────────────────────
async function sniperLoop() {
  if (shuttingDown) return;
  if (sniperRunning) return; // never overlap
  sniperRunning = true;
  try {
    await sniperScan();
  } catch (err) {
    log("SNIPER LOOP ERROR:", err?.message||err);
  } finally {
    sniperRunning = false;
  }
  if (!shuttingDown) {
    // Market Open Mode: faster cadence 14:25-15:00 UK
    const mins    = getUkMinutes();
    const openMode = mins >= OPEN_MODE_START_MIN && mins < OPEN_MODE_END_MIN;
    const interval = openMode ? SNIPER_OPEN_LOOP_MS : SNIPER_LOOP_MS;
    sniperTimer = setTimeout(() => void sniperLoop(), interval);
  }
}

// ── Warm loop ────────────────────────────────────────────────────
async function warmLoop() {
  if (shuttingDown) return;
  if (warmRunning) return;
  warmRunning = true;
  try {
    await warmScan();
  } catch (err) {
    log("WARM LOOP ERROR:", err?.message||err);
  } finally {
    warmRunning = false;
  }
  if (!shuttingDown) {
    warmTimer = setTimeout(() => void warmLoop(), WARM_LOOP_MS);
  }
}

// ================================================================
// END V100 SNIPER ENGINE
// ================================================================

async function safeCycle() {
  if (running||shuttingDown) return;
  running = true;
  cycleCount++;
  try {
    resetApiUsageIfNewDay();
    await safeRun("btcTrend",         updateBTCTrend);
    await safeRun("btcMacroTrend",    updateBTCMacroTrend);   // V100: 4h macro regime
    await safeRun("qqqTrend",         updateQQQTrend);

    // V100: Capital protection alert -- tell subscribers WHY we're not trading
    // V100: Market-specific capital protection alerts
    // BTC controls crypto alerts. QQQ controls US alerts. Separate and clean.
    const alertCooldown = Date.now() - lastMacroAlert > 3 * 60 * 60 * 1000;
    const nowProtecting = isMacroProtecting();

    if (nowProtecting && !macroProtecting && alertCooldown) {
      macroProtecting = true;
      lastMacroAlert  = Date.now();
      const cryptoBlocked = isCryptoBlocked();
      const usBlocked     = isUSBlocked();
      const lines2 = [
        `📊 <b>MARKET UPDATE</b>`,
        ``,
        `Current conditions:`,
      ];
      if (cryptoBlocked) {
        lines2.push(`🪙 <b>Bitcoin</b> — ${escapeHtml(getProtectionReason("CRYPTO"))}`);
      }
      if (usBlocked) {
        lines2.push(`🇺🇸 <b>US market</b> — ${escapeHtml(getProtectionReason("US"))}`);
      }
      lines2.push(``);
      lines2.push(`The algorithm requires confirmed trends before flagging setups.`);
      lines2.push(`No setups are being flagged at this time.`);
      lines2.push(``);
      lines2.push(`Intel and analysis continue as normal.`);
      lines2.push(``);
      lines2.push(`——————————`);
      lines2.push(`⚠️ <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · @baretradesignals 🎯</i>`);
      await safeRun("macroAlert", () => sendChannel(lines(lines2)));

    } else if (!nowProtecting && macroProtecting) {
      macroProtecting = false;
      lastMacroAlert  = Date.now();
      await safeRun("macroLift", () => sendChannel(lines([
        `✅ <b>SCANNER RESUMING</b>`,
        ``,
        `Market conditions have improved.`,
        `The algorithm is back to scanning for setups.`,
        ``,
        `🪙 BTC: <b>${escapeHtml(btcTrend)}</b> (1h) | <b>${escapeHtml(btcMacroTrend)}</b> (4h)`,
        `🇺🇸 QQQ: <b>${escapeHtml(qqqTrend)}</b> (${qqqBullCount} stable readings)`,
        ``,
        `——————————`,
        `⚠️ <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · @baretradesignals 🎯</i>`,
      ])));
    }
    await safeRun("morningBriefing",  sendMorningBriefing);
    await safeRun("preMarket",        sendPreMarketAlert);
    await safeRun("marketAlerts",     checkMarketAlerts);

    // V101: momentum leaderboard check -- throttled to ~every 12 minutes.
    // Doesn't need every-cycle frequency (heat decays over hours, not
    // seconds) and this avoids hammering Supabase on every 60-90s scan.
    if (Date.now() - lastLeaderboardCheck > 12 * 60 * 1000) {
      lastLeaderboardCheck = Date.now();
      await safeRun("momentumLeaderboard", runMomentumLeaderboardCheck);
    }
    await safeRun("dynamicInjection", injectHotCryptoMovers);
    await safeRun("sniperRoster",     updateSniperRoster);  // V100: promote/demote sniper assets
    await safeRun("manageTrades",     manageTrades);
    // V102: hourly reject summary removed by request -- daily summary
    // (sendRejectStatsSummary, at US close) now carries real diagnostic
    // insight instead, so the hourly version was redundant noise.
    // sendHourlyRejectSummary() left defined, just unused.
    const signals = await withTimeout(safeRun("scan", scan), SCAN_TIMEOUT_MS, "scan");
    await safeRun("flushRejectDiagnostics", flushRejectDiagnostics);
    await safeRun("safetyModeAlert", sendSafetyModeAlert);
    if (Array.isArray(signals) && signals.length > 0) {
      await safeRun("processSignals", () => processSignals(signals));
    } else {
      log(`NO SIGNALS -- TD=${apiUsage.twelvedata} AV=${apiUsage.alphavantage} BTC=${btcTrend}`);
      // V100: regime-aware watchlist throttle
      // BULL: watchlist after 90 mins quiet, hourly max
      // BEAR: watchlist max once every 4 hours -- no point posting every cycle when market is down
      const sinceLastSignal = lastSignalTime > 0 ? Date.now() - lastSignalTime : Infinity;
      const bearMode        = isMacroProtecting();
      const quietThreshold  = bearMode ? 4 * 60 * 60 * 1000 : 90 * 60 * 1000;
      const quietEnough     = sinceLastSignal > quietThreshold;
      if (quietEnough) {
        const alerts = await loadAlertsCached();
        const trades = await loadTradesCached();
        await safeRun("watchlist", () => sendWatchlistAlert(alerts, trades));
      }
    }
  } catch (err) {
    log("CYCLE ERROR:", err?.message||err);
  } finally {
    running = false;
  }
}

async function cycleLoop() {
  if (shuttingDown) return;
  const started  = Date.now();
  await safeCycle();
  const elapsed  = Date.now() - started;
  // V100: regime-aware scan interval
  // BEAR (macro protecting): longer cycles -- no point hammering 77 assets when nothing qualifies
  // BULL: 60s cycles -- momentum needs speed
  const interval = getScanInterval();
  const wait     = elapsed >= interval ? 1000 : interval - elapsed;
  if (interval === SCAN_INTERVAL_BEAR_MS) {
    log(`🐻 BEAR regime -- next scan in ${Math.round(SCAN_INTERVAL_BEAR_MS / 60000)} mins (API conservation mode)`);
  }
  cycleTimer = setTimeout(() => void cycleLoop(), wait);
}

async function refreshLoop() {
  if (shuttingDown) return;
  await safeRun("refreshPools", refreshDynamicPools);
  refreshTimer = setTimeout(() => void refreshLoop(), POOL_REFRESH_INTERVAL_MS);
}

// ── Graceful shutdown ────────────────────────────────────────────
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true; ready = false;
  clearRuntimeTimers();
  log(`🛑 ${signal} received`);
  try {
    const [trades, alerts] = await Promise.all([loadTrades(), loadAlerts()]);
    await Promise.all([saveTrades(trades), saveAlerts(alerts)]);
    log("💾 State saved");
  } catch (err) { log("Shutdown error:", err?.message||err); }
  if (server) await new Promise(resolve => { server.close(resolve); setTimeout(resolve, 2000); });
  setTimeout(() => process.exit(signal==="UNCAUGHT_EXCEPTION"?1:0), SHUTDOWN_EXIT_MS);
}

process.on("unhandledRejection", reason => console.error("UNHANDLED REJECTION:", reason));
process.on("uncaughtException",  async err => {
  console.error("UNCAUGHT EXCEPTION:", err);
  if (fatalTriggered) return;
  fatalTriggered = true;
  await gracefulShutdown("UNCAUGHT_EXCEPTION");
});
process.on("SIGINT",  () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

// ── Boot ─────────────────────────────────────────────────────────
ensureFiles();

server = app.listen(PORT, "0.0.0.0", async () => {
  log(`🚀 SNIPER V100 on port ${PORT}`);
  await safeRun("bootTelegram", () => sendPrivate(lines([
    "🚀 SNIPER V100 LIVE — PREDICT. HUNT. STRIKE. RIDE.",
    "",
    "🧠 PREDICT: Intel identifies leaders by 08:00 UK",
    "🔥 HUNT: HOT assets scanned every 12s, WARM every 30s",
    "🎯 STRIKE: Pullback entries with conviction alerts",
    "🚀 RIDE: Exits on structure not time",
    "",
    "Tier 1 HOT (heat ≥90) → 12s scans, 8s at open",
    "Tier 2 WARM (heat 40-89) → 30s scans",
    "Tier 3 COLD → normal 90s cycle",
    "Market Open Mode 14:25-15:00 UK → 8s HOT scans",
    "5m candles for HOT execution timing",
    "",
    "Alpaca: " + (ALPACA_API_KEY ? "ENABLED" : "NOT CONFIGURED"),
    "Polygon: " + (POLYGON_API_KEY ? "ENABLED" : "NOT CONFIGURED"),
    "Supabase: " + (supabaseEnabled ? "ENABLED" : "DISABLED"),
  ])));
  // Supabase connection test
  if (supabaseEnabled) {
    try {
      const { error } = await supabase.from("trades").select("id").limit(1);
      if (error) {
        log(`❌ Supabase connection test FAILED: ${error.message}`);
        await sendPrivate(`\u26a0\ufe0f <b>Supabase connection failed</b>\n${error.message}\nFalling back to local JSON.`);
      } else {
        log("✅ Supabase connection test passed");
      }
    } catch (e) {
      log(`❌ Supabase connection test exception: ${e.message}`);
      await sendPrivate(`\u26a0\ufe0f <b>Supabase connection exception</b>\n${e.message}`);
    }
  }
  await sleep(STARTUP_DELAY_MS);
  await safeRun("initialPools",  refreshDynamicPools);
  ready = true;
  log("✅ SNIPER V100 READY -- PREDICT. HUNT. STRIKE. RIDE.");
  await safeRun("initialCycle", safeCycle);
  cacheCleanupTimer = setInterval(cleanupCandleCache, CACHE_CLEANUP_MS);
  void cycleLoop();
  void refreshLoop();
  // V100: Start priority scanning loops
  setTimeout(() => void sniperLoop(), 5000);  // Sniper starts 5s after boot
  setTimeout(() => void warmLoop(),   10000); // Warm starts 10s after boot
  log("🎯 V100 Sniper Engine armed -- HOT loop: 12s | WARM loop: 30s | Open Mode: 8s");
});
