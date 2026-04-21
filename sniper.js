const fs = require("fs");
const path = require("path");
const axios = require("axios");

// =======================
// ENV
// =======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DATA_DIR = process.env.DATA_DIR || ".";
const SIGNAL_FILE = path.join(DATA_DIR, "signals.json");
const TRADES_FILE = path.join(DATA_DIR, "trades.json");

const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 65);
const MAX_ALERTS = Number(process.env.MAX_ALERTS_PER_SCAN || 4);
const COOLDOWN_HOURS = Number(process.env.COOLDOWN_HOURS || 6);

const ACCOUNT_SIZE = Number(process.env.ACCOUNT_SIZE || 1000);
const RISK_PCT = Number(process.env.RISK_PCT || 0.02);

const REQUEST_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 30 * 60 * 1000;

// =======================
// WATCHLIST
// =======================
const WATCHLIST = {
  stocks: ["SMH","EQQQ.L","PLTR","AMD","APP","MSTR","COIN","ASTS","SOUN"],
  crypto: ["SOL","ETH","FET","RNDR"]
};

const CG_IDS = {
  ETH: "ethereum",
  SOL: "solana",
  FET: "fetch-ai",
  RNDR: "render-token"
};

// =======================
// CACHE
// =======================
const CACHE = new Map();

function getCache(k){
  const v = CACHE.get(k);
  if(!v) return null;
  if(Date.now()-v.t > CACHE_TTL_MS) return null;
  return v.d;
}

function setCache(k,d){
  CACHE.set(k,{d,t:Date.now()});
}

// =======================
// STORAGE
// =======================
fs.mkdirSync(DATA_DIR,{recursive:true});

if(!fs.existsSync(SIGNAL_FILE)){
  fs.writeFileSync(SIGNAL_FILE,"[]\n","utf8");
}
if(!fs.existsSync(TRADES_FILE)){
  fs.writeFileSync(TRADES_FILE,"[]\n","utf8");
}

function loadSignals(){
  try{return JSON.parse(fs.readFileSync(SIGNAL_FILE,"utf8"));}
  catch{return [];}
}
function saveSignals(s){
  fs.writeFileSync(SIGNAL_FILE,JSON.stringify(s.slice(-100),null,2)+"\n","utf8");
}

function loadTrades(){
  try{return JSON.parse(fs.readFileSync(TRADES_FILE,"utf8"));}
  catch{return [];}
}
function saveTrades(t){
  fs.writeFileSync(TRADES_FILE,JSON.stringify(t,null,2)+"\n","utf8");
}

// =======================
// TELEGRAM
// =======================
async function send(msg){
  if(!BOT_TOKEN||!CHAT_ID) return;

  try{
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id:CHAT_ID,
        text:msg,
        disable_web_page_preview:true
      },
      {timeout:REQUEST_TIMEOUT_MS}
    );
  }catch(e){
    console.log("TG error:",e.message);
  }
}

// =======================
// HELPERS
// =======================
function norm(a){return String(a).toUpperCase().replace("USDT","");}
function key(s){return `${s.asset}|${s.entry}|${s.sl}|${s.tp}`;}

function duplicate(s,list){
  return list.some(x=>key(x)===key(s));
}

function cooldown(asset,list){
  const now=Date.now();
  return list.some(x=>norm(x.asset)===norm(asset)&&now-x.time<COOLDOWN_HOURS*3600000);
}

function hasOpenTrade(asset,trades){
  return trades.some(t=>norm(t.asset)===norm(asset)&&t.status==="open");
}

function safeSeries(arr){
  if(!Array.isArray(arr)) return null;
  const c=arr.filter(x=>Number.isFinite(x));
  if(c.length<20) return null;
  return c;
}

function summarise(symbol,closes,source){
  const c=safeSeries(closes);
  if(!c) return null;

  const last20=c.slice(-20);

  return {
    symbol,
    source,
    closes:c,
    last:c.at(-1),
    prev:c.at(-2),
    high:Math.max(...last20),
    low:Math.min(...last20),
    sma:last20.reduce((a,b)=>a+b,0)/last20.length
  };
}

