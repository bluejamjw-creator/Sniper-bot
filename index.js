const { spawn } = require('child_process');

// Start Python portfolio bot
const pythonProcess = spawn('python3', ['portfolio_bot.py']);

pythonProcess.stdout.on('data', (data) => {
  console.log(`PYTHON: ${data}`);
});

pythonProcess.stderr.on('data', (data) => {
  console.error(`PYTHON ERROR: ${data}`);
});
// ============================================================
//   SNIPER BREAKOUT ALERTS  FINAL EDITION
// ============================================================
//  Crypto: Strict 6-condition breakout (Binance candle data)
//          + Momentum fallback tier (labelled clearly)
//  Stocks: Momentum scanner (Yahoo Finance)
//  Alerts: Telegram with entry / stop / target / size / rating
//  No npm packages needed  pure Node.js built-ins only
// ============================================================
//
//  QUICK START:
//  1. Fill in BOT_TOKEN and CHAT_ID below
//  2. Open terminal in this folder
//  3. Run:  node sniper-final.js
//
//  TO GET YOUR CREDENTIALS:
//  BOT_TOKEN � Telegram � @BotFather � /newbot
//  CHAT_ID   � Telegram � @userinfobot � START
//  Then find your new bot and tap START on it too
// ============================================================

const https = require("https");

// 
//  �️  YOUR SETTINGS  EDIT THESE
// 
const BOT_TOKEN      = process.env.BOT_TOKEN  || "YOUR_BOT_TOKEN_HERE";
const CHAT_ID        = process.env.CHAT_ID    || "YOUR_CHAT_ID_HERE";
const MODE           = "sniper";   // "sniper" (strict) | "aggressive" (looser)
const ACCOUNT_SIZE   = 1000;       // Your account size in USD
const RISK_PCT       = 0.02;       // Risk per trade  0.02 = 2%
const COOLDOWN_MIN   = 60;         // Minutes before same asset can alert again
const CRYPTO_EVERY   = 5;          // Minutes between crypto scans
const STOCK_EVERY    = 15;         // Minutes between stock scans
// 

// 
//  � WATCHLISTS
// 
const CRYPTO_PAIRS = [
  // Large caps
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT","LINKUSDT",
  // Mid caps
  "MATICUSDT","LTCUSDT","UNIUSDT","ATOMUSDT","NEARUSDT",
  "APTUSDT","ARBUSDT","OPUSDT","INJUSDT","SEIUSDT",
  "SUIUSDT","TIAUSDT","JUPUSDT","WIFUSDT","FETUSDT",
  // DeFi / AI / Infrastructure
  "RENDERUSDT","AAVEUSDT","MKRUSDT","SNXUSDT","CRVUSDT",
  "GRTUSDT","FILUSDT","ICPUSDT","VETUSDT","XLMUSDT",
  // Alts
  "ALGOUSDT","EGLDUSDT","FLOWUSDT","XTZUSDT","SANDUSDT",
  "MANAUSDT","AXSUSDT","GALAUSDT","APEUSDT","IMXUSDT",
  "LDOUSDT","STXUSDT","KASUSDT","PENDLEUSDT","ENAUSDT","AXLUSDT"
];

const STOCKS = [
  // US Tech
  "AAPL","TSLA","NVDA","MSFT","AMZN","META","GOOGL","AMD","NFLX",
  // US Other
  "DIS","BA","NKE",
  // UK
  "BP.L","HSBA.L","VOD.L","AZN.L",
  // High-conviction individual picks
  "PLTR","VRT","GEV"
];

// 
//  � INTERNALS
// 
const cooldowns = new Map();

function isCoolingDown(key) {
  const now  = Date.now();
  const last = cooldowns.get(key);
  if (last && now - last < COOLDOWN_MIN * 60 * 1000) return true;
  cooldowns.set(key, now);
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmt(n) {
  if (n == null) return "";
  return n >= 100
    ? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : n.toPrecision(5);
}

function round(n) {
  return n >= 100 ? Math.round(n * 100) / 100 : Math.round(n * 10000) / 10000;
}

function positionSize(entry, stop) {
  const risk = Math.abs(entry - stop);
  if (!risk) return "0";
  return ((ACCOUNT_SIZE * RISK_PCT) / risk).toFixed(4);
}

function stars(score, max) {
  const pct = score / max;
  if (pct >= 1.0)  return " PERFECT (6/6)";
  if (pct >= 0.83) return " A+";
  if (pct >= 0.66) return " Strong";
  if (pct >= 0.5)  return " Decent";
  return                  " Weak";
}

// 
//   HTTP HELPERS
// 
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
        headers: { "User-Agent": "Mozilla/5.0" } },
      res => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error("JSON parse error")); }
        });
      }
    ).on("error", reject);
  });
}

