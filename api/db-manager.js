/**
 * مدير قواعد البيانات (Database Manager)
 * 
 * يدير الاتصال بقاعدة البيانات الرئيسية وقواعد البيانات الخاصة بكل مالك
 */

const mysql = require('mysql2/promise');
const config = require('./config');
const { initOwnerDatabase } = require('./init-owner-db');
const { initAlwataniDatabase, getAlwataniDatabaseName } = require('./init-alwatani-db');

// Pool للقاعدة الرئيسية
let masterPool = null;

// Cache للـ pools الخاصة بكل مالك
const ownerPools = new Map(); // domain -> pool

// Cache للـ pools الخاصة بكل حساب وطني
const alwataniPools = new Map(); // username -> pool

/**
 * تهيئة الاتصال بقاعدة البيانات الرئيسية
 */
async function initMasterPool() {
    if (masterPool) return masterPool;
    
    try {
        // التحقق من وجود قاعدة البيانات وإنشائها إذا لم تكن موجودة
        let connection = await mysql.createConnection({
            host: config.db.host,
            user: config.db.user,
            password: config.db.password
        });
        
        await connection.query(`CREATE DATABASE IF NOT EXISTS ${config.master.database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await connection.end();
        
        masterPool = mysql.createPool({
            ...config.db,
            database: config.master.database
        });
        
        // إنشاء الجدول إذا لم يكن موجوداً
        try {
            await masterPool.query(`
                CREATE TABLE IF NOT EXISTS owners_databases (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    username VARCHAR(255) UNIQUE NOT NULL COMMENT 'اسم المستخدم الكامل (مثل: admin@tec)',
                    domain VARCHAR(100) NOT NULL COMMENT 'النطاق (مثل: tec)',
                    database_name VARCHAR(100) UNIQUE NOT NULL COMMENT 'اسم قاعدة البيانات (مثل: ftth_owner_tec)',
                    agent_name VARCHAR(255) COMMENT 'اسم الوكيل الثلاثي',
                    company_name VARCHAR(255) COMMENT 'اسم الشركة',
                    governorate VARCHAR(100) COMMENT 'المحافظة',
                    region VARCHAR(100) COMMENT 'المنطقة',
                    phone VARCHAR(20) COMMENT 'رقم الهاتف',
                    email VARCHAR(255) COMMENT 'البريد الإلكتروني',
                    is_active BOOLEAN DEFAULT TRUE COMMENT 'حالة تفعيل الحساب',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_username (username),
                    INDEX idx_domain (domain),
                    INDEX idx_database_name (database_name),
                    INDEX idx_email (email),
                    INDEX idx_phone (phone)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
        } catch (tableError) {
            console.warn('⚠️ Warning creating owners_databases table:', tableError.message);
        }
        
        console.log('✅ Connected to master database');
        return masterPool;
    } catch (error) {
        console.error('❌ Failed to connect to master database:', error.message);
        throw error;
    }
}

/**
 * استخراج النطاق من اسم المستخدم
 * admin@tec -> tec
 */
function getDomainFromUsername(username) {
    if (!username) return null;
    
    const match = username.match(/^admin@(.+)$/);
    return match ? match[1].toLowerCase() : null;
}

/**
 * الحصول على اسم قاعدة البيانات من النطاق
 * tec -> ftth_owner_tec
 */
function getDatabaseName(domain) {
    if (!domain) return null;
    
    // تنظيف اسم النطاق (إزالة الأحرف الخاصة)
    const cleanDomain = domain.toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/^_+|_+$/g, ''); // إزالة _ من البداية والنهاية
    
    if (!cleanDomain) {
        throw new Error('Invalid domain name');
    }
    
    return `ftth_owner_${cleanDomain}`;
}

/**
 * الحصول على أو إنشاء pool لقاعدة بيانات المالك
 */
