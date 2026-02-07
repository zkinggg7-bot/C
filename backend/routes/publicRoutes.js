
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken'); 

// --- Config Imports ---
let firestore, cloudinary;
try {
    const firebaseAdmin = require('../config/firebaseAdmin');
    firestore = firebaseAdmin.db;
    cloudinary = require('../config/cloudinary');
} catch (e) {
    console.warn("⚠️ Config files check failed in public routes...");
}

// Models
const User = require('../models/user.model.js');
const Novel = require('../models/novel.model.js');
const Settings = require('../models/settings.model.js'); 

// Helper to escape regex special characters
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Helper to get user role inside public route (Safely)
const getUserRole = (req) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return 'guest';
        const decoded = jwt.decode(token); 
        return decoded?.role || 'guest';
    } catch (e) { return 'guest'; }
};

// Helper to check and update status automatically
async function checkNovelStatus(novel) {
    if (novel.status === 'مكتملة') return novel; 

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    if (novel.lastChapterUpdate < thirtyDaysAgo && novel.status === 'مستمرة') {
        novel.status = 'متوقفة';
        await novel.save();
    }
    return novel;
}

// 🔥 Helper for Forbidden Words Filter (Hidden Chapters)
const isChapterHidden = (title) => {
    if (!title) return true;
    // Check for Arabic characters - If found, it's translated (visible)
    if (/[\u0600-\u06FF]/.test(title)) return false;
    // If no Arabic, assume it's English/Raw -> Hidden
    return true;
};

// 🔥 Fixed Categories (Baseline) - If DB is empty
const BASE_CATEGORIES = [
    'أكشن', 'رومانسي', 'فانتازيا', 'شيانشيا', 'شوانهوان', 'وشيا', 
    'مغامرات', 'نظام', 'حريم', 'رعب', 'خيال علمي', 'دراما', 'غموض', 'تاريخي'
];

