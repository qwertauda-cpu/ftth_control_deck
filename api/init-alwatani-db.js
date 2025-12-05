/**
 * إنشاء هيكل قاعدة البيانات لكل حساب وطني (Alwatani Database)
 * 
 * هذا الملف ينشئ قاعدة بيانات منفصلة لكل حساب وطني
 * كل حساب وطني له قاعدة بيانات منفصلة تماماً
 */

const mysql = require('mysql2/promise');
const config = require('./config');

/**
 * الحصول على اسم قاعدة البيانات للحساب الوطني
 * @param {string} username - اسم المستخدم الوطني (مثل: bot.n8nf)
 * @returns {string} - اسم قاعدة البيانات (مثل: ftth_alwatani_bot_n8nf)
 */
function getAlwataniDatabaseName(username) {
    if (!username) {
        throw new Error('Alwatani username is required');
    }
    
    // تنظيف اسم المستخدم (استبدال النقاط بشرطات سفلية وإزالة الأحرف الخاصة)
    const cleanUsername = username
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')  // استبدال الأحرف الخاصة بشرطات سفلية
        .replace(/_+/g, '_')           // استبدال الشرطات المتعددة بشرطة واحدة
        .replace(/^_|_$/g, '');        // إزالة الشرطات من البداية والنهاية
    
    return `ftth_alwatani_${cleanUsername}`;
}

/**
 * إنشاء قاعدة بيانات جديدة للحساب الوطني
 * @param {string} username - اسم المستخدم الوطني
 * @returns {Promise<string>} - اسم قاعدة البيانات المنشأة
 */
async function initAlwataniDatabase(username) {
    if (!username) {
        throw new Error('Alwatani username is required');
    }
    
    const dbName = getAlwataniDatabaseName(username);
    let connection;
    
    try {
        console.log(`🔄 جاري إنشاء قاعدة البيانات: ${dbName}...`);
        
        // الاتصال بـ MySQL بدون قاعدة بيانات أولاً لإنشائها
        connection = await mysql.createConnection({
            host: config.db.host,
            user: config.db.user,
            password: config.db.password
        });
        
        console.log('✅ تم الاتصال بـ MySQL بنجاح');
        
        // إنشاء قاعدة البيانات إذا لم تكن موجودة
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        console.log(`✅ تم إنشاء قاعدة البيانات: ${dbName}`);
        
        // استخدام قاعدة البيانات
        await connection.query(`USE \`${dbName}\``);
        
        // ==================== 1. جدول alwatani_customers_cache (ذاكرة التخزين المؤقت للمشتركين) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS alwatani_customers_cache (
                id INT PRIMARY KEY AUTO_INCREMENT,
                account_id VARCHAR(255) NOT NULL,
                username VARCHAR(255),
                device_name VARCHAR(255),
                phone VARCHAR(20),
                region VARCHAR(255),
                page_url TEXT,
                start_date DATE,
                end_date DATE,
                status VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_account_id (account_id),
                INDEX idx_phone (phone),
                INDEX idx_status (status),
                INDEX idx_username (username)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: alwatani_customers_cache');
        
        // ==================== 2. جدول wallet_transactions (معاملات المحفظة) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS wallet_transactions (
                id BIGINT PRIMARY KEY AUTO_INCREMENT,
                transaction_id BIGINT NOT NULL COMMENT 'معرف الحوالة من API الوطني',
                partner_id INT NOT NULL COMMENT 'معرف الشريك (Partner ID)',
                transaction_data JSON NOT NULL COMMENT 'بيانات الحوالة الكاملة (JSON)',
                transaction_type VARCHAR(100) COMMENT 'نوع الحوالة',
                transaction_amount DECIMAL(15, 2) COMMENT 'مبلغ الحوالة',
                occured_at DATETIME COMMENT 'تاريخ حدوث الحوالة',
                synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT 'تاريخ المزامنة',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_transaction_partner (transaction_id, partner_id),
                INDEX idx_transaction_id (transaction_id),
                INDEX idx_partner_id (partner_id),
                INDEX idx_transaction_type (transaction_type),
                INDEX idx_occured_at (occured_at),
                INDEX idx_synced_at (synced_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: wallet_transactions');
        
        await connection.end();
        console.log(`✅ تم إنهاء الاتصال بقاعدة البيانات: ${dbName}`);
        
        return dbName;
    } catch (error) {
        if (connection) {
            await connection.end().catch(() => {});
        }
        console.error(`❌ خطأ في إنشاء قاعدة البيانات ${dbName}:`, error.message);
        throw error;
    }
}

module.exports = {
    getAlwataniDatabaseName,
    initAlwataniDatabase
};
