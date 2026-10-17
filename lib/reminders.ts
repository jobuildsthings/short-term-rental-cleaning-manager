/**
 * Reminder engine (Workstream E).
 *
 * Contracts §4.13–16, §7.8:
 * - For each job in `assigned` or `confirmed`: one reminder per entry in
 *   `property.reminder_hours_before` (default 24h, 2h before job start),
 *   per channel: SMS to the dispatcher contact phone, email to the
 *   dispatcher contact email. Dispatcher-only (Jo gets the digest+recap).
 * - Bodies render AT SEND TIME with the CURRENT access instructions and
 *   are never persisted (the `reminders` table holds metadata only).
 * - On reschedule/cancel/complete: recompute (cancel pending, create new);
 *   cancelled/completed jobs get pending rows marked `skipped`.
 * - Send path: email via Resend (direct); SMS via the device bridge
 *   (queued reference-only; the drain renders bodies). Twilio fallback
 *   only. Failures: retry with backoff, then `failed` + audit + digest.
 *
 * BINDING: decrypted instruction values live only in memory inside the
 * render functions and are never logged, never put in audit metadata,
 * and never stored.
 */
import { and, eq, inArray, lte } from "drizzle-orm";
import { audit } from "./audit";
import { decryptField } from "./crypto";
import { type Db, type Tx } from "./db";
import { queueSmsForDevice, sendEmail, smsProvider } from "./send";
import { agencySettings, cleaningJobs, properties, reminders } from "./schema";
import { APP_TIME_ZONE, formatDatePT, formatWallTimePT, zonedDateTime } from "./time";

/** Reminder-eligible job statuses (contracts §4.13). */
const ELIGIBLE_STATUSES = ["assigned", "confirmed"] as const;

export interface ReminderJobView {
  id: string;
  title: string;
  scheduledDate: string; // YYYY-MM-DD (PT)
  startTime: string; // HH:MM wall-clock PT
  endTime: string; // HH:MM wall-clock PT
  status: string;
  propertyId: string;
}

export interface ReminderPropertyView {
  id: string;
  name: string;
  listingAddress: string | null;
  reminderHoursBefore: number[];
  accessInstructionsEncrypted: string | null;
}

export interface DesiredReminder {
  channel: "sms" | "email";
  recipient: "dispatcher";
  scheduledFor: Date;
}

/** Job start as an absolute instant (PT wall-clock → Date). */
export function jobStartInstant(job: ReminderJobView): Date {
  return zonedDateTime(job.scheduledDate, job.startTime);
}

/**
 * The full desired reminder set for a job. Pure — used by the scheduler
 * and by tests. scheduled_for = job start minus N hours, per the
 * property's reminder_hours_before.
 */
export function desiredReminders(
  job: ReminderJobView,
  property: ReminderPropertyView,
): DesiredReminder[] {
  const start = jobStartInstant(job);
  const out: DesiredReminder[] = [];
  const hours = [...new Set(property.reminderHoursBefore)].sort((a, b) => a - b);
  for (const h of hours) {
    if (!Number.isFinite(h) || h < 0) continue;
    const at = new Date(start.getTime() - h * 3600_000);
    out.push({ channel: "sms", recipient: "dispatcher", scheduledFor: at });
    out.push({ channel: "email", recipient: "dispatcher", scheduledFor: at });
  }
  return out;
}

function sameMinute(a: Date, b: Date): boolean {
  return Math.floor(a.getTime() / 60000) === Math.floor(b.getTime() / 60000);
}

async function loadJobContext(tx: Tx, jobId: string): Promise<{
  job: ReminderJobView;
  property: ReminderPropertyView;
  agency: { contactPhone: string; contactEmail: string };
} | null> {
  const jobs = await tx
    .select()
    .from(cleaningJobs)
    .where(eq(cleaningJobs.id, jobId))
    .limit(1);
  const job = jobs[0];
  if (!job) return null;
  const props = await tx
    .select()
    .from(properties)
    .where(eq(properties.id, job.propertyId))
    .limit(1);
  const property = props[0];
  if (!property) return null;
  const agencies = await tx.select().from(agencySettings).limit(1);
  const agency = agencies[0];
  if (!agency) return null;
  return {
    job: {
      id: job.id,
      title: job.title,
      scheduledDate: job.scheduledDate,
      startTime: job.startTime,
      endTime: job.endTime,
      status: job.status,
      propertyId: job.propertyId,
    },
    property: {
      id: property.id,
      name: property.name,
      listingAddress: property.listingAddress,
      reminderHoursBefore: property.reminderHoursBefore,
      accessInstructionsEncrypted: property.accessInstructions,
    },
    agency: { contactPhone: agency.contactPhone, contactEmail: agency.contactEmail },
  };
}

