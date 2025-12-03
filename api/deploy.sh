#!/bin/bash

# Auto-deploy script for GitHub webhook
# This script will be called by the webhook endpoint

PROJECT_PATH="${PROJECT_PATH:-/var/www/ftth_control_deck}"
PM2_APP_NAME="${PM2_APP_NAME:-ftth-api}"

echo "[DEPLOY] Starting deployment at $(date)"

# Navigate to project directory
cd "$PROJECT_PATH" || exit 1

# Pull latest changes
echo "[DEPLOY] Pulling latest changes from GitHub..."
git pull origin main

if [ $? -eq 0 ]; then
    echo "[DEPLOY] ✅ Git pull successful"
    
    # Install dependencies if needed
    echo "[DEPLOY] Installing/updating dependencies..."
    cd "$PROJECT_PATH/api" || exit 1
    npm install
    
    # Restart PM2 application
    echo "[DEPLOY] Restarting PM2 application..."
    pm2 restart "$PM2_APP_NAME"
    
    if [ $? -eq 0 ]; then
        echo "[DEPLOY] ✅ Deployment completed successfully at $(date)"
    else
        echo "[DEPLOY] ❌ PM2 restart failed"
        exit 1
    fi
else
    echo "[DEPLOY] ❌ Git pull failed"
    exit 1
fi

