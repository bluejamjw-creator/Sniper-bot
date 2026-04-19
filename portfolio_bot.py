import time
import requests
import yfinance as yf
from datetime import datetime
import os
import json

BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")

CHECK_INTERVAL = 3600

COOLDOWN_FILE = "cooldown.json"

# ================================
# PORTFOLIO (BUY PRICES ONLY)
# ================================
portfolio = {
    "core": {
        "NVDA": {"buy": 180},
        "AVGO": {"buy": 315},
        "MSFT": {"buy": 390},
        "ANET": {"buy": 136},
        "MRVL": {"buy": 87},
    },
    "aggressive": {
        "APP": {"buy": 440},
        "AMD": {"buy": 200},
        "MSTR": {"buy": 140},
        "ASTS": {"buy": 90},
        "SOUN": {"buy": 7},
    }
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
def get_price(ticker):
    try:
        stock = yf.Ticker(ticker)
        data = stock.history(period="1d")
        if data.empty:
            return None
        return data["Close"].iloc[-1]
    except:
        return None

def get_signal():
    try:
        with open("signals.json", "r") as f:
            return json.load(f)
    except:
        return None

# ================================
# COOLDOWN
# ================================
def load_cooldown():
    try:
        with open(COOLDOWN_FILE, "r") as f:
            return json.load(f)
    except:
        return {}

def save_cooldown(data):
    with open(COOLDOWN_FILE, "w") as f:
        json.dump(data, f)

cooldowns = load_cooldown()

# ================================
# HELPERS
# ================================
def decision(pct):
    if pct >= 25:
        return "🔥 TRIM (overextended)"
    elif pct >= 15:
        return "⚡ STRONG"
    elif pct <= -20:
        return "❌ CUT"
    elif pct <= -10:
        return "⚠️ WEAK"
    else:
        return "✅ HOLD"

def impact_score(from_pct, to_pct):
    return round(to_pct - from_pct, 2)

# ================================
# ANALYSIS
# ================================
def analyse():
    report = "📊 Portfolio Intelligence (Final System)\n\n"

    signal = get_signal()

    valid_signal = False
    if signal:
        if signal.get("confidence") in ["HIGH", "VERY HIGH"] and signal.get("score", 0) >= 5:
            valid_signal = True

    for pot_name, assets in portfolio.items():
        report += f"--- {pot_name.upper()} ---\n"

        performance = []

        for ticker, data in assets.items():
            price = get_price(ticker)

            if not price:
                continue

            buy = data["buy"]
            pct = ((price - buy) / buy) * 100

            performance.append((ticker, pct))

            report += f"{ticker}: {round(pct,2)}% {decision(pct)}\n"

        performance.sort(key=lambda x: x[1], reverse=True)
        top = performance[:2]

        report += "\n🔁 Actions:\n"

        for ticker, pct in performance:
            now = time.time()
            last = cooldowns.get(ticker, 0)

            if now - last < 86400:
                continue

            # CORE RULES
            if pot_name == "core":
                if pct >= 25:
                    report += f"→ Trim {ticker} by 10%\n"
                    cooldowns[ticker] = now

                elif pct <= -20:
                    report += f"→ Reduce {ticker}\n"
                    cooldowns[ticker] = now

            # AGGRESSIVE RULES
            elif pot_name == "aggressive":
                if pct <= -15 and top:
                    target = None

                    if valid_signal:
                        target = signal["asset"].replace("/USDT", "")
                    else:
                        target = top[0][0]

                    impact = impact_score(pct, top[0][1])

                    if impact >= 5:
                        report += f"→ Move 20% from {ticker} → {target} (Impact +{impact}%)\n"
                        cooldowns[ticker] = now

                elif -5 < pct < 5 and top:
                    target = top[0][0]
                    impact = impact_score(pct, top[0][1])

                    if impact >= 5:
                        report += f"→ Rotate 10% from {ticker} → {target} (Impact +{impact}%)\n"
                        cooldowns[ticker] = now

                elif pct >= 25:
                    report += f"→ Trim {ticker} by 20%\n"
                    cooldowns[ticker] = now

        report += "\n"

    save_cooldown(cooldowns)

    report += f"\n🕒 {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}"

    return report

# ================================
# LOOP
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
    print("Final portfolio system running...")
    run()
