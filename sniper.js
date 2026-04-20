const fs = require("fs");
const path = require("path");
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const DATA_DIR = process.env.DATA_DIR || ".";
const SIGNAL_FILE = path.join(DATA_DIR, "signals.json");

console.log("Using data dir:", DATA_DIR);

// Ensure storage exists
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(SIGNAL_FILE)) {
  fs.writeFileSync(SIGNAL_FILE, "[]", "utf8");
}

// ------------------
// TELEGRAM
// ------------------
async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: String(msg),
      }
    );
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

// ------------------
// STORAGE
// ------------------
function loadSignals() {
  try {
    return JSON.parse(fs.readFileSync(SIGNAL_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSignals(signals) {
  fs.writeFileSync(SIGNAL_FILE, JSON.stringify(signals, null, 2), "utf8");
}

// ------------------
// HELPERS
// ------------------
function normalize(asset) {
  return String(asset || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/USDT$/, "");
}

function getKey(s) {
  return `${normalize(s.asset)}|${s.entry}|${s.sl}|${s.tp}`;
}

function isDuplicate(newSignal, signals) {
  const now = Date.now();

  return signals.some((s) => {
    const same = getKey(s) === getKey(newSignal);
    const recent = now - s.time < 3600000; // 1 hour
    return same && recent;
  });
}

// ------------------
// CREATE SIGNAL
// ------------------
async function createSignal(signal) {
  const entry = Number(signal.entry);
  const sl = Number(signal.sl);
  const tp = Number(signal.tp);

  if (!signal.asset || [entry, sl, tp].some(isNaN)) {
    console.log("Invalid signal");
    return;
  }

  const signals = loadSignals();

  const enriched = {
    asset: normalize(signal.asset),
    entry,
    sl,
    tp,
    confidence: Number(signal.confidence || 0),
    time: Date.now(),
  };

  if (isDuplicate(enriched, signals)) {
    console.log("Duplicate skipped");
    return;
  }

  signals.push(enriched);
  saveSignals(signals.slice(-100));

  const msg =
    `🚨 SNIPER SIGNAL\n` +
    `${enriched.asset} (${enriched.confidence}%)\n` +
    `Entry: ${entry}\nSL: ${sl}\nTP: ${tp}`;

  await send(msg);
  console.log("Signal created:", enriched.asset);
}

// ------------------
// RUN
// ------------------
async function runSniper() {
  console.log("Sniper running...");

  // TEST SIGNAL (replace later)
  await createSignal({
    asset: "SOLUSDT",
    entry: 142,
    sl: 135,
    tp: 165,
    confidence: 82,
  });
}

runSniper();
