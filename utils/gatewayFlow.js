require('dotenv').config()
const axios = require('axios')
const crypto = require('node:crypto')
const mongoose = require('mongoose')
const logger = require('pino')()
const { sendToQueue } = require('./rabbitmq')

let tvmountConnection = null

const GATEWAY_ENABLED = String(
	process.env.TELEGRAM_GATEWAY_ENABLED || 'false'
).toLowerCase() === 'true'
const GATEWAY_URL = (
	process.env.TELEGRAM_GATEWAY_URL || 'https://telegram.it.tvmountmaster.com'
).replace(/\/+$/, '')
const LEGACY_CALLER_ID = process.env.TELEGRAM_GATEWAY_CALLER_ID || ''
const LEGACY_API_SECRET = process.env.TELEGRAM_GATEWAY_API_KEY || ''
const NEW_API_KEY = process.env.TELEGRAM_GATEWAY_API_KEY || process.env.TELEGRAM_GATEWAY_API_KEY_ID || ''
const NEW_API_SECRET = process.env.TELEGRAM_GATEWAY_API_SECRET || ''
const GATEWAY_API_KEY = LEGACY_CALLER_ID || NEW_API_KEY
const GATEWAY_API_SECRET = NEW_API_SECRET || (LEGACY_CALLER_ID ? LEGACY_API_SECRET : '')
const GATEWAY_CHAT_ID = process.env.TELEGRAM_GATEWAY_CHAT_ID || process.env.TELEGRAM_CHAT_ID || ''
const GATEWAY_CHAT_ALIAS = process.env.TELEGRAM_GATEWAY_CHAT_ALIAS || ''
const EXPECTED_APP_KEY = process.env.TELEGRAM_GATEWAY_EXPECTED_APP_KEY || ''
const EXPECTED_ROUTE_KEY = process.env.TELEGRAM_GATEWAY_EXPECTED_ROUTE_KEY || ''
const REDIRECT_DM_ENABLED = String(process.env.TELEGRAM_GATEWAY_REDIRECT_DM || 'false').toLowerCase() === 'true'

// Log gateway config on startup
logger.info('🔧 Gateway config:')
logger.info(`   GATEWAY_ENABLED: ${GATEWAY_ENABLED}`)
logger.info(`   GATEWAY_URL: ${GATEWAY_URL}`)
logger.info(`   GATEWAY_API_KEY: ${GATEWAY_API_KEY ? GATEWAY_API_KEY.substring(0, 10) + '...' : 'NOT SET'}`)
logger.info(`   GATEWAY_API_SECRET: ${GATEWAY_API_SECRET ? GATEWAY_API_SECRET.substring(0, 10) + '...' : 'NOT SET'}`)
logger.info(`   GATEWAY_CHAT_ID: ${GATEWAY_CHAT_ID}`)
logger.info(`   GATEWAY_CHAT_ALIAS: ${GATEWAY_CHAT_ALIAS}`)
logger.info(`   REDIRECT_DM_ENABLED: ${REDIRECT_DM_ENABLED}`)

const isGatewayEnabled = () => GATEWAY_ENABLED

const normalizeClientId = clientId => {
	if (clientId === null || clientId === undefined) return null
	if (typeof clientId === 'object' && clientId.$numberLong) {
		const parsed = Number(clientId.$numberLong)
		return Number.isFinite(parsed) ? parsed : null
	}
	const parsed = Number(clientId)
	return Number.isFinite(parsed) ? parsed : null
}

const getOrderId = order => {
	if (!order) return null
	if (typeof order.get === 'function') {
		return order.get('order_id')
	}
	return order.order_id || null
}

const formatUtcIso = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z')

const buildValueVariants = value => {
	if (value === null || value === undefined) return []
	const values = [value, String(value)]
	const numeric = Number(value)
	if (Number.isFinite(numeric)) values.push(numeric)
	return [...new Set(values)]
}

