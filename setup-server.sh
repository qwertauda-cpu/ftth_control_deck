#!/bin/bash

# Script لإعداد المشروع على السيرفر
# انسخ هذا الملف إلى السيرفر ونفذه: bash setup-server.sh

set -e  # إيقاف عند أي خطأ

echo "=========================================="
echo "بدء إعداد المشروع على السيرفر"
echo "=========================================="

# المتغيرات
PROJECT_PATH="/var/www/ftth_control_deck"
GITHUB_REPO="https://github.com/qwertauda-cpu/ftth_control_deck.git"
# GITHUB_TOKEN - سيتم إدخاله عند الحاجة

# 1. تثبيت Git (إذا لم يكن مثبتاً)
echo "[1/10] التحقق من تثبيت Git..."
if ! command -v git &> /dev/null; then
    echo "تثبيت Git..."
    sudo apt update
    sudo apt install git -y
else
    echo "✓ Git مثبت بالفعل"
fi

# 2. تثبيت Node.js و npm (إذا لم يكونا مثبتين)
echo "[2/10] التحقق من تثبيت Node.js..."
if ! command -v node &> /dev/null; then
    echo "تثبيت Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
else
    echo "✓ Node.js مثبت بالفعل: $(node --version)"
fi

# 3. حذف المجلد القديم إذا كان موجوداً
echo "[3/10] تنظيف المجلدات القديمة..."
if [ -d "$PROJECT_PATH" ]; then
    echo "حذف المجلد القديم..."
    sudo rm -rf "$PROJECT_PATH"
fi

# 4. Clone المشروع
echo "[4/10] Clone المشروع من GitHub..."
cd /var/www
# إذا كان لديك Personal Access Token، استخدمه هنا:
# sudo git clone "https://qwertauda-cpu:YOUR_TOKEN@github.com/qwertauda-cpu/ftth_control_deck.git" ftth_control_deck
# أو بدون Token:
sudo git clone "$GITHUB_REPO" ftth_control_deck

# 5. تغيير الصلاحيات
echo "[5/10] تغيير صلاحيات المجلد..."
sudo chown -R $USER:$USER "$PROJECT_PATH"

# 6. تثبيت Dependencies
echo "[6/10] تثبيت Dependencies..."
cd "$PROJECT_PATH/api"
npm install

# 7. إعداد ملف .env
echo "[7/10] إعداد ملف .env..."
if [ ! -f .env ]; then
    cp ENV_TEMPLATE.env .env
    echo "" >> .env
    echo "# Auto-deployment settings" >> .env
    echo "PROJECT_PATH=$PROJECT_PATH" >> .env
    echo "PM2_APP_NAME=ftth-api" >> .env
    echo "GITHUB_WEBHOOK_SECRET=my-secret-key-$(date +%s)" >> .env
    echo "ADMIN_PASSWORD=admin123" >> .env
    echo "✓ تم إنشاء ملف .env"
    echo "⚠️  يرجى تعديل ADMIN_PASSWORD و GITHUB_WEBHOOK_SECRET في ملف .env"
else
    echo "✓ ملف .env موجود بالفعل"
fi

# 8. جعل script قابل للتنفيذ
echo "[8/10] جعل scripts قابلة للتنفيذ..."
chmod +x "$PROJECT_PATH/api/deploy.sh"

# 9. تثبيت PM2
echo "[9/10] التحقق من تثبيت PM2..."
if ! command -v pm2 &> /dev/null; then
    echo "تثبيت PM2..."
    sudo npm install -g pm2
else
    echo "✓ PM2 مثبت بالفعل"
fi

# 10. تشغيل المشروع
echo "[10/10] تشغيل المشروع بـ PM2..."
cd "$PROJECT_PATH/api"

# إيقاف التطبيقات إذا كانت تعمل
pm2 stop ftth-api 2>/dev/null || true
pm2 stop admin-server 2>/dev/null || true
pm2 delete ftth-api 2>/dev/null || true
pm2 delete admin-server 2>/dev/null || true

# تشغيل التطبيقات
pm2 start server.js --name ftth-api
pm2 start Untitled-1.js --name admin-server

# حفظ الإعدادات
pm2 save

# عرض الحالة
echo ""
echo "=========================================="
echo "✓ تم إعداد المشروع بنجاح!"
echo "=========================================="
echo ""
pm2 status
echo ""
echo "IP السيرفر:"
curl -s ifconfig.me
echo ""
echo ""
echo "⚠️  خطوات مهمة:"
echo "1. افتح ملف .env وعدّل ADMIN_PASSWORD و GITHUB_WEBHOOK_SECRET"
echo "2. انسخ IP السيرفر أعلاه"
echo "3. اذهب إلى GitHub Webhook settings وأضف:"
echo "   URL: http://YOUR_IP:8081/api/admin/webhook/github"
echo "   Secret: (انسخه من ملف .env)"
echo ""
echo "لرؤية السجلات: pm2 logs"
echo "لإعادة التشغيل: pm2 restart all"

