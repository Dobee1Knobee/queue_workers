require('dotenv').config()
const mongoose = require('mongoose')
const logger = require('pino')()
const { smsSchema } = require('../../models/sms_model')
const { clientFinder, createNewClient } = require('../clientFinder')
const { sendToQueue } = require('../rabbitmq')
const {
	isGatewayEnabled,
	sendRepeatSmsNotification,
	sendDirectLeadNotificationToGateway,
} = require('../gatewayFlow')
const { tryAutoClaimOpenLeadFromSms } = require('../autoClaim')
const SHIFT_REPLACEMENTS = require('../../config/shiftReplacements')

let smsConnection = null
let SmsModel = null
let tvmountConnection = null

const REPEAT_CONTACT_WINDOW_DAYS = 14

const findClaimedManagerForClient = async (clientId, tvmountConn) => {
	if (!clientId) return null
	
	const cutoff = new Date(Date.now() - REPEAT_CONTACT_WINDOW_DAYS * 24 * 60 * 60 * 1000)
	const FilledFormsModel = tvmountConn.models.filled_forms || tvmountConn.model(
		'filled_forms',
		new mongoose.Schema({}, { strict: false }),
		'filled_forms'
	)
	
	const form = await FilledFormsModel.findOne({
		client_id: clientId,
		manager_at: { $exists: true, $nin: [null, ''] },
		date: { $gte: cutoff.toISOString() },
	}).sort({ date: -1 })
	
	if (!form) return null
	
	const managerAt = form.get('manager_at')
	if (!managerAt) return null
	
	const UsersModel = tvmountConn.models.users || tvmountConn.model(
		'users',
		new mongoose.Schema({}, { strict: false }),
		'users'
	)
	
	const managerDoc = await UsersModel.findOne({ at: managerAt })
	if (!managerDoc) return null
	
	// Check if manager is working
	if (managerDoc.working !== false) {
		return managerDoc
	}
	
	// Manager not working - check for replacement
	const replacementAt = SHIFT_REPLACEMENTS[managerAt]
	if (!replacementAt) {
		return managerDoc
	}
	
	const replacementDoc = await UsersModel.findOne({ at: replacementAt })
	if (!replacementDoc || replacementDoc.working === false) {
		return managerDoc
	}
	
	// Return replacement manager
	return {
		...replacementDoc.toObject(),
		delegated_from_at: managerAt,
		delegated_from_manager_id: managerDoc.manager_id,
	}
}

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

const getSmsType = event => {
	if (event === 'phone.sms_received') return 'incoming'
	if (event === 'phone.sms_sent') return 'outgoing'
	return 'unknown'
}

const pickFirstPhone = members => {
	if (!Array.isArray(members)) return null
	return members.map(member => member?.phone_number).find(Boolean) || null
}

const getClientPhoneFromSms = (event, smsData) => {
	if (event === 'phone.sms_received') {
		return (
			smsData.sender?.phone_number ||
			smsData.from?.phone_number ||
			smsData.from_member?.phone_number ||
			smsData.from_phone_number ||
			smsData.phone_number ||
			null
		)
	}

	if (event === 'phone.sms_sent') {
		return (
			pickFirstPhone(smsData.to_members) ||
			smsData.to?.phone_number ||
			smsData.to_member?.phone_number ||
			smsData.to_phone_number ||
			null
		)
	}

	return null
}

// Dedup: skip repeat notifications for the same client within 10 minutes
const recentRepeatClients = new Map()