function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" });
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      },
      res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
    );
    req.on("error", reject);
    req.write(body); req.end();
  });
}

// 
//   TECHNICAL INDICATORS
// 
function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period - 1).fill(null);
  out.push(val);
  for (let i = period; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
    out.push(val);
  }
  return out;
}

function calcSMA(arr, p) {
  return arr.map((_, i) =>
    i < p - 1 ? null : arr.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p
  );
}

function calcStdDev(arr, p) {
  return arr.map((_, i) => {
    if (i < p - 1) return null;
    const sl = arr.slice(i - p + 1, i + 1);
    const m  = sl.reduce((a, b) => a + b, 0) / p;
    return Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / p);
  });
}

function calcBB(closes, p = 20, mult = 2) {
  const mid = calcSMA(closes, p);
  const sd  = calcStdDev(closes, p);
  return closes.map((_, i) => mid[i] == null ? null : {
    mid: mid[i],
    upper: mid[i] + mult * sd[i],
    lower: mid[i] - mult * sd[i],
    width: (mult * 2 * sd[i]) / mid[i]
  });
}

function calcATR(candles, p = 14) {
  const tr = candles.map((c, i) =>
    i === 0 ? c.h - c.l :
    Math.max(c.h - c.l, Math.abs(c.h - candles[i-1].c), Math.abs(c.l - candles[i-1].c))
  );
  let atr = tr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const out = new Array(p - 1).fill(null);
  out.push(atr);
  for (let i = p; i < tr.length; i++) {
    atr = (atr * (p - 1) + tr[i]) / p;
    out.push(atr);
  }
  return out;
}

// 
//   CRYPTO  6 STRICT CONDITIONS
// 
async function fetchKlines(symbol, interval, limit = 250) {
  const url  = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const data = await httpGet(url);
  if (!Array.isArray(data)) throw new Error(`Bad Binance response: ${symbol}`);
  return data.map(k => ({
    o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]
  }));
}

// 1. Multi-timeframe trend  price above EMA50 > EMA200 on 1H AND 4H
function condTrend(c1h, c4h) {
  const cl1 = c1h.map(x => x.c), cl4 = c4h.map(x => x.c);
  const e50_1  = calcEMA(cl1, 50),  e200_1 = calcEMA(cl1, 200);
  const e50_4  = calcEMA(cl4, 50),  e200_4 = calcEMA(cl4, 200);
  const price  = cl1.at(-1);
  const [a, b] = [e50_1.at(-1), e200_1.at(-1)];
  const [c, d] = [e50_4.at(-1), e200_4.at(-1)];
  const pass   = price > a && a > b && price > c && c > d;
  return { pass, detail: `1H EMA50:${a?.toFixed(2)} EMA200:${b?.toFixed(2)} | 4H EMA50:${c?.toFixed(2)}` };
}

// 2. Bollinger Band compression  band width at 20-candle low
function condCompression(c1h, agg) {
  const bands  = calcBB(c1h.map(x => x.c)).filter(Boolean);
  if (bands.length < 20) return { pass: false, detail: "Not enough data" };
  const last20 = bands.slice(-20);
  const curW   = last20.at(-1).width;
  const minW   = Math.min(...last20.map(b => b.width));
  const pass   = curW <= minW * (agg ? 1.06 : 1.01);
  return { pass, detail: `BandWidth ${(curW * 100).toFixed(3)}% ${pass ? "(SQUEEZED )" : "(not tight)"}` };
}

// 3. Liquidity build  at least 3 touches of same resistance
function condLiquidity(c1h) {
  const highs   = c1h.slice(-15).map(x => x.h);
  const top     = Math.max(...highs);
  const touches = highs.filter(h => Math.abs(h - top) / top < 0.002).length;
  const pass    = touches >= 3;
  return { pass, detail: `${touches} touches @ $${fmt(top)}`, level: top };
}

