import time
import requests
import yfinance as yf
from datetime import datetime
from zoneinfo import ZoneInfo
import os
import json
import traceback

BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")

TOTAL_CAPITAL = 300
BUY_MODE = True

SIGNAL_FILE = "signals.json"
HOLDINGS_FILE = "holdings.json"

session = requests.Session()

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
    "RENDER": 0.33,
    "FET": 0.27,
    "SOL": 0.20,
    "ETH": 0.20,
}

COINGECKO_IDS = {
    "RENDER": "render-token",
    "FET": "fetch-ai",
    "SOL": "solana",
    "ETH": "ethereum",
}


def log(msg):
    print("[portfolio]", msg, flush=True)


def send(msg):
    if not BOT_TOKEN or not CHAT_ID:
        return
    try:
        parts = [msg[i:i+4000] for i in range(0, len(msg), 4000)]
        for p in parts:
            session.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                json={"chat_id": CHAT_ID, "text": p},
                timeout=10
            )
    except Exception as e:
        log(f"Telegram error: {e}")


def get_stock_data(ticker):
    try:
        hist = yf.Ticker(ticker).history(period="1mo", interval="1d")
        if hist.empty or len(hist) < 2:
            return None
        current = float(hist["Close"].iloc[-1])
        old = float(hist["Close"].iloc[0])
        if old == 0:
            return None
        return current, (current - old) / old
    except Exception as e:
        log(f"Stock error {ticker}: {e}")
        return None


def get_crypto_data(symbol):
    try:
        cid = COINGECKO_IDS.get(symbol)
        if not cid:
            return None

        r = session.get(
            f"https://api.coingecko.com/api/v3/coins/{cid}/market_chart?vs_currency=usd&days=30",
            timeout=10
        )
        data = r.json()

        prices = data.get("prices")
        if not prices or len(prices) < 2:
            return None

        current = prices[-1][1]
        old = prices[0][1]

        if old == 0:
            return None

        return current, (current - old) / old
    except Exception as e:
        log(f"Crypto error {symbol}: {e}")
        return None


def get_signals():
    try:
        with open(SIGNAL_FILE, "r") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except:
        return []


def get_holdings():
    try:
        with open(HOLDINGS_FILE, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except:
        return {}


def build_buy_plan():
    pots = [
        ("CORE", POT_1_CORE, 0.5, "stock"),
        ("AGGRESSIVE", POT_2_AGGRESSIVE, 0.3, "stock"),
        ("CRYPTO", POT_3_CRYPTO, 0.2, "crypto"),
    ]

    lines = []
    lines.append("💰 BUY PLAN")
    lines.append(f"Total: £{TOTAL_CAPITAL}")
    lines.append("")

    for name, pot, ratio, ptype in pots:
        pot_value = TOTAL_CAPITAL * ratio
        lines.append(f"📦 {name} (£{round(pot_value,2)})")

        for ticker, weight in pot.items():
            target_value = pot_value * weight

            data = get_crypto_data(ticker) if ptype == "crypto" else get_stock_data(ticker)
            if not data:
                lines.append(f"⚪ {ticker} — no data")
                continue

            price, _ = data
            units = target_value / price if price else 0
            units = round(units, 4) if ptype == "crypto" else round(units, 2)

            lines.append(f"{ticker:<8} | £{round(target_value,2):>6} | {units} units")

        lines.append("")

    return "\n".join(lines)


def calculate_portfolio():
    holdings = get_holdings()
    total = 0
    values = {}

    for t, units in holdings.items():
        if units == 0:
            continue

        data = get_crypto_data(t) if t in COINGECKO_IDS else get_stock_data(t)
        if not data:
            continue

        price, _ = data
        val = price * units

        values[t] = val
        total += val

    return total, values


def build_rebalance():
    total, values = calculate_portfolio()

    lines = []
    lines.append("⚖️ ACTIONS")

    if total == 0:
        lines.append("No holdings yet")
        return lines

    for pot in [POT_1_CORE, POT_2_AGGRESSIVE, POT_3_CRYPTO]:
        for t, target in pot.items():
            current = values.get(t, 0)
            target_val = total * target
            diff = current - target_val

            if abs(diff) < total * 0.02:
                continue

            if diff > 0:
                lines.append(f"✂️ {t} SELL £{round(diff,2)}")
            else:
                lines.append(f"🟢 {t} BUY £{round(abs(diff),2)}")

    return lines


def analyse():
    lines = []

    now = datetime.now(ZoneInfo("Europe/London"))
    total, values = calculate_portfolio()

    lines.append("📊 PORTFOLIO SUMMARY")
    lines.append(now.strftime("%d %b %Y %H:%M UK"))
    lines.append("")
    lines.append(f"💰 Total: £{round(total,2)}")
    lines.append("")

    perf = []

    for t in values:
        data = get_crypto_data(t) if t in COINGECKO_IDS else get_stock_data(t)
        if not data:
            continue
        _, c = data
        perf.append((t, c))

    if perf:
        perf.sort(key=lambda x: x[1], reverse=True)

        lines.append("🔥 TOP")
        for t, c in perf[:3]:
            lines.append(f"{t} {round(c*100,1)}%")

        lines.append("")
        lines.append("⚠️ WORST")
        for t, c in perf[-3:]:
            lines.append(f"{t} {round(c*100,1)}%")

        lines.append("")

    lines.extend(build_rebalance())

    signals = get_signals()
    if signals:
        best = sorted(signals, key=lambda x: x.get("confidence", 0), reverse=True)[0]
        lines.append("")
        lines.append("🎯 SNIPER")
        lines.append(f"{best.get('asset')} {best.get('confidence')}%")

    return "\n".join(lines)


def run():
    log("Portfolio bot started")

    if not os.path.exists(SIGNAL_FILE):
        with open(SIGNAL_FILE, "w") as f:
            f.write("[]")

    if not os.path.exists(HOLDINGS_FILE):
        with open(HOLDINGS_FILE, "w") as f:
            f.write("{}")

    try:
        if BUY_MODE:
            send(build_buy_plan())

        send(analyse())

    except Exception:
        traceback.print_exc()


if __name__ == "__main__":
    run()
