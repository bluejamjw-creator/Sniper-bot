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

CHECK_INTERVAL = 6 * 60 * 60

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

TRIM_THRESHOLDS = {
    "aggressive": {"trim": 0.25, "profit": 0.45, "exit": 0.60},
    "crypto":     {"trim": 0.35, "profit": 0.50, "exit": 0.60},
}

# ================================================================
# TELEGRAM
# ================================================================
def send(msg):
    if not BOT_TOKEN or not CHAT_ID:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={"chat_id": CHAT_ID, "text": msg},
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

        change = (current - old) / old

        if change != change:  # NaN protection
            return None

        return current, change

    except:
        return None

# ================================================================
# DATA — CRYPTO (FIXED)
# ================================================================
def get_crypto_data(symbol):
    if not symbol.endswith("USDT"):
        symbol += "USDT"

    try:
        r = requests.get(
            f"https://api.binance.com/api/v3/ticker/price?symbol={symbol}",
            timeout=10
        )
        data = r.json()

        if "price" not in data:
            return None

        price = float(data["price"])

        candles = requests.get(
            f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval=1d&limit=31",
            timeout=10
        ).json()

        if not candles or len(candles) < 2:
            return None

        old = float(candles[0][1])
        if old == 0:
            return None

        change = (price - old) / old

        if change != change:  # NaN protection
            return None

        return price, change

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
        if change >= 0.15: return "⚡ STRONG"
        if change >= -0.05: return "✅ HOLD"
        return "🧊 WEAK"

    if pot_type == "aggressive":
        t = TRIM_THRESHOLDS["aggressive"]
        if change >= t["exit"]: return "🚨 EXIT"
        if change >= t["profit"]: return "🔥 TAKE PROFIT"
        if change >= t["trim"]: return "✂️ TRIM"
        if change >= -0.05: return "✅ HOLD"
        return "🧊 WAIT"

    if pot_type == "crypto":
        t = TRIM_THRESHOLDS["crypto"]
        if change >= t["exit"]: return "🚨 TAKE MAJORITY"
        if change >= t["profit"]: return "🔥 TAKE PROFIT"
        if change >= t["trim"]: return "✂️ TRIM"
        return "✅ HOLD"

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
            status = classify(change,type_)

            lines.append(f"{display} {round(change*100,1)}% {status}")

    # ============================================================
    # SNIPER OUTPUT (UPGRADED)
    # ============================================================
    signals = get_signals()
    if signals:
        ranked = sorted(signals, key=score_signal, reverse=True)

        lines.append("\n🎯 SNIPER (Top 3)")

        for s in ranked[:3]:
            conf = s.get("confidence")
            if conf is None:
                conf = round(score_signal(s),1)

            lines.append(
                f"\n{s.get('asset')} ({conf}%)\n"
                f"Entry: {s.get('entry')}\n"
                f"SL: {s.get('sl')}\n"
                f"TP: {s.get('tp')}"
            )

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
