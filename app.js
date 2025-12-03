// API Configuration
// اكتشاف تلقائي لـ API_URL - يعمل على localhost أو IP المحلي
const getAPIURL = () => {
    const hostname = window.location.hostname;
    // إذا كان من localhost أو 127.0.0.1، استخدم localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return 'http://localhost:3000/api';
    }
    // وإلا استخدم نفس hostname (IP المحلي)
    return `http://${hostname}:3000/api`;
};
const API_URL = getAPIURL();

// Current User State
let currentDetailUser = ''; // admin@domain (owner username) - يُستخدم للوصول إلى قاعدة البيانات
let currentDetailPass = '';
let currentUserId = null;
let currentUserAgentName = null; // اسم الوكيل الثلاثي للمستخدم الحالي
let currentCompanyName = null; // اسم الشركة للمستخدم الحالي
let currentAlwataniUsername = ''; // username من alwatani_login table - يُستخدم فقط للاتصال بـ Alwatani API

/**
 * Helper: إضافة username إلى URL parameters
 */
function addUsernameToUrl(url) {
    if (!currentDetailUser) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}username=${encodeURIComponent(currentDetailUser)}`;
}

/**
 * Helper: إضافة alwatani_login_id إلى URL
 * يستخدم currentUserId (وهو alwatani_login.id)
 */
function addAlwataniLoginIdToUrl(url) {
    if (!currentUserId) {
        console.warn('[addAlwataniLoginIdToUrl] currentUserId is not set');
        return url;
    }
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}alwatani_login_id=${currentUserId}`;
}

/**
 * إعادة تحميل المشتركين من الـ cache
 */
async function reloadSubscribersFromCache() {
    if (!currentUserId) {
        console.warn('[reloadSubscribersFromCache] currentUserId is not set');
        return;
    }
    
    try {
        console.log('[RELOAD CACHE] Reloading subscribers from cache...');
        await loadSubscribers();
        showToast('✅ تم تحديث قائمة المشتركين', 'success');
    } catch (error) {
        console.error('[RELOAD CACHE] Error:', error);
        showToast('❌ خطأ في تحديث قائمة المشتركين', 'error');
    }
}

/**
 * Helper: إضافة username إلى fetch options
 */
function addUsernameToFetchOptions(options = {}) {
    if (!currentDetailUser) return options;
    
    const newOptions = { ...options };
    if (!newOptions.headers) {
        newOptions.headers = {};
    }
    newOptions.headers['x-username'] = currentDetailUser;
    
    if (newOptions.body && typeof newOptions.body === 'string') {
        try {
            const bodyObj = JSON.parse(newOptions.body);
            bodyObj.owner_username = currentDetailUser;
            newOptions.body = JSON.stringify(bodyObj);
        } catch (e) {
            // إذا كان body ليس JSON، أضف owner_username في query
        }
    } else if (newOptions.body && typeof newOptions.body === 'object') {
        newOptions.body.owner_username = currentDetailUser;
    }
    
    return newOptions;
}
let currentCustomersPage = 1;

const ALWATANI_CUSTOMERS_PAGE_SIZE = 100;

// Auto-refresh intervals
let dataAutoRefreshInterval = null;
let isRefreshingData = false; // Flag لمنع التحديثات المتداخلة
let currentScreen = 'dashboard'; // تتبع الشاشة الحالية

// Subscribers dashboard state
const subscriberStatusConfig = [
    {
        key: 'all',
        label: 'فعال',
        description: 'كل المشتركين',
        ringColor: '#22c55e',
        match: () => true
    },
    {
        key: 'active',
        label: 'نشط',
        description: 'خدمة تعمل الآن',
        ringColor: '#16a34a',
        match: (meta) => meta?.tags?.has('active') || meta?.tags?.has('connected')
    },
    {
        key: 'disconnected',
        label: 'غير متصل',
        description: 'خارج الخدمة',
        ringColor: '#ef4444',
        match: (meta) => meta?.tags?.has('disconnected')
    },
    {
        key: 'trial',
        label: 'تجريبي',
        description: 'حسابات الاختبار',
        ringColor: '#8b5cf6',
        match: (meta) => meta?.tags?.has('trial')
    },
    {
        key: 'expired',
        label: 'منتهي الصلاحية',
        description: 'يتطلب تجديد',
        ringColor: '#fb7185',
        match: (meta) => meta?.tags?.has('expired')
    },
    {
        key: 'expiring',
        label: 'انتهاء الصلاحية عن قريب',
        description: 'خلال 7 أيام',
        ringColor: '#f59e0b',
        match: (meta) => meta?.tags?.has('expiring')
    }
];

const subscriberFilterLabels = {
    all: 'جميع المشتركين',
    active: 'المشتركون النشطون',
    disconnected: 'غير المتصلين',
    trial: 'الحسابات التجريبية',
    expired: 'المشتركون منتهي الصلاحية',
    expiring: 'المشتركون الذين ينتهون قريباً'
};

const subscriberStatusBadgeClasses = {
    active: 'bg-emerald-50 text-emerald-600',
    connected: 'bg-emerald-50 text-emerald-600',
    disconnected: 'bg-rose-50 text-rose-600',
    inactive: 'bg-rose-50 text-rose-600',
    trial: 'bg-indigo-50 text-indigo-600',
    expired: 'bg-red-50 text-red-600',
    expiring: 'bg-amber-50 text-amber-600',
    other: 'bg-slate-100 text-slate-600'
};

let subscribersCache = [];
let activeSubscriberFilter = 'all';
let expiringSortOrder = 'asc';
let currentFilteredSubscribers = [];
let subscriberPagination = {
    pageSize: 10,
    currentPage: 1
};

// ================= Screen Navigation =================
function switchScreen(hideId, showId) {
    const hideEl = document.getElementById(hideId);
    const showEl = document.getElementById(showId);
    hideEl.classList.add('hidden');
    hideEl.classList.remove('flex');
    showEl.classList.remove('hidden');
    showEl.classList.add('flex');
}

// ================= Authentication =================
async function handleLogin(e) {
    e.preventDefault();
    const userVal = document.getElementById('login-username').value;
    const passVal = document.getElementById('login-password').value;
    const btn = document.getElementById('submit-btn');
    const errorMsg = document.getElementById('error-msg');
    const oldHtml = btn.innerHTML;
    
    btn.innerHTML = '<div class="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent"></div>';
    btn.disabled = true;
    errorMsg.classList.add('hidden');

    try {
        console.log('[LOGIN] Attempting login for user:', userVal);
        
        // First, check if server is running
        try {
            const healthCheck = await Promise.race([
                fetch(`${API_URL.replace('/api', '')}/api/health`, {
                    method: 'GET'
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
            ]);
            if (!healthCheck.ok) {
                throw new Error('Server not responding');
            }
        } catch (healthError) {
            console.error('[LOGIN] Server health check failed:', healthError);
            const errorText = errorMsg.querySelector('span');
            if (errorText) {
                errorText.innerHTML = '❌ السيرفر غير يعمل!<br><small>يرجى تشغيل السيرفر أولاً:<br>1. افتح PowerShell في مجلد api<br>2. نفّذ: node server.js</small>';
            }
            errorMsg.classList.remove('hidden');
            btn.innerHTML = oldHtml;
            btn.disabled = false;
            return;
        }
        
        // Check in database only - no hardcoded users
        const response = await Promise.race([
            fetch(`${API_URL}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: userVal, password: passVal })
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);
        
        console.log('[LOGIN] Response status:', response.status);
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('[LOGIN] Response data:', data);
        
        if (data.success) {
            currentUserId = data.user.id;
            // استخدام owner_username إذا كان موجوداً، وإلا استخدام username
            currentDetailUser = data.user.owner_username || userVal;
            console.log('[LOGIN] Setting currentDetailUser:', currentDetailUser, 'from data:', data.user);
            currentDetailPass = passVal;
            currentUserAgentName = data.user.agent_name || null; // حفظ agent_name للمستخدم الحالي
            currentCompanyName = data.user.company_name || null; // حفظ company_name للمستخدم الحالي
            updateSideMenuInfo(); // تحديث معلومات القائمة الجانبية
            
            // Store user role for later use
            const userRole = data.user.role;
            
            // All users go to dashboard first (لوحة التحكم الرئيسية)
                // إخفاء صفحة تسجيل الدخول أولاً بشكل كامل
                const loginContainer = document.getElementById('login-container');
                if (loginContainer) {
                    loginContainer.style.display = 'none';
                    loginContainer.classList.add('hidden');
                    loginContainer.classList.remove('flex', 'flex-1');
                }
                // إخفاء جميع الشاشات الأخرى أولاً
                hideAllMainScreens();
                // إظهار لوحة التحكم (بدون القائمة الجانبية)
                showScreen('dashboard-screen');
                hideSideMenu(); // إخفاء القائمة الجانبية في لوحة التحكم الرئيسية
                await loadPages();
                currentScreen = 'dashboard';
                startAutoRefresh(); // بدء التحديث التلقائي
            
            // Apply dark mode if saved
            const savedTheme = localStorage.getItem('theme');
            if (savedTheme === 'dark') {
                applyDarkMode();
            }
        } else {
            console.log('[LOGIN] Login failed:', data.message);
            const errorText = errorMsg.querySelector('span');
            if (errorText) {
                errorText.textContent = data.message || 'بيانات الدخول غير صحيحة';
            }
            errorMsg.classList.remove('hidden');
        }
    } catch (error) {
        console.error('[LOGIN] Error:', error);
        const errorText = errorMsg.querySelector('span');
        if (errorText) {
            if (error.name === 'AbortError' || error.message.includes('timeout')) {
                const serverURL = API_URL.replace('/api', '');
                errorText.innerHTML = `⏱️ انتهت مهلة الاتصال!<br><small>تأكد من أن السيرفر يعمل على ${serverURL}</small>`;
            } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError') || error.message.includes('Server not responding')) {
                errorText.innerHTML = '❌ السيرفر غير متاح!<br><small>يرجى تشغيل السيرفر:<br>cd api && node server.js</small>';
            } else {
                errorText.textContent = 'حدث خطأ: ' + (error.message || 'خطأ غير معروف');
            }
        }
        errorMsg.classList.remove('hidden');
    } finally {
        btn.innerHTML = oldHtml;
        btn.disabled = false;
    }
    
    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
}

// ================= Create Account =================
function openCreateAccountModal(e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    const modal = document.getElementById('create-account-modal');
    if (!modal) {
        console.error('Create account modal not found');
        return;
    }
    
    // إخفاء القائمة الجانبية عند فتح modal إضافة مستخدم جديد
    hideSideMenu();
    
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    
    // Reset form - جميع الحقول
    const agentNameInput = document.getElementById('new-account-agent-name');
    const companyNameInput = document.getElementById('new-account-company-name');
    const governorateSelect = document.getElementById('new-account-governorate');
    const regionInput = document.getElementById('new-account-region');
    const phoneInput = document.getElementById('new-account-phone');
    const emailInput = document.getElementById('new-account-email');
    const usernameInput = document.getElementById('new-account-username');
    const passwordInput = document.getElementById('new-account-password');
    const passwordConfirmInput = document.getElementById('new-account-password-confirm');
    const errorDiv = document.getElementById('create-account-error');
    const successDiv = document.getElementById('create-account-success');
    const usernamePreview = document.getElementById('username-preview-value');
    
    if (agentNameInput) agentNameInput.value = '';
    if (companyNameInput) companyNameInput.value = '';
    if (governorateSelect) governorateSelect.value = '';
    if (regionInput) regionInput.value = '';
    if (phoneInput) phoneInput.value = '7';
    if (emailInput) emailInput.value = '';
    if (usernameInput) usernameInput.value = '';
    if (passwordInput) passwordInput.value = '';
    if (passwordConfirmInput) passwordConfirmInput.value = '';
    if (usernamePreview) usernamePreview.textContent = '---';
    if (errorDiv) errorDiv.classList.add('hidden');
    if (successDiv) successDiv.classList.add('hidden');
    
    // إضافة معاينة لاسم المستخدم والتحقق منه
    if (usernameInput) {
        // إزالة أي listeners سابقة
        const newInput = usernameInput.cloneNode(true);
        usernameInput.parentNode.replaceChild(newInput, usernameInput);
        
        let checkUsernameTimeout;
        
        // إضافة الـ listener الجديد
        newInput.addEventListener('input', function() {
            const username = this.value.toLowerCase().replace(/[^a-z]/g, '');
            const previewEl = document.getElementById('username-preview-value');
            const errorEl = document.getElementById('username-error');
            const availableEl = document.getElementById('username-available');
            const fullUsername = `admin@${username}`;
            
            // إخفاء الرسائل السابقة
            if (errorEl) errorEl.classList.add('hidden');
            if (availableEl) availableEl.classList.add('hidden');
            
            // إلغاء الطلب السابق
            if (checkUsernameTimeout) {
                clearTimeout(checkUsernameTimeout);
            }
            
            // تحديث المعاينة
            if (previewEl) {
                if (username.length >= 3) {
                    previewEl.textContent = username;
                    previewEl.parentElement.parentElement.style.color = '#16a34a';
                    
                    // التحقق من وجود اسم المستخدم في الداتابيس مع debounce
                    checkUsernameTimeout = setTimeout(async () => {
                        try {
                            const response = await fetch(`${API_URL}/users/check-username?username=${encodeURIComponent(fullUsername)}`);
                            const data = await response.json();
                            
                            if (data.exists) {
                                // اسم المستخدم موجود
                                newInput.classList.add('border-red-500');
                                newInput.classList.remove('border-green-500', 'border-slate-300');
                                if (errorEl) {
                                    errorEl.classList.remove('hidden');
                                }
                            } else {
                                // اسم المستخدم متاح
                                newInput.classList.add('border-green-500');
                                newInput.classList.remove('border-red-500', 'border-slate-300');
                                if (availableEl) {
                                    availableEl.classList.remove('hidden');
                                }
                            }
                        } catch (error) {
                            console.error('Error checking username:', error);
                        }
                    }, 500); // انتظار 500ms بعد توقف المستخدم عن الكتابة
                } else if (username.length === 2) {
                    // إظهار باللون الأحمر عند حرفين
                    this.classList.add('border-red-500');
                    this.classList.remove('border-green-500', 'border-slate-300');
                    previewEl.textContent = username;
                    previewEl.parentElement.parentElement.style.color = '#ef4444';
                } else {
                    this.classList.remove('border-red-500', 'border-green-500');
                    this.classList.add('border-slate-300');
                    previewEl.textContent = '---';
                    previewEl.parentElement.parentElement.style.color = '#64748b';
                }
            }
        });
    }
    
    // إضافة التحقق من البريد الإلكتروني
    if (emailInput) {
        // إزالة أي listeners سابقة
        const emailInputNew = emailInput.cloneNode(true);
        emailInput.parentNode.replaceChild(emailInputNew, emailInput);
        
        emailInputNew.addEventListener('input', function() {
            let email = this.value;
            const errorEl = document.getElementById('email-error');
            
            // النطاقات المسموح بها فقط
            const allowedDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'];
            
            if (email) {
                email = email.trim();
                const atIndex = email.indexOf('@');
                
                if (atIndex === -1 || atIndex === 0) {
                    this.classList.add('border-red-500');
                    this.classList.remove('border-green-500', 'border-slate-300');
                    if (errorEl) {
                        errorEl.textContent = 'البريد الإلكتروني يجب أن يحتوي على @';
                        errorEl.classList.remove('hidden');
                    }
                } else {
                    const usernamePart = email.substring(0, atIndex);
                    const domainPart = email.substring(atIndex + 1).toLowerCase();
                    
                    // التحقق من أن اسم المستخدم صحيح
                    if (!/^[a-zA-Z0-9._%+-]+$/.test(usernamePart) || usernamePart.length === 0) {
                        this.classList.add('border-red-500');
                        this.classList.remove('border-green-500', 'border-slate-300');
                        if (errorEl) {
                            errorEl.textContent = 'اسم المستخدم غير صحيح';
                            errorEl.classList.remove('hidden');
                        }
                    } else if (!allowedDomains.includes(domainPart)) {
                        // النطاق غير مسموح
                        this.classList.add('border-red-500');
                        this.classList.remove('border-green-500', 'border-slate-300');
                        if (errorEl) {
                            errorEl.textContent = 'النطاق غير مسموح. النطاقات المسموحة: gmail.com, yahoo.com, hotmail.com, outlook.com, icloud.com';
                            errorEl.classList.remove('hidden');
                        }
                    } else {
                        // التحقق من أن البريد ينتهي بالنطاق فقط (لا يوجد نص إضافي)
                        if (email.toLowerCase() !== usernamePart + '@' + domainPart) {
                            this.classList.add('border-red-500');
                            this.classList.remove('border-green-500', 'border-slate-300');
                            if (errorEl) {
                                errorEl.textContent = 'البريد الإلكتروني غير صحيح. لا يمكن إضافة نص بعد النطاق';
                                errorEl.classList.remove('hidden');
                            }
                        } else {
                            // التحقق من أن البريد غير مستخدم في قاعدة البيانات
                            const trimmedEmailValue = email.trim().toLowerCase();
                            checkEmailAvailability(trimmedEmailValue);
                        }
                    }
                }
            } else {
                this.classList.remove('border-red-500', 'border-green-500');
                this.classList.add('border-slate-300');
                if (errorEl) errorEl.classList.add('hidden');
                const emailExistsError = document.getElementById('email-exists-error');
                if (emailExistsError) emailExistsError.classList.add('hidden');
            }
        });
    }
    
    // إضافة التحقق من رقم الهاتف
    if (phoneInput) {
        const phoneInputNew = phoneInput.cloneNode(true);
        phoneInput.parentNode.replaceChild(phoneInputNew, phoneInput);
        
        // التأكد من أن القيمة الافتراضية هي 7
        if (!phoneInputNew.value || !phoneInputNew.value.startsWith('7')) {
            phoneInputNew.value = '7';
        }
        
        phoneInputNew.addEventListener('input', function() {
            handlePhoneInput(this);
        });
        
        phoneInputNew.addEventListener('focus', function() {
            if (!this.value || !this.value.startsWith('7')) {
                this.value = '7';
            }
        });
    }
    
    // إضافة مؤشر قوة كلمة المرور والتحقق من التطابق
    let passwordInputNew = null;
    let passwordConfirmInputNew = null;
    
    if (passwordInput) {
        // إزالة أي listeners سابقة
        passwordInputNew = passwordInput.cloneNode(true);
        passwordInput.parentNode.replaceChild(passwordInputNew, passwordInput);
        
        passwordInputNew.addEventListener('input', function() {
            const password = this.value;
            updatePasswordStrength(password);
            // تحديث التحقق من التطابق إذا كان هناك نص في حقل التأكيد
            if (passwordConfirmInputNew && passwordConfirmInputNew.value.length > 0) {
                passwordConfirmInputNew.dispatchEvent(new Event('input'));
            }
        });
    }
    
    if (passwordConfirmInput) {
        // إزالة أي listeners سابقة
        passwordConfirmInputNew = passwordConfirmInput.cloneNode(true);
        passwordConfirmInput.parentNode.replaceChild(passwordConfirmInputNew, passwordConfirmInput);
        
        passwordConfirmInputNew.addEventListener('input', function() {
            const password = passwordInputNew ? passwordInputNew.value : '';
            const confirm = this.value;
            const matchEl = document.getElementById('password-match');
            
            if (confirm.length > 0) {
                if (password === confirm) {
                    this.classList.add('border-green-500');
                    this.classList.remove('border-red-500', 'border-slate-300');
                    if (matchEl) {
                        matchEl.textContent = '✓ كلمات المرور متطابقة';
                        matchEl.className = 'text-xs text-green-600 mt-1';
                        matchEl.classList.remove('hidden');
                    }
                } else {
                    this.classList.add('border-red-500');
                    this.classList.remove('border-green-500', 'border-slate-300');
                    if (matchEl) {
                        matchEl.textContent = '✗ كلمات المرور غير متطابقة';
                        matchEl.className = 'text-xs text-red-500 mt-1';
                        matchEl.classList.remove('hidden');
                    }
                }
            } else {
                this.classList.remove('border-red-500', 'border-green-500');
                this.classList.add('border-slate-300');
                if (matchEl) matchEl.classList.add('hidden');
            }
        });
    }
}

function closeCreateAccountModal() {
    const modal = document.getElementById('create-account-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    
    // إظهار القائمة الجانبية مرة أخرى عند إغلاق modal (فقط إذا كان المستخدم مسجل دخول)
    const loginContainer = document.getElementById('login-container');
    if (loginContainer && loginContainer.classList.contains('hidden') && currentUserId) {
        // إذا كان login-container مخفي (أي المستخدم مسجل دخول)، أظهر القائمة
        showSideMenu();
    }
}

// دالة للتحكم في رقم الهاتف (يبدأ برقم 7)
function handlePhoneInput(input) {
    let value = input.value.replace(/[^0-9]/g, ''); // إزالة أي شيء غير الأرقام
    
    // التأكد من أن الرقم يبدأ بـ 7
    if (value.length === 0) {
        input.value = '7';
    } else if (!value.startsWith('7')) {
        input.value = '7' + value.replace(/^7+/, '').slice(0, 9); // أضف 7 في البداية
    } else {
        input.value = value.slice(0, 10); // حد أقصى 10 أرقام (7 + 9)
    }
    
    // التحقق من رقم الهاتف في قاعدة البيانات
    const phone = input.value;
    if (phone.length === 10 && phone.startsWith('7')) {
        checkPhoneAvailability(phone);
    } else {
        // إخفاء رسالة الخطأ إذا لم يكتمل الرقم
        const errorEl = document.getElementById('phone-error');
        if (errorEl) errorEl.classList.add('hidden');
        input.classList.remove('border-red-500');
        input.classList.add('border-slate-300');
    }
}

// دالة للتحقق من رقم الهاتف في قاعدة البيانات
// دالة للتحقق من البريد الإلكتروني في قاعدة البيانات
async function checkEmailAvailability(email) {
    const emailInput = document.getElementById('new-account-email');
    const errorEl = document.getElementById('email-error');
    const emailExistsError = document.getElementById('email-exists-error');
    
    if (!emailInput) return;
    
    // إخفاء رسالة الخطأ العامة أولاً
    if (errorEl) errorEl.classList.add('hidden');
    
    let checkEmailTimeout;
    if (checkEmailTimeout) {
        clearTimeout(checkEmailTimeout);
    }
    
    checkEmailTimeout = setTimeout(async () => {
        try {
            const response = await fetch(`${API_URL}/users/check-email?email=${encodeURIComponent(email)}`);
            const data = await response.json();
            
            if (data.exists) {
                emailInput.classList.add('border-red-500');
                emailInput.classList.remove('border-green-500', 'border-slate-300');
                if (emailExistsError) emailExistsError.classList.remove('hidden');
            } else {
                emailInput.classList.add('border-green-500');
                emailInput.classList.remove('border-red-500', 'border-slate-300');
                if (emailExistsError) emailExistsError.classList.add('hidden');
            }
        } catch (error) {
            console.error('Error checking email:', error);
        }
    }, 500); // debounce 500ms
}

async function checkPhoneAvailability(phone) {
    const phoneInput = document.getElementById('new-account-phone');
    const errorEl = document.getElementById('phone-error');
    
    if (!phoneInput || !errorEl) return;
    
    try {
        const response = await fetch(`${API_URL}/users/check-phone?phone=${encodeURIComponent(phone)}`);
        const data = await response.json();
        
        if (data.exists) {
            phoneInput.classList.add('border-red-500');
            phoneInput.classList.remove('border-green-500', 'border-slate-300');
            errorEl.classList.remove('hidden');
        } else {
            phoneInput.classList.add('border-green-500');
            phoneInput.classList.remove('border-red-500', 'border-slate-300');
            errorEl.classList.add('hidden');
        }
    } catch (error) {
        console.error('Error checking phone:', error);
    }
}

// دالة لإظهار/إخفاء كلمة المرور
function togglePasswordVisibility(inputId, iconId) {
    const input = document.getElementById(inputId);
    const icon = document.getElementById(iconId);
    
    if (!input || !icon) return;
    
    if (input.type === 'password') {
        input.type = 'text';
        icon.innerHTML = `
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
        `;
    } else {
        input.type = 'password';
        icon.innerHTML = `
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        `;
    }
}

// دالة تحديث مؤشر قوة كلمة المرور
function updatePasswordStrength(password) {
    const strengthBar = document.getElementById('password-strength-fill');
    const strengthText = document.getElementById('password-strength-text');
    const requirementsEl = document.getElementById('password-requirements');
    
    if (!password) {
        if (strengthBar) {
            strengthBar.style.width = '0%';
            strengthBar.style.background = '#ef4444';
        }
        if (strengthText) strengthText.textContent = 'ضعيف';
        if (strengthText) strengthText.className = 'text-xs font-medium text-slate-500';
        return;
    }
    
    let strength = 0;
    let feedback = [];
    
    // طول 8 أحرف
    if (password.length >= 8) {
        strength += 25;
    } else {
        feedback.push('8 أحرف على الأقل');
    }
    
    // يحتوي على أحرف صغيرة
    if (/[a-z]/.test(password)) {
        strength += 25;
    } else {
        feedback.push('أحرف صغيرة');
    }
    
    // يحتوي على أحرف كبيرة
    if (/[A-Z]/.test(password)) {
        strength += 25;
    } else {
        feedback.push('أحرف كبيرة');
    }
    
    // يحتوي على أرقام
    if (/[0-9]/.test(password)) {
        strength += 25;
    } else {
        feedback.push('أرقام');
    }
    
    // تحديث الشريط
    if (strengthBar) {
        strengthBar.style.width = strength + '%';
        
        if (strength <= 25) {
            strengthBar.style.background = '#ef4444'; // أحمر
            if (strengthText) {
                strengthText.textContent = 'ضعيف جداً';
                strengthText.className = 'text-xs font-medium text-red-600';
            }
        } else if (strength <= 50) {
            strengthBar.style.background = '#f59e0b'; // برتقالي
            if (strengthText) {
                strengthText.textContent = 'ضعيف';
                strengthText.className = 'text-xs font-medium text-orange-600';
            }
        } else if (strength <= 75) {
            strengthBar.style.background = '#eab308'; // أصفر
            if (strengthText) {
                strengthText.textContent = 'متوسط';
                strengthText.className = 'text-xs font-medium text-yellow-600';
            }
        } else {
            strengthBar.style.background = '#22c55e'; // أخضر
            if (strengthText) {
                strengthText.textContent = 'قوي';
                strengthText.className = 'text-xs font-medium text-green-600';
            }
        }
    }
    
    // تحديث متطلبات كلمة المرور
    if (requirementsEl) {
        if (feedback.length > 0) {
            requirementsEl.textContent = 'ناقص: ' + feedback.join('، ');
            requirementsEl.className = 'text-xs text-red-500';
        } else {
            requirementsEl.textContent = '✓ جميع المتطلبات مستوفاة';
            requirementsEl.className = 'text-xs text-green-600';
        }
    }
}

async function handleCreateAccount(e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    // الحصول على جميع الحقول
    const agentNameInput = document.getElementById('new-account-agent-name');
    const companyNameInput = document.getElementById('new-account-company-name');
    const governorateSelect = document.getElementById('new-account-governorate');
    const regionInput = document.getElementById('new-account-region');
    const phoneInput = document.getElementById('new-account-phone');
    const emailInput = document.getElementById('new-account-email');
    const usernameInput = document.getElementById('new-account-username');
    const passwordInput = document.getElementById('new-account-password');
    const passwordConfirmInput = document.getElementById('new-account-password-confirm');
    const errorDiv = document.getElementById('create-account-error');
    const errorText = document.getElementById('create-account-error-text');
    const successDiv = document.getElementById('create-account-success');
    const btn = document.getElementById('create-account-btn');
    
    if (!agentNameInput || !companyNameInput || !phoneInput || !emailInput || !usernameInput || !passwordInput || !passwordConfirmInput || !errorDiv || !errorText || !successDiv || !btn) {
        console.error('Required elements not found');
        return false;
    }
    
    // جمع البيانات
    const agentName = agentNameInput.value.trim();
    const companyName = companyNameInput.value.trim();
    const governorate = governorateSelect ? governorateSelect.value.trim() : '';
    const region = regionInput ? regionInput.value.trim() : '';
    
    // التحقق من المحافظة (إجباري)
    if (!governorate) {
        errorText.textContent = 'يرجى اختيار المحافظة';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    // التحقق من المنطقة (إجباري)
    if (!region || region.trim().length === 0) {
        errorText.textContent = 'يرجى إدخال العنوان الكامل';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    const phone = phoneInput.value.trim();
    const email = emailInput.value.trim();
    let username = usernameInput.value.trim().toLowerCase().replace(/[^a-z]/g, '');
    const password = passwordInput.value;
    const passwordConfirm = passwordConfirmInput.value;
    const oldBtnText = btn.innerHTML;
    
    // Reset messages
    errorDiv.classList.add('hidden');
    successDiv.classList.add('hidden');
    
    // Validation
    if (!agentName) {
        errorText.textContent = 'يرجى إدخال اسم الوكيل الثلاثي';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    if (!companyName) {
        errorText.textContent = 'يرجى إدخال اسم الشركة';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    // التحقق من رقم الهاتف (10 أرقام ويبدأ برقم 7)
    if (!phone || phone.length !== 10) {
        errorText.textContent = 'رقم الهاتف يجب أن يكون 10 أرقام';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    if (!/^7[0-9]{9}$/.test(phone)) {
        errorText.textContent = 'رقم الهاتف يجب أن يبدأ برقم 7 ويحتوي على 10 أرقام';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    // التحقق من البريد الإلكتروني ونطاقه
    if (!email) {
        errorText.textContent = 'يرجى إدخال البريد الإلكتروني';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    // النطاقات المسموح بها فقط
    const allowedDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'];
    const trimmedEmail = email.trim().toLowerCase();
    
    const atIndex = trimmedEmail.indexOf('@');
    if (atIndex === -1 || atIndex === 0) {
        errorText.textContent = 'البريد الإلكتروني يجب أن يحتوي على @';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    const usernamePart = trimmedEmail.substring(0, atIndex);
    const domainPart = trimmedEmail.substring(atIndex + 1);
    
    // التحقق من اسم المستخدم
    if (!/^[a-zA-Z0-9._%+-]+$/.test(usernamePart) || usernamePart.length === 0) {
        errorText.textContent = 'اسم المستخدم غير صحيح';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    // التحقق من أن النطاق مسموح به
    if (!allowedDomains.includes(domainPart)) {
        errorText.textContent = 'النطاق غير مسموح. النطاقات المسموحة: gmail.com, yahoo.com, hotmail.com, outlook.com, icloud.com';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    // التحقق من أن البريد ينتهي بالنطاق فقط (لا يوجد نص إضافي)
    if (trimmedEmail !== usernamePart + '@' + domainPart) {
        errorText.textContent = 'البريد الإلكتروني غير صحيح. لا يمكن إضافة نص بعد النطاق';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    // التحقق من اسم المستخدم
    if (username.length < 3) {
        errorText.textContent = 'اسم المستخدم يجب أن يكون 3 أحرف إنجليزية على الأقل';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    if (!/^[a-z]{3,}$/.test(username)) {
        errorText.textContent = 'اسم المستخدم يجب أن يحتوي على أحرف إنجليزية فقط (3 أحرف على الأقل)';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    // التحقق من تطابق كلمة المرور
    if (password !== passwordConfirm) {
        errorText.textContent = 'كلمات المرور غير متطابقة';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    // التحقق من قوة كلمة المرور (8 أحرف + أرقام + أحرف)
    if (password.length < 8) {
        errorText.textContent = 'كلمة المرور يجب أن تكون 8 أحرف على الأقل';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
        errorText.textContent = 'كلمة المرور يجب أن تحتوي على أحرف كبيرة وصغيرة';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    if (!/[0-9]/.test(password)) {
        errorText.textContent = 'كلمة المرور يجب أن تحتوي على أرقام';
        errorDiv.classList.remove('hidden');
        return false;
    }
    
    // التحقق النهائي من البريد الإلكتروني ورقم الهاتف في قاعدة البيانات
    // هذا التحقق إجباري قبل الإرسال
    try {
        // التحقق من البريد الإلكتروني
        const emailCheckResponse = await fetch(`${API_URL}/users/check-email?email=${encodeURIComponent(trimmedEmail)}`);
        const emailCheckData = await emailCheckResponse.json();
        
        if (emailCheckData.exists) {
            errorText.textContent = '❌ البريد الإلكتروني مستخدم مسبقاً. يرجى استخدام بريد إلكتروني آخر';
            errorDiv.classList.remove('hidden');
            btn.disabled = false;
            btn.innerHTML = oldBtnText;
            // إظهار رسالة الخطأ تحت حقل البريد
            const emailExistsError = document.getElementById('email-exists-error');
            if (emailExistsError) {
                emailExistsError.classList.remove('hidden');
            }
            emailInput.classList.add('border-red-500');
            emailInput.classList.remove('border-green-500', 'border-slate-300');
            return false;
        }
        
        // التحقق من رقم الهاتف
        const phoneCheckResponse = await fetch(`${API_URL}/users/check-phone?phone=${encodeURIComponent(phone)}`);
        const phoneCheckData = await phoneCheckResponse.json();
        
        if (phoneCheckData.exists) {
            errorText.textContent = '❌ رقم الهاتف مستخدم مسبقاً. يرجى استخدام رقم هاتف آخر';
            errorDiv.classList.remove('hidden');
            btn.disabled = false;
            btn.innerHTML = oldBtnText;
            // إظهار رسالة الخطأ تحت حقل رقم الهاتف
            const phoneError = document.getElementById('phone-error');
            if (phoneError) {
                phoneError.classList.remove('hidden');
            }
            phoneInput.classList.add('border-red-500');
            phoneInput.classList.remove('border-green-500', 'border-slate-300');
            return false;
        }
    } catch (error) {
        console.error('[CREATE ACCOUNT] Error checking email/phone:', error);
        errorText.textContent = '❌ حدث خطأ أثناء التحقق من البيانات. يرجى المحاولة مرة أخرى';
        errorDiv.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = oldBtnText;
        return false;
    }
    
    // تحويل اسم المستخدم إلى admin@username
    const fullUsername = `admin@${username}`;
    
    // Show loading
    btn.disabled = true;
    btn.innerHTML = '<div class="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mx-auto"></div>';
    
    try {
        console.log('[CREATE ACCOUNT] Attempting to create account for user:', fullUsername);
        
        const response = await fetch(`${API_URL}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: fullUsername,
                password: password,
                agent_name: agentName,
                company_name: companyName,
                governorate: governorate,
                region: region,
                phone: (() => {
                    // إزالة جميع +964 المتكررة
                    let cleanPhone = phone.replace(/\+*964/g, '');
                    // إزالة 964 في البداية إذا كان موجوداً
                    if (cleanPhone.startsWith('964')) {
                        cleanPhone = cleanPhone.substring(3);
                    }
                    // إضافة +964 مرة واحدة فقط
                    return cleanPhone ? `+964${cleanPhone}` : phone;
                })(),
                email: email,
                position: 'Owner' // المالك تلقائياً
            })
        });
        
        console.log('[CREATE ACCOUNT] Response status:', response.status);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('[CREATE ACCOUNT] Response data:', data);
        
        if (data.success) {
            successDiv.classList.remove('hidden');
            
            // Clear form
            if (agentNameInput) agentNameInput.value = '';
            if (companyNameInput) companyNameInput.value = '';
            if (governorateSelect) governorateSelect.value = '';
            if (regionInput) regionInput.value = '';
            if (phoneInput) phoneInput.value = '';
            if (emailInput) emailInput.value = '';
            if (usernameInput) usernameInput.value = '';
            if (passwordInput) passwordInput.value = '';
            if (passwordConfirmInput) passwordConfirmInput.value = '';
            const usernamePreview = document.getElementById('username-preview-value');
            if (usernamePreview) usernamePreview.textContent = '---';
            
            // Auto close after 2 seconds
            setTimeout(() => {
                closeCreateAccountModal();
            }, 2000);
        } else {
            console.log('[CREATE ACCOUNT] Account creation failed:', data.message);
            errorText.textContent = data.message || 'فشل إنشاء الحساب';
            errorDiv.classList.remove('hidden');
        }
    } catch (error) {
        console.error('[CREATE ACCOUNT] Error:', error);
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            const serverURL = API_URL.replace('/api', '');
            errorText.textContent = `تعذر الاتصال بالخادم. تأكد من أن السيرفر يعمل على ${serverURL}`;
        } else {
            errorText.textContent = 'حدث خطأ أثناء إنشاء الحساب: ' + error.message;
        }
        errorDiv.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.innerHTML = oldBtnText;
    }
    
    return false;
}

