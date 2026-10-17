/**
 * POST /api/jobs/:id/assign — owner assigns a job to the dispatcher.
 * Accepts jobs in `scheduled` or `declined` state (a declined job flows
 * declined → scheduled → assigned atomically, both transitions audited).
 * The assignee must be a dispatcher with a membership on the job's property.
 */
import { and, eq } from "drizzle-orm";
import { apiErrorResponse, badRequest, notFound } from "@/lib/api";
import { requireOwner } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { cleaningJobs, memberships } from "@/lib/schema";
import { serializeJob, transitionJob } from "@/lib/scheduler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    const body = (await req.json()) as { user_id?: unknown };
    if (typeof body.user_id !== "string" || body.user_id.length === 0) {
      throw badRequest("user_id is required");
    }

    const job = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const [j] = await tx
        .select()
        .from(cleaningJobs)
        .where(eq(cleaningJobs.id, id))
        .limit(1);
      if (!j) throw notFound("Job not found");
      if (!["scheduled", "declined"].includes(j.status)) {
        throw badRequest(`Cannot assign a job in status ${j.status}.`);
      }
      const [m] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, body.user_id as string),
            eq(memberships.propertyId, j.propertyId),
          ),
        )
        .limit(1);
      if (!m || m.role !== "dispatcher") {
        throw badRequest("Assignee must be a dispatcher on this property.");
      }

      let current = j;
      if (current.status === "declined") {
        current = await transitionJob(
          tx,
          current.id,
          "scheduled",
          { kind: "user", userId: session.appUserId, role: "owner" },
        );
      }
      current = await transitionJob(
        tx,
        current.id,
        "assigned",
        { kind: "user", userId: session.appUserId, role: "owner" },
      );
      await tx
        .update(cleaningJobs)
        .set({ assignedToUserId: body.user_id as string, updatedAt: new Date().toISOString() })
        .where(eq(cleaningJobs.id, current.id));
      const [done] = await tx
        .select()
        .from(cleaningJobs)
        .where(eq(cleaningJobs.id, current.id))
        .limit(1);
      return done!;
    });
    return Response.json(serializeJob(job));
  } catch (e) {
    return apiErrorResponse(e);
  }
}
