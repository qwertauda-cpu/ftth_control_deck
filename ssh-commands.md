# طرق الاتصال بالسيرفر عبر SSH

## الطريقة 1: الاتصال المباشر (يدوي)

افتح Git Bash ونفّذ:

```bash
ssh qwertauda@130.211.200.58
```

عند المطالبة، أدخل كلمة المرور: `t3c1061@`

## الطريقة 2: استخدام السكريبت

```bash
bash connect-ssh.sh
```

## الطريقة 3: الاتصال وتنفيذ الأوامر مباشرة

```bash
ssh qwertauda@130.211.200.58 "cd /var/www/ftth_control_deck && git pull origin main && pm2 restart ftth-control-deck"
```

(سيطلب كلمة المرور)

## الطريقة 4: استخدام السكريبت التلقائي

```bash
bash connect-and-deploy.sh
```

## الطريقة 5: استخدام SSH Keys (بدون كلمة مرور)

**مرة واحدة فقط - إعداد SSH Key:**

```bash
# 1. إنشاء SSH Key (إذا لم يكن موجوداً)
ssh-keygen -t rsa -b 4096

# 2. نسخ المفتاح للسيرفر
ssh-copy-id qwertauda@130.211.200.58

# 3. بعد ذلك يمكنك الاتصال بدون كلمة مرور
ssh qwertauda@130.211.200.58
```

## الطريقة 6: استخدام sshpass (تلقائي بالكامل)

**تثبيت sshpass في Git Bash:**

1. تحميل sshpass من: https://sourceforge.net/projects/sshpass/
2. وضع الملف في مجلد Git Bash
3. ثم استخدام:

```bash
sshpass -p 't3c1061@' ssh qwertauda@130.211.200.58 "cd /var/www/ftth_control_deck && git pull origin main && pm2 restart ftth-control-deck"
```

## الأوامر المفيدة بعد الاتصال:

```bash
# الانتقال للمجلد
cd /var/www/ftth_control_deck

# سحب التحديثات
git pull origin main

# إعادة تشغيل السيرفر
pm2 restart ftth-control-deck

# عرض الحالة
pm2 status

# عرض الـ logs
pm2 logs ftth-control-deck --lines 50

# التحقق من البورت
netstat -tuln | grep 3000
```

