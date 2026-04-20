import time
import requests
import yfinance as yf
from datetime import datetime
import os
import json

# ================================================================
#  SETTINGS
# ================================================================
BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID   = os.getenv("CHAT_ID")

CHECK_INTERVAL      = 6 * 60 * 60    # Full report every 6 hours
STAGNANT_PCT        = 0.20            # Flat within ±20% over 60 days
STAGNANT_BEAT_PCT   = 0.30            # Only flag if another pos is up 30%+
REBALANCE_DRIFT     = 0.05            # Alert if drift 5%+ from target
MIN_SWAP_EDGE       = 10              # Minimum improvement % to suggest swap
SWAP_COOLDOWN_HOURS = 72              # Hours between swap suggestions
LAST_TRADE_FILE     = "last_trade.json"
STAGNANT_FILE       = "stagnant_alerted.json"

# ================================================================
#  3-POT STRUCTURE
# ================================================================
POT_1_CORE = {
    "SMH":    0.29,
    "EQQQ.L": 0.25,
    "INDA":   0.20,
    "PLTR":   0.13,
    "VRT":    0.08,
    "ETHC.L": 0.05,
}

POT_2_AGGRESSIVE = {
    "APP":  0.28,
    "AMD":  0.22,
    "MSTR": 0.20,
    "ASTS": 0.15,
    "SOUN": 0.10,
    "COIN": 0.05,
}

POT_3_CRYPTO = {
    "RENDERUSDT": 0.333,
    "FETUSDT":    0.267,
    "SOLUSDT":    0.200,
    "ETHUSDT":    0.200,
}

CRYPTO_NAMES = {
    "RENDERUSDT": "RENDER",
    "FETUSDT":    "FET",
    "SOLUSDT":    "SOL",
    "ETHUSDT":    "ETH",
}

TICKER_POT = {}
for t in POT_1_CORE:       TICKER_POT[t] = ("core",       1)
for t in POT_2_AGGRESSIVE: TICKER_POT[t] = ("aggressive", 2)
for t in POT_3_CRYPTO:     TICKER_POT[t] = ("crypto",     3)

VOLATILE_STOCKS = {
    "COIN","MSTR","HOOD","IONQ","SMCI","ARM","ASTS","SOUN",
    "PLTR","APP","NVDA","AMD","META","TSLA","GEV"
}

TRIM_THRESHOLDS = {
    "aggressive": {"trim": 0.25, "profit": 0.45, "exit": 0.60},
    "crypto":     {"trim": 0.35, "profit": 0.50, "exit": 0.60},
}

# ================================================================
#  TELEGRAM
# ================================================================
def send(msg, urgent=False):
    if not BOT_TOKEN or not CHAT_ID:
        print("No credentials")
        return
    prefix = "🚨 ACTION NEEDED\n\n" if urgent else ""
    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={"chat_id": CHAT_ID, "text": prefix + msg},
            timeout=10
        )
        print("Telegram: sent")
    except Exception as e:
        print(f"Telegram error: {e}")

# ================================================================
#  DATA — Stocks via Yahoo Finance
# ================================================================
def get_stock_data(ticker, period="1mo"):
    for attempt in range(3):
        try:
            hist = yf.Ticker(ticker).history(period=period)
            if hist.empty or len(hist) < 2:
                return None
            current = float(hist["Close"].iloc[-1])
            old     = float(hist["Close"].iloc[0])
            if old == 0:
                return None
            change = (current - old) / old
            return (current, change) if change == change else None
        except:
            time.sleep(1)
    return None

def get_stock_60d(ticker):
    for attempt in range(3):
        try:
            hist = yf.Ticker(ticker).history(period="3mo")
            if hist.empty or len(hist) < 20:
                return None
            current = float(hist["Close"].iloc[-1])
            old     = float(hist["Close"].iloc[-60]) if len(hist) >= 60 else float(hist["Close"].iloc[0])
            if old == 0:
                return None
            change = (current - old) / old
            return change if change == change else None
        except:
            time.sleep(1)
    return None

# ================================================================
#  DATA — Crypto via Binance (matches Revolut)
# ================================================================
def get_crypto_data(symbol):
    for attempt in range(3):
        try:
            price   = float(requests.get(
                f"https://api.binance.com/api/v3/ticker/price?symbol={symbol}",
                timeout=10
            ).json()["price"])
            candles = requests.get(
                f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval=1d&limit=31",
                timeout=10
            ).json()
            if not candles:
                return None
            old    = float(candles[0][1])
            change = (price - old) / old
            return (price, change) if change == change else None
        except:
            time.sleep(1)
    return None

