
const mongoose = require('mongoose');

const chapterSchema = new mongoose.Schema({
    number: { type: Number, required: true },
    title: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }, 
    views: { type: Number, default: 0 }
});

const novelSchema = new mongoose.Schema({
    title: { type: String, required: true, index: true },
    titleEn: { type: String },
    author: { type: String, required: true }, 
    authorEmail: { type: String }, 
    cover: { type: String }, 
    description: { type: String },
    category: { type: String, index: true },
    tags: [{ type: String, index: true }], // 🔥 Added index to tags
    status: { type: String, default: 'مستمرة' },
    rating: { type: Number, default: 0 },
    
    views: { type: Number, default: 0 }, 
    viewedBy: [{ type: String }], 

    dailyViews: { type: Number, default: 0 },
    weeklyViews: { type: Number, default: 0 },
    monthlyViews: { type: Number, default: 0 },
    
    favorites: { type: Number, default: 0 },
    
    reactions: {
        like: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], 
        love: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], 
        funny: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], 
        sad: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], 
        angry: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] 
    },

    chapters: [chapterSchema],
    lastChapterUpdate: { type: Date, default: Date.now },
    isRecommended: { type: Boolean, default: false },
    isTrending: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

novelSchema.index({ title: 'text', author: 'text' });
novelSchema.index({ views: -1 });
novelSchema.index({ lastChapterUpdate: -1 });
novelSchema.index({ authorEmail: 1 }); 

const Novel = mongoose.model('Novel', novelSchema);
module.exports = Novel;