async function getOwnerPool(domain) {
    if (!domain) {
        throw new Error('Domain is required');
    }
    
    // التحقق من وجود pool في الـ cache
    if (ownerPools.has(domain)) {
        return ownerPools.get(domain);
    }
    
    // الحصول على اسم قاعدة البيانات
    const dbName = getDatabaseName(domain);
    
    // التحقق من وجود قاعدة البيانات
    const masterPool = await initMasterPool();
    const [dbCheck] = await masterPool.query(
        'SELECT database_name FROM owners_databases WHERE domain = ?',
        [domain]
    );
    
    if (dbCheck.length === 0) {
        throw new Error(`Database does not exist for domain: ${domain}. Please create an account first.`);
    }
    
    // إنشاء pool جديد
    const ownerPool = mysql.createPool({
        ...config.db,
        database: dbName
    });
    
    // حفظ في الـ cache
    ownerPools.set(domain, ownerPool);
    console.log(`✅ Connected to owner database: ${dbName}`);
    
    return ownerPool;
}

/**
 * الحصول على pool من اسم المستخدم
 * يقبل admin@domain أو أي username آخر (يبحث في قاعدة البيانات)
 */
async function getPoolFromUsername(username) {
    if (!username) {
        throw new Error('Username is required');
    }
    
    // إذا كان username بتنسيق admin@domain، استخدمه مباشرة
    const domain = getDomainFromUsername(username);
    if (domain) {
        return await getOwnerPool(domain);
    }
    
    // إذا لم يكن admin@domain، ابحث عن owner username في جميع قواعد البيانات
    const masterPool = await initMasterPool();
    const [owners] = await masterPool.query(
        'SELECT username, domain FROM owners_databases WHERE is_active = TRUE'
    );
    
    // البحث في كل قاعدة بيانات عن المستخدم
    for (const owner of owners) {
        try {
            const ownerPool = await getOwnerPool(owner.domain);
            const [users] = await ownerPool.query(
                'SELECT username FROM users WHERE username = ? LIMIT 1',
                [username]
            );
            
            if (users.length > 0) {
                // المستخدم موجود في هذه القاعدة، استخدم owner username
                return await getOwnerPool(owner.domain);
            }
        } catch (error) {
            // تجاهل الأخطاء والبحث في قاعدة البيانات التالية
            continue;
        }
    }
    
    throw new Error(`User ${username} not found in any database`);
}

/**
 * الحصول على معلومات قاعدة البيانات الخاصة بمالك من قاعدة البيانات الرئيسية
 */
async function getOwnerDatabaseInfo(username) {
    await initMasterPool();
    
    try {
        const [rows] = await masterPool.query(
            'SELECT * FROM owners_databases WHERE username = ?',
            [username]
        );
        
        return rows.length > 0 ? rows[0] : null;
    } catch (error) {
        console.error('Error getting owner database info:', error.message);
        throw error;
    }
}

/**
 * التحقق من وجود قاعدة بيانات للمالك
 */
async function ownerDatabaseExists(username) {
    const info = await getOwnerDatabaseInfo(username);
    return info !== null;
}

/**
 * إنشاء قاعدة بيانات جديدة للمالك
 */
