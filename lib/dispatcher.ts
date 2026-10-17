/**
 * Dispatcher workstream — shared server-side logic for the agency view.
 *
 * The dispatcher is the cleaning agency's ONLY app user (individual crew
 * members never sign in). Everything here is scoped to jobs ASSIGNED to
 * the dispatcher (cleaning_jobs.assigned_to_user_id = userId) and runs
 * inside withUser() so RLS is the backstop even if a handler forgets a
 * filter.
 *
 * Access instructions are decrypted here, in memory, at the point of use
 * (the job detail view). They are NEVER logged, never written to audit
 * metadata, and never leave the server except inside the dispatcher's
 * own detail response.
 *
 * State machine (contracts §1, enforced by lib/job-transitions.ts):
 *   assigned → confirmed → in_progress → completed   (dispatcher)
 *   assigned → declined → scheduled                   (decline returns the
 *     job to the pool with assignment cleared + needs_attention set,
 *     so the owner sees it in the daily digest)
 */
import { and, asc, eq, gte } from "drizzle-orm";
import { decryptField } from "./crypto";
import { withUser, type Db, type Tx } from "./db";
import { allowedTransitions, canTransition, type Role } from "./job-transitions";
import {
  auditLog,
  checklistItems,
  cleaningJobs,
  jobChecklistResults,
  messages,
  properties,
  type JobStatus,
} from "./schema";
import { formatDatePT, formatWallTimePT } from "./time";

