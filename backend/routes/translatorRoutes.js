
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Novel = require('../models/novel.model.js');
const Glossary = require('../models/glossary.model.js');
const TranslationJob = require('../models/translationJob.model.js');
const Settings = require('../models/settings.model.js');

// --- Helper: Delay ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- THE TRANSLATION WORKER (2-STEP PROCESS) ---
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

        // 1. Get Settings
        const settings = await Settings.findOne({}); 
        
        // Merge Keys
        let keys = job.apiKeys && job.apiKeys.length > 0 ? job.apiKeys : (settings?.translatorApiKeys || []);
        
        if (!keys || keys.length === 0) {
            job.status = 'failed';
            job.logs.push({ message: 'لا توجد مفاتيح API', type: 'error' });
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
            if (freshJob.status !== 'active') break;

            // Get Data
            const chapterIndex = novel.chapters.findIndex(c => c.number === chapterNum);
            if (chapterIndex === -1) {
                await pushLog(jobId, `فصل ${chapterNum} غير موجود`, 'warning');
                continue;
            }
            const originalChapter = novel.chapters[chapterIndex]; 
            let sourceContent = originalChapter.content || ""; 

            if (!sourceContent || sourceContent.length < 50) {
                 await pushLog(jobId, `محتوى الفصل ${chapterNum} قصير جداً`, 'warning');
                 continue;
            }

            // --- STEP 0: Prepare Glossary (Fetched FRESH every chapter) ---
            const glossaryItems = await Glossary.find({ novelId: novel._id });
            const glossaryText = glossaryItems.map(g => `"${g.term}": "${g.translation}"`).join(',\n');

            // --- KEY ROTATION HELPER ---
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
                    // Retry logic simple: redo iteration
                    chaptersToProcess.unshift(chapterNum); 
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
                
                // Use a different key if possible or rotate for distribution
                keyIndex++; 
                const modelJSON = getModel();
                // Force JSON output for extraction
                modelJSON.generationConfig = { responseMimeType: "application/json" };

                const extractionInput = `
${extractPrompt}

--- ENGLISH SOURCE ---
${sourceContent.substring(0, 8000)} 
--- ARABIC TRANSLATION ---
${translatedText.substring(0, 8000)}
--------------------------
`; 
                // Note: We trim input for extraction to avoid context limit if novel is huge, 
                // usually terms appear early or throughout. Adjust length as needed.

                const resultExt = await modelJSON.generateContent(extractionInput);
                const responseExt = await resultExt.response;
                const jsonExt = JSON.parse(responseExt.text());

                // ======================================================
                // 🔥 STEP 3: SAVE GLOSSARY & UPDATE NOVEL
                // ======================================================
                
                // A. Save Terms
                if (jsonExt.newTerms && Array.isArray(jsonExt.newTerms)) {
                    let newTermsCount = 0;
                    for (const termObj of jsonExt.newTerms) {
                        if (termObj.term && termObj.translation) {
                            // Atomic Upsert to ensure it's ready for NEXT chapter immediately
                            await Glossary.updateOne(
                                { novelId: novel._id, term: termObj.term }, 
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

                // B. Update Novel Content (Replace English with Arabic)
                novel.chapters[chapterIndex].title = `الفصل ${chapterNum}`; // Or extract title from text if needed
                novel.chapters[chapterIndex].content = translatedText;
                novel.markModified('chapters');
                await novel.save();

                // C. Update Job
                await TranslationJob.findByIdAndUpdate(jobId, {
                    $inc: { translatedCount: 1 },
                    $set: { currentChapter: chapterNum, lastUpdate: new Date() }
                });

                await pushLog(jobId, `🎉 تم إنجاز الفصل ${chapterNum} بالكامل`, 'success');

            } catch (err) {
                console.error("Extraction Error:", err);
                await pushLog(jobId, `⚠️ فشل الاستخراج (تم حفظ الترجمة فقط): ${err.message}`, 'warning');
                
                // Save translation even if extraction failed
                novel.chapters[chapterIndex].content = translatedText;
                novel.markModified('chapters');
                await novel.save();
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