// 4. Pressure build  higher lows + rising volume into resistance
function condPressure(c1h, agg) {
  const last  = c1h.slice(-12);
  const lows  = last.map(x => x.l), vols = last.map(x => x.v);
  const avgL1 = lows.slice(0,6).reduce((a,b)=>a+b,0)/6;
  const avgL2 = lows.slice(6).reduce((a,b)=>a+b,0)/6;
  const avgV1 = vols.slice(0,6).reduce((a,b)=>a+b,0)/6;
  const avgV2 = vols.slice(6).reduce((a,b)=>a+b,0)/6;
  const hl    = avgL2 > avgL1 * (agg ? 0.997 : 1.001);
  const vi    = avgV2 > avgV1 * (agg ? 1.05  : 1.12);
  return { pass: hl && vi, detail: `HigherLows:${hl?"YES":"NO"} | VolTrend:${vi?"RISING":"FLAT"}` };
}

// 5. Breakout trigger  close above resistance, strong body, 2x volume, no wick
function condBreakout(c1h, level, agg) {
  const last   = c1h.at(-1);
  const prev20 = c1h.slice(-21, -1);
  const avgVol = prev20.reduce((a,c) => a + c.v, 0) / prev20.length;
  const spread = last.h - last.l;
  const body   = spread > 0 ? (last.c - last.o) / spread : 0;
  const wick   = spread > 0 ? (last.h - last.c) / spread : 1;
  const above  = last.c > level;
  const strong = body  > (agg ? 0.50 : 0.60);
  const volOK  = last.v >= avgVol * (agg ? 1.5 : 2.0);
  const noWick = wick  < (agg ? 0.25 : 0.18);
  const pass   = above && strong && volOK && noWick;
  const volX   = last.v / avgVol;
  return { pass, detail: `${volX.toFixed(1)}x vol | body ${(body*100).toFixed(0)}% | wick ${(wick*100).toFixed(0)}%`, entry: last.c, volX };
}

// 6. Clean air  no major resistance in next 2.5%
function condCleanAir(c1h, entry) {
  const target   = entry * 1.025;
  const barriers = c1h.slice(-50, -1).filter(c => c.h >= entry * 1.003 && c.h <= target).length;
  return { pass: barriers <= 3, detail: `${barriers} barriers in next 2.5%` };
}

// 
//   CRYPTO ANALYSIS  TIERED SCORING
// 
async function analyseCrypto(symbol) {
  const agg = MODE === "aggressive";
  try {
    const [c1h, c4h] = await Promise.all([
      fetchKlines(symbol, "1h", 250),
      fetchKlines(symbol, "4h", 250)
    ]);

    // Run all 6 strict conditions
    const trend    = condTrend(c1h, c4h);
    const compress = condCompression(c1h, agg);
    const liq      = condLiquidity(c1h);
    const pressure = condPressure(c1h, agg);
    const brk      = condBreakout(c1h, liq.level, agg);
    const clean    = condCleanAir(c1h, brk.entry);

    const strictPass =
      (trend.pass || agg) &&
      compress.pass &&
      liq.pass &&
      pressure.pass &&
      brk.pass &&
      clean.pass;

    // Momentum fallback  calculated from candle data (not CoinGecko)
    const last       = c1h.at(-1);
    const prev20     = c1h.slice(-21, -1);
    const avgVol     = prev20.reduce((a, c) => a + c.v, 0) / prev20.length;
    const open24     = c1h.at(-25)?.o || last.c;
    const open1h     = c1h.at(-2)?.c  || last.c;
    const chg24h     = ((last.c - open24) / open24) * 100;
    const chg1h      = ((last.c - open1h) / open1h) * 100;
    const volRatio   = last.v / avgVol;

    const momentumPass = chg24h > 3 && chg1h > 1 && volRatio > 2;

    //  Tiered decision 
    let score, tier, confidence;

    if (strictPass) {
      score      = 6;
      tier       = "STRICT";
      confidence = brk.volX >= 2.5 && !agg ? "VERY HIGH" : "HIGH";
    } else if (momentumPass) {
      score      = 3;
      tier       = "MOMENTUM";
      confidence = "MODERATE";
    } else {
      // Nothing passed  report what failed first
      const failAt = !trend.pass    ? "TREND"
                   : !compress.pass ? "COMPRESSION"
                   : !liq.pass      ? "LIQUIDITY"
                   : !pressure.pass ? "PRESSURE"
                   : !brk.pass      ? "BREAKOUT"
                   :                  "CLEAN AIR";
      return { pass: false, failAt };
    }

    //  Build trade levels 
    const atrVal = calcATR(c1h).at(-1);
    const entry  = round(tier === "STRICT" ? brk.entry : last.c * 1.005);
    const sl     = round(tier === "STRICT"
      ? Math.min(liq.level * 0.992, entry - atrVal)
      : entry * 0.97);
    const risk   = entry - sl;
    const tp     = round(entry + risk * 2.5);
    const rrN    = (tp - entry) / risk;

    //  Reason string 
    const reasons = [];
    if (tier === "STRICT") {
      if (compress.pass) reasons.push("BB squeeze");
      if (liq.pass)      reasons.push(`${liq.detail.split(" ")[0]} resistance touches`);
      if (brk.pass)      reasons.push(`${brk.volX.toFixed(1)}x volume breakout`);
      if (pressure.pass) reasons.push("ascending pressure");
    } else {
      reasons.push(`+${chg24h.toFixed(1)}% in 24h`);
      reasons.push(`+${chg1h.toFixed(1)}% last hour`);
      reasons.push(`${volRatio.toFixed(1)}x volume surge`);
    }

    return {
      pass: true,
      signal: {
        type: "CRYPTO", tier, asset: symbol.replace("USDT", "/USDT"),
        timeframe: "1H", entry, sl, tp,
        rr: `1:${rrN.toFixed(1)}`, rrN,
        size: positionSize(entry, sl),
        confidence, score,
        reason: reasons.join(" + "),
        volX: tier === "STRICT" ? brk.volX : volRatio,
        conds: { trend, compress, liq, pressure, brk, clean }
      }
    };
  } catch(e) {
    return { pass: false, failAt: "API_ERROR", error: e.message };
  }
}

