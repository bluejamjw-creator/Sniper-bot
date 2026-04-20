#!/bin/sh
set -eu

echo "Starting Sniper + Portfolio..."

node sniper.js &
SNIPER_PID=$!

python portfolio_bot.py &
PORTFOLIO_PID=$!

trap 'echo "Stopping..."; kill $SNIPER_PID $PORTFOLIO_PID 2>/dev/null || true' INT TERM

wait $SNIPER_PID $PORTFOLIO_PID
