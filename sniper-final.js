const https = require("https");
const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SCAN_INTERVAL = 5 * 60 * 1000;
const SIGNAL_FILE = "signals.json";
const TTL = 4 * 60 * 60 * 1000;

const STOCKS = [
  "NVDA", "AMD", "TSLA", "META", "AAPL", "MSFT", "AMZN",
  "PLTR", "COIN", "MSTR", "SMCI", "ARM", "IONQ", "APP",
  "GOOGL", "NFLX", "SNOW", "CRWD", "ZS", "SHOP"
];

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("Telegram disabled: BOT_TOKEN or CHAT_ID missing");
    return;
  }

  const body = JSON.stringify({ chat_id: CHAT_ID, text: text });

  const req = https.request({
    hostname: "api.telegram.org",
    path: "/bot" + BOT_TOKEN + "/sendMessage",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  });

  req.on("error", function (err) {
    console.error("Telegram error:", err.message);
  });

  req.write(body);
  req.end();
}

let lastHeartbeatDay = null;
let lastSentSignal = null;

function sendHeartbeat() {
  const day = new Date().toDateString();
  if (day !== lastHeartbeatDay) {
    sendTelegram("Sniper active - scanning " + STOCKS.length + " stocks + crypto");
    lastHeartbeatDay = day;
  }
}

function httpGet(url, timeoutMs, retries) {
  if (timeoutMs === undefined) timeoutMs = 8000;
  if (retries === undefined) retries = 2;

  return new Promise(function (resolve) {
    function attempt(n) {
      let u;
      try {
        u = new URL(url);
      } catch (e) {
        if (n < retries) return setTimeout(function () { attempt(n + 1); }, 500 * (n + 1));
        resolve(null);
        return;
      }

      const req = https.get({
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: timeoutMs
      }, function (res) {
        let data = "";
        res.on("data", function (c) {
          data += c;
        });
        res.on("end", function () {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            if (n < retries) return setTimeout(function () { attempt(n + 1); }, 500 * (n + 1));
            resolve(null);
          }
        });
      });

      req.on("timeout", function () {
        req.destroy(new Error("timeout"));
      });

      req.on("error", function () {
        if (n < retries) return setTimeout(function () { attempt(n + 1); }, 500 * (n + 1));
        resolve(null);
      });
    }

    attempt(0);
  });
}

function ema(arr, p) {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let val = arr.slice(0, p).reduce(function (a, b) { return a + b; }, 0) / p;
  for (let i = p; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
  }
  return val;
}

function atr(c, p) {
  if (p === undefined) p = 14;
  if (c.length < p + 1) return null;

  const trs = [];
  for (let i = 1; i < c.length; i++) {
    const prev = c[i - 1];
    const curr = c[i];
    trs.push(Math.max(
      curr.h - curr.l,
      Math.abs(curr.h - prev.c),
      Math.abs(curr.l - prev.c)
    ));
  }

  return trs.slice(-p).reduce(function (a, b) { return a + b; }, 0) / p;
}

function resistanceZone(highs) {
  let best = { level: 0, count: 0 };

  for (const h of highs) {
    const cluster = highs.filter(function (x) {
      return Math.abs(x - h) / h < 0.006;
    });

    if (cluster.length > best.count) {
      best = {
        level: cluster.reduce(function (a, b) { return a + b; }, 0) / cluster.length,
        count: cluster.length
      };
    }
  }

  return best;
}

async function getStockCandles(sym) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + sym + "?interval=1h&range=1mo";
  const d = await httpGet(url);

  const r = d && d.chart && d.chart.result && d.chart.result[0];
  if (!r || !r.indicators || !r.indicators.quote || !r.indicators.quote[0]) return null;

  const q = r.indicators.quote[0];
  const candles = [];

  for (let i = 0; i < ((q.close && q.close.length) || 0); i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null) continue;
    candles.push({
      o: q.open && q.open[i] != null ? q.open[i] : q.close[i],
      h: q.high[i],
      l: q.low[i],
      c: q.close[i],
      v: q.volume && q.volume[i] != null ? q.volume[i] : 0
    });
  }

  return candles.length > 50 ? candles : null;
}

async function getPairs() {
  const d = await httpGet("https://api.binance.com/api/v3/ticker/24hr");

  if (!Array.isArray(d)) {
    console.log("Binance returned invalid pairs data, using fallback list");
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
  }

  return d
    .filter(function (x) {
      return x && typeof x.symbol === "string" && x.symbol.endsWith("USDT") && typeof x.quoteVolume !== "undefined";
    })
    .sort(function (a, b) {
      return parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume);
    })
    .slice(0, 50)
    .map(function (x) {
      return x.symbol;
    });
}

