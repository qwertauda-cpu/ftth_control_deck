const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

// Load .env file BEFORE requiring config
// Try multiple locations
const envPaths = [
    path.join(__dirname, '.env'),                    // api/.env
    path.join(__dirname, '..', '.env'),             // project root .env
    path.join(require('os').homedir(), '.env'),     // home directory .env
    '/var/www/ftth_control_deck/.env',              // server project root
    '/var/www/ftth_control_deck/api/.env'           // server api folder
];

let envLoaded = false;
for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
        require('dotenv').config({ path: envPath });
        console.log(`[SERVER] ✅ Loaded .env from: ${envPath}`);
        envLoaded = true;
        break;
    }
}

if (!envLoaded) {
    console.log(`[SERVER] ⚠️  No .env file found. Trying default location...`);
    require('dotenv').config();
}

// Debug environment variables
if (process.env.DB_PASSWORD) {
    console.log(`[SERVER] ✅ DB_PASSWORD is set (length: ${process.env.DB_PASSWORD.length})`);
} else {
    console.log(`[SERVER] ❌ DB_PASSWORD is NOT set!`);
}

const config = require('./config');
const cheerio = require('cheerio');
const https = require('https');
const querystring = require('querystring');
const zlib = require('zlib');
const dbManager = require('./db-manager');

/**
 * Helper: الحصول على owner username من alwatani_login id
 */
async function getOwnerUsernameFromAlwataniLoginId(alwataniLoginId) {
    try {
        // الحصول على جميع المالكين من قاعدة البيانات الرئيسية
        const masterPool = await dbManager.initMasterPool();
        const [owners] = await masterPool.query(
            'SELECT username, domain FROM owners_databases WHERE is_active = TRUE'
        );
        
        // البحث في كل قاعدة بيانات عن alwatani_login id
        for (const owner of owners) {
            try {
                const ownerPool = await dbManager.getOwnerPool(owner.domain);
                const [login] = await ownerPool.query(
                    'SELECT id FROM alwatani_login WHERE id = ?',
                    [alwataniLoginId]
                );
                
                if (login && login.length > 0) {
                    return owner.username;
                }
            } catch (error) {
                // تجاهل الأخطاء والبحث في قاعدة البيانات التالية
                continue;
            }
        }
        
        return null;
    } catch (error) {
        console.error('[getOwnerUsernameFromAlwataniLoginId] Error:', error.message);
        return null;
    }
}

const app = express();
const path = require('path');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CRITICAL: Block admin routes BEFORE static middleware
// This ensures they return 404 even if files exist
app.get('/admin-dashboard.html', (req, res) => {
    console.log('[BLOCK] Admin dashboard request blocked');
    res.status(404).json({ success: false, message: 'الصفحة غير موجودة' });
});

app.get('/admin-login.html', (req, res) => {
    console.log('[BLOCK] Admin login request blocked');
    res.status(404).json({ success: false, message: 'الصفحة غير موجودة' });
});

app.get('/admin/login', (req, res) => {
    console.log('[BLOCK] Admin login route blocked');
    res.status(404).json({ success: false, message: 'الصفحة غير موجودة' });
});

app.get('/admin/dashboard', (req, res) => {
    console.log('[BLOCK] Admin dashboard route blocked');
    res.status(404).json({ success: false, message: 'الصفحة غير موجودة' });
});

app.get('/admin', (req, res) => {
    console.log('[BLOCK] Admin root route blocked');
    res.status(404).json({ success: false, message: 'الصفحة غير موجودة' });
});

app.get('/admin-link.html', (req, res) => {
    console.log('[BLOCK] Admin link page blocked');
    res.status(404).json({ success: false, message: 'الصفحة غير موجودة' });
});

// Serve static files - but skip admin files
const staticMiddleware = express.static(path.join(__dirname), {
    index: false,
    extensions: ['html', 'htm']
});

app.use((req, res, next) => {
    // Skip static middleware for admin files
    if (req.path === '/admin-dashboard.html' || 
        req.path === '/admin-login.html' || 
        req.path === '/admin-link.html' ||
        req.path === '/admin' ||
        req.path === '/admin/login' ||
        req.path === '/admin/dashboard') {
        console.log(`[STATIC] Skipping static middleware for: ${req.path}`);
        return next(); // Let it fall through to 404 handler
    }
    // For other files, use static middleware
    staticMiddleware(req, res, next);
});

// Store sync progress for each user (in-memory)
const syncProgressStore = new Map(); // userId -> { stage, current, total, message, startedAt, updatedAt, phoneFound }

// Helper functions to update sync progress
function updateSyncProgress(userId, progress) {
    const existing = syncProgressStore.get(userId) || {};
    // Always update total and current when provided to avoid stale values
    syncProgressStore.set(userId, {
        ...existing,
        ...progress,
        // Ensure total and current are always updated if provided
        total: progress.total !== undefined ? progress.total : existing.total,
        current: progress.current !== undefined ? progress.current : existing.current,
        updatedAt: new Date().toISOString()
    });
}

function getSyncProgress(userId) {
    return syncProgressStore.get(userId) || null;
}

function clearSyncProgress(userId) {
    syncProgressStore.delete(userId);
}

function requestSyncCancellation(userId, message = 'تم طلب إيقاف المزامنة...') {
    if (!userId) return;
    const existing = syncProgressStore.get(userId) || {};
    syncProgressStore.set(userId, {
        ...existing,
        cancelRequested: true,
        stage: existing.stage || 'cancelling',
        message,
        updatedAt: new Date().toISOString()
    });
}

function clearSyncCancellation(userId) {
    if (!userId) return;
    const existing = syncProgressStore.get(userId);
    if (!existing) return;
    const { cancelRequested, ...rest } = existing;
    syncProgressStore.set(userId, {
        ...rest,
        cancelRequested: false,
        updatedAt: new Date().toISOString()
    });
}

function isSyncCancelled(userId) {
    if (!userId) return false;
    const progress = syncProgressStore.get(userId);
    return Boolean(progress?.cancelRequested);
}

// Initialize master database pool
async function initializePool() {
    try {
        // Initialize master database pool
        await dbManager.initMasterPool();
        console.log('✅ Master database pool initialized');
    } catch (error) {
        console.error('❌ Failed to initialize master database pool:', error.message);
        console.error('\n💡 Please ensure:');
        console.error('   1. XAMPP is running');
        console.error('   2. MySQL service is running');
        console.error('   3. Run: npm run init-master-db');
        process.exit(1);
    }
}

// Middleware to get owner pool from request
async function getOwnerPoolFromRequest(req) {
    try {
        // Try to get username from various sources
        const username = req.body?.username || req.query?.username || req.headers['x-username'];
        
        if (!username) {
            throw new Error('Username is required');
        }
        
        return await dbManager.getPoolFromUsername(username);
    } catch (error) {
        console.error('[getOwnerPoolFromRequest] Error:', error.message);
        throw error;
    }
}

/**
 * Helper: الحصول على username من request
 */
function getUsernameFromRequest(req) {
    return req.body?.username || req.query?.username || req.headers['x-username'] || req.body?.owner_username;
}

/**
 * Helper: الحصول على alwatani_login_id من request
 * يمكن أن يأتي من query parameter, body, أو headers
 */
function getAlwataniLoginIdFromRequest(req) {
    // من query parameter مباشرة (الأولوية الأولى)
    if (req.query?.alwatani_login_id) {
        const id = parseInt(req.query.alwatani_login_id, 10);
        if (!isNaN(id) && id > 0) {
            return id;
        }
    }
    
    if (req.query?.alwataniId) {
        const id = parseInt(req.query.alwataniId, 10);
        if (!isNaN(id) && id > 0) {
            return id;
        }
    }
    
    if (req.query?.userId) {
        const id = parseInt(req.query.userId, 10);
        if (!isNaN(id) && id > 0) {
            return id;
        }
    }
    
    // من body
    if (req.body?.alwatani_login_id) {
        const id = parseInt(req.body.alwatani_login_id, 10);
        if (!isNaN(id) && id > 0) {
            return id;
        }
    }
    
    if (req.body?.alwataniId) {
        const id = parseInt(req.body.alwataniId, 10);
        if (!isNaN(id) && id > 0) {
            return id;
        }
    }
    
    // من headers
    if (req.headers['x-alwatani-login-id']) {
        const id = parseInt(req.headers['x-alwatani-login-id'], 10);
        if (!isNaN(id) && id > 0) {
            return id;
        }
    }
    
    // من params.id فقط في حالات محددة (مثل /api/alwatani-login/:id/...)
    // تجنب استخدامه في endpoints أخرى مثل /api/teams/:id/members لأن id هنا هو معرف الفريق
    // نتحقق من المسار أولاً
    const path = req.path || (req.url ? req.url.split('?')[0] : '') || '';
    if (path && path.startsWith('/api/alwatani-login/')) {
        if (req.params?.id) {
            const id = parseInt(req.params.id, 10);
            if (!isNaN(id) && id > 0) {
                return id;
            }
        }
    }
    
    return null;
}

/**
 * Helper: الحصول على owner pool من request
 */
async function getOwnerPoolFromRequestHelper(req) {
    const username = getUsernameFromRequest(req);
    if (!username) {
        throw new Error('Username (owner_username) is required in query, body, or x-username header');
    }
    return await dbManager.getPoolFromUsername(username);
}

/**
 * Helper: الحصول على alwatani pool من request
 * يحصل على alwatani_login_id من الطلب، ثم يحصل على username من alwatani_login، ثم يعيد pool قاعدة البيانات
 */
async function getAlwataniPoolFromRequestHelper(req) {
    try {
        const ownerUsername = getUsernameFromRequest(req);
        if (!ownerUsername) {
            throw new Error('Username (owner_username) is required in query, body, or x-username header');
        }
        
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        if (!alwataniLoginId) {
            throw new Error('alwatani_login_id is required in query, body, params, or headers');
        }
        
        console.log('[GET ALWATANI POOL] Request:', { ownerUsername, alwataniLoginId });
        
        // الحصول على owner pool للحصول على username من alwatani_login
        const ownerPool = await dbManager.getPoolFromUsername(ownerUsername);
        console.log('[GET ALWATANI POOL] Querying alwatani_login table:', { ownerUsername, alwataniLoginId });
        
        const [alwataniAccount] = await ownerPool.query(
            'SELECT id, username, user_id FROM alwatani_login WHERE id = ?',
            [alwataniLoginId]
        );
        
        console.log('[GET ALWATANI POOL] Query result:', { 
            found: alwataniAccount?.length > 0, 
            account: alwataniAccount?.[0] || null 
        });
        
        if (!alwataniAccount || alwataniAccount.length === 0) {
            // محاولة البحث في جميع قواعد البيانات
            console.warn(`[GET ALWATANI POOL] Account ${alwataniLoginId} not found in ${ownerUsername}, searching in all databases...`);
            
            const masterPool = await dbManager.initMasterPool();
            const [allOwners] = await masterPool.query(
                'SELECT username, domain FROM owners_databases WHERE is_active = TRUE'
            );
            
            for (const owner of allOwners) {
                try {
                    const checkPool = await dbManager.getPoolFromUsername(owner.domain);
                    const [checkAccount] = await checkPool.query(
                        'SELECT id, username, user_id FROM alwatani_login WHERE id = ?',
                        [alwataniLoginId]
                    );
                    
                    if (checkAccount && checkAccount.length > 0) {
                        console.log(`[GET ALWATANI POOL] Found account ${alwataniLoginId} in ${owner.domain}`);
                        const alwataniUsername = checkAccount[0].username;
                        return await dbManager.getAlwataniPool(alwataniUsername);
                    }
                } catch (err) {
                    // تجاهل الأخطاء والبحث في القاعدة التالية
                    continue;
                }
            }
            
            throw new Error(`Alwatani login account with id ${alwataniLoginId} not found in any database`);
        }
        
        const alwataniUsername = alwataniAccount[0].username;
        console.log('[GET ALWATANI POOL] Found alwatani username:', alwataniUsername);
        
        // الحصول على pool لقاعدة بيانات الوطني
        const pool = await dbManager.getAlwataniPool(alwataniUsername);
        console.log('[GET ALWATANI POOL] Successfully got pool');
        return pool;
    } catch (error) {
        console.error('[GET ALWATANI POOL] Error:', error);
        console.error('[GET ALWATANI POOL] Error stack:', error.stack);
        throw error;
    }
}

// ================= Authentication Routes =================

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        console.log('[LOGIN] Request received:', {
            body: req.body,
            headers: req.headers['content-type']
        });
        
        const { username, password } = req.body;
        
        if (!username || !password) {
            console.log('[LOGIN] Missing credentials');
            return res.json({
                success: false,
                message: 'يرجى إدخال اسم المستخدم وكلمة المرور'
            });
        }
        
        // البحث عن المستخدم في جميع قواعد البيانات بشكل متوازي
        console.log('[LOGIN] Searching for user in all databases:', username);
        const masterPool = await dbManager.initMasterPool();
        const [owners] = await masterPool.query(
            'SELECT username, domain, database_name FROM owners_databases WHERE is_active = TRUE'
        );
        
        let foundUser = null;
        let foundOwnerUsername = null;
        let foundDomain = null;
        
        // البحث في جميع قواعد البيانات بشكل متوازي (أسرع بكثير)
        const searchPromises = owners.map(async (owner) => {
            try {
                const ownerPool = await dbManager.getOwnerPool(owner.domain);
                const [rows] = await ownerPool.query(
                    'SELECT id, username, role, agent_name, company_name, is_active, position FROM users WHERE username = ? AND password = ? LIMIT 1',
                    [username, password]
                );
                
                if (rows.length > 0) {
                    return {
                        user: rows[0],
                        ownerUsername: owner.username,
                        domain: owner.domain
                    };
                }
            } catch (error) {
                // تجاهل الأخطاء
                return null;
            }
            return null;
        });
        
        // انتظار جميع عمليات البحث مع التوقف عند العثور على المستخدم
        const results = await Promise.all(searchPromises);
        const foundResult = results.find(result => result !== null);
        
        if (foundResult) {
            foundUser = foundResult.user;
            foundOwnerUsername = foundResult.ownerUsername;
            foundDomain = foundResult.domain;
        }
        
        if (!foundUser) {
            console.log('[LOGIN] Invalid credentials for user:', username);
            return res.json({
                success: false,
                message: 'بيانات الدخول غير صحيحة'
            });
        }
        
        // التحقق من حالة الحساب (مفعّل/مجمّد)
        if (foundUser.is_active === 0 || foundUser.is_active === false) {
            console.log('[LOGIN] Account is deactivated for user:', username);
            return res.json({
                success: false,
                message: '❌ حسابك مجمّد. يرجى الاتصال بالمسؤول'
            });
        }
        
        // تحديث last_activity عند تسجيل الدخول
        try {
            const ownerPool = await dbManager.getOwnerPool(foundDomain);
            await ownerPool.query(
                'UPDATE users SET updated_at = NOW() WHERE id = ?',
                [foundUser.id]
            );
            console.log('[LOGIN] Updated last activity for user:', username);
        } catch (error) {
            console.warn('[LOGIN] Could not update last activity:', error.message);
        }
        
        console.log('[LOGIN] Login successful for user:', username, 'Owner:', foundOwnerUsername);
        res.json({
            success: true,
            user: {
                id: foundUser.id,
                username: foundUser.username,
                role: foundUser.role,
                agent_name: foundUser.agent_name,
                company_name: foundUser.company_name,
                owner_username: foundOwnerUsername // إضافة owner_username للاستخدام في frontend
            }
        });
    } catch (error) {
        console.error('[LOGIN] Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'خطأ في الخادم: ' + error.message 
        });
    }
});

// ================= Users Management Routes =================

// Get all users (requires username in query or body)
app.get('/api/users', async (req, res) => {
    try {
        const { username } = req.query || req.body;
        
        if (!username) {
            return res.status(400).json({ 
                error: 'اسم المستخدم مطلوب',
                message: 'يرجى إرسال اسم المستخدم في query أو body'
            });
        }
        
        // الحصول على قاعدة البيانات الخاصة بالمالك
        const ownerPool = await dbManager.getPoolFromUsername(username);
        
        const [rows] = await ownerPool.query(
            'SELECT id, username, password, role, created_at FROM users ORDER BY created_at DESC'
        );
        res.json(rows);
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'خطأ في جلب المستخدمين: ' + error.message });
    }
});

const ALWATANI_HOST = 'admin.ftth.iq';

// Create HTTPS agent with keep-alive for better connection stability
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000, // Send keep-alive packet every 30 seconds
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 60000,
    scheduling: 'fifo'
});

const STATIC_ALWATANI_COOKIES = (config.alwatani && typeof config.alwatani.cookies === 'string')
    ? config.alwatani.cookies.trim()
    : '';
const EXTRA_ALWATANI_HEADERS = (config.alwatani && typeof config.alwatani.extraHeaders === 'object' && config.alwatani.extraHeaders !== null)
    ? config.alwatani.extraHeaders
    : {};
const OVERRIDE_ALWATANI_HEADERS = (config.alwatani && typeof config.alwatani.overrideHeaders === 'object' && config.alwatani.overrideHeaders !== null)
    ? config.alwatani.overrideHeaders
    : null;
const ALWATANI_HEADERS_MODE = (config.alwatani && typeof config.alwatani.headersMode === 'string')
    ? config.alwatani.headersMode
    : 'merge';
const DEFAULT_ALWATANI_HEADERS = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Origin': 'https://admin.ftth.iq',
    'Referer': 'https://admin.ftth.iq/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    'x-client-app': '53d57a7f-3f89-4e9d-873b-3d071bc6dd9f',
    'x-user-role': '0',
    'X-Requested-With': 'XMLHttpRequest',
    'Connection': 'keep-alive',
    'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not A(Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin'
};

const ALWATANI_BASE_HEADERS = (() => {
    let base = { ...DEFAULT_ALWATANI_HEADERS };
    if (OVERRIDE_ALWATANI_HEADERS && Object.keys(OVERRIDE_ALWATANI_HEADERS).length > 0) {
        if (ALWATANI_HEADERS_MODE === 'replace') {
            base = { ...OVERRIDE_ALWATANI_HEADERS };
        } else {
            base = { ...base, ...OVERRIDE_ALWATANI_HEADERS };
        }
    }
    if (EXTRA_ALWATANI_HEADERS && Object.keys(EXTRA_ALWATANI_HEADERS).length > 0) {
        base = { ...base, ...EXTRA_ALWATANI_HEADERS };
    }
    return base;
})();

function getHeaderValueCaseInsensitive(headers, headerName) {
    if (!headers || !headerName) return undefined;
    const target = headerName.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === target) {
            return value;
        }
    }
    return undefined;
}

const DEFAULT_REFERER_HEADER = getHeaderValueCaseInsensitive(ALWATANI_BASE_HEADERS, 'Referer') || 'https://admin.ftth.iq/';

// إعدادات قابلة للتعديل ديناميكياً
let DETAIL_FETCH_CONCURRENCY = Math.max(1, parseInt(process.env.DETAIL_FETCH_CONCURRENCY || process.env.ALWATANI_DETAIL_CONCURRENCY || '3', 10));
let DETAIL_FETCH_BATCH_DELAY = Math.max(0, parseInt(process.env.DETAIL_FETCH_BATCH_DELAY_MS || process.env.ALWATANI_DETAIL_BATCH_DELAY || '1000', 10));
const DETAIL_FETCH_DELAY_MIN = Math.max(0, parseInt(process.env.DETAIL_FETCH_DELAY_MIN || '0', 10));
const DETAIL_FETCH_DELAY_MAX = Math.max(0, parseInt(process.env.DETAIL_FETCH_DELAY_MAX || '0', 10));
const DETAIL_FETCH_MAX_RETRIES = Math.max(1, parseInt(process.env.DETAIL_FETCH_MAX_RETRIES || '3', 10));
const DETAIL_FETCH_IMMEDIATE_SAVE = (process.env.DETAIL_FETCH_IMMEDIATE_SAVE || 'true').toLowerCase() !== 'false';
const PAGE_FETCH_BATCH_SIZE = Math.max(1, parseInt(process.env.PAGE_FETCH_BATCH_SIZE || process.env.ALWATANI_PAGE_BATCH_SIZE || '12', 10));
let PAGE_FETCH_BATCH_DELAY = Math.max(0, parseInt(process.env.PAGE_FETCH_BATCH_DELAY_MS || process.env.ALWATANI_PAGE_BATCH_DELAY || '0', 10));
const PAGE_FETCH_MAX_RETRIES = Math.max(1, parseInt(process.env.PAGE_FETCH_MAX_RETRIES || '4', 10));
const PAGE_FETCH_RATE_LIMIT_BACKOFF = Math.max(1000, parseInt(process.env.PAGE_FETCH_RATE_BACKOFF_MS || '15000', 10));

// Helper functions للحصول على القيم الحالية (للاستخدام في الكود)
function getDetailFetchConcurrency() { return DETAIL_FETCH_CONCURRENCY; }
function getDetailFetchBatchDelay() { return DETAIL_FETCH_BATCH_DELAY; }
function getPageFetchBatchDelay() { return PAGE_FETCH_BATCH_DELAY; }
const ADDRESS_BATCH_SIZE = Math.max(20, parseInt(process.env.ADDRESSES_BATCH_SIZE || '120', 10));
const ADDRESS_BATCH_DELAY = Math.max(0, parseInt(process.env.ADDRESSES_BATCH_DELAY_MS || '250', 10));
const RATE_LIMIT_HOST = (process.env.RATE_LIMIT_HOST || 'rate-limit.ftth.iq').toLowerCase();
const RATE_LIMIT_BACKOFF_MULTIPLIER = Math.max(1, parseFloat(process.env.RATE_LIMIT_BACKOFF_MULTIPLIER || '1.6'));
const EXPIRING_SOON_WINDOW_DAYS = Math.max(1, parseInt(process.env.EXPIRING_SOON_DAYS || '7', 10));
const ACTIVE_STATUS_KEYWORDS = [
    'active',
    'connected',
    'online',
    'working',
    'running',
    'قيد',
    'نشط',
    'فعال',
    'شغال',
    'connected'
];
const INACTIVE_STATUS_KEYWORDS = [
    'inactive',
    'disconnected',
    'suspended',
    'blocked',
    'stopped',
    'expired',
    'ended',
    'terminated',
    'inactive',
    'غير نشط',
    'غير متصل',
    'منتهي',
    'منتهية',
    'معلق',
    'off'
];

function buildAlwataniHeaders(overrides = {}, token, cookiesOverride = null) {
    const { Cookie: overrideCookie, cookie: overrideCookieLower, ...restOverrides } = overrides || {};
    const headers = {
        ...ALWATANI_BASE_HEADERS,
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...restOverrides
    };
    const cookieHeader = cookiesOverride || overrideCookie || overrideCookieLower || STATIC_ALWATANI_COOKIES;
    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    }
    return headers;
}

function resolveAlwataniReferer(path) {
    if (!path) {
        return DEFAULT_REFERER_HEADER;
    }

    if (path.startsWith('/api/customers/')) {
        const match = path.match(/\/api\/customers\/(\d+)/);
        if (match && match[1]) {
            return `https://admin.ftth.iq/customer-details/${match[1]}/details/view`;
        }
    }

    if (path.startsWith('/api/customers/subscriptions')) {
        const customerIdMatch = path.match(/customerId=([^&]+)/);
        if (customerIdMatch && customerIdMatch[1]) {
            return `https://admin.ftth.iq/customer-details/${customerIdMatch[1]}/details/view`;
        }
    }

    if (path.startsWith('/customer-details/')) {
        const detailMatch = path.match(/\/customer-details\/(\d+)/);
        if (detailMatch && detailMatch[1]) {
            return `https://admin.ftth.iq/customer-details/${detailMatch[1]}/details/view`;
        }
    }

    return DEFAULT_REFERER_HEADER;
}

function decodeAlwataniBuffer(buffer, encoding) {
    try {
        if (!encoding) return buffer;
        if (encoding.includes('br') && typeof zlib.brotliDecompressSync === 'function') {
            return zlib.brotliDecompressSync(buffer);
        }
        if (encoding.includes('gzip')) {
            return zlib.gunzipSync(buffer);
        }
        if (encoding.includes('deflate')) {
            return zlib.inflateSync(buffer);
        }
    } catch (error) {
        console.error(`[ALWATANI] Decompression error: ${error.message}`);
    }
    return buffer;
}

function parseAlwataniResponse(res) {
    return new Promise((resolve) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
            let rawData = Buffer.concat(chunks);
            rawData = decodeAlwataniBuffer(rawData, (res.headers['content-encoding'] || '').toLowerCase());
            const responseText = rawData.toString('utf8').trim();
            let json = null;
            let isHtml = false;
            
            // التحقق من نوع الاستجابة
            if (responseText.startsWith('<!DOCTYPE') || responseText.startsWith('<html')) {
                isHtml = true;
            }
            
            try {
                if (responseText && !isHtml) {
                    json = JSON.parse(responseText);
                }
            } catch (error) {
                // لا نطبع خطأ إذا كانت الاستجابة HTML (مقصد)
                if (!isHtml) {
                    // فقط للأخطاء غير المتوقعة
                    const errorPreview = responseText.substring(0, 100);
                    if (!errorPreview.includes('<!DOCTYPE') && !errorPreview.includes('<html')) {
                        console.error(`[ALWATANI] JSON parse error: ${error.message}`);
                    }
                }
            }
            
            resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                text: responseText,
                json,
                isHtml
            });
        });
    });
}

