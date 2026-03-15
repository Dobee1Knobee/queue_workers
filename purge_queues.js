require('dotenv').config()
const amqp = require('amqplib')

const queuesToPurge = [
	'call_in_test',
	'sms_in_test',
	'repeat_call_in',
	'repeat_sms_in',
	'new_inbound_lead',
	'auto_claim_in',
]

async function purgeQueues() {
	const url = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASS}@${process.env.NGROK_TCP_HOST}:${process.env.NGROK_TCP_PORT}`
	console.log(`Connecting to RabbitMQ: ${url}`)

	try {
		const connection = await amqp.connect(url)
		const channel = await connection.createChannel()

		for (const queue of queuesToPurge) {
			try {
				const info = await channel.checkQueue(queue)
				if (info) {
					console.log(`Purging queue: ${queue} (${info.messageCount} messages)`)
					await channel.purgeQueue(queue)
					console.log(`✅ Queue ${queue} purged.`)
				}
			} catch (error) {
				if (error.message.includes('404')) {
					console.log(`ℹ️ Queue ${queue} does not exist, skipping.`)
				} else {
					console.error(`❌ Error purging ${queue}:`, error.message)
				}
				// Re-create channel if it was closed due to 404
				if (error.message.includes('404')) {
					// Connection might be fine, but channel is closed on 404
				}
			}
		}

		await channel.close()
		await connection.close()
		console.log('\nAll done!')
	} catch (error) {
		console.error('Fatal error:', error.message)
	}
}

purgeQueues()
