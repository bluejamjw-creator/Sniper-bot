#!/bin/sh

echo "Starting services..."

# Start portfolio bot (runs its own loop)
python3 portfolio_bot.py &

# Start sniper (runs continuously with internal loop)
node sniper.js
