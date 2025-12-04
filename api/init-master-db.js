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
        
        // ==================== جدول chat_rooms (المحادثات) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS chat_rooms (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) NOT NULL COMMENT 'اسم المحادثة',
                description TEXT COMMENT 'وصف المحادثة',
                created_by VARCHAR(255) NOT NULL COMMENT 'منشئ المحادثة (owner_username)',
                status VARCHAR(50) DEFAULT 'active' COMMENT 'حالة المحادثة (active, archived)',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_created_by (created_by),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: chat_rooms (المحادثات)');
        
        // ==================== جدول chat_members (أعضاء المحادثة) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS chat_members (
                id INT PRIMARY KEY AUTO_INCREMENT,
                chat_room_id INT NOT NULL,
                owner_username VARCHAR(255) NOT NULL COMMENT 'اسم المالك (مثل: admin@tec)',
                status VARCHAR(50) DEFAULT 'active' COMMENT 'حالة العضوية (active, left)',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_chat_member (chat_room_id, owner_username),
                INDEX idx_chat_room_id (chat_room_id),
                INDEX idx_owner_username (owner_username),
                FOREIGN KEY (chat_room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: chat_members (أعضاء المحادثة)');
        
        // ==================== جدول chat_membership_requests (طلبات الانضمام للمحادثة) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS chat_membership_requests (
                id INT PRIMARY KEY AUTO_INCREMENT,
                chat_room_id INT NOT NULL,
                owner_username VARCHAR(255) NOT NULL COMMENT 'اسم المالك الذي يطلب الانضمام',
                status VARCHAR(50) DEFAULT 'pending' COMMENT 'حالة الطلب (pending, approved, rejected)',
                requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                approved_at TIMESTAMP NULL,
                approved_by VARCHAR(255) COMMENT 'من وافق على الطلب',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_pending_request (chat_room_id, owner_username, status),
                INDEX idx_chat_room_id (chat_room_id),
                INDEX idx_owner_username (owner_username),
                INDEX idx_status (status),
                FOREIGN KEY (chat_room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: chat_membership_requests (طلبات الانضمام)');
        
        // ==================== جدول chat_messages (رسائل المحادثة) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INT PRIMARY KEY AUTO_INCREMENT,
                chat_room_id INT NOT NULL,
                sender_username VARCHAR(255) NOT NULL COMMENT 'مرسل الرسالة (owner_username)',
                message TEXT NOT NULL COMMENT 'نص الرسالة',
                message_type VARCHAR(50) DEFAULT 'text' COMMENT 'نوع الرسالة (text, file, image)',
                file_url TEXT COMMENT 'رابط الملف إذا كانت الرسالة ملف',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_chat_room_id (chat_room_id),
                INDEX idx_sender_username (sender_username),
                INDEX idx_created_at (created_at),
                FOREIGN KEY (chat_room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: chat_messages (رسائل المحادثة)');
        
        // ==================== جدول control_accounts (حسابات لوحة التحكم) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS control_accounts (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(255) UNIQUE NOT NULL COMMENT 'اسم المستخدم',
                password_hash VARCHAR(255) NOT NULL COMMENT 'كلمة المرور المشفرة',
                full_name VARCHAR(255) COMMENT 'الاسم الكامل',
                email VARCHAR(255) COMMENT 'البريد الإلكتروني',
                role VARCHAR(50) DEFAULT 'admin' COMMENT 'الدور (admin, manager, viewer)',
                is_active BOOLEAN DEFAULT TRUE COMMENT 'حالة تفعيل الحساب',
                last_login TIMESTAMP NULL COMMENT 'آخر تسجيل دخول',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                created_by INT COMMENT 'من أنشأ الحساب',
                INDEX idx_username (username),
                INDEX idx_email (email),
                INDEX idx_role (role),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: control_accounts (حسابات لوحة التحكم)');
        
        // ==================== جدول flowchart_data (مخططات Flowchart) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS flowchart_data (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) NOT NULL COMMENT 'اسم المخطط',
                description TEXT COMMENT 'وصف المخطط',
                nodes JSON NOT NULL COMMENT 'العقد (Nodes)',
                edges JSON NOT NULL COMMENT 'الروابط (Edges)',
                created_by VARCHAR(255) NOT NULL COMMENT 'منشئ المخطط',
                updated_by VARCHAR(255) COMMENT 'آخر من عدل المخطط',
                is_active BOOLEAN DEFAULT TRUE COMMENT 'حالة المخطط',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_created_by (created_by),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: flowchart_data (مخططات Flowchart)');
        
        // ==================== جدول employees (الموظفين) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS employees (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(255) UNIQUE NOT NULL COMMENT 'اسم المستخدم',
                password_hash VARCHAR(255) NOT NULL COMMENT 'كلمة المرور المشفرة',
                full_name VARCHAR(255) NOT NULL COMMENT 'الاسم الكامل',
                email VARCHAR(255) COMMENT 'البريد الإلكتروني',
                phone VARCHAR(20) COMMENT 'رقم الهاتف',
                position VARCHAR(100) COMMENT 'المنصب',
                department VARCHAR(100) COMMENT 'القسم',
                permissions JSON COMMENT 'الصلاحيات (JSON object)',
                salary DECIMAL(10, 2) COMMENT 'الراتب',
                hire_date DATE COMMENT 'تاريخ التوظيف',
                is_active BOOLEAN DEFAULT TRUE COMMENT 'حالة تفعيل الحساب',
                last_login TIMESTAMP NULL COMMENT 'آخر تسجيل دخول',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                created_by INT COMMENT 'من أنشأ الحساب',
                INDEX idx_username (username),
                INDEX idx_email (email),
                INDEX idx_is_active (is_active),
                INDEX idx_department (department)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: employees (الموظفين)');
        
        // ==================== جدول invoices (الفواتير) ====================
        await connection.query(`
            CREATE TABLE IF NOT EXISTS invoices (
                id INT PRIMARY KEY AUTO_INCREMENT,
                invoice_number VARCHAR(50) UNIQUE NOT NULL COMMENT 'رقم الفاتورة',
                owner_username VARCHAR(255) NOT NULL COMMENT 'اسم المالك (مثل: admin@tec)',
                invoice_type VARCHAR(50) DEFAULT 'rental' COMMENT 'نوع الفاتورة (rental, service, other)',
                amount DECIMAL(10, 2) NOT NULL COMMENT 'المبلغ',
                currency VARCHAR(10) DEFAULT 'IQD' COMMENT 'العملة',
                issue_date DATE NOT NULL COMMENT 'تاريخ الإصدار',
                due_date DATE COMMENT 'تاريخ الاستحقاق',
                status VARCHAR(50) DEFAULT 'pending' COMMENT 'حالة الفاتورة (pending, paid, overdue, cancelled)',
                payment_method VARCHAR(50) COMMENT 'طريقة الدفع',
                payment_date DATE COMMENT 'تاريخ الدفع',
                description TEXT COMMENT 'وصف الفاتورة',
                notes TEXT COMMENT 'ملاحظات',
                items JSON COMMENT 'عناصر الفاتورة (JSON array)',
                tax_rate DECIMAL(5, 2) DEFAULT 0 COMMENT 'نسبة الضريبة',
                tax_amount DECIMAL(10, 2) DEFAULT 0 COMMENT 'مبلغ الضريبة',
                total_amount DECIMAL(10, 2) NOT NULL COMMENT 'المبلغ الإجمالي',
                created_by VARCHAR(255) COMMENT 'من أنشأ الفاتورة',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_invoice_number (invoice_number),
                INDEX idx_owner_username (owner_username),
                INDEX idx_status (status),
                INDEX idx_issue_date (issue_date),
                INDEX idx_due_date (due_date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ تم إنشاء جدول: invoices (الفواتير)');
        
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

