require('dotenv').config()
const mongoose = require('mongoose')
const logger = require('pino')()
const { sendToQueue } = require('./rabbitmq')
const SHIFT_REPLACEMENTS = require('../config/shiftReplacements')

let tvmountConnection = null
let tvmountConnectionPromise = null

const AUTO_CLAIM_SHADOW = String(
	process.env.AUTO_CLAIM_SHADOW || 'true'
).toLowerCase() === 'true'
const AUTO_CLAIM_ENABLED = String(
	process.env.AUTO_CLAIM_ENABLED || 'false'
).toLowerCase() === 'true'
const AUTO_CLAIM_SEND_DM = String(
	process.env.AUTO_CLAIM_SEND_DM || 'false'
).toLowerCase() === 'true'
const AUTO_CLAIM_LOOKBACK_HOURS = Number(
	process.env.AUTO_CLAIM_LOOKBACK_HOURS || 168
)
const AUTO_CLAIM_QUEUE = process.env.AUTO_CLAIM_QUEUE || 'auto_claim_in'
const AUTO_CLAIM_MIN_CALL_DURATION_SEC = Number(
	process.env.AUTO_CLAIM_MIN_CALL_DURATION_SEC || 15
)
const AUTO_CLAIM_REQUEST_DEDUP_MS = Number(
	process.env.AUTO_CLAIM_REQUEST_DEDUP_MS || 5 * 60 * 1000
)
const CONNECTED_RESULT_KEYWORDS = String(
	process.env.AUTO_CLAIM_CONNECTED_RESULTS ||
		'accepted,answered,connected,completed'
)
	.split(',')
	.map(value => value.trim().toLowerCase())
	.filter(Boolean)

const OPEN_LEAD_CAMPAIGNS = ['missed_call', 'repeat_call', 'repeat_sms']
const QUEUE_WORKERS_FORM_MARKERS = [
	{ source: 'telegram_gateway' },
	{ team_: 'test_gateway' },
	{ team_: 'test_mini_bot' },
	{ chat_team: 'TEST' },
]
const recentAutoClaimRequests = new Map()

const buildValueVariants = value => {
	if (value === null || value === undefined || value === '') return []
	const values = [value, String(value)]
	const numeric = Number(value)
	if (Number.isFinite(numeric)) values.push(numeric)
	return [...new Set(values)]
}

const normalizeCallResult = result => String(result || '').trim().toLowerCase()

const normalizePhone = value => {
	const digits = String(value || '').replace(/\D/g, '')
	if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
	return digits
}

const getLeadBaseQuery = cutoff => ({
	$and: [
		{ $or: OPEN_LEAD_CAMPAIGNS.map(value => ({ cpmn_name: value })) },
		{
			$or: [
				{ manager_at: { $exists: false } },
				{ manager_at: null },
				{ manager_at: '' },
			],
		},
		{ $or: QUEUE_WORKERS_FORM_MARKERS },
		{
			$or: [
				{ date: { $gte: cutoff.toISOString() } },
				{ date: { $exists: false } },
			],
		},
	],
})

const isObservationEnabled = () => AUTO_CLAIM_SHADOW || AUTO_CLAIM_ENABLED

