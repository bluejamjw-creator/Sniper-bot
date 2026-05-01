// ================================================================
// SNIPER V66 PRODUCTION
// INSTITUTIONAL MOMENTUM CONTINUATION ENGINE
// CRYPTO + US STOCKS + LSE
// V60   = ANTI-CHASE UPGRADED
// V60.1 = SPLIT VOLUME REQUIREMENTS
// V61   = SETUP-AWARE ENTRY LOGIC
// V62   = STRUCTURAL UPGRADES (1h stocks, split vol, tiered crypto)
// V63   = SIGNAL FLOW UPGRADES (reclaim, vol, lookback, intervals)
// V64   = CONTINUATION ENGINE + 4 SETUP TYPES
// V65   = DIAGNOSTIC LOGGING + FILTER OPTIMISATION
// V66   = OUTCOME TRACKING + WEEKLY PERFORMANCE REPORT
//   - alerts.json saves entry/sl/tp/rr/setupType per signal
//   - checkOutcomes() polls price every 15 min → TP/SL Telegram alerts
//   - weekly performance report every Monday 07:00 UTC
//   - watchlist additions: APP, MSTR, COIN, INDA
// ================================================================

console.log("🚀 SNIPER V66 PRODUCTION STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// ================================================================
// CONFIG
// ================================================================

const PORT =
  process.env.PORT || 3000;

const BOT_TOKEN =
  process.env.BOT_TOKEN || "";

const CHAT_ID =
  process.env.CHAT_ID || "";

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const FILES = {

  alerts:
    path.join(
      DATA_DIR,
      "alerts.json"
    ),

  trades:
    path.join(
      DATA_DIR,
      "trades.json"
    )

};

// ================================================================
// V60 SETTINGS
// ================================================================

const MAX_SIGNALS = 12;  // V63: increased from 8

const CRYPTO_COOLDOWN = 3;
const STOCK_COOLDOWN = 4;

const MAX_MOMENTUM = 0.15;

const BREAKOUT_THRESHOLD = 0.002;

const CRYPTO_VOL_RATIO_BULL = 1.05;
const CRYPTO_VOL_RATIO_NEUTRAL = 1.12;

const STOCK_MIN_VOL_RATIO = 0.85;  // V65: loosened for diagnostics — 1h Yahoo vol can be inconsistent

const MIN_RR = 1.5;

// ================================================================
// PARABOLIC
// ================================================================

const PARABOLIC_MIN_VOL = 2.0;
const PARABOLIC_MIN_MOMENTUM = 0.03;

// ================================================================
// V62 ANTI-CHASE + ENTRY SETTINGS
// ================================================================

// V65: market-aware extension limit
// Crypto naturally runs 10-14% above EMA20 in strong trends
// Stocks are tighter — 9% still appropriate
const EXTENSION_HARD_LIMIT_CRYPTO = 0.14;
const EXTENSION_HARD_LIMIT_STOCK  = 0.09;

// V62: SPLIT VOLUME REQUIREMENTS BY ASSET CLASS
// Crypto bursts harder — needs more confirmation
// Stocks on 1h candles — lower natural volume spikes
const CRYPTO_BREAKOUT_VOL = 1.20;
const CRYPTO_RECLAIM_VOL  = 1.05;
const STOCK_BREAKOUT_VOL  = 1.03;  // V63: loosened from 1.10 — mega-caps grind slowly
const STOCK_RECLAIM_VOL   = 1.00;  // unchanged — reclaims already permissive

// recentRun momentum threshold — blocks late impulsive entries
const RECENT_RUN_MOMENTUM = 0.025;

// ================================================================
// ENABLES
// ================================================================

const ENABLE_CRYPTO = true;
const ENABLE_US = true;
const ENABLE_LSE = true;

// ================================================================
// CRYPTO WATCHLIST — TIERED
// ================================================================

const CRYPTO_PAIRS = [

  // TIER 1 — CORE LIQUID TREND
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "LINKUSDT",
  "XRPUSDT",    // V64: added — high liquidity, institutional interest

  // TIER 2 — HIGH-BETA MOMENTUM
  "DOGEUSDT",
  "SUIUSDT",
  "TIAUSDT",
  "AVAXUSDT",
  "INJUSDT",
  "JUPUSDT",
  "STXUSDT",
  "POLUSDT",    // V64: added — Polygon, L2 narrative

  // TIER 3 — NARRATIVE / AI INFRASTRUCTURE
  "FETUSDT",
  "TAOUSDT",
  "RENDERUSDT",
  "NEARUSDT",
  "ONDOUSDT",
  "LDOUSDT"     // V64: added — Lido, liquid staking narrative

];

// ================================================================
// ================================================================
// ================================================================
// US STOCKS — ELITE TREND NAMES
// ================================================================

const STOCK_POOL = [

  // AI SEMICONDUCTORS — core engine
  "NVDA",
  "AVGO",
  "AMD",
  "MU",
  "TSM",
  "ASML",
  "QCOM",
  "TSEM",   // defense-grade SiGe, DoD domestic supplier
  "MRVL",   // AI networking silicon
  "ARM",    // CPU architecture royalties, AI edge
  "CRDO",   // V64: Credo Technology — high-speed connectivity, AI infra
  "ALAB",   // V64: Astera Labs — PCIe/optical connectivity, AI servers

  // AI NETWORKING + INFRASTRUCTURE
  "ANET",   // hyperscaler networking
  "SMCI",   // AI server infrastructure
  "CLS",    // V64: Celestica — AI server manufacturing momentum
  "EQIX",   // V64: Equinix — data centre REIT, AI infrastructure anchor

  // AI SOFTWARE + PLATFORMS
  "PLTR",
  "CRWD",
  "SNOW",
  "NET",

  // MEGA-CAP MOMENTUM
  "MSFT",
  "AMZN",
  "META",
  "GOOGL",
  "AAPL",

  // AI POWER + GRID INFRASTRUCTURE
  "GEV",
  "VST",
  "CCJ",
  "NEE",
  "ETN",
  "VRT",
  "CEG",

  // DEFENSE
  "GD",
  "HII",
  "LMT",
  "NOC",

  // FINANCIALS
  "JPM",
  "GS",

  // V66: NEW ADDITIONS
  "APP",    // AppLovin — strongest momentum AI advertising platform
  "MSTR",   // MicroStrategy — leveraged BTC proxy, high momentum
  "COIN",   // Coinbase — crypto sentiment stock
  "INDA",   // iShares India ETF — emerging market momentum

  // HEALTHCARE MOMENTUM
  "LLY",
  "NVO",

  // ETF PROXIES
  "SMH",
  "QQQ",
  "XLK",
  "XLE",
  "IGV"

];

// ================================================================
// LSE — ELITE TREND NAMES
// ================================================================

const LSE_POOL = [

  // DEFENSE + INDUSTRIALS
  "BA.L",     // BAE Systems — defense AI and platforms
  "RR.L",     // Rolls-Royce — power systems, defense

  // UTILITIES + POWER INFRASTRUCTURE
  "NG.L",     // V64: National Grid — AI power demand beneficiary
  "SSE.L",    // V64: SSE — renewables and grid infrastructure

  // FINANCIAL + DATA INFRASTRUCTURE
  "LSEG.L",   // V64: London Stock Exchange Group — data/fintech momentum
  "EXPN.L",   // Experian — data/fintech momentum

  // TECH + MOMENTUM
  "SPX.L",    // V64: SPX Technologies — precision engineering
  "HLMA.L",   // V64: Halma — safety/environment tech, strong trend
  "IMI.L",    // V64: IMI — precision engineering momentum
  "SMIN.L",   // V64: Smiths Group — industrial tech

  // ENERGY + OIL
  "SHEL.L",   // Shell — liquid momentum
  "BP.L",     // BP — energy momentum

  // MINING + COMMODITIES
  "GLEN.L",   // Glencore — copper, critical metals
  "RIO.L",    // Rio Tinto — diversified mining

  // BANKS
  "BARC.L",   // Barclays — institutional momentum
  "LLOY.L",   // Lloyds — UK financial bellwether
  "NWG.L",    // NatWest — UK banking momentum

  // HEALTHCARE
  "AZN.L"     // AstraZeneca — pharma momentum

];

// ================================================================

let running = false;

let btcTrend = "neutral";

// Market state — always init false so open alerts fire correctly on deploy
// Mid-session restarts will send the open alert again — that's acceptable
// and confirms the bot is live, which is useful
let usMarketState = false;
let lseMarketState = false;

// ================================================================
// HELPERS
// ================================================================

function nowIso() {

  return new Date().toISOString();

}

function ensureFiles() {

  fs.mkdirSync(
    DATA_DIR,
    { recursive: true }
  );

  for (
    const file of Object.values(FILES)
  ) {

    if (
      !fs.existsSync(file)
    ) {

      fs.writeFileSync(
        file,
        "[]"
      );

    }

  }

}

function load(
  file,
  fallback
) {

  try {

    return JSON.parse(
      fs.readFileSync(
        file,
        "utf8"
      )
    );

  } catch {

    return fallback;

  }

}

function save(
  file,
  data
) {

  fs.writeFileSync(

    file,

    JSON.stringify(
      data,
      null,
      2
    )

  );

}

function avg(arr) {

  if (!arr.length) {
    return 0;
  }

  return (

    arr.reduce(
      (a, b) => a + b,
      0
    ) /

    arr.length

  );

}

function ema(
  values,
  period
) {

  const k =
    2 / (period + 1);

  let out =
    values[0];

  for (
    let i = 1;
    i < values.length;
    i++
  ) {

    out =

      values[i] * k +

      out * (1 - k);

  }

  return out;

}

function hoursAgo(ts) {

  return (

    (
      Date.now() -

      new Date(ts)
        .getTime()

    ) / 36e5

  );

}

function formatPrice(
  value,
  market
) {

  if (
    market === "LSE"
  ) {

    return `£${value.toFixed(2)}`;

  }

  if (value >= 1) {

    return `$${value.toFixed(2)}`;

  }

  return `$${value.toFixed(4)}`;

}

// ================================================================
// MARKET HOURS
// ================================================================

function isUSMarketOpen() {

  const now =
    new Date();

  const hour =
    now.getUTCHours();

  const minute =
    now.getUTCMinutes();

  const day =
    now.getUTCDay();

  if (
    day === 0 ||
    day === 6
  ) {

    return false;

  }

  // US market scan window: start at 14:00 UTC (pre-market begins)
  // Official open: 14:30 UTC — but pre-market moves matter
  // Close: 21:00 UTC = 4:00 PM ET
  const minuteOfDay =
    hour * 60 + minute;

  return (
    minuteOfDay >= 810 &&  // 13:30 UTC = 14:30 BST (US market open)
    minuteOfDay < 1200     // 20:00 UTC = 21:00 BST (close)
  );

}

function isLSEOpen() {

  const now =
    new Date();

  const hour =
    now.getUTCHours();

  const minute =
    now.getUTCMinutes();

  const day =
    now.getUTCDay();

  if (
    day === 0 ||
    day === 6
  ) {

    return false;

  }

  // V66: UK bank holidays — LSE closed on these dates
  const yyyy =
    now.getUTCFullYear();

  const mm =
    String(now.getUTCMonth() + 1)
      .padStart(2, "0");

  const dd =
    String(now.getUTCDate())
      .padStart(2, "0");

  const today =
    `${yyyy}-${mm}-${dd}`;

  const ukBankHolidays = [
    "2026-01-01", // New Year's Day
    "2026-04-03", // Good Friday
    "2026-04-06", // Easter Monday
    "2026-05-04", // Early May Bank Holiday
    "2026-05-25", // Spring Bank Holiday
    "2026-08-31", // Summer Bank Holiday
    "2026-12-25", // Christmas Day
    "2026-12-28", // Boxing Day (substitute)
    "2025-12-25",
    "2025-12-26",
    "2025-01-01",
    "2025-04-18",
    "2025-04-21",
    "2025-05-05",
    "2025-05-26",
    "2025-08-25"
  ];

  if (
    ukBankHolidays.includes(today)
  ) {

    return false;

  }

  // LSE: 07:00 UTC = 08:00 BST open, 15:50 UTC = 16:50 BST close
  const minuteOfDay =
    hour * 60 + minute;

  return (
    minuteOfDay >= 420 &&  // 07:00 UTC = 08:00 BST
    minuteOfDay < 950      // 15:50 UTC = 16:50 BST
  );

}

// ================================================================
// TELEGRAM
// ================================================================

async function send(msg) {

  if (
    !BOT_TOKEN ||
    !CHAT_ID
  ) {

    console.log(msg);

    return;

  }

  try {

    await axios.post(

      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,

      {

        chat_id:
          CHAT_ID,

        text:
          msg

      }

    );

  } catch (e) {

    console.log(
      "TELEGRAM ERROR:",
      e.message
    );

  }

}

// ================================================================
// MARKET STATUS
// ================================================================

async function marketStatusCheck() {

  const usOpen =
    isUSMarketOpen();

  const lseOpen =
    isLSEOpen();

  if (
    usOpen &&
    !usMarketState
  ) {

    await send(
`🇺🇸 US PRE-MARKET OPEN

⚡ Momentum scanner active`
    );

  }

  if (
    !usOpen &&
    usMarketState
  ) {

    await send(
`🇺🇸 US MARKET CLOSED`
    );

  }

  if (
    lseOpen &&
    !lseMarketState
  ) {

    await send(
`🇬🇧 LSE OPEN

⚡ Momentum scanner active`
    );

  }

  if (
    !lseOpen &&
    lseMarketState
  ) {

    await send(
`🇬🇧 LSE CLOSED`
    );

  }

  usMarketState =
    usOpen;

  lseMarketState =
    lseOpen;

}

// ================================================================
// FETCH CRYPTO
// ================================================================

async function fetchCrypto(
  symbol
) {

  try {

    const { data } =

      await axios.get(

        "https://data-api.binance.vision/api/v3/klines",

        {

          params: {

            symbol,

            interval: "1h",

            limit: 120

          }

        }

      );

    return data.map(k => ({

      close: +k[4],

      high: +k[2],

      low: +k[3],

      volume: +k[5]

    }));

  } catch (e) {

    console.log(
      `CRYPTO ERROR ${symbol}`,
      e.message
    );

    return null;

  }

}

// ================================================================
// FETCH STOCKS
// ================================================================

// V62: US stocks use 1h candles — intraday reclaim/breakout detection
async function fetchYahooUS(
  symbol
) {

  try {

    const { data } =

      await axios.get(

        `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}`,

        {

          params: {

            range: "60d",

            interval: "1h"

          },

          headers: {

            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",

            "Accept": "application/json"

          }

        }

      );

    const result =
      data?.chart?.result?.[0];

    const quote =
      result?.indicators
        ?.quote?.[0];

    if (!quote?.close) {

      return null;

    }

    return quote.close

      .map((c, i) => ({

        close: +c,

        high:
          +quote.high?.[i],

        low:
          +quote.low?.[i],

        volume:
          +quote.volume?.[i]

      }))

      .filter(
        x => x.close
      );

  } catch (e) {

    console.log(
      `YAHOO ERROR ${symbol}`,
      e.message
    );

    return null;

  }

}

// V64: LSE stocks — switched to query2 endpoint, better headers
// query1 is heavily rate-limited on server IPs; query2 is more permissive
async function fetchYahooLSE(
  symbol
) {

  try {

    const { data } =

      await axios.get(

        `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}`,

        {

          params: {

            range: "6mo",

            interval: "1d",

            includePrePost: false,

            events: "div,splits"

          },

          headers: {

            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",

            "Accept": "*/*",

            "Accept-Language": "en-US,en;q=0.9",

            "Origin": "https://finance.yahoo.com",

            "Referer": "https://finance.yahoo.com/"

          }

        }

      );

    const result =
      data?.chart?.result?.[0];

    const quote =
      result?.indicators
        ?.quote?.[0];

    if (!quote?.close) {

      return null;

    }

    return quote.close

      .map((c, i) => ({

        close: +c,

        high:
          +quote.high?.[i],

        low:
          +quote.low?.[i],

        volume:
          +quote.volume?.[i]

      }))

      .filter(
        x => x.close
      );

  } catch (e) {

    console.log(
      `YAHOO ERROR ${symbol}`,
      e.message
    );

    return null;

  }

}

// ================================================================
// BTC TREND
// ================================================================

async function updateBTCTrend() {

  const candles =
    await fetchCrypto(
      "BTCUSDT"
    );

  if (!candles) {
    return;
  }

  const closes =
    candles.map(
      x => x.close
    );

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  btcTrend =
    ema20 > ema50
      ? "bullish"
      : "neutral";

}

// ================================================================
// COOLDOWN
// ================================================================

function cooldown(
  asset,
  alerts,
  market
) {

  const found =

    [...alerts]

      .reverse()

      .find(
        x =>
          x.asset === asset
      );

  if (!found) {

    return false;

  }

  const limit =

    market === "CRYPTO"

      ? CRYPTO_COOLDOWN

      : STOCK_COOLDOWN;

  return (

    hoursAgo(
      found.sentAt
    ) < limit

  );

}

// ================================================================
// ANALYSIS
// ================================================================

function analyse(
  asset,
  candles,
  market
) {

  if (
    !candles ||
    candles.length < 60
  ) {

    return null;

  }

  const closes =
    candles.map(
      x => x.close
    );

  const highs =
    candles.map(
      x => x.high
    );

  const lows =
    candles.map(
      x => x.low
    );

  const volumes =
    candles.map(
      x => x.volume
    );

  const last =
    closes.at(-1);

  const prev =
    closes.at(-2);

  const momentum =
    (
      last - prev
    ) / prev;

  if (
    momentum <= 0 ||
    momentum >
      MAX_MOMENTUM
  ) {

    console.log(`REJECTED ${asset} — momentum out of range (${(momentum*100).toFixed(2)}%)`);
    return null;

  }

  // ============================================================
  // TREND
  // ============================================================

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  const strongTrend =
    ema20 > ema50;

  if (
    !strongTrend
  ) {

    console.log(`REJECTED ${asset} — no strong trend (EMA20 ${ema20.toFixed(2)} < EMA50 ${ema50.toFixed(2)})`);
    return null;

  }

  // ============================================================
  // VOLUME
  // ============================================================

  // V65: exclude current candle from avg — prevents spike self-dilution
  const avgVol =
    avg(
      volumes.slice(-21, -1)
    );

  const currentVol =
    volumes.at(-1);

  const volRatio =
    currentVol / avgVol;

  if (
    market === "CRYPTO"
  ) {

    const requiredVol =

      btcTrend === "bullish"

        ? CRYPTO_VOL_RATIO_BULL

        : CRYPTO_VOL_RATIO_NEUTRAL;

    if (
      volRatio <
      requiredVol
    ) {

      return null;

    }

  } else {

    if (
      volRatio <
      STOCK_MIN_VOL_RATIO
    ) {

      return null;

    }

  }

  // ============================================================
  // BREAKOUT
  // ============================================================

  // V63: shortened lookback 15 → 10 for faster intraday detection
  const breakout =
    Math.max(
      ...highs.slice(
        -10,
        -1
      )
    );

  const breakoutStrength =
    (
      last - breakout
    ) / breakout;

  // V62: market-aware breakout vol — crypto 1.20x / stocks 1.10x
  const breakoutVolRequired =
    market === "CRYPTO"
      ? CRYPTO_BREAKOUT_VOL
      : STOCK_BREAKOUT_VOL;

  const reclaimVolRequired =
    market === "CRYPTO"
      ? CRYPTO_RECLAIM_VOL
      : STOCK_RECLAIM_VOL;

  const breakoutSignal =

    breakoutStrength >
      BREAKOUT_THRESHOLD &&

    volRatio > breakoutVolRequired;

  // ============================================================
  // RECLAIM
  // ============================================================
  // V63: improved reclaim — catches pullback, bounce, drift reclaims

  const reclaim =
    last > ema20 &&
    closes.slice(-4).some(
      c => c < ema20
    );

  // ============================================================
  // V65: RECENT RUN — moved here so continuation can reference it
  // 4-candle move > 8% = overextension, block breakout entries
  // ============================================================

  const recentRun =
    (closes.at(-1) / closes.at(-4)) - 1 > 0.08;

  // ============================================================
  // V64: CONTINUATION SETUP
  // V65: nearEMA20 now market-aware — crypto stays higher above EMA20
  // ============================================================

  const nearEMA20 =
    market === "CRYPTO"
      ? ema20 * 1.06
      : ema20 * 1.035;

  const continuation =
    last > ema20 &&
    last > ema50 &&
    closes.slice(-6).some(
      c => c < nearEMA20
    ) &&
    !reclaim &&
    momentum > 0 &&
    !recentRun;

  // ============================================================
  // VALIDATION
  // ============================================================

  if (
    !breakoutSignal &&
    !reclaim &&
    !continuation
  ) {

    console.log(`REJECTED ${asset} — no setup (no breakout/reclaim/continuation)`);
    return null;

  }

  // ============================================================
  // V65: SPLIT VOLUME VALIDATION — MARKET AWARE
  // ============================================================

  if (
    breakoutSignal &&
    !reclaim &&
    !continuation &&
    volRatio < breakoutVolRequired
  ) {

    console.log(`REJECTED ${asset} — breakout vol too low (${volRatio.toFixed(2)}x < ${breakoutVolRequired}x)`);
    return null;

  }

  if (
    (reclaim || continuation) &&
    !breakoutSignal &&
    volRatio < reclaimVolRequired
  ) {

    console.log(`REJECTED ${asset} — reclaim/continuation vol too low (${volRatio.toFixed(2)}x)`);
    return null;

  }

  // ============================================================
  // V65: ANTI-CHASE — percentage-based recentRun
  // blocks >8% move in 4 candles — only on breakout signals
  // ============================================================

  if (
    breakoutSignal &&
    recentRun &&
    momentum > RECENT_RUN_MOMENTUM
  ) {

    console.log(`REJECTED ${asset} — recentRun overextension (>${((closes.at(-1)/closes.at(-4)-1)*100).toFixed(1)}% in 4 candles)`);
    return null;

  }

  // ============================================================
  // SETUP TYPE
  // ============================================================

  let setupType =
    reclaim
      ? "RECLAIM"
      : continuation
      ? "CONTINUATION"
      : "BREAKOUT";

  // ============================================================
  // PARABOLIC
  // ============================================================

  const parabolic =

    momentum >
      PARABOLIC_MIN_MOMENTUM &&

    volRatio >
      PARABOLIC_MIN_VOL;

  // ============================================================
  // ENTRY
  // ============================================================

  let entry =
    last;

  let entryType =
    "MARKET BUY";

  const extension =
    (
      last - ema20
    ) / ema20;

  // ============================================================
  // V65: MARKET-AWARE EXTENSION LIMIT
  // Crypto: 14% / Stocks: 9%
  // ============================================================

  const extensionLimit =
    market === "CRYPTO"
      ? EXTENSION_HARD_LIMIT_CRYPTO
      : EXTENSION_HARD_LIMIT_STOCK;

  if (
    extension > extensionLimit
  ) {

    console.log(`REJECTED ${asset} — overextended (${(extension*100).toFixed(1)}% > ${(extensionLimit*100).toFixed(0)}% limit)`);
    return null;

  }

  // ============================================================
  // V61+V64: SETUP-AWARE ENTRY LOGIC
  // PARABOLIC    → STOP BUY  breakout * 1.003 (override — always first)
  // RECLAIM      → LIMIT BUY last * 0.992     (wait for retest)
  // CONTINUATION → LIMIT BUY ema20 * 1.002    (buy near EMA20 grind)
  // BREAKOUT     → STOP BUY  breakout * 1.002 (prove continuation)
  // MARKET BUY retired — no blind market entries
  // ============================================================

  if (
    parabolic
  ) {

    entryType =
      "STOP BUY";

    entry =
      breakout * 1.003;

  } else if (
    reclaim
  ) {

    entryType =
      "LIMIT BUY";

    entry =
      last * 0.996;

  } else if (
    continuation
  ) {

    entryType =
      "LIMIT BUY";

    entry =
      ema20 * 0.997;  // just above EMA20 — buy the grind near support

  } else if (
    breakoutSignal
  ) {

    entryType =
      "STOP BUY";

    entry =
      breakout * 1.002;

  }

  // ============================================================
  // STOP
  // ============================================================

  const recentLow =
    Math.min(
      ...lows.slice(-5)
    );

  const sl =
    recentLow * 0.995;

  if (
    sl >= entry
  ) {

    return null;

  }

  // ============================================================
  // TARGET
  // ============================================================
  // V65: DYNAMIC TP — based on RR ratio not fixed %
  // entry + (risk * 2.2) = natural 2.2R target
  // Parabolic gets wider 3R target

  const riskAmt = entry - sl;

  let tp =
    entry + (riskAmt * 2.2);

  if (
    parabolic
  ) {

    tp =
      entry + (riskAmt * 3.0);

  }

  // ============================================================
  // RR
  // ============================================================

  const riskPct =
    (entry - sl) / entry;

  if (
    riskPct <= 0
  ) {

    return null;

  }

  const rewardPct =
    (tp - entry) / entry;

  const rr =

    (
      rewardPct / riskPct
    ).toFixed(1);

  if (
    rr < MIN_RR
  ) {

    console.log(`REJECTED ${asset} — RR too low (${rr} < ${MIN_RR})`);
    return null;

  }

  // ============================================================
  // SCORE
  // ============================================================

  let score = 50;

  if (
    momentum > 0.01
  ) score += 10;

  if (
    volRatio > 1.5
  ) score += 10;

  if (
    breakoutSignal
  ) score += 10;

  if (
    reclaim
  ) score += 15;

  if (
    continuation
  ) score += 12;  // slightly below reclaim — less confirmed but still strong

  if (
    strongTrend
  ) score += 10;

  // ============================================================
  // GRADE
  // ============================================================

  let grade = "B";

  if (
    score >= 90
  ) {

    grade = "A*";

  }

  else if (
    score >= 75
  ) {

    grade = "A";

  }

  return {

    asset,
    market,

    grade,

    setupType,

    status:

      parabolic
        ? "PARABOLIC"
        : "CONFIRMED",

    entryType,

    entry,

    sl,

    tp,

    rr,

    score,

    momentum,

    volRatio

  };

}

// ================================================================
// SIGNAL MESSAGE
// ================================================================

async function sendSignal(
  s
) {

  const icon =

    s.status === "PARABOLIC"

      ? "🔥"

      : "🚨";

  const marketIcon =

    s.market === "CRYPTO"

      ? "🪙"

      : s.market === "US"

      ? "🇺🇸"

      : "🇬🇧";

  await send(

`${icon} ${s.status} ${s.grade}

${marketIcon} ${s.asset}

🧠 ${s.setupType}

⚡ ${s.entryType}

🎯 ENTRY
${formatPrice(
  s.entry,
  s.market
)}

🛑 STOP
${formatPrice(
  s.sl,
  s.market
)}

💰 TARGET
${formatPrice(
  s.tp,
  s.market
)}

📊 R:R ${s.rr}

📈 ${(
  s.momentum * 100
).toFixed(2)}%

📊 VOL ${s.volRatio.toFixed(2)}x

🧠 SCORE ${s.score}

₿ ${btcTrend}`

  );

}

// ================================================================
// SCAN
// ================================================================

async function scan() {

  const alerts =
    load(
      FILES.alerts,
      []
    );

  const results = [];

  async function processAsset(
    asset,
    market,
    fetcher
  ) {

    if (
      cooldown(
        asset,
        alerts,
        market
      )
    ) {

      return;

    }

    const candles =
      await fetcher(asset);

    const signal =
      analyse(
        asset,
        candles,
        market
      );

    if (
      signal
    ) {

      results.push(
        signal
      );

    }

  }

  // CRYPTO

  if (
    ENABLE_CRYPTO
  ) {

    for (
      const pair of CRYPTO_PAIRS
    ) {

      await processAsset(
        pair,
        "CRYPTO",
        fetchCrypto
      );

    }

  }

  // US

  if (
    ENABLE_US &&
    isUSMarketOpen()
  ) {

    for (
      const stock of STOCK_POOL
    ) {

      await processAsset(
        stock,
        "US",
        fetchYahooUS    // 1h candles
      );

    }

  }

  // LSE

  if (
    ENABLE_LSE &&
    isLSEOpen()
  ) {

    for (
      const stock of LSE_POOL
    ) {

      await processAsset(
        stock,
        "LSE",
        fetchYahooLSE   // daily candles — Yahoo limitation
      );

    }

  }

  return results

    .sort(
      (a, b) =>
        b.score -
        a.score
    )

    .slice(
      0,
      MAX_SIGNALS
    );

}

// ================================================================
// PROCESS SIGNALS
// ================================================================

async function processSignals(
  signals
) {

  const alerts =
    load(
      FILES.alerts,
      []
    );

  const trades =
    load(
      FILES.trades,
      []
    );

  for (
    const s of signals
  ) {

    await sendSignal(s);

    const sentAt = nowIso();

    // Cooldown tracking — minimal
    alerts.push({

      asset:
        s.asset,

      sentAt

    });

    // V66: full trade record for outcome tracking
    trades.push({

      id:
        `${s.asset}-${Date.now()}`,

      asset:
        s.asset,

      market:
        s.market,

      setupType:
        s.setupType,

      entryType:
        s.entryType,

      entry:
        s.entry,

      sl:
        s.sl,

      tp:
        s.tp,

      rr:
        s.rr,

      score:
        s.score,

      sentAt,

      outcome:
        "OPEN"

    });

  }

  save(
    FILES.alerts,
    alerts
  );

  save(
    FILES.trades,
    trades
  );

}

// ================================================================
// MAIN LOOP
// ================================================================

async function runCycle() {

  if (running) {
    return;
  }

  running = true;

  try {

    ensureFiles();

    await marketStatusCheck();

    await updateBTCTrend();

    // V66: check open trade outcomes every cycle
    await checkOutcomes();

    // V66: weekly report — fires Monday 07:00 UTC only
    await weeklyReport();

    const signals =
      await scan();

    console.log(
      `Signals: ${signals.length}`
    );

    if (
      signals.length
    ) {

      await processSignals(
        signals
      );

    }

  } catch (e) {

    console.log(
      "RUN ERROR:",
      e.message
    );

  } finally {

    running = false;

  }

}

// ================================================================
// V66: OUTCOME TRACKING
// Polls open trades every 15 min
// Fires Telegram when TP or SL is hit
// ================================================================

async function checkOutcomes() {

  const trades =
    load(
      FILES.trades,
      []
    );

  const open =
    trades.filter(
      t => t.outcome === "OPEN"
    );

  if (!open.length) {
    return;
  }

  let updated = false;

  for (const trade of open) {

    try {

      let price = null;

      if (
        trade.market === "CRYPTO"
      ) {

        const { data } =
          await axios.get(
            "https://data-api.binance.vision/api/v3/ticker/price",
            { params: { symbol: trade.asset } }
          );

        price = +data.price;

      } else {

        const { data } =
          await axios.get(
            `https://query2.finance.yahoo.com/v8/finance/chart/${trade.asset}`,
            {
              params: { range: "1d", interval: "1m" },
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "*/*",
                "Referer": "https://finance.yahoo.com/"
              }
            }
          );

        const closes =
          data?.chart?.result?.[0]
            ?.indicators?.quote?.[0]?.close;

        if (closes) {
          price = closes.filter(Boolean).at(-1);
        }

      }

      if (!price) continue;

      const mktIcon =
        trade.market === "CRYPTO" ? "🪙"
        : trade.market === "US" ? "🇺🇸"
        : "🇬🇧";

      if (price >= trade.tp) {

        trade.outcome = "WIN";
        trade.closedAt = nowIso();
        trade.closePrice = price;
        updated = true;

        await send(
`✅ TARGET HIT

${mktIcon} ${trade.asset}
🧠 ${trade.setupType}

🎯 Entry: ${trade.entry.toFixed(4)}
💰 TP hit: ${price.toFixed(4)}
📊 R:R ${trade.rr}

🏆 +${trade.rr}R captured`
        );

      } else if (price <= trade.sl) {

        trade.outcome = "LOSS";
        trade.closedAt = nowIso();
        trade.closePrice = price;
        updated = true;

        await send(
`❌ STOPPED OUT

${mktIcon} ${trade.asset}
🧠 ${trade.setupType}

🎯 Entry: ${trade.entry.toFixed(4)}
🛑 SL hit: ${price.toFixed(4)}

💥 -1R`
        );

      }

    } catch (e) {

      console.log(
        `OUTCOME CHECK ERROR ${trade.asset}:`,
        e.message
      );

    }

  }

  if (updated) {

    save(
      FILES.trades,
      trades
    );

  }

}