function runAnalysis(c, sym, type, mode) {
  const closes = c.map(function (x) { return x.c; });
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);

  if (!e50 || !e200) return null;
  if (!(closes[closes.length - 1] > e50 && e50 > e200)) return null;

  const highs = c.slice(-40).map(function (x) { return x.h; });
  const zone = resistanceZone(highs);
  const level = zone.level;
  const count = zone.count;

  const last = c[c.length - 1];
  const prev = c.slice(-41, -1);
  if (!last || prev.length === 0) return null;

  const avgVol = prev.reduce(function (a, x) { return a + x.v; }, 0) / prev.length;
  const body = (last.c - last.o) / ((last.h - last.l) || 1);

  if (mode === "elite") {
    if (count < 5) return null;
    if (!(last.c > level && last.v > avgVol * (type === "crypto" ? 2.5 : 2.2))) return null;
    if (body < 0.5) return null;
  }

  if (mode === "trade") {
    if (count < 3) return null;
    if (!(last.c > level && last.v > avgVol * 1.5)) return null;
  }

  const a = atr(c.slice(-30));
  const sl = a ? last.c - 1.5 * a : last.c * 0.97;
  const tp = a ? last.c + 3 * a : last.c * 1.06;

  const confidence = Math.min(100, Math.round(
    (Math.min(count, 6) / 6) * 40 +
    (Math.min(last.v / avgVol, 4) / 4) * 40 +
    body * 20
  ));

  return {
    type: type,
    asset: sym,
    entry: last.c,
    sl: +sl.toFixed(4),
    tp: +tp.toFixed(4),
    touches: count,
    volRatio: +(last.v / avgVol).toFixed(2),
    mode: mode,
    confidence: confidence,
    time: Date.now()
  };
}

async function analyseCrypto(sym, mode) {
  const raw = await httpGet("https://api.binance.com/api/v3/klines?symbol=" + sym + "&interval=1h&limit=220");

  if (!Array.isArray(raw) || raw.length < 200) return null;

  const c = raw.map(function (k) {
    return {
      o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]
    };
  });

  return runAnalysis(c, sym, "crypto", mode);
}

async function analyseStock(sym) {
  const c = await getStockCandles(sym);
  if (!c) return null;
  return runAnalysis(c, sym, "stock", "elite");
}

function loadSignals() {
  try {
    const data = JSON.parse(fs.readFileSync(SIGNAL_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function saveSignal(sig) {
  let data = loadSignals();
  data = data.filter(function (x) {
    return Date.now() - x.time < TTL;
  });

  if (data.find(function (x) { return x.asset === sig.asset; })) return false;

  data.push(sig);
  fs.writeFileSync(SIGNAL_FILE, JSON.stringify(data, null, 2));
  return true;
}

function formatSignal(s, i) {
  return "SIGNAL #" + i + " " + s.asset + "
" +
    "Entry: " + s.entry + "
" +
    "SL: " + s.sl + "
" +
    "TP: " + s.tp + "
" +
    "Confidence: " + s.confidence + "%";
}

async function scan() {
  try {
    console.log("Scan running...");
    sendHeartbeat();

    const pairs = await getPairs();
    const results = [];

    for (const p of pairs) {
      try {
        const e = await analyseCrypto(p, "elite");
        if (e) {
          results.push(e);
          continue;
        }

        const t = await analyseCrypto(p, "trade");
        if (t) results.push(t);
      } catch (err) {
        console.error("Crypto analysis failed for", p, err && err.message ? err.message : err);
      }

      await sleep(100);
    }

    for (const s of STOCKS) {
      try {
        const e = await analyseStock(s);
        if (e) results.push(e);
      } catch (err) {
        console.error("Stock analysis failed for", s, err && err.message ? err.message : err);
      }

      await sleep(100);
    }

    if (!results.length) {
      console.log("No signals.");
      return;
    }

    results.sort(function (a, b) {
      return (b.confidence + (b.mode === "elite" ? 30 : 0)) - (a.confidence + (a.mode === "elite" ? 30 : 0));
    });

    const top = results.filter(function (x) {
      return x.confidence >= 75;
    }).slice(0, 1);

    for (let i = 0; i < top.length; i++) {
      const sig = top[i];
      if (saveSignal(sig)) {
        if (sig.asset !== lastSentSignal) {
          sendTelegram(formatSignal(sig, i + 1));
          lastSentSignal = sig.asset;
        }
        console.log("Sent:", sig.asset);
      }
    }
  } catch (err) {
    console.error("Scan crashed:", err && err.stack ? err.stack : err);
  }
}

async function run() {
  console.log("Sniper started");

  if (!fs.existsSync(SIGNAL_FILE)) {
    fs.writeFileSync(SIGNAL_FILE, "[]");
  }

  await scan();
  setInterval(scan, SCAN_INTERVAL);
}

run().catch(function (err) {
  console.error("Fatal startup error:", err && err.stack ? err.stack : err);
  process.exit(1);
});