def get_crypto_60d(symbol):
    for attempt in range(3):
        try:
            candles = requests.get(
                f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval=1d&limit=61",
                timeout=10
            ).json()
            if not candles or len(candles) < 2:
                return None
            current = float(candles[-1][4])
            old     = float(candles[0][1])
            if old == 0:
                return None
            change = (current - old) / old
            return change if change == change else None
        except:
            time.sleep(1)
    return None

# ================================================================
#  SIGNALS FROM SNIPER
# ================================================================
def get_signals():
    try:
        with open("signals.json", "r") as f:
            raw = json.load(f)
        return [s if isinstance(s, dict) else {"asset": s} for s in raw]
    except:
        return []

def score_signal(s):
    return min(s.get("touches", 3), 6) * 10 + min(float(s.get("volRatio", 1.5)), 5) * 8

# ================================================================
#  COOLDOWN
# ================================================================
def cooldown_active():
    try:
        last = json.load(open(LAST_TRADE_FILE)).get("time", 0)
        return (time.time() - last) < SWAP_COOLDOWN_HOURS * 3600
    except:
        return False

def save_trade_time():
    with open(LAST_TRADE_FILE, "w") as f:
        json.dump({"time": time.time()}, f)

# ================================================================
#  STAGNANT TRACKING
# ================================================================
def load_stagnant():
    try:
        with open(STAGNANT_FILE, "r") as f:
            return json.load(f)
    except:
        return {}

def stagnant_cooldown(ticker):
    alerted = load_stagnant()
    if ticker not in alerted:
        return False
    return (time.time() - alerted[ticker]) < 14 * 86400

def mark_stagnant(ticker):
    alerted = load_stagnant()
    alerted[ticker] = time.time()
    with open(STAGNANT_FILE, "w") as f:
        json.dump(alerted, f)

# ================================================================
#  CLASSIFY
# ================================================================
def classify(change, pot_type):
    if pot_type == "core":
        if change >= 0.40:    return "🔥 EXTENDED",      "Consider trimming at annual review"
        elif change >= 0.15:  return "⚡ STRONG",         "Hold — performing well"
        elif change >= -0.05: return "✅ HOLD",           "On track"
        elif change >= -0.20: return "🧊 WEAK",           "DCA opportunity"
        else:                 return "🚨 DOWN",            "Reassess at annual review"

    elif pot_type == "aggressive":
        t = TRIM_THRESHOLDS["aggressive"]
        if change >= t["exit"]:     return "🚨 EXIT",         f"Exit majority — up {round(change*100)}%"
        elif change >= t["profit"]: return "🔥 TAKE PROFIT",  f"Take meaningful profit — up {round(change*100)}%"
        elif change >= t["trim"]:   return "✂️ TRIM",          f"Trim 25% — up {round(change*100)}%"
        elif change >= -0.05:       return "✅ HOLD",          "Momentum holding"
        elif change >= -0.20:       return "🧊 WAIT",          "Holding pattern"
        else:                       return "🚨 REASSESS",      f"Down {round(abs(change)*100)}% — review thesis"

    elif pot_type == "crypto":
        t = TRIM_THRESHOLDS["crypto"]
        if change >= t["exit"]:     return "🚨 TAKE MAJORITY", f"Up {round(change*100)}% — take majority profit"
        elif change >= t["profit"]: return "🔥 TAKE PROFIT",   f"Up {round(change*100)}% — take 25–50%"
        elif change >= t["trim"]:   return "✂️ TRIM",           f"Up {round(change*100)}% — consider trimming"
        elif change >= -0.20:       return "✅ HOLD",           "Hold — DCA on"
        elif change >= -0.50:       return "🧊 HOLD THROUGH",   "Expected drawdown — keep DCA'ing"
        else:                       return "🚨 REASSESS",       f"Down {round(abs(change)*100)}% — check fundamentals"

    return "✅ HOLD", ""

