const mongoose = require('mongoose')

const smsSchema = new mongoose.Schema({
	smsType: {
		type: String,
		required: true,
	},
	phone: {
		type: String,
		required: true,
	},
	clientId: {
		type: Number,
		required: true,
	},
	isFirstMessage: {
		type: Boolean,
		required: true,
	},
	message: {
		type: String,
		required: true,
	},
	messageId: {
		type: String,
		unique: true,
	},
	sessionId: String,
	ownerId: String,
	dateTime: Date,
	createdAt: {
		type: Date,
		default: Date.now,
	},
})

// Явно указываем имя коллекции, чтобы избежать проблем с namespace
const SmsModel = mongoose.model('Sms', smsSchema, 'sms')

module.exports = { SmsModel, smsSchema }
