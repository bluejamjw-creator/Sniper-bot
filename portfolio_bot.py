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

CHECK_INTERVAL  = 6 * 60 * 60   # Every 6 hours
LAST_TRADE_FILE = "last_trade.json"
STAGNANT_FILE   = "stagnant_alerted.json"

# Stagnant = flat within ±20% for 60 days AND another position
# in same pot is up 30%+ (only then is there a better use of capital)
STAGNANT_PCT      = 0.20
STAGNANT_BEAT_PCT = 0.30

# Rebalance alert if position drifts 5%+ from target allocation
REBALANCE_DRIFT = 0.05

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

# Friendly display names for crypto
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

# ================================================================
#  PROFIT TAKING THRESHOLDS
# ================================================================
TRIM_THRESHOLDS = {
    "aggressive": {"trim": 0.25, "profit": 0.45, "exit": 0.60},
    "crypto":     {"trim": 0.35, "profit": 0.50, "exit": 0.60},
}

# ================================================================
#  TELEGRAM
# ================================================================
def send(msg, urgent=False):
    if not BOT_TOKEN or not CHAT_ID:
        print("No Telegram credentials")
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
#  DATA — STOCKS via Yahoo Finance
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
            if change != change:
                return None
            return current, change
        except Exception as e:
            if attempt == 2:
                print(f"Stock data error [{ticker}]: {e}")
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
            if attempt == 2:
                return None
            time.sleep(1)
    return None

# ================================================================
#  DATA — CRYPTO via Binance (matches Revolut exactly)
# ================================================================
def get_crypto_data(symbol):
    """Fetch current price and 30-day % change from Binance."""
    for attempt in range(3):
        try:
            # Current price
            url = f"https://api.binance.com/api/v3/ticker/price?symbol={symbol}"
            r = requests.get(url, timeout=10)
            price = float(r.json()["price"])

            # 30-day change via klines
            kurl = f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval=1d&limit=31"
            kr = requests.get(kurl, timeout=10)
            candles = kr.json()
            if not candles or len(candles) < 2:
                return None
            old = float(candles[0][1])  # open of oldest candle
            if old == 0:
                return None
            change = (price - old) / old
            if change != change:
                return None
            return price, change
        except Exception as e:
            if attempt == 2:
                print(f"Crypto data error [{symbol}]: {e}")
            time.sleep(1)
    return None

def get_crypto_60d(symbol):
    for attempt in range(3):
        try:
            kurl = f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval=1d&limit=61"
            kr = requests.get(kurl, timeout=10)
            candles = kr.json()
            if not candles or len(candles) < 2:
                return None
            current = float(candles[-1][4])
            old     = float(candles[0][1])
            if old == 0:
                return None
            change = (current - old) / old
            return change if change == change else None
        except:
            if attempt == 2:
                return None
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
    touches = s.get("touches", 3)
    vol     = float(s.get("volRatio", 1.5))
    return min(touches, 6) * 10 + min(vol, 5) * 8

# ================================================================
#  STAGNANT TRACKING
# ================================================================
def load_stagnant():
    try:
        with open(STAGNANT_FILE, "r") as f:
            return json.load(f)
    except:
        return {}

def save_stagnant(data):
    with open(STAGNANT_FILE, "w") as f:
        json.dump(data, f, indent=2)

def stagnant_cooldown_active(ticker):
    alerted = load_stagnant()
    if ticker not in alerted:
        return False
    return (time.time() - alerted[ticker]) < 14 * 86400

def mark_stagnant(ticker):
    alerted = load_stagnant()
    alerted[ticker] = time.time()
    save_stagnant(alerted)