# ================================================================
#  INSTRUCTIONS — plain English, 2-minute actions
# ================================================================
def make_instructions(actions, rebalances, swaps):
    if not actions and not rebalances and not swaps:
        return []

    lines = ["📋 WHAT TO DO\n(2 minutes in Trading 212 / Revolut)\n"]
    step  = 1

    for ticker, status, pot_num in actions:
        platform = "Revolut" if pot_num == 3 else "Trading 212"
        display  = CRYPTO_NAMES.get(ticker, ticker)

        if "EXIT" in status or "MAJORITY" in status:
            pct = "70–80%"
        elif "TAKE PROFIT" in status:
            pct = "30–50%"
        elif "TRIM" in status:
            pct = "25%"
        else:
            pct = None

        if pct:
            lines.append(
                f"Step {step}: {platform} → Pot {pot_num}\n"
                f"  Find {display} → Sell {pct} of your position\n"
                f"  Leave the rest invested\n"
            )
            step += 1
        elif "REASSESS" in status:
            lines.append(
                f"Step {step}: Check {display} on {platform}\n"
                f"  Still believe in it? → Hold\n"
                f"  Lost conviction? → Sell and move to strongest position\n"
            )
            step += 1

    for ticker, target_pct, actual_pct, pot_num, direction in rebalances:
        display = CRYPTO_NAMES.get(ticker, ticker)
        action  = "Reduce" if direction == "reduce" else "Increase"
        lines.append(
            f"Step {step}: Trading 212 → Pot {pot_num}\n"
            f"  {display} is now {actual_pct}% of pot (target {target_pct}%)\n"
            f"  {action} its pie slice to {target_pct}%\n"
            f"  T212 auto-rebalances on your next deposit\n"
        )
        step += 1

    for old_t, new_t, pot_num, improvement in swaps:
        platform   = "Revolut" if pot_num == 3 else "Trading 212"
        old_display = CRYPTO_NAMES.get(old_t, old_t)
        lines.append(
            f"Step {step}: {platform} → Pot {pot_num}\n"
            f"  Sell all of {old_display}\n"
            f"  Buy {new_t} with the proceeds\n"
            f"  Expected improvement: +{improvement}%\n"
        )
        step += 1

    if step > 1:
        lines.append(f"Total: {step-1} step(s) — under 2 minutes.")

    return lines

# ================================================================
#  POT REPORT
# ================================================================
def report_pot(name, holdings, pot_type, pot_num):
    lines       = []
    performance = []
    actions     = []

    lines.append(f"\n{'═'*42}")
    lines.append(f"  {name}")
    lines.append(f"{'═'*42}")

    for ticker, alloc in holdings.items():
        data    = get_crypto_data(ticker) if pot_num == 3 else get_stock_data(ticker)
        display = CRYPTO_NAMES.get(ticker, ticker)

        if not data:
            lines.append(f"  {display:<16} — no data")
            continue

        price, change = data
        status, note  = classify(change, pot_type)
        performance.append((ticker, change))

        pct_str   = f"{round(change*100,1):+.1f}%"
        alloc_str = f"{round(alloc*100)}%"

        lines.append(f"  {display:<16} {alloc_str:<5} {pct_str:<8} {status}")
        if note:
            lines.append(f"                 ↳ {note}")

        if any(x in status for x in ["TRIM","TAKE PROFIT","EXIT","MAJORITY","REASSESS"]):
            actions.append((ticker, status, pot_num))

    # Internal rotation
    if pot_type in ["aggressive", "crypto"]:
        weak   = [(t, c) for t, c in performance if c < -0.05]
        strong = [(t, c) for t, c in performance if c >  0.15]
        if weak and strong:
            weak.sort(key=lambda x: x[1])
            strong.sort(key=lambda x: x[1], reverse=True)
            lines.append(f"\n  🔄 Internal rotation:")
            for w, s in zip(weak, strong):
                wd = CRYPTO_NAMES.get(w[0], w[0])
                sd = CRYPTO_NAMES.get(s[0], s[0])
                lines.append(f"    {wd} → {sd} (+{round((s[1]-w[1])*100,1)}%)")

    if actions:
        lines.append(f"\n  💡 Actions:")
        for t, st, _ in actions:
            lines.append(f"    → {CRYPTO_NAMES.get(t,t)}: {st}")
    else:
        lines.append(f"\n  ✅ No action needed")

    return lines, performance, actions

