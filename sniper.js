const fs = require("fs");
const path = require("path");
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const DATA_DIR = process.env.DATA_DIR || ".";
const SIGNAL_FILE = path.join(DATA_DIR, "signals.json");

console.log("Using data dir:", DATA_DIR);

// Ensure storage exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(SIGNAL_FILE)) {
    fs.writeFileSync(SIGNAL_FILE, "[]", "utf8");
}

// =======================
// TELEGRAM
// =======================
async function send(msg) {
    if (!BOT_TOKEN || !CHAT_ID) return;

    try {
        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            {
                chat_id: CHAT_ID,
                text: String(msg)
            }
        );
    } catch (e) {
        console.log("Telegram error:", e.message);
    }
}

// =======================
// LOAD / SAVE
// =======================
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
    try {
        fs.writeFileSync(SIGNAL_FILE, JSON.stringify(signals, null, 2), "utf8");
    } catch (e) {
        console.log("Save error:", e.message);
    }
}

// =======================
// DEDUPE
// =======================
function getSignalKey(s) {
    return `${s.asset}|${s.time}`;
}

function isDuplicate(newSignal, signals) {
    const key = getSignalKey(newSignal);
    return signals.some(s => getSignalKey(s) === key);
}

// =======================
// CREATE SIGNAL
// =======================
async function createSignal(signal) {

    if (
        !signal ||
        !signal.asset ||
        Number.isNaN(Number(signal.entry)) ||
        Number.isNaN(Number(signal.sl)) ||
        Number.isNaN(Number(signal.tp))
    ) {
        console.log("Invalid signal skipped");
        return;
    }

    const signals = loadSignals();

    const enriched = {
        asset: signal.asset,
        entry: Number(signal.entry),
        sl: Number(signal.sl),
        tp: Number(signal.tp),
        confidence: Number(signal.confidence || 0),
        time: Date.now()
    };

    if (isDuplicate(enriched, signals)) {
        console.log("Duplicate skipped:", enriched.asset);
        return;
    }

    signals.push(enriched);

    // keep last 100 signals
    const trimmed = signals.slice(-100);
    saveSignals(trimmed);

    const msg =
        `🚨 SNIPER SIGNAL\n` +
        `${enriched.asset} (${enriched.confidence}%)\n` +
        `Entry: ${enriched.entry}\n` +
        `SL: ${enriched.sl}\n` +
        `TP: ${enriched.tp}`;

    await send(msg);

    console.log("Signal created:", enriched.asset);
}

// =======================
// TEST SIGNAL (REPLACE LATER)
// =======================
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

runSniper();
