/**
 * Scheduling engine tests (Workstream B).
 *
 * Runs against PGlite (real Postgres, migrations applied) with the admin
 * connection — the same trust level as the scheduler worker. Covers:
 * turnover derivation, idempotency, date-change moves, manual-move
 * protection, reservation removals, the fit-check flag, and the three
 * recurring-series edit scopes.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../lib/db";
import {
  applyFeedSync,
  createSeries,
  overrideOccurrence,
  reconcileTurnoverJobs,
  splitSeries,
  todayPT,
  transitionJob,
  turnoverStableKey,
  updateSeries,
} from "../lib/scheduler";
import {
  cleaningJobs,
  icalFeeds,
  memberships,
  occurrenceOverrides,
  properties,
  recurringSeries,
  users,
} from "../lib/schema";
import { addDays } from "../lib/recurrence";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asTx = (db: any): Tx => db as Tx;

let db: ReturnType<typeof drizzlePglite>;
let ownerId = "";
let propertyId = "";
let feedId = "";

function parsed(
  events: Array<{ uid: string; summary?: string; checkIn: string; checkOut: string; cancelled?: boolean }>,
) {
  return {
    ok: true as const,
    events: events.map((e) => ({
      uid: e.uid,
      summary: e.summary ?? null,
      checkIn: e.checkIn,
      checkOut: e.checkOut,
      cancelled: e.cancelled ?? false,
    })),
    skipped: 0,
  };
}

async function jobByKey(key: string) {
  const [j] = await db.select().from(cleaningJobs).where(eq(cleaningJobs.stableKey, key)).limit(1);
  return j;
}

beforeAll(async () => {
  const client = new PGlite();
  const raw = drizzlePglite(client);
  await migrate(raw, { migrationsFolder: "./drizzle" });
  db = drizzlePglite(client);

  const [owner] = await db
    .insert(users)
    .values({ email: "owner-b@test.dev", displayName: "Owner" })
    .returning();
  ownerId = owner!.id;
  const [prop] = await db
    .insert(properties)
    .values({ name: "Engine Test Property" })
    .returning();
  propertyId = prop!.id;
  await db
    .insert(memberships)
    .values({ userId: ownerId, propertyId, role: "owner" });
  const [feed] = await db
    .insert(icalFeeds)
    .values({ propertyId, label: "Test feed", url: "https://example.com/feed.ics" })
    .returning();
  feedId = feed!.id;
});

describe("turnover derivation", () => {
  it("creates one scheduled job per reservation checkout", async () => {
    const r = await applyFeedSync(
      asTx(db),
      feedId,
      parsed([
        { uid: "r1", summary: "Guest One", checkIn: "2026-11-01", checkOut: "2026-11-05" },
        { uid: "r2", summary: "Guest Two", checkIn: "2026-11-05", checkOut: "2026-11-08" },
      ]),
    );
    expect(r.status).toBe("ok");
    expect(r.reservationsUpserted).toBe(2);
    expect(r.jobsCreated).toBe(2);

    const j1 = await jobByKey(turnoverStableKey(feedId, "r1"));
    expect(j1).toMatchObject({
      jobType: "turnover",
      scheduledDate: "2026-11-05",
      status: "scheduled",
    });
    expect(j1!.startTime.slice(0, 5)).toBe("11:00");
    expect(j1!.endTime.slice(0, 5)).toBe("15:00");
    expect(j1!.title).toContain("Guest One");
  });

  it("is idempotent: re-running on identical input changes nothing", async () => {
    const r = await applyFeedSync(
      asTx(db),
      feedId,
      parsed([
        { uid: "r1", summary: "Guest One", checkIn: "2026-11-01", checkOut: "2026-11-05" },
        { uid: "r2", summary: "Guest Two", checkIn: "2026-11-05", checkOut: "2026-11-08" },
      ]),
    );
    expect(r.jobsCreated).toBe(0);
    expect(r.jobsUpdated).toBe(0);
    const all = await db.select().from(cleaningJobs);
    expect(all.filter((j) => j.jobType === "turnover")).toHaveLength(2);
  });

  it("moves the job when the reservation dates change", async () => {
    const r = await applyFeedSync(
      asTx(db),
      feedId,
      parsed([
        { uid: "r1", summary: "Guest One", checkIn: "2026-11-01", checkOut: "2026-11-06" },
        { uid: "r2", summary: "Guest Two", checkIn: "2026-11-06", checkOut: "2026-11-08" },
      ]),
    );
    expect(r.jobsUpdated).toBe(1); // only r1's job moved; r2 unchanged
    const j1 = await jobByKey(turnoverStableKey(feedId, "r1"));
    expect(j1!.scheduledDate).toBe("2026-11-06");
  });

  it("never moves a job the owner rescheduled manually", async () => {
    const key = turnoverStableKey(feedId, "r1");
    const before = await jobByKey(key);
    // Owner drags the job to a different day in the UI.
    await db
      .update(cleaningJobs)
      .set({ scheduledDate: "2026-11-10" })
      .where(eq(cleaningJobs.id, before!.id));

    // Feed unchanged — engine must leave the manual date alone.
    const r = await applyFeedSync(
      asTx(db),
      feedId,
      parsed([
        { uid: "r1", summary: "Guest One", checkIn: "2026-11-01", checkOut: "2026-11-06" },
        { uid: "r2", summary: "Guest Two", checkIn: "2026-11-06", checkOut: "2026-11-08" },
      ]),
    );
    expect(r.jobsUpdated).toBe(0);
    const after = await jobByKey(key);
    expect(after!.scheduledDate).toBe("2026-11-10");
  });

  it("cancels the auto job when its reservation disappears (unconfirmed)", async () => {
    const r = await applyFeedSync(
      asTx(db),
      feedId,
      parsed([{ uid: "r1", summary: "Guest One", checkIn: "2026-11-01", checkOut: "2026-11-06" }]),
    );
    expect(r.reservationsRemoved).toBe(1);
    expect(r.jobsCancelled).toBe(1);
    const j2 = await jobByKey(turnoverStableKey(feedId, "r2"));
    expect(j2!.status).toBe("cancelled");
    expect(j2!.cancelReason).toBe("reservation removed");
  });

  it("flags instead of cancelling when the job is already confirmed", async () => {
    // Restore r2: the system revives the job it auto-cancelled (flagged for
    // owner review — a feed glitch must never silently drop a cleaning).
    const restored = await applyFeedSync(
      asTx(db),
      feedId,
      parsed([
        { uid: "r1", summary: "Guest One", checkIn: "2026-11-01", checkOut: "2026-11-06" },
        { uid: "r2", summary: "Guest Two", checkIn: "2026-11-06", checkOut: "2026-11-08" },
      ]),
    );
    expect(restored.jobsUpdated).toBeGreaterThan(0);
    const key = turnoverStableKey(feedId, "r2");
    const revived = await jobByKey(key);
    expect(revived!.status).toBe("scheduled");
    expect(revived!.needsAttention).toBe(true);

    // Confirm it, then remove the reservation again.
    await db
      .update(cleaningJobs)
      .set({ status: "confirmed", assignedToUserId: ownerId, needsAttention: false })
      .where(eq(cleaningJobs.id, revived!.id));

    const r = await applyFeedSync(
      asTx(db),
      feedId,
      parsed([{ uid: "r1", summary: "Guest One", checkIn: "2026-11-01", checkOut: "2026-11-06" }]),
    );
    expect(r.jobsCancelled).toBe(0);
    expect(r.jobsFlagged).toBe(1);
    const flagged = await jobByKey(key);
    expect(flagged!.status).toBe("confirmed");
    expect(flagged!.needsAttention).toBe(true);
  });

  it("flags tight same-day turnovers via the fit check", async () => {
    // Back-to-back on the same day with only a 1-hour window for a 4-hour job.
    await db
      .update(properties)
      .set({ checkoutTime: "11:00", checkinTime: "12:00", turnoverBufferMinutes: 0 })
      .where(eq(properties.id, propertyId));
    await applyFeedSync(
      asTx(db),
      feedId,
      parsed([
        { uid: "tight1", checkIn: "2026-12-01", checkOut: "2026-12-05" },
        { uid: "tight2", checkIn: "2026-12-05", checkOut: "2026-12-07" },
      ]),
    );
    const job = await jobByKey(turnoverStableKey(feedId, "tight1"));
    expect(job!.needsAttention).toBe(true);
    // Restore defaults for other tests.
    await db
      .update(properties)
      .set({ checkoutTime: null, checkinTime: null })
      .where(eq(properties.id, propertyId));
  });
});

describe("state machine via transitionJob", () => {
  it("drives the happy path and blocks illegal jumps", async () => {
    const key = turnoverStableKey(feedId, "tight1");
    const job = await jobByKey(key);
    const sys = { kind: "system" as const, userId: null, role: "owner" as const };
    const t1 = await transitionJob(asTx(db), job!.id, "assigned", sys);
    expect(t1.status).toBe("assigned");
    await expect(transitionJob(asTx(db), job!.id, "completed", sys)).rejects.toThrow(
      /Cannot move job/,
    );
    const t2 = await transitionJob(asTx(db), job!.id, "cancelled", sys, { reason: "test" });
    expect(t2.status).toBe("cancelled");
    expect(t2.cancelReason).toBe("test");
  });
});

describe("recurring series", () => {
  it("expands a weekly series into future jobs", async () => {
    const today = todayPT();
    const series = await createSeries(asTx(db), {
      propertyId,
      title: "Wednesday clean",
      rrule: { freq: "weekly", interval: 1, weekdays: [3], dtstart: today },
      createdBy: ownerId,
    });
    const jobs = await db
      .select()
      .from(cleaningJobs)
      .where(eq(cleaningJobs.seriesId, series.id));
    expect(jobs.length).toBeGreaterThan(4);
    expect(jobs.length).toBeLessThan(20); // ~120-day horizon, weekly
    for (const j of jobs) {
      expect(j.jobType).toBe("recurring");
      expect(j.status).toBe("scheduled");
      expect(j.startTime.slice(0, 5)).toBe("11:00");
    }
    // Stable keys are unique per occurrence.
    const keys = new Set(jobs.map((j) => j.stableKey));
    expect(keys.size).toBe(jobs.length);
  });

  it("'this occurrence' override reschedules a single job", async () => {
    const [series] = await db.select().from(recurringSeries).limit(1);
    const jobs = await db
      .select()
      .from(cleaningJobs)
      .where(eq(cleaningJobs.seriesId, series!.id));
    const target = jobs[0]!;
    const newDate = addDays(target.scheduledDate, 1);

    await overrideOccurrence(
      asTx(db),
      series!.id,
      target.occurrenceDate!,
      "rescheduled",
      { newDate },
      ownerId,
    );
    const [ov] = await db.select().from(occurrenceOverrides);
    expect(ov!.action).toBe("rescheduled");
    const moved = await jobByKey(target.stableKey);
    expect(moved!.scheduledDate).toBe(newDate);
    // The rest of the series is untouched.
    const others = await db
      .select()
      .from(cleaningJobs)
      .where(eq(cleaningJobs.seriesId, series!.id));
    expect(others.filter((j) => j.id !== moved!.id && j.scheduledDate === newDate)).toHaveLength(0);
  });

  it("'this and following' splits the series", async () => {
    const [series] = await db.select().from(recurringSeries).limit(1);
    const fromDate = addDays(todayPT(), 30);
    const { oldSeries, newSeries } = await splitSeries(
      asTx(db),
      series!.id,
      fromDate,
      { defaultStartTime: "10:00" },
      ownerId,
    );
    expect(oldSeries.id).not.toBe(newSeries.id);
    expect((oldSeries.rrule as { until: string }).until).toBe(addDays(fromDate, -1));
    expect((newSeries.rrule as { dtstart: string }).dtstart).toBe(fromDate);

    // Jobs from fromDate onward belong to the new series with the new time.
    const newJobs = await db
      .select()
      .from(cleaningJobs)
      .where(eq(cleaningJobs.seriesId, newSeries.id));
    expect(newJobs.length).toBeGreaterThan(0);
    for (const j of newJobs) expect(j.startTime.slice(0, 5)).toBe("10:00");
    const oldJobs = await db
      .select()
      .from(cleaningJobs)
      .where(eq(cleaningJobs.seriesId, oldSeries.id));
    for (const j of oldJobs) {
      if (j.status === "scheduled") expect(j.occurrenceDate! < fromDate).toBe(true);
    }
  });

  it("'entire series' update regenerates future occurrences", async () => {
    const [, ...rest] = await db.select().from(recurringSeries);
    const series = rest[0] ?? (await db.select().from(recurringSeries).then((r) => r[0]));
    await updateSeries(asTx(db), series!.id, { defaultEndTime: "16:00" }, ownerId);
    const jobs = await db
      .select()
      .from(cleaningJobs)
      .where(eq(cleaningJobs.seriesId, series!.id));
    const future = jobs.filter((j) => j.status === "scheduled");
    expect(future.length).toBeGreaterThan(0);
    for (const j of future) expect(j.endTime.slice(0, 5)).toBe("16:00");
  });

  it("deactivating a series cancels its future jobs", async () => {
    const series = await createSeries(asTx(db), {
      propertyId,
      title: "Doomed series",
      rrule: { freq: "weekly", interval: 1, weekdays: [6], dtstart: todayPT() },
      createdBy: ownerId,
    });
    await updateSeries(asTx(db), series.id, { isActive: false }, ownerId);
    const jobs = await db
      .select()
      .from(cleaningJobs)
      .where(eq(cleaningJobs.seriesId, series.id));
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) expect(j.status).toBe("cancelled");
    expect(jobs[0]!.cancelReason).toBe("series deactivated");
  });

  it("reconcile is a no-op helper when given an empty change set", async () => {
    const [prop] = await db.select().from(properties).where(eq(properties.id, propertyId)).limit(1);
    const r = await reconcileTurnoverJobs(asTx(db), prop!, new Set());
    expect(r.created).toBe(0);
  });
});
