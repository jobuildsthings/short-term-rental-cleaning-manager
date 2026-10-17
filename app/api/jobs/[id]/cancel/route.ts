/**
 * POST /api/jobs/:id/cancel — owner cancels a job from any non-terminal
 * state. Pending reminders are skipped; the shared-calendar event is
 * deleted (Workstream E hook).
 */
import { apiErrorResponse } from "@/lib/api";
import { requireOwner } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { serializeJob, transitionJob } from "@/lib/scheduler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    let reason: string | undefined;
    try {
      const body = (await req.json()) as { reason?: unknown };
      if (typeof body.reason === "string" && body.reason.trim()) {
        reason = body.reason.trim().slice(0, 500);
      }
    } catch {
      // A cancel without a body is fine.
    }
    const job = await withUser(getDbApp(), session.appUserId, (tx) =>
      transitionJob(
        tx,
        id,
        "cancelled",
        { kind: "user", userId: session.appUserId, role: "owner" },
        { reason },
      ),
    );
    return Response.json(serializeJob(job));
  } catch (e) {
    return apiErrorResponse(e);
  }
}
