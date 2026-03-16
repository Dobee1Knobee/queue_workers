import asyncio
import json
import os
import re
import time
import aio_pika
from datetime import datetime, timezone, timedelta
from bson import ObjectId
from pymongo import MongoClient
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.error import NetworkError, RetryAfter, TimedOut
from telegram.ext import ApplicationBuilder, CallbackQueryHandler, ContextTypes
from telegram.request import HTTPXRequest

from dotenv import load_dotenv
load_dotenv()

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
CHAT_ID = int(os.environ["TELEGRAM_CHAT_ID"])
TELEGRAM_PROXY = os.environ.get("TELEGRAM_PROXY")  # Optional proxy URL

# Telegram timeout config
TG_CONNECT_TIMEOUT = 30.0
TG_READ_TIMEOUT = 30.0
TG_WRITE_TIMEOUT = 30.0

# RabbitMQ (shared with queue_workers)
RABBIT_HOST = os.environ.get("NGROK_TCP_HOST", "7.tcp.ngrok.io")
RABBIT_PORT = int(os.environ.get("NGROK_TCP_PORT", "21850"))
RABBIT_USER = os.environ.get("RABBITMQ_USER", "guest")
RABBIT_PASS = os.environ.get("RABBITMQ_PASS", "guest")
AUTO_CLAIM_QUEUE = os.environ.get("AUTO_CLAIM_QUEUE", "auto_claim_in")

# MongoDB
MONGO_URI = os.environ.get("MONGO_URI", os.environ.get("CLIENTS_DB_URL", ""))

# Admin override - redirect all DMs to this user instead of actual manager
AUTO_CLAIM_ADMIN = os.environ.get("AUTO_CLAIM_ADMIN", "").strip() or None

# 2-week window for direct-to-DM routing
REPEAT_CONTACT_WINDOW_DAYS = 14

filled_forms_db = None
clients_db = None
users_db = None
orders_db = None

# Will be set after Application is built
app = None
send_lock = asyncio.Lock()
last_send_ts = 0.0
MIN_SEND_INTERVAL_SEC = float(os.environ.get("TELEGRAM_MIN_SEND_INTERVAL_SEC", "1.2"))


def connect_mongo():
    global filled_forms_db, clients_db, users_db, orders_db
    try:
        # Increased serverSelectionTimeoutMS for Atlas resilience
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=30000, connectTimeoutMS=30000)
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
            serverSelectionTimeoutMS=30000,
            connectTimeoutMS=30000
        )
        db = client["tvmount"]
    filled_forms_db = db["filled_forms"]
    clients_db = db["clients"]
    users_db = db["users"]
    orders_db = db["orders"]
    print("✅ MongoDB connected")


