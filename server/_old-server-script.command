#!/bin/bash
cd "$(dirname "$0")"

# Clear all previous terminal clutter
clear

# 1. Silent Setup
if [ ! -d "node_modules" ]; then
    echo "📦 First-time setup: Installing dependencies..."
    # --no-audit and --no-fund remove the vulnerability/funding messages
    npm install --silent --no-audit --no-fund > /dev/null 2>&1
fi

# 2. Run the server 
# We use 'exec' to make the Node process take over the shell, 
# preventing the "Saving session" logs from appearing until you actually close it.
exec npm start --silent