async function fetchAlwataniResource(path, token, method = 'GET', retryOn403 = false, username = null, password = null, context = 'unknown') {
    return new Promise(async (resolve) => {
        const makeRequest = async (currentToken) => {
            return new Promise((innerResolve) => {
                const refererHeader = resolveAlwataniReferer(path);
                const headers = buildAlwataniHeaders(refererHeader ? { Referer: refererHeader } : {}, currentToken);
                const options = {
                    hostname: ALWATANI_HOST,
                    path,
                    method,
                    agent: httpsAgent, // استخدام agent مع keep-alive
                    headers,
                    timeout: 20000 // زيادة timeout إلى 20 ثانية للسماح بوقت أكثر
                };

                const req = https.request(options, (res) => {
                    parseAlwataniResponse(res).then((parsed) => {
                        if (res.statusCode === 302) {
                            const redirectLocation = res.headers.location || null;
                            const redirectMessage = `HTTP 302 redirect${redirectLocation ? ` to ${redirectLocation}` : ''}`;
                            innerResolve({
                                success: false,
                                statusCode: 302,
                                redirect: true,
                                redirectLocation,
                                data: null,
                                raw: parsed.text,
                                message: redirectMessage,
                                context,
                                token: currentToken
                            });
                            return;
                        }

                        let success = res.statusCode >= 200 && res.statusCode < 300;
                        let errorMessage = null;
                        
                        // إذا كانت الاستجابة HTML، نتحقق من نوعها
                        // صفحة تفاصيل المشترك هي HTML عادي (status 200)
                        // صفحة الحظر/الخطأ هي HTML مع status 400/403/500
                        if (parsed.isHtml) {
                            // إذا كان status 200، هذه صفحة المشترك الفعلية (ليست حظر)
                            if (res.statusCode === 200) {
                                // هذه صفحة HTML عادية - نجح الطلب
                                // سنقوم بتحليلها لاحقاً في fetchAlwataniCustomerDetails
                                success = true;
                            } else {
                                // status غير 200 = صفحة خطأ أو حظر
                                errorMessage = `الموقع يعيد صفحة HTML بدلاً من البيانات (قد يكون هناك حظر أو خطأ)`;
                                if (res.statusCode >= 400) {
                                    console.warn(`[ALWATANI] ⚠️ HTML Error Response (Possible Block) [${context}]: HTTP ${res.statusCode}`);
                                }
                                innerResolve({ 
                                    success: false, 
                                    message: errorMessage,
                                    statusCode: res.statusCode,
                                    isHtml: true,
                                    raw: parsed.text
                                });
                                return;
                            }
                        }
                        
                        if (!success) {
                            errorMessage = 
                                parsed.json?.error_description || 
                                parsed.json?.error || 
                                parsed.json?.message || 
                                parsed.json?.title ||
                                `HTTP ${res.statusCode}: ${parsed.text?.substring(0, 200) || 'Unknown error'}`;
                            
                            // معالجة Rate Limiting (429) مع إعادة المحاولة التلقائية
                            if (res.statusCode === 429) {
                                console.warn(`[ALWATANI] ⚠️ Rate Limit (429) [${context}] - Too Many Requests - Waiting 10 seconds...`);
                                errorMessage = 'Rate limit exceeded. Please wait a moment.';
                                
                                // انتظار 10 ثوانٍ ثم إعادة المحاولة (مرة واحدة فقط)
                                if (retryOn403) {
                                    setTimeout(async () => {
                                        console.log(`[ALWATANI] Retrying after 10 seconds wait [${context}]...`);
                                        try {
                                            const retryResult = await makeRequest(currentToken);
                                            innerResolve(retryResult);
                                        } catch (err) {
                                            innerResolve({ success: false, message: errorMessage });
                                        }
                                    }, 10000);
                                    return;
                                }
                            } else {
                                console.error(`[ALWATANI] Request failed [${context}]: ${res.statusCode} - ${errorMessage}`);
                            }
                            
                            // إذا كان 403 وتم تفعيل retry، حاول إعادة التحقق من الحساب
                            if (res.statusCode === 403 && retryOn403 && username && password) {
                                console.log(`[ALWATANI] 403 Forbidden [${context}] - Attempting to re-verify account...`);
                                verifyAlwataniAccount(username, password).then(async (reVerification) => {
                                    if (reVerification.success && reVerification.data?.access_token) {
                                        console.log(`[ALWATANI] ✅ Got new token [${context}], retrying...`);
                                        // إعادة المحاولة مع token جديد
                                        const retryResult = await makeRequest(reVerification.data.access_token);
                                        innerResolve(retryResult);
                                    } else {
                                        innerResolve({
                                            success: false,
                                            statusCode: 403,
                                            data: parsed.json,
                                            raw: parsed.text,
                                            message: 'تم رفض الوصول (403). يرجى التحقق من بيانات الدخول.',
                                            context
                                        });
                                    }
                                }).catch((err) => {
                                    console.error(`[ALWATANI] Error during retry verification [${context}]:`, err);
                                    innerResolve({
                                        success: false,
                                        statusCode: 403,
                                        data: parsed.json,
                                        raw: parsed.text,
                                        message: 'تم رفض الوصول (403). فشل إعادة التحقق من الحساب.',
                                        context
                                    });
                                });
                                return;
                            }
                        }
                        
                        innerResolve({
                            success: success || (parsed.isHtml && res.statusCode === 200), // نجاح إذا كان HTML و status 200
                            statusCode: res.statusCode,
                            data: parsed.json,
                            raw: parsed.text,
                            message: errorMessage,
                            context,
                            token: currentToken, // إرجاع الـ token المستخدم
                            isHtml: parsed.isHtml // إرجاع isHtml للاستخدام لاحقاً
                        });
                    });
                });

                req.on('error', (error) => {
                    console.error('[ALWATANI] Request error:', error.message);
                    innerResolve({ 
                        success: false, 
                        statusCode: null,
                        message: 'خطأ في الاتصال: ' + error.message,
                        context,
                        retryable: error.code === 'ECONNRESET' || error.message?.includes('ECONNRESET')
                    });
                });

                req.on('timeout', () => {
                    console.error('[ALWATANI] Request timeout');
                    req.destroy();
                    innerResolve({ 
                        success: false, 
                        statusCode: null,
                        message: 'انتهت مهلة الاتصال بالموقع الخارجي',
                        context,
                        retryable: true
                    });
                });

                req.end();
            });
        };

        const maxRetries = 3;
        const initialRateLimitDelay = 10000; // 10 seconds
        const maxRateLimitRetries = 5;
        const initialNetworkRetryDelay = 5000;
        let rateLimitErrors = 0;
        let attempt = 0;
        let result = null;

        while (attempt <= maxRetries) {
            result = await makeRequest(token);

            if (result?.statusCode === 429 && rateLimitErrors < maxRateLimitRetries) {
                rateLimitErrors++;
                const waitTime = initialRateLimitDelay * rateLimitErrors;
                console.warn(`[ALWATANI] ⚠️ Rate limit (429) [${context}] retry ${rateLimitErrors}/${maxRateLimitRetries} after ${waitTime / 1000}s...`);
                await delay(waitTime);
                attempt++;
                continue;
            }

            if (result?.retryable && attempt < maxRetries) {
                const waitTime = initialNetworkRetryDelay * (attempt + 1);
                console.warn(`[ALWATANI] ⚠️ Network issue [${context}] (${result.message}). Retrying ${attempt + 1}/${maxRetries} after ${waitTime / 1000}s...`);
                await delay(waitTime);
                attempt++;
                continue;
            }

            break;
        }

        resolve(result);
    });
}

function normalizeAlwataniCollection(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.models)) return payload.models;
    return [];
}

function extractAlwataniAccountId(record) {
    if (!record) return null;
    return record.accountId ||
        record.AccountId ||
        record.customerAccountId ||
        record.customerId ||
        record?.self?.accountId ||
        record?.self?.id ||
        record.id ||
        null;
}

function buildAlwataniAddressMap(addressPayload) {
    const addresses = normalizeAlwataniCollection(addressPayload);
    const map = new Map();
    addresses.forEach((address) => {
        const accountId = address?.accountId ||
            address?.AccountId ||
            address?.customerAccountId ||
            address?.account?.id;
        if (accountId !== undefined && accountId !== null) {
            map.set(String(accountId), address);
        }
    });
    return map;
}

const EASTERN_DIGIT_MAP = {
    '٠': '0',
    '١': '1',
    '٢': '2',
    '٣': '3',
    '٤': '4',
    '٥': '5',
    '٦': '6',
    '٧': '7',
    '٨': '8',
    '٩': '9'
};

function convertEasternToWesternDigits(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/[٠-٩]/g, (digit) => EASTERN_DIGIT_MAP[digit] || digit);
}

function normalizeTextValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? convertEasternToWesternDigits(trimmed) : null;
}

function normalizePhoneValue(value) {
    const text = normalizeTextValue(value);
    if (!text) return null;
    const digits = convertEasternToWesternDigits(text).replace(/[^0-9+]/g, '');
    return digits || text;
}

function normalizeDateValue(value) {
    const text = normalizeTextValue(value);
    if (!text) return null;
    const isoPattern = /^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/;
    const dmyPattern = /^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{2,4})/;
    let normalized = text;
    
    if (isoPattern.test(text)) {
        const [, y, m, d] = text.match(isoPattern);
        normalized = `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    } else if (dmyPattern.test(text)) {
        const [, d, m, y] = text.match(dmyPattern);
        const fullYear = y.length === 2 ? `20${y}` : y.padStart(4, '0');
        normalized = `${fullYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    } else {
        const parsed = new Date(text);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString().split('T')[0];
        }
    }
    
    return normalized;
}

function parseNuxtStateFromHtml(html) {
    if (!html) return null;
    const patterns = [
        /window\.__NUXT__=\s*(\{[\s\S]*?\});/,
        /window\.__INITIAL_STATE__=\s*(\{[\s\S]*?\});/
    ];
    
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
            try {
                return JSON.parse(match[1]);
            } catch (error) {
                console.error('[ALWATANI] Failed to parse embedded state:', error.message);
            }
        }
    }
    return null;
}

function findFirstValueByKeys(payload, candidateKeys = []) {
    if (!payload || typeof payload !== 'object') return null;
    const targets = candidateKeys.map((key) => key.toLowerCase());
    const visited = new Set();
    const stack = [payload];
    
    while (stack.length) {
        const current = stack.pop();
        if (!current || typeof current !== 'object') continue;
        if (visited.has(current)) continue;
        visited.add(current);
        
        if (Array.isArray(current)) {
            current.forEach((item) => stack.push(item));
            continue;
        }
        
        for (const [key, value] of Object.entries(current)) {
            const keyName = key.toLowerCase();
            if (targets.some((candidate) => keyName.includes(candidate))) {
                if (value !== null && value !== undefined && value !== '') {
                    if (typeof value === 'string' || typeof value === 'number') {
                        return typeof value === 'string' ? value.trim() : String(value);
                    }
                }
            }
            if (typeof value === 'object') {
                stack.push(value);
            }
        }
    }
    
    return null;
}

function extractDomValueByLabels($, labels = []) {
    if (!$) return null;
    for (const label of labels) {
        const matches = $(`*:contains("${label}")`).filter((_, el) => {
            const text = $(el).clone().children().remove().end().text().replace(/[:：]/g, '').trim();
            return text === label || text.includes(label);
        });
        
        if (matches.length) {
            for (let i = 0; i < matches.length; i++) {
                const labelEl = matches.eq(i);
                
                // محاولات أكثر شمولية للعثور على القيمة
                const candidates = [
                    labelEl.next(), // العنصر التالي مباشرة
                    labelEl.next('td'), // TD التالي
                    labelEl.next('.value, .detail-value, .info-value, .field-value'), // العنصر التالي مع class محدد
                    labelEl.parent().find('.value, .detail-value, .info-value, .field-value').first(), // داخل الـ parent
                    labelEl.parent().next(), // العنصر التالي للـ parent
                    labelEl.parent().next('td'), // TD التالي للـ parent
                    labelEl.closest('tr').find('td').not(labelEl).first(), // داخل نفس الـ tr
                    labelEl.closest('tr').find('td').eq(1), // العمود الثاني في الـ tr
                    labelEl.closest('.flex, .grid, .row, .field').find('.value, .detail-value, .info-value, span, div').not(labelEl).first(), // داخل container
                    labelEl.siblings().not(labelEl).first(), // العناصر الشقيقة
                    labelEl.parent().siblings().first(), // العناصر الشقيقة للـ parent
                    $(labelEl).parent().find('*').not(labelEl).first() // أي عنصر آخر داخل الـ parent
                ];
                
                for (const candidate of candidates) {
                    if (!candidate || !candidate.length) continue;
                    const valueText = candidate.text().trim();
                    if (valueText && valueText !== label) {
                        return valueText;
                    }
                }
                
                // محاولة أخرى: البحث عن patterns في النص المجاور
                const parentText = labelEl.parent().text();
                const labelIndex = parentText.indexOf(label);
                if (labelIndex !== -1) {
                    const afterLabel = parentText.substring(labelIndex + label.length).trim();
                    const match = afterLabel.match(/[\d\s\+\-\(\)]+/); // pattern لرقم الهاتف
                    if (match && match[0].trim().length >= 7) {
                        return match[0].trim();
                    }
                }
            }
        }
    }
    return null;
}

function buildZoneStringFromAddress(address) {
    if (!address || typeof address !== 'object') {
        return null;
    }

    const parts = [];
    const governorate = address.governorate?.displayValue || address.governorate?.name || address.governorate;
    const district = address.district?.displayValue || address.district?.name || address.district;
    const city = address.city?.displayValue || address.city;

    if (governorate) parts.push(governorate);
    if (district) parts.push(district);
    if (city && !parts.includes(city)) parts.push(city);
    if (address.neighborhood) parts.push(`حي ${address.neighborhood}`);
    if (address.street) parts.push(`شارع ${address.street}`);
    if (address.house) parts.push(`دار ${address.house}`);
    if (address.nearestPoint) parts.push(`قرب ${address.nearestPoint}`);

    if (parts.length > 0) {
        return parts.join(' - ');
    }

    return address.displayValue || null;
}

function combineDetails(primary, secondary) {
    if (!primary && !secondary) return null;
    if (!primary) return { ...secondary };
    if (!secondary) return { ...primary };

    const merged = { ...primary };
    for (const [key, value] of Object.entries(secondary)) {
        if (value === null || value === undefined || value === '') {
            continue;
        }
        if (!merged[key] || merged[key] === '' || merged[key] === null) {
            merged[key] = value;
        }
    }
    return merged;
}

async function saveCustomerRecordImmediate(item, alwataniPool) {
    if (!item || !item.accountId || !item.record) {
        return;
    }

    if (!alwataniPool) {
        console.error(`[ENRICH] Missing alwataniPool for account ${item?.accountId} - skipping save`);
        return;
    }

    try {
        const payload = JSON.stringify(item.record);
        const partnerId = item.partnerId || null;

        await alwataniPool.query(
            `INSERT INTO alwatani_customers_cache (account_id, partner_id, customer_data, synced_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON DUPLICATE KEY UPDATE 
                customer_data = VALUES(customer_data),
                updated_at = CURRENT_TIMESTAMP`,
            [item.accountId, partnerId, payload]
        );
    } catch (error) {
        console.error(`[ENRICH] Error saving subscriber ${item?.accountId} immediately: ${error.message}`);
    }
}

function extractZoneLabel(record) {
    if (!record || typeof record !== 'object') {
        return null;
    }

    const candidates = [
        record.zone,
        record.zoneName,
        record.region,
        record.area,
        record?.rawAddress?.zone,
        record?.rawAddress?.zoneDisplayValue,
        record?.rawAddress?.displayValue
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }

    return null;
}

function parseDateValue(value) {
    if (!value) return null;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed;
    }
    return null;
}

function classifySubscriberStatus(record, nowMs = Date.now()) {
    const result = {
        status: 'active',
        expiringSoon: false
    };

    if (!record || typeof record !== 'object') {
        return result;
    }

    const statusValue = ((record.status ||
        record.subscriptionStatus ||
        record.state ||
        record.serviceStatus ||
        '') + '').trim().toLowerCase();

    if (statusValue) {
        if (ACTIVE_STATUS_KEYWORDS.some((keyword) => statusValue.includes(keyword))) {
            result.status = 'active';
        } else if (INACTIVE_STATUS_KEYWORDS.some((keyword) => statusValue.includes(keyword))) {
            result.status = 'inactive';
        }
    }

    const endDateValue = record.endDate ||
        record.end_date ||
        record.contractEnd ||
        record.expires ||
        record.expiration ||
        record.endsAt;

    const parsedEndDate = parseDateValue(endDateValue);
    if (parsedEndDate) {
        const diffDays = Math.ceil((parsedEndDate.getTime() - nowMs) / 86400000);
        if (diffDays < 0) {
            result.status = 'inactive';
        } else if (diffDays <= EXPIRING_SOON_WINDOW_DAYS) {
            result.expiringSoon = true;
        }
    }

    return result;
}

function computeCacheStats(rows) {
    const nowMs = Date.now();
    let total = 0;
    let active = 0;
    let inactive = 0;
    let expiringSoon = 0;
    const zones = new Set();
    let lastUpdated = null;

    for (const row of rows) {
        let record = row.customer_data;
        if (typeof record === 'string') {
            try {
                record = JSON.parse(record);
            } catch (error) {
                continue;
            }
        }

        if (!record || typeof record !== 'object') {
            continue;
        }

        total += 1;
        const classification = classifySubscriberStatus(record, nowMs);
        if (classification.status === 'inactive') {
            inactive += 1;
        } else {
            active += 1;
        }
        if (classification.expiringSoon) {
            expiringSoon += 1;
        }

        const zoneLabel = extractZoneLabel(record);
        if (zoneLabel) {
            zones.add(zoneLabel);
        }

        if (!lastUpdated || (row.updated_at && row.updated_at > lastUpdated)) {
            lastUpdated = row.updated_at;
        }
    }

    return {
        total,
        active,
        inactive,
        expiringSoon,
        zones: zones.size,
        lastSync: lastUpdated ? new Date(lastUpdated).toISOString() : null,
        source: 'cache'
    };
}

async function computeLegacySubscribersStats(ownerPool, alwataniLoginId) {
    try {
        if (!alwataniLoginId) {
            return {
                total: 0,
                active: 0,
                inactive: 0,
                expiringSoon: 0,
                zones: 0,
                source: 'legacy'
            };
        }
        
        const [totalResult] = await ownerPool.query('SELECT COUNT(*) as count FROM subscribers WHERE alwatani_login_id = ?', [alwataniLoginId]);
        const total = totalResult[0]?.count || 0;

        const [activeResult] = await ownerPool.query('SELECT COUNT(*) as count FROM subscribers WHERE alwatani_login_id = ? AND status = "active"', [alwataniLoginId]);
        const active = activeResult[0]?.count || 0;

        const [zonesResult] = await ownerPool.query('SELECT COUNT(DISTINCT zone) as count FROM subscribers WHERE alwatani_login_id = ?', [alwataniLoginId]);
        const zones = zonesResult[0]?.count || 0;

        const [expiringResult] = await ownerPool.query(
            'SELECT COUNT(*) as count FROM subscribers WHERE alwatani_login_id = ? AND end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)',
            [alwataniLoginId]
        );
        const expiringSoon = expiringResult[0]?.count || 0;

        return {
            total,
            active,
            inactive: Math.max(total - active, 0),
            expiringSoon,
            zones,
            source: 'legacy'
        };
    } catch (error) {
        console.error('[STATS] Legacy subscribers stats error:', error);
        return {
            total: 0,
            active: 0,
            inactive: 0,
            expiringSoon: 0,
            zones: 0,
            source: 'legacy',
            error: error.message
        };
    }
}

function isRateLimitRedirect(resp) {
    if (!resp || !resp.redirect) return false;
    if (resp.redirectLocation && typeof resp.redirectLocation === 'string') {
        return resp.redirectLocation.toLowerCase().includes(RATE_LIMIT_HOST);
    }
    if (resp.headers && typeof resp.headers.location === 'string') {
        return resp.headers.location.toLowerCase().includes(RATE_LIMIT_HOST);
    }
    return false;
}

async function fetchCustomersPageWithRetry(pageNumber, token, username, password, sortProperty, pageSize, applyToken, context = 'customers_page') {
    let attempt = 0;
    let backoff = PAGE_FETCH_RATE_LIMIT_BACKOFF;

    while (attempt < PAGE_FETCH_MAX_RETRIES) {
        if (attempt > 0) {
            console.log(`[SYNC] Retrying page ${pageNumber} (attempt ${attempt + 1}/${PAGE_FETCH_MAX_RETRIES})...`);
        }

        const customersPath = `/api/customers?pageSize=${pageSize}&pageNumber=${pageNumber}&sortCriteria.property=${sortProperty}&sortCriteria.direction=asc`;
        const resp = await fetchAlwataniResource(
            customersPath,
            token,
            'GET',
            true,
            username,
            password,
            `${context}_${pageNumber}`
        );
        applyToken(resp);

        if (resp.redirect && isRateLimitRedirect(resp)) {
            console.warn(`[SYNC] ⚠️ Rate limit redirect for page ${pageNumber}. Waiting ${(backoff / 1000).toFixed(1)}s before retry...`);
            await delay(backoff);
            backoff = Math.min(backoff * RATE_LIMIT_BACKOFF_MULTIPLIER, backoff * 4);
            attempt += 1;
            continue;
        }

        if (resp.success) {
            return resp;
        }

        if (resp.statusCode === 302 && resp.redirect) {
            console.warn(`[SYNC] ⚠️ HTTP 302 redirect for page ${pageNumber}: ${resp.redirectLocation || 'unknown'} - Waiting ${(backoff / 1000).toFixed(1)}s before retry...`);
            await delay(backoff);
            backoff = Math.min(backoff * RATE_LIMIT_BACKOFF_MULTIPLIER, backoff * 4);
            attempt += 1;
            continue;
        }

        // Non rate-limit failure - break
        return resp;
    }

    return {
        success: false,
        statusCode: 302,
        redirect: true,
        message: `Rate limit redirect exceeded for page ${pageNumber}`
    };
}

function evaluateDetailsCompleteness(details) {
    const essentialFields = ['phone'];
    const optionalFields = ['username', 'zone'];
    const missingEssential = essentialFields.filter((field) => !details || !details[field]);
    const missingOptional = optionalFields.filter((field) => !details || !details[field]);

    return {
        hasRequiredFields: missingEssential.length === 0,
        isComplete: missingEssential.length === 0 && missingOptional.length === 0,
        missingFields: [...missingEssential, ...missingOptional],
        missingEssential,
        missingOptional
    };
}

function parseCustomerDetailsHtml(html) {
    const details = {
        username: null,
        phone: null,
        zone: null,
        startDate: null,
        endDate: null,
        status: null
    };
    
    if (!html) {
        return details;
    }
    
    const nuxtState = parseNuxtStateFromHtml(html);
    if (nuxtState) {
        // فصل استخراج username عن deviceName
        details.username = details.username || findFirstValueByKeys(nuxtState, ['username', 'userName']);
        details.deviceName = details.deviceName || findFirstValueByKeys(nuxtState, ['deviceName', 'device']);
        details.phone = details.phone || findFirstValueByKeys(nuxtState, ['phoneNumber', 'customerPhone', 'contactPhone', 'mobile']);
        details.zone = details.zone || findFirstValueByKeys(nuxtState, ['zoneName', 'zone', 'region', 'area']);
        details.startDate = details.startDate || findFirstValueByKeys(nuxtState, ['startDate', 'contractStart', 'startsAt', 'activationDate']);
        details.endDate = details.endDate || findFirstValueByKeys(nuxtState, ['endDate', 'contractEnd', 'expires', 'endsAt', 'expiration']);
        details.status = details.status || findFirstValueByKeys(nuxtState, ['status', 'state', 'subscriptionStatus']);
    }
    
    const $ = cheerio.load(html);
    // استخراج اسم المستخدم واسم الجهاز بشكل منفصل
    if (!details.username) {
        details.username = extractDomValueByLabels($, ['اسم المستخدم', 'المستخدم']);
    }
    // استخراج اسم الجهاز بشكل منفصل
    if (!details.deviceName) {
        details.deviceName = extractDomValueByLabels($, ['اسم الجهاز', 'الجهاز']);
    }
    
    // محاولات متعددة لاستخراج رقم الهاتف
    details.phone = details.phone || extractDomValueByLabels($, [
        'رقم الهاتف', 
        'رقم هاتف المشترك', 
        'الهاتف',
        'هاتف',
        'جوال',
        'رقم الجوال',
        'رقم الاتصال',
        'تلفون',
        'Phone',
        'phone',
        'mobile',
        'Mobile',
        'Tel'
    ]);
    
    // محاولة إضافية: البحث عن أرقام في HTML تشبه أرقام الهواتف العراقية
    if (!details.phone) {
        // أنماط مختلفة لأرقام الهواتف العراقية
        const phonePatterns = [
            /(\+?964|0)?7[0-9]{9}/g, // 07XXXXXXXXX (10 أرقام)
            /(\+?964|0)?7[0-9]{8}/g, // 07XXXXXXXX (9 أرقام)
            /(\+?964|0)?7[0-9]{10}/g, // 07XXXXXXXXXX (11 رقم)
            /0?7[0-9]{2}[\s\-]?[0-9]{3}[\s\-]?[0-9]{4}/g, // 07XX XXX XXXX مع مسافات
            /(\+?964|0)?7[0-9]{2}[0-9]{7}/g // 07XX-XXXXXXX
        ];
        
        const allText = $.text();
        
        for (const pattern of phonePatterns) {
            const phoneMatches = allText.match(pattern);
            if (phoneMatches && phoneMatches.length > 0) {
                // تنظيف الرقم: إزالة المسافات والأرقام الزائدة
                let cleanedPhone = phoneMatches[0].trim();
                cleanedPhone = cleanedPhone.replace(/[\s\-\(\)]/g, ''); // إزالة المسافات والشرطات والأقواس
                cleanedPhone = cleanedPhone.replace(/^\+?964/, '0'); // تحويل 964 إلى 0
                cleanedPhone = cleanedPhone.replace(/^0+/, '0'); // إزالة الأصفار الزائدة
                
                // التحقق من أن الرقم يبدأ بـ 07 وله طول معقول (10-11 رقم)
                if (cleanedPhone.startsWith('07') && cleanedPhone.length >= 10 && cleanedPhone.length <= 11) {
                    details.phone = cleanedPhone;
                    break;
                }
            }
        }
    }
    
    // محاولة أخرى: البحث في input fields و data attributes
    if (!details.phone) {
        const phoneInputs = $('input[type="tel"], input[name*="phone"], input[id*="phone"], input[placeholder*="هاتف"], input[placeholder*="جوال"]');
        if (phoneInputs.length > 0) {
            details.phone = phoneInputs.first().val() || phoneInputs.first().attr('value');
        }
    }
    
    // محاولة أخرى: البحث في data attributes
    if (!details.phone) {
        const phoneData = $('[data-phone], [data-phone-number], [data-mobile], [data-tel]').first().attr('data-phone') || 
                         $('[data-phone], [data-phone-number], [data-mobile], [data-tel]').first().attr('data-phone-number') ||
                         $('[data-phone], [data-phone-number], [data-mobile], [data-tel]').first().attr('data-mobile') ||
                         $('[data-phone], [data-phone-number], [data-mobile], [data-tel]').first().attr('data-tel');
        if (phoneData) {
            details.phone = phoneData;
        }
    }
    
    // محاولة أخيرة محسّنة: البحث في جميع النصوص عن أرقام تبدو كأرقام هاتف
    if (!details.phone) {
        // الحصول على جميع النصوص من الصفحة
        const allText = $.text();
        
        // أنماط محسّنة لأرقام الهواتف العراقية
        const phonePatterns = [
            /(?:^|[^\d])(0?7[0-9]{9})(?:[^\d]|$)/g,  // 07XXXXXXXXX (10 أرقام)
            /(?:^|[^\d])(0?7[0-9]{10})(?:[^\d]|$)/g, // 07XXXXXXXXXX (11 رقم)
            /(?:^|[^\d])(\+?9647[0-9]{9})(?:[^\d]|$)/g, // +9647XXXXXXXXX
            /(?:^|[^\d])(7[0-9]{2}[\s\-]?[0-9]{3}[\s\-]?[0-9]{4})(?:[^\d]|$)/g, // 7XX XXX XXXX
            /(?:^|[^\d])(0?7\d{2}[\s\-]?\d{3}[\s\-]?\d{4})(?:[^\d]|$)/g // 07XX-XXX-XXXX مع فواصل
        ];
        
        for (const pattern of phonePatterns) {
            const matches = allText.match(pattern);
            if (matches && matches.length > 0) {
                for (const match of matches) {
                    let phone = match.trim().replace(/[\s\-\(\)\.]/g, '');
                    
                    // تنظيف الرقم
                    phone = phone.replace(/^\+?964/, '0'); // تحويل 964 إلى 0
                    if (!phone.startsWith('0')) phone = '0' + phone;
                    
                    // التحقق من أن الرقم يبدأ بـ 07 وله طول معقول
                    if (phone.startsWith('07') && phone.length >= 10 && phone.length <= 11) {
                        details.phone = phone;
                        break;
                    }
                }
                if (details.phone) break;
            }
        }
    }
    
    // تطبيع رقم الهاتف إذا تم العثور عليه
    if (details.phone) {
        details.phone = normalizePhoneValue(details.phone);
    }
    
    details.zone = details.zone || extractDomValueByLabels($, ['المنطقة', 'المنطقة الجغرافية']);
    details.startDate = details.startDate || extractDomValueByLabels($, ['تاريخ بدء الاشتراك', 'تاريخ التفعيل', 'تاريخ البدء']);
    details.endDate = details.endDate || extractDomValueByLabels($, ['تاريخ انتهاء الاشتراك', 'تاريخ الانتهاء']);
    details.status = details.status || extractDomValueByLabels($, ['الحالة', 'حالة الخدمة']);
    
    const badgeStatus = $('.status-badge, .status, .badge, .subscription-status').first().text().trim();
    if (badgeStatus && !details.status) {
        details.status = badgeStatus;
    }
    
    details.username = normalizeTextValue(details.username);
    details.phone = normalizePhoneValue(details.phone);
    details.zone = normalizeTextValue(details.zone);
    details.startDate = normalizeDateValue(details.startDate);
    details.endDate = normalizeDateValue(details.endDate);
    details.status = normalizeTextValue(details.status);
    
    return details;
}

function mergeCustomerDetails(record, details) {
    if (!record || !details) return;
    // تحديث username بشكل منفصل
    if (details.username) {
        record.username = details.username;
    }
    // تحديث deviceName بشكل منفصل - لا نستخدم deviceName كـ username
    if (details.deviceName) {
        record.deviceName = details.deviceName;
    }
    if (details.phone) record.phone = details.phone;
    if (details.zone) record.zone = details.zone;
    if (details.status) record.status = details.status;
    if (details.startDate) {
        record.startDate = details.startDate;
        record.start_date = details.startDate;
    }
    if (details.endDate) {
        record.endDate = details.endDate;
        record.end_date = details.endDate;
    }
    if (record.accountId) {
        record.page_url = `https://admin.ftth.iq/customer-details/${record.accountId}/details/view`;
    }
    record.details_fetched_at = new Date().toISOString();
}

