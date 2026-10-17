/**
 * /dispatcher/jobs/:id — job detail for the dispatcher.
 *
 * Address, time window (always PT), current access instructions
 * (decrypted server-side, never logged), checklist, one-tap actions,
 * and the shared-calendar link state.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDbApp, withUser } from "@/lib/db";
import { DispatcherError, getDispatcherJobDetail } from "@/lib/dispatcher";
import JobActions from "@/components/dispatcher/JobActions";
import JobChecklist from "@/components/dispatcher/JobChecklist";
import StatusBadge from "@/components/dispatcher/StatusBadge";

export default async function DispatcherJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  const appUserId = session?.appUserId;
  if (!appUserId) redirect("/signin");

  const isOwner = session.memberships?.some((m) => m.role === "owner");
  if (isOwner) redirect("/dashboard");

  const { id } = await params;
  let detail;
  try {
    detail = await withUser(getDbApp(), appUserId, (tx) =>
      getDispatcherJobDetail(tx, appUserId, id),
    );
  } catch (e) {
    if (e instanceof DispatcherError && e.status === 404) notFound();
    throw e;
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Link
        href="/dispatcher"
        className="inline-block min-h-[44px] py-2 text-base font-medium text-sky-700"
      >
        ← All cleanings
      </Link>

      <div className="mt-2 flex items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold leading-tight">{detail.title}</h1>
        <StatusBadge status={detail.status} />
      </div>
      <p className="mt-1 text-lg text-neutral-700">{detail.whenLabel}</p>

      <section className="mt-6 rounded-xl border border-neutral-200 bg-white px-5 py-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Property
        </h2>
        <p className="mt-1 text-lg font-medium">{detail.propertyName}</p>
        {detail.propertyAddress && (
          <p className="text-base text-neutral-600">{detail.propertyAddress}</p>
        )}
      </section>

      {detail.accessInstructions && (
        <section className="mt-4 rounded-xl border-2 border-amber-300 bg-amber-50 px-5 py-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-amber-800">
            Access instructions
          </h2>
          <p className="mt-1 whitespace-pre-wrap text-lg text-neutral-900">
            {detail.accessInstructions}
          </p>
        </section>
      )}

      <section className="mt-4 rounded-xl border border-neutral-200 bg-white px-5 py-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Calendar
        </h2>
        <p className="mt-1 text-base text-neutral-700">
          {detail.calendarState === "linked"
            ? "On the shared Cleanings calendar — check your calendar app."
            : "Not on the shared calendar yet."}
        </p>
      </section>

      <div className="mt-6">
        <JobActions jobId={detail.id} allowedActions={detail.allowedActions} />
      </div>

      <JobChecklist jobId={detail.id} initial={detail.checklist} />

      {detail.messagesCount > 0 && (
        <p className="mt-6 text-center text-base text-neutral-500">
          {detail.messagesCount} message{detail.messagesCount === 1 ? "" : "s"} on
          this job — messaging arrives with the next workstream.
        </p>
      )}
    </main>
  );
}
