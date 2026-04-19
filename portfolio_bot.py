import time
import requests
import yfinance as yf
from datetime import datetime
import os
import json

# ================================
# SETTINGS
# ================================
BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")

CHECK_INTERVAL = 86400  # 24 hours

ACCOUNT_SIZE = 1000
RISK_PCT = 0.02
MAX_TOTAL_RISK = 0.06

LAST_TRADE_FILE = "last_trade.json"

# ================================
# PORTFOLIO
# ================================
portfolio = {
    "core": {
        "EQQQ": 0.25,
        "NVDA": 0.15,
        "AVGO": 0.12,
        "MSFT": 0.12,
        "VRT": 0.10,
        "TSM": 0.10,
        "ANET": 0.08,
        "MRVL": 0.08
    },
    "aggressive": {
        "APP": 0.30,
        "AMD": 0.25,
        "MSTR": 0.20,
        "ASTS": 0.15,
        "SOUN": 0.10
    }
}

# ================================
# SECTOR MAP
# ================================
SECTORS = {
    "NVDA": "AI", "AMD": "AI", "AVGO": "AI", "MRVL": "AI",
    "ANET": "AI", "MSFT": "AI", "TSM": "AI", "APP": "AI",
    "MSTR": "CRYPTO",
    "ASTS": "SPEC", "SOUN": "SPEC"
}

# ================================
# TELEGRAM
# ================================
def send(msg):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    requests.post(url, json={"chat_id": CHAT_ID, "text": msg})

# ================================
# DATA
# ================================
def get_data(ticker):
    try:
        stock = yf.Ticker(ticker)
        hist = stock.history(period="1mo")

        if hist.empty or len(hist) < 2:
            return None

        current = hist["Close"].iloc[-1]
        old = hist["Close"].iloc[0]

        if old == 0:
            return None

        change = (current - old) / old

        if str(change) == "nan":
            return None

        return current, change

    except:
        return None

# ================================
# SIGNALS (FIXED)
# ================================
def get_signals():
    try:
        with open("signals.json", "r") as f:
            return json.load(f)
    except:
        return []

# ================================
# TRADE COOLDOWN
# ================================
def last_trade_time():
    try:
        with open(LAST_TRADE_FILE, "r") as f:
            return json.load(f)["time"]
    except:
        return 0

def save_trade_time():
    with open(LAST_TRADE_FILE, "w") as f:
        json.dump({"time": time.time()}, f)

# ================================
# LOGIC
# ================================
def classify(change):
    if change >= 0.30:
        return "🔥 TRIM", "Overextended"
    elif change >= 0.15:
        return "⚡ STRONG", "Momentum"
    elif change >= -0.05:
        return "✅ HOLD", "Healthy"
    else:
        return "🧊 WAIT", "Weak"

def position_size(entry, stop):
    risk_amount = ACCOUNT_SIZE * RISK_PCT
    risk_per_unit = abs(entry - stop)

    if risk_per_unit == 0:
        return 0

    return round(risk_amount / risk_per_unit, 2)

def current_risk_estimate(performance):
    active = len([p for _, p in performance if p > -10])
    return active * RISK_PCT

def too_correlated(asset):
    sector = SECTORS.get(asset)
    if not sector:
        return False

    count = sum(
        1 for pot in portfolio.values()
        for a in pot if SECTORS.get(a) == sector
    )

    return count >= 4

def allow_new_trade(performance, asset):
    weak = len([p for _, p in performance if p < -5])
    strong = len([p for _, p in performance if p > 25])

    if weak >= 2:
        return False, "Too many weak positions"

    if strong >= 3:
        return False, "Market overheated"

    if current_risk_estimate(performance) >= MAX_TOTAL_RISK:
        return False, "Max risk reached"

    if too_correlated(asset):
        return False, "Too correlated"

    if time.time() - last_trade_time() < 86400:
        return False, "Cooldown active"

    return True, "OK"

# ================================
# ROTATION ENGINE (NEW)
# ================================
def rotation_engine(performance):
    weak = sorted([p for p in performance if p[1] < -0.05], key=lambda x: x[1])
    strong = sorted([p for p in performance if p[1] > 0.15], key=lambda x: x[1], reverse=True)

    actions = []

    for w, s in zip(weak, strong):
        impact = round((s[1] - w[1]) * 100, 2)
        actions.append(f"Rotate 10% from {w[0]} → {s[0]} (+{impact}%)")

    return actions

# ================================
# ANALYSIS
# ================================
def analyse():
    report = "📊 Portfolio Intelligence\n\n"
    actions = []
    performance = []

    for pot_name, assets in portfolio.items():
        report += f"--- {pot_name.upper()} ---\n"

        for ticker in assets:
            data = get_data(ticker)

            if not data:
                report += f"{ticker}: no data\n"
                continue

            price, change = data
            status, note = classify(change)

            performance.append((ticker, change))

            report += f"{ticker}: {round(change*100,2)}% {status} ({note})\n"

            if "TRIM" in status:
                actions.append(f"Trim {ticker} 10% → CASH")

        report += "\n"

    # =====================
    # WATCHLIST
    # =====================
    candidates = sorted(
        [(t, c) for t, c in performance if 0.05 < c < 0.20],
        key=lambda x: x[1],
        reverse=True
    )

    if candidates:
        report += "🎯 Watchlist\n"
        for t, c in candidates[:3]:
            report += f"→ {t} ({round(c*100,2)}%)\n"

    # =====================
    # ROTATION
    # =====================
    rotations = rotation_engine(performance)
    if rotations:
        report += "\n🔄 Smart Rotation\n"
        for r in rotations:
            report += f"→ {r}\n"

    # =====================
    # SNIPER
    # =====================
    signals = get_signals()

    if signals:
        report += "\n🤖 Sniper Opportunities\n"

        for asset in signals[-3:]:
            allowed, reason = allow_new_trade(performance, asset)

            if allowed:
                report += f"✅ {asset} allowed\n"
                save_trade_time()
            else:
                report += f"❌ {asset} blocked ({reason})\n"

    # =====================
    # ACTIONS
    # =====================
    if actions:
        report += "\n💡 Actions\n"
        for a in set(actions):
            report += f"→ {a}\n"

    report += f"\n🕒 {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}"
    return report

# ================================
# LOOP
# ================================
def run():
    while True:
        try:
            msg = analyse()

            if "💡 Actions" in msg or "Sniper" in msg:
                print("Sending update...")
                send(msg)
            else:
                print("No major change")

        except Exception as e:
            print("Error:", e)

        time.sleep(CHECK_INTERVAL)

# ================================
# START
# ================================
if __name__ == "__main__":
    print("Portfolio system running...")
    run()