async function fetchAlwataniCustomerDetails(accountId, tokenRef, username, password) {
    if (!accountId) {
        return { success: false, message: 'Invalid accountId' };
    }

    const apiResult = await fetchCustomerDetailsViaApi(accountId, tokenRef, username, password);
    const apiData = apiResult.data ? { ...apiResult.data } : null;

    if (apiResult.success && apiResult.data && apiResult.hasRequiredFields) {
        if (parseInt(accountId) % 50 === 0 || parseInt(accountId) <= 10) {
            console.log(`[DETAILS] ✅ API data for ${accountId}: phone=${apiResult.data.phone || 'no'}, username=${apiResult.data.username || 'no'}, zone=${apiResult.data.zone || 'no'}`);
        }
        return apiResult;
    }

    if (apiResult.redirect || apiResult.statusCode === 302) {
        console.warn(`[DETAILS] ⚠️ API redirect for ${accountId}. Falling back to HTML scraping...`);
    } else if (apiResult.success && !apiResult.hasRequiredFields) {
        console.warn(`[DETAILS] ⚠️ API data incomplete for ${accountId}. Missing: ${apiResult.missingFields?.join(', ') || 'unknown'} - Falling back to HTML...`);
    } else if (apiResult.message) {
        console.warn(`[DETAILS] ⚠️ API details fetch failed for ${accountId}: ${apiResult.message}`);
    }

    const htmlResult = await fetchCustomerDetailsViaHtml(accountId, tokenRef, username, password);

    if (htmlResult.success && htmlResult.data) {
        const mergedData = combineDetails(htmlResult.data, apiData);
        const completeness = evaluateDetailsCompleteness(mergedData);
        const finalResult = {
            ...htmlResult,
            data: mergedData,
            source: htmlResult.source || 'html',
            ...completeness,
            fallbackUsed: true
        };

        if (!completeness.hasRequiredFields) {
            finalResult.success = false;
            finalResult.message = htmlResult.message || 'HTML response missing essential fields';
        } else {
            finalResult.success = true;
        }

        if (parseInt(accountId) % 50 === 0 || parseInt(accountId) <= 10) {
            console.log(`[DETAILS] ✅ Fallback HTML data for ${accountId}: phone=${mergedData.phone || 'no'}, username=${mergedData.username || 'no'}, zone=${mergedData.zone || 'no'}`);
        }

        return finalResult;
    }

    if (apiResult.success && apiData) {
        const completeness = evaluateDetailsCompleteness(apiData);
        return {
            ...apiResult,
            success: completeness.hasRequiredFields,
            data: apiData,
            ...completeness,
            message: htmlResult.message || apiResult.message || 'HTML fallback failed; returning partial API data',
            fallbackUsed: true
        };
    }

    return htmlResult;
}

async function fetchCustomerDetailsViaApi(accountId, tokenRef, username, password) {
    const customerResp = await fetchAlwataniResource(
        `/api/customers/${accountId}`,
        tokenRef.value,
        'GET',
        true,
        username,
        password,
        `customer_api_${accountId}`
    );

    if (customerResp?.token && customerResp.token !== tokenRef.value) {
        tokenRef.value = customerResp.token;
    }

    if (customerResp.statusCode === 302 || customerResp.redirect) {
        return {
            success: false,
            statusCode: 302,
            redirect: true,
            message: customerResp.message
        };
    }

    if (!customerResp.success || !customerResp.data) {
        return {
            success: false,
            statusCode: customerResp.statusCode,
            message: customerResp.message || `Failed to fetch customer (HTTP ${customerResp.statusCode || 'unknown'})`
        };
    }

    let customerData = customerResp.data;
    if (customerData && typeof customerData === 'object') {
        customerData = customerData.data || customerData.model || customerData;
    }
    if (Array.isArray(customerData)) {
        customerData = customerData[0];
    }

    if (!customerData || typeof customerData !== 'object') {
        return {
            success: false,
            message: 'Customer payload is empty'
        };
    }

    const primaryContact = customerData.primaryContact || {};
    const addresses = Array.isArray(customerData.addresses) ? customerData.addresses : [];
    const primaryAddress = addresses.find((addr) => addr && (addr.displayValue || addr.governorate || addr.district || addr.city)) || addresses[0];
    const addressZone = buildZoneStringFromAddress(primaryAddress);

    const details = {
        username: customerData.username || customerData.displayName || customerData.self?.displayValue || primaryContact.self?.displayValue || primaryContact.displayValue || null,
        deviceName: customerData.deviceName || customerData.device || null,
        phone: customerData.phone || customerData.phoneNumber || customerData.mobile || customerData.contactPhone || primaryContact.mobile || primaryContact.secondaryPhone || primaryContact.phone || null,
        zone: customerData.zone || customerData.zoneName || customerData.region || customerData.area || addressZone || null,
        startDate: customerData.startDate || customerData.contractStart || customerData.startsAt || customerData.activationDate || null,
        endDate: customerData.endDate || customerData.contractEnd || customerData.expires || customerData.endsAt || customerData.expiration || null,
        status: customerData.status || customerData.state || customerData.subscriptionStatus || null,
        page_url: `https://admin.ftth.iq/customer-details/${accountId}/details/view`
    };
    let subscriptionDeviceName = null;

    try {
        const subscriptionsResp = await fetchAlwataniResource(
            `/api/customers/subscriptions?customerId=${accountId}`,
            tokenRef.value,
            'GET',
            true,
            username,
            password,
            `subscriptions_api_${accountId}`
        );

        if (subscriptionsResp?.token && subscriptionsResp.token !== tokenRef.value) {
            tokenRef.value = subscriptionsResp.token;
        }

        if (subscriptionsResp.success && subscriptionsResp.data) {
            const subsPayload = subscriptionsResp.data?.data || subscriptionsResp.data?.models || subscriptionsResp.data?.items || subscriptionsResp.data;
            const subscriptions = Array.isArray(subsPayload) ? subsPayload : [];

            if (subscriptions.length > 0) {
                const sub = subscriptions[0];
                const candidateDeviceName = sub.deviceDetails?.username ||
                    sub.deviceDetails?.deviceName ||
                    sub.deviceDetails?.serial ||
                    sub.username ||
                    sub.deviceName ||
                    sub.device ||
                    sub.serviceName ||
                    sub.service ||
                    null;
                if (candidateDeviceName) {
                    subscriptionDeviceName = candidateDeviceName;
                }
                // لا نستخدم candidateDeviceName كـ username إلا إذا لم يكن username موجوداً وكان مناسباً
                // candidateDeviceName هو للجهاز فقط
                details.phone = details.phone || sub.phone || sub.phoneNumber || sub.mobile;
                details.zone = details.zone || sub.zone || sub.zoneName || sub.region;
                details.startDate = details.startDate || sub.startDate || sub.contractStart || sub.startsAt;
                details.endDate = details.endDate || sub.endDate || sub.contractEnd || sub.expires || sub.endsAt;
                details.status = details.status || sub.status || sub.state || sub.subscriptionStatus;
            }
        } else if (subscriptionsResp.statusCode === 302 || subscriptionsResp.redirect) {
            return {
                success: false,
                statusCode: 302,
                redirect: true,
                message: subscriptionsResp.message || 'Subscriptions API redirected'
            };
        }
    } catch (error) {
        if (parseInt(accountId) <= 5) {
            console.warn(`[DETAILS] Could not fetch subscriptions for ${accountId}: ${error.message}`);
        }
    }

    if (subscriptionDeviceName) {
        details.deviceName = subscriptionDeviceName;
        // لا نستخدم deviceName كـ username إلا إذا لم يكن username موجوداً
        if (!details.username) {
            details.username = subscriptionDeviceName;
        }
    }

    details.username = normalizeTextValue(details.username);
    // لا نستخدم username كبديل لـ deviceName - إذا لم يكن deviceName موجوداً، نتركه null
    details.deviceName = normalizeTextValue(details.deviceName);
    details.phone = normalizePhoneValue(details.phone);
    details.zone = normalizeTextValue(details.zone);
    details.startDate = normalizeDateValue(details.startDate);
    details.endDate = normalizeDateValue(details.endDate);
    details.status = normalizeTextValue(details.status);

    const completeness = evaluateDetailsCompleteness(details);
    const result = {
        success: true,
        data: details,
        source: 'api',
        ...completeness
    };

    if (!completeness.hasRequiredFields) {
        result.message = 'API response missing essential fields';
    } else if (!completeness.isComplete) {
        result.message = `API response missing fields: ${completeness.missingFields.join(', ')}`;
    }

    return result;
}

async function fetchCustomerDetailsViaHtml(accountId, tokenRef, username, password) {
    const resp = await fetchAlwataniResource(
        `/customer-details/${accountId}/details/view`,
        tokenRef.value,
        'GET',
        true,
        username,
        password,
        `customer_details_${accountId}`
    );

    if (resp?.token && resp.token !== tokenRef.value) {
        tokenRef.value = resp.token;
    }

    const htmlContent = resp.raw || resp.text || '';
    const statusCode = resp.statusCode || 0;

    if (!(statusCode === 200 && htmlContent && typeof htmlContent === 'string' && htmlContent.length > 100)) {
        const errorMsg = resp.message || `Failed to fetch (HTTP ${statusCode})`;
        if (parseInt(accountId) % 50 === 0 || parseInt(accountId) <= 5) {
            console.warn(`[DETAILS] ⚠️ Failed for ${accountId}: ${errorMsg}, statusCode: ${statusCode}, success: ${resp.success}, htmlLength: ${htmlContent?.length || 0}`);
        }
        return {
            success: false,
            message: errorMsg,
            statusCode,
            isHtml: resp.isHtml
        };
    }

    if (parseInt(accountId) <= 1) {
        console.log(`\n[DETAILS] 🔍 ========== Analyzing HTML for subscriber ${accountId} ==========`);
        console.log(`[DETAILS] HTML length: ${htmlContent.length} chars`);
        console.log(`[DETAILS] HTML first 800 chars:\n${htmlContent.substring(0, 800)}`);
        console.log(`[DETAILS] HTML last 300 chars:\n${htmlContent.substring(Math.max(0, htmlContent.length - 300))}`);
        console.log(`[DETAILS] Contains '__NUXT__': ${htmlContent.includes('__NUXT__')}`);
        console.log(`[DETAILS] Contains '__INITIAL_STATE__': ${htmlContent.includes('__INITIAL_STATE__')}`);
        console.log(`[DETAILS] Contains 'customer': ${htmlContent.toLowerCase().includes('customer')}`);
        console.log(`[DETAILS] Contains 'هاتف': ${htmlContent.includes('هاتف')}`);
        console.log(`[DETAILS] Contains 'phone': ${htmlContent.toLowerCase().includes('phone')}`);
        console.log(`[DETAILS] Contains '<title>': ${htmlContent.includes('<title>')}`);
        const titleMatch = htmlContent.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) {
            console.log(`[DETAILS] Page title: "${titleMatch[1]}"`);
        }
        if (htmlContent.includes('redirect') || /loading/i.test(htmlContent)) {
            console.log(`[DETAILS] ⚠️ Possible redirect or loading page detected!`);
        }
        console.log(`[DETAILS] ============================================================\n`);
    }

    const details = parseCustomerDetailsHtml(htmlContent);

    if (details.phone || details.username || details.zone) {
        if (parseInt(accountId) % 50 === 0 || parseInt(accountId) <= 10) {
            console.log(`[DETAILS] ✅ Data extracted for ${accountId}: phone=${details.phone || 'no'}, username=${details.username || 'no'}, zone=${details.zone || 'no'}`);
        }
    } else {
        if (parseInt(accountId) <= 3) {
            console.warn(`[DETAILS] ⚠️ No data extracted for ${accountId} - HTML length: ${htmlContent.length} chars`);
        } else if (parseInt(accountId) % 100 === 0) {
            console.warn(`[DETAILS] ⚠️ No data extracted for ${accountId} - HTML length: ${htmlContent.length} chars`);
        }
    }

    const completeness = evaluateDetailsCompleteness(details);
    return { 
        success: completeness.hasRequiredFields, 
        data: details, 
        isHtml: resp.isHtml, 
        source: 'html',
        ...completeness
    };
}

// دالة مساعدة لإضافة تأخير عشوائي (محاكاة سلوك المستخدم الطبيعي)
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return delay(ms);
}

async function enrichCustomersWithDetails(records, tokenRef, username, password, userId = null, alwataniPool = null) {
    if (!Array.isArray(records) || !records.length) {
        console.log('[ENRICH] No records to fetch details for');
        return { processed: 0, successCount: 0, phoneFoundCount: 0, cancelled: false };
    }
    
    console.log(`[ENRICH] Starting to fetch details from subscriber pages for ${records.length} subscribers...`);
    
    // Initialize progress tracking
    if (userId) {
        updateSyncProgress(userId, {
            stage: 'enriching',
            current: 0,
            total: records.length,
            message: `جاري جلب تفاصيل ${records.length} مشترك...`,
            startedAt: new Date().toISOString(),
            phoneFound: 0
        });
    }
    
    // جلب مشتركين بعدد قابل للتعديل عبر ENV (تفاصيل أسرع بدون حظر)
    // قراءة القيم ديناميكياً في كل مرة
    const concurrency = getDetailFetchConcurrency();
    let delayBetweenBatches = getDetailFetchBatchDelay();
    let delayMin = DETAIL_FETCH_DELAY_MIN;
    let delayMax = DETAIL_FETCH_DELAY_MAX;
    console.log(`[ENRICH] Starting detail fetching: ${concurrency} subscribers every ${(Math.max(delayBetweenBatches, 1) / 1000).toFixed(2)} seconds`);
    
    let processed = 0;
    let successCount = 0;
    let phoneFoundCount = 0;
    let rateLimitErrors = 0;
    let consecutiveErrors = 0;
    let totalErrors = 0;
    const maxConsecutiveErrors = 3; // تقليل العدد للاستجابة السريعة للحظر
    const errorRateThreshold = 0.3; // إذا كان معدل الخطأ > 30%، نزيد التأخير
    
    let cancelled = false;
    
    for (let i = 0; i < records.length; i += concurrency) {
        if (userId && isSyncCancelled(userId)) {
            cancelled = true;
            console.warn('[ENRICH] ⏹️ Cancellation requested - stopping detail fetching loop.');
            break;
        }
        
        // حساب معدل الخطأ
        const errorRate = processed > 0 ? totalErrors / processed : 0;
        
        // إذا كان معدل الخطأ عالي جداً أو أخطاء متتالية كثيرة، نزيد التأخير
        if (consecutiveErrors >= maxConsecutiveErrors || (errorRate > errorRateThreshold && processed > 10)) {
            const waitTime = errorRate > errorRateThreshold ? 15000 : 10000; // 15s إذا كان المعدل عالي، 10s للأخطاء المتتالية
            console.log(`[ENRICH] ⚠️ High error rate detected! Error rate: ${(errorRate * 100).toFixed(1)}%, consecutive errors: ${consecutiveErrors} - Waiting ${waitTime/1000} seconds before continuing...`);
            await delay(waitTime);
            consecutiveErrors = Math.floor(consecutiveErrors / 2); // تقليل العدد بعد الانتظار
            // زيادة التأخير مؤقتاً
            delayMin = Math.min(delayMin * 1.5, 5000);
            delayMax = Math.min(delayMax * 1.5, 8000);
            delayBetweenBatches = Math.min(delayBetweenBatches * 1.5, 5000);
        }
        
        const batch = records.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(async (item, index) => {
            try {
                if (!item.accountId) {
                    console.warn(`[ENRICH] Skipping subscriber without accountId`);
                    return { success: false };
                }
                
                // لا تأخير بين الطلبات في نفس الـ batch (جميعهم متوازيين)
                // فقط تأخير بين الـ batches
                
                // Retry mechanism مع exponential backoff
                let detailResp = null;
                let retries = 0;
                const maxRetries = DETAIL_FETCH_MAX_RETRIES;
                let lastError = null;
                
                while (retries <= maxRetries) {
                    if (userId && isSyncCancelled(userId)) {
                        cancelled = true;
                        break;
                    }
                    
                    try {
                        detailResp = await fetchAlwataniCustomerDetails(item.accountId, tokenRef, username, password);
                        
                        // إذا نجح الطلب أو لم يكن حظر، نتوقف
                        if (detailResp.success && detailResp.data) {
                            break;
                        }
                        
                        // إذا كان حظر (HTML response)، ننتظر ونعيد المحاولة
                        if (detailResp.isHtml && retries < maxRetries) {
                            const backoffDelay = Math.min(30000 * Math.pow(2, retries), 120000); // 30s, 60s, 120s
                            console.warn(`[ENRICH] ⚠️ Blocked for ${item.accountId}, retry ${retries + 1}/${maxRetries} after ${backoffDelay/1000}s...`);
                            await delay(backoffDelay);
                            retries++;
                            lastError = detailResp;
                            continue;
                        }
                        
                        // إذا لم يكن حظر أو انتهت المحاولات، نتوقف
                        break;
                    } catch (error) {
                        lastError = { success: false, message: error.message };
                        if (retries < maxRetries) {
                            const backoffDelay = Math.min(30000 * Math.pow(2, retries), 120000);
                            console.warn(`[ENRICH] ⚠️ Exception for ${item.accountId}, retry ${retries + 1}/${maxRetries} after ${backoffDelay/1000}s...`);
                            await delay(backoffDelay);
                            retries++;
                        } else {
                            break;
                        }
                    }
                }
                
                if (cancelled) {
                    return { success: false, cancelled: true };
                }
                
                // إذا فشلت جميع المحاولات، نستخدم آخر استجابة
                if (!detailResp) {
                    detailResp = lastError || { success: false, message: 'All retries failed' };
                }
                
                // معالجة Rate Limiting (429 Too Many Requests)
                if (detailResp.statusCode === 429 || detailResp.message?.includes('Too Many Requests')) {
                    rateLimitErrors++;
                    console.warn(`[ENRICH] ⚠️ Rate limit for subscriber ${item.accountId} - Increasing delay`);
                    return { success: false, rateLimited: true };
                }
                
                    if (detailResp.success && detailResp.data) {
                    const beforePhone = item.record.phone;
                    mergeCustomerDetails(item.record, detailResp.data);
                    
                    if (detailResp.data.phone && detailResp.data.phone !== beforePhone) {
                        phoneFoundCount++;
                    }
                        
                        if (DETAIL_FETCH_IMMEDIATE_SAVE) {
                            // Note: saveCustomerRecordImmediate requires ownerPool, will be called from sync endpoint
                        }
                        
                    // تقليل عداد الأخطاء المتتالية عند النجاح (لا نعيده إلى 0 مباشرة)
                    return { success: true };
                } else {
                    totalErrors++;
                    const reason = detailResp.isHtml ? 'Blocked/HTML response' : (detailResp.message || 'Unknown reason');
                    
                    // Log errors more frequently for debugging
                    if (parseInt(item.accountId || '0') % 25 === 0 || totalErrors <= 10) {
                        console.warn(`[ENRICH] Failed to fetch details for account ${item.accountId}: ${reason}`);
                    }
                    
                    return { success: false, reason };
                }
            } catch (error) {
                totalErrors++;
                // Log errors more frequently for debugging
                if (parseInt(item.accountId || '0') % 25 === 0 || totalErrors <= 10) {
                    console.error(`[ENRICH] Exception fetching details for account ${item.accountId}:`, error.message);
                }
                return { success: false, reason: 'Exception: ' + error.message };
            }
        }));
        
        // حساب النجاحات والأخطاء
        const batchSuccesses = batchResults.filter(r => r.success).length;
        const batchErrors = batch.length - batchSuccesses;
        if (batchResults.some(r => r.cancelled)) {
            cancelled = true;
        }
        successCount += batchSuccesses;
        
        // تحديث عداد الأخطاء المتتالية بناءً على نسبة النجاح في الـ batch
        if (batchSuccesses === 0) {
            consecutiveErrors += batchErrors; // زيادة أكبر إذا فشل الـ batch كاملاً
        } else if (batchSuccesses < batch.length * 0.5) {
            consecutiveErrors += Math.floor(batchErrors / 2); // زيادة متوسطة إذا كان النجاح < 50%
        } else {
            consecutiveErrors = Math.max(0, consecutiveErrors - batchSuccesses); // تقليل عند النجاح
        }
        
        processed += batch.length;
        
        if (cancelled) {
            console.warn('[ENRICH] ⏹️ Cancellation acknowledged after current batch.');
            break;
        }
        
        // تحديث حالة التقدم
        if (userId) {
            updateSyncProgress(userId, {
                stage: 'enriching',
                current: processed,
                total: records.length,
                message: `جاري جلب التفاصيل... ${processed}/${records.length} (${successCount} نجح، ${phoneFoundCount} مع رقم هاتف)`,
                phoneFound: phoneFoundCount
            });
        }
        
        // تسجيل التقدم بشكل متكرر لكل batch
        console.log(`[ENRICH] Progress: ${processed}/${records.length} (${successCount} success, ${phoneFoundCount} phones, ${totalErrors} errors)`);        
        
        // تأخير بين الـ batches (إلا إذا كنا في نهاية القائمة)
        if (i + concurrency < records.length) {
            // تأخير أطول إذا كان هناك rate limiting
            const waitTime = rateLimitErrors > 0 ? delayBetweenBatches * 2 : delayBetweenBatches;
            await delay(waitTime);
        }
        
        // إذا حدث rate limiting كثيراً، نزيد التأخير
        if (rateLimitErrors > 10 && rateLimitErrors % 5 === 0) {
            console.log(`[ENRICH] ⚠️ Too many Rate Limiting errors (${rateLimitErrors}) - Waiting additional 10 seconds...`);
            await delay(10000);
        }
    }
    
    if (cancelled) {
        console.log(`[ENRICH] ⏹️ Detail fetching cancelled: ${successCount}/${processed} succeeded, ${phoneFoundCount} phones captured.`);
    } else {
        console.log(`[ENRICH] ✅ Completed fetching details: ${successCount}/${records.length} succeeded, ${phoneFoundCount} with phone numbers, ${rateLimitErrors} rate limits`);
    }
    
    return {
        processed,
        successCount,
        phoneFoundCount,
        rateLimitErrors,
        totalErrors,
        cancelled
    };
}

function buildCombinedCustomerRecord(customer, addressMap) {
    const accountId = extractAlwataniAccountId(customer);
    const matchedAddress = accountId ? addressMap.get(String(accountId)) : null;
    const subscriptions = Array.isArray(customer?.subscriptions) ? customer.subscriptions : [];
    const primarySubscription = subscriptions.length ? subscriptions[0] : null;
    const subscriptionDeviceName = primarySubscription?.username ||
        primarySubscription?.deviceName ||
        primarySubscription?.device ||
        primarySubscription?.serviceName ||
        null;
    const baseDeviceName = customer?.deviceName ||
        customer?.device ||
        subscriptionDeviceName ||
        null;

    return {
        accountId,
        name: customer?.displayValue ||
            customer?.self?.displayValue ||
            customer?.customerName ||
            matchedAddress?.displayValue ||
            null,
        username: customer?.username ||
            customer?.userName ||
            customer?.self?.userName ||
            null,
        deviceName: baseDeviceName || subscriptionDeviceName || null,
        status: customer?.status ||
            customer?.subscriptionStatus ||
            customer?.state ||
            null,
        phone: customer?.phoneNumber ||
            customer?.customerPhone ||
            customer?.contactPhone ||
            matchedAddress?.phoneNumber ||
            matchedAddress?.primaryPhone ||
            null,
        zone: customer?.zone?.displayValue ||
            customer?.zone ||
            matchedAddress?.zoneDisplayValue ||
            matchedAddress?.zone ||
            null,
        startDate: customer?.startDate ||
            customer?.contractStart ||
            primarySubscription?.startsAt ||
            null,
        endDate: customer?.endDate ||
            customer?.contractEnd ||
            customer?.expires ||
            primarySubscription?.endsAt ||
            null,
        rawCustomer: customer,
        rawAddress: matchedAddress,
        deviceName: baseDeviceName
    };
}

async function fetchAlwataniAddresses(token, accountIds) {
    if (!Array.isArray(accountIds) || accountIds.length === 0) {
        return { success: false, statusCode: null, data: null };
    }

    const filtered = accountIds
        .filter((accId) => accId !== undefined && accId !== null)
        .map((accId) => String(accId));

    if (!filtered.length) {
        return { success: false, statusCode: null, data: null };
    }

    const combinedList = [];
    let overallSuccess = true;
    let lastStatus = 200;

    for (let i = 0; i < filtered.length; i += ADDRESS_BATCH_SIZE) {
        const batch = filtered.slice(i, i + ADDRESS_BATCH_SIZE);
        const query = batch.map((accId) => `accountIds=${encodeURIComponent(accId)}`).join('&');
        const resp = await fetchAlwataniResource(`/api/addresses?${query}`, token, 'GET', true, null, null, 'addresses_lookup');
        lastStatus = resp.statusCode;

        if (resp.success && resp.data) {
            const list = normalizeAlwataniCollection(resp.data);
            combinedList.push(...list);
        } else {
            overallSuccess = false;
            console.warn(`[ALWATANI] ⚠️ Failed to fetch addresses batch (${batch.length} ids): ${resp.message || resp.statusCode}`);
        }

        if (ADDRESS_BATCH_DELAY > 0 && i + ADDRESS_BATCH_SIZE < filtered.length) {
            await delay(ADDRESS_BATCH_DELAY);
        }
    }

    return {
        success: overallSuccess,
        statusCode: lastStatus,
        data: combinedList
    };
}

async function collectAllAlwataniCustomers(token, pageSize, sortPropertyParam, maxPages = 400) {
    const combined = [];
    const rawCustomers = [];
    const seenAccounts = new Set();
    const statusHistory = [];

    let totalFetched = 0;
    let pagesFetched = 0;
    let pageNumber = 1;

    while (pageNumber <= maxPages) {
        const customersPath =
            `/api/customers?pageSize=${pageSize}&pageNumber=${pageNumber}&sortCriteria.property=${sortPropertyParam}&sortCriteria.direction=asc`;

        const customersResp = await fetchAlwataniResource(customersPath, token);
        statusHistory.push({ page: pageNumber, status: customersResp.statusCode });

        if (!customersResp.success) {
            return {
                success: pagesFetched > 0,
                message: 'تعذر إكمال جلب جميع المشتركين من الوطني',
                combined,
                customers: rawCustomers,
                totalFetched,
                pagesFetched,
                statusHistory,
                maxPages
            };
        }

        const customersList = normalizeAlwataniCollection(customersResp.data);
        if (!customersList.length) {
            break;
        }

        rawCustomers.push(...customersList);

        const accountIds = Array.from(new Set(
            customersList
                .map((customer) => extractAlwataniAccountId(customer))
                .filter((value) => value !== null && value !== undefined)
                .map((value) => String(value))
        ));

        const addressesResp = await fetchAlwataniAddresses(token, accountIds);
        const addressMap = buildAlwataniAddressMap(addressesResp.data);

        customersList.forEach((customer, index) => {
            const combinedRecord = buildCombinedCustomerRecord(customer, addressMap);
            const key = combinedRecord.accountId ? String(combinedRecord.accountId) : `page-${pageNumber}-idx-${index}`;
            if (!seenAccounts.has(key)) {
                seenAccounts.add(key);
                combined.push(combinedRecord);
                totalFetched += 1;
            }
        });

        pagesFetched += 1;

        if (customersList.length < pageSize) {
            break;
        }

        pageNumber += 1;
    }

    return {
        success: true,
        combined,
        customers: rawCustomers,
        totalFetched,
        pagesFetched,
        statusHistory,
        maxPages
    };
}

// Verify account with external API
async function verifyAlwataniAccount(username, password, options = {}) {
    const maxAttempts = Math.max(1, parseInt(options.maxAttempts || 5, 10));
    const retryDelay = Math.max(1000, parseInt(options.retryDelay || 10000, 10));

    const attemptVerification = () => new Promise((resolve) => {
        console.log(`[VERIFY] Attempting to verify account: ${username}`);

        const postData = querystring.stringify({
            grant_type: 'password',
            scope: 'openid profile',
            client_id: '',
            username,
            password
        });

        const req = https.request({
            hostname: ALWATANI_HOST,
            path: '/api/auth/Contractor/token',
            method: 'POST',
            agent: httpsAgent, // استخدام agent مع keep-alive
            headers: buildAlwataniHeaders({
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'Referer': 'https://admin.ftth.iq/auth/login'
            }),
            timeout: 15000 // زيادة timeout إلى 15 ثانية
        }, (res) => {
            parseAlwataniResponse(res).then((parsed) => {
                console.log(`[VERIFY] Status Code: ${parsed.statusCode}`);
                console.log(`[VERIFY] Response: ${parsed.text.substring(0, 300)}`);

                if (parsed.json && parsed.statusCode === 200 && parsed.json.access_token) {
                    console.log(`[VERIFY] ✅ Verification successful for account: ${username}`);
                    resolve({ success: true, data: parsed.json });
                } else {
                    const errorMsg =
                        (parsed.json && (parsed.json.error_description || parsed.json.error || parsed.json.title)) ||
                        parsed.text ||
                        'Invalid login credentials';
                    console.log(`[VERIFY] ❌ Verification failed: ${errorMsg}`);
                    resolve({ success: false, message: errorMsg });
                }
            });
        });

        req.on('error', (error) => {
            const errorDetails = {
                code: error.code,
                message: error.message,
                syscall: error.syscall,
                address: error.address,
                port: error.port
            };
            console.error(`[VERIFY] ❌ Connection error:`, errorDetails);
            resolve({
                success: false,
                message: 'Connection error to external site: ' + error.message,
                retryable: true,
                errorDetails
            });
        });

        req.on('timeout', () => {
            console.error(`[VERIFY] ❌ Connection timeout after 15 seconds`);
            req.destroy();
            resolve({
                success: false,
                message: 'Connection timeout to external site (15 seconds)',
                retryable: true
            });
        });

        req.write(postData);
        req.end();
    });

    let attempt = 0;
    let lastResult = { success: false, message: 'Unknown error' };

    while (attempt < maxAttempts) {
        const result = await attemptVerification();
        if (result.success) {
            return result;
        }

        lastResult = result;

        if (!result.retryable || attempt === maxAttempts - 1) {
            if (attempt === maxAttempts - 1) {
                console.error(`[VERIFY] ❌ Failed after ${maxAttempts} attempts. Last error: ${result.message}`);
                return {
                    ...lastResult,
                    message: `فشل التحقق من الحساب بعد ${maxAttempts} محاولات: ${result.message}`,
                    attemptsMade: maxAttempts
                };
            }
            return lastResult;
        }

        attempt += 1;
        const waitTime = retryDelay * attempt;
        console.warn(`[VERIFY] ⚠️ Connection issue while verifying (${result.message}). Retrying ${attempt}/${maxAttempts} after ${waitTime / 1000}s...`);
        await delay(waitTime);
    }

    console.error(`[VERIFY] ❌ Failed after ${maxAttempts} attempts. Last error: ${lastResult.message}`);
    return {
        ...lastResult,
        message: `فشل التحقق من الحساب بعد ${maxAttempts} محاولات: ${lastResult.message}`,
        attemptsMade: maxAttempts
    };
}

