/**
 * GET /api/jobs/:id/reminders — owner only. Reminder metadata for a job:
 * [{channel, scheduled_for, status, attempts}]. Bodies are never stored
 * and never returned (contracts §2: "no bodies").
 */
import { asc, eq } from "drizzle-orm";
import { AuthError, authErrorResponse, requireOwner } from "@/lib/auth-helpers";
import { apiErrorResponse, notFound } from "@/lib/api";
import { getDbApp, withUser } from "@/lib/db";
import { cleaningJobs, reminders } from "@/lib/schema";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    const rows = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const jobs = await tx.select({ id: cleaningJobs.id }).from(cleaningJobs).where(eq(cleaningJobs.id, id)).limit(1);
      if (!jobs[0]) throw notFound("Job not found");
      return tx
        .select()
        .from(reminders)
        .where(eq(reminders.jobId, id))
        .orderBy(asc(reminders.scheduledFor));
    });
    return Response.json(
      rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        recipient: r.recipient,
        scheduled_for: r.scheduledFor,
        status: r.status,
        attempts: r.attempts,
        last_error: r.lastError,
      })),
    );
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}
