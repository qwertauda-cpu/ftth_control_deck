# إعداد Firewall لـ Google Cloud Platform

## فتح Port 8081 في Google Cloud

### الطريقة 1: من Google Cloud Console

1. اذهب إلى: https://console.cloud.google.com/networking/firewalls
2. اضغط "Create Firewall Rule"
3. املأ البيانات:
   - **Name**: `allow-webhook-8081`
   - **Direction**: Ingress
   - **Targets**: All instances in the network
   - **Source IP ranges**: `0.0.0.0/0` (أو `github.com` IPs إذا أردت تقييد الوصول)
   - **Protocols and ports**: 
     - ✅ TCP
     - Port: `8081`
4. اضغط "Create"

### الطريقة 2: من Command Line (gcloud)

```bash
gcloud compute firewall-rules create allow-webhook-8081 \
    --allow tcp:8081 \
    --source-ranges 0.0.0.0/0 \
    --description "Allow GitHub webhook on port 8081"
```

### الطريقة 3: من SSH على السيرفر

```bash
# إذا كان لديك iptables
sudo iptables -A INPUT -p tcp --dport 8081 -j ACCEPT
sudo iptables-save
```

---

## التحقق من أن Port مفتوح

```bash
# من جهازك المحلي
curl -v http://130.211.200.58:8081/api/admin/webhook/github
```

إذا كان Port مفتوحاً، يجب أن تحصل على رد (حتى لو كان خطأ).

---

## ملاحظات أمنية

- يمكنك تقييد الوصول لـ GitHub IPs فقط بدلاً من `0.0.0.0/0`
- GitHub IPs: https://api.github.com/meta (انظر `hooks`)