const parseClaimClientId = callbackData => {
	if (typeof callbackData !== 'string') return null
	if (callbackData.startsWith('claim:zoom:')) {
		const parts = callbackData.split(':')
		return parts[parts.length - 1] // The last part is the client ID
	}
	return null
}

const getGatewayChatTarget = () => {
	if (GATEWAY_CHAT_ALIAS) return { chatAlias: GATEWAY_CHAT_ALIAS }
	if (GATEWAY_CHAT_ID) return { chatId: String(GATEWAY_CHAT_ID) }
	throw new Error(
		'TELEGRAM_GATEWAY_CHAT_ID/TELEGRAM_CHAT_ID or TELEGRAM_GATEWAY_CHAT_ALIAS must be configured'
	)
}

const makeIdempotencyKey = prefix =>
	`${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`

const getTvmountConnection = async () => {
	if (tvmountConnection && tvmountConnection.readyState === 1) {
		return tvmountConnection
	}

	let dbUrl = process.env.TVMOUNT_DB_URL || process.env.CLIENTS_DB_URL
	if (!dbUrl && process.env.CALL_DB_URL) {
		dbUrl = process.env.CALL_DB_URL.replace(/\/[^\/\?]+(\?|$)/, '/tvmount$1')
	}
	if (!dbUrl && process.env.SMS_DB_URL) {
		dbUrl = process.env.SMS_DB_URL.replace(/\/[^\/\?]+(\?|$)/, '/tvmount$1')
	}
	if (!dbUrl) {
		throw new Error(
			'TVMOUNT_DB_URL/CLIENTS_DB_URL/CALL_DB_URL/SMS_DB_URL is not configured'
		)
	}

	tvmountConnection = mongoose.createConnection(dbUrl, {
		bufferCommands: false,
		maxPoolSize: 10,
	})

	await new Promise((resolve, reject) => {
		if (tvmountConnection.readyState === 1) {
			logger.info('✅ Connected to tvmount database (gateway flow)')
			resolve()
			return
		}
		tvmountConnection.once('connected', () => {
			logger.info('✅ Connected to tvmount database (gateway flow)')
			resolve()
		})
		tvmountConnection.once('error', err => reject(err))
	})

	return tvmountConnection
}

const getCollectionModel = async name => {
	const conn = await getTvmountConnection()
	return conn.models[name] || conn.model(name, new mongoose.Schema({}, { strict: false }), name)
}

const gatewayPostInternal = async ({ operationType, payload, idempotencyKey, correlationId }) => {
	if (!GATEWAY_API_KEY || !GATEWAY_API_SECRET) {
		throw new Error(
			'Gateway auth is not configured. Use either legacy TELEGRAM_GATEWAY_CALLER_ID+TELEGRAM_GATEWAY_API_KEY or new TELEGRAM_GATEWAY_API_KEY+TELEGRAM_GATEWAY_API_SECRET'
		)
	}

	const requestBody = {
		idempotencyKey: idempotencyKey || makeIdempotencyKey(operationType),
		operationType,
		payload,
	}
	logger.info(
		`➡️ [gateway] op=${operationType} idempotencyKey=${requestBody.idempotencyKey} payload=${JSON.stringify(payload)}`
	)

	const headers = {
		'x-api-key': GATEWAY_API_KEY,
		'x-api-secret': GATEWAY_API_SECRET,
		'x-correlation-id': correlationId || crypto.randomUUID(),
		'content-type': 'application/json',
	}

	try {
		const resp = await axios.post(
			`${GATEWAY_URL}/v1/internal/telegram-requests`,
			requestBody,
			{
				headers,
				timeout: 12000,
				validateStatus: () => true,
			}
		)
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(
				`Gateway internal request failed: ${resp.status} ${JSON.stringify(resp.data || {})}`
			)
		}
		logger.info(
			`⬅️ [gateway] op=${operationType} status=${resp.status} tx=${resp.data?.transactionId || 'n/a'}`
		)
		return resp.data
	} catch (error) {
		const details = error.response
			? `${error.response.status} ${JSON.stringify(error.response.data || {})}`
			: error.message
		throw new Error(`Gateway request error: ${details}`)
	}
}

