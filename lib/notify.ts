/**
 * Message-fallback notifications (Workstream E).
 *
 * Contracts §4.22, §7.16: a new message on a job thread notifies the
 * other party — SMS via the owner's phone to the dispatcher (she lives
 * on text), email to the owner. If SMS fails, fall back to email for the
 * dispatcher too, and surface the failure per the no-silent-failures rule.
 *
 * Workstream D records intents in two places (see
 * docs/decisions/2026-10-17-message-notification-outbox.md):
 *   1. `notification_outbox` rows (the durable queue — preferred), and
 *   2. `audit_log` rows with action `message.posted` carrying
 *      metadata.notification {channel, recipient} (current implementation).
 * This worker drains BOTH: outbox rows first, then audit intents lacking a
 * matching `message.notification_sent` audit row. Once messaging.ts
 * writes to the outbox directly, path (2) becomes redundant but harmless.
 *
 * Notification text is fixed ("New message on [job] — open the app");
 * bodies and instruction values never enter this flow.
 */
import { and, eq } from "drizzle-orm";
import { audit } from "./audit";
import { type Db, type Tx } from "./db";
import { queueSmsForDevice, sendEmail, sendSmsViaTwilio, smsProvider } from "./send";
import {
  agencySettings,
  auditLog,
  cleaningJobs,
  memberships,
  notificationOutbox,
  users,
} from "./schema";

const MAX_ATTEMPTS = 3;

interface OutboxRow {
  id: string;
  jobId: string;
  channel: string;
  recipient: string;
  attempts: number;
}

async function resolveParties(tx: Tx): Promise<{
  dispatcherPhone: string;
  dispatcherEmail: string;
  ownerEmail: string;
} | null> {
  const agencies = await tx.select().from(agencySettings).limit(1);
  const agency = agencies[0];
  if (!agency) return null;
  const disp = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, agency.dispatcherUserId))
    .limit(1);
  const owners = await tx
    .select({ email: users.email })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(eq(memberships.role, "owner"))
    .limit(1);
  const ownerEmail = owners[0]?.email;
  if (!ownerEmail) return null;
  return {
    dispatcherPhone: agency.contactPhone,
    dispatcherEmail: disp[0]?.email ?? agency.contactEmail,
    ownerEmail,
  };
}

async function jobTitle(tx: Tx, jobId: string): Promise<string> {
  const rows = await tx
    .select({ title: cleaningJobs.title })
    .from(cleaningJobs)
    .where(eq(cleaningJobs.id, jobId))
    .limit(1);
  return rows[0]?.title ?? "a cleaning job";
}

/** Fixed notification copy — no bodies, no codes, ever. */
function notificationText(title: string): string {
  return `New message on "${title}" — open the app to read it.`;
}

async function deliverSms(
  tx: Tx,
  ref: { notificationId: string },
  toPhone: string,
  text: string,
): Promise<"sent" | "queued" | "failed"> {
  if (smsProvider() === "twilio") {
    try {
      await sendSmsViaTwilio(toPhone, text);
      return "sent";
    } catch {
      return "failed";
    }
  }
  await queueSmsForDevice(tx, ref, toPhone);
  return "queued";
}