function logout() {
    ['dashboard-screen', 'page-detail-screen', 'ticket-management-screen', 'team-management-screen', 'team-tickets-screen'].forEach(id => {
        const el = document.getElementById(id);
        if(el) {
            el.classList.add('hidden');
            el.classList.remove('flex');
        }
    });
    const loginContainer = document.getElementById('login-container');
    if (loginContainer) {
        loginContainer.classList.remove('hidden');
        loginContainer.classList.add('flex', 'flex-1');
        loginContainer.style.display = 'flex';
    }
    hideSideMenu(); // إخفاء القائمة الجانبية عند الخروج
    currentUserId = null;
    currentDetailUser = '';
    currentDetailPass = '';
    currentUserAgentName = null;
    currentCompanyName = null;
}

// (Import section removed)

// ================= Super Admin - Pages Management =================
async function loadPages() {
    try {
        // Load from alwatani_login table (حسابات الوطني - واجهة تسجيل الدخول الثانية)
        // فلترة حسب المستخدم الحالي (عزل البيانات)
        if (!currentUserId || !currentDetailUser) {
            console.error('Missing currentUserId or currentDetailUser');
            return;
        }
        
        const response = await fetch(`${API_URL}/alwatani-login?user_id=${currentUserId}&username=${encodeURIComponent(currentDetailUser)}`);
        const data = await response.json();
        
        const listContainer = document.getElementById('pages-list-container');
        const emptyState = document.getElementById('empty-state');
        
        // Clear existing pages except empty state
        const existingPages = listContainer.querySelectorAll('.slide-up');
        existingPages.forEach(page => page.remove());
        
        // التحقق من أن data هو array
        if (!Array.isArray(data)) {
            console.error('Invalid data format:', data);
            emptyState.style.display = 'block';
            return;
        }
        
        if (data.length === 0) {
            emptyState.style.display = 'block';
        } else {
            emptyState.style.display = 'none';
            data.forEach(user => {
                addPageCard(user.username, user.password, user.id, 'dashboard');
            });
        }
    } catch (error) {
        console.error('Error loading pages:', error);
    }
}

