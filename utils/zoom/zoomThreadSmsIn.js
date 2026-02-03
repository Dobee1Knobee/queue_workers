require('dotenv').config()
const mongoose = require('mongoose')
const logger = require('pino')()
const { smsSchema } = require('../../models/sms_model')
const { clientFinder, createNewClient } = require('../clientFinder')
const { getCallConnection } = require('./zoomThreadCallIn')
const axios = require('axios')
// Создаем отдельное подключение для SMS базы данных
// чтобы избежать конфликтов с другими подключениями
let smsConnection = null
let SmsModel = null

// Подключение к базе данных tvmount для работы с fastQuiz
let tvmountConnection = null

const getTvmountConnection = async () => {
	// Используем TVMOUNT_DB_URL если задан, иначе CLIENT_DB_URL, иначе формируем из SMS_DB_URL
	let dbUrl = process.env.TVMOUNT_DB_URL || process.env.CLIENTS_DB_URL
	
	if (!dbUrl && process.env.SMS_DB_URL) {
		// Заменяем имя базы данных в строке подключения на tvmount
		dbUrl = process.env.SMS_DB_URL.replace(/\/[^\/\?]+(\?|$)/, '/tvmount$1')
	}
	
	if (!dbUrl) {
		throw new Error('Переменная TVMOUNT_DB_URL, CLIENT_DB_URL или SMS_DB_URL не определена в .env файле')
	}

	// Если подключение уже существует и активно, возвращаем его
	if (tvmountConnection && tvmountConnection.readyState === 1) {
		return tvmountConnection
	}

	// Создаем новое подключение
	tvmountConnection = mongoose.createConnection(dbUrl, {
		bufferCommands: false,
		maxPoolSize: 10,
	})

	// Ждем, пока подключение установится
	await new Promise((resolve, reject) => {
		if (tvmountConnection.readyState === 1) {
			logger.info('✅ Connected to tvmount database')
			logger.info(`Database name: ${tvmountConnection.name}`)
			resolve()
		} else {
			tvmountConnection.once('connected', () => {
				logger.info('✅ Connected to tvmount database')
				logger.info(`Database name: ${tvmountConnection.name}`)
				resolve()
			})
			tvmountConnection.once('error', err => {
				logger.error('❌ Error connecting to tvmount database:', err.message)
				reject(err)
			})
		}
	})

	return tvmountConnection
}

const getSmsConnection = async () => {
	if (!process.env.SMS_DB_URL) {
		throw new Error('Переменная SMS_DB_URL не определена в .env файле')
	}

	// Если подключение уже существует и активно, возвращаем его
	if (smsConnection && smsConnection.readyState === 1 && SmsModel) {
		return { connection: smsConnection, model: SmsModel }
	}

	// Создаем новое подключение
	smsConnection = mongoose.createConnection(process.env.SMS_DB_URL, {
		bufferCommands: false,
		maxPoolSize: 10,
	})

	// Ждем, пока подключение установится
	await new Promise((resolve, reject) => {
		if (smsConnection.readyState === 1) {
			// Уже подключено (маловероятно, но на всякий случай)
			logger.info('✅ Connected to SMS database')
			logger.info(`Database name: ${smsConnection.name}`)
			resolve()
		} else {
			smsConnection.once('connected', () => {
				logger.info('✅ Connected to SMS database')
				logger.info(`Database name: ${smsConnection.name}`)
				resolve()
			})
			smsConnection.once('error', err => {
				logger.error('❌ Error connecting to SMS database:', err.message)
				reject(err)
			})
		}
	})

	// Создаем модель на этом подключении
	SmsModel = smsConnection.model('Sms', smsSchema, 'sms')

	return { connection: smsConnection, model: SmsModel }
}

