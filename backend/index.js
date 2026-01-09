
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

const http = require('http');
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const multer = require('multer'); // إضافة Multer لرفع الملفات
const AdmZip = require('adm-zip'); // إضافة مكتبة فك الضغط

// --- Config Imports ---
let firestore, cloudinary;
try {
    const firebaseAdmin = require('./config/firebaseAdmin');
    firestore = firebaseAdmin.db;
    cloudinary = require('./config/cloudinary');
} catch (e) {
    console.warn("⚠️ Config files check failed...");
}

// Models
const User = require('./models/user.model.js');
const Novel = require('./models/novel.model.js');
const NovelLibrary = require('./models/novelLibrary.model.js'); 
const Settings = require('./models/settings.model.js');
const Comment = require('./models/comment.model.js'); // 🔥 Import Comment Model

// 🔥 MODEL FOR SCRAPER LOGS (للتتبع المباشر)
const ScraperLogSchema = new mongoose.Schema({
    message: String,
    type: { type: String, default: 'info' }, // info, success, error, warning
    timestamp: { type: Date, default: Date.now }
});
// حذف النموذج القديم إذا وجد لتجنب التعارض
if (mongoose.models.ScraperLog) delete mongoose.models.ScraperLog;
const ScraperLog = mongoose.model('ScraperLog', ScraperLogSchema);

const app = express();

// 🔥 قائمة الأدمن المسموح بهم حصراً 🔥
const ADMIN_EMAILS = ["flaf.aboode@gmail.com", "zeus", "zeus@gmail.com"];

// إعداد Multer للتعامل مع رفع الصور في الذاكرة
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

app.use(express.json({ limit: '50mb' }));

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

// الاتصال بقاعدة البيانات عند بدء التشغيل (مهم لـ Railway)
connectToDatabase();

app.use(async (req, res, next) => {
    if (!cachedDb) {
        await connectToDatabase();
    }
    next();
});

// Helper Function for Logging to DB
async function logScraper(message, type = 'info') {
    try {
        console.log(`[Scraper Log] ${message}`);
        await ScraperLog.create({ message, type, timestamp: new Date() });
        // Keep only last 100 logs to save space
        const count = await ScraperLog.countDocuments();
        if (count > 100) {
            const first = await ScraperLog.findOne().sort({ timestamp: 1 });
            if (first) await ScraperLog.deleteOne({ _id: first._id });
        }
    } catch (e) {
        console.error("Log error", e);
    }
}

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
             // السماح للداعمين والمشرفين بالوصول لنقاط النهاية هذه
             next();
        } else {
            res.status(403).json({ message: 'Admin/Contributor access required' });
        }
    });
}

// Helper to check and update status automatically
async function checkNovelStatus(novel) {
    if (novel.status === 'مكتملة') return novel; // المكتملة لا تتغير

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // إذا مر 30 يوم والحالة مستمرة، حولها لمتوقفة
    if (novel.lastChapterUpdate < thirtyDaysAgo && novel.status === 'مستمرة') {
        novel.status = 'متوقفة';
        await novel.save();
    }
    return novel;
}

// =========================================================
// 📜 SCRAPER LOGS API
// =========================================================

