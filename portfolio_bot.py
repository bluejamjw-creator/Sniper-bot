// ==========================================================
// PORTFOLIO V9 — STRATEGIC ALLOCATION ENGINE
// Independent strategic portfolio intelligence system
// Works ALONGSIDE Sniper — NOT dependent on it
// ==========================================================

console.log("🧠 PORTFOLIO V9 STARTING...");

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const ws = require("ws");
const { createClient } = require("@supabase/supabase-js");

// ==========================================================
// ENV
// ==========================================================

const BOT_TOKEN            = process.env.BOT_TOKEN || "";
const CHAT_ID              = process.env.CHAT_ID || "";

const SUPABASE_URL         = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const DATA_DIR = process.env.DATA_DIR || "./data";

const supabaseEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      realtime: { transport: ws }
    })
  : null;

// ==========================================================
// FILES
// ==========================================================

const FILES = {
  targets: path.join(DATA_DIR, "targets.json"),
  signals: path.join(DATA_DIR, "signals.json"),
  trades: path.join(DATA_DIR, "trades.json"),

  portfolio: path.join(DATA_DIR, "portfolio_state.json"),
  actions: path.join(DATA_DIR, "portfolio_actions.json"),
  regime: path.join(DATA_DIR, "market_regime.json"),
  themes: path.join(DATA_DIR, "theme_strength.json"),
  leadership: path.join(DATA_DIR, "leadership.json"),
  health: path.join(DATA_DIR, "system_status.json")
};

// ==========================================================
// CONFIG
// ==========================================================

const REVIEW_INTERVAL_MS = 1000 * 60 * 60 * 6;

const MAX_POSITION = 35;
const MIN_POSITION = 3;

const REGIMES = {
  RISK_ON: "RISK_ON",
  RISK_OFF: "RISK_OFF",
  INFRASTRUCTURE: "INFRASTRUCTURE",
  SPECULATIVE: "SPECULATIVE"
};

// ==========================================================
// CORE PORTFOLIOS
// ==========================================================

const PORTFOLIOS = {
  B: {
    GEV: 28,
    AMAT: 18,
    ETN: 16,
    AVAV: 12,
    NVDA: 8,
    AVGO: 6,
    ASTS: 5,
    IONQ: 4,
    CIEN: 3
  },

  C: {
    ETH: 35,
    SOL: 25,
    LINK: 25,
    BTC: 10,
    TAO: 5
  }
};

// ==========================================================
// HELPERS
// ==========================================================

function ensureFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const defaults = {
    [FILES.actions]: [],
    [FILES.portfolio]: {},
    [FILES.regime]: {},
    [FILES.themes]: [],
    [FILES.leadership]: [],
    [FILES.health]: {}
  };

  for (const [file, value] of Object.entries(defaults)) {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(value, null, 2));
    }
  }
}

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  if (typeof data !== "object") {
    throw new Error(`INVALID SAVE ${file}`);
  }

  const temp = `${file}.tmp`;

  fs.writeFileSync(temp, JSON.stringify(data, null, 2));

  fs.renameSync(temp, file);

  console.log(`✅ Saved ${path.basename(file)}`);
}

function nowIso() {
  return new Date().toISOString();
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ==========================================================
// TELEGRAM
// ==========================================================

async function send(msg) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(msg);
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: msg,
        parse_mode: "HTML"
      }
    );
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

// ==========================================================
// LOAD SIGNALS
// ==========================================================

function loadSignals() {
  return readJson(FILES.signals, []);
}

function loadTrades() {
  return readJson(FILES.trades, []);
}

// ==========================================================
// REGIME ENGINE
// ==========================================================

function detectRegime(signals) {
  const avgScore = avg(signals.map(x => x.score || 0));

  const infraCount = signals.filter(x =>
    ["GEV", "ETN", "VRT", "AMAT", "KLAC", "LRCX"].includes(x.asset)
  ).length;

  const speculativeCount = signals.filter(x =>
    ["IONQ", "ASTS", "TAO", "ACHR"].includes(x.asset)
  ).length;

  if (avgScore < 75) {
    return REGIMES.RISK_OFF;
  }

  if (infraCount > speculativeCount) {
    return REGIMES.INFRASTRUCTURE;
  }

  if (speculativeCount >= infraCount) {
    return REGIMES.SPECULATIVE;
  }

  return REGIMES.RISK_ON;
}

// ==========================================================
// THEME ENGINE
// ==========================================================

function buildThemes(signals) {
  const themes = {
    AI_INFRA: 0,
    POWER_GRID: 0,
    DEFENSE_AUTONOMY: 0,
    QUANTUM: 0,
    TOKENIZATION: 0
  };

  for (const s of signals) {
    const asset = s.asset || "";

    if (["NVDA","AMAT","KLAC","LRCX","AVGO"].includes(asset)) {
      themes.AI_INFRA += s.score || 0;
    }

    if (["GEV","ETN","VRT"].includes(asset)) {
      themes.POWER_GRID += s.score || 0;
    }

    if (["AVAV","PLTR"].includes(asset)) {
      themes.DEFENSE_AUTONOMY += s.score || 0;
    }

    if (["IONQ"].includes(asset)) {
      themes.QUANTUM += s.score || 0;
    }

    if (["ETH","SOL","LINK","COIN"].includes(asset)) {
      themes.TOKENIZATION += s.score || 0;
    }
  }

  return Object.entries(themes)
    .map(([theme, score]) => ({
      theme,
      score: Number(score.toFixed(1))
    }))
    .sort((a, b) => b.score - a.score);
}

