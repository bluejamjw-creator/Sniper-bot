#!/bin/sh
set -eu

echo "Starting loop..."

while true
do
  echo "Running portfolio..."
  python3 portfolio_bot.py || true

  echo "Running sniper..."
  node sniper.js || true

  echo "Sleeping 5 minutes..."
  sleep 300
done
