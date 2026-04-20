const fs = require("fs");
const path = require("path");
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DATA_DIR = process.env.DATA_DIR || ".";
const SIGNAL_FILE = path.join(DATA_DIR, "signals.json");

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SIGNAL_FILE)) fs.writeFileSync(SIGNAL_FILE, "[]", "utf8");
}

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: String(msg)
    });
  } catch (e) {
    console.log("Telegram error:", e.response?.data || e.message);
  }
}

function loadSignals() {
  try {
    const raw = fs.readFileSync(SIGNAL_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveSignals(signals) {
  fs.writeFileSync(SIGNAL_FILE, JSON.stringify(signals, null, 2), "utf8");
}

function normalizeAsset(asset) {
  return String(asset || "")
    .trim()
    .toUpperCase()
    .replace(/s+/g, "")
    .replace(/USDT$/i, "");
}

function getSignalKey(s) {
  return `${normalizeAsset(s.asset)}|${Number(s.entry)}|${Number(s.sl)}|${Number(s.tp)}`;
}

function isDuplicate(newSignal, signals) {
  const key = getSignalKey(newSignal);
  return signals.some(s => getSignalKey(s) === key);
}

function validateSignal(signal) {
  if (!signal || !signal.asset) return false;

  const entry = Number(signal.entry);
  const sl = Number(signal.sl);
  const tp = Number(signal.tp);
  const confidence = Number(signal.confidence ?? 0);

  if ([entry, sl, tp, confidence].some(Number.isNaN)) return false;
  if (entry <= 0 || sl <= 0 || tp <= 0) return false;
  if (sl >= entry || tp <= entry) return false;

  return true;
}

async function createSignal(signal) {
  if (!validateSignal(signal)) {
    console.log("Invalid signal skipped");
    return;
  }

  const signals = loadSignals();
  const enriched = {
    asset: normalizeAsset(signal.asset),
    entry: Number(signal.entry),
    sl: Number(signal.sl),
    tp: Number(signal.tp),
    confidence: Number(signal.confidence ?? 0),
    time: Date.now()
  };

  if (isDuplicate(enriched, signals)) {
    console.log("Duplicate skipped:", enriched.asset);
    return;
  }

  signals.push(enriched);
  saveSignals(signals.slice(-100));

  const msg =
    `🚨 SNIPER SIGNAL
` +
    `${enriched.asset} (${enriched.confidence}%)
` +
    `Entry: ${enriched.entry}
` +
    `SL: ${enriched.sl}
` +
    `TP: ${enriched.tp}`;

  await send(msg);
  console.log("Signal created:", enriched.asset);
}

async function runSniper() {
  console.log("Sniper running...");
  const exampleSignal = {
    asset: "SOLUSDT",
    entry: 142,
    sl: 135,
    tp: 165,
    confidence: 82
  };
  await createSignal(exampleSignal);
}

async function main() {
  try {
    ensureStorage();
    await runSniper();
  } catch (e) {
    console.error("Fatal sniper error:", e.stack || e.message || e);
    process.exitCode = 1;
  }
}

main();