async function handleAddPage(e) {
    e.preventDefault();
    const userInput = document.getElementById('new-page-user');
    const passInput = document.getElementById('new-page-pass');
    const username = userInput.value.trim();
    const password = passInput.value.trim();
    
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const oldBtnText = submitBtn.innerHTML;
    
    // Show loading state
    submitBtn.disabled = true;
    submitBtn.innerHTML = `
        <svg class="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        جاري التحقق...
    `;

    try {
        // Add Alwatani account to alwatani_login table (backend will verify with external API first)
        // ربط الحساب بالمستخدم الحالي
        if (!currentUserId) {
            alert('❌ يجب تسجيل الدخول أولاً');
            return;
        }
        
        const response = await fetch(`${API_URL}/alwatani-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                username, 
                password,
                role: 'user',
                user_id: currentUserId, // ربط الحساب بالمستخدم الحالي
                owner_username: currentDetailUser // اسم المستخدم الخاص بالمالك (مثل admin@tec)
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            document.getElementById('empty-state').style.display = 'none';
            addPageCard(username, password, data.id, 'dashboard');
            
            // Show success message
            submitBtn.innerHTML = '✅ تم بنجاح';
            submitBtn.classList.add('bg-green-500');
            submitBtn.classList.remove('custom-blue');
            
            // After adding user, automatically go to subscriber management page
            // لا نغير currentDetailUser - نحتفظ بـ admin@domain
            currentDetailPass = password;
            currentUserId = data.id;
            
            // Switch to subscriber management page after short delay
            setTimeout(async () => {
                switchScreen('dashboard-screen', 'page-detail-screen');
                await loadSubscribers();
                await loadAlwataniDetails();
                
                // Clear form
            userInput.value = '';
            passInput.value = '';
                
                // Reset button
                submitBtn.disabled = false;
                submitBtn.innerHTML = oldBtnText;
                submitBtn.classList.remove('bg-green-500');
                submitBtn.classList.add('custom-blue');
            }, 1000);
        } else {
            alert('❌ ' + (data.message || 'فشل إضافة المستخدم'));
            submitBtn.disabled = false;
            submitBtn.innerHTML = oldBtnText;
        }
    } catch (error) {
        console.error('Error adding page:', error);
        alert('❌ حدث خطأ أثناء إضافة الحساب: ' + error.message);
        submitBtn.disabled = false;
        submitBtn.innerHTML = oldBtnText;
    }
}

function addPageCard(username, password, userId) {
    const listContainer = document.getElementById('pages-list-container');
    const timeNow = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    
    const pageCard = document.createElement('div');
    pageCard.className = "bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4 slide-up group hover:border-blue-300 hover:shadow-md transition-all w-full cursor-pointer";
    pageCard.onclick = function() { openPageDetail(username, password, userId); };
    
    pageCard.innerHTML = `
        <div class="flex items-center gap-4 flex-1">
            <div class="w-10 h-10 bg-blue-50 text-[#26466D] rounded-full flex items-center justify-center flex-shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
            </div>
            <div class="flex flex-col sm:flex-row sm:gap-6 w-full">
                <div class="flex flex-col">
                    <span class="text-xs text-slate-400">اسم المستخدم</span>
                    <span class="font-bold text-slate-800 text-lg">${username}</span>
                </div>
                <div class="hidden sm:block w-px h-10 bg-slate-100"></div>
                <div class="flex flex-col">
                    <span class="text-xs text-slate-400">كلمة المرور</span>
                    <span class="font-mono text-slate-600 bg-slate-50 px-2 rounded mt-0.5">${password}</span>
                </div>
            </div>
        </div>
        <div class="flex items-center justify-between md:justify-end gap-3 border-t md:border-t-0 border-slate-100 pt-3 md:pt-0 mt-2 md:mt-0">
            <span class="text-xs text-slate-400 font-medium">${timeNow}</span>
            <button onclick="event.stopPropagation(); deletePage(${userId}, this)" class="text-red-400 hover:text-red-600 p-2 rounded-full hover:bg-red-50 transition-colors z-10 relative" title="حذف">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
        </div>
    `;
    
    listContainer.insertBefore(pageCard, listContainer.firstChild);
}

async function deletePage(userId, button) {
    if (!confirm('هل تريد حذف هذا المستخدم؟')) return;
    
    try {
        // Delete from alwatani_login table
        const response = await fetch(`${API_URL}/alwatani-login/${userId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            button.closest('.slide-up').remove();
            checkEmpty();
        } else {
            alert('❌ ' + (data.message || 'فشل حذف المستخدم'));
        }
    } catch (error) {
        console.error('Error deleting page:', error);
        alert('حدث خطأ أثناء حذف الصفحة');
    }
}

function checkEmpty() {
    const listContainer = document.getElementById('pages-list-container');
    const emptyState = document.getElementById('empty-state');
    const pages = listContainer.getElementsByClassName('slide-up');
    if (pages.length === 0) emptyState.style.display = 'block';
}

function openPageDetail(username, password, userId) {
    // لا نغير currentDetailUser - نحتفظ بـ admin@domain
    // username و password من alwatani_login تُستخدم فقط للاتصال بـ Alwatani API
    console.log('[OPEN PAGE] Opening page detail:', { 
        alwataniUsername: username, 
        currentDetailUser: currentDetailUser,
        userId: userId 
    });
    currentDetailPass = password; // فقط password من alwatani_login
    currentUserId = userId;
    // التأكد من أن currentDetailUser لا يزال admin@domain
    if (!currentDetailUser || !currentDetailUser.includes('@')) {
        console.warn('[OPEN PAGE] Warning: currentDetailUser is not set or invalid:', currentDetailUser);
    }
    switchScreen('dashboard-screen', 'page-detail-screen');
    showSideMenu(); // إظهار القائمة الجانبية عند فتح صفحة تفاصيل المستخدم
    
    // إظهار section-dashboard وإخفاء section-subscribers بشكل افتراضي
    const sectionDashboard = document.getElementById('section-dashboard');
    const sectionSubscribers = document.getElementById('section-subscribers');
    if (sectionDashboard) sectionDashboard.classList.remove('hidden');
    if (sectionSubscribers) sectionSubscribers.classList.add('hidden');
    
    loadSubscribers();
    loadAlwataniDetails();
    // تم إزالة updateSyncStatus() لأننا لم نعد نستخدم sync
}

async function updateSyncStatus() {
    // تم تعطيل هذه الدالة لأننا لم نعد نستخدم sync وcache
    // البيانات تُجلب مباشرة من API في كل مرة
    if (!currentUserId) return;
    
    const syncStatusEl = document.getElementById('sync-status');
    if (syncStatusEl) {
        syncStatusEl.textContent = 'البيانات تُجلب مباشرة من الموقع الرئيسي';
        syncStatusEl.className = 'text-sm text-blue-600 mt-2';
    }
}

function backToDashboard() {
    switchScreen('page-detail-screen', 'dashboard-screen');
    hideSideMenu(); // إخفاء القائمة الجانبية عند العودة إلى لوحة التحكم الرئيسية
}

function openAdminDashboard() {
    switchScreen('page-detail-screen', 'dashboard-screen');
    hideSideMenu(); // إخفاء القائمة الجانبية عند العودة إلى لوحة التحكم الرئيسية
    loadPages();
    currentScreen = 'dashboard';
    startAutoRefresh();
}

function openExpiringScreen() {
    hideAllMainScreens();
    showScreen('expiring-screen');
    renderExpiringSoonList();
    setSideMenuActiveByScreen('expiring');
    currentScreen = 'expiring';
    startAutoRefresh();
}

function closeExpiringScreen() {
    scrollToSection('section-subscribers');
}

function openTicketDashboardScreen() {
    hideAllMainScreens();
    showScreen('tickets-dashboard-screen');
    setSideMenuActiveByScreen('tickets');
    currentScreen = 'tickets';
    startAutoRefresh();
}

function closeTicketDashboardScreen() {
    scrollToSection('section-subscribers');
}

function openGeneralSettingsScreen() {
    hideAllMainScreens();
    showScreen('general-settings-screen');
    setSideMenuActiveByScreen('settings');
    loadEmployees();
    currentScreen = 'settings';
    startAutoRefresh();
}

function closeGeneralSettingsScreen() {
    scrollToSection('section-subscribers');
}

// ================= Employee Management System =================

// نظام الصلاحيات الشامل
const PERMISSIONS_SYSTEM = {
    dashboard: {
        name: 'لوحة التحكم الرئيسية',
        permissions: {
            'dashboard.view': 'عرض لوحة التحكم',
            'dashboard.stats': 'عرض الإحصائيات',
            'dashboard.export': 'تصدير البيانات'
        }
    },
    subscribers: {
        name: 'إدارة المشتركين',
        permissions: {
            'subscribers.view': 'عرض المشتركين',
            'subscribers.sync': 'مزامنة المشتركين',
            'subscribers.edit': 'تعديل بيانات المشتركين',
            'subscribers.delete': 'حذف المشتركين',
            'subscribers.export': 'تصدير قائمة المشتركين'
        }
    },
    tickets: {
        name: 'إدارة التذاكر',
        permissions: {
            'tickets.view': 'عرض التذاكر',
            'tickets.create': 'إنشاء تذاكر جديدة',
            'tickets.edit': 'تعديل التذاكر',
            'tickets.delete': 'حذف التذاكر',
            'tickets.assign': 'توزيع التذاكر على الفرق',
            'tickets.redirect': 'إعادة توجيه التذاكر',
            'tickets.close': 'إغلاق التذاكر'
        }
    },
    teams: {
        name: 'إدارة الفرق',
        permissions: {
            'teams.view': 'عرض الفرق',
            'teams.create': 'إنشاء فرق جديدة',
            'teams.edit': 'تعديل الفرق',
            'teams.delete': 'حذف الفرق',
            'teams.members': 'إدارة أعضاء الفرق'
        }
    },
    wallet: {
        name: 'محفظة النقود',
        permissions: {
            'wallet.view': 'عرض رصيد المحفظة',
            'wallet.transactions': 'عرض الحوالات',
            'wallet.sync': 'مزامنة الحوالات',
            'wallet.export': 'تصدير الحوالات'
        }
    },
    employees: {
        name: 'إدارة الموظفين',
        permissions: {
            'employees.view': 'عرض الموظفين',
            'employees.create': 'إضافة موظفين',
            'employees.edit': 'تعديل بيانات الموظفين',
            'employees.delete': 'حذف الموظفين',
            'employees.permissions': 'تعديل صلاحيات الموظفين'
        }
    },
    settings: {
        name: 'الإعدادات',
        permissions: {
            'settings.view': 'عرض الإعدادات',
            'settings.edit': 'تعديل الإعدادات',
            'settings.alwatani': 'إدارة حسابات الوطني'
        }
    },
    reports: {
        name: 'التقارير',
        permissions: {
            'reports.view': 'عرض التقارير',
            'reports.generate': 'إنشاء تقارير',
            'reports.export': 'تصدير التقارير'
        }
    }
};

let currentEditingEmployeeId = null;

// تحميل قائمة الموظفين
async function loadEmployees() {
    try {
        const response = await fetch(addUsernameToUrl(`${API_URL}/employees`), addUsernameToFetchOptions());
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const employees = await response.json();
        
        const container = document.getElementById('employees-list-container');
        if (!container) return;
        
        // التحقق من أن employees هو array
        if (!employees || !Array.isArray(employees)) {
            console.error('[LOAD EMPLOYEES] Invalid response format:', employees);
            container.innerHTML = `
                <div class="text-center py-12 bg-slate-50 rounded-xl border border-dashed border-slate-300">
                    <p class="text-slate-500 font-medium">خطأ في تحميل الموظفين</p>
                    <p class="text-sm text-slate-400 mt-1">يرجى المحاولة مرة أخرى</p>
                </div>
            `;
            return;
        }
        
        if (employees.length === 0) {
            container.innerHTML = `
                <div class="text-center py-12 bg-slate-50 rounded-xl border border-dashed border-slate-300">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 text-slate-400 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                    </svg>
                    <p class="text-slate-500 font-medium">لا يوجد موظفين</p>
                    <p class="text-sm text-slate-400 mt-1">ابدأ بإضافة موظف جديد</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = employees.map(emp => {
            // الأيقونات للمناصب
            const positionIcons = {
                'المالك': '👑',
                'مدير': '👔',
                'محاسب': '💼',
                'مبيعات': '📊',
                'متابعة': '📋',
                'دعم فني': '🛠️',
                'مندوب': '🚚'
            };
            
            const positionColors = {
                'المالك': 'bg-purple-100 text-purple-700',
                'مدير': 'bg-indigo-100 text-indigo-700',
                'محاسب': 'bg-green-100 text-green-700',
                'مبيعات': 'bg-yellow-100 text-yellow-700',
                'متابعة': 'bg-pink-100 text-pink-700',
                'دعم فني': 'bg-orange-100 text-orange-700',
                'مندوب': 'bg-blue-100 text-blue-700'
            };
            
            const positionIcon = positionIcons[emp.position] || '👤';
            
            const positionColor = positionColors[emp.position] || 'bg-slate-100 text-slate-700';
            const permissions = emp.permissions ? (typeof emp.permissions === 'string' ? JSON.parse(emp.permissions) : emp.permissions) : {};
            const permissionsCount = Object.keys(permissions).filter(k => permissions[k]).length;
            
            const isOwner = emp.position === 'المالك' || emp.position === 'Owner';
            
            // عرض agent_name كالاسم الرئيسي إذا كان موجوداً وغير فارغ
            // الأولوية: agent_name > display_name > username
            let ownerDisplayName = emp.username; // القيمة الافتراضية
            
            // تحقق من agent_name أولاً
            if (emp.agent_name !== null && emp.agent_name !== undefined && String(emp.agent_name).trim().length > 0) {
                ownerDisplayName = String(emp.agent_name).trim();
            } 
            // إذا لم يوجد agent_name، استخدم display_name
            else if (emp.display_name !== null && emp.display_name !== undefined && String(emp.display_name).trim().length > 0) {
                ownerDisplayName = String(emp.display_name).trim();
            }
            
            const ownerUsername = isOwner ? String(emp.username).replace(/^@/, '') : String(emp.username);
            
            // التحقق من حالة الحساب بشكل صحيح (is_active: 1/0 أو true/false)
            const isActive = emp.is_active === 1 || emp.is_active === true || (emp.is_active !== 0 && emp.is_active !== false && emp.is_active !== null);
            
            // إصلاح رقم الهاتف: إزالة تكرار +964 وعرضه بدون + (مثل المالك)
            let phoneDisplay = '';
            if (emp.phone) {
                let phone = emp.phone.toString().trim();
                // إزالة جميع +964 المتكررة
                phone = phone.replace(/\+\s*964/g, '');
                phone = phone.replace(/\+964/g, '');
                phone = phone.replace(/^964/g, ''); // إزالة 964 من البداية إذا كانت موجودة
                
                // إذا كان الرقم موجوداً وطوله 9 أرقام على الأقل، أضف 964
                if (phone && phone.length >= 9) {
                    phoneDisplay = `964${phone}`;
                } else if (phone && phone.length >= 13) {
                    // إذا كان الرقم طويلاً (يحتوي على 964 بالفعل)
                    phoneDisplay = phone;
                }
            }
            
            // معلومات إضافية (البريد الإلكتروني ورقم الهاتف) - لجميع الموظفين
            const ownerInfo = (emp.email || phoneDisplay) ? `
                <div class="mt-2 pt-2 border-t border-slate-200">
                    ${emp.email ? `<div class="text-xs text-slate-600 mb-1">📧 ${emp.email}</div>` : ''}
                    ${phoneDisplay ? `<div class="text-xs text-slate-600">📱 ${phoneDisplay}</div>` : ''}
                </div>
            ` : '';
            
            return `
                <div class="bg-white border border-slate-200 rounded-xl p-5 hover:shadow-md transition-shadow">
                    <div class="flex items-start justify-between">
                        <div class="flex-1">
                            <div class="flex items-center gap-3 mb-2">
                                <div class="w-12 h-12 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-bold text-lg">
                                    ${ownerDisplayName.charAt(0).toUpperCase()}
                                </div>
                                <div class="flex-1">
                                    <div class="flex items-center gap-2">
                                        <h4 class="font-bold text-slate-800 text-lg">${ownerDisplayName}</h4>
                                        ${!isOwner ? `
                                        <button onclick="toggleEmployeeStatus(${emp.id}, ${isActive})" 
                                                class="p-1.5 rounded-lg transition-colors ${isActive ? 'text-green-600 hover:bg-green-100 bg-green-50' : 'text-red-600 hover:bg-red-100 bg-red-50'}" 
                                                title="${isActive ? 'الحساب مفعّل - اضغط للتجميد' : 'الحساب مجمّد - اضغط للتفعيل'}">
                                            ${isActive ? `
                                                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                                                </svg>
                                            ` : `
                                                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                                </svg>
                                            `}
                                        </button>
                                        ` : ''}
                                    </div>
                                    <p class="text-sm text-slate-500">${ownerUsername.replace(/^@/, '')}</p>
                                    ${ownerInfo}
                                </div>
                            </div>
                            <div class="flex items-center gap-2 mb-3">
                                <span class="${positionColor} text-xs font-bold px-3 py-1 rounded-full">${positionIcon} ${emp.position || 'غير محدد'}</span>
                                ${!isOwner ? `<span class="text-xs text-slate-500">${permissionsCount} صلاحية</span>` : ''}
                            </div>
                            ${!isOwner ? `
                            <div class="text-xs text-slate-400">
                                تم الإنشاء: ${new Date(emp.created_at).toLocaleDateString('ar-IQ')}
                            </div>
                            ` : ''}
                        </div>
                        ${!isOwner ? `
                        <div class="flex items-center gap-2">
                            <button onclick="editEmployee(${emp.id})" class="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg text-sm font-medium transition-colors">
                                تعديل
                            </button>
                            <button onclick="deleteEmployee(${emp.id}, '${(emp.display_name || emp.username).replace(/'/g, "\\'")}')" class="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-sm font-medium transition-colors">
                                حذف
                            </button>
                        </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Error loading employees:', error);
        const container = document.getElementById('employees-list-container');
        if (container) {
            container.innerHTML = `
                <div class="text-center py-12 bg-red-50 rounded-xl border border-red-200">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 text-red-400 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p class="text-red-600 font-medium">خطأ في تحميل الموظفين</p>
                    <p class="text-sm text-red-400 mt-1">${error.message || 'يرجى المحاولة مرة أخرى'}</p>
                </div>
            `;
        }
    }
}

// متغير لتخزين النطاق
let cachedOwnerDomain = null;

// استخراج النطاق من اسم المستخدم للمالك (مثال: admin@tec -> tec)
async function getOwnerDomain() {
    // إذا كان النطاق محفوظاً في الكاش، استخدمه
    if (cachedOwnerDomain) {
        return cachedOwnerDomain;
    }
    
    // محاولة استخراج النطاق من currentDetailUser
    if (currentDetailUser) {
        const parts = currentDetailUser.split('@');
        if (parts.length > 1) {
            cachedOwnerDomain = parts[1];
            return cachedOwnerDomain;
        }
    }
    
    // إذا لم يتم العثور على النطاق محلياً، اجلبه من قاعدة البيانات
    try {
        const response = await fetch(`${API_URL}/owner/domain`);
        const data = await response.json();
        if (data.success && data.domain) {
            cachedOwnerDomain = data.domain;
            return cachedOwnerDomain;
        }
    } catch (error) {
        console.error('Error fetching owner domain:', error);
    }
    
    return '';
}

// فتح نافذة إضافة موظف
async function openAddEmployeeModal() {
    currentEditingEmployeeId = null;
    document.getElementById('add-employee-modal-title').textContent = 'إضافة موظف جديد';
    document.getElementById('add-employee-submit-text').textContent = 'إضافة الموظف';
    document.getElementById('employee-username').value = '';
    document.getElementById('employee-display-name').value = '';
    document.getElementById('employee-password').value = '';
    document.getElementById('employee-password-confirm').value = '';
    document.getElementById('employee-position').value = '';
    document.getElementById('employee-email').value = '';
    document.getElementById('employee-phone').value = '';
    
    // جلب النطاق وتحديث placeholder
    const usernameInput = document.getElementById('employee-username');
    const ownerDomain = await getOwnerDomain();
    
    if (ownerDomain && usernameInput) {
        usernameInput.placeholder = `مثال: ahmed (سيصبح: ahmed@${ownerDomain})`;
        const previewEl = document.getElementById('employee-username-preview');
        if (previewEl) {
            previewEl.textContent = `اسم المستخدم الكامل: ---`;
        }
    }
    
    // إضافة event listener لتحديث المعاينة عند الكتابة
    if (usernameInput && !usernameInput.dataset.listenerAdded) {
        usernameInput.addEventListener('input', async function() {
            const usernameValue = this.value.trim();
            const domain = await getOwnerDomain();
            const previewEl = document.getElementById('employee-username-preview');
            if (previewEl) {
                if (usernameValue && domain) {
                    previewEl.textContent = `اسم المستخدم الكامل: ${usernameValue}@${domain}`;
                } else {
                    previewEl.textContent = `اسم المستخدم الكامل: ---`;
                }
            }
        });
        usernameInput.dataset.listenerAdded = 'true';
    }
    
    // بناء قائمة الصلاحيات
    buildPermissionsList();
    
    const modal = document.getElementById('add-employee-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

// إغلاق نافذة إضافة موظف
function closeAddEmployeeModal() {
    const modal = document.getElementById('add-employee-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    currentEditingEmployeeId = null;
}

// بناء قائمة الصلاحيات
function buildPermissionsList(selectedPermissions = {}) {
    const container = document.querySelector('#permissions-container .space-y-4');
    if (!container) return;
    
    const allPermissions = {};
    Object.values(PERMISSIONS_SYSTEM).forEach(categoryData => {
        Object.assign(allPermissions, categoryData.permissions);
    });
    
    container.innerHTML = `
        <div class="mb-4 pb-4 border-b border-slate-200">
            <label class="flex items-center gap-2 cursor-pointer hover:bg-white p-2 rounded transition-colors bg-indigo-50">
                <input type="checkbox" id="select-all-permissions" onchange="toggleAllPermissions(this.checked)" class="w-4 h-4 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500">
                <span class="text-sm font-bold text-indigo-700">تأشير الكل</span>
            </label>
        </div>
        ${Object.entries(PERMISSIONS_SYSTEM).map(([category, categoryData]) => {
            const categoryPermissions = Object.entries(categoryData.permissions).map(([key, name]) => {
                const isChecked = selectedPermissions[key] ? 'checked' : '';
                return `
                    <label class="flex items-center gap-2 cursor-pointer hover:bg-white p-2 rounded transition-colors">
                        <input type="checkbox" name="permission" value="${key}" ${isChecked} onchange="updateSelectAllCheckbox()" class="w-4 h-4 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500 permission-checkbox">
                        <span class="text-sm text-slate-700">${name}</span>
                    </label>
                `;
            }).join('');
            
            return `
                <div class="bg-white rounded-lg p-4 border border-slate-200">
                    <h5 class="font-bold text-slate-800 mb-3 text-sm">${categoryData.name}</h5>
                    <div class="space-y-1">
                        ${categoryPermissions}
                    </div>
                </div>
            `;
        }).join('')}
    `;
    
    // تحديث حالة "تأشير الكل" بناءً على الصلاحيات المحددة
    updateSelectAllCheckbox();
}

// تأشير/إلغاء تأشير جميع الصلاحيات
function toggleAllPermissions(checked) {
    const checkboxes = document.querySelectorAll('.permission-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = checked;
    });
}

// تحديث حالة "تأشير الكل" بناءً على حالة الصلاحيات
function updateSelectAllCheckbox() {
    const checkboxes = document.querySelectorAll('.permission-checkbox');
    const selectAllCheckbox = document.getElementById('select-all-permissions');
    if (!selectAllCheckbox || checkboxes.length === 0) return;
    
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    const someChecked = Array.from(checkboxes).some(cb => cb.checked);
    
    selectAllCheckbox.checked = allChecked;
    selectAllCheckbox.indeterminate = someChecked && !allChecked;
}

// معالجة إضافة/تعديل موظف
async function handleAddEmployee(e) {
    e.preventDefault();
    
    let username = document.getElementById('employee-username').value.trim();
    const displayName = document.getElementById('employee-display-name').value.trim();
    const password = document.getElementById('employee-password').value;
    const passwordConfirm = document.getElementById('employee-password-confirm').value;
    const position = document.getElementById('employee-position').value;
    const email = document.getElementById('employee-email').value.trim();
    const phone = document.getElementById('employee-phone').value.trim();
    
    // إضافة النطاق تلقائياً لاسم المستخدم إذا لم يكن موجوداً
    const ownerDomain = await getOwnerDomain();
    if (ownerDomain && username && !username.includes('@')) {
        username = `${username}@${ownerDomain}`;
    }
    
    // التحقق من البيانات
    if (!username || !displayName || !password || !position) {
        alert('يرجى ملء جميع الحقول المطلوبة');
        return;
    }
    
    if (password !== passwordConfirm) {
        alert('كلمة المرور وتأكيدها غير متطابقين');
        return;
    }
    
    if (password.length < 6) {
        alert('كلمة المرور يجب أن تكون 6 أحرف على الأقل');
        return;
    }
    
    // جمع الصلاحيات المحددة
    const permissionCheckboxes = document.querySelectorAll('#permissions-container input[name="permission"]:checked');
    const permissions = {};
    permissionCheckboxes.forEach(cb => {
        permissions[cb.value] = true;
    });
    
    if (Object.keys(permissions).length === 0) {
        alert('يرجى تحديد صلاحية واحدة على الأقل');
        return;
    }
    
    try {
        const url = currentEditingEmployeeId 
            ? `${API_URL}/employees/${currentEditingEmployeeId}`
            : `${API_URL}/employees`;
        const method = currentEditingEmployeeId ? 'PUT' : 'POST';
        
        const body = {
            username,
            display_name: displayName,
            password,
            position,
            permissions,
            email: email || null,
            phone: phone || null
        };
        
        // إذا كان تعديل ولا نريد تغيير كلمة المرور
        if (currentEditingEmployeeId && !password) {
            delete body.password;
        }
        
        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        const data = await response.json();
        
        if (data.success) {
            await loadEmployees();
            closeAddEmployeeModal();
            alert(`✅ ${currentEditingEmployeeId ? 'تم تحديث' : 'تم إضافة'} الموظف بنجاح!`);
        } else {
            alert('❌ ' + (data.message || 'فشلت العملية'));
        }
    } catch (error) {
        console.error('Error saving employee:', error);
        alert('❌ حدث خطأ أثناء حفظ الموظف');
    }
}

// تعديل موظف
async function editEmployee(employeeId) {
    try {
        const response = await fetch(`${API_URL}/employees/${employeeId}`);
        const employee = await response.json();
        
        if (!employee || !employee.id) {
            alert('❌ لم يتم العثور على الموظف');
            return;
        }
        
        // منع تعديل المالك
        if (employee.position === 'المالك' || employee.position === 'Owner') {
            alert('❌ لا يمكن تعديل بيانات المالك');
            return;
        }
        
        currentEditingEmployeeId = employee.id;
        document.getElementById('add-employee-modal-title').textContent = 'تعديل موظف';
        document.getElementById('add-employee-submit-text').textContent = 'حفظ التعديلات';
        
        // استخراج الجزء الأول من اسم المستخدم (بدون النطاق) للعرض
        const usernameParts = employee.username.split('@');
        const usernameWithoutDomain = usernameParts.length > 0 ? usernameParts[0] : employee.username;
        document.getElementById('employee-username').value = usernameWithoutDomain;
        
        // تحديث المعاينة
        const ownerDomain = await getOwnerDomain();
        const previewEl = document.getElementById('employee-username-preview');
        if (previewEl && ownerDomain) {
            previewEl.textContent = `اسم المستخدم الكامل: ${usernameWithoutDomain}@${ownerDomain}`;
        }
        
        document.getElementById('employee-display-name').value = employee.display_name || '';
        document.getElementById('employee-password').value = '';
        document.getElementById('employee-password-confirm').value = '';
        document.getElementById('employee-password').required = false;
        document.getElementById('employee-password-confirm').required = false;
        document.getElementById('employee-position').value = employee.position || '';
        document.getElementById('employee-email').value = employee.email || '';
        // استخراج رقم الهاتف بدون +964 للعرض
        let phoneValue = '';
        if (employee.phone) {
            phoneValue = employee.phone.toString().replace(/^\+?964/, '');
        }
        document.getElementById('employee-phone').value = phoneValue;
        
        const permissions = employee.permissions ? (typeof employee.permissions === 'string' ? JSON.parse(employee.permissions) : employee.permissions) : {};
        buildPermissionsList(permissions);
        
        const modal = document.getElementById('add-employee-modal');
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    } catch (error) {
        console.error('Error loading employee:', error);
        alert('❌ حدث خطأ أثناء تحميل بيانات الموظف');
    }
}

// حذف موظف
// تبديل حالة تفعيل/تجميد الموظف
async function toggleEmployeeStatus(employeeId, currentStatus) {
    const newStatus = !currentStatus;
    const statusText = newStatus ? 'تفعيل' : 'تجميد';
    
    if (!confirm(`هل أنت متأكد من ${statusText} هذا الحساب؟`)) {
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/employees/${employeeId}/toggle-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: newStatus })
        });
        
        const data = await response.json();
        
        if (data.success) {
            await loadEmployees();
            alert(`✅ تم ${statusText} الحساب بنجاح`);
        } else {
            alert('❌ ' + (data.message || 'فشلت العملية'));
        }
    } catch (error) {
        console.error('Error toggling employee status:', error);
        alert('❌ حدث خطأ أثناء تغيير حالة الحساب');
    }
}

async function deleteEmployee(employeeId, employeeName) {
    // التحقق من أن الموظف ليس مالكاً قبل التأكيد
    try {
        const employeeResponse = await fetch(`${API_URL}/employees/${employeeId}`);
        const employee = await employeeResponse.json();
        
        if (employee && (employee.position === 'المالك' || employee.position === 'Owner')) {
            alert('❌ لا يمكن حذف المالك');
            return;
        }
    } catch (error) {
        console.error('Error checking employee:', error);
    }
    
    if (!confirm(`هل أنت متأكد من حذف الموظف "${employeeName}"؟\n\nهذه العملية لا يمكن التراجع عنها.`)) {
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/employees/${employeeId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            await loadEmployees();
            alert('✅ تم حذف الموظف بنجاح');
        } else {
            alert('❌ ' + (data.message || 'فشل حذف الموظف'));
        }
    } catch (error) {
        console.error('Error deleting employee:', error);
        alert('❌ حدث خطأ أثناء حذف الموظف');
    }
}

// دالة لتحديث البيانات فقط بدون إعادة تحميل كامل
async function refreshSubscribersDataOnly() {
    if (!currentUserId) return;
    
    // منع التحديثات المتداخلة
    if (isRefreshingData) {
        console.log('[AUTO-REFRESH] Refresh already in progress, skipping...');
        return;
    }
    
    isRefreshingData = true;
    
    try {
        const userId = currentUserId;
        const pageNumber = currentCustomersPage || 1;
        const pageSize = ALWATANI_CUSTOMERS_PAGE_SIZE;
        
        // إظهار شريط التحميل
        showSubscribersLoading(true, 'جاري تحديث البيانات...');
        
        // في التحديث التلقائي: جلب صفحة واحدة فقط (أسرع وأكثر موثوقية)
        // بدلاً من جلب جميع الصفحات التي قد تستغرق وقتاً طويلاً
        const apiUrl = `${API_URL}/alwatani-login/${userId}/customers?username=${encodeURIComponent(currentDetailUser || '')}&pageNumber=${pageNumber}&pageSize=${pageSize}`;
        
        // إضافة timeout للطلب (30 ثانية - كافٍ لصفحة واحدة)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 ثانية timeout
        
        const response = await fetch(apiUrl, {
            ...addUsernameToFetchOptions(),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        const data = await response.json();
        
        console.log('[AUTO-REFRESH] Response:', {
            success: data.success,
            hasData: !!data.data,
            hasCombined: !!data.data?.combined,
            combinedLength: data.data?.combined?.length || 0,
            dataKeys: data.data ? Object.keys(data.data) : []
        });
        
        if (data.success && data.data && data.data.combined && Array.isArray(data.data.combined)) {
            const combinedList = data.data.combined;
            console.log('[AUTO-REFRESH] Processing', combinedList.length, 'subscribers from page', pageNumber);
            
            // دمج البيانات الجديدة مع البيانات الموجودة (بدلاً من استبدالها)
            // تحديث المشتركين الموجودين وإضافة الجدد
            const existingMap = new Map(subscribersCache.map(sub => [sub.accountId || sub.account_id, sub]));
            
            combinedList.forEach((sub) => {
                const accountId = sub.accountId || sub.account_id;
                if (accountId) {
                    existingMap.set(accountId, sub);
                }
            });
            
            // تحديث subscribersCache مع البيانات المدمجة
            subscribersCache = Array.from(existingMap.values()).map((sub) => {
                const normalized = {
                    id: sub.id || sub.accountId || sub.account_id || null,
                    account_id: sub.account_id || sub.accountId || null,
                    accountId: sub.accountId || sub.account_id || null,
                    username: sub.username || null,
                    deviceName: sub.deviceName || sub.device_name || null,
                    name: sub.name || '--',
                    phone: sub.phone || null,
                    zone: sub.zone || null,
                    page_url: sub.page_url || (sub.accountId || sub.account_id ? `https://admin.ftth.iq/customer-details/${sub.accountId || sub.account_id}/details/view` : '#'),
                    start_date: sub.start_date || sub.startDate || null,
                    startDate: sub.startDate || sub.start_date || null,
                    end_date: sub.end_date || sub.endDate || null,
                    endDate: sub.endDate || sub.end_date || null,
                    status: sub.status || null,
                    raw: sub.raw || {},
                    rawCustomer: sub.rawCustomer || null,
                    rawAddress: sub.rawAddress || null
                };
                return {
                    ...normalized,
                    _meta: buildSubscriberMeta(normalized)
                };
            });
            
            // تحديث العرض فقط (بدون إعادة تحميل كامل)
            renderSubscriberStatusCards();
            renderExpiringSoonList();
            applySubscriberFilter(activeSubscriberFilter || 'all');
            
            if (combinedList.length > 0) {
                updateStatsFromSummary(combinedList);
            }
            
            loadWalletBalance();
            
            const total = data.pagination?.total || combinedList.length;
            const totalPages = Math.ceil(total / pageSize);
            subscriberPagination.currentPage = pageNumber;
            subscriberPagination.totalPages = totalPages;
            updatePaginationControls(total, totalPages);
            
            showSubscribersLoading(false);
            console.log('[AUTO-REFRESH] Data updated successfully:', combinedList.length, 'subscribers');
        } else {
            showSubscribersLoading(false);
            console.warn('[AUTO-REFRESH] No data received. Response:', {
                success: data.success,
                hasData: !!data.data,
                hasCombined: !!data.data?.combined,
                message: data.message || 'No message',
                data: data.data ? Object.keys(data.data) : 'No data object'
            });
        }
    } catch (error) {
        showSubscribersLoading(false);
        if (error.name === 'AbortError') {
            console.warn('[AUTO-REFRESH] Request timeout (took longer than 60 seconds)');
        } else {
            console.error('[AUTO-REFRESH] Error refreshing data:', error);
        }
    } finally {
        // إعادة تعيين flag بعد انتهاء الطلب
        isRefreshingData = false;
    }
}

// متغيرات لتتبع التقدم الحقيقي
let loadingProgressInterval = null;
let currentLoadingCount = 0;
let targetLoadingCount = 0;

// دالة لإظهار/إخفاء شريط التحميل مع عداد حقيقي
function showSubscribersLoading(show, message = '', current = 0, total = 0) {
    const loadingBar = document.getElementById('subscribers-loading-bar');
    const loadingProgress = document.getElementById('subscribers-loading-progress');
    const loadingCounter = document.getElementById('subscribers-loading-counter');
    const loadingMessage = document.getElementById('subscribers-loading-message');
    
    if (loadingBar) {
        if (show) {
            loadingBar.classList.remove('hidden');
            loadingProgress.style.width = '0%';
            
            if (total > 0) {
                currentLoadingCount = current;
                targetLoadingCount = total;
                
                // إظهار العداد
                if (loadingCounter) {
                    loadingCounter.style.display = 'block';
                    loadingCounter.textContent = `${current}/${total}`;
                }
                
                // تحديث التقدم الحقيقي
                updateLoadingProgress(current, total);
            } else {
                // محاكاة التقدم إذا لم يكن هناك total
                if (loadingCounter) {
                    loadingCounter.style.display = 'none';
                }
                let progress = 0;
                if (loadingProgressInterval) {
                    clearInterval(loadingProgressInterval);
                }
                loadingProgressInterval = setInterval(() => {
                    progress += 5;
                    if (progress <= 90) {
                        loadingProgress.style.width = progress + '%';
                    } else {
                        clearInterval(loadingProgressInterval);
                        loadingProgressInterval = null;
                    }
                }, 100);
            }
        } else {
            if (loadingProgressInterval) {
                clearInterval(loadingProgressInterval);
                loadingProgressInterval = null;
            }
            loadingProgress.style.width = '100%';
            if (loadingCounter) {
                loadingCounter.style.display = 'none';
            }
            setTimeout(() => {
                loadingBar.classList.add('hidden');
                loadingProgress.style.width = '0%';
                currentLoadingCount = 0;
                targetLoadingCount = 0;
            }, 300);
        }
    }
    
    if (loadingMessage) {
        if (show && message) {
            loadingMessage.textContent = message;
            loadingMessage.classList.remove('hidden');
        } else {
            loadingMessage.classList.add('hidden');
        }
    }
}

// دالة لتحديث التقدم الحقيقي
function updateLoadingProgress(current, total) {
    const loadingProgress = document.getElementById('subscribers-loading-progress');
    const loadingCounter = document.getElementById('subscribers-loading-counter');
    
    if (!loadingProgress || !total) return;
    
    currentLoadingCount = current;
    targetLoadingCount = total;
    
    const percentage = Math.min(100, Math.round((current / total) * 100));
    loadingProgress.style.width = percentage + '%';
    
    if (loadingCounter) {
        loadingCounter.textContent = `${current}/${total}`;
    }
}

// دالة بدء التحديث التلقائي للبيانات
function startAutoRefresh() {
    // إيقاف أي تحديث تلقائي سابق
    if (dataAutoRefreshInterval) {
        clearInterval(dataAutoRefreshInterval);
        dataAutoRefreshInterval = null;
    }
    
    // تحديث البيانات كل 60 ثانية (زيادة من 30 لتجنب التعارض)
    dataAutoRefreshInterval = setInterval(async () => {
        // التحقق من أن الطلب السابق انتهى
        if (isRefreshingData) {
            console.log('[AUTO-REFRESH] Previous refresh still in progress, skipping this cycle...');
            return;
        }
        
        console.log('[AUTO-REFRESH] Refreshing data for screen:', currentScreen);
        
        try {
            switch (currentScreen) {
                case 'dashboard':
                    // تحديث بيانات المشتركين فقط (بدون إعادة تحميل كامل)
                    if (currentUserId) {
                        await refreshSubscribersDataOnly();
                    }
                    break;
                    
                case 'expiring':
                    // تحديث قائمة المشتركين قرب الانتهاء
                    renderExpiringSoonList();
                    break;
                    
                case 'tickets':
                    // تحديث التذاكر
                    if (typeof loadTickets === 'function') {
                        await loadTickets();
                    }
                    break;
                    
                case 'wallet':
                    // تحديث بيانات المحفظة (إذا كان التحديث التلقائي مفعلاً)
                    if (walletAutoRefreshInterval) {
                        // التحديث التلقائي للمحفظة يعمل بالفعل
                        break;
                    }
                    // وإلا، تحديث بسيط
                    if (typeof loadWalletData === 'function') {
                        await loadWalletData();
                    }
                    break;
                    
                case 'ticket-management':
                    // تحديث قائمة التذاكر في إدارة التذاكر
                    if (typeof loadTeamTickets === 'function') {
                        await loadTeamTickets();
                    }
                    break;
                    
                default:
                    // لا شيء
                    break;
            }
        } catch (error) {
            console.error('[AUTO-REFRESH] Error refreshing data:', error);
        }
    }, 60000); // 60 ثانية (زيادة من 30 لتجنب التعارض)
    
    console.log('[AUTO-REFRESH] Auto-refresh started for screen:', currentScreen);
}

