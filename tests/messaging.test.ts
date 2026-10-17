/**
 * Messaging tests (Workstream D).
 *
 * Exercises lib/messaging.ts against a real Postgres (PGlite, RLS
 * included) through withUser() scoping — exactly like the production API
 * routes. Covers: participant permission boundaries, newest-first
 * ordering, body validation, immutability (no UPDATE/DELETE possible),
 * and the notification-intent audit record (metadata only, never the
 * body — contracts §5).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUser, type Db, type Tx } from "../lib/db";
import {
  auditLog,
  cleaningJobs,
  memberships,
  messages,
  properties,
  users,
} from "../lib/schema";
import {
  MessageError,
  listJobMessages,
  postJobMessage,
} from "../lib/messaging";

const appDb = { transaction: undefined as never } as Pick<Db, "transaction">;

let ownerId = "";
let dispatcherId = ""; // assigned to jobA
let dispatcher2Id = ""; // membership on property A, NOT assigned to jobA
let strangerId = "";
let jobAId = "";

function asUser<T>(db: Pick<Db, "transaction">, userId: string, fn: (tx: Tx) => Promise<T>) {
  return withUser(db, userId, fn);
}

beforeAll(async () => {
  const client = new PGlite();
  const raw = drizzlePglite(client);
  await migrate(raw, { migrationsFolder: "./drizzle" });
  await client.query("SET ROLE app");
  const db = drizzlePglite(client);
  Object.assign(appDb, { transaction: db.transaction.bind(db) });

  await client.query("RESET ROLE");
  const admin = drizzlePglite(client);

  const [owner] = await admin.insert(users).values({ email: "o@test.dev", displayName: "O" }).returning();
  const [d1] = await admin.insert(users).values({ email: "d1@test.dev", displayName: "D1" }).returning();
  const [d2] = await admin.insert(users).values({ email: "d2@test.dev", displayName: "D2" }).returning();
  const [stranger] = await admin.insert(users).values({ email: "s@test.dev", displayName: "S" }).returning();
  ownerId = owner!.id;
  dispatcherId = d1!.id;
  dispatcher2Id = d2!.id;
  strangerId = stranger!.id;

  const [pa] = await admin.insert(properties).values({ name: "Property A" }).returning();
  await admin.insert(memberships).values([
    { userId: ownerId, propertyId: pa!.id, role: "owner" },
    { userId: dispatcherId, propertyId: pa!.id, role: "dispatcher" },
    { userId: dispatcher2Id, propertyId: pa!.id, role: "dispatcher" },
  ]);

  const [jobA] = await admin
    .insert(cleaningJobs)
    .values({
      propertyId: pa!.id,
      stableKey: "manual:msg-test-a",
      title: "Job A",
      jobType: "turnover",
      scheduledDate: "2026-10-25",
      status: "assigned",
      assignedToUserId: dispatcherId,
      createdBy: ownerId,
    })
    .returning();
  jobAId = jobA!.id;

  await client.query("SET ROLE app");
}, 120000);

afterAll(async () => {
  // PGlite instance is garbage-collected with the worker.
});

describe("postJobMessage permissions", () => {
  it("owner can post on any thread", async () => {
    const m = await asUser(appDb, ownerId, (tx) =>
      postJobMessage(tx, {
        jobId: jobAId,
        senderUserId: ownerId,
        senderRole: "owner",
        isOwner: true,
        body: "Hello from owner",
      }),
    );
    expect(m.body).toBe("Hello from owner");
    expect(m.sender.isYou).toBe(true);
  });

  it("assigned dispatcher can post on their job's thread", async () => {
    const m = await asUser(appDb, dispatcherId, (tx) =>
      postJobMessage(tx, {
        jobId: jobAId,
        senderUserId: dispatcherId,
        senderRole: "dispatcher",
        isOwner: false,
        body: "On my way",
      }),
    );
    expect(m.body).toBe("On my way");
  });

  it("dispatcher NOT assigned to the job is rejected (403)", async () => {
    await expect(
      asUser(appDb, dispatcher2Id, (tx) =>
        postJobMessage(tx, {
          jobId: jobAId,
          senderUserId: dispatcher2Id,
          senderRole: "dispatcher",
          isOwner: false,
          body: "sneaky",
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("stranger sees no job (404)", async () => {
    await expect(
      asUser(appDb, strangerId, (tx) =>
        postJobMessage(tx, {
          jobId: jobAId,
          senderUserId: strangerId,
          senderRole: "dispatcher",
          isOwner: false,
          body: "sneaky",
        }),
      ),
    ).rejects.toMatchObject({ code: "job_not_found", status: 404 });
  });

  it("rejects empty, over-long, and non-string bodies", async () => {
    const post = (body: unknown) =>
      asUser(appDb, ownerId, (tx) =>
        postJobMessage(tx, {
          jobId: jobAId,
          senderUserId: ownerId,
          senderRole: "owner",
          isOwner: true,
          body,
        }),
      );
    await expect(post("   ")).rejects.toMatchObject({ status: 400 });
    await expect(post("x".repeat(2001))).rejects.toMatchObject({ status: 400 });
    await expect(post(42)).rejects.toMatchObject({ status: 400 });
    await expect(post("ok")).resolves.toBeTruthy();
  });
});

describe("listJobMessages", () => {
  it("returns the thread newest-first with role labels", async () => {
    const thread = await asUser(appDb, ownerId, (tx) =>
      listJobMessages(tx, {
        jobId: jobAId,
        viewerUserId: ownerId,
        viewerRole: "owner",
        isOwner: true,
      }),
    );
    expect(thread.length).toBeGreaterThanOrEqual(3);
    // Newest first.
    for (let i = 1; i < thread.length; i++) {
      expect(thread[i - 1]!.createdAt >= thread[i]!.createdAt).toBe(true);
    }
    // Role labels: owner's own messages are "you"/owner, dispatcher's are dispatcher.
    const mine = thread.find((m) => m.sender.isYou);
    expect(mine?.sender.role).toBe("owner");
    const theirs = thread.find((m) => !m.sender.isYou);
    expect(theirs?.sender.role).toBe("dispatcher");
  });

  it("dispatcher sees their own messages as you", async () => {
    const thread = await asUser(appDb, dispatcherId, (tx) =>
      listJobMessages(tx, {
        jobId: jobAId,
        viewerUserId: dispatcherId,
        viewerRole: "dispatcher",
        isOwner: false,
      }),
    );
    expect(thread.length).toBeGreaterThan(0);
    const mine = thread.find((m) => m.sender.isYou);
    expect(mine?.sender.role).toBe("dispatcher");
  });

  it("unassigned dispatcher and stranger cannot list", async () => {
    await expect(
      asUser(appDb, dispatcher2Id, (tx) =>
        listJobMessages(tx, {
          jobId: jobAId,
          viewerUserId: dispatcher2Id,
          viewerRole: "dispatcher",
          isOwner: false,
        }),
      ),
    ).rejects.toBeInstanceOf(MessageError);
    await expect(
      asUser(appDb, strangerId, (tx) =>
        listJobMessages(tx, {
          jobId: jobAId,
          viewerUserId: strangerId,
          viewerRole: "dispatcher",
          isOwner: false,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("immutability", () => {
  it("messages cannot be updated or deleted (no RLS policy → no-op)", async () => {
    // With RLS enabled and no UPDATE/DELETE policy at all, the USING
    // clause is false for every row: the statements succeed vacuously
    // with affectedRows 0 and can never touch a row. That IS the
    // immutability guarantee — verify it directly.
    const [one] = await asUser(appDb, ownerId, (tx) =>
      tx.select().from(messages).where(eq(messages.jobId, jobAId)).limit(1),
    );
    const upd = await asUser(appDb, ownerId, (tx) =>
      tx.update(messages).set({ body: "edited" }).where(eq(messages.id, one!.id)),
    );
    expect(upd.rowCount ?? 0).toBe(0);
    const del = await asUser(appDb, ownerId, (tx) =>
      tx.delete(messages).where(eq(messages.id, one!.id)),
    );
    expect(del.rowCount ?? 0).toBe(0);
    // And the row is untouched.
    const [still] = await asUser(appDb, ownerId, (tx) =>
      tx.select().from(messages).where(eq(messages.id, one!.id)),
    );
    expect(still!.body).not.toBe("edited");
  });
});

describe("notification intent", () => {
  it("records an audit intent with channel/recipient and never the body", async () => {
    const secret = `code-word-${Date.now()}`;
    const m = await asUser(appDb, dispatcherId, (tx) =>
      postJobMessage(tx, {
        jobId: jobAId,
        senderUserId: dispatcherId,
        senderRole: "dispatcher",
        isOwner: false,
        body: secret,
      }),
    );
    const intents = await asUser(appDb, ownerId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, m.id)),
    );
    expect(intents).toHaveLength(1);
    const meta = intents[0]!.metadata as Record<string, unknown>;
    expect(intents[0]!.action).toBe("message.posted");
    // Dispatcher wrote → owner gets an email (§7.16).
    expect(meta.notification).toEqual({ channel: "email", recipient: "owner" });
    // The body must not appear anywhere in the audit record.
    expect(JSON.stringify(intents[0])).not.toContain(secret);
  });

  it("owner message queues an SMS to the dispatcher", async () => {
    const m = await asUser(appDb, ownerId, (tx) =>
      postJobMessage(tx, {
        jobId: jobAId,
        senderUserId: ownerId,
        senderRole: "owner",
        isOwner: true,
        body: "Timing changed",
      }),
    );
    const intents = await asUser(appDb, ownerId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, m.id)),
    );
    const meta = intents[0]!.metadata as Record<string, unknown>;
    expect(meta.notification).toEqual({ channel: "sms", recipient: "dispatcher" });
  });
});
