#!/bin/sh
set -eu

echo "Starting Sniper + Portfolio..."

python3 portfolio_bot.py &
PORTFOLIO_PID=$!

node sniper.js &
SNIPER_PID=$!

cleanup() {
  kill $PORTFOLIO_PID $SNIPER_PID 2>/dev/null || true
  wait $PORTFOLIO_PID $SNIPER_PID 2>/dev/null || true
}

trap cleanup INT TERM

wait -n $PORTFOLIO_PID $SNIPER_PID
cleanup
