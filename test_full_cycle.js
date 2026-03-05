require('dotenv').config()
const mongoose = require('mongoose')
const { sendToQueue } = require('./utils/rabbitmq')

const CLIENTS_DB_URL = process.env.CLIENTS_DB_URL
const CALL_DB_URL = process.env.CALL_DB_URL
const SMS_DB_URL = process.env.SMS_DB_URL

// Нормализуем номер по аналогии с clientFinder
function normalizePhone(phone) {
  let digits = phone.replace(/[^0-9]/g, '')
  if (digits.startsWith('1') && digits.length === 11) digits = digits.substring(1)
  return digits // 10-цифровой номер
}

async function runTest() {
  // Используем Gregory Hofelich из quiz_submissions
  // Zoom прислал бы: +12487018182
  // В quiz_submissions хранится: +1 (248) 701-8182
  const customerNumber = '+12487018182'
  const normalizedDigits = normalizePhone(customerNumber)
  console.log(`\n📞 Тест для: ${customerNumber}`)
  console.log(`📞 Нормализовано: ${normalizedDigits}\n`)

  // Подключения
  const tvmountConn = await mongoose.createConnection(CLIENTS_DB_URL).asPromise()
  const callConn = await mongoose.createConnection(CALL_DB_URL).asPromise()
  const smsConn = await mongoose.createConnection(SMS_DB_URL).asPromise()
  console.log(`✅ MongoDB подключён (tvmount: ${tvmountConn.name}, prod: ${callConn.name})\n`)

  // --- Шаг 1: Ищем клиента ---
  const ClientModel = tvmountConn.model('Client', new mongoose.Schema({}, { strict: false }), 'clients')
  const client = await ClientModel.findOne({ number: normalizedDigits })
  console.log(`👤 Клиент в clients:`, client ? `id=${client.id}` : '❌ не найден')
  const clientId = client?.id

  // --- Шаг 2: Ищем existingCall и existingSms ---
  const CallModel = callConn.model('Call', new mongoose.Schema({}, { strict: false }), 'call')
  const SmsModel = smsConn.model('Sms', new mongoose.Schema({}, { strict: false }), 'sms')
  
  const [existingCall, existingSms] = await Promise.all([
    clientId ? CallModel.findOne({ client_id: clientId }) : null,
    clientId ? SmsModel.findOne({ clientId: clientId }) : null,
  ])
  console.log(`📞 Существующий Call (production.call):`, existingCall ? `найден (${existingCall.direction})` : '❌ нет')
  console.log(`📱 Существующий SMS (production.sms):`, existingSms ? `найден` : '❌ нет')

  // --- Шаг 3: Ищем заказы в fastQuiz и quiz_submissions ---
  const FastQuizModel = tvmountConn.model('fastQuiz', new mongoose.Schema({}, { strict: false }), 'fastQuiz')
  const QuizModel = tvmountConn.model('quiz_submissions', new mongoose.Schema({}, { strict: false }), 'quiz_submissions')

  // Ищем по оригинальному номеру И по регексу (нормализованные 10 цифр)
  const phoneRegex = new RegExp(normalizedDigits.split('').join('[^0-9]*'))
  
  const [fastQuizOrders, quizOrders] = await Promise.all([
    FastQuizModel.find({ phone: { $regex: phoneRegex } }),
    QuizModel.find({ phone: { $regex: phoneRegex } }),
  ])

  console.log(`\n📋 fastQuiz заказы: ${fastQuizOrders.length}`)
  fastQuizOrders.forEach((o, i) => console.log(`  ${i+1}. ${o.city}, ${o.state} | ${o.name}`))
  
  console.log(`📋 quiz_submissions заказы: ${quizOrders.length}`)
  quizOrders.forEach((o, i) => console.log(`  ${i+1}. ${o.city}, ${o.state} | ${o.name}`))

  const allOrders = [...fastQuizOrders, ...quizOrders]
  const isRepeat = Boolean(existingCall || existingSms || allOrders.length > 0)

  console.log(`\n🔍 ИТОГ: ${isRepeat ? '⚠️ ПОВТОРНЫЙ клиент' : '✅ НОВЫЙ клиент'}`)

  // --- Шаг 4: Публикуем в RabbitMQ если повторный ---
  if (isRepeat) {
    const payload = {
      client_id: "60a12345b12345c12345d123", // Fake ObjectId
      client_numeric_id: 41381, // Real client ID from user's logs
      customer_number: '12487018182',
      orders: [], // button_bot.py ignores this now and queries DB
      direction: 'inbound',
      test: true
    }
    console.log(`\n📤 Публикуем в repeat_call_in:`)
    console.log(JSON.stringify(payload, null, 2))
    await sendToQueue('repeat_call_in', payload)
    console.log(`\n✅ Сообщение отправлено в RabbitMQ!`)
    console.log(`👉 Проверь: https://test.tvmountmaster.ngrok.dev/#/queues`)
  } else {
    console.log(`\n📤 Новый клиент → отправили бы webhook (не делаем в тесте)`)
  }

  await tvmountConn.close()
  await callConn.close()
  await smsConn.close()
  process.exit(0)
}

runTest().catch(e => {
  console.error('❌ Ошибка:', e.message)
  process.exit(1)
})
