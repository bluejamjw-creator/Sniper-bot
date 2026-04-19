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
STAGNANT_DAYS   = 60             # Days flat before flagging
STAGNANT_PCT    = 0.05           # ±5% = stagnant
LAST_TRADE_FILE = "last_trade.json"
STAGNANT_FILE   = "stagnant_alerted.json"

# ================================================================
#  3-POT STRUCTURE — CONFIRMED APRIL 2026
# ================================================================

POT_1_CORE = {
    "SMH":  0.29,   # VanEck Semiconductors ETF  — 29%
    "EQQQ": 0.25,   # Invesco Nasdaq-100 ETF      — 25%
    "INDA": 0.20,   # iShares MSCI India ETF      — 20%
    "PLTR": 0.13,   # Palantir                    — 13%
    "VRT":  0.08,   # Vertiv Holdings             —  8%
    "ETHC": 0.05,   # 21Shares ETH Staking ETP    —  5%
}

POT_2_AGGRESSIVE = {
    "APP":  0.28,   # AppLovin       — 28%
    "AMD":  0.22,   # AMD            — 22%
    "MSTR": 0.20,   # MicroStrategy  — 20%
    "ASTS": 0.15,   # AST SpaceMobile — 15%
    "SOUN": 0.10,   # SoundHound AI  — 10%
    "COIN": 0.05,   # Coinbase       —  5%
}

POT_3_CRYPTO = {
    "RNDR-USD": 0.333,  # Render    — GPU compute  — 33%
    "FET-USD":  0.267,  # Fetch.ai  — AI agents    — 27%
    "SOL-USD":  0.200,  # Solana    — L1 network   — 20%
    "ETH-USD":  0.200,  # Ethereum  — settlement   — 20%
}

# Reverse lookup: ticker → (pot_type, pot_number)
TICKER_POT = {}
for t in POT_1_CORE:       TICKER_POT[t] = ("core",       1)
for t in POT_2_AGGRESSIVE: TICKER_POT[t] = ("aggressive", 2)
for t in POT_3_CRYPTO:     TICKER_POT[t] = ("crypto",     3)