// ================================================================
// V66: WEEKLY PERFORMANCE REPORT
// Fires every Monday at 07:00 UTC
// Covers the past 7 days of trades
// ================================================================

async function weeklyReport() {

  const now = new Date();

  // Only run on Monday (day 1) at 07:00 UTC
  if (
    now.getUTCDay() !== 1 ||
    now.getUTCHours() !== 7
  ) {
    return;
  }

  const trades =
    load(
      FILES.trades,
      []
    );

  // Filter to last 7 days
  const weekAgo =
    Date.now() - 7 * 24 * 60 * 60 * 1000;

  const weekTrades =
    trades.filter(
      t =>
        new Date(t.sentAt).getTime() >
        weekAgo
    );

  const closed =
    weekTrades.filter(
      t => t.outcome !== "OPEN"
    );

  const wins =
    closed.filter(
      t => t.outcome === "WIN"
    );

  const losses =
    closed.filter(
      t => t.outcome === "LOSS"
    );

  const open =
    weekTrades.filter(
      t => t.outcome === "OPEN"
    );

  const winRate =
    closed.length
      ? Math.round(
          (wins.length / closed.length) * 100
        )
      : 0;

  const avgRR =
    wins.length
      ? (
          wins.reduce(
            (sum, t) => sum + +t.rr,
            0
          ) / wins.length
        ).toFixed(1)
      : "0";

  const bestTrade =
    wins.sort(
      (a, b) => +b.rr - +a.rr
    )[0];

  // Breakdown by market
  const cryptoTrades =
    weekTrades.filter(
      t => t.market === "CRYPTO"
    );

  const usTrades =
    weekTrades.filter(
      t => t.market === "US"
    );

  const lseTrades =
    weekTrades.filter(
      t => t.market === "LSE"
    );

  const marketLine = (
    label,
    icon,
    arr
  ) => {
    const w = arr.filter(t => t.outcome === "WIN").length;
    const total = arr.filter(t => t.outcome !== "OPEN").length;
    return total
      ? `${icon} ${label}: ${arr.length} signals, ${w}/${total} wins`
      : `${icon} ${label}: ${arr.length} signals`;
  };

  const weekEnd =
    now.toLocaleDateString(
      "en-GB",
      { day: "numeric", month: "short", year: "numeric" }
    );

  await send(
`📊 WEEKLY PERFORMANCE
Week ending ${weekEnd}

🔔 Signals: ${weekTrades.length}
✅ Winners: ${wins.length} (${winRate}%)
❌ Losers: ${losses.length}
⏳ Open: ${open.length}

📈 Avg RR captured: ${avgRR}R
${bestTrade ? `🏆 Best: ${bestTrade.asset} +${bestTrade.rr}R` : ""}

${marketLine("Crypto", "🪙", cryptoTrades)}
${marketLine("US", "🇺🇸", usTrades)}
${marketLine("LSE", "🇬🇧", lseTrades)}

₿ ${btcTrend}`
  );

}

// ================================================================
// API
// ================================================================

app.get("/", (_req, res) => {

  res.send(
    "SNIPER V66 PRODUCTION RUNNING 🚀"
  );

});

// ================================================================
// START
// ================================================================

ensureFiles();

app.listen(

  PORT,

  "0.0.0.0",

  async () => {

    console.log(
      `API running on ${PORT}`
    );

    await send(

`🚀 SNIPER V66 PRODUCTION LIVE

✅ outcome tracking: TP/SL alerts via Telegram
✅ trades.json: full entry/sl/tp/rr saved per signal
✅ weekly report: every Monday 07:00 UTC
✅ watchlist: APP, MSTR, COIN, INDA added
✅ 4 setup types: CONTINUATION / RECLAIM / BREAKOUT / PARABOLIC
✅ rejection logging active
✅ market hours: LSE 08:00 BST / US 14:30 BST
✅ crypto 21 pairs / US 54 stocks / LSE 18 names
✅ 5 min scans / MAX_SIGNALS 12

🎯 V66 — outcome tracking + weekly performance active`

    );

    setTimeout(
      runCycle,
      5000
    );

    setInterval(
      runCycle,
      300000  // V63: 5 min scans (was 10 min) — better 1h momentum flow
    );

  }

);
