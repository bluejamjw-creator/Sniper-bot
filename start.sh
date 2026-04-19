#!/bin/bash

echo "Starting Sniper + Portfolio..."

node sniper-final.js &
python3 portfolio_bot.py

wait
