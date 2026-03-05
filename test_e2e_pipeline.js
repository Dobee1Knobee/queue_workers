/**
 * E2E Pipeline Test: RabbitMQ → mini_bot → Telegram
 * 
 * Sends a message DIRECTLY to the repeat_call_in / repeat_sms_in queues
 * using the same sendToQueue() function that zoomThreadCallIn uses.
 * 
 * This tests the REAL pipeline: Node.js sendToQueue → RabbitMQ → Python mini_bot → Telegram
 * 
 * Usage:
 *   node test_e2e_pipeline.js           # test repeat call
 *   node test_e2e_pipeline.js sms       # test repeat SMS
 *   node test_e2e_pipeline.js both      # test both
 * 
 * IMPORTANT: Start test_mini_bot.py in another terminal first!
 */

require('dotenv').config()
const { sendToQueue } = require('./utils/rabbitmq')

const TEST_PHONE = '+10001112233'
const TEST_CLIENT_ID = 99999

async function main() {
    const mode = process.argv[2] || 'call'

    console.log('=' .repeat(60))
    console.log('  E2E PIPELINE TEST — direct RabbitMQ push')
    console.log('  Using the SAME sendToQueue() as zoomThreadCallIn')
    console.log('=' .repeat(60))

    if (mode === 'call' || mode === 'both') {
        console.log('\n📞 Sending REPEAT CALL to repeat_call_in queue...')
        
        const repeatCallData = {
            client_id: String(TEST_CLIENT_ID),
            client_numeric_id: TEST_CLIENT_ID,
            customer_number: TEST_PHONE,
            // Only recent orders — zoomThreadCallIn filters by _id >= twoWeeksAgo
            // ZZ0000000 (Feb 1) would NOT pass the 14-day filter
            orders: [
                { 
                    order_id: 'ZZ0000001', 
                    status: 'scheduled',
                    _id: '65e3b1c0aabbccdd00000001'  // Mar 1 — within 14 days
                },
            ],
            direction: 'inbound',
            ext: '100',
            duration: 30,
            callEnd: new Date().toISOString(),
            zoomData: { test: true }
        }

        await sendToQueue('repeat_call_in', repeatCallData)
        console.log('   ✅ Message sent to repeat_call_in!')
        console.log('   Payload:', JSON.stringify(repeatCallData, null, 2))
    }

    if (mode === 'sms' || mode === 'both') {
        console.log('\n💬 Sending REPEAT SMS to repeat_sms_in queue...')
        
        const repeatSmsData = {
            client_id: String(TEST_CLIENT_ID),
            client_numeric_id: TEST_CLIENT_ID,
            customer_number: TEST_PHONE,
            message: 'Hello, I need to schedule another TV mounting please',
            // Only recent orders (same filter as zoomThreadSmsIn)
            orders: [
                { 
                    order_id: 'ZZ0000001', 
                    status: 'scheduled',
                    _id: '65e3b1c0aabbccdd00000001'  // Mar 1 — within 14 days
                },
            ],
            smsType: 'sms',
            zoomData: { test: true }
        }

        await sendToQueue('repeat_sms_in', repeatSmsData)
        console.log('   ✅ Message sent to repeat_sms_in!')
        console.log('   Payload:', JSON.stringify(repeatSmsData, null, 2))
    }

    console.log('\n' + '=' .repeat(60))
    console.log('  🎯 CHECK YOUR TERMINALS:')
    if (mode === 'call' || mode === 'both') {
        console.log('  📞 CALL: Telegram group should show:')
        console.log('     📞 Повторный звонок')
        console.log('     Клиент: #c99999')
        console.log('     📋 Прошлые заказы:')
        console.log('       📦 ZZ0000001')
        console.log('     [Claim]  ← NO phone number shown!')
    }
    if (mode === 'sms' || mode === 'both') {
        console.log('  💬 SMS: Telegram group should show:')
        console.log('     💬 Повторное СМС')
        console.log('     Клиент: #c99999')
        console.log('     📋 Прошлые заказы:')
        console.log('       📦 ZZ0000001')
        console.log('     [Claim]  ← NO phone or SMS text shown!')
    }
    console.log('\n  After Claim → DM shows phone + details')
    console.log('=' .repeat(60))

    // Give RabbitMQ a moment to deliver
    await new Promise(resolve => setTimeout(resolve, 2000))
    process.exit(0)
}

main().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