// 
//   STOCK ANALYSIS  MOMENTUM SCANNER
// 
async function analyseStock(symbol) {
  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
    const data = await httpGet(url);
    const res  = data?.chart?.result?.[0];
    if (!res) return { pass: false, failAt: "NO_DATA" };

    const meta   = res.meta;
    const price  = meta.regularMarketPrice;
    const prev   = meta.previousClose;
    const low    = meta.regularMarketDayLow;
    const high   = meta.regularMarketDayHigh;
    const vol    = meta.regularMarketVolume;
    const avgVol = meta.averageDailyVolume10Day || vol;

    if (!price || !prev) return { pass: false, failAt: "NO_PRICE" };

    const change   = ((price - prev) / prev) * 100;
    const volRatio = vol / avgVol;
    const dayRange = ((price - low) / ((high - low) || 1)) * 100;

    // Score out of 5
    let score = 0;
    if (change > 2)           score++; // meaningful daily move
    if (change > 3.5)         score++; // strong daily move
    if (volRatio > 1.5)       score++; // above average volume
    if (dayRange > 65)        score++; // in upper part of day range
    if (price > prev * 1.02)  score++; // decisively above prev close

    if (score < 3) return { pass: false, failAt: `SCORE_${score}/5` };

    const entry = round(price * 1.003);
    const sl    = round(entry * 0.98);
    const tp    = round(entry * 1.05);
    const risk  = entry - sl;
    const rrN   = (tp - entry) / risk;

    return {
      pass: true,
      signal: {
        type: "STOCK", asset: symbol, timeframe: "1D",
        entry, sl, tp,
        rr: `1:${rrN.toFixed(1)}`, rrN,
        size: positionSize(entry, sl),
        confidence: score >= 4 ? "VERY HIGH" : "HIGH",
        score,
        reason: `+${change.toFixed(2)}% move | ${volRatio.toFixed(1)}x vol | ${dayRange.toFixed(0)}% of day range`,
        change, volRatio
      }
    };
  } catch(e) {
    return { pass: false, failAt: "API_ERROR", error: e.message };
  }
}

