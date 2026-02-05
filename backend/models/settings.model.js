
const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    provider: { type: String, default: 'gemini' },
    model: { type: String, default: 'gemini-1.5-flash' },
    temperature: { type: Number, default: 0.7 },
    geminiApiKeys: [{ key: String, status: String }],
    openrouterApiKeys: [{ key: String, status: String }],
    customProviders: [{
        id: String,
        name: String,
        baseUrl: String,
        models: [{ id: String, name: String }],
        apiKeys: [{ key: String, status: String }]
    }],
    customPrompt: { type: String, default: '' },
    
    // 🔥 Translator Specific Settings
    translatorModel: { type: String, default: 'gemini-2.5-flash' }, 
    translatorExtractPrompt: { type: String, default: '' },
    translatorApiKeys: [{ type: String }], // Global Keys for Translator
    
    // 🔥 Categories Management (Master List)
    managedCategories: [{ type: String }],
    
    // 🔥 Category Normalization Rules (Dynamic)
    // Example: [{ original: 'قتال', target: 'فنون قتالية' }]
    categoryNormalizationRules: [{ 
        original: { type: String, required: true }, 
        target: { type: String, required: true } 
    }],

    fontSize: { type: Number, default: 18 },
    globalBlocklist: [{ type: String }],

    // 🔥 Global App Rights (Copyrights)
    globalChapterStartText: { type: String, default: '' },
    globalChapterEndText: { type: String, default: '' }

}, { timestamps: true });

const Settings = mongoose.model('Settings', settingsSchema);

module.exports = Settings;
