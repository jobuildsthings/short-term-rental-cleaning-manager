/**
 * /dashboard — thin foundation shell. Lists the viewer's properties and
 * upcoming jobs (RLS-scoped), all times rendered explicitly in
 * America/Los_Angeles. Workstream C builds the full host UI on top of the
 * /api routes; this page proves auth + permissions work end to end.
 */
import { redirect } from "next/navigation";
import { and, asc, gte } from "drizzle-orm";
import { auth } from "@/auth";
import { getDbApp, withUser } from "@/lib/db";
import { cleaningJobs, properties } from "@/lib/schema";
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

  const { props, jobs } = await withUser(getDbApp(), appUserId, async (tx) => {
    const props = await tx.select().from(properties);
    const from = todayPT();
    const jobs = await tx
      .select()
      .from(cleaningJobs)
      .where(and(gte(cleaningJobs.scheduledDate, from)))
      .orderBy(asc(cleaningJobs.scheduledDate), asc(cleaningJobs.startTime))
      .limit(50);
    return { props, jobs };
  });

  const isOwner = session.memberships?.some((m) => m.role === "owner");

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Cleaning schedule</h1>
        <span className="text-xs text-neutral-500">{isOwner ? "Owner" : "Dispatcher"} · PT</span>
      </div>

      <h2 className="mt-8 text-sm font-medium uppercase tracking-wide text-neutral-500">
        Properties
      </h2>
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
