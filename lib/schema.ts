/**
 * Database schema — mirrors Phase 0 contracts §1 exactly.
 *
 * Conventions (binding):
 * - Canonical timezone America/Los_Angeles. Wall-clock job times are
 *   `date` + `time` interpreted in the property's timezone.
 * - All ids are uuid PKs, generated server-side (gen_random_uuid()).
 * - No soft deletes. Audit log is append-only.
 * - The word "cleaner" (individual) never appears: the only agency user
 *   is the dispatcher.
 * - Brand-neutral: no brand or personal names anywhere in this file.
 */
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

/** users — one row per human. Google OAuth only, invite-only, no passwords. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  googleSub: text("google_sub").unique(),
  avatarUrl: text("avatar_url"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** memberships — user × property × role. This is the row-scoping root. */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    role: text("role").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("memberships_user_property_uidx").on(t.userId, t.propertyId),
    check("memberships_role_check", sql`role IN ('owner','dispatcher')`),
  ],
);

/**
 * agency_settings — singleton row for the cleaning agency.
 * agency_name is set at deploy from env/seed config — never a real name in git.
 */
export const agencySettings = pgTable("agency_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  agencyName: text("agency_name").notNull(),
  dispatcherUserId: uuid("dispatcher_user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  contactPhone: text("contact_phone").notNull(),
  contactEmail: text("contact_email").notNull(),
  // Shared "Cleanings" calendar in the owner's Google account.
  // Provisioned by the calendar sync (Workstream E); NULL until then.
  googleCalendarId: text("google_calendar_id"),
  googleCalendarShared: boolean("google_calendar_shared").notNull().default(false),
});

/** properties — one row per short-term rental. */
export const properties = pgTable("properties", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  listingUrl: text("listing_url"),
  listingTitle: text("listing_title"),
  listingAddress: text("listing_address"),
  listingPhotoUrls: text("listing_photo_urls").array(),
  listingLastRefreshedAt: timestamptz("listing_last_refreshed_at"),
  timezone: text("timezone").notNull().default("America/Los_Angeles"),
  // Default cleaning window 11:00–15:00; overridable per property and per job.
  defaultWindowStart: time("default_window_start").notNull().default("11:00"),
  defaultWindowEnd: time("default_window_end").notNull().default("15:00"),
  checkinTime: time("checkin_time"),
  checkoutTime: time("checkout_time"),
  turnoverBufferMinutes: integer("turnover_buffer_minutes").notNull().default(0),
  reminderHoursBefore: integer("reminder_hours_before").array().notNull().default([24, 2]),
  // Application-layer encrypted (see lib/crypto.ts). NEVER logged.
  accessInstructions: text("access_instructions"),
  accessInstructionsUpdatedAt: timestamptz("access_instructions_updated_at"),
  accessInstructionsUpdatedBy: uuid("access_instructions_updated_by").references(
    () => users.id,
  ),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

/** access_instruction_history — append-only prior values (encrypted). */
export const accessInstructionHistory = pgTable("access_instruction_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  propertyId: uuid("property_id")
    .notNull()
    .references(() => properties.id),
  instructionsEncrypted: text("instructions_encrypted").notNull(),
  changedAt: timestamptz("changed_at").notNull().defaultNow(),
  changedBy: uuid("changed_by")
    .notNull()
    .references(() => users.id),
});

/** checklist_templates — per-property reusable checklists. */
export const checklistTemplates = pgTable(
  "checklist_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("checklist_templates_property_name_uidx").on(t.propertyId, t.name)],
);

export const checklistItems = pgTable("checklist_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id")
    .notNull()
    .references(() => checklistTemplates.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  photoRequired: boolean("photo_required").notNull().default(false),
});

/** ical_feeds — booking-calendar feeds. URLs are secrets: never logged. */
export const icalFeeds = pgTable("ical_feeds", {
  id: uuid("id").primaryKey().defaultRandom(),
  propertyId: uuid("property_id")
    .notNull()
    .references(() => properties.id),
  label: text("label").notNull(),
  url: text("url").notNull(),
  lastSyncedAt: timestamptz("last_synced_at"),
  lastSyncStatus: text("last_sync_status"),
  lastSyncError: text("last_sync_error"),
});

/** reservations — from iCal, keyed by (feed, UID). */
export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    icalFeedId: uuid("ical_feed_id")
      .notNull()
      .references(() => icalFeeds.id),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    uid: text("uid").notNull(),
    guestName: text("guest_name"),
    checkIn: date("check_in", { mode: "string" }).notNull(),
    checkOut: date("check_out", { mode: "string" }).notNull(),
  },
  (t) => [uniqueIndex("reservations_feed_uid_uidx").on(t.icalFeedId, t.uid)],
);

