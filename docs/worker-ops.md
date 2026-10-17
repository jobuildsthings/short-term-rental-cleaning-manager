# Worker operations — reminder worker (Workstream E)

## What it is

`scripts/reminder-worker.ts` is the time-driven half of notifications.
The scheduling engine (`scripts/scheduler.ts`, Workstream B) owns
calendar ingestion; this worker owns everything that must happen *at a
time*:

| Pass (every 60s) | What it does |
|---|---|
| Due reminders | Email sends now (Resend); SMS queued reference-only to `sms_outbox` for the device bridge |
| Reminder reconcile | Ensures every `assigned`/`confirmed` job has its full reminder set (covers missed lifecycle hooks) |
| Notification outbox | Message-fallback intents: email direct, SMS via device bridge (Twilio fallback only) |
| Calendar reconcile | Incremental (jobs changed in the window) + full sweep every 15 min |
| Saturday recap | Sends when `agency_settings.recap_weekday`/`recap_time` is reached (default Sat 08:00 PT) |
| Daily digest | One email/day to the owner: sync failures, failed sends, declines, flags |

## Running it

```sh
# Local dev (uses DATABASE_URL from .env — the owner connection)
npx tsx scripts/reminder-worker.ts
```

In production it runs as a long-lived process next to the app, e.g. a
second service in docker-compose:

```yaml
  reminder-worker:
    build: .
    restart: unless-stopped
    command: ["npx", "tsx", "scripts/reminder-worker.ts"]
    env_file: .env
    depends_on:
      db:
        condition: service_healthy
```

(The compose file keeps only the services the repo can carry; add this
stanza at deploy time.)

## Env vars

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Owner Postgres connection (worker bypasses RLS — documented) |
| `ACCESS_INSTRUCTIONS_KEY` | 32-byte hex key; bodies render at send time only |
| `RESEND_API_KEY` | Resend API key for all email |
| `RESEND_FROM` | From header, e.g. `Cleanings <reminders@example.com>` |
| `SMS_PROVIDER` | `device_bridge` (default) or `twilio` (documented fallback) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | Only needed when `SMS_PROVIDER=twilio` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Token refresh for the calendar sync |

## The SMS device bridge (important)

This worker NEVER sends texts itself. SMS reminders/notifications land
in `sms_outbox` as reference-only rows (no bodies — bodies render at
drain time with current access instructions). A separate Muse-side
scheduled job drains the queue with the owner's paired phone — see
`docs/sms-device-bridge.md`. If the bridge is down, rows stay `pending`
and the digest reports them; nothing fails silently.

## Lifecycle hooks (for future workstreams)

Job lifecycle changes (assign/confirm/reschedule/cancel/complete)
should call:
- `scheduleRemindersForJob(db, jobId)` after assign/confirm/reschedule
- `skipRemindersForJob(db, jobId)` after cancel/complete
- `syncJobEvent(db, jobId)` after any status/date change

The worker's reconcile passes cover missed hooks, so hooks are an
optimization, not a correctness requirement.

## Logs

JSON, one event per line. Never contains feed URLs, phone numbers,
message bodies, or access-instruction values. Key events:
`reminders_processed`, `notifications_processed`, `calendar_reconciled`,
`recap_sent`, `digest_sent`, plus `*_failed` variants.
