def send(msg):
    if not BOT_TOKEN or not CHAT_ID:
        print(msg)
        return

    try:
        r = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={
                "chat_id": CHAT_ID,
                "text": msg,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
            timeout=20,
        )
        r.raise_for_status()
    except Exception as e:
        print(f"Telegram send error: {e}")
        print(msg)


def fmt_money(x):
    return f"£{x:,.2f}"


def fmt_units(x):
    return f"{x:.4f}u"


def build_table(rows):
    return "<pre>" + "\n".join(rows) + "</pre>"


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


def build_buy_plan(targets, budget=300.0):
    monthly = {"core": 100.0, "aggressive": 100.0, "crypto": 100.0}
    blocks = [f"<b>🧰 BUY PLAN</b>\nTotal: £{int(budget)}"]

    for pot in POT_ORDER:
        pot_total = monthly[pot]
        emoji = {"core": "📦", "aggressive": "🔥", "crypto": "🪙"}[pot]

        rows = []
        missing = []

        for ticker, weight in targets.get(pot, {}).items():
            amount = round(pot_total * float(weight) / 100.0, 2)
            price = get_price(ticker)

            if price and price > 0:
                units = amount / price
                rows.append(f"{ticker:<8} {fmt_money(amount):>9}  {fmt_units(units):>10}")
            else:
                missing.append(f"{ticker:<8} {fmt_money(amount):>9}  {'no data':>10}")

        section = [f"<b>{emoji} {pot.upper()} ({fmt_money(pot_total)})</b>"]

        if rows:
            section.append(build_table(rows))

        if missing:
            section.append("No price data:\n" + build_table(missing))

        blocks.append("\n".join(section))

    return "\n\n".join(blocks)


def build_portfolio_summary():
    total, values, prices, holdings = calculate_portfolio()
    latest, sniper_line = build_sniper_context(holdings)
    targets = get_targets()

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
    ]

    return "\n".join(parts).strip()


def run():
    ensure_files()
    msg = build_buy_plan(get_targets()) + "\n\n" + build_portfolio_summary()
    print(msg)
    send(msg)