async function processOutboxRow(
  tx: Tx,
  row: OutboxRow,
  parties: { dispatcherPhone: string; dispatcherEmail: string; ownerEmail: string },
): Promise<"sent" | "queued" | "failed"> {
  const title = await jobTitle(tx, row.jobId);
  const text = notificationText(title);
  const markSent = () =>
    tx
      .update(notificationOutbox)
      .set({ status: "sent", attempts: row.attempts + 1, sentAt: new Date().toISOString() })
      .where(eq(notificationOutbox.id, row.id));
  try {
    if (row.channel === "email") {
      const to = row.recipient === "dispatcher" ? parties.dispatcherEmail : parties.ownerEmail;
      await sendEmail({ to, subject: `New message on "${title}"`, text });
      await markSent();
    } else {
      // SMS → dispatcher only (contracts §7.16).
      const outcome = await deliverSms(tx, { notificationId: row.id }, parties.dispatcherPhone, text);
      if (outcome === "sent") {
        await markSent();
      } else if (outcome === "queued") {
        // Stays `pending`: the device drain marks sent/failed.
        return "queued";
      } else {
        // Twilio path failed → fall back to email for the dispatcher too.
        await sendEmail({
          to: parties.dispatcherEmail,
          subject: `New message on "${title}"`,
          text: `${text}\n\n(Text delivery failed — please check the app.)`,
        });
        await markSent();
        await audit(tx, {
          actorType: "system",
          action: "notification.sms_fallback_to_email",
          entityType: "notification_outbox",
          entityId: row.id,
          metadata: { job_id: row.jobId },
        });
      }
    }
    await audit(tx, {
      actorType: "system",
      action: "message.notification_sent",
      entityType: "notification_outbox",
      entityId: row.id,
      metadata: { channel: row.channel, recipient: row.recipient, job_id: row.jobId },
    });
    return "sent";
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await tx
        .update(notificationOutbox)
        .set({ status: "failed", attempts, lastError: msg.slice(0, 500) })
        .where(eq(notificationOutbox.id, row.id));
      await audit(tx, {
        actorType: "system",
        action: "message.notification_failed",
        entityType: "notification_outbox",
        entityId: row.id,
        metadata: { channel: row.channel, job_id: row.jobId, error: msg.slice(0, 200) },
      });
    } else {
      await tx
        .update(notificationOutbox)
        .set({ attempts, lastError: msg.slice(0, 500) })
        .where(eq(notificationOutbox.id, row.id));
    }
    return "failed";
  }
}

/**
 * Drain pending notification_outbox rows. Returns counts.
 */
export async function processNotificationOutbox(db: Pick<Db, "transaction">): Promise<{
  sent: number;
  queued: number;
  failed: number;
}> {
  const stats = { sent: 0, queued: 0, failed: 0 };
  await db.transaction(async (tx0) => {
    const tx = tx0 as Tx;
    const parties = await resolveParties(tx);
    if (!parties) return;
    const rows = (await tx
      .select({
        id: notificationOutbox.id,
        jobId: notificationOutbox.jobId,
        channel: notificationOutbox.channel,
        recipient: notificationOutbox.recipient,
        attempts: notificationOutbox.attempts,
      })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.status, "pending"))) as OutboxRow[];
    for (const row of rows) {
      const outcome = await processOutboxRow(tx, row, parties);
      stats[outcome]++;
    }
  });
  return stats;
}

/**
 * Converter for Workstream D's audit-log intents: find `message.posted`
 * audit rows with metadata.notification that have neither a matching
 * `notification_outbox` row nor a `message.notification_sent` audit row,
 * and convert them into outbox rows. The normal outbox drain then
 * delivers them. Once messaging.ts writes to the outbox directly, this
 * becomes a no-op — but it stays as the safety net.
 */
export async function convertMessagePostedIntents(db: Pick<Db, "transaction">): Promise<number> {
  let n = 0;
  await db.transaction(async (tx0) => {
    const tx = tx0 as Tx;
    const posted = await tx
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "message.posted"));
    for (const p of posted) {
      const meta = p.metadata as {
        job_id?: string;
        message_id?: string;
        notification?: { channel?: string; recipient?: string };
      } | null;
      const notif = meta?.notification;
      if (!notif?.channel || !meta?.job_id || !meta?.message_id || !p.entityId) continue;
      if (notif.channel !== "sms" && notif.channel !== "email") continue;
      const existing = await tx
        .select({ id: notificationOutbox.id })
        .from(notificationOutbox)
        .where(eq(notificationOutbox.messageId, meta.message_id))
        .limit(1);
      if (existing.length > 0) continue;
      const already = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "message.notification_sent"),
            eq(auditLog.entityId, p.entityId),
          ),
        )
        .limit(1);
      if (already.length > 0) continue;
      await tx.insert(notificationOutbox).values({
        jobId: meta.job_id,
        messageId: meta.message_id,
        channel: notif.channel,
        recipient: notif.recipient === "owner" ? "owner" : "dispatcher",
        status: "pending",
      });
      n++;
    }
  });
  return n;
}