// Memory leak protection: periodically clear old entries
setInterval(() => {
	const now = Date.now()
	for (const [clientId, timestamp] of recentRepeatClients.entries()) {
		if (now - timestamp > 10 * 60 * 1000) { // Keep for 10 minutes max
			recentRepeatClients.delete(clientId)
		}
	}
}, 5 * 60 * 1000) // Run every 5 minutes
const REPEAT_DEDUP_MS = 3 * 60 * 1000

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
		const eventType = data.body.event
		const phoneNumber = getClientPhoneFromSms(eventType, smsData)
		const smsType = getSmsType(eventType)

		// Проверка: если номер слишком короткий - это может быть ошибка
		const phoneDigits = (phoneNumber || '').replace(/\D/g, '')
		if (phoneDigits.length > 0 && phoneDigits.length <= 6) {
			logger.info(`⚠️ Пропускаем SMS: номер ${phoneNumber} похож на экстеншен (${phoneDigits.length} цифр)`)
			return { success: false, message: 'Likely extension, not a client number' }
		}

		// Ищем клиента по номеру телефона
		let client = await clientFinder(phoneNumber)
		let clientId = null
		let clientNumericId = null

		if (client) {
			// Клиент найден, используем его id
			clientId = client.id
			clientNumericId = client.toObject().id // числовой id для кнопки Claim
		} else {
			// Клиент не найден, создаем нового
			const newClient = await createNewClient(phoneNumber)
			clientId = newClient.id
			clientNumericId = newClient.toObject().id
			logger.info(
				`✅ Создан новый клиент с id: ${clientId}, numericId: ${clientNumericId} для номера: ${phoneNumber}`
			)
		}
		const message = smsData.message || ''
		const messageId = smsData.message_id || null
		const sessionId = smsData.session_id || null
		const ownerId = smsData.owner?.id || null
		const managerPhone = smsData.owner?.phone_number || null
		const dateTime = smsData.date_time
			? new Date(smsData.date_time)
			: new Date()
		let isFirstMessage = true
		if (!phoneNumber || !message) {
			throw new Error(
				`Отсутствуют обязательные поля: phone_number или message (event: ${eventType})`
			)
		}

		// Получаем подключение и модель
		const { connection, model } = await getSmsConnection()

		// Ищем заказы в коллекции orders в базе tvmount за последние 2 недели
		const tvmountConn = await getTvmountConnection()
		const OrdersModel = tvmountConn.models.orders || tvmountConn.model(
			'orders',
			new mongoose.Schema({}, { strict: false }),
			'orders'
		)
		const UsersModel = tvmountConn.models.users || tvmountConn.model(
			'users',
			new mongoose.Schema({}, { strict: false }),
			'users'
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
			}).sort({ _id: -1 }).limit(10);

			const hasAnyOrder = allOrders.length > 0
			const hasRecentOrder = recentOrders.length > 0

			logger.info(
				`🔍 SMS: smsType=${smsType}, orders (2 недели)=${recentOrders.length}, всего=${allOrders.length}`
			)

		// Find manager by phone (for incoming SMS, check to_members; for outgoing, check owner)
		let responsibleManager = null
		if (smsType === 'incoming') {
			const recipientPhone = smsData.to_members?.[0]?.phone_number || null
			if (recipientPhone) {
				const normalizedPhone = recipientPhone.replace(/\D/g, '').slice(-10)
				responsibleManager = await UsersModel.findOne({
					'phone_numbers.number': {
						$regex: normalizedPhone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
					},
				})
			}
		}

		// Создаём новую запись SMS
		const newSms = new model({
			smsType: smsType,
			isFirstMessage: smsType === 'incoming',
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
			`✅ SMS сохранено: ${phoneNumber} - ${message.substring(0, 50)}...`
		)

		// ============================================================
		// INCOMING SMS LOGIC
		// ============================================================
		if (smsType === 'incoming') {
			// First check: does client have a claimed manager (< 2 weeks)?
			const claimedManager = await findClaimedManagerForClient(clientNumericId, tvmountConn)
			
			// Has claimed manager (< 2 weeks) → DM
			if (claimedManager && claimedManager.at) {
				logger.info(
					`📱 Incoming SMS - client has claimed manager @${claimedManager.at}`
				)

				const inboundLeadData = {
					client_id: clientId,
					client_numeric_id: clientNumericId,
					customer_number: phoneNumber,
					message: message,
					lead_type: 'inbound_sms',
					ext: claimedManager.extension_number || null,
					manager_at: claimedManager.at,
					manager_id: claimedManager.manager_id,
					team: claimedManager.team,
					has_any_order: hasAnyOrder,
					has_recent_order: hasRecentOrder,
					manager_resolution_method: claimedManager.delegated_from_at ? 'delegated' : 'direct',
					delegated_from_at: claimedManager.delegated_from_at || null,
					delegated_from_manager_id: claimedManager.delegated_from_manager_id || null,
				}

				const dedupKey = `new_inbound_lead_${clientNumericId}`
				const lastSent = recentRepeatClients.get(dedupKey)
				if (lastSent && Date.now() - lastSent < REPEAT_DEDUP_MS) {
					logger.info(`⏭️ Дедупликация: уже отправлен`)
				} else {
					recentRepeatClients.set(dedupKey, Date.now())
					
					if (isGatewayEnabled()) {
						await sendDirectLeadNotificationToGateway(inboundLeadData)
					} else {
						await sendToQueue('new_inbound_lead', inboundLeadData)
					}
					
					logger.info(
						`✅ SMS DM отправлен @${claimedManager.at} (client=${clientNumericId})`
					)
				}
			}
			// Has recent order (< 2 weeks) → DM
			else if (hasRecentOrder && responsibleManager && responsibleManager.at) {
				logger.info(
					`📱 Incoming SMS - active client, sending DM to @${responsibleManager.at}`
				)

				const inboundLeadData = {
					client_id: clientId,
					client_numeric_id: clientNumericId,
					customer_number: phoneNumber,
					message: message,
					lead_type: 'inbound_sms',
					ext: responsibleManager.extension_number || null,
					manager_at: responsibleManager.at,
					manager_id: responsibleManager.manager_id,
					team: responsibleManager.team,
					has_any_order: hasAnyOrder,
					has_recent_order: hasRecentOrder,
					manager_resolution_method: 'direct',
				}

				const dedupKey = `new_inbound_lead_${clientNumericId}`
				const lastSent = recentRepeatClients.get(dedupKey)
				if (lastSent && Date.now() - lastSent < REPEAT_DEDUP_MS) {
					logger.info(`⏭️ Дедупликация: уже отправлен`)
				} else {
					recentRepeatClients.set(dedupKey, Date.now())

					if (isGatewayEnabled()) {
						await sendDirectLeadNotificationToGateway(inboundLeadData)
					} else {
						await sendToQueue('new_inbound_lead', inboundLeadData)
					}

					logger.info(
						`✅ SMS DM отправлен @${responsibleManager.at} (client=${clientNumericId})`
					)
				}
			}
			// New client OR repeat client (> 2 weeks) → group + claim button
			else {
				logger.info(
					`📱 Incoming SMS - new/repeat client, sending to group`
				)

				const dedupKey = `sms_${clientNumericId}`
				const lastSent = recentRepeatClients.get(dedupKey)
				if (lastSent && Date.now() - lastSent < REPEAT_DEDUP_MS) {
					logger.info(`⏭️ Дедупликация: SMS lead уже отправлен`)
				} else {
					recentRepeatClients.set(dedupKey, Date.now())

					const smsLeadData = {
						client_id: clientId,
						client_numeric_id: clientNumericId,
						customer_number: phoneNumber,
						orders: allOrders,
						message: message,
						smsType: smsType,
						date_time: dateTime,
						team: null,
						manager_at: null,
						zoomData: data
					}

					if (isGatewayEnabled()) {
						await sendRepeatSmsNotification(smsLeadData)
					} else {
						await sendToQueue('repeat_sms_in', smsLeadData)
					}
				}
			}
		}

		// ============================================================
		// OUTGOING SMS LOGIC - auto-claim open leads
		// ============================================================
		if (smsType === 'outgoing') {
			try {
				await tryAutoClaimOpenLeadFromSms({
					clientId: clientNumericId,
					phone: phoneNumber,
					managerPhone: smsData.owner?.phone_number || null,
					smsType,
					ownerId,
					messageId,
				})
			} catch (autoClaimError) {
				logger.warn(
					`⚠️ Auto-claim skipped for SMS client=${clientNumericId}: ${autoClaimError.message}`
				)
			}
		}

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
