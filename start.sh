#!/bin/sh
set -eu

echo "Starting Portfolio Bot..."
python3 portfolio_bot.py &

PORTFOLIO_PID=$!

echo "Starting Sniper..."
node sniper.js &

SNIPER_PID=$!

trap 'kill $PORTFOLIO_PID $SNIPER_PID 2>/dev/null || true; wait $PORTFOLIO_PID $SNIPER_PID 2>/dev/null || true' TERM INT

wait $PORTFOLIO_PID $SNIPER_PID