// دالة إيقاف التحديث التلقائي
function stopAutoRefresh() {
    if (dataAutoRefreshInterval) {
        clearInterval(dataAutoRefreshInterval);
        dataAutoRefreshInterval = null;
        console.log('[AUTO-REFRESH] Auto-refresh stopped');
    }
}

function openWalletScreen() {
    hideAllMainScreens();
    showScreen('wallet-screen');
    setSideMenuActiveByScreen('wallet');
    loadWalletData();
    currentScreen = 'wallet';
    // لا نبدأ auto-refresh هنا لأن المحفظة لها نظام تحديث تلقائي خاص بها
}

function closeWalletScreen() {
    // إيقاف التحديث التلقائي عند إغلاق الشاشة
    if (walletAutoRefreshInterval) {
        clearInterval(walletAutoRefreshInterval);
        walletAutoRefreshInterval = null;
    }
    // إلغاء تفعيل toggle
    const toggle = document.getElementById('wallet-auto-refresh-toggle');
    if (toggle) {
        toggle.checked = false;
    }
    scrollToSection('section-subscribers');
}

function hideAllMainScreens() {
    const screens = [
        'dashboard-screen',
        'expiring-screen',
        'tickets-dashboard-screen',
        'general-settings-screen',
        'wallet-screen',
        'team-tickets-screen',
        'page-detail-screen',
        'ticket-management-screen',
        'team-management-screen'
    ];
    screens.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.add('hidden');
            el.classList.remove('flex');
        }
    });
}

function showScreen(id) {
    const el = document.getElementById(id);
    if (el) {
        el.classList.remove('hidden');
        el.classList.add('flex');
    }
}

function setSideMenuActive(buttons) {
    // إزالة التفعيل من جميع الأزرار الرئيسية والفرعية
    document.querySelectorAll('.side-menu-link, .side-menu-link-sub').forEach((btn) => btn.classList.remove('active'));
    if (!buttons) {
        return;
    }
    const targetButtons = Array.isArray(buttons) ? buttons : [buttons];
    targetButtons.forEach((button) => {
        if (button) {
            button.classList.add('active');
        }
    });
}

function setSideMenuActiveBySection(sectionId) {
    if (!sectionId) {
        setSideMenuActive(null);
        return;
    }
    // البحث عن الأزرار التي تستخدم onclick أو data-side-link
    const buttons = Array.from(document.querySelectorAll(`[data-side-link="${sectionId}"], button[onclick*="${sectionId}"]`));
    if (buttons.length) {
        setSideMenuActive(buttons);
    } else {
        setSideMenuActive(null);
    }
}

function setSideMenuActiveByScreen(screenKey) {
    if (!screenKey) {
        setSideMenuActive(null);
        return;
    }
    const buttons = Array.from(document.querySelectorAll(`[data-screen-link="${screenKey}"]`));
    if (buttons.length) {
        setSideMenuActive(buttons);
    } else {
        setSideMenuActive(null);
    }
}

function hydrateSideMenus() {
    // القائمة الجانبية الآن ثابتة في HTML، لا نحتاج نسخها
    // فقط نحدث المعلومات عند تسجيل الدخول
    updateSideMenuInfo();
}

// دوال لإظهار/إخفاء القائمة الجانبية
function showSideMenu() {
    const sideMenu = document.getElementById('side-menu-container');
    if (sideMenu) {
        sideMenu.classList.remove('hidden');
        sideMenu.style.display = 'block';
    }
}

function hideSideMenu() {
    const sideMenu = document.getElementById('side-menu-container');
    if (sideMenu) {
        sideMenu.classList.add('hidden');
        sideMenu.style.display = 'none';
    }
}

// دالة لإظهار/إخفاء القائمة على الهواتف المحمولة
function toggleSideMenu() {
    const sideMenu = document.getElementById('side-menu-container');
    if (sideMenu) {
        sideMenu.classList.toggle('open');
    }
}

function updateSideMenuInfo() {
    // تحديث اسم الموقع
    const siteNameEl = document.getElementById('site-name');
    if (siteNameEl) {
        siteNameEl.textContent = 'نظام إدارة FTTH';
    }
    
    // تحديث اسم الوكيل
    const agentNameEl = document.getElementById('agent-name');
    if (agentNameEl) {
        agentNameEl.textContent = currentUserAgentName || 'غير محدد';
    }
    
    // تحديث اسم الشركة
    const companyNameEl = document.getElementById('company-name');
    if (companyNameEl) {
        companyNameEl.textContent = currentCompanyName || '';
        if (!currentCompanyName) {
            companyNameEl.style.display = 'none';
        } else {
            companyNameEl.style.display = 'block';
        }
    }
}

// دالة لإظهار الإشعارات (Toast)
function showToast(message, type = 'info') {
    // إنشاء عنصر Toast إذا لم يكن موجوداً
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.className = 'fixed top-4 left-4 z-50 space-y-2';
        document.body.appendChild(toastContainer);
    }
    
    const toast = document.createElement('div');
    const bgColors = {
        success: 'bg-green-500',
        error: 'bg-red-500',
        warning: 'bg-yellow-500',
        info: 'bg-blue-500'
    };
    const iconColors = {
        success: 'text-green-600',
        error: 'text-red-600',
        warning: 'text-yellow-600',
        info: 'text-blue-600'
    };
    
    toast.className = `${bgColors[type] || bgColors.info} text-white px-6 py-4 rounded-lg shadow-lg flex items-center gap-3 min-w-[300px] max-w-md animate-slide-in`;
    toast.innerHTML = `
        <span class="flex-1">${message}</span>
        <button onclick="this.parentElement.remove()" class="text-white/80 hover:text-white">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
        </button>
    `;
    
    toastContainer.appendChild(toast);
    
    // إزالة الإشعار تلقائياً بعد 5 ثوانٍ
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// دوال الشاشات الجديدة
function openSalesScreen() {
    hideAllMainScreens();
    showScreen('dashboard-screen');
    scrollToSection('section-dashboard');
    showToast('قسم المبيعات - قريباً', 'info');
    setSideMenuActiveBySection('section-dashboard');
    currentScreen = 'dashboard';
}

function openWarehouseScreen() {
    hideAllMainScreens();
    showScreen('dashboard-screen');
    scrollToSection('section-dashboard');
    showToast('قسم المخازن - قريباً', 'info');
    // تفعيل زر المخازن في القائمة
    const warehouseBtn = document.querySelector('.side-menu-link-sub[onclick*="openWarehouseScreen"]');
    if (warehouseBtn) {
        setSideMenuActive([warehouseBtn]);
    }
    currentScreen = 'dashboard';
}

function openPurchasesScreen() {
    hideAllMainScreens();
    showScreen('dashboard-screen');
    scrollToSection('section-dashboard');
    showToast('قسم المشتريات - قريباً', 'info');
    // تفعيل زر المشتريات في القائمة
    const purchasesBtn = document.querySelector('.side-menu-link-sub[onclick*="openPurchasesScreen"]');
    if (purchasesBtn) {
        setSideMenuActive([purchasesBtn]);
    }
    currentScreen = 'dashboard';
}

function openFinanceScreen() {
    hideAllMainScreens();
    showScreen('dashboard-screen');
    scrollToSection('section-dashboard');
    showToast('قسم السندات والمالية - قريباً', 'info');
    setSideMenuActiveBySection('section-dashboard');
    currentScreen = 'dashboard';
}

function openReportsScreen() {
    hideAllMainScreens();
    showScreen('dashboard-screen');
    scrollToSection('section-dashboard');
    showToast('قسم التقارير - قريباً', 'info');
    setSideMenuActiveBySection('section-dashboard');
    currentScreen = 'dashboard';
}

function ensurePageDetailScreenVisible() {
    const pageDetailScreen = document.getElementById('page-detail-screen');
    if (!pageDetailScreen) return;
    if (pageDetailScreen.classList.contains('hidden')) {
        hideAllMainScreens();
        showScreen('page-detail-screen');
    }
}

// ================= Subscribers Management =================
async function loadSubscribers(pageNumber = 1, forceSync = false) {
    // التأكد من وجود currentUserId (من تسجيل الدخول)
    if (!currentUserId) {
        console.error('[LOAD SUBSCRIBERS] No currentUserId - user must login first');
        showSubscribersTableMessage('❌ يرجى تسجيل الدخول أولاً');
        subscribersCache = [];
        return;
    }
    
    currentCustomersPage = pageNumber;
    
    // تحميل البيانات مباشرة من API بدون cache
    await loadRemoteSubscribers(pageNumber, ALWATANI_CUSTOMERS_PAGE_SIZE);
}

// دالة جديدة لتحديث البيانات مباشرة من API
async function refreshSubscribers() {
    if (!currentUserId) {
        await loadSubscribers();
        return;
    }
    
    console.log('[REFRESH] Starting refresh from API...');
    
    // تعطيل أزرار التحديث أثناء التحميل
    const refreshButtons = document.querySelectorAll('button[onclick="refreshSubscribers()"]');
    refreshButtons.forEach(btn => {
        btn.disabled = true;
        const originalHTML = btn.innerHTML;
        btn.dataset.originalHTML = originalHTML;
        btn.innerHTML = '<svg class="animate-spin h-4 w-4 inline-block mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>جاري التحديث...';
    });
    
    showSubscribersTableMessage('جاري تحديث البيانات من الموقع الرئيسي...');
    
    try {
        // تحميل البيانات مباشرة من API
        await loadRemoteSubscribers(currentCustomersPage || 1, ALWATANI_CUSTOMERS_PAGE_SIZE);
        
        showSubscribersTableMessage('✅ تم تحديث البيانات بنجاح!');
    } catch (error) {
        console.error('[REFRESH] Error:', error);
        showSubscribersTableMessage('❌ حدث خطأ أثناء التحديث: ' + (error.message || 'خطأ غير معروف'));
    } finally {
        // إعادة تفعيل الأزرار
        refreshButtons.forEach(btn => {
            btn.disabled = false;
            if (btn.dataset.originalHTML) {
                btn.innerHTML = btn.dataset.originalHTML;
                delete btn.dataset.originalHTML;
            }
        });
    }
}

async function loadLocalSubscribers() {
    try {
        const userId = currentUserId; // user_id من تسجيل الدخول
        if (!userId) {
            console.error('[LOAD SUBSCRIBERS] No user_id available');
            subscribersCache = [];
            showSubscribersTableMessage('❌ لم يتم تحديد المستخدم. يرجى تسجيل الدخول مرة أخرى.');
            return;
        }
        
        showSubscribersTableMessage('جاري تحميل بيانات المشتركين ...');
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/subscribers`)), addUsernameToFetchOptions());
        const data = await response.json();
        
        subscribersCache = Array.isArray(data) ? data.map((sub) => ({
            ...sub,
            _meta: buildSubscriberMeta(sub)
        })) : [];
        
        renderSubscriberStatusCards();
        renderExpiringSoonList();
        applySubscriberFilter(activeSubscriberFilter || 'all');
        updateStats();
    } catch (error) {
        console.error('Error loading subscribers:', error);
        subscribersCache = [];
        renderSubscriberStatusCards();
        renderExpiringSoonList();
        currentFilteredSubscribers = [];
        subscriberPagination.currentPage = 0;
        renderSubscribersTablePage();
        updateSubscriberFilterSummary(0);
    }
}

async function loadRemoteSubscribers(pageNumber = 1, pageSize = ALWATANI_CUSTOMERS_PAGE_SIZE) {
    if (!currentUserId) {
        showSubscribersTableMessage('يرجى اختيار حساب الوطني من القائمة.');
        return;
    }

    const userId = currentUserId;
    
    // محاولة جلب البيانات من قاعدة البيانات أولاً (cache)
    try {
        showSubscribersTableMessage('جاري تحميل البيانات من قاعدة البيانات...');
        showSubscribersLoading(true, 'جاري تحميل البيانات...');
        console.log('[LOAD CACHE] Fetching from database cache for userId:', userId, 'page:', pageNumber);
        
        const cacheUrl = `${API_URL}/alwatani-login/${userId}/customers/cache?username=${encodeURIComponent(currentDetailUser || '')}&pageNumber=${pageNumber}&pageSize=${pageSize}`;
        const cacheResponse = await fetch(cacheUrl, addUsernameToFetchOptions());
        const cacheData = await cacheResponse.json();
        
        // إذا كانت البيانات موجودة في cache، تحقق من عددها وتاريخها
        if (cacheData.success && cacheData.customers && Array.isArray(cacheData.customers) && cacheData.customers.length > 0) {
            const totalInCache = cacheData.total || 0;
            const MIN_CACHE_THRESHOLD = 500; // الحد الأدنى للاعتماد على cache
            const MAX_CACHE_AGE_HOURS = 24; // الحد الأقصى لعمر البيانات في cache (ساعة)
            
            // التحقق من عمر البيانات
            let cacheTooOld = false;
            if (cacheData.lastSync) {
                const lastSyncDate = new Date(cacheData.lastSync);
                const now = new Date();
                const hoursSinceSync = (now - lastSyncDate) / (1000 * 60 * 60);
                if (hoursSinceSync > MAX_CACHE_AGE_HOURS) {
                    cacheTooOld = true;
                    console.log(`[LOAD CACHE] Cache data is ${hoursSinceSync.toFixed(1)} hours old (older than ${MAX_CACHE_AGE_HOURS} hours), fetching from API...`);
                }
            }
            
            // إذا كان العدد الإجمالي في cache قليل جداً أو البيانات قديمة، اجلب من API مباشرة
            if (totalInCache < MIN_CACHE_THRESHOLD || cacheTooOld) {
                console.log(`[LOAD CACHE] Cache insufficient (${totalInCache} records${cacheTooOld ? ', data too old' : ''}), fetching from API instead...`);
                showSubscribersTableMessage(`⚠️ البيانات في قاعدة البيانات غير كافية (${totalInCache} سجل فقط)، جاري جلب البيانات من الموقع الرئيسي...`);
                // تجاهل cache والانتقال لجلب من API
                throw new Error('Cache has insufficient or outdated data, fetching from API');
            }
            
            console.log('[LOAD CACHE] Found', cacheData.customers.length, 'subscribers in cache (page', pageNumber, 'of', cacheData.totalPages, ', total:', totalInCache, ')');
            
            subscribersCache = cacheData.customers.map((sub) => {
                const normalized = {
                    id: sub.id || sub.accountId || sub.account_id || null,
                    account_id: sub.account_id || sub.accountId || null,
                    accountId: sub.accountId || sub.account_id || null,
                    username: sub.username || null,
                    deviceName: sub.deviceName || sub.device_name || null,
                    name: sub.name || '--',
                    phone: sub.phone || null,
                    zone: sub.zone || null,
                    page_url: sub.page_url || (sub.accountId || sub.account_id ? `https://admin.ftth.iq/customer-details/${sub.accountId || sub.account_id}/details/view` : '#'),
                    start_date: sub.start_date || sub.startDate || null,
                    startDate: sub.startDate || sub.start_date || null,
                    end_date: sub.end_date || sub.endDate || null,
                    endDate: sub.endDate || sub.end_date || null,
                    status: sub.status || null,
                    raw: sub.raw || {},
                    rawCustomer: sub.rawCustomer || null,
                    rawAddress: sub.rawAddress || null
                };
                return {
                    ...normalized,
                    _meta: buildSubscriberMeta(normalized)
                };
            });
            
            // تحديث العرض بدون إخفاء الجدول
            renderSubscriberStatusCards();
            renderExpiringSoonList();
            applySubscriberFilter(activeSubscriberFilter || 'all', false);
            updateStats();
            
            const total = cacheData.total || subscribersCache.length;
            const totalPages = cacheData.totalPages || Math.ceil(total / pageSize);
            subscriberPagination.currentPage = pageNumber;
            subscriberPagination.totalPages = totalPages;
            updatePaginationControls(total, totalPages);
            
            const lastSync = cacheData.lastSync ? new Date(cacheData.lastSync).toLocaleString('ar-IQ') : 'غير معروف';
            showSubscribersTableMessage(`✅ تم تحميل ${subscribersCache.length} مشترك من قاعدة البيانات (الصفحة ${pageNumber}/${totalPages}) - آخر تحديث: ${lastSync}`);
            showSubscribersLoading(false);
            return;
        }
    } catch (cacheError) {
        console.warn('[LOAD CACHE] Cache load failed, falling back to API:', cacheError);
    }
    
    // إذا لم تكن البيانات في cache، جلب من API
    try {
        showSubscribersTableMessage('جاري تحميل جميع البيانات من الموقع الرئيسي...');
        showSubscribersLoading(true, 'جاري جلب جميع المشتركين من الموقع الرئيسي...');
        console.log('[LOAD API] Fetching ALL pages from Alwatani API for userId:', userId);
        
        // استخدام fetchAll=true لجلب جميع الصفحات
        const apiUrl = `${API_URL}/alwatani-login/${userId}/customers?username=${encodeURIComponent(currentDetailUser || '')}&fetchAll=true&mode=all&pageSize=${pageSize}&maxPages=2000`;
        const response = await fetch(apiUrl, addUsernameToFetchOptions());
        const data = await response.json();
        
        console.log('[LOAD API] Response:', {
            success: data.success,
            hasData: !!data.data,
            combinedLength: data.data?.combined?.length || 0
        });
        
        if (data.success && data.data && data.data.combined && Array.isArray(data.data.combined)) {
            const combinedList = data.data.combined;
            const totalFetched = data.pagination?.total || combinedList.length;
            const pagesFetched = data.pagination?.pagesFetched || 1;
            console.log('[LOAD API] Processing', combinedList.length, 'subscribers (from', pagesFetched, 'pages, total:', totalFetched, ')');
            
            // تحديث التقدم الحقيقي
            updateLoadingProgress(0, combinedList.length);
            showSubscribersLoading(true, `جاري معالجة ${combinedList.length} مشترك...`, 0, combinedList.length);
            
            subscribersCache = combinedList.map((sub, index) => {
                // تحديث التقدم أثناء المعالجة
                if (index % 10 === 0 || index === combinedList.length - 1) {
                    updateLoadingProgress(index + 1, combinedList.length);
                }
                // Normalize data structure from API
                const normalized = {
                    id: sub.id || sub.accountId || sub.account_id || null,
                    account_id: sub.account_id || sub.accountId || null,
                    accountId: sub.accountId || sub.account_id || null,
                    username: sub.username || null,
                    deviceName: sub.deviceName || sub.device_name || null,
                    name: sub.name || '--',
                    phone: sub.phone || null,
                    zone: sub.zone || null,
                    page_url: sub.page_url || (sub.accountId || sub.account_id ? `https://admin.ftth.iq/customer-details/${sub.accountId || sub.account_id}/details/view` : '#'),
                    start_date: sub.start_date || sub.startDate || null,
                    startDate: sub.startDate || sub.start_date || null,
                    end_date: sub.end_date || sub.endDate || null,
                    endDate: sub.endDate || sub.end_date || null,
                    status: sub.status || null,
                    raw: sub.raw || {},
                    rawCustomer: sub.rawCustomer || null,
                    rawAddress: sub.rawAddress || null
                };
                return {
                    ...normalized,
                    _meta: buildSubscriberMeta(normalized)
                };
            });
            
            console.log('[LOAD API] Rendered', subscribersCache.length, 'subscribers');
            
            // تحديث التقدم إلى 100%
            updateLoadingProgress(combinedList.length, combinedList.length);
            
            renderSubscriberStatusCards();
            renderExpiringSoonList();
            // استخدام animation عند عرض الجدول
            applySubscriberFilter(activeSubscriberFilter || 'all', true);
            
            // تحديث الإحصائيات من البيانات
            if (combinedList.length > 0) {
                updateStatsFromSummary(combinedList);
            }
            
            loadWalletBalance(); // تحميل رصيد المحفظة
            
            const total = data.pagination?.total || combinedList.length;
            // استخدام pagesFetched المحدد سابقاً
            showSubscribersTableMessage(`✅ تم تحميل ${combinedList.length} مشترك من الموقع الرئيسي (${pagesFetched} صفحة، إجمالي: ${total})`);
            
            // إخفاء شريط التحميل بعد انتهاء animation (حسب عدد المشتركين في الصفحة الحالية)
            const pageSize = subscriberPagination.pageSize || 10;
            const animateCount = Math.min(pageSize, currentFilteredSubscribers.length);
            setTimeout(() => {
                showSubscribersLoading(false);
            }, (animateCount * 30) + 500); // بعد انتهاء animation
            
            // تحديث pagination - إذا كان fetchAll، نعرض جميع البيانات في صفحة واحدة
            if (data.pagination?.mode === 'all') {
                // جميع البيانات في صفحة واحدة
                subscriberPagination.currentPage = 1;
                subscriberPagination.totalPages = 1;
                updatePaginationControls(total, 1);
            } else {
                const totalPages = Math.ceil(total / pageSize);
                subscriberPagination.currentPage = pageNumber;
                subscriberPagination.totalPages = totalPages;
                updatePaginationControls(total, totalPages);
            }
            
            return;
        } else {
            console.error('[LOAD API] No data in response:', data);
            showSubscribersTableMessage('❌ لم يتم العثور على بيانات. ' + (data.message || ''));
            showSubscribersLoading(false);
            subscribersCache = [];
            renderSubscriberStatusCards();
            renderExpiringSoonList();
            currentFilteredSubscribers = [];
            subscriberPagination.currentPage = 0;
            updatePaginationControls(0, 0);
            updateSubscriberFilterSummary(0);
        }
    } catch (error) {
        console.error('[LOAD API] Error loading from API:', error);
        showSubscribersTableMessage('❌ حدث خطأ أثناء جلب البيانات: ' + (error.message || 'خطأ غير معروف'));
        showSubscribersLoading(false);
        subscribersCache = [];
        renderSubscriberStatusCards();
        renderExpiringSoonList();
        currentFilteredSubscribers = [];
        subscriberPagination.currentPage = 0;
        updatePaginationControls(0, 0);
        updateSubscriberFilterSummary(0);
    }
}

// متغير لتخزين interval مراقبة التقدم
let syncProgressInterval = null;

// دالة لإيقاف مراقبة التقدم
function stopSyncProgressMonitoring() {
    if (syncProgressInterval) {
        clearInterval(syncProgressInterval);
        syncProgressInterval = null;
    }
}

// دالة لإيقاف المزامنة
async function stopSync() {
    if (!currentUserId) {
        alert('لا توجد عملية مزامنة نشطة');
        return;
    }
    
    const userId = currentUserId;
    const stopSyncBtn = document.getElementById('stop-sync-btn');
    const syncButton = document.getElementById('sync-customers-btn');
    
    if (stopSyncBtn) {
        stopSyncBtn.disabled = true;
        stopSyncBtn.innerHTML = '<svg class="animate-spin h-4 w-4 inline-block mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>جاري الإيقاف...';
    }
    
    try {
        const response = await fetch(addUsernameToUrl(`${API_URL}/alwatani-login/${userId}/customers/sync/stop`), addUsernameToFetchOptions({
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        }));
        
        const data = await response.json();
        
        if (data.success) {
            showSubscribersTableMessage('⏹️ تم طلب إيقاف المزامنة. سيتم حفظ البيانات التي تم جلبها.');
            
            // إخفاء زر الإيقاف وإظهار زر المزامنة بعد ثانيتين
            setTimeout(async () => {
                if (stopSyncBtn) {
                    stopSyncBtn.classList.add('hidden');
                    stopSyncBtn.disabled = false;
                    stopSyncBtn.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                        </svg>
                        إيقاف المزامنة
                    `;
                }
                
                if (syncButton) {
                    syncButton.disabled = false;
                    syncButton.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        <span id="sync-btn-text">مزامنة المشتركين</span>
                    `;
                }
                
                // تحديث البيانات بعد الإيقاف
                await loadLocalSubscribers();
            }, 2000);
        } else {
            alert('فشل إيقاف المزامنة: ' + (data.message || 'خطأ غير معروف'));
            if (stopSyncBtn) {
                stopSyncBtn.disabled = false;
            }
        }
    } catch (error) {
        console.error('[STOP SYNC] Error:', error);
        alert('حدث خطأ أثناء محاولة إيقاف المزامنة');
        if (stopSyncBtn) {
            stopSyncBtn.disabled = false;
        }
    }
}