const safeAnswerCallback = async (callbackQueryId, text, showAlert = false) => {
	if (!callbackQueryId) return
	try {
		await gatewayPostInternal({
			operationType: 'answer_callback_query',
			idempotencyKey: makeIdempotencyKey(`answer-callback-${callbackQueryId}`),
			payload: {
				callbackQueryId,
				...(text ? { text } : {}),
				...(showAlert ? { showAlert: true } : {}),
			},
		})
	} catch (error) {
		logger.warn(`⚠️ Failed to answer callback query ${callbackQueryId}: ${error.message}`)
	}
}

const getClientStatusLabel = ({ hasRecentOrder, hasAnyOrder }) => {
	if (hasRecentOrder) return '🟢 АКТИВНЫЙ КЛИЕНТ'
	if (hasAnyOrder) return '🟡 ПОВТОРНЫЙ КЛИЕНТ'
	return '🔵 НОВЫЙ КЛИЕНТ'
}

const buildLeadMessage = ({
	type,
	clientNumericId,
	customerNumber,
	recentOrders,
	callResult,
	hasRecentOrder,
	hasAnyOrder,
	message,
	delegatedFromAt,
}) => {
	let orderIdsText = ''
	for (const order of recentOrders || []) {
		const orderId = getOrderId(order)
		if (orderId) orderIdsText += `\n  📦 ${orderId}`
	}
	const orderBlock = orderIdsText ? `\n\n📋 Прошлые заказы:${orderIdsText}` : ''

	const statusLabel = getClientStatusLabel({ hasRecentOrder, hasAnyOrder })
	const delegationLine = delegatedFromAt ? `\n🕒 Delegated from @${delegatedFromAt}` : ''
	const phoneLine = customerNumber ? `\nPhone: ${customerNumber}` : ''

	if (type === 'call') {
		return `📞 Повторный звонок\nКлиент: #c${clientNumericId}${phoneLine}\nСтатус: ${statusLabel}${delegationLine}${orderBlock}`
	}
	if (type === 'missed_call') {
		const callStatusLine = callResult ? `\nЗвонок: ${callResult}` : ''
		return `☎️ Пропущенный звонок\nКлиент: #c${clientNumericId}${phoneLine}\nСтатус: ${statusLabel}${callStatusLine}${delegationLine}${orderBlock}`
	}
	if (type === 'sms') {
		const formattedSms = message ? message.replace(/\\n/g, '\n') : ''
		const smsContent = formattedSms ? `\n\n💬 Текст СМС:\n${formattedSms}` : ''
		return `💬 Входящее СМС\nКлиент: #c${clientNumericId}${phoneLine}\nСтатус: ${statusLabel}${delegationLine}${smsContent}${orderBlock}`
	}
	return `🆕 Новый лид\nКлиент: #c${clientNumericId}${phoneLine}\nСтатус: ${statusLabel}${delegationLine}${orderBlock}`
}