// مسح السجلات
app.delete('/api/scraper/logs', async (req, res) => {
    try {
        await ScraperLog.deleteMany({});
        res.json({ message: "Logs cleared" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// جلب السجلات
app.get('/api/scraper/logs', async (req, res) => {
    try {
        const logs = await ScraperLog.find().sort({ timestamp: -1 }).limit(100);
        res.json(logs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ✅ نقطة البداية (Init) - لضمان استجابة فورية
app.post('/api/scraper/init', async (req, res) => {
    try {
        const { url, userEmail } = req.body;
        await ScraperLog.deleteMany({}); // تنظيف القديم
        
        if (userEmail) {
            const user = await User.findOne({ email: userEmail });
            if (user) await logScraper(`👤 المستخدم: ${user.name}`, 'info');
        }

        await logScraper(`🚀 بدء عملية استيراد جديدة...`, 'info');
        await logScraper(`🔗 الرابط المستهدف: ${url}`, 'info');
        await logScraper(`⏳ جاري الاتصال بخدمة السحب (Python Scraper)...`, 'warning');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ✅ تسجيل خطأ من العميل (App) إذا فشل الاتصال بالسكرابر
app.post('/api/scraper/log', async (req, res) => {
    try {
        const { message, type } = req.body;
        await logScraper(message, type || 'info');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =========================================================
// 🕷️ SCRAPER WEBHOOK (بوابة استقبال البيانات من السكرابر)
// =========================================================
app.post('/api/scraper/receive', async (req, res) => {
    const secret = req.headers['authorization'] || req.headers['x-api-secret'];
    const VALID_SECRET = 'Zeusndndjddnejdjdjdejekk29393838msmskxcm9239484jdndjdnddjj99292938338zeuslojdnejxxmejj82283849';
    
    if (secret !== VALID_SECRET) {
        await logScraper("محاولة وصول غير مصرح بها للـ Webhook", 'error');
        return res.status(403).json({ message: "Unauthorized: Invalid Secret" });
    }

    try {
        const { adminEmail, novelData, chapters, error } = req.body;

        // إذا أرسل السكرابر خطأ
        if (error) {
            await logScraper(`❌ خطأ من السكرابر: ${error}`, 'error');
            return res.status(400).json({ message: error });
        }

        await logScraper(`📥 وصل رد من السكرابر! تحليل البيانات...`, 'info');

        if (!adminEmail || !novelData || !novelData.title) {
            await logScraper("❌ بيانات ناقصة في الطلب", 'error');
            return res.status(400).json({ message: "Missing required data" });
        }

        // 2. البحث عن المستخدم (الأدمن) لربط الرواية به
        const user = await User.findOne({ email: adminEmail });
        if (!user) {
            await logScraper(`❌ المستخدم ${adminEmail} غير موجود في النظام`, 'error');
            return res.status(404).json({ message: `User with email ${adminEmail} not found` });
        }

        // 3. البحث عن الرواية أو إنشاؤها
        let novel = await Novel.findOne({ title: novelData.title });

        // 🔥🔥🔥 CLOUDINARY UPLOAD LOGIC 🔥🔥🔥
        // إذا كان هناك رابط صورة ولم يكن رابط Cloudinary، نقوم برفعه للحصول على رابط ثابت
        if (novelData.cover && !novelData.cover.includes('cloudinary') && cloudinary) {
            try {
                await logScraper(`🖼️ جاري رفع غلاف الرواية إلى Cloudinary...`, 'info');
                const uploadRes = await cloudinary.uploader.upload(novelData.cover, {
                    folder: 'novels_covers',
                    resource_type: 'image'
                });
                // تحديث الرابط بالرابط الجديد الآمن
                novelData.cover = uploadRes.secure_url;
                await logScraper(`✅ تم رفع الغلاف بنجاح: ${novelData.cover}`, 'success');
            } catch (imgErr) {
                await logScraper(`⚠️ فشل رفع الغلاف إلى Cloudinary: ${imgErr.message}`, 'warning');
                // نستمر باستخدام الرابط الأصلي في حالة الفشل
            }
        }

        if (!novel) {
            // إنشاء رواية جديدة
            await logScraper(`✨ جاري إنشاء رواية جديدة: ${novelData.title}`, 'info');
            novel = new Novel({
                title: novelData.title,
                cover: novelData.cover,
                description: novelData.description,
                author: user.name, // ربط الرواية باسم المستخدم
                authorEmail: user.email,
                category: novelData.category || 'أخرى',
                tags: novelData.tags || [],
                status: 'مستمرة',
                chapters: [],
                views: 0
            });
            await novel.save();
            await logScraper(`✅ تم إنشاء صفحة الرواية بنجاح`, 'success');
        } else {
            // تحديث البيانات إذا كانت موجودة
            await logScraper(`🔄 الرواية موجودة بالفعل، جاري تحديث البيانات...`, 'warning');
            if (!novel.cover && novelData.cover) novel.cover = novelData.cover;
            if (novelData.cover && novelData.cover.includes('cloudinary') && novel.cover !== novelData.cover) {
                 // Update cover if new one is cloudinary and different
                 novel.cover = novelData.cover;
            }
            if (!novel.description && novelData.description) novel.description = novelData.description;
            // ضمان تحديث المؤلف إذا كان مفقوداً
            if (!novel.authorEmail) {
                novel.author = user.name;
                novel.authorEmail = user.email;
            }
            await novel.save();
        }

        // 4. معالجة الفصول وإضافتها
        if (chapters && Array.isArray(chapters) && chapters.length > 0) {
            let addedCount = 0;
            // await logScraper(`📚 جاري معالجة ${chapters.length} فصل...`, 'info');

            for (const chap of chapters) {
                // التأكد من عدم تكرار الفصل
                const existingChap = novel.chapters.find(c => c.number === chap.number);

                if (!existingChap) {
                    // أ) حفظ المحتوى في Firestore (للقراءة)
                    if (firestore) {
                        await firestore.collection('novels').doc(novel._id.toString())
                            .collection('chapters').doc(chap.number.toString()).set({
                                title: chap.title,
                                content: chap.content, // المحتوى النصي من السكرابر
                                lastUpdated: new Date()
                            });
                    }

                    // ب) إضافة بيانات الفصل الوصفية في MongoDB
                    novel.chapters.push({
                        number: chap.number,
                        title: chap.title,
                        createdAt: new Date(),
                        views: 0
                    });
                    addedCount++;
                }
            }

            if (addedCount > 0) {
                // ترتيب الفصول وحفظ الرواية
                novel.chapters.sort((a, b) => a.number - b.number);
                novel.lastChapterUpdate = new Date();
                await novel.save();
                await logScraper(`✅ تم حفظ ${addedCount} فصل جديد في قاعدة البيانات`, 'success');
            } else {
                if (chapters.length > 0) {
                   await logScraper(`⚠️ تم استلام ${chapters.length} فصل، لكنها موجودة مسبقاً`, 'info');
                }
            }
        } else {
            // لا حاجة لطباعة تحذير إذا كانت القائمة فارغة (قد تكون مرحلة أولية لإنشاء الرواية فقط)
            if (chapters && chapters.length === 0) {
                await logScraper(`ℹ️ تم تحديث بيانات الرواية الأساسية`, 'info');
            }
        }

        res.json({ success: true, novelId: novel._id, message: "Data processed successfully" });

    } catch (error) {
        console.error("Scraper Receiver Error:", error);
        await logScraper(`❌ خطأ فادح في الخادم: ${error.message}`, 'error');
        res.status(500).json({ error: error.message });
    }
});

// =========================================================
// 🎭 NOVEL REACTIONS API
// =========================================================
app.post('/api/novels/:novelId/react', verifyToken, async (req, res) => {
    try {
        const { type } = req.body; // 'like', 'love', 'funny', 'sad', 'angry'
        const validTypes = ['like', 'love', 'funny', 'sad', 'angry'];
        
        if (!validTypes.includes(type)) return res.status(400).json({message: "Invalid reaction type"});

        const novel = await Novel.findById(req.params.novelId);
        if (!novel) return res.status(404).json({message: "Novel not found"});

        const userId = req.user.id;

        if (!novel.reactions) {
            novel.reactions = { like: [], love: [], funny: [], sad: [], angry: [] };
        }
        
        let added = false;

        if (novel.reactions[type].includes(userId)) {
            novel.reactions[type].pull(userId);
        } else {
            validTypes.forEach(t => {
                if (novel.reactions[t].includes(userId)) {
                    novel.reactions[t].pull(userId);
                }
            });
            novel.reactions[type].push(userId);
            added = true;
        }

        await novel.save();

        const stats = {
            like: novel.reactions.like.length,
            love: novel.reactions.love.length,
            funny: novel.reactions.funny.length,
            sad: novel.reactions.sad.length,
            angry: novel.reactions.angry.length,
            userReaction: added ? type : null 
        };

        res.json(stats);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =========================================================
// 💬 COMMENTS API (Updated for Chapters)
// =========================================================

// Get Comments & Stats
app.get('/api/novels/:novelId/comments', async (req, res) => {
    try {
        const { novelId } = req.params;
        const { sort = 'newest', page = 1, limit = 20, chapterNumber } = req.query;
        
        // 1. Get Novel Stats (Reactions) - Only relevant for novel page, but kept for compatibility
        const novel = await Novel.findById(novelId).select('reactions');
        let stats = { like: 0, love: 0, funny: 0, sad: 0, angry: 0, total: 0, userReaction: null };
        
        if (novel && novel.reactions) {
            stats.like = novel.reactions.like?.length || 0;
            stats.love = novel.reactions.love?.length || 0;
            stats.funny = novel.reactions.funny?.length || 0;
            stats.sad = novel.reactions.sad?.length || 0;
            stats.angry = novel.reactions.angry?.length || 0;
            stats.total = stats.like + stats.love + stats.funny + stats.sad + stats.angry;
        }

        // 2. Build Query
        let query = { novelId, parentId: null };
        
        // 🔥 Strict filtering: If chapterNumber is provided, get ONLY that chapter's comments.
        // If NOT provided, get ONLY general novel comments (chapterNumber: null).
        if (chapterNumber) {
            query.chapterNumber = parseInt(chapterNumber);
        } else {
            query.chapterNumber = null; // or { $exists: false } if migrating old data
        }

        let sortOption = { createdAt: -1 };
        if (sort === 'oldest') sortOption = { createdAt: 1 };
        if (sort === 'best') sortOption = { likes: -1 }; 

        const comments = await Comment.find(query)
            .populate('user', 'name picture role isCommentBlocked')
            .populate({ path: 'replyCount' })
            .sort(sortOption)
            .skip((page - 1) * limit)
            .limit(parseInt(limit));

        // 🔥 Fix for Deleted Users: Filter out comments where user is null (prevents frontend crash)
        const validComments = comments.filter(c => c.user !== null);

        const totalComments = await Comment.countDocuments(query);

        res.json({ 
            comments: validComments, 
            totalComments,
            stats 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get Replies
app.get('/api/comments/:commentId/replies', async (req, res) => {
    try {
        const replies = await Comment.find({ parentId: req.params.commentId })
            .populate('user', 'name picture role')
            .sort({ createdAt: 1 });
        
        // Filter null users here too
        res.json(replies.filter(r => r.user !== null));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Post Comment (Supports Chapter)
app.post('/api/comments', verifyToken, async (req, res) => {
    try {
        const { novelId, content, parentId, chapterNumber } = req.body;
        
        const currentUser = await User.findById(req.user.id);
        if (currentUser.isCommentBlocked) {
            return res.status(403).json({ message: "أنت ممنوع من التعليق." });
        }

        if (!content || !content.trim()) return res.status(400).json({message: "Content required"});

        const newComment = new Comment({
            novelId,
            user: req.user.id,
            content: content.trim(),
            parentId: parentId || null,
            chapterNumber: chapterNumber ? parseInt(chapterNumber) : null // 🔥 Save chapter number
        });

        await newComment.save();
        await newComment.populate('user', 'name picture role');

        res.json(newComment);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔥 Update Comment (Edit)
app.put('/api/comments/:commentId', verifyToken, async (req, res) => {
    try {
        const { content } = req.body;
        const comment = await Comment.findById(req.params.commentId);
        
        if (!comment) return res.status(404).json({message: "Comment not found"});
        
        // Ensure ownership
        if (comment.user.toString() !== req.user.id) {
            return res.status(403).json({message: "Unauthorized"});
        }

        comment.content = content;
        comment.isEdited = true;
        await comment.save();
        
        await comment.populate('user', 'name picture role');
        res.json(comment);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Like/Dislike
app.post('/api/comments/:commentId/action', verifyToken, async (req, res) => {
    try {
        const { action } = req.body; 
        const userId = req.user.id;
        const comment = await Comment.findById(req.params.commentId);
        
        if (!comment) return res.status(404).json({message: "Comment not found"});

        if (action === 'like') {
            comment.dislikes.pull(userId);
            if (comment.likes.includes(userId)) {
                comment.likes.pull(userId);
            } else {
                comment.likes.addToSet(userId);
            }
        } else if (action === 'dislike') {
            comment.likes.pull(userId);
            if (comment.dislikes.includes(userId)) {
                comment.dislikes.pull(userId);
            } else {
                comment.dislikes.addToSet(userId);
            }
        }

        await comment.save();
        res.json({ likes: comment.likes.length, dislikes: comment.dislikes.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete
app.delete('/api/comments/:commentId', verifyToken, async (req, res) => {
    try {
        const comment = await Comment.findById(req.params.commentId);
        if (!comment) return res.status(404).json({message: "Not found"});

        if (comment.user.toString() !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({message: "Unauthorized"});
        }

        await Comment.deleteMany({ parentId: comment._id });
        await Comment.findByIdAndDelete(req.params.commentId);

        res.json({ message: "Deleted" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Block User Comments
app.put('/api/admin/users/:id/block-comment', verifyAdmin, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: "Access Denied" });
    try {
        const { block } = req.body;
        const user = await User.findByIdAndUpdate(req.params.id, { isCommentBlocked: block }, { new: true });
        res.json({ message: block ? "User blocked from comments" : "User unblocked", user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// =========================================================
// 🧪 TEST AUTH API (للاختبار فقط)
// =========================================================
app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email) return res.status(400).json({ message: "البريد الإلكتروني مطلوب" });

        let user = await User.findOne({ email });
        let role = 'user';
        
        const lowerEmail = email.toLowerCase();
        if (ADMIN_EMAILS.includes(lowerEmail)) {
            role = 'admin';
        }

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

// =========================================================
// 🖼️ UPLOAD API
// =========================================================
app.post('/api/upload', verifyToken, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        const b64 = Buffer.from(req.file.buffer).toString('base64');
        let dataURI = "data:" + req.file.mimetype + ";base64," + b64;
        
        const result = await cloudinary.uploader.upload(dataURI, {
            folder: "zeus_user_uploads",
            resource_type: "image"
        });

        res.json({ url: result.secure_url });
    } catch (error) {
        console.error("Upload Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// =========================================================
// 🚀 BULK UPLOAD API (النشر المتعدد)
// =========================================================
app.post('/api/admin/chapters/bulk-upload', verifyAdmin, upload.single('zip'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: "No ZIP file uploaded" });
        const { novelId } = req.body;
        
        if (!novelId) return res.status(400).json({ message: "Novel ID required" });

        const novel = await Novel.findById(novelId);
        if (!novel) return res.status(404).json({ message: "Novel not found" });

        if (req.user.role !== 'admin') {
            if (novel.authorEmail !== req.user.email) {
                return res.status(403).json({ message: "لا تملك صلاحية النشر لهذه الرواية" });
            }
        }

        const zip = new AdmZip(req.file.buffer);
        const zipEntries = zip.getEntries();
        
        let successCount = 0;
        let errors = [];
        
        for (const entry of zipEntries) {
            if (entry.isDirectory || !entry.entryName.endsWith('.txt')) continue;

            try {
                const fileName = path.basename(entry.entryName, '.txt');
                const chapterNumber = parseInt(fileName);

                if (isNaN(chapterNumber)) {
                    errors.push(`تخطي الملف ${entry.entryName}: الاسم ليس رقماً`);
                    continue;
                }

                const fullText = zip.readAsText(entry, 'utf8');
                const lines = fullText.split('\n');
                
                if (lines.length === 0) continue;

                const firstLine = lines[0].trim();
                let chapterTitle = firstLine;
                
                const colonIndex = firstLine.indexOf(':');
                if (colonIndex > -1) {
                    chapterTitle = firstLine.substring(colonIndex + 1).trim();
                }
                
                if (!chapterTitle) chapterTitle = firstLine;

                const content = lines.slice(1).join('\n').trim();

                if (firestore) {
                    await firestore.collection('novels').doc(novelId).collection('chapters').doc(chapterNumber.toString()).set({
                        title: chapterTitle,
                        content: content,
                        lastUpdated: new Date()
                    });
                } else {
                    throw new Error("Firebase not configured");
                }

                const chapterMeta = { 
                    number: chapterNumber, 
                    title: chapterTitle, 
                    createdAt: new Date(), 
                    views: 0 
                };

                const existingIndex = novel.chapters.findIndex(c => c.number === chapterNumber);
                if (existingIndex > -1) {
                    novel.chapters[existingIndex].title = chapterTitle;
                } else {
                    novel.chapters.push(chapterMeta);
                }

                successCount++;

            } catch (err) {
                console.error(`Error processing ${entry.entryName}:`, err);
                errors.push(`خطأ في ملف ${entry.entryName}`);
            }
        }

        if (successCount > 0) {
            novel.chapters.sort((a, b) => a.number - b.number);
            novel.lastChapterUpdate = new Date();
            if (novel.status === 'متوقفة') novel.status = 'مستمرة';
            await novel.save();
        }

        res.json({ 
            message: `تمت المعالجة. نجح: ${successCount}، فشل: ${errors.length}`,
            errors: errors,
            successCount
        });

    } catch (error) {
        console.error("Bulk Upload Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// =========================================================
// 👤 USER PROFILE API
// =========================================================

// Update Profile Info
app.put('/api/user/profile', verifyToken, async (req, res) => {
    try {
        const { name, bio, banner, picture, isHistoryPublic } = req.body;
        
        const updates = {};
        
        if (name && name !== req.user.name) {
             const existing = await User.findOne({ name: name });
             if (existing) {
                 return res.status(400).json({ message: "اسم المستخدم هذا مستخدم بالفعل." });
             }
             updates.name = name;
        }
        
        if (bio !== undefined) updates.bio = bio;
        if (banner) updates.banner = banner;
        if (picture) updates.picture = picture;
        if (isHistoryPublic !== undefined) updates.isHistoryPublic = isHistoryPublic;

        const updatedUser = await User.findByIdAndUpdate(
            req.user.id,
            { $set: updates },
            { new: true }
        );

        res.json(updatedUser);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get User Profile with Stats
app.get('/api/user/stats', verifyToken, async (req, res) => {
    try {
        let targetUserId = req.user.id;
        let targetUser = null;

        if (req.query.userId) {
            targetUserId = req.query.userId;
            targetUser = await User.findById(targetUserId);
        } else if (req.query.email) {
            targetUser = await User.findOne({ email: req.query.email });
            if (targetUser) targetUserId = targetUser._id;
        } else {
            targetUser = await User.findById(targetUserId);
        }

        if (!targetUser) return res.status(404).json({ message: "User not found" });

        const libraryStats = await NovelLibrary.aggregate([
            { $match: { user: new mongoose.Types.ObjectId(targetUserId) } },
            { $project: { readCount: { $size: { $ifNull: ["$readChapters", []] } } } },
            { $group: { _id: null, totalRead: { $sum: "$readCount" } } }
        ]);
        const totalReadChapters = libraryStats[0] ? libraryStats[0].totalRead : 0;

        let addedChapters = 0;
        let totalViews = 0;
        let myWorks = [];

        myWorks = await Novel.find({ 
            $or: [
                { authorEmail: targetUser.email },
                { author: { $regex: new RegExp(`^${targetUser.name}$`, 'i') } } 
            ]
        });
        
        myWorks.forEach(novel => {
            addedChapters += (novel.chapters ? novel.chapters.length : 0);
            totalViews += (novel.views || 0);
        });
        
        res.json({
            user: {
                _id: targetUser._id,
                name: targetUser.name,
                email: targetUser.email, 
                picture: targetUser.picture,
                banner: targetUser.banner,
                bio: targetUser.bio,
                role: targetUser.role,
                createdAt: targetUser.createdAt,
                isHistoryPublic: targetUser.isHistoryPublic
            },
            readChapters: totalReadChapters,
            addedChapters,
            totalViews,
            myWorks
        });

    } catch (error) {
        console.error("Stats Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// =========================================================
// 👑 USERS MANAGEMENT API (ADMIN ONLY)
// =========================================================

// Get All Users
app.get('/api/admin/users', verifyAdmin, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: "Access Denied" });
    try {
        const users = await User.find({}).sort({ createdAt: -1 });
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update User Role
app.put('/api/admin/users/:id/role', verifyAdmin, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: "Access Denied" });
    try {
        const { role } = req.body;
        if (!['user', 'contributor', 'admin'].includes(role)) return res.status(400).json({message: "Invalid role"});
        
        const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true });
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete User
app.delete('/api/admin/users/:id', verifyAdmin, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ message: "Access Denied" });
    try {
        const targetUserId = req.params.id;
        const deleteContent = req.query.deleteContent === 'true'; 

        if (targetUserId === req.user.id) return res.status(400).json({message: "Cannot delete yourself"});

        const targetUser = await User.findById(targetUserId);
        if (!targetUser) return res.status(404).json({ message: "User not found" });

        // 🔥🔥🔥 Important: Delete Comments when user is deleted 🔥🔥🔥
        await Comment.deleteMany({ user: targetUserId });

        if (deleteContent) {
            const userNovels = await Novel.find({ authorEmail: targetUser.email });
            
            if (firestore && userNovels.length > 0) {
                for (const novel of userNovels) {
                    try {
                        const chaptersRef = firestore.collection('novels').doc(novel._id.toString()).collection('chapters');
                        const snapshot = await chaptersRef.get();
                        if (!snapshot.empty) {
                            const deletePromises = snapshot.docs.map(doc => doc.ref.delete());
                            await Promise.all(deletePromises);
                        }
                        await firestore.collection('novels').doc(novel._id.toString()).delete();
                    } catch (err) {
                        console.error(`Error deleting firestore for novel ${novel._id}`, err);
                    }
                }
            }

            await Novel.deleteMany({ authorEmail: targetUser.email });
        }

        await User.findByIdAndDelete(targetUserId);
        await NovelLibrary.deleteMany({ user: targetUserId });
        await Settings.deleteMany({ user: targetUserId });
        
        res.json({ 
            message: deleteContent 
                ? "User and their works/comments deleted successfully" 
                : "User and comments deleted successfully (works preserved)" 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// =========================================================
// 📝 ADMIN API: الروايات
// =========================================================
app.post('/api/admin/novels', verifyAdmin, async (req, res) => {
    try {
        const { title, cover, description, category, tags, status } = req.body;
        
        const authorName = req.user.name;
        const authorEmail = req.user.email;

        const newNovel = new Novel({
            title, 
            cover, 
            description, 
            author: authorName, 
            authorEmail: authorEmail,
            category, 
            tags,
            chapters: [], 
            views: 0, 
            status: status || 'مستمرة'
        });

        await newNovel.save();
        res.json(newNovel);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/novels/:id', verifyAdmin, async (req, res) => {
    try {
        const { title, cover, description, category, tags, status } = req.body;
        
        const novel = await Novel.findById(req.params.id);
        if (!novel) return res.status(404).json({ message: "Novel not found" });

        if (req.user.role !== 'admin') {
            if (novel.authorEmail !== req.user.email) {
                return res.status(403).json({ message: "لا تملك صلاحية تعديل هذه الرواية" });
            }
        }

        let updateData = { title, cover, description, category, tags, status };

        if (req.user.role === 'admin') {
            updateData.author = req.user.name;
            updateData.authorEmail = req.user.email;
        }
        
        const updated = await Novel.findByIdAndUpdate(req.params.id, updateData, { new: true });
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/novels/:id', verifyAdmin, async (req, res) => {
    try {
        const novelId = req.params.id;
        const novel = await Novel.findById(novelId);
        if (!novel) return res.status(404).json({ message: "Novel not found" });

        if (req.user.role !== 'admin') {
            if (novel.authorEmail !== req.user.email) {
                return res.status(403).json({ message: "لا تملك صلاحية حذف هذه الرواية" });
            }
        }

        if (firestore) {
            try {
                const chaptersRef = firestore.collection('novels').doc(novelId).collection('chapters');
                const snapshot = await chaptersRef.get();
                
                if (!snapshot.empty) {
                    const deletePromises = snapshot.docs.map(doc => doc.ref.delete());
                    await Promise.all(deletePromises);
                }
                
                await firestore.collection('novels').doc(novelId).delete();
                console.log(`✅ Deleted Firestore content for novel: ${novelId}`);
            } catch (fsError) {
                console.error("❌ Firestore deletion error:", fsError);
            }
        }

        await Novel.findByIdAndDelete(novelId);
        await NovelLibrary.deleteMany({ novelId: novelId });
        
        res.json({ message: "Deleted successfully (DB + Content)" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/chapters', verifyAdmin, async (req, res) => {
    try {
        const { novelId, number, title, content } = req.body;
        
        const novel = await Novel.findById(novelId);
        if (!novel) return res.status(404).json({ message: "Novel not found" });

        if (req.user.role !== 'admin') {
            if (novel.authorEmail !== req.user.email) {
                return res.status(403).json({ message: "لا تملك صلاحية الإضافة لهذه الرواية" });
            }
        }

        if (firestore) {
            await firestore.collection('novels').doc(novelId).collection('chapters').doc(number.toString()).set({
                title, content, lastUpdated: new Date()
            });
        }

        const existingChapterIndex = novel.chapters.findIndex(c => c.number == number);
        const chapterMeta = { number: Number(number), title, createdAt: new Date(), views: 0 };

        if (existingChapterIndex > -1) {
            novel.chapters[existingChapterIndex] = { ...novel.chapters[existingChapterIndex].toObject(), ...chapterMeta };
        } else {
            novel.chapters.push(chapterMeta);
        }
        
        novel.lastChapterUpdate = new Date();
        
        if (novel.status === 'متوقفة') {
            novel.status = 'مستمرة';
        }

        novel.markModified('chapters');
        await novel.save();

        res.json({ message: "Chapter saved successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/chapters/:novelId/:number', verifyAdmin, async (req, res) => {
    try {
        const { novelId, number } = req.params;
        const { title, content } = req.body;

        const novel = await Novel.findById(novelId);
        if (!novel) return res.status(404).json({ message: "Novel not found" });

        if (req.user.role !== 'admin') {
            if (novel.authorEmail !== req.user.email) {
                return res.status(403).json({ message: "لا تملك صلاحية تعديل هذا الفصل" });
            }
        }

        if (firestore) {
            await firestore.collection('novels').doc(novelId).collection('chapters').doc(number.toString()).update({
                title, content, lastUpdated: new Date()
            });
        }

        const chapterIndex = novel.chapters.findIndex(c => c.number == number);
        if (chapterIndex > -1) {
            novel.chapters[chapterIndex].title = title;
            novel.markModified('chapters');
            await novel.save();
        }

        res.json({ message: "Chapter updated successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/chapters/:novelId/:number', verifyAdmin, async (req, res) => {
    try {
        const { novelId, number } = req.params;
        const novel = await Novel.findById(novelId);
        if (!novel) return res.status(404).json({ message: "Novel not found" });

        if (req.user.role !== 'admin') {
            if (novel.authorEmail !== req.user.email) {
                return res.status(403).json({ message: "لا تملك صلاحية حذف هذا الفصل" });
            }
        }
        
        novel.chapters = novel.chapters.filter(c => c.number != number);
        await novel.save();

        if (firestore) {
            await firestore.collection('novels').doc(novelId).collection('chapters').doc(number.toString()).delete();
        }

        res.json({ message: "Chapter deleted" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/novels/:id/view', verifyToken, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).send('Invalid ID');
        
        const { chapterNumber } = req.body; 
        
        if (!chapterNumber) {
            return res.status(200).json({ message: 'Chapter number required for view count' });
        }

        const novel = await Novel.findById(req.params.id);
        if (!novel) return res.status(404).send('Novel not found');

        const userId = req.user.id;
        const viewKey = `${userId}_ch_${chapterNumber}`;
        const alreadyViewed = novel.viewedBy.includes(viewKey);

        if (!alreadyViewed) {
            novel.viewedBy.push(viewKey);
            novel.views += 1;
            novel.dailyViews += 1;
            novel.weeklyViews += 1;
            novel.monthlyViews += 1;
            await novel.save();
            return res.status(200).json({ viewed: true, total: novel.views });
        } else {
            return res.status(200).json({ viewed: false, message: 'Already viewed this chapter', total: novel.views });
        }
    } catch (error) { 
        console.error("View Count Error:", error);
        res.status(500).send('Error'); 
    }
});

app.get('/api/novels', async (req, res) => {
    try {
        const { filter, search, category, status, sort, page = 1, limit = 20, timeRange } = req.query;
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;
        let matchStage = {};

        if (search) {
             matchStage.$or = [
                 { title: { $regex: search, $options: 'i' } },
                 { author: { $regex: search, $options: 'i' } }
             ];
        }
        if (category && category !== 'all') {
            matchStage.$or = [{ category: category }, { tags: category }];
        }
        if (status && status !== 'all') {
            matchStage.status = status;
        }
        if (filter === 'latest_updates') {
            matchStage["chapters.0"] = { $exists: true };
        }

        let pipeline = [
            { $match: matchStage },
            { $addFields: { chaptersCount: { $size: { $ifNull: ["$chapters", []] } } } }
        ];

        let sortStage = {};
        if (sort === 'chapters_desc') sortStage = { chaptersCount: -1 };
        else if (sort === 'chapters_asc') sortStage = { chaptersCount: 1 };
        else if (sort === 'title_asc') sortStage = { title: 1 };
        else if (sort === 'title_desc') sortStage = { title: -1 };
        else if (filter === 'latest_updates') sortStage = { lastChapterUpdate: -1 };
        else if (filter === 'latest_added') sortStage = { createdAt: -1 };
        else if (filter === 'featured' || filter === 'trending') {
             if (timeRange === 'day') sortStage = { dailyViews: -1 };
             else if (timeRange === 'week') sortStage = { weeklyViews: -1 };
             else if (timeRange === 'month') sortStage = { monthlyViews: -1 };
             else sortStage = { views: -1 };
        } else {
             sortStage = { chaptersCount: -1 };
        }

        pipeline.push({ $sort: sortStage });

        const result = await Novel.aggregate([
            { $match: matchStage },
            { $addFields: { chaptersCount: { $size: { $ifNull: ["$chapters", []] } } } },
            { $sort: sortStage },
            {
                $facet: {
                    metadata: [{ $count: "total" }],
                    data: [{ $skip: skip }, { $limit: limitNum }]
                }
            }
        ]);

        const novelsData = result[0].data;
        const totalCount = result[0].metadata[0] ? result[0].metadata[0].total : 0;
        const totalPages = Math.ceil(totalCount / limitNum);

        res.json({ novels: novelsData, currentPage: pageNum, totalPages: totalPages, totalNovels: totalCount });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/novels/:id', async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Invalid ID' });
        
        let novelDoc = await Novel.findById(req.params.id);
        if (!novelDoc) return res.status(404).json({ message: 'Novel not found' });
        
        novelDoc = await checkNovelStatus(novelDoc);
        
        const novel = novelDoc.toObject();
        novel.chaptersCount = novel.chapters ? novel.chapters.length : 0;
        
        res.json(novel);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/novels/:novelId/chapters/:chapterId', async (req, res) => {
    try {
        const { novelId, chapterId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(novelId)) return res.status(404).json({ message: 'Invalid ID' });

        const novel = await Novel.findById(novelId);
        if (!novel) return res.status(404).json({ message: 'Novel not found' });

        let chapterMeta = novel.chapters.find(c => c._id.toString() === chapterId) || 
                          novel.chapters.find(c => c.number == chapterId);

        if (!chapterMeta) return res.status(404).json({ message: 'Chapter metadata not found' });

        let content = "لا يوجد محتوى.";
        
        if (firestore) {
            const docRef = firestore.collection('novels').doc(novelId).collection('chapters').doc(chapterMeta.number.toString());
            const docSnap = await docRef.get();
            if (docSnap.exists) {
                content = docSnap.data().content;
            }
        }

        res.json({ 
            ...chapterMeta.toObject(), 
            content: content,
            totalChapters: novel.chapters.length
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Library Logic
app.post('/api/novel/update', verifyToken, async (req, res) => {
    try {
        const { novelId, title, cover, author, isFavorite, lastChapterId, lastChapterTitle } = req.body;
        if (!novelId || !mongoose.Types.ObjectId.isValid(novelId)) return res.status(400).json({ message: 'Invalid ID' });

        const originalNovel = await Novel.findById(novelId);
        const totalChapters = originalNovel ? (originalNovel.chapters.length || 1) : 1;

        let libraryItem = await NovelLibrary.findOne({ user: req.user.id, novelId });
        let isNewFavorite = false;
        let isRemovedFavorite = false;

        if (!libraryItem) {
            libraryItem = new NovelLibrary({ 
                user: req.user.id, novelId, title, cover, author, 
                isFavorite: isFavorite || false, 
                lastChapterId: lastChapterId || 0,
                readChapters: lastChapterId ? [lastChapterId] : [], 
                lastChapterTitle,
                progress: lastChapterId ? Math.round((1 / totalChapters) * 100) : 0
            });
            if (isFavorite) isNewFavorite = true;
        } else {
            if (isFavorite !== undefined) {
                if (isFavorite && !libraryItem.isFavorite) isNewFavorite = true;
                if (!isFavorite && libraryItem.isFavorite) isRemovedFavorite = true;
                libraryItem.isFavorite = isFavorite;
            }
            if (title) libraryItem.title = title;
            if (cover) libraryItem.cover = cover;
            
            if (lastChapterId) {
                libraryItem.lastChapterId = lastChapterId;
                libraryItem.lastChapterTitle = lastChapterTitle;
                libraryItem.readChapters.addToSet(lastChapterId);
                const readCount = libraryItem.readChapters.length;
                libraryItem.progress = Math.min(100, Math.round((readCount / totalChapters) * 100));
            }
            libraryItem.lastReadAt = new Date();
        }
        await libraryItem.save();

        if (isNewFavorite) {
            await Novel.findByIdAndUpdate(novelId, { $inc: { favorites: 1 } });
        } else if (isRemovedFavorite) {
            await Novel.findByIdAndUpdate(novelId, { $inc: { favorites: -1 } });
        }

        res.json(libraryItem);
    } catch (error) { 
        console.error(error);
        res.status(500).json({ message: 'Failed' }); 
    }
});

app.get('/api/novel/library', verifyToken, async (req, res) => {
    try {
        const { type, userId } = req.query; 
        let targetId = req.user.id;
        
        if (userId) {
            const targetUser = await User.findById(userId);
            if (!targetUser) return res.status(404).json({ message: "User not found" });
            if (userId !== req.user.id && !targetUser.isHistoryPublic && type === 'history') {
                 return res.json([]); 
            }
            targetId = userId;
        }

        let query = { user: targetId };
        if (type === 'favorites') query.isFavorite = true;
        else if (type === 'history') query.progress = { $gt: 0 };
        
        const items = await NovelLibrary.find(query).sort({ lastReadAt: -1 });
        res.json(items);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/novel/status/:novelId', verifyToken, async (req, res) => {
    const item = await NovelLibrary.findOne({ user: req.user.id, novelId: req.params.novelId });
    const readChapters = item ? item.readChapters : [];
    res.json(item || { isFavorite: false, progress: 0, lastChapterId: 0, readChapters: [] });
});

app.get('/api/notifications', verifyToken, async (req, res) => {
    try {
        const favorites = await NovelLibrary.find({ user: req.user.id, isFavorite: true });
        if (!favorites || favorites.length === 0) return res.json({ notifications: [], totalUnread: 0 });

        const favIds = favorites.map(f => f.novelId);
        const novels = await Novel.find({ _id: { $in: favIds } })
            .select('title cover chapters lastChapterUpdate')
            .sort({ lastChapterUpdate: -1 })
            .lean();

        let notifications = [];
        let totalUnread = 0;

        novels.forEach(novel => {
            const libraryEntry = favorites.find(f => f.novelId.toString() === novel._id.toString());
            const readList = libraryEntry.readChapters || [];
            const libCreatedAt = new Date(libraryEntry.createdAt);
            
            const newUnreadChapters = (novel.chapters || []).filter(ch => {
                const chapDate = new Date(ch.createdAt);
                const isNewer = chapDate > libCreatedAt;
                const isUnread = !readList.includes(ch.number);
                return isNewer && isUnread;
            });
            
            if (newUnreadChapters.length > 0) {
                const count = newUnreadChapters.length;
                const lastChapter = novel.chapters[novel.chapters.length - 1];
                
                notifications.push({
                    _id: novel._id,
                    title: novel.title,
                    cover: novel.cover,
                    newChaptersCount: count,
                    lastChapterNumber: lastChapter ? lastChapter.number : 0,
                    lastChapterTitle: lastChapter ? lastChapter.title : '',
                    updatedAt: novel.lastChapterUpdate
                });
                totalUnread += count;
            }
        });

        res.json({ notifications, totalUnread });

    } catch (error) {
        console.error("Notifications Error:", error);
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
        if (ADMIN_EMAILS.includes(lowerEmail)) {
            role = 'admin';
        }

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

// 🔥🔥🔥🔥 تشغيل الخادم على Railway (الاستماع للمنفذ) 🔥🔥🔥🔥
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