const getTvmountConnection = async () => {
	if (tvmountConnection && tvmountConnection.readyState === 1) {
		return tvmountConnection
	}
	if (tvmountConnectionPromise) {
		await tvmountConnectionPromise
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

	tvmountConnectionPromise = new Promise((resolve, reject) => {
		if (tvmountConnection.readyState === 1) {
			resolve()
			return
		}
		tvmountConnection.once('connected', resolve)
		tvmountConnection.once('error', reject)
	})

	try {
		await tvmountConnectionPromise
	} finally {
		tvmountConnectionPromise = null
	}

	return tvmountConnection
}

const getCollectionModel = async name => {
	const conn = await getTvmountConnection()
	return (
		conn.models[name] ||
		conn.model(name, new mongoose.Schema({}, { strict: false }), name)
	)
}

const findUserByAt = async at => {
	if (!at) return null
	const UsersModel = await getCollectionModel('users')
	return UsersModel.findOne({ at })
}

const findOpenLead = async ({ clientId, phone }) => {
	const cutoff = new Date(Date.now() - AUTO_CLAIM_LOOKBACK_HOURS * 60 * 60 * 1000)
	const FilledFormsModel = await getCollectionModel('filled_forms')
	const candidates = await FilledFormsModel.find(getLeadBaseQuery(cutoff))
		.sort({ date: -1, _id: -1 })
		.limit(200)

	const normalizedPhone = normalizePhone(phone)
	if (normalizedPhone.length >= 10) {
		const phoneLead = candidates.find(doc => {
			return normalizePhone(doc.telephone) === normalizedPhone
		})
		if (phoneLead) {
			return {
				lead: phoneLead,
				matchMethod: 'telephone',
				normalizedPhone,
			}
		}
	}

	const clientVariants = buildValueVariants(clientId).map(value => String(value))
	if (clientVariants.length) {
		const clientLead = candidates.find(doc =>
			clientVariants.includes(String(doc.client_id))
		)
		if (clientLead) {
			return {
				lead: clientLead,
				matchMethod: 'client_id',
				normalizedPhone,
			}
		}
	}

	return {
		lead: null,
		matchMethod: null,
		normalizedPhone,
	}
}

const resolveSmsManager = async ownerId => {
	const variants = buildValueVariants(ownerId)
	if (!variants.length) return null
	const UsersModel = await getCollectionModel('users')
	return UsersModel.findOne({
		$or: variants.flatMap(value => [
			{ id: value },
			{ extension_id: value },
			{ phone_user_id: value },
		]),
	})
}

const resolveManagerByPhone = async phone => {
	const normalizedPhone = normalizePhone(phone)
	if (normalizedPhone.length < 10) return null
	const UsersModel = await getCollectionModel('users')
	return UsersModel.findOne({
		'phone_numbers.number': {
			$regex: normalizedPhone.slice(-10).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
		},
	})
}


const buildManagerSnapshot = (manager, resolutionMethod = null, extra = {}) => {
	if (!manager) return null
	return {
		manager_id: manager.manager_id || manager.id || null,
		manager_at: manager.at || manager.username || null,
		team: manager.team || null,
		chat_id: manager.chat_id || null,
		working: manager.working,
		resolution_method: resolutionMethod,
		...extra,
	}
}

const resolveEffectiveManager = async (managerDoc, resolutionMethod) => {
	if (!managerDoc) return null
	if (managerDoc.working !== false) {
		return buildManagerSnapshot(managerDoc, resolutionMethod)
	}

	const replacementAt = SHIFT_REPLACEMENTS[managerDoc.at]
	if (!replacementAt) {
		return buildManagerSnapshot(managerDoc, resolutionMethod, {
			replacement_candidate_at: null,
		})
	}

	const replacementDoc = await findUserByAt(replacementAt)
	if (!replacementDoc || replacementDoc.working === false) {
		return buildManagerSnapshot(managerDoc, resolutionMethod, {
			replacement_candidate_at: replacementAt,
		})
	}

	return buildManagerSnapshot(replacementDoc, `${resolutionMethod}:shift_replacement`, {
		delegated_from_at: managerDoc.at || null,
		delegated_from_manager_id: managerDoc.manager_id || null,
		replacement_candidate_at: replacementAt,
	})
}

const evaluateCallAutoClaim = ({ direction, duration, result, manager }) => {
	if (!manager) {
		return { eligible: false, reason: 'manager_not_resolved' }
	}
	if (direction !== 'outbound') {
		return { eligible: false, reason: 'call_not_outgoing' }
	}

	const normalizedResult = normalizeCallResult(result)
	const durationSec = Number(duration)
	const hasDurationSignal =
		Number.isFinite(durationSec) &&
		durationSec >= AUTO_CLAIM_MIN_CALL_DURATION_SEC
	const hasConnectedResultSignal = CONNECTED_RESULT_KEYWORDS.some(keyword =>
		normalizedResult.includes(keyword)
	)

	if (!hasDurationSignal && !hasConnectedResultSignal) {
		return {
			eligible: false,
			reason: 'call_not_strong_enough',
			normalizedResult,
			durationSec,
		}
	}

	return {
		eligible: true,
		reason: hasDurationSignal
			? `call_duration_gte_${AUTO_CLAIM_MIN_CALL_DURATION_SEC}`
			: 'call_result_connected',
		normalizedResult,
		durationSec,
	}
}

const evaluateSmsAutoClaim = ({ smsType, manager }) => {
	if (!manager) {
		return { eligible: false, reason: 'manager_not_resolved' }
	}
	if (smsType !== 'outgoing') {
		return { eligible: false, reason: 'sms_not_outgoing' }
	}
	return { eligible: true, reason: 'outgoing_sms_detected' }
}

const logDecision = payload => {
	logger.info(
		{
			event: 'auto_claim_shadow',
			...payload,
		},
		'Auto-claim shadow evaluation'
	)
}

const shouldSkipDuplicateRequest = ({ leadId, managerAt, triggerKey }) => {
	const key = `${leadId}:${managerAt}:${triggerKey}`
	const lastSent = recentAutoClaimRequests.get(key)
	if (lastSent && Date.now() - lastSent < AUTO_CLAIM_REQUEST_DEDUP_MS) {
		return true
	}
	recentAutoClaimRequests.set(key, Date.now())
	return false
}

const enqueueAutoClaimRequest = async ({
	lead,
	leadType,
	clientId,
	manager,
	channel,
	trigger,
	triggerKey,
	matchMethod,
	eventPhone,
	reason,
	createIfMissing = false,
	extra = {},
}) => {
	if (!manager?.manager_at) return false
	const dedupLeadId = lead ? String(lead._id) : `create:${leadType}:${clientId}:${eventPhone || 'na'}`
	if (
		shouldSkipDuplicateRequest({
			leadId: dedupLeadId,
			managerAt: manager.manager_at,
			triggerKey,
		})
	) {
		logger.info(
			{
				event: 'auto_claim_request_skipped',
				lead_form_id: lead ? String(lead._id) : null,
				create_if_missing: createIfMissing,
				manager_at: manager.manager_at,
				trigger_key: triggerKey,
			},
			'Auto-claim request deduplicated'
		)
		return false
	}

	const payload = {
		form_id: lead ? String(lead._id) : null,
		client_id: lead?.client_id ?? clientId ?? null,
		lead_type: lead?.cpmn_name || leadType || null,
		create_if_missing: createIfMissing,
		manager_id: manager.manager_id || null,
		manager_at: manager.manager_at || null,
		team: manager.team || null,
		manager_chat_id: manager.chat_id || null,
		manager_resolution_method: manager.resolution_method || null,
		channel,
		trigger,
		trigger_key: triggerKey,
		match_method: matchMethod || null,
		event_phone: eventPhone || null,
		reason,
		created_at: new Date().toISOString(),
		...extra,
	}

	const sent = await sendToQueue(AUTO_CLAIM_QUEUE, payload)
	logger.info(
		{
			event: 'auto_claim_request',
			queue: AUTO_CLAIM_QUEUE,
			sent,
			...payload,
		},
		'Auto-claim request queued'
	)
	return sent
}

const tryAutoClaimOpenLeadFromCall = async ({
	clientId,
	phone,
	managerPhone,
	direction,
	duration,
	result,
	responsibleManager,
	callId,
}) => {
	if (!isObservationEnabled()) return { observed: false, reason: 'disabled' }

	const { lead, matchMethod, normalizedPhone } = await findOpenLead({
		clientId,
		phone,
	})
	let managerDoc = responsibleManager
	let managerResolutionMethod = 'extension_or_zoom_id'
	if (!managerDoc && managerPhone) {
		managerDoc = await resolveManagerByPhone(managerPhone)
		managerResolutionMethod = managerDoc ? 'phone_numbers.number' : 'extension_or_zoom_id'
	}
	const manager = await resolveEffectiveManager(
		managerDoc,
		managerResolutionMethod
	)
	const decision = evaluateCallAutoClaim({
		direction,
		duration,
		result,
		manager,
	})
	if (!lead) {
		logDecision({
			channel: 'call',
			lead_type: null,
			lead_form_id: null,
			client_id: clientId,
			trigger: direction === 'outbound' ? 'call_outgoing' : 'call_connected',
			call_id: callId || null,
			event_phone: normalizedPhone || normalizePhone(phone),
			result: result || null,
			duration_sec: Number.isFinite(Number(duration)) ? Number(duration) : null,
			manager_id: manager?.manager_id || null,
			manager_at: manager?.manager_at || null,
			team: manager?.team || null,
			manager_resolution_method: manager?.resolution_method || null,
			manager_working: manager?.working ?? null,
			delegated_from_at: manager?.delegated_from_at || null,
			replacement_candidate_at: manager?.replacement_candidate_at || null,
			would_auto_claim: false,
			reason: 'no_open_lead',
			mode: AUTO_CLAIM_ENABLED ? 'enabled' : 'shadow_apply',
		})
		return { observed: false, reason: 'no_open_lead' }
	}

	logDecision({
		channel: 'call',
		lead_type: lead.cpmn_name || null,
		lead_form_id: String(lead._id),
		client_id: lead.client_id,
		trigger: direction === 'outbound' ? 'call_outgoing' : 'call_connected',
		call_id: callId || null,
		event_phone: normalizedPhone || normalizePhone(phone),
		match_method: matchMethod,
		result: result || null,
		normalized_result: decision.normalizedResult || null,
		duration_sec: decision.durationSec ?? (Number.isFinite(Number(duration)) ? Number(duration) : null),
		manager_id: manager?.manager_id || null,
		manager_at: manager?.manager_at || null,
		team: manager?.team || null,
		manager_resolution_method: manager?.resolution_method || null,
		manager_working: manager?.working ?? null,
		delegated_from_at: manager?.delegated_from_at || null,
		replacement_candidate_at: manager?.replacement_candidate_at || null,
		would_auto_claim: decision.eligible,
		reason: decision.reason,
		mode: AUTO_CLAIM_ENABLED ? 'enabled' : 'shadow_apply',
	})

	if (decision.eligible && (AUTO_CLAIM_ENABLED || AUTO_CLAIM_SHADOW)) {
		await enqueueAutoClaimRequest({
			lead,
			manager,
			channel: 'call',
			trigger: 'call_outgoing',
			triggerKey: callId || `${lead._id}:${manager.manager_at}:call`,
			matchMethod,
			eventPhone: normalizedPhone || normalizePhone(phone),
			reason: decision.reason,
			extra: {
				apply_mode: AUTO_CLAIM_ENABLED ? 'enabled' : 'shadow_apply',
				suppress_dm: !AUTO_CLAIM_SEND_DM,
				delegated_from_at: manager?.delegated_from_at || null,
				replacement_candidate_at: manager?.replacement_candidate_at || null,
				call_id: callId || null,
				result: result || null,
				duration_sec: decision.durationSec ?? null,
			},
		})
	}

	return {
		observed: true,
		leadType: lead.cpmn_name || null,
		wouldAutoClaim: decision.eligible,
		reason: decision.reason,
	}
}

const tryAutoClaimOpenLeadFromSms = async ({
	clientId,
	phone,
	managerPhone,
	smsType,
	ownerId,
	messageId,
}) => {
	if (!isObservationEnabled()) return { observed: false, reason: 'disabled' }

	const { lead, matchMethod, normalizedPhone } = await findOpenLead({
		clientId,
		phone,
	})
	let managerDoc = await resolveSmsManager(ownerId)
	let managerResolutionMethod = 'owner_id'
	if (!managerDoc && managerPhone) {
		managerDoc = await resolveManagerByPhone(managerPhone)
		managerResolutionMethod = managerDoc ? 'phone_numbers.number' : 'owner_id'
	}
	const manager = await resolveEffectiveManager(
		managerDoc,
		managerResolutionMethod
	)
	const decision = evaluateSmsAutoClaim({ smsType, manager })
	if (!lead) {
		logDecision({
			channel: 'sms',
			lead_type: null,
			lead_form_id: null,
			client_id: clientId,
			trigger: smsType === 'outgoing' ? 'sms_outgoing' : 'sms_incoming',
			message_id: messageId || null,
			event_phone: normalizedPhone || normalizePhone(phone),
			owner_id: ownerId || null,
			manager_id: manager?.manager_id || null,
			manager_at: manager?.manager_at || null,
			team: manager?.team || null,
			manager_resolution_method: manager?.resolution_method || null,
			manager_working: manager?.working ?? null,
			delegated_from_at: manager?.delegated_from_at || null,
			replacement_candidate_at: manager?.replacement_candidate_at || null,
			would_auto_claim: false,
			reason: 'no_open_lead',
			mode: AUTO_CLAIM_ENABLED ? 'enabled' : 'shadow_apply',
		})
		return { observed: false, reason: 'no_open_lead' }
	}

	logDecision({
		channel: 'sms',
		lead_type: lead.cpmn_name || null,
		lead_form_id: String(lead._id),
		client_id: lead.client_id,
		trigger: smsType === 'outgoing' ? 'sms_outgoing' : 'sms_incoming',
		message_id: messageId || null,
		event_phone: normalizedPhone || normalizePhone(phone),
		match_method: matchMethod,
		owner_id: ownerId || null,
		manager_id: manager?.manager_id || null,
		manager_at: manager?.manager_at || null,
		team: manager?.team || null,
		manager_resolution_method: manager?.resolution_method || null,
		manager_working: manager?.working ?? null,
		delegated_from_at: manager?.delegated_from_at || null,
		replacement_candidate_at: manager?.replacement_candidate_at || null,
		would_auto_claim: decision.eligible,
		reason: decision.reason,
		mode: AUTO_CLAIM_ENABLED ? 'enabled' : 'shadow_apply',
	})

	if (decision.eligible && (AUTO_CLAIM_ENABLED || AUTO_CLAIM_SHADOW)) {
		await enqueueAutoClaimRequest({
			lead,
			manager,
			channel: 'sms',
			trigger: 'sms_outgoing',
			triggerKey: messageId || `${lead._id}:${manager.manager_at}:sms`,
			matchMethod,
			eventPhone: normalizedPhone || normalizePhone(phone),
			reason: decision.reason,
			extra: {
				apply_mode: AUTO_CLAIM_ENABLED ? 'enabled' : 'shadow_apply',
				suppress_dm: !AUTO_CLAIM_SEND_DM,
				delegated_from_at: manager?.delegated_from_at || null,
				replacement_candidate_at: manager?.replacement_candidate_at || null,
				message_id: messageId || null,
				owner_id: ownerId || null,
			},
		})
	}

	return {
		observed: true,
		leadType: lead.cpmn_name || null,
		wouldAutoClaim: decision.eligible,
		reason: decision.reason,
	}
}

module.exports = {
	tryAutoClaimOpenLeadFromCall,
	tryAutoClaimOpenLeadFromSms,
}
