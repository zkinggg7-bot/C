const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Novel = require('../models/novel.model.js');
const Glossary = require('../models/glossary.model.js');
const TranslationJob = require('../models/translationJob.model.js');
const Settings = require('../models/settings.model.js');

// --- Firestore Setup (MANDATORY) ---
let firestore;
try {
    const firebaseAdmin = require('../config/firebaseAdmin');
    firestore = firebaseAdmin.db;
} catch (e) {
    console.error("❌ CRITICAL: Firestore not loaded. Translator cannot work without it.");
}

// --- Helper: Delay ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- THE TRANSLATION WORKER (STRICT FIRESTORE MODE) ---
async function processTranslationJob(jobId) {
    try {
        const job = await TranslationJob.findById(jobId);
        if (!job || job.status !== 'active') return;

        if (!firestore) {
            job.status = 'failed';
            job.logs.push({ message: 'خطأ خادم: قاعدة بيانات النصوص (Firestore) غير متصلة', type: 'error' });
            await job.save();
            return;
        }

        const novel = await Novel.findById(job.novelId);
        if (!novel) {
            job.status = 'failed';
            job.logs.push({ message: 'الرواية لم تعد موجودة', type: 'error' });
            await job.save();
            return;
        }

        // 1. Get Settings & Keys
        const settings = await Settings.findOne({}); 
        
        // Merge Keys: Prioritize keys stored in the Job itself
        let keys = (job.apiKeys && job.apiKeys.length > 0) ? job.apiKeys : (settings?.translatorApiKeys || []);
        
        if (!keys || keys.length === 0) {
            job.status = 'failed';
            job.logs.push({ message: 'لا توجد مفاتيح API محفوظة.', type: 'error' });
            await job.save();
            return;
        }

        let keyIndex = 0;
        
        // Load Prompts
        const transPrompt = settings?.customPrompt || "You are a professional translator. Translate the novel chapter from English to Arabic. Output ONLY the Arabic translation. Use the glossary provided.";
        const extractPrompt = settings?.translatorExtractPrompt || "Analyze the English source and Arabic translation. Extract important proper nouns, cultivation terms, and skills. Output JSON: { \"newTerms\": [{\"term\": \"English\", \"translation\": \"Arabic\"}] }";
        
        let selectedModel = settings?.translatorModel || 'gemini-1.5-flash'; 

        // Sort Chapters
        const chaptersToProcess = job.targetChapters.sort((a, b) => a - b);

        for (const chapterNum of chaptersToProcess) {
            // Re-Check Status
            const freshJob = await TranslationJob.findById(jobId);
            if (!freshJob || freshJob.status !== 'active') break;

            // 🔥 FIX 1: Always get a FRESH copy of the novel to avoid Version Conflict
            const freshNovel = await Novel.findById(job.novelId);
            const chapterIndex = freshNovel.chapters.findIndex(c => c.number === chapterNum);
            
            if (chapterIndex === -1) {
                await pushLog(jobId, `فصل ${chapterNum} غير موجود في الفهرس`, 'warning');
                continue;
            }

            // 🔥 STEP 0: FETCH SOURCE CONTENT FROM FIRESTORE ONLY
            let sourceContent = ""; 
            try {
                const docRef = firestore.collection('novels').doc(freshNovel._id.toString()).collection('chapters').doc(chapterNum.toString());
                const docSnap = await docRef.get();
                if (docSnap.exists) {
                    const data = docSnap.data();
                    sourceContent = data.content || "";
                }
            } catch (fsErr) {
                console.log(`Firestore fetch error for Ch ${chapterNum}:`, fsErr.message);
            }

            if (!sourceContent || sourceContent.trim().length === 0) {
                 await pushLog(jobId, `تخطي الفصل ${chapterNum}: المحتوى غير موجود في السيرفر (Firestore)`, 'warning');
                 continue;
            }

            // --- Prepare Glossary ---
            const glossaryItems = await Glossary.find({ novelId: freshNovel._id });
            const glossaryText = glossaryItems.map(g => `"${g.term}": "${g.translation}"`).join(',\n');

            // --- Key Rotation ---
            const getModel = () => {
                const currentKey = keys[keyIndex % keys.length];
                const genAI = new GoogleGenerativeAI(currentKey);
                return genAI.getGenerativeModel({ model: selectedModel });
            };

            let translatedText = "";

            // ======================================================
            // 🔥 STEP 1: TRANSLATION (English -> Arabic)
            // ======================================================
            try {
                await pushLog(jobId, `1️⃣ جاري ترجمة الفصل ${chapterNum}...`, 'info');
                
                const model = getModel();
                const translationInput = `
${transPrompt}

--- GLOSSARY (Use these strictly) ---
${glossaryText}
-------------------------------------

--- ENGLISH TEXT TO TRANSLATE ---
${sourceContent}
---------------------------------
`;
                const result = await model.generateContent(translationInput);
                const response = await result.response;
                translatedText = response.text();

            } catch (err) {
                console.error(err);
                if (err.message.includes('429') || err.message.includes('quota')) {
                    keyIndex++; // Rotate key
                    await pushLog(jobId, `⚠️ ضغط على المفتاح، تبديل وإعادة المحاولة...`, 'warning');
                    await delay(5000);
                    chaptersToProcess.unshift(chapterNum); // Retry this chapter
                    continue;
                }
                await pushLog(jobId, `❌ فشل الترجمة للفصل ${chapterNum}: ${err.message}`, 'error');
                continue; 
            }

            // ======================================================
            // 🔥 STEP 2: EXTRACTION (English + Arabic -> Terms)
            // ======================================================
            try {
                await pushLog(jobId, `2️⃣ جاري استخراج المصطلحات...`, 'info');
                
                keyIndex++; 
                const modelJSON = getModel();
                modelJSON.generationConfig = { responseMimeType: "application/json" };

                const extractionInput = `
${extractPrompt}

--- ENGLISH SOURCE ---
${sourceContent.substring(0, 8000)} 
--- ARABIC TRANSLATION ---
${translatedText.substring(0, 8000)}
--------------------------
`; 
                const resultExt = await modelJSON.generateContent(extractionInput);
                const responseExt = await resultExt.response;
                const jsonExt = JSON.parse(responseExt.text());

                // ======================================================
                // 🔥 STEP 3: SAVE TO FIRESTORE ONLY (CONTENT) & MONGO (METADATA)
                // ======================================================
                
                // A. Save Terms
                if (jsonExt.newTerms && Array.isArray(jsonExt.newTerms)) {
                    let newTermsCount = 0;
                    for (const termObj of jsonExt.newTerms) {
                        if (termObj.term && termObj.translation) {
                            await Glossary.updateOne(
                                { novelId: freshNovel._id, term: termObj.term }, 
                                { 
                                    $set: { translation: termObj.translation },
                                    $setOnInsert: { autoGenerated: true }
                                },
                                { upsert: true }
                            );
                            newTermsCount++;
                        }
                    }
                    if (newTermsCount > 0) await pushLog(jobId, `✅ تم إضافة/تحديث ${newTermsCount} مصطلح للمسرد`, 'success');
                }

                // B. Save Translation to FIRESTORE
                try {
                    await firestore.collection('novels').doc(freshNovel._id.toString())
                        .collection('chapters').doc(chapterNum.toString())
                        .set({
                            title: `الفصل ${chapterNum}`,
                            content: translatedText,
                            lastUpdated: new Date()
                        }, { merge: true });
                    
                } catch (fsSaveErr) {
                    throw new Error(`فشل الحفظ في Firestore: ${fsSaveErr.message}`);
                }

                // 🔥 FIX 2: Update MongoDB Metadata using findOneAndUpdate to bypass versioning issues
                await Novel.findOneAndUpdate(
                    { _id: freshNovel._id, "chapters.number": chapterNum },
                    { 
                        $set: { "chapters.$.title": `الفصل ${chapterNum}` } 
                    }
                );

                // D. Update Job
                await TranslationJob.findByIdAndUpdate(jobId, {
                    $inc: { translatedCount: 1 },
                    $set: { currentChapter: chapterNum, lastUpdate: new Date() }
                });

                await pushLog(jobId, `🎉 تم إنجاز الفصل ${chapterNum} وحفظه في السيرفر`, 'success');

            } catch (err) {
                console.error("Extraction/Save Error:", err);
                
                if (translatedText) {
                    try {
                        // Save to Firestore fallback
                        await firestore.collection('novels').doc(freshNovel._id.toString())
                            .collection('chapters').doc(chapterNum.toString())
                            .set({ content: translatedText }, { merge: true });
                        
                        // Update Mongo Metadata fallback
                        await Novel.findOneAndUpdate(
                            { _id: freshNovel._id, "chapters.number": chapterNum },
                            { $set: { "chapters.$.title": `الفصل ${chapterNum}` } }
                        );

                        await pushLog(jobId, `⚠️ تم حفظ الترجمة (فشل الاستخراج): ${err.message}`, 'warning');
                    } catch (saveErr) {
                        await pushLog(jobId, `❌ فشل الحفظ النهائي: ${saveErr.message}`, 'error');
                    }
                } else {
                    await pushLog(jobId, `❌ فشل العملية: ${err.message}`, 'error');
                }
            }

            await delay(2000); // Cool down
        }

        await TranslationJob.findByIdAndUpdate(jobId, { status: 'completed' });
        await pushLog(jobId, `🏁 اكتملت جميع الفصول!`, 'success');

    } catch (e) {
        console.error("Worker Critical Error:", e);
        await TranslationJob.findByIdAndUpdate(jobId, { status: 'failed' });
    }
}

