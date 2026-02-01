
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Novel = require('../models/novel.model.js');
const Glossary = require('../models/glossary.model.js');
const TranslationJob = require('../models/translationJob.model.js');
const Settings = require('../models/settings.model.js');

// --- Helper: Delay ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- THE TRANSLATION WORKER ---
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

        // 1. Get Settings (Prompts & Global Keys)
        const settings = await Settings.findOne({}); 
        
        // Merge Job Keys with Global Keys
        let keys = job.apiKeys && job.apiKeys.length > 0 ? job.apiKeys : (settings?.translatorApiKeys || []);
        
        if (!keys || keys.length === 0) {
            job.status = 'failed';
            job.logs.push({ message: 'لا توجد مفاتيح API (لا في المهمة ولا في الإعدادات العامة)', type: 'error' });
            await job.save();
            return;
        }

        let keyIndex = 0;
        const transPrompt = settings?.customPrompt || "You are a professional translator. Translate the following novel chapter to Arabic. Use the provided Glossary strictly. output JSON: { \"title\": \"Arabic Title\", \"content\": \"Arabic Content (HTML formatted paragraphs)\", \"newTerms\": [{\"term\": \"English\", \"translation\": \"Arabic\"}] }";
        let selectedModel = settings?.translatorModel || 'gemini-1.5-flash'; // Default fallback

        // ترتيب الفصول المستهدفة
        const chaptersToProcess = job.targetChapters.sort((a, b) => a - b);

        for (const chapterNum of chaptersToProcess) {
            // Check Job Status
            const freshJob = await TranslationJob.findById(jobId);
            if (freshJob.status !== 'active') break;

            // Get Chapter Data
            const chapterIndex = novel.chapters.findIndex(c => c.number === chapterNum);
            if (chapterIndex === -1) {
                await pushLog(jobId, `فصل ${chapterNum} غير موجود في قاعدة البيانات`, 'warning');
                continue;
            }
            const originalChapter = novel.chapters[chapterIndex]; 
            
            // Assume content exists or fetched from external DB. 
            // Here we assume it's in the array for simplicity of the prompt context.
            // In production, fetch from Firestore/GridFS if 'content' is not in Mongo.
            let sourceContent = originalChapter.content || ""; 

            if (!sourceContent || sourceContent.length < 50) {
                 await pushLog(jobId, `محتوى الفصل ${chapterNum} فارغ أو قصير جداً`, 'warning');
                 continue;
            }

            // Get Glossary
            const glossaryItems = await Glossary.find({ novelId: novel._id });
            const glossaryText = glossaryItems.map(g => `"${g.term}": "${g.translation}"`).join(',\n');

            // Rotate Key
            const currentKey = keys[keyIndex % keys.length];
            const genAI = new GoogleGenerativeAI(currentKey);
            const model = genAI.getGenerativeModel({ 
                model: selectedModel,
                generationConfig: { responseMimeType: "application/json" }
            });

            const fullPrompt = `
${transPrompt}

--- GLOSSARY (Strictly enforce these terms) ---
${glossaryText}
----------------------------------------

--- SOURCE CHAPTER (Title: ${originalChapter.title}) ---
${sourceContent}
----------------------------------------
`;

            try {
                await pushLog(jobId, `جاري ترجمة الفصل ${chapterNum}...`, 'info');
                
                const result = await model.generateContent(fullPrompt);
                const response = await result.response;
                const jsonText = response.text();
                const data = JSON.parse(jsonText);

                if (data.title && data.content) {
                    // Update Novel
                    novel.chapters[chapterIndex].title = data.title;
                    novel.chapters[chapterIndex].content = data.content; 
                    novel.markModified('chapters');
                    
                    // Update Glossary with new terms
                    if (data.newTerms && Array.isArray(data.newTerms)) {
                        let newTermsCount = 0;
                        for (const termObj of data.newTerms) {
                            if (termObj.term && termObj.translation) {
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
                
                if (err.message.includes('429') || err.message.includes('quota')) {
                    keyIndex++;
                    await pushLog(jobId, `تم تبديل المفتاح وتأخير 10 ثواني...`, 'warning');
                    await delay(10000);
                }
            }

            await delay(2000);
        }

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

    // 1. Get Novels (Latest 15 ADDED)
    app.get('/api/translator/novels', verifyToken, async (req, res) => {
        try {
            const { search } = req.query;
            let query = {};
            if (search) {
                query.title = { $regex: search, $options: 'i' };
            }
            
            // Sort by createdAt -1 (Newest created first)
            const novels = await Novel.find(query)
                .select('title cover chapters author status createdAt')
                .sort({ createdAt: -1 }) 
                .limit(15);
            
            res.json(novels);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 2. Start Job (Supports Resume & Ranges)
    app.post('/api/translator/start', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId, chapters, apiKeys, resumeFrom } = req.body; 
            
            const novel = await Novel.findById(novelId);
            if (!novel) return res.status(404).json({ message: "Novel not found" });

            let targetChapters = [];
            
            if (resumeFrom) {
                // Resume logic: translate all chapters AFTER resumeFrom
                targetChapters = novel.chapters
                    .filter(c => c.number >= resumeFrom)
                    .map(c => c.number);
            } else if (chapters === 'all') {
                targetChapters = novel.chapters.map(c => c.number);
            } else if (Array.isArray(chapters)) {
                targetChapters = chapters;
            }

            // Ensure we have keys (either passed or from settings)
            // Logic handled inside worker, but we can verify here too if needed.

            const job = new TranslationJob({
                novelId,
                novelTitle: novel.title,
                cover: novel.cover,
                targetChapters,
                totalToTranslate: targetChapters.length,
                apiKeys: apiKeys || [], 
                logs: [{ message: `تم بدء المهمة (استهداف ${targetChapters.length} فصل)`, type: 'info' }]
            });

            await job.save();

            // Fire Worker
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

    // 4. Get Job Details (Enhanced for Analytics)
    app.get('/api/translator/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await TranslationJob.findById(req.params.id);
            if (!job) return res.status(404).json({message: "Job not found"});

            // Fetch novel to check current max chapter
            const novel = await Novel.findById(job.novelId).select('chapters');
            const maxChapter = novel ? (novel.chapters.length > 0 ? Math.max(...novel.chapters.map(c => c.number)) : 0) : 0;

            const response = job.toObject();
            response.novelMaxChapter = maxChapter; // For resume logic
            
            res.json(response);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 5. Manage Glossary (With Bulk & Search)
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
            // Upsert logic
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
    
    // Bulk Delete Glossary
    app.post('/api/translator/glossary/bulk-delete', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { ids } = req.body;
            await Glossary.deleteMany({ _id: { $in: ids } });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 6. Translator Settings API (Including Keys)
    app.get('/api/translator/settings', verifyToken, verifyAdmin, async (req, res) => {
        try {
            let settings = await Settings.findOne({ user: req.user.id });
            if (!settings) settings = {};
            res.json({
                customPrompt: settings.customPrompt || '',
                translatorExtractPrompt: settings.translatorExtractPrompt || '',
                translatorModel: settings.translatorModel || 'gemini-2.5-flash',
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
