#!/bin/sh

echo "Starting Sniper + Portfolio Bot..."

npm install
pip install -r requirements.txt

node sniper-final.js &
python3 portfolio_bot.py

wait
