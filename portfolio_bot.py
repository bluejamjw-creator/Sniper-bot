# =======================
# PORTFOLIO BOT V6 (FINAL)
# =======================

import json
import requests
from datetime import datetime
import time
import os

BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")

DATA_DIR = os.getenv("DATA_DIR", "./data")

# =======================
# TELEGRAM
# =======================
def send(msg):
    if not BOT_TOKEN or not CHAT_ID:
        print(msg)
        return

    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={
                "chat_id": CHAT_ID,
                "text": msg,
                "parse_mode": "HTML"
            },
            timeout=20
        )
    except Exception as e:
        print("Telegram error:", e)

# =======================
# HELPERS
# =======================
def now():
    return datetime.now().strftime("%d %b %H:%M")

# =======================
# FILE SETUP
# =======================
def ensure_files():
    os.makedirs(DATA_DIR, exist_ok=True)

    defaults = {
        "signals.json": [],
        "actions.json": [],
        "trades.json": [],
        "stats.json": {}
    }

    for file, default in defaults.items():
        path = os.path.join(DATA_DIR, file)
        if not os.path.exists(path):
            with open(path, "w") as f:
                json.dump(default, f)

# =======================
# LOAD TARGETS
# =======================
def load_targets():
    try:
        with open("targets.json") as f:
            return json.load(f)
    except:
        print("targets.json missing")
        return {}

def calculate_portfolio():
    targets = load_targets()

    holdings = []
    weights = {}

    for group in targets:
        for ticker, weight in targets[group].items():
            holdings.append(ticker)
            weights[ticker] = weights.get(ticker, 0) + weight

    return weights, holdings

# =======================
# LOAD SIGNALS
# =======================
def load_signals():
    try:
        with open(os.path.join(DATA_DIR, "signals.json")) as f:
            return json.load(f)
    except:
        return []

# =======================
# SCORING
# =======================
def score_asset(sniper_score=0):

    score = 50

    if sniper_score > 80:
        score += 25
    elif sniper_score > 70:
        score += 20
    elif sniper_score > 60:
        score += 10
    else:
        score -= 5

    return score

# =======================
# ACTION ENGINE
# =======================
def build_actions(weights, holdings):

    sniper = load_signals()
    sniper_map = {s.get("asset"): s for s in sniper}

    scored = []

    for t in holdings:
        sniper_score = sniper_map.get(t, {}).get("confidence", 0)
        score = score_asset(sniper_score)

        scored.append({
            "ticker": t,
            "score": score,
            "weight": weights.get(t, 0)
        })

    scored.sort(key=lambda x: x["score"])

    weak_assets = [x for x in scored if x["score"] < 60]

    strong_sniper = sorted(
        sniper,
        key=lambda x: x.get("confidence", 0),
        reverse=True
    )

    actions = []
    swaps = []

    # =========================
    # SWAP LOGIC (SMART)
    # =========================
    for w in weak_assets:
        for s in strong_sniper:

            new_score = score_asset(s.get("confidence", 0))
            improvement = new_score - w["score"]

            if (
                improvement >= 8 and
                new_score >= 70 and
                s.get("asset") not in holdings
            ):
                swaps.append({
                    "out": w["ticker"],
                    "in": s.get("asset"),
                    "improvement": improvement
                })

    swaps.sort(key=lambda x: x["improvement"], reverse=True)

    MAX_SWAPS = 2

    for s in swaps[:MAX_SWAPS]:
        actions.append(
            f"🔁 SWAP (+{s['improvement']})\nOUT: {s['out']}\nIN: {s['in']}"
        )

    # =========================
    # ADD LOGIC
    # =========================
    for s in strong_sniper[:3]:
        if s.get("confidence", 0) >= 80 and s.get("asset") not in holdings:
            actions.append(f"🔥 ADD {s['asset']} ({s['confidence']}%)")

    # =========================
    # SAVE ACTIONS
    # =========================
    try:
        with open(os.path.join(DATA_DIR, "actions.json"), "w") as f:
            json.dump(actions, f, indent=2)
    except Exception as e:
        print("actions save error:", e)

    return actions

# =======================
# RUN
# =======================
def run():

    ensure_files()

    weights, holdings = calculate_portfolio()

    if not holdings:
        print("No holdings")
        return

    actions = build_actions(weights, holdings)

    if not actions:
        print("No actions")
        return

    actions_text = "\n\n".join(actions)

    # ONLY send meaningful signals
    if "SWAP" in actions_text or "ADD" in actions_text:
        print("🧠 ACTIONS:\n", actions_text)

        send(
            f"<b>🧠 PORTFOLIO ACTIONS</b>\n"
            f"<i>{now()}</i>\n\n"
            f"{actions_text}"
        )
    else:
        print("No strong signals")

# =======================
# LOOP
# =======================
def main_loop():
    while True:
        try:
            print("=== PORTFOLIO CYCLE ===")
            run()
        except Exception as e:
            print("Portfolio error:", e)

        time.sleep(300)

if __name__ == "__main__":
    main_loop()
