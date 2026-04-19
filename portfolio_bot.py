import time
import requests
import yfinance as yf
from datetime import datetime

import os

BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")

CHECK_INTERVAL = 3600  # 1 hour
PROFIT_TAKE = 0.25     # 25%
STOP_LOSS = -0.20      # -20%

# ================================
# YOUR PORTFOLIO (EDIT THIS)
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
# GET PRICE DATA
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
# ANALYSIS
# ================================
def analyse():
    report = "📊 Portfolio Update\n\n"

    for pot_name, assets in portfolio.items():
        report += f"--- {pot_name.upper()} ---\n"

        for ticker, weight in assets.items():
            data = get_data(ticker)

            if not data:
                report += f"{ticker}: no data\n"
                continue

            price, change = data

            # Status logic
            if change >= PROFIT_TAKE:
                status = "🔥 TAKE PROFIT"
            elif change <= STOP_LOSS:
                status = "❌ CUT / REVIEW"
            else:
                status = "✅ HOLD"

            report += f"{ticker} ({int(weight*100)}%)\n"
            report += f"Price: ${round(price,2)} | Change: {round(change*100,2)}%\n"
            report += f"{status}\n\n"

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
    print("Portfolio bot running...")
    run()
