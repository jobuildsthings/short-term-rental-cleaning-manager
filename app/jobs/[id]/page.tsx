/**
 * /jobs/[id] — minimal job detail (Workstream D's surface for the message
 * thread). Shows the job header and the per-job thread; both the owner and
 * the dispatcher land here. Workstream C (host UI) may extend or replace
 * this page — the MessageThread component is the stable contract.
 */
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDbApp, withUser } from "@/lib/db";
import { cleaningJobs, properties } from "@/lib/schema";
import { formatDatePT, formatWallTimePT } from "@/lib/time";
import MessageThread from "@/components/messages/MessageThread";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const appUserId = session?.appUserId;
  if (!appUserId) redirect("/signin");

  const job = await withUser(getDbApp(), appUserId, async (tx) => {
    const rows = await tx
      .select({
        id: cleaningJobs.id,
        title: cleaningJobs.title,
        status: cleaningJobs.status,
        scheduledDate: cleaningJobs.scheduledDate,
        startTime: cleaningJobs.startTime,
        endTime: cleaningJobs.endTime,
        propertyName: properties.name,
      })
      .from(cleaningJobs)
      .innerJoin(properties, eq(cleaningJobs.propertyId, properties.id))
      .where(eq(cleaningJobs.id, id))
      .limit(1);
    return rows[0] ?? null;
  });

  // RLS already scoped the query: invisible job → 404 (no existence leak).
  if (!job) notFound();

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <a href="/dashboard" className="text-sm text-neutral-500 underline">
        ← Back to schedule
      </a>
      <h1 className="mt-2 text-2xl font-semibold">{job.title}</h1>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-600">
        <span>{job.propertyName}</span>
        <span>
          {formatDatePT(job.scheduledDate)} · {formatWallTimePT(job.startTime)} –{" "}
          {formatWallTimePT(job.endTime)}
        </span>
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">
          {job.status}
        </span>
      </div>

      <MessageThread jobId={job.id} />
    </main>
  );
}
