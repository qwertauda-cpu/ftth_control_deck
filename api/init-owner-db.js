/**
 * إنشاء هيكل قاعدة البيانات لكل مالك (Owner Database)
 * 
 * هذا الملف ينشئ جميع الجداول اللازمة لكل مالك
 * كل مالك له قاعدة بيانات منفصلة تماماً
 */

const mysql = require('mysql2/promise');
const config = require('./config');

async function initOwnerDatabase(databaseName) {
    let connection;
    
    try {
        console.log(`🔄 جاري إنشاء قاعدة البيانات: ${databaseName}...`);
        
        // Connect without database first to create it
        connection = await mysql.createConnection({
            host: config.db.host,
            user: config.db.user,
            password: config.db.password
        });
        
        console.log('✅ تم الاتصال بـ MySQL بنجاح');
        
        // Create database if not exists
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        console.log(`✅ تم إنشاء قاعدة البيانات: ${databaseName}`);
        
        // Use the database
        await connection.query(`USE \`${databaseName}\``);
        
        // ==================== 1. جدول users (المستخدمين والموظفين) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'user',
                display_name VARCHAR(255),
                position VARCHAR(50),
                permissions JSON,
                created_by INT,
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
                INDEX idx_position (position),
                INDEX idx_created_by (created_by),
                INDEX idx_governorate (governorate),
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: users (المستخدمين والموظفين)');
        
        // ==================== 2. جدول alwatani_login (حسابات الوطني) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS alwatani_login (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id INT NOT NULL,
                username VARCHAR(255) NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'user',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_username (username),
                INDEX idx_user_id (user_id),
                UNIQUE KEY unique_user_username (user_id, username),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: alwatani_login (حسابات الوطني)');
        
        // ==================== 3. جدول dashboard_users (مستخدمي لوحة التحكم) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS dashboard_users (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'user',
                notes TEXT,
                created_by INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_username (username),
                INDEX idx_created_by (created_by),
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: dashboard_users (مستخدمي لوحة التحكم)');
        
        // ==================== 4. جدول subscribers (المشتركين) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS subscribers (
                id INT PRIMARY KEY AUTO_INCREMENT,
                alwatani_login_id INT NOT NULL COMMENT 'معرف حساب الوطني المرتبط',
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50) NOT NULL,
                zone VARCHAR(100),
                page_url TEXT,
                start_date DATE,
                end_date DATE,
                status VARCHAR(50) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_phone (phone),
                INDEX idx_zone (zone),
                INDEX idx_status (status),
                INDEX idx_end_date (end_date),
                INDEX idx_alwatani_login_id (alwatani_login_id),
                FOREIGN KEY (alwatani_login_id) REFERENCES alwatani_login(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: subscribers (المشتركين)');
        
        // ==================== 5. جدول tickets (التذاكر) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS tickets (
                id INT PRIMARY KEY AUTO_INCREMENT,
                alwatani_login_id INT NOT NULL COMMENT 'معرف حساب الوطني المرتبط',
                ticket_number VARCHAR(50) NOT NULL,
                subscriber_name VARCHAR(255) NOT NULL,
                description TEXT,
                team VARCHAR(100),
                status VARCHAR(50) DEFAULT 'open',
                priority VARCHAR(50) DEFAULT 'medium',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_ticket_alwatani (ticket_number, alwatani_login_id),
                INDEX idx_ticket_number (ticket_number),
                INDEX idx_status (status),
                INDEX idx_team (team),
                INDEX idx_alwatani_login_id (alwatani_login_id),
                FOREIGN KEY (alwatani_login_id) REFERENCES alwatani_login(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: tickets (التذاكر)');
        
        // ==================== 6. جدول teams (الفرق) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS teams (
                id INT PRIMARY KEY AUTO_INCREMENT,
                alwatani_login_id INT NOT NULL COMMENT 'معرف حساب الوطني المرتبط',
                name VARCHAR(255) NOT NULL,
                description TEXT,
                status VARCHAR(50) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_team_alwatani (name, alwatani_login_id),
                INDEX idx_name (name),
                INDEX idx_status (status),
                INDEX idx_alwatani_login_id (alwatani_login_id),
                FOREIGN KEY (alwatani_login_id) REFERENCES alwatani_login(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: teams (الفرق)');
        
        // ==================== 7. جدول team_members (أعضاء الفرق) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS team_members (
                id INT PRIMARY KEY AUTO_INCREMENT,
                team_id INT NOT NULL,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                photo_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_team_id (team_id),
                FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: team_members (أعضاء الفرق)');
        
        // ==================== 8. جدول imported_accounts (الحسابات المستوردة) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS imported_accounts (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(255) NOT NULL,
                password VARCHAR(255) NOT NULL,
                source VARCHAR(255) DEFAULT 'external_api',
                api_url TEXT,
                original_data JSON,
                status VARCHAR(50) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_username (username),
                INDEX idx_source (source),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: imported_accounts (الحسابات المستوردة)');
        
        // ==================== 9. جدول alwatani_customers_cache (مشتركين الوطني المحفوظين محلياً) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS alwatani_customers_cache (
                id BIGINT PRIMARY KEY AUTO_INCREMENT,
                alwatani_login_id INT NOT NULL COMMENT 'معرف حساب الوطني المرتبط',
                account_id VARCHAR(255) NOT NULL,
                partner_id INT NOT NULL,
                customer_data JSON NOT NULL,
                synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_account_partner_alwatani (account_id, partner_id, alwatani_login_id),
                INDEX idx_partner_id (partner_id),
                INDEX idx_synced_at (synced_at),
                INDEX idx_alwatani_login_id (alwatani_login_id),
                FOREIGN KEY (alwatani_login_id) REFERENCES alwatani_login(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: alwatani_customers_cache (مشتركين الوطني المحفوظين محلياً)');
        
        // ==================== 10. جدول wallet_transactions (حوالات المحفظة المحفوظة محلياً) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS wallet_transactions (
                id BIGINT PRIMARY KEY AUTO_INCREMENT,
                alwatani_login_id INT NOT NULL COMMENT 'معرف حساب الوطني المرتبط',
                transaction_id BIGINT NOT NULL,
                partner_id INT NOT NULL,
                transaction_data JSON NOT NULL,
                transaction_type VARCHAR(100),
                transaction_amount DECIMAL(15, 2),
                occured_at DATETIME,
                synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_transaction_partner_alwatani (transaction_id, partner_id, alwatani_login_id),
                INDEX idx_partner_id (partner_id),
                INDEX idx_transaction_type (transaction_type),
                INDEX idx_occured_at (occured_at),
                INDEX idx_synced_at (synced_at),
                INDEX idx_alwatani_login_id (alwatani_login_id),
                FOREIGN KEY (alwatani_login_id) REFERENCES alwatani_login(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: wallet_transactions (حوالات المحفظة المحفوظة محلياً)');
        
        console.log(`\n🎉 تم إعداد قاعدة البيانات ${databaseName} بنجاح!`);
        console.log('📝 جميع الجداول جاهزة للاستخدام');
        
        return true;
        
    } catch (error) {
        console.error(`❌ خطأ في إعداد قاعدة البيانات ${databaseName}:`, error.message);
        throw error;
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

// إذا تم تشغيل الملف مباشرة
if (require.main === module) {
    const dbName = process.argv[2];
    if (!dbName) {
        console.error('❌ يرجى تحديد اسم قاعدة البيانات');
        console.error('📝 الاستخدام: node init-owner-db.js <database_name>');
        process.exit(1);
    }
    
    initOwnerDatabase(dbName)
        .then(() => {
            console.log('\n✅ اكتمل بنجاح!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ فشل الإنشاء:', error.message);
            process.exit(1);
        });
}

module.exports = { initOwnerDatabase };

