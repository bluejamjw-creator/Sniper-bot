#!/usr/bin/env python3
"""
PORTFOLIO BOT — FINAL PRODUCTION VERSION
"""

import time, requests, yfinance as yf, os, json
from datetime import datetime

# ───────────────── SETTINGS ─────────────────
BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID   = os.getenv("CHAT_ID")

CHECK_INTERVAL = 6 * 60 * 60
STAGNANT_PCT   = 0.05

LAST_TRADE_FILE = "last_trade.json"
STAGNANT_FILE   = "stagnant_alerted.json"

# ───────────────── POTS ─────────────────
POT_1_CORE = {
    "SMH":0.29,"EQQQ":0.25,"INDA":0.20,"PLTR":0.13,"VRT":0.08,"ETHC":0.05
}
POT_2_AGGRESSIVE = {
    "APP":0.28,"AMD":0.22,"MSTR":0.20,"ASTS":0.15,"SOUN":0.10,"COIN":0.05
}
POT_3_CRYPTO = {
    "RNDR-USD":0.333,"FET-USD":0.267,"SOL-USD":0.2,"ETH-USD":0.2
}

TICKER_POT = {}
for t in POT_1_CORE: TICKER_POT[t] = ("core",1)
for t in POT_2_AGGRESSIVE: TICKER_POT[t] = ("aggressive",2)
for t in POT_3_CRYPTO: TICKER_POT[t] = ("crypto",3)

VOLATILE = {"COIN","MSTR","TSLA","NVDA","AMD","PLTR","APP","ASTS","SOUN"}

# ───────────────── TELEGRAM ─────────────────
def send(msg):
    if not BOT_TOKEN or not CHAT_ID:
        print(msg)
        return
    requests.post(
        f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
        json={"chat_id":CHAT_ID,"text":msg},
        timeout=10
    )

# ───────────────── DATA ─────────────────
def get_price_change(t):
    try:
        h = yf.Ticker(t).history(period="1mo")
        if len(h)<2: return None
        c,o = float(h["Close"].iloc[-1]), float(h["Close"].iloc[0])
        return c,(c-o)/o
    except: return None

def get_60d_change(t):
    try:
        h = yf.Ticker(t).history(period="3mo")
        if len(h)<20: return None
        c,o = float(h["Close"].iloc[-1]), float(h["Close"].iloc[-60])
        return (c-o)/o
    except: return None

# ───────────────── SIGNALS ─────────────────
def get_signals():
    try:
        return json.load(open("signals.json"))
    except:
        return []

def score_signal(s):
    return min(s.get("touches",3),6)*10 + min(float(s.get("volRatio",1.5)),5)*8

# ───────────────── WEAKNESS SCORE ─────────────────
def weakness_score(item):
    ticker, change = item
    stagnation = abs(get_60d_change(ticker) or 0)
    return change - (stagnation * 0.5)

# ───────────────── CLASSIFY ─────────────────
def classify(change, pot):
    if pot=="core":
        if change>=0.4: return "🔥 EXTENDED"
        elif change>=0.15: return "⚡ STRONG"
        elif change>=-0.05: return "✅ HOLD"
        elif change>=-0.2: return "🧊 WEAK"
        else: return "🚨 DOWN"

    if pot=="aggressive":
        if change>=0.6: return "🚨 EXIT"
        elif change>=0.45: return "🔥 PROFIT"
        elif change>=0.25: return "✂️ TRIM"
        else: return "✅ HOLD"

    if pot=="crypto":
        if change>=0.6: return "🚨 MAJORITY"
        elif change>=0.5: return "🔥 PROFIT"
        elif change>=0.35: return "✂️ TRIM"
        else: return "✅ HOLD"

# ───────────────── ROUTING ─────────────────
def route(sig,p1,p2,p3):
    a = sig.get("asset","")
    t = sig.get("type","")

    if a in TICKER_POT:
        return TICKER_POT[a][1],"topup",f"{a} breakout → top up"

    is_crypto = (t=="crypto" or "USD" in a)

    if is_crypto:
        perf,pot = p3,3
    elif a in VOLATILE:
        perf,pot = p2,2
    else:
        perf,pot = p1,1

    if perf:
        weakest = min(perf,key=weakness_score)
        if weakest[1] < -0.1:
            return pot,"replace",f"Replace {weakest[0]} → {a}"

    return pot,"watch",f"{a} watchlist"

# ───────────────── STAGNANT ─────────────────
def stagnant(holdings, ranked):
    flagged=[]
    best = ranked[0] if ranked else None

    try:
        data=json.load(open(STAGNANT_FILE))
    except:
        data={}

    for t in holdings:
        if t in data and time.time()-data[t]<14*86400:
            continue

        c=get_60d_change(t)
        if c is None: continue

        if abs(c)<=STAGNANT_PCT:
            msg=f"{t} stagnant ({round(c*100,1)}%)"
            if best:
                msg+=f"\n→ Replace with {best.get('asset')}"
            send(msg)
            data[t]=time.time()
            flagged.append(t)

    json.dump(data,open(STAGNANT_FILE,"w"))
    return flagged

# ───────────────── POT ANALYSIS ─────────────────
def analyse_pot(name,holdings,pot_type):
    lines,perf,acts=[],[],[]
    lines.append(f"\n{name}")

    for t,a in holdings.items():
        d=get_price_change(t)
        if not d: continue
        _,c=d
        perf.append((t,c))

        status=classify(c,pot_type)
        lines.append(f"{t:<8} {a*100:>4}% {c:+6.1%} {status}")

        if status in ["✂️ TRIM","🔥 PROFIT","🚨 EXIT","🚨 MAJORITY"]:
            acts.append((t,status))

    return lines,perf,acts

# ───────────────── MAIN ─────────────────
def analyse():
    lines=["📊 PORTFOLIO"]

    l1,p1,a1=analyse_pot("CORE",POT_1_CORE,"core")
    l2,p2,a2=analyse_pot("AGGRESSIVE",POT_2_AGGRESSIVE,"aggressive")
    l3,p3,a3=analyse_pot("CRYPTO",POT_3_CRYPTO,"crypto")

    lines+=l1+l2+l3
    actions=a1+a2+a3

    signals=get_signals()
    ranked=sorted(signals,key=score_signal,reverse=True)

    if ranked:
        lines.append("\n🎯 SNIPER")

        for s in ranked[:5]:
            pot,act,msg=route(s,p1,p2,p3)
            lines.append(f"{s.get('asset')} → Pot {pot} [{act}]")
            if act!="watch":
                actions.append((s.get("asset"),act))

        if actions:
            best=ranked[0]
            lines.append(f"\n💸 Deploy into {best.get('asset')}")

    stagnant(POT_1_CORE,ranked)
    stagnant(POT_2_AGGRESSIVE,ranked)
    stagnant(POT_3_CRYPTO,ranked)

    return "\n".join(lines),bool(actions)

# ───────────────── LOOP ─────────────────
def run():
    while True:
        msg,flag=analyse()
        print(msg)
        if flag:
            send(msg)
        time.sleep(CHECK_INTERVAL)

if __name__=="__main__":
    print("BOT LIVE\n")
    run()
