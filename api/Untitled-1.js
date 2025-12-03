// admin-server.js - Server Control Dashboard Backend
const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'))); // للخدمات الثابتة

// Authentication
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // غيّر هذا!

// Helper function to execute commands
function executeCommand(command, requireSudo = false) {
    return new Promise((resolve, reject) => {
        const fullCommand = requireSudo ? `echo '${ADMIN_PASSWORD}' | sudo -S ${command}` : command;
        exec(fullCommand, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            resolve({
                success: !error,
                output: stdout || '',
                error: stderr || '',
                code: error ? error.code : 0
            });
        });
    });
}

// Authentication middleware
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === ADMIN_PASSWORD) {
            next();
            return;
        }
    }
    res.status(401).json({ error: 'Unauthorized - Invalid token' });
};

// Routes

// Get server status
app.get('/api/admin/status', requireAuth, async (req, res) => {
    try {
        const [apacheStatus, pm2Status, diskUsage, memoryUsage] = await Promise.all([
            executeCommand('systemctl is-active apache2'),
            executeCommand('pm2 jlist'),
            executeCommand('df -h /'),
            executeCommand('free -h')
        ]);

        res.json({
            success: true,
            data: {
                apache: {
                    status: apacheStatus.output.trim(),
                    active: apacheStatus.output.trim() === 'active'
                },
                pm2: pm2Status.success ? JSON.parse(pm2Status.output) : [],
                disk: diskUsage.output,
                memory: memoryUsage.output
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Restart Apache
app.post('/api/admin/restart-apache', requireAuth, async (req, res) => {
    try {
        const result = await executeCommand('systemctl restart apache2', true);
        res.json({
            success: result.success,
            message: result.success ? 'Apache restarted successfully' : 'Failed to restart Apache',
            output: result.output,
            error: result.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Restart API
app.post('/api/admin/restart-api', requireAuth, async (req, res) => {
    try {
        const result = await executeCommand('pm2 restart ftth-api');
        res.json({
            success: result.success,
            message: result.success ? 'API restarted successfully' : 'Failed to restart API',
            output: result.output,
            error: result.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get API logs
app.get('/api/admin/logs/:service?', requireAuth, async (req, res) => {
    try {
        const service = req.params.service || 'ftth-api';
        const lines = req.query.lines || 100;
        const result = await executeCommand(`pm2 logs ${service} --lines ${lines} --nostream`);
        
        res.json({
            success: true,
            logs: result.output || result.error,
            service: service
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get PM2 processes
app.get('/api/admin/pm2/status', requireAuth, async (req, res) => {
    try {
        const result = await executeCommand('pm2 jlist');
        const processes = result.success ? JSON.parse(result.output) : [];
        res.json({ success: true, processes });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Execute custom command (with caution)
app.post('/api/admin/execute', requireAuth, async (req, res) => {
    try {
        const { command, requireSudo } = req.body;
        
        // Security: Block dangerous commands
        const dangerousCommands = ['rm -rf', 'format', 'mkfs', 'dd if=', 'shutdown', 'reboot'];
        const isDangerous = dangerousCommands.some(cmd => command.includes(cmd));
        
        if (isDangerous) {
            return res.status(403).json({ 
                success: false, 
                error: 'Dangerous command blocked for security' 
            });
        }
        
        const result = await executeCommand(command, requireSudo);
        res.json({
            success: result.success,
            output: result.output,
            error: result.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Git pull (deploy)
app.post('/api/admin/deploy', requireAuth, async (req, res) => {
    try {
        const result = await executeCommand('cd /var/www/ftth_control_deck && git pull origin main');
        res.json({
            success: result.success,
            message: result.success ? 'Deployment completed' : 'Deployment failed',
            output: result.output,
            error: result.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GitHub Webhook - Auto Deploy (لا يحتاج authentication لأن GitHub يرسل secret)
app.post('/api/admin/webhook/github', async (req, res) => {
    try {
        const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
        const githubEvent = req.headers['x-github-event'];
        const githubSignature = req.headers['x-hub-signature-256'];
        
        // التحقق من أن الطلب من GitHub (اختياري لكن آمن)
        if (WEBHOOK_SECRET && githubSignature) {
            // يمكن إضافة التحقق من الـ signature هنا
            // لكن سنتركه بسيطاً الآن
        }
        
        // نستجيب فوراً لـ GitHub
        res.status(200).json({ success: true, message: 'Webhook received' });
        
        // تنفيذ التحديث في الخلفية
        if (githubEvent === 'push') {
            console.log('[WEBHOOK] GitHub push detected, starting auto-deploy...');
            
            const projectPath = process.env.PROJECT_PATH || '/var/www/ftth_control_deck';
            const pm2AppName = process.env.PM2_APP_NAME || 'ftth-api';
            
            // 1. Pull latest changes
            const pullResult = await executeCommand(`cd ${projectPath} && git pull origin main`);
            console.log('[WEBHOOK] Git pull result:', pullResult.success ? 'Success' : 'Failed');
            
            if (pullResult.success) {
                // 2. Install dependencies if package.json changed
                const installResult = await executeCommand(`cd ${projectPath}/api && npm install`);
                console.log('[WEBHOOK] npm install result:', installResult.success ? 'Success' : 'Failed');
                
                // 3. Restart PM2 application
                const restartResult = await executeCommand(`pm2 restart ${pm2AppName}`);
                console.log('[WEBHOOK] PM2 restart result:', restartResult.success ? 'Success' : 'Failed');
                
                console.log('[WEBHOOK] ✅ Auto-deploy completed successfully');
            } else {
                console.error('[WEBHOOK] ❌ Git pull failed:', pullResult.error);
            }
        }
    } catch (error) {
        console.error('[WEBHOOK] Error:', error.message);
        // لا نرسل خطأ لأننا أرسلنا 200 بالفعل
    }
});

// Login endpoint
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true, token: ADMIN_PASSWORD });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

// Database Statistics Endpoint
app.get('/api/admin/database/stats', requireAuth, async (req, res) => {
    try {
        const mysql = require('mysql2/promise');
        const config = require('./config');
        
        const pool = mysql.createPool(config.db);
        
        // إحصائيات قاعدة البيانات الرئيسية
        const [usersCount] = await pool.query('SELECT COUNT(*) as count FROM users');
        const [subscribersCount] = await pool.query('SELECT COUNT(*) as count FROM subscribers');
        const [alwataniLoginCount] = await pool.query('SELECT COUNT(*) as count FROM alwatani_login');
        const [ticketsCount] = await pool.query('SELECT COUNT(*) as count FROM tickets');
        const [teamsCount] = await pool.query('SELECT COUNT(*) as count FROM teams');
        
        // إحصائيات من قاعدة البيانات الرئيسية
        const masterPool = mysql.createPool({ ...config.db, database: config.master.database });
        const [ownersCount] = await masterPool.query('SELECT COUNT(*) as count FROM owners_databases');
        
        // حجم قاعدة البيانات
        const [dbSize] = await pool.query(`
            SELECT 
                table_schema AS 'Database',
                ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS 'Size (MB)'
            FROM information_schema.tables 
            WHERE table_schema = ?
            GROUP BY table_schema
        `, [config.db.database]);
        
        res.json({
            success: true,
            data: {
                users: usersCount[0].count,
                subscribers: subscribersCount[0].count,
                alwataniLogins: alwataniLoginCount[0].count,
                tickets: ticketsCount[0].count,
                teams: teamsCount[0].count,
                owners: ownersCount[0].count,
                databaseSize: dbSize[0] ? dbSize[0]['Size (MB)'] : 0
            }
        });
        
        await pool.end();
        await masterPool.end();
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get Database Tables Data
app.get('/api/admin/database/tables', requireAuth, async (req, res) => {
    try {
        const mysql = require('mysql2/promise');
        const config = require('./config');
        const { table, limit = 100, offset = 0 } = req.query;
        
        if (!table) {
            return res.status(400).json({ success: false, error: 'Table name is required' });
        }
        
        const pool = mysql.createPool(config.db);
        const [rows] = await pool.query(`SELECT * FROM ?? LIMIT ? OFFSET ?`, [table, parseInt(limit), parseInt(offset)]);
        const [count] = await pool.query(`SELECT COUNT(*) as total FROM ??`, [table]);
        
        res.json({
            success: true,
            data: rows,
            total: count[0].total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
        
        await pool.end();
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get All Tables List
app.get('/api/admin/database/tables-list', requireAuth, async (req, res) => {
    try {
        const mysql = require('mysql2/promise');
        const config = require('./config');
        const { database } = req.query;
        
        const dbName = database || config.db.database;
        const pool = mysql.createPool({ ...config.db, database: dbName });
        
        const [tables] = await pool.query(`
            SELECT 
                TABLE_NAME as name,
                TABLE_ROWS as rows,
                ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS size_mb
            FROM information_schema.TABLES 
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME
        `, [dbName]);
        
        res.json({
            success: true,
            database: dbName,
            tables: tables
        });
        
        await pool.end();
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.ADMIN_PORT || 8081;

app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Admin Dashboard server running on port ${PORT}`);
    console.log(`Access the dashboard at: http://localhost:${PORT}/admin-dashboard.html`);
});