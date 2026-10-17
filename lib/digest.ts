/**
 * Daily digest email to the owner (Workstream E).
 *
 * Contracts §4.21: the "no silent failures" guarantee made concrete —
 * every day Jo gets: iCal sync failures, failed reminders (email direct
 * + SMS device-bridge), declined jobs awaiting reassignment, and
 * `needs_attention` flags. One send per day, tracked via the audit log
 * (`digest.sent`); a failed digest send is itself retried by the worker
 * and, if it keeps failing, logged loudly (console + audit).
 *
 * This is operational mail to the owner, not marketing — covered by the
 * standing send-mode authorization's failure-surfacing clause
 * (docs/decisions/2026-10-17-reminder-auto-send-authorization.md).
 */
import { and, desc, eq, gte, ne } from "drizzle-orm";
import { audit } from "./audit";
import { type Db, type Tx } from "./db";
import { sendEmail } from "./send";
import {
  auditLog,
  cleaningJobs,
  icalFeeds,
  memberships,
  properties,
  reminders,
  smsOutbox,
  users,
} from "./schema";
import { APP_TIME_ZONE, formatDatePT, formatWallTimePT, zonedDateTime } from "./time";

export interface DigestItems {
  syncFailures: { feedLabel: string; propertyName: string; error: string | null }[];
  failedReminders: { jobTitle: string; propertyName: string; channel: string; error: string | null }[];
  failedSms: { toPhone: string; jobTitle: string; error: string | null }[];
  declinedAwaiting: { jobTitle: string; propertyName: string; scheduledDate: string }[];
  needsAttention: { jobTitle: string; propertyName: string; scheduledDate: string; status: string }[];
}

/** Start of "today" in PT, as an ISO instant, minus lookback days. */
function ptDayStartIso(daysAgo = 0): string {
  const [y, m, d] = todayPtDate().split("-").map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d! - daysAgo));
  const dateStr = shifted.toISOString().slice(0, 10);
  return zonedDateTime(dateStr, "00:00").toISOString();
}

export async function collectDigestItems(tx: Tx): Promise<DigestItems> {
  const since = ptDayStartIso(1); // last ~24h window for failures

  const feeds = await tx
    .select({
      feedLabel: icalFeeds.label,
      propertyName: properties.name,
      error: icalFeeds.lastSyncError,
    })
    .from(icalFeeds)
    .innerJoin(properties, eq(properties.id, icalFeeds.propertyId))
    .where(eq(icalFeeds.lastSyncStatus, "error"));

  const failedRem = await tx
    .select({
      jobTitle: cleaningJobs.title,
      propertyName: properties.name,
      channel: reminders.channel,
      error: reminders.lastError,
    })
    .from(reminders)
    .innerJoin(cleaningJobs, eq(cleaningJobs.id, reminders.jobId))
    .innerJoin(properties, eq(properties.id, cleaningJobs.propertyId))
    .where(and(eq(reminders.status, "failed"), gte(reminders.createdAt, since)));

  const failedSmsRows = await tx
    .select({
      toPhone: smsOutbox.toPhone,
      error: smsOutbox.lastError,
      jobTitle: cleaningJobs.title,
    })
    .from(smsOutbox)
    .leftJoin(reminders, eq(reminders.id, smsOutbox.reminderId))
    .leftJoin(cleaningJobs, eq(cleaningJobs.id, reminders.jobId))
    .where(and(eq(smsOutbox.status, "failed"), gte(smsOutbox.createdAt, since)));

  // Declined jobs sitting back in `scheduled` with needs_attention:
  // the dispatcher said no and nobody has been reassigned yet.
  const declined = await tx
    .select({
      jobTitle: cleaningJobs.title,
      propertyName: properties.name,
      scheduledDate: cleaningJobs.scheduledDate,
    })
    .from(cleaningJobs)
    .innerJoin(properties, eq(properties.id, cleaningJobs.propertyId))
    .where(
      and(
        eq(cleaningJobs.status, "scheduled"),
        eq(cleaningJobs.needsAttention, true),
        gte(cleaningJobs.scheduledDate, todayPtDate()),
      ),
    );

  const attention = await tx
    .select({
      jobTitle: cleaningJobs.title,
      propertyName: properties.name,
      scheduledDate: cleaningJobs.scheduledDate,
      status: cleaningJobs.status,
    })
    .from(cleaningJobs)
    .innerJoin(properties, eq(properties.id, cleaningJobs.propertyId))
    .where(
      and(
        eq(cleaningJobs.needsAttention, true),
        ne(cleaningJobs.status, "completed"),
        ne(cleaningJobs.status, "cancelled"),
      ),
    )
    .orderBy(desc(cleaningJobs.scheduledDate));

  return {
    syncFailures: feeds,
    failedReminders: failedRem,
    failedSms: failedSmsRows.map((r) => ({
      toPhone: r.toPhone,
      jobTitle: r.jobTitle ?? "(unknown job)",
      error: r.error,
    })),
    declinedAwaiting: declined,
    needsAttention: attention,
  };
}