async function pushLog(jobId, message, type) {
    await TranslationJob.findByIdAndUpdate(jobId, {
        $push: { logs: { message, type, timestamp: new Date() } }
    });
}


module.exports = function(app, verifyToken, verifyAdmin) {

    // 🔥 FIX: Auto-clean old conflicting indexes on startup
    mongoose.connection.once('open', async () => {
        try {
            const collection = mongoose.connection.db.collection('glossaries');
            const indexes = await collection.indexes();
            if (indexes.some(idx => idx.name === 'user_1_key_1')) {
                await collection.dropIndex('user_1_key_1');
                console.log('✅ Deleted old conflicting index: user_1_key_1');
            }
        } catch (err) {
            console.log('ℹ️ No old indexes to delete or already cleaned.');
        }
    });

    // 1. Get Novels (Latest 15 ADDED)
    app.get('/api/translator/novels', verifyToken, async (req, res) => {
        try {
            const { search } = req.query;
            let query = {};
            if (search) {
                query.title = { $regex: search, $options: 'i' };
            }
            
            const novels = await Novel.find(query)
                .select('title cover chapters author status createdAt')
                .sort({ createdAt: -1 }) 
                .limit(15);
            
            res.json(novels);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 2. Start Job
    app.post('/api/translator/start', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId, chapters, apiKeys, resumeFrom } = req.body; 
            
            const novel = await Novel.findById(novelId);
            if (!novel) return res.status(404).json({ message: "Novel not found" });

            const userSettings = await Settings.findOne({ user: req.user.id });
            const savedKeys = userSettings?.translatorApiKeys || [];
            
            const effectiveKeys = (apiKeys && apiKeys.length > 0) ? apiKeys : savedKeys;

            if (effectiveKeys.length === 0) {
                return res.status(400).json({ message: "No API keys found. Please add keys in Settings first." });
            }

            let targetChapters = [];
            
            if (resumeFrom) {
                targetChapters = novel.chapters
                    .filter(c => c.number >= resumeFrom)
                    .map(c => c.number);
            } else if (chapters === 'all') {
                targetChapters = novel.chapters.map(c => c.number);
            } else if (Array.isArray(chapters)) {
                targetChapters = chapters;
            }

            const job = new TranslationJob({
                novelId,
                novelTitle: novel.title,
                cover: novel.cover,
                targetChapters,
                totalToTranslate: targetChapters.length,
                apiKeys: effectiveKeys,
                logs: [{ message: `تم بدء المهمة (استهداف ${targetChapters.length} فصل) باستخدام ${effectiveKeys.length} مفتاح`, type: 'info' }]
            });

            await job.save();

            processTranslationJob(job._id);

            res.json({ message: "Job started", jobId: job._id });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 3. Get Jobs List
    app.get('/api/translator/jobs', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const jobs = await TranslationJob.find().sort({ updatedAt: -1 }).limit(20);
            const uiJobs = jobs.map(j => ({
                id: j._id,
                novelTitle: j.novelTitle,
                cover: j.cover,
                status: j.status,
                translated: j.translatedCount,
                total: j.totalToTranslate,
                startTime: j.startTime
            }));
            res.json(uiJobs);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 4. Get Job Details
    app.get('/api/translator/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await TranslationJob.findById(req.params.id);
            if (!job) return res.status(404).json({message: "Job not found"});

            const novel = await Novel.findById(job.novelId).select('chapters');
            const maxChapter = novel ? (novel.chapters.length > 0 ? Math.max(...novel.chapters.map(c => c.number)) : 0) : 0;

            const response = job.toObject();
            response.novelMaxChapter = maxChapter;
            
            res.json(response);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 5. Manage Glossary
    app.get('/api/translator/glossary/:novelId', verifyToken, async (req, res) => {
        try {
            const terms = await Glossary.find({ novelId: req.params.novelId });
            res.json(terms);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/translator/glossary', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId, term, translation } = req.body;
            const newTerm = await Glossary.findOneAndUpdate(
                { novelId, term },
                { translation, autoGenerated: false },
                { new: true, upsert: true }
            );
            res.json(newTerm);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/translator/glossary/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            await Glossary.findByIdAndDelete(req.params.id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    app.post('/api/translator/glossary/bulk-delete', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { ids } = req.body;
            await Glossary.deleteMany({ _id: { $in: ids } });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 6. Translator Settings API
    app.get('/api/translator/settings', verifyToken, verifyAdmin, async (req, res) => {
        try {
            let settings = await Settings.findOne({ user: req.user.id });
            if (!settings) settings = {};
            res.json({
                customPrompt: settings.customPrompt || '',
                translatorExtractPrompt: settings.translatorExtractPrompt || '',
                translatorModel: settings.translatorModel || 'gemini-1.5-flash',
                translatorApiKeys: settings.translatorApiKeys || []
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/translator/settings', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { customPrompt, translatorExtractPrompt, translatorModel, translatorApiKeys } = req.body;
            
            let settings = await Settings.findOne({ user: req.user.id });
            if (!settings) {
                settings = new Settings({ user: req.user.id });
            }

            if (customPrompt !== undefined) settings.customPrompt = customPrompt;
            if (translatorExtractPrompt !== undefined) settings.translatorExtractPrompt = translatorExtractPrompt;
            if (translatorModel !== undefined) settings.translatorModel = translatorModel;
            if (translatorApiKeys !== undefined) settings.translatorApiKeys = translatorApiKeys;

            await settings.save();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
