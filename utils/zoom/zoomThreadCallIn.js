require('dotenv').config()
const mongoose = require('mongoose')
const logger = require('pino')()
let callConnection = null
let CallModel = null
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

	const external =
		caller_number_source === 'external' && caller_number
			? caller_number
			: callee_number_source === 'external' && callee_number
			? callee_number
			: null

	if (external) customerNumber = external

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

	// дальше твоя логика
	if (direction === 'outbound') {
		// outbound обработка
	} else if (direction === 'inbound') {
		// inbound обработка
	}

	return { success: true, callData }
}

module.exports = { zoomThreadCallIn }