// دالة لمراقبة حالة التقدم
async function monitorSyncProgress(userId) {
    stopSyncProgressMonitoring(); // إيقاف أي مراقبة سابقة
    
    const progressContainer = document.getElementById('sync-progress-container');
    const progressBar = document.getElementById('sync-progress-bar');
    const progressCounter = document.getElementById('sync-progress-counter');
    const progressMessage = document.getElementById('sync-progress-message');
    const progressPhoneFound = document.getElementById('sync-progress-phone-found');
    const progressPercentage = document.getElementById('sync-progress-percentage');
    
    if (!progressContainer) return;
    
    // إظهار حاوية التقدم
    progressContainer.classList.remove('hidden');
    
    // مراقبة التقدم كل ثانية
    syncProgressInterval = setInterval(async () => {
        try {
            const response = await fetch(`${API_URL}/alwatani-login/${userId}/customers/sync-progress`);
            const data = await response.json();
            
            if (data.success && data.progress) {
                const progress = data.progress;
                
                // تحديث العداد
                if (progressCounter) {
                    progressCounter.textContent = `${progress.current || 0} / ${progress.total || 0}`;
                }
                
                // تحديث الرسالة
                if (progressMessage) {
                    progressMessage.textContent = progress.message || 'جاري المزامنة...';
                }
                
                // تحديث شريط التحميل
                if (progressBar) {
                    let percentage = 0;
                    if (progress.total && progress.total > 0) {
                        percentage = Math.round((progress.current / progress.total) * 100);
                    } else if (progress.percentage) {
                        percentage = progress.percentage;
                    }
                    progressBar.style.width = `${percentage}%`;
                    progressBar.setAttribute('aria-valuenow', percentage);
                }
                
                // تحديث النسبة المئوية
                if (progressPercentage) {
                    let percentage = 0;
                    if (progress.total && progress.total > 0) {
                        percentage = Math.round((progress.current / progress.total) * 100);
                    } else if (progress.percentage) {
                        percentage = progress.percentage;
                    }
                    progressPercentage.textContent = `${percentage}%`;
                }
                
                // تحديث عدد أرقام الهواتف
                if (progressPhoneFound) {
                    progressPhoneFound.textContent = `${progress.phoneFound || 0} رقم هاتف تم العثور عليه`;
                }
                
                // إذا اكتملت المزامنة أو حدث خطأ
                if (progress.stage === 'completed' || progress.stage === 'error') {
                    // تحديث شريط التقدم إلى 100% عند اكتمال المزامنة
                    if (progressBar && progress.stage === 'completed') {
                        progressBar.style.width = '100%';
                    }
                    
                    // إبقاء الشريط ظاهراً لمدة 10 ثوانٍ قبل الإخفاء
                    setTimeout(() => {
                        stopSyncProgressMonitoring();
                        if (progressContainer) {
                            progressContainer.classList.add('hidden');
                        }
                    }, 10000);
                }
            } else {
                // لا توجد عملية مزامنة نشطة - لا نخفي الشريط فوراً
                // قد يكون السيرفر مشغول بالتحميل
            }
        } catch (error) {
            console.error('[PROGRESS] Error fetching progress:', error);
        }
    }, 1000); // تحديث كل ثانية
}

async function syncCustomers() {
    if (!currentUserId) {
        alert('يرجى اختيار حساب الوطني من القائمة أولاً.');
        return;
    }

    const userId = currentUserId;
    const syncButton = document.getElementById('sync-customers-btn');
    const stopSyncBtn = document.getElementById('stop-sync-btn');
    const syncStatus = document.getElementById('sync-status');
    
    if (syncButton) {
        syncButton.disabled = true;
        syncButton.innerHTML = '<svg class="animate-spin h-4 w-4 inline-block mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>جاري المزامنة...';
    }
    
    // إظهار زر الإيقاف
    if (stopSyncBtn) {
        stopSyncBtn.classList.remove('hidden');
        stopSyncBtn.disabled = false;
    }
    
    if (syncStatus) {
        syncStatus.textContent = 'جاري المزامنة... قد يستغرق ذلك عدة دقائق حسب عدد المشتركين.';
        syncStatus.className = 'text-sm text-blue-600';
    }
    
    showSubscribersTableMessage('جاري مزامنة المشتركين من الوطني... قد يستغرق ذلك عدة دقائق.');
    
    // بدء مراقبة التقدم
    monitorSyncProgress(userId);

    try {
        // المزامنة الذكية: سيتم جلب المشتركين الناقصين فقط
        const forceFullSync = false; // السماح للمزامنة الذكية بالعمل
        console.log('[SYNC] بدء المزامنة الذكية - سيتم جلب المشتركين الناقصين فقط');
        
        console.log('[SYNC] Starting sync request...');
        const fetchOptions = addUsernameToFetchOptions({
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                forceFullSync: forceFullSync,
                owner_username: currentDetailUser
            })
        });
        const response = await fetch(addUsernameToUrl(`${API_URL}/alwatani-login/${userId}/customers/sync`), fetchOptions);
        
        console.log('[SYNC] Response status:', response.status);
        
        if (!response.ok) {
            const errorText = await response.text();
            let errorData;
            try {
                errorData = JSON.parse(errorText);
            } catch (e) {
                errorData = { message: errorText || `HTTP error! status: ${response.status}` };
            }
            const stageSuffix = errorData?.stage ? ` [${errorData.stage}]` : '';
            throw new Error((errorData.message || `خطأ في الخادم: ${response.status}`) + stageSuffix);
        }
        
        const data = await response.json();
        console.log('[SYNC] Response data:', data);
        console.log('[SYNC] Response status:', response.status);
        console.log('[SYNC] Response success:', data.success);
        
        if (data.success) {
            // إيقاف مراقبة التقدم بعد انتهاء المزامنة
            setTimeout(() => {
                stopSyncProgressMonitoring();
            }, 2000);
            
            const stats = data.stats || {};
            showSubscribersTableMessage(
                `✅ تمت المزامنة بنجاح! تم جلب ${stats.totalFetched || 0} مشترك (${stats.saved || 0} جديد، ${stats.updated || 0} محدث)`
            );
            
            if (syncStatus) {
                syncStatus.textContent = `آخر مزامنة: ${new Date().toLocaleString('ar-IQ')} - ${stats.total || 0} مشترك`;
                syncStatus.className = 'text-sm text-green-600';
            }
            
            // إخفاء زر الإيقاف وإعادة تفعيل زر المزامنة
            const stopSyncBtn = document.getElementById('stop-sync-btn');
            if (stopSyncBtn) {
                stopSyncBtn.classList.add('hidden');
            }
            if (syncButton) {
                syncButton.disabled = false;
                syncButton.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    <span id="sync-btn-text">مزامنة المشتركين</span>
                `;
            }
            
            // Reload subscribers from cache with retry mechanism
            console.log('[SYNC] Reloading subscribers from cache...');
            await loadRemoteSubscribers();
            
            // If no data loaded, retry after a short delay (database might need a moment)
            if (subscribersCache.length === 0) {
                console.log('[SYNC] No data loaded, retrying after 1 second...');
                setTimeout(async () => {
                    await loadRemoteSubscribers();
                    await updateSyncStatus();
                }, 1000);
            } else {
                console.log('[SYNC] Successfully loaded', subscribersCache.length, 'subscribers');
                await updateSyncStatus();
            }
        } else {
            const stageSuffix = data.stage ? ` [${data.stage}]` : '';
            const errorMsg = data.message || 'فشلت المزامنة';
            console.error('[SYNC] Sync failed. Server response:', {
                success: data.success,
                stage: data.stage,
                message: errorMsg,
                fullData: data
            });
            throw new Error(errorMsg + stageSuffix);
        }
    } catch (error) {
        // إيقاف مراقبة التقدم عند حدوث خطأ
        stopSyncProgressMonitoring();
        
        console.error('[SYNC] Error details:', {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        
        let errorMessage = '❌ فشلت المزامنة: ';
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            const serverURL = API_URL.replace('/api', '');
            errorMessage += `تعذر الاتصال بالخادم. تأكد من أن السيرفر يعمل على ${serverURL}`;
        } else if (error.message.includes('تم رفض الوصول (403)')) {
            errorMessage += 'تم رفض الوصول من موقع الوطني. يرجى التحقق من بيانات الدخول وإعادة إضافة الحساب الوطني.';
        } else if (error.message.includes('HTTP error')) {
            errorMessage += error.message;
        } else {
            errorMessage += error.message || 'خطأ غير معروف';
        }
        
        showSubscribersTableMessage(errorMessage);
        
        if (syncStatus) {
            syncStatus.textContent = 'فشلت المزامنة. يرجى المحاولة مرة أخرى.';
            syncStatus.className = 'text-sm text-red-600';
        }
    } finally {
        if (syncButton) {
            syncButton.disabled = false;
            syncButton.innerHTML = 'مزامنة المشتركين';
        }
    }
}

async function fetchAlwataniCustomersPage(userId, pageNumber, pageSize) {
    const params = new URLSearchParams({
        pageNumber: String(pageNumber),
        pageSize: String(pageSize)
    });

    const response = await fetch(`${API_URL}/alwatani-login/${userId}/customers?${params.toString()}`);
    const data = await response.json();

    if (!data.success || !data.data) {
        throw new Error(data.message || 'تعذر جلب بيانات المشتركين من الوطني');
    }

    return {
        combined: Array.isArray(data.data.combined) ? data.data.combined : [],
        summary: data.data.summary || null,
        pagination: data.pagination || {},
        raw: data
    };
}

async function updateStats() {
    try {
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/subscribers/stats`)), addUsernameToFetchOptions());
        const stats = await response.json();
        
        updateStatsFromSummary(stats);
    } catch (error) {
        console.error('Error updating stats:', error);
        updateStatsFromSummary(null);
    }
}

// ================= Wallet Functions =================

let walletTransactionsPage = 1;
const walletTransactionsPageSize = 100; // زيادة حجم الصفحة لجلب المزيد من الحوالات
let allWalletTransactions = []; // تخزين جميع الحوالات
let walletAutoRefreshInterval = null; // للتحديث التلقائي
let isLoadingAllTransactions = false; // لتجنب طلبات متعددة متزامنة

async function loadWalletBalance() {
    if (!currentUserId) {
        console.warn('[WALLET] No currentUserId, skipping wallet balance load');
        return;
    }
    
    const container = document.getElementById('wallet-balance-container');
    if (!container) {
        console.warn('[WALLET] wallet-balance-container not found');
        return;
    }
    
    // عرض حالة التحميل
    container.innerHTML = `
        <div class="text-center text-slate-400 text-sm py-4">
            <div class="flex items-center justify-center gap-2">
                <svg class="animate-spin h-5 w-5 text-[#26466D]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                جاري تحميل بيانات المحفظة...
            </div>
        </div>
    `;
    
    try {
        console.log('[WALLET] Loading balance for userId:', currentUserId);
        const response = await fetch(addUsernameToUrl(`${API_URL}/alwatani-login/${currentUserId}/wallet/balance`), addUsernameToFetchOptions());
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('[WALLET] Balance response:', data);
        
        if (data.success && data.data) {
            // محاولة استخراج الرصيد من عدة مصادر محتملة
            const walletData = data.data;
            let balance = 0;
            
            // البحث في أماكن مختلفة
            if (typeof walletData === 'number') {
                balance = walletData;
            } else if (typeof walletData === 'object' && walletData !== null) {
                balance = walletData.balance || 
                         walletData.availableBalance || 
                         walletData.totalBalance || 
                         walletData.amount ||
                         walletData.available ||
                         walletData.data?.balance ||
                         walletData.data?.availableBalance ||
                         walletData.model?.balance ||
                         walletData.model?.availableBalance ||
                         walletData.wallet?.balance ||
                         walletData.wallet?.availableBalance ||
                         0;
                
                // إذا كان الرصيد عبارة عن string، نحوله إلى رقم
                if (typeof balance === 'string') {
                    balance = parseFloat(balance.replace(/[^\d.-]/g, '')) || 0;
                }
            }
            
            // التحقق من أن الرصيد رقم صالح
            if (isNaN(balance) || balance === null || balance === undefined) {
                balance = 0;
            }
            
            const formattedBalance = new Intl.NumberFormat('ar-IQ', {
                style: 'currency',
                currency: 'IQD',
                minimumFractionDigits: 0
            }).format(balance);
            
            container.innerHTML = `
                <div class="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-6 border border-blue-200">
                    <div class="text-center">
                        <p class="text-sm text-slate-600 mb-2">الرصيد المتاح</p>
                        <p class="text-3xl font-bold text-[#26466D]">${formattedBalance}</p>
                        <button onclick="openWalletScreen()" class="mt-4 px-4 py-2 bg-[#26466D] text-white rounded-lg text-sm font-medium hover:bg-[#1e3a5f] transition-colors">
                            عرض الحوالات
                        </button>
                    </div>
                </div>
            `;
        } else {
            const errorMsg = data.message || 'فشل جلب رصيد المحفظة';
            console.error('[WALLET] Failed to load balance:', {
                message: errorMsg,
                success: data.success,
                statusCode: data.statusCode,
                fullResponse: data
            });
            
            // عرض رسالة خطأ واضحة
            let displayMsg = 'غير متوفر';
            if (errorMsg && errorMsg.includes('403')) {
                displayMsg = 'تم رفض الوصول - يرجى التحقق من الحساب';
            } else if (errorMsg && errorMsg.includes('404')) {
                displayMsg = 'المحفظة غير موجودة';
            } else if (errorMsg && !errorMsg.includes('فشل')) {
                displayMsg = errorMsg;
            }
            
            container.innerHTML = `
                <div class="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-6 border border-blue-200">
                    <div class="text-center">
                        <p class="text-sm text-slate-600 mb-2">الرصيد المتاح</p>
                        <p class="text-lg text-slate-400 mb-4">${displayMsg}</p>
                        <button onclick="openWalletScreen()" class="px-4 py-2 bg-[#26466D] text-white rounded-lg text-sm font-medium hover:bg-[#1e3a5f] transition-colors">
                            عرض الحوالات
                        </button>
                    </div>
                </div>
            `;
        }
    } catch (error) {
        console.error('[WALLET] Error loading balance:', error);
        container.innerHTML = `
            <div class="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-6 border border-blue-200">
                <div class="text-center">
                    <p class="text-sm text-slate-600 mb-2">الرصيد المتاح</p>
                    <p class="text-lg text-slate-400 mb-4">غير متوفر</p>
                    <button onclick="openWalletScreen()" class="px-4 py-2 bg-[#26466D] text-white rounded-lg text-sm font-medium hover:bg-[#1e3a5f] transition-colors">
                        عرض الحوالات
                    </button>
                </div>
            </div>
        `;
    }
}

async function loadWalletData() {
    if (!currentUserId) return;
    
    await Promise.all([
        loadWalletBalanceInScreen(),
        loadWalletTransactions()
    ]);
}

async function loadWalletBalanceInScreen() {
    if (!currentUserId) return;
    
    const display = document.getElementById('wallet-balance-display');
    if (!display) return;
    
    try {
        const response = await fetch(addUsernameToUrl(`${API_URL}/alwatani-login/${currentUserId}/wallet/balance`), addUsernameToFetchOptions());
        const data = await response.json();
        
        if (data.success && data.data) {
            const balance = data.data.balance || data.data.availableBalance || data.data.totalBalance || 0;
            const formattedBalance = new Intl.NumberFormat('ar-IQ', {
                style: 'currency',
                currency: 'IQD',
                minimumFractionDigits: 0
            }).format(balance);
            
            display.innerHTML = `
                <div class="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-8 border border-blue-200">
                    <div class="text-center">
                        <p class="text-sm text-slate-600 mb-3">الرصيد المتاح</p>
                        <p class="text-4xl font-bold text-[#26466D]">${formattedBalance}</p>
                    </div>
                </div>
            `;
        } else {
            display.innerHTML = `<div class="text-center text-red-500 text-sm py-4">${data.message || 'فشل جلب رصيد المحفظة'}</div>`;
        }
    } catch (error) {
        console.error('[WALLET] Error loading balance in screen:', error);
        display.innerHTML = `<div class="text-center text-red-500 text-sm py-4">خطأ في جلب رصيد المحفظة</div>`;
    }
}

async function loadWalletTransactions(loadAll = true) {
    if (!currentUserId) return;
    
    if (isLoadingAllTransactions) {
        console.log('[WALLET] Already loading transactions, skipping...');
        return;
    }
    
    const container = document.getElementById('wallet-transactions-container');
    const summaryEl = document.getElementById('wallet-transactions-summary');
    if (!container) return;
    
    // عرض حالة التحميل
    if (loadAll) {
        container.innerHTML = `
            <div class="text-center text-slate-400 text-sm py-4">
                <div class="flex items-center justify-center gap-2">
                    <svg class="animate-spin h-5 w-5 text-[#26466D]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    جاري تحميل جميع الحوالات...
                </div>
            </div>
        `;
        if (summaryEl) summaryEl.textContent = 'جاري التحميل...';
    }
    
    isLoadingAllTransactions = true;
    
    try {
        if (loadAll) {
            // جلب جميع الحوالات من جميع الصفحات
            await loadAllWalletTransactions();
        } else {
            // جلب صفحة واحدة فقط
            const response = await fetch(addUsernameToUrl(`${API_URL}/alwatani-login/${currentUserId}/wallet/transactions?pageSize=${walletTransactionsPageSize}&pageNumber=${walletTransactionsPage}`), addUsernameToFetchOptions());
            const data = await response.json();
            
            if (data.success && data.data) {
                const transactions = normalizeAlwataniCollection(data.data);
                allWalletTransactions = transactions;
                const totalCount = data.data.totalCount || transactions.length;
                renderWalletTransactions(allWalletTransactions, totalCount);
                if (summaryEl) summaryEl.textContent = `عرض ${allWalletTransactions.length} من ${totalCount} حوالة`;
            } else {
                container.innerHTML = `<div class="text-center text-red-500 text-sm py-4">${data.message || 'فشل جلب الحوالات'}</div>`;
            }
        }
    } catch (error) {
        console.error('[WALLET] Error loading transactions:', error);
        container.innerHTML = `<div class="text-center text-red-500 text-sm py-4">خطأ في جلب الحوالات: ${error.message}</div>`;
        if (summaryEl) summaryEl.textContent = 'خطأ في التحميل';
    } finally {
        isLoadingAllTransactions = false;
    }
}

