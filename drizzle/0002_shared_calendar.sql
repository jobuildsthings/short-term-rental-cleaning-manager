-- 0002_shared_calendar.sql — storage for the shared "Cleanings" calendar.
--
-- Calendar model (spec update 2026-10-17): the app manages ONE dedicated
-- calendar in the OWNER's Google account, shared with the dispatcher's
-- Google address. Only the owner grants Calendar OAuth scope at sign-in;

--> statement-breakpoint

-- the dispatcher signs in with Google for identity only.
-- Provisioning (create/find calendar + share with dispatcher) is Workstream E.
-- These columns are the contract between foundation storage and E's sync.



ALTER TABLE public.agency_settings
  ADD COLUMN IF NOT EXISTS google_calendar_id text,
  ADD COLUMN IF NOT EXISTS google_calendar_shared boolean NOT NULL DEFAULT false;

--> statement-breakpoint

COMMENT ON COLUMN public.agency_settings.google_calendar_id IS
  'Id of the dedicated shared calendar in the owner Google account. Written by the calendar sync (Workstream E). NULL until provisioned.';

--> statement-breakpoint

COMMENT ON COLUMN public.agency_settings.google_calendar_shared IS
  'Whether the dispatcher has been granted reader access via the Calendar ACL API. Managed by the calendar sync (Workstream E).';
