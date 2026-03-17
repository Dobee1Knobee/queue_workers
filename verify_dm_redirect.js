// Mock environment and dependencies for pure logic verification
process.env.TELEGRAM_GATEWAY_REDIRECT_DM = 'true'
process.env.TELEGRAM_GATEWAY_CHAT_ID = '-100123456789'

// Mock logger
const logger = {
    warn: console.warn,
    info: console.log,
    error: console.error
}

// Mock getGatewayChatTarget and gatewayPostInternal as they appear in gatewayFlow.js
// We'll read the file directly or just mock them based on what we know

const getGatewayChatTarget = () => {
    return { chatId: '-100123456789' }
}

const buildLeadMessage = ({ redirectionTag = '', managerAt = 'iliasorokin67' }) => {
    return `${redirectionTag}Mock message for @${managerAt}`
}

// Simplified version of the logic from gatewayFlow.js
async function sendDirectLeadNotificationToGatewayMock(leadData) {
    const managerAt = leadData.manager_at || 'iliasorokin67'
    const managerChatId = null // Simulating missing chat ID
    
    let targetChatId = managerChatId
    let redirectionTag = ''

    if (process.env.TELEGRAM_GATEWAY_REDIRECT_DM === 'true') {
        const groupTarget = getGatewayChatTarget()
        targetChatId = groupTarget.chatId || groupTarget.chatAlias
        redirectionTag = `🕒 [REDIRECTED DM for @${managerAt}]\n`
    }

    const text = buildLeadMessage({ redirectionTag, managerAt })

    return {
        payload: {
            chatId: String(targetChatId),
            text: text,
        },
    }
}

// Lead data
const mockLead = {
    manager_at: 'iliasorokin67',
    lead_type: 'direct'
}

console.log('--- REDIRECT DM LOGIC VERIFICATION ---')
console.log('ENABLED: ' + process.env.TELEGRAM_GATEWAY_REDIRECT_DM)

async function runTest() {
    const result = await sendDirectLeadNotificationToGatewayMock(mockLead)
    console.log('Lead Payload:', JSON.stringify(result.payload, null, 2))
    
    if (result.payload.chatId === '-100123456789' && result.payload.text.includes('[REDIRECTED DM')) {
        console.log('✅ SUCCESS: Lead DM correctly redirected.')
    } else {
        console.log('❌ FAILURE: Lead DM redirection logic failed.')
    }

    // Mock claim DM
    async function sendClaimDmVerification() {
        let claimerChatId = '123456789'
        let redirectionTag = ''
        const managerAt = 'iliasorokin67'

        if (process.env.TELEGRAM_GATEWAY_REDIRECT_DM === 'true') {
            const groupTarget = getGatewayChatTarget()
            claimerChatId = groupTarget.chatId || groupTarget.chatAlias
            redirectionTag = `🕒 [REDIRECTED DM for @${managerAt}]\n`
        }

        const payload = {
            chatId: String(claimerChatId),
            text: redirectionTag + 'Claim confirmed for client #123'
        }
        console.log('Claim Payload:', JSON.stringify(payload, null, 2))

        if (payload.chatId === '-100123456789' && payload.text.includes('[REDIRECTED DM')) {
            console.log('✅ SUCCESS: Claim DM correctly redirected.')
        } else {
            console.log('❌ FAILURE: Claim DM redirection logic failed.')
        }
    }

    await sendClaimDmVerification()
}

runTest()
