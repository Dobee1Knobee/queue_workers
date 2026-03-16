# Queue Workers — Lead Routing System

TV Mount business automation: Zoom Phone → RabbitMQ → MongoDB → Telegram

## Architecture Overview

```
┌─────────────────┐
│  Zoom Phone     │
│  Webhooks       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│  app.js         │────▶│  RabbitMQ       │
│  (Express:8000) │     │  Queues         │
└─────────────────┘     └────────┬────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ zoomThreadCallIn│     │ zoomThreadSmsIn │     │   mini_bot.py   │
│  (Node.js)      │     │  (Node.js)      │     │   (Python)      │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 ▼
                        ┌─────────────────┐
                        │  MongoDB        │
                        │  - tvmount      │
                        │  - production   │
                        └─────────────────┘
```

## Lead Routing Flow

### Inbound Call

```
                         ┌─────────────────────┐
                         │ Inbound Call Received│
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ Find Client by Phone│
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ Check Claimed Manager│
                         │ (filled_forms, <2w) │
                         └──────────┬──────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
            ┌───────────┐   ┌───────────┐   ┌───────────┐
            │ Has Claim │   │ No Claim  │   │ No Claim  │
            │ Manager   │   │ Missed    │   │ Answered  │
            └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
                  │               │               │
                  ▼               ▼               ▼
            ┌───────────┐   ┌───────────┐   ┌───────────┐
            │ DM to     │   │ Group +   │   │ DM to     │
            │ Manager   │   │ Claim     │   │ Manager   │
            │ (direct)  │   │ Button    │   │ (auto)    │
            └───────────┘   └───────────┘   └───────────┘
```

### Inbound SMS

```
                         ┌─────────────────────┐
                         │ Inbound SMS Received│
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ Find Client by Phone│
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ Check Claimed Manager│
                         │ (filled_forms, <2w) │
                         └──────────┬──────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
            ┌───────────────┐               ┌───────────────┐
            │ Has Claimed   │               │ No Claim      │
            │ Manager       │               │               │
            └───────┬───────┘               └───────┬───────┘
                    │                               │
                    ▼                       ┌───────┴───────┐
            ┌───────────────┐               │               │
            │ DM to Manager │               ▼               ▼
            │ (with SMS text)│      ┌───────────────┐ ┌───────────────┐
            └───────────────┘      │ Active Client │ │ New/Repeat    │
                                   │ (order <2w)   │ │ Client        │
                                   └───────┬───────┘ └───────┬───────┘
                                           │                 │
                                           ▼                 ▼
                                   ┌───────────────┐ ┌───────────────┐
                                   │ DM to Manager │ │ Group + Claim │
                                   │               │ │ Button        │
                                   └───────────────┘ └───────────────┘
```

### Auto-Claim (Outbound Call/SMS)

```
                         ┌─────────────────────┐
                         │ Manager calls/SMS   │
                         │ client back         │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ Find Open Lead      │
                         │ (filled_forms,      │
                         │  manager_at = null) │
                         └──────────┬──────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
            ┌───────────┐   ┌───────────┐   ┌───────────┐
            │ Lead Found│   │ Call ≥15s │   │ No Lead   │
            │           │   │ OR Answer │   │           │
            └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
                  │               │               │
                  └───────────────┼───────────────┘
                                  │
                                  ▼
                         ┌─────────────────────┐
                         │ Update filled_forms │
                         │ - manager_at        │
                         │ - manager_id        │
                         │ - team              │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ Edit Group Message  │
                         │ Remove Claim Button │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ Send DM to Manager  │
                         │ with client details │
                         └─────────────────────┘
```

## RabbitMQ Queues

| Queue | Producer | Consumer | Purpose |
|-------|----------|----------|---------|
| `call_in_test` | app.js | zoomThreadCallIn | Inbound calls from Zoom |
| `sms_in_test` | app.js | zoomThreadSmsIn | Inbound SMS from Zoom |
| `repeat_call_in` | zoomThreadCallIn | mini_bot.py | Missed calls → group |
| `repeat_sms_in` | zoomThreadSmsIn | mini_bot.py | New client SMS → group |
| `new_inbound_lead` | zoomThreadCallIn/SmsIn | mini_bot.py | Direct DM to manager |
| `auto_claim_in` | autoClaim.js | mini_bot.py | Auto-claim triggers |
| `personal_claimed_leads` | mini_bot.py | button_bot.py | Claim events |

## MongoDB Collections

### tvmount database