const zoomThreadSmsIn = async data => {
	logger.info('📱 Обработка SMS сообщения')

	try {
		// Проверяем структуру данных
		if (!data.body || !data.body.payload || !data.body.payload.object) {
			throw new Error(
				'Неверная структура данных: отсутствует body.payload.object'
			)
		}

		const smsData = data.body.payload.object

		// Извлекаем данные из структуры Zoom
		const phoneNumber = smsData.sender?.phone_number || null
		const smsType =
			data.body.event === 'phone.sms_received' ? 'incoming' : 'outgoing'

		// Ищем клиента по номеру телефона
		let client = await clientFinder(phoneNumber)
		let clientId = null

		if (client) {
			// Клиент найден, используем его id
			clientId = client.id
		} else {
			// Клиент не найден, создаем нового
			const newClient = await createNewClient(phoneNumber)
			clientId = newClient.id
			logger.info(
				`✅ Создан новый клиент с id: ${clientId} для номера: ${phoneNumber}`
			)
		}
		const message = smsData.message || ''
		const messageId = smsData.message_id || null
		const sessionId = smsData.session_id || null
		const ownerId = smsData.owner?.id || null
		const dateTime = smsData.date_time
			? new Date(smsData.date_time)
			: new Date()
		let isFirstMessage = true
		if (!phoneNumber || !message) {
			throw new Error('Отсутствуют обязательные поля: phone_number или message')
		}

		// Получаем подключение и модель
		const { connection, model } = await getSmsConnection()
		const { callConection, callModel } = await getCallConnection()
		// Проверяем, не существует ли уже сообщение с таким messageId
		let existingSms = null
		if (messageId) {
			existingSms = await model.findOne({clientId: clientId })
			if(!existingSms){
				existingCall = await callModel.findOne({clientId: clientId })
			}
		}

		if (existingSms || existingCall) {
			logger.info(`⚠️ SMS или Call с клиентом ${clientId} уже существует, пропускаем`)
			return { success: true, skipped: true, message: 'SMS or Call already exists' }
		}

		// Ищем заказы в коллекции fastQuiz в базе tvmount
		const tvmountConn = await getTvmountConnection()
		const FastQuizModel = tvmountConn.model(
			'fastQuiz',
			new mongoose.Schema({}, { strict: false }),
			'fastQuiz'
		)
		const previewsOrder = await FastQuizModel.find({
			client_id: clientId,
		})
		if (previewsOrder.length > 0) {
			logger.info(`⚠️ Заказ уже существует`)
			isFirstMessage = false
		} else {
			// quiz_submission также из базы tvmount
			const quizSubmissionModel = tvmountConn.model(
				'quiz_submission',
				new mongoose.Schema({}, { strict: false }),
				'quiz_submission'
			)
			const quizSubmission = await quizSubmissionModel.find({
				client_id: clientId,
			})
			if (quizSubmission.length > 0) {
				logger.info(`⚠️ Заказ уже существует`)
				isFirstMessage = false
			} else {
				isFirstMessage = true
				// URL webhook из переменной окружения или по умолчанию localhost:3000
				const webhookUrl = process.env.WEBHOOK_SMS_URL || 'http://localhost:3000/webhook/sms'
				logger.info(`ЗАЯВКА ПО ПЕРВОМУ СООБЩЕНИЮ`)
				axios
					.post(
						webhookUrl,
						{
							smsType: smsType,
							isFirstMessage: isFirstMessage,
							phone: phoneNumber,
							clientId: clientId,
							message: message,
							messageId: messageId,
							sessionId: sessionId,
							ownerId: ownerId,
							dateTime: dateTime,
						},
						{
							headers: {
								'Content-Type': 'application/json',
							},
						}
					)
					.then(response => {
						logger.info(
							`✅ SMS сохранено в базу данных: ${phoneNumber} - ${message.substring(
								0,
								50
							)}...`
						)
					})
					.catch(error => {
						// Если сервер недоступен (ECONNREFUSED), это не критично - логируем как предупреждение
						if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
							logger.warn(
								`⚠️ Webhook сервер недоступен (${error.config?.url}): ${error.message}. SMS сохранено в БД.`
							)
						} else {
							// Другие ошибки логируем как ошибки
							logger.error(
								{
									err: error,
									message: error.message,
									code: error.code,
									url: error.config?.url,
								},
								'❌ Ошибка отправки webhook'
							)
						}
					})
			}
		}

		// Создаём новую запись SMS
		const newSms = new model({
			smsType: smsType,
			isFirstMessage: isFirstMessage,
			phone: phoneNumber,
			clientId: clientId,
			message: message,
			messageId: messageId,
			sessionId: sessionId,
			ownerId: ownerId,
			dateTime: dateTime,
		})

		await newSms.save()
		logger.info(
			`✅ SMS сохранено в базу данных: ${phoneNumber} - ${message.substring(
				0,
				50
			)}...`
		)

		return {
			success: true,
			smsId: newSms._id,
			phone: phoneNumber,
			messageId: messageId,
		}
	} catch (error) {
		logger.error(
			{
				err: error,
				message: error.message,
				stack: error.stack,
			},
			'❌ Ошибка в zoomThreadSmsIn'
		)
		throw error
	}
}

module.exports = { zoomThreadSmsIn, getSmsConnection }