// Create new user (for initial login - واجهة تسجيل الدخول الأولى)
app.post('/api/users', async (req, res) => {
    try {
        console.log('[CREATE USER] Request received:', {
            body: req.body,
            headers: req.headers['content-type']
        });
        
        const { 
            username, 
            password, 
            role,
            agent_name,
            company_name,
            governorate,
            region,
            phone,
            email,
            position
        } = req.body;
        
        // Validation
        if (!username || username.trim().length < 3) {
            console.log('[CREATE USER] Username too short');
            return res.json({
                success: false,
                message: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل'
            });
        }
        
        if (!password || password.length < 3) {
            console.log('[CREATE USER] Password too short');
            return res.json({
                success: false,
                message: 'كلمة المرور يجب أن تكون 3 أحرف على الأقل'
            });
        }
        
        // التحقق من الحقول المطلوبة للوكيل
        if (!agent_name || !agent_name.trim()) {
            return res.json({
                success: false,
                message: 'اسم الوكيل الثلاثي مطلوب'
            });
        }
        
        if (!company_name || !company_name.trim()) {
            return res.json({
                success: false,
                message: 'اسم الشركة مطلوب'
            });
        }
        
        if (!phone || !phone.trim()) {
            return res.json({
                success: false,
                message: 'رقم الهاتف مطلوب'
            });
        }
        
        if (!email || !email.trim()) {
            return res.json({
                success: false,
                message: 'البريد الإلكتروني مطلوب'
            });
        }
        
        // التحقق من صيغة البريد الإلكتروني والنطاقات المسموح بها
        const allowedDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'];
        const trimmedEmail = email.trim().toLowerCase();
        
        const atIndex = trimmedEmail.indexOf('@');
        if (atIndex === -1 || atIndex === 0) {
            return res.json({
                success: false,
                message: 'البريد الإلكتروني يجب أن يحتوي على @'
            });
        }
        
        const usernamePart = trimmedEmail.substring(0, atIndex);
        const domainPart = trimmedEmail.substring(atIndex + 1);
        
        // التحقق من اسم المستخدم
        if (!/^[a-zA-Z0-9._%+-]+$/.test(usernamePart) || usernamePart.length === 0) {
            return res.json({
                success: false,
                message: 'اسم المستخدم غير صحيح'
            });
        }
        
        // التحقق من أن النطاق مسموح به
        if (!allowedDomains.includes(domainPart)) {
            return res.json({
                success: false,
                message: 'النطاق غير مسموح. النطاقات المسموحة: gmail.com, yahoo.com, hotmail.com, outlook.com, icloud.com'
            });
        }
        
        // التحقق من أن البريد ينتهي بالنطاق فقط (لا يوجد نص إضافي)
        if (trimmedEmail !== usernamePart + '@' + domainPart) {
            return res.json({
                success: false,
                message: 'البريد الإلكتروني غير صحيح. لا يمكن إضافة نص بعد النطاق'
            });
        }
        
        const trimmedUsername = username.trim().toLowerCase();
        
        // التحقق من أن اسم المستخدم يتبع الصيغة admin@...
        if (!trimmedUsername.startsWith('admin@')) {
            return res.json({
                success: false,
                message: 'اسم المستخدم يجب أن يبدأ بـ admin@'
            });
        }
        
        // استخراج الجزء الأساسي من اسم المستخدم (بعد admin@)
        const usernameBase = trimmedUsername.replace(/^admin@/, '');
        if (usernameBase.length < 3 || !/^[a-z]{3,}$/.test(usernameBase)) {
            return res.json({
                success: false,
                message: 'اسم المستخدم الأساسي يجب أن يكون 3 أحرف إنجليزية على الأقل'
            });
        }
        
        // التحقق من عدم وجود قاعدة بيانات للمالك (من قاعدة البيانات الرئيسية)
        console.log('[CREATE USER] Checking if owner database exists:', trimmedUsername);
        const dbExists = await dbManager.ownerDatabaseExists(trimmedUsername);
        
        if (dbExists) {
            console.log('[CREATE USER] Owner database already exists');
            return res.json({
                success: false,
                message: '❌ الحساب موجود مسبقاً. يرجى استخدام حساب آخر'
            });
        }
        
        // التحقق من البريد الإلكتروني ورقم الهاتف في قاعدة البيانات الرئيسية
        const masterPool = await dbManager.initMasterPool();
        
        // التحقق من البريد الإلكتروني
        const [existingEmail] = await masterPool.query(
            'SELECT id FROM owners_databases WHERE email = ?',
            [trimmedEmail]
        );
        
        if (existingEmail.length > 0) {
            console.log('[CREATE USER] Email already exists');
            return res.json({
                success: false,
                message: '❌ البريد الإلكتروني مستخدم مسبقاً. يرجى استخدام بريد إلكتروني آخر'
            });
        }
        
        // التحقق من رقم الهاتف
        const trimmedPhone = phone.trim();
        let cleanPhone = trimmedPhone.replace(/\+*964/g, '');
        if (cleanPhone.startsWith('964')) {
            cleanPhone = cleanPhone.substring(3);
        }
        const formattedPhone = cleanPhone ? `+964${cleanPhone}` : trimmedPhone;
        
        const [existingPhone] = await masterPool.query(
            'SELECT id FROM owners_databases WHERE phone = ? OR phone = ?',
            [formattedPhone, formattedPhone.replace(/^\+964/, '')]
        );
        
        if (existingPhone.length > 0) {
            console.log('[CREATE USER] Phone already exists');
            return res.json({
                success: false,
                message: '❌ رقم الهاتف مستخدم مسبقاً. يرجى استخدام رقم هاتف آخر'
            });
        }
        
        // إنشاء قاعدة البيانات الجديدة للمالك
        console.log('[CREATE USER] Creating new owner database for:', trimmedUsername);
        try {
            
            await dbManager.createOwnerDatabase({
                username: trimmedUsername,
                password: password,
                agent_name: agent_name.trim(),
                company_name: company_name.trim(),
                governorate: governorate ? governorate.trim() : null,
                region: region ? region.trim() : null,
                phone: formattedPhone, // تم تعريفه أعلاه
                email: email.trim()
            });
            
            console.log('[CREATE USER] Owner database created successfully');
            
            // الحصول على معلومات الحساب المُنشأ
            const domain = dbManager.getDomainFromUsername(trimmedUsername);
            const ownerPool = await dbManager.getOwnerPool(domain);
            const [userRows] = await ownerPool.query(
                'SELECT id FROM users WHERE username = ?',
                [trimmedUsername]
            );
            
            res.json({
                success: true,
                id: userRows[0].id,
                message: '✅ تم إنشاء الحساب وقاعدة البيانات بنجاح'
            });
        } catch (error) {
            console.error('[CREATE USER] Error creating owner database:', error);
            return res.status(500).json({
                success: false,
                message: 'خطأ في إنشاء قاعدة البيانات: ' + error.message
            });
        }
    } catch (error) {
        console.error('[CREATE USER] Error:', error);
        
        // التحقق من الأخطاء الشائعة
        if (error.code === 'ER_DUP_ENTRY') {
            return res.json({
                success: false,
                message: 'اسم المستخدم أو البريد الإلكتروني موجود مسبقاً'
            });
        }
        
        res.status(500).json({ 
            success: false, 
            message: 'خطأ في إنشاء الحساب: ' + error.message 
        });
    }
});

// Check if username exists
app.get('/api/users/check-username', async (req, res) => {
    try {
        const { username } = req.query;
        
        if (!username) {
            return res.json({
                exists: false,
                message: 'يرجى إدخال اسم المستخدم'
            });
        }
        
        const trimmedUsername = username.trim().toLowerCase();
        
        // التحقق من قاعدة البيانات الرئيسية
        const masterPool = await dbManager.initMasterPool();
        const [existing] = await masterPool.query(
            'SELECT id FROM owners_databases WHERE username = ?',
            [trimmedUsername]
        );
        
        if (existing.length > 0) {
            return res.json({
                exists: true,
                message: 'اسم المستخدم موجود مسبقاً'
            });
        }
        
        res.json({
            exists: false,
            message: 'اسم المستخدم متاح'
        });
    } catch (error) {
        console.error('[CHECK USERNAME] Error:', error);
        res.status(500).json({
            exists: false,
            message: 'خطأ في التحقق من اسم المستخدم'
        });
    }
});

// Check if email exists
app.get('/api/users/check-email', async (req, res) => {
    try {
        const { email } = req.query;
        
        if (!email) {
            return res.json({
                exists: false,
                message: 'يرجى إدخال البريد الإلكتروني'
            });
        }
        
        const trimmedEmail = email.trim().toLowerCase();
        
        // التحقق من قاعدة البيانات الرئيسية
        const masterPool = await dbManager.initMasterPool();
        const [existing] = await masterPool.query(
            'SELECT id FROM owners_databases WHERE email = ?',
            [trimmedEmail]
        );
        
        res.json({
            exists: existing.length > 0,
            message: existing.length > 0 ? 'البريد الإلكتروني مستخدم مسبقاً' : 'البريد الإلكتروني متاح'
        });
    } catch (error) {
        console.error('[CHECK EMAIL] Error:', error);
        res.status(500).json({
            exists: false,
            message: 'خطأ في التحقق من البريد الإلكتروني'
        });
    }
});

// Check if phone exists
app.get('/api/users/check-phone', async (req, res) => {
    try {
        const { phone } = req.query;
        
        if (!phone) {
            return res.json({
                exists: false,
                message: 'يرجى إدخال رقم الهاتف'
            });
        }
        
        const trimmedPhone = phone.trim();
        
        // Check if phone exists (مع +964 وبدونه)
        // لأن الرقم يُحفظ مع +964 في قاعدة البيانات
        const phoneWithPrefix = trimmedPhone.startsWith('+964') ? trimmedPhone : `+964${trimmedPhone}`;
        const phoneWithoutPrefix = trimmedPhone.replace(/^\+964/, '');
        
        // التحقق من قاعدة البيانات الرئيسية
        const masterPool = await dbManager.initMasterPool();
        const [existing] = await masterPool.query(
            'SELECT id FROM owners_databases WHERE phone = ? OR phone = ? OR phone = ?',
            [trimmedPhone, phoneWithPrefix, phoneWithoutPrefix]
        );
        
        res.json({
            exists: existing.length > 0,
            message: existing.length > 0 ? 'رقم الهاتف مستخدم مسبقاً' : 'رقم الهاتف متاح'
        });
    } catch (error) {
        console.error('[CHECK PHONE] Error:', error);
        res.status(500).json({
            exists: false,
            message: 'خطأ في التحقق من رقم الهاتف'
        });
    }
});

const ALWATANI_ROUTES = ['/api/alwatani-login', '/alwatani-login'];

async function handleCreateAlwataniLogin(req, res) {
    try {
        const { username, password, role, user_id, owner_username } = req.body;
        
        console.log('[CREATE ALWATANI LOGIN] Request:', { username, user_id, owner_username, body: req.body });
        
        // Validation
        if (!username || username.length < 3) {
            return res.json({
                success: false,
                message: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل'
            });
        }
        
        if (!password || password.length < 3) {
            return res.json({
                success: false,
                message: 'كلمة المرور يجب أن تكون 3 أحرف على الأقل'
            });
        }
        
        if (!user_id) {
            return res.json({
                success: false,
                message: 'يجب تحديد معرف المستخدم'
            });
        }
        
        if (!owner_username) {
            return res.json({
                success: false,
                message: 'يجب تحديد اسم المستخدم الخاص بالمالك (owner_username)'
            });
        }
        
        // التحقق من وجود قاعدة البيانات
        const dbExists = await dbManager.ownerDatabaseExists(owner_username);
        if (!dbExists) {
            console.log('[CREATE ALWATANI LOGIN] Database does not exist for:', owner_username);
            return res.json({
                success: false,
                message: 'قاعدة البيانات غير موجودة. يرجى التأكد من تسجيل الدخول بشكل صحيح'
            });
        }
        
        // الحصول على قاعدة البيانات الخاصة بالمالك
        console.log('[CREATE ALWATANI LOGIN] Getting pool for username:', owner_username);
        let ownerPool;
        try {
            ownerPool = await dbManager.getPoolFromUsername(owner_username);
            console.log('[CREATE ALWATANI LOGIN] Pool obtained successfully');
            if (!ownerPool) {
                throw new Error('Failed to get database pool');
            }
        } catch (poolError) {
            console.error('[CREATE ALWATANI LOGIN] Error getting pool:', poolError);
            console.error('[CREATE ALWATANI LOGIN] Pool error stack:', poolError.stack);
            return res.json({
                success: false,
                message: 'خطأ في الاتصال بقاعدة البيانات: ' + poolError.message
            });
        }
        
        // Verify account with external API first
        console.log(`[ALWATANI LOGIN] Starting account verification: ${username} for user_id: ${user_id}`);
        let verification;
        try {
            verification = await verifyAlwataniAccount(username, password);
            console.log(`[ALWATANI LOGIN] Verification result:`, verification);
        } catch (verifyError) {
            console.error('[CREATE ALWATANI LOGIN] Verification error:', verifyError);
            return res.json({
                success: false,
                message: 'خطأ في التحقق من الحساب: ' + verifyError.message
            });
        }
        
        if (!verification || !verification.success) {
            console.log(`[ALWATANI LOGIN] ❌ Save rejected - Verification failed`);
            return res.json({
                success: false,
                message: '❌ Account verification failed: ' + (verification?.message || 'Unknown error')
            });
        }
        
        console.log(`[ALWATANI LOGIN] ✅ Verification successful - Proceeding to save`);
        
        // Check if username already exists for this user (يسمح بنفس username لمستخدمين مختلفين)
        let existing;
        try {
            [existing] = await ownerPool.query(
                'SELECT id FROM alwatani_login WHERE user_id = ? AND username = ?',
                [user_id, username]
            );
        } catch (queryError) {
            console.error('[CREATE ALWATANI LOGIN] Query error:', queryError);
            return res.json({
                success: false,
                message: 'خطأ في التحقق من الحساب: ' + queryError.message
            });
        }
        
        if (existing && existing.length > 0) {
            return res.json({
                success: false,
                message: 'هذا الحساب مضاف مسبقاً لك'
            });
        }
        
        let result;
        try {
            [result] = await ownerPool.query(
                'INSERT INTO alwatani_login (user_id, username, password, role) VALUES (?, ?, ?, ?)',
                [user_id, username, password, role || 'user']
            );
        } catch (insertError) {
            console.error('[CREATE ALWATANI LOGIN] Insert error:', insertError);
            if (insertError.code === 'ER_DUP_ENTRY') {
                return res.json({
                    success: false,
                    message: 'هذا الحساب مضاف مسبقاً لك'
                });
            }
            throw insertError;
        }
        
        // إنشاء قاعدة بيانات منفصلة لحساب الوطني
        try {
            console.log(`[CREATE ALWATANI LOGIN] Creating database for: ${username}`);
            const alwataniDbName = await dbManager.createAlwataniDatabase(username);
            console.log(`[CREATE ALWATANI LOGIN] ✅ Database created: ${alwataniDbName}`);
        } catch (dbError) {
            console.error('[CREATE ALWATANI LOGIN] Database creation error:', dbError);
            // لا نوقف العملية إذا فشل إنشاء قاعدة البيانات، لكن نسجل الخطأ
            console.warn('[CREATE ALWATANI LOGIN] ⚠️ Account saved but database creation failed. Database will be created on first access.');
        }
        
        res.json({
            success: true,
            id: result.insertId,
            message: '✅ تم التحقق من الحساب وحفظه بنجاح'
        });
    } catch (error) {
        console.error('[CREATE ALWATANI LOGIN] Unexpected error:', error);
        console.error('[CREATE ALWATANI LOGIN] Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            message: 'خطأ في إنشاء الحساب: ' + error.message 
        });
    }
}

ALWATANI_ROUTES.forEach(route => {
    app.post(route, handleCreateAlwataniLogin);
});

// Delete user
app.delete('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await pool.query('DELETE FROM users WHERE id = ?', [id]);
        
        res.json({
            success: true,
            message: 'تم حذف المستخدم بنجاح'
        });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ success: false, message: 'خطأ في حذف المستخدم' });
    }
});

// ================= Alwatani Login Management Routes =================

async function handleGetAlwataniLogins(req, res) {
    try {
        const userId = req.query.user_id || req.headers['x-user-id'];
        const ownerUsername = req.query.username || req.headers['x-username'];
        
        console.log('[GET ALWATANI LOGIN] Request:', { userId, ownerUsername, query: req.query });
        
        if (!ownerUsername) {
            console.log('[GET ALWATANI LOGIN] Missing ownerUsername');
            return res.status(400).json({ 
                error: 'اسم المستخدم (username) مطلوب',
                message: 'يرجى إرسال username في query أو header'
            });
        }
        
        if (!userId) {
            console.log('[GET ALWATANI LOGIN] Missing userId');
            return res.status(400).json({ 
                error: 'معرف المستخدم (user_id) مطلوب',
                message: 'يرجى إرسال user_id في query أو header'
            });
        }
        
        // التحقق من وجود قاعدة البيانات
        let dbExists = false;
        try {
            dbExists = await dbManager.ownerDatabaseExists(ownerUsername);
            console.log('[GET ALWATANI LOGIN] Database exists:', dbExists, 'for username:', ownerUsername);
        } catch (dbCheckError) {
            console.error('[GET ALWATANI LOGIN] Error checking database:', dbCheckError.message);
            return res.json([]); // إرجاع array فارغ في حالة الخطأ
        }
        
        if (!dbExists) {
            console.log('[GET ALWATANI LOGIN] Database does not exist for:', ownerUsername);
            return res.json([]); // إرجاع array فارغ بدلاً من خطأ
        }
        
        // الحصول على قاعدة البيانات الخاصة بالمالك
        console.log('[GET ALWATANI LOGIN] Getting pool for username:', ownerUsername);
        let ownerPool;
        try {
            ownerPool = await dbManager.getPoolFromUsername(ownerUsername);
        } catch (poolError) {
            console.error('[GET ALWATANI LOGIN] Error getting pool:', poolError.message);
            return res.status(500).json({ 
                error: 'خطأ في الاتصال بقاعدة البيانات',
                message: poolError.message 
            });
        }
        
        let query = 'SELECT id, username, password, role, user_id, created_at FROM alwatani_login WHERE user_id = ? ORDER BY created_at DESC';
        
        console.log('[GET ALWATANI LOGIN] Executing query with userId:', userId);
        let rows;
        try {
            [rows] = await ownerPool.query(query, [userId]);
            console.log('[GET ALWATANI LOGIN] Found rows:', rows?.length || 0);
        } catch (queryError) {
            console.error('[GET ALWATANI LOGIN] Query error:', queryError.message);
            // إذا كان الجدول غير موجود، إرجاع array فارغ
            if (queryError.code === 'ER_NO_SUCH_TABLE') {
                return res.json([]);
            }
            throw queryError;
        }
        
        res.json(Array.isArray(rows) ? rows : []);
    } catch (error) {
        console.error('[GET ALWATANI LOGIN] Error:', error);
        console.error('[GET ALWATANI LOGIN] Error stack:', error.stack);
        res.status(500).json({ 
            error: 'خطأ في جلب حسابات الوطني',
            message: error.message,
            details: error.stack
        });
    }
}

async function handleDeleteAlwataniLogin(req, res) {
    try {
        const { id } = req.params;
        const userId = req.query.user_id || req.headers['x-user-id'];
        const ownerUsername = req.query.username || req.headers['x-username'];
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false,
                message: 'اسم المستخدم (username) مطلوب'
            });
        }
        
        // الحصول على قاعدة البيانات الخاصة بالمالك
        const ownerPool = await dbManager.getPoolFromUsername(ownerUsername);
        
        // التحقق من أن الحساب يخص المستخدم الحالي (للمزيد من الأمان)
        if (userId) {
            const [check] = await ownerPool.query(
                'SELECT id FROM alwatani_login WHERE id = ? AND user_id = ?',
                [id, userId]
            );
            
            if (check.length === 0) {
                return res.status(403).json({ 
                    success: false, 
                    message: 'غير مصرح لك بحذف هذا الحساب' 
                });
            }
        }
        
        await ownerPool.query('DELETE FROM alwatani_login WHERE id = ?', [id]);
        
        res.json({
            success: true,
            message: 'تم حذف حساب الوطني بنجاح'
        });
    } catch (error) {
        console.error('Delete Alwatani login error:', error);
        res.status(500).json({ success: false, message: 'خطأ في حذف حساب الوطني: ' + error.message });
    }
}

ALWATANI_ROUTES.forEach(route => {
    app.get(route, handleGetAlwataniLogins);
    app.delete(`${route}/:id`, handleDeleteAlwataniLogin);
});

async function handleGetAlwataniCustomers(req, res) {
    try {
        const { id } = req.params;
        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        
        const pageNumber = Math.max(parseInt(req.query.pageNumber, 10) || 1, 1);
        const requestedPageSize = parseInt(req.query.pageSize, 10) || 10;
        const pageSize = Math.min(Math.max(requestedPageSize, 1), 100);

        const fetchMode = (req.query.mode || req.query.fetch || '').toLowerCase();
        const fetchAll = fetchMode === 'all' || (req.query.fetchAll || '').toLowerCase() === 'true';
        const maxPages = Math.min(Math.max(parseInt(req.query.maxPages, 10) || 400, 1), 2000);

        const [accounts] = await ownerPool.query(
            'SELECT id, username, password FROM alwatani_login WHERE id = ?',
            [id]
        );

        if (accounts.length === 0) {
            return res.status(404).json({ success: false, message: 'الحساب غير موجود' });
        }

        const account = accounts[0];
        const verification = await verifyAlwataniAccount(account.username, account.password);

        if (!verification.success) {
            return res.json({
                success: false,
                message: verification.message || '❌ فشل التحقق من الحساب'
            });
        }

        const token = verification.data?.access_token;
        if (!token) {
            return res.json({
                success: false,
                message: 'لم يتم استلام رمز الوصول من الموقع الخارجي'
            });
        }

        const sortProperty = encodeURIComponent('self.displayValue');
        const summaryPath = `/api/customers/summary?partnersAndLOBAgnostic=false&pageSize=${pageSize}&pageNumber=${pageNumber}`;
        const summaryResp = await fetchAlwataniResource(summaryPath, token);

        if (fetchAll) {
            const aggregation = await collectAllAlwataniCustomers(token, pageSize, sortProperty, maxPages);

            if (!aggregation.success && aggregation.pagesFetched === 0) {
                return res.json({
                    success: false,
                    message: aggregation.message || 'تعذر جلب المشتركين من الوطني'
                });
            }

            return res.json({
                success: true,
                pagination: {
                    mode: 'all',
                    pageSize,
                    pagesFetched: aggregation.pagesFetched,
                    total: aggregation.totalFetched,
                    maxPages: aggregation.maxPages
                },
                data: {
                    customers: {
                        items: aggregation.customers,
                        totalCount: aggregation.totalFetched
                    },
                    summary: summaryResp.data || null,
                    addresses: null,
                    combined: aggregation.combined
                },
                meta: {
                    statuses: {
                        summary: summaryResp.statusCode,
                        aggregator: aggregation.statusHistory
                    }
                }
            });
        }

        const customersPath =
            `/api/customers?pageSize=${pageSize}&pageNumber=${pageNumber}&sortCriteria.property=${sortProperty}&sortCriteria.direction=asc`;

        const customersResp = await fetchAlwataniResource(customersPath, token);
        if (!customersResp.success) {
            return res.json({
                success: false,
                message: 'تعذر جلب قائمة المشتركين من الوطني'
            });
        }

        const customersList = normalizeAlwataniCollection(customersResp.data);
        const accountIds = Array.from(new Set(customersList
            .map((customer) => extractAlwataniAccountId(customer))
            .filter((value) => value !== null && value !== undefined)
            .map((value) => String(value))
        ));

        const addressesResp = await fetchAlwataniAddresses(token, accountIds);
        const addressMap = buildAlwataniAddressMap(addressesResp.data);
        const combined = customersList.map((customer) => buildCombinedCustomerRecord(customer, addressMap));

        res.json({
            success: true,
            pagination: {
                pageNumber,
                pageSize,
                total: customersResp.data?.totalCount ||
                    customersResp.data?.total ||
                    customersResp.data?.count ||
                    customersResp.data?.Total ||
                    customersResp.data?.TotalCount ||
                    combined.length
            },
            data: {
                customers: customersResp.data || null,
                summary: summaryResp.data || null,
                addresses: addressesResp.data || null,
                combined
            },
            meta: {
                statuses: {
                    customers: customersResp.statusCode,
                    summary: summaryResp.statusCode,
                    addresses: addressesResp.statusCode
                }
            }
        });
    } catch (error) {
        console.error('Fetch Alwatani customers error:', error);
        res.status(500).json({
            success: false,
            message: 'خطأ في جلب بيانات المشتركين من الوطني'
        });
    }
}

ALWATANI_ROUTES.forEach(route => {
    app.get(`${route}/:id/customers`, handleGetAlwataniCustomers);
});

