
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    googleId: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String }, // 🔥 New: Password field for email/password auth
    name: { type: String, required: true, unique: true }, 
    picture: { type: String }, 
    banner: { type: String, default: '' }, 
    bio: { type: String, default: '' }, 
    isHistoryPublic: { type: Boolean, default: true }, 
    isCommentBlocked: { type: Boolean, default: false }, // 🔥 New: Block from commenting only
    role: { type: String, default: 'user', enum: ['user', 'admin', 'contributor'] } 
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

module.exports = User;