async function createOwnerDatabase(ownerInfo) {
    await initMasterPool();
    
    const { username } = ownerInfo;
    if (!username) {
        throw new Error('Username is required');
    }
    
    // استخراج النطاق
    const domain = getDomainFromUsername(username);
    if (!domain) {
        throw new Error('Invalid username format. Must be admin@domain');
    }
    
    // الحصول على اسم قاعدة البيانات
    const dbName = getDatabaseName(domain);
    
    // التحقق من عدم وجود قاعدة بيانات بنفس الاسم
    const existing = await getOwnerDatabaseInfo(username);
    if (existing) {
        throw new Error(`Database already exists for username: ${username}`);
    }
    
    // إنشاء قاعدة البيانات والجداول
    try {
        console.log(`🔄 Creating database: ${dbName}`);
        await initOwnerDatabase(dbName);
        console.log(`✅ Database created: ${dbName}`);
    } catch (error) {
        console.error(`❌ Failed to create database ${dbName}:`, error.message);
        throw error;
    }
    
    // حفظ المعلومات في قاعدة البيانات الرئيسية
    try {
        await masterPool.query(`
            INSERT INTO owners_databases (
                username, domain, database_name, agent_name, company_name,
                governorate, region, phone, email
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            username,
            domain,
            dbName,
            ownerInfo.agent_name || null,
            ownerInfo.company_name || null,
            ownerInfo.governorate || null,
            ownerInfo.region || null,
            ownerInfo.phone || null,
            ownerInfo.email || null
        ]);
        
        console.log(`✅ Owner database info saved to master database`);
    } catch (error) {
        console.error('❌ Failed to save owner info to master database:', error.message);
        throw error;
    }
    
    // إنشاء حساب المالك في قاعدة البيانات الخاصة به
    try {
        const ownerPool = await getOwnerPool(domain);
        
        // تنسيق رقم الهاتف
        let phone = ownerInfo.phone || '';
        if (phone) {
            phone = phone.trim().replace(/\+*964/g, '');
            if (phone.startsWith('964')) {
                phone = phone.substring(3);
            }
            phone = phone ? `+964${phone}` : phone;
        }
        
        await ownerPool.query(`
            INSERT INTO users (
                username, password, role, agent_name, company_name,
                governorate, region, phone, email, position
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            username,
            ownerInfo.password,
            'admin',
            ownerInfo.agent_name || null,
            ownerInfo.company_name || null,
            ownerInfo.governorate || null,
            ownerInfo.region || null,
            phone,
            ownerInfo.email || null,
            'Owner'
        ]);
        
        console.log(`✅ Owner account created in database ${dbName}`);
    } catch (error) {
        console.error('❌ Failed to create owner account:', error.message);
        throw error;
    }
    
    return dbName;
}

/**
 * التحقق من صحة اسم قاعدة البيانات
 */
function isValidDatabaseName(name) {
    // MySQL database names can contain: letters, digits, underscore, dollar
    // Cannot start with a digit
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) && name.length <= 64;
}

/**
 * الحصول على pool لقاعدة بيانات وطني
 */
async function getAlwataniPool(username) {
    if (!username) {
        throw new Error('Alwatani username is required');
    }
    
    // Check if pool exists in cache
    if (alwataniPools.has(username)) {
        return alwataniPools.get(username);
    }
    
    // Get database name
    const dbName = getAlwataniDatabaseName(username);
    
    // Create new pool
    const pool = mysql.createPool({
        ...config.db,
        database: dbName
    });
    
    // Save to cache
    alwataniPools.set(username, pool);
    console.log(`✅ Connected to alwatani database: ${dbName}`);
    
    return pool;
}

/**
 * إنشاء قاعدة بيانات جديدة لحساب وطني
 */
async function createAlwataniDatabase(username) {
    if (!username) {
        throw new Error('Alwatani username is required');
    }
    
    const dbName = await initAlwataniDatabase(username);
    
    // Create pool and cache it
    const pool = await getAlwataniPool(username);
    
    console.log(`✅ Alwatani database created: ${dbName}`);
    return dbName;
}

/**
 * إغلاق جميع الاتصالات
 */
async function closeAllConnections() {
    if (masterPool) {
        await masterPool.end();
        masterPool = null;
    }
    
    for (const [domain, pool] of ownerPools.entries()) {
        try {
            await pool.end();
            console.log(`✅ Closed connection for domain: ${domain}`);
        } catch (error) {
            console.error(`❌ Error closing connection for domain ${domain}:`, error.message);
        }
    }
    
    ownerPools.clear();
    
    for (const [username, pool] of alwataniPools.entries()) {
        try {
            await pool.end();
            console.log(`✅ Closed connection for alwatani: ${username}`);
        } catch (error) {
            console.error(`❌ Error closing connection for alwatani ${username}:`, error.message);
        }
    }
    
    alwataniPools.clear();
}

module.exports = {
    initMasterPool,
    getOwnerPool,
    getPoolFromUsername,
    getOwnerDatabaseInfo,
    ownerDatabaseExists,
    createOwnerDatabase,
    getDomainFromUsername,
    getDatabaseName,
    isValidDatabaseName,
    getAlwataniPool,
    createAlwataniDatabase,
    closeAllConnections
};

