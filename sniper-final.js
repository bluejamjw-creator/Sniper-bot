index.js
const https = require("https");

// ================= SETTINGS =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;

const ACCOUNT_SIZE = 1000;
const RISK_PCT     = 0.02;
const CRYPTO_EVERY = 3;   // faster scans
const STOCK_EVERY  = 15;
const COOLDOWN_MIN = 60;

// Safety check
if (!BOT_TOKEN || !CHAT_ID) {
  console.log("❌ BOT TOKEN / CHAT ID NOT SET");
}

// ================= WATCHLIST =================
const CRYPTO = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT"];
const STOCKS = ["AAPL","TSLA","NVDA","MSFT","AMZN","GOOGL"];

// ================= HELPERS =================
function sendTelegram(text) {
  const data = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    parse_mode: "Markdown"
  });

  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": data.length
    }
  });

  req.write(data);
  req.end();
}

function positionSize(entry, stop) {
  const risk = Math.abs(entry - stop);
  if (!risk) return 0;
  return ((ACCOUNT_SIZE * RISK_PCT) / risk).toFixed(2);
}

// ================= SIMPLE SCANNER =================
async function fakeSignal(asset, type) {
  const price = Math.random() * 100 + 100;

  const entry = price * 1.002;
  const stop  = entry * 0.98;
  const tp    = entry * 1.05;

  return {
    asset,
    entry,
    stop,
    tp,
    rr: "1:2",
    size: positionSize(entry, stop),
    type
  };
}

// ================= BUILD MESSAGE =================
function buildMsg(s) {
  return `🚨 *${s.type} ALERT — ${s.asset}*

💰 Entry: $${s.entry.toFixed(2)}
🛑 Stop:  $${s.stop.toFixed(2)}
🎯 TP:    $${s.tp.toFixed(2)}

📊 R:R = ${s.rr}
💵 Size: ${s.size}

⭐ Rating: ⭐⭐⭐⭐

🕐 ${new Date().toUTCString()}`;
}

// ================= RUN =================
async function runCrypto() {
  for (let c of CRYPTO) {
    const s = await fakeSignal(c, "CRYPTO");
    sendTelegram(buildMsg(s));
  }
}

async function runStocks() {
  for (let s of STOCKS) {
    const sig = await fakeSignal(s, "STOCK");
    sendTelegram(buildMsg(sig));
  }
}

// ================= START =================
async function main() {
  console.log("🚀 SNIPER BOT LIVE");

  sendTelegram("✅ Sniper Bot is LIVE");

  runCrypto();
  runStocks();

  setInterval(runCrypto, CRYPTO_EVERY * 60000);
  setInterval(runStocks, STOCK_EVERY * 60000);
}

main();