function newAbort(ms){
  const c=new AbortController();
  setTimeout(()=>c.abort(),ms);
  return c.signal;
}

async function httpGet(url,config={}){
  return axios.get(url,{
    timeout:REQUEST_TIMEOUT_MS,
    signal:newAbort(REQUEST_TIMEOUT_MS),
    ...config
  });
}

// =======================
// FETCH
// =======================
async function fetchStock(symbol){
  const k=`s_${symbol}`;
  const c=getCache(k);
  if(c) return c;

  try{
    const {data}=await httpGet(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`
    );

    const closes=data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const r=summarise(symbol,closes,"Yahoo");

    if(r) setCache(k,r);
    return r;
  }catch{}

  return null;
}

async function fetchCrypto(symbol){
  const k=`c_${symbol}`;
  const c=getCache(k);
  if(c) return c;

  const id=CG_IDS[symbol];

  if(id){
    try{
      const {data}=await httpGet(
        `https://api.coingecko.com/api/v3/coins/${id}/market_chart`,
        {params:{vs_currency:"usd",days:30}}
      );

      const closes=(data?.prices || []).map(p=>Number(p[1]));
      const r=summarise(symbol,closes,"CoinGecko");

      if(r) setCache(k,r);
      return r;
    }catch{}
  }

  try{
    const {data}=await httpGet(
      `https://api.binance.com/api/v3/klines`,
      {params:{symbol:`${symbol}USDT`,interval:"1d",limit:30}}
    );

    const closes=(data || []).map(x=>Number(x[4]));
    const r=summarise(symbol,closes,"Binance");

    if(r) setCache(k,r);
    return r;
  }catch{}

  return null;
}

// =======================
// EMA
// =======================
function ema(v,p){
  if(!v || v.length < p) return null;

  const k=2/(p+1);
  let e=v[0];

  for(let i=1;i<v.length;i++){
    e=v[i]*k+e*(1-k);
  }
  return e;
}

// =======================
// MODES
// =======================
function isPullback(m){
  const price=m.last;
  const depth=(m.high-price)/m.high;

  const valid=depth>0.02 && depth<0.06;
  const aboveSMA=price>m.sma;
  const structure=price>m.low*1.02;

  return valid && aboveSMA && structure;
}

function isMomentumBreakout(m){
  const price = m.last;
  const nearHigh = price > m.high * 0.98;
  const momentum = (m.last - m.prev) / m.prev;

  return nearHigh && momentum > 0.02;
}

// =======================
// SIGNAL
// =======================
function buildSignal(m,type){
  if(!m) return null;

  const entry=m.last;

  const closes=m.closes.slice(-50);
  const ema20=ema(closes,20);
  const ema50=ema(closes,50);

  if(!ema20 || !ema50) return null;
  if(ema20<=ema50) return null;

  const pullback = isPullback(m);
  const breakout = isMomentumBreakout(m);

  if(!pullback && !breakout) return null;

  const momentum = (m.last - m.prev) / m.prev;

  if(pullback && momentum < 0.008) return null;
  if(breakout && momentum < 0.02) return null;

  const sl=Math.min(m.low*0.995,entry*0.97);

  let tp;
  if (breakout) {
    tp = entry * 1.12;
  } else {
    tp = Math.max(m.high * 1.02, entry * 1.05);
  }

  if(entry<=sl) return null;

  const rr=(tp-entry)/(entry-sl);
  if(rr<1.3) return null;

  const trendRange=(m.high-m.low)/m.low;
  if(trendRange<0.05) return null;

  let conf=55;
  if(momentum>0.015) conf+=15;
  if(entry>m.sma) conf+=10;
  if(rr>2) conf+=10;

  if(conf<MIN_CONFIDENCE) return null;

  return {
    asset:m.symbol,
    entry:+entry.toFixed(2),
    sl:+sl.toFixed(2),
    tp:+tp.toFixed(2),
    confidence:conf,
    type,
    mode: breakout ? "momentum" : "pullback",
    source:m.source,
    rr:+rr.toFixed(2),
    time:Date.now()
  };
}

