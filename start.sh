#!/bin/bash

echo "Starting loop..."

while true
do
  echo "======================"
  echo "New cycle: $(date)"
  echo "======================"

  echo "Running portfolio..."
  python3 portfolio_bot.py || echo "Portfolio failed"

  echo "Running sniper..."
  node sniper.js || echo "Sniper failed"

  echo "Cycle complete"

  echo "Sleeping 5 minutes..."
  sleep 300
done
