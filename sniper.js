// ================================================================
// SNIPER V64 PRODUCTION
// INSTITUTIONAL MOMENTUM CONTINUATION ENGINE
// CRYPTO + US STOCKS + LSE
// V60   = ANTI-CHASE UPGRADED
// V60.1 = SPLIT VOLUME REQUIREMENTS
// V61   = SETUP-AWARE ENTRY LOGIC
// V62   = STRUCTURAL UPGRADES (1h stocks, split vol, tiered crypto)
// V63   = SIGNAL FLOW UPGRADES (reclaim, vol, lookback, intervals)
// V64   = CONTINUATION ENGINE
//   - CONTINUATION added as first-class setup type
//   - LSE open alert fix (false init restored)
//   - updated watchlists: XRP, POL, LDO, CRDO, ALAB, CLS, EQIX
//   - LSE expanded: NG, SSE, LSEG, SPX, HLMA, IMI, SMIN
// ================================================================

console.log("🚀 SNIPER V64 PRODUCTION STARTING...");

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

const STOCK_MIN_VOL_RATIO = 1.00;  // V63: loosened from 1.05 — institutional trends grind

const MIN_RR = 1.5;

// ================================================================
// PARABOLIC
// ================================================================

const PARABOLIC_MIN_VOL = 2.0;
const PARABOLIC_MIN_MOMENTUM = 0.03;

// ================================================================
// V62 ANTI-CHASE + ENTRY SETTINGS
// ================================================================

// Hard limit — no entries beyond this extension from EMA20
const EXTENSION_HARD_LIMIT = 0.09;

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
    minuteOfDay >= 840 &&  // 14:00 UTC = 15:00 BST (pre-market)
    minuteOfDay < 1260     // 21:00 UTC = 22:00 BST (close)
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

  // LSE: 8:00 AM UTC open, 4:30 PM UTC close
  const minuteOfDay =
    hour * 60 + minute;

  return (
    minuteOfDay >= 480 &&  // 08:00 UTC
    minuteOfDay < 1010     // 16:30 UTC
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

        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,

        {

          params: {

            range: "60d",

            interval: "1h"

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

// V62: LSE stocks use daily candles — Yahoo only supports 1h for US
async function fetchYahooLSE(
  symbol
) {

  try {

    const { data } =

      await axios.get(

        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,

        {

          params: {

            range: "6mo",

            interval: "1d"

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

    return null;

  }

  // ============================================================
  // VOLUME
  // ============================================================

  const avgVol =
    avg(
      volumes.slice(-20)
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
  // Old: only hard crossover (prev < EMA20 AND last > EMA20)
  // New: last > EMA20 AND any of last 4 candles touched below EMA20
  // Catches far more valid continuation setups without adding noise

  const reclaim =
    last > ema20 &&
    closes.slice(-4).some(
      c => c < ema20
    );

  // ============================================================
  // V64: CONTINUATION SETUP
  // Price grinding above EMA20, pulled back near it, resuming
  // This is the AMD/NVDA stair-step pattern — most common institutional setup
  // Different from reclaim: never went below EMA20, just touched near it
  // ============================================================

  const nearEMA20 =
    ema20 * 1.025;  // within 2.5% above EMA20

  const continuation =
    last > ema20 &&              // price above EMA20
    last > ema50 &&              // uptrend intact
    closes.slice(-6).some(       // touched near EMA20 in last 6 candles
      c => c < nearEMA20
    ) &&
    !reclaim &&                  // not a hard reclaim (already handled)
    momentum > 0 &&              // moving up
    !recentRun;                  // not already extended

  // ============================================================
  // VALIDATION
  // ============================================================

  if (
    !breakoutSignal &&
    !reclaim &&
    !continuation
  ) {

    return null;

  }

  // ============================================================
  // V62: SPLIT VOLUME VALIDATION — MARKET AWARE
  // Crypto breakout: 1.20x / Stock breakout: 1.10x
  // Crypto reclaim:  1.05x / Stock reclaim:  1.00x
  // Continuation: uses reclaim vol thresholds (quiet grind is fine)
  // ============================================================

  if (
    breakoutSignal &&
    !reclaim &&
    !continuation &&
    volRatio < breakoutVolRequired
  ) {

    return null;

  }

  if (
    (reclaim || continuation) &&
    !breakoutSignal &&
    volRatio < reclaimVolRequired
  ) {

    return null;

  }

  // ============================================================
  // V60: ANTI-CHASE — BLOCK LATE BREAKOUTS AFTER 3+ IMPULSIVE CANDLES
  // Catches entries like TIA on 28 Apr where scanner fired at spike peak
  // Reclaims are exempt — only breakout signals are blocked
  // ============================================================

  const recentRun = (
    closes.at(-1) > closes.at(-2) &&
    closes.at(-2) > closes.at(-3) &&
    closes.at(-3) > closes.at(-4)
  );

  if (
    breakoutSignal &&
    recentRun &&
    momentum > RECENT_RUN_MOMENTUM
  ) {

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
  // V60: ANTI-CHASE HARD LIMIT — tightened 0.12 → 0.09
  // ============================================================

  if (
    extension > EXTENSION_HARD_LIMIT
  ) {

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
      last * 0.992;

  } else if (
    continuation
  ) {

    entryType =
      "LIMIT BUY";

    entry =
      ema20 * 1.002;  // just above EMA20 — buy the grind near support

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

  let tp =
    entry * 1.06;

  if (
    parabolic
  ) {

    tp =
      entry * 1.10;

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

  for (
    const s of signals
  ) {

    await sendSignal(s);

    alerts.push({

      asset:
        s.asset,

      sentAt:
        nowIso()

    });

  }

  save(
    FILES.alerts,
    alerts
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
// API
// ================================================================

app.get("/", (_req, res) => {

  res.send(
    "SNIPER V64 PRODUCTION RUNNING 🚀"
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

`🚀 SNIPER V64 PRODUCTION LIVE

✅ CONTINUATION setup added (EMA20 grind pattern)
✅ 4 setup types: CONTINUATION / RECLAIM / BREAKOUT / PARABOLIC
✅ LSE open alert fixed
✅ crypto: 21 pairs — XRP, POL, LDO added
✅ US stocks: 50 names — CRDO, ALAB, CLS, EQIX added
✅ LSE: 18 names — NG, SSE, LSEG, SPX, HLMA, IMI, SMIN added
✅ stocks on 1h / LSE on daily
✅ 5 min scan intervals / MAX_SIGNALS 12
✅ anti-chase protection intact

🎯 V64 — continuation engine active`

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