// Sync all customers from Alwatani and store locally
app.post('/api/alwatani-login/:id/customers/sync', async (req, res) => {
    const { id } = req.params;
    try {
        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        
        const forceFullSync = req.body.forceFullSync === true; // خيار لفرض المزامنة الكاملة
        clearSyncCancellation(id);
        const [accounts] = await ownerPool.query(
            'SELECT id, username, password, user_id FROM alwatani_login WHERE id = ?',
            [id]
        );

        if (accounts.length === 0) {
            return res.status(404).json({ success: false, message: 'الحساب غير موجود' });
        }

        const account = accounts[0];
        
        // الحصول على pool لقاعدة بيانات الوطني
        const alwataniPool = await dbManager.getAlwataniPool(account.username);
        
        // تأخير أولي للسماح للاتصال بالاستقرار
        console.log('[SYNC] Waiting 5 seconds before starting verification to ensure connection stability...');
        await delay(5000);
        
        console.log('[SYNC] Starting account verification...');
        const verification = await verifyAlwataniAccount(account.username, account.password, {
            maxAttempts: 5,
            retryDelay: 10000
        });

        if (!verification.success) {
            console.error(`[SYNC] ❌ Account verification failed after all retries: ${verification.message}`);
            return res.json({
                success: false,
                message: `❌ فشل التحقق من الحساب بعد عدة محاولات: ${verification.message || 'خطأ في الاتصال بالموقع الخارجي'}. يرجى المحاولة مرة أخرى.`
            });
        }

        let token = verification.data?.access_token;
        if (!token) {
            return res.json({
                success: false,
                message: 'لم يتم استلام رمز الوصول من الموقع الخارجي'
            });
        }
        const tokenRef = { value: token };

        let partnerId = verification.data?.AccountId || verification.data?.account_id || null;
        const applyTokenFromResponse = (resp) => {
            if (resp?.token && resp.token !== tokenRef.value) {
                tokenRef.value = resp.token;
            }
            token = tokenRef.value;
        };

        const currentUserResp = await fetchAlwataniResource(
            '/api/current-user',
            token,
            'GET',
            true,
            account.username,
            account.password,
            'current_user'
        );
        applyTokenFromResponse(currentUserResp);

        if (currentUserResp.statusCode === 403 && !currentUserResp.success) {
            const stage = currentUserResp.context || 'current_user';
            return res.json({
                success: false,
                stage,
                message: `[${stage}] تم رفض الوصول (403) أثناء جلب بيانات الحساب. يرجى التحقق من بيانات الدخول.`
            });
        }

        if (currentUserResp.success && currentUserResp.data) {
            const userData = currentUserResp.data.model || currentUserResp.data;
            partnerId = partnerId || userData?.self?.id || userData?.AccountId || null;
        }

        if (!partnerId) {
            return res.json({
                success: false,
                message: 'لم يتم تحديد معرف الشريك (partnerId)'
            });
        }

        console.log(`[SYNC] Starting sync for account ${id} (partnerId: ${partnerId})`);

        const pageSize = 100; // استخدام الحجم المدعوم من واجهة الوطني
        const sortProperty = encodeURIComponent('self.displayValue');
        const parallelPages = PAGE_FETCH_BATCH_SIZE; // عدد الصفحات التي يتم جلبها بشكل متوازي
        let cancelled = false;
        
        // جلب الصفحة الأولى لمعرفة العدد الإجمالي مع retry mechanism
        const firstPageResp = await fetchCustomersPageWithRetry(
            1,
            token,
            account.username,
            account.password,
            sortProperty,
            pageSize,
            applyTokenFromResponse,
            'customers_first_page'
        );

        if (!firstPageResp.success || !firstPageResp.data) {
            console.error('[SYNC] Failed to fetch first page:', firstPageResp);
            const stage = firstPageResp.context || 'customers_first_page';
            let errorMsg = firstPageResp.message || 'خطأ غير معروف';
            if (firstPageResp.statusCode === 403) {
                errorMsg = 'تم رفض الوصول (403). قد يكون الحساب منتهي الصلاحية أو محظور. يرجى التحقق من بيانات الدخول.';
            }
            return res.json({
                success: false,
                stage,
                message: `[${stage}] فشل جلب البيانات من الوطني: ${errorMsg}`
            });
        }

        const firstPageList = normalizeAlwataniCollection(firstPageResp.data);
        if (firstPageList.length === 0) {
            return res.json({
                success: false,
                message: 'لا توجد بيانات في الوطني'
            });
        }

        let allCustomers = [...firstPageList];
        const totalCount = firstPageResp.data?.totalCount || firstPageResp.data?.total || 0;
        const totalPages = totalCount > 0 ? Math.ceil(totalCount / pageSize) : Math.ceil(firstPageList.length / pageSize);
        
        console.log(`[SYNC] Total count: ${totalCount || 'unknown'}, Total pages: ${totalPages}`);
        
        // ==================== المزامنة الذكية ====================
        // مقارنة العدد الإجمالي مع قاعدة البيانات لتحديد إذا كنا نحتاج المزامنة الكاملة
        let useSmartSync = false;
        let missingAccountIds = [];
        
        if (!forceFullSync && totalCount > 0) {
            try {
                const [dbCountResult] = await alwataniPool.query(
                    'SELECT COUNT(DISTINCT account_id) as total FROM alwatani_customers_cache WHERE partner_id = ?',
                    [partnerId]
                );
                const dbTotal = dbCountResult[0]?.total || 0;
                const difference = totalCount - dbTotal;
                
                console.log(`[SYNC] 📊 Total in Alwatani: ${totalCount}, In DB: ${dbTotal}, Difference: ${difference}`);
                
                // إذا كان الفرق صغير (أقل من 50 مشترك)، نستخدم المزامنة الذكية
                if (difference > 0 && difference <= 50) {
                    useSmartSync = true;
                    console.log(`[SYNC] 🔍 Smart sync enabled: Only ${difference} missing subscribers detected. Identifying missing IDs...`);
                    
                    updateSyncProgress(id, {
                        stage: 'identifying_missing',
                        current: 0,
                        total: totalPages,
                        message: `تحديد المشتركين الناقصين... (${difference} ناقص)`
                    });
                    
                    // جمع جميع IDs من الصفحة الأولى
                    const allAccountIdsFromAlwatani = new Set();
                    firstPageList.forEach(customer => {
                        const accountId = extractAlwataniAccountId(customer);
                        if (accountId) {
                            allAccountIdsFromAlwatani.add(String(accountId));
                        }
                    });
                    
                    // جلب باقي الصفحات للحصول على جميع IDs (بدون عناوين أو تفاصيل - أسرع)
                    for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
                        if (isSyncCancelled(id)) {
                            cancelled = true;
                            break;
                        }
                        
                        const pageResp = await fetchCustomersPageWithRetry(
                            pageNum,
                            token,
                            account.username,
                            account.password,
                            sortProperty,
                            pageSize,
                            applyTokenFromResponse,
                            `customers_id_only_${pageNum}`
                        );
                        
                        if (pageResp.success && pageResp.data) {
                            const customersList = normalizeAlwataniCollection(pageResp.data);
                            customersList.forEach(customer => {
                                const accountId = extractAlwataniAccountId(customer);
                                if (accountId) {
                                    allAccountIdsFromAlwatani.add(String(accountId));
                                }
                            });
                        }
                        
                        updateSyncProgress(id, {
                            stage: 'identifying_missing',
                            current: pageNum,
                            total: totalPages,
                            message: `جلب IDs من الصفحة ${pageNum}/${totalPages}...`
                        });
                        
                        // تأخير قصير لتجنب rate limiting
                        const currentPageDelay = getPageFetchBatchDelay();
                        if (pageNum < totalPages && currentPageDelay > 0) {
                            await delay(currentPageDelay);
                        }
                    }
                    
                    if (cancelled) {
                        updateSyncProgress(id, {
                            stage: 'cancelled',
                            message: 'تم إيقاف المزامنة أثناء تحديد المشتركين الناقصين',
                            cancelRequested: true
                        });
                        return res.json({
                            success: true,
                            cancelled: true,
                            message: 'تم إيقاف العملية أثناء تحديد المشتركين الناقصين'
                        });
                    }
                    
                    // جلب IDs من قاعدة البيانات
                    const [dbAccountIds] = await alwataniPool.query(
                        'SELECT DISTINCT account_id FROM alwatani_customers_cache WHERE partner_id = ?',
                        [partnerId]
                    );
                    const dbAccountIdsSet = new Set(dbAccountIds.map(row => String(row.account_id)));
                    
                    // تحديد المشتركين الناقصين
                    missingAccountIds = Array.from(allAccountIdsFromAlwatani).filter(
                        accountId => !dbAccountIdsSet.has(accountId)
                    );
                    
                    console.log(`[SYNC] ✅ Identified ${missingAccountIds.length} missing subscribers`);
                    
                    if (missingAccountIds.length === 0) {
                        console.log(`[SYNC] ✅ No missing subscribers found. All ${totalCount} subscribers are already in database.`);
                        updateSyncProgress(id, {
                            stage: 'complete',
                            current: totalCount,
                            total: totalCount,
                            message: `✅ جميع ${totalCount} مشترك موجودين في قاعدة البيانات`
                        });
                        return res.json({
                            success: true,
                            message: `✅ جميع ${totalCount} مشترك موجودين في قاعدة البيانات`,
                            stats: {
                                totalInAlwatani: totalCount,
                                totalInDB: dbTotal,
                                missing: 0
                            }
                        });
                    }
                    
                    console.log(`[SYNC] 🔄 Will fetch full data for ${missingAccountIds.length} missing subscribers only...`);
                } else if (difference > 0) {
                    console.log(`[SYNC] 📊 Large difference (${difference} missing) - Using full sync approach`);
                } else {
                    console.log(`[SYNC] ✅ Database is up to date or ahead (DB: ${dbTotal}, Alwatani: ${totalCount})`);
                }
            } catch (error) {
                console.error(`[SYNC] Error in smart sync check:`, error);
                console.log(`[SYNC] Falling back to full sync due to error`);
                useSmartSync = false;
            }
        }
        // ==================== نهاية المزامنة الذكية ====================
        
        // تحديث حالة التقدم بعد معرفة العدد الإجمالي
        updateSyncProgress(id, {
            stage: 'fetching_pages',
            current: 1,
            total: totalPages,
            message: useSmartSync 
                ? `جاري جلب بيانات المشتركين الناقصين... (${missingAccountIds.length} مشترك)`
                : `جاري جلب صفحات المشتركين... الصفحة 1 من ${totalPages}`
        });

        // جلب الصفحات المتبقية بشكل متوازي (أو فقط للمشتركين الناقصين في المزامنة الذكية)
        const remainingPages = totalPages > 1 ? totalPages - 1 : 0;
        
        if (useSmartSync && missingAccountIds.length > 0) {
            // المزامنة الذكية: جلب فقط المشتركين الناقصين
            console.log(`[SYNC] 🔍 Smart sync: Fetching full data for ${missingAccountIds.length} missing subscribers only...`);
            
            // إنشاء Set للبحث السريع
            const missingIdsSet = new Set(missingAccountIds.map(id => String(id)));
            
            // تصفية الصفحة الأولى للمشتركين الناقصين فقط
            allCustomers = firstPageList.filter(customer => {
                const accountId = extractAlwataniAccountId(customer);
                return accountId && missingIdsSet.has(String(accountId));
            });
            
            console.log(`[SYNC] Found ${allCustomers.length} missing subscribers in first page`);
            
            // جلب باقي الصفحات للمشتركين الناقصين فقط
            if (remainingPages > 0) {
                for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
                    if (isSyncCancelled(id)) {
                        cancelled = true;
                        break;
                    }
                    
                    // إذا وجدنا جميع المشتركين الناقصين، نتوقف
                    if (allCustomers.length >= missingAccountIds.length) {
                        console.log(`[SYNC] ✅ Found all ${missingAccountIds.length} missing subscribers, stopping page fetch`);
                        break;
                    }
                    
                    const pageResp = await fetchCustomersPageWithRetry(
                        pageNum,
                        token,
                        account.username,
                        account.password,
                        sortProperty,
                        pageSize,
                        applyTokenFromResponse,
                        `customers_missing_${pageNum}`
                    );
                    
                    if (pageResp.statusCode === 403 && !pageResp.success) {
                        console.error('[SYNC] Failed to fetch page due to 403 after retry');
                        const stage = pageResp.context || `customers_page_${pageNum}`;
                        return res.json({
                            success: false,
                            stage,
                            message: `[${stage}] تم رفض الوصول (403) أثناء جلب صفحات المشتركين. يرجى التحقق من بيانات الدخول.`
                        });
                    }
                    
                    if (pageResp.success && pageResp.data) {
                        const customersList = normalizeAlwataniCollection(pageResp.data);
                        // تصفية: فقط المشتركين الناقصين
                        const missingFromPage = customersList.filter(customer => {
                            const accountId = extractAlwataniAccountId(customer);
                            return accountId && missingIdsSet.has(String(accountId));
                        });
                        allCustomers = allCustomers.concat(missingFromPage);
                        console.log(`[SYNC] Page ${pageNum}: Found ${missingFromPage.length} missing subscribers (out of ${customersList.length} total)`);
                    }
                    
                    updateSyncProgress(id, {
                        stage: 'fetching_missing_pages',
                        current: allCustomers.length,
                        total: missingAccountIds.length,
                        message: `جاري جلب بيانات المشتركين الناقصين... ${allCustomers.length}/${missingAccountIds.length}`
                    });
                    
                    const currentPageDelay = getPageFetchBatchDelay();
                    if (currentPageDelay > 0 && pageNum < totalPages) {
                        await delay(currentPageDelay);
                    }
                }
            }
            
            console.log(`[SYNC] ✅ Fetched ${allCustomers.length} missing subscribers (out of ${missingAccountIds.length} identified)`);
        } else if (remainingPages > 0) {
            // المزامنة الكاملة: جلب جميع الصفحات
            console.log(`[SYNC] Fetching ${remainingPages} pages in parallel (${parallelPages} pages per batch)...`);
            
            for (let startPage = 2; startPage <= totalPages; startPage += parallelPages) {
                if (isSyncCancelled(id)) {
                    cancelled = true;
                    console.warn('[SYNC] ⏹️ Cancellation requested during page fetching.');
                    break;
                }
                
                const endPage = Math.min(startPage + parallelPages - 1, totalPages);
                const pagePromises = [];
                
                for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
                    pagePromises.push(
                        fetchCustomersPageWithRetry(
                            pageNum,
                            token,
                            account.username,
                            account.password,
                            sortProperty,
                            pageSize,
                            applyTokenFromResponse,
                            'customers_page'
                        )
                    );
                }
                
                const pageResults = await Promise.all(pagePromises);
                
                let pagesFetchedInBatch = 0;
                for (let i = 0; i < pageResults.length; i++) {
                    const pageResult = pageResults[i];
                    const currentPageNum = startPage + i;
                    
                    if (pageResult.statusCode === 403 && !pageResult.success) {
                        console.error('[SYNC] Failed to fetch page due to 403 after retry');
                        const stage = pageResult.context || `customers_page_${currentPageNum}`;
                        return res.json({
                            success: false,
                            stage,
                            message: `[${stage}] تم رفض الوصول (403) أثناء جلب صفحات المشتركين. يرجى التحقق من بيانات الدخول.`
                        });
                    }

                    if (pageResult.success && pageResult.data) {
                        const customersList = normalizeAlwataniCollection(pageResult.data);
                        allCustomers = allCustomers.concat(customersList);
                        console.log(`[SYNC] Fetched page ${currentPageNum}: ${customersList.length} subscribers`);
                        pagesFetchedInBatch++;
                    } else {
                        if (isRateLimitRedirect(pageResult)) {
                            console.warn(`[SYNC] Rate limit prevented fetching page ${currentPageNum} after retries.`);
                        }
                        console.error(`[SYNC] Failed to fetch page ${currentPageNum}:`, pageResult.message);
                    }
                }
                
                // تحديث حالة التقدم بعد جلب كل batch
                const lastPageInBatch = Math.min(startPage + pageResults.length - 1, totalPages);
                updateSyncProgress(id, {
                    stage: 'fetching_pages',
                    current: lastPageInBatch,
                    total: totalPages,
                    message: `Fetching subscriber pages... Page ${lastPageInBatch}/${totalPages} (${pagesFetchedInBatch} successful in this batch)`
                });
                
                const currentPageDelay = getPageFetchBatchDelay();
                if (currentPageDelay > 0 && lastPageInBatch < totalPages) {
                    await delay(currentPageDelay);
                }
            }
        }

        if (cancelled) {
            updateSyncProgress(id, {
                stage: 'cancelled',
                message: 'تم إيقاف المزامنة أثناء جلب صفحات المشتركين',
                cancelRequested: true
            });
            return res.json({
                success: true,
                cancelled: true,
                message: 'تم إيقاف العملية أثناء جلب الصفحات'
            });
        }

        const totalFetched = allCustomers.length;
        if (useSmartSync) {
            console.log(`[SYNC] ✅ Smart sync: Fetched ${totalFetched} missing subscribers (out of ${missingAccountIds.length} identified)`);
        } else {
            console.log(`[SYNC] ✅ Fetched ${totalFetched} subscribers from all pages`);
        }
        
        // تحديث حالة التقدم بعد جلب جميع الصفحات
        updateSyncProgress(id, {
            stage: 'pages_complete',
            current: totalPages,
            total: totalPages,
            message: `✅ تم جلب جميع الصفحات (${totalPages} صفحة، ${totalFetched} مشترك) - جاري جلب العناوين...`
        });

        // ========== المرحلة 1: جلب العناوين ==========
        const accountIds = Array.from(new Set(allCustomers
            .map((customer) => extractAlwataniAccountId(customer))
            .filter((value) => value !== null && value !== undefined)
            .map((value) => String(value))
        ));

        updateSyncProgress(id, {
            stage: 'fetching_addresses',
            current: 0,
            total: accountIds.length,
            message: `جاري جلب العناوين لـ ${accountIds.length} مشترك...`
        });

        const addressesResp = await fetchAlwataniResource(
            `/api/addresses?${accountIds.map(id => `accountIds=${encodeURIComponent(id)}`).join('&')}`,
            token,
            'GET',
            true,
            account.username,
            account.password,
            'addresses_bulk'
        );
        applyTokenFromResponse(addressesResp);

        if (addressesResp.statusCode === 403 && !addressesResp.success) {
            const stage = addressesResp.context || 'addresses_bulk';
            return res.json({
                success: false,
                stage,
                message: `[${stage}] تم رفض الوصول (403) أثناء جلب عناوين المشتركين. يرجى التحقق من بيانات الدخول.`
            });
        }
        
        const addressMap = buildAlwataniAddressMap(addressesResp.data || {});

        updateSyncProgress(id, {
            stage: 'addresses_complete',
            current: accountIds.length,
            total: accountIds.length,
            message: `✅ تم جلب العناوين - جاري تحضير البيانات...`
        });

        // تحضير البيانات الأساسية (بدون تفاصيل من صفحات المشتركين بعد)
        const combinedRecords = [];
        for (const customer of allCustomers) {
            const accountId = extractAlwataniAccountId(customer);
            if (!accountId) continue;

            const combined = buildCombinedCustomerRecord(customer, addressMap);
            combinedRecords.push({
                accountId: String(accountId),
                partnerId,
                record: combined
            });
        }

        console.log(`[SYNC] ✅ Prepared ${combinedRecords.length} subscribers. Now starting to fetch details from subscriber pages...`);
        
        // التحقق من البيانات الموجودة في قاعدة البيانات (مزامنة ذكية)
        let recordsToEnrich = combinedRecords;
        let skippedCount = 0;
        let existingCustomersMap = new Map();
        
        if (!forceFullSync) {
            console.log(`[SYNC] 🔍 Smart sync: Checking existing data...`);
            const [existingRecords] = await alwataniPool.query(
                'SELECT account_id, customer_data FROM alwatani_customers_cache WHERE partner_id = ?',
                [partnerId]
            );
            
            // إنشاء خريطة للمشتركين الموجودين مع بياناتهم
            existingRecords.forEach(row => {
                try {
                    const customerData = typeof row.customer_data === 'string' 
                        ? JSON.parse(row.customer_data) 
                        : row.customer_data;
                    const accountId = String(row.account_id);
                    
                    // التحقق من وجود بيانات كاملة (خاصة رقم الهاتف وusername)
                    const hasPhone = customerData?.phone && 
                                    customerData?.phone.trim() !== '' && 
                                    customerData?.phone !== '--' &&
                                    customerData?.phone !== null;
                    
                    const hasUsername = customerData?.username && 
                                       customerData?.username.trim() !== '' && 
                                       customerData?.username !== '--' &&
                                       customerData?.username !== null;
                    
                    const hasCompleteData = hasPhone && hasUsername;
                    
                    existingCustomersMap.set(accountId, {
                        exists: true,
                        hasCompleteData,
                        hasPhone,
                        data: customerData
                    });
                } catch (e) {
                    console.error(`[SYNC] Error reading subscriber data ${row.account_id}:`, e.message);
                }
            });
            
            // فلترة المشتركين: فقط الجدد أو الذين ينقصهم البيانات
            recordsToEnrich = combinedRecords.filter(item => {
                const accountId = String(item.accountId);
                const existing = existingCustomersMap.get(accountId);
                
                if (!existing) {
                    // مشترك جديد - يحتاج جلب التفاصيل
                    return true;
                }
                
                if (!existing.hasCompleteData) {
                    // موجود لكن البيانات غير مكتملة - يحتاج تحديث
                    // لا نطبع رسالة لكل مشترك لتقليل الضوضاء - فقط في النهاية
                    return true;
                }
                
                // موجود وبياناته كاملة - يتم تخطيه
                return false;
            });
            
            skippedCount = combinedRecords.length - recordsToEnrich.length;
        } else {
            console.log(`[SYNC] 🔄 Full sync: Will fetch details for all subscribers (forceFullSync enabled)`);
        }
        
        const toEnrichCount = recordsToEnrich.length;
        
        if (skippedCount > 0) {
            console.log(`[SYNC] 📊 Stats: ${toEnrichCount} need details, ${skippedCount} will be skipped (exists with complete data)`);
        } else {
            console.log(`[SYNC] 📊 Stats: ${toEnrichCount} subscribers need details`);
        }
        
        // تحديث حالة التقدم قبل بدء جلب التفاصيل
        updateSyncProgress(id, {
            stage: 'enriching',
            current: 0,
            total: toEnrichCount,
            message: skippedCount > 0 
                ? `جاري جلب تفاصيل ${toEnrichCount} مشترك (تم تخطي ${skippedCount} موجودين)...`
                : `جاري جلب تفاصيل ${toEnrichCount} مشترك...`
        });
        
        // تحديث السجلات المخطاة بالبيانات الموجودة (فقط في المزامنة الذكية)
        if (!forceFullSync && skippedCount > 0) {
            combinedRecords.forEach(item => {
                const accountId = String(item.accountId);
                const existing = existingCustomersMap.get(accountId);
                
                if (existing && existing.hasCompleteData && existing.data) {
                    // نسخ البيانات الكاملة من الكاش
                    Object.assign(item.record, existing.data);
                }
            });
        }
        
        // جلب التفاصيل فقط للمشتركين الجدد أو غير المكتملين
        if (toEnrichCount > 0) {
            // إضافة userId إلى records قبل إرسالها
            recordsToEnrich.forEach(item => {
                item.userId = id; // استخدام id من req.params (alwatani_login.id)
            });
            const enrichResult = await enrichCustomersWithDetails(recordsToEnrich, tokenRef, account.username, account.password, id, alwataniPool);
            
            if (enrichResult?.cancelled || isSyncCancelled(id)) {
                updateSyncProgress(id, {
                    stage: 'cancelled',
                    current: enrichResult?.processed || 0,
                    total: toEnrichCount,
                    message: `تم إيقاف جلب التفاصيل بعد معالجة ${enrichResult?.processed || 0} من ${toEnrichCount}`,
                    phoneFound: enrichResult?.phoneFoundCount || 0,
                    cancelRequested: true
                });
                return res.json({
                    success: true,
                    cancelled: true,
                    message: 'تم إيقاف جلب التفاصيل حسب الطلب',
                    processed: enrichResult?.processed || 0,
                    phones: enrichResult?.phoneFoundCount || 0
                });
            }
        } else {
            console.log(`[SYNC] ✅ All subscribers exist with complete data - no need to fetch details`);
            updateSyncProgress(id, {
                stage: 'enriching',
                current: 0,
                total: 0,
                message: `✅ جميع المشتركين موجودين وبياناتهم مكتملة`
            });
        }
        
        if (isSyncCancelled(id)) {
            updateSyncProgress(id, {
                stage: 'cancelled',
                message: 'تم إيقاف العملية قبل مرحلة الحفظ',
                cancelRequested: true
            });
            return res.json({
                success: true,
                cancelled: true,
                message: 'تم إيقاف العملية قبل الحفظ'
            });
        }
        token = tokenRef.value;
        
        // تحديث حالة التقدم بعد انتهاء جلب التفاصيل
        const finalProgress = getSyncProgress(id);
        updateSyncProgress(id, {
            stage: 'saving',
            current: 0, // Reset to 0 for saving stage
            total: combinedRecords.length,
            message: `تم جلب التفاصيل - جاري الحفظ في قاعدة البيانات...`,
            phoneFound: finalProgress?.phoneFound || 0
        });

        const customersToSave = combinedRecords.map((item) => ({
            accountId: item.accountId,
            partnerId: item.partnerId,
            customerData: JSON.stringify(item.record)
        }));

        console.log(`[SYNC] Preparing ${customersToSave.length} subscribers to save to database...`);

        // تحديث حالة التقدم عند بدء الحفظ
        updateSyncProgress(id, {
            stage: 'saving',
            current: 0,
            total: customersToSave.length,
            message: `جاري الحفظ في قاعدة البيانات... 0/${customersToSave.length}`
        });

        // التحقق من بنية الجدول
        let hasPartnerId = false;
        let hasCustomerData = false;
        try {
            const [columns] = await alwataniPool.query(`
                SELECT COLUMN_NAME 
                FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_SCHEMA = DATABASE() 
                AND TABLE_NAME = 'alwatani_customers_cache'
            `);
            const columnNames = columns.map(c => c.COLUMN_NAME);
            hasPartnerId = columnNames.includes('partner_id');
            hasCustomerData = columnNames.includes('customer_data');
            console.log(`[SYNC] Table structure: hasPartnerId=${hasPartnerId}, hasCustomerData=${hasCustomerData}`);
        } catch (e) {
            console.warn('[SYNC] Could not check table structure:', e.message);
        }

        // الحصول على عدد السجلات الموجودة قبل المزامنة
        let beforeTotal = 0;
        if (hasPartnerId) {
        const [beforeCount] = await alwataniPool.query(
            'SELECT COUNT(*) as total FROM alwatani_customers_cache WHERE partner_id = ?',
            [partnerId]
        );
            beforeTotal = beforeCount[0]?.total || 0;
        } else {
            const [beforeCount] = await alwataniPool.query(
                'SELECT COUNT(*) as total FROM alwatani_customers_cache'
            );
            beforeTotal = beforeCount[0]?.total || 0;
        }

        // حفظ البيانات بشكل batch باستخدام INSERT ... ON DUPLICATE KEY UPDATE
        const batchSize = 50; // حفظ 50 مشترك في كل batch (تقليل من 100 لتجنب أخطاء SQL)
        let processedCount = 0;

        for (let i = 0; i < customersToSave.length; i += batchSize) {
            const batch = customersToSave.slice(i, i + batchSize);

            try {
                if (hasPartnerId && hasCustomerData) {
                    // البنية الجديدة: partner_id + customer_data (JSON)
            const values = [];
            const placeholders = [];
            for (const customer of batch) {
                values.push(customer.accountId, customer.partnerId, customer.customerData);
                placeholders.push('(?, ?, ?, CURRENT_TIMESTAMP)');
            }
                const query = `
                    INSERT INTO alwatani_customers_cache (account_id, partner_id, customer_data, synced_at) 
                    VALUES ${placeholders.join(', ')}
                    ON DUPLICATE KEY UPDATE 
                        customer_data = VALUES(customer_data),
                        updated_at = CURRENT_TIMESTAMP
                `;
                await alwataniPool.query(query, values);
                } else {
                    // البنية القديمة: أعمدة منفصلة
                    for (const customer of batch) {
                        const record = typeof customer.customerData === 'string' 
                            ? JSON.parse(customer.customerData) 
                            : customer.customerData;
                        
                        await alwataniPool.query(
                            `INSERT INTO alwatani_customers_cache 
                             (account_id, username, device_name, phone, region, page_url, start_date, end_date, status, created_at) 
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                             ON DUPLICATE KEY UPDATE 
                                username = VALUES(username),
                                device_name = VALUES(device_name),
                                phone = VALUES(phone),
                                region = VALUES(region),
                                page_url = VALUES(page_url),
                                start_date = VALUES(start_date),
                                end_date = VALUES(end_date),
                                status = VALUES(status),
                                updated_at = CURRENT_TIMESTAMP`,
                            [
                                record.accountId || record.account_id,
                                record.username,
                                record.deviceName || record.device_name,
                                record.phone,
                                record.zone || record.region,
                                record.page_url,
                                record.startDate || record.start_date,
                                record.endDate || record.end_date,
                                record.status
                            ]
                        );
                    }
                }
                
                processedCount += batch.length;
                
                // تحديث حالة التقدم أثناء الحفظ
                const progress = getSyncProgress(id);
                if (progress) {
                    updateSyncProgress(id, {
                        stage: 'saving',
                        current: processedCount,
                        total: customersToSave.length,
                        message: `جاري الحفظ في قاعدة البيانات... ${processedCount}/${customersToSave.length}`,
                        phoneFound: progress.phoneFound || 0
                    });
                }
                
                console.log(`[SYNC] Saved batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(customersToSave.length / batchSize)}: ${batch.length} subscribers`);
            } catch (err) {
                console.error(`[SYNC] Error saving batch ${Math.floor(i / batchSize) + 1}:`, err.message);
                console.error(`[SYNC] Error details:`, err);
                // في حالة الخطأ، نعود للحفظ واحد تلو الآخر لهذا batch
                console.log(`[SYNC] Attempting to save batch ${Math.floor(i / batchSize) + 1} one by one...`);
                for (const customer of batch) {
                    try {
                        if (hasPartnerId && hasCustomerData) {
                        await alwataniPool.query(
                            `INSERT INTO alwatani_customers_cache (account_id, partner_id, customer_data) 
                             VALUES (?, ?, ?) 
                             ON DUPLICATE KEY UPDATE 
                                 customer_data = VALUES(customer_data),
                                 updated_at = CURRENT_TIMESTAMP`,
                            [customer.accountId, customer.partnerId, customer.customerData]
                        );
                        } else {
                            const record = typeof customer.customerData === 'string' 
                                ? JSON.parse(customer.customerData) 
                                : customer.customerData;
                            await alwataniPool.query(
                                `INSERT INTO alwatani_customers_cache 
                                 (account_id, username, device_name, phone, region, page_url, start_date, end_date, status) 
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                 ON DUPLICATE KEY UPDATE 
                                    username = VALUES(username),
                                    device_name = VALUES(device_name),
                                    phone = VALUES(phone),
                                    region = VALUES(region),
                                    page_url = VALUES(page_url),
                                    start_date = VALUES(start_date),
                                    end_date = VALUES(end_date),
                                    status = VALUES(status),
                                    updated_at = CURRENT_TIMESTAMP`,
                                [
                                    record.accountId || record.account_id,
                                    record.username,
                                    record.deviceName || record.device_name,
                                    record.phone,
                                    record.zone || record.region,
                                    record.page_url,
                                    record.startDate || record.start_date,
                                    record.endDate || record.end_date,
                                    record.status
                                ]
                            );
                        }
                        processedCount++;
                    } catch (singleErr) {
                        console.error(`[SYNC] Error saving subscriber ${customer.accountId}:`, singleErr.message);
                    }
                }
            }
        }

        // حساب العدد الفعلي بعد المزامنة
        let afterTotal = 0;
        if (hasPartnerId) {
        const [afterCount] = await alwataniPool.query(
            'SELECT COUNT(*) as total FROM alwatani_customers_cache WHERE partner_id = ?',
            [partnerId]
        );
            afterTotal = afterCount[0]?.total || 0;
        } else {
            const [afterCount] = await alwataniPool.query(
                'SELECT COUNT(*) as total FROM alwatani_customers_cache'
            );
            afterTotal = afterCount[0]?.total || 0;
        }
        
        // حساب عدد السجلات الجديدة والمحدثة
        const savedCount = Math.max(0, afterTotal - beforeTotal);
        const updatedCount = processedCount - savedCount;

        console.log(`[SYNC] ✅ Sync completed: ${savedCount} new, ${updatedCount} updated`);

        // تحديث حالة التقدم النهائية
        const progress = getSyncProgress(id);
        if (progress) {
            updateSyncProgress(id, {
                stage: 'completed',
                current: progress.total || totalFetched,
                total: progress.total || totalFetched,
                message: `✅ اكتملت المزامنة: ${savedCount} جديد، ${updatedCount} محدث`,
                phoneFound: progress.phoneFound || 0
            });
        }

        res.json({
            success: true,
            message: `تمت المزامنة بنجاح`,
            stats: {
                totalFetched,
                saved: savedCount,
                updated: updatedCount,
                total: savedCount + updatedCount
            }
        });
    } catch (error) {
        console.error('[SYNC] Error syncing subscribers:', error);
        console.error('[SYNC] Error details:', {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        // تحديث حالة التقدم عند حدوث خطأ
        updateSyncProgress(id, {
            stage: 'error',
            message: 'فشلت المزامنة: ' + (error.message || 'خطأ غير معروف')
        });
        
        res.status(500).json({
            success: false,
            message: 'خطأ في مزامنة المشتركين: ' + (error.message || 'خطأ غير معروف')
        });
    }
});

