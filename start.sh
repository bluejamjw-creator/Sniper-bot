#!/bin/bash

echo "Starting loop..."

while true
do
  echo "Running portfolio..."
  python3 portfolio_bot.py || echo "Portfolio failed"

  echo "Running sniper..."
  node sniper.js || echo "Sniper failed"

  echo "Sleeping 15 minutes..."
  sleep 900
done
