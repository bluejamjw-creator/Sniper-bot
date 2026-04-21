#!/bin/sh

echo "Starting services..."

python3 portfolio_bot.py &

node sniper.js
