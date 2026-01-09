
const mongoose = require('mongoose');
const path = require('path');
const AdmZip = require('adm-zip');

// --- Config Imports ---
let firestore, cloudinary;
try {
    const firebaseAdmin = require('../config/firebaseAdmin');
    firestore = firebaseAdmin.db;
    cloudinary = require('../config/cloudinary');
} catch (e) {
    console.warn("⚠️ Config files check failed in admin routes...");
}

// Models
const User = require('../models/user.model.js');
const Novel = require('../models/novel.model.js');
const NovelLibrary = require('../models/novelLibrary.model.js'); 
const Settings = require('../models/settings.model.js');
const Comment = require('../models/comment.model.js');

// 🔥 MODEL FOR SCRAPER LOGS (للتتبع المباشر) - Defined here as it's admin/scraper specific
const ScraperLogSchema = new mongoose.Schema({
    message: String,
    type: { type: String, default: 'info' }, // info, success, error, warning
    timestamp: { type: Date, default: Date.now }
});
// حذف النموذج القديم إذا وجد لتجنب التعارض
if (mongoose.models.ScraperLog) delete mongoose.models.ScraperLog;
const ScraperLog = mongoose.model('ScraperLog', ScraperLogSchema);

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

module.exports = function(app, verifyToken, verifyAdmin, upload) {

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
    // 🔍 CHECK EXISTING CHAPTERS (NEW)
    // =========================================================
    app.post('/api/scraper/check-chapters', async (req, res) => {
        const secret = req.headers['authorization'] || req.headers['x-api-secret'];
        const VALID_SECRET = 'Zeusndndjddnejdjdjdejekk29393838msmskxcm9239484jdndjdnddjj99292938338zeuslojdnejxxmejj82283849';
        
        if (secret !== VALID_SECRET) return res.status(403).json({ message: "Unauthorized" });

        try {
            const { title } = req.body;
            // البحث عن الرواية بالاسم العربي المطابق
            const novel = await Novel.findOne({ title: title });
            
            if (novel) {
                // إرجاع أرقام الفصول الموجودة فقط
                const existingChapters = novel.chapters.map(c => c.number);
                await logScraper(`✅ الرواية موجودة مسبقاً: ${title} (${existingChapters.length} فصل)`, 'success');
                return res.json({ 
                    exists: true, 
                    chapters: existingChapters 
                });
            } else {
                return res.json({ exists: false, chapters: [] });
            }
        } catch (e) {
            console.error("Check Chapters Error:", e);
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
            const { adminEmail, novelData, chapters, error, skipMetadataUpdate } = req.body;

            // إذا أرسل السكرابر خطأ
            if (error) {
                await logScraper(`❌ خطأ من السكرابر: ${error}`, 'error');
                return res.status(400).json({ message: error });
            }

            // await logScraper(`📥 وصل رد من السكرابر! تحليل البيانات...`, 'info');

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
            // فقط إذا لم نكن في وضع "تخطي التحديث" (skipMetadataUpdate)
            if (!skipMetadataUpdate && novelData.cover && !novelData.cover.includes('cloudinary') && cloudinary) {
                try {
                    // await logScraper(`🖼️ جاري رفع الغلاف: ${novelData.cover}`, 'info');
                    const uploadRes = await cloudinary.uploader.upload(novelData.cover, {
                        folder: 'novels_covers',
                        resource_type: 'auto', // Auto detect type
                        timeout: 60000 // 60s timeout
                    });
                    novelData.cover = uploadRes.secure_url;
                    await logScraper(`✅ تم رفع الغلاف بنجاح`, 'success');
                } catch (imgErr) {
                    await logScraper(`⚠️ فشل رفع الغلاف: ${imgErr.message} - سيتم استخدام الرابط الأصلي.`, 'warning');
                    // لا نوقف العملية، نستمر بالرابط الأصلي
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
                // تحديث البيانات إذا كانت موجودة (فقط إذا لم يطلب التخطي)
                if (!skipMetadataUpdate) {
                    await logScraper(`🔄 تحديث بيانات الرواية (غلاف/وصف)...`, 'info');
                    if (novelData.cover && (novelData.cover.includes('cloudinary') || !novel.cover)) {
                         novel.cover = novelData.cover;
                    }
                    if (!novel.description && novelData.description) novel.description = novelData.description;
                    
                    // ضمان تحديث المؤلف إذا كان مفقوداً
                    if (!novel.authorEmail) {
                        novel.author = user.name;
                        novel.authorEmail = user.email;
                    }
                    await novel.save();
                } else {
                     // await logScraper(`ℹ️ تخطي تحديث الميتاداتا (الرواية موجودة)`, 'info');
                }
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
                    await logScraper(`✅ تم حفظ ${addedCount} فصل جديد`, 'success');
                } else {
                    if (chapters.length > 0) {
                       // await logScraper(`ℹ️ الفصول المستلمة موجودة مسبقاً (${chapters.length})`, 'info');
                    }
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
};