async function loadAllWalletTransactions() {
    if (!currentUserId) return;
    
    const container = document.getElementById('wallet-transactions-container');
    const summaryEl = document.getElementById('wallet-transactions-summary');
    
    // محاولة جلب الحوالات من قاعدة البيانات أولاً
    try {
        const dbResponse = await fetch(addUsernameToUrl(`${API_URL}/alwatani-login/${currentUserId}/wallet/transactions/db?limit=10000`), addUsernameToFetchOptions());
        const dbData = await dbResponse.json();
        
        if (dbData.success && dbData.data && dbData.data.items && dbData.data.items.length > 0) {
            allWalletTransactions = dbData.data.items;
            const totalCount = dbData.data.totalCount || allWalletTransactions.length;
            
            console.log(`[WALLET] Loaded ${allWalletTransactions.length} transactions from database`);
            
            // عرض الحوالات من قاعدة البيانات
            renderWalletTransactions(allWalletTransactions, totalCount);
            
            if (summaryEl) {
                summaryEl.textContent = `عرض ${allWalletTransactions.length} حوالة من قاعدة البيانات (آخر تحديث: ${new Date().toLocaleTimeString('ar-IQ')})`;
            }
            
            // محاولة المزامنة في الخلفية لتحديث البيانات
            syncWalletTransactionsInBackground();
            
            return; // نجحنا في جلب البيانات من قاعدة البيانات
        }
    } catch (error) {
        console.warn('[WALLET] Could not load from database, falling back to API:', error);
    }
    
    // Fallback: جلب من API الوطني
    console.log('[WALLET] Loading transactions from API...');
    allWalletTransactions = [];
    let pageNumber = 1;
    let totalCount = 0;
    let hasMore = true;
    
    while (hasMore) {
        try {
            const response = await fetch(addUsernameToUrl(`${API_URL}/alwatani-login/${currentUserId}/wallet/transactions?pageSize=${walletTransactionsPageSize}&pageNumber=${pageNumber}`), addUsernameToFetchOptions());
            const data = await response.json();
            
            if (!data.success || !data.data) {
                console.error('[WALLET] Failed to load page', pageNumber, data.message);
                break;
            }
            
            const transactions = normalizeAlwataniCollection(data.data);
            totalCount = data.data.totalCount || totalCount || transactions.length;
            
            if (transactions.length === 0) {
                hasMore = false;
                break;
            }
            
            allWalletTransactions = allWalletTransactions.concat(transactions);
            
            // تحديث التقدم
            if (summaryEl) {
                summaryEl.textContent = `جاري تحميل الحوالات... ${allWalletTransactions.length} من ${totalCount}`;
            }
            
            // إذا لم نصل للعدد الإجمالي بعد، نكمل
            if (allWalletTransactions.length >= totalCount || transactions.length < walletTransactionsPageSize) {
                hasMore = false;
            } else {
                pageNumber++;
                // تأخير قصير بين الصفحات لتجنب rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (error) {
            console.error(`[WALLET] Error loading page ${pageNumber}:`, error);
            hasMore = false;
        }
    }
    
    console.log(`[WALLET] Loaded ${allWalletTransactions.length} transactions from ${pageNumber} pages`);
    
    // عرض جميع الحوالات
    renderWalletTransactions(allWalletTransactions, totalCount);
    
    if (summaryEl) {
        summaryEl.textContent = `عرض ${allWalletTransactions.length} حوالة (آخر تحديث: ${new Date().toLocaleTimeString('ar-IQ')})`;
    }
}

// مزامنة الحوالات في الخلفية (بدون انتظار)
async function syncWalletTransactionsInBackground() {
    if (!currentUserId) return;
    
    try {
        console.log('[WALLET] Starting background sync...');
        const response = await fetch(addUsernameToUrl(`${API_URL}/alwatani-login/${currentUserId}/wallet/transactions/sync?maxPages=100`), addUsernameToFetchOptions({
            method: 'POST'
        }));
        const data = await response.json();
        
        if (data.success) {
            console.log(`[WALLET] ✅ Background sync completed: ${data.synced} transactions synced`);
            // تحديث الحوالات بعد المزامنة
            setTimeout(() => {
                loadAllWalletTransactions();
            }, 1000);
        } else {
            console.warn('[WALLET] Background sync failed:', data.message);
        }
    } catch (error) {
        console.error('[WALLET] Error in background sync:', error);
        // لا نعرض خطأ للمستخدم، هذا تحديث خلفي
    }
}

function renderWalletTransactions(transactions, totalCount) {
    const container = document.getElementById('wallet-transactions-container');
    if (!container) return;
    
    if (!transactions || transactions.length === 0) {
        container.innerHTML = '<div class="text-center text-slate-400 text-sm py-8">لا توجد حوالات</div>';
        return;
    }
    
    const transactionsHtml = transactions.map((transaction, index) => {
        // البحث عن المبلغ في أماكن مختلفة
        let amount = 0;
        if (typeof transaction === 'number') {
            amount = transaction;
        } else if (transaction && typeof transaction === 'object') {
            // البحث في أماكن مختلفة - المبلغ موجود في transactionAmount.value
            if (transaction.transactionAmount && typeof transaction.transactionAmount === 'object') {
                amount = transaction.transactionAmount.value || 
                        transaction.transactionAmount.amount ||
                        transaction.transactionAmount.totalAmount ||
                        0;
            } else {
                // البحث في أماكن أخرى كـ fallback
                amount = transaction.amount || 
                        transaction.totalAmount || 
                        transaction.transactionValue ||
                        transaction.value ||
                        transaction.transactionAmount ||
                        transaction.balanceChange ||
                        transaction.debit ||
                        transaction.credit ||
                        transaction.amountChange ||
                        transaction.amountAfter ||
                        transaction.balance ||
                        transaction.availableBalance ||
                        transaction.planPrice || // سعر الخطة كـ fallback
                        transaction.data?.amount ||
                        transaction.model?.amount ||
                        transaction.wallet?.amount ||
                        0;
            }
            
            // إذا كان المبلغ string، نحوله إلى رقم
            if (typeof amount === 'string') {
                amount = parseFloat(amount.replace(/[^\d.-]/g, '')) || 0;
            }
        }
        
        // التحقق من أن المبلغ رقم صالح
        if (isNaN(amount) || amount === null || amount === undefined) {
            amount = 0;
        }
        
        const isDebit = amount < 0;
        const formattedAmount = new Intl.NumberFormat('ar-IQ', {
            style: 'currency',
            currency: 'IQD',
            minimumFractionDigits: 0
        }).format(Math.abs(amount));
        
        // استخراج التاريخ - قد يكون في occuredAt أو occurredAt
        const date = transaction.occuredAt || 
                    transaction.occurredAt || 
                    transaction.createdAt || 
                    transaction.date || 
                    transaction.timestamp ||
                    transaction.transactionDate ||
                    '';
        const formattedDate = date ? new Date(date).toLocaleString('ar-IQ') : 'غير معروف';
        
        // استخراج الوصف - البحث في جميع الحقول المحتملة
        // من الـ response، نوع الحوالة موجود في transaction.type مباشرة
        let description = transaction.type || 
                         transaction.transactionType ||
                         transaction.description || 
                         transaction.note || 
                         transaction.reason ||
                         transaction.purpose ||
                         transaction.action ||
                         transaction.operation ||
                         '';
        
        // إذا كان الوصف من changeType
        if (!description && transaction.changeType) {
            description = transaction.changeType.transactionType ||
                         transaction.changeType.type ||
                         transaction.changeType.displayValue || 
                         transaction.changeType.description || '';
        }
        
        // إذا كان الوصف من salesType
        if (!description && transaction.salesType) {
            description = transaction.salesType.transactionType ||
                         transaction.salesType.type ||
                         transaction.salesType.displayValue || 
                         transaction.salesType.description || '';
        }
        
        // إذا لم نجد وصف، نستخدم نوع المحفظة
        if (!description && transaction.walletType) {
            description = transaction.walletType.displayValue || transaction.walletType.description || '';
        }
        
        // البحث في walletTransferDetails
        if (!description && transaction.walletTransferDetails) {
            description = transaction.walletTransferDetails.transactionType ||
                         transaction.walletTransferDetails.type ||
                         transaction.walletTransferDetails.description || '';
        }
        
        // إضافة معلومات إضافية للوصف (نوع الباقة)
        let additionalInfo = '';
        if (transaction.subscription && transaction.subscription.displayValue) {
            additionalInfo = ` - ${transaction.subscription.displayValue}`;
        }
        
        // ترجمة أنواع الحوالات الشائعة
        if (description) {
            const typeTranslations = {
                'PLAN_PURCHASE': 'شراء باقة',
                'PLAN_RENEW': 'تجديد باقة',
                'PLAN_UPGRADE': 'ترقية باقة',
                'PLAN_DOWNGRADE': 'تخفيض باقة',
                'PLAN_CANCEL': 'إلغاء باقة',
                'PLAN_SUSPEND': 'تعليق باقة',
                'DEPOSIT': 'إيداع',
                'WITHDRAWAL': 'سحب',
                'REFUND': 'استرداد',
                'TRANSFER': 'تحويل',
                'PAYMENT': 'دفع',
                'CHARGE': 'شحن',
                'Upfront': 'دفع مقدماً',
                'Main': 'رئيسي',
                'PURCHASE': 'شراء',
                'RENEW': 'تجديد',
                'UPGRADE': 'ترقية',
                'DOWNGRADE': 'تخفيض'
            };
            
            // البحث عن الترجمة (case-insensitive)
            const descriptionUpper = description.toUpperCase().trim();
            const translation = typeTranslations[description] || typeTranslations[descriptionUpper];
            
            if (translation) {
                description = translation;
            } else if (descriptionUpper.includes('PLAN_')) {
                // إذا كان نوع غير معروف لكن يحتوي على PLAN_
                const planType = descriptionUpper.replace('PLAN_', '').toLowerCase();
                const planTranslations = {
                    'PURCHASE': 'شراء باقة',
                    'RENEW': 'تجديد باقة',
                    'UPGRADE': 'ترقية باقة',
                    'DOWNGRADE': 'تخفيض باقة'
                };
                description = planTranslations[planType] || planType + ' باقة';
            } else if (descriptionUpper.includes('_')) {
                // معالجة الأنواع الأخرى التي تحتوي على underscore
                description = description.replace(/_/g, ' ').toLowerCase();
            }
        }
        
        // إذا لم نجد وصف نهائياً
        if (!description) {
            description = 'حوالة';
        }
        
        // معلومات إضافية (اسم المشترك أو اسم الجهاز)
        let extraInfo = '';
        if (transaction.customer && transaction.customer.displayValue) {
            extraInfo = transaction.customer.displayValue;
        } else if (transaction.deviceUsername) {
            extraInfo = transaction.deviceUsername;
        }
        
        return `
            <div class="border-b border-slate-100 p-4 hover:bg-slate-50 transition-colors">
                <div class="flex items-center justify-between">
                    <div class="flex-1">
                        <p class="text-sm font-medium text-slate-800">${description}${additionalInfo}</p>
                        ${extraInfo ? `<p class="text-xs text-slate-400 mt-0.5">${extraInfo}</p>` : ''}
                        <p class="text-xs text-slate-500 mt-1">${formattedDate}</p>
                    </div>
                    <div class="text-left ml-4">
                        <p class="text-sm font-bold ${isDebit ? 'text-red-600' : 'text-green-600'}">
                            ${isDebit ? '-' : '+'}${formattedAmount}
                        </p>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    container.innerHTML = `
        <div class="border border-slate-200 rounded-lg overflow-hidden">
            ${transactionsHtml}
        </div>
    `;
}

async function refreshWalletTransactions() {
    walletTransactionsPage = 1;
    await loadWalletTransactions(true); // جلب جميع الحوالات
}

async function syncWalletTransactions() {
    if (!currentUserId) {
        alert('يرجى اختيار حساب الوطني أولاً');
        return;
    }
    
    const summaryEl = document.getElementById('wallet-transactions-summary');
    if (summaryEl) {
        summaryEl.textContent = 'جاري المزامنة مع الموقع الوطني...';
    }
    
    try {
        const response = await fetch(addUsernameToUrl(`${API_URL}/alwatani-login/${currentUserId}/wallet/transactions/sync?maxPages=100`), addUsernameToFetchOptions({
            method: 'POST'
        }));
        const data = await response.json();
        
        if (data.success) {
            console.log(`[WALLET] ✅ Sync completed: ${data.synced} transactions synced`);
            if (summaryEl) {
                summaryEl.textContent = `✅ تمت المزامنة: ${data.synced} حوالة`;
            }
            
            // تحديث الحوالات بعد المزامنة
            setTimeout(() => {
                loadAllWalletTransactions();
            }, 500);
        } else {
            alert(`❌ فشلت المزامنة: ${data.message || 'خطأ غير معروف'}`);
            if (summaryEl) {
                summaryEl.textContent = 'فشلت المزامنة';
            }
        }
    } catch (error) {
        console.error('[WALLET] Error syncing transactions:', error);
        alert(`❌ خطأ في المزامنة: ${error.message}`);
        if (summaryEl) {
            summaryEl.textContent = 'خطأ في المزامنة';
        }
    }
}

function toggleWalletAutoRefresh(enabled) {
    // إيقاف أي interval موجود
    if (walletAutoRefreshInterval) {
        clearInterval(walletAutoRefreshInterval);
        walletAutoRefreshInterval = null;
    }
    
    if (enabled) {
        console.log('[WALLET] Auto-refresh enabled - refreshing every 30 seconds');
        // تحديث كل 30 ثانية (الرصيد والحوالات)
        walletAutoRefreshInterval = setInterval(async () => {
            console.log('[WALLET] Auto-refreshing wallet data...');
            await Promise.all([
                loadWalletBalanceInScreen(),
                loadWalletTransactions(true)
            ]);
            // مزامنة في الخلفية كل دقيقة (أي مرتين لكل refresh cycle)
            syncWalletTransactionsInBackground();
        }, 30000); // 30 ثانية
        
        // تحديث فوري عند التفعيل
        loadWalletData();
        // بدء المزامنة في الخلفية
        setTimeout(() => syncWalletTransactionsInBackground(), 2000);
    } else {
        console.log('[WALLET] Auto-refresh disabled');
    }
}

function normalizeAlwataniCollection(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.models)) return payload.models;
    return [];
}

// ================= Subscribers Dashboard Helpers =================
function buildSubscriberMeta(subscriber) {
    const tags = new Set(['all']);
    const statusValue = (subscriber.status || '').toLowerCase();
    if (statusValue) {
        tags.add(statusValue);
        if (statusValue.includes('active')) {
            tags.add('active');
            tags.add('connected');
        }
        if (['connected', 'online'].includes(statusValue)) {
            tags.add('connected');
        }
        if (['inactive', 'disconnected', 'offline', 'suspended'].includes(statusValue)) {
            tags.add('disconnected');
        }
        if (['trial', 'test', 'demo', 'pilot'].includes(statusValue)) {
            tags.add('trial');
        }
    }
    
    const meta = {
        tags,
        statusKey: statusValue || 'other',
        daysLeft: null,
        isExpired: false,
        isExpiringSoon: false
    };
    
    const endDateValue = subscriber.end_date || subscriber.endDate;
    if (endDateValue) {
        const endDate = new Date(endDateValue);
        if (!Number.isNaN(endDate.getTime())) {
            const diffDays = Math.ceil((endDate - new Date()) / (1000 * 60 * 60 * 24));
            meta.daysLeft = diffDays;
            if (diffDays < 0) {
                tags.add('expired');
                meta.isExpired = true;
            }
            if (diffDays >= 0 && diffDays <= 7) {
                tags.add('expiring');
                meta.isExpiringSoon = true;
            }
        }
    }
    
    if (meta.isExpired) {
        meta.statusKey = 'expired';
    } else if (meta.isExpiringSoon) {
        meta.statusKey = 'expiring';
    } else if (tags.has('trial')) {
        meta.statusKey = 'trial';
    } else if (tags.has('disconnected')) {
        meta.statusKey = 'disconnected';
    } else if (tags.has('active') || tags.has('connected')) {
        meta.statusKey = 'active';
    } else if (!statusValue) {
        meta.statusKey = 'other';
    }
    
    return meta;
}

function matchSubscriberFilter(meta, filterKey) {
    if (!meta) return false;
    if (!filterKey || filterKey === 'all') return true;
    if (filterKey === 'active') return meta.tags.has('active') || meta.tags.has('connected');
    if (filterKey === 'disconnected') return meta.tags.has('disconnected');
    if (filterKey === 'trial') return meta.tags.has('trial');
    if (filterKey === 'expired') return meta.tags.has('expired');
    if (filterKey === 'expiring') return meta.tags.has('expiring');
    return meta.tags.has(filterKey);
}

function renderSubscriberStatusCards() {
    const grid = document.getElementById('subscriber-status-grid');
    if (!grid) return;
    
    const counts = {};
    subscriberStatusConfig.forEach((cfg) => { counts[cfg.key] = 0; });
    const total = subscribersCache.length;
    
    subscribersCache.forEach((sub) => {
        const meta = sub._meta || buildSubscriberMeta(sub);
        sub._meta = meta;
        subscriberStatusConfig.forEach((cfg) => {
            if (cfg.match(meta)) {
                counts[cfg.key] = (counts[cfg.key] || 0) + 1;
            }
        });
    });
    
    grid.innerHTML = '';
    
    subscriberStatusConfig.forEach((cfg) => {
        const value = counts[cfg.key] || 0;
        const percent = total === 0 ? 0 : Math.round((value / total) * 100);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'status-card';
        card.setAttribute('data-status-card', cfg.key);
        card.innerHTML = `
            <div class="flex items-start justify-between gap-4">
                <div>
                    <p class="text-xs text-slate-500 mb-1">${cfg.label}</p>
                    <h4 class="text-2xl font-bold text-slate-800">${value}</h4>
                    <span class="text-[11px] text-slate-400">${cfg.description}</span>
                </div>
                <div class="status-progress" style="--ring-color:${cfg.ringColor}; --ring-progress:${Math.min(percent, 100) * 3.6}deg;">
                    <span>${percent}%</span>
                </div>
            </div>
        `;
        card.addEventListener('click', () => applySubscriberFilter(cfg.key));
        grid.appendChild(card);
    });
    
    setActiveStatusCardUI();
}

function normalizeAlwataniCustomer(item, index) {
    const rawCustomer = item?.rawCustomer || item?.customer || item;
    const rawAddress = item?.rawAddress || item?.address || null;
    const accountId = item?.accountId ||
        rawCustomer?.accountId ||
        rawCustomer?.AccountId ||
        rawCustomer?.customerAccountId ||
        rawCustomer?.self?.accountId ||
        rawCustomer?.self?.id ||
        rawCustomer?.id ||
        null;
    const subscriptions = Array.isArray(rawCustomer?.subscriptions) ? rawCustomer.subscriptions : [];
    const primarySubscription = subscriptions.length ? subscriptions[0] : null;

    return {
        id: accountId || `alw-${index + 1}`,
        account_id: accountId,
        username: item?.username ||
            rawCustomer?.username ||
            rawCustomer?.userName ||
            rawCustomer?.self?.userName ||
            item?.deviceName ||
            rawCustomer?.deviceName ||
            rawCustomer?.device ||
            primarySubscription?.username ||
            primarySubscription?.deviceName ||
            primarySubscription?.device ||
            null,
        deviceName: item?.deviceName ||
            rawCustomer?.deviceName ||
            rawCustomer?.device ||
            primarySubscription?.username ||
            primarySubscription?.deviceName ||
            primarySubscription?.device ||
            null,
        name: item?.name ||
            rawCustomer?.self?.displayValue ||
            rawCustomer?.displayValue ||
            rawCustomer?.customerName ||
            '--',
        phone: item?.phone ||
            rawCustomer?.phoneNumber ||
            rawCustomer?.customerPhone ||
            rawCustomer?.contactPhone ||
            rawAddress?.phoneNumber ||
            rawAddress?.primaryPhone ||
            '--',
        zone: item?.zone ||
            rawCustomer?.zone?.displayValue ||
            rawCustomer?.zone ||
            rawAddress?.zoneDisplayValue ||
            rawAddress?.zone ||
            '--',
        page_url: accountId ? `https://admin.ftth.iq/customer-details/${accountId}/details/view` : '#',
        start_date: item?.startDate ||
            rawCustomer?.startDate ||
            rawCustomer?.contractStart ||
            primarySubscription?.startsAt ||
            null,
        end_date: item?.endDate ||
            rawCustomer?.endDate ||
            rawCustomer?.contractEnd ||
            rawCustomer?.expires ||
            primarySubscription?.endsAt ||
            null,
        status: item?.status ||
            rawCustomer?.status ||
            rawCustomer?.subscriptionStatus ||
            'غير مصنف',
        raw: {
            customer: rawCustomer,
            address: rawAddress
        }
    };
}

function showSubscribersTableMessage(message) {
        const tbody = document.getElementById('subscribers-table-body');
    if (!tbody) return;
    tbody.innerHTML = `
        <tr>
            <td colspan="11" class="p-8 text-center text-gray-400">${message}</td>
        </tr>
    `;
}

function updateStatsFromSummary(summary) {
    const fallback = computeSubscriberStatsFromCache();
    const totals = {
        total: summary?.total ??
            summary?.totalCount ??
            summary?.customers?.totalCount ??
            fallback.total,
        active: summary?.active ??
            summary?.totalActive ??
            summary?.customers?.totalActive ??
            fallback.active,
        zones: summary?.zones ??
            summary?.zonesCount ??
            fallback.zones,
        expiringSoon: summary?.expiringSoon ??
            summary?.totalExpiring ??
            summary?.customers?.totalExpiring ??
            fallback.expiringSoon
    };

    setText('total-subscribers', totals.total || 0);
    setText('active-subscribers', totals.active || 0);
    setText('zones-count', totals.zones || 0);
    setText('expiring-soon', totals.expiringSoon || 0);
}

function computeSubscriberStatsFromCache() {
    const stats = {
        total: subscribersCache.length,
        active: 0,
        zones: 0,
        expiringSoon: 0
    };

    const zonesSet = new Set();
    subscribersCache.forEach((sub) => {
        const meta = sub._meta || buildSubscriberMeta(sub);
        sub._meta = meta;
        if (meta.tags.has('active') || meta.tags.has('connected')) {
            stats.active += 1;
        }
        if (meta.tags.has('expiring')) {
            stats.expiringSoon += 1;
        }
        if (sub.zone) {
            zonesSet.add(sub.zone);
        }
    });

    stats.zones = zonesSet.size;
    return stats;
}

function setActiveStatusCardUI() {
    const cards = document.querySelectorAll('[data-status-card]');
    cards.forEach((card) => {
        const key = card.getAttribute('data-status-card');
        if (key === activeSubscriberFilter) {
            card.classList.add('active');
        } else {
            card.classList.remove('active');
        }
    });
}

function applySubscriberFilter(filterKey = 'all') {
    activeSubscriberFilter = filterKey || 'all';
    currentFilteredSubscribers = subscribersCache.filter((sub) => {
        const meta = sub._meta || buildSubscriberMeta(sub);
        sub._meta = meta;
        return matchSubscriberFilter(meta, activeSubscriberFilter);
    });
    subscriberPagination.currentPage = 1;
    renderSubscribersTablePage();
    updateSubscriberFilterSummary(currentFilteredSubscribers.length);
    setActiveStatusCardUI();
}

function renderSubscribersTable(list, offset = 0, animate = true) {
    const tbody = document.getElementById('subscribers-table-body');
    if (!tbody) {
        console.error('[RENDER TABLE] Table body not found!');
        return;
    }
    
    console.log('[RENDER TABLE] Rendering', list?.length || 0, 'subscribers');
    
    tbody.innerHTML = '';
        
    if (!list || list.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="11" class="p-8 text-center text-gray-400">
                    <div class="flex flex-col items-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
                        <p>لا توجد بيانات</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }
    
    if (animate && list.length > 0) {
        // عرض المشتركين واحد تلو الآخر مع animation
        let currentIndex = 0;
        const animateNext = () => {
            if (currentIndex >= list.length) {
                console.log('[RENDER TABLE] Successfully rendered', list.length, 'rows in table with animation');
                return;
            }
            
            const sub = list[currentIndex];
            const meta = sub._meta || buildSubscriberMeta(sub);
            sub._meta = meta;
            
            const row = document.createElement('tr');
            row.className = 'hover:bg-gray-50 transition-all duration-300 opacity-0 transform translate-y-2';
            row.dataset.status = meta.statusKey || '';
            row.dataset.tags = Array.from(meta.tags || []).join(',');
            row.innerHTML = `
                <td class="p-4 font-mono text-gray-400">${offset + currentIndex + 1}</td>
                <td class="p-4 font-medium text-gray-800">${sub.name || '--'}</td>
                <td class="p-4 text-gray-600 font-mono" dir="ltr">${sub.account_id || sub.accountId || '--'}</td>
                <td class="p-4 text-gray-600 font-mono" dir="ltr">${sub.deviceName || sub.username || '--'}</td>
                <td class="p-4 text-gray-600 font-mono" dir="ltr">${sub.phone || '--'}</td>
                <td class="p-4 text-gray-600">${sub.zone || '--'}</td>
                <td class="p-4"><a href="${sub.page_url || '#'}" target="_blank" class="text-blue-600 hover:underline text-xs">عرض الصفحة</a></td>
                <td class="p-4 text-gray-600">${formatDate(sub.start_date || sub.startDate)}</td>
                <td class="p-4 text-gray-600">${formatDate(sub.end_date || sub.endDate)}</td>
                <td class="p-4">
                    <span class="px-2 py-1 rounded-full text-xs font-bold ${getStatusBadgeClass(meta.statusKey)}">${getStatusLabel(meta.statusKey)}</span>
                </td>
                <td class="p-4 text-center">
                    <button class="text-gray-400 hover:text-[#26466D]">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" /></svg>
                    </button>
                </td>
            `;
            tbody.appendChild(row);
            
            // Animation: fade in + slide up
            setTimeout(() => {
                row.classList.remove('opacity-0', 'translate-y-2');
                row.classList.add('opacity-100', 'translate-y-0');
            }, 10);
            
            // تحديث العداد
            updateLoadingProgress(currentIndex + 1, list.length);
            
            currentIndex++;
            setTimeout(animateNext, 30); // 30ms بين كل مشترك (سريع وجميل)
        };
        
        animateNext();
    } else {
        // عرض بدون animation (للحالات العادية)
        list.forEach((sub, index) => {
            const meta = sub._meta || buildSubscriberMeta(sub);
            sub._meta = meta;
            const row = document.createElement('tr');
            row.className = 'hover:bg-gray-50 transition-colors';
            row.dataset.status = meta.statusKey || '';
            row.dataset.tags = Array.from(meta.tags || []).join(',');
            row.innerHTML = `
                <td class="p-4 font-mono text-gray-400">${offset + index + 1}</td>
                <td class="p-4 font-medium text-gray-800">${sub.name || '--'}</td>
                <td class="p-4 text-gray-600 font-mono" dir="ltr">${sub.account_id || sub.accountId || '--'}</td>
                <td class="p-4 text-gray-600 font-mono" dir="ltr">${sub.deviceName || sub.username || '--'}</td>
                <td class="p-4 text-gray-600 font-mono" dir="ltr">${sub.phone || '--'}</td>
                <td class="p-4 text-gray-600">${sub.zone || '--'}</td>
                <td class="p-4"><a href="${sub.page_url || '#'}" target="_blank" class="text-blue-600 hover:underline text-xs">عرض الصفحة</a></td>
                <td class="p-4 text-gray-600">${formatDate(sub.start_date || sub.startDate)}</td>
                <td class="p-4 text-gray-600">${formatDate(sub.end_date || sub.endDate)}</td>
                <td class="p-4">
                    <span class="px-2 py-1 rounded-full text-xs font-bold ${getStatusBadgeClass(meta.statusKey)}">${getStatusLabel(meta.statusKey)}</span>
                </td>
                <td class="p-4 text-center">
                    <button class="text-gray-400 hover:text-[#26466D]">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" /></svg>
                    </button>
                </td>
            `;
            tbody.appendChild(row);
        });
        console.log('[RENDER TABLE] Successfully rendered', list.length, 'rows in table');
    }
}

function getStatusLabel(key) {
    switch (key) {
        case 'active':
        case 'connected':
            return 'نشط';
        case 'disconnected':
        case 'inactive':
            return 'غير متصل';
        case 'trial':
            return 'تجريبي';
        case 'expired':
            return 'منتهي';
        case 'expiring':
            return 'قريب الانتهاء';
        default:
            return 'غير مصنف';
    }
}

function getStatusBadgeClass(key) {
    return subscriberStatusBadgeClasses[key] || subscriberStatusBadgeClasses.other;
}

function updateSubscriberFilterSummary(count) {
    const summary = document.getElementById('subscriber-filter-summary');
    if (!summary) return;
    const label = subscriberFilterLabels[activeSubscriberFilter] || subscriberFilterLabels.all;
    summary.textContent = `عرض ${count} - ${label}`;
}

function renderSubscribersTablePage(animate = false) {
    const total = currentFilteredSubscribers.length;
    const pageSize = subscriberPagination.pageSize || 10;
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    
    if (totalPages === 0) {
        subscriberPagination.currentPage = 0;
        renderSubscribersTable([], 0, animate);
        updatePaginationControls(total, totalPages);
        return;
    }
    
    if (subscriberPagination.currentPage < 1) {
        subscriberPagination.currentPage = 1;
    }
    if (subscriberPagination.currentPage > totalPages) {
        subscriberPagination.currentPage = totalPages;
    }
    
    const start = (subscriberPagination.currentPage - 1) * pageSize;
    const pagedList = currentFilteredSubscribers.slice(start, start + pageSize);
    
    renderSubscribersTable(pagedList, start, animate);
    updatePaginationControls(total, totalPages);
}

function updatePaginationControls(totalCount, totalPages) {
    const pageInfo = document.getElementById('subscriber-page-info');
    const prevBtn = document.getElementById('subscriber-prev-page');
    const nextBtn = document.getElementById('subscriber-next-page');
    const pageSizeSelect = document.getElementById('subscriber-page-size');
    
    if (pageInfo) {
        if (totalPages === 0) {
            pageInfo.textContent = 'لا يوجد بيانات';
        } else {
            pageInfo.textContent = `صفحة ${subscriberPagination.currentPage} من ${totalPages}`;
        }
    }
    
    if (pageSizeSelect) {
        pageSizeSelect.value = String(subscriberPagination.pageSize);
    }
    
    const disablePrev = totalPages === 0 || subscriberPagination.currentPage <= 1;
    const disableNext = totalPages === 0 || subscriberPagination.currentPage >= totalPages;
    
    if (prevBtn) {
        prevBtn.disabled = disablePrev;
    }
    if (nextBtn) {
        nextBtn.disabled = disableNext;
    }
}

function handlePageSizeChange(value) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) return;
    subscriberPagination.pageSize = parsed;
    subscriberPagination.currentPage = currentFilteredSubscribers.length === 0 ? 0 : 1;
    renderSubscribersTablePage();
}

function getTotalPages() {
    if (!subscriberPagination.pageSize || subscriberPagination.pageSize <= 0) return 0;
    return currentFilteredSubscribers.length === 0
        ? 0
        : Math.ceil(currentFilteredSubscribers.length / subscriberPagination.pageSize);
}

function goToPreviousPage() {
    if (subscriberPagination.currentPage <= 1) return;
    subscriberPagination.currentPage -= 1;
    renderSubscribersTablePage();
}

function goToNextPage() {
    const totalPages = getTotalPages();
    if (totalPages === 0 || subscriberPagination.currentPage >= totalPages) return;
    subscriberPagination.currentPage += 1;
    renderSubscribersTablePage();
}

function renderExpiringSoonList() {
    const listEl = document.getElementById('expiring-subscribers-list');
    if (!listEl) return;
    
    let soon = subscribersCache
        .filter((sub) => sub._meta?.isExpiringSoon)
        .sort((a, b) => {
            const aDays = a._meta?.daysLeft ?? Number.MAX_SAFE_INTEGER;
            const bDays = b._meta?.daysLeft ?? Number.MAX_SAFE_INTEGER;
            return aDays - bDays;
        });
    
    if (expiringSortOrder === 'desc') {
        soon = soon.reverse();
    }
    
    const limit = 8;
    soon = soon.slice(0, limit);
    
    if (soon.length === 0) {
        listEl.innerHTML = '<div class="py-6 text-center text-slate-400 text-sm">لا يوجد مشتركين على وشك انتهاء الصلاحية</div>';
        return;
    }
    
    listEl.innerHTML = soon.map((sub) => `
        <div class="flex items-center justify-between py-3">
            <div>
                <p class="font-bold text-slate-800">${sub.name || '--'}</p>
                <span class="text-xs text-slate-500">ينتهي في ${formatDate(sub.end_date)}</span>
            </div>
            <div class="text-right">
                <span class="text-sm font-bold text-orange-500">${Math.max(sub._meta?.daysLeft ?? 0, 0)} يوم</span>
                <p class="text-[11px] text-slate-400">${sub.zone || ''}</p>
            </div>
        </div>
    `).join('');
}

function exportSubscribersToExcel() {
    if (!currentFilteredSubscribers.length) {
        alert('لا يوجد بيانات لتصديرها.');
        return;
    }
    
    const headers = ['#', 'الاسم', 'معرف الحساب', 'اسم الجهاز', 'رقم الهاتف', 'المنطقة', 'رابط الصفحة', 'تاريخ البدء', 'تاريخ الانتهاء', 'الحالة'];
    const rows = currentFilteredSubscribers.map((sub, index) => {
        const meta = sub._meta || buildSubscriberMeta(sub);
        return [
            index + 1,
            sub.name || '',
            sub.account_id || sub.accountId || '',
            sub.deviceName || sub.username || '',
            sub.phone || '',
            sub.zone || '',
            sub.page_url || '',
            formatDate(sub.start_date || sub.startDate) || '',
            formatDate(sub.end_date || sub.endDate) || '',
            getStatusLabel(meta.statusKey)
        ];
    });
    
    const csvContent = '\uFEFF' + [headers, ...rows]
        .map((row) => row.map(escapeCSVValue).join(','))
        .join('\r\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function escapeCSVValue(value) {
    if (value === null || value === undefined) {
        value = '';
    }
    const stringValue = String(value).replace(/"/g, '""');
    return `"${stringValue}"`;
}

function initSideMenuNavigation() {
    // معالجة أزرار التنقل بين الأقسام
    const sectionLinks = document.querySelectorAll('[data-side-link]');
    sectionLinks.forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const target = link.getAttribute('data-side-link');
            if (target) {
                scrollToSection(target, { skipMenuUpdate: true });
                setSideMenuActiveBySection(target);
            }
        });
    });
    
    // معالجة أزرار التنقل بين الشاشات
    const screenLinks = document.querySelectorAll('[data-screen-link]');
    screenLinks.forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const screenKey = link.getAttribute('data-screen-link');
            if (screenKey) {
                // استدعاء الدالة المناسبة حسب الشاشة
                switch(screenKey) {
                    case 'expiring':
                        openExpiringScreen();
                        break;
                    case 'tickets':
                        openTicketDashboardScreen();
                        break;
                    case 'wallet':
                        openWalletScreen();
                        break;
                    case 'settings':
                        openGeneralSettingsScreen();
                        break;
                }
            }
        });
    });
}

function scrollToSection(sectionId, options = {}) {
    if (!sectionId) return;
    ensurePageDetailScreenVisible();
    const section = document.getElementById(sectionId);
    if (!section) return;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    if (!options.skipMenuUpdate) {
        setSideMenuActiveBySection(sectionId);
    }
}

