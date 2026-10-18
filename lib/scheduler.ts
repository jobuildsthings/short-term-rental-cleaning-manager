/**
 * Scheduling engine (Workstream B).
 *
 * Turns booking-calendar reservations into turnover jobs, keeps them in sync
 * idempotently, expands recurring series, and enforces the job state machine.
 * All dates are YYYY-MM-DD calendar dates; all times are wall-clock in
 * America/Los_Angeles (contracts: always PT, regardless of viewer location).
 *
 * Reliability rules (contracts §4):
 * - Re-running the engine on identical input changes nothing (stable_key
 *   upserts). Never duplicates, never silently deletes.
 * - A reservation that vanishes from a feed cancels its auto job only while
 *   the job is still unconfirmed; confirmed-or-later jobs are flagged for
 *   the owner instead of being touched.
 * - A job the owner manually rescheduled is never moved back by the engine:
 *   only reservations whose dates actually changed drive job moves.
 * - Workstream E hooks (reminders, calendar) are marked inline; this module
 *   only writes the reminders.status='skipped' bookkeeping the contracts
 *   require on cancel/complete.
 */
import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { audit } from "./audit";
import { badRequest, forbidden, notFound } from "./api";
import { getDbAdmin, type Tx } from "./db";
import { fetchIcalFeed, parseIcs, ymdInTimeZone, type ParsedIcalEvent } from "./ical";
import { canTransition, type Role } from "./job-transitions";
import { addDays, expandRrule, validateRrule, type RruleInput } from "./recurrence";
import {
  cleaningJobs,
  icalFeeds,
  memberships,
  occurrenceOverrides,
  properties,
  recurringSeries,
  reminders,
  reservations,
  type JobStatus,
} from "./schema";
import { APP_TIME_ZONE } from "./time";

type Property = typeof properties.$inferSelect;
type Series = typeof recurringSeries.$inferSelect;
export type CleaningJob = typeof cleaningJobs.$inferSelect;

/** API-facing job shape (snake_case, per contracts §2). */
export function serializeJob(j: CleaningJob) {
  return {
    id: j.id,
    property_id: j.propertyId,
    reservation_id: j.reservationId,
    series_id: j.seriesId,
    occurrence_date: j.occurrenceDate,
    stable_key: j.stableKey,
    title: j.title,
    job_type: j.jobType,
    scheduled_date: j.scheduledDate,
    start_time: j.startTime.slice(0, 5),
    end_time: j.endTime.slice(0, 5),
    status: j.status,
    assigned_to_user_id: j.assignedToUserId,
    checklist_template_id: j.checklistTemplateId,
    google_event_id: j.googleEventId,
    needs_attention: j.needsAttention,
    cancel_reason: j.cancelReason,
    confirmed_at: j.confirmedAt,
    completed_at: j.completedAt,
    cancelled_at: j.cancelledAt,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
  };
}

export const APP_TZ = APP_TIME_ZONE;

/** YYYY-MM-DD for "today" in America/Los_Angeles. */
export function todayPT(now = new Date()): string {
  return ymdInTimeZone(now, APP_TZ);
}

/** Idempotency keys (contracts §4). */
export const turnoverStableKey = (feedId: string, uid: string) => `turnover:${feedId}:${uid}`;
export const seriesStableKey = (seriesId: string, occurrenceDate: string) =>
  `series:${seriesId}:${occurrenceDate}`;

function minutesOf(t: string): number {
  const [h = "0", m = "0"] = t.split(":");
  return Number(h) * 60 + Number(m);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ownerIdForProperty(tx: Tx, propertyId: string): Promise<string> {
  const rows = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.propertyId, propertyId), eq(memberships.role, "owner")))
    .limit(1);
  if (!rows[0]) throw new Error(`no owner membership for property ${propertyId}`);
  return rows[0].userId;
}

// ---------------------------------------------------------------------------
// iCal sync
// ---------------------------------------------------------------------------

export interface FeedSyncResult {
  feedId: string;
  status: "ok" | "error";
  reservationsUpserted: number;
  reservationsRemoved: number;
  jobsCreated: number;
  jobsUpdated: number;
  jobsCancelled: number;
  jobsFlagged: number;
  error?: string;
}

export interface FetchedFeed {
  ok: true;
  events: ParsedIcalEvent[];
  skipped: number;
}

export type FetchFeedResult = FetchedFeed | { ok: false; error: string };

/**
 * Fetch + parse a feed. Network happens OUTSIDE any DB transaction —
 * callers then pass the result to applyFeedSync. Feed URLs never appear in
 * errors (they are secrets).
 */