# High-volatility stocks route to Pot 2, others to Pot 1
VOLATILE_STOCKS = {
    "COIN","MSTR","HOOD","IONQ","SMCI","ARM","ASTS","SOUN",
    "PLTR","APP","NVDA","AMD","META","TSLA","COIN","GEV"
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
        print("No Telegram credentials — not sent")
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
#  DATA
# ================================================================
def get_price_change(ticker, period="1mo"):
    try:
        hist = yf.Ticker(ticker).history(period=period)
        if hist.empty or len(hist) < 2:
            return None
        current = float(hist["Close"].iloc[-1])
        old     = float(hist["Close"].iloc[0])
        if old == 0 or current != current:
            return None
        return current, (current - old) / old
    except Exception as e:
        print(f"Data error [{ticker}]: {e}")
        return None

def get_60d_change(ticker):
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
    touches  = s.get("touches", 3)
    vol      = float(s.get("volRatio", 1.5))
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
    return (time.time() - alerted[ticker]) < 14 * 86400  # 14 days

def mark_stagnant(ticker):
    alerted = load_stagnant()
    alerted[ticker] = time.time()
    save_stagnant(alerted)

# ================================================================
#  TRADE COOLDOWN
# ================================================================
def last_trade_time():
    try:
        with open(LAST_TRADE_FILE, "r") as f:
            return json.load(f)["time"]
    except:
        return 0

def save_trade_time():
    with open(LAST_TRADE_FILE, "w") as f:
        json.dump({"time": time.time()}, f)

# ================================================================
#  CLASSIFY POSITION
# ================================================================
def classify(change, pot_type):
    if pot_type == "core":
        if change >= 0.40:    return "🔥 EXTENDED",    "Consider trimming at annual review"
        elif change >= 0.15:  return "⚡ STRONG",       "Hold — performing well"
        elif change >= -0.05: return "✅ HOLD",         "On track"
        elif change >= -0.20: return "🧊 WEAK",         "DCA opportunity"
        else:                 return "🚨 DOWN",          "Reassess at annual review"

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
#  SNIPER SIGNAL ROUTER
#  Decides which pot a signal belongs to and what action to take
# ================================================================
def route_signal(sig, p1, p2, p3):
    asset    = sig.get("asset", "")
    sig_type = sig.get("type", "")

    # Already in a pot → top up opportunity
    if asset in TICKER_POT:
        pot_type, pot_num = TICKER_POT[asset]
        perf = {1: p1, 2: p2, 3: p3}[pot_num]
        current = dict(perf).get(asset, 0)
        if current < 0.15:
            return pot_num, "topup", asset, \
                f"{asset} is in Pot {pot_num} and breaking out — top up this position"
        else:
            return pot_num, "watch", asset, \
                f"{asset} in Pot {pot_num} already running — breakout confirms strength, hold"

    # Not in pots → find which pot it fits and what to replace
    is_crypto = (sig_type == "crypto" or "USDT" in asset or "-USD" in asset)

    if is_crypto:
        target_pot, target_perf, pot_type = 3, p3, "crypto"
    elif asset in VOLATILE_STOCKS:
        target_pot, target_perf, pot_type = 2, p2, "aggressive"
    else:
        target_pot, target_perf, pot_type = 1, p1, "core"

    # Weakest in that pot = replacement candidate
    if target_perf:
        weakest = min(target_perf, key=lambda x: x[1])
        if weakest[1] < -0.10:
            return target_pot, "replace", weakest[0], \
                f"Consider replacing {weakest[0]} ({round(weakest[1]*100)}%) with {asset} in Pot {target_pot}"

    return target_pot, "watch", None, \
        f"{asset} — watchlist candidate for Pot {target_pot}"

# ================================================================
#  STAGNANT DETECTOR — fires its own Telegram immediately
# ================================================================
def check_stagnant(holdings, pot_num, signals):
    flagged   = []
    best_sig  = sorted(signals, key=score_signal, reverse=True)[-1] if signals else None

    for ticker in holdings:
        if stagnant_cooldown_active(ticker):
            continue

        change_60d = get_60d_change(ticker)
        if change_60d is None:
            continue

        if abs(change_60d) <= STAGNANT_PCT:
            replacement = ""
            if best_sig:
                replacement = f"\n🔄 Best current signal: {best_sig.get('asset')} — consider as replacement"

            msg = (
                f"😴 STAGNANT POSITION — POT {pot_num}\n\n"
                f"Ticker : {ticker}\n"
                f"60-day : {round(change_60d*100, 1)}%\n"
                f"Status : Flat for ~2 months\n"
                f"{replacement}\n\n"
                f"Would you buy {ticker} today? If not — replace it."
            )
            send(msg)
            mark_stagnant(ticker)
            flagged.append(ticker)
            print(f"Stagnant alert: {ticker}")

    return flagged

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
        data = get_price_change(ticker)
        if not data:
            lines.append(f"  {ticker:<14} — no data")
            continue

        price, change = data
        status, note  = classify(change, pot_type)
        performance.append((ticker, change))

        pct_str   = f"{round(change*100, 1):+.1f}%"
        alloc_str = f"{round(alloc*100)}%"

        lines.append(f"  {ticker:<14} {alloc_str:<5} {pct_str:<8} {status}")
        if note:
            lines.append(f"               ↳ {note}")

        if any(x in status for x in ["TRIM","TAKE PROFIT","EXIT","TAKE MAJORITY","REASSESS"]):
            actions.append((ticker, status, note, pot_num))

    # Within-pot rotation
    if pot_type in ["aggressive", "crypto"]:
        weak   = [(t, c) for t, c in performance if c < -0.05]
        strong = [(t, c) for t, c in performance if c >  0.15]
        if weak and strong:
            weak.sort(key=lambda x: x[1])
            strong.sort(key=lambda x: x[1], reverse=True)
            lines.append(f"\n  🔄 Internal rotation:")
            for w, s in zip(weak, strong):
                diff = round((s[1] - w[1]) * 100, 1)
                lines.append(f"    {w[0]} → {s[0]} (+{diff}%)")

    if actions:
        lines.append(f"\n  💡 Actions:")
        for t, st, _, _ in actions:
            lines.append(f"    → {t}: {st}")
    else:
        lines.append(f"\n  ✅ No action needed")

    return lines, performance, actions

# ================================================================
#  MAIN
# ================================================================
def analyse():
    all_lines    = []
    urgent_items = []

    all_lines.append("📊 PORTFOLIO INTELLIGENCE")
    all_lines.append(f"🕒 {datetime.utcnow().strftime('%d %b %Y · %H:%M UTC')}")
    all_lines.append("3 pots | Sniper integrated | 6hr checks")

    # ── Pot analysis ────────────────────────────────────────
    l1, p1, a1 = analyse_pot("POT 1 — CORE",       POT_1_CORE,       "core",       1)
    l2, p2, a2 = analyse_pot("POT 2 — AGGRESSIVE",  POT_2_AGGRESSIVE, "aggressive", 2)
    l3, p3, a3 = analyse_pot("POT 3 — CRYPTO",      POT_3_CRYPTO,     "crypto",     3)

    all_lines.extend(l1 + l2 + l3)
    all_actions = a1 + a2 + a3

    # ── Sniper routing ───────────────────────────────────────
    signals = get_signals()
    if signals:
        ranked = sorted(signals, key=score_signal, reverse=True)

        all_lines.append(f"\n{'═'*42}")
        all_lines.append(f"  🎯 SNIPER → PORTFOLIO ROUTING")
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

        # ── Profit deploy queue ──────────────────────────────
        trim_actions = [(t, st, p) for t, st, _, p in all_actions
                        if any(x in st for x in ["TRIM","TAKE PROFIT","EXIT"])]

        if trim_actions:
            best = ranked[-1]
            best_asset = best.get("asset", "?")
            best_route = route_signal(best, p1, p2, p3)

            all_lines.append(f"\n{'═'*42}")
            all_lines.append(f"  💸 PROFIT DEPLOY QUEUE")
            all_lines.append(f"{'═'*42}")
            for t, st, p in trim_actions:
                all_lines.append(
                    f"  When you {st.split()[0].lower()} {t} "
                    f"→ redeploy into {best_asset} "
                    f"(Pot {best_route[0]}) — strongest signal now"
                )

    # ── Stagnant checks (fires own Telegram if needed) ──────
    stagnant = []
    stagnant += check_stagnant(POT_1_CORE,       1, signals)
    stagnant += check_stagnant(POT_2_AGGRESSIVE, 2, signals)
    stagnant += check_stagnant(POT_3_CRYPTO,     3, signals)

    # ── Summary ──────────────────────────────────────────────
    all_lines.append(f"\n{'═'*42}")
    if all_actions or urgent_items:
        all_lines.append(f"  ⚠️  {len(all_actions)} action(s) across pots")
    else:
        all_lines.append(f"  ✅ All pots healthy — no action needed")
    if stagnant:
        all_lines.append(f"  😴 Stagnant alerts sent: {', '.join(stagnant)}")
    all_lines.append(f"  Next check: in {CHECK_INTERVAL//3600} hours")
    all_lines.append(f"{'═'*42}")

    full_msg    = "\n".join(all_lines)
    should_send = bool(all_actions or urgent_items)

    return full_msg, should_send, urgent_items

# ================================================================
#  RUN LOOP
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
                print("No actions — Telegram not sent")

        except Exception as e:
            print(f"Loop error: {e}")

        time.sleep(CHECK_INTERVAL)

# ================================================================
#  START
# ================================================================
if __name__ == "__main__":
    print("═" * 42)
    print("  PORTFOLIO BOT — OPTIMAL")
    print("  3 Pots | Sniper integrated")
    print(f"  Checks every {CHECK_INTERVAL//3600}hrs")
    print("═" * 42 + "\n")

    for f, default in [
        ("signals.json",    "[]"),
        (LAST_TRADE_FILE,   "{}"),
        (STAGNANT_FILE,     "{}")
    ]:
        if not os.path.exists(f):
            with open(f, "w") as fh:
                fh.write(default)

    run()
