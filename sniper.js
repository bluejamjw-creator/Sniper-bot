// ================================================================
// SNIPER V100 -- PART 1 OF 3
// Paste first. Parts 2 and 3 follow immediately after.
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

console.log("🚀 SNIPER V100 STARTING...");

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
  "XRP"  // w/e 08-Jun-2026: liquidity magnet on risk-on rotation
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
const MIN_US_SCORE_HB       = 65;   // V98: lowered from 70 -- runners need room to score

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

const MIN_GLOBAL_SCORE = 85; // V100: floor only -- dynamic elite threshold handles final gate
const MIN_CRYPTO_SCORE = 88; // V100 P1: lowered from 100 -- A+ only was rejecting real opportunities on NEAR/SUI/ONDO etc
const MIN_US_SCORE     = 68;
const MIN_LSE_SCORE    = 60;

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
  "ASTS","RKLB","LUNR","IONQ","OKLO","SMR","AVAV","ACHR","JOBY","SPCX","SPCE",
  "MSTR","COIN","PLTR","CRWD","MARA","RIOT","CLSK","TSLA",
  "NVDA","AMD","SMCI","SOUN","PTON","UPST","OPEN","HOOD"
]);

function isHighBeta(symbol) { return HIGH_BETA_STOCKS.has(symbol); }

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
const REGIME_OVERRIDE_MIN_VOL      = 2.0;  // V98: lowered from 2.5 -- catch alt divergences on risk_off BTC
const REGIME_OVERRIDE_MIN_MOMENTUM = 0.015; // V98: lowered from 2.0% to 1.5% -- NEAR-style moves qualify

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
  parts.push("💡 Top blocker = priority fix for tomorrow");
  await safeRun("rejectStats", () => sendPrivate(lines(parts)));
}

async function sendEndOfDayReport() {
  // ── V100: End of Day Report ───────────────────────────────────
  // Accurate to the actual session -- pulls real data, not templates.
  // Posted to the CHANNEL (subscribers see it) at 21:00 UK.

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
  parts.push(`⚠️ <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · @baretradesignals</i>`);

  await sendChannel(lines(parts));
  log("📊 End of day report sent");
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
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","AVAXUSDT",
  "LINKUSDT","NEARUSDT","RENDERUSDT","SUIUSDT","TONUSDT",
  "ONDOUSDT","ARBUSDT","OPUSDT","INJUSDT","TIAUSDT",
  "STRKUSDT","JUPUSDT","FETUSDT","EIGENUSDT",
  "XRPUSDT"  // w/e 08-Jun-2026: volume magnet on risk-on rotation
];

const STATIC_STOCK_FALLBACK = [
  // AI infrastructure core
  "NVDA","PLTR","AMD","AVGO","ANET","CRWD","APP",
  // Space & defense -- narrative active w/e 08-Jun-2026
  "ASTS","RKLB","LUNR","ACHR","JOBY","AVAV",
  // Speculative beta
  "IONQ","MSTR","COIN","OKLO","SMR","SOUN",
  // Industrials & power
  "VRT","GEV","ETN","AMAT","QQQ","SMH",
];

// LSE pool updated w/e 08-Jun-2026
// Removed: RPI.L, JD.L (not current momentum leaders), LGEN.L (weakest financials fit)
// Added: VOD.L (high volume telco, institutional flows active)
const LSE_POOL = [
  // Defence & aerospace -- narrative active
  "BA.L","RR.L",
  // Miners -- commodity momentum
  "RIO.L","AAL.L","GLEN.L","FRES.L",
  // Banks -- rate sensitivity, institutional risk-on flows
  "BARC.L","LLOY.L","NWG.L","HSBA.L",
  // Growth/tech adjacent
  "EXPN.L","AUTO.L","SAGE.L",
  // Energy
  "SHEL.L","BP.L",
  // Pharma/consumer
  "AZN.L","ULVR.L",
  // Aviation -- sector flows active
  "IAG.L",
  // Telco -- volume leader this week
  "VOD.L",
];

const CLEAN_TICKER = /^[A-Z]{1,5}$/;
const OTC_SUFFIXES = ["F","Y","PK"];