const sendLeadNotificationToGateway = async ({ type, leadData }) => {
	const clientNumericId = leadData.client_numeric_id || leadData.client_id
	const customerNumber = leadData.customer_number || ''
	const messageText = leadData.message || ''
	const recentOrders = leadData.orders || []
	const callResult = leadData.result || ''
	const text = buildLeadMessage({
		type,
		clientNumericId,
		customerNumber: null, // No phone in group messages
		recentOrders,
		callResult,
		hasRecentOrder: leadData.has_recent_order,
		hasAnyOrder: leadData.has_any_order,
		message: messageText,
		delegatedFromAt: leadData.delegated_from_at,
	})

	const claimType = type === 'sms' ? 'sms' : type === 'missed_call' ? 'missed' : 'rpt'
	const sendResp = await gatewayPostInternal({
		operationType: 'send_message',
		idempotencyKey: makeIdempotencyKey(`lead-${type}-${clientNumericId}`),
		payload: {
			...getGatewayChatTarget(),
			text,
			replyMarkup: {
				inlineKeyboard: [
					[{ text: 'Claim', callbackData: `claim:zoom:${claimType}:${clientNumericId}` }],
				],
			},
		},
	})

	const telegramMessageId = sendResp?.deliveryResult?.messageId
	const telegramChatId = sendResp?.deliveryResult?.chatId
	if (!telegramMessageId) {
		logger.warn(
			`⚠️ Gateway send_message accepted without deliveryResult.messageId (type=${type}, client=${clientNumericId})`
		)
		return sendResp
	}

	const FilledFormsModel = await getCollectionModel('filled_forms')
	await FilledFormsModel.create({
		chat_team: 'TEST',
		team_: 'test_gateway',
		cpmn_name:
			type === 'sms' ? 'repeat_sms' : type === 'missed_call' ? 'missed_call' : 'repeat_call',
		client_id: clientNumericId,
		telephone: customerNumber,
		...(type === 'sms' ? { sms_text: messageText } : {}),
		chat_message_id: telegramMessageId,
		test_chat_id: telegramChatId || GATEWAY_CHAT_ID || null,
		date: formatUtcIso(new Date()),
		text,
		type: 'TV',
		messages: {},
		source: 'telegram_gateway',
	})

	return sendResp
}

const sendRepeatCallNotification = repeatData =>
	sendLeadNotificationToGateway({ type: 'call', leadData: repeatData })

const sendRepeatSmsNotification = repeatData =>
	sendLeadNotificationToGateway({ type: 'sms', leadData: repeatData })

const sendMissedCallNotification = missedData =>
	sendLeadNotificationToGateway({ type: 'missed_call', leadData: missedData })

const sendDirectLeadNotificationToGateway = async leadData => {
	const clientNumericId = leadData.client_numeric_id || leadData.client_id
	const managerAt = leadData.manager_at
	const managerChatId = leadData.manager_chat_id

	if (!managerAt) {
		logger.warn(`⚠️ Cannot send direct lead to gateway: manager_at missing client=${clientNumericId}`)
		return null
	}

	const text = buildLeadMessage({
		type: leadData.lead_type === 'missed_call' ? 'missed_call' : 'direct',
		clientNumericId,
		customerNumber: leadData.customer_number,
		recentOrders: leadData.orders || [],
		callResult: leadData.result || '',
		hasRecentOrder: leadData.has_recent_order,
		hasAnyOrder: leadData.has_any_order,
		message: leadData.message || '',
		delegatedFromAt: leadData.delegated_from_at,
	})

	// Use per-manager chat ID if available, otherwise fallback to global gateway chat
	let targetChatId = managerChatId || (await getManagerChatIdByAt(managerAt))
	let redirectionTag = ''

	if (REDIRECT_DM_ENABLED) {
		const groupTarget = getGatewayChatTarget()
		targetChatId = groupTarget.chatId || groupTarget.chatAlias
		redirectionTag = `🕒 [REDIRECTED DM for @${managerAt}]\n`
	}

	if (!targetChatId) {
		logger.warn(`⚠️ Manager @${managerAt} has no chatID and no group fallback, cannot send direct lead`)
		return null
	}

	return gatewayPostInternal({
		operationType: 'send_message',
		idempotencyKey: makeIdempotencyKey(`direct-lead-${clientNumericId}-${Date.now()}`),
		payload: {
			chatId: String(targetChatId),
			text: redirectionTag + text,
		},
	})
}

const getManagerChatIdByAt = async managerAt => {
	const UsersModel = await getCollectionModel('users')
	const user = await UsersModel.findOne({ at: managerAt })
	return user?.chat_id || null
}

