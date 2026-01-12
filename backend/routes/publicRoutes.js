
const mongoose = require('mongoose');

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

module.exports = function(app, verifyToken, upload) {

    // =========================================================
    // 🖼️ UPLOAD API (User Profile Uploads)
    // =========================================================
    app.post('/api/upload', verifyToken, upload.single('image'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ message: "No file uploaded" });

            // التحويل إلى Base64 مع معالجة أفضل للذاكرة
            const b64 = Buffer.from(req.file.buffer).toString('base64');
            let dataURI = "data:" + req.file.mimetype + ";base64," + b64;
            
            const result = await cloudinary.uploader.upload(dataURI, {
                folder: "zeus_user_uploads",
                resource_type: "auto" // السماح بجميع أنواع الصور
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

            // Project only necessary fields for works list to avoid large payload
            myWorks = await Novel.find({ 
                $or: [
                    { authorEmail: targetUser.email },
                    { author: { $regex: new RegExp(`^${targetUser.name}$`, 'i') } } 
                ]
            }).select('title cover status views chapters');
            
            myWorks.forEach(novel => {
                addedChapters += (novel.chapters ? novel.chapters.length : 0);
                totalViews += (novel.views || 0);
            });

            // Map works to lightweight objects
            const lightWorks = myWorks.map(novel => ({
                _id: novel._id,
                title: novel.title,
                cover: novel.cover,
                status: novel.status,
                views: novel.views,
                chaptersCount: novel.chapters ? novel.chapters.length : 0
            }));
            
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
                myWorks: lightWorks
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

            // 🔥 OPTIMIZATION: Do not load the entire chapters array!
            // We use $project to exclude 'chapters' and only calculate its size
            // This massively reduces the payload size (from MBs to KBs)
            
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
                        // Calculate count without returning the array
                        chaptersCount: { $size: { $ifNull: ["$chapters", []] } },
                        // For 'latest updates', we might need the last chapter's meta data
                        // Get ONLY the last element of the array
                        chapters: { $slice: ["$chapters", -1] } 
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
            
            // Note: For Detail screen, we usually need the full chapter list (titles/numbers),
            // but not the CONTENT of the chapters. The Model schema defines chapters as
            // { number, title, createdAt, views }. Content is stored in Firestore or inside ZIPs usually.
            // If `chapterSchema` in Mongoose has `content`, we MUST exclude it here too.
            // Assuming `chapterSchema` only has metadata based on `novel.model.js`.
            
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
};