/**
 * (Re)compute a job's reminder rows. Idempotent: inserts missing pending
 * rows, deletes pending rows no longer desired (e.g. after reschedule).
 * Call after assign/confirm/reschedule. Uses the admin connection — the
 * worker owns scheduling.
 */
export async function scheduleRemindersForJob(
  db: Pick<Db, "transaction">,
  jobId: string,
): Promise<void> {
  const admin = db;
  await admin.transaction(async (tx) => {
    const ctx = await loadJobContext(tx as Tx, jobId);
    if (!ctx) return;
    const existing = await tx
      .select()
      .from(reminders)
      .where(and(eq(reminders.jobId, jobId), eq(reminders.status, "pending")));

    if (!(ELIGIBLE_STATUSES as readonly string[]).includes(ctx.job.status)) {
      if (existing.length > 0) {
        await tx
          .update(reminders)
          .set({ status: "skipped" })
          .where(and(eq(reminders.jobId, jobId), eq(reminders.status, "pending")));
      }
      return;
    }

    const desired = desiredReminders(ctx.job, ctx.property);
    const toDelete = existing.filter(
      (row) =>
        !desired.some(
          (d) =>
            d.channel === row.channel &&
            sameMinute(d.scheduledFor, new Date(row.scheduledFor)),
        ),
    );
    if (toDelete.length > 0) {
      await tx
        .delete(reminders)
        .where(inArray(reminders.id, toDelete.map((r) => r.id)));
    }
    const toInsert = desired.filter(
      (d) =>
        !existing.some(
          (row) =>
            row.channel === d.channel &&
            sameMinute(new Date(row.scheduledFor), d.scheduledFor),
        ),
    );
    for (const d of toInsert) {
      await tx.insert(reminders).values({
        jobId: ctx.job.id,
        channel: d.channel,
        recipient: d.recipient,
        scheduledFor: d.scheduledFor.toISOString(),
        status: "pending",
      });
    }
  });
}

/** Mark a job's pending reminders skipped (cancelled/completed jobs). */
export async function skipRemindersForJob(
  db: Pick<Db, "transaction">,
  jobId: string,
): Promise<void> {
  const admin = db;
  await admin.transaction(async (tx) => {
    await tx
      .update(reminders)
      .set({ status: "skipped" })
      .where(and(eq(reminders.jobId, jobId), eq(reminders.status, "pending")));
  });
}

// ---------------------------------------------------------------------------
// Rendering (pure; called at send time with CURRENT instructions)
// ---------------------------------------------------------------------------

export interface RenderContext {
  job: ReminderJobView;
  propertyName: string;
  propertyAddress: string | null;
  /** Decrypted current access instructions, or null if none set. */
  accessInstructions: string | null;
}

export function whenLabel(job: ReminderJobView): string {
  return `${formatDatePT(job.scheduledDate)} · ${formatWallTimePT(job.startTime)} – ${formatWallTimePT(job.endTime)}`;
}

/** Short SMS body. Rendered at send time; never stored. */
export function renderReminderSms(ctx: RenderContext): string {
  const lines = [
    `Cleaning reminder: ${ctx.propertyName}`,
    whenLabel(ctx.job),
  ];
  if (ctx.propertyAddress) lines.push(ctx.propertyAddress);
  lines.push(
    ctx.accessInstructions
      ? `Access: ${ctx.accessInstructions}`
      : "Access: no instructions on file — check the app.",
  );
  return lines.join("\n");
}