// =======================
// POSITION SIZE
// =======================
function positionSize(entry,sl){
  const risk=ACCOUNT_SIZE*RISK_PCT;
  const per=entry-sl;
  if(per<=0) return null;

  return {
    size:+(risk/per).toFixed(4),
    riskAmount:+risk.toFixed(2)
  };
}

// =======================
// SCAN
// =======================
async function scan(){
  console.log("Scan start");

  const results=[];

  for(const s of WATCHLIST.stocks){
    results.push(buildSignal(await fetchStock(s),"stock"));
  }

  for(const c of WATCHLIST.crypto){
    results.push(buildSignal(await fetchCrypto(c),"crypto"));
  }

  const ranked=results.filter(Boolean)
    .sort((a,b)=>b.confidence-a.confidence)
    .slice(0,MAX_ALERTS);

  const signals=loadSignals();
  const trades=loadTrades();
  const seen=new Set();

  for(const s of ranked){
    if(seen.has(s.asset)) continue;
    seen.add(s.asset);

    if(duplicate(s,signals)) continue;
    if(cooldown(s.asset,signals)) continue;
    if(hasOpenTrade(s.asset,trades)) continue;

    const pos=positionSize(s.entry,s.sl);
    if(!pos) continue;

    signals.push(s);
    saveSignals(signals);

    trades.push({
      asset:s.asset,
      entry:s.entry,
      sl:s.sl,
      tp:s.tp,
      size:pos.size,
      status:"open",
      movedBE:false,
      partialTaken:false,
      lastAlert:0,
      highest:s.entry,
      time:Date.now()
    });

    saveTrades(trades);

    const icon=s.type==="crypto"?"🪙":"📈";

    await send(
`🚨 SNIPER SIGNAL
${icon} ${s.asset} (${s.confidence}%)
Mode: ${s.mode.toUpperCase()}
Entry: ${s.entry}
SL: ${s.sl}
TP: ${s.tp}
RR: ${s.rr}
Size: ${pos.size}
Risk: £${pos.riskAmount}`
    );

    console.log("Signal:",s.asset);
  }

  console.log("Scan end");
}

// =======================
// EXECUTION
// =======================
async function manageTrades(){
  const trades=loadTrades();
  const now=Date.now();

  for(let t of trades){
    if(t.status!=="open") continue;

    const m=WATCHLIST.crypto.includes(t.asset)
      ? await fetchCrypto(t.asset)
      : await fetchStock(t.asset);

    if(!m) continue;

    const price=m.last;

    if(price>t.highest) t.highest=price;

    if(price<=t.sl){
      t.status="stopped";
      t.exit=price;
      t.exitReason="SL";
      t.closedTime=now;
      t.pnl=(t.exit-t.entry)*t.size;

      await send(`❌ STOPPED\n${t.asset}\n${price}`);
      continue;
    }

    if(price>=t.tp){
      t.status="closed";
      t.exit=price;
      t.exitReason="TP";
      t.closedTime=now;
      t.pnl=(t.exit-t.entry)*t.size;

      await send(`✅ TP\n${t.asset}\n${price}`);
      continue;
    }

    if(!t.movedBE && price>=t.entry*1.02){
      t.sl=t.entry;
      t.movedBE=true;
      await send(`🟡 BE ${t.asset}`);
    }

    if(!t.partialTaken && price>=t.entry*1.04){
      t.partialTaken=true;
      await send(`💰 PARTIAL ${t.asset}`);
    }

    if(price>t.entry*1.05){
      const newSL=t.highest*0.97;

      if(newSL>t.sl*1.002){
        t.sl=newSL;

        if(now-t.lastAlert>600000){
          t.lastAlert=now;
          await send(`📈 TRAIL ${t.asset} SL ${t.sl.toFixed(2)}`);
        }
      }
    }
  }

  saveTrades(trades);
}

// =======================
// RUN
// =======================
async function runCycle() {
  console.log("=== NEW CYCLE ===", new Date().toISOString());

  try {
    await scan();
    await manageTrades();
  } catch (e) {
    console.error("Cycle error:", e.message);
  }
}

// run immediately
runCycle();

// run every 5 minutes
setInterval(runCycle, 300000);
