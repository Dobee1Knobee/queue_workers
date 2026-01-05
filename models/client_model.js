const mongoose = require('mongoose')

const clientSchema = new mongoose.Schema({
	number: {
		type: [String],
		required: true,
	},
	id: {
		type: Number,
		required: true,
	},
	oldClientId: {
		type: Number,
		required: false,
	},
})

// Явно указываем имя коллекции, чтобы избежать проблем с namespace
const ClientModel = mongoose.model('clients', clientSchema)

module.exports = { ClientModel, clientSchema }
