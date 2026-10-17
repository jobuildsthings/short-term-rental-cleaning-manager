CREATE TABLE "access_instruction_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"instructions_encrypted" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agency_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_name" text NOT NULL,
	"dispatcher_user_id" uuid NOT NULL,
	"contact_phone" text NOT NULL,
	"contact_email" text NOT NULL,
	CONSTRAINT "agency_settings_dispatcher_user_id_unique" UNIQUE("dispatcher_user_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"photo_required" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cleaning_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"reservation_id" uuid,
	"series_id" uuid,
	"occurrence_date" date,
	"stable_key" text NOT NULL,
	"title" text NOT NULL,
	"job_type" text NOT NULL,
	"scheduled_date" date NOT NULL,
	"start_time" time DEFAULT '11:00' NOT NULL,
	"end_time" time DEFAULT '15:00' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"assigned_to_user_id" uuid,
	"checklist_template_id" uuid,
	"google_event_id" text,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"cancel_reason" text,
	"confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cleaning_jobs_stable_key_unique" UNIQUE("stable_key"),
	CONSTRAINT "cleaning_jobs_status_check" CHECK (status IN ('draft','scheduled','assigned','confirmed','in_progress','completed','declined','cancelled')),
	CONSTRAINT "cleaning_jobs_type_check" CHECK (job_type IN ('turnover','recurring','deep_clean','restock','maintenance','other'))
);
--> statement-breakpoint
CREATE TABLE "google_oauth_tokens" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"refresh_token_encrypted" text,
	"scope" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ical_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" text,
	"last_sync_error" text
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'dispatcher' NOT NULL,
	"property_ids" uuid[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_unique" UNIQUE("token"),
	CONSTRAINT "invites_role_check" CHECK (role IN ('owner','dispatcher'))
);
--> statement-breakpoint
CREATE TABLE "job_checklist_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"checklist_item_id" uuid NOT NULL,
	"is_done" boolean DEFAULT false NOT NULL,
	"photo_url" text,
	"completed_at" timestamp with time zone,
	"completed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_role_check" CHECK (role IN ('owner','dispatcher'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "occurrence_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"action" text NOT NULL,
	"new_date" date,
	"new_start_time" time,
	"new_end_time" time,
	CONSTRAINT "occurrence_overrides_action_check" CHECK (action IN ('rescheduled','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"listing_url" text,
	"listing_title" text,
	"listing_address" text,
	"listing_photo_urls" text[],
	"listing_last_refreshed_at" timestamp with time zone,
	"timezone" text DEFAULT 'America/Los_Angeles' NOT NULL,
	"default_window_start" time DEFAULT '11:00' NOT NULL,
	"default_window_end" time DEFAULT '15:00' NOT NULL,
	"checkin_time" time,
	"checkout_time" time,
	"turnover_buffer_minutes" integer DEFAULT 0 NOT NULL,
	"reminder_hours_before" integer[] DEFAULT '{24,2}' NOT NULL,
	"access_instructions" text,
	"access_instructions_updated_at" timestamp with time zone,
	"access_instructions_updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recap_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_starting" date NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "recurring_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"title" text NOT NULL,
	"rrule" jsonb NOT NULL,
	"default_start_time" time DEFAULT '11:00' NOT NULL,
	"default_end_time" time DEFAULT '15:00' NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ical_feed_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"uid" text NOT NULL,
	"guest_name" text,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"google_sub" text,
	"avatar_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
ALTER TABLE "access_instruction_history" ADD CONSTRAINT "access_instruction_history_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_instruction_history" ADD CONSTRAINT "access_instruction_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_dispatcher_user_id_users_id_fk" FOREIGN KEY ("dispatcher_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."checklist_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_series_id_recurring_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."recurring_series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_checklist_template_id_checklist_templates_id_fk" FOREIGN KEY ("checklist_template_id") REFERENCES "public"."checklist_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_oauth_tokens" ADD CONSTRAINT "google_oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ical_feeds" ADD CONSTRAINT "ical_feeds_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_checklist_results" ADD CONSTRAINT "job_checklist_results_job_id_cleaning_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."cleaning_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_checklist_results" ADD CONSTRAINT "job_checklist_results_checklist_item_id_checklist_items_id_fk" FOREIGN KEY ("checklist_item_id") REFERENCES "public"."checklist_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_checklist_results" ADD CONSTRAINT "job_checklist_results_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_job_id_cleaning_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."cleaning_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence_overrides" ADD CONSTRAINT "occurrence_overrides_series_id_recurring_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."recurring_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_access_instructions_updated_by_users_id_fk" FOREIGN KEY ("access_instructions_updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_job_id_cleaning_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."cleaning_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_ical_feed_id_ical_feeds_id_fk" FOREIGN KEY ("ical_feed_id") REFERENCES "public"."ical_feeds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_templates_property_name_uidx" ON "checklist_templates" USING btree ("property_id","name");--> statement-breakpoint
CREATE INDEX "cleaning_jobs_property_date_idx" ON "cleaning_jobs" USING btree ("property_id","scheduled_date");--> statement-breakpoint
CREATE INDEX "cleaning_jobs_status_idx" ON "cleaning_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "job_checklist_results_job_item_uidx" ON "job_checklist_results" USING btree ("job_id","checklist_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_property_uidx" ON "memberships" USING btree ("user_id","property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "occurrence_overrides_series_date_uidx" ON "occurrence_overrides" USING btree ("series_id","occurrence_date");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_feed_uid_uidx" ON "reservations" USING btree ("ical_feed_id","uid");