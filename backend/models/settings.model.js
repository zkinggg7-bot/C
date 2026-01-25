
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
    fontSize: { type: Number, default: 18 },
    // 🔥 New field for storing globally banned words/phrases for cleanup
    globalBlocklist: [{ type: String }] 
}, { timestamps: true });

const Settings = mongoose.model('Settings', settingsSchema);

module.exports = Settings;
    