/** Today's PT date as YYYY-MM-DD. */
function todayPtDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts; // en-CA yields YYYY-MM-DD
}

export function buildDigestEmail(items: DigestItems, dateLabel: string): {
  subject: string;
  text: string;
} {
  const subject = `Daily digest — ${dateLabel}`;
  const lines = [`Cleaning operations digest for ${dateLabel} (Pacific):`, ``];
  let empty = true;

  const section = (title: string, rows: string[]) => {
    if (rows.length === 0) return;
    empty = false;
    lines.push(`${title} (${rows.length}):`);
    for (const r of rows) lines.push(`• ${r}`);
    lines.push(``);
  };

  section(
    "Calendar sync failures",
    items.syncFailures.map(
      (f) => `${f.propertyName} / ${f.feedLabel}${f.error ? ` — ${f.error.slice(0, 160)}` : ""}`,
    ),
  );
  section(
    "Failed reminders",
    items.failedReminders.map(
      (r) => `${r.propertyName}: ${r.jobTitle} (${r.channel})${r.error ? ` — ${r.error.slice(0, 160)}` : ""}`,
    ),
  );
  section(
    "Failed texts (device bridge)",
    items.failedSms.map(
      (s) => `${s.jobTitle} → ${s.toPhone}${s.error ? ` — ${s.error.slice(0, 160)}` : ""}`,
    ),
  );
  section(
    "Declined jobs awaiting reassignment",
    items.declinedAwaiting.map(
      (j) => `${formatDatePT(j.scheduledDate)} — ${j.propertyName}: ${j.jobTitle}`,
    ),
  );
  section(
    "Jobs needing attention",
    items.needsAttention.map(
      (j) =>
        `${formatDatePT(j.scheduledDate)} · ${formatWallTimePT("11:00")} — ${j.propertyName}: ${j.jobTitle} (${j.status})`,
    ),
  );

  if (empty) {
    lines.push(`All quiet — no failures, no unconfirmed jobs, nothing flagged.`);
  }
  lines.push(``, `Times are Pacific.`);
  return { subject, text: lines.join("\n") };
}

async function ownerEmail(tx: Tx): Promise<string | null> {
  const rows = await tx
    .select({ email: users.email })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(eq(memberships.role, "owner"))
    .limit(1);
  return rows[0]?.email ?? null;
}

/**
 * Send today's digest if one hasn't been sent yet (tracked via audit
 * `digest.sent` for the current PT date). Returns true when sent.
 */
export async function runDailyDigestIfDue(admin: Db): Promise<boolean> {
  const today = todayPtDate();
  return admin.transaction(async (tx0) => {
    const tx = tx0 as Tx;
    // Any digest.sent since today's PT midnight → already done.
    const sentToday = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "digest.sent"), gte(auditLog.createdAt, ptDayStartIso(0))))
      .limit(1);
    if (sentToday.length > 0) return false;

    const email = await ownerEmail(tx);
    if (!email) return false;
    const items = await collectDigestItems(tx);
    const { subject, text } = buildDigestEmail(items, formatDatePT(today));

    try {
      await sendEmail({ to: email, subject, text });
    } catch (e) {
      // A failed digest is itself a loud failure: audit it so the next
      // pass retries, and log loudly (never the body).
      await audit(tx, {
        actorType: "system",
        action: "digest.failed",
        entityType: "digest",
        metadata: { date: today, error: (e instanceof Error ? e.message : "unknown").slice(0, 200) },
      });
      console.error(JSON.stringify({ event: "digest_send_failed", date: today }));
      return false;
    }
    await audit(tx, {
      actorType: "system",
      action: "digest.sent",
      entityType: "digest",
      entityId: "00000000-0000-0000-0000-000000000000",
      metadata: {
        date: today,
        sync_failures: items.syncFailures.length,
        failed_reminders: items.failedReminders.length,
        failed_sms: items.failedSms.length,
        declined_awaiting: items.declinedAwaiting.length,
        needs_attention: items.needsAttention.length,
      },
    });
    return true;
  });
}

export { APP_TIME_ZONE as DIGEST_TIME_ZONE };