# ================================================================
#  CLASSIFY
# ================================================================
def classify(change, pot_type):
    if pot_type == "core":
        if change >= 0.40:    return "🔥 EXTENDED",   "Consider trimming at annual review"
        elif change >= 0.15:  return "⚡ STRONG",      "Hold — performing well"
        elif change >= -0.05: return "✅ HOLD",        "On track"
        elif change >= -0.20: return "🧊 WEAK",        "DCA opportunity"
        else:                 return "🚨 DOWN",         "Reassess at annual review"

    elif pot_type == "aggressive":
        t = TRIM_THRESHOLDS["aggressive"]
        if change >= t["exit"]:     return "🚨 EXIT",        f"Exit majority — up {round(change*100)}%"
        elif change >= t["profit"]: return "🔥 TAKE PROFIT", f"Take meaningful profit — up {round(change*100)}%"
        elif change >= t["trim"]:   return "✂️ TRIM",         f"Trim 25% — up {round(change*100)}%"
        elif change >= -0.05:       return "✅ HOLD",         "Momentum holding"
        elif change >= -0.20:       return "🧊 WAIT",         "Holding pattern"
        else:                       return "🚨 REASSESS",     f"Down {round(abs(change)*100)}% — review thesis"

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
#  INSTRUCTIONS GENERATOR
#  Converts bot recommendations into plain English 2-minute actions
# ================================================================
def make_instructions(actions, rebalances, swaps):
    if not actions and not rebalances and not swaps:
        return []

    lines = []
    lines.append("📋 WHAT TO DO — Step by step")
    lines.append("(Takes 2 minutes in Trading 212 / Revolut)\n")

    step = 1

    for ticker, status, pot_num in actions:
        if "TRIM" in status or "TAKE PROFIT" in status:
            platform = "Revolut" if pot_num == 3 else "Trading 212"
            pot_name = f"Pot {pot_num}"
            pct      = "25%" if "TRIM" in status else "30–50%"
            lines.append(
                f"Step {step}: Open {platform}\n"
                f"  → Go to your {pot_name} holdings\n"
                f"  → Find {ticker}\n"
                f"  → Sell {pct} of your position\n"
                f"  → Leave the rest invested\n"
            )
            step += 1

        elif "EXIT" in status or "MAJORITY" in status:
            platform = "Revolut" if pot_num == 3 else "Trading 212"
            lines.append(
                f"Step {step}: Open {platform}\n"
                f"  → Go to your Pot {pot_num} holdings\n"
                f"  → Find {ticker}\n"
                f"  → Sell 70–80% of your position\n"
                f"  → Keep a small amount in case it continues\n"
            )
            step += 1

        elif "REASSESS" in status:
            platform = "Revolut" if pot_num == 3 else "Trading 212"
            lines.append(
                f"Step {step}: Check {ticker} on {platform}\n"
                f"  → Is the reason you bought it still valid?\n"
                f"  → If YES → hold and keep DCA'ing\n"
                f"  → If NO  → sell and move to strongest position\n"
            )
            step += 1

    for ticker, target_pct, actual_pct, pot_num, direction in rebalances:
        platform = "Trading 212"
        if direction == "reduce":
            lines.append(
                f"Step {step}: Open {platform} → Pot {pot_num}\n"
                f"  → {ticker} has grown to {actual_pct}% of your pot (target: {target_pct}%)\n"
                f"  → Reduce its pie slice back to {target_pct}%\n"
                f"  → Trading 212 will auto-rebalance on your next deposit\n"
            )
        else:
            lines.append(
                f"Step {step}: Open {platform} → Pot {pot_num}\n"
                f"  → {ticker} has shrunk to {actual_pct}% of your pot (target: {target_pct}%)\n"
                f"  → Increase its pie slice back to {target_pct}%\n"
                f"  → Trading 212 will auto-rebalance on your next deposit\n"
            )
        step += 1

    for old_ticker, new_ticker, pot_num, reason in swaps:
        platform = "Revolut" if pot_num == 3 else "Trading 212"
        lines.append(
            f"Step {step}: Open {platform} → Pot {pot_num}\n"
            f"  → Sell your entire {old_ticker} position\n"
            f"  → Buy {new_ticker} with the proceeds\n"
            f"  → Reason: {reason}\n"
        )
        step += 1

    if step == 1:
        return []

    lines.append(f"Total steps: {step - 1} — should take under 2 minutes.")
    return lines

# ================================================================
#  STAGNANT + SWAP DETECTOR
#  Only fires for Pot 2 and Pot 3
#  Only fires if another position in same pot is up 30%+
# ================================================================
def check_stagnant_and_swaps(holdings, pot_type, pot_num, performance, signals):
    swaps   = []
    flagged = []

    if pot_num == 1:
        return swaps, flagged  # Never flag core ETFs

    # Find best performing position in this pot
    best_in_pot = max(performance, key=lambda x: x[1]) if performance else None

    # Best sniper signal as swap candidate
    ranked_signals = sorted(signals, key=score_signal, reverse=True)
    best_signal    = ranked_signals[-1] if ranked_signals else None

    for ticker in holdings:
        if stagnant_cooldown_active(ticker):
            continue

        if pot_num == 3:
            change_60d = get_crypto_60d(ticker)
        else:
            change_60d = get_stock_60d(ticker)

        if change_60d is None:
            continue

        # Only flag if flat AND another position is doing much better
        is_flat       = abs(change_60d) <= STAGNANT_PCT
        better_exists = best_in_pot and best_in_pot[0] != ticker and best_in_pot[1] >= STAGNANT_BEAT_PCT

        if is_flat and better_exists:
            if best_signal:
                sig_asset = best_signal.get("asset", "").replace("USDT", "")
                reason    = f"Flat {round(change_60d*100, 1)}% in 60 days while {best_in_pot[0]} is up {round(best_in_pot[1]*100)}%"
                swaps.append((ticker, sig_asset, pot_num, reason))
                flagged.append(ticker)
                mark_stagnant(ticker)
            else:
                # No signal — just flag as stagnant
                msg = (
                    f"😴 STAGNANT — POT {pot_num}\n\n"
                    f"Ticker : {ticker}\n"
                    f"60-day : {round(change_60d*100, 1)}%\n"
                    f"Meanwhile {best_in_pot[0]} is up {round(best_in_pot[1]*100)}%\n\n"
                    f"Worth reviewing — would you buy {ticker} today?"
                )
                send(msg)
                mark_stagnant(ticker)
                flagged.append(ticker)

    return swaps, flagged

