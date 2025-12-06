# PowerShell script to connect to server and execute commands
$ErrorActionPreference = "Stop"

$server = "130.211.200.58"
$user = "qwertauda"
$password = "t3c1061@"

Write-Host "==========================================" -ForegroundColor Green
Write-Host "🚀 Connecting to server..." -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""

# Commands to execute (single line)
$commands = "cd /var/www/ftth_control_deck && git fetch origin && git reset --hard origin/main && cd api && npm install bcrypt --save && cd .. && pm2 delete ftth-control-deck 2>/dev/null || true && pm2 start api/server.js --name ftth-control-deck && pm2 save && sleep 3 && pm2 status && pm2 logs ftth-control-deck --lines 30 --nostream"

# Try using plink (PuTTY) if available
if (Get-Command plink -ErrorAction SilentlyContinue) {
    Write-Host "✅ Using plink (PuTTY)..." -ForegroundColor Yellow
    $commands | plink -ssh "$user@$server" -pw $password
} 
# Try using ssh with expect-like approach
elseif (Get-Command ssh -ErrorAction SilentlyContinue) {
    Write-Host "✅ Using SSH..." -ForegroundColor Yellow
    Write-Host "Note: You may need to enter password manually" -ForegroundColor Yellow
    Write-Host ""
    
    # Execute commands directly
    Write-Host "Executing commands on server..." -ForegroundColor Yellow
    Write-Host "Password: $password" -ForegroundColor Cyan
    ssh "$user@$server" $commands
}
else {
    Write-Host "❌ SSH tools not found. Please install:" -ForegroundColor Red
    Write-Host "   - OpenSSH (usually pre-installed in Windows 10)" -ForegroundColor Yellow
    Write-Host "   - Or PuTTY (plink.exe)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Manual commands:" -ForegroundColor Cyan
    Write-Host "ssh $user@$server" -ForegroundColor White
    Write-Host "cd /var/www/ftth_control_deck" -ForegroundColor White
    Write-Host "git pull origin main" -ForegroundColor White
    Write-Host "pm2 restart ftth-control-deck" -ForegroundColor White
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "✅ Done!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
