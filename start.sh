#!/bin/sh
set -eu

echo "Starting Sniper + Portfolio Bot..."

node sniper-final.js &
SNIPER_PID=$!

python3 portfolio_bot.py &
PORTFOLIO_PID=$!

trap 'echo "Shutting down..."; kill "$SNIPER_PID" "$PORTFOLIO_PID" 2>/dev/null || true' INT TERM

wait -n "$SNIPER_PID" "$PORTFOLIO_PID"
STATUS=$?

echo "One process exited with status $STATUS. Stopping both..."
kill "$SNIPER_PID" "$PORTFOLIO_PID" 2>/dev/null || true
wait 2>/dev/null || true

exit "$STATUS"