const extractGatewayCallback = payload => {
	const callbackQuery = payload?.callbackQuery || payload?.rawUpdate?.callback_query || {}
	const callbackMessage =
		callbackQuery.message || payload?.rawUpdate?.callback_query?.message || {}
	const callbackFrom = callbackQuery.from || payload?.rawUpdate?.callback_query?.from || {}

	return {
		callbackQueryId: callbackQuery.id || null,
		callbackData: callbackQuery.data || null,
		messageId: callbackQuery.messageId || callbackMessage.message_id || null,
		chatId:
			callbackMessage?.chatId ||
			callbackMessage?.chat?.id ||
			payload?.message?.chatId ||
			null,
		fromId: callbackQuery.fromId || callbackFrom.id || null,
		username: callbackFrom.username || null,
		firstName: callbackFrom.first_name || null,
	}
}

const formatClaimDm = ({ form, clientRef, managerAt }) => {
	const phone = form?.telephone || '_'
	const clientName = clientRef?.client_name || '_'
	const smsRaw = form?.sms_text || ''
	const smsText = smsRaw ? `\n\n💬 Текст СМС:\n${String(smsRaw).replace(/\\n/g, '\n')}` : ''

	const redirectNote = REDIRECT_DM_ENABLED && managerAt
		? `\n\n🔄 [REDIRECTED from @${managerAt}]`
		: ''

	return (
		`Client #c${form?.client_id ?? '_'}\n` +
		`Client name: ${clientName}\n` +
		`Campaign: ${form?.cpmn_name ?? '_'}\n` +
		`Phone: ${phone}${smsText}${redirectNote}`
	)
}

