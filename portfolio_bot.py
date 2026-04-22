// =======================
// PORTFOLIO BOT V7
// WEEKLY REVIEW - JAVASCRIPT
// =======================

const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DATA_DIR = process.env.DATA_DIR || "./data";
const MAX_SWAPS = Number(process.env.MAX_SWAPS || 2);

const POT_ORDER = ["core", "aggressive", "crypto"];
const POT_LABELS = {
  core: "Pot 1 · Core",
  aggressive: "Pot 2 · Aggressive",
  crypto: "Pot 3 · Crypto"
};

// =======================
// TELEGRAM
// =======================
async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(msg);
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: msg,
        parse_mode: "HTML"
      })
    });

    const data = await res.json();

    if (!data.ok) {
      console.log("Telegram API error:", data);
    }
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

// =======================
// HELPERS
// =======================
function now() {
  return new Date().toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const defaults = {
    "signals.json": [],
    "actions.json": [],
    "trades.json": [],
    "stats.json": {}
  };

  for (const [file, defaultValue] of Object.entries(defaults)) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
    }
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

// =======================
// LOAD DATA
// =======================
function loadTargets() {
  return readJson("./targets.json", {});
}

function loadSignals() {
  return readJson(path.join(DATA_DIR, "signals.json"), []);
}

function buildPots(targets) {
  const pots = {};

  for (const pot of POT_ORDER) {
    const entries = targets[pot] || {};
    const total = Object.values(entries).reduce((sum, value) => sum + value, 0) || 1;

    pots[pot] = Object.entries(entries).map(([ticker, weight]) => ({
      ticker,
      weight,
      pct: Number(((weight / total) * 100).toFixed(1))
    }));
  }

  return pots;
}

function buildSignalMap(signals) {
  const map = {};

  for (const s of signals) {
    const asset = (s.asset || s.ticker || "").toUpperCase();
    if (asset) {
      map[asset] = s;
    }
  }

  return map;
}

// =======================
// SCORING
// =======================
function momentumScore(ticker, weight, signal = {}) {
  const confidence = Number(signal.confidence || 0);
  const volRatio = Number(signal.vol_ratio || signal.volume_ratio || 0);
  const netMove = Number(signal.net_move || signal.netMove || 0);

  const breakout =
    String(signal.breakout || signal.breakout_status || "NO").toUpperCase() === "YES";

  const btcTrend =
    String(signal.btc_trend || signal.btcTrend || "up").toLowerCase();

  let score = 0;

  score += confidence * 0.45;
  score += Math.min(volRatio, 5) * 10;
  score += Math.max(netMove, 0) * 15;

  if (breakout) score += 8;
  if (btcTrend === "up") score += 5;

  // slight penalty for weaker allocations
  score -= Math.max(0, 20 - weight) * 0.35;

  return Number(score.toFixed(1));
}

function classifyHolding(score, weight) {
  if (score >= 82) return "ADD";
  if (score >= 70) return "HOLD";
  if (score >= 56) return "REVIEW";
  if (weight >= 20) return "TRIM";
  return "EXIT";
}

function findReplacement(weakHolding, heldTickers, strongCandidates) {
  for (const candidate of strongCandidates) {
    if (!heldTickers.has(candidate.ticker) && candidate.score >= weakHolding.score + 12) {
      return candidate;
    }
  }
  return null;
}

// =======================
// WEEKLY REVIEW
// =======================
function weeklyReview() {
  const targets = loadTargets();
  const signals = loadSignals();
  const signalMap = buildSignalMap(signals);
  const pots = buildPots(targets);

  const allHeld = new Set();
  const ranked = [];

  for (const potName of POT_ORDER) {
    for (const item of pots[potName] || []) {
      allHeld.add(item.ticker);

      const signal = signalMap[item.ticker.toUpperCase()] || {};
      const score = momentumScore(item.ticker, item.weight, signal);
      const action = classifyHolding(score, item.weight);

      ranked.push({
        pot: potName,
        ticker: item.ticker,
        weight: item.weight,
        pct: item.pct,
        score,
        action,
        signal
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score);

  const weakHoldings = ranked
    .filter(x => ["REVIEW", "TRIM", "EXIT"].includes(x.action))
    .sort((a, b) => a.score - b.score);

  const strongCandidates = ranked.filter(x => x.action === "ADD");

  const report = [];
  const actions = [];

  report.push("<b>🗓 WEEKLY PORTFOLIO REVIEW</b>");
  report.push(`<i>${now()}</i>`);
  report.push("");

  for (const potName of POT_ORDER) {
    report.push(`<b>${POT_LABELS[potName]}</b>`);

    const potRows = ranked.filter(r => r.pot === potName);
    for (const row of potRows) {
      report.push(`• ${row.ticker} — ${row.action} · score ${row.score} · ${row.pct}%`);
    }

    report.push("");
  }

  for (const weak of weakHoldings.slice(0, MAX_SWAPS)) {
    const replacement = findReplacement(weak, allHeld, strongCandidates);

    if (replacement) {
      actions.push(
        `🔁 SWAP ${weak.ticker} → ${replacement.ticker}
` +
        `OUT: ${weak.action} score ${weak.score}
` +
        `IN: ${replacement.action} score ${replacement.score}`
      );
    } else {
      actions.push(
        `⚠️ ${weak.ticker} ${weak.action} score ${weak.score} — no clear replacement yet`
      );
    }
  }

  if (!actions.length) {
    actions.push("No swap-worthy stagnation found this week.");
  }

  fs.writeFileSync(
    path.join(DATA_DIR, "actions.json"),
    JSON.stringify(actions, null, 2)
  );

  return `${report.join("
")}
${actions.join("

")}`;
}

// =======================
// RUN
// =======================
async function run() {
  ensureFiles();

  const targets = loadTargets();
  if (!targets || !Object.keys(targets).length) {
    console.log("targets.json missing or empty");
    return;
  }

  const message = weeklyReview();
  console.log(message);
  await send(message);
}

run().catch(err => {
  console.error("Portfolio bot error:", err);
});
