#!/bin/sh

echo "Starting Sniper + Portfolio Bot..."

node sniper-final.js &
python3 portfolio_bot.py
