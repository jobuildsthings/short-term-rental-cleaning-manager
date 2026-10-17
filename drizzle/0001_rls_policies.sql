-- 0001_rls.sql — Row-Level Security: database-level enforcement of the
-- permission matrix (contracts §3).
--
-- Design:
-- * The app connects as role `app` (least privilege, owns nothing) via
--   APP_DATABASE_URL. RLS applies to every query it runs.
-- * Migrations/seeds/scheduler use the owner connection (DATABASE_URL),
--   which bypasses RLS. No service-role bypass exists in request code paths.
-- * Request code MUST wrap queries in withUser(userId) (lib/db.ts), which
--   opens a transaction and runs SET LOCAL app.user_id = '<uuid>'.
--   Without it, app_user_id() is NULL and every policy denies: fail-closed.
-- * Helper functions are SECURITY DEFINER (owned by the migrator) so the
--   internal membership lookups bypass RLS without recursive policies.



CREATE OR REPLACE FUNCTION public.app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_is_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = public.app_user_id() AND role = 'owner'
  )
$$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_can_access_property(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT public.app_is_owner() OR EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = public.app_user_id() AND property_id = p_id
  )
$$;

--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app NOLOGIN;
  END IF;
END $$;

--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;

--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;

--> statement-breakpoint

-- users: own row readable/updatable; owner reads all; inserts via admin only.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY users_select ON public.users FOR SELECT
  USING (id = public.app_user_id() OR public.app_is_owner());

--> statement-breakpoint

CREATE POLICY users_update_own ON public.users FOR UPDATE
  USING (id = public.app_user_id()) WITH CHECK (id = public.app_user_id());

--> statement-breakpoint

-- memberships: the scoping root. Reads are self-or-owner; writes are admin-only.
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY memberships_select ON public.memberships FOR SELECT
  USING (user_id = public.app_user_id() OR public.app_is_owner());

--> statement-breakpoint

-- invites: owner only.
ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY invites_owner_all ON public.invites FOR ALL
  USING (public.app_is_owner()) WITH CHECK (public.app_is_owner());

--> statement-breakpoint

-- agency_settings: owner manages; dispatcher reads her own row.
ALTER TABLE public.agency_settings ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY agency_settings_select ON public.agency_settings FOR SELECT
  USING (public.app_is_owner() OR dispatcher_user_id = public.app_user_id());

--> statement-breakpoint

CREATE POLICY agency_settings_update ON public.agency_settings FOR UPDATE
  USING (public.app_is_owner()) WITH CHECK (public.app_is_owner());

--> statement-breakpoint

-- properties
ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY properties_select ON public.properties FOR SELECT
  USING (public.app_can_access_property(id));

--> statement-breakpoint

CREATE POLICY properties_insert ON public.properties FOR INSERT
  WITH CHECK (public.app_is_owner());

--> statement-breakpoint

CREATE POLICY properties_update ON public.properties FOR UPDATE
  USING (public.app_is_owner()) WITH CHECK (public.app_is_owner());

--> statement-breakpoint

CREATE POLICY properties_delete ON public.properties FOR DELETE
  USING (public.app_is_owner());

--> statement-breakpoint

-- access_instruction_history: owner-only reads; owner-only appends.
ALTER TABLE public.access_instruction_history ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY aih_select ON public.access_instruction_history FOR SELECT
  USING (public.app_is_owner());

--> statement-breakpoint

CREATE POLICY aih_insert ON public.access_instruction_history FOR INSERT
  WITH CHECK (public.app_is_owner());

--> statement-breakpoint

-- checklist_templates
ALTER TABLE public.checklist_templates ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY ct_select ON public.checklist_templates FOR SELECT
  USING (public.app_can_access_property(property_id));

--> statement-breakpoint

CREATE POLICY ct_write ON public.checklist_templates FOR ALL
  USING (public.app_is_owner()) WITH CHECK (public.app_is_owner());

--> statement-breakpoint