/** recurring_series — e.g. weekly Wednesday clean of the lived-in unit. */
export const recurringSeries = pgTable("recurring_series", {
  id: uuid("id").primaryKey().defaultRandom(),
  propertyId: uuid("property_id")
    .notNull()
    .references(() => properties.id),
  title: text("title").notNull(),
  // {freq:'weekly'|'monthly', interval:int, weekdays:[0-6], until:date|null, count:int|null}
  rrule: jsonb("rrule").notNull(),
  defaultStartTime: time("default_start_time").notNull().default("11:00"),
  defaultEndTime: time("default_end_time").notNull().default("15:00"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

/** occurrence_overrides — "this occurrence" edits (GCal-style). */
export const occurrenceOverrides = pgTable(
  "occurrence_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => recurringSeries.id, { onDelete: "cascade" }),
    occurrenceDate: date("occurrence_date", { mode: "string" }).notNull(), // YYYY-MM-DD
    action: text("action").notNull(),
    newDate: date("new_date", { mode: "string" }),
    newStartTime: time("new_start_time"),
    newEndTime: time("new_end_time"),
  },
  (t) => [
    uniqueIndex("occurrence_overrides_series_date_uidx").on(t.seriesId, t.occurrenceDate),
    check("occurrence_overrides_action_check", sql`action IN ('rescheduled','cancelled')`),
  ],
);

/** cleaning_jobs — the core entity. Status machine enforced server-side. */
export const cleaningJobs = pgTable(
  "cleaning_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    reservationId: uuid("reservation_id").references(() => reservations.id),
    seriesId: uuid("series_id").references(() => recurringSeries.id),
    occurrenceDate: date("occurrence_date", { mode: "string" }),
    stableKey: text("stable_key").notNull().unique(), // idempotency key
    title: text("title").notNull(),
    jobType: text("job_type").notNull(),
    scheduledDate: date("scheduled_date", { mode: "string" }).notNull(),
    startTime: time("start_time").notNull().default("11:00"),
    endTime: time("end_time").notNull().default("15:00"),
    status: text("status").notNull().default("draft"),
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id),
    checklistTemplateId: uuid("checklist_template_id").references(
      () => checklistTemplates.id,
    ),
    googleEventId: text("google_event_id"),
    needsAttention: boolean("needs_attention").notNull().default(false),
    cancelReason: text("cancel_reason"),
    confirmedAt: timestamptz("confirmed_at"),
    completedAt: timestamptz("completed_at"),
    cancelledAt: timestamptz("cancelled_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("cleaning_jobs_property_date_idx").on(t.propertyId, t.scheduledDate),
    index("cleaning_jobs_status_idx").on(t.status),
    check(
      "cleaning_jobs_status_check",
      sql`status IN ('draft','scheduled','assigned','confirmed','in_progress','completed','declined','cancelled')`,
    ),
    check(
      "cleaning_jobs_type_check",
      sql`job_type IN ('turnover','recurring','deep_clean','restock','maintenance','other')`,
    ),
  ],
);

export const JOB_STATUSES = [
  "draft",
  "scheduled",
  "assigned",
  "confirmed",
  "in_progress",
  "completed",
  "declined",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** job_checklist_results — per-job checklist progress. Photos: Phase 2. */
export const jobChecklistResults = pgTable(
  "job_checklist_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => cleaningJobs.id, { onDelete: "cascade" }),
    checklistItemId: uuid("checklist_item_id")
      .notNull()
      .references(() => checklistItems.id),
    isDone: boolean("is_done").notNull().default(false),
    photoUrl: text("photo_url"), // Phase 2
    completedAt: timestamptz("completed_at"),
    completedBy: uuid("completed_by").references(() => users.id),
  },
  (t) => [uniqueIndex("job_checklist_results_job_item_uidx").on(t.jobId, t.checklistItemId)],
);

/** messages — per-job threads, immutable. */
export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => cleaningJobs.id, { onDelete: "cascade" }),
  senderUserId: uuid("sender_user_id")
    .notNull()
    .references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** reminders — scheduled sends, metadata only. Bodies rendered at send time. */
export const reminders = pgTable("reminders", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => cleaningJobs.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  recipient: text("recipient").notNull(),
  scheduledFor: timestamptz("scheduled_for").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/** recap_runs — Saturday recap audit. */
export const recapRuns = pgTable("recap_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  weekStarting: date("week_starting", { mode: "string" }).notNull(), // Monday
  generatedAt: timestamptz("generated_at").notNull().defaultNow(),
  sentAt: timestamptz("sent_at"),
  status: text("status").notNull().default("pending"),
  error: text("error"),
});

/** audit_log — append-only. Metadata must NEVER contain instruction values,
 *  feed URLs, or message bodies. */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorType: text("actor_type").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/**
 * invites — NOT in contracts §1 (gap filled by foundation): backs the
 * invite-only flow. Single-use, 7-day expiry.
 */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull().unique(),
    email: text("email").notNull(),
    role: text("role").notNull().default("dispatcher"),
    propertyIds: uuid("property_ids").array().notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    usedAt: timestamptz("used_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  () => [check("invites_role_check", sql`role IN ('owner','dispatcher')`)],
);

/**
 * google_oauth_tokens — NOT in contracts §1 (gap filled by foundation):
 * the OWNER connects their Google account at sign-in with Calendar scope
 * (shared "Cleanings" calendar model, spec update 2026-10-17); the
 * dispatcher signs in with Google for identity only (no calendar scope).
 * Refresh tokens are secrets: encrypted at rest (see lib/crypto.ts),
 * never logged. The calendar event sync itself is Workstream E.
 */
export const googleOauthTokens = pgTable("google_oauth_tokens", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  scope: text("scope"),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});
