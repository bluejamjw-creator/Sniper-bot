import requests
import yfinance as yf
import os
import json

BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")

DATA_DIR = os.getenv("DATA_DIR", ".")
SIGNAL_FILE = os.path.join(DATA_DIR, "signals.json")
HOLDINGS_FILE = os.path.join(DATA_DIR, "holdings.json")

POT_1_CORE = {
    "SMH": 0.29, "EQQQ.L": 0.25, "INDA": 0.20,
    "PLTR": 0.13, "VRT": 0.08, "ETHC.L": 0.05,
}

POT_2_AGGRESSIVE = {
    "APP": 0.28, "AMD": 0.22, "MSTR": 0.20,
    "ASTS": 0.15, "SOUN": 0.10, "COIN": 0.05,
}

POT_3_CRYPTO = {
    "RENDER": 0.33, "FET": 0.27, "SOL": 0.20, "ETH": 0.20,
}

COINGECKO_IDS = {
    "RENDER": "render-token",
    "FET": "fetch-ai",
    "SOL": "solana",
    "ETH": "ethereum",
}

session = requests.Session()

# -------------------------
# HELPERS
# -------------------------
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

def normalize_all(symbol):
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

def get_stock_data(t):
    try:
        h = yf.Ticker(t).history(period="1mo")
        if h.empty:
            return None
        return float(h["Close"].iloc[-1]), 0
    except:
        return None

def get_crypto_data(t):
    try:
        cid = COINGECKO_IDS.get(t)
        if not cid:
            return None
        r = session.get(
            f"https://api.coingecko.com/api/v3/simple/price?ids={cid}&vs_currencies=usd"
        ).json()
        price = r.get(cid, {}).get("usd")
        if not price:
            return None
        return float(price), 0
    except:
        return None

def calculate_portfolio():
    try:
        with open(HOLDINGS_FILE) as f:
            holdings = json.load(f)
    except:
        holdings = {}

    total = 0
    values = {}

    for t, units in holdings.items():
        n = normalize_all(t)
        data = get_crypto_data(n) if n in COINGECKO_IDS else get_stock_data(t)
        if not data:
            continue

        price, _ = data
        val = price * units

        values[t] = val
        total += val

    return total, values

def get_confidence_multiplier(c):
    if c >= 80: return 0.75
    if c >= 70: return 0.5
    if c >= 60: return 0.25
    return 0

# -------------------------
# SMART SWAP
# -------------------------
def build_smart_swap():
    total, values = calculate_portfolio()

    if total <= 0:
        return "🔁 SMART SWAP\nNo holdings yet"

    signal = get_latest_signal()
    if not signal:
        return "🔁 SMART SWAP\nNo signal"

    incoming = normalize_all(signal.get("asset"))
    if not incoming:
        return "🔁 SMART SWAP\nInvalid signal"

    confidence = float(signal.get("confidence", 0))
    size_mult = get_confidence_multiplier(confidence)

    if size_mult == 0:
        return "🔁 SMART SWAP\nSignal too weak"

    targets = {}
    targets.update(POT_1_CORE)
    targets.update(POT_2_AGGRESSIVE)
    targets.update(POT_3_CRYPTO)

    candidates = []

    for t, val in values.items():
        n = normalize_all(t)
        current_w = val / total if total > 0 else 0
        drift = current_w - targets.get(n, 0)

        if drift > 0:
            candidates.append((t, drift))

    if not candidates:
        return "🔁 SMART SWAP\nNo candidates"

    candidates.sort(key=lambda x: x[1], reverse=True)
    source, drift = candidates[0]

    if normalize_all(source) == incoming:
        return "🔁 SMART SWAP\nSame asset"

    swap_value = round(total * drift * size_mult, 2)

    return (
        f"🔁 SMART SWAP\n\n"
        f"SELL {source} £{swap_value}\n"
        f"BUY {incoming} £{swap_value}\n\n"
        f"Reason:\n"
        f"Overweight {round(drift*100,1)}%\n"
        f"Signal {confidence}%"
    )

# -------------------------
# RUN
# -------------------------
def run():

    # ensure files exist
    if not os.path.exists(HOLDINGS_FILE):
        with open(HOLDINGS_FILE, "w") as f:
            f.write("{}")

    if not os.path.exists(SIGNAL_FILE):
        with open(SIGNAL_FILE, "w") as f:
            f.write("[]")

    print("Portfolio running...")

    result = build_smart_swap()
    print(result)
    send(result)

if __name__ == "__main__":
    run()
