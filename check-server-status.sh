#!/bin/bash

echo "=========================================="
echo "🔍 Checking Server Status"
echo "=========================================="
echo ""

echo "1. Checking PM2 status..."
pm2 status
echo ""

echo "2. Checking if port 3000 is in use..."
netstat -tuln | grep 3000 || ss -tuln | grep 3000 || echo "Port 3000 not found"
echo ""

echo "3. Checking PM2 logs (last 50 lines)..."
pm2 logs ftth-control-deck --lines 50 --nostream
echo ""

echo "4. Checking if server.js exists..."
ls -la /var/www/ftth_control_deck/api/server.js
echo ""

echo "5. Checking control panel files..."
ls -la /var/www/ftth_control_deck/api/control-*.html
echo ""

echo "6. Trying to start server if not running..."
pm2 start /var/www/ftth_control_deck/api/server.js --name ftth-control-deck || pm2 restart ftth-control-deck
echo ""

echo "7. Final PM2 status..."
pm2 status
echo ""

echo "=========================================="
echo "✅ Check complete!"
echo "=========================================="