// دالة جديدة للتنقل إلى قسم مع تفعيل القائمة
function navigateToSection(sectionId) {
    const pageDetailScreen = document.getElementById('page-detail-screen');
    const dashboardScreen = document.getElementById('dashboard-screen');
    
    // إذا كنا في dashboard-screen الرئيسية، لا نعمل شيئاً
    if (dashboardScreen && !dashboardScreen.classList.contains('hidden')) {
        return;
    }
    
    // إذا كنا في شاشة أخرى (مثل الأكسباير أو التذاكر)، نحتاج للانتقال إلى page-detail-screen أولاً
    const otherScreens = ['expiring-screen', 'tickets-dashboard-screen', 'wallet-screen', 'general-settings-screen', 'team-management-screen', 'team-tickets-screen'];
    let isInOtherScreen = false;
    
    for (const screenId of otherScreens) {
        const screen = document.getElementById(screenId);
        if (screen && !screen.classList.contains('hidden')) {
            isInOtherScreen = true;
            break;
        }
    }
    
    // إذا كنا في شاشة أخرى، نحتاج لفتح page-detail-screen أولاً
    if (isInOtherScreen && currentUserId && currentDetailUser) {
        console.log('[navigateToSection] Opening page-detail-screen first from another screen');
        // فتح صفحة تفاصيل المستخدم
        openPageDetail(currentDetailUser, currentDetailPass, currentUserId);
        // الانتظار قليلاً ثم الانتقال للقسم المطلوب
        setTimeout(() => {
            navigateToSection(sectionId);
        }, 100);
        return;
    }
    
    // إذا كنا في page-detail-screen
    if (pageDetailScreen && !pageDetailScreen.classList.contains('hidden')) {
        const sectionDashboard = document.getElementById('section-dashboard');
        const sectionSubscribers = document.getElementById('section-subscribers');
        
        // إظهار/إخفاء الأقسام بناءً على القسم المطلوب
        if (sectionId === 'section-subscribers') {
            // إخفاء لوحة التحكم وإظهار قسم المشتركين
            if (sectionDashboard) sectionDashboard.classList.add('hidden');
            if (sectionSubscribers) {
                sectionSubscribers.classList.remove('hidden');
                scrollToSection(sectionId);
            }
        } else if (sectionId === 'section-dashboard') {
            // إظهار لوحة التحكم وإخفاء قسم المشتركين
            if (sectionSubscribers) sectionSubscribers.classList.add('hidden');
            if (sectionDashboard) {
                sectionDashboard.classList.remove('hidden');
                scrollToSection(sectionId);
            }
        } else {
            // لأي قسم آخر، استخدام السلوك الافتراضي
            scrollToSection(sectionId);
        }
        
        setSideMenuActiveBySection(sectionId);
    } else {
        // إذا لم نكن في page-detail-screen وليس لدينا معلومات المستخدم، نحتاج لفتحها أولاً
        if (currentUserId && currentDetailUser) {
            console.log('[navigateToSection] Opening page-detail-screen first');
            openPageDetail(currentDetailUser, currentDetailPass, currentUserId);
            setTimeout(() => {
                navigateToSection(sectionId);
            }, 100);
        } else {
            console.warn('[navigateToSection] Cannot navigate to section without opening a user page first');
        }
    }
}

function initExpiringSortControl() {
    const sortSelect = document.getElementById('expiring-sort-select');
    if (!sortSelect) return;
    sortSelect.value = expiringSortOrder;
    sortSelect.addEventListener('change', (event) => {
        expiringSortOrder = event.target.value || 'asc';
        renderExpiringSoonList();
    });
}

function initSideMenuToggle() {
    const menus = document.querySelectorAll('.side-menu');
    if (!menus.length) return;
    menus.forEach((menu) => {
        const toggleBtn = menu.querySelector('.side-menu-toggle');
        if (!toggleBtn) return;
        toggleBtn.addEventListener('click', () => {
            const collapsed = menu.classList.toggle('collapsed');
            toggleBtn.setAttribute('aria-expanded', (!collapsed).toString());
            toggleBtn.setAttribute('aria-label', collapsed ? 'إظهار القائمة' : 'إخفاء القائمة');
        });
    });
}

// ================= Alwatani Dashboard =================
async function loadAlwataniDetails(triggeredFromButton = false) {
    const container = document.getElementById('alwatani-data-card');
    if (!container) return;

    if (!currentUserId) {
        setAlwataniState('error', 'يرجى اختيار حساب الوطني من القائمة.');
        return;
    }

    setAlwataniState('loading');

    try {
        const response = await fetch(`${API_URL}/alwatani-login/${currentUserId}/details`);
        const data = await response.json();

        if (!data.success || !data.data) {
            setAlwataniState('error', data.message || 'تعذر جلب بيانات الوطني');
            return;
        }

        renderAlwataniData(data);
    } catch (error) {
        console.error('Alwatani data error:', error);
        setAlwataniState('error', 'حدث خطأ أثناء الاتصال بخادم الوطني');
    }
}

function setAlwataniState(state, message) {
    const loadingEl = document.getElementById('alwatani-loading');
    const errorEl = document.getElementById('alwatani-error');
    const errorText = document.getElementById('alwatani-error-text');
    const contentEl = document.getElementById('alwatani-content');

    if (!loadingEl || !errorEl || !contentEl) return;

    if (state === 'loading') {
        loadingEl.classList.remove('hidden');
        errorEl.classList.add('hidden');
        contentEl.classList.add('hidden');
    } else if (state === 'error') {
        if (errorText) {
            errorText.textContent = message || 'تعذر تحميل البيانات';
        }
        errorEl.classList.remove('hidden');
        loadingEl.classList.add('hidden');
        contentEl.classList.add('hidden');
    } else {
        loadingEl.classList.add('hidden');
        errorEl.classList.add('hidden');
        contentEl.classList.remove('hidden');
    }
}

function renderAlwataniData(response) {
    const payload = response.data || {};
    const wallet = unwrapModel(payload.walletBalance) || {};
    const dashboard = unwrapModel(payload.dashboardSummary) || {};
    const tasks = unwrapModel(payload.tasksSummary) || {};
    const requests = unwrapModel(payload.requestsSummary) || {};
    const tickets = unwrapModel(payload.ticketsSummary) || {};
    const currentUser = payload.currentUser || {};
    const partnerSpan = document.getElementById('alwatani-partner-id');

    const walletCurrent = extractNumber(
        wallet.balance,
        wallet.currentBalance,
        wallet.availableBalance,
        wallet.totalBalance,
        wallet.remainingCredit
    );
    const walletPending = extractNumber(
        wallet.pendingBalance,
        wallet.holdBalance,
        wallet.onHoldBalance,
        wallet.teamMemberWallet?.balance,
        wallet.commission
    );

    const customersMetrics = dashboard.customers || {};
    const subscriptionsMetrics = dashboard.subscriptions || {};
    const totalPages = extractNumber(
        dashboard.totalPages,
        customersMetrics.totalCount,
        subscriptionsMetrics.totalCount
    );
    const activePages = extractNumber(
        dashboard.activePages,
        customersMetrics.totalActive,
        subscriptionsMetrics.totalActive
    );

    const totalTasks = extractNumber(
        tasks.totalCount,
        tasks.total,
        tasks.totalTasks,
        tasks.openTasks,
        tasks.count
    );
    const totalRequests = extractNumber(
        requests.totalCount,
        requests.total,
        requests.totalRequests,
        requests.count,
        Array.isArray(requests.items) ? requests.items.reduce((sum, item) => sum + (item.totalOpen || 0), 0) : null
    );

    const openTickets = extractNumber(
        tickets.open,
        tickets.totalOpen,
        tickets.openTickets,
        tickets?.statusCounts?.open
    );
    const pendingTickets = extractNumber(
        tickets.pending,
        tickets.totalPending,
        tickets.pendingTickets,
        tickets?.statusCounts?.pending
    );
    const closedTickets = extractNumber(
        tickets.closed,
        tickets.totalClosed,
        tickets.closedTickets,
        tickets?.statusCounts?.closed
    );

    setText('alwatani-wallet-current', formatCurrency(walletCurrent));
    setText('alwatani-wallet-pending', formatCurrency(walletPending));
    setText('alwatani-dashboard-total', formatNumber(totalPages));
    setText('alwatani-dashboard-active', formatNumber(activePages));
    setText('alwatani-tasks-total', formatNumber(totalTasks));
    setText('alwatani-requests-total', formatNumber(totalRequests));
    setText('alwatani-tickets-open', formatNumber(openTickets));
    setText('alwatani-tickets-pending', formatNumber(pendingTickets));
    setText('alwatani-tickets-closed', formatNumber(closedTickets));

    setText('alwatani-user-username', currentUser.preferred_username || currentUser.username || '--');
    setText('alwatani-user-email', currentUser.email || currentUser.userName || currentUser.username || '--');

    let rolesArray = currentUser.roles ||
        currentUser.Role ||
        currentUser.realm_access?.roles ||
        currentUser?.realmAccess?.roles;
    if (Array.isArray(rolesArray) && rolesArray.length && rolesArray[0]?.displayValue) {
        rolesArray = rolesArray.map(role => role.displayValue);
    }
    const rolesText = Array.isArray(rolesArray) ? rolesArray.join(', ') : (rolesArray || '--');
    setText('alwatani-user-role', rolesText);

    if (partnerSpan) {
        const partnerValue = response.partnerId ||
            currentUser.AccountId ||
            currentUser.accountId ||
            currentUser.self?.accountId ||
            currentUser.self?.id;
        partnerSpan.textContent = partnerValue ? `PARTNER: ${partnerValue}` : 'PARTNER: --';
    }

    const lastSync = document.getElementById('alwatani-last-sync');
    if (lastSync) {
        lastSync.textContent = new Date().toLocaleString('ar-EG');
    }

    renderAlwataniTransactions(payload.transactions);
    setAlwataniState('success');
}

function renderAlwataniTransactions(transactionsPayload) {
    const tbody = document.getElementById('alwatani-transactions-body');
    if (!tbody) return;

    const transactionsSource = unwrapModel(transactionsPayload);
    let transactionsList = [];
    if (Array.isArray(transactionsSource)) {
        transactionsList = transactionsSource;
    } else if (Array.isArray(transactionsSource?.items)) {
        transactionsList = transactionsSource.items;
    } else if (Array.isArray(transactionsSource?.data)) {
        transactionsList = transactionsSource.data;
    } else if (Array.isArray(transactionsSource?.transactions)) {
        transactionsList = transactionsSource.transactions;
    }

    if (!transactionsList || transactionsList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-slate-400">لا توجد بيانات متاحة</td></tr>`;
        return;
    }

    tbody.innerHTML = '';
    transactionsList.slice(0, 5).forEach((tx) => {
        const type = tx.operationType || tx.transactionType || tx.type || '--';
        const amount = formatCurrency(
            extractNumber(
                tx.transactionAmount?.value,
                tx.amount,
                tx.value,
                tx.balance
            )
        );
        const wallet = tx.walletType || tx.wallet || tx.sourceWallet || '--';
        const date = formatDateTime(tx.occuredAt || tx.createdAt || tx.date || tx.timestamp);

        const row = document.createElement('tr');
        row.className = 'hover:bg-slate-50 transition-colors';
        row.innerHTML = `
            <td class="p-3 font-medium text-slate-700">${type}</td>
            <td class="p-3 text-slate-600">${amount}</td>
            <td class="p-3 text-slate-500">${wallet}</td>
            <td class="p-3 text-slate-500">${date}</td>
        `;
        tbody.appendChild(row);
    });
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = value === undefined || value === null || value === '' ? '--' : value;
    }
}

function extractNumber(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        const num = Number(value);
        if (!Number.isNaN(num)) {
            return num;
        }
    }
    return null;
}

function unwrapModel(value) {
    if (!value) return value;
    if (value.model) return value.model;
    return value;
}

function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return dateString;
    return date.toLocaleDateString('ar-EG');
}

function formatDateTime(dateString) {
    if (!dateString) return '--';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return dateString;
    return date.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
}

function formatNumber(value) {
    if (value === undefined || value === null || value === '') return '--';
    const num = Number(value);
    if (Number.isNaN(num)) return value;
    return num.toLocaleString('ar-IQ');
}

function formatCurrency(value) {
    const formatted = formatNumber(value);
    if (formatted === '--' || formatted === value) {
        return formatted;
    }
    return `${formatted} د.ع`;
}

// ================= Tickets Management =================
async function openTicketManagement() {
    // إخفاء جميع الشاشات أولاً ثم إظهار شاشة إدارة التكتات
    hideAllMainScreens();
    showScreen('ticket-management-screen');
    await loadTickets();
    updateTicketCounts();
    currentScreen = 'ticket-management';
    startAutoRefresh();
}

// Load tickets from API
async function loadTickets() {
    try {
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/tickets`)), addUsernameToFetchOptions());
        const ticketsData = await response.json();
        
        // التحقق من أن البيانات هي array
        const tickets = Array.isArray(ticketsData) ? ticketsData : (ticketsData.error ? [] : []);
        
        const tableBody = document.getElementById('tickets-table-body');
        tableBody.innerHTML = '';
        
        if (!Array.isArray(tickets) || tickets.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="7" class="p-8 text-center text-gray-400">لا توجد تكتات</td>
                </tr>
            `;
        } else {
            tickets.forEach(ticket => {
                const row = document.createElement('tr');
                row.className = "hover:bg-slate-50 slide-up";
                row.setAttribute('data-status', ticket.status);
                row.setAttribute('data-ticket-id', ticket.id);
                
                const statusClasses = {
                    'open': 'bg-red-100 text-red-600 focus:ring-red-200',
                    'pending': 'bg-orange-100 text-orange-600 focus:ring-orange-200',
                    'closed': 'bg-gray-100 text-gray-600 focus:ring-gray-200'
                };
                
                const statusText = {
                    'open': 'مفتوح',
                    'pending': 'قيد المعالجة',
                    'closed': 'مغلق'
                };
                
                const date = ticket.created_at ? new Date(ticket.created_at).toISOString().split('T')[0] : '-';
                
                // Escape values for onclick attribute
                const ticketNumberEscaped = (ticket.ticket_number || '').replace(/'/g, "\\'").replace(/"/g, "&quot;");
                const subscriberNameEscaped = (ticket.subscriber_name || '').replace(/'/g, "\\'").replace(/"/g, "&quot;");
                const teamEscaped = (ticket.team || '').replace(/'/g, "\\'").replace(/"/g, "&quot;");
                const descriptionEscaped = (ticket.description || '').replace(/'/g, "\\'").replace(/"/g, "&quot;").replace(/\n/g, '\\n');
                
                row.innerHTML = `
                    <td class="p-3 font-mono text-slate-600">${ticket.ticket_number}</td>
                    <td class="p-3 font-medium">${ticket.subscriber_name}</td>
                    <td class="p-3 text-slate-600">${ticket.description || '-'}</td>
                    <td class="p-3"><span class="bg-indigo-50 text-indigo-700 px-2 py-1 rounded text-xs font-bold">${ticket.team || '-'}</span></td>
                    <td class="p-3">
                        <select onchange="updateTicketStatus(this)" class="status-select ${statusClasses[ticket.status] || statusClasses.open} px-2 py-1 rounded text-xs font-bold border-none outline-none focus:ring-2 transition-colors">
                            <option value="open" ${ticket.status === 'open' ? 'selected' : ''}>مفتوح</option>
                            <option value="pending" ${ticket.status === 'pending' ? 'selected' : ''}>قيد المعالجة</option>
                            <option value="closed" ${ticket.status === 'closed' ? 'selected' : ''}>مغلق</option>
                        </select>
                    </td>
                    <td class="p-3 text-slate-500">${date}</td>
                    <td class="p-3 text-center">
                        <button onclick="viewTicketDetails(${ticket.id}, '${ticketNumberEscaped}', '${subscriberNameEscaped}', '${teamEscaped}', '${descriptionEscaped}')" class="text-blue-500 hover:underline">عرض</button>
                    </td>
                `;
                
                tableBody.appendChild(row);
            });
        }
    } catch (error) {
        console.error('Error loading tickets:', error);
        const tableBody = document.getElementById('tickets-table-body');
        tableBody.innerHTML = `
            <tr>
                <td colspan="7" class="p-8 text-center text-red-400">حدث خطأ أثناء تحميل التكتات</td>
            </tr>
        `;
    }
}

function backToDashboardFromTickets() {
    switchScreen('ticket-management-screen', 'page-detail-screen');
}

async function openAddTicketModal() {
    document.getElementById('add-ticket-modal').classList.remove('hidden');
    document.getElementById('add-ticket-modal').classList.add('flex');
    
    // Load teams into select dropdown
    await loadTeamsForTicket();
}

async function loadTeamsForTicket() {
    try {
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/teams`)), addUsernameToFetchOptions());
        const teamsData = await response.json();
        const teams = Array.isArray(teamsData) ? teamsData : (teamsData.error ? [] : []);
        const select = document.getElementById('ticket-team');
        
        select.innerHTML = '<option value="">اختر الفريق...</option>';
        
        // فلترة الفرق النشطة فقط
        const activeTeams = teams.filter(team => team.status === 'active');
        
        // جلب أعضاء كل فريق والتحقق من وجودهم
        for (const team of activeTeams) {
            try {
                const membersResponse = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/teams/${team.id}/members`)), addUsernameToFetchOptions());
                const members = await membersResponse.json();
                
                // إضافة الفريق فقط إذا كان يحتوي على أعضاء
                if (members && members.length > 0) {
                    const option = document.createElement('option');
                    option.value = team.name;
                    option.textContent = team.name;
                    select.appendChild(option);
                }
            } catch (error) {
                console.error(`Error loading members for team ${team.id}:`, error);
                // في حالة الخطأ، لا نضيف الفريق للأمان
            }
        }
        
        // إذا لم توجد فرق تحتوي على أعضاء، عرض رسالة
        if (select.options.length === 1) { // فقط الخيار الافتراضي
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '⚠️ لا توجد فرق تحتوي على أعضاء';
            option.disabled = true;
            select.appendChild(option);
        }
    } catch (error) {
        console.error('Error loading teams for ticket:', error);
        const select = document.getElementById('ticket-team');
        if (select) {
            select.innerHTML = '<option value="">خطأ في تحميل الفرق</option>';
        }
    }
}

function closeAddTicketModal() {
    document.getElementById('add-ticket-modal').classList.add('hidden');
    document.getElementById('add-ticket-modal').classList.remove('flex');
}

async function handleAddTicket(e) {
    e.preventDefault();
    const subscriber = document.getElementById('ticket-subscriber').value;
    const desc = document.getElementById('ticket-desc').value;
    const team = document.getElementById('ticket-team').value;
    
    if (!team) {
        alert('يرجى اختيار فريق');
        return;
    }
    
    // التحقق من وجود أعضاء في الفريق (تحقق إضافي)
    try {
        const teamResponse = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/teams`)), addUsernameToFetchOptions());
        const teamsData = await teamResponse.json();
        const teams = Array.isArray(teamsData) ? teamsData : [];
        const selectedTeam = teams.find(t => t.name === team);
        
        if (selectedTeam) {
            const membersResponse = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/teams/${selectedTeam.id}/members`)), addUsernameToFetchOptions());
            const membersData = await membersResponse.json();
            const members = Array.isArray(membersData) ? membersData : [];
            
            if (!members || members.length === 0) {
                alert('⚠️ لا يمكن إرسال التكت إلى هذا الفريق لأنه لا يحتوي على أعضاء!\n\nيرجى إضافة أعضاء للفريق من صفحة إدارة الفرق أولاً.');
                // إعادة تحميل القائمة
                await loadTeamsForTicket();
                return;
            }
        } else {
            alert('⚠️ الفريق المحدد غير موجود');
            await loadTeamsForTicket();
            return;
        }
    } catch (error) {
        console.error('Error checking team members:', error);
        alert('⚠️ حدث خطأ أثناء التحقق من أعضاء الفريق. يرجى المحاولة مرة أخرى.');
        return;
    }
    
    // Ticket number will be generated by the backend

    try {
        // إرسال إلى API
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/tickets`)), addUsernameToFetchOptions({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subscriber_name: subscriber,
                description: desc,
                team: team,
                status: 'open',
                priority: 'medium'
            })
        }));
        
        const data = await response.json();
        
        if (data.success) {
            // Reload tickets from API to ensure consistency
            await loadTickets();
            
            document.getElementById('ticket-subscriber').value = '';
            document.getElementById('ticket-desc').value = '';
            closeAddTicketModal();
            updateTicketCounts();
            
            alert('✅ تم إضافة التكت بنجاح!');
        } else {
            alert('❌ فشل إضافة التكت!');
        }
    } catch (error) {
        console.error('Error adding ticket:', error);
        alert('❌ حدث خطأ أثناء إضافة التكت!');
    }
}

async function updateTicketStatus(selectElement) {
    const status = selectElement.value;
    const row = selectElement.closest('tr');
    const ticketId = row.getAttribute('data-ticket-id');
    
    if (!ticketId) {
        console.error('Ticket ID not found');
        return;
    }
    
    // Update UI immediately
    row.setAttribute('data-status', status);
    selectElement.className = 'status-select px-2 py-1 rounded text-xs font-bold border-none outline-none focus:ring-2 transition-colors';
    
    if (status === 'open') {
        selectElement.classList.add('bg-red-100', 'text-red-600', 'focus:ring-red-200');
    } else if (status === 'pending') {
        selectElement.classList.add('bg-orange-100', 'text-orange-600', 'focus:ring-orange-200');
    } else if (status === 'closed') {
        selectElement.classList.add('bg-gray-100', 'text-gray-600', 'focus:ring-gray-200');
    }
    
    // Send update to API
    try {
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/tickets/${ticketId}`)), addUsernameToFetchOptions({
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        }));
        
        const data = await response.json();
        
        if (!data.success) {
            console.error('Failed to update ticket status');
            // Revert UI change on error
            await loadTickets();
        }
    } catch (error) {
        console.error('Error updating ticket status:', error);
        // Revert UI change on error
        await loadTickets();
    }
    
    updateTicketCounts();
}

function filterTickets(status) {
    const buttons = document.querySelectorAll('.filter-btn');
    buttons.forEach(btn => {
        if(btn.getAttribute('data-filter') === status) {
            btn.classList.remove('bg-white', 'text-slate-600', 'border', 'border-slate-200');
            btn.classList.add('bg-[#26466D]', 'text-white');
        } else {
            btn.classList.add('bg-white', 'text-slate-600', 'border', 'border-slate-200');
            btn.classList.remove('bg-[#26466D]', 'text-white');
        }
    });

    const rows = document.querySelectorAll('#tickets-table-body tr');
    rows.forEach(row => {
        if (status === 'all' || row.getAttribute('data-status') === status) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

function updateTicketCounts() {
    const rows = document.querySelectorAll('#tickets-table-body tr');
    let openCount = 0;
    let pendingCount = 0;
    let closedCount = 0;
    
    rows.forEach(row => {
        if (row.style.display === 'none') return; // Skip hidden rows
        const status = row.getAttribute('data-status');
        if (status === 'open') openCount++;
        else if (status === 'pending') pendingCount++;
        else if (status === 'closed') closedCount++;
    });
    
    document.getElementById('open-tickets-count').textContent = openCount;
    document.getElementById('pending-tickets-count').textContent = pendingCount;
    document.getElementById('closed-tickets-count').textContent = closedCount;
}

// Search tickets function
function searchTickets(searchTerm) {
    const term = searchTerm.toLowerCase();
    const rows = document.querySelectorAll('#tickets-table-body tr');
    
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        if (text.includes(term)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
    
    updateTicketCounts();
}

// ================= Teams Management =================
async function openTeamManagement() {
    switchScreen('ticket-management-screen', 'team-management-screen');
    await loadTeams();
}

// متغيرات لحفظ بيانات الصورة
let selectedMemberPhoto = null;

// Load teams from API
async function loadTeams() {
    try {
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/teams`)), addUsernameToFetchOptions());
        const teamsData = await response.json();
        const teams = Array.isArray(teamsData) ? teamsData : (teamsData.error ? [] : []);
        
        // تحديث dropdown إضافة الأعضاء
        const teamSelect = document.getElementById('team-select-for-member');
        if (teamSelect) {
            teamSelect.innerHTML = '<option value="">اختر الفريق</option>';
            teams.forEach(team => {
                if (team.status === 'active') {
                    const option = document.createElement('option');
                    option.value = team.id;
                    option.textContent = team.name;
                    teamSelect.appendChild(option);
                }
            });
        }
        
        const container = document.getElementById('teams-list-container');
        container.innerHTML = '';
        
        if (teams.length === 0) {
            container.innerHTML = `
                <div class="col-span-full text-center py-12 bg-white rounded-xl border border-dashed border-slate-300">
                    <p class="text-slate-500">لا توجد فرق</p>
                </div>
            `;
        } else {
            // Get ticket counts for each team
            const ticketsResponse = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/tickets`)), addUsernameToFetchOptions());
            const ticketsData = await ticketsResponse.json();
            const allTickets = Array.isArray(ticketsData) ? ticketsData : [];
            
            for (const team of teams) {
                // جلب أعضاء الفريق
                let members = [];
                try {
                    const membersResponse = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/teams/${team.id}/members`)), addUsernameToFetchOptions());
                    if (membersResponse.ok) {
                        members = await membersResponse.json();
                        // تأكد من أن members مصفوفة
                        if (!Array.isArray(members)) {
                            members = [];
                        }
                    } else if (membersResponse.status === 404) {
                        // إذا كان 404، هذا يعني أن الجدول غير موجود أو الفريق غير موجود
                        console.warn(`Team ${team.id} members endpoint returned 404 - table may not exist`);
                        members = [];
                    } else {
                        console.error(`Error loading members for team ${team.id}:`, membersResponse.status);
                        members = [];
                    }
                } catch (error) {
                    console.error(`Error loading members for team ${team.id}:`, error);
                    members = [];
                }
                
                const teamTicketsCount = allTickets.filter(t => t.team === team.name).length;
                const firstLetter = team.name.charAt(0).toUpperCase();
                const statusClass = team.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700';
                const statusText = team.status === 'active' ? 'نشط' : 'غير نشط';
                
                const teamCard = document.createElement('div');
                teamCard.className = "bg-white p-5 rounded-xl border border-slate-200 shadow-sm hover:border-indigo-300 transition-colors cursor-pointer group slide-up";
                teamCard.onclick = function() { openTeamTickets(team.name); };
                
                // عرض أعضاء الفريق
                const membersHtml = members.length > 0 
                    ? members.map(member => `
                        <div class="flex items-center gap-2 text-xs text-slate-600">
                            ${member.photo_url 
                                ? `<img src="${member.photo_url}" alt="${member.name}" class="w-6 h-6 rounded-full object-cover border border-indigo-200">`
                                : `<div class="w-6 h-6 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-bold">${member.name.charAt(0)}</div>`
                            }
                            <span>${member.name}</span>
                        </div>
                    `).join('')
                    : '<p class="text-xs text-red-500">⚠️ لا يوجد أعضاء</p>';
                
                teamCard.innerHTML = `
                    <div class="flex justify-between items-start mb-4">
                        <div class="w-12 h-12 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-lg">${firstLetter}</div>
                        <div class="flex items-center gap-2">
                            <button onclick="event.stopPropagation(); openEditTeamModal(${team.id}, '${team.name.replace(/'/g, "\\'")}', '${(team.description || '').replace(/'/g, "\\'")}')" class="text-indigo-600 hover:text-indigo-700 p-1.5 rounded-lg hover:bg-indigo-50 transition-colors" title="تعديل الفريق">
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                            </button>
                            <span onclick="event.stopPropagation(); toggleTeamStatus(${team.id}, this)" class="${statusClass} text-xs font-bold px-2 py-1 rounded-full cursor-pointer hover:opacity-80 select-none">${statusText}</span>
                        </div>
                    </div>
                    <h4 class="font-bold text-slate-800 text-lg mb-1">${team.name}</h4>
                    <p class="text-xs text-slate-500 mb-4">${team.description || '-'}</p>
                    <div class="mb-4 space-y-1">
                        <p class="text-xs font-medium text-slate-600 mb-2">الأعضاء:</p>
                        <div class="space-y-1">
                            ${membersHtml}
                        </div>
                    </div>
                    <div class="flex items-center justify-between text-sm bg-slate-50 p-3 rounded-lg">
                        <span class="text-slate-600">التكتات المسندة:</span>
                        <span class="font-bold text-indigo-700">${teamTicketsCount}</span>
                    </div>
                `;
                
                container.appendChild(teamCard);
            }
        }
    } catch (error) {
        console.error('Error loading teams:', error);
    }
}

function backToTicketsFromTeams() {
    switchScreen('team-management-screen', 'ticket-management-screen');
}

async function handleAddTeam(e) {
    e.preventDefault();
    const nameInput = document.getElementById('new-team-name');
    const descInput = document.getElementById('new-team-desc');
    const name = nameInput.value;
    const desc = descInput.value;

    try {
        // إرسال إلى API
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/teams`)), addUsernameToFetchOptions({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                description: desc,
                status: 'active'
            })
        }));
        
        const data = await response.json();
        
        if (data.success) {
            // Reload teams from API to ensure consistency
            await loadTeams();
            
            nameInput.value = '';
            descInput.value = '';
            
            alert('✅ تم إضافة الفريق بنجاح!');
        } else {
            alert('❌ فشل إضافة الفريق!');
        }
    } catch (error) {
        console.error('Error adding team:', error);
        alert('❌ حدث خطأ أثناء إضافة الفريق!');
    }
}

