import time
import requests
import yfinance as yf
from datetime import datetime
import os
import json

# ================================================================
# SETTINGS
# ================================================================
BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID   = os.getenv("CHAT_ID")

CHECK_INTERVAL      = 6 * 60 * 60
STAGNANT_PCT        = 0.20
STAGNANT_BEAT_PCT   = 0.30
REBALANCE_DRIFT     = 0.05
MIN_SWAP_EDGE       = 10
SWAP_COOLDOWN_HOURS = 72
LAST_TRADE_FILE     = "last_trade.json"
STAGNANT_FILE       = "stagnant_alerted.json"

# ================================================================
# POTS
# ================================================================
POT_1_CORE = {
    "SMH": 0.29, "EQQQ.L": 0.25, "INDA": 0.20,
    "PLTR": 0.13, "VRT": 0.08, "ETHC.L": 0.05,
}

POT_2_AGGRESSIVE = {
    "APP": 0.28, "AMD": 0.22, "MSTR": 0.20,
    "ASTS": 0.15, "SOUN": 0.10, "COIN": 0.05,
}

POT_3_CRYPTO = {
    "RENDERUSDT": 0.333, "FETUSDT": 0.267,
    "SOLUSDT": 0.200, "ETHUSDT": 0.200,
}

CRYPTO_NAMES = {
    "RENDERUSDT": "RENDER",
    "FETUSDT": "FET",
    "SOLUSDT": "SOL",
    "ETHUSDT": "ETH",
}

TICKER_POT = {}
for t in POT_1_CORE:       TICKER_POT[t] = ("core", 1)
for t in POT_2_AGGRESSIVE: TICKER_POT[t] = ("aggressive", 2)
for t in POT_3_CRYPTO:     TICKER_POT[t] = ("crypto", 3)

VOLATILE_STOCKS = {
    "COIN","MSTR","HOOD","IONQ","SMCI","ARM","ASTS","SOUN",
    "PLTR","APP","NVDA","AMD","META","TSLA","GEV"
}

TRIM_THRESHOLDS = {
    "aggressive": {"trim": 0.25, "profit": 0.45, "exit": 0.60},
    "crypto":     {"trim": 0.35, "profit": 0.50, "exit": 0.60},
}

# ================================================================
# TELEGRAM
# ================================================================
def send(msg, urgent=False):
    if not BOT_TOKEN or not CHAT_ID:
        return
    prefix = "🚨 ACTION NEEDED\n\n" if urgent else ""
    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={"chat_id": CHAT_ID, "text": prefix + msg},
            timeout=10
        )
    except:
        pass

# ================================================================
# DATA — STOCKS
# ================================================================
def get_stock_data(ticker):
    try:
        hist = yf.Ticker(ticker).history(period="1mo")
        if hist.empty or len(hist) < 2:
            return None
        current = float(hist["Close"].iloc[-1])
        old     = float(hist["Close"].iloc[0])
        if old == 0:
            return None
        return current, (current - old) / old
    except:
        return None

def get_stock_60d(ticker):
    try:
        hist = yf.Ticker(ticker).history(period="3mo")
        if hist.empty:
            return None
        current = float(hist["Close"].iloc[-1])
        old     = float(hist["Close"].iloc[0])
        return (current - old) / old
    except:
        return None

# ================================================================
# DATA — CRYPTO (FIXED)
# ================================================================
def get_crypto_data(symbol):
    if not symbol.endswith("USDT"):
        symbol += "USDT"

    try:
        price = float(requests.get(
            f"https://api.binance.com/api/v3/ticker/price?symbol={symbol}"
        ).json()["price"])

        candles = requests.get(
            f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval=1d&limit=31"
        ).json()

        old = float(candles[0][1])
        return price, (price - old) / old
    except:
        return None

def get_crypto_60d(symbol):
    if not symbol.endswith("USDT"):
        symbol += "USDT"

    try:
        candles = requests.get(
            f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval=1d&limit=61"
        ).json()

        current = float(candles[-1][4])
        old     = float(candles[0][1])
        return (current - old) / old
    except:
        return None

# ================================================================
# SIGNALS
# ================================================================
def get_signals():
    try:
        return json.load(open("signals.json"))
    except:
        return []

def score_signal(s):
    vol = s.get("volRatio", 1)
    if isinstance(vol, str):
        vol = float(vol)
    return min(s.get("touches",3),6)*10 + min(vol,5)*8

# ================================================================
# CLASSIFY
# ================================================================
def classify(change, pot_type):
    if pot_type == "core":
        if change >= 0.15: return "⚡ STRONG","Hold"
        if change >= -0.05: return "✅ HOLD","On track"
        return "🧊 WEAK","DCA"

    if pot_type == "aggressive":
        t = TRIM_THRESHOLDS["aggressive"]
        if change >= t["exit"]: return "🚨 EXIT","Sell majority"
        if change >= t["profit"]: return "🔥 TAKE PROFIT","Take profit"
        if change >= t["trim"]: return "✂️ TRIM","Trim 25%"
        if change >= -0.05: return "✅ HOLD","Hold"
        return "🧊 WAIT","Wait"

    if pot_type == "crypto":
        t = TRIM_THRESHOLDS["crypto"]
        if change >= t["exit"]: return "🚨 TAKE MAJORITY","Sell majority"
        if change >= t["profit"]: return "🔥 TAKE PROFIT","Take profit"
        if change >= t["trim"]: return "✂️ TRIM","Trim"
        return "✅ HOLD","Hold"

# ================================================================
# MAIN
# ================================================================
def analyse():
    lines = []
    lines.append("📊 PORTFOLIO INTELLIGENCE")
    lines.append(datetime.utcnow().strftime("%d %b %Y %H:%M UTC"))

    for name, pot, type_, num in [
        ("CORE", POT_1_CORE, "core",1),
        ("AGGRESSIVE", POT_2_AGGRESSIVE,"aggressive",2),
        ("CRYPTO", POT_3_CRYPTO,"crypto",3)
    ]:
        lines.append(f"\n--- POT {num} {name} ---")

        for t, alloc in pot.items():
            data = get_crypto_data(t) if num==3 else get_stock_data(t)
            display = CRYPTO_NAMES.get(t,t)

            if not data:
                lines.append(f"{display} — no data")
                continue

            _, change = data
            status,_ = classify(change,type_)

            lines.append(f"{display} {round(change*100,1)}% {status}")

    signals = get_signals()
    if signals:
        ranked = sorted(signals, key=score_signal, reverse=True)

        lines.append("\n🎯 SNIPER")

        for s in ranked[:3]:
            conf = s.get("confidence")
            if conf is None:
                conf = round(score_signal(s),1)

            lines.append(f"{s.get('asset')} | confidence {conf}%")

    return "\n".join(lines)

# ================================================================
# LOOP
# ================================================================
def run():
    while True:
        msg = analyse()
        print(msg)
        send(msg)
        time.sleep(CHECK_INTERVAL)

if __name__ == "__main__":
    run()
