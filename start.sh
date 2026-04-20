#!/bin/sh
set -eu

echo "Starting Portfolio Bot..."
python3 portfolio_bot.py

echo "Starting Sniper..."
exec node sniper.js
