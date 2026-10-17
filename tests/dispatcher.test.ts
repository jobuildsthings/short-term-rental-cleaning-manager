/**
 * Dispatcher workstream tests — permission boundaries + job transitions.
 *
 * Uses the same PGlite pattern as permissions.test.ts: real Postgres with
 * the actual migrations, every call scoped through withUser() as the
 * least-privilege `app` role — exactly like production request handlers.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withUser, type Db, type Tx } from "../lib/db";
import { encryptField } from "../lib/crypto";
import {
  DispatcherError,
  getDispatcherJobDetail,
  listDispatcherJobs,
  setDispatcherChecklistResult,
  transitionDispatcherJob,
} from "../lib/dispatcher";
import {
  auditLog,
  checklistItems,
  checklistTemplates,
  cleaningJobs,
  memberships,
  properties,
  users,
} from "../lib/schema";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const appDb = { transaction: undefined as never } as Pick<Db, "transaction">;

let ownerId = "";
let dispatcherId = "";
let propertyAId = "";
let propertyBId = "";
let assignedJobId = "";
let otherJobId = "";
let declineJobId = "";
let templateId = "";
let itemId = "";

function asUser<T>(db: Pick<Db, "transaction">, userId: string, fn: (tx: Tx) => Promise<T>) {
  return withUser(db, userId, fn);
}

function isoDatePlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  vi.stubEnv("ACCESS_INSTRUCTIONS_KEY", TEST_KEY);
  const client = new PGlite();
  const raw = drizzlePglite(client);
  await migrate(raw, { migrationsFolder: "./drizzle" });
  await client.query("SET ROLE app");
  const db = drizzlePglite(client);
  Object.assign(appDb, { transaction: db.transaction.bind(db) });

  await client.query("RESET ROLE");
  const admin = drizzlePglite(client);

  const [owner] = await admin
    .insert(users)
    .values({ email: "owner@c.test", displayName: "Owner" })
    .returning();
  const [dispatcher] = await admin
    .insert(users)
    .values({ email: "dispatcher@c.test", displayName: "Dispatcher" })
    .returning();
  ownerId = owner!.id;
  dispatcherId = dispatcher!.id;

  const [pa] = await admin
    .insert(properties)
    .values({
      name: "Property A",
      listingAddress: "1 Test St",
      accessInstructions: encryptField("Gate code 1234"),
    })
    .returning();
  const [pb] = await admin.insert(properties).values({ name: "Property B" }).returning();
  propertyAId = pa!.id;
  propertyBId = pb!.id;

  await admin.insert(memberships).values([
    { userId: ownerId, propertyId: propertyAId, role: "owner" },
    { userId: ownerId, propertyId: propertyBId, role: "owner" },
    { userId: dispatcherId, propertyId: propertyAId, role: "dispatcher" },
  ]);

  const [tpl] = await admin
    .insert(checklistTemplates)
    .values({ propertyId: propertyAId, name: "Standard" })
    .returning();
  templateId = tpl!.id;
  const [itm] = await admin
    .insert(checklistItems)
    .values({ templateId, label: "Mop floors", sortOrder: 0 })
    .returning();
  itemId = itm!.id;

  // Assigned to the dispatcher, tomorrow.
  const [ja] = await admin
    .insert(cleaningJobs)
    .values({
      propertyId: propertyAId,
      stableKey: "manual:c-a",
      title: "Assigned Job",
      jobType: "turnover",
      scheduledDate: isoDatePlus(1),
      status: "assigned",
      assignedToUserId: dispatcherId,
      checklistTemplateId: templateId,
      createdBy: ownerId,
    })
    .returning();
  assignedJobId = ja!.id;

  // On the other property — the dispatcher must never see it.
  const [jb] = await admin
    .insert(cleaningJobs)
    .values({
      propertyId: propertyBId,
      stableKey: "manual:c-b",
      title: "Other Job",
      jobType: "turnover",
      scheduledDate: isoDatePlus(1),
      status: "assigned",
      assignedToUserId: dispatcherId,
      createdBy: ownerId,
    })
    .returning();
  otherJobId = jb!.id;

  // Past job assigned to the dispatcher — excluded from the list.
  await admin.insert(cleaningJobs).values({
    propertyId: propertyAId,
    stableKey: "manual:c-past",
    title: "Past Job",
    jobType: "turnover",
    scheduledDate: isoDatePlus(-2),
    status: "completed",
    assignedToUserId: dispatcherId,
    createdBy: ownerId,
  });

  // Fresh assigned job reserved for the decline test. Dated yesterday so it
  // stays out of the list test's upcoming-jobs expectation.
  const [jd] = await admin
    .insert(cleaningJobs)
    .values({
      propertyId: propertyAId,
      stableKey: "manual:c-decline",
      title: "Decline Me",
      jobType: "turnover",
      scheduledDate: isoDatePlus(-1),
      status: "assigned",
      assignedToUserId: dispatcherId,
      createdBy: ownerId,
    })
    .returning();
  declineJobId = jd!.id;

  await client.query("SET ROLE app");
}, 120000);

describe("dispatcher job list", () => {
  it("lists only assigned jobs, today and upcoming", async () => {
    const jobs = await asUser(appDb, dispatcherId, (tx) =>
      listDispatcherJobs(tx, dispatcherId),
    );
    // Assigned Job only: Other Job is on an unassigned property, Past Job is over.
    expect(jobs.map((j) => j.id)).toEqual([assignedJobId]);
    expect(jobs[0]!.whenLabel).toMatch(/PT/);
  });
});

describe("dispatcher job detail", () => {
  it("includes decrypted access instructions for an assigned job", async () => {
    const detail = await asUser(appDb, dispatcherId, (tx) =>
      getDispatcherJobDetail(tx, dispatcherId, assignedJobId),
    );
    expect(detail.accessInstructions).toBe("Gate code 1234");
    expect(detail.propertyAddress).toBe("1 Test St");
    expect(detail.checklist).toHaveLength(1);
    expect(detail.checklist[0]!.label).toBe("Mop floors");
    expect(detail.allowedActions).toEqual(["confirm", "decline"]);
    expect(detail.calendarState).toBe("pending");
  });

  it("404s for a job on a property the dispatcher is not assigned to", async () => {
    await expect(
      asUser(appDb, dispatcherId, (tx) =>
        getDispatcherJobDetail(tx, dispatcherId, otherJobId),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("404s for a nonexistent job", async () => {
    await expect(
      asUser(appDb, dispatcherId, (tx) =>
        getDispatcherJobDetail(tx, dispatcherId, "00000000-0000-0000-0000-000000000000"),
      ),
    ).rejects.toBeInstanceOf(DispatcherError);
  });
});

describe("dispatcher transitions", () => {
  it("confirm moves assigned → confirmed and audits", async () => {
    const job = await asUser(appDb, dispatcherId, (tx) =>
      transitionDispatcherJob(tx, dispatcherId, assignedJobId, "confirm"),
    );
    expect(job.status).toBe("confirmed");
    const audits = await asUser(appDb, ownerId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, assignedJobId)),
    );
    expect(audits.some((a) => a.action === "job.confirmed")).toBe(true);
  });

  it("rejects an illegal transition with 400", async () => {
    // confirmed → complete is not allowed (must go through in_progress).
    await expect(
      asUser(appDb, dispatcherId, (tx) =>
        transitionDispatcherJob(tx, dispatcherId, assignedJobId, "complete"),
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_transition" });
  });

  it("start then complete walks the job to done", async () => {
    const started = await asUser(appDb, dispatcherId, (tx) =>
      transitionDispatcherJob(tx, dispatcherId, assignedJobId, "start"),
    );
    expect(started.status).toBe("in_progress");
    const done = await asUser(appDb, dispatcherId, (tx) =>
      transitionDispatcherJob(tx, dispatcherId, assignedJobId, "complete"),
    );
    expect(done.status).toBe("completed");
  });

  it("404s when transitioning a job not assigned to the dispatcher", async () => {
    await expect(
      asUser(appDb, dispatcherId, (tx) =>
        transitionDispatcherJob(tx, dispatcherId, otherJobId, "confirm"),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("decline returns the job to the pool with needs_attention set", async () => {
    const back = await asUser(appDb, dispatcherId, (tx) =>
      transitionDispatcherJob(tx, dispatcherId, declineJobId, "decline", {
        reason: "crew fully booked",
      }),
    );
    expect(back.status).toBe("scheduled");
    expect(back.needsAttention).toBe(true);

    // Assignment cleared at the database level.
    const row = await asUser(appDb, ownerId, (tx) =>
      tx.select().from(cleaningJobs).where(eq(cleaningJobs.id, declineJobId)),
    );
    expect(row[0]!.assignedToUserId).toBeNull();

    // Audit captured the decline + return-to-pool (metadata carries the reason,
    // never access instructions).
    const audits = await asUser(appDb, ownerId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, declineJobId)),
    );
    const declined = audits.find((a) => a.action === "job.declined");
    expect(declined).toBeDefined();
    expect((declined!.metadata as { reason: string }).reason).toBe("crew fully booked");
    expect(audits.some((a) => a.action === "job.returned_to_pool")).toBe(true);
  });
});

describe("dispatcher checklist", () => {
  it("toggles an item on an assigned job", async () => {
    const row = await asUser(appDb, dispatcherId, (tx) =>
      setDispatcherChecklistResult(tx, dispatcherId, assignedJobId, itemId, true),
    );
    expect(row.isDone).toBe(true);
    const back = await asUser(appDb, dispatcherId, (tx) =>
      setDispatcherChecklistResult(tx, dispatcherId, assignedJobId, itemId, false),
    );
    expect(back.isDone).toBe(false);
  });

  it("refuses checklist changes on an unassigned job", async () => {
    await expect(
      asUser(appDb, dispatcherId, (tx) =>
        setDispatcherChecklistResult(tx, dispatcherId, otherJobId, itemId, true),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
