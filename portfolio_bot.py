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
TARGETS_FILE = os.path.join(DATA_DIR, "targets.json")

session = requests.Session()
session.headers.update({"User-Agent": "portfolio-bot/2.0"})

UK_TZ = ZoneInfo("Europe/London")

CRYPTO_IDS = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "SOL": "solana",
    "FET": "fetch-ai",
    "RNDR": "render-token",
    "RENDER": "render-token",
}

DEFAULT_TARGETS = {
    "core": {"SMH": 29, "EQQQ.L": 25, "INDA": 20, "PLTR": 13, "VRT": 8, "COIN": 5},
    "aggressive": {"APP": 28, "AMD": 22, "MSTR": 20, "ASTS": 15, "SOUN": 10, "COIN": 5},
    "crypto": {"RNDR": 33, "FET": 27, "SOL": 20, "ETH": 20},
}

POT_ORDER = ["core", "aggressive", "crypto"]


def send(msg):
    if not BOT_TOKEN or not CHAT_ID:
        print(msg)
        return

    try:
        r = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={"chat_id": CHAT_ID, "text": msg, "disable_web_page_preview": True},
            timeout=20,
        )
        r.raise_for_status()
    except Exception as e:
        print(f"Telegram send error: {e}")
        print(msg)


def now_uk():
    return datetime.now(UK_TZ)


def format_uk_time():
    return now_uk().strftime("%d %b %Y %H:%M UK")


def normalize(symbol):
    s = (symbol or "").strip().upper()
    if s.endswith(".L"):
        return s
    if s.endswith("USDT"):
        return s[:-4]
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
    if not os.path.exists(TARGETS_FILE):
        save_json_file(TARGETS_FILE, DEFAULT_TARGETS)


def get_targets():
    data = load_json_file(TARGETS_FILE, DEFAULT_TARGETS)
    return data if isinstance(data, dict) else DEFAULT_TARGETS


def get_signals():
    data = load_json_file(SIGNAL_FILE, [])
    return data if isinstance(data, list) else []


def get_latest_signal():
    signals = get_signals()
    return max(signals, key=lambda x: x.get("time", 0)) if signals else None


def get_crypto_price(symbol):
    coin_id = CRYPTO_IDS.get(normalize(symbol))
    if not coin_id:
        return None

    try:
        r = session.get(
            "https://api.coingecko.com/api/v3/simple/price",
            params={"ids": coin_id, "vs_currencies": "usd"},
            timeout=20,
        )
        r.raise_for_status()
        p = r.json().get(coin_id, {}).get("usd")
        return float(p) if p is not None else None
    except Exception:
        return None


def get_stock_price(symbol):
    try:
        hist = yf.Ticker(symbol).history(period="5d")
        if hist.empty:
            return None
        return float(hist["Close"].dropna().iloc[-1])
    except Exception:
        return None


def get_price(symbol):
    n = normalize(symbol)
    return get_crypto_price(n) if n in CRYPTO_IDS else get_stock_price(symbol)


def load_holdings():
    data = load_json_file(HOLDINGS_FILE, {})
    return data if isinstance(data, dict) else {}


def calculate_portfolio():
    holdings = load_holdings()
    total = 0.0
    values, prices = {}, {}

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


def owned_assets(holdings):
    return {normalize(k) for k in holdings.keys()}


def build_sniper_context(holdings):
    latest = get_latest_signal()
    if not latest:
        return None, "No sniper signal"

    asset = normalize(latest.get("asset"))
    conf = float(latest.get("confidence", 0) or 0)
    source = latest.get("source", "sniper")
    in_portfolio = asset in owned_assets(holdings)

    if conf >= 80:
        action = "WATCH+" if in_portfolio else "BUY+WATCH"
    elif conf >= 60:
        action = "WATCH" if in_portfolio else "WATCHLIST"
    else:
        action = "IGNORE"

    return latest, f"{action} | {asset} | conf {int(conf)} | {source}"


def drift_report(total, values, targets):
    lines = []

    for pot in POT_ORDER:
        pot_targets = targets.get(pot, {})
        if not pot_targets:
            continue

        lines.append(f"{pot.upper()}")

        for ticker, w in pot_targets.items():
            current = values.get(ticker, 0.0)
            pct = (current / total * 100) if total > 0 else 0
            drift = pct - float(w)
            lines.append(f"{ticker}: {pct:.1f}% vs {w:.1f}% ({drift:+.1f}%)")

    return lines


def build_buy_plan(targets, budget=300.0):
    monthly = {"core": 100.0, "aggressive": 100.0, "crypto": 100.0}
    lines = ["🧰 BUY PLAN", f"Total: £{int(budget)}", ""]

    for pot in POT_ORDER:
        pot_total = monthly[pot]
        emoji = {"core": "📦", "aggressive": "🔥", "crypto": "🪙"}[pot]
        lines.append(f"{emoji} {pot.upper()} (£{int(pot_total)})")

        for ticker, weight in targets.get(pot, {}).items():
            amount = round(pot_total * float(weight) / 100.0, 2)
            price = get_price(ticker)

            if price and price > 0:
                units = round(amount / price, 4)
                lines.append(f"{ticker} | £{amount} | {units} units")
            else:
                lines.append(f"{ticker} | £{amount} | no data")

        lines.append("")

    return "\
".join(lines).strip()


def build_portfolio_summary():
    total, values, prices, holdings = calculate_portfolio()
    latest, sniper_line = build_sniper_context(holdings)
    targets = get_targets()

    lines = [
        "📊 PORTFOLIO SUMMARY",
        format_uk_time(),
        "",
        f"💰 Total: £{round(total, 2)}",
        "",
        "⚖️ SNIPER",
        sniper_line,
        "",
        "📍 DRIFT",
    ]

    lines.extend(drift_report(total, values, targets)[:30] or ["No holdings yet"])
    return "\
".join(lines).strip()


def run():
    ensure_files()
    msg = build_buy_plan(get_targets()) + "\
\
" + build_portfolio_summary()
    print(msg)
    send(msg)


if __name__ == "__main__":
    run()
