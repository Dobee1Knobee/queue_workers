import asyncio
import json
import os
import re
import aio_pika
from datetime import datetime, timezone, timedelta
from pymongo import MongoClient
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ApplicationBuilder, CallbackQueryHandler, ContextTypes

from dotenv import load_dotenv
load_dotenv()

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
CHAT_ID = int(os.environ["TELEGRAM_CHAT_ID"])

# RabbitMQ (shared with queue_workers)
RABBIT_HOST = os.environ.get("NGROK_TCP_HOST", "7.tcp.ngrok.io")
RABBIT_PORT = int(os.environ.get("NGROK_TCP_PORT", "21850"))
RABBIT_USER = os.environ.get("RABBITMQ_USER", "guest")
RABBIT_PASS = os.environ.get("RABBITMQ_PASS", "guest")

# MongoDB
MONGO_URI = os.environ.get("MONGO_URI", os.environ.get("CLIENTS_DB_URL", ""))
filled_forms_db = None
clients_db = None
users_db = None
orders_db = None 

# Will be set after Application is built
app = None


def connect_mongo():
    global filled_forms_db, clients_db, users_db, orders_db
    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        client.admin.command("ping")
        db = client["tvmount"]
    except Exception as e:
        print(f"⚠️  mongodb+srv failed ({e}), trying direct connection...")
        # Fallback: resolve SRV manually or use direct hosts
        client = MongoClient(
            "mongodb://Devteam:779DzaWHURdNgjJD@cluster0-shard-00-00.qsf14.mongodb.net:27017,"
            "cluster0-shard-00-01.qsf14.mongodb.net:27017,"
            "cluster0-shard-00-02.qsf14.mongodb.net:27017/"
            "tvmount?ssl=true&replicaSet=atlas-&authSource=admin",
            serverSelectionTimeoutMS=5000,
        )
        db = client["tvmount"]
    filled_forms_db = db["filled_forms"]
    clients_db = db["clients"]
    users_db = db["users"]
    orders_db = db["orders"]
    print("✅ MongoDB connected")


async def publish_to_queue(queue_name, payload):
    """Publish a message to a RabbitMQ queue"""
    connection = await aio_pika.connect_robust(
        host=RABBIT_HOST,
        port=RABBIT_PORT,
        login=RABBIT_USER,
        password=RABBIT_PASS,
    )
    async with connection:
        channel = await connection.channel()
        await channel.declare_queue(queue_name, durable=True)
        await channel.default_exchange.publish(
            aio_pika.Message(
                body=json.dumps(payload).encode(),
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            ),
            routing_key=queue_name,
        )


def normalize_client_id(client_id):
    if client_id is None:
        return None
    if isinstance(client_id, dict):
        if "$numberLong" in client_id:
            return int(client_id["$numberLong"])
    try:
        return int(client_id)
    except (ValueError, TypeError):
        return None


async def zoom_repeat_call_in(data):
    try:
        client_numeric_id = data.get("client_numeric_id") or data.get("client_id")
        customer_number = data.get("customer_number", "")
        recent_orders = data.get("orders") or []

        order_ids_text = ""
        for o in recent_orders:
            oid = o.get("order_id")
            if oid:
                order_ids_text += f"\n  📦 {oid}"

        order_block = f"\n\n📋 Прошлые заказы:{order_ids_text}" if order_ids_text else ""

        text = (
            f"📞 Повторный звонок\n"
            f"Клиент: #c{client_numeric_id}"
            f"{order_block}"
        )

        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("Claim", callback_data=f"✔️Claim")]
        ])

        msg = await app.bot.send_message(
            chat_id=CHAT_ID, text=text, reply_markup=keyboard,
            parse_mode="HTML",
        )
        print(f"✅ [repeat_call_in] Sent to Telegram, message_id={msg.message_id}")

        # Insert into filled_forms so Claim handler can find it
        filled_forms_db.insert_one({
            "chat_team": "TEST",
            "team_": "test_mini_bot",
            "cpmn_name": "repeat_call",
            "client_id": client_numeric_id,
            "telephone": customer_number,
            "chat_message_id": msg.message_id,
            "test_chat_id": CHAT_ID,
            "date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "text": text,
            "type": "TV",
            "messages": {},
        })

    except Exception as e:
        print(f"❌ [repeat_call_in] Error: {e}")


