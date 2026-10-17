/**
 * /dispatcher — the agency home. Today's jobs first, then upcoming.
 * Phone-first: big cards, big tap targets, nothing else.
 *
 * Owners are sent to /dashboard; this view is for the dispatcher.
 */
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDbApp, withUser } from "@/lib/db";
import { listDispatcherJobs } from "@/lib/dispatcher";
import JobCard from "@/components/dispatcher/JobCard";

function todayPT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default async function DispatcherHome() {
  const session = await auth();
  const appUserId = session?.appUserId;
  if (!appUserId) redirect("/signin");

  const isOwner = session.memberships?.some((m) => m.role === "owner");
  if (isOwner) redirect("/dashboard");

  const jobs = await withUser(getDbApp(), appUserId, (tx) =>
    listDispatcherJobs(tx, appUserId),
  );

  const today = todayPT();
  const todays = jobs.filter((j) => j.scheduledDate === today);
  const upcoming = jobs.filter((j) => j.scheduledDate !== today);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">My cleanings</h1>
        <span className="text-sm text-neutral-500">All times PT</span>
      </div>

      <h2 className="mt-6 text-sm font-medium uppercase tracking-wide text-neutral-500">
        Today
      </h2>
      <div className="mt-2 space-y-3">
        {todays.map((j) => (
          <JobCard key={j.id} job={j} />
        ))}
        {todays.length === 0 && (
          <p className="rounded-xl border border-neutral-200 bg-white px-5 py-4 text-base text-neutral-500">
            Nothing scheduled for today.
          </p>
        )}
      </div>

      <h2 className="mt-8 text-sm font-medium uppercase tracking-wide text-neutral-500">
        Upcoming
      </h2>
      <div className="mt-2 space-y-3">
        {upcoming.map((j) => (
          <JobCard key={j.id} job={j} />
        ))}
        {upcoming.length === 0 && (
          <p className="rounded-xl border border-neutral-200 bg-white px-5 py-4 text-base text-neutral-500">
            Nothing coming up.
          </p>
        )}
      </div>
    </main>
  );
}
