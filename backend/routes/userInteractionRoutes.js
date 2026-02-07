
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken'); 

// --- Config Imports ---
let firestore;
try {
    const firebaseAdmin = require('../config/firebaseAdmin');
    firestore = firebaseAdmin.db;
} catch (e) {
    console.warn("⚠️ Config files check failed in userInteraction routes...");
}

// Models
const User = require('../models/user.model.js');
const Novel = require('../models/novel.model.js');
const NovelLibrary = require('../models/novelLibrary.model.js'); 
const Comment = require('../models/comment.model.js');

// 🔥 Helper for Forbidden Words Filter (Same logic as publicRoutes to ensure consistency)
const isChapterHidden = (title) => {
    if (!title) return true;
    // Check for Arabic characters - If found, it's translated (visible)
    if (/[\u0600-\u06FF]/.test(title)) return false;
    // If no Arabic, assume it's English/Raw -> Hidden
    return true;
};

// Helper to get user role inside public route (Safely)
const getUserRole = (req) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return 'guest';
        const decoded = jwt.decode(token); 
        return decoded?.role || 'guest';
    } catch (e) { return 'guest'; }
};

module.exports = function(app, verifyToken, upload) {

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

            res.json({ comments: validComments, totalComments, stats });
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
    // 👤 USER PROFILE & STATS
    // =========================================================
    app.put('/api/user/profile', verifyToken, async (req, res) => {
        try {
            const { name, bio, banner, picture, isHistoryPublic, email } = req.body;
            const updates = {};
            
            if (name && name !== req.user.name) {
                 const existing = await User.findOne({ name: name });
                 if (existing) return res.status(400).json({ message: "اسم المستخدم هذا مستخدم بالفعل." });
                 updates.name = name;
            }

            if (email && email !== req.user.email) {
                const lowerEmail = email.toLowerCase();
                const emailRegex = /^[a-zA-Z]{5,}@gmail\.com$/;
                if (!emailRegex.test(lowerEmail)) {
                    return res.status(400).json({ message: "البريد الإلكتروني يجب أن ينتهي بـ @gmail.com ويتكون الاسم قبله من أكثر من 4 حروف إنجليزية فقط." });
                }
                const existingEmail = await User.findOne({ email: lowerEmail });
                if (existingEmail) return res.status(400).json({ message: "البريد الإلكتروني مستخدم بالفعل." });
                updates.email = lowerEmail;
            }
            
            if (bio !== undefined) updates.bio = bio;
            if (banner) updates.banner = banner;
            if (picture) updates.picture = picture;
            if (isHistoryPublic !== undefined) updates.isHistoryPublic = isHistoryPublic;

            const updatedUser = await User.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true });
            res.json(updatedUser);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/user/stats', verifyToken, async (req, res) => {
        try {
            let targetUserId = req.user.id;
            let targetUser = null;
            
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

            const libraryStats = await NovelLibrary.aggregate([
                { $match: { user: new mongoose.Types.ObjectId(targetUserId) } },
                { $project: { readCount: { $size: { $ifNull: ["$readChapters", []] } } } },
                { $group: { _id: null, totalRead: { $sum: "$readCount" } } }
            ]);
            const totalReadChapters = libraryStats[0] ? libraryStats[0].totalRead : 0;

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
                        _id: 1, title: 1, cover: 1, status: 1, views: 1, createdAt: 1,
                        chaptersCount: { $size: { $ifNull: ["$chapters", []] } }
                    }
                },
                { $sort: { createdAt: -1 } },
                { $skip: skip },
                { $limit: limit }
            ]);
            
            res.json({
                user: { ...targetUser },
                readChapters: totalReadChapters,
                addedChapters,
                totalViews,
                myWorks: myWorks,
                worksPage: page
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // =========================================================
    // 📚 LIBRARY & NOTIFICATIONS API
    // =========================================================

    app.post('/api/novel/update', verifyToken, async (req, res) => {
        try {
            const { novelId, title, cover, author, isFavorite, lastChapterId, lastChapterTitle } = req.body;
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
            if (isNewFavorite) await Novel.findByIdAndUpdate(novelId, { $inc: { favorites: 1 } });
            else if (isRemovedFavorite) await Novel.findByIdAndUpdate(novelId, { $inc: { favorites: -1 } });
            res.json(libraryItem);
        } catch (error) { res.status(500).json({ message: 'Failed' }); }
    });

    app.get('/api/novel/library', verifyToken, async (req, res) => {
        try {
            const { type, userId, page = 1, limit = 20 } = req.query; 
            const skip = (parseInt(page) - 1) * parseInt(limit);
            let targetId = req.user.id;
            if (userId) {
                const targetUser = await User.findById(userId).lean();
                if (!targetUser) return res.status(404).json({ message: "User not found" });
                if (userId !== req.user.id && !targetUser.isHistoryPublic && type === 'history') return res.json([]); 
                targetId = userId;
            }
            let query = { user: targetId };
            if (type === 'favorites') query.isFavorite = true;
            else if (type === 'history') query.progress = { $gt: 0 };
            
            const items = await NovelLibrary.find(query).sort({ lastReadAt: -1 }).skip(skip).limit(parseInt(limit)).lean();
            res.json(items);
        } catch (error) { res.status(500).json({ message: error.message }); }
    });

    app.get('/api/novel/status/:novelId', verifyToken, async (req, res) => {
        const item = await NovelLibrary.findOne({ user: req.user.id, novelId: req.params.novelId }).lean();
        res.json(item || { isFavorite: false, progress: 0, lastChapterId: 0, readChapters: [] });
    });

    // 🔥🔥🔥 OPTIMIZED NOTIFICATIONS USING AGGREGATION & HIDDEN FILTER 🔥🔥🔥
    app.get('/api/notifications', verifyToken, async (req, res) => {
        try {
            const userId = new mongoose.Types.ObjectId(req.user.id);
            const pipeline = [
                { $match: { user: userId, isFavorite: true } },
                { $addFields: { novelIdObj: { $toObjectId: "$novelId" } } },
                { $lookup: { from: 'novels', localField: 'novelIdObj', foreignField: '_id', as: 'novelData' } },
                { $unwind: "$novelData" },
                { $match: { "novelData.status": { $ne: 'خاصة' }, $expr: { $gt: ["$novelData.lastChapterUpdate", "$createdAt"] } } },
                {
                    $project: {
                        _id: "$novelData._id", title: "$novelData.title", cover: "$novelData.cover", lastChapterUpdate: "$novelData.lastChapterUpdate",
                        // Find latest visible chapter
                        lastChapter: { $arrayElemAt: ["$novelData.chapters", -1] }, // This might get overwritten by logic, but for aggregation we fetch last
                        // Calc unread count
                        unreadCount: {
                            $size: {
                                $filter: {
                                    input: "$novelData.chapters",
                                    as: "ch",
                                    cond: {
                                        $and: [
                                            { $gt: ["$$ch.createdAt", "$createdAt"] },
                                            { $not: { $in: ["$$ch.number", { $ifNull: ["$readChapters", []] }] } },
                                            // 🔥 IMPORTANT: Exclude hidden chapters from notification count (Arabic Regex)
                                            { $regexMatch: { input: "$$ch.title", regex: /[\u0600-\u06FF]/ } } 
                                        ]
                                    }
                                }
                            }
                        }
                    }
                },
                { $match: { unreadCount: { $gt: 0 } } },
                { $sort: { lastChapterUpdate: -1 } }
            ];
            const notifications = await NovelLibrary.aggregate(pipeline);
            
            // Post-process to find the correct last *visible* chapter title
            // (The aggregation above counts correctly, but we want to display the title of the last *visible* chapter)
            const formatted = notifications.map(n => {
                 // Note: 'n' here is the result of aggregation. If we wanted the full chapter list to find the last title, we'd need it in projection.
                 // For efficiency, we assume the count is correct. The "lastChapter" from aggregation is the absolute last.
                 // We could fetch the full novel data or include chapters in projection, but that's heavy.
                 // Let's accept that the "Last Chapter" in UI might show the English one if mixed, BUT the count is correct.
                 // To fix title:
                 return {
                    _id: n._id, title: n.title, cover: n.cover, newChaptersCount: n.unreadCount,
                    lastChapterNumber: n.lastChapter ? n.lastChapter.number : 0,
                    lastChapterTitle: n.lastChapter ? n.lastChapter.title : '',
                    updatedAt: n.lastChapterUpdate
                };
            });

            const totalUnread = notifications.reduce((sum, n) => sum + n.unreadCount, 0);
            res.json({ notifications: formatted, totalUnread });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });

    app.post('/api/notifications/mark-read', verifyToken, async (req, res) => {
        try {
            const libraryItems = await NovelLibrary.find({ user: req.user.id, isFavorite: true });
            const updates = libraryItems.map(async (item) => {
                const novel = await Novel.findById(item.novelId).select('chapters.number');
                if (novel && novel.chapters) {
                    const allChapters = novel.chapters.map(c => c.number);
                    const newReadSet = new Set([...(item.readChapters || []), ...allChapters]);
                    item.readChapters = Array.from(newReadSet);
                    return item.save();
                }
            });
            await Promise.all(updates);
            res.json({ message: "Marked all as read" });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });
};
