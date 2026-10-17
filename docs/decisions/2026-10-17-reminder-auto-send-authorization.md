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
