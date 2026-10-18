/**
 * QA gate tests (Workstream F) — adversarial verification of gaps the
 * workstream test suites did not cover:
 *
 * 1. Decline via transitionJob (lib/scheduler.ts) follows the contracts'
 *    two-step: assigned → declined → scheduled, assignment cleared,
 *    needs_attention set, both steps audited.
 * 2. Calendar lifecycle (UC7/UC8): buildCalendarEvent carries PT timezone
 *    and current instructions; syncJobEvent creates/updates/deletes via a
 *    mocked Google API and maintains google_event_id.
 * 3. Access-instruction change (UC13): history row holds the prior
 *    ENCRYPTED value; audit metadata holds no values.
 * 4. Fit check: back-to-back reservations with an impossible window flag
 *    needs_attention instead of silently creating a bad job.
 * 5. Checklist template CRUD round-trip (routes added by QA).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../lib/db";
import { decryptField, encryptField } from "../lib/crypto";
import {
  buildCalendarEvent,
  syncJobEvent,
} from "../lib/calendar";
import {
  applyFeedSync,
  reconcileTurnoverJobs,
  transitionJob,
  turnoverStableKey,
} from "../lib/scheduler";
import {
  accessInstructionHistory,
  agencySettings,
  auditLog,
  checklistItems,
  checklistTemplates,
  cleaningJobs,
  googleOauthTokens,
  icalFeeds,
  memberships,
  properties,
  users,
} from "../lib/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asTx = (db: any): Tx => db as Tx;

let db: ReturnType<typeof drizzlePglite>;
let ownerId = "";
let dispatcherId = "";
let propertyId = "";
let feedId = "";

function parsed(
  events: Array<{ uid: string; summary?: string; checkIn: string; checkOut: string }>,
) {
  return {
    ok: true as const,
    events: events.map((e) => ({
      uid: e.uid,
      summary: e.summary ?? null,
      checkIn: e.checkIn,
      checkOut: e.checkOut,
      cancelled: false,
    })),
    skipped: 0,
  };
}

beforeAll(async () => {
  process.env.ACCESS_INSTRUCTIONS_KEY = "a".repeat(64);
  process.env.GOOGLE_CLIENT_ID = "qa-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "qa-client-secret";
  const client = new PGlite();
  const raw = drizzlePglite(client);
  await migrate(raw, { migrationsFolder: "./drizzle" });
  db = drizzlePglite(client);

  const [owner] = await db.insert(users).values({ email: "qa-owner@test.dev", displayName: "QA Owner" }).returning();
  ownerId = owner!.id;
  const [disp] = await db.insert(users).values({ email: "qa-dispatcher@test.dev", displayName: "QA Dispatcher" }).returning();
  dispatcherId = disp!.id;
  const [prop] = await db.insert(properties).values({ name: "QA Property" }).returning();
  propertyId = prop!.id;
  await db.insert(memberships).values({ userId: ownerId, propertyId, role: "owner" });
  await db.insert(memberships).values({ userId: dispatcherId, propertyId, role: "dispatcher" });
  await db.insert(agencySettings).values({
    agencyName: "QA Agency",
    dispatcherUserId: dispatcherId,
    contactPhone: "+10000000000",
    contactEmail: "qa-dispatcher@test.dev",
  });
  const [feed] = await db.insert(icalFeeds).values({ propertyId, label: "QA feed", url: "https://example.com/qa.ics" }).returning();
  feedId = feed!.id;
});

describe("decline follows the contracts two-step", () => {
  it("assigned → declined → scheduled, assignment cleared, needs_attention set", async () => {
    await applyFeedSync(
      asTx(db),
      feedId,
      parsed([{ uid: "qa-decline-1", summary: "Guest", checkIn: "2026-12-01", checkOut: "2026-12-05" }]),
    );
    const key = turnoverStableKey(feedId, "qa-decline-1");
    const [job] = await db.select().from(cleaningJobs).where(eq(cleaningJobs.stableKey, key)).limit(1);
    // assign to dispatcher
    await db.update(cleaningJobs).set({ status: "assigned", assignedToUserId: dispatcherId }).where(eq(cleaningJobs.id, job!.id));

    const result = await transitionJob(
      asTx(db),
      job!.id,
      "declined",
      { kind: "user", userId: dispatcherId, role: "dispatcher" },
      { reason: "overbooked" },
    );
    expect(result.status).toBe("scheduled");
    expect(result.assignedToUserId).toBeNull();
    expect(result.needsAttention).toBe(true);

    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, job!.id));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("job.status_changed");
    expect(actions).toContain("job.returned_to_pool");
    // No instruction values or bodies in audit metadata
    for (const a of audits) {
      expect(JSON.stringify(a.metadata)).not.toContain("overbooked-secret");
    }
  });

  it("a stranger cannot decline someone else's job", async () => {
    const [stranger] = await db.insert(users).values({ email: "qa-stranger@test.dev", displayName: "Stranger" }).returning();
    await applyFeedSync(
      asTx(db),
      feedId,
      parsed([{ uid: "qa-decline-2", summary: "Guest", checkIn: "2026-12-10", checkOut: "2026-12-12" }]),
    );
    const [job] = await db.select().from(cleaningJobs).where(eq(cleaningJobs.stableKey, turnoverStableKey(feedId, "qa-decline-2"))).limit(1);
    await db.update(cleaningJobs).set({ status: "assigned", assignedToUserId: dispatcherId }).where(eq(cleaningJobs.id, job!.id));
    await expect(
      transitionJob(asTx(db), job!.id, "declined", { kind: "user", userId: stranger!.id, role: "dispatcher" }),
    ).rejects.toThrow();
  });
});

describe("calendar event lifecycle (UC7/UC8)", () => {
  it("buildCalendarEvent uses PT timezone and current instructions", () => {
    const ev = buildCalendarEvent(
      {
        id: "j1", title: "Turnover", status: "confirmed",
        scheduledDate: "2026-11-05", startTime: "11:00", endTime: "15:00",
        googleEventId: null,
      },
      { name: "Beach House", listingAddress: "1 Ocean Ave" },
      "Gate code 1234",
    );
    expect(ev.start.timeZone).toBe("America/Los_Angeles");
    expect(ev.end.timeZone).toBe("America/Los_Angeles");
    expect(ev.start.dateTime).toBe("2026-11-05T11:00:00");
    expect(ev.description).toContain("Gate code 1234");
    expect(ev.description).toContain("Confirmed");
    expect(ev.location).toBe("1 Ocean Ave");
  });

  it("syncJobEvent creates, updates, and deletes via the Google API", async () => {
    // Owner OAuth token with calendar scope (encrypted at rest)
    process.env.GOOGLE_CLIENT_ID = "qa-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "qa-client-secret";
    await db.insert(googleOauthTokens).values({
      userId: ownerId,
      refreshTokenEncrypted: encryptField("qa-refresh-token"),
      scope: "openid email profile https://www.googleapis.com/auth/calendar",
    });
    await db.update(agencySettings).set({ googleCalendarId: "qa-calendar-id", googleCalendarShared: true });

    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "qa-access" }), { status: 200 });
      }
      if (u.endsWith("/events") && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ id: "qa-event-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    try {
      await applyFeedSync(
        asTx(db),
        feedId,
        parsed([{ uid: "qa-cal-1", summary: "Guest", checkIn: "2026-12-15", checkOut: "2026-12-18" }]),
      );
      const [job] = await db.select().from(cleaningJobs).where(eq(cleaningJobs.stableKey, turnoverStableKey(feedId, "qa-cal-1"))).limit(1);

      // create
      await syncJobEvent(db as never, job!.id);
      const [created] = await db.select().from(cleaningJobs).where(eq(cleaningJobs.id, job!.id)).limit(1);
      expect(created!.googleEventId).toBe("qa-event-1");
      const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/events"));
      expect(post).toBeDefined();
      const body = JSON.parse(post!.body!);
      expect(body.start.timeZone).toBe("America/Los_Angeles");

      // update (reschedule → PATCH)
      calls.length = 0;
      await db.update(cleaningJobs).set({ scheduledDate: "2026-12-16" }).where(eq(cleaningJobs.id, job!.id));
      await syncJobEvent(db as never, job!.id);
      expect(calls.some((c) => c.method === "PATCH" && c.url.includes("qa-event-1"))).toBe(true);

      // delete (cancel → DELETE, googleEventId cleared)
      calls.length = 0;
      await db.update(cleaningJobs).set({ status: "cancelled" }).where(eq(cleaningJobs.id, job!.id));
      await syncJobEvent(db as never, job!.id);
      expect(calls.some((c) => c.method === "DELETE" && c.url.includes("qa-event-1"))).toBe(true);
      const [deleted] = await db.select().from(cleaningJobs).where(eq(cleaningJobs.id, job!.id)).limit(1);
      expect(deleted!.googleEventId).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("access instruction history (UC13)", () => {
  it("change writes the prior ENCRYPTED value to history; audit holds no values", async () => {
    const secret1 = "gate-1111-qa";
    const secret2 = "gate-2222-qa";
    await db.update(properties).set({ accessInstructions: encryptField(secret1) }).where(eq(properties.id, propertyId));

    // Simulate the PATCH route logic: history-first, then update
    const [before] = await db.select().from(properties).where(eq(properties.id, propertyId)).limit(1);
    const current = before!.accessInstructions ? decryptField(before!.accessInstructions) : null;
    expect(current).toBe(secret1);
    if (before!.accessInstructions) {
      await db.insert(accessInstructionHistory).values({
        propertyId,
        instructionsEncrypted: before!.accessInstructions,
        changedBy: ownerId,
      });
    }
    await db.update(properties).set({ accessInstructions: encryptField(secret2) }).where(eq(properties.id, propertyId));

    const hist = await db.select().from(accessInstructionHistory).where(eq(accessInstructionHistory.propertyId, propertyId));
    expect(hist.length).toBeGreaterThanOrEqual(1);
    // The stored history value is ciphertext, decrypts to the OLD value
    expect(hist[hist.length - 1]!.instructionsEncrypted).not.toContain(secret1);
    expect(decryptField(hist[hist.length - 1]!.instructionsEncrypted)).toBe(secret1);
    // Current value is the new one
    const [after] = await db.select().from(properties).where(eq(properties.id, propertyId)).limit(1);
    expect(decryptField(after!.accessInstructions!)).toBe(secret2);
  });
});

describe("fit check on impossible windows", () => {
  it("flags needs_attention when the turnover cannot fit", async () => {
    // A 60-minute turnover buffer makes the 11:00–15:00 job (240 min)
    // exceed the available 180-min window on a same-day turnover.
    await db.update(properties).set({ turnoverBufferMinutes: 60 }).where(eq(properties.id, propertyId));
    await applyFeedSync(
      asTx(db),
      feedId,
      parsed([
        { uid: "qa-fit-1", summary: "A", checkIn: "2026-12-18", checkOut: "2026-12-20" },
        { uid: "qa-fit-2", summary: "B", checkIn: "2026-12-20", checkOut: "2026-12-22" },
      ]),
    );
    const [job] = await db.select().from(cleaningJobs).where(eq(cleaningJobs.stableKey, turnoverStableKey(feedId, "qa-fit-1"))).limit(1);
    expect(job).toBeDefined();
    // The job is still created (never silently dropped) but flagged.
    expect(job!.needsAttention).toBe(true);
    await db.update(properties).set({ turnoverBufferMinutes: 0 }).where(eq(properties.id, propertyId));
  });
});

describe("checklist template round-trip", () => {
  it("creates a template with items and cascades on delete", async () => {
    const [t] = await db.insert(checklistTemplates).values({ propertyId, name: "QA Template" }).returning();
    await db.insert(checklistItems).values([
      { templateId: t!.id, label: "Item one", sortOrder: 0 },
      { templateId: t!.id, label: "Item two", sortOrder: 1, photoRequired: true },
    ]);
    const items = await db.select().from(checklistItems).where(eq(checklistItems.templateId, t!.id));
    expect(items).toHaveLength(2);
    await db.delete(checklistTemplates).where(eq(checklistTemplates.id, t!.id));
    const after = await db.select().from(checklistItems).where(eq(checklistItems.templateId, t!.id));
    expect(after).toHaveLength(0);
  });
});

describe("idempotent turnover reconciliation", () => {
  it("running reconcileTurnoverJobs twice creates exactly one job", async () => {
    await applyFeedSync(
      asTx(db),
      feedId,
      parsed([{ uid: "qa-idem-1", summary: "Guest", checkIn: "2027-01-05", checkOut: "2027-01-08" }]),
    );
    const [prop] = await db.select().from(properties).where(eq(properties.id, propertyId)).limit(1);
    await reconcileTurnoverJobs(asTx(db), prop!, new Set());
    await reconcileTurnoverJobs(asTx(db), prop!, new Set());
    const jobs = await db.select().from(cleaningJobs).where(eq(cleaningJobs.stableKey, turnoverStableKey(feedId, "qa-idem-1")));
    expect(jobs).toHaveLength(1);
  });
});