# ================================================================
#  REBALANCE CHECKER
#  Flags if any position has drifted 5%+ from target
# ================================================================
def check_rebalance(holdings, performance, pot_num):
    rebalances = []
    perf_dict  = dict(performance)

    # Calculate current weights based on performance
    # Simple approximation: if position is up 20%, its weight grows proportionally
    adjusted = {}
    total    = 0
    for ticker, target in holdings.items():
        change = perf_dict.get(ticker, 0)
        adjusted[ticker] = target * (1 + change)
        total += adjusted[ticker]

    if total == 0:
        return rebalances

    for ticker, target in holdings.items():
        actual_pct = adjusted[ticker] / total
        drift      = actual_pct - target

        if abs(drift) >= REBALANCE_DRIFT:
            direction = "reduce" if drift > 0 else "increase"
            rebalances.append((
                ticker,
                round(target * 100),
                round(actual_pct * 100),
                pot_num,
                direction
            ))

    return rebalances

# ================================================================
#  ANALYSE ONE POT
# ================================================================
def analyse_pot(name, holdings, pot_type, pot_num):
    lines       = []
    performance = []
    actions     = []

    lines.append(f"\n{'═'*42}")
    lines.append(f"  {name}")
    lines.append(f"{'═'*42}")

    for ticker, alloc in holdings.items():
        if pot_num == 3:
            data = get_crypto_data(ticker)
            display = CRYPTO_NAMES.get(ticker, ticker)
        else:
            data    = get_stock_data(ticker)
            display = ticker

        if not data:
            lines.append(f"  {display:<16} — no data")
            continue

        price, change = data
        status, note  = classify(change, pot_type)
        performance.append((ticker, change))

        pct_str   = f"{round(change*100, 1):+.1f}%"
        alloc_str = f"{round(alloc*100)}%"

        lines.append(f"  {display:<16} {alloc_str:<5} {pct_str:<8} {status}")
        if note:
            lines.append(f"                 ↳ {note}")

        if any(x in status for x in ["TRIM","TAKE PROFIT","EXIT","TAKE MAJORITY","REASSESS"]):
            actions.append((ticker, status, pot_num))

    # Internal rotation suggestion
    if pot_type in ["aggressive", "crypto"]:
        weak   = [(t, c) for t, c in performance if c < -0.05]
        strong = [(t, c) for t, c in performance if c >  0.15]
        if weak and strong:
            weak.sort(key=lambda x: x[1])
            strong.sort(key=lambda x: x[1], reverse=True)
            lines.append(f"\n  🔄 Internal rotation:")
            for w, s in zip(weak, strong):
                wname = CRYPTO_NAMES.get(w[0], w[0])
                sname = CRYPTO_NAMES.get(s[0], s[0])
                diff  = round((s[1] - w[1]) * 100, 1)
                lines.append(f"    {wname} → {sname} (+{diff}%)")

    if actions:
        lines.append(f"\n  💡 Actions:")
        for t, st, _ in actions:
            display = CRYPTO_NAMES.get(t, t)
            lines.append(f"    → {display}: {st}")
    else:
        lines.append(f"\n  ✅ No action needed")

    return lines, performance, actions

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
            return pot_num, "topup", asset, \
                f"{asset} is in Pot {pot_num} and breaking out — top up this position"
        else:
            return pot_num, "watch", asset, \
                f"{asset} in Pot {pot_num} already running strong — hold"

    is_crypto = (sig_type == "crypto" or "USDT" in asset or "-USD" in asset)
    if is_crypto:
        target_pot, target_perf = 3, p3
    elif asset in VOLATILE_STOCKS:
        target_pot, target_perf = 2, p2
    else:
        target_pot, target_perf = 1, p1

    if target_perf:
        weakest = min(target_perf, key=lambda x: x[1])
        if weakest[1] < -0.10:
            wname = CRYPTO_NAMES.get(weakest[0], weakest[0])
            return target_pot, "replace", weakest[0], \
                f"Consider replacing {wname} ({round(weakest[1]*100)}%) with {asset} in Pot {target_pot}"

    return target_pot, "watch", None, \
        f"{asset} — watchlist candidate for Pot {target_pot}"

