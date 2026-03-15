# QWorkers Status

This file describes the current live role of `queue_workers`.
Update it after every behavior change in `queue_workers`.

## Current role

- `queue_workers` is not the primary Zoom webhook processor.
- Primary/legacy processing still happens in `bots-1/button_bot.py`.
- After legacy processing, `button_bot` mirrors raw wrapped Zoom events into RabbitMQ test queues:
  - `call_in_test`
  - `sms_in_test`
- `queue_workers` consumes those mirrored queues and runs new isolated logic on top.

## Important queue semantics

- `call_in_test` and `sms_in_test` are not original first-touch queues.
- They are test/parallel queues populated by legacy `button_bot` after it already consumed the original event.
- This means `queue_workers` currently behaves like a secondary processor attached to legacy flow, not a replacement for legacy ingestion.

## Current inputs

- RabbitMQ consumer in `queue_workers/app.js`
- Consumed queues:
  - `call_in_test`
  - `sms_in_test`
- Telegram Gateway inbound callback endpoint:
  - `POST /internal/telegram/events`

## Current supported scenarios

### Calls

- Stores processed call info in call DB.
- Finds or creates client.
- Detects inbound missed calls (`No Answer`, `Busy`, `Failed`, `Declined`, `Missed`, `Voicemail`) and creates claimable Telegram lead.
- Checks whether inbound call is a repeat lead:
  - client has old orders;
  - client has no orders in the last 14 days.
- Lead routing priority for inbound call:
  - missed call lead first;
  - repeat lead second.
- If missed/repeat lead is detected:
  - sends Telegram notification through Gateway when enabled;
  - otherwise falls back to RabbitMQ `repeat_call_in`.

### SMS

- Stores processed SMS info in SMS DB.
- Finds or creates client.
- Checks whether inbound SMS is a repeat lead with the same 14-day logic.
- If repeat is detected:
  - sends Telegram notification through Gateway when enabled;
  - otherwise falls back to RabbitMQ `repeat_sms_in`.

### Claim handling

- Mini-bot mode: claim is handled locally by `mini_bot.py`.
- Gateway mode: `queue_workers` can handle claim callbacks only if Gateway routes the callback back to `queue_workers`.
- Current routing conflict exists because Gateway routes `claim:` callback data to another downstream service.
- Shadow auto-claim observation is now wired for open `missed_call`, `repeat_call`, and `repeat_sms` leads.
- `queue_workers` now enqueues auto-claim requests for eligible shadow candidates; `mini_bot.py` applies the same claim flow used by the manual Claim button.
- In shadow-apply mode, auto-claim updates forms, edits/creates the group message, and publishes claim events, but skips manager DM notifications.
- Auto-claim only applies to already existing open leads; if no open lead exists, the event is observed and logged but does not create a new claimed lead automatically.
- Auto-claim lead matching now prefers lead `telephone` to correlate follow-up calls/SMS, with `client_id` as fallback.
- Auto-claim manager resolution now supports shift replacement: if the resolved manager has `working=false` and a configured replacement exists, the replacement manager is used instead.
- Auto-claim DM delivery is now controlled by `AUTO_CLAIM_SEND_DM`.

## Current limitations

- `queue_workers` currently supports only a subset of lead types: repeat call, missed inbound call, repeat SMS.
- Non-repeat/non-missed events are mostly logged and skipped.
- Current default behavior is effectively `shadow_apply`: if an existing open lead is found and the follow-up event qualifies, the lead is auto-claimed and the group message is updated, but manager DM is skipped.
- `AUTO_CLAIM_ENABLED=true` is only needed for the fuller apply mode semantics you may want later; existing-lead auto-claim already runs in the current shadow/apply setup.
- Manual and auto-claim can race with lead creation because `queue_workers` consumes mirrored queues after legacy already handled the original event.
- A manager can answer/call back before the free lead message is created, leaving the chat message stale until a later reconciliation step exists.
- Full legacy CRM behavior from `bots-1` is not migrated.

## Next planned gap

- Expand lead taxonomy and routing (first call, call-backs, campaign-specific rules) beyond repeat/missed cases.
- Add retroactive reconciliation after lead creation so newly created free leads can be auto-claimed if a qualifying callback already happened moments earlier.
- Add recheck before manual Claim so users cannot claim a lead that was already answered by someone else.

## Update checklist

When changing `queue_workers`, update this file if any of these changed:

- consumed queues;
- event source semantics;
- repeat detection rules;
- Telegram delivery path (mini-bot vs Gateway);
- claim ownership/routing;
- supported lead types (repeat, missed call, first call, SMS, etc.);
- fallback behavior.
