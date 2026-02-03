

// =================================================================
// 1. التحميل اليدوي لمتغيرات البيئة
// =================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // Built-in crypto for hashing

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

// Helper: Hash Password using SHA256 (Secure enough for this context without external bcrypt)
const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
};

// =========================================================
// 🔄 AUTH ROUTES (Google & Real Email/Password)
// =========================================================

// 🟢 تسجيل حساب جديد (STRICT SIGNUP)
app.post('/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // 1. Validation Rules
        if (!name || !email || !password) {
            return res.status(400).json({ message: "جميع الحقول مطلوبة" });
        }

        const lowerEmail = email.toLowerCase();

        // Email Validation: Ends with @gmail.com, Prefix > 4 English letters
        const emailRegex = /^[a-zA-Z]{5,}@gmail\.com$/;
        if (!emailRegex.test(lowerEmail)) {
            return res.status(400).json({ 
                message: "البريد الإلكتروني يجب أن ينتهي بـ @gmail.com ويتكون الاسم قبله من أكثر من 4 حروف إنجليزية فقط." 
            });
        }

        // Password Validation: Min 4 chars, English letters, numbers, @ only
        const passwordRegex = /^[a-zA-Z0-9@]{4,}$/;
        if (!passwordRegex.test(password)) {
            return res.status(400).json({ 
                message: "كلمة المرور يجب أن تكون 4 خانات على الأقل وتحتوي فقط على حروف إنجليزية، أرقام، أو رمز @" 
            });
        }

        // 2. Check Uniqueness
        const existingUser = await User.findOne({ 
            $or: [{ email: lowerEmail }, { name: name }] 
        });
        
        if (existingUser) {
            if (existingUser.email === lowerEmail) {
                return res.status(400).json({ message: "البريد الإلكتروني مستخدم بالفعل." });
            }
            return res.status(400).json({ message: "اسم المستخدم موجود بالفعل." });
        }

        // 3. Create User
        const localId = `local_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        let role = 'user';
        if (ADMIN_EMAILS.includes(lowerEmail)) role = 'admin';

        const newUser = new User({
            googleId: localId,
            email: lowerEmail,
            name: name,
            password: hashPassword(password), // Storing Hashed Password
            role: role,
            picture: '', 
            createdAt: new Date()
        });

        await newUser.save();
        await new Settings({ user: newUser._id }).save();

        // 4. Generate Token
        const payload = { id: newUser._id, googleId: newUser.googleId, name: newUser.name, email: newUser.email, role: newUser.role };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '365d' });

        res.json({ token, user: newUser });

    } catch (error) {
        console.error("Signup Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 🔵 تسجيل الدخول (STRICT LOGIN)
app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: "البريد الإلكتروني وكلمة المرور مطلوبان" });

        const lowerEmail = email.toLowerCase();

        // 1. Find User by Email
        const user = await User.findOne({ email: lowerEmail });
        
        if (!user) {
            // IMPORTANT: Return 404 so frontend knows to prompt signup
            return res.status(404).json({ message: "الحساب غير موجود." });
        }

        // 2. Verify Password
        if (!user.password) {
            return res.status(400).json({ message: "هذا الحساب مسجل عبر Google، يرجى الدخول باستخدامه." });
        }

        const hashedInput = hashPassword(password);
        
        // STRICT CHECK: Hashes MUST MATCH EXACTLY
        if (user.password !== hashedInput) {
            return res.status(401).json({ message: "كلمة المرور غير صحيحة." });
        }

        // 3. Generate Token if successful
        const payload = { id: user._id, googleId: user.googleId, name: user.name, email: user.email, role: user.role };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '365d' });
        
        res.json({ token, user });

    } catch (error) {
        console.error("Login Error:", error);
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

// تحميل مسارات الإدارة
require('./routes/adminRoutes')(app, verifyToken, verifyAdmin, upload);

// 🔥 تحميل مسارات المترجم الذكي الجديدة 🔥
require('./routes/translatorRoutes')(app, verifyToken, verifyAdmin);

// تحميل المسارات العامة
require('./routes/publicRoutes')(app, verifyToken, upload);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
