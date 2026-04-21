# =======================
# PORTFOLIO BOT V3 (QUIET + ACTIVE)
# =======================

import json
import requests
from datetime import datetime
import time
import os

BOT_TOKEN = os.getenv("BOT_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")

DATA_DIR = os.getenv("DATA_DIR", "/app/data")
POT_ORDER = ["core", "aggressive", "crypto"]

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
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
            timeout=20,
        )
    except Exception as e:
        print("Telegram error:", e)

# =======================
# HELPERS
# =======================
def fmt_money(x):
    return f"£{x:,.2f}"

def build_table(rows):
    return "<pre>" + "\n".join(rows) + "</pre"

def format_uk_time():
    return datetime.now().strftime("%d %b %H:%M")

# =======================
# FILES
# =======================
def ensure_files():
    os.makedirs(DATA_DIR, exist_ok=True)

    for file in ["signals.json", "actions.json"]:
        path = os.path.join(DATA_DIR, file)
        if not os.path.exists(path):
            with open(path, "w") as f:
                json.dump([], f)

# =======================
# HOOKS
# =======================
def calculate_portfolio():
    return 0, {}, {}, []

def get_targets():
    try:
        with open("targets.json") as f:
            return json.load(f)
    except:
        return {}

def build_sniper_context(holdings):
    return None, "Live signals active"

# =======================
# LOAD SIGNALS
# =======================
def load_sniper_signals():
    try:
        with open(os.path.join(DATA_DIR, "signals.json")) as f:
            return json.load(f)
    except:
        return []

# =======================
# SCORING
# =======================
def score_asset(ticker, sniper_score=0):

    score = 50

    if sniper_score > 80:
        score += 25
    elif sniper_score > 70:
        score += 20
    elif sniper_score > 60:
        score += 10
    else:
        score -= 5

    if score >= 75:
        label = "strong"
    elif score >= 60:
        label = "neutral"
    else:
        label = "weak"

    return score, label

# =======================
# ACTION ENGINE
# =======================
def build_actions(holdings):

    sniper = load_sniper_signals()
    sniper_map = {s["asset"]: s for s in sniper}

    scored = []

    for t in holdings:
        sniper_score = sniper_map.get(t, {}).get("score", 0)  # ✅ FIXED
        score, label = score_asset(t, sniper_score)

        scored.append({
            "ticker": t,
            "score": score,
            "label": label,
            "sniper": sniper_score
        })

    scored.sort(key=lambda x: x["score"])

    actions = []

    weak = [x for x in scored if x["score"] < 60]

    for w in weak:
        actions.append(f"⚠️ {w['ticker']} weak ({w['score']})")

    strong_sniper = sorted(
        sniper,
        key=lambda x: x.get("score", 0),
        reverse=True
    )[:3]

    for w, s in zip(weak, strong_sniper):
        actions.append(
            f"🔁 SWAP IDEA\nOUT: {w['ticker']}\nIN: {s['asset']} ({s['score']})"
        )

    for s in strong_sniper:
        if s.get("score", 0) > 75:
            actions.append(f"🔥 ADD {s['asset']} ({s['score']})")

    actions_text = "\n\n".join(actions) if actions else "No actions"

    # Save for app
    try:
        with open(os.path.join(DATA_DIR, "actions.json"), "w") as f:
            json.dump(actions, f, indent=2)
    except Exception as e:
        print("actions.json error:", e)

    return actions_text

# =======================
# RUN
# =======================
def run():

    ensure_files()

    total, values, prices, holdings = calculate_portfolio()
    actions = build_actions(holdings)

    actions = build_actions(holdings)

# Only send meaningful actions (no spam)
if any(x in actions for x in ["ADD", "SWAP"]):
    print("🧠 ACTIONS:", actions)
    send(f"<b>🧠 PORTFOLIO ACTIONS</b>\n\n{actions}")



# =======================
# LOOP
# =======================
def main_loop():
    while True:

        try:
            run()
        except Exception as e:
            print("Portfolio error:", e)

        time.sleep(300)

if __name__ == "__main__":
    main_loop()