-- checklist_items (scoped through their template's property)
ALTER TABLE public.checklist_items ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY ci_select ON public.checklist_items FOR SELECT USING (
  public.app_is_owner() OR EXISTS (
    SELECT 1 FROM public.checklist_templates t
    WHERE t.id = checklist_items.template_id
      AND public.app_can_access_property(t.property_id)
  )
);

--> statement-breakpoint

CREATE POLICY ci_write ON public.checklist_items FOR ALL
  USING (public.app_is_owner()) WITH CHECK (public.app_is_owner());

--> statement-breakpoint

-- ical_feeds: owner only (dispatcher must never see feed URLs)
ALTER TABLE public.ical_feeds ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY ical_owner_all ON public.ical_feeds FOR ALL
  USING (public.app_is_owner()) WITH CHECK (public.app_is_owner());

--> statement-breakpoint

-- reservations: scoped reads; writes via scheduler/admin only
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY reservations_select ON public.reservations FOR SELECT
  USING (public.app_can_access_property(property_id));

--> statement-breakpoint

-- recurring_series
ALTER TABLE public.recurring_series ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY rs_select ON public.recurring_series FOR SELECT
  USING (public.app_can_access_property(property_id));

--> statement-breakpoint

CREATE POLICY rs_write ON public.recurring_series FOR ALL
  USING (public.app_is_owner()) WITH CHECK (public.app_is_owner());

--> statement-breakpoint

-- occurrence_overrides (scoped through their series' property)
ALTER TABLE public.occurrence_overrides ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY oo_select ON public.occurrence_overrides FOR SELECT USING (
  public.app_is_owner() OR EXISTS (
    SELECT 1 FROM public.recurring_series s
    WHERE s.id = occurrence_overrides.series_id
      AND public.app_can_access_property(s.property_id)
  )
);

--> statement-breakpoint

CREATE POLICY oo_write ON public.occurrence_overrides FOR ALL
  USING (public.app_is_owner()) WITH CHECK (public.app_is_owner());

--> statement-breakpoint

-- cleaning_jobs: property-scoped reads; owner creates/deletes;

--> statement-breakpoint

-- updates allowed within scope (fine-grained status auth lives in API handlers)
ALTER TABLE public.cleaning_jobs ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY cj_select ON public.cleaning_jobs FOR SELECT
  USING (public.app_can_access_property(property_id));

--> statement-breakpoint

CREATE POLICY cj_insert ON public.cleaning_jobs FOR INSERT
  WITH CHECK (public.app_is_owner());

--> statement-breakpoint

CREATE POLICY cj_update ON public.cleaning_jobs FOR UPDATE
  USING (public.app_can_access_property(property_id))
  WITH CHECK (public.app_can_access_property(property_id));

--> statement-breakpoint

CREATE POLICY cj_delete ON public.cleaning_jobs FOR DELETE
  USING (public.app_is_owner());

--> statement-breakpoint

-- job_checklist_results: dispatcher limited to jobs assigned to them
ALTER TABLE public.job_checklist_results ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY jcr_select ON public.job_checklist_results FOR SELECT USING (
  public.app_is_owner() OR EXISTS (
    SELECT 1 FROM public.cleaning_jobs j
    WHERE j.id = job_checklist_results.job_id
      AND public.app_can_access_property(j.property_id)
      AND j.assigned_to_user_id = public.app_user_id()
  )
);

--> statement-breakpoint

CREATE POLICY jcr_write ON public.job_checklist_results FOR ALL USING (
  public.app_is_owner() OR EXISTS (
    SELECT 1 FROM public.cleaning_jobs j
    WHERE j.id = job_checklist_results.job_id
      AND public.app_can_access_property(j.property_id)
      AND j.assigned_to_user_id = public.app_user_id()
  )
) WITH CHECK (
  public.app_is_owner() OR EXISTS (
    SELECT 1 FROM public.cleaning_jobs j
    WHERE j.id = job_checklist_results.job_id
      AND public.app_can_access_property(j.property_id)
      AND j.assigned_to_user_id = public.app_user_id()
  )
);

--> statement-breakpoint

-- messages: immutable threads; dispatcher limited to assigned jobs' threads
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY messages_select ON public.messages FOR SELECT USING (
  public.app_is_owner() OR EXISTS (
    SELECT 1 FROM public.cleaning_jobs j
    WHERE j.id = messages.job_id
      AND public.app_can_access_property(j.property_id)
      AND j.assigned_to_user_id = public.app_user_id()
  )
);

--> statement-breakpoint

CREATE POLICY messages_insert ON public.messages FOR INSERT WITH CHECK (
  public.app_is_owner() OR EXISTS (
    SELECT 1 FROM public.cleaning_jobs j
    WHERE j.id = messages.job_id
      AND public.app_can_access_property(j.property_id)
      AND j.assigned_to_user_id = public.app_user_id()
  )
);

--> statement-breakpoint

-- reminders: owner reads; rows written by the scheduler (admin)
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY reminders_select ON public.reminders FOR SELECT
  USING (public.app_is_owner());

--> statement-breakpoint

-- recap_runs: owner reads; rows written by the scheduler (admin)
ALTER TABLE public.recap_runs ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY recap_select ON public.recap_runs FOR SELECT
  USING (public.app_is_owner());

--> statement-breakpoint

-- audit_log: owner reads; any signed-in context may append (never modify)
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY audit_select ON public.audit_log FOR SELECT
  USING (public.app_is_owner());

--> statement-breakpoint

CREATE POLICY audit_insert ON public.audit_log FOR INSERT
  WITH CHECK (public.app_user_id() IS NOT NULL);

--> statement-breakpoint

-- google_oauth_tokens: users manage only their own row
ALTER TABLE public.google_oauth_tokens ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY got_select ON public.google_oauth_tokens FOR SELECT
  USING (user_id = public.app_user_id());

--> statement-breakpoint

CREATE POLICY got_write ON public.google_oauth_tokens FOR ALL
  USING (user_id = public.app_user_id())
  WITH CHECK (user_id = public.app_user_id());