# ================================================================
#  REBALANCE CHECK
# ================================================================
def check_rebalance(holdings, performance, pot_num):
    rebalances = []
    perf_dict  = dict(performance)
    adjusted   = {}
    total      = 0

    for ticker, target in holdings.items():
        change = perf_dict.get(ticker, 0)
        adjusted[ticker] = target * (1 + change)
        total += adjusted[ticker]

    if total == 0:
        return rebalances

    for ticker, target in holdings.items():
        actual = adjusted[ticker] / total
        drift  = actual - target
        if abs(drift) >= REBALANCE_DRIFT:
            rebalances.append((
                ticker,
                round(target * 100),
                round(actual * 100),
                pot_num,
                "reduce" if drift > 0 else "increase"
            ))

    return rebalances

# ================================================================
#  SWAP FINDER
# ================================================================
def find_swaps(holdings, pot_num, performance, signals):
    swaps = []
    if pot_num == 1 or not performance or not signals:
        return swaps

    best_in_pot = max(performance, key=lambda x: x[1])
    best_signal = sorted(signals, key=score_signal, reverse=True)[0]

    for ticker, change in performance:
        if stagnant_cooldown(ticker):
            continue
        if abs(change) > STAGNANT_PCT:
            continue
        if best_in_pot[1] < STAGNANT_BEAT_PCT:
            continue

        improvement = round(
            ((best_in_pot[1] - change) * 0.5 + (score_signal(best_signal) / 100) * 0.5) * 100, 1
        )

        if improvement >= MIN_SWAP_EDGE:
            swaps.append((ticker, best_signal["asset"], pot_num, improvement))
            mark_stagnant(ticker)

    return swaps

# ================================================================
#  SNIPER ROUTING
# ================================================================
def route_signal(sig, p1, p2, p3):
    asset    = sig.get("asset", "")
    sig_type = sig.get("type", "")

    if asset in TICKER_POT:
        pot_type, pot_num = TICKER_POT[asset]
        perf    = {1: p1, 2: p2, 3: p3}[pot_num]
        current = dict(perf).get(asset, 0)
        if current < 0.15:
            return pot_num, "topup", f"{asset} breaking out — top up in Pot {pot_num}"
        return pot_num, "watch", f"{asset} already running in Pot {pot_num} — hold"

    is_crypto = sig_type == "crypto" or "USDT" in asset
    if is_crypto:
        target_pot, target_perf = 3, p3
    elif asset in VOLATILE_STOCKS:
        target_pot, target_perf = 2, p2
    else:
        target_pot, target_perf = 1, p1

    if target_perf:
        weakest = min(target_perf, key=lambda x: x[1])
        if weakest[1] < -0.10:
            wd = CRYPTO_NAMES.get(weakest[0], weakest[0])
            return target_pot, "replace", \
                f"Replace {wd} ({round(weakest[1]*100)}%) with {asset} in Pot {target_pot}"

    return target_pot, "watch", f"{asset} — watchlist for Pot {target_pot}"

