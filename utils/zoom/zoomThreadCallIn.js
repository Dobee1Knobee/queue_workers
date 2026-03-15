require('dotenv').config()
const mongoose = require('mongoose')
const logger = require('pino')()
const { callSchema } = require('../../models/call_model')
const { clientFinder, createNewClient } = require('../clientFinder')
const { sendToQueue } = require('../rabbitmq')
const {
	isGatewayEnabled,
	sendRepeatCallNotification,
	sendMissedCallNotification,
} = require('../gatewayFlow')
const { tryAutoClaimOpenLeadFromCall } = require('../autoClaim')

let callConnection = null
let CallModel = null

// Подключение к базе данных tvmount для работы с fastQuiz
let tvmountConnection = null

const normalizeDigits = value => {
	if (value === null || value === undefined) return ''
	return String(value).replace(/\D/g, '')
}

const isLikelyExtension = digits => digits.length > 0 && digits.length <= 6

const getInternalPartyId = (direction, log) => {
	if (!direction) return null
	if (direction === 'inbound') {
		return log?.callee_id || null
	}
	if (direction === 'outbound') {
		return log?.caller_id || null
	}
	return null
}

const getInternalExtension = (direction, log) => {
	if (!direction) return null
	const extFromField =
		direction === 'inbound'
			? log?.callee_extension_number
			: direction === 'outbound'
			? log?.caller_extension_number
			: null
	if (extFromField) return extFromField

	if (log?.caller_number_source === 'extension') {
		return log?.caller_number
	}
	if (log?.callee_number_source === 'extension') {
		return log?.callee_number
	}

	return direction === 'inbound' ? log?.callee_number : log?.caller_number
}

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
const MISSED_CALL_RESULTS = new Set([
	'no answer',
	'busy',
	'failed',
	'declined',
	'missed',
	'voicemail',
])

const normalizeCallResult = result => String(result || '').trim().toLowerCase()

