#!/bin/sh

echo "Starting services..."

# Start portfolio bot in background loop
while true; do
  echo "=== PORTFOLIO CYCLE ==="
  python3 portfolio_bot.py
  sleep 300
done &

# Start sniper in foreground loop (keeps container alive)
while true; do
  echo "=== SNIPER CYCLE ==="
  node sniper.js
  sleep 300
done
