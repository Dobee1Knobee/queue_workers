require('dotenv').config()
const express = require('express')
const app = express()
const port = 3000
const { queueConsumer } = require('./utils/queueConsumer')
const { zoomThreadCallIn } = require('./utils/zoom/zoomThreadCallIn')
const { zoomThreadSmsIn } = require('./utils/zoom/zoomThreadSmsIn')

app.get('/', (req, res) => {
	res.send('Hello World')
})

// Запускаем consumer при старте приложения
app.listen(port, async () => {
	console.log(`Server is running on port ${port}`)

	// Запускаем consumer для очереди
	try {
		await queueConsumer('call_in_test')

		// Обработка SMS сообщений через отдельный consumer
		const amqp = require('amqplib')
		const url = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASS}@${process.env.NGROK_TCP_HOST}:${process.env.NGROK_TCP_PORT}`
		const connection = await amqp.connect(url)
		const channel = await connection.createChannel()
		const chanelSms = await connection.createChannel()
		await channelCall.assertQueue('call_in_test', { durable: true })
		await chanelSms.assertQueue('sms_in_test', { durable: true })

		// Устанавливаем prefetch для ограничения количества одновременно обрабатываемых сообщений
		// prefetch: 1 означает, что канал будет обрабатывать только одно сообщение за раз
		await chanelSms.prefetch(1)
		await channelCall.prefetch(1)
		console.log('✅ Call Consumer запущен и готов к работе')
		console.log('⏳ Ожидаем SMS сообщения из очереди "sms_in_test"...')
		channelCall.consume(
			'call_in_test',
			async message => {
				if (message === null) return
				try {
					const data = JSON.parse(message.content.toString())
					await zoomThreadCallIn(data)
					channelCall.ack(message)
					console.log('✅ Call сообщение обработано и подтверждено')
				} catch (error) {
					console.error('❌ Ошибка обработки Call:', error.message)
					channelCall.nack(message, false, false)
				}
			},
			{ noAck: false }
		)
		chanelSms.consume(
			'sms_in_test',
			async message => {
				if (message === null) return

				try {
					const data = JSON.parse(message.content.toString())
					await zoomThreadSmsIn(data)
					chanelSms.ack(message)
					console.log('✅ SMS сообщение обработано и подтверждено')
				} catch (error) {
					console.error('❌ Ошибка обработки SMS:', error.message)
					// Для ошибок валидации не возвращаем сообщение в очередь (requeue: false)
					// чтобы избежать бесконечного цикла
					chanelSms.nack(message, false, false)
				}
			},
			{ noAck: false }
		)

		console.log('✅ SMS Consumer запущен и готов к работе')
	} catch (error) {
		console.error('Ошибка запуска consumer:', error.message)
	}
	// await zoomThreadCallIn('call_in_test');
})