async def zoom_repeat_sms_in(data):
    try:
        client_numeric_id = data.get("client_numeric_id") or data.get("client_id")
        customer_number = data.get("customer_number", "")
        message_text = data.get("message", "")
        recent_orders = data.get("orders") or []

        order_ids_text = ""
        for o in recent_orders:
            oid = o.get("order_id")
            if oid:
                order_ids_text += f"\n  📦 {oid}"

        order_block = f"\n\n📋 Прошлые заказы:{order_ids_text}" if order_ids_text else ""

        # Group message: NO sms text or phone shown (confidential — only in DM after Claim)
        text = (
            f"💬 Повторное СМС\n"
            f"Клиент: #c{client_numeric_id}"
            f"{order_block}"
        )

        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("Claim", callback_data=f"✔️Claim")]
        ])

        msg = await app.bot.send_message(
            chat_id=CHAT_ID, text=text, reply_markup=keyboard,
            parse_mode="HTML",
        )
        print(f"✅ [repeat_sms_in] Sent to Telegram, message_id={msg.message_id}")

        # Insert into filled_forms — store sms_text for DM after claim
        filled_forms_db.insert_one({
            "chat_team": "TEST",
            "team_": "test_mini_bot",
            "cpmn_name": "repeat_sms",
            "client_id": client_numeric_id,
            "telephone": customer_number,
            "sms_text": message_text,
            "chat_message_id": msg.message_id,
            "test_chat_id": CHAT_ID,
            "date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "text": text,
            "type": "TV",
            "messages": {},
        })

    except Exception as e:
        print(f"❌ [repeat_sms_in] Error: {e}")