let STOCK_POOL   = [...new Set(STATIC_STOCK_FALLBACK)];
let CRYPTO_PAIRS = [...STATIC_CRYPTO_FALLBACK];
// V98: INTEL_STOCKS -- stocks flagged as pre-market movers by Finnhub
// These get limit entries at EMA20 during opening window instead of market entries
let INTEL_STOCKS = new Set();
let HOT_SECTORS  = [];

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
function shouldScanUS()           { return ENABLE_US  && isWeekday() && isUSMarketOpen(); }
function shouldScanLSE()          { return ENABLE_LSE && isWeekday() && isLSEMarketOpen(); }
function shouldSendStockAlerts() {
  if (!isWeekday()) return false;
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
  if (market === "US")  return mins >= 870 && mins < 1260;
  if (market === "LSE") return mins >= 480 && mins < 990;
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

// Detects Stage 3 entry: big candle -> consolidation -> continuation
// The most reliable missed entry in the current system
function isFirstPullbackContinuation(candles) {
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
  // V98: regime gate removed -- momentum and volume already filter quality
  // Intel confirms real movers -- BTC/QQQ regime was blocking legitimate signals
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
          watching.push({
            label: `\uD83C\uDDFA\uD83C\uDDF8 <b>${escapeHtml(sym)}</b> \u2014 near EMA, vol building ${volRat.toFixed(1)}x`,
            key: sym,
            priority: volRat
          });
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
          const name    = sym.replace("USDT", "");
          const heatTag = getHeat(sym) >= 60 ? " \uD83D\uDD25" : "";
          watching.push({
            label: `\uD83E\uDE99 <b>${escapeHtml(name)}</b> \u2014 \u26A1 ${(momentum*100).toFixed(2)}% \u00B7 vol ${volRat.toFixed(1)}x${heatTag}`,
            key: name,
            priority: volRat * (1 + momentum * 10)
          });
        }
      } catch { /* skip */ }
    }
  }

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
  parts.push(``, `\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014`, `\u26A0\uFE0F <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · @baretradesignals</i>`);
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

  const isOpeningBell = !isWeekend() && isUSMarketOpen() && getUkMinutes() < 880;
  const parts = [isOpeningBell ? "\uD83D\uDD14\uD83D\uDFE2 <b>OPENING BELL INTEL</b>" : "\uD83E\uDDE0\uD83D\uDD25 <b>MARKET INTEL UPDATE</b>", ""];

  // ── REGIME -- compact one-liners ─────────────────────────────────
  const btcEmoji = btcTrend==="strong_bull" ? "\uD83D\uDFE2\uD83D\uDFE2" : btcTrend==="bull" ? "\uD83D\uDFE2" : btcTrend==="bear" ? "\uD83D\uDD34" : "\uD83D\uDFE1";
  parts.push(`\u20BF <b>BTC: ${btcTrend.replace("_"," ").toUpperCase()}</b> ${btcEmoji}`);

  if (!isWeekend()) {
    const qqqEmoji = qqqTrend==="bull" ? "\uD83D\uDFE2" : qqqTrend==="risk_off" ? "\uD83D\uDD34" : "\uD83D\uDFE1";
    parts.push(`\uD83D\uDCC8 <b>QQQ: ${qqqTrend.replace("_"," ").toUpperCase()}</b> ${qqqEmoji}`);
  }
  parts.push("");

  // ── ACTIVE THEMES ───────────────────────────────────────────────
  if (!isWeekend() && HOT_SECTORS.length > 0) {
    const usSectors = HOT_SECTORS.filter(s => !s.startsWith("UK_"));
    if (usSectors.length > 0) {
      parts.push("<b>Active narratives:</b>");
      for (const s of usSectors) {
        const syms = (SECTOR_SYMBOLS[s]||[]).slice(0,4).join(", ");
        parts.push(`  \uD83D\uDCCC <b>${escapeHtml(s)}</b> \u2192 ${escapeHtml(syms)}`);
      }
      parts.push("");
    }
  }

  // ── HOT STOCKS -- hero of the message ───────────────────────────
  if (!isWeekend() && topMovers.length > 0) {
    const ranked = topMovers.slice(0, 6).map(sym => {
      const pmData   = getPreMarketPrice(sym);
      const pmPct    = pmData ? pmData.changePct : 0;
      const inSector = HOT_SECTORS.some(s => (SECTOR_SYMBOLS[s]||[]).includes(sym));
      const pct      = stockMoverPcts[sym] || 0;
      const strength = Math.abs(pmPct) * 2 + (inSector ? 5 : 0) + Math.abs(pct);
      const structureOk = pct >= 0 || Math.abs(pmPct) >= 3;
      return { sym, pmPct, pct, strength, inSector, structureOk };
    }).sort((a, b) => b.strength - a.strength);

    // V98: heat score -- intel mention adds heat to all flagged stocks
    for (const m of ranked) addHeat(m.sym, 20, "intel");

    parts.push("🇺🇸 <b>Hot stocks right now:</b>");
    for (const m of ranked) {
      const pctStr  = m.pmPct ? `+${m.pmPct.toFixed(1)}%` : m.pct ? `+${m.pct.toFixed(1)}%` : "";
      const movePct = m.pmPct || m.pct || 0;
      const isHot   = getHeat(m.sym) >= HEAT_HOT_THRESHOLD;
      // Heat overrides fire -- one emoji only, never stack
      const badge   = isHot              ? " 🌡️"
                    : movePct >= 8       ? " 🔥"
                    : movePct >= 5       ? " ⚡"
                    : movePct <= -8      ? " 🧊"
                    : movePct <= -5      ? " 🥶"
                    : "";
      const brain   = m.inSector ? " 🧠" : "";
      parts.push(`  🚀 <b>${escapeHtml(m.sym)}</b> ${escapeHtml(pctStr)}${badge}${brain}`);
    }
    const topPick = ranked.find(m => m.structureOk) || ranked[0];
    if (topPick) {
      parts.push(``, `\uD83C\uDFC6 <b>Top pick: ${escapeHtml(topPick.sym)}</b> \u2014 strongest setup heading into session`);
    }
    parts.push("");
  }

  // ── LSE ─────────────────────────────────────────────────────────
  if (!isWeekend() && isLSEMarketOpen() && lseMovers.length > 0) {
    const activeSectors = getLSESectorSummary(lseMovers);
    parts.push("\uD83C\uDDEC\uD83C\uDDE7 <b>FTSE strength building:</b>");
    if (activeSectors.length > 0) parts.push(`  \uD83D\uDCC8 ${activeSectors.join(" \u2022 ")}`);
    for (const m of lseMovers.slice(0,4)) {
      parts.push(`  \uD83D\uDCCA <b>${escapeHtml(m.sym)}</b> +${m.changePct.toFixed(1)}%`);
    }
    parts.push("");
  }

  // ── CRYPTO MOVERS ───────────────────────────────────────────────
  const filteredCryptoMovers = cryptoMovers.filter(c => isApprovedCrypto(c.symbol));
  if (filteredCryptoMovers.length > 0) {
    // V98: heat score -- crypto intel mention adds heat
    for (const c of filteredCryptoMovers) addHeat(c.symbol, 20, "crypto-intel");

    parts.push("\uD83E\uDE99 <b>Elevated momentum detected:</b>");
    for (const c of filteredCryptoMovers) {
      const sym = c.symbol.replace("USDT","");
      // V100: intel shows current price action only -- no heat scoring.
      const tag  = c.changePct >= 15      ? "🔥 explosive move"
                 : c.changePct >= 8       ? "⚡ strong momentum"
                 : c.changePct >= 0       ? "📈 building momentum"
                 : c.changePct <= -15     ? "🧊 sharp drop"
                 : c.changePct <= -8      ? "🥶 selling pressure"
                 : "📉 pulling back";
      parts.push(`  📊 <b>${escapeHtml(sym)}</b> — ${tag}`);
    }
    parts.push("");
  }

  // V98: DexScreener early momentum -- catches DEX moves before CEX
  try {
    const dexMovers = await getDexScreenerMomentum();
    if (dexMovers.length > 0) {
      parts.push("🦎 <b>Early DEX momentum:</b>");
      for (const d of dexMovers.slice(0,3)) {
        const dexEmoji = d.change1h >= 15 ? "🔥" : d.change1h >= 8 ? "⚡" : d.change1h <= -15 ? "🧊" : d.change1h <= -8 ? "🥶" : "📈";
        parts.push(`  ${dexEmoji} <b>${escapeHtml(d.symbol)}</b> ${d.change1h >= 0 ? "+" : ""}${d.change1h.toFixed(1)}%/1h — ${escapeHtml(d.chain)}`);
      }
      parts.push("");
    }
  } catch { /* skip if DexScreener fails */ }

  // ── FOOTER ───────────────────────────────────────────────────────
  parts.push(`\uD83D\uDD0D Scanning ${isWeekend() ? CRYPTO_PAIRS.length+" crypto pairs only" : STOCK_POOL.length+" stocks \u2022 "+CRYPTO_PAIRS.length+" crypto pairs \u2022 "+LSE_POOL.length+" LSE stocks"}`);
  parts.push(`\uD83D\uDCA1 Entry alert fires if setup confirms on next scan`);
  parts.push(``, `\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014`, `\u26A0\uFE0F <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · @baretradesignals</i>`);

  if (parts.length <= 3) return;
  await safeRun("telegramNarrative", () => sendChannel(lines(parts)));
  log(`\uD83E\uDDE0 Intel posted (btc=${btcTrend} qqq=${qqqTrend})`);
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
    CRYPTO_PAIRS = dedup([...STATIC_CRYPTO_FALLBACK, ...trendingCoins]).slice(0, 22);
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
      // V98: track intel stocks for limit entry logic at opening bell
      INTEL_STOCKS = new Set(topMovers);
      log(`🧠 Intel stocks: ${[...INTEL_STOCKS].join(", ")}`);
      const sectorInjected = [];
      for (const sector of HOT_SECTORS) {
        const syms = (SECTOR_SYMBOLS[sector]||[]).filter(isCleanTicker);
        sectorInjected.push(...syms);
      }
      STOCK_POOL = dedup([...trendingStocks, ...topMovers, ...sectorInjected]).slice(0, 25);
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
    `⚠️ <i>Educational market commentary only · Not personalised investment advice · @baretradesignals</i>`,
  ];

  await sendChannel(lines(parts.filter(Boolean)));
  log("📊 Weekly self-audit sent");
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
        // V100: send plain English end of day report to channel
        if (key === "US") await safeRun("eodReport",   sendEndOfDayReport);
        // V100: weekly self-audit every Sunday 21:00 UK
        if (key === "US") await safeRun("weeklyAudit", sendWeeklyAudit);
      }
    }
    marketWasOpen[key] = nowOpen;
  }
}
// ================================================================
// SNIPER V99 -- PART 2 OF 3
// Paste immediately after Part 1.
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
  const yahooInterval = interval==="15min"?"15m":interval==="5min"?"5m":"1h";
  const range         = yahooInterval==="5m"?"2d":yahooInterval==="15m"?"10d":"60d"; // V98: 15m range 2d->10d for more candles
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
  const inOpeningWindow = market === "US" && isUSOpeningWindow();
  const minCandles = inOpeningWindow ? MIN_CANDLES_OPENING : MIN_CANDLES;
  if (!candles || candles.length < minCandles) {
    if (candles) log(`⛔ ${asset} -- not enough candles (${candles.length} < ${minCandles})`);
    return null;
  }

  // V98: verbose checkpoint logging for HIGH_BETA US stocks
  // Tells us exactly where SMCI/ASTS/IONQ die in the pipeline
  const isVerbose = market === "US" && isHighBeta(asset);
  const checkpoint = (label, passed, detail = "") => {
    if (!isVerbose) return;
    const icon = passed ? "✓" : "✗";
    log(`  ${icon} ${asset} [${label}]${detail ? " -- " + detail : ""}`);
  };

  // V96: setupType MUST be declared here -- undeclared = accidental global
  // causes phantom classifications between scan cycles (stale state leak)
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

  // ── Parabolic exhaustion hard block ──────────────────────────
  const pct24h = market === "CRYPTO" ? (get24hrMomentum(asset) || 0) : 0;
  if (isParabolicExhaustion(candles, pct24h, market === "CRYPTO" ? btcTrend : "neutral")) {
    log(`⛔ ${asset} -- parabolic exhaustion blocked`);
    return null;
  }

  // ── Change 1: Momentum decay filter (crypto only) ─────────────
  // Catches PARTI/TON/INJ pattern: big 24h move but rolling over now
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
      reject("momentum_decay", asset, market); return null;
    }

    // ── Change 2: Lower highs distribution filter ────────────────
    // Asset made a big move but is now forming lower highs = distribution
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

  // ── Minimum momentum ─────────────────────────────────────────
  // V100 SOFTENED: only hard-reject if momentum is negative/zero (no long case at all)
  // Below-threshold-but-positive momentum becomes a score penalty, not instant death
  const minMomentum = market === "CRYPTO" ? CRYPTO_15M_MIN_MOMENTUM
                    : (highBeta && inUSOpen) ? 0
                    : inUSOpen              ? 0.003
                    : 0;
  let momentumPenalty = 0;
  const softPenalties = {}; // accumulates named soft penalties throughout analyse()
  if (momentum <= 0) {
    checkpoint("momentum", false, `${(momentum*100).toFixed(2)}% <= 0% -- no long case`);
    if (market !== "LSE") reject("momentum_low", asset, market);
    return null;
  } else if (momentum <= minMomentum) {
    checkpoint("momentum", false, `${(momentum*100).toFixed(2)}% <= ${(minMomentum*100).toFixed(2)}% -- weak, scoring penalty applied`);
    momentumPenalty = 12; // soft penalty -- weak but not dead
  } else {
    checkpoint("momentum", true, `${(momentum*100).toFixed(2)}%`);
  }

  // ── EMA structure ─────────────────────────────────────────────
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
    // V98: relaxed crypto EMA -- price above EMA20 too strict for sideways market
    // Crypto oscillates around EMA20 constantly -- just need EMA20 > EMA50 trending up
    // ema_fail was 2818 blocks -- this was the dominant real bottleneck
    emaOk = ema20 > ema50 && ema20 > ema20Prev;
  } else {
    // US stocks: full structure
    emaOk = ema20 > ema50 && last > ema20 && ema20 > ema20Prev;
  }

  // V96: TREND_RESUMPTION bypasses EMA for HIGH_BETA entirely
  // Gap-day stocks are above EMA20 by definition -- EMA check is wrong filter
  const isTrendResumptionCandidate = highBeta && inUSOpen && isTrendResumption(candles, inUSOpen, highBeta);
  // V100 SOFTENED: EMA structure failure becomes a penalty, not instant death
  // A 95%-perfect setup with slightly imperfect EMA alignment shouldn't be thrown away
  let emaPenalty = 0;
  if (!emaOk && !isTrendResumptionCandidate) {
    checkpoint("EMA", false, `ema20=${ema20.toFixed(2)} ema50=${ema50.toFixed(2)} last=${last.toFixed(2)} -- scoring penalty applied`);
    emaPenalty = 15;
  } else {
    checkpoint("EMA", true);
  }

  // ── Volume ────────────────────────────────────────────────────
  const rawVolumes = volumes.filter(v => v > 0);
  const avgVol   = rawVolumes.length >= 5 ? avg(rawVolumes.slice(-21,-1)) : 0;
  const lastVol  = volumes.at(-1);
  const prevVol  = volumes.at(-2);
  let volRatio;
  if (avgVol > 0 && lastVol > 0) {
    volRatio = lastVol / avgVol;
  } else if (avgVol === 0 && highBeta && inUSOpen) {
    const lastRange  = (highs.at(-1) - lows.at(-1)) / (closes.at(-1) || 1);
    const priorRange = avg(highs.slice(-6,-1).map((h,i) => (h - lows.slice(-6,-1)[i]) / (closes.slice(-6,-1)[i] || 1)));
    volRatio = priorRange > 0 ? lastRange / priorRange : 1.0;
    log(`📊 ${asset} -- no volume data, using range proxy volRatio=${volRatio.toFixed(2)}`);
  } else {
    volRatio = 0;
  }
  if (!Number.isFinite(volRatio) || volRatio < 0) volRatio = 0;

  // V100 SOFTENED: weak volume confirmation becomes a penalty, not instant death
  let volumePenalty = 0;
  if (market === "CRYPTO" && avgVol > 0) {
    const prevVolRatio = prevVol / avgVol;
    const twoCandles   = volRatio >= 1.5 || (volRatio >= 1.2 && prevVolRatio >= 1.1);
    if (!twoCandles) {
      checkpoint("vol_candle", false, `single candle vol=${volRatio.toFixed(2)}x -- scoring penalty applied`);
      volumePenalty += 12;
    }
  }

  // V100 HARDENED->SOFTENED: Rule 5 -- Momentum without participation is a penalty
  // Price rising + volume declining = weaker conviction, not automatic death
  // V100 FIX: only run vol_trend check when prevVol is meaningful (>0).
  // Yahoo/Polygon sometimes returns 0 volume for the penultimate candle (data artifact).
  // 0.00x vol_trend on an artifact incorrectly fires the penalty and blocks MSTR etc.
  if (avgVol > 0 && prevVol > 100 && lastVol > 0 && last > (candles.at(-2)?.close || 0)) {
    const volTrend = lastVol / prevVol;
    if (volTrend < 0.65) {
      checkpoint("vol_trend", false, `price up but volume dropped to ${volTrend.toFixed(2)}x prior -- scoring penalty applied`);
      volumePenalty += 15;
    }
  }

  // ── Extension limit ───────────────────────────────────────────
  const extension = (last - ema20) / ema20;
  let extensionLimit;
  if (market === "CRYPTO") {
    extensionLimit = CRYPTO_15M_EXTENSION_LIMIT;
  } else if (highBeta) {
    // V94: ATR-adjusted extension for HIGH_BETA -- CLSK fix
    // Instead of fixed 20/35%, use ATR units to judge extension
    // A stock that moved 3 ATR units is not over-extended even if % looks high
    const atr = calculateATR(candles, ATR_PERIOD);
    const atrPct = atr && last > 0 ? atr / last : 0;
    const atrUnitsExtended = atrPct > 0 ? extension / atrPct : 99;
    // Allow up to 8 ATR units during opening window, 5 normally
    const atrLimit = inUSOpen ? 8 : 5;
    extensionLimit = atrUnitsExtended <= atrLimit
      ? Math.max(inUSOpen ? EXTENSION_LIMIT_HB_OW : EXTENSION_LIMIT_HB, extension + 0.001) // pass through
      : inUSOpen ? EXTENSION_LIMIT_HB_OW : EXTENSION_LIMIT_HB;

    // Pre-market price boost -- if Finnhub shows big pre-market move,
    // this is a GAP day and extension limits should be wider
    const pmData = getPreMarketPrice(asset);
    if (pmData && Math.abs(pmData.changePct) >= 5 && inUSOpen) {
      extensionLimit = Math.max(extensionLimit, 0.50); // 50% allowed on big gap days
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

  // ── V100 FINAL: MACRO AS SCORE MODIFIER, NOT VETO ────────────
  // Philosophy: Sniper catches exceptions. RKLB up 6% on 3x volume should
  // still fire even if QQQ is neutral. BTC/QQQ act as score modifiers only.
  //
  // BTC bull       = +10  (confirms crypto tailwind)
  // BTC neutral    =   0  (ranging, no help but no block)
  // BTC risk_off   = -15  (headwind, harder to score well)
  // BTC 4h risk_off = -10 additional (multi-day downtrend)
  //
  // QQQ bull + stable = +10
  // QQQ neutral        =   0
  // QQQ risk_off       = -15
  // QQQ unstable (<2)  =  -5

  if (market === "CRYPTO") {
    if (btcTrend === "strong_bull")                           softPenalties.btcRegime = -12; // bonus (negative penalty)
    else if (btcTrend === "bull")                             softPenalties.btcRegime = -10;
    else if (btcTrend === "neutral")                          softPenalties.btcRegime = 0;
    else if (btcTrend === "risk_off")                         softPenalties.btcRegime = 15;
    if (btcMacroTrend === "risk_off")                         softPenalties.btcMacro  = 10;
    checkpoint("regime", true, `btc=${btcTrend} macro=${btcMacroTrend} penalty=${softPenalties.btcRegime||0}`);
  } else {
    if (qqqTrend === "bull" && qqqBullCount >= 2)             softPenalties.qqqRegime = -10; // bonus
    else if (qqqTrend === "bull")                             softPenalties.qqqRegime = -5;
    else if (qqqTrend === "neutral")                          softPenalties.qqqRegime = 5;
    else if (qqqTrend === "risk_off")                         softPenalties.qqqRegime = 15;
    if (qqqBullCount < 2 && qqqTrend !== "risk_off")          softPenalties.qqqStable = 5;
    checkpoint("regime", true, `qqq=${qqqTrend} stable=${qqqBullCount} penalty=${softPenalties.qqqRegime||0}`);
  }

  // ── Breakout / pullback / gap detection ───────────────────────
  const breakoutLevel    = Math.max(...highs.slice(-BREAKOUT_LOOKBACK,-1));
  const breakoutDistance = breakoutLevel > 0 ? (last - breakoutLevel)/breakoutLevel : 0;

  // V99: LEADER MODE -- assets with extreme heat get relaxed breakout distance
  // TON/ONDO pattern: high heat + high volume + big move = leader, not chaser
  // Leaders often don't give perfect textbook pullbacks -- relax distance limit
  const heatScore        = getHeat(asset);
  const isLeader         = heatScore >= HEAT_HOT_THRESHOLD
                        && volRatio >= 3.0
                        && momentum >= 0.05; // 5%+ momentum
  const leaderDistMult   = isLeader ? 1.5 : 1.0; // 50% more room on breakout distance
  if (isLeader) log(`🔥 LEADER MODE: ${asset} heat=${heatScore.toFixed(0)} vol=${volRatio.toFixed(1)}x mom=${(momentum*100).toFixed(1)}%`);

  const breakoutDistLimit = (market==="CRYPTO" ? CRYPTO_15M_BREAKOUT_DIST
                          : highBeta          ? BREAKOUT_DIST_HB
                          : market==="US"     ? BREAKOUT_DIST_US_STD
                          : BREAKOUT_DIST_LSE) * leaderDistMult;

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

  // MOMENTUM_IGNITION -- V96: much stricter
  // Requires genuine 3%+ move on the candle, 2.5x+ volume, BTC must be bull
  // V100: US ignition doesn't need BTC bull -- RKLB/SMR/OKLO move on their own catalysts
  const ignitionMomThreshold = market==="CRYPTO" ? 0.03 : (inUSOpen||highBeta) ? 0.025 : 0.035;
  const ignitionBtcOk = market==="CRYPTO" ? (btcTrend==="bull"||btcTrend==="strong_bull"||btcTrend==="neutral") : true;
  const ignitionSignal = momentum > ignitionMomThreshold && volRatio > 2.5 &&
    ignitionBtcOk &&
    (useMode2 ? true : (last > ema20 && expandingRange)) &&
    (market !== "US" || !inUSOpen || minsIntoSession >= 45 || INTEL_STOCKS.has(asset)); // intel stocks exempt -- get limit entry instead

  // MOMENTUM_BREAKOUT
  const strongMomentumOverride = market==="US" && STOCK_MOMENTUM_OVERRIDE_ENABLED &&
    momentum >= STOCK_OVERRIDE_MIN_MOMENTUM && volRatio >= STOCK_OVERRIDE_MIN_VOL &&
    breakoutDistance <= STOCK_OVERRIDE_MAX_DISTANCE;

  // BREAKOUT_CONTINUATION
  // LSE: allow 0.3% tolerance below high -- UK stocks stall just under resistance before continuing
  const breakoutThreshold = market === "LSE" ? breakoutLevel * 0.997 : breakoutLevel;

  // V98: TIERED OPENING WINDOW -- different setups suit different times
  // Opening bell is brutal -- stop hunts, wide spreads, fake breakouts
  // GAP_CONTINUATION + MOMENTUM_IGNITION: allow immediately -- news/catalyst driven, direction clear
  // BREAKOUT_CONTINUATION: wait 15 mins -- need confirmation above resistance
  // PULLBACK_CONTINUATION: wait 30 mins -- needs settled trend, most vulnerable to stop hunts
  const ukMinsNow = getUkMinutes();
  const minsIntoSession = ukMinsNow - 870; // 870 = 14:30 UK

  const breakoutSignal = last >= breakoutThreshold &&
    breakoutDistance <= breakoutDistLimit &&
    volRatio >= breakoutVolNeeded &&
    momentum >= (market==="US" ? MIN_US_MOMENTUM : market==="LSE" ? MIN_LSE_MOMENTUM : 0) &&
    (market !== "US" || !inUSOpen || minsIntoSession >= 45 || INTEL_STOCKS.has(asset));

  // PULLBACK_CONTINUATION
  const nearEMAThreshold   = market==="US" ? 0.02 : 0.025;
  const nearEMA20          = Math.abs(last - ema20)/ema20 <= nearEMAThreshold;
  const pulledBackRecently = closes.slice(-6,-1).some(c => c <= ema20*1.01);

  // V96: require genuine dip of 1%+ from recent high before pullback fires
  // Prevents firing when price just consolidates sideways near EMA without real pullback
  const recentHigh     = Math.max(...highs.slice(-8));
  const dipFromHigh    = recentHigh > 0 ? (recentHigh - last) / recentHigh : 0;
  const genuineDip     = market === "CRYPTO" ? dipFromHigh >= 0.01 : true; // 1% dip required for crypto

  const pullbackSignal = nearEMA20 && pulledBackRecently && volRatio >= pullbackVolNeeded && genuineDip
    && (market !== "US" || !inUSOpen || minsIntoSession >= 45 || INTEL_STOCKS.has(asset));

  // First pullback continuation (Stage 3) -- Mode 2
  const firstPullbackCont = useMode2 && isFirstPullbackContinuation(candles) && volRatio >= 1.2;

  // Change 4: PRE_BREAKOUT_EXPANSION -- catches active expansion before confirmation
  // Enters during real-time momentum acceleration, not after it's obvious
  // GUARD: only fires when BTC is genuinely bull (no regime override) AND atrUnits <= 5
  // INJ lesson: regime override + high atrUnits = buying exhaustion not expansion
  const pbeATRUnits = getMoveInATRUnits(pct24h, candles);
  const preBreakoutExpansion = market === "CRYPTO" &&
    momentum > 0.012 &&
    volRatio > 1.8 &&
    last > ema20 &&
    breakoutDistance > -0.01 &&
    breakoutDistance < 0.015 &&
    getMoveMaturity(candles) === "expansion" &&
    regimePass(market) &&        // must have genuine bull BTC -- no regime override
    pbeATRUnits <= 5;            // move must not already be extended

  // V95: TREND_RESUMPTION -- gap-day continuation for HIGH_BETA stocks
  const trendResumption = isTrendResumption(candles, inUSOpen, highBeta) && volRatio >= 1.1;

  // V100: BROAD_MOMENTUM -- catches assets running with a genuinely broad crypto market
  // INJ/JUP pattern: 12/12 green breadth, asset trending above EMA20, real momentum
  // but no textbook pullback/breakout structure. Market is the setup.
  // Guards: breadth must be strong (>=10/12 green), momentum genuine, not extended
  const cryptoBreadthCount = (global.lastCryptoBreadthCount || 0);
  const broadMomentum = market === "CRYPTO" &&
    cryptoBreadthCount >= 10 &&
    momentum > 0.005 &&
    last > ema20 &&
    volRatio >= 1.0 &&
    pbeATRUnits <= 6;

  if (gapContinuationSignal)                              setupType = "GAP_CONTINUATION";
  else if (trendResumption)                               setupType = "TREND_RESUMPTION";
  else if (ignitionSignal)                                setupType = "MOMENTUM_IGNITION";
  else if (preBreakoutExpansion && !ignitionSignal)       setupType = "PRE_BREAKOUT_EXPANSION";
  else if (strongMomentumOverride && !ignitionSignal)     setupType = "MOMENTUM_BREAKOUT";
  else if (firstPullbackCont && !breakoutSignal)          setupType = "PULLBACK_CONTINUATION";
  else if (pullbackSignal && !breakoutSignal)             setupType = "PULLBACK_CONTINUATION";
  else if (breakoutSignal)                                setupType = "BREAKOUT_CONTINUATION";
  else if (broadMomentum)                                 setupType = "BROAD_MOMENTUM";

  // V96: null guard -- if no setup resolved, return null cleanly
  if (!setupType) {
    if (market === "US" && isHighBeta(asset)) {
      log(`  ✗ ${asset} [setup] | break=${breakoutSignal} pull=${pullbackSignal} ign=${ignitionSignal} tr=${trendResumption} gap=${gapContinuationSignal} | vol=${volRatio.toFixed(2)}x breakDist=${(breakoutDistance*100).toFixed(2)}% nearEMA=${nearEMA20}`);
    }
    checkpoint("setup", false, "no pattern detected");
    reject("no_setup", asset, market); return null;
  }
  checkpoint("setup", true, setupType);

  // V98: LATE BREAKOUT GUARD -- block exhausted moves not genuine runners
  // Only block if 24hr > 10% (not 8%) AND candle momentum very weak < 0.8%
  // TON had 0.53% candle momentum -- genuine runners have 1%+ on the candle
  if (setupType === "BREAKOUT_CONTINUATION" && market === "CRYPTO") {
    if (pct24h >= 0.10 && momentum < 0.008) {
      reject("late_breakout", asset, market); return null;
    }
  }

  // Without BTC bull, pullback entries have no trend to continue into
  const btcNotBull = market === "CRYPTO" && btcTrend !== "bull" && btcTrend !== "strong_bull";
  if (btcNotBull && setupType === "PULLBACK_CONTINUATION") {
    reject("pullback_neutral_btc", asset, market); return null;
  }

  // Pullback momentum minimum
  const minPullbackMom = market==="CRYPTO" ? CRYPTO_15M_MIN_PULLBACK
                       : market==="US"     ? MIN_PULLBACK_MOM_US
                       : MIN_PULLBACK_MOM_LSE;
  if (setupType==="PULLBACK_CONTINUATION" && momentum < minPullbackMom) return null;

  // ── Momentum cap ─────────────────────────────────────────────
  const momentumCap = setupType==="MOMENTUM_IGNITION"||setupType==="GAP_CONTINUATION" ? 0.25
                    : setupType==="PRE_BREAKOUT_EXPANSION" ? 0.04  // tight cap -- must be early
                    : market==="CRYPTO"  ? CRYPTO_15M_MAX_MOMENTUM
                    : highBeta           ? (inUSOpen ? MOMENTUM_CAP_HB_OW : MOMENTUM_CAP_HB)
                    : inUSOpen           ? 0.15
                    : market==="US"      ? MOMENTUM_CAP_US_STD
                    : MOMENTUM_CAP_LSE;

  if (momentum > momentumCap) {
    log(`BLOCKED ${asset} | reason=momentumCap | momentum=${(momentum*100).toFixed(2)}% cap=${(momentumCap*100).toFixed(2)}% setup=${setupType}`);
    return null;
  }

  // ── Entry and stops ───────────────────────────────────────────
  // V94: Conditional buy during BTC bull -- entry set ABOVE current price
  // Price must break higher through the trigger to fill
  // If price drops away → no fill, no loss (better than limit mid-dump)
  // If price keeps running → fills on confirmed momentum ✅
  // Neutral BTC → standard limit below price waiting for pullback
  const isBtcBull = btcTrend === "bull" || btcTrend === "strong_bull";
  // V95: conditional buy fires when BTC bull OR strong individual momentum (vol >= 1.8x)
  // INJ lesson: BTC neutral but 2x volume + 2.4% momentum = should be conditional not limit
  const useConditional = market === "CRYPTO" && (isBtcBull || volRatio >= 1.8);

  // V98: INTEL LIMIT ENTRY -- stocks flagged in pre-market intel get limit entry at EMA20
  // during opening window. Catches the pullback after the opening spike.
  // Pattern: bell rings → spike → pullback to EMA → real move
  // AVAV +5%, MRNA +4%, LUNR/ASTS/RKLB all pulled back to EMA after open
  const isIntelStock  = market === "US" && INTEL_STOCKS.has(asset);
  const useIntelLimit = isIntelStock && inUSOpen && minsIntoSession < 45;

  const entryType = useIntelLimit
    ? "LIMIT BUY"
    : setupType === "PULLBACK_CONTINUATION"
      ? (useConditional ? "CONDITIONAL BUY" : "LIMIT BUY")
      : "MARKET BUY";

  // V98: DYNAMIC INTEL LIMIT ENTRY
  // ChatGPT/Perplexity both validated: limit = EMA20 + 30% of gap to price
  // This adapts automatically -- ASTS gap 1.8% gets different entry than AVAV gap 0.5%
  // Fixed multiplier (1.003) was too blunt -- too close on small gaps, too far on large ones
  // Extension guard: if price still 8%+ above EMA, hasn't pulled back yet -- use market
  const gapToEMA    = Math.max(0, last - ema20);
  const intelEntry  = ema20 + (gapToEMA * 0.30); // 30% retrace of the gap
  const tooExtended = last > ema20 * 1.08;

  const entry = useIntelLimit && !tooExtended
    ? intelEntry
    : useIntelLimit && tooExtended
      ? last
      : setupType === "PULLBACK_CONTINUATION"
        ? (useConditional ? last * 1.005 : ema20 * 1.008)
        : last;

  const atr = calculateATR(candles, ATR_PERIOD);
  if (!atr || atr <= 0) return null;

  const swingLow = Math.min(...lows.slice(-6));
  const atrMult  = setupType==="PULLBACK_CONTINUATION" ? ATR_PULLBACK_MULTIPLIER
                 : (setupType==="MOMENTUM_IGNITION"||setupType==="GAP_CONTINUATION") ? ATR_IGNITION_MULTIPLIER
                 : ATR_BREAKOUT_MULTIPLIER;

  // V98: tiered ATR multiplier for opening window
  // First 30 mins: 1.8x -- opening bell noise, stop hunts, wide wicks
  // After 30 mins: 1.5x -- market settling, tighter but still generous
  // Rest of session: 1.0x (standard)
  const openingMult = (market === "US" && highBeta && inUSOpen)
    ? (minsIntoSession < 30 ? 1.8 : 1.5)
    : 1.0;
  const finalAtrMult = atrMult * openingMult;

  // GAP_CONTINUATION: SL below gap candle low for tighter stop
  let sl;
  if (setupType === "GAP_CONTINUATION") {
    const gapCandleLow = Math.min(...lows.slice(-6));
    sl = gapCandleLow - atr * 0.5;
  } else {
    sl = Math.min(swingLow - atr*finalAtrMult, entry - atr*finalAtrMult);
  }

  if (!Number.isFinite(sl) || sl >= entry) return null;

  const riskAmt = entry - sl;
  const riskPct = riskAmt / entry;
  // V99.1: tightened US stock risk caps -- wide SL was pushing TP unrealistically far
  // Standard US: max 4% risk → TP ~7% at 1.8 R:R (achievable in 1-3 days)
  // HIGH_BETA US: max 6% risk → TP ~11% (volatile names need room but not 15%)
  // Crypto: 8% cap unchanged -- BTC moves require breathing room
  const maxRisk = market === "CRYPTO" ? 0.08
                : (market === "US" && highBeta) ? 0.06
                : market === "US" ? 0.04
                : 0.06; // LSE
  if (riskPct <= 0 || riskPct > maxRisk) { reject("risk_pct", asset, market); return null; }

  const tpRaw = entry + riskAmt * TARGET_R;
  // V99.1: TP caps -- realistic targets per market
  // US standard: max 8% (achievable in 2-3 days on trend)
  // US HIGH_BETA: max 12% (volatile runners can get there)
  // Crypto BTC bull: max 10%, neutral: max 5%
  const usTpCap = highBeta ? 1.12 : 1.08;
  const cryptoTpCap = (btcTrend === "bull" || btcTrend === "strong_bull") ? 1.10 : 1.05;
  const tp = market === "CRYPTO" ? Math.min(tpRaw, entry * cryptoTpCap)
           : market === "US"     ? Math.min(tpRaw, entry * usTpCap)
           : tpRaw;
  const rr = +((((tp - entry)/entry)/riskPct).toFixed(1));
  // V100: crypto gets a slightly lower RR floor -- momentum trades in a broad bull
  // (12/12 green breadth) often have elevated ATR which mechanically compresses R:R
  // even when the trade is genuinely good. US keeps 2.0 minimum.
  const minRRforMarket = market === "CRYPTO" ? 1.7 : MIN_RR;
  if (rr < minRRforMarket) { reject("rr_too_low", asset, market); return null; }

  // V98: EXPANSION FILTER -- AMD scored 130 but went nowhere
  // Perfect setup in a dead stock is still a dead trade
  // Reject if: target distance < 1.5 ATR OR room to resistance < 1 ATR
  // This filters low-volatility sideways conditions that produce high scores but no movement
  const targetDistance = tp - entry;
  const resistanceRoom = breakoutLevel > entry ? breakoutLevel - entry : atr * 2;
  if (targetDistance < atr * 1.5) {
    checkpoint("expansion", false, `target ${targetDistance.toFixed(4)} < 1.5 ATR ${(atr*1.5).toFixed(4)}`);
    reject("no_expansion", asset, market); return null;
  }
  if (resistanceRoom < atr * 1.0 && setupType !== "BREAKOUT_CONTINUATION") {
    checkpoint("expansion", false, `resistance too close ${resistanceRoom.toFixed(4)} < 1 ATR ${atr.toFixed(4)}`);
    reject("no_expansion", asset, market); return null;
  }
  checkpoint("expansion", true, `target=${targetDistance.toFixed(4)} room=${resistanceRoom.toFixed(4)} atr=${atr.toFixed(4)}`);

  // V100 SOFTENED: low heat becomes a conviction penalty, not instant death
  // An asset with a genuinely great setup but no prior watchlist mention
  // shouldn't be thrown away -- it just scores lower on conviction
  let heatPenalty = 0;
  if (market === "CRYPTO") {
    const heatScore = getHeat(asset);
    if (heatScore < MIN_HEAT_FOR_CRYPTO) {
      checkpoint("heat", false, `heat=${heatScore.toFixed(0)} < min ${MIN_HEAT_FOR_CRYPTO} -- scoring penalty applied`);
      heatPenalty = 10;
    } else {
      checkpoint("heat", true, `heat=${heatScore.toFixed(0)}`);
    }
  }

  // ── Scoring ───────────────────────────────────────────────────
  let score = 50;

  // V100 SOFTENED: apply accumulated penalties from soft filters above
  // Philosophy: degrade confidence, don't kill the trade. Let Hunter Score decide.
  // V100 P3: HOT ASSET IN EXPANSION BYPASS
  // If heat > 120 AND move maturity = expansion, waive all soft penalties.
  // Philosophy: a genuinely hot asset actively expanding is exactly what we want.
  // Don't let minor EMA structure or volume declining penalties kill it.
  const isHotExpansion = getHeat(asset) > 120 && getMoveMaturity(candles) === "expansion";
  if (isHotExpansion) {
    log(`🔥 HOT EXPANSION BYPASS: ${asset} heat=${getHeat(asset).toFixed(0)} -- soft penalties waived`);
  }

  const totalSoftPenalty = isHotExpansion ? 0
    : (momentumPenalty||0) + (emaPenalty||0) + (volumePenalty||0) + (heatPenalty||0)
    + (softPenalties.btcNeutral||0) + (softPenalties.btcRegime||0) + (softPenalties.btcMacro||0)
    + (softPenalties.qqqRegime||0) + (softPenalties.qqqStable||0);
  if (totalSoftPenalty > 0) {
    score -= totalSoftPenalty;
    log(`📉 ${asset} soft penalties: momentum=${momentumPenalty||0} ema=${emaPenalty||0} volume=${volumePenalty||0} heat=${heatPenalty||0} total=-${totalSoftPenalty}`);
  }

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

  // Setup type
  if (setupType==="BREAKOUT_CONTINUATION")   score += 10;
  if (setupType==="PULLBACK_CONTINUATION")   score += 8;
  if (setupType==="MOMENTUM_BREAKOUT")       score += 14;
  if (setupType==="MOMENTUM_IGNITION")       score += 22; // V100: raised from 18 -- early ignition deserves more credit
  // V100 FIX 4: Early Ignition bonus -- 3x+ volume on ignition is RKLB/SMR/OKLO day-1 pattern
  // Score it harder so it clears the elite threshold before the move is over
  if (setupType==="MOMENTUM_IGNITION" && volRatio >= 3.0) score += 8;
  if (setupType==="GAP_CONTINUATION")        score += 16;
  if (setupType==="PRE_BREAKOUT_EXPANSION")  score += 13;
  if (setupType==="TREND_RESUMPTION")        score += 15; // gap-day continuation -- high quality

  // Market
  if (market==="CRYPTO") score += 5;
  if (market==="US")     score += 4;
  if (market==="LSE")    score += 2;

  // V98: HEAT SCORE BONUS -- assets with repeated intel/watchlist mentions get score boost
  // TON on watchlist + intel all day = genuine momentum building
  // Heat decays over 8 hours so stale mentions don't count
  const heatScoreForScoring = getHeat(asset);
  if (heatScoreForScoring >= HEAT_HOT_THRESHOLD) {
    const heatBonus = Math.min(15, Math.floor(heatScoreForScoring / 10));
    score += heatBonus;
    log(`🔥 HEAT BONUS: ${asset} +${heatBonus} (heat=${heatScoreForScoring.toFixed(0)})`);
  }
  // V99: LEADER MODE bonus -- extreme heat + exceptional volume + strong move
  if (isLeader) {
    score += 10;
    log(`🔥 LEADER BONUS: ${asset} +10`);
  }

  // V98: REGIME AS SCORE MODIFIER -- not a hard blocker
  // Risk-on = bonus, neutral = no change, risk-off = penalty
  // Strong signal still fires in risk-off, weak signal gets filtered naturally
  if (market === "CRYPTO") {
    // V100: regime handled via softPenalties.btcRegime/qqqRegime above
    // Negative penalty = score bonus (bull), positive = score reduction (bear)
    // No duplicate scoring here
  }
  if (market === "US") {
    // V100: QQQ regime handled via softPenalties.qqqRegime above
  }

  // Quality
  if (breakoutDistance>0 && breakoutDistance<=0.01) score += 4;
  if (expandingRange) score += 4;
  if (gapped)         score += 6; // gap adds quality for Mode 2

  // Narrative
  score += getNarrativeBonus(asset);

  // V90: MATURITY-AWARE BONUS -- replaces 24hr raw boost
  // Rewards early stage, penalises exhaustion
  score += getMomentumMaturityBonus(candles, pct24h, asset);

  // V98: use pre-fetched QQQ from scan cycle -- no per-asset await
  if (market === "US" && highBeta) {
    const qqqMom = prefetchedQqqMom !== null ? prefetchedQqqMom : await getQQQMomentum();
    const rsBonus = getRelativeStrengthBonus(momentum, qqqMom);
    if (rsBonus !== 0) log(`📊 ${asset} RS bonus=${rsBonus} (stock=${(momentum*100).toFixed(2)}% QQQ=${(qqqMom*100).toFixed(2)}%)`);
    score += rsBonus;
  }

  // V94: MOMENTUM PERSISTENCE -- higher lows = institutional accumulation
  score += getMomentumPersistenceBonus(candles);

  // V95: INTEL MOVERS BONUS -- stock already flagged in morning intel = confirmed
  // If Finnhub already identified this as a top mover, boost the score
  if (market === "US" && highBeta) {
    const pmData = getPreMarketPrice(asset);
    if (pmData && Math.abs(pmData.changePct) >= 3) {
      score += 6; // already in intel = confirmation
      log(`📡 ${asset} intel confirmed bonus +6`);
    }
  }

  let grade = "B";
  if (score >= 100) grade = "A*";
  else if (score >= 90) grade = "A";

  // V100 P1: crypto grade gate aligned with MIN_CRYPTO_SCORE=88
  // A grade starts at 90, so score>=88 can be B+ which should still pass
  // Only hard-block genuine B grades (score < 88) -- let the score floor do the work
  const cryptoGradeOk = market !== "CRYPTO" || score >= MIN_CRYPTO_SCORE;

  const scoreFloor = minScoreForMarket(market, asset);
  if (score < MIN_GLOBAL_SCORE || score < scoreFloor || grade === "B" || !cryptoGradeOk) {
    if (!cryptoGradeOk) {
      checkpoint("score", false, `${score} -- crypto requires A* (100+), got A`);
      reject("crypto_grade_a_suppressed", asset, market);
    } else if (grade === "B") {
      checkpoint("score", false, `${score} -- B grade suppressed`);
      reject("score_floor", asset, market);
    } else {
      checkpoint("score", false, `${score} < floor ${scoreFloor}`);
      reject("score_floor", asset, market);
    }
    return null;
  }
  checkpoint("score", true, `${score} >= floor ${scoreFloor} grade=${grade}`);

  // EMA distance
  const emaDistPct = ema20 > 0 ? ((last - ema20) / ema20) * 100 : 0;

  // ── EXECUTION ENGINE (V100) ───────────────────────────────────
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

  // ── V100: HUNTER SCORE (multiplicative model) ───────────────
  // Four components 0-100. Multiplicative so one weak component drags all.
  // Relative ranking beats hardcoded thresholds -- best setup on a quiet day scores 91 and fires.
  //
  // Components:
  //   Confidence  = setup quality (score normalized)
  //   Execution   = how clean the entry window is
  //   Edge        = R:R quality
  //   Conviction  = macro + heat + volume alignment
  //
  // V100 FIX: floor confidence so stacked soft penalties can degrade the score
  // without zeroing out the ENTIRE multiplicative Hunter Score. A setup that's
  // weak on momentum+EMA+volume+heat should score low, not literally zero --
  // that's the same all-filters-stack problem, just moved into scoring instead
  // of hard rejects. Floor of 5 ensures the other 3 components (exec/edge/conviction)
  // can still differentiate a "bad but survivable" setup from "no setup at all".
  const confidenceScore = Math.max(5, Math.min(100, Math.round((score / 130) * 100)));
  const edgeScore       = rr >= 3.0 ? 100 : rr >= 2.5 ? 90 : rr >= 2.0 ? 80 : rr >= 1.8 ? 65 : 40;

  // Conviction: regime + heat + volume -- all must align for full conviction
  const regimeOk     = market==="CRYPTO" ? (btcTrend==="bull"||btcTrend==="strong_bull") && btcMacroTrend!=="risk_off"
                     : market==="US"     ? (qqqTrend==="bull"||qqqTrend==="strong_bull") && qqqBullCount >= 2
                     : true;
  const heatPts      = Math.min(30, Math.round(getHeat(asset) / 4));
  const regimePts    = regimeOk ? 40 : 10;
  const volPts       = volRatio >= 2.0 ? 30 : volRatio >= 1.5 ? 20 : 10;
  const convictionScore = Math.min(100, regimePts + heatPts + volPts);

  // Multiplicative: weak component drags whole score -- all four must be strong
  const hunterRaw   = (confidenceScore/100) * (execQuality/100) * (edgeScore/100) * (convictionScore/100);
  const hunterScore = Math.round(hunterRaw * 100);
  log(`🎯 HUNTER ${asset}: confidence=${confidenceScore} exec=${execQuality} edge=${edgeScore} conviction=${convictionScore} → HUNTER=${hunterScore}`);
  log(`⚡ EXEC ${asset}: order=${execOrderType} execQ=${execQuality} setup=${score} combined=${combinedScore}`);

  // V100 SOFTENED: removed hard execQuality < 75 reject -- this was double-jeopardy.
  // execQuality already feeds multiplicatively into Hunter Score above, so poor
  // execution already crushes the final score (e.g. execQ=50 halves Hunter Score).
  // The dynamic elite threshold in pickTopSignals does the real filtering.
  if (execQuality < 40) {
    // Only reject truly broken execution windows (can't even place a sane order)
    reject("poor_execution_severe", asset, market); return null;
  }

  log(`✅ ${asset} ${market} ${setupType} score=${score} grade=${grade} execQ=${execQuality} hunter=${hunterScore}`);

  return {
    asset, market, grade, setupType, status:"CONFIRMED",
    entryType, entry, sl, tp, rr, score, momentum, volRatio,
    breakoutDistance, atr, gapPct, emaDistPct, isLeader,
    regime: market==="CRYPTO" ? btcTrend : market==="US" ? qqqTrend : "LSE_LOCAL",
    execOrderType, execEntryNote, execChaseLimit, execCancelCond, execQuality, hunterScore, convictionScore, combinedScore: hunterScore
  };
}

// ================================================================
// SNIPER V99 -- PART 3 OF 3
// Paste immediately after Part 2. This completes the file.
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
    `📸 <i>Analysis by @baretradesignals</i>`
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
    parts.push(``, `\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014`, `\u26A0\uFE0F <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell</i>`, `\uD83D\uDCF8 <i>Analysis by @baretradesignals</i>`);
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
      "\uD83D\uDCDA <i>Educational market commentary only \u00B7 @baretradesignals</i>"
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
      if (livePrice<=trade.sl) { await closeTrade(trades,trade,livePrice,"STOP LOSS");   continue; }
      if (livePrice>=trade.tp) { await closeTrade(trades,trade,livePrice,"TAKE PROFIT"); continue; }
      if (shouldForceClose(trade,livePrice)) { await closeTrade(trades,trade,livePrice,"FORCE CLOSE"); continue; }
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
      log(`🚫 Crypto breadth very weak -- ${greenPairs}/${checkedPairs} green -- skipping crypto scan`);
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

    await safeRun(`signal${signal.asset}`, () => sendChannel(buildSignalMessage(signal, size)));
    lastSignalTime = Date.now();
    // V98: signal firing adds heat -- confirms momentum is real
    addHeat(signal.asset, 30, "signal-fired");

    // Phase 2 evidence logging -- track everything needed for later statistical analysis
    // Do NOT act on this yet. Collect 20-50 signals then look for patterns.
    log(`📋 SIGNAL LOG | ${signal.asset} | setup=${signal.setupType} | btc=${btcTrend} | vol=${signal.volRatio?.toFixed(2)}x | mom=${((signal.momentum||0)*100).toFixed(2)}% | score=${signal.score} | emaDistPct=${signal.emaDistPct?.toFixed(2)||'?'}%`);

    alerts.push({ id:alertId, asset:signal.asset, market:signal.market, sentAt });
    trades.push({
      id:`${signal.asset}-${Date.now()}`, asset:signal.asset, market:signal.market,
      setupType:signal.setupType, entryType:signal.entryType,
      entry:signal.entry, sl:signal.sl, tp:signal.tp,
      rrPlanned:signal.rr, score:signal.score, volRatio:signal.volRatio,
      momentum:signal.momentum, regime:signal.regime,
      sentAt, status:"PENDING", outcome:"OPEN", sentToChannel:true,
      fillPrice:null, closePrice:null, closedAt:null, filledAt:null,
      maePct:0, mfePct:0, realizedR:null, riskFraction
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
        `⚠️ Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · @baretradesignals`,
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
      lines2.push(`⚠️ <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · @baretradesignals</i>`);
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
        `⚠️ <i>Educational market commentary only · Not personalised investment advice · Not a recommendation to buy or sell · @baretradesignals</i>`,
      ])));
    }
    await safeRun("morningBriefing",  sendMorningBriefing);
    await safeRun("preMarket",        sendPreMarketAlert);
    await safeRun("marketAlerts",     checkMarketAlerts);
    await safeRun("dynamicInjection", injectHotCryptoMovers);
    await safeRun("sniperRoster",     updateSniperRoster);  // V100: promote/demote sniper assets
    await safeRun("manageTrades",     manageTrades);
    await safeRun("hourlyRejects",    sendHourlyRejectSummary);
    const signals = await withTimeout(safeRun("scan", scan), SCAN_TIMEOUT_MS, "scan");
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
  // BEAR (macro protecting): 5 min cycles -- no point hammering 77 assets when nothing qualifies
  // BULL: 60s cycles -- momentum needs speed
  const interval = getScanInterval();
  const wait     = elapsed >= interval ? 1000 : interval - elapsed;
  if (interval === SCAN_INTERVAL_BEAR_MS) {
    log(`🐻 BEAR regime -- next scan in 5 mins (API conservation mode)`);
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
