import os
import json
import requests
import yfinance as yf
from datetime import datetime
from zoneinfo import ZoneInfo

BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")

DATA_DIR = os.getenv("DATA_DIR", ".")
SIGNAL_FILE = os.path.join(DATA_DIR, "signals.json")
HOLDINGS_FILE = os.path.join(DATA_DIR, "holdings.json")

session = requests.Session()
session.headers.update({"User-Agent": "portfolio-bot/1.0"})

UK_TZ = ZoneInfo("Europe/London")

CRYPTO_IDS = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "SOL": "solana",
    "FET": "fetch-ai",
    "RNDR": "render-token",
    "RENDER": "render-token",
}

POTS = {
    "core": ["SMH", "EQQQ.L", "INDA", "PLTR", "VRT", "ETHC.L"],
    "aggressive": ["APP", "AMD", "MSTR", "ASTS", "SOUN", "COIN"],
    "crypto": ["RNDR", "FET", "SOL", "ETH"],
}


def send(msg):
    if not BOT_TOKEN or not CHAT_ID:
        print("Missing BOT_TOKEN or CHAT_ID")
        return

    try:
        response = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={
                "chat_id": CHAT_ID,
                "text": msg,
                "disable_web_page_preview": True,
            },
            timeout=20,
        )
        response.raise_for_status()
    except Exception as e:
        print(f"Telegram send error: {e}")


def now_uk():
    return datetime.now(UK_TZ)


def format_uk_time():
    return now_uk().strftime("%d %b %Y %H:%M UK")


def normalize(symbol):
    s = (symbol or "").strip().upper()
    if s.endswith("USDT"):
        s = s[:-4]
    return s


def load_json_file(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json_file(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def ensure_files():
    os.makedirs(DATA_DIR, exist_ok=True)

    if not os.path.exists(HOLDINGS_FILE):
        save_json_file(HOLDINGS_FILE, {})

    if not os.path.exists(SIGNAL_FILE):
        save_json_file(SIGNAL_FILE, [])


def get_signals():
    return load_json_file(SIGNAL_FILE, [])


def get_latest_signal():
    signals = get_signals()
    if not signals:
        return None
    return max(signals, key=lambda x: x.get("time", 0))


def get_crypto_price(symbol):
    coin_id = CRYPTO_IDS.get(normalize(symbol))
    if not coin_id:
        return None

    try:
        response = session.get(
            "https://api.coingecko.com/api/v3/simple/price",
            params={"ids": coin_id, "vs_currencies": "usd"},
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        price = data.get(coin_id, {}).get("usd")
        return float(price) if price is not None else None
    except Exception as e:
        print(f"Crypto price error for {symbol}: {e}")
        return None


def get_stock_price(symbol):
    try:
        history = yf.Ticker(symbol).history(period="5d")
        if history.empty:
            return None
        return float(history["Close"].dropna().iloc[-1])
    except Exception as e:
        print(f"Stock price error for {symbol}: {e}")
        return None


def get_price(symbol):
    n = normalize(symbol)
    if n in CRYPTO_IDS:
        return get_crypto_price(n)
    return get_stock_price(symbol)


def load_holdings():
    return load_json_file(HOLDINGS_FILE, {})


def calculate_portfolio():
    holdings = load_holdings()
    total = 0.0
    values = {}
    prices = {}

    for ticker, units in holdings.items():
        try:
            units = float(units)
        except Exception:
            continue

        price = get_price(ticker)
        prices[ticker] = price

        if price is None:
            continue

        value = price * units
        values[ticker] = value
        total += value

    return total, values, prices, holdings


def pick_action(total, latest_signal):
    if total <= 0:
        return "No holdings yet"

    if not latest_signal:
        return "Hold - no signal"

    confidence = float(latest_signal.get("confidence", 0))
    asset = normalize(latest_signal.get("asset"))

    if confidence >= 80:
        return f"High-confidence watch: {asset}"
    if confidence >= 60:
        return f"Review signal: {asset}"
    return "Hold - signal too weak"


def build_portfolio_summary():
    total, values, prices, holdings = calculate_portfolio()
    latest_signal = get_latest_signal()
    action = pick_action(total, latest_signal)

    lines = [
        "📊 PORTFOLIO SUMMARY",
        format_uk_time(),
        "",
        f"💰 Total: £{round(total, 2)}",
        "",
        "⚖️ ACTIONS",
        action,
    ]

    return "
".join(line.rstrip() for line in lines).strip()


def build_buy_plan():
    total_budget = 300.0

    allocations = {
        "core": 150.0,
        "aggressive": 90.0,
        "crypto": 60.0,
    }

    weights = {
        "core": {
            "SMH": 0.29,
            "EQQQ.L": 0.25,
            "INDA": 0.20,
            "PLTR": 0.13,
            "VRT": 0.08,
            "ETHC.L": 0.05,
        },
        "aggressive": {
            "APP": 0.28,
            "AMD": 0.22,
            "MSTR": 0.20,
            "ASTS": 0.15,
            "SOUN": 0.10,
            "COIN": 0.05,
        },
        "crypto": {
            "RNDR": 0.33,
            "FET": 0.27,
            "SOL": 0.20,
            "ETH": 0.20,
        },
    }

    lines = [
        "🧰 BUY PLAN",
        f"Total: £{int(total_budget)}",
        "",
    ]

    for pot_name in ["core", "aggressive", "crypto"]:
        pot_total = allocations[pot_name]
        emoji = "📦" if pot_name == "core" else "🔥" if pot_name == "aggressive" else "🪙"
        lines.append(f"{emoji} {pot_name.upper()} (£{pot_total})")

        for ticker, weight in weights[pot_name].items():
            amount = round(pot_total * weight, 2)
            price = get_price(ticker)

            if price is None or price <= 0:
                lines.append(f"{ticker}  | £{amount} | no data")
            else:
                units = round(amount / price, 4)
                lines.append(f"{ticker} | £{amount} | {units} units")

        lines.append("")

    return "
".join(line.rstrip() for line in lines).strip()


def run():
    ensure_files()

    print("Portfolio bot running...")

    buy_plan = build_buy_plan()
    summary = build_portfolio_summary()

    final_message = f"{buy_plan}

{summary}"

    print(final_message)
    send(final_message)


if __name__ == "__main__":
    run()
