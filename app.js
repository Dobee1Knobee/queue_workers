require('dotenv').config()
const express = require('express')
const app = express()
const port = 8000
const amqp = require('amqplib')
const isDev = process.env.NODE_ENV !== 'production'
const devProcessingDelayMs = Number(
	process.env.DEV_PROCESSING_DELAY_MS || 10000
)
const rabbitReconnectMs = Number(process.env.RABBIT_RECONNECT_MS || 5000)
const rabbitUrl = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASS}@${process.env.NGROK_TCP_HOST}:${process.env.NGROK_TCP_PORT}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const { zoomThreadCallIn } = require('./utils/zoom/zoomThreadCallIn')
const { zoomThreadSmsIn } = require('./utils/zoom/zoomThreadSmsIn')
const {
	handleGatewayTelegramEvent,
	verifyGatewayEventHeaders,
} = require('./utils/gatewayFlow')

// Middleware для парсинга JSON
app.use(express.json())

app.get('/', (req, res) => {
	res.send('Hello World')
})

// Endpoint для приема webhook SMS
app.post('/webhook/sms', (req, res) => {
	console.log('📨 Webhook SMS получен:', req.body)
	res.status(200).json({ success: true, message: 'Webhook received' })
})

// Endpoint для приема webhook Call
app.post('/webhook/call', (req, res) => {
	console.log('📞 Webhook Call получен:', req.body)
	res.status(200).json({ success: true, message: 'Webhook received' })
})

// Endpoint для входящих событий от Telegram Gateway
app.post('/internal/telegram/events', async (req, res) => {
	try {
		const headerCheck = verifyGatewayEventHeaders(req.headers || {})
		if (!headerCheck.valid) {
			return res.status(headerCheck.status).json({
				ok: false,
				error: headerCheck.message,
			})
		}

		const result = await handleGatewayTelegramEvent(req.body || {})
		return res.status(200).json({ ok: true, ...result })
	} catch (error) {
		console.error('❌ Ошибка обработки /internal/telegram/events:', error.message)
		return res.status(500).json({
			ok: false,
			error: error.message || 'internal error',
		})
	}
})

const rabbitState = {
	connecting: false,
	connection: null,
	callChannel: null,
	smsChannel: null,
	reconnectTimer: null,
	shuttingDown: false,
}

const clearRabbitState = () => {
	rabbitState.connection = null
	rabbitState.callChannel = null
	rabbitState.smsChannel = null
}

const safeAck = (channel, message, label) => {
	try {
		channel.ack(message)
	} catch (error) {
		console.error(`⚠️ Не удалось ack для ${label}:`, error.message)
	}
}

const safeNack = (channel, message, label) => {
	try {
		channel.nack(message, false, false)
	} catch (error) {
		console.error(`⚠️ Не удалось nack для ${label}:`, error.message)
	}
}

const scheduleRabbitReconnect = reason => {
	if (rabbitState.shuttingDown || rabbitState.reconnectTimer) return
	console.warn(`♻️ RabbitMQ reconnect через ${rabbitReconnectMs}ms (${reason})`)
	rabbitState.reconnectTimer = setTimeout(() => {
		rabbitState.reconnectTimer = null
		startRabbitConsumers().catch(error => {
			console.error('❌ Ошибка reconnect RabbitMQ:', error.message)
			scheduleRabbitReconnect('reconnect failed')
		})
	}, rabbitReconnectMs)
}

const startRabbitConsumers = async () => {
	if (rabbitState.connecting || rabbitState.connection || rabbitState.shuttingDown) return
	rabbitState.connecting = true

	try {
		const connection = await amqp.connect(rabbitUrl)
		rabbitState.connection = connection

		connection.on('error', error => {
			console.error('❌ RabbitMQ connection error:', error.message)
		})

		connection.on('close', () => {
			console.warn('⚠️ RabbitMQ connection closed unexpectedly')
			clearRabbitState()
			scheduleRabbitReconnect('connection closed')
		})

		const channelCall = await connection.createChannel()
		const channelSms = await connection.createChannel()
		rabbitState.callChannel = channelCall
		rabbitState.smsChannel = channelSms

		channelCall.on('error', error => {
			console.error('❌ RabbitMQ call channel error:', error.message)
		})
		channelSms.on('error', error => {
			console.error('❌ RabbitMQ sms channel error:', error.message)
		})

		await channelCall.assertQueue('call_in_test', { durable: true })
		await channelSms.assertQueue('sms_in_test', { durable: true })
		await channelSms.prefetch(1)
		await channelCall.prefetch(1)

		console.log('✅ Call Consumer запущен и готов к работе')
		console.log('⏳ Ожидаем SMS сообщения из очереди "sms_in_test"...')

		await channelCall.consume(
			'call_in_test',
			async message => {
				if (message === null) return
				try {
					if (isDev && devProcessingDelayMs > 0) {
						await sleep(devProcessingDelayMs)
					}
					const data = JSON.parse(message.content.toString())
					await zoomThreadCallIn(data)
					safeAck(channelCall, message, 'call_in_test')
					console.log('✅ Call сообщение обработано и подтверждено')
				} catch (error) {
					console.error('❌ Ошибка обработки Call:', error.message)
					safeNack(channelCall, message, 'call_in_test')
				}
			},
			{ noAck: false }
		)

		await channelSms.consume(
			'sms_in_test',
			async message => {
				if (message === null) return
				try {
					if (isDev && devProcessingDelayMs > 0) {
						await sleep(devProcessingDelayMs)
					}
					const data = JSON.parse(message.content.toString())
					await zoomThreadSmsIn(data)
					safeAck(channelSms, message, 'sms_in_test')
					console.log('✅ SMS сообщение обработано и подтверждено')
				} catch (error) {
					console.error('❌ Ошибка обработки SMS:', error.message)
					safeNack(channelSms, message, 'sms_in_test')
				}
			},
			{ noAck: false }
		)

		console.log('✅ SMS Consumer запущен и готов к работе')
	} catch (error) {
		console.error('❌ Ошибка запуска consumers:', error.message)
		clearRabbitState()
		scheduleRabbitReconnect('startup error')
	} finally {
		rabbitState.connecting = false
	}
}

const shutdownRabbit = async signal => {
	rabbitState.shuttingDown = true
	if (rabbitState.reconnectTimer) {
		clearTimeout(rabbitState.reconnectTimer)
		rabbitState.reconnectTimer = null
	}
	if (rabbitState.connection) {
		try {
			await rabbitState.connection.close()
		} catch (error) {
			console.error(`⚠️ Ошибка закрытия RabbitMQ connection on ${signal}:`, error.message)
		}
	}
	clearRabbitState()
}

process.on('SIGINT', async () => {
	await shutdownRabbit('SIGINT')
	process.exit(0)
})

process.on('SIGTERM', async () => {
	await shutdownRabbit('SIGTERM')
	process.exit(0)
})

app.listen(port, () => {
	console.log(`Server is running on port ${port}`)
	startRabbitConsumers().catch(error => {
		console.error('❌ Ошибка старта Rabbit consumers:', error.message)
		scheduleRabbitReconnect('initial start failed')
	})
})
