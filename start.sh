#!/bin/sh
set -eu

echo "Starting services..."

while true
do
  echo "Starting Portfolio Bot..."
  python3 portfolio_bot.py &

  echo "Starting Sniper..."
  node sniper.js &

  PORTFOLIO_PID=$!
  SNIPER_PID=$!

  # Wait until either process exits
  wait -n $PORTFOLIO_PID $SNIPER_PID

  echo "One process stopped. Restarting both..."

  kill $PORTFOLIO_PID $SNIPER_PID 2>/dev/null || true
  wait $PORTFOLIO_PID $SNIPER_PID 2>/dev/null || true

  sleep 2
done
