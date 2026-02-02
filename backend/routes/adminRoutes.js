
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

// 🔥 MODEL FOR SCRAPER LOGS
const ScraperLogSchema = new mongoose.Schema({
    message: String,
    type: { type: String, default: 'info' }, 
    timestamp: { type: Date, default: Date.now }
});
if (mongoose.models.ScraperLog) delete mongoose.models.ScraperLog;
const ScraperLog = mongoose.model('ScraperLog', ScraperLogSchema);

async function logScraper(message, type = 'info') {
    try {
        console.log(`[Scraper Log] ${message}`);
        await ScraperLog.create({ message, type, timestamp: new Date() });
        const count = await ScraperLog.countDocuments();
        if (count > 100) {
            const first = await ScraperLog.findOne().sort({ timestamp: 1 });
            if (first) await ScraperLog.deleteOne({ _id: first._id });
        }
    } catch (e) {
        console.error("Log error", e);
    }
}

// Helper to escape regex special characters
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = function(app, verifyToken, verifyAdmin, upload) {

    // =========================================================
    // 📂 CATEGORY MANAGEMENT API
    // =========================================================
    
    // Add New Category to Master List
    app.post('/api/admin/categories', verifyAdmin, async (req, res) => {
        try {
            const { category } = req.body;
            if (!category) return res.status(400).json({ message: "Category name required" });

            let settings = await Settings.findOne({ user: req.user.id });
            if (!settings) settings = new Settings({ user: req.user.id });

            if (!settings.managedCategories) settings.managedCategories = [];
            
            if (!settings.managedCategories.includes(category)) {
                settings.managedCategories.push(category);
                await settings.save();
            }
            
            res.json({ message: "Category added", list: settings.managedCategories });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Delete Category (Remove from Master List + Remove from ALL Novels)
    app.delete('/api/admin/categories/:name', verifyAdmin, async (req, res) => {
        try {
            const categoryName = decodeURIComponent(req.params.name);
            
            // 1. Remove from Admin Settings
            let settings = await Settings.findOne({ user: req.user.id });
            if (settings && settings.managedCategories) {
                settings.managedCategories = settings.managedCategories.filter(c => c !== categoryName);
                await settings.save();
            }

            // 2. Remove from Novels (Tags array)
            await Novel.updateMany(
                { tags: categoryName },
                { $pull: { tags: categoryName } }
            );

            // 3. Reset Main Category if matched
            await Novel.updateMany(
                { category: categoryName },
                { $set: { category: 'أخرى' } }
            );

            res.json({ message: "Category deleted permanently" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // =========================================================
    // 🧹 GLOBAL CLEANER API
    // =========================================================
    
    // Get Blacklist
    app.get('/api/admin/cleaner', verifyAdmin, async (req, res) => {
        try {
            // We use the admin's settings to store the global blacklist for now
            let settings = await Settings.findOne({ user: req.user.id });
            if (!settings) {
                settings = new Settings({ user: req.user.id });
                await settings.save();
            }
            res.json(settings.globalBlocklist || []);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Add Word & Execute Clean
    app.post('/api/admin/cleaner', verifyAdmin, async (req, res) => {
        try {
            const { word } = req.body; 
            if (!word) return res.status(400).json({ message: "Word required" });

            // 1. Save to Blacklist
            let settings = await Settings.findOne({ user: req.user.id });
            if (!settings) settings = new Settings({ user: req.user.id });
            
            if (!settings.globalBlocklist.includes(word)) {
                settings.globalBlocklist.push(word);
                await settings.save();
            }

            // 2. Execute Cleanup on ALL Novels (Batch Job)
            let updatedCount = 0;

            if (firestore) {
                const novelsSnapshot = await firestore.collection('novels').get();
                const batchPromises = [];

                novelsSnapshot.forEach(doc => {
                    const novelId = doc.id;
                    const p = firestore.collection('novels').doc(novelId).collection('chapters').get().then(chaptersSnap => {
                        chaptersSnap.forEach(chapDoc => {
                            let content = chapDoc.data().content || "";
                            let modified = false;

                            if (word.includes('\n') || word.includes('\r')) {
                                // --- BLOCK REMOVAL MODE ---
                                if (content.includes(word)) {
                                    content = content.split(word).join('');
                                    modified = true;
                                }
                            } else {
                                // --- KEYWORD LINE REMOVAL MODE ---
                                const escapedKeyword = escapeRegExp(word);
                                const regex = new RegExp(`^.*${escapedKeyword}.*$`, 'gm');
                                
                                if (regex.test(content)) {
                                    content = content.replace(regex, '');
                                    modified = true;
                                }
                            }

                            if (modified) {
                                content = content.replace(/^\s*[\r\n]/gm, ''); // Clean empty lines
                                chapDoc.ref.update({ content: content });
                                updatedCount++;
                            }
                        });
                    });
                    batchPromises.push(p);
                });
                await Promise.all(batchPromises);
            }

            res.json({ message: "Cleanup executed", updatedCount });
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: e.message });
        }
    });

    // Update Word (Remove old, Add new, Clean new)
    app.put('/api/admin/cleaner/:index', verifyAdmin, async (req, res) => {
        try {
            const index = parseInt(req.params.index);
            const { word } = req.body;
            
            let settings = await Settings.findOne({ user: req.user.id });
            if (settings && settings.globalBlocklist[index]) {
                settings.globalBlocklist[index] = word;
                await settings.save();
                
                // Re-run cleaner for the new word (Batch)
                if (firestore) {
                    const novelsSnapshot = await firestore.collection('novels').get();
                    const batchPromises = [];
                    novelsSnapshot.forEach(doc => {
                        const p = firestore.collection('novels').doc(doc.id).collection('chapters').get().then(chaptersSnap => {
                            chaptersSnap.forEach(chapDoc => {
                                let content = chapDoc.data().content || "";
                                let modified = false;

                                if (word.includes('\n') || word.includes('\r')) {
                                    if (content.includes(word)) {
                                        content = content.split(word).join('');
                                        modified = true;
                                    }
                                } else {
                                    const escapedKeyword = escapeRegExp(word);
                                    const regex = new RegExp(`^.*${escapedKeyword}.*$`, 'gm');
                                    if (regex.test(content)) {
                                        content = content.replace(regex, '');
                                        modified = true;
                                    }
                                }

                                if (modified) {
                                    content = content.replace(/^\s*[\r\n]/gm, '');
                                    chapDoc.ref.update({ content: content });
                                }
                            });
                        });
                        batchPromises.push(p);
                    });
                    await Promise.all(batchPromises);
                }
            }
            res.json({ message: "Updated and executed" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Delete Word from Blacklist
    app.delete('/api/admin/cleaner/:word', verifyAdmin, async (req, res) => {
        try {
            const word = decodeURIComponent(req.params.word);
            let settings = await Settings.findOne({ user: req.user.id });
            if (settings) {
                settings.globalBlocklist = settings.globalBlocklist.filter(w => w !== word);
                await settings.save();
            }
            res.json({ message: "Removed from list" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });


    // =========================================================
    // 📜 SCRAPER LOGS API
    // =========================================================
    app.delete('/api/scraper/logs', async (req, res) => {
        try {
            await ScraperLog.deleteMany({});
            res.json({ message: "Logs cleared" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/scraper/logs', async (req, res) => {
        try {
            const logs = await ScraperLog.find().sort({ timestamp: -1 }).limit(100);
            res.json(logs);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/scraper/init', async (req, res) => {
        try {
            const { url, userEmail } = req.body;
            await ScraperLog.deleteMany({}); 
            
            if (userEmail) {
                const user = await User.findOne({ email: userEmail });
                if (user) await logScraper(`👤 المستخدم: ${user.name}`, 'info');
            }

            await logScraper(`🚀 بدء عملية الفحص الذكي (Probe Mode)...`, 'info');
            await logScraper(`🔗 الرابط: ${url}`, 'info');
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

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
    // 🔍 CHECK EXISTING CHAPTERS
    // =========================================================
    app.post('/api/scraper/check-chapters', async (req, res) => {
        const secret = req.headers['authorization'] || req.headers['x-api-secret'];
        const VALID_SECRET = 'Zeusndndjddnejdjdjdejekk29393838msmskxcm9239484jdndjdnddjj99292938338zeuslojdnejxxmejj82283849';
        
        if (secret !== VALID_SECRET) return res.status(403).json({ message: "Unauthorized" });

        try {
            const { title } = req.body;
            const novel = await Novel.findOne({ title: title });
            
            if (novel) {
                const existingChapters = novel.chapters.map(c => c.number);
                await logScraper(`✅ الرواية موجودة (${existingChapters.length} فصل). جاري فحص النواقص والتحديثات...`, 'success');
                return res.json({ exists: true, chapters: existingChapters });
            } else {
                return res.json({ exists: false, chapters: [] });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // =========================================================
    // 🕷️ SCRAPER WEBHOOK
    // =========================================================
    app.post('/api/scraper/receive', async (req, res) => {
        const secret = req.headers['authorization'] || req.headers['x-api-secret'];
        const VALID_SECRET = 'Zeusndndjddnejdjdjdejekk29393838msmskxcm9239484jdndjdnddjj99292938338zeuslojdnejxxmejj82283849';
        
        if (secret !== VALID_SECRET) return res.status(403).json({ message: "Unauthorized" });

        try {
            const { adminEmail, novelData, chapters, error, skipMetadataUpdate } = req.body;

            if (error) {
                await logScraper(`❌ توقف: ${error}`, 'error');
                return res.status(400).json({ message: error });
            }

            if (!adminEmail || !novelData || !novelData.title) {
                return res.status(400).json({ message: "Missing data" });
            }

            const user = await User.findOne({ email: adminEmail });
            if (!user) return res.status(404).json({ message: "User not found" });

            let novel = await Novel.findOne({ title: novelData.title });

            // Image Upload Logic (Cloudinary)
            if (!skipMetadataUpdate && novelData.cover && !novelData.cover.includes('cloudinary') && cloudinary) {
                try {
                    const uploadRes = await cloudinary.uploader.upload(novelData.cover, {
                        folder: 'novels_covers',
                        resource_type: 'auto',
                        timeout: 60000 
                    });
                    novelData.cover = uploadRes.secure_url;
                    await logScraper(`✅ تم رفع الغلاف`, 'success');
                } catch (imgErr) {
                    await logScraper(`⚠️ فشل رفع الغلاف (سيستخدم الرابط الأصلي)`, 'warning');
                }
            }

            if (!novel) {
                // New Novel
                novel = new Novel({
                    title: novelData.title,
                    cover: novelData.cover,
                    description: novelData.description,
                    author: user.name, 
                    authorEmail: user.email,
                    category: novelData.category || 'أخرى',
                    tags: novelData.tags || [],
                    status: 'مستمرة',
                    chapters: [],
                    views: 0
                });
                await novel.save();
                await logScraper(`✨ تم إنشاء الرواية: ${novelData.title}`, 'info');
            } else {
                // Update Metadata if allowed
                if (!skipMetadataUpdate) {
                    if (novelData.cover && (novelData.cover.includes('cloudinary') || !novel.cover)) {
                         novel.cover = novelData.cover;
                    }
                    if (!novel.description && novelData.description) novel.description = novelData.description;
                    if (!novel.authorEmail) {
                        novel.author = user.name;
                        novel.authorEmail = user.email;
                    }
                    await novel.save();
                }
            }

            // Save Chapters
            if (chapters && Array.isArray(chapters) && chapters.length > 0) {
                let addedCount = 0;
                for (const chap of chapters) {
                    const existingChap = novel.chapters.find(c => c.number === chap.number);
                    if (!existingChap) {
                        // Firestore
                        if (firestore) {
                            await firestore.collection('novels').doc(novel._id.toString())
                                .collection('chapters').doc(chap.number.toString()).set({
                                    title: chap.title,
                                    content: chap.content,
                                    lastUpdated: new Date()
                                });
                        }
                        // MongoDB Meta
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
                    novel.chapters.sort((a, b) => a.number - b.number);
                    novel.lastChapterUpdate = new Date();
                    await novel.save();
                    await logScraper(`✅ تم حفظ ${addedCount} فصل جديد`, 'success');
                }
            } 

            res.json({ success: true, novelId: novel._id });

        } catch (error) {
            console.error("Scraper Receiver Error:", error);
            await logScraper(`❌ خطأ خادم: ${error.message}`, 'error');
            res.status(500).json({ error: error.message });
        }
    });

    // Bulk Upload (Kept same)
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
                        errors.push(`تخطي ${entry.entryName}: الاسم ليس رقماً`);
                        continue;
                    }

                    const fullText = zip.readAsText(entry, 'utf8');
                    const lines = fullText.split('\n');
                    if (lines.length === 0) continue;

                    const firstLine = lines[0].trim();
                    let chapterTitle = firstLine;
                    const colonIndex = firstLine.indexOf(':');
                    if (colonIndex > -1) chapterTitle = firstLine.substring(colonIndex + 1).trim();
                    if (!chapterTitle) chapterTitle = firstLine;

                    const content = lines.slice(1).join('\n').trim();

                    if (firestore) {
                        await firestore.collection('novels').doc(novelId).collection('chapters').doc(chapterNumber.toString()).set({
                            title: chapterTitle,
                            content: content,
                            lastUpdated: new Date()
                        });
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
                    errors.push(`خطأ في ${entry.entryName}`);
                }
            }

            if (successCount > 0) {
                novel.chapters.sort((a, b) => a.number - b.number);
                novel.lastChapterUpdate = new Date();
                if (novel.status === 'متوقفة') novel.status = 'مستمرة';
                await novel.save();
            }

            res.json({ message: `نجح: ${successCount}`, errors, successCount });

        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Users Management (Kept same)
    app.get('/api/admin/users', verifyAdmin, async (req, res) => {
        if (req.user.role !== 'admin') return res.status(403).json({ message: "Access Denied" });
        try {
            const users = await User.find({}).sort({ createdAt: -1 });
            res.json(users);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.put('/api/admin/users/:id/role', verifyAdmin, async (req, res) => {
        if (req.user.role !== 'admin') return res.status(403).json({ message: "Access Denied" });
        try {
            const { role } = req.body;
            const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true });
            res.json(user);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/admin/users/:id', verifyAdmin, async (req, res) => {
        if (req.user.role !== 'admin') return res.status(403).json({ message: "Access Denied" });
        try {
            const targetUserId = req.params.id;
            const deleteContent = req.query.deleteContent === 'true'; 
            if (targetUserId === req.user.id) return res.status(400).json({message: "Cannot delete yourself"});

            const targetUser = await User.findById(targetUserId);
            if (!targetUser) return res.status(404).json({ message: "User not found" });

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
                        } catch (err) {}
                    }
                }
                await Novel.deleteMany({ authorEmail: targetUser.email });
            }

            await User.findByIdAndDelete(targetUserId);
            await NovelLibrary.deleteMany({ user: targetUserId });
            await Settings.deleteMany({ user: targetUserId });
            
            res.json({ message: "User deleted" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.put('/api/admin/users/:id/block-comment', verifyAdmin, async (req, res) => {
        if (req.user.role !== 'admin') return res.status(403).json({ message: "Access Denied" });
        try {
            const { block } = req.body;
            const user = await User.findByIdAndUpdate(req.params.id, { isCommentBlocked: block }, { new: true });
            res.json({ message: "Updated", user });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Novels Management (Kept same)
    app.post('/api/admin/novels', verifyAdmin, async (req, res) => {
        try {
            const { title, cover, description, category, tags, status } = req.body;
            const newNovel = new Novel({
                title, cover, description, 
                author: req.user.name, authorEmail: req.user.email,
                category, tags, status: status || 'مستمرة'
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

            if (req.user.role !== 'admin' && novel.authorEmail !== req.user.email) {
                return res.status(403).json({ message: "Access Denied" });
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

            if (req.user.role !== 'admin' && novel.authorEmail !== req.user.email) {
                return res.status(403).json({ message: "Access Denied" });
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
                } catch (fsError) {}
            }

            await Novel.findByIdAndDelete(novelId);
            await NovelLibrary.deleteMany({ novelId: novelId });
            res.json({ message: "Deleted" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/admin/chapters', verifyAdmin, async (req, res) => {
        try {
            const { novelId, number, title, content } = req.body;
            const novel = await Novel.findById(novelId);
            if (!novel) return res.status(404).json({ message: "Novel not found" });

            if (req.user.role !== 'admin' && novel.authorEmail !== req.user.email) {
                return res.status(403).json({ message: "Access Denied" });
            }

            if (firestore) {
                await firestore.collection('novels').doc(novelId).collection('chapters').doc(number.toString()).set({
                    title, content, lastUpdated: new Date()
                });
            }

            const existingIndex = novel.chapters.findIndex(c => c.number == number);
            const chapterMeta = { number: Number(number), title, createdAt: new Date(), views: 0 };

            if (existingIndex > -1) {
                novel.chapters[existingIndex] = { ...novel.chapters[existingIndex].toObject(), ...chapterMeta };
            } else {
                novel.chapters.push(chapterMeta);
            }
            
            novel.lastChapterUpdate = new Date();
            if (novel.status === 'متوقفة') novel.status = 'مستمرة';
            novel.markModified('chapters');
            await novel.save();

            res.json({ message: "Chapter saved" });
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

            if (req.user.role !== 'admin' && novel.authorEmail !== req.user.email) {
                return res.status(403).json({ message: "Access Denied" });
            }

            if (firestore) {
                await firestore.collection('novels').doc(novelId).collection('chapters').doc(number.toString()).update({
                    title, content, lastUpdated: new Date()
                });
            }

            const idx = novel.chapters.findIndex(c => c.number == number);
            if (idx > -1) {
                novel.chapters[idx].title = title;
                novel.markModified('chapters');
                await novel.save();
            }
            res.json({ message: "Updated" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.delete('/api/admin/chapters/:novelId/:number', verifyAdmin, async (req, res) => {
        try {
            const { novelId, number } = req.params;
            const novel = await Novel.findById(novelId);
            if (!novel) return res.status(404).json({ message: "Novel not found" });

            if (req.user.role !== 'admin' && novel.authorEmail !== req.user.email) {
                return res.status(403).json({ message: "Access Denied" });
            }
            
            novel.chapters = novel.chapters.filter(c => c.number != number);
            await novel.save();

            if (firestore) {
                await firestore.collection('novels').doc(novelId).collection('chapters').doc(number.toString()).delete();
            }
            res.json({ message: "Deleted" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
};
