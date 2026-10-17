/**
 * Saturday recap email (Workstream E).
 *
 * Contracts §4.17, §7.11: every Saturday (default 08:00
 * America/Los_Angeles; configurable per agency_settings.recap_weekday /
 * recap_time), email the owner AND the dispatcher the upcoming 7 days of
 * cleanings — date, time window, property, status, assignee — plus
 * sections flagging unconfirmed jobs and `needs_attention` jobs.
 *
 * Idempotency: one `recap_runs` row per week_starting (Monday); a second
 * run for the same week is a no-op. The unique constraint on
 * recap_runs.week_starting is the backstop.
 *
 * This is one of the two authorized auto-send types
 * (docs/decisions/2026-10-17-reminder-auto-send-authorization.md).
 */
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { audit } from "./audit";
import { type Db, type Tx } from "./db";
import { sendEmail } from "./send";
import {
  agencySettings,
  cleaningJobs,
  memberships,
  properties,
  recapRuns,
  users,
} from "./schema";
import { APP_TIME_ZONE, formatDatePT, formatWallTimePT } from "./time";

export interface RecapJobView {
  id: string;
  title: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  status: string;
  needsAttention: boolean;
  propertyName: string;
  assigneeName: string | null;
}

/** Monday (YYYY-MM-DD) of the week containing `d` (PT calendar). */
export function mondayOfWeek(d: Date): string {
  const pt = new Date(
    d.toLocaleString("en-US", { timeZone: APP_TIME_ZONE }),
  );
  const dow = pt.getDay(); // 0=Sun … 6=Sat
  const monday = new Date(pt);
  monday.setDate(pt.getDate() - ((dow + 6) % 7));
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, "0");
  const day = String(monday.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Current PT weekday (0=Sun…6=Sat) and HH:MM wall time. */
export function nowPtParts(now = new Date()): { weekday: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  return { weekday, hhmm: `${get("hour")}:${get("minute")}` };
}

export function buildRecapEmail(
  jobs: RecapJobView[],
  weekStarting: string,
): { subject: string; text: string } {
  const weekEnding = addDays(weekStarting, 6);
  const subject = `Weekly cleaning recap — week of ${formatDatePT(weekStarting)}`;
  const lines = [
    `Here's what's scheduled for the coming week (${formatDatePT(weekStarting)} – ${formatDatePT(weekEnding)}):`,
    ``,
  ];
  if (jobs.length === 0) {
    lines.push(`No cleanings scheduled this week.`);
  } else {
    for (const j of jobs) {
      const when = `${formatDatePT(j.scheduledDate)} · ${formatWallTimePT(j.startTime)} – ${formatWallTimePT(j.endTime)}`;
      const who = j.assigneeName ? ` — ${j.assigneeName}` : "";
      const flag = j.needsAttention ? "  ⚠ needs attention" : "";
      lines.push(`• ${when} — ${j.propertyName} (${j.status})${who}${flag}`);
    }
  }
  const unconfirmed = jobs.filter((j) => j.status === "assigned");
  if (unconfirmed.length > 0) {
    lines.push(``, `Not yet confirmed (${unconfirmed.length}):`);
    for (const j of unconfirmed) {
      lines.push(`• ${formatDatePT(j.scheduledDate)} — ${j.propertyName}`);
    }
  }
  const attention = jobs.filter((j) => j.needsAttention);
  if (attention.length > 0) {
    lines.push(``, `Needs attention (${attention.length}):`);
    for (const j of attention) {
      lines.push(`• ${formatDatePT(j.scheduledDate)} — ${j.propertyName}: ${j.title}`);
    }
  }
  lines.push(``, `Times are Pacific.`);
  return { subject, text: lines.join("\n") };
}

async function loadWeekJobs(tx: Tx, weekStarting: string): Promise<RecapJobView[]> {
  const weekEndExclusive = addDays(weekStarting, 7);
  const rows = await tx
    .select({
      job: cleaningJobs,
      propertyName: properties.name,
      assigneeName: users.displayName,
    })
    .from(cleaningJobs)
    .innerJoin(properties, eq(cleaningJobs.propertyId, properties.id))
    .leftJoin(users, eq(users.id, cleaningJobs.assignedToUserId))
    .where(
      and(
        gte(cleaningJobs.scheduledDate, weekStarting),
        lt(cleaningJobs.scheduledDate, weekEndExclusive),
      ),
    )
    .orderBy(asc(cleaningJobs.scheduledDate), asc(cleaningJobs.startTime));
  return rows.map((r) => ({
    id: r.job.id,
    title: r.job.title,
    scheduledDate: r.job.scheduledDate,
    startTime: r.job.startTime,
    endTime: r.job.endTime,
    status: r.job.status,
    needsAttention: r.job.needsAttention,
    propertyName: r.propertyName,
    assigneeName: r.assigneeName,
  }));
}

/**
 * Generate + send the recap for the week containing `now` (or send
 * immediately when `force` is true, e.g. the manual admin trigger).
 * Idempotent per week_starting: returns the existing sent run instead of
 * double-sending.
 */
export async function runRecap(
  admin: Db,
  opts: { force?: boolean; now?: Date } = {},
): Promise<{ recapRunId: string; status: string; skipped?: boolean }> {
  const now = opts.now ?? new Date();
  const weekStarting = mondayOfWeek(now);

  return admin.transaction(async (tx0) => {
    const tx = tx0 as Tx;
    const existing = await tx
      .select()
      .from(recapRuns)
      .where(eq(recapRuns.weekStarting, weekStarting))
      .limit(1);
    if (existing[0]?.status === "sent" && !opts.force) {
      return { recapRunId: existing[0].id, status: "sent", skipped: true };
    }

    const settings = await tx.select().from(agencySettings).limit(1);
    const agency = settings[0];
    if (!agency) throw new Error("agency_settings row missing");

    // owner = any user with an owner membership (single-owner system)
    const owners = await tx
      .select({ email: users.email })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(eq(memberships.role, "owner"))
      .limit(1);
    const ownerEmail = owners[0]?.email;
    if (!ownerEmail) throw new Error("no owner email found");

    const jobs = await loadWeekJobs(tx, weekStarting);
    const { subject, text } = buildRecapEmail(jobs, weekStarting);

    const [run] = existing[0]
      ? [existing[0]]
      : await tx
          .insert(recapRuns)
          .values({ weekStarting, status: "pending" })
          .returning();
    try {
      // Owner + dispatcher (contracts §4.17).
      await sendEmail({ to: ownerEmail, subject, text });
      await sendEmail({ to: agency.contactEmail, subject, text });
      await tx
        .update(recapRuns)
        .set({ status: "sent", sentAt: new Date().toISOString(), error: null })
        .where(eq(recapRuns.id, run!.id));
      await audit(tx, {
        actorType: "system",
        action: "recap.sent",
        entityType: "recap_run",
        entityId: run!.id,
        metadata: { week_starting: weekStarting, jobs: jobs.length },
      });
      return { recapRunId: run!.id, status: "sent" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      await tx
        .update(recapRuns)
        .set({ status: "failed", error: msg.slice(0, 500) })
        .where(eq(recapRuns.id, run!.id));
      await audit(tx, {
        actorType: "system",
        action: "recap.failed",
        entityType: "recap_run",
        entityId: run!.id,
        metadata: { week_starting: weekStarting, error: msg.slice(0, 200) },
      });
      throw e;
    }
  });
}

/**
 * Worker entry: send the recap when the configured weekday/time is
 * reached (default Saturday 08:00 PT). No-op otherwise.
 */
export async function runRecapIfDue(admin: Db, now = new Date()): Promise<boolean> {
  const settings = await admin.select().from(agencySettings).limit(1);
  const agency = settings[0];
  if (!agency) return false;
  const { weekday, hhmm } = nowPtParts(now);
  const recapHhmm = agency.recapTime.length === 5 ? agency.recapTime : agency.recapTime.slice(0, 5);
  if (weekday !== agency.recapWeekday || hhmm < recapHhmm) return false;
  const weekStarting = mondayOfWeek(now);
  const existing = await admin
    .select({ status: recapRuns.status })
    .from(recapRuns)
    .where(eq(recapRuns.weekStarting, weekStarting))
    .limit(1);
  if (existing[0]?.status === "sent") return false;
  await runRecap(admin, { now });
  return true;
}
