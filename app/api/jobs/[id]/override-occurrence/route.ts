/**
 * POST /api/jobs/:id/override-occurrence — "this occurrence" scope
 * (owner only). Only meaningful for jobs generated from a recurring series.
 * {occurrence_date, action: 'rescheduled'|'cancelled', new_date?,
 *  new_start_time?, new_end_time?} — writes an override row and re-expands
 * the series. The series itself is untouched.
 */
import { eq } from "drizzle-orm";
import { apiErrorResponse, assertDate, assertTime, badRequest, notFound } from "@/lib/api";
import { requireOwner } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { cleaningJobs } from "@/lib/schema";
import { overrideOccurrence } from "@/lib/scheduler";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    const body = (await req.json()) as {
      occurrence_date?: unknown;
      action?: unknown;
      new_date?: unknown;
      new_start_time?: unknown;
      new_end_time?: unknown;
    };
    const occurrenceDate = assertDate(body.occurrence_date, "occurrence_date");
    const action = body.action;
    if (action !== "rescheduled" && action !== "cancelled") {
      throw badRequest("action must be 'rescheduled' or 'cancelled'");
    }

    await withUser(getDbApp(), session.appUserId, async (tx) => {
      const [job] = await tx
        .select({ seriesId: cleaningJobs.seriesId })
        .from(cleaningJobs)
        .where(eq(cleaningJobs.id, id))
        .limit(1);
      if (!job) throw notFound("Job not found");
      if (!job.seriesId) {
        throw badRequest("override-occurrence only applies to recurring-series jobs");
      }
      await overrideOccurrence(
        tx,
        job.seriesId,
        occurrenceDate,
        action,
        {
          newDate:
            body.new_date !== undefined ? assertDate(body.new_date, "new_date") : undefined,
          newStartTime:
            body.new_start_time !== undefined
              ? assertTime(body.new_start_time, "new_start_time").slice(0, 5)
              : undefined,
          newEndTime:
            body.new_end_time !== undefined
              ? assertTime(body.new_end_time, "new_end_time").slice(0, 5)
              : undefined,
        },
        session.appUserId,
      );
    });
    return Response.json({ ok: true });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
