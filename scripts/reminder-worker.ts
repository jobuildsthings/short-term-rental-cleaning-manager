/**
 * Reminder + notification worker entry point (Workstream E).
 *
 * Owns everything time-driven on the notifications side:
 *   - due reminders (email direct via Resend; SMS queued reference-only
 *     for the device bridge)
 *   - reminder schedule reconciliation (covers missed lifecycle hooks)
 *   - message-fallback notification outbox (+ audit-intent converter)
 *   - shared "Cleanings" calendar reconciliation
 *   - Saturday recap email (owner + dispatcher)
 *   - daily digest email (owner)
 *
 * Runs forever until SIGTERM/SIGINT; one pass every 60 seconds.
 * Uses the owner connection (DATABASE_URL): bypassing RLS is allowed for
 * workers (see lib/db.ts).
 *
 * Usage: tsx scripts/reminder-worker.ts   (documented in docs/worker-ops.md)
 * Logs are JSON, one event per line — and NEVER include feed URLs,
 * message bodies, phone numbers, or access-instruction values.
 *
 * NOTE on SMS: this worker never sends texts itself. SMS rows are queued
 * into `sms_outbox` (reference only, no bodies) for the device bridge —
 * a Muse-side scheduled job drains the queue with the owner's paired
 * phone (message.send). See docs/sms-device-bridge.md. Twilio is the
 * documented fallback (SMS_PROVIDER=twilio).
 */
import { getDbAdmin } from "../lib/db";
import { reconcileCalendar } from "../lib/calendar";
import { runDailyDigestIfDue } from "../lib/digest";
import { convertMessagePostedIntents, processNotificationOutbox } from "../lib/notify";
import { runRecapIfDue } from "../lib/recap";
import { processDueReminders, reconcileReminderSchedules } from "../lib/reminders";

const INTERVAL_MS = 60_000;
const CALENDAR_SWEEP_MS = 15 * 60 * 1000; // 15 minutes
let lastCalendarSweep = 0;
let lastCalendarIncremental = "";

function log(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...extra }));
}

async function pass(): Promise<void> {
  const db = getDbAdmin();

  try {
    const r = await processDueReminders(db);
    if (r.sent + r.smsQueued + r.failed > 0) {
      log("reminders_processed", r);
    }
  } catch (e) {
    log("reminders_pass_failed", { error: e instanceof Error ? e.message : "unknown" });
  }

  try {
    const n = await reconcileReminderSchedules(db);
    void n;
  } catch (e) {
    log("reminder_reconcile_failed", { error: e instanceof Error ? e.message : "unknown" });
  }

  try {
    const converted = await convertMessagePostedIntents(db);
    const o = await processNotificationOutbox(db);
    if (converted > 0 || o.sent + o.queued + o.failed > 0) {
      log("notifications_processed", { converted, ...o });
    }
  } catch (e) {
    log("notifications_pass_failed", { error: e instanceof Error ? e.message : "unknown" });
  }

  try {
    const now = Date.now();
    if (now - lastCalendarSweep > CALENDAR_SWEEP_MS) {
      // Incremental: jobs changed since the last sweep.
      const since = lastCalendarIncremental || new Date(now - CALENDAR_SWEEP_MS).toISOString();
      const n = await reconcileCalendar(db, since);
      lastCalendarIncremental = new Date().toISOString();
      lastCalendarSweep = now;
      if (n > 0) log("calendar_reconciled", { jobs: n });
    }
  } catch (e) {
    // Calendar sync failing must not stop reminders — but it must not be
    // silent either: the digest picks it up via the audit row.
    log("calendar_pass_failed", { error: e instanceof Error ? e.message : "unknown" });
    const { audit } = await import("../lib/audit");
    await getDbAdmin().transaction(async (tx) => {
      await audit(tx as never, {
        actorType: "system",
        action: "calendar.sync_failed",
        entityType: "calendar",
        metadata: { error: (e instanceof Error ? e.message : "unknown").slice(0, 200) },
      });
    }).catch(() => undefined);
  }

  try {
    if (await runRecapIfDue(db)) log("recap_sent", {});
  } catch (e) {
    log("recap_failed", { error: e instanceof Error ? e.message : "unknown" });
  }

  try {
    if (await runDailyDigestIfDue(db)) log("digest_sent", {});
  } catch (e) {
    log("digest_failed", { error: e instanceof Error ? e.message : "unknown" });
  }
}

async function main(): Promise<void> {
  log("reminder_worker_start", { interval_ms: INTERVAL_MS });
  for (;;) {
    await pass().catch((e) =>
      log("pass_crashed", { error: e instanceof Error ? e.message : "unknown" }),
    );
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

process.on("SIGTERM", () => {
  log("reminder_worker_stop", { signal: "SIGTERM" });
  process.exit(0);
});
process.on("SIGINT", () => process.exit(0));

void main();
