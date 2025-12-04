#!/bin/bash

# Script to deploy admin dashboard on server
# Run this on the server: bash deploy-admin-dashboard.sh

echo "=========================================="
echo "🚀 Deploying Admin Dashboard"
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
git reset --hard origin/main

# Check if admin files exist
echo ""
echo "📁 Checking admin files..."
if [ -f "api/admin-login.html" ] && [ -f "api/admin-dashboard.html" ]; then
    echo "✅ admin-login.html exists"
    echo "✅ admin-dashboard.html exists"
else
    echo "❌ Admin files not found!"
    echo "Files in api directory:"
    ls -la api/admin-*.html 2>/dev/null || echo "No admin files found"
    exit 1
fi

# Restart PM2
echo ""
echo "🔄 Restarting PM2..."
pm2 restart ftth-control-deck

# Show logs
echo ""
echo "📋 Recent logs:"
pm2 logs ftth-control-deck --lines 20 --nostream

echo ""
echo "=========================================="
echo "✅ Deployment complete!"
echo "=========================================="
echo ""
echo "🌐 Access dashboard at:"
echo "   http://$(hostname -I | awk '{print $1}'):3000/admin-dashboard.html"
echo "   or"
echo "   http://130.211.200.58:3000/admin-dashboard.html"
echo ""

