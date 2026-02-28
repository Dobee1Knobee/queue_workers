require('dotenv').config()
const amqplib = require('amqplib')

async function test() {
  const host = process.env.NGROK_TCP_HOST || '7.tcp.ngrok.io'
  const port = process.env.NGROK_TCP_PORT || 21850
  const user = process.env.RABBITMQ_USER || 'guest'
  const pass = process.env.RABBITMQ_PASS || 'guest'

  const url = `amqp://${user}:${pass}@${host}:${port}`
  console.log(`🔌 Подключаемся к RabbitMQ: ${host}:${port}`)

  const conn = await amqplib.connect(url)
  const channel = await conn.createChannel()

  const queue = 'repeat_call_in'
  await channel.assertQueue(queue, { durable: true })

  const testMsg = {
    client_id: 99999,
    customer_number: '+1 (248) 701-8182',
    orders: [
      { city: 'Detroit', state: 'Michigan', tvCount: '2tv' },
      { city: 'Dallas', state: 'Texas', tvCount: '1tv' }
    ],
    direction: 'inbound',
    ext: '1001',
    duration: 120,
    zoomData: { test: true }
  }

  const msgBuffer = Buffer.from(JSON.stringify(testMsg))
  channel.sendToQueue(queue, msgBuffer, { persistent: true })

  console.log(`✅ Сообщение опубликовано в очередь "${queue}"`)
  console.log('📦 Данные:', JSON.stringify(testMsg, null, 2))
  console.log('')
  console.log('👉 Проверь на https://test.tvmountmaster.ngrok.dev/#/queues')
  console.log('   Очередь repeat_call_in должна показать 1 сообщение')

  await channel.close()
  await conn.close()
}

test().catch(e => {
  console.error('❌ Ошибка:', e.message)
  process.exit(1)
})
