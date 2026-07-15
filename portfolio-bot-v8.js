// ============================================================
// HUNTER PORTFOLIO MANAGER v2
// Separate Railway service — never modifies portfolio-bot-v8.js
//
// No fixed universe. Follows the money via:
//   - FMP most-active + biggest-gainers (quality filtered)
//   - FMP stock news (catalyst confirmation)
//   - FMP crypto news
//   - Hunter leaderboard history (momentum confirmation)
//   - Finnhub (additional news context)
//
// Three outputs — all to Bluejam only (personal):
//   1. Stock Portfolio  — ADD / HOLD / REMOVE (weeks/months)
//   2. Stock Trades     — BUY / SELL (within week)
//   3. Crypto Trades    — BUY / SELL (24/7, 48-72hr holds)
// ============================================================

'use strict';
const https = require('https');

// ── Environment ───────────────────────────────────────────────
const ENV = {
  BOT_TOKEN:            process.env.BOT_TOKEN,
  BLUEJAM_CHAT_ID:      process.env.BLUEJAM_CHAT_ID,
  SUPABASE_URL:         process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY
                      || process.env.SUPABASE_SERVICE_ROLE_KEY
                      || process.env.SUPABASE_ANON_KEY,
  FMP_API_KEY:          process.env.FMP_API_KEY,
  FINNHUB_API_KEY:      process.env.FINNHUB_API_KEY,
};

// ── Config ────────────────────────────────────────────────────
const CONFIG = {
  // Quality filters for FMP gainers/active list
  MIN_PRICE:            20,      // ignore penny stocks
  MIN_MARKET_CAP:       1e9,     // $1B+ market cap (applied where available)
  MIN_VOLUME:           500000,  // 500k+ daily volume
  MAX_PCT_FROM_HIGH:    20,      // within 20% of 52-week high for portfolio
  MAX_PCT_FROM_HIGH_TRADE: 30,   // within 30% for trades

  // Stock portfolio thresholds
  PORTFOLIO_MIN_CHANGE: 3.0,     // +3% today minimum
  PORTFOLIO_MIN_HUNTER: 55,      // Hunter avg score if in leaderboard

  // Stock trade thresholds
  TRADE_MIN_CHANGE:     5.0,     // +5% today for trade alert
  TRADE_MAX_CHANGE:     25.0,    // cap — above 25% likely penny spike

  // Crypto thresholds
  CRYPTO_MIN_SCORE:     62,
  CRYPTO_MIN_RANK:      5,

  // ETF/fund keywords to exclude
  EXCLUDE_KEYWORDS: [
    'ETF','Fund','Trust','Bear','Bull','Short','2X','3X',
    'ProShares','Direxion','GraniteShares','iShares',
    'SPDR','Warrant','Rights','Acquisition Corp',
  ],

  // Hunter crypto universe (still needed for leaderboard lookup)
  CORE_CRYPTO: [
    'BTCUSDT','ETHUSDT','SOLUSDT','TAOUSDT','FETUSDT',
    'ONDOUSDT','LINKUSDT','MORPHOUSDT','PENDLEUSDT','AAVEUSDT',
    'AVAXUSDT','XRPUSDT','TIAUSDT','SUIUSDT','SEIUSDT',
    'INJUSDT','NEARUSDT','TONUSDT','HYPEUSDT','JUPUSDT',
    'ENAUSDT','ZROUSDT','GRASSUSDT','HBARUSDT','QNTUSDT'
  ],
};

// ── Logging ───────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function round2(v) { return Math.round(v * 100) / 100; }

// ── HTTP ──────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Supabase ──────────────────────────────────────────────────
async function sbGet(path) {
  const url  = `${ENV.SUPABASE_URL}/rest/v1/${path}`;
  const data = await httpGet(url, {
    'apikey': ENV.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
  });
  try { return JSON.parse(data); } catch { return null; }
}

