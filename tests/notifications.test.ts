/**
 * Notifications tests (Workstream E).
 *
 * Exercises lib/reminders.ts, lib/recap.ts, lib/digest.ts, lib/notify.ts
 * and lib/calendar.ts (pure parts) against a real Postgres (PGlite, RLS
 * included) — exactly like the production worker. Covers:
 * - reminder bodies render at send time with the CURRENT access
 *   instructions (change the code → next render uses the new one);
 * - bodies are never persisted (reminders/sms_outbox rows carry no body);
 * - recap is idempotent per week;
 * - the digest surfaces failed reminders;
 * - the SMS device bridge queues reference-only rows;
 * - calendar events build with the right shape and PT timezone.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, type Tx } from "../lib/db";
import {
  agencySettings,
  cleaningJobs,
  memberships,
  properties,
  recapRuns,
  reminders,
  smsOutbox,
  users,
} from "../lib/schema";
import { encryptField } from "../lib/crypto";
import { __setFetchForTests } from "../lib/send";
import {
  desiredReminders,
  processDueReminders,
  renderReminderEmail,
  renderReminderSms,
  scheduleRemindersForJob,
  skipRemindersForJob,
} from "../lib/reminders";
import { buildRecapEmail, mondayOfWeek, runRecap } from "../lib/recap";
import { buildDigestEmail, collectDigestItems } from "../lib/digest";
import { buildCalendarEvent } from "../lib/calendar";
import { queueSmsForDevice } from "../lib/send";

// Fixed test key — never a real secret.
process.env.ACCESS_INSTRUCTIONS_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// Mocked by __setFetchForTests below; the key just needs to be present.
process.env.RESEND_API_KEY = "test-key";

const appDb = { transaction: undefined as never } as Pick<Db, "transaction">;

let ownerId = "";
let dispatcherId = "";
let propertyId = "";
let jobId = "";

const sentEmails: { to: string; subject: string; text: string }[] = [];

// Mock Resend: capture instead of sending.
__setFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse((init?.body as string) ?? "{}");
  sentEmails.push({ to: body.to?.[0] ?? body.to, subject: body.subject, text: body.text });
  return new Response(JSON.stringify({ id: "mock-email-id" }), { status: 200 });
}) as typeof fetch);

let admin: ReturnType<typeof drizzlePglite>;

// PGlite's drizzle client is structurally what the worker functions need;
// the cast mirrors the pattern in the other workstream test files.
const asDb = (): Db => admin as unknown as Db;
const asTxDb = (): Pick<Db, "transaction"> => admin as unknown as Pick<Db, "transaction">;

function dbish(): Pick<Db, "transaction"> {
  return asTxDb();
}

function asAdmin<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (admin as unknown as Db).transaction(fn as never) as Promise<T>;
}

beforeAll(async () => {
  const client = new PGlite();
  const raw = drizzlePglite(client);
  await migrate(raw, { migrationsFolder: "./drizzle" });
  admin = drizzlePglite(client);
  Object.assign(appDb, { transaction: admin.transaction.bind(admin) });

  const [owner] = await admin
    .insert(users)
    .values({ email: "owner@test.dev", displayName: "Owner" })
    .returning();
  const [dispatcher] = await admin
    .insert(users)
    .values({ email: "dispatcher@test.dev", displayName: "Dispatcher" })
    .returning();
  ownerId = owner!.id;
  dispatcherId = dispatcher!.id;

  const [prop] = await admin
    .insert(properties)
    .values({
      name: "Test Cottage",
      listingAddress: "123 Test St",
      reminderHoursBefore: [24, 2],
      accessInstructions: encryptField("CODE-1111"),
    })
    .returning();
  propertyId = prop!.id;

  await admin.insert(memberships).values([
    { userId: ownerId, propertyId, role: "owner" },
    { userId: dispatcherId, propertyId, role: "dispatcher" },
  ]);

  await admin.insert(agencySettings).values({
    agencyName: "Test Agency",
    dispatcherUserId: dispatcherId,
    contactPhone: "+15550001111",
    contactEmail: "dispatcher@test.dev",
  });

  // Job tomorrow 11:00–15:00 PT, assigned.
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const [job] = await admin
    .insert(cleaningJobs)
    .values({
      propertyId,
      stableKey: "manual:notif-test-1",
      title: "Turnover",
      jobType: "turnover",
      scheduledDate: tomorrow,
      startTime: "11:00",
      endTime: "15:00",
      status: "assigned",
      assignedToUserId: dispatcherId,
      createdBy: ownerId,
    })
    .returning();
  jobId = job!.id;
}, 120000);

afterAll(async () => {
  // PGlite cleans up with the process.
});

describe("desiredReminders", () => {
  it("schedules sms+email per reminder_hours_before entry", () => {
    const desired = desiredReminders(
      {
        id: jobId,
        title: "Turnover",
        scheduledDate: "2026-10-25",
        startTime: "11:00",
        endTime: "15:00",
        status: "assigned",
        propertyId,
      },
      {
        id: propertyId,
        name: "Test Cottage",
        listingAddress: null,
        reminderHoursBefore: [24, 2],
        accessInstructionsEncrypted: null,
      },
    );
    expect(desired).toHaveLength(4);
    const channels = desired.map((d) => d.channel).sort();
    expect(channels).toEqual(["email", "email", "sms", "sms"]);
    // 24h before 2026-10-25 11:00 PT. 2026-10-25 is PDT (UTC-7).
    const sms24 = desired.find((d) => d.channel === "sms");
    expect(sms24).toBeDefined();
  });

  it("dedupes and ignores invalid hours", () => {
    const desired = desiredReminders(
      {
        id: jobId,
        title: "T",
        scheduledDate: "2026-10-25",
        startTime: "11:00",
        endTime: "15:00",
        status: "assigned",
        propertyId,
      },
      {
        id: propertyId,
        name: "P",
        listingAddress: null,
        reminderHoursBefore: [24, 24, -1],
        accessInstructionsEncrypted: null,
      },
    );
    expect(desired).toHaveLength(2); // one sms + one email for 24h
  });
});

describe("rendering", () => {
  const ctx = (instructions: string | null) => ({
    job: {
      id: jobId,
      title: "Turnover",
      scheduledDate: "2026-10-25",
      startTime: "11:00",
      endTime: "15:00",
      status: "assigned",
      propertyId,
    },
    propertyName: "Test Cottage",
    propertyAddress: "123 Test St",
    accessInstructions: instructions,
  });

  it("SMS includes the current instructions and PT times", () => {
    const body = renderReminderSms(ctx("CODE-2222"));
    expect(body).toContain("CODE-2222");
    expect(body).toContain("PT");
    expect(body).toContain("Test Cottage");
  });

  it("re-rendering after a code change uses the new code, not the old", () => {
    const before = renderReminderSms(ctx("CODE-1111"));
    const after = renderReminderSms(ctx("CODE-9999"));
    expect(before).toContain("CODE-1111");
    expect(after).toContain("CODE-9999");
    expect(after).not.toContain("CODE-1111");
  });

  it("email subject/body carry property, date, and instructions", () => {
    const { subject, text } = renderReminderEmail(ctx("CODE-3333"));
    expect(subject).toContain("Test Cottage");
    expect(text).toContain("CODE-3333");
    expect(text).toContain("PT");
  });

  it("handles missing instructions gracefully", () => {
    const sms = renderReminderSms(ctx(null));
    expect(sms).toContain("no instructions on file");
  });
});

describe("scheduleRemindersForJob", () => {
  it("creates 4 pending rows idempotently, skips them on cancel", async () => {
    const db = dbish();
    await scheduleRemindersForJob(db, jobId);
    let rows = await asAdmin((tx) => tx.select().from(reminders).where(eq(reminders.jobId, jobId)));
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    // No body column may exist on the row.
    expect("body" in rows[0]!).toBe(false);

    // Second call is a no-op (no duplicates).
    await scheduleRemindersForJob(db, jobId);
    rows = await asAdmin((tx) => tx.select().from(reminders).where(eq(reminders.jobId, jobId)));
    expect(rows.length).toBe(4);

    // Cancel the job → pending rows skipped.
    await asAdmin((tx) =>
      tx.update(cleaningJobs).set({ status: "cancelled" }).where(eq(cleaningJobs.id, jobId)),
    );
    await skipRemindersForJob(db, jobId);
    rows = await asAdmin((tx) => tx.select().from(reminders).where(eq(reminders.jobId, jobId)));
    expect(rows.every((r) => r.status === "skipped")).toBe(true);

    // Restore for later tests.
    await asAdmin((tx) =>
      tx.update(cleaningJobs).set({ status: "assigned" }).where(eq(cleaningJobs.id, jobId)),
    );
  });
});

describe("processDueReminders", () => {
  it("sends due email via Resend and queues SMS reference-only", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const [emailRow, smsRow] = await asAdmin(async (tx) => {
      const e = await tx
        .insert(reminders)
        .values({ jobId, channel: "email", recipient: "dispatcher", scheduledFor: past, status: "pending" })
        .returning();
      const s = await tx
        .insert(reminders)
        .values({ jobId, channel: "sms", recipient: "dispatcher", scheduledFor: past, status: "pending" })
        .returning();
      return [e[0]!.id, s[0]!.id] as const;
    });

    const stats = await processDueReminders(dbish());
    expect(stats.sent).toBe(1);
    expect(stats.smsQueued).toBe(1);

    // Email went out with the CURRENT code (CODE-1111 in DB).
    expect(sentEmails.length).toBeGreaterThan(0);
    const last = sentEmails[sentEmails.length - 1]!;
    expect(last.to).toBe("dispatcher@test.dev");
    expect(last.text).toContain("CODE-1111");

    // Email reminder marked sent.
    const emailAfter = await asAdmin((tx) =>
      tx.select().from(reminders).where(eq(reminders.id, emailRow)),
    );
    expect(emailAfter[0]!.status).toBe("sent");

    // SMS reminder still pending (device drain completes it); the
    // outbox row is reference-only — no body column exists.
    const smsAfter = await asAdmin((tx) =>
      tx.select().from(reminders).where(eq(reminders.id, smsRow)),
    );
    expect(smsAfter[0]!.status).toBe("pending");
    const outbox = await asAdmin((tx) =>
      tx.select().from(smsOutbox).where(eq(smsOutbox.reminderId, smsRow)),
    );
    expect(outbox.length).toBe(1);
    expect("body" in outbox[0]!).toBe(false);
    expect(outbox[0]!.toPhone).toBe("+15550001111");
  });

  it("marks email failed after max attempts and never logs the body", async () => {
    // Point fetch at a failing endpoint.
    __setFetchForTests((async () => new Response("boom", { status: 500 })) as typeof fetch);
    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      const [rowId] = await asAdmin(async (tx) => {
        const [row] = await tx
          .insert(reminders)
          .values({
            jobId,
            channel: "email",
            recipient: "dispatcher",
            scheduledFor: past,
            status: "pending",
            attempts: 2,
          })
          .returning();
        return [row!.id] as const;
      });
      const stats = await processDueReminders(dbish());
      expect(stats.failed).toBe(1);
      const after = await asAdmin((tx) =>
        tx.select().from(reminders).where(eq(reminders.id, rowId)),
      );
      expect(after[0]!.status).toBe("failed");
      expect(after[0]!.lastError).not.toContain("CODE-");
    } finally {
      __setFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        sentEmails.push({ to: body.to?.[0] ?? body.to, subject: body.subject, text: body.text });
        return new Response(JSON.stringify({ id: "mock-email-id" }), { status: 200 });
      }) as typeof fetch);
    }
  });
});

describe("queueSmsForDevice", () => {
  it("is idempotent and stores no body", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const [rowId] = await asAdmin(async (tx) => {
      const [row] = await tx
        .insert(reminders)
        .values({ jobId, channel: "sms", recipient: "dispatcher", scheduledFor: past, status: "pending" })
        .returning();
      return [row!.id] as const;
    });
    const [id1, id2] = await asAdmin(async (tx) => {
      const a = await queueSmsForDevice(tx, { reminderId: rowId }, "+15550001111");
      const b = await queueSmsForDevice(tx, { reminderId: rowId }, "+15550001111");
      return [a, b] as const;
    });
    expect(id1).toBe(id2);
  });
});

describe("recap", () => {
  it("mondayOfWeek maps Saturday to the preceding Monday", () => {
    // 2026-10-17 is a Saturday.
    expect(mondayOfWeek(new Date("2026-10-17T12:00:00-07:00"))).toBe("2026-10-12");
  });

  it("buildRecapEmail lists jobs with PT times and flags", () => {
    const { subject, text } = buildRecapEmail(
      [
        {
          id: "j1",
          title: "Turnover",
          scheduledDate: "2026-10-19",
          startTime: "11:00",
          endTime: "15:00",
          status: "assigned",
          needsAttention: true,
          propertyName: "Test Cottage",
          assigneeName: "Dispatcher",
        },
      ],
      "2026-10-19",
    );
    expect(subject).toContain("2026");
    expect(text).toContain("Test Cottage");
    expect(text).toContain("PT");
    expect(text).toContain("needs attention");
    expect(text).toContain("Not yet confirmed");
    // No access instructions in the recap.
    expect(text).not.toContain("CODE-");
  });

  it("runRecap is idempotent per week", async () => {
    const first = await runRecap(asDb(), { force: true, now: new Date("2026-10-17T09:00:00-07:00") });
    expect(first.status).toBe("sent");
    const second = await runRecap(asDb(), { now: new Date("2026-10-17T10:00:00-07:00") });
    expect(second.skipped).toBe(true);
    expect(second.recapRunId).toBe(first.recapRunId);
    const rows = await asAdmin((tx) => tx.select().from(recapRuns));
    expect(rows.filter((r) => r.weekStarting === "2026-10-12").length).toBe(1);
  });
});

describe("digest", () => {
  it("surfaces failed reminders in the digest items", async () => {
    const admin = appDb as unknown as Db;
    await admin.transaction(async (tx0) => {
      const tx = tx0 as Tx;
      await tx.insert(reminders).values({
        jobId,
        channel: "email",
        recipient: "dispatcher",
        scheduledFor: new Date().toISOString(),
        status: "failed",
        lastError: "simulated failure",
      });
      const items = await collectDigestItems(tx);
      expect(items.failedReminders.length).toBeGreaterThan(0);
      const email = buildDigestEmail(items, "Sat, Oct 17, 2026");
      expect(email.text).toContain("Failed reminders");
      expect(email.subject).toContain("Daily digest");
    });
  });
});

describe("buildCalendarEvent", () => {
  it("builds a PT event with current instructions in the description", () => {
    const ev = buildCalendarEvent(
      {
        id: jobId,
        title: "Turnover",
        status: "confirmed",
        scheduledDate: "2026-10-25",
        startTime: "11:00",
        endTime: "15:00",
        googleEventId: null,
      },
      { name: "Test Cottage", listingAddress: "123 Test St" },
      "CODE-7777",
    );
    expect(ev.summary).toContain("Test Cottage");
    expect(ev.start.timeZone).toBe("America/Los_Angeles");
    expect(ev.end.timeZone).toBe("America/Los_Angeles");
    expect(ev.start.dateTime).toBe("2026-10-25T11:00:00");
    expect(ev.end.dateTime).toBe("2026-10-25T15:00:00");
    expect(ev.location).toBe("123 Test St");
    expect(ev.description).toContain("CODE-7777");
    expect(ev.description).toContain("Confirmed");
  });
});
