/**
 * /dashboard — thin foundation shell. Lists the viewer's properties and
 * upcoming jobs (RLS-scoped), all times rendered explicitly in
 * America/Los_Angeles. Workstream C builds the full host UI on top of the
 * /api routes; this page proves auth + permissions work end to end.
 */
import { redirect } from "next/navigation";
import { and, asc, eq, gte } from "drizzle-orm";
import { auth } from "@/auth";
import { getDbApp, withUser } from "@/lib/db";
import { cleaningJobs, icalFeeds, properties, reminders } from "@/lib/schema";
import { formatDatePT, formatWallTimePT } from "@/lib/time";

function todayPT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default async function DashboardPage() {
  const session = await auth();
  const appUserId = session?.appUserId;
  if (!appUserId) redirect("/signin");

  const { props, jobs, attention, failedFeeds, failedReminders } = await withUser(getDbApp(), appUserId, async (tx) => {
    const props = await tx.select().from(properties);
    const from = todayPT();
    const jobs = await tx
      .select()
      .from(cleaningJobs)
      .where(and(gte(cleaningJobs.scheduledDate, from)))
      .orderBy(asc(cleaningJobs.scheduledDate), asc(cleaningJobs.startTime))
      .limit(50);
    // UC10: no silent failures — surface attention flags, broken feeds,
    // and failed reminders on the dashboard (owner only; RLS scopes all).
    const attention = await tx
      .select()
      .from(cleaningJobs)
      .where(and(eq(cleaningJobs.needsAttention, true), gte(cleaningJobs.scheduledDate, from)))
      .orderBy(asc(cleaningJobs.scheduledDate))
      .limit(20);
    const failedFeeds = await tx
      .select()
      .from(icalFeeds)
      .where(eq(icalFeeds.lastSyncStatus, "error"))
      .limit(20);
    const failedReminders = await tx
      .select()
      .from(reminders)
      .where(eq(reminders.status, "failed"))
      .orderBy(asc(reminders.scheduledFor))
      .limit(20);
    return { props, jobs, attention, failedFeeds, failedReminders };
  });

  const isOwner = session.memberships?.some((m) => m.role === "owner");
  const hasAlerts = attention.length > 0 || failedFeeds.length > 0 || failedReminders.length > 0;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Cleaning schedule</h1>
        <span className="text-xs text-neutral-500">{isOwner ? "Owner" : "Dispatcher"} · PT</span>
      </div>

      <h2 className="mt-8 text-sm font-medium uppercase tracking-wide text-neutral-500">
        Properties
      </h2>
      {isOwner && hasAlerts && (
        <section className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <h2 className="text-sm font-semibold text-red-800">Needs attention</h2>
          <ul className="mt-2 space-y-1 text-sm text-red-700">
            {attention.map((j) => (
              <li key={j.id}>
                ⚠ {j.title} — {formatDatePT(j.scheduledDate)} ({j.status})
              </li>
            ))}
            {failedFeeds.map((f) => (
              <li key={f.id}>
                ⚠ Calendar feed “{f.label}” failed to sync{f.lastSyncError ? `: ${f.lastSyncError}` : ""}
              </li>
            ))}
            {failedReminders.map((r) => (
              <li key={r.id}>
                ⚠ {r.channel} reminder failed{r.lastError ? `: ${r.lastError}` : ""} (job {r.jobId.slice(0, 8)})
              </li>
            ))}
          </ul>
        </section>
      )}
      <ul className="mt-2 divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
        {props.map((p) => (
          <li key={p.id} className="px-4 py-3">
            <div className="font-medium">{p.name}</div>
            {p.listingAddress && (
              <div className="text-sm text-neutral-600">{p.listingAddress}</div>
            )}
          </li>
        ))}
        {props.length === 0 && (
          <li className="px-4 py-3 text-sm text-neutral-500">No properties yet.</li>
        )}
      </ul>

      <h2 className="mt-8 text-sm font-medium uppercase tracking-wide text-neutral-500">
        Upcoming jobs
      </h2>
      <ul className="mt-2 divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
        {jobs.map((j) => (
          <li key={j.id} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-4">
              <div className="font-medium">{j.title}</div>
              <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">
                {j.status}
              </span>
            </div>
            <div className="mt-1 text-sm text-neutral-600">
              {formatDatePT(j.scheduledDate)} · {formatWallTimePT(j.startTime)} –{" "}
              {formatWallTimePT(j.endTime)}
            </div>
          </li>
        ))}
        {jobs.length === 0 && (
          <li className="px-4 py-3 text-sm text-neutral-500">No upcoming jobs.</li>
        )}
      </ul>
    </main>
  );
}