async function sbUpsert(table, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url     = new URL(`${ENV.SUPABASE_URL}/rest/v1/${table}`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname,
      method: 'POST',
      headers: {
        'apikey': ENV.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sbPatch(table, filter, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url     = new URL(`${ENV.SUPABASE_URL}/rest/v1/${table}?${filter}`);
    const req = https.request({
      hostname: url.hostname, path: `${url.pathname}?${filter}`,
      method: 'PATCH',
      headers: {
        'apikey': ENV.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Telegram ──────────────────────────────────────────────────
async function sendTelegram(text, chatId) {
  if (!ENV.BOT_TOKEN || !chatId) return;
  try {
    const body = JSON.stringify({ chat_id: chatId, text });
    await new Promise((resolve, reject) => {
      const req = https.request(
        `https://api.telegram.org/bot${ENV.BOT_TOKEN}/sendMessage`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) { log(`Telegram error: ${err.message}`); }
}

// ── FMP helpers ───────────────────────────────────────────────
async function fmpGet(endpoint) {
  if (!ENV.FMP_API_KEY) return [];
  try {
    const url  = `https://financialmodelingprep.com/api/v3/${endpoint}&apikey=${ENV.FMP_API_KEY}`;
    const data = await httpGet(url);
    return JSON.parse(data);
  } catch (err) {
    log(`FMP error (${endpoint}): ${err.message}`);
    return [];
  }
}

async function getFMPQuotes(symbols) {
  if (!symbols.length) return {};
  try {
    const url  = `https://financialmodelingprep.com/api/v3/quote/${symbols.join(',')}?apikey=${ENV.FMP_API_KEY}`;
    const data = JSON.parse(await httpGet(url));
    const map  = {};
    if (Array.isArray(data)) data.forEach(q => map[q.symbol] = q);
    return map;
  } catch { return {}; }
}

async function getFMPNews(symbols) {
  if (!symbols.length || !ENV.FMP_API_KEY) return {};
  try {
    const syms = symbols.join(',');
    const url  = `https://financialmodelingprep.com/api/v3/stock_news?tickers=${syms}&limit=3&apikey=${ENV.FMP_API_KEY}`;
    const data = JSON.parse(await httpGet(url));
    const map  = {};
    if (Array.isArray(data)) {
      data.forEach(n => {
        if (!map[n.symbol]) map[n.symbol] = [];
        if (map[n.symbol].length < 2) map[n.symbol].push(n.title.slice(0, 80));
      });
    }
    return map;
  } catch { return {}; }
}

async function getFinnhubNews(symbol) {
  if (!ENV.FINNHUB_API_KEY) return [];
  try {
    const to   = new Date().toISOString().slice(0,10);
    const from = new Date(Date.now() - 5*86400000).toISOString().slice(0,10);
    const url  = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${ENV.FINNHUB_API_KEY}`;
    const data = JSON.parse(await httpGet(url));
    if (!Array.isArray(data)) return [];
    return data.slice(0,2).map(n => n.headline.slice(0,80));
  } catch { return []; }
}

// ── Quality filter — removes ETFs, leveraged products, penny stocks ──
function isQualityStock(stock) {
  if (!stock) return false;
  if (stock.price < CONFIG.MIN_PRICE) return false;
  if (stock.volume < CONFIG.MIN_VOLUME) return false;
  if (!stock.name) return false;
  const name = stock.name.toUpperCase();
  for (const kw of CONFIG.EXCLUDE_KEYWORDS) {
    if (name.includes(kw.toUpperCase())) return false;
  }
  // Exclude obvious penny stock patterns
  if (stock.changesPercentage > 200) return false; // absurd spike = penny stock
  return true;
}

// ── Hunter leaderboard data ───────────────────────────────────
async function getHunterLeaderboard(assetType, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const data  = await sbGet(
    `hunter_leaderboard_history?asset_type=eq.${assetType}&snapshot_time=gte.${encodeURIComponent(since)}&select=symbol,score,rank,snapshot_id,snapshot_time&order=snapshot_time.asc`
  );
  if (!Array.isArray(data)) return new Map();

  const snapIds    = [...new Set(data.map(r => r.snapshot_id))];
  const totalSnaps = snapIds.length;

  const map = new Map();
  for (const row of data) {
    if (!map.has(row.symbol)) {
      map.set(row.symbol, { scores: [], ranks: [] });
    }
    const d = map.get(row.symbol);
    d.scores.push(parseFloat(row.score));
    d.ranks.push(row.rank);
  }

  // Compute derived stats
  for (const [sym, d] of map.entries()) {
    d.avgScore    = round2(d.scores.reduce((a,b)=>a+b,0)/d.scores.length);
    d.peakScore   = round2(Math.max(...d.scores));
    d.currentScore = d.scores[d.scores.length-1];
    d.currentRank  = d.ranks[d.ranks.length-1];
    d.top5count   = d.ranks.filter(r => r <= 5).length;
    d.totalSnaps  = totalSnaps;
    // Rising: last 3 snapshots trending up
    const last3 = d.scores.slice(-3);
    d.rising = last3.length >= 3 && last3[2] > last3[1] && last3[1] > last3[0];
  }

  return map;
}

// ── Portfolio state ───────────────────────────────────────────
async function getPortfolioState() {
  const data = await sbGet(`hunter_portfolio_state?status=eq.active&select=*`);
  const map  = new Map();
  if (Array.isArray(data)) data.forEach(r => map.set(r.symbol, r));
  return map;
}

async function addToPortfolio(symbol, assetType, portfolio, price, score) {
  await sbUpsert('hunter_portfolio_state', {
    symbol, asset_type: assetType, portfolio, status: 'active',
    add_price: price, add_score: score,
    added_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

async function removeFromPortfolio(symbol) {
  await sbPatch('hunter_portfolio_state', `symbol=eq.${symbol}`, {
    status: 'removed',
    removed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

// ============================================================
// STOCK PORTFOLIO REVIEW
// Fires Friday 21:00 UTC after US close
// Source: FMP most-active + quality filter + Hunter confirmation
// ============================================================
async function runStockPortfolioReview() {
  log('📊 Running stock portfolio review...');

  const portfolio = await getPortfolioState();
  const hunterMap = await getHunterLeaderboard('us', 7);

  // Get today's most active — these are the stocks with real institutional interest
  const mostActive   = await fmpGet('stock_market/actives?');
  const biggestGains = await fmpGet('stock_market/gainers?');

  // Combine and deduplicate
  const combined = new Map();
  for (const stock of [...mostActive, ...biggestGains]) {
    if (!combined.has(stock.symbol)) combined.set(stock.symbol, stock);
  }

  // Get full quotes for quality stocks to get 52-week high
  const qualitySymbols = [...combined.values()]
    .filter(isQualityStock)
    .map(s => s.symbol)
    .slice(0, 30);

  const quotes = await getFMPQuotes(qualitySymbols);

  const qualified  = [];
  const addAlerts  = [];
  const holdList   = [];
  const removeList = [];

  // Check current portfolio positions first
  for (const [sym, pos] of portfolio.entries()) {
    if (pos.portfolio !== 'stock_portfolio') continue;
    const q = quotes[sym] || combined.get(sym);
    if (!q) { removeList.push({ sym, reason: 'No longer active' }); continue; }

    const pctFromHigh = q.yearHigh
      ? round2((q.yearHigh - q.price) / q.yearHigh * 100) : 100;
    const h = hunterMap.get(sym);
    const hunterOk = !h || h.avgScore >= CONFIG.PORTFOLIO_MIN_HUNTER;

    if (pctFromHigh <= CONFIG.MAX_PCT_FROM_HIGH && hunterOk) {
      holdList.push({ sym, q, pctFromHigh });
      qualified.push(sym);
    } else {
      removeList.push({ sym, reason: pctFromHigh > CONFIG.MAX_PCT_FROM_HIGH
        ? `${pctFromHigh}% from 52-week high`
        : `Score faded` });
    }
  }

  // Find new additions
  for (const sym of qualitySymbols) {
    if (qualified.includes(sym)) continue;
    if (portfolio.has(sym)) continue;

    const q = quotes[sym];
    if (!q || !q.yearHigh) continue;

    const pctFromHigh  = round2((q.yearHigh - q.price) / q.yearHigh * 100);
    const changePct    = round2(q.changePercentage || 0);
    const h            = hunterMap.get(sym);

    // Portfolio criteria: near highs + decent move today + Hunter confirmation if available
    const nearHigh    = pctFromHigh <= CONFIG.MAX_PCT_FROM_HIGH;
    const movingToday = changePct >= CONFIG.PORTFOLIO_MIN_CHANGE;
    const hunterOk    = !h || h.avgScore >= CONFIG.PORTFOLIO_MIN_HUNTER;

    if (nearHigh && movingToday && hunterOk) {
      addAlerts.push({ sym, q, pctFromHigh, changePct, h });
      qualified.push(sym);
      await addToPortfolio(sym, 'us', 'stock_portfolio', q.price, h?.avgScore || 0);
    }
  }

  // Get news for all relevant symbols
  const allSyms = [...addAlerts.map(a => a.sym), ...holdList.map(h => h.sym)];
  const newsMap = await getFMPNews(allSyms);

  // Send ADD alerts
  for (const { sym, q, pctFromHigh, changePct } of addAlerts) {
    const news = newsMap[sym] || [];
    const newsLine = news.length ? `\n\n📰 ${news[0]}` : '';
    const msg = [
      `📥 PORTFOLIO — ADD`,
      ``,
      `📈 ${sym} | ${q.name?.split(' ').slice(0,3).join(' ')}`,
      ``,
      `+${changePct}% today`,
      `${pctFromHigh}% from 52-week high`,
      `${newsLine}`,
      ``,
      `Buy.`,
      ``,
      `——————————`,
      `📸 @baretradesignals 🏹`,
    ].join('\n');
    await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
    await new Promise(r => setTimeout(r, 1500));
  }

  // Send HOLD alert (single message)
  if (holdList.length > 0) {
    const lines = holdList.map(({ sym, q }) => {
      const chg = round2(q?.changePercentage || 0);
      return `📈 ${sym}  ${chg >= 0 ? '+' : ''}${chg}% today`;
    });
    const msg = [
      `✅ PORTFOLIO — HOLD`,
      ``,
      ...lines,
      ``,
      `Still valid. Keep holding.`,
      ``,
      `——————————`,
      `📸 @baretradesignals 🏹`,
    ].join('\n');
    await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
    await new Promise(r => setTimeout(r, 1500));
  }

  // Send REMOVE alerts
  for (const { sym } of removeList) {
    await removeFromPortfolio(sym);
    const msg = [
      `📤 PORTFOLIO — REMOVE`,
      ``,
      `📈 ${sym}`,
      ``,
      `Sell.`,
      ``,
      `——————————`,
      `📸 @baretradesignals 🏹`,
    ].join('\n');
    await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
    await new Promise(r => setTimeout(r, 1500));
  }

  log(`📊 Portfolio review: +${addAlerts.length} added, ${holdList.length} held, ${removeList.length} removed`);
}

// ============================================================
// STOCK TRADE ALERTS
// Fires every 4hrs during US market hours
// Source: FMP most-active + gainers → quality filter → news check
// ============================================================
async function runStockTradeAlerts() {
  log('⚡ Checking stock trade opportunities...');

  const portfolio = await getPortfolioState();
  const hunterMap = await getHunterLeaderboard('us', 3);

  // Pull today's movers
  const mostActive   = await fmpGet('stock_market/actives?');
  const biggestGains = await fmpGet('stock_market/gainers?');

  const combined = new Map();
  for (const stock of [...mostActive, ...biggestGains]) {
    if (!combined.has(stock.symbol)) combined.set(stock.symbol, stock);
  }

  const qualityStocks = [...combined.values()].filter(isQualityStock);
  const symbols       = qualityStocks.map(s => s.symbol).slice(0, 25);
  const quotes        = await getFMPQuotes(symbols);
  const newsMap       = await getFMPNews(symbols.slice(0, 10));

  for (const stock of qualityStocks) {
    const sym  = stock.symbol;
    const q    = quotes[sym] || stock;
    const h    = hunterMap.get(sym);
    const changePct = round2(q.changePercentage || stock.changesPercentage || 0);

    // Skip if already in stock portfolio
    const inPortfolio = portfolio.has(sym) && portfolio.get(sym).portfolio === 'stock_portfolio';
    if (inPortfolio) continue;

    const inTrade = portfolio.has(sym) && portfolio.get(sym).portfolio === 'stock_trade';
    const pctFromHigh = q.yearHigh
      ? round2((q.yearHigh - q.price) / q.yearHigh * 100) : 100;

    // BUY signal: strong move today + within range + quality + news catalyst
    if (!inTrade &&
        changePct >= CONFIG.TRADE_MIN_CHANGE &&
        changePct <= CONFIG.TRADE_MAX_CHANGE &&
        pctFromHigh <= CONFIG.MAX_PCT_FROM_HIGH_TRADE) {

      const news = newsMap[sym] || await getFinnhubNews(sym);
      const newsLine = news.length ? `\n\n📰 ${news[0]}` : '';
      const hunterLine = h ? `\nHunter score: ${h.currentScore}` : '';

      const msg = [
        `⚡ TRADE — BUY`,
        ``,
        `📈 ${sym}`,
        ``,
        `+${changePct}% today`,
        `${pctFromHigh}% from 52-week high`,
        `${hunterLine}`,
        `${newsLine}`,
        ``,
        `Buy now. Take profit this week.`,
        ``,
        `——————————`,
        `📸 @baretradesignals 🏹`,
      ].join('\n');

      await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
      await addToPortfolio(sym, 'us', 'stock_trade', q.price || stock.price, h?.currentScore || 0);
      await new Promise(r => setTimeout(r, 1500));
    }

    // SELL signal: trade open, now reversing
    if (inTrade) {
      const reversing = changePct <= -3 || (h && h.currentScore < 50);
      if (reversing) {
        const msg = [
          `⚡ TRADE — SELL`,
          ``,
          `📈 ${sym}`,
          ``,
          `Momentum fading. Take profit.`,
          ``,
          `——————————`,
          `📸 @baretradesignals 🏹`,
        ].join('\n');
        await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
        await removeFromPortfolio(sym);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
}

// ============================================================
// CRYPTO TRADE ALERTS
// Fires every 4hrs, 24/7
// Source: Hunter leaderboard + FMP crypto news
// ============================================================
async function runCryptoTradeAlerts() {
  log('🪙 Checking crypto trade opportunities...');

  const portfolio = await getPortfolioState();
  const hunterMap = await getHunterLeaderboard('crypto', 3);

  // Get crypto news for context
  let cryptoNews = [];
  try {
    const url  = `https://financialmodelingprep.com/api/v3/crypto_news?limit=10&apikey=${ENV.FMP_API_KEY}`;
    const data = JSON.parse(await httpGet(url));
    if (Array.isArray(data)) cryptoNews = data.map(n => n.title?.slice(0,80)).filter(Boolean);
  } catch { /* non-fatal */ }

  for (const sym of CONFIG.CORE_CRYPTO) {
    const h = hunterMap.get(sym);
    if (!h) continue;

    const label   = sym.replace('USDT', '');
    const inTrade = portfolio.has(sym) && portfolio.get(sym).portfolio === 'crypto_trade';

    // BUY: score rising + strong + top ranked
    if (!inTrade &&
        h.rising &&
        h.currentScore >= CONFIG.CRYPTO_MIN_SCORE &&
        h.currentRank  <= CONFIG.CRYPTO_MIN_RANK) {

      const msg = [
        `⚡ TRADE — BUY`,
        ``,
        `🪙 ${label}`,
        ``,
        `Score: [${round2(h.currentScore)}] rising`,
        `Rank: #${h.currentRank}`,
        ``,
        `Buy now. Take profit 48-72hrs.`,
        ``,
        `——————————`,
        `📸 @baretradesignals 🏹`,
      ].join('\n');

      await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
      await addToPortfolio(sym, 'crypto', 'crypto_trade', 0, h.currentScore);
      await new Promise(r => setTimeout(r, 1500));
    }

    // SELL: score dropped or rank fell out
    if (inTrade && (h.currentScore < 52 || h.currentRank > 10)) {
      const msg = [
        `⚡ TRADE — SELL`,
        ``,
        `🪙 ${label}`,
        ``,
        `Momentum fading. Exit.`,
        ``,
        `——————————`,
        `📸 @baretradesignals 🏹`,
      ].join('\n');

      await sendTelegram(msg, ENV.BLUEJAM_CHAT_ID);
      await removeFromPortfolio(sym);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

// ============================================================
// MAIN LOOP
// ============================================================
async function main() {
  log('🏹 Hunter Portfolio Manager v2 starting...');

  if (!ENV.SUPABASE_URL || !ENV.SUPABASE_SERVICE_KEY) {
    log('❌ Missing Supabase credentials'); process.exit(1);
  }
  if (!ENV.FMP_API_KEY) {
    log('⚠️  No FMP API key — stock signals will be limited');
  }

  async function cycle() {
    const now      = new Date();
    const hourUTC  = now.getUTCHours();
    const dayUTC   = now.getUTCDay();
    const minUTC   = now.getUTCMinutes();
    const isFriday  = dayUTC === 5;
    const isWeekend = dayUTC === 0 || dayUTC === 6;
    const isUSOpen  = !isWeekend && hourUTC >= 14 && hourUTC <= 21;

    try {
      // Crypto — always
      await runCryptoTradeAlerts();

      // Stocks — market hours only
      if (isUSOpen) {
        await runStockTradeAlerts();
      }

      // Portfolio review — Friday after close
      if (isFriday && hourUTC === 21 && minUTC < 10) {
        await runStockPortfolioReview();
      }

    } catch (err) {
      log(`❌ Cycle error: ${err.message}`);
    }

    setTimeout(cycle, 4 * 60 * 60 * 1000);
  }

  await cycle();
}

main().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
