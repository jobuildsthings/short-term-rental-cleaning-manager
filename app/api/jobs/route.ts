/**
 * GET /api/jobs — jobs visible to the session (RLS-scoped).
 * Query params: property_id, status, from (YYYY-MM-DD), to (YYYY-MM-DD).
 * Full job CRUD + state transitions are Workstream B; this foundation
 * endpoint proves the permission matrix end to end.
 */
import { and, eq, gte, lte } from "drizzle-orm";
import { AuthError, authErrorResponse, requireSession } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { cleaningJobs } from "@/lib/schema";

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