async def handle_claim(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle Claim button press — mirrors button_bot.py claim logic"""
    query = update.callback_query
    await query.answer()

    message_id = query.message.message_id
    chat_id = query.message.chat_id
    username = query.from_user.username or query.from_user.first_name

    # Find the form by chat_message_id (same lookup as button_bot)
    form = filled_forms_db.find_one({
        "chat_team": "TEST",
        "chat_message_id": message_id,
    })

    if not form:
        # Fallback: parse #c{id} from message text
        raw_text = query.message.text or ""
        client_match = re.search(r"#c(\d+)", raw_text)
        if client_match:
            client_id = int(client_match.group(1))
            text_upd = f"claimed by @{username}\n" + raw_text
            try:
                await context.bot.edit_message_text(
                    text=text_upd,
                    chat_id=chat_id,
                    message_id=message_id,
                    reply_markup=None,
                )
            except Exception:
                pass
            print(f"✅ [claim] Fallback claim by @{username} for #c{client_id}")
        else:
            print(f"❌ [claim] Form not found for message_id={message_id}")
        return

    # Check if already claimed
    if form.get("manager_at"):
        await context.bot.answer_callback_query(
            query.id, text="Already claimed!", show_alert=True
        )
        return

    # Look up the user in users_db (same as production)
    user = users_db.find_one({"at": username})

    if not user:
        print(f"⚠️ [claim] User @{username} not found in users_db — claiming as test user")
        manager_id = "T0"
        team = "TEST"
        manager_at = username
    else:
        manager_id = user.get("manager_id", "?")
        team = user.get("team", "?")
        manager_at = user.get("at", username)

    # Update the form (same as button_bot lines 785-794)
    client_id = normalize_client_id(form.get("client_id"))
    filled_forms_db.find_one_and_update(
        {"_id": form["_id"]},
        {
            "$set": {
                "team": team,
                "manager_id": manager_id,
                "manager_at": manager_at,
            },
        },
    )

    # Edit the Telegram message to show claimed (remove button) — same as button_bot line 821
    text_upd = f"claimed by @{username} #{manager_id}{team}\n" + form.get("text", "")
    try:
        await context.bot.edit_message_text(
            text=text_upd,
            chat_id=chat_id,
            message_id=message_id,
            reply_markup=None,
            parse_mode="HTML",
        )
    except Exception as e:
        print(f"⚠️ [claim] Failed to edit message: {e}")

    # Send DM to claimer — same format as button_bot line 854-867
    claimer_chat_id = user.get("chat_id") if user else None
    if not claimer_chat_id:
        claimer_chat_id = query.from_user.id  # fallback: DM via telegram user id

    client_ref = clients_db.find_one({"id": client_id}) if client_id else None
    phone = form.get("telephone", "_")
    client_name = (client_ref or {}).get("client_name", "_") if client_ref else "_"
    sms_line = f"\n\n💬 Текст СМС:\n{form.get('sms_text')}" if form.get("sms_text") else ""

    try:
        await context.bot.send_message(
            chat_id=claimer_chat_id,
            text=(
                f"Client #c{form.get('client_id', '_')}\n"
                f"Client name: {client_name}\n"
                f"Campaign: {form.get('cpmn_name', '_')}\n"
                f"Phone: {phone}"
                f"{sms_line}"
            ),
        )
    except Exception as e:
        print(f"⚠️ [claim] Could not DM @{username} (chat_id={claimer_chat_id}): {e}")

    # Publish to personal_claimed_leads (same as button_bot lines 799-808)
    if client_id:
        utc_now = datetime.now(timezone.utc)
        if utc_now.hour >= 4:
            shift_dt = utc_now.replace(hour=0, minute=0, second=0, microsecond=0)
        else:
            shift_dt = (utc_now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)

        claim_payload = {
            "shift_date": shift_dt.strftime("%Y-%m-%d"),
            "client_id": client_id,
            "manager_at": manager_at,
            "team": team,
            "form_id": str(form.get("_id")),
            "form_date": form.get("date"),
            "claim_date": utc_now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "event": "claim",
        }
        try:
            await publish_to_queue("personal_claimed_leads", claim_payload)
            print(f"✅ [claim] Sent to personal_claimed_leads: {claim_payload}")
        except Exception as e:
            print(f"❌ [claim] Failed to send to personal_claimed_leads: {e}")

    print(f"✅ [claim] @{username} (#{manager_id}{team}) claimed #c{client_id} (form {form['_id']})")


async def make_consumer(handler, queue_name):
    """Connect to RabbitMQ and listen to one queue"""
    connection = await aio_pika.connect_robust(
        host=RABBIT_HOST,
        port=RABBIT_PORT,
        login=RABBIT_USER,
        password=RABBIT_PASS,
    )
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=1)
    queue = await channel.declare_queue(queue_name, durable=True)

    async def callback(message: aio_pika.IncomingMessage):
        async with message.process():
            try:
                data = json.loads(message.body.decode())
                print(f"\n📥 [{queue_name}] Message received")
                await handler(data)
            except Exception as e:
                print(f"❌ [{queue_name}] Processing error: {e}")

    await queue.consume(callback)
    print(f"👂 Listening on queue: {queue_name}")
    return connection


async def post_init(application):
    """Called after Application.initialize() — start RabbitMQ consumers"""
    global app
    app = application

    connect_mongo()

    # These queues are NEW and not consumed by any production bot yet
    conn1 = await make_consumer(zoom_repeat_call_in, "repeat_call_in")
    conn2 = await make_consumer(zoom_repeat_sms_in, "repeat_sms_in")

    # Store connections for cleanup
    application.bot_data["rabbit_connections"] = [conn1, conn2]

    print("\n✅ Mini bot running! Waiting for messages... (Ctrl+C to stop)\n")


def main():
    print("=" * 50)
    print("  МИНИ-БОТ: repeat_call_in + repeat_sms_in")
    print("  + Claim button handling")
    print("  Production queues NOT affected")
    print("=" * 50)
    print(f"  Telegram chat_id: {CHAT_ID}")
    print(f"  RabbitMQ: {RABBIT_HOST}:{RABBIT_PORT}")
    print(f"  MongoDB: connected to tvmount")
    print("=" * 50 + "\n")

    application = ApplicationBuilder().token(TOKEN).post_init(post_init).build()

    # Register Claim callback handler
    application.add_handler(CallbackQueryHandler(handle_claim, pattern=r".*Claim.*"))

    # run_polling handles the event loop
    application.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
