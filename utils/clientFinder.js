require('dotenv').config()
const mongoose = require('mongoose')
const { clientSchema } = require('../models/client_model')

let tvmountConnection = null
let ClientModel = null

const getTvmountConnection = async () => {
	let dbUrl = process.env.CLIENTS_DB_URL

	// Если подключение уже существует и активно, возвращаем его
	if (tvmountConnection && tvmountConnection.readyState === 1 && ClientModel) {
		return ClientModel
	}

	// Создаем новое подключение
	tvmountConnection = mongoose.createConnection(dbUrl, {
		bufferCommands: false,
		maxPoolSize: 10,
	})

	// Ждем, пока подключение установится
	await new Promise((resolve, reject) => {
		if (tvmountConnection.readyState === 1) {
			console.log('✅ Connected to tvmount database')
			console.log(`Database name: ${tvmountConnection.name}`)
			resolve()
		} else {
			tvmountConnection.once('connected', () => {
				console.log('✅ Connected to tvmount database')
				console.log(`Database name: ${tvmountConnection.name}`)
				resolve()
			})
			tvmountConnection.once('error', err => {
				console.error('❌ Error connecting to tvmount database:', err.message)
				reject(err)
			})
		}
	})

	// Создаем модель Client на этом подключении
	ClientModel = tvmountConnection.model('Client', clientSchema, 'clients')

	return ClientModel
}

const clientFinder = async phoneNumber => {
	// Удаляем все нецифровые символы
	let phone = phoneNumber.replace(/[^0-9]/g, '')
	// Удаляем первую единицу, если номер начинается с неё
	if (phone.startsWith('1')) {
		phone = phone.substring(1)
	}
	const clientModel = await getTvmountConnection()
	const client = await clientModel.findOne({ number: phone })
	return client
}

const createNewClient = async phoneNumber => {
	// Удаляем все нецифровые символы
	let phone = phoneNumber.replace(/[^0-9]/g, '')
	// Удаляем первую единицу, если номер начинается с неё
	if (phone.startsWith('1')) {
		phone = phone.substring(1)
	}

	const clientModel = await getTvmountConnection()

	// Находим последнего клиента (с максимальным id) для генерации нового id
	const lastClient = await clientModel.findOne().sort({ _id: -1 }).limit(1)

	console.log(
		'🔍 Последний клиент в базе:',
		lastClient ? `id=${lastClient.id}` : 'не найден (база пустая)'
	)

	// Безопасно вычисляем новый id
	let newId = 1
	if (
		lastClient &&
		typeof lastClient.id === 'number' &&
		!isNaN(lastClient.id)
	) {
		newId = lastClient.id + 1
		console.log(`📊 Новый id будет: ${lastClient.id} + 1 = ${newId}`)
	} else {
		console.log('📊 База пустая или lastClient.id не число, используем id = 1')
	}

	// Создаем нового клиента
	const newClient = await clientModel.create({
		number: [phone], // number - это массив, используем очищенный номер
		id: newId,
	})

	return newClient
}
module.exports = { clientFinder, createNewClient }
