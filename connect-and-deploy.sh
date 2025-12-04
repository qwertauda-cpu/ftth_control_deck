#!/bin/bash

# Script to connect to server and deploy automatically
# Usage: bash connect-and-deploy.sh

SERVER="130.211.200.58"
USER="qwertauda"
PASSWORD="t3c1061@"

echo "=========================================="
echo "🚀 Connecting and Deploying"
echo "=========================================="
echo ""

# Commands to execute on server
COMMANDS="
cd /var/www/ftth_control_deck && \
echo '📥 Pulling latest changes...' && \
git pull origin main && \
echo '🔄 Restarting PM2...' && \
pm2 restart ftth-control-deck && \
echo '📊 Checking status...' && \
pm2 status && \
echo '📋 Recent logs:' && \
pm2 logs ftth-control-deck --lines 30 --nostream
"

echo "Connecting to $USER@$SERVER..."
echo "You will be prompted for password: $PASSWORD"
echo ""

# Connect and execute commands
ssh "$USER@$SERVER" "$COMMANDS"

echo ""
echo "=========================================="
echo "✅ Deployment complete!"
echo "=========================================="
echo ""
echo "🌐 Access control panel at:"
echo "   http://$SERVER:3000/control-login.html"
echo ""