app.post('/api/alwatani-login/:id/customers/sync/stop', (req, res) => {
    const { id } = req.params;
    const progress = getSyncProgress(id);
    if (!progress) {
        return res.json({
            success: false,
            message: 'لا توجد عملية مزامنة جارية لهذا الحساب'
        });
    }
    
    if (progress.cancelRequested) {
        return res.json({
            success: true,
            message: 'تم طلب الإيقاف مسبقاً، يرجى الانتظار...'
        });
    }
    
    requestSyncCancellation(id, 'تم طلب إيقاف المزامنة من الواجهة');
    return res.json({
        success: true,
        message: 'سيتم إيقاف جلب البيانات خلال لحظات ويتم حفظ ما تم جمعه.'
    });
});

// Get sync progress endpoint
app.get('/api/alwatani-login/:id/customers/sync-progress', async (req, res) => {
    try {
        const { id } = req.params;
        const progress = getSyncProgress(id);
        
        if (!progress) {
            return res.json({
                success: false,
                message: 'لا توجد عملية مزامنة نشطة'
            });
        }
        
        res.json({
            success: true,
            progress: {
                stage: progress.stage || 'unknown',
                current: progress.current || 0,
                total: progress.total || 0,
                message: progress.message || '',
                phoneFound: progress.phoneFound || 0,
                startedAt: progress.startedAt,
                updatedAt: progress.updatedAt,
                percentage: progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0
            }
        });
    } catch (error) {
        console.error('Get sync progress error:', error);
        res.status(500).json({
            success: false,
            message: 'خطأ في جلب حالة المزامنة: ' + error.message
        });
    }
});

// Get cached customers from local database
app.get('/api/alwatani-login/:id/customers/cache', async (req, res) => {
    try {
        const { id } = req.params;
        const ownerUsername = req.query.username || req.headers['x-username'];
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'اسم المستخدم (username) مطلوب' 
            });
        }
        
        // الحصول على قاعدة البيانات الخاصة بالمالك
        const ownerPool = await dbManager.getPoolFromUsername(ownerUsername);
        
        const [accounts] = await ownerPool.query(
            'SELECT id, username, password, user_id FROM alwatani_login WHERE id = ?',
            [id]
        );

        if (accounts.length === 0) {
            return res.status(404).json({ success: false, message: 'الحساب غير موجود' });
        }

        const userId = accounts[0].user_id;
        if (!userId) {
            return res.status(400).json({ 
                success: false, 
                message: 'حساب الوطني غير مربوط بمستخدم. يرجى ربطه بمستخدم أولاً.' 
            });
        }

        console.log(`[CACHE] Fetching cache for account ${id}, username: ${accounts[0].username}, userId: ${userId}`);
        const verification = await verifyAlwataniAccount(accounts[0].username, accounts[0].password);
        let partnerId = null;
        if (verification.success && verification.data) {
            partnerId = verification.data?.AccountId || verification.data?.account_id || null;
            if (!partnerId) {
                const currentUserResp = await fetchAlwataniResource('/api/current-user', verification.data?.access_token);
                if (currentUserResp.success && currentUserResp.data) {
                    const userData = currentUserResp.data.model || currentUserResp.data;
                    partnerId = userData?.self?.id || userData?.AccountId || null;
                }
            }
        }

        // الحصول على pool لقاعدة بيانات الوطني
        const alwataniUsername = accounts[0].username;
        const alwataniPool = await dbManager.getAlwataniPool(alwataniUsername);
        
        console.log(`[CACHE] Querying cache for alwatani: ${alwataniUsername}, partnerId: ${partnerId || 'N/A'}`);
        
        // دعم pagination
        const pageNumber = parseInt(req.query.pageNumber) || 1;
        const pageSize = parseInt(req.query.pageSize) || 100;
        const offset = (pageNumber - 1) * pageSize;
        
        // التحقق من وجود عمود partner_id في الجدول - محاولة مباشرة أولاً
        let hasPartnerId = false;
        let hasCustomerData = false;
        
        // محاولة جلب عمود واحد باستخدام partner_id - إذا نجح، العمود موجود
        if (partnerId) {
            try {
                await alwataniPool.query(
                    'SELECT COUNT(*) as total FROM alwatani_customers_cache WHERE partner_id = ? LIMIT 1',
            [partnerId]
        );
                hasPartnerId = true;
                console.log('[CACHE] Table has partner_id column');
            } catch (e) {
                hasPartnerId = false;
                console.log('[CACHE] Table does not have partner_id column, using old structure');
            }
        } else {
            console.log('[CACHE] No partnerId available, using old structure');
        }
        
        // التحقق من وجود customer_data
        try {
            await alwataniPool.query(
                'SELECT customer_data FROM alwatani_customers_cache LIMIT 1'
            );
            hasCustomerData = true;
        } catch (e) {
            hasCustomerData = false;
        }
        
        let countResult, rows;
        
        if (hasPartnerId && hasCustomerData) {
            // البنية الجديدة: partner_id + customer_data (JSON)
            [countResult] = await alwataniPool.query(
                'SELECT COUNT(*) as total FROM alwatani_customers_cache WHERE partner_id = ?',
                [partnerId]
            );
            [rows] = await alwataniPool.query(
                'SELECT customer_data, synced_at FROM alwatani_customers_cache WHERE partner_id = ? ORDER BY synced_at DESC LIMIT ? OFFSET ?',
                [partnerId, pageSize, offset]
            );
        } else {
            // البنية القديمة: أعمدة منفصلة (بدون partner_id)
            [countResult] = await alwataniPool.query(
                'SELECT COUNT(*) as total FROM alwatani_customers_cache'
            );
            [rows] = await alwataniPool.query(
                'SELECT account_id, username, device_name, phone, region, page_url, start_date, end_date, status, created_at as synced_at FROM alwatani_customers_cache ORDER BY created_at DESC LIMIT ? OFFSET ?',
                [pageSize, offset]
            );
        }
        
        const total = countResult[0].total;

        console.log(`[CACHE] Found ${total} total records, returning ${rows.length} for page ${pageNumber}`);

        const customers = rows.map(row => {
            try {
                // إذا كان الجدول يحتوي على customer_data (JSON)
                if (row.customer_data) {
                return typeof row.customer_data === 'string' 
                    ? JSON.parse(row.customer_data) 
                    : row.customer_data;
                } else {
                    // إذا كان الجدول يحتوي على أعمدة منفصلة، بناء object
                    return {
                        accountId: row.account_id,
                        account_id: row.account_id,
                        username: row.username,
                        deviceName: row.device_name,
                        device_name: row.device_name,
                        phone: row.phone,
                        zone: row.region,
                        region: row.region,
                        page_url: row.page_url,
                        start_date: row.start_date,
                        startDate: row.start_date,
                        end_date: row.end_date,
                        endDate: row.end_date,
                        status: row.status
                    };
                }
            } catch (e) {
                console.error('[CACHE] Error parsing customer data:', e);
                return null;
            }
        }).filter(c => c !== null);

        // جلب آخر وقت تحديث
        let lastSyncRow;
        if (hasPartnerId && hasCustomerData) {
            [lastSyncRow] = await alwataniPool.query(
            'SELECT MAX(synced_at) as last_sync FROM alwatani_customers_cache WHERE partner_id = ?',
            [partnerId]
        );
        } else {
            [lastSyncRow] = await alwataniPool.query(
                'SELECT MAX(created_at) as last_sync FROM alwatani_customers_cache'
            );
        }

        console.log(`[CACHE] Returning ${customers.length} customers`);

        res.json({
            success: true,
            customers: customers,
            total: total,
            pageNumber: pageNumber,
            pageSize: pageSize,
            totalPages: Math.ceil(total / pageSize),
                lastSync: lastSyncRow[0]?.last_sync || null
        });
    } catch (error) {
        console.error('Get cached customers error:', error);
        res.status(500).json({
            success: false,
            message: 'خطأ في جلب البيانات المحلية: ' + error.message
        });
    }
});

// Get sync status
app.get('/api/alwatani-login/:id/customers/sync-status', async (req, res) => {
    try {
        const { id } = req.params;
        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        const [accounts] = await ownerPool.query(
            'SELECT id, username, password, user_id FROM alwatani_login WHERE id = ?',
            [id]
        );

        if (accounts.length === 0) {
            return res.status(404).json({ success: false, message: 'الحساب غير موجود' });
        }

        const userId = accounts[0].user_id;
        if (!userId) {
            return res.status(400).json({ 
                success: false, 
                message: 'حساب الوطني غير مربوط بمستخدم. يرجى ربطه بمستخدم أولاً.' 
            });
        }

        const verification = await verifyAlwataniAccount(accounts[0].username, accounts[0].password);
        let partnerId = null;
        if (verification.success && verification.data) {
            partnerId = verification.data?.AccountId || verification.data?.account_id || null;
            if (!partnerId) {
                const currentUserResp = await fetchAlwataniResource('/api/current-user', verification.data?.access_token);
                if (currentUserResp.success && currentUserResp.data) {
                    const userData = currentUserResp.data.model || currentUserResp.data;
                    partnerId = userData?.self?.id || userData?.AccountId || null;
                }
            }
        }

        if (!partnerId) {
            return res.json({
                success: false,
                message: 'لم يتم تحديد معرف الشريك'
            });
        }

        // الحصول على pool لقاعدة بيانات الوطني
        const alwataniUsername = accounts[0].username;
        const alwataniPool = await dbManager.getAlwataniPool(alwataniUsername);
        
        const [stats] = await alwataniPool.query(
            'SELECT COUNT(*) as total, MAX(synced_at) as last_sync FROM alwatani_customers_cache WHERE partner_id = ?',
            [partnerId]
        );

        res.json({
            success: true,
            status: {
                totalCached: stats[0].total || 0,
                lastSync: stats[0].last_sync || null
            }
        });
    } catch (error) {
        console.error('Get sync status error:', error);
        res.status(500).json({
            success: false,
            message: 'خطأ في جلب حالة المزامنة: ' + error.message
        });
    }
});

// Get sync progress endpoint (for progress bar/counter)
app.get('/api/alwatani-login/:id/customers/sync-progress', async (req, res) => {
    try {
        const { id } = req.params;
        const progress = getSyncProgress(id);
        
        if (!progress) {
            return res.json({
                success: false,
                message: 'لا توجد عملية مزامنة نشطة'
            });
        }
        
        res.json({
            success: true,
            progress: {
                stage: progress.stage || 'unknown',
                current: progress.current || 0,
                total: progress.total || 0,
                message: progress.message || '',
                phoneFound: progress.phoneFound || 0,
                startedAt: progress.startedAt,
                updatedAt: progress.updatedAt,
                percentage: progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0
            }
        });
    } catch (error) {
        console.error('Get sync progress error:', error);
        res.status(500).json({
            success: false,
            message: 'خطأ في جلب حالة المزامنة: ' + error.message
        });
    }
});

// Get aggregated data for a specific Alwatani account
app.get('/api/alwatani-login/:id/details', async (req, res) => {
    try {
        const { id } = req.params;
        const [accounts] = await pool.query(
            'SELECT id, username, password FROM alwatani_login WHERE id = ?',
            [id]
        );

        if (accounts.length === 0) {
            return res.status(404).json({ success: false, message: 'الحساب غير موجود' });
        }

        const account = accounts[0];
        const verification = await verifyAlwataniAccount(account.username, account.password);

        if (!verification.success) {
            return res.json({
                success: false,
                message: verification.message || '❌ فشل التحقق من الحساب'
            });
        }

        const token = verification.data?.access_token;

        if (!token) {
            return res.json({
                success: false,
                message: 'لم يتم استلام رمز الوصول من الموقع الخارجي'
            });
        }

        let partnerId = verification.data?.AccountId || verification.data?.account_id || null;

        let currentUserResp = await fetchAlwataniResource('/api/current-user', token, 'GET', true, account.username, account.password);
        
        // إذا كان 403، حاول مرة أخرى مع token جديد
        if (currentUserResp.statusCode === 403) {
            console.log('[DETAILS] 403 Forbidden - Attempting to re-verify account...');
            const reVerification = await verifyAlwataniAccount(account.username, account.password);
            if (reVerification.success && reVerification.data?.access_token) {
                token = reVerification.data.access_token;
                console.log('[DETAILS] ✅ Got new token, retrying...');
                currentUserResp = await fetchAlwataniResource('/api/current-user', token);
            }
        }
        
        let currentUserModel = null;
        if (currentUserResp.success) {
            const userData = currentUserResp.data || {};
            currentUserModel = userData.model || userData;
            if (currentUserModel) {
                partnerId = partnerId ||
                    currentUserModel.AccountId ||
                    currentUserModel.accountId ||
                    currentUserModel?.self?.accountId ||
                    currentUserModel?.self?.id ||
                    null;
            }
        }

        const [
            dashboardSummaryResp,
            tasksSummaryResp,
            requestsSummaryResp,
            ticketsSummaryResp
        ] = await Promise.all([
            fetchAlwataniResource('/api/partners/dashboard/summary?hierarchyLevel=0', token, 'GET', true, account.username, account.password),
            fetchAlwataniResource('/api/tasks/summary?hierarchyLevel=0', token, 'GET', true, account.username, account.password),
            fetchAlwataniResource('/api/requests/summary?hierarchyLevel=0', token, 'GET', true, account.username, account.password),
            fetchAlwataniResource('/api/support/tickets/summary?hierarchyLevel=0', token, 'GET', true, account.username, account.password)
        ]);

        // التحقق من وجود 403 في أي من النتائج
        let has403 = false;
        for (const resp of [dashboardSummaryResp, tasksSummaryResp, requestsSummaryResp, ticketsSummaryResp]) {
            if (resp.statusCode === 403) {
                has403 = true;
                break;
            }
        }
        
        // إذا كان هناك 403، أعد التحقق من الحساب
        if (has403) {
            console.log('[DETAILS] 403 detected - Re-verifying account...');
            const reVerification = await verifyAlwataniAccount(account.username, account.password);
            if (reVerification.success && reVerification.data?.access_token) {
                token = reVerification.data.access_token;
                console.log('[DETAILS] ✅ Got new token, re-fetching data...');
                // إعادة جلب البيانات مع token جديد
                const [retryDashboard, retryTasks, retryRequests, retryTickets] = await Promise.all([
                    fetchAlwataniResource('/api/partners/dashboard/summary?hierarchyLevel=0', token),
                    fetchAlwataniResource('/api/tasks/summary?hierarchyLevel=0', token),
                    fetchAlwataniResource('/api/requests/summary?hierarchyLevel=0', token),
                    fetchAlwataniResource('/api/support/tickets/summary?hierarchyLevel=0', token)
                ]);
                dashboardSummaryResp.data = retryDashboard.data || dashboardSummaryResp.data;
                tasksSummaryResp.data = retryTasks.data || tasksSummaryResp.data;
                requestsSummaryResp.data = retryRequests.data || requestsSummaryResp.data;
                ticketsSummaryResp.data = retryTickets.data || ticketsSummaryResp.data;
            }
        }

        let walletResp = { success: false, statusCode: null, data: null };
        let transactionsResp = { success: false, statusCode: null, data: null };

        if (partnerId) {
            walletResp = await fetchAlwataniResource(`/api/partners/${partnerId}/wallets/balance`, token, 'GET', true, account.username, account.password);
            if (walletResp.statusCode === 403) {
                const reVerification = await verifyAlwataniAccount(account.username, account.password);
                if (reVerification.success && reVerification.data?.access_token) {
                    token = reVerification.data.access_token;
                    walletResp = await fetchAlwataniResource(`/api/partners/${partnerId}/wallets/balance`, token);
                }
            }
            
            transactionsResp = await fetchAlwataniResource(
                `/api/transactions?pageSize=3&pageNumber=1&sortCriteria.property=occuredAt&sortCriteria.direction=desc&walletType=Main&hierarchyLevel=1&walletOwnerType=Partner&partnerId=${partnerId}`,
                token,
                'GET',
                true,
                account.username,
                account.password
            );
            if (transactionsResp.statusCode === 403) {
                const reVerification = await verifyAlwataniAccount(account.username, account.password);
                if (reVerification.success && reVerification.data?.access_token) {
                    token = reVerification.data.access_token;
                    transactionsResp = await fetchAlwataniResource(
                        `/api/transactions?pageSize=3&pageNumber=1&sortCriteria.property=occuredAt&sortCriteria.direction=desc&walletType=Main&hierarchyLevel=1&walletOwnerType=Partner&partnerId=${partnerId}`,
                        token
                    );
                }
            }
        }

        res.json({
            success: true,
            partnerId,
            data: {
                currentUser: currentUserModel || currentUserResp.data || null,
                walletBalance: walletResp.data || null,
                dashboardSummary: dashboardSummaryResp.data || null,
                tasksSummary: tasksSummaryResp.data || null,
                requestsSummary: requestsSummaryResp.data || null,
                ticketsSummary: ticketsSummaryResp.data || null,
                transactions: transactionsResp.data || null
            },
            meta: {
                statuses: {
                    currentUser: currentUserResp.statusCode,
                    wallet: walletResp.statusCode,
                    dashboard: dashboardSummaryResp.statusCode,
                    tasks: tasksSummaryResp.statusCode,
                    requests: requestsSummaryResp.statusCode,
                    tickets: ticketsSummaryResp.statusCode,
                    transactions: transactionsResp.statusCode
                }
            }
        });
    } catch (error) {
        console.error('Fetch Alwatani details error:', error);
        res.status(500).json({
            success: false,
            message: 'خطأ في جلب بيانات الوطني'
        });
    }
});

// ================= Wallet Routes =================

// Get wallet balance
app.get('/api/alwatani-login/:id/wallet/balance', async (req, res) => {
    try {
        const { id } = req.params;
        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        const [accounts] = await ownerPool.query(
            'SELECT id, username, password FROM alwatani_login WHERE id = ?',
            [id]
        );

        if (accounts.length === 0) {
            return res.status(404).json({ success: false, message: 'الحساب غير موجود' });
        }

        const account = accounts[0];
        
        // الحصول على pool لقاعدة بيانات الوطني
        const alwataniPool = await dbManager.getAlwataniPool(account.username);
        
        const verification = await verifyAlwataniAccount(account.username, account.password, {
            maxAttempts: 3,
            retryDelay: 5000
        });

        if (!verification.success) {
            return res.json({
                success: false,
                message: verification.message || '❌ فشل التحقق من الحساب'
            });
        }

        let token = verification.data?.access_token;
        if (!token) {
            return res.json({
                success: false,
                message: 'لم يتم استلام رمز الوصول من الموقع الخارجي'
            });
        }

        let partnerId = verification.data?.AccountId || verification.data?.account_id || null;

        // جلب بيانات المستخدم الحالي لمعرفة partnerId
        const currentUserResp = await fetchAlwataniResource(
            '/api/current-user',
            token,
            'GET',
            true,
            account.username,
            account.password,
            'wallet_current_user'
        );

        if (currentUserResp.success && currentUserResp.data) {
            const userData = currentUserResp.data.model || currentUserResp.data;
            partnerId = partnerId || userData?.self?.id || userData?.AccountId || null;
        }

        if (!partnerId) {
            return res.json({
                success: false,
                message: 'لم يتم تحديد معرف الشريك (partnerId)'
            });
        }

        // جلب رصيد المحفظة
        const walletResp = await fetchAlwataniResource(
            `/api/partners/${partnerId}/wallets/balance`,
            token,
            'GET',
            true,
            account.username,
            account.password,
            'wallet_balance'
        );

        console.log(`[WALLET] Balance response for partnerId ${partnerId}:`, {
            success: walletResp.success,
            statusCode: walletResp.statusCode,
            hasData: !!walletResp.data,
            dataKeys: walletResp.data ? Object.keys(walletResp.data) : []
        });

        if (!walletResp.success) {
            const errorMsg = walletResp.message || walletResp.raw || 'فشل جلب رصيد المحفظة';
            console.error(`[WALLET] Failed to fetch balance for partnerId ${partnerId}:`, errorMsg);
            return res.json({
                success: false,
                message: errorMsg,
                statusCode: walletResp.statusCode
            });
        }

        // معالجة البيانات من مختلف الأشكال المحتملة
        let walletData = walletResp.data || walletResp.raw || {};
        
        // إذا كانت البيانات JSON string، نحولها
        if (typeof walletData === 'string') {
            try {
                walletData = JSON.parse(walletData);
            } catch (e) {
                console.warn('[WALLET] Failed to parse wallet data as JSON:', e);
                walletData = {};
            }
        }
        
        // إذا كانت البيانات في شكل nested object
        if (walletData && typeof walletData === 'object') {
            // البحث عن الرصيد في أماكن محتملة مختلفة
            const balance = walletData.balance || 
                           walletData.availableBalance || 
                           walletData.totalBalance || 
                           walletData.amount ||
                           walletData.available ||
                           walletData.data?.balance ||
                           walletData.data?.availableBalance ||
                           walletData.model?.balance ||
                           walletData.model?.availableBalance ||
                           null;
            
            // إذا وجدنا رصيد في مكان غير المتوقع، نضعه في balance
            if (balance !== null && walletData.balance === undefined) {
                walletData.balance = balance;
            }
            
            console.log('[WALLET] Extracted balance:', balance, 'from data keys:', Object.keys(walletData));
        }

        res.json({
            success: true,
            data: walletData,
            partnerId
        });
    } catch (error) {
        console.error('[WALLET] Error fetching balance:', error);
        res.status(500).json({
            success: false,
            message: 'خطأ في جلب رصيد المحفظة: ' + error.message
        });
    }
});

// Get wallet transactions
app.get('/api/alwatani-login/:id/wallet/transactions', async (req, res) => {
    try {
        const { id } = req.params;
        const pageSize = parseInt(req.query.pageSize || '10', 10);
        const pageNumber = parseInt(req.query.pageNumber || '1', 10);
        const sortProperty = req.query.sortProperty || 'occuredAt';
        const sortDirection = req.query.sortDirection || 'desc';

        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        const [accounts] = await ownerPool.query(
            'SELECT id, username, password FROM alwatani_login WHERE id = ?',
            [id]
        );

        if (accounts.length === 0) {
            return res.status(404).json({ success: false, message: 'الحساب غير موجود' });
        }

        const account = accounts[0];
        
        const verification = await verifyAlwataniAccount(account.username, account.password, {
            maxAttempts: 3,
            retryDelay: 5000
        });

        if (!verification.success) {
            return res.json({
                success: false,
                message: verification.message || '❌ فشل التحقق من الحساب'
            });
        }

        let token = verification.data?.access_token;
        if (!token) {
            return res.json({
                success: false,
                message: 'لم يتم استلام رمز الوصول من الموقع الخارجي'
            });
        }

        let partnerId = verification.data?.AccountId || verification.data?.account_id || null;

        // جلب بيانات المستخدم الحالي لمعرفة partnerId
        const currentUserResp = await fetchAlwataniResource(
            '/api/current-user',
            token,
            'GET',
            true,
            account.username,
            account.password,
            'wallet_transactions_current_user'
        );

        if (currentUserResp.success && currentUserResp.data) {
            const userData = currentUserResp.data.model || currentUserResp.data;
            partnerId = partnerId || userData?.self?.id || userData?.AccountId || null;
        }

        if (!partnerId) {
            return res.json({
                success: false,
                message: 'لم يتم تحديد معرف الشريك (partnerId)'
            });
        }

        // جلب الحوالات
        const transactionsPath = `/api/transactions?pageSize=${pageSize}&pageNumber=${pageNumber}&sortCriteria.property=${encodeURIComponent(sortProperty)}&sortCriteria.direction=${sortDirection}&hierarchyLevel=1&walletOwnerType=Partner&partnerId=${partnerId}`;
        const transactionsResp = await fetchAlwataniResource(
            transactionsPath,
            token,
            'GET',
            true,
            account.username,
            account.password,
            'wallet_transactions'
        );

        if (!transactionsResp.success) {
            return res.json({
                success: false,
                message: transactionsResp.message || 'فشل جلب الحوالات',
                statusCode: transactionsResp.statusCode
            });
        }

        const transactionsData = transactionsResp.data || {};
        
        // تسجيل بيانات الحوالات للتحقق من البنية
        console.log('[WALLET] Transactions response structure:', {
            hasData: !!transactionsData,
            dataKeys: transactionsData ? Object.keys(transactionsData) : [],
            hasItems: !!transactionsData.items,
            itemsLength: transactionsData.items ? transactionsData.items.length : 0,
            hasModels: !!transactionsData.models,
            modelsLength: transactionsData.models ? transactionsData.models.length : 0,
            fullData: JSON.stringify(transactionsData, null, 2).substring(0, 2000)
        });
        
        if (transactionsData.items && transactionsData.items.length > 0) {
            const firstTransaction = transactionsData.items[0];
            console.log('[WALLET] First transaction full structure:', JSON.stringify(firstTransaction, null, 2));
        } else if (transactionsData.models && transactionsData.models.length > 0) {
            const firstTransaction = transactionsData.models[0];
            console.log('[WALLET] First transaction (from models) full structure:', JSON.stringify(firstTransaction, null, 2));
        } else if (Array.isArray(transactionsData) && transactionsData.length > 0) {
            console.log('[WALLET] First transaction (from array) full structure:', JSON.stringify(transactionsData[0], null, 2));
        }

        // حفظ الحوالات في قاعدة البيانات
        const transactions = normalizeAlwataniCollection(transactionsData);
        if (transactions.length > 0) {
            try {
                // الحصول على pool لقاعدة بيانات الوطني
                const alwataniPool = await dbManager.getAlwataniPool(account.username);
                await saveWalletTransactionsToDB(transactions, partnerId, alwataniPool);
                console.log(`[WALLET] Saved ${transactions.length} transactions to database for partnerId ${partnerId}`);
            } catch (dbError) {
                console.error('[WALLET] Error saving transactions to database:', dbError);
                // لا نوقف العملية إذا فشل الحفظ، نكمل بإرجاع البيانات
            }
        }

        res.json({
            success: true,
            data: transactionsData,
            partnerId,
            pagination: {
                pageSize,
                pageNumber,
                sortProperty,
                sortDirection
            }
        });
    } catch (error) {
        console.error('[WALLET] Error fetching transactions:', error);
        res.status(500).json({
            success: false,
            message: 'خطأ في جلب الحوالات: ' + error.message
        });
    }
});

