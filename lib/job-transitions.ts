/**
 * Job status state machine — enforced server-side on every transition.
 * Mirrors contracts §1 (cleaning_jobs) and §7 decision 1 (`confirmed`).
 *
 * Terminal states: completed, cancelled. `declined` is NOT terminal:
 * declining returns the job to `scheduled` with the assignment cleared
 * (contracts §4 rule 12 / §7 decision 12).
 */
import type { JobStatus } from "./schema";

export type Role = "owner" | "dispatcher";

interface Edge {
  from: JobStatus;
  to: JobStatus;
  roles: Role[];
}

const EDGES: Edge[] = [
  { from: "draft", to: "scheduled", roles: ["owner"] },
  { from: "scheduled", to: "assigned", roles: ["owner"] },
  { from: "assigned", to: "confirmed", roles: ["dispatcher"] },
  { from: "assigned", to: "declined", roles: ["dispatcher"] },
  // System returns a declined job to the pool; the owner then reassigns.
  { from: "declined", to: "scheduled", roles: ["owner"] },
  { from: "confirmed", to: "in_progress", roles: ["dispatcher"] },
  { from: "in_progress", to: "completed", roles: ["dispatcher"] },
];

const TERMINAL: JobStatus[] = ["completed", "cancelled"];

/** Cancellation: any non-terminal state → cancelled, owner only. */
export function canTransition(from: JobStatus, to: JobStatus, role: Role): boolean {
  if (from === to) return false;
  if (to === "cancelled") {
    return role === "owner" && !TERMINAL.includes(from);
  }
  return EDGES.some((e) => e.from === from && e.to === to && e.roles.includes(role));
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

/** All states a role may move a job to from `from`. */
export function allowedTransitions(from: JobStatus, role: Role): JobStatus[] {
  const out = new Set<JobStatus>();
  for (const e of EDGES) {
    if (e.from === from && e.roles.includes(role)) out.add(e.to);
  }
  if (role === "owner" && !TERMINAL.includes(from)) out.add("cancelled");
  return [...out];
}
