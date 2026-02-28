const amqp = require('amqplib')
const logger = require('pino')()

let connection = null;
let channel = null;

const initRabbitMQ = async () => {
    if (channel) return channel;

    const url = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASS}@${process.env.NGROK_TCP_HOST}:${process.env.NGROK_TCP_PORT}`
    
    try {
        connection = await amqp.connect(url);
        channel = await connection.createChannel();
        logger.info('✅ Успешно подключились к RabbitMQ для публикации (publisher)');
        return channel;
    } catch (error) {
        logger.error('❌ Ошибка подключения к RabbitMQ (publisher):', error.message);
        throw error;
    }
}

const sendToQueue = async (queueName, data) => {
    try {
        const ch = await initRabbitMQ();
        await ch.assertQueue(queueName, { durable: true });
        
        const messageBuffer = Buffer.from(JSON.stringify(data));
        const sent = ch.sendToQueue(queueName, messageBuffer, { persistent: true });
        
        if (sent) {
            logger.info(`✅ Успешно отправлено сообщение в очередь: ${queueName}`);
        } else {
            logger.warn(`⚠️ Сообщение не было отправлено в очередь (буфер переполнен): ${queueName}`);
        }
        
        return sent;
    } catch (error) {
        logger.error(`❌ Ошибка отправки сообщения в очередь ${queueName}:`, error.message);
        return false;
    }
}

module.exports = { sendToQueue }