| Collection | Purpose |
|------------|---------|
| `clients` | Client records with phone numbers |
| `orders` | Order history (ObjectId-based dates) |
| `users` | Managers with `at`, `chat_id`, `working`, `extension_number` |
| `filled_forms` | Leads with `manager_at`, `client_id`, `cpmn_name` |
| `teams` | Team configurations |

### production database

| Collection | Purpose |
|------------|---------|
| `calls` | Call log records |
| `sms` | SMS log records |

## Environment Variables

```env
# RabbitMQ
NGROK_TCP_HOST=7.tcp.ngrok.io
NGROK_TCP_PORT=21850
RABBITMQ_USER=guest
RABBITMQ_PASS=guest

# MongoDB
TVMOUNT_DB_URL=mongodb+srv://...
CLIENTS_DB_URL=mongodb+srv://...
CALL_DB_URL=mongodb+srv://...
SMS_DB_URL=mongodb+srv://...

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=-5123319543

# Auto-Claim
AUTO_CLAIM_ENABLED=true
AUTO_CLAIM_SHADOW=true
AUTO_CLAIM_SEND_DM=false
AUTO_CLAIM_ADMIN=ilyasorr

# Telegram Gateway (optional)
TELEGRAM_GATEWAY_ENABLED=false
TELEGRAM_GATEWAY_URL=https://telegram.it.tvmountmaster.com
TELEGRAM_GATEWAY_API_KEY=...
TELEGRAM_GATEWAY_API_SECRET=...
```

## Message Formats

### Group Message (with Claim button)

```
☎️ Пропущенный звонок
🟡 ПОВТОРНЫЙ КЛИЕНТ
Клиент: #c41298

📋 Прошлые заказы:
  📦 NB2208001
```

**NO phone number** (privacy)

### Direct Message (to manager)

```
💬 Входящее SMS
🟢 АКТИВНЫЙ КЛИЕНТ
Клиент: #c41298
Phone: +12125551234

💬 Текст:
Привет, хочу заказать монтаж

📋 Прошлые заказы:
  📦 NB2208001
```

**INCLUDES phone number**

## Shift Replacements

When manager is off (`working: false`), route to replacement:

```javascript
// config/shiftReplacements.js
module.exports = {
  'maestro_dave': 'intheiceage',
  'jaherrjarus': 'stealthespirit',
  // ...
}
```

## Client Status Labels

| Status | Condition | Emoji |
|--------|-----------|-------|
| Active Client | Order within 14 days | 🟢 |
| Repeat Client | Any past order | 🟡 |
| New Client | No orders | 🔵 |

## Claim Sources

| Source | Trigger |
|--------|---------|
| `manual` | User pressed Claim button |
| `auto` | Auto-claim from outgoing call/SMS |
| `auto_inbound` | Answered inbound call |
| `delegated` | Shift replacement |

## Key Files

| File | Purpose |
|------|---------|
| `app.js` | Express server, Zoom webhooks |
| `utils/zoom/zoomThreadCallIn.js` | Call processing logic |
| `utils/zoom/zoomThreadSmsIn.js` | SMS processing logic |
| `utils/autoClaim.js` | Auto-claim triggers |
| `utils/gatewayFlow.js` | Telegram gateway integration |
| `mini_bot.py` | Telegram bot, queue consumer |
| `config/shiftReplacements.js` | Shift replacement mapping |

## Testing

```bash
# Start queue_workers
cd queue_workers
npm start

# Start mini_bot (separate terminal)
python mini_bot.py

# Test webhook
curl -X POST http://localhost:8000/webhook/call \
  -H "Content-Type: application/json" \
  -d @test_payloads/call_inbound_missed.json
```

## Deployment

```bash
# Dev deployment
git tag dev-v1.2.0
git push origin main --tags

# GitLab CI/CD deploys on tags matching:
# - dev-* (development)
# - prod-* (production)
```

## Troubleshooting

### Button still shows after auto-claim

Check:
1. `auto_claim_in` queue is being consumed
2. Manager's phone is in `users.phone_numbers`
3. Form has correct markers (`team_: 'test_mini_bot'`)

### Wrong manager gets DM

Check:
1. `filled_forms.manager_at` is correct
2. `users.working` field is `true` for active manager
3. `SHIFT_REPLACEMENTS` mapping is correct

### Duplicate messages

Deduplication window is 3 minutes (`REPEAT_DEDUP_MS`). Race conditions can cause max 2 messages.

## Future Improvements

- [ ] Redis-based deduplication (atomic)
- [ ] Webhook retry handling
- [ ] Manager availability calendar
- [ ] Multi-phone manager support
