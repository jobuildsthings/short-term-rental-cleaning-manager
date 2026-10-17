/**
 * Database-level permission tests.
 *
 * Spins up a real Postgres (PGlite — Postgres compiled to WASM, RLS
 * included), applies the actual migrations, then runs every query AS THE
 * LEAST-PRIVILEGE `app` ROLE with withUser(userId) scoping — exactly like
 * production request handlers. If application code ever forgets a filter,
 * these tests prove the database itself still denies the row.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUser, type Db, type Tx } from "../lib/db";
import {
  agencySettings,
  auditLog,
  cleaningJobs,
  invites,
  icalFeeds,
  accessInstructionHistory,
  memberships,
  messages,
  properties,
  users,
} from "../lib/schema";

const appDb = { transaction: undefined as never } as Pick<Db, "transaction">;

let ownerId = "";
let dispatcherId = "";
let strangerId = "";
let propertyAId = "";
let propertyBId = "";
let jobAId = "";

async function asUser<T>(db: Pick<Db, "transaction">, userId: string, fn: (tx: Tx) => Promise<T>) {
  return withUser(db, userId, fn);
}

beforeAll(async () => {
  const client = new PGlite();
  const raw = drizzlePglite(client);
  // No pgcrypto needed: gen_random_uuid() is core in Postgres 13+ (PGlite is 16+).
  await migrate(raw, { migrationsFolder: "./drizzle" });
  // From here on, act as the least-privilege app role — like production.
  await client.query("SET ROLE app");
  const db = drizzlePglite(client);
  Object.assign(appDb, { transaction: db.transaction.bind(db) });

  // Seed via the admin path (direct inserts as the migration owner would).
  // PGlite's default user is a superuser, so plain inserts bypass RLS here —
  // exactly like the migrator/seed role in production.
  await client.query("RESET ROLE");
  const admin = drizzlePglite(client);

  const [owner] = await admin.insert(users).values({ email: "o@test.dev", displayName: "O" }).returning();
  const [dispatcher] = await admin.insert(users).values({ email: "d@test.dev", displayName: "D" }).returning();
  const [stranger] = await admin.insert(users).values({ email: "s@test.dev", displayName: "S" }).returning();
  ownerId = owner!.id;
  dispatcherId = dispatcher!.id;
  strangerId = stranger!.id;

  const [pa] = await admin.insert(properties).values({ name: "Property A" }).returning();
  const [pb] = await admin.insert(properties).values({ name: "Property B" }).returning();
  propertyAId = pa!.id;
  propertyBId = pb!.id;

  await admin.insert(memberships).values([
    { userId: ownerId, propertyId: propertyAId, role: "owner" },
    { userId: ownerId, propertyId: propertyBId, role: "owner" },
    { userId: dispatcherId, propertyId: propertyAId, role: "dispatcher" },
  ]);

  await admin.insert(agencySettings).values({
    agencyName: "Test Agency",
    dispatcherUserId: dispatcherId,
    contactPhone: "+10000000000",
    contactEmail: "d@test.dev",
  });

  const [jobA] = await admin
    .insert(cleaningJobs)
    .values({
      propertyId: propertyAId,
      stableKey: "manual:test-a",
      title: "Job A",
      jobType: "turnover",
      scheduledDate: "2026-10-25",
      status: "assigned",
      assignedToUserId: dispatcherId,
      createdBy: ownerId,
    })
    .returning();
  jobAId = jobA!.id;
  await admin.insert(cleaningJobs).values({
    propertyId: propertyBId,
    stableKey: "manual:test-b",
    title: "Job B",
    jobType: "turnover",
    scheduledDate: "2026-10-25",
    status: "scheduled",
    createdBy: ownerId,
  });

  await admin.insert(messages).values({ jobId: jobAId, senderUserId: ownerId, body: "hello" });
  await admin.insert(invites).values({
    token: "tok",
    email: "x@test.dev",
    role: "dispatcher",
    propertyIds: [propertyAId],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdBy: ownerId,
  });
  await admin.insert(icalFeeds).values({ propertyId: propertyAId, label: "L", url: "https://example.invalid/x" });
  await admin.insert(accessInstructionHistory).values({
    propertyId: propertyAId,
    instructionsEncrypted: "enc",
    changedBy: ownerId,
  });

  await client.query("SET ROLE app");
}, 120000);

afterAll(async () => {
  // PGlite instance is garbage-collected with the worker.
});

describe("row-level security", () => {
  it("dispatcher sees only assigned properties and their jobs", async () => {
    const props = await asUser(appDb, dispatcherId, (tx) => tx.select().from(properties));
    expect(props.map((p) => p.id)).toEqual([propertyAId]);

    const jobs = await asUser(appDb, dispatcherId, (tx) => tx.select().from(cleaningJobs));
    expect(jobs.map((j) => j.id)).toEqual([jobAId]);
  });

  it("owner sees everything", async () => {
    const props = await asUser(appDb, ownerId, (tx) => tx.select().from(properties));
    expect(props).toHaveLength(2);
    const jobs = await asUser(appDb, ownerId, (tx) => tx.select().from(cleaningJobs));
    expect(jobs).toHaveLength(2);
  });

  it("stranger with no memberships sees nothing", async () => {
    const props = await asUser(appDb, strangerId, (tx) => tx.select().from(properties));
    expect(props).toHaveLength(0);
    const jobs = await asUser(appDb, strangerId, (tx) => tx.select().from(cleaningJobs));
    expect(jobs).toHaveLength(0);
  });

  it("dispatcher cannot read invites, feed URLs, instruction history, or audit log", async () => {
    await asUser(appDb, dispatcherId, async (tx) => {
      expect(await tx.select().from(invites)).toHaveLength(0);
      expect(await tx.select().from(icalFeeds)).toHaveLength(0);
      expect(await tx.select().from(accessInstructionHistory)).toHaveLength(0);
      expect(await tx.select().from(auditLog)).toHaveLength(0);
    });
    await asUser(appDb, ownerId, async (tx) => {
      expect(await tx.select().from(invites)).toHaveLength(1);
      expect(await tx.select().from(icalFeeds)).toHaveLength(1);
    });
  });

  it("dispatcher cannot create properties or read other users", async () => {
    await expect(
      asUser(appDb, dispatcherId, (tx) => tx.insert(properties).values({ name: "Sneaky" })),
    ).rejects.toThrow();
    const others = await asUser(appDb, dispatcherId, (tx) =>
      tx.select().from(users).where(eq(users.id, ownerId)),
    );
    expect(others).toHaveLength(0);
    const self = await asUser(appDb, dispatcherId, (tx) =>
      tx.select().from(users).where(eq(users.id, dispatcherId)),
    );
    expect(self).toHaveLength(1);
  });

  it("dispatcher can message only assigned jobs' threads", async () => {
    // Read own job's thread: allowed.
    const mine = await asUser(appDb, dispatcherId, (tx) =>
      tx.select().from(messages).where(eq(messages.jobId, jobAId)),
    );
    expect(mine).toHaveLength(1);
    // Post to own job's thread: allowed.
    await asUser(appDb, dispatcherId, (tx) =>
      tx.insert(messages).values({ jobId: jobAId, senderUserId: dispatcherId, body: "on it" }),
    );
    // Post to the other property's job: denied at the database level.
    const jobB = (
      await asUser(appDb, ownerId, (tx) =>
        tx.select().from(cleaningJobs).where(eq(cleaningJobs.propertyId, propertyBId)),
      )
    )[0]!;
    await expect(
      asUser(appDb, dispatcherId, (tx) =>
        tx.insert(messages).values({ jobId: jobB.id, senderUserId: dispatcherId, body: "sneaky" }),
      ),
    ).rejects.toThrow();
  });

  it("no user context means no rows (fail-closed)", async () => {
    // A transaction that never sets app.user_id — every policy denies.
    const db = appDb as unknown as Db;
    const rows = await db.transaction(async (tx) => tx.select().from(cleaningJobs));
    expect(rows).toHaveLength(0);
  });
});