# ================================================================
#  MAIN ANALYSIS
# ================================================================
def analyse():
    all_lines    = []
    urgent_items = []
    all_actions  = []

    all_lines.append("📊 PORTFOLIO INTELLIGENCE")
    all_lines.append(f"🕒 {datetime.utcnow().strftime('%d %b %Y · %H:%M UTC')}")
    all_lines.append("3 pots | Sniper integrated\n")

    # Pot reports
    l1, p1, a1 = report_pot("POT 1 — CORE",       POT_1_CORE,       "core",       1)
    l2, p2, a2 = report_pot("POT 2 — AGGRESSIVE",  POT_2_AGGRESSIVE, "aggressive", 2)
    l3, p3, a3 = report_pot("POT 3 — CRYPTO",      POT_3_CRYPTO,     "crypto",     3)

    all_lines.extend(l1 + l2 + l3)
    all_actions = a1 + a2 + a3

    # Rebalance
    rebal = (
        check_rebalance(POT_1_CORE,       p1, 1) +
        check_rebalance(POT_2_AGGRESSIVE, p2, 2) +
        check_rebalance(POT_3_CRYPTO,     p3, 3)
    )

    if rebal:
        all_lines.append(f"\n{'═'*42}")
        all_lines.append(f"  ⚖️  REBALANCE")
        all_lines.append(f"{'═'*42}")
        for ticker, target, actual, pot_num, direction in rebal:
            display = CRYPTO_NAMES.get(ticker, ticker)
            arrow   = "↓ Reduce" if direction == "reduce" else "↑ Increase"
            all_lines.append(f"  {arrow} {display} — {actual}% → target {target}% (Pot {pot_num})")

    # Signals
    signals = get_signals()
    if signals:
        ranked = sorted(signals, key=score_signal, reverse=True)

        all_lines.append(f"\n{'═'*42}")
        all_lines.append(f"  🎯 SNIPER → PORTFOLIO")
        all_lines.append(f"{'═'*42}")

        for sig in ranked[-5:]:
            asset   = sig.get("asset", "?")
            entry   = sig.get("entry", "?")
            sl      = sig.get("sl", "?")
            tp      = sig.get("tp", "?")
            vol     = sig.get("volRatio", "?")
            touches = sig.get("touches", "?")

            pot_num, action, reason = route_signal(sig, p1, p2, p3)
            emoji = {"topup": "💰", "replace": "🔄", "watch": "👁️"}.get(action, "👁️")

            all_lines.append(f"\n  {emoji} {asset} → Pot {pot_num} [{action.upper()}]")
            all_lines.append(f"    Entry: {entry} | SL: {sl} | TP: {tp}")
            all_lines.append(f"    Vol: {vol}x | Touches: {touches}")
            all_lines.append(f"    {reason}")

            if action in ["topup", "replace"]:
                urgent_items.append(f"{emoji} {asset} (Pot {pot_num}): {reason}")

        # Profit deploy
        trim_actions = [(t, st, p) for t, st, p in all_actions
                        if any(x in st for x in ["TRIM","TAKE PROFIT","EXIT"])]
        if trim_actions:
            best = ranked[-1]
            best_route = route_signal(best, p1, p2, p3)
            all_lines.append(f"\n{'═'*42}")
            all_lines.append(f"  💸 REDEPLOY INTO")
            all_lines.append(f"{'═'*42}")
            for t, st, p in trim_actions:
                display = CRYPTO_NAMES.get(t, t)
                all_lines.append(
                    f"  Trim {display} → buy {best.get('asset')} "
                    f"in Pot {best_route[0]}"
                )

    # Swaps
    swaps = []
    if not cooldown_active():
        swaps = (
            find_swaps(POT_2_AGGRESSIVE, 2, p2, signals) +
            find_swaps(POT_3_CRYPTO,     3, p3, signals)
        )

    # Instructions
    instructions = make_instructions(all_actions, rebal, swaps)
    if instructions:
        all_lines.append(f"\n{'═'*42}")
        for line in instructions:
            all_lines.append(f"  {line}")

    # Summary
    total = len(all_actions) + len(rebal) + len(swaps)
    all_lines.append(f"\n{'═'*42}")
    all_lines.append(f"  {'⚠️  '+str(total)+' action(s) needed' if total else '✅ All pots healthy'}")
    all_lines.append(f"  Next check: in {CHECK_INTERVAL//3600} hours")
    all_lines.append(f"{'═'*42}")

    full_msg    = "\n".join(all_lines)
    should_send = bool(all_actions or urgent_items or rebal or swaps)

    return full_msg, should_send, urgent_items

# ================================================================
#  LOOP
# ================================================================
def run():
    while True:
        try:
            print(f"\n[{datetime.utcnow().strftime('%d %b %H:%M')}] Analysing...")
            msg, should_send, urgent = analyse()
            print(msg)

            if urgent:
                send("\n".join(urgent), urgent=True)
            if should_send:
                send(msg)
            else:
                print("All healthy — Telegram not sent")

        except Exception as e:
            print(f"Loop error: {e}")

        time.sleep(CHECK_INTERVAL)

# ================================================================
#  START
# ================================================================
if __name__ == "__main__":
    print("═" * 42)
    print("  PORTFOLIO BOT — OPTIMAL")
    print("  Stocks: Yahoo | Crypto: Binance")
    print(f"  Every {CHECK_INTERVAL//3600}hrs | Swap cooldown {SWAP_COOLDOWN_HOURS}hrs")
    print("═" * 42 + "\n")

    for f, default in [
        ("signals.json",  "[]"),
        (LAST_TRADE_FILE, "{}"),
        (STAGNANT_FILE,   "{}")
    ]:
        if not os.path.exists(f):
            with open(f, "w") as fh:
                fh.write(default)

    run()
