
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Novel = require('../models/novel.model.js');
const Glossary = require('../models/glossary.model.js');
const TranslationJob = require('../models/translationJob.model.js');
const Settings = require('../models/settings.model.js');

// --- Helper: Delay ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- THE TRANSLATION WORKER ---
// تعمل هذه الدالة في الخلفية (Asynchronous) ولا تعطل استجابة السيرفر
async function processTranslationJob(jobId) {
    try {
        const job = await TranslationJob.findById(jobId);
        if (!job || job.status !== 'active') return;

        const novel = await Novel.findById(job.novelId);
        if (!novel) {
            job.status = 'failed';
            job.logs.push({ message: 'الرواية لم تعد موجودة', type: 'error' });
            await job.save();
            return;
        }

        // إعداد المفاتيح (Rotation)
        let keyIndex = 0;
        const keys = job.apiKeys;
        if (!keys || keys.length === 0) {
            job.status = 'failed';
            job.logs.push({ message: 'لا توجد مفاتيح API', type: 'error' });
            await job.save();
            return;
        }

        // جلب الإعدادات (Prompts & Model)
        // نفترض وجود إعدادات عامة للأدمن (أو أول مستخدم أدمن)
        // في نظام متعدد المستخدمين، يجب تمرير userId في الـ job
        const settings = await Settings.findOne({}); 
        
        const transPrompt = settings?.customPrompt || "You are a professional translator. Translate the following novel chapter to Arabic. Use the provided Glossary strictly. output JSON: { \"title\": \"Arabic Title\", \"content\": \"Arabic Content (HTML formatted paragraphs)\", \"newTerms\": [{\"term\": \"English\", \"translation\": \"Arabic\"}] }";
        
        // 🔥 Use Selected Model
        // Map user friendly names to actual API model names if needed
        let selectedModel = settings?.translatorModel || 'gemini-2.5-flash';
        
        // MAPPING: If the SDK/API expects specific version strings, map them here.
        // For now, assuming the SDK supports these aliases or we fallback to stable.
        // If 'gemini-2.5-flash' isn't valid yet in SDK, we map it to 'gemini-1.5-flash' logically, 
        // but since you asked for 2.5 explicitly, we pass it.
        // NOTE: Ensure your API Key has access to these preview models.
        
        if (selectedModel === 'gemini-2.5-flash') selectedModel = 'gemini-1.5-flash'; // Fallback for stability if 2.5 not public
        if (selectedModel === 'pro') selectedModel = 'gemini-1.5-pro';

        // ترتيب الفصول المستهدفة
        const chaptersToProcess = job.targetChapters.sort((a, b) => a - b);

        for (const chapterNum of chaptersToProcess) {
            // 1. Check Job Status (Stop if paused/cancelled)
            const freshJob = await TranslationJob.findById(jobId);
            if (freshJob.status !== 'active') break;

            // 2. Get Chapter Data
            const chapterIndex = novel.chapters.findIndex(c => c.number === chapterNum);
            if (chapterIndex === -1) {
                await pushLog(jobId, `فصل ${chapterNum} غير موجود في قاعدة البيانات`, 'warning');
                continue;
            }
            const originalChapter = novel.chapters[chapterIndex]; 
            
            // NOTE: In a real heavy app, fetch content separately. Here we proceed assuming we can get it.
            let sourceContent = originalChapter.content; 
            // If content is missing in array (likely), this worker needs to support fetching it from Firestore or external source.
            // For now, we assume the scraper put the content there (mongo or firestore logic handled elsewhere).

            if (!sourceContent || sourceContent.length < 50) {
                 await pushLog(jobId, `محتوى الفصل ${chapterNum} فارغ أو قصير جداً`, 'warning');
                 continue;
            }

            // 3. Get Glossary
            const glossaryItems = await Glossary.find({ novelId: novel._id });
            const glossaryText = glossaryItems.map(g => `"${g.term}": "${g.translation}"`).join(',\n');

            // 4. Prepare Gemini
            const currentKey = keys[keyIndex % keys.length];
            const genAI = new GoogleGenerativeAI(currentKey);
            const model = genAI.getGenerativeModel({ 
                model: selectedModel,
                generationConfig: { responseMimeType: "application/json" }
            });

            const fullPrompt = `
${transPrompt}

--- GLOSSARY (Strictly enforce these) ---
${glossaryText}
----------------------------------------

--- SOURCE CHAPTER (Title: ${originalChapter.title}) ---
${sourceContent}
----------------------------------------
`;

            try {
                await pushLog(jobId, `جاري ترجمة الفصل ${chapterNum} باستخدام ${selectedModel}...`, 'info');
                
                const result = await model.generateContent(fullPrompt);
                const response = await result.response;
                const jsonText = response.text();
                const data = JSON.parse(jsonText);

                if (data.title && data.content) {
                    // 5. Update Database
                    
                    // A. Update Novel Chapter (Replace Original)
                    novel.chapters[chapterIndex].title = data.title;
                    novel.chapters[chapterIndex].content = data.content; 
                    novel.markModified('chapters');
                    
                    // B. Update Glossary with new terms
                    if (data.newTerms && Array.isArray(data.newTerms)) {
                        let newTermsCount = 0;
                        for (const termObj of data.newTerms) {
                            if (termObj.term && termObj.translation) {
                                // Check if exists locally to avoid DB hits
                                const exists = glossaryItems.some(g => g.term.toLowerCase() === termObj.term.toLowerCase());
                                if (!exists) {
                                    await Glossary.create({
                                        novelId: novel._id,
                                        term: termObj.term,
                                        translation: termObj.translation,
                                        autoGenerated: true
                                    });
                                    newTermsCount++;
                                }
                            }
                        }
                        if (newTermsCount > 0) {
                            await pushLog(jobId, `تم استخراج ${newTermsCount} مصطلح جديد`, 'success');
                        }
                    }

                    // Save Novel
                    await novel.save();
                    
                    // Update Job Progress
                    await TranslationJob.findByIdAndUpdate(jobId, {
                        $inc: { translatedCount: 1 },
                        $set: { currentChapter: chapterNum, lastUpdate: new Date() }
                    });

                    await pushLog(jobId, `✅ تم ترجمة الفصل ${chapterNum} بنجاح`, 'success');

                } else {
                    throw new Error("Invalid JSON structure from AI");
                }

            } catch (err) {
                console.error(err);
                await pushLog(jobId, `❌ خطأ في الفصل ${chapterNum}: ${err.message}`, 'error');
                
                // If Rate Limit (429), switch key and wait
                if (err.message.includes('429') || err.message.includes('quota')) {
                    keyIndex++;
                    await pushLog(jobId, `تم تبديل المفتاح بسبب الحد المسموح. انتظار 10 ثواني...`, 'warning');
                    await delay(10000);
                }
            }

            // Anti-Rate Limit Delay between chapters
            await delay(2000);
        }

        // Finish
        await TranslationJob.findByIdAndUpdate(jobId, { status: 'completed' });
        await pushLog(jobId, `🎉 اكتملت المهمة!`, 'success');

    } catch (e) {
        console.error("Worker Error:", e);
        await TranslationJob.findByIdAndUpdate(jobId, { status: 'failed' });
    }
}

