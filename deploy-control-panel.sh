#!/bin/bash

# Script to deploy control panel on server
# Usage: ssh user@server 'bash -s' < deploy-control-panel.sh

echo "=========================================="
echo "🚀 Deploying Control Panel"
echo "=========================================="

# Navigate to project directory
cd /var/www/ftth_control_deck || {
    echo "❌ Error: Directory /var/www/ftth_control_deck not found"
    exit 1
}

echo "✅ Current directory: $(pwd)"

# Pull latest changes
echo ""
echo "📥 Pulling latest changes from Git..."
git fetch origin
git pull origin main

# Check if control panel files exist
echo ""
echo "📁 Checking control panel files..."
if [ -f "api/control-login.html" ] && [ -f "api/control-panel.html" ]; then
    echo "✅ control-login.html exists"
    echo "✅ control-panel.html exists"
else
    echo "❌ Control panel files not found!"
    echo "Files in api directory:"
    ls -la api/control-*.html 2>/dev/null || echo "No control panel files found"
    exit 1
fi

# Restart PM2
echo ""
echo "🔄 Restarting PM2..."
pm2 restart ftth-control-deck

# Show logs
echo ""
echo "📋 Recent logs:"
pm2 logs ftth-control-deck --lines 30 --nostream

echo ""
echo "=========================================="
echo "✅ Deployment complete!"
echo "=========================================="
echo ""
echo "🌐 Access control panel at:"
echo "   http://130.211.200.58:3000/control-login.html"
echo ""
echo "🔑 Default password: admin123"
echo "   (Change CONTROL_PASSWORD in .env file)"
echo ""

