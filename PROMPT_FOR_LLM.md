# Prompt для продолжения работы над HHN Queue Workers

## Контекст

HHN (Handy Help Now) — система автоматизации для TV mounting бизнеса. Обрабатывает звонки и SMS из Zoom Phone, создаёт лиды в Telegram, поддерживает авто-клэйм и роутинг менеджеров.

## Репозиторий

```
/Users/iliasorokin/MY SHIT/HHN/queue_workers/
```

## Что нужно сделать

Развернуть и протестировать систему:

1. Запустить `docker-compose up -d --build`
2. Проверить логи: `docker-compose logs -f`
3. Убедиться что лиды корректно роутятся:
   - Новые клиенты → DM менеджеру
   - Повторные с claim за 14 дней → DM тому же менеджеру
   - Повторные без claim → группа с кнопкой Claim

## Архитектура

```
Zoom Phone → n8n → RabbitMQ (test queues) → queue_workers (Node.js)
                                                          ↓
                                                    mini_bot (Python/Telegram)
```

## Очереди RabbitMQ

| Очередь            | Назначение                            |
| ------------------ | ------------------------------------- |
| `call_in_test`     | Входящие звонки                       |
| `sms_in_test`      | Входящие SMS                          |
| `repeat_call_in`   | Пропущенные/повторные звонки → группа |
| `repeat_sms_in`    | Повторные SMS → группа                |
| `new_inbound_lead` | Новые входящие от новых клиентов → DM |
| `auto_claim_in`    | Авто-клэйм существующих open leads    |

## Ключевые файлы

- `app.js` — Express + RabbitMQ консьюмеры
- `mini_bot.py` — Telegram бот (500+ строк)
- `utils/zoom/zoomThreadCallIn.js` — обработка звонков
- `utils/zoom/zoomThreadSmsIn.js` — обработка SMS
- `utils/autoClaim.js` — логика авто-клэйма
- `config/shiftReplacements.js` — карта сменщиков

## Переменные .env (уже настроены)

```env
AUTO_CLAIM_ENABLED=true
AUTO_CLAIM_SHADOW=true
AUTO_CLAIM_SEND_DM=false
AUTO_CLAIM_ADMIN=ilyasorr
```

## Логика роутинга

### 1. Новый клиент (нет заказов за 2 недели)

- **Входящий SMS**: ищет менеджера по `to_members[0].phone_number` → `new_inbound_lead` → DM
- **Звонок отвечен**: ищет по `callee_number` (extension) → `new_inbound_lead` → DM

### 2. Повторный клиент

- Проверяет `filled_forms` — был ли claim за 14 дней
- **Если ДА**: DM менеджеру напрямую (без группы)
- **Если НЕТ**: группа с кнопкой "Claim"

### 3. Пропущенный звонок

- Всегда → группа с кнопкой "Claim"

### 4. Авто-клэйм

- Когда менеджер сам отвечает на open lead → обновляет `filled_forms.manager_at`

### 5. Shift replacement

- Если менеджер `working=false` → лид уходит сменщику из `config/shiftReplacements.js`

## Тестирование

Сделай тестовый звонок или SMS и проверь:

1. Лид попадает в правильную очередь
2. DM приходит нужному менеджеру (или ADMIN если включено)
3. Логи корректные

## Возможные проблемы

- Если RabbitMQ недоступен — запусти ngrok туннель
- Проверь что MongoDB доступен
- Лиды могут не находить менеджера если не совпадает phone/extension

## Документация

Полная документация в `queue_workers/README.md`
