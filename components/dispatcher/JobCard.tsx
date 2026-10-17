/**
 * One job in the dispatcher's list. The whole card is a big tap target
 * (min 64px tall) linking to the job detail.
 */
import Link from "next/link";
import type { DispatcherJobSummary } from "@/lib/dispatcher";
import StatusBadge from "./StatusBadge";

export default function JobCard({ job }: { job: DispatcherJobSummary }) {
  return (
    <Link
      href={`/dispatcher/jobs/${job.id}`}
      className="block rounded-xl border border-neutral-200 bg-white px-5 py-4 shadow-sm active:bg-neutral-50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-lg font-semibold leading-snug">{job.title}</div>
          <div className="mt-0.5 truncate text-base text-neutral-600">
            {job.propertyName}
          </div>
        </div>
        <StatusBadge status={job.status} />
      </div>
      <div className="mt-2 text-base text-neutral-700">{job.whenLabel}</div>
      {job.needsAttention && (
        <div className="mt-2 text-base font-medium text-amber-700">
          Needs attention — check details
        </div>
      )}
    </Link>
  );
}