export class DispatcherError extends Error {
  status: 400 | 403 | 404;
  code: string;
  constructor(code: string, status: 400 | 403 | 404, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface DispatcherJobSummary {
  id: string;
  title: string;
  jobType: string;
  scheduledDate: string; // YYYY-MM-DD (PT calendar date)
  startTime: string; // HH:MM wall-clock PT
  endTime: string;
  status: JobStatus;
  needsAttention: boolean;
  propertyName: string;
  propertyAddress: string | null;
  whenLabel: string; // "Sat, Oct 18, 2026 · 11:00 AM PT – 3:00 PM PT"
}

export interface DispatcherChecklistRow {
  itemId: string;
  label: string;
  sortOrder: number;
  isDone: boolean;
}

export interface DispatcherJobDetail extends DispatcherJobSummary {
  propertyId: string;
  accessInstructions: string | null; // decrypted, current value only
  accessInstructionsUpdatedAt: string | null;
  checklist: DispatcherChecklistRow[];
  messagesCount: number;
  calendarState: "linked" | "pending"; // shared Cleanings calendar event state
  allowedActions: Array<"confirm" | "decline" | "start" | "complete">;
}

function todayPT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function toSummary(
  j: typeof cleaningJobs.$inferSelect,
  propertyName: string,
  propertyAddress: string | null,
): DispatcherJobSummary {
  return {
    id: j.id,
    title: j.title,
    jobType: j.jobType,
    scheduledDate: j.scheduledDate,
    startTime: j.startTime,
    endTime: j.endTime,
    status: j.status as JobStatus,
    needsAttention: j.needsAttention,
    propertyName,
    propertyAddress,
    whenLabel: `${formatDatePT(j.scheduledDate)} · ${formatWallTimePT(j.startTime)} – ${formatWallTimePT(j.endTime)}`,
  };
}

const ACTION_TO_STATUS = {
  confirm: "confirmed",
  decline: "declined",
  start: "in_progress",
  complete: "completed",
} as const;

export type DispatcherAction = keyof typeof ACTION_TO_STATUS;

const ACTION_AUDIT: Record<DispatcherAction, string> = {
  confirm: "job.confirmed",
  decline: "job.declined",
  start: "job.started",
  complete: "job.completed",
};

/** Jobs assigned to this dispatcher, today and upcoming. */
export async function listDispatcherJobs(
  tx: Tx,
  userId: string,
): Promise<DispatcherJobSummary[]> {
  const rows = await tx
    .select({ job: cleaningJobs, propertyName: properties.name, propertyAddress: properties.listingAddress })
    .from(cleaningJobs)
    .innerJoin(properties, eq(cleaningJobs.propertyId, properties.id))
    .where(
      and(
        eq(cleaningJobs.assignedToUserId, userId),
        gte(cleaningJobs.scheduledDate, todayPT()),
      ),
    )
    .orderBy(asc(cleaningJobs.scheduledDate), asc(cleaningJobs.startTime))
    .limit(100);
  return rows.map((r) => toSummary(r.job, r.propertyName, r.propertyAddress));
}

/** Full detail for one assigned job. Throws DispatcherError(404) unless assigned to this dispatcher. */
export async function getDispatcherJobDetail(
  tx: Tx,
  userId: string,
  jobId: string,
): Promise<DispatcherJobDetail> {
  const rows = await tx
    .select({ job: cleaningJobs, property: properties })
    .from(cleaningJobs)
    .innerJoin(properties, eq(cleaningJobs.propertyId, properties.id))
    .where(
      and(eq(cleaningJobs.id, jobId), eq(cleaningJobs.assignedToUserId, userId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new DispatcherError("not_found", 404, "Job not found or not assigned to you.");
  }
  const { job, property } = row;

  // Checklist: template items for this job, left-joined to per-job results.
  let checklist: DispatcherChecklistRow[] = [];
  if (job.checklistTemplateId) {
    const items = await tx
      .select({ item: checklistItems, result: jobChecklistResults })
      .from(checklistItems)
      .where(eq(checklistItems.templateId, job.checklistTemplateId))
      .leftJoin(
        jobChecklistResults,
        and(
          eq(jobChecklistResults.checklistItemId, checklistItems.id),
          eq(jobChecklistResults.jobId, job.id),
        ),
      )
      .orderBy(asc(checklistItems.sortOrder));
    // RLS note: reading another job's results is denied by policy; the join
    // above is scoped to this job only.
    checklist = items.map((r) => ({
      itemId: r.item.id,
      label: r.item.label,
      sortOrder: r.item.sortOrder,
      isDone: r.result?.isDone ?? false,
    }));
  }

  const msgRows = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.jobId, job.id));

  const allowedActions = (["confirm", "decline", "start", "complete"] as const).filter(
    (a) => canTransition(job.status as JobStatus, ACTION_TO_STATUS[a], "dispatcher" as Role),
  );

  return {
    ...toSummary(job, property.name, property.listingAddress),
    propertyId: property.id,
    accessInstructions: property.accessInstructions
      ? decryptField(property.accessInstructions)
      : null,
    accessInstructionsUpdatedAt: property.accessInstructionsUpdatedAt,
    checklist,
    messagesCount: msgRows.length,
    calendarState: job.googleEventId ? "linked" : "pending",
    allowedActions,
  };
}

async function writeAudit(
  tx: Tx,
  userId: string,
  action: string,
  jobId: string,
  metadata?: Record<string, unknown> | null,
) {
  await tx.insert(auditLog).values({
    actorType: "user",
    actorUserId: userId,
    action,
    entityType: "cleaning_job",
    entityId: jobId,
    metadata: metadata ?? null,
  });
}

/**
 * Dispatcher one-tap transitions. Enforces:
 * - the job is assigned to this dispatcher (404 otherwise — no existence leak)
 * - the transition is legal for the dispatcher role (400 otherwise)
 * Decline is a two-step: assigned → declined → scheduled, assignment cleared,
 * needs_attention set so the owner spots it in the daily digest.
 */
export async function transitionDispatcherJob(
  tx: Tx,
  userId: string,
  jobId: string,
  action: DispatcherAction,
  opts?: { reason?: string },
): Promise<DispatcherJobSummary> {
  const rows = await tx
    .select({ job: cleaningJobs, propertyName: properties.name, propertyAddress: properties.listingAddress })
    .from(cleaningJobs)
    .innerJoin(properties, eq(cleaningJobs.propertyId, properties.id))
    .where(
      and(eq(cleaningJobs.id, jobId), eq(cleaningJobs.assignedToUserId, userId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new DispatcherError("not_found", 404, "Job not found or not assigned to you.");
  }
  const { job } = row;
  const target = ACTION_TO_STATUS[action] as JobStatus;

  if (!canTransition(job.status as JobStatus, target, "dispatcher")) {
    const allowed = allowedTransitions(job.status as JobStatus, "dispatcher");
    throw new DispatcherError(
      "invalid_transition",
      400,
      `Cannot ${action} a job with status "${job.status}". Allowed: ${allowed.join(", ") || "none"}.`,
    );
  }

  const now = new Date().toISOString();

  if (action === "decline") {
    // assigned → declined (audited), then immediately back to the pool.
    await tx
      .update(cleaningJobs)
      .set({ status: "declined", updatedAt: now })
      .where(eq(cleaningJobs.id, job.id));
    await writeAudit(tx, userId, "job.declined", job.id, {
      reason: opts?.reason ?? null,
    });
    const [back] = await tx
      .update(cleaningJobs)
      .set({
        status: "scheduled",
        assignedToUserId: null,
        needsAttention: true,
        updatedAt: now,
      })
      .where(eq(cleaningJobs.id, job.id))
      .returning();
    await writeAudit(tx, userId, "job.returned_to_pool", job.id, {
      reason: opts?.reason ?? null,
    });
    return toSummary(back!, row.propertyName, row.propertyAddress);
  }

  const patch: Partial<typeof cleaningJobs.$inferInsert> = {
    status: target,
    updatedAt: now,
  };
  if (action === "confirm") patch.confirmedAt = now;
  if (action === "complete") patch.completedAt = now;

  const [updated] = await tx
    .update(cleaningJobs)
    .set(patch)
    .where(eq(cleaningJobs.id, job.id))
    .returning();
  await writeAudit(tx, userId, ACTION_AUDIT[action], job.id, null);
  return toSummary(updated!, row.propertyName, row.propertyAddress);
}

/** Toggle a checklist item on an assigned job. */
export async function setDispatcherChecklistResult(
  tx: Tx,
  userId: string,
  jobId: string,
  itemId: string,
  isDone: boolean,
): Promise<DispatcherChecklistRow> {
  const jobs = await tx
    .select()
    .from(cleaningJobs)
    .where(
      and(eq(cleaningJobs.id, jobId), eq(cleaningJobs.assignedToUserId, userId)),
    )
    .limit(1);
  const job = jobs[0];
  if (!job) {
    throw new DispatcherError("not_found", 404, "Job not found or not assigned to you.");
  }
  // The item must belong to this job's checklist template.
  const items = await tx
    .select()
    .from(checklistItems)
    .where(
      and(
        eq(checklistItems.id, itemId),
        job.checklistTemplateId
          ? eq(checklistItems.templateId, job.checklistTemplateId)
          : eq(checklistItems.id, "__never__"),
      ),
    )
    .limit(1);
  const item = items[0];
  if (!item) {
    throw new DispatcherError("invalid_item", 400, "Checklist item is not part of this job.");
  }

  const now = new Date().toISOString();
  const existing = await tx
    .select()
    .from(jobChecklistResults)
    .where(
      and(
        eq(jobChecklistResults.jobId, job.id),
        eq(jobChecklistResults.checklistItemId, item.id),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await tx
      .update(jobChecklistResults)
      .set({
        isDone,
        completedAt: isDone ? now : null,
        completedBy: isDone ? userId : null,
      })
      .where(eq(jobChecklistResults.id, existing[0].id));
  } else {
    await tx.insert(jobChecklistResults).values({
      jobId: job.id,
      checklistItemId: item.id,
      isDone,
      completedAt: isDone ? now : null,
      completedBy: isDone ? userId : null,
    });
  }
  await writeAudit(tx, userId, "job.checklist_updated", job.id, {
    item_id: item.id,
    is_done: isDone,
  });
  return { itemId: item.id, label: item.label, sortOrder: item.sortOrder, isDone };
}

/** Convenience wrapper: run dispatcher logic as the app role with RLS scoping. */
export async function asDispatcher<T>(
  db: Pick<Db, "transaction">,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withUser(db, userId, fn);
}
