# Message fallback notifications: intent recording and outbox

**Date:** 2026-10-17
**Workstream:** D (Messaging)
**Contracts:** §4 rule 22, §7.16

## Decision

Workstream D records every new-message fallback notification as an
**intent**, and Workstream E performs the actual send. Channel priority is
fixed by §7.16: a message from the owner queues an **SMS via the owner's
phone to the dispatcher**; a message from the dispatcher queues an **email
to the owner**. If SMS fails, E falls back to email for the dispatcher too
and surfaces the failure per the no-silent-failures rule.

## Current implementation (no schema change)

`postJobMessage()` (lib/messaging.ts) writes one audit row per posted
message:

- `action = 'message.posted'`, `entity_type = 'message'`, `entity_id = <message id>`
- `metadata = { job_id, message_id, notification: { channel: 'sms'|'email', recipient: 'dispatcher'|'owner' } }`
- The message **body is never in the audit metadata** (contracts §5).

Workstream E can poll `audit_log` for `action = 'message.posted'` rows
lacking a matching `action = 'message.notification_sent'` row and send
accordingly, resolving the dispatcher's phone/email from
`agency_settings` and the owner's email from `users`.

## Recommended long-term home: notification_outbox

The audit log is append-only with no status column, so "sent" tracking via
`message.notification_sent` rows is a convention, not a guarantee. The
proper home is a small outbox table. Proposed DDL (for Workstream A or E
to adopt — Workstream D did not create it, to avoid conflicting with
parallel schema work):

```sql
CREATE TABLE public.notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.cleaning_jobs(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms','email')),
  recipient text NOT NULL CHECK (recipient IN ('dispatcher','owner')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
-- RLS: owner full access; scheduler (admin) writes status; dispatcher none.
```

Once the table exists, the one-line change in `lib/messaging.ts` is to
insert into `notification_outbox` inside `postJobMessage()` instead of
(and the audit `message.posted` row stays — it is the audit trail, not
the queue).
