const fs = require("fs");
const path = require("path");
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const DATA_DIR = process.env.DATA_DIR || ".";
const SIGNAL_FILE = path.join(DATA_DIR, "signals.json");

console.log("Using data dir:", DATA_DIR);

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(SIGNAL_FILE)) {
  fs.writeFileSync(SIGNAL_FILE, "[]", "utf8");
}

function londonTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replace(",", "") + " UK";
}

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("Missing BOT_TOKEN or CHAT_ID");
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: String(msg),
        disable_web_page_preview: true,
      },
      { timeout: 20000 }
    );
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

function loadSignals() {
  try {
    const raw = fs.readFileSync(SIGNAL_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.log("Could not load signals, using empty list");
    return [];
  }
}

function saveSignals(signals) {
  fs.writeFileSync(
    SIGNAL_FILE,
    JSON.stringify(signals, null, 2).trim() + "
",
    "utf8"
  );
}

function normalize(asset) {
  return String(asset || "")
    .trim()
    .toUpperCase()
    .replace(/s+/g, "")
    .replace(/USDT$/, "");
}

function signalKey(signal) {
  return [
    normalize(signal.asset),
    Number(signal.entry),
    Number(signal.sl),
    Number(signal.tp),
  ].join("|");
}

function isDuplicate(newSignal, signals) {
  const now = Date.now();

  return signals.some((s) => {
    const sameKey = signalKey(s) === signalKey(newSignal);
    const signalTime = Number(s.time || 0);
    const recent = now - signalTime < 60 * 60 * 1000;
    return sameKey && recent;
  });
}

function validateSignal(signal) {
  const asset = normalize(signal.asset);
  const entry = Number(signal.entry);
  const sl = Number(signal.sl);
  const tp = Number(signal.tp);
  const confidence = Number(signal.confidence || 0);

  if (!asset) return null;
  if ([entry, sl, tp, confidence].some((v) => Number.isNaN(v))) return null;

  return {
    asset,
    entry,
    sl,
    tp,
    confidence,
    time: Date.now(),
    time_uk: londonTime(),
  };
}

async function createSignal(signal) {
  const enriched = validateSignal(signal);

  if (!enriched) {
    console.log("Invalid signal skipped");
    return;
  }

  const signals = loadSignals();

  if (isDuplicate(enriched, signals)) {
    console.log("Duplicate skipped:", enriched.asset);
    return;
  }

  signals.push(enriched);
  saveSignals(signals.slice(-100));

  const lines = [
    "🚨 SNIPER SIGNAL",
    enriched.time_uk,
    "",
    `${enriched.asset} (${enriched.confidence}%)`,
    `Entry: ${enriched.entry}`,
    `SL: ${enriched.sl}`,
    `TP: ${enriched.tp}`,
  ];

  const msg = lines.map((line) => String(line).trimEnd()).join("
").trim();

  await send(msg);
  console.log("Signal created:", enriched.asset);
}

async function runSniper() {
  console.log("🔎 Sniper active — scanning stocks + crypto");

  await createSignal({
    asset: "SOLUSDT",
    entry: 142,
    sl: 135,
    tp: 165,
    confidence: 82,
  });
}

runSniper().catch((e) => {
  console.error("Fatal sniper error:", e);
});
