/**
 * One-tap job actions for the dispatcher. Big buttons (min 56px), plain
 * labels, optimistic busy state. Decline opens a reason field — the reason
 * is what the owner sees in the daily digest.
 */
"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { DispatcherAction } from "@/lib/dispatcher";

const ACTIONS: Array<{ action: DispatcherAction; label: string; style: string }> = [
  {
    action: "confirm",
    label: "Confirm this job",
    style: "bg-emerald-600 text-white active:bg-emerald-700",
  },
  {
    action: "decline",
    label: "Decline",
    style: "bg-white text-rose-700 border-2 border-rose-300 active:bg-rose-50",
  },
  {
    action: "start",
    label: "Start cleaning",
    style: "bg-sky-600 text-white active:bg-sky-700",
  },
  {
    action: "complete",
    label: "Mark complete",
    style: "bg-emerald-600 text-white active:bg-emerald-700",
  },
];

export default function JobActions({
  jobId,
  allowedActions,
}: {
  jobId: string;
  allowedActions: DispatcherAction[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  function run(action: DispatcherAction, body?: Record<string, unknown>) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/dispatcher/jobs/${jobId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error?.message ?? `Could not ${action} the job. Try again.`);
        return;
      }
      setDeclining(false);
      setReason("");
      // A declined job leaves the dispatcher's queue — go home. Everything
      // else just re-renders the detail with its new state.
      if (action === "decline") router.push("/dispatcher");
      else router.refresh();
    });
  }

  const visible = ACTIONS.filter((a) => allowedActions.includes(a.action));
  if (visible.length === 0) return null;

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg bg-rose-50 px-4 py-3 text-base text-rose-800">
          {error}
        </div>
      )}

      {declining ? (
        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <label
            htmlFor="decline-reason"
            className="block text-base font-medium text-neutral-800"
          >
            Why can&apos;t you take this job? (optional — the owner sees this)
          </label>
          <textarea
            id="decline-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="mt-2 w-full rounded-lg border border-neutral-300 px-3 py-2 text-base"
            placeholder="e.g. crew fully booked that day"
          />
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              disabled={pending}
              onClick={() => run("decline", reason.trim() ? { reason: reason.trim() } : undefined)}
              className="min-h-[56px] flex-1 rounded-xl bg-rose-600 text-lg font-semibold text-white disabled:opacity-50"
            >
              {pending ? "Sending…" : "Decline job"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setDeclining(false);
                setReason("");
              }}
              className="min-h-[56px] rounded-xl border border-neutral-300 px-6 text-lg font-medium text-neutral-700"
            >
              Back
            </button>
          </div>
        </div>
      ) : (
        visible.map(({ action, label, style }) => (
          <button
            key={action}
            type="button"
            disabled={pending}
            onClick={() =>
              action === "decline" ? setDeclining(true) : run(action)
            }
            className={`min-h-[56px] w-full rounded-xl text-lg font-semibold disabled:opacity-50 ${style}`}
          >
            {pending ? "Working…" : label}
          </button>
        ))
      )}
    </div>
  );
}
