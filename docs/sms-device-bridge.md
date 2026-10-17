# SMS device bridge — drain protocol

**Audience:** the operator (Muse) setting up the deploy-time scheduled job.
This is NOT run by the app's worker.

## Why this exists

Reminder texts and message-fallback texts go out from the owner's own
phone number via the paired-device `message.send` channel (authorization:
`docs/decisions/2026-10-17-reminder-auto-send-authorization.md`). A
server-side worker cannot invoke the device channel, so SMS delivery is
split in two:

1. **App worker** (`scripts/reminder-worker.ts`) queues *reference-only*
   rows in `sms_outbox` — `reminder_id` or `notification_id` plus the
   destination phone. **Bodies are never stored** (contracts §4.14:
   bodies render at send time with the CURRENT access instructions).
2. **This drain job** (Muse-side, on a schedule) renders each body fresh,
   sends it with the paired phone, and marks delivery.

Scope of the drain: `sms_outbox` rows ONLY. It must never send anything
else. The authorization is revocable — revoking means stopping this job.

## Drain procedure (every 2–5 minutes)

For each row in `sms_outbox` with `status = 'pending'`, oldest first:

1. Load the referenced row:
   - `reminder_id` → `reminders` → `cleaning_jobs` → `properties`
     (+ `agency_settings` for the destination phone, already on the row).
   - `notification_id` → `notification_outbox` → `cleaning_jobs`.
2. If the referenced reminder/notification is gone or its job is
   `cancelled`/`completed`, mark the outbox row `sent` with
   `last_error = 'superseded'` and mark the reminder `skipped`.
   (No text for a dead job.)
3. Otherwise render the body **now**, exactly as the worker would:
   - Reminder SMS: same shape as `renderReminderSms` in `lib/reminders.ts`
     — job title, date + window in PT, property address, and the
     property's CURRENT `access_instructions` (decrypt
     `properties.access_instructions` in memory with
     `ACCESS_INSTRUCTIONS_KEY`; never log the value).
   - Message-fallback SMS: `New message on "<job title>" — open the app
     to read it.` (no bodies, no codes — same as `notificationText` in
     `lib/notify.ts`).
4. Send via the paired phone's `message.send` to `to_phone`.
5. On success, update both the outbox row and the referenced row:
   - `sms_outbox`: `status='sent'`, `sent_at=now()`
   - `reminders` (if `reminder_id`): `status='sent'`
   - `notification_outbox` (if `notification_id`): `status='sent'`, `sent_at=now()`
6. On failure: `attempts = attempts + 1`, `last_error = <short error>`.
   After 3 attempts: `status = 'failed'`, and mirror `failed` onto the
   referenced reminder/notification row. Failed rows surface in the
   daily digest automatically (it reads both tables).

## What the drain must never do

- Never send to a number not present in `sms_outbox.to_phone`.
- Never log message bodies or access-instruction values.
- Never mark a row `sent` unless `message.send` confirmed delivery.
- Never invent reminders: if `sms_outbox` is empty, do nothing.

## Phone-offline behavior

If the paired phone is offline, `message.send` fails; the row stays
`pending` with attempts incrementing. The digest reports it as unsent
after the retry budget — never silent, per the standing rule.
