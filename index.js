const { spawn } = require('child_process');
const fs = require('fs');
const https = require("https");

// ===============================
// START PYTHON BOT
// ===============================
const pythonProcess = spawn('python3', ['portfolio_bot.py']);

pythonProcess.stdout.on('data', (data) => {
  console.log(`PYTHON: ${data}`);
});

pythonProcess.stderr.on('data', (data) => {
  console.error(`PYTHON ERROR: ${data}`);
});

// ===============================
// SETTINGS
// ===============================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;

const CRYPTO_EVERY = 5; // minutes

// ===============================
// WATCHLIST
// ===============================
const CRYPTO_PAIRS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT",
  "AVAXUSDT","DOGEUSDT","LINKUSDT","INJUSDT","SEIUSDT",
  "SUIUSDT","TIAUSDT","JUPUSDT","FETUSDT","RENDERUSDT"
];

// ===============================
// HELPERS
// ===============================
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search },
      res => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch { reject("JSON error"); }
        });
      }
    ).on("error", reject);
  });
}

function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json" }
      },
      res => res.on("data", () => {})
    );
    req.write(body);
    req.end();
    resolve();
  });
}

// ===============================
// SIGNAL STORAGE
// ===============================
function saveSignal(signal) {
  let signals = [];

  try {
    signals = JSON.parse(fs.readFileSync('signals.json'));
  } catch {}

  // prevent duplicates
  if (!signals.find(s => s.asset === signal.asset)) {
    signals.push(signal);
  }

  // keep last 10 only
  if (signals.length > 10) signals.shift();

  fs.writeFileSync('signals.json', JSON.stringify(signals, null, 2));
}

// ===============================
// ELITE BREAKOUT LOGIC
// ===============================
async function analyse(symbol) {
  try {
    const data = await httpGet(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=120`
    );

    const candles = data.map(k => ({
      o: +k[1],
      h: +k[2],
      l: +k[3],
      c: +k[4],
      v: +k[5]
    }));

    const closes = candles.map(c => c.c);

    // EMA
    function ema(arr, period) {
      const k = 2 / (period + 1);
      let val = arr.slice(0, period).reduce((a, b) => a + b) / period;
      for (let i = period; i < arr.length; i++) {
        val = arr[i] * k + val * (1 - k);
      }
      return val;
    }

    const e50 = ema(closes, 50);
    const e200 = ema(closes, 200);
    const price = closes.at(-1);

    // 1. TREND
    if (!(price > e50 && e50 > e200)) return null;

    // 2. RESISTANCE
    const highs = candles.slice(-20).map(c => c.h);
    const top = Math.max(...highs);

    const touches = highs.filter(h =>
      Math.abs(h - top) / top < 0.002
    ).length;

    if (touches < 3) return null;

    // 3. BREAKOUT
    const last = candles.at(-1);
    const prev = candles.slice(-21, -1);

    const avgVol = prev.reduce((a, c) => a + c.v, 0) / prev.length;

    if (!(last.c > top && last.v > avgVol * 1.8)) return null;

    // 4. CLEAN BODY
    const body = (last.c - last.o) / (last.h - last.l || 1);

    if (body < 0.5) return null;

    // ===============================
    // PASS
    // ===============================
    return {
      asset: symbol,
      entry: last.c,
      sl: last.c * 0.97,
      tp: last.c * 1.06
    };

  } catch {
    return null;
  }
}

// ===============================
// SCAN LOOP
// ===============================
async function scan() {
  console.log("\nScanning...\n");

  for (const sym of CRYPTO_PAIRS) {

    const signal = await analyse(sym);

    if (signal) {

      console.log(`Signal found: ${sym}`);

      await sendTelegram(`🚀 ${sym} breakout`);

      saveSignal({
        asset: sym,
        entry: signal.entry,
        sl: signal.sl,
        tp: signal.tp,
        time: Date.now()
      });

      break; // only best signal per scan
    }
  }
}

// ===============================
// START
// ===============================
async function main() {
  console.log("Sniper running...");

  // ensure signals file exists
  if (!fs.existsSync("signals.json")) {
    fs.writeFileSync("signals.json", "[]");
  }

  await scan();
  setInterval(scan, CRYPTO_EVERY * 60 * 1000);
}

main();