// معالجة اختيار صورة العضو
function handleMemberPhotoSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
        alert('يرجى اختيار ملف صورة');
        return;
    }
    
    // التحقق من حجم الملف (مثلاً 2MB)
    if (file.size > 2 * 1024 * 1024) {
        alert('حجم الصورة كبير جداً. يرجى اختيار صورة أقل من 2MB');
        return;
    }
    
    const reader = new FileReader();
    reader.onload = function(e) {
        selectedMemberPhoto = e.target.result; // base64
        const preview = document.getElementById('member-photo-preview');
        if (preview) {
            preview.src = selectedMemberPhoto;
            preview.classList.remove('hidden');
        }
    };
    reader.onerror = function() {
        alert('خطأ في قراءة الصورة');
    };
    reader.readAsDataURL(file);
}

// إضافة عضو جديد للفريق
async function handleAddTeamMember(e) {
    e.preventDefault();
    const teamId = document.getElementById('team-select-for-member').value;
    const name = document.getElementById('member-name').value.trim();
    const phone = document.getElementById('member-phone').value.trim();
    
    if (!teamId) {
        alert('يرجى اختيار الفريق');
        return;
    }
    
    if (!name) {
        alert('يرجى إدخال اسم الفني');
        return;
    }
    
    if (!phone) {
        alert('يرجى إدخال رقم هاتف الفني');
        return;
    }
    
    try {
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/teams/${teamId}/members`)), addUsernameToFetchOptions({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                phone: phone,
                photo_url: selectedMemberPhoto || null
            })
        }));
        
        // التحقق من حالة الاستجابة أولاً
        if (!response.ok) {
            let errorMessage = 'خطأ غير معروف';
            try {
                const errorData = await response.json();
                errorMessage = errorData.message || errorData.error || `خطأ ${response.status}`;
            } catch (e) {
                // إذا فشل تحليل JSON، استخدم رسالة افتراضية
                if (response.status === 404) {
                    errorMessage = 'الفريق غير موجود';
                } else if (response.status === 500) {
                    errorMessage = 'خطأ في الخادم';
                } else {
                    errorMessage = `خطأ ${response.status}: ${response.statusText}`;
                }
            }
            alert('❌ فشل إضافة العضو: ' + errorMessage);
            return;
        }
        
        const data = await response.json();
        
        if (data.success) {
            // إعادة تحميل الفرق
            await loadTeams();
            
            // تنظيف النموذج
            document.getElementById('team-select-for-member').value = '';
            document.getElementById('member-name').value = '';
            document.getElementById('member-phone').value = '';
            document.getElementById('member-photo-input').value = '';
            selectedMemberPhoto = null;
            const preview = document.getElementById('member-photo-preview');
            if (preview) {
                preview.src = '';
                preview.classList.add('hidden');
            }
            
            alert('✅ تم إضافة العضو بنجاح!');
        } else {
            alert('❌ فشل إضافة العضو: ' + (data.message || 'خطأ غير معروف'));
        }
    } catch (error) {
        console.error('Error adding team member:', error);
        alert('❌ حدث خطأ أثناء إضافة العضو: ' + (error.message || 'خطأ في الاتصال'));
    }
}

async function toggleTeamStatus(teamId, element) {
    const currentStatus = element.classList.contains('bg-green-100') ? 'active' : 'inactive';
    const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
    
    try {
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/teams/${teamId}`)), addUsernameToFetchOptions({
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        }));
        
        const data = await response.json();
        
        if (data.success) {
            // Update UI
            if (newStatus === 'active') {
                element.classList.remove('bg-red-100', 'text-red-700');
                element.classList.add('bg-green-100', 'text-green-700');
                element.innerText = 'نشط';
            } else {
        element.classList.remove('bg-green-100', 'text-green-700');
        element.classList.add('bg-red-100', 'text-red-700');
        element.innerText = 'غير نشط';
            }
    } else {
            alert('❌ فشل تحديث حالة الفريق!');
        }
    } catch (error) {
        console.error('Error updating team status:', error);
        alert('❌ حدث خطأ أثناء تحديث حالة الفريق!');
    }
}

// فتح modal تعديل الفريق
function openEditTeamModal(teamId, teamName, teamDescription) {
    document.getElementById('edit-team-id').value = teamId;
    document.getElementById('edit-team-name').value = teamName || '';
    document.getElementById('edit-team-description').value = teamDescription || '';
    
    const modal = document.getElementById('edit-team-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

// إغلاق modal تعديل الفريق
function closeEditTeamModal() {
    const modal = document.getElementById('edit-team-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    
    // تنظيف الحقول
    document.getElementById('edit-team-id').value = '';
    document.getElementById('edit-team-name').value = '';
    document.getElementById('edit-team-description').value = '';
}

// معالجة تحديث الفريق
async function handleUpdateTeam(e) {
    e.preventDefault();
    
    const teamId = document.getElementById('edit-team-id').value;
    const name = document.getElementById('edit-team-name').value.trim();
    const description = document.getElementById('edit-team-description').value.trim();
    
    if (!teamId) {
        alert('❌ خطأ: معرف الفريق غير موجود');
        return;
    }
    
    if (!name) {
        alert('❌ يرجى إدخال اسم الفريق');
        return;
    }
    
    try {
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/teams/${teamId}`)), addUsernameToFetchOptions({
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                description: description || null
            })
        }));
        
        const data = await response.json();
        
        if (data.success) {
            // إعادة تحميل الفرق
            await loadTeams();
            
            // إغلاق modal
            closeEditTeamModal();
            
            alert('✅ تم تعديل الفريق بنجاح!');
        } else {
            alert('❌ فشل تعديل الفريق: ' + (data.message || 'خطأ غير معروف'));
        }
    } catch (error) {
        console.error('Error updating team:', error);
        alert('❌ حدث خطأ أثناء تعديل الفريق: ' + (error.message || 'خطأ في الاتصال'));
    }
}

async function openTeamTickets(teamName) {
    document.getElementById('team-tickets-title').innerText = `تكتات: ${teamName}`;
    switchScreen('team-management-screen', 'team-tickets-screen');
    await loadTeamTickets(teamName);
}

// Load tickets for a specific team
async function loadTeamTickets(teamName) {
    try {
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/tickets`)), addUsernameToFetchOptions());
        const allTickets = await response.json();
        const teamTickets = Array.isArray(allTickets) ? allTickets.filter(ticket => ticket.team === teamName) : [];
        
        const tableBody = document.querySelector('#team-tickets-screen tbody');
        if (!tableBody) return;
        
        tableBody.innerHTML = '';
        
        if (teamTickets.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="6" class="p-8 text-center text-gray-400">لا توجد تكتات مسندة لهذا الفريق</td>
                </tr>
            `;
        } else {
            teamTickets.forEach(ticket => {
                const row = document.createElement('tr');
                row.className = "hover:bg-slate-50";
                
                const priorityColors = {
                    'high': 'bg-red-100 text-red-700',
                    'medium': 'bg-yellow-100 text-yellow-700',
                    'low': 'bg-green-100 text-green-700'
                };
                
                const statusColors = {
                    'open': 'bg-red-100 text-red-700',
                    'pending': 'bg-orange-100 text-orange-700',
                    'closed': 'bg-gray-100 text-gray-700'
                };
                
                const date = ticket.created_at ? new Date(ticket.created_at).toISOString().split('T')[0] : '-';
                
                // Escape values for onclick attribute
                const ticketNumberEscaped = (ticket.ticket_number || '').replace(/'/g, "\\'").replace(/"/g, "&quot;");
                const subscriberNameEscaped = (ticket.subscriber_name || '').replace(/'/g, "\\'").replace(/"/g, "&quot;");
                const teamEscaped = (ticket.team || '').replace(/'/g, "\\'").replace(/"/g, "&quot;");
                const descriptionEscaped = (ticket.description || '').replace(/'/g, "\\'").replace(/"/g, "&quot;").replace(/\n/g, '\\n');
                
                row.innerHTML = `
                    <td class="p-3 font-mono text-slate-600">${ticket.ticket_number}</td>
                    <td class="p-3 font-medium">${ticket.subscriber_name}</td>
                    <td class="p-3 text-slate-600">${ticket.description || '-'}</td>
                    <td class="p-3">
                        <span class="${priorityColors[ticket.priority] || priorityColors.medium} px-2 py-1 rounded text-xs font-bold">
                            ${ticket.priority === 'high' ? 'عالية' : ticket.priority === 'medium' ? 'متوسطة' : 'منخفضة'}
                        </span>
                    </td>
                    <td class="p-3">
                        <span class="${statusColors[ticket.status] || statusColors.open} px-2 py-1 rounded text-xs font-bold">
                            ${ticket.status === 'open' ? 'مفتوح' : ticket.status === 'pending' ? 'قيد المعالجة' : 'مغلق'}
                        </span>
                    </td>
                    <td class="p-3 text-center">
                        <button onclick="viewTicketDetails(${ticket.id}, '${ticketNumberEscaped}', '${subscriberNameEscaped}', '${teamEscaped}', '${descriptionEscaped}')" class="text-blue-500 hover:underline">عرض</button>
                    </td>
                `;
                
                tableBody.appendChild(row);
            });
        }
    } catch (error) {
        console.error('Error loading team tickets:', error);
        const tableBody = document.querySelector('#team-tickets-screen tbody');
        if (tableBody) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="6" class="p-8 text-center text-red-400">حدث خطأ أثناء تحميل التكتات</td>
                </tr>
            `;
        }
    }
}

// متغيرات لإعادة توجيه التذكرة
let currentRedirectTicketId = null;
let currentRedirectTicketDescription = null;

function viewTicketDetails(ticketId, ticketNumber, subscriberName, currentTeam, currentDescription) {
    currentRedirectTicketId = ticketId;
    currentRedirectTicketDescription = currentDescription || '';
    
    // تحديث معلومات التذكرة في الـ modal
    document.getElementById('redirect-ticket-info').textContent = `#${ticketNumber} - ${subscriberName}`;
    document.getElementById('redirect-current-team').textContent = currentTeam || 'غير محدد';
    
    // تحميل الفرق المتاحة
    loadTeamsForRedirect();
    
    // مسح حقل الملاحظة
    document.getElementById('redirect-ticket-note').value = '';
    
    // فتح الـ modal
    const modal = document.getElementById('redirect-ticket-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeRedirectTicketModal() {
    const modal = document.getElementById('redirect-ticket-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    currentRedirectTicketId = null;
    currentRedirectTicketDescription = null;
    document.getElementById('redirect-ticket-team').value = '';
    document.getElementById('redirect-ticket-note').value = '';
}

async function loadTeamsForRedirect() {
    try {
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/teams`)), addUsernameToFetchOptions());
        const teamsData = await response.json();
        const teams = Array.isArray(teamsData) ? teamsData : (teamsData.error ? [] : []);
        const select = document.getElementById('redirect-ticket-team');
        
        select.innerHTML = '<option value="">اختر الفريق...</option>';
        
        // فلترة الفرق النشطة فقط
        const activeTeams = teams.filter(team => team.status === 'active');
        
        // جلب أعضاء كل فريق والتحقق من وجودهم
        for (const team of activeTeams) {
            try {
                const membersResponse = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/teams/${team.id}/members`)), addUsernameToFetchOptions());
                const members = await membersResponse.json();
                
                // إضافة الفريق فقط إذا كان يحتوي على أعضاء
                if (members && members.length > 0) {
                    const option = document.createElement('option');
                    option.value = team.name;
                    option.textContent = team.name;
                    select.appendChild(option);
                }
            } catch (error) {
                console.error(`Error loading members for team ${team.id}:`, error);
            }
        }
        
        // إذا لم توجد فرق تحتوي على أعضاء، عرض رسالة
        if (select.options.length === 1) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '⚠️ لا توجد فرق تحتوي على أعضاء';
            option.disabled = true;
            select.appendChild(option);
        }
    } catch (error) {
        console.error('Error loading teams for redirect:', error);
        const select = document.getElementById('redirect-ticket-team');
        if (select) {
            select.innerHTML = '<option value="">خطأ في تحميل الفرق</option>';
        }
    }
}

async function handleRedirectTicket() {
    if (!currentRedirectTicketId) {
        alert('خطأ: لم يتم تحديد التذكرة');
        return;
    }
    
    const newTeam = document.getElementById('redirect-ticket-team').value;
    if (!newTeam) {
        alert('يرجى اختيار فريق لإعادة التوجيه');
        return;
    }
    
    const note = document.getElementById('redirect-ticket-note').value.trim();
    if (!note) {
        alert('يرجى إدخال ملاحظة توضح سبب إعادة التوجيه');
        return;
    }
    
    // دمج الملاحظة مع الوصف الحالي
    const currentDescription = currentRedirectTicketDescription || '';
    const updatedDescription = currentDescription 
        ? `${currentDescription}\n\n[إعادة توجيه] ${note}`
        : `[إعادة توجيه] ${note}`;
    
    try {
        const response = await fetch(addAlwataniLoginIdToUrl(addUsernameToUrl(`${API_URL}/tickets/${currentRedirectTicketId}`)), addUsernameToFetchOptions({
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                team: newTeam,
                description: updatedDescription
            })
        }));
        
        if (!response.ok) {
            let errorMessage = 'خطأ غير معروف';
            try {
                const errorData = await response.json();
                errorMessage = errorData.message || errorData.error || `خطأ ${response.status}`;
            } catch (e) {
                errorMessage = `خطأ ${response.status}: ${response.statusText}`;
            }
            alert('❌ فشل إعادة توجيه التذكرة: ' + errorMessage);
            return;
        }
        
        const data = await response.json();
        
        if (data.success) {
            // إعادة تحميل التذاكر
            await loadTickets();
            updateTicketCounts();
            
            // إغلاق الـ modal
            closeRedirectTicketModal();
            
            alert('✅ تم إعادة توجيه التذكرة بنجاح!');
        } else {
            alert('❌ فشل إعادة توجيه التذكرة: ' + (data.message || 'خطأ غير معروف'));
        }
    } catch (error) {
        console.error('Error redirecting ticket:', error);
        alert('❌ حدث خطأ أثناء إعادة توجيه التذكرة: ' + (error.message || 'خطأ في الاتصال'));
    }
}

function closeTeamTickets() {
    switchScreen('team-tickets-screen', 'team-management-screen');
}

// ================= User Info Modal =================
function showUserInfoModal() {
    // عرض اسم المستخدم
    document.getElementById('modal-username').innerText = currentDetailUser;
    
    const passInput = document.getElementById('modal-password');
    passInput.value = currentDetailPass;
    passInput.type = "password";
    document.getElementById('modal-eye-icon').innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />';
    const modal = document.getElementById('user-info-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeUserInfoModal() {
    const modal = document.getElementById('user-info-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function toggleModalPassword() {
    const passInput = document.getElementById('modal-password');
    const icon = document.getElementById('modal-eye-icon');
    if (passInput.type === "password") {
        passInput.type = "text";
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />';
    } else {
        passInput.type = "password";
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />';
    }
}

// Close modal on background click
document.addEventListener('DOMContentLoaded', function() {
    // إخفاء القائمة الجانبية عند تحميل الصفحة (افتراضياً في صفحة تسجيل الدخول)
    hideSideMenu();
    
    // إغلاق modal إعادة توجيه التذكرة عند النقر على الخلفية
    const redirectModal = document.getElementById('redirect-ticket-modal');
    if (redirectModal) {
        redirectModal.addEventListener('click', function(e) {
            if (e.target === redirectModal) {
                closeRedirectTicketModal();
            }
        });
    }
    
    document.getElementById('user-info-modal').addEventListener('click', function(e) {
        if (e.target === this) { closeUserInfoModal(); }
    });
    
    document.getElementById('add-ticket-modal').addEventListener('click', function(e) {
        if (e.target === this) { closeAddTicketModal(); }
    });
    
    const createAccountModal = document.getElementById('create-account-modal');
    if (createAccountModal) {
        // منع context menu (الكليك اليمين) على الـ modal
        createAccountModal.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        });
        
        // إغلاق الـ modal عند الضغط على الـ backdrop فقط (left click)
        createAccountModal.addEventListener('click', function(e) {
            // التأكد من أن الـ click هو left click فقط (button === 0)
            // والتأكد من أن الـ click كان على الـ backdrop وليس على المحتوى
            if (e.button === 0 && e.target === this) {
                e.preventDefault();
                e.stopPropagation();
                closeCreateAccountModal();
            }
        });
        
        // منع إغلاق الـ modal عند الضغط داخل المحتوى
        const modalContent = createAccountModal.querySelector('.bg-white');
        if (modalContent) {
            modalContent.addEventListener('click', function(e) {
                e.stopPropagation();
            });
        }
    }
});

// ================= Theme Toggle =================
function toggleTheme() {
    const body = document.body;
    const isDark = body.classList.contains('dark-mode');
    const themeBtn = document.getElementById('theme-toggle-btn');
    
    // Add animation class
    if (themeBtn) {
        themeBtn.style.transform = 'scale(0.9)';
        setTimeout(() => {
            themeBtn.style.transform = 'scale(1)';
        }, 150);
    }
    
    // Smooth transition with delay for better UX
    if (isDark) {
        body.style.transition = 'background-color 0.4s cubic-bezier(0.4, 0, 0.2, 1), color 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
        body.classList.remove('dark-mode');
        localStorage.setItem('theme', 'light');
        updateThemeIcon(false);
        applyLightMode();
    } else {
        body.style.transition = 'background-color 0.4s cubic-bezier(0.4, 0, 0.2, 1), color 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
        body.classList.add('dark-mode');
        localStorage.setItem('theme', 'dark');
        updateThemeIcon(true);
        applyDarkMode();
    }
    
    // Trigger reflow for smooth animation
    void body.offsetWidth;
}

// Apply dark mode styles dynamically to all elements
function applyDarkMode() {
    const allElements = document.querySelectorAll('*');
    
    allElements.forEach(el => {
        // Skip SVG, images, and buttons with specific colors
        if (el.tagName === 'SVG' || el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'CANVAS') {
            return;
        }
        
        // Skip elements with stat-icon or custom-blue classes
        if (el.classList.contains('stat-icon-green') || 
            el.classList.contains('stat-icon-blue') || 
            el.classList.contains('stat-icon-orange') || 
            el.classList.contains('stat-icon-purple') || 
            el.classList.contains('stat-icon-red') ||
            el.classList.contains('custom-blue')) {
            return;
        }
        
        const classes = el.className;
        if (classes && typeof classes === 'string') {
            // Background colors - force override
            if (classes.includes('bg-white')) {
                el.style.setProperty('background-color', '#1e293b', 'important');
            }
            if (classes.includes('bg-slate-50')) {
                el.style.setProperty('background-color', '#0f172a', 'important');
            }
            if (classes.includes('bg-gray-50')) {
                el.style.setProperty('background-color', '#1e293b', 'important');
            }
            if (classes.includes('bg-gray-100')) {
                el.style.setProperty('background-color', '#1e293b', 'important');
            }
            if (classes.includes('bg-gray-200')) {
                el.style.setProperty('background-color', '#334155', 'important');
            }
            if (classes.includes('bg-blue-50')) {
                el.style.setProperty('background-color', '#1e3a5f', 'important');
            }
            if (classes.includes('bg-red-50')) {
                el.style.setProperty('background-color', '#7f1d1d', 'important');
            }
            if (classes.includes('bg-orange-100')) {
                el.style.setProperty('background-color', '#7c2d12', 'important');
            }
            if (classes.includes('bg-indigo-50') || classes.includes('bg-indigo-100')) {
                el.style.setProperty('background-color', '#312e81', 'important');
            }
            if (classes.includes('bg-green-100')) {
                el.style.setProperty('background-color', '#14532d', 'important');
            }
            
            // Check for inline bg color
            const bgColor = window.getComputedStyle(el).backgroundColor;
            if (bgColor === 'rgb(248, 250, 252)' || bgColor === 'rgba(248, 250, 252, 1)') {
                el.style.setProperty('background-color', '#0f172a', 'important');
            }
        }
        
        // Handle specific IDs - force override
        if (el.id === 'login-container' || 
            el.id === 'dashboard-screen' || 
            el.id === 'ticket-management-screen' || 
            el.id === 'team-management-screen' || 
            el.id === 'page-detail-screen' || 
            el.id === 'team-tickets-screen') {
            el.style.setProperty('background-color', '#0f172a', 'important');
        }
        
        // Handle headers - force override
        if (el.tagName === 'HEADER') {
            el.style.setProperty('background-color', '#1e293b', 'important');
        }
        
        // Handle main elements
        if (el.tagName === 'MAIN') {
            const bgColor = window.getComputedStyle(el).backgroundColor;
            if (bgColor === 'rgb(248, 250, 252)' || bgColor === 'rgba(248, 250, 252, 1)') {
                el.style.setProperty('background-color', '#0f172a', 'important');
            }
        }
    });
    
    // Also apply to body and html
    document.body.style.setProperty('background-color', '#0f172a', 'important');
    document.documentElement.style.setProperty('background-color', '#0f172a', 'important');
}

// Apply light mode (remove inline styles)
function applyLightMode() {
    const allElements = document.querySelectorAll('*');
    allElements.forEach(el => {
        const bgColor = el.style.backgroundColor;
        if (bgColor && (bgColor.includes('#1e293b') || 
            bgColor.includes('#0f172a') || 
            bgColor.includes('#334155') ||
            bgColor.includes('rgb(30, 41, 59)') ||
            bgColor.includes('rgb(15, 23, 42)') ||
            bgColor.includes('rgb(51, 65, 85)'))) {
            el.style.removeProperty('background-color');
        }
    });
    
    // Reset body and html
    document.body.style.removeProperty('background-color');
    document.documentElement.style.removeProperty('background-color');
}

// Watch for new elements and apply dark mode automatically
let darkModeObserver = null;

function startDarkModeObserver() {
    if (darkModeObserver) {
        darkModeObserver.disconnect();
    }
    
    darkModeObserver = new MutationObserver((mutations) => {
        if (document.body.classList.contains('dark-mode')) {
            applyDarkMode();
        }
    });
    
    darkModeObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
    });
}

function updateThemeIcon(isDark) {
    const icon = document.getElementById('theme-icon');
    if (!icon) return;
    
    if (isDark) {
        // Moon icon for dark mode
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />';
    } else {
        // Sun icon for light mode
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />';
    }
}

// Load theme from localStorage on page load
document.addEventListener('DOMContentLoaded', function() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        updateThemeIcon(true);
        // Apply dark mode after a short delay to ensure DOM is ready
        setTimeout(() => {
            applyDarkMode();
            startDarkModeObserver();
        }, 100);
    } else {
        updateThemeIcon(false);
    }
    
    // Start observer for dynamic content
    startDarkModeObserver();
    hydrateSideMenus();
    initSideMenuNavigation();
    initExpiringSortControl();
    initSideMenuToggle();
    setSideMenuActiveBySection('section-dashboard');
    
    // Search functionality
    const searchInput = document.getElementById('search-subscribers');
    if (searchInput) {
        searchInput.addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            const rows = document.querySelectorAll('#subscribers-table-body tr');
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                if (text.includes(searchTerm)) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            });
        });
    }
});


