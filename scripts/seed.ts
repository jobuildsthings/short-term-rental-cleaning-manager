/**
 * Seed script — demo data only, all values obviously fake.
 * NEVER use real names, addresses, phone numbers, or door codes here.
 *
 * Creates (idempotent: skips if the demo property already exists):
 * - one owner user (SEED_OWNER_EMAIL)
 * - one property ("Demo Property") with encrypted demo access instructions
 * - one dispatcher user + membership + agency_settings row
 * - one PENDING dispatcher invite (exercises the invite flow)
 * - one sample turnover job (scheduled, assigned to the dispatcher)
 * - one weekly recurring series (Wednesday) + one generated job instance
 *
 * Usage: npm run db:seed [-- --force to reseed]
 * Uses the owner connection (DATABASE_URL): seeds bypass RLS by design.
 */
import { eq } from "drizzle-orm";
import { getDbAdmin } from "../lib/db";
import { encryptField } from "../lib/crypto";
import {
  agencySettings,
  auditLog,
  cleaningJobs,
  invites,
  memberships,
  properties,
  recurringSeries,
  users,
} from "../lib/schema";
import { randomBytes } from "node:crypto";

const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const DISPATCHER_EMAIL = process.env.SEED_DISPATCHER_EMAIL ?? "dispatcher@example.com";
const AGENCY_NAME = process.env.SEED_AGENCY_NAME ?? "Demo Cleaning Agency";
const DISPATCHER_PHONE = process.env.SEED_DISPATCHER_PHONE ?? "+15550001111";

function nextWeekday(target: number): string {
  // Next occurrence of weekday `target` (0=Sunday..6=Saturday), at least 1 day out.
  const d = new Date();
  const add = ((target - d.getDay() + 7) % 7) || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const force = process.argv.includes("--force");
  const db = getDbAdmin();

  const existing = await db
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.name, "Demo Property"))
    .limit(1);
  if (existing.length > 0 && !force) {
    console.log("Demo data already seeded. Pass --force to reseed.");
    return;
  }
  if (force && existing.length > 0) {
    // Minimal reseed: delete demo jobs/series; keep users simple by reusing.
    const pid = existing[0]!.id;
    await db.delete(cleaningJobs).where(eq(cleaningJobs.propertyId, pid));
    await db.delete(recurringSeries).where(eq(recurringSeries.propertyId, pid));
    await db.delete(properties).where(eq(properties.id, pid));
    console.log("Removed previous demo property; reseeding…");
  }

  const [owner] = await db
    .insert(users)
    .values({ email: OWNER_EMAIL, displayName: "Demo Owner" })
    .onConflictDoNothing()
    .returning({ id: users.id });
  const ownerId =
    owner?.id ??
    (await db.select({ id: users.id }).from(users).where(eq(users.email, OWNER_EMAIL)).limit(1))[0]!.id;

  const [dispatcher] = await db
    .insert(users)
    .values({ email: DISPATCHER_EMAIL, displayName: "Demo Dispatcher" })
    .onConflictDoNothing()
    .returning({ id: users.id });
  const dispatcherId =
    dispatcher?.id ??
    (await db.select({ id: users.id }).from(users).where(eq(users.email, DISPATCHER_EMAIL)).limit(1))[0]!.id;

  const [property] = await db
    .insert(properties)
    .values({
      name: "Demo Property",
      listingTitle: "Demo 2BR flat near the park",
      listingAddress: "123 Demo Street, San Francisco, CA 94110",
      timezone: "America/Los_Angeles",
      accessInstructions: encryptField("DEMO ONLY — gate code 0000, lockbox 0000"),
      accessInstructionsUpdatedBy: ownerId,
      accessInstructionsUpdatedAt: new Date().toISOString(),
    })
    .returning({ id: properties.id });
  const propertyId = property!.id;

  await db.insert(memberships).values([
    { userId: ownerId, propertyId, role: "owner" },
    { userId: dispatcherId, propertyId, role: "dispatcher" },
  ]);

  await db.insert(agencySettings).values({
    agencyName: AGENCY_NAME,
    dispatcherUserId: dispatcherId,
    contactPhone: DISPATCHER_PHONE,
    contactEmail: DISPATCHER_EMAIL,
  });

  // A pending invite, so the invite flow can be exercised end to end.
  const inviteToken = randomBytes(32).toString("hex");
  await db.insert(invites).values({
    token: inviteToken,
    email: "new-dispatcher@example.com",
    role: "dispatcher",
    propertyIds: [propertyId],
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    createdBy: ownerId,
  });

  // Sample turnover job, assigned to the dispatcher.
  const jobDate = nextWeekday(6); // next Saturday
  await db.insert(cleaningJobs).values({
    propertyId,
    stableKey: `manual:seed-turnover-${jobDate}`,
    title: "Turnover clean (demo)",
    jobType: "turnover",
    scheduledDate: jobDate,
    startTime: "11:00",
    endTime: "15:00",
    status: "assigned",
    assignedToUserId: dispatcherId,
    createdBy: ownerId,
  });

  // Weekly Wednesday series + one generated instance.
  const wednesday = nextWeekday(3);
  const [series] = await db
    .insert(recurringSeries)
    .values({
      propertyId,
      title: "Weekly Wednesday clean (demo)",
      rrule: { freq: "weekly", interval: 1, weekdays: [3], until: null, count: null },
      createdBy: ownerId,
    })
    .returning({ id: recurringSeries.id });
  await db.insert(cleaningJobs).values({
    propertyId,
    seriesId: series!.id,
    occurrenceDate: wednesday,
    stableKey: `series:${series!.id}:${wednesday}`,
    title: "Weekly Wednesday clean (demo)",
    jobType: "recurring",
    scheduledDate: wednesday,
    startTime: "11:00",
    endTime: "15:00",
    status: "scheduled",
    assignedToUserId: dispatcherId,
    createdBy: ownerId,
  });

  await db.insert(auditLog).values({
    actorType: "system",
    action: "seed.completed",
    entityType: "property",
    entityId: propertyId,
    metadata: { note: "demo seed" },
  });

  console.log("Seed complete.");
  console.log(`  owner:      ${OWNER_EMAIL}`);
  console.log(`  dispatcher: ${DISPATCHER_EMAIL}`);
  console.log(`  invite link: /invite/${inviteToken}  (for new-dispatcher@example.com)`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