export async function fetchFeedEvents(feedUrl: string, timeZone: string): Promise<FetchFeedResult> {
  try {
    const ics = await fetchIcalFeed(feedUrl);
    const { events, skipped } = parseIcs(ics, timeZone);
    return { ok: true, events, skipped };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "feed fetch failed" };
  }
}

/**
 * Apply a fetched feed to the database: upsert reservations, handle
 * removals, and reconcile turnover jobs. Idempotent.
 */
export async function applyFeedSync(
  tx: Tx,
  feedId: string,
  fetched: FetchFeedResult,
): Promise<FeedSyncResult> {
  const [feed] = await tx.select().from(icalFeeds).where(eq(icalFeeds.id, feedId)).limit(1);
  if (!feed) throw notFound("Feed not found");
  const [property] = await tx
    .select()
    .from(properties)
    .where(eq(properties.id, feed.propertyId))
    .limit(1);
  if (!property) throw notFound("Property not found");

  const result: FeedSyncResult = {
    feedId,
    status: "ok",
    reservationsUpserted: 0,
    reservationsRemoved: 0,
    jobsCreated: 0,
    jobsUpdated: 0,
    jobsCancelled: 0,
    jobsFlagged: 0,
  };

  if (!fetched.ok) {
    await tx
      .update(icalFeeds)
      .set({ lastSyncedAt: nowIso(), lastSyncStatus: "error", lastSyncError: fetched.error })
      .where(eq(icalFeeds.id, feedId));
    await audit(tx, {
      actorType: "system",
      action: "ical.sync_failed",
      entityType: "ical_feed",
      entityId: feedId,
      metadata: { error: fetched.error }, // never the URL
    });
    result.status = "error";
    result.error = fetched.error;
    return result;
  }

  const existing = await tx
    .select()
    .from(reservations)
    .where(eq(reservations.icalFeedId, feedId));
  const byUid = new Map(existing.map((r) => [r.uid, r]));
  const seen = new Set<string>();
  /** Reservations whose dates are new or changed — the only ones allowed to move jobs. */
  const changedIds = new Set<string>();

  for (const ev of fetched.events) {
    if (ev.cancelled) continue; // treated as removed below
    seen.add(ev.uid);
    const cur = byUid.get(ev.uid);
    if (!cur) {
      const [ins] = await tx
        .insert(reservations)
        .values({
          icalFeedId: feedId,
          propertyId: feed.propertyId,
          uid: ev.uid,
          guestName: ev.summary,
          checkIn: ev.checkIn,
          checkOut: ev.checkOut,
        })
        .returning({ id: reservations.id });
      changedIds.add(ins!.id);
      result.reservationsUpserted++;
    } else if (
      cur.checkIn !== ev.checkIn ||
      cur.checkOut !== ev.checkOut ||
      (cur.guestName ?? null) !== ev.summary
    ) {
      await tx
        .update(reservations)
        .set({ guestName: ev.summary, checkIn: ev.checkIn, checkOut: ev.checkOut })
        .where(eq(reservations.id, cur.id));
      changedIds.add(cur.id);
      result.reservationsUpserted++;
    }
  }

  // Reservations that vanished from the feed (or are now STATUS:CANCELLED).
  for (const r of existing) {
    if (seen.has(r.uid)) continue;
    const key = turnoverStableKey(feedId, r.uid);
    const [job] = await tx
      .select()
      .from(cleaningJobs)
      .where(eq(cleaningJobs.stableKey, key))
      .limit(1);
    if (job && ["draft", "scheduled", "assigned"].includes(job.status)) {
      await transitionJob(
        tx,
        job.id,
        "cancelled",
        { kind: "system", userId: null, role: "owner" },
        { reason: "reservation removed" },
      );
      result.jobsCancelled++;
    } else if (job && ["confirmed", "in_progress"].includes(job.status)) {
      // Never auto-cancel a confirmed job — flag it for the owner instead.
      await tx
        .update(cleaningJobs)
        .set({ needsAttention: true, updatedAt: nowIso() })
        .where(eq(cleaningJobs.id, job.id));
      await audit(tx, {
        actorType: "system",
        action: "job.flagged",
        entityType: "cleaning_job",
        entityId: job.id,
        metadata: { reason: "reservation_removed" },
      });
      result.jobsFlagged++;
    }
    if (job) {
      // Break the FK before the reservation row is deleted; the job keeps
      // its stable_key and audit trail. Re-linked if the reservation returns.
      await tx
        .update(cleaningJobs)
        .set({ reservationId: null, updatedAt: nowIso() })
        .where(eq(cleaningJobs.id, job.id));
    }
    await tx.delete(reservations).where(eq(reservations.id, r.id));
    await audit(tx, {
      actorType: "system",
      action: "reservation.removed",
      entityType: "reservation",
      entityId: r.id,
      metadata: { feed_id: feedId },
    });
    result.reservationsRemoved++;
  }

  const recon = await reconcileTurnoverJobs(tx, property, changedIds);
  result.jobsCreated += recon.created;
  result.jobsUpdated += recon.updated;
  result.jobsFlagged += recon.flagged;

  await tx
    .update(icalFeeds)
    .set({ lastSyncedAt: nowIso(), lastSyncStatus: "ok", lastSyncError: null })
    .where(eq(icalFeeds.id, feedId));
  await audit(tx, {
    actorType: "system",
    action: "ical.synced",
    entityType: "ical_feed",
    entityId: feedId,
    metadata: {
      upserted: result.reservationsUpserted,
      removed: result.reservationsRemoved,
      jobs_created: result.jobsCreated,
    },
  });
  return result;
}

