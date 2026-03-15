require('dotenv').config()
const mongoose = require('mongoose')
const logger = require('pino')()
const { smsSchema } = require('../../models/sms_model')
const { clientFinder, createNewClient } = require('../clientFinder')
const { sendToQueue } = require('../rabbitmq')
const {
	isGatewayEnabled,
	sendRepeatSmsNotification,
} = require('../gatewayFlow')
const { tryAutoClaimOpenLeadFromSms } = require('../autoClaim')
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
			const isRepeatSms = hasAnyOrder && !hasRecentOrder && smsType === 'incoming'

			logger.info(
				`🔍 Найдено заказов в таблице хендимен (orders): за 2 недели=${recentOrders.length}, всего=${allOrders.length}`
			)

				if (isRepeatSms) {
					logger.info(`⚠️ Повторный клиент ${clientId} (последний заказ старше 2 недель) — отправляем уведомление в Telegram`)
					isFirstMessage = false

				// Dedup: skip if we already sent repeat for this client recently
			const dedupKey = `sms_${clientNumericId}`
			const lastSent = recentRepeatClients.get(dedupKey)
			if (lastSent && Date.now() - lastSent < REPEAT_DEDUP_MS) {
				logger.info(`⏭️ Дедупликация: repeat_sms_in для клиента ${clientNumericId} уже отправлен ${Math.round((Date.now() - lastSent) / 1000)}с назад, пропускаем`)
			} else {
				recentRepeatClients.set(dedupKey, Date.now())

				// Find manager for SMS (recipient phone number)
				const managerPhone = smsData.to_members?.[0]?.phone_number || null
				let managerInfo = null
				if (managerPhone) {
					const normalizedManagerPhone = managerPhone.replace(/\D/g, '').slice(-10)
					managerInfo = await UsersModel.findOne({
						'phone_numbers.number': {
							$regex: normalizedManagerPhone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
						},
					})
				}

					const repeatSmsData = {
						client_id: clientId,
						client_numeric_id: clientNumericId,
						customer_number: phoneNumber,
						orders: allOrders,
						message: message,
						smsType: smsType,
						date_time: dateTime,
						team: managerInfo?.team || null,
						manager_at: managerInfo?.at || null,
						zoomData: data
				}

						if (isGatewayEnabled()) {
							try {
								await sendRepeatSmsNotification(repeatSmsData)
								logger.info(
									`✅ repeat_sms_in отправлен через Telegram Gateway (client=${clientNumericId})`
								)
							} catch (gatewayError) {
								logger.error(
									`❌ Ошибка Telegram Gateway для repeat_sms_in: ${gatewayError.message}`
								)
								await sendToQueue('repeat_sms_in', repeatSmsData)
								logger.info(
									`↩️ Fallback: repeat_sms_in отправлен в RabbitMQ очередь`
								)
							}
						} else {
							await sendToQueue('repeat_sms_in', repeatSmsData)
						}
					}

				} else {
					// SMS по активному заказу (<= 2 недель) не считаем repeat
					if (hasRecentOrder && smsType === 'incoming') {
						isFirstMessage = false
						logger.info(
							`📨 SMS по активному заказу клиента ${clientNumericId} (<= 2 недель), repeat уведомление пропущено`
						)
					} else {
						isFirstMessage = true
					}
					logger.info(
						`⏭️ REPEAT_ONLY: non-repeat sms пропущен (smsType=${smsType}, hasAnyOrder=${hasAnyOrder}, hasRecentOrder=${hasRecentOrder})`
					)
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

		// Check if this is a new inbound SMS with extension info
		// For inbound SMS: sender = client, to_members[0] = manager
		if (smsType === 'incoming' && !hasRecentOrder) {
			// Get manager's phone number from to_members
			const managerPhone = smsData.to_members?.[0]?.phone_number || null
			
			// Try to find the manager by phone number (like button_bot.py does)
			let manager = null
			if (managerPhone) {
				const normalizedManagerPhone = managerPhone.replace(/\D/g, '').slice(-10)
				manager = await UsersModel.findOne({
					'phone_numbers.number': {
						$regex: normalizedManagerPhone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
					},
				})
			}

			// If found, send to new_inbound_lead queue
			if (manager && manager.at) {
				const inboundLeadData = {
					client_id: clientId,
					client_numeric_id: clientNumericId,
					customer_number: phoneNumber,
					message: message,
					lead_type: 'inbound_sms',
					ext: manager.extension_number || null,
					manager_at: manager.at,
					manager_id: manager.manager_id,
					team: manager.team,
				}

				try {
					const dedupKey = `new_inbound_lead_${clientNumericId}`
					const lastSent = recentRepeatClients.get(dedupKey)
					if (lastSent && Date.now() - lastSent < REPEAT_DEDUP_MS) {
						logger.info(
							`⏭️ Дедупликация: new_inbound_lead (SMS) для клиента ${clientNumericId} уже отправлен ${Math.round((Date.now() - lastSent) / 1000)}с назад, пропускаем`
						)
					} else {
						recentRepeatClients.set(dedupKey, Date.now())
						await sendToQueue('new_inbound_lead', inboundLeadData)
						logger.info(
							`✅ new_inbound_lead отправлен для SMS client=${clientNumericId}, manager=${manager.at}`
						)
					}
				} catch (queueError) {
					logger.error(
						`❌ Ошибка отправки в new_inbound_lead: ${queueError.message}`
					)
				}

			} else {
				logger.warn(
					`⚠️ SMS received but manager not found for phone=${managerPhone}, skipping new_inbound_lead`
				)
			}
		}

		try {
			await tryAutoClaimOpenLeadFromSms({
				clientId: clientNumericId,
				phone: phoneNumber,
				managerPhone,
				smsType,
				ownerId,
				messageId,
			})
		} catch (autoClaimError) {
			logger.warn(
				`⚠️ Auto-claim shadow skipped for sms client=${clientNumericId}: ${autoClaimError.message}`
			)
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
