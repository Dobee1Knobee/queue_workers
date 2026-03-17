# Queue Workers — Полный анализ

## Содержание
1. [Архитектура](#архитектура)
2. [Поток данных](#поток-данных)
3. [Очереди RabbitMQ](#очереди-rabbitmq)
4. [Обработка звонков](#обработка-звонков)
5. [Обработка SMS](#обработка-sms)
6. [Кейсы роутинга](#кейсы-роутинга)
7. [Auto Claim](#auto-claim)
8. [Сменщики (Shift Replacement)](#сменщики-shift-replacement)
9. [Поля данных](#поля-данных)
10. [mini_bot.py](#mini_botpy)

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Zoom Phone                                     │
│                    (webhooks → n8n → RabbitMQ)                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         queue_workers (Node.js)                             │
│  ┌──────────────────┐    ┌──────────────────┐                             │
│  │ app.js            │    │ mini_bot.py      │                             │
│  │ Express server    │    │ Telegram bot     │                             │
│  │ RabbitMQ consumer │    │ Claim handling   │                             │
│  └──────────────────┘    └──────────────────┘                             │
│            │                         │                                       │
│            ▼                         ▼                                       │
│  ┌──────────────────┐    ┌──────────────────┐                             │
│  │ zoomThreadCallIn │    │ send_to_telegram  │                             │
│  │ zoomThreadSmsIn  │    │ claim processing │                             │
│  └──────────────────┘    └──────────────────┘                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MongoDB                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                    │
│  │ production    │  │ tvmount      │  │ tvmount      │                    │
│  │ calls, sms    │  │ clients      │  │ users        │                    │
│  └──────────────┘  │ orders       │  │ filled_forms │                    │
│                    │ filled_forms │  └──────────────┘                    │
│                    └──────────────┘                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Поток данных

### Входящие звонки (call_in_test)

```
Zoom webhook → n8n → call_in_test → queue_workers/app.js
                                            │
                                            ▼
                                    zoomThreadCallIn.js
                                            │
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
            repeat_call_in          new_inbound_lead           (autoClaim)
```

### Входящие SMS (sms_in_test)

```
Zoom webhook → n8n → sms_in_test → queue_workers/app.js
                                           │
                                           ▼
                                   zoomThreadSmsIn.js
                                           │
                    ┌────────────────────────┼─────────────────────────┐
                    ▼                        ▼                         ▼
            repeat_sms_in            new_inbound_lead           (autoClaim)
```

---

## Очереди RabbitMQ

| Очередь | Направление | Описание |
|---------|-------------|----------|
| `call_in_test` | Входящая | Звонки от Zoom (тестовая) |
| `sms_in_test` | Входящая | SMS от Zoom (тестовая) |
| `repeat_call_in` | Исходящая | Пропущенные и повторные звонки |
| `repeat_sms_in` | Исходящая | Повторные SMS |
| `new_inbound_lead` | Исходящая | Новые лиды (ответили / новый SMS) |
| `auto_claim_in` | Входящая | Запросы на автоклейм |
| `personal_claimed_leads` | Исходящая | События при claim (для статистики) |

---

## Обработка звонков

### zoomThreadCallIn.js

#### 1. Извлечение данных из webhook
```javascript
direction: 'inbound' | 'outbound'
caller_number: номер клиента
callee_number: номер (экстеншен или номер менеджера)
result: 'no answer' | 'connected' | 'busy' | ...
duration: продолжительность в секундах
```

#### 2. Определение номера клиента
- Для inbound: `caller_number` (звонивший)
- Для outbound: `callee_number` (кому звонили)

#### 3. Определение экстеншена
Используется `callee_extension_number` или определяется по `callee_number` если это extension.

#### 4. Поиск ответственного менеджера
```javascript
// Поиск по extension_number
responsibleManager = await UsersModel.findOne({
    extension_number: extForLookup
})

// Или по Zoom user ID
if (!responsibleManager) {
    responsibleManager = await UsersModel.findOne({
        id: internalPartyId
    })
}
```

#### 5. Проверка на экстеншен
Если номер клиента ≤6 цифр — это экстеншен, а не телефон клиента → **пропускаем**.

#### 6. Определение типа звонка

```javascript
const isMissedInboundCall = 
    direction === 'inbound' && 
    MISSED_CALL_RESULTS.has(result)  // 'no answer', 'busy', 'failed', 'missed', 'voicemail'

const isRepeatCall = 
    hasAnyOrder &&           // есть заказы
    !hasRecentOrder &&      // нет заказов за последние 14 дней
    direction === 'inbound'

const isAnsweredInbound = 
    direction === 'inbound' &&
    !MISSED_CALL_RESULTS.has(result) &&  // ответили
    responsibleManager &&                 // менеджер найден
    !hasRecentOrder                      // новый клиент (нет заказов 14 дней)
```

---

## Обработка SMS

### zoomThreadSmsIn.js

#### 1. Извлечение данных
```javascript
smsType: 'incoming' | 'outgoing'
phoneNumber: номер клиента (sender для входящих)
message: текст сообщения
to_members: кому отправлено (массив с phone_number)
```

#### 2. Поиск менеджера для SMS
Для входящих SMS менеджер определяется по `to_members[0].phone_number`:
```javascript
manager = await UsersModel.findOne({
    'phone_numbers.number': normalizedManagerPhone
})
```

#### 3. Определение типа SMS

```javascript
const isRepeatSms = 
    hasAnyOrder &&           // есть заказы
    !hasRecentOrder &&      // нет заказов за последние 14 дней
    smsType === 'incoming'

const isNewInboundSms = 
    smsType === 'incoming' &&
    !hasRecentOrder &&       // новый клиент
    manager && manager.at    // менеджер найден
```

---

## Кейсы роутинга

### 1. Пропущенный звонок (No Answer)

**Когда:** `isMissedInboundCall = true`

**Роутинг:**
```
         ┌─────────────────────────────────────────────────────┐
         │  Клиент заклеймен ≤14 дней назад?                   │
         └─────────────────────────────────────────────────────┘
                          │                   │
                         ДА                  НЕТ
                          ▼                   ▼
              DM менеджеру          Группа + Claim кнопка
              (REDIRECTED)          (показывается Owner)
```

**Очередь:** `repeat_call_in`  
**lead_type:** `missed_call`

---

### 2. Повторный звонок (>14 дней без заказов)

**Когда:** `isRepeatCall = true`

**Роутинг:**
```
Всегда → Группа + Claim кнопка
```

**Очередь:** `repeat_call_in`  
**lead_type:** `repeat_call`

---

### 3. Входящий звонок — ответили

**Когда:** `isAnsweredInbound = true`

**Роутинг:**
```
Всегда → DM менеджеру (кто ответил)
```

**Очередь:** `new_inbound_lead`  
**lead_type:** `answered_call`

---

### 4. Новый SMS (без заказов 14 дней)

**Когда:** `isNewInboundSms = true`

**Роутинг:**
```
Всегда → DM менеджеру (по экстеншену)
```

**Очередь:** `new_inbound_lead`  
**lead_type:** `inbound_sms`

---

### 5. Повторный SMS

**Когда:** `isRepeatSms = true`

**Роутинг:**
```
         ┌─────────────────────────────────────────────────────┐
         │  Клиент заклеймен ≤14 дней назад?                   │
         └─────────────────────────────────────────────────────┘
                          │                   │
                         ДА                  НЕТ
                          ▼                   ▼
              DM менеджеру          Группа + Claim кнопка
              (REDIRECTED)          
```

**Очередь:** `repeat_sms_in`  
**lead_type:** `repeat_sms`

---

## Auto Claim

### Как работает

Auto Claim — это механизм автоматического взятия заявок для **исходящих** звонков/SMS от менеджеров.

### Переменные окружения

```env
AUTO_CLAIM_ENABLED=true      # Включить автоклейм (реальное взятие)
AUTO_CLAIM_SHADOW=true       # Только логировать, не брать
AUTO_CLAIM_SEND_DM=false     # Отправлять DM менеджеру
AUTO_CLAIM_ADMIN=ilyasorr    # Перенаправить все DM в группу
```

### Логика

1. Исходящий звонок/SMS от менеджера
2. Ищется открытая форма (filled_forms) для этого клиента:
   - `cpmn_name`: 'missed_call', 'repeat_call', 'repeat_sms'
   - `manager_at`: пустой (не заклеймен)
   - `date`: за последние N дней
3. Если форма найдена → автоматически ставится `manager_at` = тот, кто звонил

### Фильтры

- **Минимальная длительность звонка:** 15 секунд (настраивается)
- **Только исходящие:** `direction === 'outbound'`
- **Только открытые формы:** `manager_at` пустой

---

## Сменщики (Shift Replacement)

### Конфигурация

Файл: `config/shiftReplacements.js`

```javascript
module.exports = {
    maestro_dave: 'intheiceage',
    jaherrjarus: 'stealthespirit',
    alexeyblau: 'millerbeer',
    murmurhamdy: 'SSales2025',
    vainshtein: 'WaveyG_21',
    vlrsvlv: 'tralalerodon',
    Taddy_BamBam: 'kirillos8888',
    arsen2243: 'shawtypaid',
}
```

### Логика

```javascript
// В autoClaim.js
if (managerDoc.working === false) {
    // Ищем сменщика
    const replacementAt = SHIFT_REPLACEMENTS[managerDoc.at]
    if (replacementAt) {
        // Используем сменщика
        replacementDoc = await findUserByAt(replacementAt)
    }
}
```

**Когда применяется:**
- Ответственный менеджер имеет `working: false`
- В конфиге есть запись для этого менеджера

---

## Поля данных

### В сообщениях Telegram

| Поле | Описание | Пример |
|------|----------|--------|
| `Клиент: #c{id}` | ID клиента | `Клиент: #c100932` |
| `Phone:` | Номер телефона | `Phone: +14694264761` |
| `📱 На экстеншн:` | Экстеншен | `📱 На экстеншн: 1039` |
| `Статус:` | Результат звонка | `Статус: No Answer` |
| `👤 Owner:` | Ответственный менеджер | `👤 Owner: @jaherrjarus` |
| `👥 Команда:` | Команда (A, B, C...) | `👥 Команда: B` |
| `📅` | Дата/время | `📅 2026-03-15T20:48:00Z` |
| `📋 Прошлые заказы:` | Список заказов | `📋 Прошлые заказы: 📦 OA0103296` |
| `🔄 [REDIRECTED from @...]` | Перенаправление | `🔄 [REDIRECTED from @jaherrjarus]` |

### В RabbitMQ payload

| Поле | Описание |
|------|----------|
| `client_id` | ID клиента в MongoDB |
| `client_numeric_id` | Числовой ID для кнопки |
| `customer_number` | Номер телефона клиента |
| `lead_type` | 'missed_call', 'repeat_call', 'answered_call', 'inbound_sms', 'repeat_sms' |
| `team` | Команда (A, B, C, H, W) |
| `manager_at` | Telegram username менеджера (@...) |
| `manager_id` | ID менеджера |
| `ext` | Экстеншен |
| `direction` | 'inbound' или 'outbound' |
| `result` | Результат звонка |
| `orders` | Массив заказов клиента |

---

## mini_bot.py

### Функции

| Функция | Описание |
|---------|----------|
| `zoom_repeat_call_in()` | Обработка пропущенных/повторных звонков |
| `zoom_repeat_sms_in()` | Обработка повторных SMS |
| `zoom_new_inbound_lead()` | Обработка новых лидов (ответили / новый SMS) |
| `handle_claim()` | Обработка нажатия кнопки Claim |
| `apply_claim_to_form()` | Применение claim к форме |
| `find_claimed_manager_for_client()` | Поиск менеджера, который брал клиента за 14 дней |

### Claim процесс

1. Пользователь нажимает кнопку "Claim"
2. Ищется форма по `client_id` и `chat_message_id`
3. Проверяется, что форма не заклеймена (`manager_at` пустой)
4. Обновляется форма:
   - `manager_at` = username нажавшего
   - `team` = команда
   - `manager_id` = ID менеджера
5. Редактируется сообщение в группе — убирается кнопка, добавляется "claimed by @..."
6. Отправляется в `personal_claimed_leads` для статистики

### ROUTE_REDIRECTED (AUTO_CLAIM_ADMIN)

Когда `AUTO_CLAIM_ADMIN` установлен:
- Все DM перенаправляются в группу `TELEGRAM_CHAT_ID`
- Добавляется пометка "🔄 [REDIRECTED from @...]"

---

## Дедупликация

Чтобы не отправлять много уведомлений для одного клиента:

```javascript
const recentRepeatClients = new Map()
const REPEAT_DEDUP_MS = 3 * 60 * 1000 // 3 минуты

// Перед отправкой
const dedupKey = `repeat_call_${clientNumericId}`
const lastSent = recentRepeatClients.get(dedupKey)
if (lastSent && Date.now() - lastSent < REPEAT_DEDUP_MS) {
    // Пропускаем
    return
}
recentRepeatClients.set(dedupKey, Date.now())
```

---

## Базы данных

| База | Коллекции | Назначение |
|------|-----------|------------|
| `production` | `calls`, `sms` | Логи звонков и SMS от Zoom |
| `tvmount` | `clients` | Клиенты |
| `tvmount` | `orders` | Заказы |
| `tvmount` | `users` | Менеджеры |
| `tvmount` | `filled_forms` | Заявки/формы |

### Подключения в коде

```javascript
// production (звонки)
CALL_DB_URL = mongodb+srv://.../production

// production (SMS)  
SMS_DB_URL = mongodb+srv://.../production

// tvmount
CLIENTS_DB_URL = mongodb+srv://.../tvmount
TVMOUNT_DB_URL = mongodb+srv://.../tvmount  // приоритетнее
```
