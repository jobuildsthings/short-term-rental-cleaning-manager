/**
 * GET /api/jobs — jobs visible to the session (RLS-scoped).
 * Query params: property_id, status, from (YYYY-MM-DD), to (YYYY-MM-DD).
 *
 * POST /api/jobs — manual job creation (owner only). Times default to the
 * property window (11:00–15:00); start/end date default to the same day —
 * the client sends a single scheduled_date (contracts §2).
 */
import { and, eq, gte, lte } from "drizzle-orm";
import { apiErrorResponse, assertDate, assertTime, badRequest } from "@/lib/api";
import { AuthError, authErrorResponse, requireOwner, requireSession } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { cleaningJobs } from "@/lib/schema";
import { createManualJob, serializeJob } from "@/lib/scheduler";

export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const url = new URL(req.url);
    const propertyId = url.searchParams.get("property_id");
    const status = url.searchParams.get("status");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    const rows = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const conds = [];
      if (propertyId) conds.push(eq(cleaningJobs.propertyId, propertyId));
      if (status) conds.push(eq(cleaningJobs.status, status));
      if (from) conds.push(gte(cleaningJobs.scheduledDate, from));
      if (to) conds.push(lte(cleaningJobs.scheduledDate, to));
      return tx
        .select()
        .from(cleaningJobs)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(cleaningJobs.scheduledDate, cleaningJobs.startTime)
        .limit(200);
    });

    return Response.json(
      rows.map((j) => ({
        id: j.id,
        property_id: j.propertyId,
        title: j.title,
        job_type: j.jobType,
        scheduled_date: j.scheduledDate,
        start_time: j.startTime,
        end_time: j.endTime,
        status: j.status,
        needs_attention: j.needsAttention,
      })),
    );
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireOwner();
    const body = (await req.json()) as {
      property_id?: unknown;
      title?: unknown;
      job_type?: unknown;
      scheduled_date?: unknown;
      start_time?: unknown;
      end_time?: unknown;
      checklist_template_id?: unknown;
    };
    if (typeof body.property_id !== "string" || body.property_id.length === 0) {
      throw badRequest("property_id is required");
    }
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      throw badRequest("title is required");
    }
    if (typeof body.job_type !== "string") {
      throw badRequest("job_type is required");
    }
    const scheduledDate = assertDate(body.scheduled_date, "scheduled_date");

    const job = await withUser(getDbApp(), session.appUserId, (tx) =>
      createManualJob(tx, {
        propertyId: body.property_id as string,
        title: (body.title as string).trim(),
        jobType: body.job_type as string,
        scheduledDate,
        startTime: body.start_time !== undefined ? assertTime(body.start_time, "start_time") : undefined,
        endTime: body.end_time !== undefined ? assertTime(body.end_time, "end_time") : undefined,
        checklistTemplateId:
          typeof body.checklist_template_id === "string" ? body.checklist_template_id : null,
        createdBy: session.appUserId,
      }),
    );
    return Response.json(serializeJob(job), { status: 201 });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
