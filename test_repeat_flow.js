/**
 * Уровень 2: Полный цикл repeat_call_in
 * Ищет клиента с заказами за 2 недели → шлёт в RabbitMQ → bots-1 подхватит и отправит в Telegram
 *
 * Запуск: node test_repeat_flow.js [номер_телефона]
 * Пример: node test_repeat_flow.js +12487018182
 *
 * Если номер не указан — сам найдёт клиента с недавним заказом
 */
require('dotenv').config()
const mongoose = require('mongoose')
const { clientFinder } = require('./utils/clientFinder')
const { sendToQueue } = require('./utils/rabbitmq')

const TVMOUNT_DB_URL = process.env.TVMOUNT_DB_URL || process.env.CLIENTS_DB_URL

async function findClientWithRecentOrder(tvmountConn) {
  const OrdersModel = tvmountConn.model('orders', new mongoose.Schema({}, { strict: false }), 'orders')
  const ClientModel = tvmountConn.model('clients', new mongoose.Schema({}, { strict: false }), 'clients')

  const twoWeeksAgo = new Date()
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)
  const twoWeeksAgoId = new mongoose.Types.ObjectId(
    Math.floor(twoWeeksAgo.getTime() / 1000).toString(16) + '0000000000000000'
  )

  // Находим последний заказ за 2 недели
  const recentOrder = await OrdersModel.findOne({
    _id: { $gte: twoWeeksAgoId },
    client_id: { $exists: true, $ne: null }
  }).sort({ _id: -1 })

  if (!recentOrder) {
    console.log('❌ Не нашли заказов за последние 2 недели')
    return null
  }

  console.log(`📦 Нашли заказ: ${recentOrder.order_id || '(без order_id)'}, client_id: ${recentOrder.client_id}`)

  // Находим клиента
  const client = await ClientModel.findOne({ id: recentOrder.client_id })
  if (!client) {
    console.log(`❌ Клиент с id=${recentOrder.client_id} не найден в clients`)
    return null
  }

  console.log(`👤 Клиент: number=${client.number}`)
  return { client, phone: client.number }
}

async function run() {
  const tvmountConn = await mongoose.createConnection(TVMOUNT_DB_URL).asPromise()
  console.log(`✅ Подключён к ${tvmountConn.name}\n`)

  let phone = process.argv[2]

  // Если номер не указан — ищем клиента с недавним заказом
  if (!phone) {
    console.log('📌 Номер не указан, ищу клиента с заказом за 2 недели...\n')
    const result = await findClientWithRecentOrder(tvmountConn)
    if (!result) {
      await tvmountConn.close()
      process.exit(1)
    }
    phone = result.phone
  }

  console.log(`\n📞 Тестируем: ${phone}\n`)

  // 1. Ищем клиента (как в zoomThreadCallIn.js)
  const client = await clientFinder(phone)
  if (!client) {
    console.log('❌ Клиент не найден')
    await tvmountConn.close()
    process.exit(1)
  }

  const clientId = client.id
  const clientNumericId = Number(client.toObject().id) || client.toObject().id
  console.log(`👤 Клиент: id=${clientId}, numericId=${clientNumericId}`)

  // 2. Ищем заказы за 2 недели
  const OrdersModel = tvmountConn.models.orders || tvmountConn.model('orders', new mongoose.Schema({}, { strict: false }), 'orders')

  const twoWeeksAgo = new Date()
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)
  const twoWeeksAgoId = new mongoose.Types.ObjectId(
    Math.floor(twoWeeksAgo.getTime() / 1000).toString(16) + '0000000000000000'
  )

  const recentOrders = await OrdersModel.find({
    client_id: clientNumericId,
    _id: { $gte: twoWeeksAgoId }
  }).sort({ _id: -1 }).limit(10)

  console.log(`📦 Заказов за 2 недели: ${recentOrders.length}`)
  recentOrders.forEach((o, i) => {
    const date = o._id.getTimestamp().toISOString().slice(0, 10)
    console.log(`  ${i + 1}. ${o.order_id || '(без order_id)'} | дата: ${date}`)
  })

  if (recentOrders.length === 0) {
    console.log('\n✅ Клиент НОВЫЙ — repeat_call_in не нужен')
    await tvmountConn.close()
    process.exit(0)
  }

  // 3. Шлём в RabbitMQ (как в zoomThreadCallIn.js)
  const payload = {
    client_id: clientId,
    client_numeric_id: clientNumericId,
    customer_number: phone,
    orders: recentOrders.map(o => o.toObject()),
    direction: 'inbound',
    ext: '',
    duration: 0,
    callEnd: new Date(),
    test: true
  }

  const queueName = process.env.TEST_MODE ? 'repeat_call_in_test' : 'repeat_call_in'
  console.log(`\n📤 Отправляю в RabbitMQ очередь "${queueName}"...`)
  await sendToQueue(queueName, payload)
  console.log(`✅ Отправлено! ${process.env.TEST_MODE ? 'mini bot' : 'bots-1'} должен подхватить и отправить в Telegram\n`)

  await tvmountConn.close()
  // Даём RabbitMQ время отправить
  setTimeout(() => process.exit(0), 2000)
}

run().catch(e => { console.error('❌', e.message); process.exit(1) })