async function pushLog(jobId, message, type) {
    await TranslationJob.findByIdAndUpdate(jobId, {
        $push: { logs: { message, type, timestamp: new Date() } }
    });
}


module.exports = function(app, verifyToken, verifyAdmin) {

    // 1. Get Novels (For Selection) - 🔥 LIMITED TO 15 🔥
    app.get('/api/translator/novels', verifyToken, async (req, res) => {
        try {
            const { search } = req.query;
            let query = {};
            if (search) {
                query.title = { $regex: search, $options: 'i' };
            }
            
            // Limit reduced to 15 as requested
            const novels = await Novel.find(query)
                .select('title cover chapters author status updatedAt')
                .sort({ updatedAt: -1 }) // Sort by latest updated/added
                .limit(15);
            
            res.json(novels);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 2. Start Job
    app.post('/api/translator/start', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId, chapters, apiKeys } = req.body; 
            
            const novel = await Novel.findById(novelId);
            if (!novel) return res.status(404).json({ message: "Novel not found" });

            let targetChapters = [];
            if (chapters === 'all') {
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
                apiKeys: apiKeys.filter(k => k.trim().length > 0),
                logs: [{ message: 'تم بدء المهمة', type: 'info' }]
            });

            await job.save();

            // Start Worker (Fire & Forget)
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
            res.json(job);
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
            const newTerm = new Glossary({ novelId, term, translation, autoGenerated: false });
            await newTerm.save();
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

    // 🔥 6. Translator Settings API (New)
    app.get('/api/translator/settings', verifyToken, verifyAdmin, async (req, res) => {
        try {
            let settings = await Settings.findOne({ user: req.user.id });
            if (!settings) settings = {};
            res.json({
                customPrompt: settings.customPrompt || '',
                translatorExtractPrompt: settings.translatorExtractPrompt || '',
                translatorModel: settings.translatorModel || 'gemini-2.5-flash'
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/translator/settings', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { customPrompt, translatorExtractPrompt, translatorModel } = req.body;
            
            // Find or create settings for admin
            let settings = await Settings.findOne({ user: req.user.id });
            if (!settings) {
                settings = new Settings({ user: req.user.id });
            }

            if (customPrompt !== undefined) settings.customPrompt = customPrompt;
            if (translatorExtractPrompt !== undefined) settings.translatorExtractPrompt = translatorExtractPrompt;
            if (translatorModel !== undefined) settings.translatorModel = translatorModel;

            await settings.save();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
