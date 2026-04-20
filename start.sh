#!/bin/sh

echo "Starting loop..."

while true
do
  echo "Running portfolio..."
  python3 portfolio_bot.py || echo "Portfolio failed"

  echo "Running sniper..."
  node sniper.js || echo "Sniper failed"

  echo "Sleeping 5 minutes..."
  sleep 300
done