// ==========================================================
// LEADERSHIP ENGINE
// ==========================================================

function buildLeadership(signals) {
  return signals
    .map(s => ({
      ticker: s.asset,
      leadershipScore:
        (s.score || 0) +
        ((s.volRatio || 0) * 3) +
        ((s.momentum || 0) * 100)
    }))
    .sort((a, b) => b.leadershipScore - a.leadershipScore)
    .slice(0, 15);
}

// ==========================================================
// PORTFOLIO SCORING
// ==========================================================

function scoreHolding(ticker, signals, regime) {
  const signal = signals.find(s => s.asset === ticker);

  if (!signal) {
    return 40;
  }

  let score = signal.score || 50;

  if (regime === REGIMES.INFRASTRUCTURE) {
    if (["GEV","ETN","AMAT","AVGO","VRT"].includes(ticker)) {
      score += 10;
    }
  }

  if (regime === REGIMES.RISK_OFF) {
    if (["IONQ","ASTS","TAO"].includes(ticker)) {
      score -= 12;
    }
  }

  if ((signal.volRatio || 0) > 2) {
    score += 5;
  }

  if ((signal.momentum || 0) > 0.02) {
    score += 5;
  }

  return Math.round(score);
}

// ==========================================================
// ACTION ENGINE
// ==========================================================

function determineAction(score) {
  if (score >= 90) return "STRONG ADD";
  if (score >= 82) return "ADD";
  if (score >= 70) return "HOLD";
  if (score >= 58) return "REVIEW";
  return "REDUCE";
}

// ==========================================================
// REVIEW ENGINE
// ==========================================================

function runReview() {
  const signals = loadSignals();

  const regime = detectRegime(signals);

  const themes = buildThemes(signals);

  const leadership = buildLeadership(signals);

  const actions = [];

  for (const [portfolioName, holdings] of Object.entries(PORTFOLIOS)) {
    for (const [ticker, weight] of Object.entries(holdings)) {

      const score = scoreHolding(
        ticker,
        signals,
        regime
      );

      const action = determineAction(score);

      actions.push({
        portfolio: portfolioName,
        ticker,
        weight,
        score,
        action
      });
    }
  }

  const health = {
    lastRun: nowIso(),
    signalsLoaded: signals.length,
    regime,
    topTheme: themes[0]?.theme || "NONE",
    topLeader: leadership[0]?.ticker || "NONE"
  };

  writeJson(FILES.actions, actions);
  writeJson(FILES.regime, { regime });
  writeJson(FILES.themes, themes);
  writeJson(FILES.leadership, leadership);
  writeJson(FILES.health, health);

  return {
    regime,
    themes,
    leadership,
    actions,
    health
  };
}

// ==========================================================
// TELEGRAM REPORT
// ==========================================================

function buildReport(data) {
  const lines = [];

  lines.push("🧠 <b>PORTFOLIO V9 REVIEW</b>");
  lines.push("");

  lines.push(`📡 Regime: <b>${data.regime}</b>`);
  lines.push(`🔥 Top Theme: <b>${data.themes[0]?.theme || "NONE"}</b>`);
  lines.push(`👑 Leader: <b>${data.leadership[0]?.ticker || "NONE"}</b>`);

  lines.push("");

  lines.push("<b>📊 PORTFOLIO ACTIONS</b>");

  for (const action of data.actions) {
    lines.push(
      `• ${action.ticker} — ${action.action} ` +
      `(${action.score}) ` +
      `| ${action.weight}%`
    );
  }

  lines.push("");

  lines.push("<b>⚡ THEMES</b>");

  for (const t of data.themes.slice(0, 5)) {
    lines.push(`• ${t.theme} — ${t.score}`);
  }

  return lines.join("\n");
}

// ==========================================================
// SUPABASE SYNC
// ==========================================================

async function syncSupabase(data) {
  if (!supabaseEnabled) return;

  try {
    await supabase
      .from("portfolio_reviews")
      .insert([
        {
          created_at: nowIso(),
          regime: data.regime,
          top_theme: data.themes[0]?.theme || null,
          top_leader: data.leadership[0]?.ticker || null,
          actions: data.actions
        }
      ]);

    console.log("✅ Supabase sync OK");

  } catch (e) {
    console.log("❌ Supabase sync failed:", e.message);
  }
}

// ==========================================================
// MAIN LOOP
// ==========================================================

async function runCycle() {

  try {

    console.log("🔄 Running V9 review...");

    const data = runReview();

    const report = buildReport(data);

    console.log(report);

    await send(report);

    await syncSupabase(data);

  } catch (e) {

    console.log("❌ V9 ERROR:", e.message);

    await send(
      `❌ PORTFOLIO V9 ERROR\n${e.message}`
    );
  }
}

// ==========================================================
// BOOT
// ==========================================================

ensureFiles();

(async () => {

  console.log("🚀 PORTFOLIO V9 LIVE");

  await send(
    "🧠🚀 PORTFOLIO V9 LIVE\n" +
    "Strategic allocation engine active"
  );

  await runCycle();

  setInterval(async () => {
    await runCycle();
  }, REVIEW_INTERVAL_MS);

})();
