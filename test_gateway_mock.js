const axios = require('axios');

const URL = 'http://localhost:8000/internal/telegram/events';
const HEADERS = {
    'x-telegram-app-key': 'zoom-income-lead-claim',
    'x-telegram-route-key': 'support-bot',
    'content-type': 'application/json'
};

const mockEvent = {
    updateType: 'callback_query',
    callbackQuery: {
        id: 'mock_callback_id_' + Date.now(),
        fromId: 12345678,
        username: 'test_manager',
        messageId: 111,
        chatId: -5123319543,
        data: 'claim:777' // Mocking a claim for client ID 777
    }
};

async function runTest() {
    console.log('🚀 Sending mock gateway event to queue_workers...');
    try {
        const response = await axios.post(URL, mockEvent, { headers: HEADERS });
        console.log('✅ Status:', response.status);
        console.log('✅ Response:', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('❌ Test failed:', error.response ? error.response.data : error.message);
    }
}

runTest();