const handleGatewayTelegramEvent = async payload => {
	const updateType = payload?.updateType || 'unknown'
	if (updateType !== 'callback_query') {
		return { handled: false, reason: `ignored updateType=${updateType}` }
	}

	const callback = extractGatewayCallback(payload)
	if (!callback.callbackData || !callback.callbackData.startsWith('claim:zoom:')) {
		return { handled: false, reason: 'ignored non-claim callback' }
	}
	const claimClientId = parseClaimClientId(callback.callbackData)

	const messageId = Number(callback.messageId)
	if (!Number.isFinite(messageId)) {
		await safeAnswerCallback(callback.callbackQueryId, 'Invalid message', true)
		return { handled: true, reason: 'invalid messageId' }
	}

	const FilledFormsModel = await getCollectionModel('filled_forms')
	const UsersModel = await getCollectionModel('users')
	const ClientsModel = await getCollectionModel('clients')

	const formQuery = {
		$and: [
			{
				$or: buildValueVariants(messageId).map(value => ({ chat_message_id: value })),
			},
			{
				$or: [{ source: 'telegram_gateway' }, { team_: 'test_gateway' }],
			},
		],
	}
	if (claimClientId !== null) {
		formQuery.$and.push({
			$or: buildValueVariants(claimClientId).map(value => ({ client_id: value })),
		})
	}
	if (callback.chatId !== null && callback.chatId !== undefined) {
		formQuery.$and.push({
			$or: buildValueVariants(callback.chatId).map(value => ({ test_chat_id: value })),
		})
	}

	const form = await FilledFormsModel.findOne(formQuery).sort({ _id: -1 })

	if (!form) {
		await safeAnswerCallback(callback.callbackQueryId, 'Form not found', true)
		return { handled: true, reason: 'form not found' }
	}

	if (form.manager_at) {
		await safeAnswerCallback(callback.callbackQueryId, 'Already claimed!', true)
		return { handled: true, reason: 'already claimed' }
	}

	await safeAnswerCallback(callback.callbackQueryId)

	const username = callback.username || callback.firstName || `id_${callback.fromId || 'unknown'}`

	let user = null
	if (callback.username) {
		user = await UsersModel.findOne({ at: callback.username })
	}
	if (!user && callback.fromId !== null && callback.fromId !== undefined) {
		user = await UsersModel.findOne({
			$or: [{ chat_id: callback.fromId }, { chat_id: String(callback.fromId) }],
		})
	}

	const managerId = user?.manager_id || 'T0'
	const team = user?.team || 'TEST'
	const managerAt = user?.at || username

	await FilledFormsModel.updateOne(
		{ _id: form._id },
		{
			$set: {
				team,
				manager_id: managerId,
				manager_at: managerAt,
			},
		}
	)

	const chatId = callback.chatId || form.test_chat_id || GATEWAY_CHAT_ID
	if (chatId) {
		const updatedText = `claimed by @${username} #${managerId}${team}\n${form.text || ''}`
		try {
			await gatewayPostInternal({
				operationType: 'edit_message_text',
				idempotencyKey: makeIdempotencyKey(`claim-edit-${messageId}`),
				payload: {
					chatId: String(chatId),
					messageId,
					text: updatedText,
				},
			})
		} catch (error) {
			logger.warn(`⚠️ Failed to edit claimed message ${messageId}: ${error.message}`)
		}
	}

	const clientId = normalizeClientId(form.client_id)
	let clientRef = null
	if (clientId !== null) {
		clientRef = await ClientsModel.findOne({
			$or: [{ id: clientId }, { id: String(clientId) }],
		})
	}

	let claimerChatId = user?.chat_id || callback.fromId
	let redirectionTag = ''

	if (REDIRECT_DM_ENABLED) {
		const groupTarget = getGatewayChatTarget()
		claimerChatId = groupTarget.chatId || groupTarget.chatAlias
		redirectionTag = `🕒 [REDIRECTED DM for @${managerAt}]\n`
	}

	if (claimerChatId) {
		try {
			await gatewayPostInternal({
				operationType: 'send_message',
				idempotencyKey: makeIdempotencyKey(`claim-dm-${form._id}`),
				payload: {
					chatId: String(claimerChatId),
					text: redirectionTag + formatClaimDm({ form, clientRef, managerAt }),
				},
			})
		} catch (error) {
			logger.warn(
				`⚠️ Failed to send DM for claim form=${form._id} chatId=${claimerChatId}: ${error.message}`
			)
		}
	}

	if (clientId !== null) {
		const utcNow = new Date()
		const shiftStart = new Date(utcNow)
		if (utcNow.getUTCHours() >= 4) {
			shiftStart.setUTCHours(0, 0, 0, 0)
		} else {
			shiftStart.setUTCDate(shiftStart.getUTCDate() - 1)
			shiftStart.setUTCHours(0, 0, 0, 0)
		}

		await sendToQueue('personal_claimed_leads', {
			shift_date: shiftStart.toISOString().slice(0, 10),
			client_id: clientId,
			manager_at: managerAt,
			team,
			form_id: String(form._id),
			form_date: form.date,
			claim_date: formatUtcIso(utcNow),
			event: 'claim',
		})
	}

	logger.info(`✅ [gateway-claim] @${username} claimed #c${form.client_id}`)
	return { handled: true, reason: 'claim processed', formId: String(form._id) }
}

const verifyGatewayEventHeaders = headers => {
	if (EXPECTED_APP_KEY && headers['x-telegram-app-key'] !== EXPECTED_APP_KEY) {
		return {
			valid: false,
			status: 403,
			message: `Unexpected x-telegram-app-key: ${headers['x-telegram-app-key'] || ''}`,
		}
	}
	if (EXPECTED_ROUTE_KEY && headers['x-telegram-route-key'] !== EXPECTED_ROUTE_KEY) {
		return {
			valid: false,
			status: 403,
			message: `Unexpected x-telegram-route-key: ${headers['x-telegram-route-key'] || ''}`,
		}
	}
	return { valid: true }
}

module.exports = {
	isGatewayEnabled,
	sendRepeatCallNotification,
	sendRepeatSmsNotification,
	sendMissedCallNotification,
	sendDirectLeadNotificationToGateway,
	handleGatewayTelegramEvent,
	verifyGatewayEventHeaders,
	gatewayPostInternal,
	makeIdempotencyKey,
	getGatewayChatTarget,
}
