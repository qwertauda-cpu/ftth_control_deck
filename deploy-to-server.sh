#!/bin/bash

# Script to deploy control panel to server
# Run this in Git Bash: bash deploy-to-server.sh

SERVER="130.211.200.58"
USER="qwertauda"
PASSWORD="t3c1061@"

echo "=========================================="
echo "🚀 Connecting to server and deploying..."
echo "=========================================="
echo ""

# Commands to execute on server
COMMANDS="cd /var/www/ftth_control_deck && git pull origin main && pm2 restart ftth-control-deck && pm2 logs ftth-control-deck --lines 30 --nostream"

# Try to connect using sshpass if available, otherwise use expect
if command -v sshpass &> /dev/null; then
    echo "✅ Using sshpass for password authentication"
    sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no "$USER@$SERVER" "$COMMANDS"
elif command -v expect &> /dev/null; then
    echo "✅ Using expect for password authentication"
    expect << EOF
    spawn ssh -o StrictHostKeyChecking=no "$USER@$SERVER" "$COMMANDS"
    expect "password:"
    send "$PASSWORD\r"
    expect eof
EOF
else
    echo "❌ Neither sshpass nor expect is available"
    echo ""
    echo "Please run these commands manually in Git Bash:"
    echo ""
    echo "ssh $USER@$SERVER"
    echo "cd /var/www/ftth_control_deck"
    echo "git pull origin main"
    echo "pm2 restart ftth-control-deck"
    echo "pm2 logs ftth-control-deck --lines 50"
    echo ""
    echo "Or install sshpass:"
    echo "  - On Ubuntu/Debian: sudo apt-get install sshpass"
    echo "  - On Windows (Git Bash): Download from https://sourceforge.net/projects/sshpass/"
    exit 1
fi

echo ""
echo "=========================================="
echo "✅ Deployment complete!"
echo "=========================================="
echo ""
echo "🌐 Access control panel at:"
echo "   http://$SERVER:3000/control-login.html"
echo ""

