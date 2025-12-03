# دليل التحديث التلقائي من Cursor إلى السيرفر

## نظرة عامة
هذا النظام يسمح بتحديث السيرفر تلقائياً عند عمل `git push` من Cursor إلى GitHub.

## الخطوات

### 1. إعداد المشروع على السيرفر

#### أ) Clone المشروع على السيرفر:
```bash
ssh username@your-server-ip
cd /var/www
git clone https://github.com/qwertauda-cpu/ftth_control_deck.git ftth_control_deck
cd ftth_control_deck/api
npm install
```

#### ب) إعداد ملف `.env`:
```bash
cd /var/www/ftth_control_deck/api
cp ENV_TEMPLATE.env .env
nano .env
```

أضف هذه المتغيرات:
```env
PROJECT_PATH=/var/www/ftth_control_deck
PM2_APP_NAME=ftth-api
GITHUB_WEBHOOK_SECRET=your-secret-here
```

#### ج) تشغيل المشروع بـ PM2:
```bash
cd /var/www/ftth_control_deck/api
pm2 start server.js --name ftth-api
pm2 save
```

#### د) تشغيل Admin Server:
```bash
cd /var/www/ftth_control_deck/api
pm2 start Untitled-1.js --name admin-server
pm2 save
```

#### هـ) جعل script قابل للتنفيذ:
```bash
chmod +x /var/www/ftth_control_deck/api/deploy.sh
```

---

### 2. إعداد GitHub Webhook

#### أ) اذهب إلى إعدادات المستودع:
1. افتح: https://github.com/qwertauda-cpu/ftth_control_deck/settings/hooks
2. اضغط "Add webhook"

#### ب) إعدادات الـ Webhook:
- **Payload URL**: `http://your-server-ip:8081/api/admin/webhook/github`
  - أو إذا كان لديك domain: `https://yourdomain.com/api/admin/webhook/github`
- **Content type**: `application/json`
- **Secret**: اكتب secret عشوائي (مثلاً: `my-secret-key-12345`)
- **Events**: اختر "Just the push event"
- **Active**: ✅

#### ج) احفظ الـ Secret:
انسخ الـ Secret وأضفه في ملف `.env` على السيرفر:
```bash
nano /var/www/ftth_control_deck/api/.env
```
أضف:
```env
GITHUB_WEBHOOK_SECRET=my-secret-key-12345
```

---

### 3. فتح Port على السيرفر

#### إذا كنت تستخدم firewall:
```bash
# Ubuntu/Debian
sudo ufw allow 8081/tcp

# CentOS/RHEL
sudo firewall-cmd --permanent --add-port=8081/tcp
sudo firewall-cmd --reload
```

---

### 4. طريقة الاستخدام

#### من Cursor (على جهازك):
```bash
# 1. عدل الملفات
# 2. أضف التغييرات
git add .

# 3. احفظ التغييرات
git commit -m "وصف التغييرات"

# 4. ارفع إلى GitHub
git push origin main
```

#### بعد `git push`:
- GitHub يرسل webhook تلقائياً إلى السيرفر
- السيرفر يسحب التحديثات (`git pull`)
- يثبت Dependencies الجديدة (`npm install`)
- يعيد تشغيل PM2 تلقائياً

---

### 5. التحقق من عمل النظام

#### أ) اختبر الـ Webhook يدوياً:
```bash
curl -X POST http://your-server-ip:8081/api/admin/webhook/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -d '{"ref":"refs/heads/main"}'
```

#### ب) تحقق من السجلات:
```bash
# سجلات Admin Server
pm2 logs admin-server

# سجلات API
pm2 logs ftth-api
```

---

### 6. استكشاف الأخطاء

#### المشكلة: Webhook لا يعمل
- تحقق من أن Admin Server يعمل: `pm2 status`
- تحقق من Port: `netstat -tulpn | grep 8081`
- تحقق من السجلات: `pm2 logs admin-server`

#### المشكلة: Git pull فشل
- تحقق من الصلاحيات: `ls -la /var/www/ftth_control_deck`
- تحقق من Git remote: `cd /var/www/ftth_control_deck && git remote -v`
- قد تحتاج لإعداد Git credentials على السيرفر

#### المشكلة: PM2 لا يعيد التشغيل
- تحقق من اسم التطبيق: `pm2 list`
- تأكد من أن `PM2_APP_NAME` في `.env` صحيح

---

### 7. الأمان

#### تحسين الأمان (اختياري):
1. استخدم HTTPS بدلاً من HTTP
2. أضف IP whitelist في Admin Server
3. استخدم GitHub Secret للتحقق من الطلبات
4. استخدم firewall لتقييد الوصول لـ Port 8081

---

## ملاحظات مهمة

1. **مسار المشروع**: تأكد من أن `PROJECT_PATH` في `.env` صحيح
2. **اسم PM2**: تأكد من أن `PM2_APP_NAME` يطابق اسم التطبيق في PM2
3. **Git Credentials**: قد تحتاج لإعداد SSH keys أو Personal Access Token على السيرفر
4. **الصلاحيات**: تأكد من أن المستخدم لديه صلاحيات كتابة في مجلد المشروع

---

## الدعم

إذا واجهت أي مشكلة، تحقق من:
- سجلات PM2: `pm2 logs`
- سجلات النظام: `journalctl -u your-service`
- GitHub Webhook deliveries في إعدادات المستودع

