
// =================================================================
// 1. التحميل اليدوي لمتغيرات البيئة
// =================================================================
const fs = require('fs');
const path = require('path');

try {
    const envConfig = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    envConfig.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) {
            process.env[key.trim()] = value.trim();
        }
    });
    console.log('✅ Environment variables loaded manually.');
} catch (error) {
    console.warn('⚠️  Could not find .env file. Using platform environment variables instead.');
}

const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const multer = require('multer');

// Models (Required for Auth here)
const User = require('./models/user.model.js');
const Settings = require('./models/settings.model.js');

const app = express();

// 🔥 قائمة الأدمن المسموح بهم حصراً 🔥
const ADMIN_EMAILS = ["flaf.aboode@gmail.com", "zeus", "zeus@gmail.com"];

// إعداد Multer للتعامل مع رفع الصور في الذاكرة
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Database Connection
let cachedDb = null;
async function connectToDatabase() {
    if (cachedDb) return cachedDb;
    try {
        const db = await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
        });
        cachedDb = db;
        console.log("✅ Connected to MongoDB Atlas");
        return db;
    } catch (error) {
        console.error("❌ MongoDB connection error:", error);
        throw error;
    }
}
connectToDatabase();

app.use(async (req, res, next) => {
    if (!cachedDb) await connectToDatabase();
    next();
});

// Middleware Definitions
function verifyToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid token' });
        req.user = user;
        next();
    });
}

async function verifyAdmin(req, res, next) {
    verifyToken(req, res, async () => {
        const user = await User.findById(req.user.id);
        if (user && (user.role === 'admin' || user.role === 'contributor')) {
             next();
        } else {
            res.status(403).json({ message: 'Admin/Contributor access required' });
        }
    });
}

// =========================================================
// 🔄 AUTH ROUTES (Google & Test)
// =========================================================

// 🧪 TEST AUTH API (للاختبار فقط)
app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email) return res.status(400).json({ message: "البريد الإلكتروني مطلوب" });

        let user = await User.findOne({ email });
        let role = 'user';
        const lowerEmail = email.toLowerCase();
        if (ADMIN_EMAILS.includes(lowerEmail)) role = 'admin';

        if (!user) {
            let proposedName = email.split('@')[0];
            let counter = 1;
            while(await User.findOne({ name: proposedName })) {
                proposedName = `${email.split('@')[0]}_${counter}`;
                counter++;
            }
            user = new User({
                googleId: `test_${Date.now()}`, 
                email: email,
                name: proposedName, 
                picture: '',
                role: role,
                createdAt: new Date()
            });
            await user.save();
            await new Settings({ user: user._id }).save();
        } else {
            if (role === 'admin' && user.role !== 'admin') {
                user.role = 'admin';
                await user.save();
            }
        }
        const payload = { id: user._id, googleId: user.googleId, name: user.name, email: user.email, role: user.role };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '365d' });
        res.json({ token, user });
    } catch (error) {
        console.error("Test Login Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://c-production-3db6.up.railway.app/auth/google/callback" 
);

app.get('/auth/google', (req, res) => {
    const redirectUri = req.query.redirect_uri;
    const platform = req.query.platform;
    let state = redirectUri || (platform === 'mobile' ? 'mobile' : 'web');
    const authorizeUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: 'https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
        state: state 
    });
    res.redirect(authorizeUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    try {
        await connectToDatabase();
        const { code, state } = req.query;
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        const userInfoResponse = await oauth2Client.request({ url: 'https://www.googleapis.com/oauth2/v3/userinfo' });
        const userInfo = userInfoResponse.data;
        let user = await User.findOne({ googleId: userInfo.sub });
        let role = 'user';
        const lowerEmail = userInfo.email.toLowerCase();
        if (ADMIN_EMAILS.includes(lowerEmail)) role = 'admin';
        if (!user) {
            let proposedName = userInfo.name;
            let counter = 1;
            while(await User.findOne({ name: proposedName })) {
                proposedName = `${userInfo.name}_${counter}`;
                counter++;
            }
            user = new User({
                googleId: userInfo.sub,
                email: userInfo.email,
                name: proposedName,
                picture: userInfo.picture,
                role: role,
                createdAt: new Date() 
            });
            await user.save();
            await new Settings({ user: user._id }).save();
        } else {
             if (role === 'admin' && user.role !== 'admin') {
                user.role = 'admin';
                await user.save();
            }
        }
        const payload = { id: user._id, googleId: user.googleId, name: user.name, email: user.email, role: user.role };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '365d' });
        if (state && state.startsWith('exp://')) {
            const separator = state.includes('?') ? '&' : '?';
            res.redirect(`${state}${separator}token=${token}`);
        } else if (state === 'mobile' || state.startsWith('aplcionszeus://')) {
            const deepLink = state === 'mobile' ? `aplcionszeus://auth?token=${token}` : `${state}?token=${token}`;
            res.redirect(deepLink);
        } else {
            res.redirect(`https://c-production-3db6.up.railway.app/?token=${token}`);
        }
    } catch (error) {
        console.error('Auth error:', error);
        res.redirect('https://c-production-3db6.up.railway.app/?auth_error=true');
    }
});

app.get('/api/user', verifyToken, async (req, res) => {
    const user = await User.findById(req.user.id);
    res.json({ loggedIn: true, user: user });
});

// =========================================================
// 🔗 MOUNT ROUTES
// =========================================================

// تحميل مسارات الإدارة (Admin, Scraper, Bulk Upload)
require('./routes/adminRoutes')(app, verifyToken, verifyAdmin, upload);

// تحميل المسارات العامة (Public, Reader, Comments, Library)
require('./routes/publicRoutes')(app, verifyToken, upload);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
