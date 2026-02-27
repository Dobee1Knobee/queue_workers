require('dotenv').config();
const amqp = require('amqplib');

const isDev = process.env.NODE_ENV !== 'production';
const devProcessingDelayMs = Number(
	process.env.DEV_PROCESSING_DELAY_MS || 1000
);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const queueConsumer = async (queueName) => {
    console.log('Queue consumer для очереди:', queueName);
    
    const url = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASS}@${process.env.NGROK_TCP_HOST}:${process.env.NGROK_TCP_PORT}`;
    console.log('Подключаемся к RabbitMQ:', url.replace(/:[^:@]+@/, ':****@')); // Скрываем пароль в логах
    
    let connection;
    try {
        connection = await amqp.connect(url);
        console.log('✅ Подключение к RabbitMQ установлено');
    } catch (error) {
        console.error('❌ Ошибка подключения к RabbitMQ:', error.message);
        throw error; 
    }
    
    let channel;
    try {
        channel = await connection.createChannel();
        console.log('✅ Channel создан');
    } catch (error) {
        console.error('❌ Ошибка создания Channel:', error.message);
        await connection.close(); // Закрываем соединение при ошибке
        throw error;
    }
    
    // Шаг 4: Проверяем/создаём Queue (если не существует, создастся автоматически)
    try {
        await channel.assertQueue(queueName, {
            durable: true // Очередь сохранится при перезапуске RabbitMQ
        });
        console.log(`✅ Очередь "${queueName}" готова к работе`);
    } catch (error) {
        console.error('❌ Ошибка создания Queue:', error.message);
        await channel.close();
        await connection.close();
        throw error;
    }
    
    // Ограничиваем количество одновременно обрабатываемых сообщений
    await channel.prefetch(1);

    // Шаг 5: Подписываемся на сообщения из очереди
    console.log(`⏳ Ожидаем сообщения из очереди "${queueName}"...`);
    
    channel.consume(queueName, async (message) => {
        if (message === null) {
            // RabbitMQ закрыл соединение
            console.log('❌ Соединение закрыто RabbitMQ');
            return;
        }
        
        try {
            if (isDev && devProcessingDelayMs > 0) {
                await sleep(devProcessingDelayMs);
            }
            // Парсим JSON сообщение
            const content = JSON.parse(message.content.toString());
            console.log('📨 Получено сообщение:', JSON.stringify(content, null, 2));
            
            // TODO: Здесь обрабатываем сообщение
            // Например: отправка email, обработка данных и т.д.
            
            // Подтверждаем обработку сообщения (acknowledge)
            channel.ack(message);
            console.log('✅ Сообщение обработано и подтверждено');
            
        } catch (error) {
            console.error('❌ Ошибка обработки сообщения:', error.message);
            // Отклоняем сообщение (nack) - оно вернётся в очередь
            channel.nack(message, false, true); // false = не множественное, true = вернуть в очередь
        }
    }, {
        noAck: false // Ручное подтверждение (manual acknowledgment)
    });
    
    console.log('✅ Consumer запущен и готов к работе');
}

module.exports = { queueConsumer };