// 
//   TELEGRAM MESSAGES
// 
function buildCryptoMsg(s, stats) {
  const isStrict  = s.tier === "STRICT";
  const topEmoji  = s.confidence === "VERY HIGH" ? "" : isStrict ? "" : "";
  const tierLine  = isStrict
    ? " *STRICT BREAKOUT*  All 6 conditions passed"
    : " *MOMENTUM ALERT*  Fallback signal, lower confidence";

  const c = s.conds;
  const condLines = isStrict
    ? [
        `${c.trend.pass    ? "" : ""} Multi-TF Trend      ${c.trend.detail}`,
        `${c.compress.pass ? "" : ""} BB Compression      ${c.compress.detail}`,
        `${c.liq.pass      ? "" : ""} Liquidity Build     ${c.liq.detail}`,
        `${c.pressure.pass ? "" : ""} Pressure Build      ${c.pressure.detail}`,
        `${c.brk.pass      ? "" : ""} Breakout Trigger    ${c.brk.detail}`,
        `${c.clean.pass    ? "" : ""} Clean Air Ahead     ${c.clean.detail}`,
      ].join("\n")
    : "�️ Strict conditions not met  momentum threshold triggered";

  return `${topEmoji} *CRYPTO  ${s.asset}*
${tierLine}
${stars(s.score, 6)}


 Entry:        $${fmt(s.entry)}
 Stop Loss:    $${fmt(s.sl)}
 Take Profit:  $${fmt(s.tp)}
 Risk/Reward:  ${s.rr}
 Size:         ${s.size} units
   (${RISK_PCT * 100}% of $${ACCOUNT_SIZE} = $${(ACCOUNT_SIZE * RISK_PCT).toFixed(0)} risked)


${condLines}

 *Setup:* ${s.reason}
 *Volume:* ${s.volX.toFixed(1)}x average
 ${stats.passed} setup${stats.passed !== 1 ? "s" : ""} from ${stats.total} pairs scanned
� ${new Date().toUTCString()}
_Sniper Breakout Alerts  ${MODE.toUpperCase()} mode_`;
}

function buildStockMsg(s) {
  const emoji = s.confidence === "VERY HIGH" ? "" : "";
  return `${emoji} *STOCK  ${s.asset}*
 *MOMENTUM ALERT*
${stars(s.score, 5)}


 Entry:        $${fmt(s.entry)}
 Stop Loss:    $${fmt(s.sl)}
 Take Profit:  $${fmt(s.tp)}
 Risk/Reward:  ${s.rr}
 Size:         ${s.size} shares
   (${RISK_PCT * 100}% of $${ACCOUNT_SIZE} = $${(ACCOUNT_SIZE * RISK_PCT).toFixed(0)} risked)


 Daily move:   +${s.change.toFixed(2)}%
 Volume:       ${s.volRatio.toFixed(1)}x average
 ${s.reason}

� ${new Date().toUTCString()}
_Sniper Breakout Alerts  Stock Scanner_`;
}

// 
//   SCAN CYCLES
// 
async function scanCrypto() {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`\n[${t}]  CRYPTO SCAN (${CRYPTO_PAIRS.length} pairs, ${MODE.toUpperCase()}) `);

  let passed = 0, errors = 0, best = null;

  for (const sym of CRYPTO_PAIRS) {
    process.stdout.write(`  ${sym.padEnd(14)} `);
    const r = await analyseCrypto(sym);

    if (r.pass) {
      passed++;
      const s = r.signal;
      console.log(` [${s.tier}] ${s.confidence} | vol ${s.volX.toFixed(1)}x | score ${s.score}/6`);
      // Prefer strict over momentum; break ties by score then volX
      if (!best ||
          (s.tier === "STRICT" && best.tier !== "STRICT") ||
          (s.tier === best.tier && s.score > best.score) ||
          (s.tier === best.tier && s.score === best.score && s.volX > best.volX)) {
        best = s;
      }
    } else {
      console.log(`� ${r.failAt}${r.error ? ` (${r.error})` : ""}`);
      if (r.failAt === "API_ERROR") errors++;
    }

    await sleep(120); // avoid Binance rate limits
  }

  console.log(`\n  Result: ${passed} passed / ${CRYPTO_PAIRS.length} scanned / ${errors} errors`);

  if (best) {
    if (!isCoolingDown(best.asset)) {
      console.log(`   BEST: ${best.asset} [${best.tier}]  ${best.confidence}`);
      try {
        await sendTelegram(buildCryptoMsg(best, { total: CRYPTO_PAIRS.length, passed }));
        console.log(`   Telegram sent!`);
      } catch(e) {
        console.log(`  � Telegram failed: ${e.message}`);
      }
    } else {
      console.log(`  �� ${best.asset} still in cooldown  no alert sent`);
    }
  } else {
    console.log(`  No setups found this cycle.`);
  }

  console.log(`  Next crypto scan in ${CRYPTO_EVERY} minutes...`);
}

