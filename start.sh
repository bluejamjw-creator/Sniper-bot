#!/bin/sh
set -eu

echo "Starting Sniper + Portfolio Bot..."

node sniper-final.js &
SNIPER_PID=$!

python3 portfolio_bot.py &
PORTFOLIO_PID=$!

trap 'echo "Shutting down..."; kill "$SNIPER_PID" "$PORTFOLIO_PID" 2>/dev/null || true' INT TERM

while kill -0 "$SNIPER_PID" 2>/dev/null && kill -0 "$PORTFOLIO_PID" 2>/dev/null; do
  sleep 5
done

echo "One process exited. Stopping both..."
kill "$SNIPER_PID" "$PORTFOLIO_PID" 2>/dev/null || true
wait "$SNIPER_PID" 2>/dev/null || true
wait "$PORTFOLIO_PID" 2>/dev/null || true

exit 1
