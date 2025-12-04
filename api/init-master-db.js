/**
 * إنشاء قاعدة البيانات الرئيسية (Master Database)
 * 
 * هذه القاعدة تخزن معلومات جميع المالكين وقواعد البيانات الخاصة بكل مالك
 */

const mysql = require('mysql2/promise');
const config = require('./config');

async function initMasterDatabase() {
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
        
        // Create master database
        const masterDbName = config.master.database;
        await connection.query(`CREATE DATABASE IF NOT EXISTS ${masterDbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        console.log(`✅ تم إنشاء قاعدة البيانات الرئيسية: ${masterDbName}`);
        
        // Use the master database
        await connection.query(`USE ${masterDbName}`);
        
        // Create owners_databases table
        await connection.query(`
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
        console.log('✅ تم إنشاء جدول: owners_databases');
        
        // Create chat_messages table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INT PRIMARY KEY AUTO_INCREMENT,
                sender_id INT NOT NULL COMMENT 'معرف المرسل (admin user id)',
                sender_name VARCHAR(255) NOT NULL COMMENT 'اسم المرسل',
                sender_role VARCHAR(50) DEFAULT 'admin' COMMENT 'دور المرسل (admin, manager, user)',
                message TEXT NOT NULL COMMENT 'نص الرسالة',
                message_type VARCHAR(20) DEFAULT 'text' COMMENT 'نوع الرسالة (text, image, file)',
                file_url VARCHAR(500) COMMENT 'رابط الملف/الصورة',
                file_name VARCHAR(255) COMMENT 'اسم الملف',
                file_size INT COMMENT 'حجم الملف بالبايت',
                is_read BOOLEAN DEFAULT FALSE COMMENT 'هل تمت قراءة الرسالة',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_sender_id (sender_id),
                INDEX idx_created_at (created_at),
                INDEX idx_is_read (is_read)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: chat_messages');
        
        // Create chat_participants table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS chat_participants (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id INT NOT NULL COMMENT 'معرف المستخدم',
                username VARCHAR(255) NOT NULL COMMENT 'اسم المستخدم',
                display_name VARCHAR(255) COMMENT 'الاسم المعروض',
                email VARCHAR(255) COMMENT 'البريد الإلكتروني',
                phone VARCHAR(20) COMMENT 'رقم الهاتف',
                role VARCHAR(50) DEFAULT 'user' COMMENT 'الدور (admin, manager, user)',
                is_active BOOLEAN DEFAULT TRUE COMMENT 'حالة التفعيل',
                last_seen TIMESTAMP NULL COMMENT 'آخر ظهور',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_user_id (user_id),
                INDEX idx_username (username),
                INDEX idx_role (role),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: chat_participants');
        
        console.log('\n🎉 تم إعداد قاعدة البيانات الرئيسية بنجاح!');
        console.log('📝 الآن يمكنك إنشاء قواعد البيانات للعملاء');
        
    } catch (error) {
        console.error('❌ خطأ في إعداد قاعدة البيانات الرئيسية:', error.message);
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
initMasterDatabase();

