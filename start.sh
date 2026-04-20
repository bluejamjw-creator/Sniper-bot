#!/bin/sh

echo "Starting Sniper + Portfolio..."

node sniper.js &
python portfolio_bot.py