module.exports = function(app, verifyToken, upload) {

    // =========================================================
    // 📂 CATEGORIES API (Managed + Dynamic fallback)
    // =========================================================
    app.get('/api/categories', async (req, res) => {
        try {
            // 1. Try to fetch from Admin Settings (The Source of Truth)
            const adminSettings = await Settings.findOne({ 
                managedCategories: { $exists: true, $not: { $size: 0 } } 
            }).sort({ updatedAt: -1 }); 

            let masterList = [];
            
            if (adminSettings && adminSettings.managedCategories && adminSettings.managedCategories.length > 0) {
                masterList = adminSettings.managedCategories;
            } else {
                // Fallback
                const distinctCategories = await Novel.distinct('category');
                const distinctTags = await Novel.distinct('tags');
                masterList = [
                    ...BASE_CATEGORIES,
                    ...distinctCategories.filter(c => c), 
                    ...distinctTags.filter(t => t)
                ];
            }

            const uniqueCats = Array.from(new Set(masterList)).sort();
            const responseData = uniqueCats.map(c => ({ id: c, name: c }));
            responseData.unshift({ id: 'all', name: 'الكل' });

            res.json(responseData);
        } catch (error) {
            console.error("Categories Fetch Error:", error);
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
                resource_type: "auto" 
            });

            res.json({ url: result.secure_url });
        } catch (error) {
            console.error("Upload Error:", error);
            res.status(500).json({ error: error.message || "Failed to upload image" });
        }
    });

    // =========================================================
    // 🔥 NOVELS & HOME API (UPDATED FOR TRANSLATED CHAPTERS) 🔥
    // =========================================================

    app.post('/api/novels/:id/view', verifyToken, async (req, res) => {
        try {
            if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).send('Invalid ID');
            const { chapterNumber } = req.body; 
            if (!chapterNumber) return res.status(200).json({ message: 'Chapter number required' });

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
                return res.status(200).json({ viewed: false, message: 'Already viewed', total: novel.views });
            }
        } catch (error) { 
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

            const role = getUserRole(req);
            if (role !== 'admin') {
                matchStage.status = { $ne: 'خاصة' };
            }

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

            // Only show novels with at least 1 chapter if looking for updates
            if (filter === 'latest_updates') {
                matchStage["chapters.0"] = { $exists: true };
            }

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

            const pipeline = [
                { $match: matchStage },
                { 
                    $project: {
                        title: 1, cover: 1, author: 1, category: 1, tags: 1, status: 1,
                        views: 1, dailyViews: 1, weeklyViews: 1, monthlyViews: 1,
                        lastChapterUpdate: 1, createdAt: 1, rating: 1, sourceUrl: 1,
                        chaptersCount: { $size: { $ifNull: ["$chapters", []] } },
                        // Grab full chapters array to filter in JS (or slice if too big)
                        // Limiting to last 50 chapters for performance in aggregation
                        chapters: { $slice: ["$chapters", -50] } 
                    }
                },
                { $sort: sortStage },
                {
                    $facet: {
                        metadata: [{ $count: "total" }],
                        data: [{ $skip: skip }, { $limit: limitNum }]
                    }
                }
            ];

            const result = await Novel.aggregate(pipeline);
            let novelsData = result[0].data;
            
            // 🔥 LOGIC CHANGE: Find the LAST VISIBLE (TRANSLATED) CHAPTER
            novelsData = novelsData.map(n => {
                let displayChapter = null;
                
                // If admin, show absolute last
                if (role === 'admin') {
                    if (n.chapters && n.chapters.length > 0) {
                        displayChapter = n.chapters[n.chapters.length - 1]; // Last one
                    }
                } else {
                    // For users, iterate backwards to find first non-hidden chapter
                    if (n.chapters && n.chapters.length > 0) {
                        for (let i = n.chapters.length - 1; i >= 0; i--) {
                            const ch = n.chapters[i];
                            if (!isChapterHidden(ch.title)) {
                                displayChapter = ch;
                                break; 
                            }
                        }
                    }
                }

                // Clean up the object to return lightweight data
                return {
                    ...n,
                    chapters: displayChapter ? [displayChapter] : [] // Only return the relevant chapter for the card
                };
            });

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
            
            let novelDoc = await Novel.findById(req.params.id).lean();
            if (!novelDoc) return res.status(404).json({ message: 'Novel not found' });
            
            const role = getUserRole(req);
            if (novelDoc.status === 'خاصة' && role !== 'admin') {
                return res.status(403).json({ message: "Access Denied" });
            }

            checkNovelStatus(await Novel.findById(req.params.id)); 

            if (role !== 'admin') {
                if (novelDoc.chapters) {
                    novelDoc.chapters = novelDoc.chapters.filter(c => !isChapterHidden(c.title));
                }
            } else {
                if (novelDoc.chapters) {
                    novelDoc.chapters.sort((a, b) => b.number - a.number);
                }
            }

            novelDoc.chaptersCount = novelDoc.chapters ? novelDoc.chapters.length : 0;
            res.json(novelDoc);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    });

    app.get('/api/novels/:novelId/chapters/:chapterId', async (req, res) => {
        try {
            const { novelId, chapterId } = req.params;
            const novel = await Novel.findById(novelId).lean();
            if (!novel) return res.status(404).json({ message: 'Novel not found' });

            const role = getUserRole(req);
            let chapterMeta = novel.chapters.find(c => c._id.toString() === chapterId) || 
                              novel.chapters.find(c => c.number == chapterId);

            if (!chapterMeta) return res.status(404).json({ message: 'Chapter metadata not found' });

            if (role !== 'admin' && isChapterHidden(chapterMeta.title)) {
                return res.status(403).json({ message: "Chapter not available yet" });
            }

            let content = "لا يوجد محتوى.";
            if (firestore) {
                const docRef = firestore.collection('novels').doc(novelId).collection('chapters').doc(chapterMeta.number.toString());
                const docSnap = await docRef.get();
                if (docSnap.exists) content = docSnap.data().content;
            }

            // Cleaner & Copyright Logic (Same as before)
            let copyrightStart = "";
            let copyrightEnd = "";
            let copyrightStyles = {};

            try {
                const adminSettings = await Settings.findOne({ 
                    $or: [ { globalBlocklist: { $exists: true } }, { globalChapterStartText: { $exists: true } } ] 
                }).sort({ updatedAt: -1 }).lean(); 

                if (adminSettings) {
                    if (adminSettings.globalBlocklist && adminSettings.globalBlocklist.length > 0) {
                        adminSettings.globalBlocklist.forEach(word => {
                            if (!word) return;
                            if (word.includes('\n')) content = content.split(word).join('');
                            else content = content.replace(new RegExp(`^.*${escapeRegExp(word)}.*$`, 'gm'), '');
                        });
                    }
                    content = content.replace(/^\s*[\r\n]/gm, '').replace(/\n\s*\n/g, '\n\n'); 
                    
                    const separatorLine = "\n\n___________________________________________________________________\n\n";
                    const internalTitleRegex = /(^|\n)(.*(?:الفصل|Chapter).*?)(\n|$)/gi;
                    if (internalTitleRegex.test(content)) {
                        content = content.replace(internalTitleRegex, '$1$2' + separatorLine + '$3');
                    }

                    const frequency = adminSettings.copyrightFrequency || 'always';
                    const everyX = adminSettings.copyrightEveryX || 5;
                    const chapNum = parseInt(chapterMeta.number);
                    let showCopyright = true;
                    if (frequency === 'random' && Math.random() > 0.5) showCopyright = false;
                    else if (frequency === 'every_x' && chapNum % everyX !== 0) showCopyright = false;

                    if (showCopyright) {
                        copyrightStart = adminSettings.globalChapterStartText || "";
                        copyrightEnd = adminSettings.globalChapterEndText || "";
                        copyrightStyles = adminSettings.globalCopyrightStyles || {};
                        if (!copyrightStyles.fontSize) copyrightStyles.fontSize = 14; 
                    }
                }
            } catch (err) {}

            let totalAvailable = novel.chapters.length;
            if (role !== 'admin') totalAvailable = novel.chapters.filter(c => !isChapterHidden(c.title)).length;

            res.json({ 
                ...chapterMeta, 
                content, copyrightStart, copyrightEnd, copyrightStyles, 
                totalChapters: totalAvailable
            });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    });
};
