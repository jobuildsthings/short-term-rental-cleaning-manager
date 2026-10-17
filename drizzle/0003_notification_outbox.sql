-- 0003_notification_outbox.sql — Workstream E: notification outbox tables,
-- SMS device-bridge queue, and configurable recap schedule.
--
-- notification_outbox: the durable home for message-fallback notification
-- intents (contracts §4.22), per the Workstream D decision doc
-- (docs/decisions/2026-10-17-message-notification-outbox.md). The audit-log
-- convention D implemented stays as the audit trail; this table is the
-- queue the worker drains.
--
-- sms_outbox: reference-only queue for SMS that must go out through the
-- owner's paired phone (device bridge). Bodies are NEVER stored here —
-- they are rendered at send/drain time from the referenced reminder or
-- notification, using the CURRENT access instructions (contracts §4.14).
-- See docs/sms-device-bridge.md.
--
-- agency_settings.recap_weekday / recap_time: configurable recap schedule
-- (contracts §7.11: Saturday 08:00 America/Los_Angeles by default).
-- recap_weekday follows JavaScript's Date.getDay(): 0=Sunday … 6=Saturday.

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.notification_outbox (
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

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.sms_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id uuid REFERENCES public.reminders(id) ON DELETE CASCADE,
  notification_id uuid REFERENCES public.notification_outbox(id) ON DELETE CASCADE,
  to_phone text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CHECK (reminder_id IS NOT NULL OR notification_id IS NOT NULL)
);

--> statement-breakpoint

ALTER TABLE public.agency_settings
  ADD COLUMN IF NOT EXISTS recap_weekday integer NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS recap_time time NOT NULL DEFAULT '08:00';

--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recap_runs_week_starting_unique'
  ) THEN
    ALTER TABLE public.recap_runs
      ADD CONSTRAINT recap_runs_week_starting_unique UNIQUE (week_starting);
  END IF;
END $$;

--> statement-breakpoint

COMMENT ON TABLE public.notification_outbox IS
  'Durable queue for message-fallback notification intents (contracts §4.22). Drained by the reminder worker.';

--> statement-breakpoint

COMMENT ON TABLE public.sms_outbox IS
  'Reference-only queue for SMS sent via the owner-phone device bridge. NEVER stores message bodies — bodies render at drain time from the referenced row using current access instructions (contracts §4.14). See docs/sms-device-bridge.md.';

--> statement-breakpoint

COMMENT ON COLUMN public.agency_settings.recap_weekday IS
  'Weekday for the recap email, JavaScript getDay() convention (0=Sunday … 6=Saturday). Default 6 (Saturday).';

--> statement-breakpoint

-- RLS: owner reads the queues; the dispatcher never manages them (she
-- receives sends). The worker uses the admin connection and bypasses RLS.
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY no_select ON public.notification_outbox FOR SELECT
  USING (public.app_is_owner());

--> statement-breakpoint

ALTER TABLE public.sms_outbox ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY so_select ON public.sms_outbox FOR SELECT
  USING (public.app_is_owner());

--> statement-breakpoint
