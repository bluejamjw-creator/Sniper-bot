import json
import requests
from datetime import datetime

BOT_TOKEN = None  # keep your env setup if already done
CHAT_ID = None

POT_ORDER = ["core", "aggressive", "crypto"]

# =======================
# BASIC HELPERS
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
        print(e)


def fmt_money(x):
    return f"£{x:,.2f}"


def fmt_units(x):
    return f"{x:.4f}u"


def build_table(rows):
    return "<pre>" + "\n".join(rows) + "</pre>"


def format_uk_time():
    return datetime.now().strftime("%d %b %H:%M")


# =======================
# MOCK / EXISTING HOOKS
# (leave yours if already implemented)
# =======================
def get_price(ticker):
    return None  # keep your real version


def calculate_portfolio():
    return 0, {}, {}, []


def get_targets():
    return {}


def build_sniper_context(holdings):
    return None, "No sniper data"


def ensure_files():
    pass


# =======================
# DRIFT
# =======================
def drift_report(total, values, targets):
    sections = []

    for pot in POT_ORDER:
        pot_targets = targets.get(pot, {})
        if not pot_targets:
            continue

        rows = []
        for ticker, w in pot_targets.items():
            current = values.get(ticker, 0.0)
            pct = (current / total * 100) if total > 0 else 0.0
            drift = pct - float(w)
            rows.append(f"{ticker:<8} {pct:>5.1f}% / {float(w):>5.1f}%  {drift:+5.1f}%")

        if rows:
            sections.append(f"<b>{pot.upper()}</b>\n" + build_table(rows))

    return "\n\n".join(sections)


# =======================
# BUY PLAN
# =======================
def build_buy_plan(targets, budget=300.0):
    monthly = {"core": 100.0, "aggressive": 100.0, "crypto": 100.0}
    blocks = [f"<b>🧰 BUY PLAN</b>\nTotal: £{int(budget)}"]

    for pot in POT_ORDER:
        pot_total = monthly[pot]
        emoji = {"core": "📦", "aggressive": "🔥", "crypto": "🪙"}[pot]

        rows = []

        for ticker, weight in targets.get(pot, {}).items():
            amount = round(pot_total * float(weight) / 100.0, 2)
            price = get_price(ticker)

            if price:
                units = amount / price
                rows.append(f"{ticker:<8} {fmt_money(amount):>9}  {fmt_units(units):>10}")
            else:
                rows.append(f"{ticker:<8} {fmt_money(amount):>9}  {'no data':>10}")

        blocks.append(f"<b>{emoji} {pot.upper()}</b>\n" + build_table(rows))

    return "\n\n".join(blocks)


# =======================
# 🧠 NEW: SNIPER DATA
# =======================
def load_sniper_signals():
    try:
        with open("data/signals.json") as f:
            return json.load(f)
    except:
        return []


# =======================
# 🧠 NEW: SCORING
# =======================
def score_asset(ticker, sniper_score=0):
    score = 50

    if sniper_score > 70:
        score += 20
    elif sniper_score > 60:
        score += 10
    elif sniper_score == 0:
        score -= 10

    if score > 70:
        label = "strong"
    elif score > 55:
        label = "neutral"
    else:
        label = "weak"

    return score, label


# =======================
# 🧠 NEW: DECISION ENGINE
# =======================
def build_actions(holdings):
    sniper = load_sniper_signals()

    sniper_map = {s["asset"]: s for s in sniper}

    scored = []

    for t in holdings:
        sniper_score = sniper_map.get(t, {}).get("confidence", 0)
        score, label = score_asset(t, sniper_score)

        scored.append({
            "ticker": t,
            "score": score,
            "label": label,
            "sniper": sniper_score
        })

    scored.sort(key=lambda x: x["score"])

    actions = []

    weak = [x for x in scored if x["score"] < 55]

    for w in weak:
        actions.append(f"⚠️ {w['ticker']} weak ({w['score']})")

    strong_sniper = sorted(
        sniper,
        key=lambda x: x["confidence"],
        reverse=True
    )[:3]

    for w, s in zip(weak, strong_sniper):
        actions.append(
            f"🔁 SWAP IDEA\nOUT: {w['ticker']} ({w['score']})\nIN: {s['asset']} ({s['confidence']}%)"
        )

    for s in strong_sniper:
        if s["confidence"] > 70:
            actions.append(f"🔥 ADD {s['asset']} ({s['confidence']}%)")

    return "\n\n".join(actions) if actions else "No actions"


# =======================
# SUMMARY
# =======================
def build_portfolio_summary():
    total, values, prices, holdings = calculate_portfolio()
    latest, sniper_line = build_sniper_context(holdings)
    targets = get_targets()

    actions = build_actions(holdings)

    parts = [
        "<b>📊 PORTFOLIO SUMMARY</b>",
        format_uk_time(),
        f"Total value: {fmt_money(total)}",
        "",
        "<b>⚖️ SNIPER</b>",
        sniper_line,
        "",
        "<b>📍 DRIFT</b>",
        drift_report(total, values, targets) or "No holdings yet",
        "",
        "<b>🧠 ACTIONS</b>",
        actions
    ]

    return "\n".join(parts)


# =======================
# RUN
# =======================
def run():
    ensure_files()
    msg = build_buy_plan(get_targets()) + "\n\n" + build_portfolio_summary()
    print(msg)
    send(msg)
