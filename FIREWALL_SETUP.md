# إعداد Firewall لـ Google Cloud Platform

## فتح Ports المطلوبة في Google Cloud

### Port 3000 (API Server) - **مطلوب**
### Port 8081 (Admin Server) - **مطلوب**

### الطريقة 1: من Google Cloud Console

#### أ) فتح Port 3000 (API Server):

1. اذهب إلى: https://console.cloud.google.com/networking/firewalls
2. اضغط "Create Firewall Rule"
3. املأ البيانات:
   - **Name**: `allow-api-3000`
   - **Direction**: Ingress
   - **Targets**: All instances in the network
   - **Source IP ranges**: `0.0.0.0/0`
   - **Protocols and ports**: 
     - ✅ TCP
     - Port: `3000`
4. اضغط "Create"

#### ب) فتح Port 8081 (Admin Server):

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
# فتح Port 3000 (API Server)
gcloud compute firewall-rules create allow-api-3000 \
    --allow tcp:3000 \
    --source-ranges 0.0.0.0/0 \
    --description "Allow API server on port 3000"

# فتح Port 8081 (Admin Server)
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

## التحقق من أن Ports مفتوحة

```bash
# من جهازك المحلي - Port 3000 (API Server)
curl -v http://130.211.200.58:3000/api/health

# من جهازك المحلي - Port 8081 (Admin Server)
curl -v http://130.211.200.58:8081/api/admin/webhook/github
```

إذا كانت Ports مفتوحة، يجب أن تحصل على رد (حتى لو كان خطأ).

---

## ملاحظات أمنية

- يمكنك تقييد الوصول لـ GitHub IPs فقط بدلاً من `0.0.0.0/0`
- GitHub IPs: https://api.github.com/meta (انظر `hooks`)

