export const callSchema = new mongoose.Schema({
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
})
const CallModel = mongoose.model('Call', callSchema, 'call')
