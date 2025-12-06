# دليل الاتصال بقاعدة البيانات

## معلومات الاتصال

### للإنتاج (السيرفر):
```
Host: 130.211.200.58 (أو IP السيرفر)
Port: 3306
User: root (أو المستخدم المحدد)
Password: [كلمة المرور]
```

### للمحلي (XAMPP):
```
Host: localhost
Port: 3306
User: root
Password: (فارغ عادة)
```

## قواعد البيانات المتاحة:

1. **ftth_master** - القاعدة الرئيسية (معلومات المالكين)
2. **ftth_owner_tec** - قاعدة بيانات المالك (tec)
3. **ftth_alwatani_[username]** - قواعد بيانات المشتركين لكل حساب وطني

## برامج إدارة قواعد البيانات الموصى بها:

### 1. DBeaver (الأفضل - مجاني)
- التحميل: https://dbeaver.io/download/
- يدعم MySQL/MariaDB
- واجهة سهلة وقوية

### 2. MySQL Workbench (رسمي)
- التحميل: https://dev.mysql.com/downloads/workbench/
- من Oracle (مطوري MySQL)

### 3. HeidiSQL (Windows فقط)
- التحميل: https://www.heidisql.com/download.php
- خفيف وسريع

### 4. phpMyAdmin (ويب)
- متوفر مع XAMPP
- رابط: http://localhost/phpmyadmin

## خطوات الاتصال بـ DBeaver:

1. افتح DBeaver
2. اضغط على "New Database Connection"
3. اختر "MySQL"
4. أدخل:
   - Host: localhost (أو IP السيرفر)
   - Port: 3306
   - Database: ftth_master (أو أي قاعدة بيانات)
   - Username: root
   - Password: [كلمة المرور]
5. اضغط "Test Connection"
6. اضغط "Finish"

## تحسينات الأداء المقترحة:

1. **زيادة Connection Limit** في `config.js`:
   ```javascript
   connectionLimit: 20  // بدلاً من 10
   ```

2. **إضافة Indexes** على الأعمدة المستخدمة كثيراً في البحث

3. **استخدام Query Caching** في MySQL

4. **تنظيف البيانات القديمة** دورياً