def find_claimed_manager_for_client(client_id, window_days=REPEAT_CONTACT_WINDOW_DAYS):
    """
    Find the manager who claimed this client within the last `window_days` days.
    Returns user document or None if not found.
    """
    if not client_id:
        return None
    
    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
    
    form = filled_forms_db.find_one(
        {
            "client_id": client_id,
            "manager_at": {"$exists": True, "$ne": None, "$ne": ""},
            "date": {"$gte": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")},
        },
        sort=[("date", -1)]
    )
    
    if not form:
        return None
    
    manager_at = form.get("manager_at")
    if not manager_at:
        return None
    
    return users_db.find_one({"at": manager_at})


async def get_manager_chat_id(manager_at):
    """Get chat_id for a manager by their at username"""
    if not manager_at:
        return None
    user = users_db.find_one({"at": manager_at})
    return user.get("chat_id") if user else None


async def throttled_send_message(**kwargs):
    global last_send_ts
    async with send_lock:
        now = time.monotonic()
        wait_for = MIN_SEND_INTERVAL_SEC - (now - last_send_ts)
        if wait_for > 0:
            await asyncio.sleep(wait_for)

        attempts = 3
        for attempt in range(1, attempts + 1):
            try:
                message = await app.bot.send_message(**kwargs)
                last_send_ts = time.monotonic()
                return message
            except RetryAfter as exc:
                retry_after = int(getattr(exc, "retry_after", 1) or 1)
                print(f"⚠️ Telegram flood control. Waiting {retry_after}s before retry {attempt}/{attempts}")
                await asyncio.sleep(retry_after)
            except (TimedOut, NetworkError) as exc:
                if attempt == attempts:
                    raise
                delay = attempt * 3
                print(f"⚠️ Telegram temporary error: {exc}. Retry in {delay}s ({attempt}/{attempts})")
                await asyncio.sleep(delay)

        raise RuntimeError("Failed to send Telegram message after retries")


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


def build_manager_snapshot(user=None, fallback=None):
    fallback = fallback or {}
    user = user or {}
    manager_at = user.get("at") or fallback.get("manager_at") or fallback.get("username")
    return {
        "manager_id": user.get("manager_id") or fallback.get("manager_id") or "T0",
        "team": user.get("team") or fallback.get("team") or "TEST",
        "manager_at": manager_at,
        "chat_id": user.get("chat_id") or fallback.get("manager_chat_id") or fallback.get("chat_id"),
        "delegated_from_at": fallback.get("delegated_from_at"),
        "delegated_from_manager_id": fallback.get("delegated_from_manager_id"),
        "replacement_candidate_at": fallback.get("replacement_candidate_at"),
        "resolution_method": fallback.get("manager_resolution_method") or fallback.get("resolution_method"),
    }


def build_claim_message_text(form, manager):
    return (
        f"claimed by @{manager.get('manager_at', '_')} "
        f"#{manager.get('manager_id', 'T0')}{manager.get('team', 'TEST')}\n"
        + form.get("text", "")
    )


async def send_claim_dm(form, manager, fallback_chat_id=None):
    # Admin override: redirect all DMs to GROUP instead of actual manager's DM
    if AUTO_CLAIM_ADMIN:
        claimer_chat_id = CHAT_ID  # Send to group
        redirect_note = f"\n\n🔄 [REDIRECTED from @{manager.get('manager_at', '_')}]"
    else:
        claimer_chat_id = manager.get("chat_id") or fallback_chat_id
        redirect_note = ""
    
    if not claimer_chat_id:
        print(f"⚠️ [claim] No DM target for @{manager.get('manager_at', '_')}")
        return

    client_id = normalize_client_id(form.get("client_id"))
    client_ref = clients_db.find_one({"id": client_id}) if client_id else None
    phone = form.get("telephone", "_")
    client_name = (client_ref or {}).get("client_name", "_") if client_ref else "_"
    sms_raw = form.get("sms_text", "")
    sms_text = sms_raw.replace("\\n", "\n") if sms_raw else ""
    sms_line = f"\n\n💬 Текст СМС:\n{sms_text}" if sms_text else ""

    try:
        await throttled_send_message(
            chat_id=claimer_chat_id,
            text=(
                f"Client #c{form.get('client_id', '_')}\n"
                f"Client name: {client_name}\n"
                f"Campaign: {form.get('cpmn_name', '_')}\n"
                f"Phone: {phone}"
                f"{sms_line}"
                f"{redirect_note}"
            ),
        )
    except Exception as e:
        print(
            f"⚠️ [claim] Could not DM @{manager.get('manager_at', '_')} "
            f"(chat_id={claimer_chat_id}): {e}"
        )


async def publish_claim_event(form, manager):
    client_id = normalize_client_id(form.get("client_id"))
    if not client_id:
        return

    utc_now = datetime.now(timezone.utc)
    if utc_now.hour >= 4:
        shift_dt = utc_now.replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        shift_dt = (utc_now - timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )

    claim_payload = {
        "shift_date": shift_dt.strftime("%Y-%m-%d"),
        "client_id": client_id,
        "manager_at": manager.get("manager_at"),
        "team": manager.get("team"),
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


async def apply_claim_to_form(form, manager, source="manual", fallback_chat_id=None, suppress_dm=False):
    if not form:
        print(f"❌ [claim] Form missing for source={source}")
        return False

    if form.get("manager_at"):
        print(
            f"⚠️ [claim] Form {form.get('_id')} already claimed by "
            f"@{form.get('manager_at')}"
        )
        return False

    manager = build_manager_snapshot(fallback=manager)
    if not manager.get("manager_at"):
        raise RuntimeError(f"manager_at missing for source={source}")

    client_id = normalize_client_id(form.get("client_id"))
    filled_forms_db.find_one_and_update(
        {"_id": form["_id"]},
        {
            "$set": {
                "team": manager.get("team"),
                "manager_id": manager.get("manager_id"),
                "manager_at": manager.get("manager_at"),
                "claim_source": source,
                "claim_resolution_method": manager.get("resolution_method"),
                "delegated_from_at": manager.get("delegated_from_at"),
                "delegated_from_manager_id": manager.get("delegated_from_manager_id"),
            },
        },
    )

    chat_id = form.get("test_chat_id") or CHAT_ID
    updated_text = build_claim_message_text(form, manager)
    try:
        await app.bot.edit_message_text(
            text=updated_text,
            chat_id=chat_id,
            message_id=form.get("chat_message_id"),
            reply_markup=None,
            parse_mode="HTML",
        )
    except Exception as e:
        print(f"⚠️ [claim] Failed to edit message: {e}")

    if not suppress_dm:
        await send_claim_dm(form, manager, fallback_chat_id=fallback_chat_id)
    await publish_claim_event(form, manager)

    print(
        f"✅ [claim:{source}] @{manager.get('manager_at')} "
        f"(#{manager.get('manager_id')}{manager.get('team')}) claimed #c{client_id} "
        f"(form {form['_id']})"
    )
    return True


async def handle_auto_claim(data):
    form_id = data.get("form_id")
    if not form_id:
        print("⚠️ [auto_claim] Missing form_id, skipping create-and-claim fallback")
        return

    try:
        form = filled_forms_db.find_one({"_id": ObjectId(form_id)})
    except Exception as e:
        print(f"❌ [auto_claim] Invalid form_id={form_id}: {e}")
        return

    if not form:
        print(f"❌ [auto_claim] Form not found: {form_id}")
        return

    user = None
    manager_at = data.get("manager_at")
    if manager_at:
        user = users_db.find_one({"at": manager_at})
    if not user and data.get("manager_id") and data.get("team"):
        user = users_db.find_one({
            "manager_id": data.get("manager_id"),
            "team": data.get("team"),
        })

    manager = build_manager_snapshot(user=user, fallback=data)
    await apply_claim_to_form(
        form,
        manager,
        source=data.get("apply_mode") or "auto",
        suppress_dm=bool(data.get("suppress_dm")),
    )


async def zoom_repeat_call_in(data):
    try:
        client_numeric_id = data.get("client_numeric_id") or data.get("client_id")
        customer_number = data.get("customer_number", "")
        recent_orders = data.get("orders") or []
        lead_type = data.get("lead_type") or "repeat_call"
        call_result = data.get("result", "")
        is_missed_call = lead_type == "missed_call"
        direction = data.get("direction", "inbound")
        
        # Extract manager info
        team = data.get("team", "")
        manager_at = data.get("manager_at", "")
        date_time = data.get("date_time", "")
        
        # Format date if available
        date_line = f"\n📅 {date_time}" if date_time else ""
        team_line = f"\n👥 Команда: {team}" if team else ""
        owner_line = f"\n👤 Owner: @{manager_at}" if manager_at else ""
        
        # For missed calls, check if client was claimed within last 2 weeks
        # If yes, route directly to that manager's DM
        if is_missed_call:
            claimed_manager = find_claimed_manager_for_client(client_numeric_id, window_days=REPEAT_CONTACT_WINDOW_DAYS)
            
            if claimed_manager:
                manager_at = claimed_manager.get("at")
                manager_chat_id = claimed_manager.get("chat_id")
                
                # Build order info
                order_ids_text = ""
                for o in recent_orders:
                    oid = o.get("order_id")
                    if oid:
                        order_ids_text += f"\n  📦 {oid}"
                order_block = f"\n📋 Прошлые заказы:{order_ids_text}" if order_ids_text else ""
                
                # Check for admin override - send to GROUP instead of DM
                if AUTO_CLAIM_ADMIN:
                    # Use group chat instead of admin DM
                    manager_chat_id = CHAT_ID  # Send to group
                    redirect_note = f"\n\n🔄 [REDIRECTED from @{manager_at}]"
                else:
                    redirect_note = ""
                
                if manager_chat_id:
                    await throttled_send_message(
                        chat_id=manager_chat_id,
                        text=(
                            f"☎️ Пропущенный звонок от клиента\n"
                            f"Клиент: #c{client_numeric_id}\n"
                            f"Phone: {customer_number}\n"
                            f"Статус: {call_result or 'unknown'}"
                            f"{order_block}"
                            f"{redirect_note}"
                        ),
                        parse_mode="HTML",
                    )
                    print(f"✅ [repeat_call_in] Direct DM to @{manager_at} for missed call #c{client_numeric_id}")
                    return  # Skip group message
                else:
                    print(f"⚠️ [repeat_call_in] Manager @{manager_at} has no chat_id, falling back to group")
        
        # No claimed manager in 2 weeks or not missed call → create lead in group
        order_ids_text = ""
        for o in recent_orders:
            oid = o.get("order_id")
            if oid:
                order_ids_text += f"\n  📦 {oid}"

        order_block = f"\n\n📋 Прошлые заказы:{order_ids_text}" if order_ids_text else ""
        status_line = f"\nСтатус: {call_result}" if is_missed_call and call_result else ""

        text = (
            f"{'☎️ Пропущенный звонок' if is_missed_call else '📞 Повторный звонок'}\n"
            f"Клиент: #c{client_numeric_id}"
            f"{status_line}"
            f"{date_line}"
            f"{team_line}"
            f"{owner_line}"
            f"{order_block}"
        )

        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton("Claim", callback_data=f"✔️Claim")]
        ])

        msg = await throttled_send_message(
            chat_id=CHAT_ID, text=text, reply_markup=keyboard,
            parse_mode="HTML",
        )
        print(f"✅ [repeat_call_in] Sent to Telegram group, message_id={msg.message_id}")

        # Insert into filled_forms so Claim handler can find it
        filled_forms_db.insert_one({
            "chat_team": "TEST",
            "team_": "test_mini_bot",
            "cpmn_name": "missed_call" if is_missed_call else "repeat_call",
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
        raise


async def zoom_repeat_sms_in(data):
    try:
        client_numeric_id = data.get("client_numeric_id") or data.get("client_id")
        customer_number = data.get("customer_number", "")
        message_text = data.get("message", "")
        recent_orders = data.get("orders") or []
        sms_type = data.get("smsType", "incoming")

        # Check if this client was claimed within the last 2 weeks
        # If yes, route directly to that manager's DM (no group message, no Claim button)
        claimed_manager = find_claimed_manager_for_client(client_numeric_id, window_days=REPEAT_CONTACT_WINDOW_DAYS)
        
        if claimed_manager:
            # Direct-to-DM: send SMS content directly to the manager who claimed this client
            manager_at = claimed_manager.get("at")
            manager_chat_id = claimed_manager.get("chat_id")
            
            # Build order info
            order_ids_text = ""
            for o in recent_orders:
                oid = o.get("order_id")
                if oid:
                    order_ids_text += f"\n  📦 {oid}"
            order_block = f"\n📋 Прошлые заказы:{order_ids_text}" if order_ids_text else ""
            
            # Check for admin override - send to GROUP instead of DM
            if AUTO_CLAIM_ADMIN:
                manager_chat_id = CHAT_ID  # Send to group
                redirect_note = f"\n\n🔄 [REDIRECTED from @{manager_at}]"
            else:
                redirect_note = ""
            
            if manager_chat_id:
                await throttled_send_message(
                    chat_id=manager_chat_id,
                    text=(
                        f"💬 Повторное СМС от клиента\n"
                        f"Клиент: #c{client_numeric_id}\n"
                        f"Phone: {customer_number}\n"
                        f"Текст: {message_text}"
                        f"{order_block}"
                        f"{redirect_note}"
                    ),
                    parse_mode="HTML",
                )
                print(f"✅ [repeat_sms_in] Direct DM to @{manager_at} for client #{client_numeric_id}")
                return  # Skip group message
            else:
                print(f"⚠️ [repeat_sms_in] Manager @{manager_at} has no chat_id, falling back to group")
        
        # No claimed manager in 2 weeks → create lead in group chat (existing behavior)
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

        msg = await throttled_send_message(
            chat_id=CHAT_ID, text=text, reply_markup=keyboard,
            parse_mode="HTML",
        )
        print(f"✅ [repeat_sms_in] Sent to Telegram group, message_id={msg.message_id}")

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
        raise


async def handle_claim(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle Claim button press — mirrors button_bot.py claim logic"""
    query = update.callback_query
    await query.answer()

    message_id = query.message.message_id
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
                    chat_id=query.message.chat_id,
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

    manager = build_manager_snapshot(user=user, fallback={"manager_at": username})
    await apply_claim_to_form(
        form,
        manager,
        source="manual",
        fallback_chat_id=query.from_user.id,
    )


async def zoom_new_inbound_lead(data):
    """
    Handle inbound leads with auto-claim:
    - Answered inbound call → DM to manager who answered
    - New SMS with extension info → DM to manager
    
    This creates a pre-claimed lead directly in the manager's DM,
    no group message, no Claim button.
    """
    try:
        client_numeric_id = data.get("client_numeric_id") or data.get("client_id")
        customer_number = data.get("customer_number", "")
        lead_type = data.get("lead_type", "inbound_sms")
        message_text = data.get("message", "")
        call_result = data.get("result", "")
        ext = data.get("ext", "")
        manager_at = data.get("manager_at", "")
        has_any_order = data.get("has_any_order", False)
        has_recent_order = data.get("has_recent_order", False)
        
        manager = users_db.find_one({"at": manager_at}) if manager_at else None
        
        if not manager:
            print(f"❌ [new_inbound_lead] Manager @{manager_at} not found")
            return
        
        manager_chat_id = manager.get("chat_id")
        
        if AUTO_CLAIM_ADMIN:
            manager_chat_id = CHAT_ID
            redirect_note = f"\n\n🔄 [REDIRECTED from @{manager_at}]"
        else:
            redirect_note = ""
        
        if not manager_chat_id:
            print(f"⚠️ [new_inbound_lead] Manager @{manager_at} has no chat_id, skipping")
            return
        
        # Determine client status label
        if has_recent_order:
            client_status = "🟢 АКТИВНЫЙ КЛИЕНТ"
        elif has_any_order:
            client_status = "🟡 ПОВТОРНЫЙ КЛИЕНТ"
        else:
            client_status = "🔵 НОВЫЙ КЛИЕНТ"
        
        # Build message based on type
        if lead_type == "inbound_sms":
            content_text = f"Текст: {message_text}" if message_text else ""
            lead_label = "💬 Входящее SMS"
        elif lead_type == "active_call":
            content_text = f"Статус: {call_result}" if call_result else ""
            lead_label = "☎️ Звонок от активного клиента"
        else:
            content_text = f"Статус: {call_result}" if call_result else ""
            lead_label = "☎️ Входящий звонок"
        
        ext_info = f"\n📱 На экстеншн: {ext}" if ext else ""
        
        await throttled_send_message(
            chat_id=manager_chat_id,
            text=(
                f"{lead_label}\n"
                f"{client_status}\n"
                f"Клиент: #c{client_numeric_id}\n"
                f"Phone: {customer_number}"
                f"{ext_info}\n"
                f"{content_text}"
                f"{redirect_note}"
            ),
            parse_mode="HTML",
        )
        
        # Create a pre-claimed form
        filled_forms_db.insert_one({
            "chat_team": "TEST",
            "team_": "test_mini_bot",
            "cpmn_name": lead_type,
            "client_id": client_numeric_id,
            "telephone": customer_number,
            "manager_at": manager_at,
            "manager_id": manager.get("manager_id"),
            "team": manager.get("team"),
            "date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "claim_source": "auto_inbound",
            "type": "TV",
            "messages": {},
        })
        
        print(f"✅ [new_inbound_lead] DM sent to @{manager_at} for #c{client_numeric_id} ({client_status})")
        
    except Exception as e:
        print(f"❌ [new_inbound_lead] Error: {e}")
        raise


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
        async with message.process(requeue=True):
            try:
                data = json.loads(message.body.decode())
                print(f"\n📥 [{queue_name}] Message received")
                await handler(data)
            except Exception as e:
                print(f"❌ [{queue_name}] Processing error: {e}")
                raise

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
    conn3 = await make_consumer(handle_auto_claim, AUTO_CLAIM_QUEUE)
    conn4 = await make_consumer(zoom_new_inbound_lead, "new_inbound_lead")

    # Store connections for cleanup
    application.bot_data["rabbit_connections"] = [conn1, conn2, conn3, conn4]

    print("\n✅ Mini bot running! Waiting for messages... (Ctrl+C to stop)\n")


def main():
    print("=" * 50)
    print("  МИНИ-БОТ: repeat_call_in + repeat_sms_in")
    print(f"  + auto-claim queue: {AUTO_CLAIM_QUEUE}")
    print("  + Claim button handling")
    print("  Production queues NOT affected")
    print("=" * 50)
    print(f"  Telegram chat_id: {CHAT_ID}")
    print(f"  RabbitMQ: {RABBIT_HOST}:{RABBIT_PORT}")
    print(f"  MongoDB: connected to tvmount")
    print("=" * 50 + "\n")

    # Configure custom request with proxy and timeouts
    request_kwargs = {
        'connect_timeout': TG_CONNECT_TIMEOUT,
        'read_timeout': TG_READ_TIMEOUT,
        'write_timeout': TG_WRITE_TIMEOUT
    }
    
    if TELEGRAM_PROXY:
        print(f"🌐 Using Telegram proxy: {TELEGRAM_PROXY}")
        request_kwargs['proxy_url'] = TELEGRAM_PROXY

    request = HTTPXRequest(**request_kwargs)
    
    application = ApplicationBuilder() \
        .token(TOKEN) \
        .request(request) \
        .post_init(post_init) \
        .build()

    # Register Claim callback handler
    application.add_handler(CallbackQueryHandler(handle_claim, pattern=r".*Claim.*"))

    # run_polling handles the event loop
    application.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
