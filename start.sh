#!/bin/sh

echo "Starting services..."

python3 portfolio_bot.py &

exec node sniper.js