async function scanStocks() {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`\n[${t}]  STOCK SCAN (${STOCKS.length} symbols) `);

  let sent = 0;

  for (const sym of STOCKS) {
    process.stdout.write(`  ${sym.padEnd(10)} `);
    const r = await analyseStock(sym);

    if (r.pass) {
      const s = r.signal;
      console.log(` ${s.confidence} | +${s.change.toFixed(2)}% | ${s.volRatio.toFixed(1)}x vol | score ${s.score}/5`);
      if (!isCoolingDown(sym)) {
        try {
          await sendTelegram(buildStockMsg(s));
          console.log(`     Alert sent`);
          sent++;
        } catch(e) {
          console.log(`    � Telegram failed: ${e.message}`);
        }
      } else {
        console.log(`    �� In cooldown`);
      }
    } else {
      console.log(`� ${r.failAt}`);
    }

    await sleep(250); // small delay between Yahoo requests
  }

  console.log(`  Result: ${sent} stock alert${sent !== 1 ? "s" : ""} sent`);
  console.log(`  Next stock scan in ${STOCK_EVERY} minutes...`);
}

// 
//   STARTUP
// 
async function main() {
  console.log("\n  �����������������������������������������������");
  console.log("  �     SNIPER BREAKOUT ALERTS              �");
  console.log("  �       Final Edition                       �");
  console.log("  ����������������������������������������������\n");
  console.log(`  Mode:            ${MODE.toUpperCase()}`);
  console.log(`  Crypto pairs:    ${CRYPTO_PAIRS.length} (Binance USDT)`);
  console.log(`  Stocks:          ${STOCKS.length} (Yahoo Finance)`);
  console.log(`  Crypto interval: every ${CRYPTO_EVERY} minutes`);
  console.log(`  Stock interval:  every ${STOCK_EVERY} minutes`);
  console.log(`  Account size:    $${ACCOUNT_SIZE}`);
  console.log(`  Risk per trade:  ${RISK_PCT * 100}% ($${ACCOUNT_SIZE * RISK_PCT})`);
  console.log(`  Cooldown:        ${COOLDOWN_MIN} minutes per asset`);
  console.log(`  Telegram:        ${BOT_TOKEN !== "YOUR_BOT_TOKEN_HERE" ? "CONFIGURED " : "�️  NOT SET"}\n`);

  if (BOT_TOKEN === "YOUR_BOT_TOKEN_HERE" || CHAT_ID === "YOUR_CHAT_ID_HERE") {
    console.log("  �️  WARNING: BOT_TOKEN or CHAT_ID not set.");
    console.log("  Bot will run but Telegram alerts will fail.\n");
  }

  // Send startup confirmation to Telegram
  try {
    await sendTelegram(
      ` *Sniper Breakout Alerts  Online*\n\n` +
      `*Final Edition started*\n` +
      `Mode: ${MODE.toUpperCase()}\n` +
      `Crypto: ${CRYPTO_PAIRS.length} pairs every ${CRYPTO_EVERY}m\n` +
      `Stocks: ${STOCKS.length} symbols every ${STOCK_EVERY}m\n` +
      `Account: $${ACCOUNT_SIZE} | Risk: ${RISK_PCT * 100}% per trade\n` +
      `Cooldown: ${COOLDOWN_MIN}m per asset\n\n` +
      `Two alert tiers:\n` +
      ` STRICT  all 6 breakout conditions (rare, high quality)\n` +
      ` MOMENTUM  price + volume surge (more frequent)\n\n` +
      `Scanning now... `
    );
    console.log("   Startup message sent to Telegram \n");
  } catch(e) {
    console.log(`  � Telegram error on startup: ${e.message}\n`);
  }

  // Run both scans immediately on launch
  await scanCrypto();
  await scanStocks();

  // Then schedule on intervals
  setInterval(scanCrypto, CRYPTO_EVERY  * 60 * 1000);
  setInterval(scanStocks, STOCK_EVERY   * 60 * 1000);
}

main().catch(console.error);
