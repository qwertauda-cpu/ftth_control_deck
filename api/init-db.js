const mysql = require('mysql2/promise');
const config = require('./config');

async function initDatabase() {
    let connection;
    
    try {
        console.log('🔄 جاري الاتصال بـ MySQL...');
        
        // Connect without database first to create it
        connection = await mysql.createConnection({
            host: config.db.host,
            user: config.db.user,
            password: config.db.password
        });
        
        console.log('✅ تم الاتصال بـ MySQL بنجاح');
        
        // Create database if not exists
        await connection.query(`CREATE DATABASE IF NOT EXISTS ${config.db.database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        console.log(`✅ تم إنشاء قاعدة البيانات: ${config.db.database}`);
        
        // Use the database
        await connection.query(`USE ${config.db.database}`);
        
        // Create users table (for initial login - واجهة تسجيل الدخول الأولى)
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
        console.log('✅ تم إنشاء جدول: users (واجهة تسجيل الدخول الأولى)');
        
        // إضافة الأعمدة الجديدة إذا كان الجدول موجوداً مسبقاً
        try {
            await connection.query(`
                ALTER TABLE users 
                ADD COLUMN IF NOT EXISTS display_name VARCHAR(255) AFTER role,
                ADD COLUMN IF NOT EXISTS position VARCHAR(50) AFTER display_name,
                ADD COLUMN IF NOT EXISTS permissions JSON AFTER position,
                ADD COLUMN IF NOT EXISTS created_by INT AFTER permissions,
                ADD COLUMN IF NOT EXISTS agent_name VARCHAR(255) COMMENT 'اسم الوكيل الثلاثي' AFTER created_by,
                ADD COLUMN IF NOT EXISTS company_name VARCHAR(255) COMMENT 'اسم الشركة' AFTER agent_name,
                ADD COLUMN IF NOT EXISTS governorate VARCHAR(100) COMMENT 'المحافظة' AFTER company_name,
                ADD COLUMN IF NOT EXISTS region VARCHAR(100) COMMENT 'المنطقة' AFTER governorate,
                ADD COLUMN IF NOT EXISTS phone VARCHAR(20) COMMENT 'رقم الهاتف' AFTER region,
                ADD COLUMN IF NOT EXISTS email VARCHAR(255) COMMENT 'البريد الإلكتروني' AFTER phone,
                ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE COMMENT 'حالة تفعيل الحساب' AFTER email
            `);
            console.log('✅ تم تحديث جدول users بإضافة الحقول الجديدة');
        } catch (error) {
            // تجاهل الخطأ إذا كانت الأعمدة موجودة بالفعل
            if (!error.message.includes('Duplicate column name')) {
                console.warn('⚠️ تحذير عند تحديث جدول users:', error.message);
            }
        }
        
        // إضافة index للمحافظة إذا لم يكن موجوداً
        try {
            await connection.query(`ALTER TABLE users ADD INDEX IF NOT EXISTS idx_governorate (governorate)`);
        } catch (error) {
            if (!error.message.includes('Duplicate key name')) {
                console.warn('⚠️ تحذير عند إضافة index للمحافظة:', error.message);
            }
        }
        
        // إضافة foreign key إذا لم يكن موجوداً
        try {
            await connection.query(`
                ALTER TABLE users 
                ADD CONSTRAINT IF NOT EXISTS fk_users_created_by 
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
            `);
        } catch (error) {
            // تجاهل الخطأ إذا كان foreign key موجوداً بالفعل
            if (!error.message.includes('Duplicate foreign key')) {
                console.warn('⚠️ تحذير عند إضافة foreign key:', error.message);
            }
        }
        
        // Create alwatani_login table (for Alwatani accounts - واجهة تسجيل الدخول الثانية)
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
        console.log('✅ تم إنشاء جدول: alwatani_login (واجهة تسجيل الدخول الثانية - حساب الوطني)');
        
        // إضافة الأعمدة الجديدة إذا كان الجدول موجوداً مسبقاً
        try {
            await connection.query(`
                ALTER TABLE alwatani_login 
                ADD COLUMN IF NOT EXISTS user_id INT NOT NULL AFTER id
            `);
            console.log('✅ تم تحديث جدول alwatani_login بإضافة user_id');
            
            // إضافة index و foreign key
            try {
                await connection.query(`ALTER TABLE alwatani_login ADD INDEX IF NOT EXISTS idx_user_id (user_id)`);
            } catch (e) {}
            
            try {
                await connection.query(`
                    ALTER TABLE alwatani_login 
                    ADD CONSTRAINT IF NOT EXISTS fk_alwatani_user_id 
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                `);
            } catch (e) {}
            
            // تغيير UNIQUE constraint ليشمل user_id
            try {
                await connection.query(`
                    ALTER TABLE alwatani_login 
                    DROP INDEX IF EXISTS username
                `);
            } catch (e) {}
            
            try {
                await connection.query(`
                    ALTER TABLE alwatani_login 
                    ADD UNIQUE KEY IF NOT EXISTS unique_user_username (user_id, username)
                `);
            } catch (e) {
                // إذا فشل، قد يكون لأن هناك بيانات موجودة، نحاول تحديثها يدوياً
                console.warn('⚠️ قد تحتاج لتحديث UNIQUE constraint يدوياً');
            }
        } catch (error) {
            if (!error.message.includes('Duplicate column name')) {
                console.warn('⚠️ تحذير عند تحديث جدول alwatani_login:', error.message);
            }
        }
        
        // Create dashboard_users table (for users added from dashboard - إدارة المشتركين)
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
        
        // Create subscribers table (FTTH subscribers data)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS subscribers (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id INT NOT NULL,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50) NOT NULL,
                zone VARCHAR(100),
                page_url TEXT,
                start_date DATE,
                end_date DATE,
                status VARCHAR(50) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_user_id (user_id),
                INDEX idx_name (name),
                INDEX idx_phone (phone),
                INDEX idx_zone (zone),
                INDEX idx_status (status),
                INDEX idx_end_date (end_date),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: subscribers');
        
        // إضافة user_id إلى جدول subscribers إذا لم يكن موجوداً
        try {
            await connection.query(`
                ALTER TABLE subscribers 
                ADD COLUMN IF NOT EXISTS user_id INT NOT NULL AFTER id,
                ADD INDEX IF NOT EXISTS idx_user_id (user_id)
            `);
            console.log('✅ تم إضافة user_id إلى جدول subscribers');
            
            // إضافة foreign key إذا لم يكن موجوداً
            try {
                await connection.query(`
                    ALTER TABLE subscribers 
                    ADD CONSTRAINT IF NOT EXISTS fk_subscribers_user_id 
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                `);
            } catch (e) {
                if (!e.message.includes('Duplicate foreign key')) {
                    console.warn('⚠️ تحذير عند إضافة foreign key لجدول subscribers:', e.message);
                }
            }
        } catch (error) {
            if (!error.message.includes('Duplicate column name')) {
                console.warn('⚠️ تحذير عند تحديث جدول subscribers:', error.message);
            }
        }
        
        // ==================== Create tickets table - REMOVED ====================
        // تم حذف إنشاء جدول tickets المحلية وجميع الكود المتعلق به
        // النظام الآن يجلب التذاكر فقط من موقع الوطني
        
        // Create teams table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS teams (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id INT NOT NULL,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                status VARCHAR(50) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_user_id (user_id),
                INDEX idx_name (name),
                INDEX idx_status (status),
                UNIQUE KEY unique_user_name (user_id, name),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: teams');
        
        // إضافة user_id إلى جدول teams إذا لم يكن موجوداً
        try {
            await connection.query(`
                ALTER TABLE teams 
                ADD COLUMN IF NOT EXISTS user_id INT NOT NULL AFTER id,
                ADD INDEX IF NOT EXISTS idx_user_id (user_id)
            `);
            console.log('✅ تم إضافة user_id إلى جدول teams');
            
            // إضافة UNIQUE constraint لاسم الفريق لكل مستخدم
            try {
                await connection.query(`
                    ALTER TABLE teams 
                    ADD UNIQUE KEY IF NOT EXISTS unique_user_name (user_id, name)
                `);
            } catch (e) {}
            
            // إضافة foreign key إذا لم يكن موجوداً
            try {
                await connection.query(`
                    ALTER TABLE teams 
                    ADD CONSTRAINT IF NOT EXISTS fk_teams_user_id 
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                `);
            } catch (e) {
                if (!e.message.includes('Duplicate foreign key')) {
                    console.warn('⚠️ تحذير عند إضافة foreign key لجدول teams:', e.message);
                }
            }
        } catch (error) {
            if (!error.message.includes('Duplicate column name')) {
                console.warn('⚠️ تحذير عند تحديث جدول teams:', error.message);
            }
        }
        
        // Create team_members table (for team members)
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
        
        // Create imported_accounts table (for accounts imported from external APIs)
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
        console.log('✅ تم إنشاء جدول: imported_accounts');
        
        // Create alwatani_customers_cache table (for cached customer data from Alwatani)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS alwatani_customers_cache (
                id BIGINT PRIMARY KEY AUTO_INCREMENT,
                user_id INT NOT NULL,
                account_id VARCHAR(255) NOT NULL,
                partner_id INT NOT NULL,
                customer_data JSON NOT NULL,
                synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_user_account_partner (user_id, account_id, partner_id),
                INDEX idx_user_id (user_id),
                INDEX idx_partner_id (partner_id),
                INDEX idx_synced_at (synced_at),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: alwatani_customers_cache (مشتركين الوطني المحفوظين محلياً)');
        
        // إضافة user_id إلى جدول alwatani_customers_cache إذا لم يكن موجوداً
        try {
            await connection.query(`
                ALTER TABLE alwatani_customers_cache 
                ADD COLUMN IF NOT EXISTS user_id INT NOT NULL AFTER id,
                ADD INDEX IF NOT EXISTS idx_user_id (user_id)
            `);
            console.log('✅ تم إضافة user_id إلى جدول alwatani_customers_cache');
            
            // تحديث UNIQUE constraint ليشمل user_id
            try {
                await connection.query(`ALTER TABLE alwatani_customers_cache DROP INDEX IF EXISTS unique_account_partner`);
            } catch (e) {}
            
            try {
                await connection.query(`
                    ALTER TABLE alwatani_customers_cache 
                    ADD UNIQUE KEY IF NOT EXISTS unique_user_account_partner (user_id, account_id, partner_id)
                `);
            } catch (e) {}
            
            // إضافة foreign key إذا لم يكن موجوداً
            try {
                await connection.query(`
                    ALTER TABLE alwatani_customers_cache 
                    ADD CONSTRAINT IF NOT EXISTS fk_alwatani_customers_user_id 
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                `);
            } catch (e) {
                if (!e.message.includes('Duplicate foreign key')) {
                    console.warn('⚠️ تحذير عند إضافة foreign key لجدول alwatani_customers_cache:', e.message);
        }
            }
        } catch (error) {
            if (!error.message.includes('Duplicate column name')) {
                console.warn('⚠️ تحذير عند تحديث جدول alwatani_customers_cache:', error.message);
            }
        }
        
        // Create wallet_transactions table (for cached wallet transactions)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS wallet_transactions (
                id BIGINT PRIMARY KEY AUTO_INCREMENT,
                user_id INT NOT NULL,
                transaction_id BIGINT NOT NULL,
                partner_id INT NOT NULL,
                transaction_data JSON NOT NULL,
                transaction_type VARCHAR(100),
                transaction_amount DECIMAL(15, 2),
                occured_at DATETIME,
                synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_user_transaction_partner (user_id, transaction_id, partner_id),
                INDEX idx_user_id (user_id),
                INDEX idx_partner_id (partner_id),
                INDEX idx_transaction_type (transaction_type),
                INDEX idx_occured_at (occured_at),
                INDEX idx_synced_at (synced_at),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: wallet_transactions (حوالات المحفظة المحفوظة محلياً)');
        
        // إضافة user_id إلى جدول wallet_transactions إذا لم يكن موجوداً
        try {
            await connection.query(`
                ALTER TABLE wallet_transactions 
                ADD COLUMN IF NOT EXISTS user_id INT NOT NULL AFTER id,
                ADD INDEX IF NOT EXISTS idx_user_id (user_id)
            `);
            console.log('✅ تم إضافة user_id إلى جدول wallet_transactions');
            
            // تحديث UNIQUE constraint ليشمل user_id
            try {
                await connection.query(`ALTER TABLE wallet_transactions DROP INDEX IF EXISTS unique_transaction_partner`);
            } catch (e) {}
            
            try {
                await connection.query(`
                    ALTER TABLE wallet_transactions 
                    ADD UNIQUE KEY IF NOT EXISTS unique_user_transaction_partner (user_id, transaction_id, partner_id)
                `);
            } catch (e) {}
            
            // إضافة foreign key إذا لم يكن موجوداً
            try {
                await connection.query(`
                    ALTER TABLE wallet_transactions 
                    ADD CONSTRAINT IF NOT EXISTS fk_wallet_transactions_user_id 
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                `);
            } catch (e) {
                if (!e.message.includes('Duplicate foreign key')) {
                    console.warn('⚠️ تحذير عند إضافة foreign key لجدول wallet_transactions:', e.message);
                }
            }
        } catch (error) {
            if (!error.message.includes('Duplicate column name')) {
                console.warn('⚠️ تحذير عند تحديث جدول wallet_transactions:', error.message);
            }
        }
        
        // ملاحظة: لا نضيف فرق افتراضية أو مشتركين افتراضيين لأنهم يحتاجون user_id
        // كل مستخدم سيضيف فرقه ومشتركيه بنفسه
        
        console.log('\n🎉 تم إعداد قاعدة البيانات بنجاح!');
        console.log('📝 يمكنك الآن تشغيل الخادم باستخدام: npm start');
        
    } catch (error) {
        console.error('❌ خطأ في إعداد قاعدة البيانات:', error.message);
        console.error('\n💡 تأكد من:');
        console.error('   1. تشغيل XAMPP');
        console.error('   2. تشغيل خدمة MySQL في XAMPP');
        console.error('   3. صحة بيانات الاتصال في ملف .env');
        process.exit(1);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

// Run the initialization
initDatabase();

