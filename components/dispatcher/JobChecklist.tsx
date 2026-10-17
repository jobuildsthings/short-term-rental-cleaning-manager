/**
 * Job checklist for the dispatcher. Tapping a row toggles it done/not done.
 * Big tap targets; the change saves immediately.
 */
"use client";

import { useState, useTransition } from "react";
import type { DispatcherChecklistRow } from "@/lib/dispatcher";

export default function JobChecklist({
  jobId,
  initial,
}: {
  jobId: string;
  initial: DispatcherChecklistRow[];
}) {
  const [items, setItems] = useState(initial);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle(item: DispatcherChecklistRow) {
    setError(null);
    const next = !item.isDone;
    setItems((prev) =>
      prev.map((p) => (p.itemId === item.itemId ? { ...p, isDone: next } : p)),
    );
    startTransition(async () => {
      const res = await fetch(`/api/dispatcher/jobs/${jobId}/checklist`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: item.itemId, is_done: next }),
      });
      if (!res.ok) {
        setError("Could not save that change. Try again.");
        setItems((prev) =>
          prev.map((p) =>
            p.itemId === item.itemId ? { ...p, isDone: item.isDone } : p,
          ),
        );
      }
    });
  }

  if (items.length === 0) return null;
  const done = items.filter((i) => i.isDone).length;

  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
        Checklist — {done} of {items.length} done
      </h2>
      {error && (
        <div className="mt-2 rounded-lg bg-rose-50 px-4 py-3 text-base text-rose-800">
          {error}
        </div>
      )}
      <ul className="mt-2 divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
        {items.map((item) => (
          <li key={item.itemId}>
            <button
              type="button"
              disabled={isPending}
              onClick={() => toggle(item)}
              className="flex min-h-[56px] w-full items-center gap-3 px-4 py-3 text-left active:bg-neutral-50"
              aria-pressed={item.isDone}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-2 ${
                  item.isDone
                    ? "border-emerald-600 bg-emerald-600 text-white"
                    : "border-neutral-300 bg-white"
                }`}
                aria-hidden
              >
                {item.isDone && (
                  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
                    <path d="M6.5 11.2 3.3 8l-1.1 1.1 4.3 4.3 8.3-8.3L13.7 4z" />
                  </svg>
                )}
              </span>
              <span
                className={`text-base ${item.isDone ? "text-neutral-400 line-through" : "text-neutral-800"}`}
              >
                {item.label}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
