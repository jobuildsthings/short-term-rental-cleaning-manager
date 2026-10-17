# Decision: reminder auto-send authorization

**Date:** 2026-10-17
**Decided by:** the owner, in her own words.

## The authorization

> "use my phone to send the texts"

(Full message: "Great this should be free just use my phone to send the texts.")

## Scope

This app is authorized to **automatically send**:

1. Cleaning reminder texts (24h and 2h before each assigned/confirmed job,
   per the property's `reminder_hours_before`) to the cleaning agency's
   confirmed contact phone — sent from the owner's own phone number via the
   paired-device send command. Every reminder includes the property's
   **current** access instructions, rendered at send time.
2. The Saturday recap **email** (default Saturday 08:00 America/Los_Angeles)
   to the owner and the agency's confirmed contact email, listing the
   upcoming week's cleanings.

## Explicitly out of scope

- Anything else. No other recipients, no other message types, no marketing,
  no payments (money moves via Venmo, outside the app).

## Standing rule interaction

The owner's standing rulebook otherwise bans automated outbound sends.
This file records the named exception: one app, these two message types,
these recipients. It is **revocable at any time** — revocation means
deleting this file's authority: the scheduler must then stop sending and
surface unsent reminders on the dashboard instead.

## Implementation notes for future workstreams

- Reminder bodies are rendered at send time and **never persisted**
  (`reminders` table holds metadata only).
- `reminders` rows track `pending → sent/failed/skipped` with retry counts;
  a failed send is never silent (dashboard + daily digest).
- The Saturday recap writes one `recap_runs` row per send.
- Every send writes an audit entry (`reminder.sent`, `recap.sent`) with
  metadata only — never message bodies or instruction values.

## Workstream E implementation (2026-10-17)

The authorization above is implemented as follows. Scope is unchanged:
reminders + Saturday recap, nothing else.

**Email (direct).** The reminder worker (`scripts/reminder-worker.ts`)
sends email itself via the Resend HTTP API (`lib/send.ts`). No SDK, no
new dependency. Failures retry (3 attempts), then `failed` + audit +
daily digest.

**SMS (device bridge).** A deployed worker cannot reach the owner's phone
directly, so SMS takes a two-hop path that preserves the "render at send
time" rule:
1. The worker queues a *reference-only* row in `sms_outbox`
   (`reminder_id` or `notification_id` + destination phone). **No body is
   ever stored** — storing the rendered body would freeze the access
   instructions at queue time, violating the current-value rule.
2. A Muse-side scheduled job (the deploy-time cron, NOT this repo's
   worker) drains `sms_outbox`: for each pending row it re-renders the
   body from the referenced reminder/notification using the CURRENT
   access instructions, sends it with the paired phone's `message.send`,
   and marks both the outbox row and the reminder/notification `sent`
   (or `failed` with the error). Drain protocol: `docs/sms-device-bridge.md`.

**Twilio fallback.** `SMS_PROVIDER=twilio` switches the worker to direct
Twilio sends. Documented fallback only — the device bridge is primary.

**Revocation.** Deleting this file's authority means: set
`SMS_PROVIDER=none`-equivalent (stop the worker's send paths and the
drain cron); the worker then leaves reminders `pending` and the digest
reports them as unsent. The `send.ts` module has no generic
send-anything entry point, so nothing else can emit.

**Also covered by this worker:** the daily digest email to the owner
(contracts §4.21 — the no-silent-failures guarantee), the shared
"Cleanings" calendar sync (contracts §4.18–20), and message-fallback
notifications (contracts §4.22) via `notification_outbox`.
