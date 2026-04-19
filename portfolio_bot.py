import time
import requests
import yfinance as yf
from datetime import datetime
import os
import json

BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")

CHECK_INTERVAL = 3600  # 1 hour

# ================================
# YOUR PORTFOLIO
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
# TELEGRAM
# ================================
def send(msg):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    requests.post(url, json={"chat_id": CHAT_ID, "text": msg})

# ================================
# GET DATA
# ================================
def get_data(ticker):
    try:
        stock = yf.Ticker(ticker)
        hist = stock.history(period="1mo")

        if hist.empty:
            return None

        current = hist["Close"].iloc[-1]
        old = hist["Close"].iloc[0]

        change = (current - old) / old
        return current, change

    except:
        return None

# ================================
# CLASSIFICATION LOGIC (SMART MODE)
# ================================
def classify(change):
    if change >= 0.30:
        return "🔥 TRIM", "Overextended (lock profits)"
    elif change >= 0.15:
        return "⚡ STRONG", "Momentum strong (wait pullback)"
    elif change >= -0.05:
        return "✅ HOLD", "Healthy range"
    else:
        return "🧊 WAIT", "Weak (no adds)"

# ================================
# ANALYSIS
# ================================
def analyse():
    report = "📊 Portfolio Intelligence (Smart Mode)\n\n"
    actions = []

    for pot_name, assets in portfolio.items():
        report += f"--- {pot_name.upper()} ---\n"

        for ticker, weight in assets.items():
            data = get_data(ticker)

            if not data:
                report += f"{ticker}: no data\n"
                continue

            price, change = data
            status, note = classify(change)

            report += f"{ticker}: {round(change*100,2)}% {status} ({note})\n"

            # ACTION LOGIC
            if "TRIM" in status:
                actions.append(f"Trim {ticker} by 10% → move to CASH")
            elif "WAIT" in status:
                actions.append(f"Do NOT add to {ticker} yet")

        report += "\n"

    # Remove duplicates
    actions = list(dict.fromkeys(actions))

    if actions:
        report += "💡 Actions:\n"
        for a in actions:
            report += f"→ {a}\n"

    report += f"\n🕒 {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}"
    return report

# ================================
# MAIN LOOP
# ================================
def run():
    while True:
        try:
            msg = analyse()
            print("Sending update...")
            send(msg)
            print("Done.\n")

        except Exception as e:
            print("Error:", e)

        time.sleep(CHECK_INTERVAL)

# ================================
# START
# ================================
if __name__ == "__main__":
    print("Portfolio bot running (SMART MODE)...")
    run()
