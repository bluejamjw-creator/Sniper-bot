import time
import requests
import yfinance as yf
from datetime import datetime
import os
import json
import traceback

BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")

CHECK_INTERVAL = 600
SIGNAL_FILE = "signals.json"

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
    "RENDERUSDT": 0.33,
    "FETUSDT": 0.27,
    "SOLUSDT": 0.20,
    "ETHUSDT": 0.20,
}

CRYPTO_NAMES = {
    "RENDERUSDT": "RENDER",
    "FETUSDT": "FET",
    "SOLUSDT": "SOL",
    "ETHUSDT": "ETH",
}

TRIM_THRESHOLDS = {
    "aggressive": {"trim": 0.25, "profit": 0.45, "exit": 0.60},
    "crypto": {"trim": 0.35, "profit": 0.50, "exit": 0.60},
}

session = requests.Session()


def log(msg):
    print("[portfolio]", msg, flush=True)


def send(msg):
    if not BOT_TOKEN or not CHAT_ID:
        log("Telegram disabled")
        return

    try:
        parts = [msg[i:i + 4000] for i in range(0, len(msg), 4000)]
        for part in parts:
            session.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                json={"chat_id": CHAT_ID, "text": part},
                timeout=15
            )
    except Exception as e:
        log(f"Telegram error: {e}")


def get_stock_data(ticker):
    try:
        hist = yf.Ticker(ticker).history(period="1mo")
        if hist.empty or len(hist) < 2:
            return None

        current = float(hist["Close"].iloc[-1])
        old = float(hist["Close"].iloc[0])

        if old == 0:
            return None

        change = (current - old) / old
        if change != change:
            return None

        return current, change
    except Exception as e:
        log(f"Stock error {ticker}: {e}")
        return None


def get_crypto_data(symbol):
    if not symbol.endswith("USDT"):
        symbol += "USDT"

    try:
        price_data = session.get(
            f"https://api.binance.com/api/v3/ticker/price?symbol={symbol}",
            timeout=10
        ).json()

        if not isinstance(price_data, dict) or "price" not in price_data:
            return None

        price = float(price_data["price"])

        candles = session.get(
            f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval=1d&limit=31",
            timeout=10
        ).json()

        if not isinstance(candles, list) or len(candles) < 2:
            return None

        old = float(candles[0][1])
        if old == 0:
            return None

        change = (price - old) / old
        if change != change:
            return None

        return price, change

    except Exception as e:
        log(f"Crypto error {symbol}: {e}")
        return None


def get_signals():
    try:
        with open(SIGNAL_FILE, "r") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:
        log(f"Signal read error: {e}")
        return []


def score_signal(s):
    return s.get("confidence", 0)


def classify(change, pot_type):
    if pot_type == "core":
        if change >= 0.15:
            return "STRONG"
        if change >= -0.05:
            return "HOLD"
        return "WEAK"

    if pot_type == "aggressive":
        t = TRIM_THRESHOLDS["aggressive"]
        if change >= t["exit"]:
            return "EXIT"
        if change >= t["profit"]:
            return "TAKE PROFIT"
        if change >= t["trim"]:
            return "TRIM"
        if change >= -0.05:
            return "HOLD"
        return "WATCH"

    if pot_type == "crypto":
        t = TRIM_THRESHOLDS["crypto"]
        if change >= t["exit"]:
            return "TAKE MAJORITY"
        if change >= t["profit"]:
            return "TAKE PROFIT"
        if change >= t["trim"]:
            return "TRIM"
        if change >= -0.08:
            return "HOLD"
        return "WATCH"

    return "HOLD"


def analyse_pot(name, pot, pot_type, pot_num):
    lines = []
    lines.append("━━━━━━━━━━━━━━")
    lines.append(f"📦 POT {pot_num} — {name}")
    lines.append("━━━━━━━━━━━━━━")

    for ticker, alloc in pot.items():
        data = get_crypto_data(ticker) if pot_type == "crypto" else get_stock_data(ticker)
        display = CRYPTO_NAMES.get(ticker, ticker)

        if not data:
            lines.append(f"⚪ {display:<8} | no data")
            continue

        _, change = data
        status = classify(change, pot_type)

        emoji = {
            "STRONG": "🔥",
            "HOLD": "✅",
            "WEAK": "🧊",
            "TRIM": "✂️",
            "TAKE PROFIT": "💰",
            "EXIT": "🚨",
            "WATCH": "👀",
            "TAKE MAJORITY": "💸"
        }.get(status, "•")

        lines.append(f"{emoji} {display:<8} | {round(change * 100, 1):>5}%")

    return lines


def analyse():
    lines = []

    lines.append("📊 PORTFOLIO INTELLIGENCE")
    lines.append("🕒 " + datetime.utcnow().strftime("%d %b %Y %H:%M UTC"))
    lines.append("")

    lines.extend(analyse_pot("CORE", POT_1_CORE, "core", 1))
    lines.append("")
    lines.extend(analyse_pot("AGGRESSIVE", POT_2_AGGRESSIVE, "aggressive", 2))
    lines.append("")
    lines.extend(analyse_pot("CRYPTO", POT_3_CRYPTO, "crypto", 3))

    signals = get_signals()

    if signals:
        ranked = sorted(signals, key=score_signal, reverse=True)

        lines.append("")
        lines.append("━━━━━━━━━━━━━━")
        lines.append("🎯 SNIPER SIGNAL")
        lines.append("━━━━━━━━━━━━━━")

        for s in ranked[:1]:
            conf = s.get("confidence", 0)
            bars = "█" * int(conf / 10)

            lines.append(
                f"🚀 {s.get('asset')} — {conf}%\n"
                f"Entry: {s.get('entry')} | SL: {s.get('sl')} | TP: {s.get('tp')}\n"
                f"Confidence: {bars}"
            )

    return "\n".join(lines)


def run():
    log("Portfolio bot started")

    if not os.path.exists(SIGNAL_FILE):
        with open(SIGNAL_FILE, "w") as f:
            f.write("[]")

    while True:
        try:
            msg = analyse()
            print(msg, flush=True)
            send(msg)
        except Exception:
            traceback.print_exc()

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    run()
