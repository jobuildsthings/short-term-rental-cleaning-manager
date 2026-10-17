/**
 * Shared helper for dispatcher job-action routes (confirm / decline /
 * start / complete). Each route file is a thin wrapper around
 * dispatcherAction — the state machine itself lives in lib/scheduler.ts.
 */
import { apiErrorResponse } from "@/lib/api";
import { requireSession } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { serializeJob, transitionJob } from "@/lib/scheduler";
import type { JobStatus } from "@/lib/schema";

export async function dispatcherAction(
  req: Request,
  params: Promise<{ id: string }>,
  to: JobStatus,
): Promise<Response> {
  try {
    const session = await requireSession();
    const { id } = await params;
    let reason: string | undefined;
    if (to === "declined") {
      try {
        const body = (await req.json()) as { reason?: unknown };
        if (typeof body.reason === "string" && body.reason.trim()) {
          reason = body.reason.trim().slice(0, 500);
        }
      } catch {
        // A decline without a body is fine.
      }
    }
    const job = await withUser(getDbApp(), session.appUserId, (tx) =>
      transitionJob(
        tx,
        id,
        to,
        { kind: "user", userId: session.appUserId, role: "dispatcher" },
        { reason },
      ),
    );
    return Response.json(serializeJob(job));
  } catch (e) {
    return apiErrorResponse(e);
  }
}