/**
 * Derive turnover jobs from a property's reservations (contracts §4 rules 4-8).
 * Idempotent: re-running on identical input changes nothing.
 *
 * @param changedReservationIds reservations whose dates are new/changed —
 *   only these may move an existing job's date. A job whose date differs
 *   without its reservation changing was moved by the owner; leave it alone.
 */
export async function reconcileTurnoverJobs(
  tx: Tx,
  property: Property,
  changedReservationIds: Set<string>,
): Promise<{ created: number; updated: number; flagged: number }> {
  const out = { created: 0, updated: 0, flagged: 0 };
  const rows = await tx
    .select()
    .from(reservations)
    .where(eq(reservations.propertyId, property.id))
    .orderBy(reservations.checkIn, reservations.checkOut);
  if (rows.length === 0) return out;

  const createdBy = await ownerIdForProperty(tx, property.id);
  const defaultStart = property.defaultWindowStart.slice(0, 5);
  const defaultEnd = property.defaultWindowEnd.slice(0, 5);

  for (const r of rows) {
    const checkout = r.checkOut;
    // Next reservation: smallest check-in on/after this checkout (itself excluded).
    const next = rows.find((s) => s.id !== r.id && s.checkIn >= checkout);
    const key = turnoverStableKey(r.icalFeedId, r.uid);
    const [job] = await tx
      .select()
      .from(cleaningJobs)
      .where(eq(cleaningJobs.stableKey, key))
      .limit(1);

    const title = r.guestName
      ? `Turnover · ${r.guestName} · out ${checkout}`
      : `Turnover · out ${checkout}`;

    // Revive: the reservation is back but its job was auto-cancelled when the
    // reservation vanished (e.g. a feed glitch). The system undoes its own
    // automation — flagged for the owner to confirm — but never touches a
    // job a human cancelled. This bypasses the state machine deliberately:
    // `cancelled` is terminal for user transitions.
    //
    // Re-link: the job's reservation_id is nulled when a reservation vanishes
    // so the row can be deleted; re-link it to the current row.
    if (job) {
      if (job.status === "cancelled" && job.cancelReason === "reservation removed") {
        await tx
          .update(cleaningJobs)
          .set({
            status: "scheduled",
            cancelReason: null,
            cancelledAt: null,
            needsAttention: true,
            updatedAt: nowIso(),
          })
          .where(eq(cleaningJobs.id, job.id));
        await audit(tx, {
          actorType: "system",
          action: "job.revived",
          entityType: "cleaning_job",
          entityId: job.id,
          metadata: { reason: "reservation_restored" },
        });
        job.status = "scheduled";
        job.needsAttention = true;
        out.updated++;
      }
      if (job.reservationId !== r.id) {
        await tx
          .update(cleaningJobs)
          .set({ reservationId: r.id, updatedAt: nowIso() })
          .where(eq(cleaningJobs.id, job.id));
        job.reservationId = r.id;
      }
    }

    // Fit check (contracts §4 rule 7): same-day turnovers get flagged when
    // the job doesn't fit between checkout and next check-in.
    let needsAttention = false;
    if (next && next.checkIn === checkout) {
      const checkoutT = property.checkoutTime?.slice(0, 5) ?? "11:00";
      const checkinT = property.checkinTime?.slice(0, 5) ?? "15:00";
      const available =
        minutesOf(checkinT) - minutesOf(checkoutT) - (property.turnoverBufferMinutes ?? 0);
      const duration = minutesOf(job?.endTime.slice(0, 5) ?? defaultEnd) -
        minutesOf(job?.startTime.slice(0, 5) ?? defaultStart);
      if (duration > available) needsAttention = true;
    }

    if (!job) {
      await tx.insert(cleaningJobs).values({
        propertyId: property.id,
        reservationId: r.id,
        stableKey: key,
        title,
        jobType: "turnover",
        scheduledDate: checkout,
        startTime: defaultStart,
        endTime: defaultEnd,
        status: "scheduled",
        needsAttention,
        createdBy,
      });
      const [created] = await tx
        .select({ id: cleaningJobs.id })
        .from(cleaningJobs)
        .where(eq(cleaningJobs.stableKey, key))
        .limit(1);
      await audit(tx, {
        actorType: "system",
        action: "job.created",
        entityType: "cleaning_job",
        entityId: created!.id,
        metadata: { stable_key: key, job_type: "turnover" },
      });
      // Workstream E: schedule reminders + create the shared-calendar event here.
      out.created++;
      continue;
    }

    const feedChanged = changedReservationIds.has(r.id);
    if (job.scheduledDate !== checkout) {
      if (!feedChanged) {
        // The owner moved this job manually — the engine must not move it back.
        continue;
      }
      if (["in_progress", "completed", "cancelled"].includes(job.status)) {
        // Rule 8: don't move a job that's underway; flag it for the owner.
        await tx
          .update(cleaningJobs)
          .set({ needsAttention: true, updatedAt: nowIso() })
          .where(eq(cleaningJobs.id, job.id));
        await audit(tx, {
          actorType: "system",
          action: "job.flagged",
          entityType: "cleaning_job",
          entityId: job.id,
          metadata: { reason: "reservation_date_changed_after_start" },
        });
        out.flagged++;
        continue;
      }
      await tx
        .update(cleaningJobs)
        .set({ scheduledDate: checkout, title, updatedAt: nowIso() })
        .where(eq(cleaningJobs.id, job.id));
      await audit(tx, {
        actorType: "system",
        action: "job.updated",
        entityType: "cleaning_job",
        entityId: job.id,
        metadata: { reason: "reservation_date_changed", scheduled_date: checkout },
      });
      // Workstream E: recompute reminders + update the shared-calendar event here.
      out.updated++;
    } else if (job.title !== title) {
      await tx
        .update(cleaningJobs)
        .set({ title, updatedAt: nowIso() })
        .where(eq(cleaningJobs.id, job.id));
      out.updated++;
    }
    if (needsAttention && !job.needsAttention) {
      await tx
        .update(cleaningJobs)
        .set({ needsAttention: true, updatedAt: nowIso() })
        .where(eq(cleaningJobs.id, job.id));
      out.flagged++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recurring series
// ---------------------------------------------------------------------------

export interface SeriesPatch {
  title?: string;
  rrule?: RruleInput;
  defaultStartTime?: string;
  defaultEndTime?: string;
  notes?: string | null;
  isActive?: boolean;
}

function seriesDtstart(series: Series): string {
  const r = series.rrule as unknown as { dtstart?: string };
  if (r && typeof r.dtstart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.dtstart)) {
    return r.dtstart;
  }
  return series.createdAt.slice(0, 10);
}

/**
 * Expand a series into jobs for future occurrences (contracts §4 rules 10-12).
 * Idempotent; never rewrites completed/cancelled jobs; never touches the past.
 */
export async function expandSeries(
  tx: Tx,
  seriesId: string,
  horizonDays = 120,
): Promise<{ created: number; updated: number; cancelled: number }> {
  const out = { created: 0, updated: 0, cancelled: 0 };
  const [series] = await tx
    .select()
    .from(recurringSeries)
    .where(eq(recurringSeries.id, seriesId))
    .limit(1);
  if (!series) throw notFound("Series not found");

  const [property] = await tx
    .select()
    .from(properties)
    .where(eq(properties.id, series.propertyId))
    .limit(1);
  if (!property) throw notFound("Property not found");

  const from = todayPT();
  const to = addDays(from, horizonDays);

  if (!series.isActive) {
    // Rule 12: deactivating cancels future scheduled/assigned jobs.
    const doomed = await tx
      .select()
      .from(cleaningJobs)
      .where(
        and(
          eq(cleaningJobs.seriesId, seriesId),
          ne(cleaningJobs.status, "completed"),
          ne(cleaningJobs.status, "cancelled"),
        ),
      );
    for (const j of doomed) {
      if (["draft", "scheduled", "assigned"].includes(j.status)) {
        await transitionJob(
          tx,
          j.id,
          "cancelled",
          { kind: "system", userId: null, role: "owner" },
          { reason: "series deactivated" },
        );
        out.cancelled++;
      }
    }
    return out;
  }

  const validated = validateRrule(series.rrule);
  if (!validated.ok) throw badRequest(`invalid rrule on series: ${validated.error}`);
  const occurrences = expandRrule(validated.rrule, seriesDtstart(series), from, to);
  const occurrenceSet = new Set(occurrences);

  const overrides = await tx
    .select()
    .from(occurrenceOverrides)
    .where(eq(occurrenceOverrides.seriesId, seriesId));
  const overrideByDate = new Map(overrides.map((o) => [o.occurrenceDate, o]));

  const existing = await tx
    .select()
    .from(cleaningJobs)
    .where(eq(cleaningJobs.seriesId, seriesId));
  const existingByKey = new Map(existing.map((j) => [j.stableKey, j]));

  const defaultStart = (series.defaultStartTime ?? "11:00").slice(0, 5);
  const defaultEnd = (series.defaultEndTime ?? "15:00").slice(0, 5);

  for (const occ of occurrences) {
    const ov = overrideByDate.get(occ);
    const key = seriesStableKey(seriesId, occ);
    const job = existingByKey.get(key);

    if (ov?.action === "cancelled") {
      if (job && ["draft", "scheduled", "assigned"].includes(job.status)) {
        await transitionJob(
          tx,
          job.id,
          "cancelled",
          { kind: "system", userId: null, role: "owner" },
          { reason: "occurrence cancelled" },
        );
        out.cancelled++;
      }
      continue;
    }

    const scheduledDate = ov?.action === "rescheduled" && ov.newDate ? ov.newDate : occ;
    const startTime = (ov?.newStartTime ?? defaultStart).slice(0, 5);
    const endTime = (ov?.newEndTime ?? defaultEnd).slice(0, 5);

    if (!job) {
      await tx.insert(cleaningJobs).values({
        propertyId: series.propertyId,
        seriesId: series.id,
        occurrenceDate: occ,
        stableKey: key,
        title: series.title,
        jobType: "recurring",
        scheduledDate,
        startTime,
        endTime,
        status: "scheduled",
        createdBy: series.createdBy,
      });
      const [created] = await tx
        .select({ id: cleaningJobs.id })
        .from(cleaningJobs)
        .where(eq(cleaningJobs.stableKey, key))
        .limit(1);
      await audit(tx, {
        actorType: "system",
        action: "job.created",
        entityType: "cleaning_job",
        entityId: created!.id,
        metadata: { stable_key: key, job_type: "recurring" },
      });
      // Workstream E: schedule reminders + create the shared-calendar event here.
      out.created++;
      continue;
    }

    // Never rewrite completed/cancelled jobs; leave in-flight jobs' dates alone.
    if (["completed", "cancelled", "in_progress"].includes(job.status)) continue;
    if (
      job.scheduledDate !== scheduledDate ||
      job.startTime.slice(0, 5) !== startTime ||
      job.endTime.slice(0, 5) !== endTime ||
      job.title !== series.title
    ) {
      await tx
        .update(cleaningJobs)
        .set({
          scheduledDate,
          startTime,
          endTime,
          title: series.title,
          updatedAt: nowIso(),
        })
        .where(eq(cleaningJobs.id, job.id));
      // Workstream E: recompute reminders + update the shared-calendar event here.
      out.updated++;
    }
  }

  // Prune: occurrences that fell out of the expansion (series shrunk).
  for (const j of existing) {
    if (!j.occurrenceDate || j.occurrenceDate < from) continue;
    if (occurrenceSet.has(j.occurrenceDate)) continue;
    if (["draft", "scheduled", "assigned"].includes(j.status)) {
      await transitionJob(
        tx,
        j.id,
        "cancelled",
        { kind: "system", userId: null, role: "owner" },
        { reason: "occurrence removed" },
      );
      out.cancelled++;
    }
  }
  return out;
}

/** "This occurrence" scope: write an override row, then re-expand. */
export async function overrideOccurrence(
  tx: Tx,
  seriesId: string,
  occurrenceDate: string,
  action: "rescheduled" | "cancelled",
  opts: { newDate?: string; newStartTime?: string; newEndTime?: string },
  actorUserId: string,
): Promise<void> {
  const [series] = await tx
    .select()
    .from(recurringSeries)
    .where(eq(recurringSeries.id, seriesId))
    .limit(1);
  if (!series) throw notFound("Series not found");

  const [existing] = await tx
    .select()
    .from(occurrenceOverrides)
    .where(
      and(
        eq(occurrenceOverrides.seriesId, seriesId),
        eq(occurrenceOverrides.occurrenceDate, occurrenceDate),
      ),
    )
    .limit(1);
  const row = {
    seriesId,
    occurrenceDate,
    action,
    newDate: opts.newDate ?? null,
    newStartTime: opts.newStartTime ?? null,
    newEndTime: opts.newEndTime ?? null,
  };
  if (existing) {
    await tx
      .update(occurrenceOverrides)
      .set({ action, newDate: row.newDate, newStartTime: row.newStartTime, newEndTime: row.newEndTime })
      .where(eq(occurrenceOverrides.id, existing.id));
  } else {
    await tx.insert(occurrenceOverrides).values(row);
  }
  await audit(tx, {
    actorType: "user",
    actorUserId,
    action: "series.occurrence_overridden",
    entityType: "recurring_series",
    entityId: seriesId,
    metadata: { occurrence_date: occurrenceDate, override_action: action },
  });
  await expandSeries(tx, seriesId);
}

/**
 * "This and following" scope (contracts §4 rule 11): terminate the original
 * series the day before `fromDate` and create a new series from `fromDate`.
 */
export async function splitSeries(
  tx: Tx,
  seriesId: string,
  fromDate: string,
  patch: SeriesPatch,
  actorUserId: string,
): Promise<{ oldSeries: Series; newSeries: Series }> {
  const [series] = await tx
    .select()
    .from(recurringSeries)
    .where(eq(recurringSeries.id, seriesId))
    .limit(1);
  if (!series) throw notFound("Series not found");
  const validatedOld = validateRrule(series.rrule);
  if (!validatedOld.ok) throw badRequest(`invalid rrule on series: ${validatedOld.error}`);

  const oldRrule = validatedOld.rrule as RruleInput & { dtstart?: string };
  const mergedRrule: RruleInput & { dtstart?: string } = {
    ...oldRrule,
    ...(patch.rrule ?? {}),
    dtstart: fromDate,
  };
  const validatedNew = validateRrule(mergedRrule);
  if (!validatedNew.ok) throw badRequest(`invalid rrule: ${validatedNew.error}`);

  // Terminate the original the day before the split.
  const until = addDays(fromDate, -1);
  await tx
    .update(recurringSeries)
    .set({
      rrule: { ...oldRrule, until },
      updatedAt: nowIso(),
    })
    .where(eq(recurringSeries.id, seriesId));

  const [created] = await tx
    .insert(recurringSeries)
    .values({
      propertyId: series.propertyId,
      title: patch.title ?? series.title,
      rrule: validatedNew.rrule,
      defaultStartTime: (patch.defaultStartTime ?? series.defaultStartTime ?? "11:00").slice(0, 8),
      defaultEndTime: (patch.defaultEndTime ?? series.defaultEndTime ?? "15:00").slice(0, 8),
      notes: patch.notes ?? series.notes,
      isActive: patch.isActive ?? true,
      createdBy: actorUserId,
    })
    .returning();
  const newSeries = created!;

  await audit(tx, {
    actorType: "user",
    actorUserId,
    action: "series.split",
    entityType: "recurring_series",
    entityId: seriesId,
    metadata: { from_date: fromDate, new_series_id: newSeries.id },
  });

  await expandSeries(tx, seriesId);
  await expandSeries(tx, newSeries.id);

  const [oldSeries] = await tx
    .select()
    .from(recurringSeries)
    .where(eq(recurringSeries.id, seriesId))
    .limit(1);
  return { oldSeries: oldSeries!, newSeries };
}

/** "Entire series" scope: update the series, regenerate future occurrences. */
export async function updateSeries(
  tx: Tx,
  seriesId: string,
  patch: SeriesPatch,
  actorUserId: string,
): Promise<Series> {
  const [series] = await tx
    .select()
    .from(recurringSeries)
    .where(eq(recurringSeries.id, seriesId))
    .limit(1);
  if (!series) throw notFound("Series not found");

  const set: Partial<typeof recurringSeries.$inferInsert> = { updatedAt: nowIso() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.isActive !== undefined) set.isActive = patch.isActive;
  if (patch.defaultStartTime !== undefined) set.defaultStartTime = patch.defaultStartTime.slice(0, 8);
  if (patch.defaultEndTime !== undefined) set.defaultEndTime = patch.defaultEndTime.slice(0, 8);
  if (patch.rrule !== undefined) {
    const v = validateRrule(patch.rrule);
    if (!v.ok) throw badRequest(`invalid rrule: ${v.error}`);
    // Preserve the series' dtstart unless the patch sets one explicitly.
    const oldDtstart = (series.rrule as { dtstart?: string }).dtstart;
    set.rrule = { ...v.rrule, ...(oldDtstart && !v.rrule.dtstart ? { dtstart: oldDtstart } : {}) };
  }
  await tx.update(recurringSeries).set(set).where(eq(recurringSeries.id, seriesId));
  await audit(tx, {
    actorType: "user",
    actorUserId,
    action: "series.updated",
    entityType: "recurring_series",
    entityId: seriesId,
    metadata: { scope: "series" },
  });
  await expandSeries(tx, seriesId);
  const [updated] = await tx
    .select()
    .from(recurringSeries)
    .where(eq(recurringSeries.id, seriesId))
    .limit(1);
  return updated!;
}

/** Create a series and immediately expand it. */
export async function createSeries(
  tx: Tx,
  input: {
    propertyId: string;
    title: string;
    rrule: RruleInput;
    defaultStartTime?: string;
    defaultEndTime?: string;
    notes?: string | null;
    createdBy: string;
  },
): Promise<Series> {
  const v = validateRrule(input.rrule);
  if (!v.ok) throw badRequest(`invalid rrule: ${v.error}`);
  const rrule = { ...v.rrule, dtstart: v.rrule.dtstart ?? todayPT() };
  const [series] = await tx
    .insert(recurringSeries)
    .values({
      propertyId: input.propertyId,
      title: input.title,
      rrule,
      defaultStartTime: (input.defaultStartTime ?? "11:00").slice(0, 8),
      defaultEndTime: (input.defaultEndTime ?? "15:00").slice(0, 8),
      notes: input.notes ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  await audit(tx, {
    actorType: "user",
    actorUserId: input.createdBy,
    action: "series.created",
    entityType: "recurring_series",
    entityId: series!.id,
    metadata: { title: input.title },
  });
  await expandSeries(tx, series!.id);
  return series!;
}

// ---------------------------------------------------------------------------
// Manual jobs
// ---------------------------------------------------------------------------

export interface ManualJobInput {
  propertyId: string;
  title: string;
  jobType: string;
  scheduledDate: string;
  startTime?: string;
  endTime?: string;
  checklistTemplateId?: string | null;
  createdBy: string;
}

const MANUAL_JOB_TYPES = ["turnover", "recurring", "deep_clean", "restock", "maintenance", "other"];

/** POST /api/jobs — manual creation (contracts §2). */
export async function createManualJob(tx: Tx, input: ManualJobInput): Promise<CleaningJob> {
  if (!MANUAL_JOB_TYPES.includes(input.jobType)) {
    throw badRequest(`job_type must be one of ${MANUAL_JOB_TYPES.join(", ")}`);
  }
  const [property] = await tx
    .select()
    .from(properties)
    .where(eq(properties.id, input.propertyId))
    .limit(1);
  if (!property) throw notFound("Property not found");

  const startTime = (input.startTime ?? property.defaultWindowStart).slice(0, 5);
  const endTime = (input.endTime ?? property.defaultWindowEnd).slice(0, 5);
  if (minutesOf(endTime) <= minutesOf(startTime)) {
    throw badRequest("end_time must be after start_time");
  }

  const [job] = await tx
    .insert(cleaningJobs)
    .values({
      propertyId: input.propertyId,
      stableKey: `manual:${randomUUID()}`,
      title: input.title,
      jobType: input.jobType,
      scheduledDate: input.scheduledDate,
      startTime,
      endTime,
      status: "scheduled",
      checklistTemplateId: input.checklistTemplateId ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  await audit(tx, {
    actorType: "user",
    actorUserId: input.createdBy,
    action: "job.created",
    entityType: "cleaning_job",
    entityId: job!.id,
    metadata: { job_type: input.jobType, manual: true },
  });
  // Workstream E: schedule reminders + create the shared-calendar event here.
  return job!;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export interface JobActor {
  kind: "user" | "system";
  userId: string | null;
  role: Role;
}

/**
 * Move a job through the state machine with server-side enforcement.
 * The tx must already be scoped (withUser) for request paths; the worker
 * passes an admin transaction and kind 'system'.
 */
export async function transitionJob(
  tx: Tx,
  jobId: string,
  to: JobStatus,
  actor: JobActor,
  opts?: { reason?: string },
): Promise<CleaningJob> {
  const [job] = await tx
    .select()
    .from(cleaningJobs)
    .where(eq(cleaningJobs.id, jobId))
    .limit(1);
  if (!job) throw notFound("Job not found");

  if (to === "cancelled" && actor.role !== "owner") {
    throw forbidden("Only the owner can cancel a job.");
  }
  if (
    actor.kind === "user" &&
    actor.role === "dispatcher" &&
    job.assignedToUserId !== actor.userId
  ) {
    throw forbidden("You can only act on jobs assigned to you.");
  }
  if (!canTransition(job.status as JobStatus, to, actor.role)) {
    throw badRequest(`Cannot move job from ${job.status} to ${to}.`);
  }

  const set: Partial<typeof cleaningJobs.$inferInsert> = {
    status: to,
    updatedAt: nowIso(),
  };
  if (to === "confirmed") set.confirmedAt = nowIso();
  if (to === "completed") set.completedAt = nowIso();
  if (to === "cancelled") {
    set.cancelledAt = nowIso();
    set.cancelReason = opts?.reason ?? null;
  }
  if (to === "declined") {
    // Contracts §1/§4: assigned → declined → scheduled. The declining
    // dispatcher is no longer the assignee; the job returns to the pool
    // with needs_attention so the owner spots it in the daily digest.
    // Record the decline first (audited), then the return to pool.
    await tx.update(cleaningJobs).set({
      status: "declined",
      updatedAt: nowIso(),
    }).where(eq(cleaningJobs.id, job.id));
    await audit(tx, {
      actorType: actor.kind,
      actorUserId: actor.userId,
      action: "job.status_changed",
      entityType: "cleaning_job",
      entityId: job.id,
      metadata: { from: job.status, to: "declined", ...(opts?.reason ? { reason: opts.reason } : {}) },
    });
    await tx.update(cleaningJobs).set({
      status: "scheduled",
      assignedToUserId: null,
      needsAttention: true,
      updatedAt: nowIso(),
    }).where(eq(cleaningJobs.id, job.id));
    await audit(tx, {
      actorType: actor.kind,
      actorUserId: actor.userId,
      action: "job.returned_to_pool",
      entityType: "cleaning_job",
      entityId: job.id,
      metadata: { ...(opts?.reason ? { reason: opts.reason } : {}) },
    });
    const [declined] = await tx
      .select()
      .from(cleaningJobs)
      .where(eq(cleaningJobs.id, job.id))
      .limit(1);
    return declined!;
  }

  await tx.update(cleaningJobs).set(set).where(eq(cleaningJobs.id, job.id));

  if (to === "cancelled" || to === "completed") {
    // Contracts §4 rule 15: pending reminders are skipped.
    await tx
      .update(reminders)
      .set({ status: "skipped" })
      .where(and(eq(reminders.jobId, job.id), eq(reminders.status, "pending")));
  }
  // Workstream E: on confirm → create shared-calendar event; on reschedule
  // (via PATCH) → update event; on cancel → delete event.

  await audit(tx, {
    actorType: actor.kind,
    actorUserId: actor.userId,
    action: "job.status_changed",
    entityType: "cleaning_job",
    entityId: job.id,
    metadata: { from: job.status, to, ...(opts?.reason ? { reason: opts.reason } : {}) },
  });

  const [updated] = await tx
    .select()
    .from(cleaningJobs)
    .where(eq(cleaningJobs.id, job.id))
    .limit(1);
  return updated!;
}

/** Convenience for the worker: run a full hourly pass over every feed. */
export async function runSchedulerPass(): Promise<void> {
  const db = getDbAdmin(); // scheduler worker: allowed admin client (see lib/db.ts)
  // Hourly sync per feed: only feeds never synced or synced over an hour ago.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const feeds = await db
    .select()
    .from(icalFeeds)
    .where(
      or(isNull(icalFeeds.lastSyncedAt), lt(icalFeeds.lastSyncedAt, oneHourAgo)),
    );
  for (const feed of feeds) {
    const [prop] = await db
      .select({ timezone: properties.timezone })
      .from(properties)
      .where(eq(properties.id, feed.propertyId))
      .limit(1);
    const fetched = await fetchFeedEvents(feed.url, prop?.timezone ?? APP_TZ);
    const result = await db.transaction((tx) => applyFeedSync(tx, feed.id, fetched));
    console.log(
      JSON.stringify({
        event: "feed_sync",
        feed_id: feed.id,
        status: result.status,
        upserted: result.reservationsUpserted,
        removed: result.reservationsRemoved,
        jobs_created: result.jobsCreated,
        jobs_updated: result.jobsUpdated,
      }),
    );
  }
  // Recurring series are expanded on every pass: idempotent and self-healing.
  const series = await db
    .select({ id: recurringSeries.id })
    .from(recurringSeries)
    .where(eq(recurringSeries.isActive, true));
  for (const s of series) {
    await db.transaction((tx) => expandSeries(tx, s.id));
  }
}
