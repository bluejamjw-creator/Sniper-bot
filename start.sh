#!/bin/sh

echo "Starting Sniper..."

# Run sniper continuously
while true; do
  echo "=== SNIPER CYCLE ==="
  node sniper.js
  sleep 300
done
