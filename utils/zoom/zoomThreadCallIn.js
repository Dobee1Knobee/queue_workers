require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('pino')();

const zoomThreadCallIn = async (data) => {
    console.log('Zoom thread consumer для очереди:', data);
    
    try {
        // Проверяем наличие переменной окружения
        if (!process.env.CALL_DB_URL) {
            throw new Error('Переменная CALL_DB_URL не определена в .env файле. Добавьте CALL_DB_URL=your_mongodb_connection_string в .env');
        }
        
        // Подключаемся к базе данных (если ещё не подключены)
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.CALL_DB_URL);
            logger.info('✅ Connected to call database');
        } else {
            logger.info('✅ Already connected to database');
        }
        
    } catch (error) {
        logger.error('❌ Ошибка в zoomThreadCallIn:', error.message);
        throw error;
    }
}
module.exports = { zoomThreadCallIn };