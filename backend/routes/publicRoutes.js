
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
const NovelLibrary = require('../models/novelLibrary.model.js'); 
const Comment = require('../models/comment.model.js');
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

// 🔥 Helper for Forbidden Words Filter
const isChapterHidden = (title) => {
    if (!title) return true;
    const lower = title.toLowerCase();
    const forbidden = ['chapter', 'ago', 'month', 'week', 'day', 'year', 'years', 'months', 'weeks', 'days'];
    return forbidden.some(word => lower.includes(word));
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
            }).sort({ updatedAt: -1 }); // Get latest active settings if multiple admins

            let masterList = [];
            
            if (adminSettings && adminSettings.managedCategories && adminSettings.managedCategories.length > 0) {
                masterList = adminSettings.managedCategories;
            } else {
                // Fallback: Combine Fixed + Dynamic from Novels
                const distinctCategories = await Novel.distinct('category');
                const distinctTags = await Novel.distinct('tags');
                masterList = [
                    ...BASE_CATEGORIES,
                    ...distinctCategories.filter(c => c), 
                    ...distinctTags.filter(t => t)
                ];
            }

            // Remove duplicates and sort
            const uniqueCats = Array.from(new Set(masterList)).sort();

            // Return objects
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
    // 🎭 NOVEL REACTIONS API
    // =========================================================
    app.post('/api/novels/:novelId/react', verifyToken, async (req, res) => {
        try {
            const { type } = req.body; 
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
    // 💬 COMMENTS API 
    // =========================================================
    app.get('/api/novels/:novelId/comments', async (req, res) => {
        try {
            const { novelId } = req.params;
            const { sort = 'newest', page = 1, limit = 20, chapterNumber } = req.query;
            
            const novel = await Novel.findById(novelId).select('reactions').lean();
            let stats = { like: 0, love: 0, funny: 0, sad: 0, angry: 0, total: 0, userReaction: null };
            
            if (novel && novel.reactions) {
                stats.like = novel.reactions.like?.length || 0;
                stats.love = novel.reactions.love?.length || 0;
                stats.funny = novel.reactions.funny?.length || 0;
                stats.sad = novel.reactions.sad?.length || 0;
                stats.angry = novel.reactions.angry?.length || 0;
                stats.total = stats.like + stats.love + stats.funny + stats.sad + stats.angry;
            }

            let query = { novelId, parentId: null };
            
            if (chapterNumber) {
                query.chapterNumber = parseInt(chapterNumber);
            } else {
                query.chapterNumber = null; 
            }

            let sortOption = { createdAt: -1 };
            if (sort === 'oldest') sortOption = { createdAt: 1 };
            if (sort === 'best') sortOption = { likes: -1 }; 

            const comments = await Comment.find(query)
                .populate('user', 'name picture role isCommentBlocked')
                .populate({ path: 'replyCount' })
                .sort(sortOption)
                .skip((page - 1) * limit)
                .limit(parseInt(limit))
                .lean(); 

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

    app.get('/api/comments/:commentId/replies', async (req, res) => {
        try {
            const replies = await Comment.find({ parentId: req.params.commentId })
                .populate('user', 'name picture role')
                .sort({ createdAt: 1 })
                .lean();
            
            res.json(replies.filter(r => r.user !== null));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/comments', verifyToken, async (req, res) => {
        try {
            const { novelId, content, parentId, chapterNumber } = req.body;
            
            const currentUser = await User.findById(req.user.id).select('isCommentBlocked');
            if (currentUser.isCommentBlocked) {
                return res.status(403).json({ message: "أنت ممنوع من التعليق." });
            }

            if (!content || !content.trim()) return res.status(400).json({message: "Content required"});

            const newComment = new Comment({
                novelId,
                user: req.user.id,
                content: content.trim(),
                parentId: parentId || null,
                chapterNumber: chapterNumber ? parseInt(chapterNumber) : null 
            });

            await newComment.save();
            await newComment.populate('user', 'name picture role');

            res.json(newComment);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.put('/api/comments/:commentId', verifyToken, async (req, res) => {
        try {
            const { content } = req.body;
            const comment = await Comment.findById(req.params.commentId);
            
            if (!comment) return res.status(404).json({message: "Comment not found"});
            
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

    // =========================================================
    // 👤 USER PROFILE API
    // =========================================================

    app.put('/api/user/profile', verifyToken, async (req, res) => {
        try {
            const { name, bio, banner, picture, isHistoryPublic, email } = req.body;
            
            const updates = {};
            
            if (name && name !== req.user.name) {
                 const existing = await User.findOne({ name: name });
                 if (existing) {
                     return res.status(400).json({ message: "اسم المستخدم هذا مستخدم بالفعل." });
                 }
                 updates.name = name;
            }

            // 🔥 Validate and Update Email
            if (email && email !== req.user.email) {
                const lowerEmail = email.toLowerCase();
                const emailRegex = /^[a-zA-Z]{5,}@gmail\.com$/;
                if (!emailRegex.test(lowerEmail)) {
                    return res.status(400).json({ 
                        message: "البريد الإلكتروني يجب أن ينتهي بـ @gmail.com ويتكون الاسم قبله من أكثر من 4 حروف إنجليزية فقط." 
                    });
                }
                const existingEmail = await User.findOne({ email: lowerEmail });
                if (existingEmail) {
                    return res.status(400).json({ message: "البريد الإلكتروني مستخدم بالفعل." });
                }
                updates.email = lowerEmail;
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

    app.get('/api/user/stats', verifyToken, async (req, res) => {
        try {
            let targetUserId = req.user.id;
            let targetUser = null;
            
            // Pagination Params
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const skip = (page - 1) * limit;

            if (req.query.userId) {
                targetUserId = req.query.userId;
                targetUser = await User.findById(targetUserId).lean();
            } else if (req.query.email) {
                targetUser = await User.findOne({ email: req.query.email }).lean();
                if (targetUser) targetUserId = targetUser._id;
            } else {
                targetUser = await User.findById(targetUserId).lean();
            }

            if (!targetUser) return res.status(404).json({ message: "User not found" });

            // 1. Library Stats
            const libraryStats = await NovelLibrary.aggregate([
                { $match: { user: new mongoose.Types.ObjectId(targetUserId) } },
                { $project: { readCount: { $size: { $ifNull: ["$readChapters", []] } } } },
                { $group: { _id: null, totalRead: { $sum: "$readCount" } } }
            ]);
            const totalReadChapters = libraryStats[0] ? libraryStats[0].totalRead : 0;

            // 2. My Works Stats
            const worksStats = await Novel.aggregate([
                { 
                    $match: { 
                        $or: [
                            { authorEmail: targetUser.email },
                            { author: { $regex: new RegExp(`^${targetUser.name}$`, 'i') } } 
                        ]
                    } 
                },
                {
                    $group: {
                        _id: null,
                        totalViews: { $sum: "$views" },
                        totalChapters: { $sum: { $size: { $ifNull: ["$chapters", []] } } }
                    }
                }
            ]);

            const addedChapters = worksStats[0] ? worksStats[0].totalChapters : 0;
            const totalViews = worksStats[0] ? worksStats[0].totalViews : 0;

            // 3. Lightweight My Works List (PAGINATED)
            // Sort: Descending (First Added to Last Added -> Newest first) - createdAt: -1
            const myWorks = await Novel.aggregate([
                { 
                    $match: { 
                        $or: [
                            { authorEmail: targetUser.email },
                            { author: { $regex: new RegExp(`^${targetUser.name}$`, 'i') } } 
                        ]
                    } 
                },
                {
                    $project: {
                        _id: 1,
                        title: 1,
                        cover: 1,
                        status: 1,
                        views: 1,
                        createdAt: 1,
                        chaptersCount: { $size: { $ifNull: ["$chapters", []] } }
                    }
                },
                { $sort: { createdAt: -1 } }, // Descending (Newest First)
                { $skip: skip },
                { $limit: limit }
            ]);
            
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
                myWorks: myWorks,
                worksPage: page
            });

        } catch (error) {
            console.error("Stats Error:", error);
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
            res.status(500).send('Error'); 
        }
    });

    // 🔥 Rocket Speed Home Screen Aggregation 🔥
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

            // 🔥 FIX: Direct match for categories
            if (category && category !== 'all') {
                matchStage.$or = [{ category: category }, { tags: category }];
            }

            if (status && status !== 'all') {
                matchStage.status = status; 
            }

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
                        title: 1,
                        cover: 1,
                        author: 1,
                        category: 1,
                        tags: 1,
                        status: 1,
                        views: 1,
                        dailyViews: 1,
                        weeklyViews: 1,
                        monthlyViews: 1,
                        lastChapterUpdate: 1,
                        createdAt: 1,
                        rating: 1,
                        chaptersCount: { $size: { $ifNull: ["$chapters", []] } },
                        lastChapter: { $arrayElemAt: ["$chapters", -1] }
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
            
            if (role !== 'admin') {
                novelsData = novelsData.map(n => {
                    let safeLastChapter = n.lastChapter;
                    if (safeLastChapter && isChapterHidden(safeLastChapter.title)) {
                        safeLastChapter = null; 
                    }
                    return { ...n, chapters: safeLastChapter ? [safeLastChapter] : [] };
                });
            } else {
                novelsData = novelsData.map(n => ({ ...n, chapters: n.lastChapter ? [n.lastChapter] : [] }));
            }

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
            if (!mongoose.Types.ObjectId.isValid(novelId)) return res.status(404).json({ message: 'Invalid ID' });

            const novel = await Novel.findById(novelId).lean();
            if (!novel) return res.status(404).json({ message: 'Novel not found' });

            const role = getUserRole(req);
            if (novel.status === 'خاصة' && role !== 'admin') {
                return res.status(403).json({ message: "Access Denied" });
            }

            let chapterMeta = novel.chapters.find(c => c._id.toString() === chapterId) || 
                              novel.chapters.find(c => c.number == chapterId);

            if (!chapterMeta) return res.status(404).json({ message: 'Chapter metadata not found' });

            if (role !== 'admin') {
                if (isChapterHidden(chapterMeta.title)) {
                    return res.status(403).json({ message: "Chapter not available yet" });
                }
            }

            let content = "لا يوجد محتوى.";
            
            if (firestore) {
                const docRef = firestore.collection('novels').doc(novelId).collection('chapters').doc(chapterMeta.number.toString());
                const docSnap = await docRef.get();
                if (docSnap.exists) {
                    content = docSnap.data().content;
                }
            }

            // 🔥 CLEANER + COPYRIGHTS INJECTION 🔥
            try {
                // Fetch settings for both Blocklist AND Global Copyrights
                // We assume there's a master settings doc (either created by main admin or first one found)
                const adminSettings = await Settings.findOne({ 
                    $or: [
                        { globalBlocklist: { $exists: true, $not: { $size: 0 } } },
                        { globalChapterStartText: { $exists: true } }
                    ] 
                }).sort({ updatedAt: -1 }).lean(); // Get the latest updated one

                if (adminSettings) {
                    // 1. Cleaner Logic
                    if (adminSettings.globalBlocklist && adminSettings.globalBlocklist.length > 0) {
                        const blocklist = adminSettings.globalBlocklist;
                        blocklist.forEach(word => {
                            if (!word) return;
                            if (word.includes('\n') || word.includes('\r')) {
                                content = content.split(word).join('');
                            } else {
                                const escapedKeyword = escapeRegExp(word);
                                const regex = new RegExp(`^.*${escapedKeyword}.*$`, 'gm');
                                content = content.replace(regex, '');
                            }
                        });
                    }

                    // 2. Formatting cleanup
                    content = content.replace(/^\s*[\r\n]/gm, ''); 
                    content = content.replace(/\n\s*\n/g, '\n\n'); 

                    // 3. Inject Copyrights (If they exist)
                    const startText = adminSettings.globalChapterStartText;
                    const endText = adminSettings.globalChapterEndText;

                    if (startText && startText.trim().length > 0) {
                        const styledStart = `<div style="text-align: center; font-weight: bold; margin-bottom: 20px; color: #888; border-bottom: 1px solid #333; padding-bottom: 10px;">${startText}</div>`;
                        // Prepend
                        content = `${styledStart}\n\n${content}`;
                    }

                    if (endText && endText.trim().length > 0) {
                        const styledEnd = `<div style="text-align: center; font-weight: bold; margin-top: 20px; color: #888; border-top: 1px solid #333; padding-top: 10px;">${endText}</div>`;
                        // Append
                        content = `${content}\n\n${styledEnd}`;
                    }
                }
            } catch (cleanerErr) {}

            let totalAvailable = novel.chapters.length;
            if (role !== 'admin') {
                totalAvailable = novel.chapters.filter(c => !isChapterHidden(c.title)).length;
            }

            res.json({ 
                ...chapterMeta, 
                content: content,
                totalChapters: totalAvailable
            });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    });

    app.post('/api/novel/update', verifyToken, async (req, res) => {
        try {
            const { novelId, title, cover, author, isFavorite, lastChapterId, lastChapterTitle } = req.body;
            if (!novelId || !mongoose.Types.ObjectId.isValid(novelId)) return res.status(400).json({ message: 'Invalid ID' });

            const originalNovel = await Novel.findById(novelId).select('chapters');
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
            const { type, userId, page = 1, limit = 20 } = req.query; 
            const pageNum = parseInt(page);
            const limitNum = parseInt(limit);
            const skip = (pageNum - 1) * limitNum;

            let targetId = req.user.id;
            
            if (userId) {
                const targetUser = await User.findById(userId).lean();
                if (!targetUser) return res.status(404).json({ message: "User not found" });
                if (userId !== req.user.id && !targetUser.isHistoryPublic && type === 'history') {
                     return res.json([]); 
                }
                targetId = userId;
            }

            let query = { user: targetId };
            if (type === 'favorites') query.isFavorite = true;
            else if (type === 'history') query.progress = { $gt: 0 };
            
            const items = await NovelLibrary.find(query)
                .sort({ lastReadAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean();
            
            res.json(items);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    });

    app.get('/api/novel/status/:novelId', verifyToken, async (req, res) => {
        const item = await NovelLibrary.findOne({ user: req.user.id, novelId: req.params.novelId }).lean();
        const readChapters = item ? item.readChapters : [];
        res.json(item || { isFavorite: false, progress: 0, lastChapterId: 0, readChapters: [] });
    });

    // 🔥🔥🔥 OPTIMIZED NOTIFICATIONS USING AGGREGATION 🔥🔥🔥
    app.get('/api/notifications', verifyToken, async (req, res) => {
        try {
            const userId = new mongoose.Types.ObjectId(req.user.id);

            // 1. Get User Favorites (NovelLibrary)
            // 2. Lookup actual Novels data
            // 3. Compare dates efficiently inside DB
            
            const pipeline = [
                // Step 1: Match user's favorite library entries
                { 
                    $match: { 
                        user: userId, 
                        isFavorite: true 
                    } 
                },
                // Step 2: Convert novelId string to ObjectId for lookup (if needed, assuming NovelLibrary uses string for novelId based on schema)
                // Since NovelLibrarySchema says novelId: String, but Novel _id is ObjectId.
                {
                    $addFields: {
                        novelIdObj: { $toObjectId: "$novelId" }
                    }
                },
                // Step 3: Join with Novels collection to get chapter updates
                {
                    $lookup: {
                        from: 'novels',
                        localField: 'novelIdObj',
                        foreignField: '_id',
                        as: 'novelData'
                    }
                },
                // Step 4: Unwind the novel data (since lookup returns an array)
                { $unwind: "$novelData" },
                
                // Step 5: Filter out hidden/private novels
                { 
                    $match: { 
                        "novelData.status": { $ne: 'خاصة' } 
                    } 
                },

                // Step 6: Filter novels where Last Update is AFTER the library creation/update
                // This is a quick pre-filter to avoid checking chapters of old novels
                {
                    $match: {
                        $expr: { $gt: ["$novelData.lastChapterUpdate", "$createdAt"] }
                    }
                },

                // Step 7: Project only what we need to calculate unread count
                // We calculate unread by filtering the chapters array directly in projection
                {
                    $project: {
                        _id: "$novelData._id",
                        title: "$novelData.title",
                        cover: "$novelData.cover",
                        lastChapterUpdate: "$novelData.lastChapterUpdate",
                        // Get the latest chapter details
                        lastChapter: { $arrayElemAt: ["$novelData.chapters", -1] },
                        // Calculate unread count:
                        // Filter chapters where createdAt > library.createdAt AND number NOT IN library.readChapters
                        unreadCount: {
                            $size: {
                                $filter: {
                                    input: "$novelData.chapters",
                                    as: "ch",
                                    cond: {
                                        $and: [
                                            { $gt: ["$$ch.createdAt", "$createdAt"] }, // Chapter is newer than when user favored it
                                            { $not: { $in: ["$$ch.number", { $ifNull: ["$readChapters", []] }] } } // Chapter not read
                                        ]
                                    }
                                }
                            }
                        }
                    }
                },
                
                // Step 8: Only keep results with > 0 unread
                { $match: { unreadCount: { $gt: 0 } } },
                
                // Step 9: Sort by latest update
                { $sort: { lastChapterUpdate: -1 } }
            ];

            const notifications = await NovelLibrary.aggregate(pipeline);
            
            // Calculate total unread badge
            const totalUnread = notifications.reduce((sum, n) => sum + n.unreadCount, 0);

            // Format for UI
            const formattedNotifications = notifications.map(n => ({
                _id: n._id,
                title: n.title,
                cover: n.cover,
                newChaptersCount: n.unreadCount,
                lastChapterNumber: n.lastChapter ? n.lastChapter.number : 0,
                lastChapterTitle: n.lastChapter ? n.lastChapter.title : '',
                updatedAt: n.lastChapterUpdate
            }));

            res.json({ notifications: formattedNotifications, totalUnread });

        } catch (error) {
            console.error("Aggregation Notifications Error:", error);
            res.status(500).json({ error: error.message });
        }
    });

    // 🔥🔥🔥 MARK ALL AS READ 🔥🔥🔥
    app.post('/api/notifications/mark-read', verifyToken, async (req, res) => {
        try {
            // Fetch all favorite library entries for the user
            const libraryItems = await NovelLibrary.find({ user: req.user.id, isFavorite: true });
            
            const updates = libraryItems.map(async (item) => {
                const novel = await Novel.findById(item.novelId).select('chapters.number');
                if (novel && novel.chapters) {
                    const allChapters = novel.chapters.map(c => c.number);
                    // Merge existing read chapters with all available chapters
                    // converting to Set to remove duplicates, then back to array
                    const newReadSet = new Set([...(item.readChapters || []), ...allChapters]);
                    item.readChapters = Array.from(newReadSet);
                    return item.save();
                }
            });

            await Promise.all(updates);
            res.json({ message: "Marked all as read" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
};