/** Email subject + text body. Rendered at send time; never stored. */
export function renderReminderEmail(ctx: RenderContext): { subject: string; text: string } {
  const subject = `Cleaning reminder: ${ctx.propertyName} — ${formatDatePT(ctx.job.scheduledDate)} ${formatWallTimePT(ctx.job.startTime)}`;
  const lines = [
    `Hi,`,
    ``,
    `This is a reminder for the upcoming cleaning:`,
    ``,
    `Property: ${ctx.propertyName}`,
    `When: ${whenLabel(ctx.job)}`,
  ];
  if (ctx.propertyAddress) lines.push(`Address: ${ctx.propertyAddress}`);
  lines.push(
    ``,
    `Access instructions:`,
    ctx.accessInstructions ?? "No access instructions on file — please check the app.",
    ``,
    `Please confirm in the app if you haven't already.`,
  );
  return { subject, text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Worker pass: send what's due
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;

interface DueReminderRow {
  id: string;
  jobId: string;
  channel: string;
  attempts: number;
}

/**
 * Process due reminders (scheduled_for <= now, status pending).
 * Email: render + send now. SMS: hand to the device bridge (reference
 * only); the drain marks sent/failed. Failures retry with backoff
 * (attempts), then `failed` + audit — never silent.
 */
export async function processDueReminders(db: Pick<Db, "transaction">): Promise<{
  sent: number;
  smsQueued: number;
  failed: number;
}> {
  const stats = { sent: 0, smsQueued: 0, failed: 0 };
  const now = new Date();
  await db.transaction(async (tx0) => {
    const tx = tx0 as Tx;
    const due: DueReminderRow[] = await tx
      .select({
        id: reminders.id,
        jobId: reminders.jobId,
        channel: reminders.channel,
        attempts: reminders.attempts,
      })
      .from(reminders)
      .where(and(eq(reminders.status, "pending"), lte(reminders.scheduledFor, now.toISOString())));

    for (const row of due) {
      try {
        const ctx0 = await loadJobContext(tx, row.jobId);
        if (!ctx0) {
          await markFailed(tx, row, "job or property missing");
          stats.failed++;
          continue;
        }
        // The job may have moved out of eligibility since scheduling.
        if (!(ELIGIBLE_STATUSES as readonly string[]).includes(ctx0.job.status)) {
          await tx
            .update(reminders)
            .set({ status: "skipped" })
            .where(eq(reminders.id, row.id));
          continue;
        }
        // Decrypt ONLY here, in memory, at send time. Never logged.
        const instructions = ctx0.property.accessInstructionsEncrypted
          ? decryptField(ctx0.property.accessInstructionsEncrypted)
          : null;
        const renderCtx: RenderContext = {
          job: ctx0.job,
          propertyName: ctx0.property.name,
          propertyAddress: ctx0.property.listingAddress,
          accessInstructions: instructions,
        };

        if (row.channel === "email") {
          const { subject, text } = renderReminderEmail(renderCtx);
          await sendEmail({ to: ctx0.agency.contactEmail, subject, text });
          await tx
            .update(reminders)
            .set({ status: "sent", attempts: row.attempts + 1 })
            .where(eq(reminders.id, row.id));
          await audit(tx, {
            actorType: "system",
            action: "reminder.sent",
            entityType: "reminder",
            entityId: row.id,
            metadata: { channel: "email", job_id: row.jobId },
          });
          stats.sent++;
        } else if (row.channel === "sms") {
          if (smsProvider() === "twilio") {
            const { sendSmsViaTwilio } = await import("./send");
            await sendSmsViaTwilio(ctx0.agency.contactPhone, renderReminderSms(renderCtx));
            await tx
              .update(reminders)
              .set({ status: "sent", attempts: row.attempts + 1 })
              .where(eq(reminders.id, row.id));
            await audit(tx, {
              actorType: "system",
              action: "reminder.sent",
              entityType: "reminder",
              entityId: row.id,
              metadata: { channel: "sms", via: "twilio", job_id: row.jobId },
            });
            stats.sent++;
          } else {
            const outboxId = await queueSmsForDevice(
              tx,
              { reminderId: row.id },
              ctx0.agency.contactPhone,
            );
            // Reminder stays `pending` until the device drain confirms
            // delivery (it marks sent/failed on both rows).
            await audit(tx, {
              actorType: "system",
              action: "reminder.sent",
              entityType: "reminder",
              entityId: row.id,
              metadata: { channel: "sms", via: "device_bridge", outbox_id: outboxId, job_id: row.jobId },
            });
            stats.smsQueued++;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown";
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await markFailed(tx, { ...row, attempts }, msg);
          stats.failed++;
        } else {
          await tx
            .update(reminders)
            .set({ attempts, lastError: msg.slice(0, 500) })
            .where(eq(reminders.id, row.id));
        }
      }
    }
  });
  return stats;
}

async function markFailed(tx: Tx, row: DueReminderRow, error: string): Promise<void> {
  await tx
    .update(reminders)
    .set({ status: "failed", attempts: row.attempts, lastError: error.slice(0, 500) })
    .where(eq(reminders.id, row.id));
  await audit(tx, {
    actorType: "system",
    action: "reminder.failed",
    entityType: "reminder",
    entityId: row.id,
    metadata: { channel: row.channel, job_id: row.jobId, error: error.slice(0, 200) },
  });
}

/**
 * Reconciliation pass: ensure every eligible job has its full reminder
 * set (covers jobs created before this worker existed, or missed hooks).
 * Cheap: scheduleRemindersForJob only inserts what's missing.
 */
export async function reconcileReminderSchedules(db: Pick<Db, "transaction">): Promise<number> {
  const admin = db as Db;
  const jobs = await admin
    .select({ id: cleaningJobs.id })
    .from(cleaningJobs)
    .where(inArray(cleaningJobs.status, [...ELIGIBLE_STATUSES]));
  let n = 0;
  for (const j of jobs) {
    await scheduleRemindersForJob(db, j.id);
    n++;
  }
  return n;
}

export { APP_TIME_ZONE };
