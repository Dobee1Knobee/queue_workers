require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('pino')();
const { smsSchema } = require('../../models/sms_model');

// Создаем отдельное подключение для SMS базы данных
// чтобы избежать конфликтов с другими подключениями
let smsConnection = null;
let SmsModel = null;

const getSmsConnection = async () => {
    if (!process.env.SMS_DB_URL) {
        throw new Error('Переменная SMS_DB_URL не определена в .env файле');
    }
    
    // Если подключение уже существует и активно, возвращаем его
    if (smsConnection && smsConnection.readyState === 1 && SmsModel) {
        return { connection: smsConnection, model: SmsModel };
    }
    
    // Создаем новое подключение
    smsConnection = mongoose.createConnection(process.env.SMS_DB_URL, {
        bufferCommands: false,
        maxPoolSize: 10
    });
    
    // Ждем, пока подключение установится
    await new Promise((resolve, reject) => {
        if (smsConnection.readyState === 1) {
            // Уже подключено (маловероятно, но на всякий случай)
            logger.info('✅ Connected to SMS database');
            logger.info(`Database name: ${smsConnection.name}`);
            resolve();
        } else {
            smsConnection.once('connected', () => {
                logger.info('✅ Connected to SMS database');
                logger.info(`Database name: ${smsConnection.name}`);
                resolve();
            });
            smsConnection.once('error', (err) => {
                logger.error('❌ Error connecting to SMS database:', err.message);
                reject(err);
            });
        }
    });
    
    // Создаем модель на этом подключении
    SmsModel = smsConnection.model('Sms', smsSchema, 'sms');
    
    return { connection: smsConnection, model: SmsModel };
};

const zoomThreadSmsIn = async (data) => {
    logger.info('📱 Обработка SMS сообщения');
    
    try {
        // Проверяем структуру данных
        if (!data.body || !data.body.payload || !data.body.payload.object) {
            throw new Error('Неверная структура данных: отсутствует body.payload.object');
        }
        
        const smsData = data.body.payload.object;
        
        // Извлекаем данные из структуры Zoom
        const phoneNumber = smsData.sender?.phone_number || null;
        const message = smsData.message || '';
        const messageId = smsData.message_id || null;
        const sessionId = smsData.session_id || null;
        const ownerId = smsData.owner?.id || null;
        const dateTime = smsData.date_time ? new Date(smsData.date_time) : new Date();
        
        if (!phoneNumber || !message) {
            throw new Error('Отсутствуют обязательные поля: phone_number или message');
        }
        
        // Получаем подключение и модель
        const { model } = await getSmsConnection();
        
        // Проверяем, не существует ли уже сообщение с таким messageId
        let existingSms = null;
        if (messageId) {
            existingSms = await model.findOne({ messageId });
        }
        
        if (existingSms) {
            logger.info(`⚠️ SMS с messageId ${messageId} уже существует, пропускаем`);
            return { success: true, skipped: true, message: 'SMS already exists' };
        }
        
        // Создаём новую запись SMS
        const newSms = new model({
            incoming: true,
            phone: phoneNumber,
            message: message,
            messageId: messageId,
            sessionId: sessionId,
            ownerId: ownerId,
            dateTime: dateTime
        });
        
        await newSms.save();
        logger.info(`✅ SMS сохранено в базу данных: ${phoneNumber} - ${message.substring(0, 50)}...`);
        
        return { 
            success: true, 
            smsId: newSms._id,
            phone: phoneNumber,
            messageId: messageId
        };
        
    } catch (error) {
        logger.error('❌ Ошибка в zoomThreadSmsIn:', error.message);
        throw error;
    }
}

module.exports = { zoomThreadSmsIn };
