#!/bin/bash

# Move to the directory where this script is located
cd "$(dirname "$0")"

# Clear terminal for a clean look
clear

echo "🚀 Merchant Autofill Helper"
echo "=============================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed."
    echo ""
    echo "Please install Node.js from: https://nodejs.org"
    echo "Then run this file again."
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

# First-time setup: Install dependencies silently
if [ ! -d "node_modules" ]; then
    echo "📦 First-time setup: Installing dependencies..."
    echo "   This may take a few minutes..."
    echo ""
    npm install --silent --no-audit --no-fund > /dev/null 2>&1

    if [ $? -eq 0 ]; then
        echo "✅ Installation complete!"
        echo ""
    else
        echo "❌ Installation failed. Please check your internet connection."
        echo ""
        read -p "Press Enter to exit..."
        exit 1
    fi
fi

# Run the server with exec to take over the shell
exec npm run dev
