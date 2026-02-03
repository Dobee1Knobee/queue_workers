require('dotenv').config()
const mongoose = require('mongoose')
const logger = require('pino')()
const { callSchema } = require('../../models/call_model')
const { clientFinder, createNewClient } = require('../clientFinder')
const { getSmsConnection } = require('./zoomThreadSmsIn')

let callConnection = null
let CallModel = null

// Подключение к базе данных tvmount для работы с fastQuiz
let tvmountConnection = null

const getTvmountConnection = async () => {
	// Используем TVMOUNT_DB_URL если задан, иначе CLIENT_DB_URL, иначе формируем из CALL_DB_URL
	let dbUrl = process.env.TVMOUNT_DB_URL || process.env.CLIENTS_DB_URL
	
	if (!dbUrl && process.env.CALL_DB_URL) {
		// Заменяем имя базы данных в строке подключения на tvmount
		dbUrl = process.env.CALL_DB_URL.replace(/\/[^\/\?]+(\?|$)/, '/tvmount$1')
	}
	
	if (!dbUrl) {
		throw new Error('Переменная TVMOUNT_DB_URL, CLIENT_DB_URL или CALL_DB_URL не определена в .env файле')
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

const getCallConnection = async () => {
	if (!process.env.CALL_DB_URL) {
		throw new Error('Переменная CALL_DB_URL не определена в .env файле')
	}
	if (callConnection && callConnection.readyState === 1 && CallModel) {
		return { connection: callConnection, model: CallModel }
	}
	callConnection = mongoose.createConnection(process.env.CALL_DB_URL, {
		bufferCommands: false,
		maxPoolSize: 10,
	})
	await new Promise((resolve, reject) => {
		if (callConnection.readyState === 1) {
			logger.info('✅ Connected to call database')
			logger.info(`Database name: ${callConnection.name}`)
			resolve()
		} else {
			callConnection.once('connected', () => {
				logger.info('✅ Connected to call database')
				logger.info(`Database name: ${callConnection.name}`)
				resolve()
			})
			callConnection.once('error', err => {
				logger.error('❌ Error connecting to call database:', err.message)
				reject(err)
			})
		}
	})
	CallModel = callConnection.model('Call', callSchema, 'call')
	return { connection: callConnection, model: CallModel }
}
const zoomThreadCallIn = async data => {
	logger.info('📞 Обработка Call сообщения')

	const { connection, model } = await getCallConnection()

	const log = data?.body?.payload?.object?.call_logs?.[0]
	if (!log) {
		logger.info('❌ Нет call_logs[0]')
		return { success: false, message: 'No call log' }
	}

	const {
		direction = null,
		duration = null,
		result = null,
		call_end_time: callEnd = null,
		caller_number,
		callee_number,
		caller_number_source,
		callee_number_source,
	} = log

	// 1) Номер клиента (внешний номер)
	// Сначала по direction, потом — страховка через *_source === 'external'
	let customerNumber =
		direction === 'inbound'
			? caller_number
			: direction === 'outbound'
			? callee_number
			: null

	// Внутренний номер (ext) - противоположный внешнему
	let ext =
		direction === 'inbound'
			? callee_number
			: direction === 'outbound'
			? caller_number
			: null

	// Дополнительная проверка на внешний номер
	const external =
		caller_number_source === 'external' && caller_number
			? caller_number
			: callee_number_source === 'external' && callee_number
			? callee_number
			: null

	if (external) {
		customerNumber = external
		// Если external найден, ext - это противоположный номер
		ext = external === caller_number ? callee_number : caller_number
	}

	// callData можно хранить как угодно — просто пример
	const callData = { direction, duration, result, callEnd, customerNumber }

	// 2) Валидация (duration может быть 0 — это НЕ ошибка)
	if (!direction || result == null || !callEnd || !customerNumber) {
		logger.info('❌ Нет данных о Call', callData)
		return { success: false, message: 'No call data' }
	}

	// duration допускаем 0, но не null/undefined
	if (duration == null) {
		logger.info('❌ Нет duration', callData)
		return { success: false, message: 'No call duration' }
	}

	// Преобразуем callEnd в Date, если это строка
	const callEndDate = callEnd instanceof Date ? callEnd : new Date(callEnd)

	// Проверяем, что ext не null (он обязателен в модели)
	if (!ext) {
		logger.warn('⚠️ ext не определен, используем пустую строку')
		ext = ''
	}

	const client = await clientFinder(customerNumber)
	let clientId = null
	if (client) {
		clientId = client.id
		logger.info(`✅ Клиент найден: id=${clientId}`)
	} else {
		const newClient = await createNewClient(customerNumber)
		clientId = newClient.id
		logger.info(`✅ Создан новый клиент: id=${clientId}`)
	}
	
	// Проверяем, не существует ли уже SMS или звонок с таким clientId
	const { model: smsModel } = await getSmsConnection()
	const { model: callModel } = await getCallConnection()
	
	let existingSms = await smsModel.findOne({ clientId: clientId })
	let existingCall = await callModel.findOne({ client_id: clientId })
	
	if (existingSms || existingCall) {
		logger.info(`⚠️ SMS или Call с клиентом ${clientId} уже существует, пропускаем`)
		return { success: true, skipped: true, message: 'SMS or Call already exists' }
	}
	
	try {
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

		// Ищем заказы в коллекции quiz_submission в базе tvmount
		const quizSubmissionModel = tvmountConn.model(
			'quiz_submission',
			new mongoose.Schema({}, { strict: false }),
			'quiz_submission'
		)
		const quizSubmission = await quizSubmissionModel.find({
			client_id: clientId,
		})

		const hasExistingOrder =
			previewsOrder.length > 0 || quizSubmission.length > 0

		logger.info(
			`🔍 Найдено заказов: fastQuiz=${previewsOrder.length}, quiz_submission=${quizSubmission.length}`
		)

		// Сохраняем звонок в базу данных
		const callDataToSave = {
			client_id: clientId,
			ext: ext,
			direction: direction,
			duration: duration,
			result: result,
			call_end_time: callEndDate,
			customer_number: customerNumber,
		}

		logger.info('💾 Сохраняем звонок:', callDataToSave)

		const call = new model(callDataToSave)
		await call.save()

		logger.info(`✅ Call успешно сохранен в БД с _id: ${call._id}`)

		if (hasExistingOrder) {
			logger.info(`✅ Call сохранено (заказ уже существует): ${customerNumber}`)
		} else {
			logger.info(
				`✅ Первый заказ по ${direction} сохранен в базу данных: ${customerNumber}`
			)
		}
	} catch (error) {
		logger.error(
			{
				err: error,
				message: error.message,
				stack: error.stack,
			},
			'❌ Ошибка в zoomThreadCallIn'
		)
		return { success: false, message: 'Error processing call' }
	}

	if (direction === 'outbound') {
		// outbound обработка
	} else if (direction === 'inbound') {
		// inbound обработка
	}

	return { success: true, callData }
}

module.exports = { zoomThreadCallIn, getCallConnection }
