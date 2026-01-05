require('dotenv').config()
const { clientFinder, createNewClient } = require('./utils/clientFinder')

// Тестовый номер телефона - замените на реальный из вашей базы
const testPhoneNumber = '24565374645'

async function testClientFinder() {
	try {
		console.log(`🔍 Ищем клиента с номером: ${testPhoneNumber}`)

		const client = await clientFinder(testPhoneNumber)

		if (client) {
			console.log('✅ Клиент найден:')
			console.log(JSON.stringify(client, null, 2))
		} else {
			const newClient = await createNewClient(testPhoneNumber)
			console.log('❌ Клиент не найден')
			console.log(JSON.stringify(newClient, null, 2))
		}

		// Закрываем подключение
		process.exit(0)
	} catch (error) {
		console.error('❌ Ошибка при поиске клиента:', error.message)
		process.exit(1)
	}
}

testClientFinder()
