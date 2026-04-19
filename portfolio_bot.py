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

CHECK_INTERVAL  = 6 * 60 * 60
LAST_TRADE_FILE = "last_trade.json"
STAGNANT_FILE   = "stagnant_alerted.json"

STAGNANT_PCT      = 0.20
STAGNANT_BEAT_PCT = 0.30
REBALANCE_DRIFT   = 0.05

MIN_SWAP_EDGE       = 10
MAX_SWAPS_PER_RUN   = 1
SWAP_COOLDOWN_HOURS = 72

# ================================================================
# POTS
# ================================================================

POT_1_CORE = {
    "SMH": 0.29,
    "EQQQ.L": 0.25,
    "INDA": 0.20,
    "PLTR": 0.13,
    "VRT": 0.08,
    "ETHC.L": 0.05,
}

POT_2_AGGRESSIVE = {
    "APP": 0.28,
    "AMD": 0.22,
    "MSTR": 0.20,
    "ASTS": 0.15,
    "SOUN": 0.10,
    "COIN": 0.05,
}

POT_3_CRYPTO = {
    "RENDERUSDT": 0.333,
    "FETUSDT": 0.267,
    "SOLUSDT": 0.200,
    "ETHUSDT": 0.200,
}

CRYPTO_NAMES = {
    "RENDERUSDT": "RENDER",
    "FETUSDT": "FET",
    "SOLUSDT": "SOL",
    "ETHUSDT": "ETH",
}

TICKER_POT = {}
for t in POT_1_CORE: TICKER_POT[t] = ("core", 1)
for t in POT_2_AGGRESSIVE: TICKER_POT[t] = ("aggressive", 2)
for t in POT_3_CRYPTO: TICKER_POT[t] = ("crypto", 3)

VOLATILE_STOCKS = {
    "COIN","MSTR","HOOD","IONQ","SMCI","ARM","ASTS","SOUN",
    "PLTR","APP","NVDA","AMD","META","TSLA","GEV"
}

TRIM_THRESHOLDS = {
    "aggressive": {"trim": 0.25, "profit": 0.45, "exit": 0.60},
    "crypto": {"trim": 0.35, "profit": 0.50, "exit": 0.60},
}

# ================================================================
# TELEGRAM
# ================================================================

def send(msg, urgent=False):
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
# DATA
# ================================================================

def get_stock_data(ticker):
    try:
        hist = yf.Ticker(ticker).history(period="1mo")
        if hist.empty:
            return None
        current = float(hist["Close"].iloc[-1])
        old     = float(hist["Close"].iloc[0])
        return current, (current - old) / old
    except:
        return None

def get_crypto_data(symbol):
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

# ================================================================
# SIGNALS
# ================================================================

def get_signals():
    try:
        return json.load(open("signals.json"))
    except:
        return []

def score_signal(s):
    return min(s.get("touches",3),6)*10 + min(float(s.get("volRatio",1)),5)*8

# ================================================================
# COOLDOWN
# ================================================================

def get_last_trade_time():
    try:
        return json.load(open(LAST_TRADE_FILE)).get("time",0)
    except:
        return 0

def save_trade_time():
    json.dump({"time":time.time()}, open(LAST_TRADE_FILE,"w"))

def cooldown_active():
    return (time.time() - get_last_trade_time()) < SWAP_COOLDOWN_HOURS*3600

# ================================================================
# IMPROVEMENT
# ================================================================

def calculate_improvement(old, best, score):
    return round(((best-old)*0.5 + (score/100)*0.5)*100,1)

# ================================================================
# ANALYSE POT
# ================================================================

def analyse_pot(holdings, pot_num):
    performance = []
    for t in holdings:
        data = get_crypto_data(t) if pot_num == 3 else get_stock_data(t)
        if data:
            performance.append((t, data[1]))
    return performance

# ================================================================
# SWAPS
# ================================================================

def find_swaps(holdings, pot_num, perf, signals):
    swaps = []

    if pot_num == 1 or not perf or not signals:
        return swaps

    best_in_pot = max(perf, key=lambda x:x[1])
    best_signal = sorted(signals, key=score_signal, reverse=True)[0]

    for t, chg in perf:

        if abs(chg) > STAGNANT_PCT:
            continue

        if best_in_pot[1] < STAGNANT_BEAT_PCT:
            continue

        imp = calculate_improvement(
            chg,
            best_in_pot[1],
            score_signal(best_signal)
        )

        if imp < MIN_SWAP_EDGE:
            continue

        swaps.append((t, best_signal["asset"], pot_num, imp))

    return swaps

# ================================================================
# MAIN
# ================================================================

def analyse():
    signals = get_signals()

    p1 = analyse_pot(POT_1_CORE, 1)
    p2 = analyse_pot(POT_2_AGGRESSIVE, 2)
    p3 = analyse_pot(POT_3_CRYPTO, 3)

    swaps = (
        find_swaps(POT_2_AGGRESSIVE, 2, p2, signals) +
        find_swaps(POT_3_CRYPTO, 3, p3, signals)
    )

    if swaps and cooldown_active():
        return "⏳ Cooldown active", False

    if swaps:
        swaps.sort(key=lambda x:x[3], reverse=True)
        swap = swaps[0]

        msg = f"""🚨 ACTION NEEDED

Replace {swap[0]} → {swap[1]}
Expected improvement: +{swap[3]}%

Do:
• Sell {swap[0]}
• Buy {swap[1]}
"""

        return msg, True

    return "All good", False

# ================================================================
# LOOP
# ================================================================

def run():
    while True:
        msg, send_flag = analyse()

        if send_flag:
            send(msg)
            save_trade_time()
        else:
            print(msg)

        time.sleep(CHECK_INTERVAL)

# ================================================================
# START
# ================================================================

if __name__ == "__main__":
    if not os.path.exists("signals.json"):
        open("signals.json","w").write("[]")

    run()
