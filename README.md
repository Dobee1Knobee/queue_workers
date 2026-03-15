# Queue Workers

Автоматизация для TV Mount — обработка звонков/SMS из Zoom Phone, авто-клэйм лидов, Telegram бот.

## Быстрый старт

```bash
cd queue_workers
docker-compose up -d --build
docker-compose logs -f
```

## Архитектура

```
Zoom Phone Webhook → n8n → RabbitMQ → queue_workers (Node.js)
                                           ↓
                                    mini_bot (Python/Telegram)
```

## Очереди RabbitMQ

| Очередь | Назначение |
|---------|------------|
| `call_in_test` | Входящие звонки (дубликат от button_bot) |
| `sms_in_test` | Входящие SMS (дубликат от button_bot) |
| `repeat_call_in` | Пропущенные/повторные звонки → Telegram группа |
| `repeat_sms_in` | Повторные SMS → Telegram группа |
| `auto_claim_in` | Авто-клэйм существующих open leads |
| `new_inbound_lead` | Новые входящие SMS/звонки от новых клиентов → DM менеджеру |

## Переменные окружения

```env
# RabbitMQ
NGROK_TCP_HOST=7.tcp.ngrok.io
NGROK_TCP_PORT=21850
RABBITMQ_USER=guest
RABBITMQ_PASS=guest

# MongoDB
CALL_DB_URL=mongodb+srv://...
SMS_DB_URL=mongodb+srv://...
CLIENTS_DB_URL=mongodb+srv://...

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=-1234567890

# Auto-claim
AUTO_CLAIM_ENABLED=true
AUTO_CLAIM_SHADOW=true
AUTO_CLAIM_SEND_DM=false
AUTO_CLAIM_ADMIN=ilyasorr  # Пересылать все DM этому юзеру
```

## Логика лидов

### 1. Новый клиент (нет заказов за 2 недели)
- **SMS** → ищет менеджера по `to_members[0].phone_number` → `new_inbound_lead` → DM
- **Звонок отвечен** → ищет по `callee_number` (extension) → `new_inbound_lead` → DM

### 2. Повторный клиент (есть заказы старше 2 недель)
- Проверяет `filled_forms` — был ли claim за последние 14 дней
- **Если ДА** → DM менеджеру напрямую
- **Если НЕТ** → группа с кнопкой "Claim"

### 3. Пропущенный звонок
- Всегда → группа с кнопкой "Claim"

### 4. Авто-клэйм
- Когда менеджер сам отвечает на звонок/SMS существующего open lead
- Обновляет `filled_forms.manager_at`

## Shift Replacement

Если менеджер `working=false`, лид уходит сменщику:

```javascript
// config/shiftReplacements.js
{
  'maestro_dave': 'intheiceage',
  'jaherrjarus': 'stealthespirit',
  // ...
}
```

## API

### Endpoints

- `GET /health` — health check
- `POST /internal/telegram/events` — webhook от Telegram Gateway

## Разработка

```bash
# Локально (без Docker)
npm install
npm start

# В другом терминале
python mini_bot.py

# Очистить очереди
node purge_queues.js
```

## Файлы

- `app.js` — Express сервер, RabbitMQ консьюмеры
- `mini_bot.py` — Telegram бот
- `utils/zoom/zoomThreadCallIn.js` — обработка звонков
- `utils/zoom/zoomThreadSmsIn.js` — обработка SMS
- `utils/autoClaim.js` — логика авто-клэйма
- `config/shiftReplacements.js` — карта сменщиков