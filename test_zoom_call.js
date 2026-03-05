require('dotenv').config();
const { zoomThreadCallIn } = require('./utils/zoom/zoomThreadCallIn');

async function run() {
    console.log('🚀 Запуск теста zoomThreadCallIn...');
    
    // Мок данные из Zoom вебхука
    const mockZoomData = {
        body: {
            payload: {
                object: {
                    call_logs: [
                        {
                            direction: 'inbound',
                            duration: 120,
                            result: 'Call Answered',
                            call_end_time: new Date().toISOString(),
                            caller_number: '+12487018182', // Номер клиента Gregory Hofelich (из базы)
                            caller_number_source: 'external',
                            callee_number: '12345',
                            callee_number_source: 'internal',
                            callee_extension_number: '101'
                        }
                    ]
                }
            }
        }
    };

    try {
        const result = await zoomThreadCallIn(mockZoomData);
        console.log('\n🏁 Результат zoomThreadCallIn:', result);
    } catch (err) {
        console.error('❌ Ошибка теста:', err);
    }
    
    // Небольшая задержка перед выходом, чтобы логи пино успели записаться
    setTimeout(() => process.exit(0), 1000);
}

run();