# ================================================================
#  MAIN ANALYSIS
# ================================================================
def analyse():
    all_lines    = []
    urgent_items = []
    all_swaps    = []
    all_rebal    = []
    all_actions  = []

    all_lines.append("📊 PORTFOLIO INTELLIGENCE")
    all_lines.append(f"🕒 {datetime.utcnow().strftime('%d %b %Y · %H:%M UTC')}")
    all_lines.append("3 pots active | Sniper integrated\n")

    # Analyse pots
    l1, p1, a1 = analyse_pot("POT 1 — CORE",       POT_1_CORE,       "core",       1)
    l2, p2, a2 = analyse_pot("POT 2 — AGGRESSIVE",  POT_2_AGGRESSIVE, "aggressive", 2)
    l3, p3, a3 = analyse_pot("POT 3 — CRYPTO",      POT_3_CRYPTO,     "crypto",     3)

    all_lines.extend(l1 + l2 + l3)
    all_actions = a1 + a2 + a3

    # Rebalance checks
    r1 = check_rebalance(POT_1_CORE,       p1, 1)
    r2 = check_rebalance(POT_2_AGGRESSIVE, p2, 2)
    r3 = check_rebalance(POT_3_CRYPTO,     p3, 3)
    all_rebal = r1 + r2 + r3

    if all_rebal:
        all_lines.append(f"\n{'═'*42}")
        all_lines.append(f"  ⚖️  REBALANCE NEEDED")
        all_lines.append(f"{'═'*42}")
        for ticker, target, actual, pot_num, direction in all_rebal:
            display = CRYPTO_NAMES.get(ticker, ticker)
            arrow   = "↓ Reduce" if direction == "reduce" else "↑ Increase"
            all_lines.append(
                f"  {arrow} {display} — currently {actual}% vs target {target}% in Pot {pot_num}"
            )

    # Sniper routing
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
            rr      = sig.get("rr", "2:1")
            vol     = sig.get("volRatio", "?")
            touches = sig.get("touches", "?")

            pot_num, action, target, reason = route_signal(sig, p1, p2, p3)
            emoji = {"topup": "💰", "replace": "🔄", "watch": "👁️"}.get(action, "👁️")

            all_lines.append(f"\n  {emoji} {asset} → Pot {pot_num} [{action.upper()}]")
            all_lines.append(f"    Entry: {entry} | SL: {sl} | TP: {tp} | R:R {rr}")
            all_lines.append(f"    Vol: {vol}x | Touches: {touches}")
            all_lines.append(f"    {reason}")

            if action in ["topup", "replace"]:
                urgent_items.append(f"{emoji} {asset} (Pot {pot_num}): {reason}")

        # Profit deploy queue
        trim_actions = [(t, st, p) for t, st, p in all_actions
                        if any(x in st for x in ["TRIM","TAKE PROFIT","EXIT"])]
        if trim_actions and ranked:
            best       = ranked[-1]
            best_asset = best.get("asset", "?")
            best_route = route_signal(best, p1, p2, p3)
            all_lines.append(f"\n{'═'*42}")
            all_lines.append(f"  💸 REDEPLOY PROFITS INTO")
            all_lines.append(f"{'═'*42}")
            for t, st, p in trim_actions:
                display = CRYPTO_NAMES.get(t, t)
                all_lines.append(
                    f"  When you trim {display} → buy {best_asset} "
                    f"in Pot {best_route[0]} — strongest signal now"
                )

    # Stagnant + swap checks (Pot 2 and 3 only)
    s2, f2 = check_stagnant_and_swaps(POT_2_AGGRESSIVE, "aggressive", 2, p2, signals)
    s3, f3 = check_stagnant_and_swaps(POT_3_CRYPTO,     "crypto",     3, p3, signals)
    all_swaps  = s2 + s3
    stagnant   = f2 + f3

    # Generate plain English instructions
    instructions = make_instructions(all_actions, all_rebal, all_swaps)

    if instructions:
        all_lines.append(f"\n{'═'*42}")
        for line in instructions:
            all_lines.append(f"  {line}")

    # Summary
    all_lines.append(f"\n{'═'*42}")
    total = len(all_actions) + len(all_rebal) + len(all_swaps)
    if total:
        all_lines.append(f"  ⚠️  {total} action(s) needed")
    else:
        all_lines.append(f"  ✅ All pots healthy — nothing to do")
    if stagnant:
        all_lines.append(f"  🔄 Swap suggestions sent: {len(stagnant)}")
    all_lines.append(f"  Next check: in {CHECK_INTERVAL//3600} hours")
    all_lines.append(f"{'═'*42}")

    full_msg    = "\n".join(all_lines)
    should_send = bool(all_actions or urgent_items or all_rebal or all_swaps)

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
    print("  Stocks: Yahoo Finance")
    print("  Crypto: Binance (matches Revolut)")
    print(f"  Checks every {CHECK_INTERVAL//3600}hrs")
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