// Helper function to save wallet transactions to database
async function saveWalletTransactionsToDB(transactions, partnerId, alwataniPool) {
    if (!transactions || transactions.length === 0 || !partnerId || !alwataniPool) {
        if (!alwataniPool) {
            console.error('[WALLET] Missing alwataniPool - cannot save transactions');
        }
        return;
    }

    for (const transaction of transactions) {
        try {
            const transactionId = transaction.id || transaction.transaction_id;
            if (!transactionId) {
                console.warn('[WALLET] Skipping transaction without id:', transaction);
                continue;
            }

            const transactionAmount = transaction.transactionAmount?.value || 
                                    transaction.amount || 
                                    transaction.totalAmount || 
                                    0;
            const transactionType = transaction.type || 
                                  transaction.transactionType || 
                                  null;
            const occuredAt = transaction.occuredAt || 
                            transaction.occurredAt || 
                            transaction.createdAt || 
                            transaction.date || 
                            null;

            // تحويل التاريخ إلى تنسيق قاعدة البيانات
            let occuredAtFormatted = null;
            if (occuredAt) {
                try {
                    const date = new Date(occuredAt);
                    if (!isNaN(date.getTime())) {
                        occuredAtFormatted = date.toISOString().slice(0, 19).replace('T', ' ');
                    }
                } catch (e) {
                    console.warn('[WALLET] Invalid date format:', occuredAt);
                }
            }

            await alwataniPool.query(
                `INSERT INTO wallet_transactions 
                 (transaction_id, partner_id, transaction_data, transaction_type, transaction_amount, occured_at, synced_at)
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON DUPLICATE KEY UPDATE 
                    transaction_data = VALUES(transaction_data),
                    transaction_type = VALUES(transaction_type),
                    transaction_amount = VALUES(transaction_amount),
                    occured_at = VALUES(occured_at),
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    transactionId,
                    partnerId,
                    JSON.stringify(transaction),
                    transactionType,
                    transactionAmount,
                    occuredAtFormatted
                ]
            );
        } catch (error) {
            console.error(`[WALLET] Error saving transaction ${transaction.id}:`, error.message);
            // نكمل مع باقي الحوالات حتى لو فشلت واحدة
        }
    }
}

// Get wallet transactions from database
app.get('/api/alwatani-login/:id/wallet/transactions/db', async (req, res) => {
    try {
        const { id } = req.params;
        const limit = parseInt(req.query.limit || '1000', 10);
        const offset = parseInt(req.query.offset || '0', 10);

        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        const [accounts] = await ownerPool.query(
            'SELECT id, username, password FROM alwatani_login WHERE id = ?',
            [id]
        );

        if (accounts.length === 0) {
            return res.status(404).json({ success: false, message: 'الحساب غير موجود' });
        }

        // الحصول على partnerId من الحساب
        let partnerId = null;
        try {
            const verification = await verifyAlwataniAccount(accounts[0].username, accounts[0].password, {
                maxAttempts: 2,
                retryDelay: 3000
            });
            
            if (verification.success) {
                partnerId = verification.data?.AccountId || verification.data?.account_id || null;
                
                if (!partnerId) {
                    const currentUserResp = await fetchAlwataniResource(
                        '/api/current-user',
                        verification.data?.access_token,
                        'GET',
                        true,
                        accounts[0].username,
                        accounts[0].password,
                        'wallet_db_current_user'
                    );
                    
                    if (currentUserResp.success && currentUserResp.data) {
                        const userData = currentUserResp.data.model || currentUserResp.data;
                        partnerId = partnerId || userData?.self?.id || userData?.AccountId || null;
                    }
                }
            }
        } catch (e) {
            console.warn('[WALLET] Could not get partnerId, using stored transactions only:', e.message);
        }

        let query = 'SELECT transaction_data, occured_at, synced_at FROM wallet_transactions WHERE 1=1';
        const params = [];

        if (partnerId) {
            query += ' AND partner_id = ?';
            params.push(partnerId);
        }

        query += ' ORDER BY occured_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        // الحصول على pool لقاعدة بيانات الوطني
        const alwataniUsername = accounts[0].username;
        const alwataniPool = await dbManager.getAlwataniPool(alwataniUsername);
        
        const [rows] = await alwataniPool.query(query, params);

        // تحويل البيانات من JSON إلى objects
        const transactions = rows.map(row => {
            try {
                const transactionData = typeof row.transaction_data === 'string' 
                    ? JSON.parse(row.transaction_data) 
                    : row.transaction_data;
                return transactionData;
            } catch (e) {
                console.error('[WALLET] Error parsing transaction data:', e);
                return null;
            }
        }).filter(t => t !== null);

        // الحصول على العدد الإجمالي
        let countQuery = 'SELECT COUNT(*) as total FROM wallet_transactions WHERE 1=1';
        const countParams = [];
        if (partnerId) {
            countQuery += ' AND partner_id = ?';
            countParams.push(partnerId);
        }
        const [countResult] = await alwataniPool.query(countQuery, countParams);
        const totalCount = countResult[0]?.total || 0;

        res.json({
            success: true,
            data: {
                items: transactions,
                totalCount: totalCount
            },
            partnerId,
            fromCache: true
        });
    } catch (error) {
        console.error('[WALLET] Error fetching transactions from DB:', error);
        res.status(500).json({
            success: false,
            message: 'خطأ في جلب الحوالات من قاعدة البيانات: ' + error.message
        });
    }
});

// Sync wallet transactions (force refresh from API and save to DB)
app.post('/api/alwatani-login/:id/wallet/transactions/sync', async (req, res) => {
    try {
        const { id } = req.params;
        const maxPages = parseInt(req.query.maxPages || '100', 10); // حد أقصى 100 صفحة

        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        const [accounts] = await ownerPool.query(
            'SELECT id, username, password FROM alwatani_login WHERE id = ?',
            [id]
        );

        if (accounts.length === 0) {
            return res.status(404).json({ success: false, message: 'الحساب غير موجود' });
        }

        const account = accounts[0];
        
        // الحصول على pool لقاعدة بيانات الوطني
        const alwataniPool = await dbManager.getAlwataniPool(account.username);
        
        const verification = await verifyAlwataniAccount(account.username, account.password, {
            maxAttempts: 3,
            retryDelay: 5000
        });

        if (!verification.success) {
            return res.json({
                success: false,
                message: verification.message || '❌ فشل التحقق من الحساب'
            });
        }

        let token = verification.data?.access_token;
        if (!token) {
            return res.json({
                success: false,
                message: 'لم يتم استلام رمز الوصول من الموقع الخارجي'
            });
        }

        let partnerId = verification.data?.AccountId || verification.data?.account_id || null;

        const currentUserResp = await fetchAlwataniResource(
            '/api/current-user',
            token,
            'GET',
            true,
            account.username,
            account.password,
            'wallet_sync_current_user'
        );

        if (currentUserResp.success && currentUserResp.data) {
            const userData = currentUserResp.data.model || currentUserResp.data;
            partnerId = partnerId || userData?.self?.id || userData?.AccountId || null;
        }

        if (!partnerId) {
            return res.json({
                success: false,
                message: 'لم يتم تحديد معرف الشريك (partnerId)'
            });
        }

        const pageSize = 100;
        let allTransactions = [];
        let pageNumber = 1;
        let totalCount = 0;

        // جلب الصفحة الأولى لمعرفة العدد الإجمالي
        const firstPagePath = `/api/transactions?pageSize=${pageSize}&pageNumber=${pageNumber}&sortCriteria.property=${encodeURIComponent('occuredAt')}&sortCriteria.direction=desc&hierarchyLevel=1&walletOwnerType=Partner&partnerId=${partnerId}`;
        const firstPageResp = await fetchAlwataniResource(
            firstPagePath,
            token,
            'GET',
            true,
            account.username,
            account.password,
            'wallet_sync_first_page'
        );

        if (!firstPageResp.success) {
            return res.json({
                success: false,
                message: firstPageResp.message || 'فشل جلب الحوالات',
                statusCode: firstPageResp.statusCode
            });
        }

        const firstPageTransactions = normalizeAlwataniCollection(firstPageResp.data);
        allTransactions = allTransactions.concat(firstPageTransactions);
        totalCount = firstPageResp.data?.totalCount || firstPageTransactions.length;
        const totalPages = Math.min(Math.ceil(totalCount / pageSize), maxPages);

        console.log(`[WALLET SYNC] Total transactions: ${totalCount}, Total pages: ${totalPages}, Max pages to sync: ${maxPages}`);

        // جلب باقي الصفحات
        for (pageNumber = 2; pageNumber <= totalPages; pageNumber++) {
            const pagePath = `/api/transactions?pageSize=${pageSize}&pageNumber=${pageNumber}&sortCriteria.property=${encodeURIComponent('occuredAt')}&sortCriteria.direction=desc&hierarchyLevel=1&walletOwnerType=Partner&partnerId=${partnerId}`;
            const pageResp = await fetchAlwataniResource(
                pagePath,
                token,
                'GET',
                true,
                account.username,
                account.password,
                `wallet_sync_page_${pageNumber}`
            );

            if (pageResp.success) {
                const pageTransactions = normalizeAlwataniCollection(pageResp.data);
                allTransactions = allTransactions.concat(pageTransactions);
                console.log(`[WALLET SYNC] Fetched page ${pageNumber}/${totalPages}: ${pageTransactions.length} transactions`);
            } else {
                console.warn(`[WALLET SYNC] Failed to fetch page ${pageNumber}:`, pageResp.message);
            }

            // تأخير قصير بين الصفحات
            if (pageNumber < totalPages) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        // حفظ جميع الحوالات في قاعدة البيانات
        if (allTransactions.length > 0) {
            // الحصول على pool لقاعدة بيانات الوطني
            const alwataniPool = await dbManager.getAlwataniPool(account.username);
            await saveWalletTransactionsToDB(allTransactions, partnerId, alwataniPool);
            console.log(`[WALLET SYNC] ✅ Saved ${allTransactions.length} transactions to database for partnerId ${partnerId}`);
        }

        res.json({
            success: true,
            message: `تم مزامنة ${allTransactions.length} حوالة بنجاح`,
            data: {
                items: allTransactions,
                totalCount: totalCount
            },
            partnerId,
            synced: allTransactions.length
        });
    } catch (error) {
        console.error('[WALLET] Error syncing transactions:', error);
        res.status(500).json({
            success: false,
            message: 'خطأ في مزامنة الحوالات: ' + error.message
        });
    }
});

// ================= Subscribers Management Routes =================

// Helper function to get user_id from request
function getUserIdFromRequest(req) {
    // محاولة الحصول على user_id من query parameter أولاً
    if (req.query.user_id) {
        return parseInt(req.query.user_id, 10);
    }
    // ثم من body
    if (req.body && req.body.user_id) {
        return parseInt(req.body.user_id, 10);
    }
    // ثم من headers
    if (req.headers['user-id']) {
        return parseInt(req.headers['user-id'], 10);
    }
    return null;
}

// Get all subscribers
app.get('/api/subscribers', async (req, res) => {
    try {
        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ error: 'username (owner_username) مطلوب في الطلب' });
        }
        
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ error: 'alwatani_login_id مطلوب في الطلب (query parameter: alwatani_login_id أو alwataniId أو userId)' });
        }
        
        // الحصول على pool لقاعدة بيانات الوطني
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        
        // إضافة pagination وlimit لتحسين الأداء
        const page = parseInt(req.query.page || '1', 10);
        const limit = parseInt(req.query.limit || '100', 10); // حد أقصى 100 مشترك في كل طلب
        const offset = (page - 1) * limit;
        
        // جلب المشتركين مع pagination
        const [rows] = await alwataniPool.query(
            'SELECT * FROM subscribers ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [Math.min(limit, 100), offset] // حد أقصى 100 مشترك
        );
        
        // جلب العدد الإجمالي (اختياري - فقط إذا طُلب)
        if (req.query.includeTotal === 'true') {
            const [countResult] = await alwataniPool.query('SELECT COUNT(*) as total FROM subscribers');
            res.json({
                data: rows || [],
                pagination: {
                    page,
                    limit: Math.min(limit, 100),
                    total: countResult[0]?.total || 0,
                    totalPages: Math.ceil((countResult[0]?.total || 0) / Math.min(limit, 100))
                }
            });
        } else {
            res.json(rows || []);
        }
    } catch (error) {
        console.error('Get subscribers error:', error);
        res.status(500).json({ error: 'خطأ في جلب المشتركين: ' + error.message });
    }
});

// Get subscribers statistics
app.get('/api/subscribers/stats', async (req, res) => {
    try {
        const username = getUsernameFromRequest(req);
        
        if (!username) {
            return res.status(400).json({ error: 'username (owner_username) مطلوب في الطلب' });
        }
        
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ error: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        // الحصول على pool لقاعدة بيانات الوطني
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        
        const partnerIdParam = req.query.partnerId ? parseInt(req.query.partnerId, 10) : null;
        let query = 'SELECT customer_data, updated_at FROM alwatani_customers_cache';
        const params = [];

        if (!Number.isNaN(partnerIdParam) && partnerIdParam > 0) {
            query += ' WHERE partner_id = ?';
            params.push(partnerIdParam);
        }

        const [cacheRows] = await alwataniPool.query(query, params);

        if (cacheRows && cacheRows.length > 0) {
            const stats = computeCacheStats(cacheRows);
            return res.json(stats);
        }

        // Fallback: إحصائيات من subscribers table
        const [totalResult] = await alwataniPool.query('SELECT COUNT(*) as count FROM subscribers');
        const [activeResult] = await alwataniPool.query('SELECT COUNT(*) as count FROM subscribers WHERE status = "active"');
        const [zonesResult] = await alwataniPool.query('SELECT COUNT(DISTINCT zone) as count FROM subscribers');
        const [expiringResult] = await alwataniPool.query(
            'SELECT COUNT(*) as count FROM subscribers WHERE end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)'
        );
        
        return res.json({
            total: totalResult[0]?.count || 0,
            active: activeResult[0]?.count || 0,
            inactive: (totalResult[0]?.count || 0) - (activeResult[0]?.count || 0),
            expiringSoon: expiringResult[0]?.count || 0,
            zones: zonesResult[0]?.count || 0,
            source: 'subscribers'
        });
    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({ error: 'خطأ في جلب الإحصائيات: ' + error.message });
    }
});

// Get subscriber by ID
app.get('/api/subscribers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ error: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        const [rows] = await alwataniPool.query('SELECT * FROM subscribers WHERE id = ?', [id]);
        
        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.status(404).json({ error: 'المشترك غير موجود' });
        }
    } catch (error) {
        console.error('Get subscriber error:', error);
        res.status(500).json({ error: 'خطأ في جلب المشترك: ' + error.message });
    }
});

// Create new subscriber
app.post('/api/subscribers', async (req, res) => {
    try {
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ success: false, message: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        const { name, phone, zone, page_url, start_date, end_date, status } = req.body;
        
        const [result] = await alwataniPool.query(
            'INSERT INTO subscribers (name, phone, zone, page_url, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, phone, zone, page_url, start_date, end_date, status || 'active']
        );
        
        res.json({
            success: true,
            id: result.insertId,
            message: 'تم إضافة المشترك بنجاح'
        });
    } catch (error) {
        console.error('Create subscriber error:', error);
        res.status(500).json({ success: false, message: 'خطأ في إضافة المشترك: ' + error.message });
    }
});

// Update subscriber
app.put('/api/subscribers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ success: false, message: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        const { name, phone, zone, page_url, start_date, end_date, status } = req.body;
        
        // التحقق من أن المشترك موجود
        const [existing] = await alwataniPool.query('SELECT id FROM subscribers WHERE id = ?', [id]);
        
        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: 'المشترك غير موجود' });
        }
        
        await alwataniPool.query(
            'UPDATE subscribers SET name = ?, phone = ?, zone = ?, page_url = ?, start_date = ?, end_date = ?, status = ? WHERE id = ?',
            [name, phone, zone, page_url, start_date, end_date, status, id]
        );
        
        res.json({
            success: true,
            message: 'تم تحديث المشترك بنجاح'
        });
    } catch (error) {
        console.error('Update subscriber error:', error);
        res.status(500).json({ success: false, message: 'خطأ في تحديث المشترك: ' + error.message });
    }
});

// Delete subscriber
app.delete('/api/subscribers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ success: false, message: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        
        // التحقق من أن المشترك موجود
        const [existing] = await alwataniPool.query('SELECT id FROM subscribers WHERE id = ?', [id]);
        
        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: 'المشترك غير موجود' });
        }
        
        await alwataniPool.query('DELETE FROM subscribers WHERE id = ?', [id]);
        
        res.json({
            success: true,
            message: 'تم حذف المشترك بنجاح'
        });
    } catch (error) {
        console.error('Delete subscriber error:', error);
        res.status(500).json({ success: false, message: 'خطأ في حذف المشترك: ' + error.message });
    }
});

// ================= Tickets Management Routes =================

// Get all tickets
app.get('/api/tickets', async (req, res) => {
    try {
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ error: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        const [rows] = await alwataniPool.query(
            'SELECT * FROM tickets ORDER BY created_at DESC'
        );
        res.json(rows || []);
    } catch (error) {
        console.error('Get tickets error:', error);
        res.status(500).json({ error: 'خطأ في جلب التكتات: ' + error.message });
    }
});

// Create new ticket
app.post('/api/tickets', async (req, res) => {
    try {
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ success: false, message: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        const { subscriber_name, description, team, status, priority } = req.body;
        
        // Generate unique ticket number
        const timestamp = Date.now();
        const random = Math.floor(Math.random() * 1000);
        let ticket_number = `TK-${timestamp}-${random}`;
        
        // Check if ticket number already exists (very unlikely but safe)
        const [existing] = await alwataniPool.query(
            'SELECT id FROM tickets WHERE ticket_number = ?',
            [ticket_number]
        );
        
        if (existing.length > 0) {
            // If exists, generate new one
            const newRandom = Math.floor(Math.random() * 10000);
            ticket_number = `TK-${timestamp}-${newRandom}`;
        }
        
        const [result] = await alwataniPool.query(
            'INSERT INTO tickets (ticket_number, subscriber_name, description, team, status, priority) VALUES (?, ?, ?, ?, ?, ?)',
            [ticket_number, subscriber_name, description, team, status || 'open', priority || 'medium']
        );
        
        res.json({
            success: true,
            id: result.insertId,
            ticket_number: ticket_number,
            message: 'تم إضافة التكت بنجاح'
        });
    } catch (error) {
        console.error('Create ticket error:', error);
        res.status(500).json({ success: false, message: 'خطأ في إضافة التكت: ' + error.message });
    }
});

// Update ticket status
app.put('/api/tickets/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, priority, team, description } = req.body;
        
        // بناء الاستعلام ديناميكياً حسب الحقول المرسلة
        const updates = [];
        const values = [];
        
        if (status !== undefined) {
            updates.push('status = ?');
            values.push(status);
        }
        if (priority !== undefined) {
            updates.push('priority = ?');
            values.push(priority);
        }
        if (team !== undefined) {
            updates.push('team = ?');
            values.push(team);
        }
        if (description !== undefined) {
            updates.push('description = ?');
            values.push(description);
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ success: false, message: 'لا توجد بيانات للتحديث' });
        }
        
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ success: false, message: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        
        // التحقق من وجود التكت
        const [existing] = await alwataniPool.query('SELECT id FROM tickets WHERE id = ?', [id]);
        
        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: 'التكت غير موجود' });
        }
        
        values.push(id);
        const query = `UPDATE tickets SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
        
        await alwataniPool.query(query, values);
        
        res.json({
            success: true,
            message: 'تم تحديث التكت بنجاح'
        });
    } catch (error) {
        console.error('Update ticket error:', error);
        res.status(500).json({ success: false, message: 'خطأ في تحديث التكت' });
    }
});

// ================= Employees Management Routes =================

// Get owner domain
app.get('/api/owner/domain', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT username FROM users WHERE position = ? OR position = ? LIMIT 1',
            ['Owner', 'المالك']
        );
        
        if (rows.length > 0) {
            const ownerUsername = rows[0].username;
            const parts = ownerUsername.split('@');
            const domain = parts.length > 1 ? parts[1] : '';
            return res.json({ success: true, domain });
        }
        
        res.json({ success: false, domain: '' });
    } catch (error) {
        console.error('Get owner domain error:', error);
        res.json({ success: false, domain: '' });
    }
});

// Get all employees
app.get('/api/employees', async (req, res) => {
    try {
        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        
        const [rows] = await ownerPool.query(
            `SELECT u.id, u.username, u.password, u.role, u.display_name, u.position, u.permissions, 
             u.created_at, u.updated_at, u.email, u.phone, u.agent_name, u.is_active,
             creator.username as created_by_username
             FROM users u 
             LEFT JOIN users creator ON u.created_by = creator.id 
             ORDER BY u.created_at DESC`
        );
        
        // Parse JSON permissions if they're strings
        const employees = rows.map(emp => ({
            ...emp,
            permissions: emp.permissions ? (typeof emp.permissions === 'string' ? JSON.parse(emp.permissions) : emp.permissions) : {}
        }));
        
        res.json(employees);
    } catch (error) {
        console.error('Get employees error:', error);
        res.status(500).json({ error: 'خطأ في جلب الموظفين' });
    }
});

// Get single employee
app.get('/api/employees/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        
        const [rows] = await ownerPool.query(
            `SELECT u.id, u.username, u.password, u.role, u.display_name, u.position, u.permissions, 
             u.created_at, u.updated_at, u.email, u.phone,
             creator.username as created_by_username
             FROM users u 
             LEFT JOIN users creator ON u.created_by = creator.id 
             WHERE u.id = ?`,
            [id]
        );
        
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
        }
        
        const employee = rows[0];
        employee.permissions = employee.permissions ? (typeof employee.permissions === 'string' ? JSON.parse(employee.permissions) : employee.permissions) : {};
        
        res.json(employee);
    } catch (error) {
        console.error('Get employee error:', error);
        res.status(500).json({ success: false, message: 'خطأ في جلب بيانات الموظف' });
    }
});

// Create new employee
app.post('/api/employees', async (req, res) => {
    try {
        const { username, password, display_name, position, permissions, email, phone } = req.body;
        
        // Validation
        if (!username || !password || !display_name || !position) {
            return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ success: false, message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
        }
        
        if (!permissions || Object.keys(permissions).length === 0) {
            return res.status(400).json({ success: false, message: 'يجب تحديد صلاحية واحدة على الأقل' });
        }
        
        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        
        // Check if username already exists
        const [existing] = await ownerPool.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'اسم المستخدم موجود مسبقاً' });
        }
        
        // Hash password (simple hash for now, you can use bcrypt in production)
        const hashedPassword = password; // In production, use: bcrypt.hashSync(password, 10)
        
        // Format phone number (remove +964 if exists, then add it)
        let formattedPhone = null;
        if (phone && phone.trim()) {
            let phoneNum = phone.trim().replace(/^\+?964/, '');
            formattedPhone = phoneNum ? `+964${phoneNum}` : null;
        }
        
        // Insert employee (is_active defaults to TRUE if not specified)
        const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : 1;
        const [result] = await ownerPool.query(
            `INSERT INTO users (username, password, display_name, position, permissions, created_by, is_active, email, phone) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [username, hashedPassword, display_name, position, JSON.stringify(permissions), req.body.created_by || null, isActive, email || null, formattedPhone]
        );
        
        res.json({
            success: true,
            id: result.insertId,
            message: 'تم إضافة الموظف بنجاح'
        });
    } catch (error) {
        console.error('Create employee error:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ success: false, message: 'اسم المستخدم موجود مسبقاً' });
        } else {
            res.status(500).json({ success: false, message: 'خطأ في إضافة الموظف: ' + error.message });
        }
    }
});

// Update employee
app.put('/api/employees/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { username, password, display_name, position, permissions, email, phone } = req.body;
        
        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        
        // Check if employee exists and get position
        const [existing] = await ownerPool.query('SELECT id, position FROM users WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
        }
        
        // منع تعديل الموظفين برول Owner
        if (existing[0].position === 'المالك' || existing[0].position === 'Owner') {
            return res.status(403).json({ success: false, message: 'لا يمكن تعديل بيانات المالك' });
        }
        
        // Build update query dynamically
        const updates = [];
        const values = [];
        
        if (username !== undefined) {
            // Check if new username is already taken by another user
            const [usernameCheck] = await ownerPool.query('SELECT id FROM users WHERE username = ? AND id != ?', [username, id]);
            if (usernameCheck.length > 0) {
                return res.status(400).json({ success: false, message: 'اسم المستخدم موجود مسبقاً' });
            }
            updates.push('username = ?');
            values.push(username);
        }
        
        if (password !== undefined && password !== '') {
            if (password.length < 6) {
                return res.status(400).json({ success: false, message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
            }
            const hashedPassword = password; // In production, use: bcrypt.hashSync(password, 10)
            updates.push('password = ?');
            values.push(hashedPassword);
        }
        
        if (display_name !== undefined) {
            updates.push('display_name = ?');
            values.push(display_name);
        }
        
        if (position !== undefined) {
            updates.push('position = ?');
            values.push(position);
        }
        
        if (permissions !== undefined) {
            if (Object.keys(permissions).length === 0) {
                return res.status(400).json({ success: false, message: 'يجب تحديد صلاحية واحدة على الأقل' });
            }
            updates.push('permissions = ?');
            values.push(JSON.stringify(permissions));
        }
        
        if (email !== undefined) {
            updates.push('email = ?');
            values.push(email || null);
        }
        
        if (phone !== undefined) {
            // Format phone number (remove +964 if exists, then add it)
            let formattedPhone = null;
            if (phone && phone.trim()) {
                let phoneNum = phone.trim().replace(/^\+?964/, '');
                formattedPhone = phoneNum ? `+964${phoneNum}` : null;
            }
            updates.push('phone = ?');
            values.push(formattedPhone);
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ success: false, message: 'لا توجد بيانات للتحديث' });
        }
        
        values.push(id);
        const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
        
        await ownerPool.query(query, values);
        
        res.json({
            success: true,
            message: 'تم تحديث الموظف بنجاح'
        });
    } catch (error) {
        console.error('Update employee error:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            res.status(400).json({ success: false, message: 'اسم المستخدم موجود مسبقاً' });
        } else {
            res.status(500).json({ success: false, message: 'خطأ في تحديث الموظف: ' + error.message });
        }
    }
});

// Toggle employee status (activate/deactivate)
app.post('/api/employees/:id/toggle-status', async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;
        
        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        
        // Check if employee exists
        const [existing] = await ownerPool.query('SELECT id, position FROM users WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
        }
        
        // منع تجميد/تفعيل المالك
        if (existing[0].position === 'المالك' || existing[0].position === 'Owner') {
            return res.status(403).json({ success: false, message: 'لا يمكن تجميد أو تفعيل حساب المالك' });
        }
        
        // Update status
        await ownerPool.query('UPDATE users SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, id]);
        
        res.json({
            success: true,
            message: `تم ${is_active ? 'تفعيل' : 'تجميد'} الحساب بنجاح`
        });
    } catch (error) {
        console.error('Toggle employee status error:', error);
        res.status(500).json({ success: false, message: 'خطأ في تغيير حالة الحساب: ' + error.message });
    }
});

// Delete employee
app.delete('/api/employees/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        const ownerPool = await getOwnerPoolFromRequestHelper(req);
        
        // Check if employee exists and get position
        const [existing] = await ownerPool.query('SELECT id, username, position FROM users WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
        }
        
        // منع حذف الموظفين برول Owner
        if (existing[0].position === 'المالك' || existing[0].position === 'Owner') {
            return res.status(403).json({ success: false, message: 'لا يمكن حذف المالك' });
        }
        
        // Prevent deleting yourself
        // Note: You might want to add session/user tracking to prevent self-deletion
        
        // Delete employee
        await ownerPool.query('DELETE FROM users WHERE id = ?', [id]);
        
        res.json({
            success: true,
            message: 'تم حذف الموظف بنجاح'
        });
    } catch (error) {
        console.error('Delete employee error:', error);
        res.status(500).json({ success: false, message: 'خطأ في حذف الموظف: ' + error.message });
    }
});

// ================= Dashboard Users Management Routes =================

// Get all dashboard users
app.get('/api/dashboard-users', async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT du.id, du.username, du.password, du.role, du.notes, du.created_at, 
             u.username as created_by_username 
             FROM dashboard_users du 
             LEFT JOIN users u ON du.created_by = u.id 
             ORDER BY du.created_at DESC`
        );
        res.json(rows);
    } catch (error) {
        console.error('Get dashboard users error:', error);
        res.status(500).json({ error: 'خطأ في جلب مستخدمي لوحة التحكم' });
    }
});

