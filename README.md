# 🚀 Sniper Bot

A one-service Railway deployment that runs:

- **Sniper bot** — scans stocks and crypto for breakout opportunities
- **Portfolio bot** — sends portfolio reviews, holdings updates, and sniper watchlist summaries

Both bots run together in one Docker container using `start.sh`.

---

## Files

- `Dockerfile` — builds the Railway service
- `start.sh` — starts both bots in one service
- `package.json` — Node setup for the sniper bot
- `requirements.txt` — Python dependencies for the portfolio bot
- `sniper-final.js` — breakout and opportunity scanner
- `portfolio_bot.py` — portfolio update and holdings review bot
- `README.md` — project guide

---

## How it works

### Sniper bot
The sniper bot:
- scans stocks and crypto
- looks for trend + breakout setups
- ranks opportunities by confidence
- saves signals into `signals.json`
- sends top alerts to Telegram

### Portfolio bot
The portfolio bot:
- reviews Pot 1, Pot 2, and Pot 3
- checks price change and basic status
- reads `signals.json`
- sends Telegram portfolio updates
- shows the strongest sniper ideas in the watchlist section

---

## Pots

### Pot 1 — Core
Long-term retirement-style holdings.

### Pot 2 — Aggressive
Higher-growth positions for medium-term profit goals.

### Pot 3 — Crypto
Higher-risk crypto positions with stricter trim and review logic.

---

## Environment variables

Add these in Railway:

```env
BOT_TOKEN=your_telegram_bot_token
CHAT_ID=your_telegram_chat_id
