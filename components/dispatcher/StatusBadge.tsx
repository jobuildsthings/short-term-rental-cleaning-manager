/** Small status pill. Colors are semantic, labels are plain words. */
const STYLES: Record<string, string> = {
  assigned: "bg-amber-100 text-amber-900",
  confirmed: "bg-sky-100 text-sky-900",
  in_progress: "bg-violet-100 text-violet-900",
  completed: "bg-emerald-100 text-emerald-900",
  declined: "bg-rose-100 text-rose-900",
  scheduled: "bg-neutral-100 text-neutral-700",
  cancelled: "bg-neutral-200 text-neutral-500",
  draft: "bg-neutral-100 text-neutral-500",
};

const LABELS: Record<string, string> = {
  assigned: "New — needs your OK",
  confirmed: "Confirmed",
  in_progress: "In progress",
  completed: "Done",
  declined: "Declined",
  scheduled: "Scheduled",
  cancelled: "Cancelled",
  draft: "Draft",
};

export default function StatusBadge({ status }: { status: string }) {
  const style = STYLES[status] ?? STYLES.scheduled!;
  const label = LABELS[status] ?? status;
  return (
    <span
      className={`inline-block shrink-0 rounded-full px-3 py-1 text-sm font-medium ${style}`}
    >
      {label}
    </span>
  );
}
