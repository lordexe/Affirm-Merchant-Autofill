#!/bin/bash
# Move to the directory where this script is located
cd "$(dirname "$0")"

echo "🚀 Starting Merchant Helper..."
echo "----------------------------"

# Ensure dependencies are installed (only runs the first time)
if [ ! -d "node_modules" ]; then
    echo "📦 First-time setup: Installing dependencies..."
    npm install
fi

# Run the server
npm start