// Create new dashboard user
app.post('/api/dashboard-users', async (req, res) => {
    try {
        const { username, password, role, notes, created_by } = req.body;
        
        // Check if username already exists
        const [existing] = await pool.query(
            'SELECT id FROM dashboard_users WHERE username = ?',
            [username]
        );
        
        if (existing.length > 0) {
            return res.json({
                success: false,
                message: 'اسم المستخدم موجود مسبقاً'
            });
        }
        
        const [result] = await pool.query(
            'INSERT INTO dashboard_users (username, password, role, notes, created_by) VALUES (?, ?, ?, ?, ?)',
            [username, password, role || 'user', notes || null, created_by || null]
        );
        
        res.json({
            success: true,
            id: result.insertId,
            message: 'تم إضافة مستخدم لوحة التحكم بنجاح'
        });
    } catch (error) {
        console.error('Create dashboard user error:', error);
        res.status(500).json({ success: false, message: 'خطأ في إضافة مستخدم لوحة التحكم' });
    }
});

// Update dashboard user
app.put('/api/dashboard-users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { username, password, role, notes } = req.body;
        
        await pool.query(
            'UPDATE dashboard_users SET username = ?, password = ?, role = ?, notes = ? WHERE id = ?',
            [username, password, role, notes, id]
        );
        
        res.json({
            success: true,
            message: 'تم تحديث مستخدم لوحة التحكم بنجاح'
        });
    } catch (error) {
        console.error('Update dashboard user error:', error);
        res.status(500).json({ success: false, message: 'خطأ في تحديث مستخدم لوحة التحكم' });
    }
});

// Delete dashboard user
app.delete('/api/dashboard-users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await pool.query('DELETE FROM dashboard_users WHERE id = ?', [id]);
        
        res.json({
            success: true,
            message: 'تم حذف مستخدم لوحة التحكم بنجاح'
        });
    } catch (error) {
        console.error('Delete dashboard user error:', error);
        res.status(500).json({ success: false, message: 'خطأ في حذف مستخدم لوحة التحكم' });
    }
});

// ================= Imported Accounts Management Routes =================

// Get all imported accounts
app.get('/api/imported-accounts', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, username, password, source, api_url, status, created_at FROM imported_accounts ORDER BY created_at DESC'
        );
        res.json(rows);
    } catch (error) {
        console.error('Get imported accounts error:', error);
        res.status(500).json({ error: 'خطأ في جلب الحسابات المستوردة' });
    }
});

// Create new imported account
app.post('/api/imported-accounts', async (req, res) => {
    try {
        const { username, password, source, api_url, original_data } = req.body;
        
        const [result] = await pool.query(
            'INSERT INTO imported_accounts (username, password, source, api_url, original_data, status) VALUES (?, ?, ?, ?, ?, ?)',
            [username, password, source || 'external_api', api_url || null, original_data ? JSON.stringify(original_data) : null, 'active']
        );
        
        res.json({
            success: true,
            id: result.insertId,
            message: 'تم إضافة الحساب المستورد بنجاح'
        });
    } catch (error) {
        console.error('Create imported account error:', error);
        res.status(500).json({ success: false, message: 'خطأ في إضافة الحساب المستورد' });
    }
});

// Delete imported account
app.delete('/api/imported-accounts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await pool.query('DELETE FROM imported_accounts WHERE id = ?', [id]);
        
        res.json({
            success: true,
            message: 'تم حذف الحساب المستورد بنجاح'
        });
    } catch (error) {
        console.error('Delete imported account error:', error);
        res.status(500).json({ success: false, message: 'خطأ في حذف الحساب المستورد' });
    }
});

// ================= Teams Management Routes =================

// Get all teams
app.get('/api/teams', async (req, res) => {
    try {
        const ownerUsername = getUsernameFromRequest(req);
        
        if (!ownerUsername) {
            return res.status(400).json({ error: 'username (owner_username) مطلوب في الطلب' });
        }
        
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ error: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        // استخدام alwataniPool للحصول على الفرق من قاعدة بيانات الوطني
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        const [rows] = await alwataniPool.query(
            'SELECT * FROM teams ORDER BY created_at DESC'
        );
        res.json(rows || []);
    } catch (error) {
        console.error('Get teams error:', error);
        res.status(500).json({ error: 'خطأ في جلب الفرق: ' + error.message });
    }
});

// Create new team
app.post('/api/teams', async (req, res) => {
    try {
        // التحقق من username
        const ownerUsername = getUsernameFromRequest(req);
        if (!ownerUsername) {
            return res.status(400).json({ 
                success: false, 
                message: 'username (owner_username) مطلوب في الطلب' 
            });
        }
        
        // التحقق من alwatani_login_id
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        if (!alwataniLoginId) {
            return res.status(400).json({ 
                success: false, 
                message: 'alwatani_login_id مطلوب في الطلب' 
            });
        }
        
        // التحقق من البيانات المرسلة
        const { name, description, status } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ 
                success: false, 
                message: 'اسم الفريق (name) مطلوب' 
            });
        }
        
        // الحصول على alwatani pool
        let alwataniPool;
        try {
            alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        } catch (poolError) {
            console.error('[CREATE TEAM] Error getting alwatani pool:', poolError);
            return res.status(500).json({ 
                success: false, 
                message: 'خطأ في الاتصال بقاعدة البيانات: ' + poolError.message 
            });
        }
        
        if (!alwataniPool) {
            return res.status(500).json({ 
                success: false, 
                message: 'فشل في الحصول على اتصال بقاعدة البيانات' 
            });
        }
        
        // التحقق من وجود جدول teams
        try {
            await alwataniPool.query('SELECT 1 FROM teams LIMIT 1');
        } catch (tableError) {
            console.error('[CREATE TEAM] Teams table check failed:', tableError);
            if (tableError.code === 'ER_NO_SUCH_TABLE') {
                return res.status(500).json({ 
                    success: false, 
                    message: 'جدول teams غير موجود في قاعدة البيانات. يرجى التأكد من إنشاء قاعدة بيانات الوطني بشكل صحيح.' 
                });
            }
            // إذا كان خطأ آخر، نتابع المحاولة
        }
        
        // إدراج الفريق
        console.log('[CREATE TEAM] Attempting to insert team:', { 
            name: name.trim(), 
            description: description ? description.trim() : null, 
            status: status || 'active',
            alwataniLoginId,
            ownerUsername
        });
        
        const [result] = await alwataniPool.query(
            'INSERT INTO teams (name, description, status) VALUES (?, ?, ?)',
            [name.trim(), description ? description.trim() : null, status || 'active']
        );
        
        console.log('[CREATE TEAM] Team created successfully:', { id: result.insertId });
        
        res.json({
            success: true,
            id: result.insertId,
            message: 'تم إضافة الفريق بنجاح'
        });
    } catch (error) {
        console.error('[CREATE TEAM] Error:', error);
        console.error('[CREATE TEAM] Error code:', error.code);
        console.error('[CREATE TEAM] Error message:', error.message);
        console.error('[CREATE TEAM] Error stack:', error.stack);
        
        // معالجة أخطاء محددة
        let errorMessage = 'خطأ في إضافة الفريق';
        let statusCode = 500;
        
        if (error.code === 'ER_NO_SUCH_TABLE') {
            errorMessage = 'جدول teams غير موجود في قاعدة البيانات. يرجى التأكد من إنشاء قاعدة بيانات الوطني بشكل صحيح.';
        } else if (error.code === 'ER_DUP_ENTRY' || error.code === 1062) {
            errorMessage = 'فريق بهذا الاسم موجود بالفعل';
            statusCode = 400;
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            errorMessage = 'فشل الاتصال بقاعدة البيانات. يرجى المحاولة مرة أخرى.';
        } else if (error.message && error.message.includes('pool')) {
            errorMessage = 'خطأ في الاتصال بقاعدة البيانات: ' + error.message;
        } else {
            errorMessage = `خطأ في إضافة الفريق: ${error.message || 'خطأ غير معروف'}`;
        }
        
        res.status(statusCode).json({ 
            success: false, 
            message: errorMessage,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ================= Team Members Routes (يجب أن تكون قبل route الفريق) =================

// Get team members
app.get('/api/teams/:id/members', async (req, res) => {
    try {
        const { id } = req.params;
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ error: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        
        // التحقق من وجود الفريق
        const [teamCheck] = await alwataniPool.query('SELECT id FROM teams WHERE id = ?', [id]);
        if (teamCheck.length === 0) {
            return res.status(404).json({ error: 'الفريق غير موجود' });
        }
        
        const [rows] = await alwataniPool.query(
            'SELECT * FROM team_members WHERE team_id = ? ORDER BY created_at DESC',
            [id]
        );
        res.json(rows || []); // إرجاع مصفوفة فارغة بدلاً من null
    } catch (error) {
        console.error('Get team members error:', error);
        // إذا كان الجدول غير موجود، أعد مصفوفة فارغة بدلاً من خطأ
        if (error.code === 'ER_NO_SUCH_TABLE') {
            console.warn('Table team_members does not exist. Please run: npm run init-db');
            return res.json([]); // إرجاع مصفوفة فارغة
        }
        // في حالة وجود خطأ آخر، أعد مصفوفة فارغة بدلاً من خطأ 500 لتجنب كسر الواجهة
        console.warn('Error loading team members, returning empty array:', error.message);
        res.json([]);
    }
});

// Add team member
app.post('/api/teams/:id/members', async (req, res) => {
    try {
        console.log('[ADD TEAM MEMBER] Request received:', {
            teamId: req.params.id,
            body: req.body,
            query: req.query,
            params: req.params
        });
        
        const { id } = req.params;
        const { name, phone, photo_url } = req.body;
        
        // التحقق من البيانات الأساسية
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'اسم العضو مطلوب' });
        }
        
        // الحصول على alwatani_login_id
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        console.log('[ADD TEAM MEMBER] Extracted alwataniLoginId:', alwataniLoginId);
        
        if (!alwataniLoginId) {
            console.error('[ADD TEAM MEMBER] Missing alwatani_login_id');
            return res.status(400).json({ success: false, message: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        // الحصول على pool قاعدة البيانات
        let alwataniPool;
        try {
            console.log('[ADD TEAM MEMBER] Getting alwatani pool...');
            alwataniPool = await getAlwataniPoolFromRequestHelper(req);
            console.log('[ADD TEAM MEMBER] Successfully got alwatani pool');
        } catch (poolError) {
            console.error('[ADD TEAM MEMBER] Error getting alwatani pool:', poolError);
            return res.status(500).json({ 
                success: false, 
                message: 'خطأ في الاتصال بقاعدة البيانات: ' + poolError.message 
            });
        }
        
        if (!alwataniPool) {
            console.error('[ADD TEAM MEMBER] alwataniPool is null');
            return res.status(500).json({ 
                success: false, 
                message: 'فشل في الحصول على اتصال بقاعدة البيانات' 
            });
        }
        
        // التحقق من وجود جدول team_members
        try {
            await alwataniPool.query('SELECT 1 FROM team_members LIMIT 1');
        } catch (tableError) {
            console.error('[ADD TEAM MEMBER] Teams table check failed:', tableError);
            if (tableError.code === 'ER_NO_SUCH_TABLE') {
                return res.status(500).json({ 
                    success: false, 
                    message: 'جدول team_members غير موجود في قاعدة البيانات. يرجى التأكد من إنشاء قاعدة بيانات الوطني بشكل صحيح.' 
                });
            }
        }
        
        // التحقق من وجود الفريق
        console.log('[ADD TEAM MEMBER] Checking if team exists:', id);
        let teamCheck;
        try {
            [teamCheck] = await alwataniPool.query('SELECT id, name FROM teams WHERE id = ?', [id]);
            console.log('[ADD TEAM MEMBER] Team check result:', teamCheck);
        } catch (checkError) {
            console.error('[ADD TEAM MEMBER] Error checking team:', checkError);
            return res.status(500).json({ 
                success: false, 
                message: 'خطأ في التحقق من وجود الفريق: ' + checkError.message 
            });
        }
        
        if (!teamCheck || teamCheck.length === 0) {
            console.warn('[ADD TEAM MEMBER] Team not found:', id);
            return res.status(404).json({ success: false, message: 'الفريق غير موجود' });
        }
        
        // إدراج العضو
        console.log('[ADD TEAM MEMBER] Inserting member:', {
            team_id: id,
            name: name.trim(),
            phone: phone ? phone.trim() : null,
            photo_url: photo_url || null
        });
        
        console.log('[ADD TEAM MEMBER] Attempting to insert member with values:', {
            team_id: id,
            name: name.trim(),
            phone: phone ? phone.trim() : null,
            photo_url: photo_url || null,
            team_id_type: typeof id,
            team_id_value: id
        });
        
        let result;
        try {
            [result] = await alwataniPool.query(
                'INSERT INTO team_members (team_id, name, phone, photo_url) VALUES (?, ?, ?, ?)',
                [id, name.trim(), phone ? phone.trim() : null, photo_url || null]
            );
            
            console.log('[ADD TEAM MEMBER] Member added successfully:', { insertId: result.insertId });
        } catch (insertError) {
            console.error('[ADD TEAM MEMBER] Insert error details:', {
                code: insertError.code,
                errno: insertError.errno,
                sqlState: insertError.sqlState,
                message: insertError.message,
                sql: insertError.sql,
                values: [id, name.trim(), phone ? phone.trim() : null, photo_url || null]
            });
            throw insertError;
        }
        
        res.json({
            success: true,
            id: result.insertId,
            message: 'تم إضافة العضو بنجاح'
        });
    } catch (error) {
        console.error('[ADD TEAM MEMBER] Error:', error);
        console.error('[ADD TEAM MEMBER] Error code:', error.code);
        console.error('[ADD TEAM MEMBER] Error message:', error.message);
        console.error('[ADD TEAM MEMBER] Error stack:', error.stack);
        
        // تحسين رسائل الخطأ
        let errorMessage = 'خطأ في إضافة العضو';
        let statusCode = 500;
        
        if (error.code === 'ER_NO_SUCH_TABLE') {
            errorMessage = 'جدول team_members غير موجود. يرجى التأكد من إنشاء قاعدة بيانات الوطني بشكل صحيح.';
        } else if (error.code === 'ER_DUP_ENTRY' || error.code === 1062) {
            errorMessage = 'هذا العضو موجود بالفعل في هذا الفريق';
            statusCode = 400;
        } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
            errorMessage = 'الفريق غير موجود';
            statusCode = 404;
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            errorMessage = 'فشل الاتصال بقاعدة البيانات. يرجى المحاولة مرة أخرى.';
        } else {
            errorMessage = `خطأ في إضافة العضو: ${error.message || 'خطأ غير معروف'}`;
        }
        
        res.status(statusCode).json({ 
            success: false, 
            message: errorMessage,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Delete team member
app.delete('/api/teams/:teamId/members/:memberId', async (req, res) => {
    try {
        const { teamId, memberId } = req.params;
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ success: false, message: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        await alwataniPool.query(
            'DELETE FROM team_members WHERE id = ? AND team_id = ?',
            [memberId, teamId]
        );
        res.json({ success: true, message: 'تم حذف العضو بنجاح' });
    } catch (error) {
        console.error('Delete team member error:', error);
        res.status(500).json({ success: false, message: 'خطأ في حذف العضو: ' + error.message });
    }
});

// ================= Team Routes =================

// Update team (status, name, description)
app.put('/api/teams/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, name, description } = req.body;
        
        const alwataniLoginId = getAlwataniLoginIdFromRequest(req);
        
        if (!alwataniLoginId) {
            return res.status(400).json({ success: false, message: 'alwatani_login_id مطلوب في الطلب' });
        }
        
        // التحقق من البيانات
        if (name !== undefined && (!name || !name.trim())) {
            return res.status(400).json({ success: false, message: 'اسم الفريق لا يمكن أن يكون فارغاً' });
        }
        
        const alwataniPool = await getAlwataniPoolFromRequestHelper(req);
        
        // التحقق من وجود الفريق
        const [teamCheck] = await alwataniPool.query('SELECT id, name FROM teams WHERE id = ?', [id]);
        if (teamCheck.length === 0) {
            return res.status(404).json({ success: false, message: 'الفريق غير موجود' });
        }
        
        let query = 'UPDATE teams SET ';
        const updates = [];
        const values = [];
        
        if (status !== undefined) {
            updates.push('status = ?');
            values.push(status);
        }
        if (name !== undefined) {
            updates.push('name = ?');
            values.push(name.trim());
        }
        if (description !== undefined) {
            updates.push('description = ?');
            values.push(description ? description.trim() : null);
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ success: false, message: 'لا توجد بيانات للتحديث' });
        }
        
        query += updates.join(', ') + ', updated_at = CURRENT_TIMESTAMP WHERE id = ?';
        values.push(id);
        
        await alwataniPool.query(query, values);
        
        res.json({
            success: true,
            message: 'تم تحديث الفريق بنجاح'
        });
    } catch (error) {
        console.error('[UPDATE TEAM] Error:', error);
        console.error('[UPDATE TEAM] Error code:', error.code);
        console.error('[UPDATE TEAM] Error message:', error.message);
        
        let errorMessage = 'خطأ في تحديث الفريق';
        let statusCode = 500;
        
        if (error.code === 'ER_DUP_ENTRY' || error.code === 1062) {
            errorMessage = 'فريق بهذا الاسم موجود بالفعل';
            statusCode = 400;
        } else if (error.code === 'ER_NO_SUCH_TABLE') {
            errorMessage = 'جدول teams غير موجود في قاعدة البيانات';
        } else {
            errorMessage = `خطأ في تحديث الفريق: ${error.message || 'خطأ غير معروف'}`;
        }
        
        res.status(statusCode).json({ 
            success: false, 
            message: errorMessage,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ================= Health Check =================

app.get('/api/health', async (req, res) => {
    try {
        const masterPool = await dbManager.initMasterPool();
        const connection = await masterPool.getConnection();
        connection.release();
        res.json({ 
            status: 'ok', 
            database: 'connected',
            message: 'API Server is running'
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            database: 'disconnected',
            message: error.message 
        });
    }
});

// Root route - Shows server info and admin dashboard links
app.get('/', (req, res) => {
    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:3000';
    const baseUrl = `${protocol}://${host}`;
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    
    // Get server IP from request
    const serverIP = req.headers['x-forwarded-for'] || 
                     req.connection.remoteAddress || 
                     req.socket.remoteAddress ||
                     (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
                     'localhost';
    
    res.json({
        name: 'FTTH Control Deck API',
        version: '1.0.0',
        status: 'running',
        server: {
            protocol: protocol,
            host: host,
            baseUrl: baseUrl,
            clientIP: clientIP,
            port: config.server.port
        },
        endpoints: {
            auth: '/api/auth/login',
            users: '/api/users',
            subscribers: '/api/subscribers',
            tickets: '/api/tickets',
            teams: '/api/teams',
            health: '/api/health'
        }
    });
});

// ================= Admin Dashboard Routes - REMOVED =================

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        success: false, 
        message: 'خطأ في الخادم',
        error: err.message 
    });
});

// Helper function to escape HTML special characters
function escapeHtml(text) {
    if (typeof text !== 'string') {
        return '';
    }
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
}

// 404 handler (only for API routes, not for static files)
// NOTE: This MUST be the last route handler!
app.use((req, res) => {
    // Log the 404 request for debugging (server-side only)
    console.log(`[404] ${req.method} ${req.path} - Not found`);
    
    // Check if file exists for other HTML files
    if (req.path.endsWith('.html')) {
        const filePath = path.join(__dirname, req.path);
        console.log(`[404] Checking if file exists: ${filePath}`);
        if (fs.existsSync(filePath)) {
            console.log(`[404] ✅ File exists! Serving directly...`);
            return res.sendFile(filePath, (err) => {
                if (err) {
                    console.error(`[404] ❌ Error serving file:`, err);
                    if (!res.headersSent) {
                        res.status(500).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>خطأ</title></head><body><h1>خطأ في تحميل الملف</h1><p>${escapeHtml(err.message)}</p></body></html>`);
                    }
                    return;
                }
            });
        } else {
            console.log(`[404] ❌ File does not exist: ${filePath}`);
        }
    }
    
    // Escape the path for safe HTML rendering
    const safePath = escapeHtml(req.path);
    
    // إذا كان الطلب لملف HTML أو static file، أرسل 404 HTML
    if (req.path.endsWith('.html') || req.path.includes('.')) {
        res.status(404).send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <title>404 - الصفحة غير موجودة</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; }
                    h1 { color: #e74c3c; }
                </style>
            </head>
            <body>
                <h1>404 - الصفحة غير موجودة</h1>
                <p>الصفحة التي تبحث عنها غير موجودة.</p>
                <p style="color: #666; font-size: 12px;">المسار: ${safePath}</p>
            </body>
            </html>
        `);
    } else {
        // للـ API routes، أرسل JSON
        res.status(404).json({ 
            success: false, 
            message: 'الصفحة غير موجودة'
        });
    }
});

// Start server
async function startServer() {
    await initializePool();
    
    
    const PORT = config.server.port;
    app.listen(PORT, '0.0.0.0', () => {
        const os = require('os');
        const networkInterfaces = os.networkInterfaces();
        let localIP = 'localhost';
        
        // الحصول على IP المحلي
        for (const interfaceName in networkInterfaces) {
            const interfaces = networkInterfaces[interfaceName];
            for (const iface of interfaces) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    localIP = iface.address;
                    break;
                }
            }
            if (localIP !== 'localhost') break;
        }
        
        console.log('');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`🚀 FTTH Control Deck API Server`);
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`✅ Server running on: http://localhost:${PORT}`);
        console.log(`🌐 Network Access: http://${localIP}:${PORT}`);
        console.log(`📊 API Status: http://${localIP}:${PORT}/api/health`);
        console.log(`📱 Mobile Access: http://${localIP}:${PORT}`);
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('📝 Available Endpoints:');
        console.log(`   POST   /api/auth/login       - Login`);
        console.log(`   GET    /api/users            - Get all users`);
        console.log(`   POST   /api/users            - Add new user`);
        console.log(`   DELETE /api/users/:id        - Delete user`);
        console.log(`   GET    /api/subscribers      - Get all subscribers`);
        console.log(`   GET    /api/subscribers/stats - Statistics`);
        console.log(`   POST   /api/subscribers      - Add subscriber`);
        console.log(`   PUT    /api/subscribers/:id  - Update subscriber`);
        console.log(`   DELETE /api/subscribers/:id  - Delete subscriber`);
        console.log(`   GET    /api/tickets          - Get tickets`);
        console.log(`   POST   /api/tickets          - Add ticket`);
        console.log(`   GET    /api/teams            - Get teams`);
        console.log(`   POST   /api/teams            - Add team`);
        console.log('');
        console.log('💡 Tip: You can stop the server by pressing Ctrl+C');
        console.log('═══════════════════════════════════════════════════════════');
        
        // تم إلغاء نظام التحديث التلقائي - المزامنة تتم يدوياً فقط
        // startAutoSyncService();
    });
}

// ================= Auto Sync Service =================
// نظام التحديث التلقائي للبيانات
let autoSyncIntervals = new Map(); // userId -> interval
let autoSyncRunning = new Map(); // userId -> boolean

async function startAutoSyncService() {
    console.log('');
    console.log('🔄 Starting Auto-Sync Service...');
    
    // انتظار 30 ثانية بعد تشغيل السيرفر قبل بدء المزامنة
    await delay(30000);
    
    // بدء المزامنة التلقائية لجميع الحسابات
    await syncAllAccounts();
    
    // بدء التحديث التلقائي كل 30 ثانية
    setInterval(async () => {
        await syncAllAccounts(false); // incremental sync (سريع)
    }, 30000); // 30 ثانية
    
    console.log('✅ Auto-Sync Service started - Updates every 30 seconds');
}

async function syncAllAccounts(isFirstSync = true) {
    try {
        const masterPool = await dbManager.initMasterPool();
        const [owners] = await masterPool.query(
            'SELECT username, domain FROM owners_databases WHERE is_active = TRUE'
        );
        
        for (const owner of owners) {
            try {
                const ownerPool = await dbManager.getOwnerPool(owner.domain);
                const [accounts] = await ownerPool.query(
                    'SELECT id, username, user_id FROM alwatani_login WHERE id IS NOT NULL'
                );
                
                for (const account of accounts) {
                    if (autoSyncRunning.get(account.id)) {
                        console.log(`[AUTO-SYNC] Skipping ${account.username} - sync already running`);
                        continue;
                    }
                    
                    // في المرة الأولى: sync كامل بطيء
                    // في التحديثات: sync سريع (incremental)
                    await performAutoSync(account.id, owner.username, owner.domain, isFirstSync);
                }
            } catch (error) {
                console.error(`[AUTO-SYNC] Error syncing owner ${owner.username}:`, error.message);
            }
        }
    } catch (error) {
        console.error('[AUTO-SYNC] Error in syncAllAccounts:', error.message);
    }
}

async function performAutoSync(accountId, ownerUsername, ownerDomain, isFullSync = false) {
    autoSyncRunning.set(accountId, true);
    
    try {
        console.log(`[AUTO-SYNC] ${isFullSync ? 'Full' : 'Incremental'} sync for account ${accountId}...`);
        
        // استخدام إعدادات مختلفة حسب نوع المزامنة
        const originalPageDelay = PAGE_FETCH_BATCH_DELAY;
        const originalDetailDelay = DETAIL_FETCH_BATCH_DELAY;
        const originalConcurrency = DETAIL_FETCH_CONCURRENCY;
        
        if (isFullSync) {
            // في المرة الأولى: إعدادات بطيئة لتجنب الحظر
            PAGE_FETCH_BATCH_DELAY = 2000; // 2 ثانية بين الصفحات
            DETAIL_FETCH_BATCH_DELAY = 2000; // 2 ثانية بين التفاصيل
            DETAIL_FETCH_CONCURRENCY = 2; // 2 مشترك في كل مرة
            console.log('[AUTO-SYNC] Using slow settings for first sync to avoid rate limiting');
        } else {
            // في التحديثات: إعدادات سريعة
            PAGE_FETCH_BATCH_DELAY = 500; // 0.5 ثانية
            DETAIL_FETCH_BATCH_DELAY = 500; // 0.5 ثانية
            DETAIL_FETCH_CONCURRENCY = 5; // 5 مشتركين في كل مرة
            console.log('[AUTO-SYNC] Using fast settings for incremental sync');
        }
        
        // تنفيذ المزامنة باستخدام http module
        const http = require('http');
        const syncPath = `/api/alwatani-login/${accountId}/customers/sync`;
        const postData = JSON.stringify({
            forceFullSync: isFullSync,
            owner_username: ownerUsername
        });
        
        const result = await new Promise((resolve) => {
            const options = {
                hostname: 'localhost',
                port: config.server.port,
                path: syncPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'X-Owner-Username': ownerUsername
                },
                timeout: 300000 // 5 دقائق timeout
            };
            
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const jsonData = JSON.parse(data);
                        resolve({ ok: res.statusCode === 200, status: res.statusCode, data: jsonData });
                    } catch (e) {
                        resolve({ ok: false, status: res.statusCode, data: { success: false, message: data } });
                    }
                });
            });
            
            req.on('error', (error) => {
                resolve({ ok: false, status: 0, data: { success: false, message: error.message } });
            });
            
            req.on('timeout', () => {
                req.destroy();
                resolve({ ok: false, status: 0, data: { success: false, message: 'Request timeout' } });
            });
            
            req.write(postData);
            req.end();
        });
        
        if (result.ok && result.data.success) {
            console.log(`[AUTO-SYNC] ✅ Sync completed for account ${accountId}`);
        } else {
            console.warn(`[AUTO-SYNC] ⚠️ Sync ${result.ok ? 'completed with warnings' : 'failed'} for account ${accountId}:`, result.data.message || `Status: ${result.status}`);
        }
        
        // استعادة الإعدادات الأصلية
        PAGE_FETCH_BATCH_DELAY = originalPageDelay;
        DETAIL_FETCH_BATCH_DELAY = originalDetailDelay;
        DETAIL_FETCH_CONCURRENCY = originalConcurrency;
        
    } catch (error) {
        console.error(`[AUTO-SYNC] Error syncing account ${accountId}:`, error.message);
    } finally {
        autoSyncRunning.set(accountId, false);
    }
}

// ==================== Chat API Endpoints - REMOVED ====================


// Handle shutdown gracefully
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down server...');
    try {
        await dbManager.closeAllConnections();
        console.log('✅ Database connections closed');
    } catch (error) {
        console.error('Error closing connections:', error.message);
    }
    process.exit(0);
});

startServer();



