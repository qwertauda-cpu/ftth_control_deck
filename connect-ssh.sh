#!/bin/bash

# Script to connect to server via SSH
# Usage: bash connect-ssh.sh

SERVER="130.211.200.58"
USER="qwertauda"
PASSWORD="t3c1061@"

echo "=========================================="
echo "🔐 Connecting to server via SSH"
echo "=========================================="
echo ""
echo "Server: $USER@$SERVER"
echo ""

# Method 1: Direct SSH connection (will prompt for password)
echo "Connecting via SSH..."
echo "Password: $PASSWORD"
echo ""

# Connect to server
ssh "$USER@$SERVER"

