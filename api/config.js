// Database Configuration for XAMPP MySQL
const path = require('path');
const fs = require('fs');

// Try to load .env from multiple locations
const homeDir = process.env.HOME || process.env.USERPROFILE || require('os').homedir() || '';
const envPaths = [
    path.join(__dirname, '.env'),           // api/.env
    path.join(__dirname, '..', '.env'),    // project root .env
    homeDir ? path.join(homeDir, '.env') : null,  // home directory .env
    '/var/www/ftth_control_deck/.env',     // server project root
    '/var/www/ftth_control_deck/api/.env'  // server api folder
].filter(Boolean); // Remove null values

let envLoaded = false;
for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
        require('dotenv').config({ path: envPath });
        console.log(`[CONFIG] ✅ Loaded .env from: ${envPath}`);
        envLoaded = true;
        break;
    }
}

// If no .env found, try default location
if (!envLoaded) {
    console.log(`[CONFIG] ⚠️  No .env file found in: ${envPaths.join(', ')}`);
    console.log(`[CONFIG] ⚠️  Trying default dotenv.config()...`);
    require('dotenv').config();
}

// Debug: Show what environment variables are loaded
if (process.env.DB_PASSWORD) {
    console.log(`[CONFIG] ✅ DB_PASSWORD is set (length: ${process.env.DB_PASSWORD.length})`);
} else {
    console.log(`[CONFIG] ❌ DB_PASSWORD is NOT set!`);
}

function parseHeadersEnv(value) {
    if (!value || typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    // حاول أولاً تفسير القيمة كـ JSON
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch (error) {
            console.warn('[CONFIG] فشل تحليل ترويسة JSON مخصّصة:', error.message);
        }
    }

    // fallback: صيغة شبيهة بنسخ DevTools (سطر لكل رأس)
    const headerObject = {};
    const lines = trimmed.replace(/\r/g, '').split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;
        const separatorIndex = line.indexOf(':');
        if (separatorIndex === -1) continue;
        const key = line.slice(0, separatorIndex).trim();
        const valuePart = line.slice(separatorIndex + 1).trim();
        if (key) {
            headerObject[key] = valuePart;
        }
    }

    return Object.keys(headerObject).length > 0 ? headerObject : null;
}

let extraHeaders = {};
if (process.env.ALWATANI_EXTRA_HEADERS) {
    try {
        const parsed = JSON.parse(process.env.ALWATANI_EXTRA_HEADERS);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            extraHeaders = parsed;
        } else {
            console.warn('[CONFIG] ALWATANI_EXTRA_HEADERS يجب أن يكون JSON كائن (مثال: {"Header-Name":"value"})');
        }
    } catch (error) {
        console.warn('[CONFIG] فشل تحليل ALWATANI_EXTRA_HEADERS:', error.message);
    }
}

const overrideHeaders =
    parseHeadersEnv(process.env.ALWATANI_FULL_HEADERS ||
        process.env.ALWATANI_BASE_HEADERS ||
        process.env.ALWATANI_OVERRIDE_HEADERS);

let headersMode = (process.env.ALWATANI_HEADERS_MODE || 'merge').toLowerCase();
if (!['merge', 'replace'].includes(headersMode)) {
    console.warn('[CONFIG] ALWATANI_HEADERS_MODE يجب أن يكون merge أو replace. سيتم استخدام merge.');
    headersMode = 'merge';
}

module.exports = {
    db: {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'ftth_control_deck',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    },
    master: {
        // قاعدة البيانات الرئيسية - تخزن معلومات جميع المالكين
        database: 'ftth_master'
    },
    server: {
        port: process.env.PORT || 3000
    },
    alwatani: {
        cookies: process.env.ALWATANI_COOKIES || '',
        extraHeaders,
        overrideHeaders,
        headersMode
    }
};


