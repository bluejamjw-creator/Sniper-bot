const express = require("express");
const axios = require("axios");

const app = express();

const PORT = process.env.PORT || 8080;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// =====================================
// SETTINGS
// =====================================

const SCAN_INTERVAL = 1000 * 60 * 5;

const MIN_CONFIDENCE = 70;
const MIN_24H_VOLUME = 5000000;

const COOLDOWN_HOURS = 12;

const PAIRS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "AVAXUSDT",
  "DOGEUSDT",
  "LINKUSDT",
  "SUIUSDT",
  "TAOUSDT",
  "SEIUSDT",
  "PEPEUSDT",
  "RUNEUSDT",
  "NEARUSDT",
  "ADAUSDT",
  "XRPUSDT",
  "ORDIUSDT"
];

// =====================================
// MEMORY
// =====================================

const alertedPairs = {};

// =====================================
// TELEGRAM
// =====================================

async function sendTelegram(message) {

  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("Missing telegram vars");
    return;
  }

  try {

    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: message
      }
    );

    console.log("Telegram alert sent");

  } catch (err) {

    console.log("Telegram error:", err.message);

  }

}

// =====================================
// HELPERS
// =====================================

function average(arr) {

  return arr.reduce((a, b) => a + b, 0) / arr.length;

}

function cooldownPassed(pair) {

  const last = alertedPairs[pair];

  if (!last) return true;

  const diff = Date.now() - last;

  return diff > COOLDOWN_HOURS * 60 * 60 * 1000;

}

// =====================================
// GET CANDLES
// =====================================

async function getCandles(symbol) {

  try {

    const url =
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=30`;

    const response = await axios.get(url);

    return response.data;

  } catch (err) {

    console.log(`${symbol} candle fail`);

    return [];

  }

}

// =====================================
// GET TICKER
// =====================================

async function getTicker(symbol) {

  try {

    const url =
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;

    const response = await axios.get(url);

    return response.data;

  } catch (err) {

    console.log(`${symbol} ticker fail`);

    return null;

  }

}

// =====================================
// CONFIDENCE ENGINE
// =====================================

function calculateConfidence({
  breakout,
  volumeSpike,
  strongTrend,
  momentum
}) {

  let score = 0;

  if (breakout) score += 30;

  if (volumeSpike) score += 25;

  if (strongTrend) score += 25;

  if (momentum) score += 20;

  return score;

}

// =====================================
// SCAN PAIR
// =====================================

async function scanPair(symbol) {

  try {

    const candles = await getCandles(symbol);

    if (candles.length < 25) {

      console.log(`${symbol} rejected: short data`);

      return null;

    }

    const ticker = await getTicker(symbol);

    if (!ticker) return null;

    const volume = Number(ticker.quoteVolume);

    if (volume < MIN_24H_VOLUME) {

      console.log(`${symbol} rejected: low volume`);

      return null;

    }

    const closes = candles.map(c => Number(c[4]));

    const volumes = candles.map(c => Number(c[5]));

    const latest = closes[closes.length - 1];

    const previousHigh =
      Math.max(...closes.slice(closes.length - 10, closes.length - 1));

    const avgVolume =
      average(volumes.slice(0, volumes.length - 1));

    const latestVolume =
      volumes[volumes.length - 1];

    const breakout =
      latest > previousHigh;

    const volumeSpike =
      latestVolume > avgVolume * 1.8;

    const sma =
      average(closes.slice(closes.length - 10));

    const strongTrend =
      latest > sma;

    const momentum =
      closes[closes.length - 1] >
      closes[closes.length - 3];

    const confidence =
      calculateConfidence({
        breakout,
        volumeSpike,
        strongTrend,
        momentum
      });

    if (confidence < MIN_CONFIDENCE) {

      console.log(
        `${symbol} rejected: confidence ${confidence}`
      );

      return null;

    }

    return {
      symbol,
      confidence,
      price: latest,
      breakout,
      volumeSpike
    };

  } catch (err) {

    console.log(`${symbol} scan fail`);

    return null;

  }

}

// =====================================
// PORTFOLIO ROTATION CHECK
// =====================================

async function portfolioRotationCheck() {

  const ideas = [
    {
      from: "ADA",
      to: "SOL",
      score: 18
    },
    {
      from: "XRP",
      to: "TAO",
      score: 26
    }
  ];

  const best = ideas.sort((a, b) => b.score - a.score)[0];

  if (best.score >= 25) {

    await sendTelegram(

`🔄 PORTFOLIO ROTATION

Switch Idea:
${best.from} ➜ ${best.to}

Opportunity Score: ${best.score}

Reason:
Higher momentum + stronger trend structure`

    );

  }

}

// =====================================
// MAIN SCAN
// =====================================

async function runScanner() {

  console.log("");
  console.log("=== V23 SCAN ===");

  let signals = 0;

  for (const pair of PAIRS) {

    const result = await scanPair(pair);

    if (!result) continue;

    if (!cooldownPassed(pair)) {

      console.log(`${pair} cooldown active`);

      continue;

    }

    alertedPairs[pair] = Date.now();

    signals++;

    await sendTelegram(

`🚨 CRYPTO BREAKOUT

Pair: ${result.symbol}

Confidence: ${result.confidence}

Price: ${result.price}

Breakout: ${result.breakout ? "YES" : "NO"}

Volume Expansion:
${result.volumeSpike ? "YES" : "NO"}

Style:
Swing breakout setup`

    );

    console.log(`${pair} alert sent`);

  }

  console.log(`Signals: ${signals}`);

  await portfolioRotationCheck();

}

// =====================================
// SERVER
// =====================================

app.get("/", (req, res) => {

  res.send("V23 RUNNING");

});

// =====================================
// START
// =====================================

app.listen(PORT, async () => {

  console.log(`Running on ${PORT}`);

  await sendTelegram("✅ V23 sniper online");

  await runScanner();

  setInterval(runScanner, SCAN_INTERVAL);

});