// Dedup: skip duplicate lead notifications for the same client in a short window
const recentRepeatClients = new Map()
const REPEAT_DEDUP_MS = 3 * 60 * 1000

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
		caller_extension_number,
		callee_extension_number,
		caller_id,
		callee_id,
	} = log

	// 1) Номер клиента (внешний номер)
	// Сначала по direction, потом — страховка через *_source === 'external'
	let customerNumber =
		direction === 'inbound'
			? caller_number
			: direction === 'outbound'
			? callee_number
			: null

	// Внутренний номер (ext) - стараемся получить именно extension
	let ext = getInternalExtension(direction, {
		caller_number,
		callee_number,
		caller_number_source,
		callee_number_source,
		caller_extension_number,
		callee_extension_number,
	})
	
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
		if (!ext) {
			ext = external === caller_number ? callee_number : caller_number
		}
	}

	// Проверка: если номер слишком короткий - это экстеншен, а не клиент
	const customerDigits = normalizeDigits(customerNumber)
	if (customerDigits.length > 0 && customerDigits.length <= 6) {
		logger.info(`⚠️ Пропускаем звонок: номер ${customerNumber} похож на экстеншен (${customerDigits.length} цифр)`)
		return { success: false, message: 'Likely extension, not a client number' }
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
	let clientNumericId = null
	if (client) {
		clientId = client.id
		clientNumericId = Number(client.toObject().id) || client.toObject().id // числовой id для кнопки Claim
		logger.info(`✅ Клиент найден: id=${clientId}, numericId=${clientNumericId}`)
	} else {
		const newClient = await createNewClient(customerNumber)
		clientId = newClient.id
		clientNumericId = Number(newClient.toObject().id) || newClient.toObject().id
		logger.info(`✅ Создан новый клиент: id=${clientId}, numericId=${clientNumericId}`)
	}
	
	try {
		// Ищем заказы в коллекции fastQuiz в базе tvmount
		const tvmountConn = await getTvmountConnection()
		const UsersModel = tvmountConn.models.users || tvmountConn.model(
			'users',
			new mongoose.Schema({}, { strict: false }),
			'users'
		)

		const extDigits = normalizeDigits(ext)
		const extForLookup = isLikelyExtension(extDigits) ? Number(extDigits) : null
		const internalPartyId = getInternalPartyId(direction, {
			caller_id,
			callee_id,
		})

		let responsibleManager = null
		if (extForLookup !== null) {
			responsibleManager = await UsersModel.findOne({
				extension_number: extForLookup,
			})
		}

		if (!responsibleManager && internalPartyId) {
			responsibleManager = await UsersModel.findOne({
				id: internalPartyId,
			})
		}

		if (!responsibleManager && extDigits && !isLikelyExtension(extDigits)) {
			logger.warn(
				`⚠️ ext "${ext}" не похож на extension, пропускаем поиск по extension_number`
			)
		}
		// Ищем заказы в коллекции orders в базе tvmount за последние 2 недели
		const OrdersModel = tvmountConn.models.orders || tvmountConn.model(
			'orders',
			new mongoose.Schema({}, { strict: false }),
			'orders'
		)

		const twoWeeksAgo = new Date();
		twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
		const twoWeeksAgoId = new mongoose.Types.ObjectId(
			Math.floor(twoWeeksAgo.getTime() / 1000).toString(16) + '0000000000000000'
		);

			// Запрашиваем из базы заказы за последние 2 недели
			const recentOrders = await OrdersModel.find({
				client_id: clientNumericId,
				_id: { $gte: twoWeeksAgoId }
			}).sort({ _id: -1 }).limit(10);

			// И любые заказы клиента (для определения "старше 2 недель")
			const allOrders = await OrdersModel.find({
				client_id: clientNumericId,
			}).sort({ _id: -1 }).limit(10)

				const hasAnyOrder = allOrders.length > 0
				const hasRecentOrder = recentOrders.length > 0
				const isRepeatCall = hasAnyOrder && !hasRecentOrder && direction === 'inbound'
				const isMissedInboundCall =
					direction === 'inbound' && MISSED_CALL_RESULTS.has(normalizeCallResult(result))

			logger.info(
				`🔍 Найдено заказов в таблице хендимен (orders): за 2 недели=${recentOrders.length}, всего=${allOrders.length}`
			)

		// Сохраняем звонок в базу данных
		const callDataToSave = {
			client_id: clientId,
			ext: String(ext),
			direction: direction,
			duration: duration,
			result: result,
			call_end_time: callEndDate,
			customer_number: customerNumber,
			responsible_manager_id: responsibleManager?.id,
		}

		logger.info('💾 Сохраняем звонок:', callDataToSave)

		const call = new model(callDataToSave)
		await call.save()

		logger.info(`✅ Call успешно сохранен в БД с _id: ${call._id}`)

					if (isMissedInboundCall) {
						logger.info(
							`☎️ Missed inbound call detected (result=${result || 'unknown'}) — отправляем claim lead`
						)

						const dedupKey = `missed_call_${clientNumericId}`
						const lastSent = recentRepeatClients.get(dedupKey)
						if (lastSent && Date.now() - lastSent < REPEAT_DEDUP_MS) {
							logger.info(
								`⏭️ Дедупликация: missed call lead для клиента ${clientNumericId} уже отправлен ${Math.round((Date.now() - lastSent) / 1000)}с назад, пропускаем`
							)
						} else {
							recentRepeatClients.set(dedupKey, Date.now())

							const missedCallData = {
								client_id: clientId,
								client_numeric_id: clientNumericId,
								customer_number: customerNumber,
								orders: allOrders,
								direction,
								ext,
								duration,
								result,
								date_time: callEndDate,
								lead_type: 'missed_call',
								team: responsibleManager?.team || null,
								manager_at: responsibleManager?.at || null,
								manager_id: responsibleManager?.manager_id || null,
								zoomData: data,
							}

							if (isGatewayEnabled()) {
								try {
									await sendMissedCallNotification(missedCallData)
									logger.info(
										`✅ missed_call lead отправлен через Telegram Gateway (client=${clientNumericId})`
									)
								} catch (gatewayError) {
									logger.error(
										`❌ Ошибка Telegram Gateway для missed_call lead: ${gatewayError.message}`
									)
									await sendToQueue('repeat_call_in', missedCallData)
									logger.info(
										'↩️ Fallback: missed_call lead отправлен в RabbitMQ очередь repeat_call_in'
									)
								}
							} else {
								await sendToQueue('repeat_call_in', missedCallData)
							}
						}
					} else if (isRepeatCall) {
						logger.info(`✅ Repeat call (последний заказ старше 2 недель), входящий: ${customerNumber}`)

				// Dedup: skip if we already sent repeat for this client recently
				const dedupKey = `repeat_call_${clientNumericId}`
				const lastSent = recentRepeatClients.get(dedupKey)
			if (lastSent && Date.now() - lastSent < REPEAT_DEDUP_MS) {
				logger.info(`⏭️ Дедупликация: repeat_call_in для клиента ${clientNumericId} уже отправлен ${Math.round((Date.now() - lastSent) / 1000)}с назад, пропускаем`)
			} else {
				recentRepeatClients.set(dedupKey, Date.now())

				// Отправляем сообщение в RabbitMQ о повторном звонке
					const repeatCallData = {
						client_id: clientId,
						client_numeric_id: clientNumericId,
						customer_number: customerNumber,
						orders: allOrders,
						direction: direction,
						ext: ext,
						duration: duration,
						result: result,
						date_time: callEndDate,
						team: responsibleManager?.team || null,
						manager_at: responsibleManager?.at || null,
						manager_id: responsibleManager?.manager_id || null,
						zoomData: data
					}

					if (isGatewayEnabled()) {
						try {
							await sendRepeatCallNotification(repeatCallData)
							logger.info(
								`✅ repeat_call_in отправлен через Telegram Gateway (client=${clientNumericId})`
							)
						} catch (gatewayError) {
							logger.error(
								`❌ Ошибка Telegram Gateway для repeat_call_in: ${gatewayError.message}`
							)
							await sendToQueue('repeat_call_in', repeatCallData)
							logger.info(
								`↩️ Fallback: repeat_call_in отправлен в RabbitMQ очередь`
							)
						}
					} else {
						await sendToQueue('repeat_call_in', repeatCallData)
					}
				}
				} else {
					logger.info(
						`⏭️ REPEAT_ONLY: non-repeat call пропущен (direction=${direction}, hasAnyOrder=${hasAnyOrder}, hasRecentOrder=${hasRecentOrder})`
					)
				}

				// Check if this is an answered inbound call (new lead)
				// Send to new_inbound_lead queue for direct-to-DM routing
				const normalizedCallResult = normalizeCallResult(result)
				const isAnsweredInbound = 
					direction === 'inbound' &&
					!MISSED_CALL_RESULTS.has(normalizedCallResult) &&
					responsibleManager &&
					responsibleManager.at &&
					!hasRecentOrder // Only for new clients, not repeats

				if (isAnsweredInbound) {
					const inboundLeadData = {
						client_id: clientId,
						client_numeric_id: clientNumericId,
						customer_number: customerNumber,
						lead_type: 'answered_call',
						result: result,
						ext: ext,
						manager_at: responsibleManager.at,
						manager_id: responsibleManager.manager_id,
						team: responsibleManager.team,
						duration: duration,
					}

					try {
						const dedupKey = `new_inbound_lead_${clientNumericId}`
						const lastSent = recentRepeatClients.get(dedupKey)
						if (lastSent && Date.now() - lastSent < REPEAT_DEDUP_MS) {
							logger.info(
								`⏭️ Дедупликация: new_inbound_lead для клиента ${clientNumericId} уже отправлен ${Math.round((Date.now() - lastSent) / 1000)}с назад, пропускаем`
							)
						} else {
							recentRepeatClients.set(dedupKey, Date.now())
							await sendToQueue('new_inbound_lead', inboundLeadData)
							logger.info(
								`✅ new_inbound_lead отправлен для answered call client=${clientNumericId}, manager=${responsibleManager.at}`
							)
						}
					} catch (queueError) {
						logger.error(
							`❌ Ошибка отправки в new_inbound_lead: ${queueError.message}`
						)
					}

				}

				try {
					await tryAutoClaimOpenLeadFromCall({
						clientId: clientNumericId,
						phone: customerNumber,
						managerPhone:
							direction === 'outbound' ? caller_number : callee_number,
						direction,
						duration,
						result,
						responsibleManager,
						callId: log?.id || log?.call_id || null,
					})
				} catch (autoClaimError) {
					logger.warn(
						`⚠️ Auto-claim shadow skipped for call client=${clientNumericId}: ${autoClaimError.message}`
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
