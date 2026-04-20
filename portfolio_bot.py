import requests
import yfinance as yf
import os
import json

BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")

DATA_DIR = os.getenv("DATA_DIR", ".")
SIGNAL_FILE = os.path.join(DATA_DIR, "signals.json")
HOLDINGS_FILE = os.path.join(DATA_DIR, "holdings.json")

COINGECKO_IDS = {
    "SOL": "solana",
    "ETH": "ethereum",
    "FET": "fetch-ai",
    "RENDER": "render-token"
}

session = requests.Session()

# ------------------
# TELEGRAM
# ------------------
def send(msg):
    if not BOT_TOKEN or not CHAT_ID:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={"chat_id": CHAT_ID, "text": msg}
        )
    except:
        pass

# ------------------
# HELPERS
# ------------------
def normalize(symbol):
    return (symbol or "").replace("USDT", "").upper()

def get_signals():
    try:
        with open(SIGNAL_FILE) as f:
            return json.load(f)
    except:
        return []

def get_latest_signal():
    signals = get_signals()
    return max(signals, key=lambda x: x.get("time", 0)) if signals else None

# ------------------
# DATA
# ------------------
def get_crypto_price(symbol):
    cid = COINGECKO_IDS.get(symbol)
    if not cid:
        return None

    try:
        r = session.get(
            f"https://api.coingecko.com/api/v3/simple/price?ids={cid}&vs_currencies=usd"
        ).json()

        price = r.get(cid, {}).get("usd")
        return float(price) if price else None
    except:
        return None

def get_stock_price(symbol):
    try:
        h = yf.Ticker(symbol).history(period="1mo")
        return float(h["Close"].iloc[-1]) if not h.empty else None
    except:
        return None

# ------------------
# PORTFOLIO
# ------------------
def calculate():
    try:
        with open(HOLDINGS_FILE) as f:
            holdings = json.load(f)
    except:
        holdings = {}

    total = 0
    values = {}

    for t, units in holdings.items():
        n = normalize(t)

        price = get_crypto_price(n) if n in COINGECKO_IDS else get_stock_price(t)
        if not price:
            continue

        val = price * units
        values[t] = val
        total += val

    return total, values

# ------------------
# SWAP LOGIC
# ------------------
def build_swap():
    total, values = calculate()

    if total <= 0:
        return "🔁 No holdings"

    signal = get_latest_signal()
    if not signal:
        return "🔁 No signal"

    incoming = normalize(signal.get("asset"))
    confidence = float(signal.get("confidence", 0))

    if confidence < 60:
        return "🔁 Signal too weak"

    # pick largest holding
    source = max(values, key=values.get)
    value = values[source]

    swap = round(value * 0.3, 2)

    if normalize(source) == incoming:
        return "🔁 Same asset"

    return f"""🔁 SMART SWAP

SELL {source} £{swap}
BUY {incoming} £{swap}

Signal: {confidence}%"""

# ------------------
# RUN
# ------------------
def run():
    os.makedirs(DATA_DIR, exist_ok=True)

    if not os.path.exists(HOLDINGS_FILE):
        with open(HOLDINGS_FILE, "w") as f:
            f.write("{}")

    if not os.path.exists(SIGNAL_FILE):
        with open(SIGNAL_FILE, "w") as f:
            f.write("[]")

    print("Portfolio running...")

    msg = build_swap()
    print(msg)
    send(msg)

if __name__ == "__main__":
    run()
