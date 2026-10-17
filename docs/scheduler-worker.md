# Scheduler worker

The scheduling engine (`lib/scheduler.ts`) runs as a separate long-lived
process, not inside web requests: booking-calendar syncs involve network
I/O and must never block the UI.

## What it does, every 15 minutes

1. Finds iCal feeds due for sync (never synced, or synced over an hour ago).
2. Fetches + parses each feed **outside** any DB transaction, then applies
   the result inside a transaction: upsert reservations, handle removals,
   reconcile turnover jobs (idempotent via `stable_key`).
3. Re-expands all active recurring series (idempotent and self-healing —
   a missed run just catches up on the next pass).

## Running it

```sh
npm run scheduler
```

With docker-compose: `docker compose up worker` (shares the app image,
waits for the database to be healthy).

## Reliability notes

- A failed feed sync never throws the pass: the feed is marked
  `last_sync_status='error'` with a URL-free error message, an
  `ical.sync_failed` audit row is written, and the failure surfaces on the
  dashboard and in the daily digest (Workstream E reads these rows).
- Logs are JSON, one event per line, and never contain feed URLs.
- The worker uses the owner database connection (`DATABASE_URL`), which
  bypasses row-level security — this is the documented exception for the
  scheduler (see `lib/db.ts`). Request handlers must never do this.
