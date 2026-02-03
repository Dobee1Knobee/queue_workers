const mongoose = require('mongoose')

const callSchema = new mongoose.Schema({
	direction: {
		type: String,
		required: true,
	},
	duration: {
		type: Number,
		required: true,
	},
	result: {
		type: String,
		required: true,
	},
	call_end_time: {
		type: Date,
		required: true,
	},
	customer_number: {
		type: String,
		required: true,
	},
	ext: {
		type: String,
		required: true,
	},
	client_id: {
		type: Number,
		required: true,
	},
})
// Явно указываем имя коллекции, чтобы избежать проблем с namespace
const CallModel = mongoose.model('Call', callSchema, 'call')

module.exports = { CallModel, callSchema }
