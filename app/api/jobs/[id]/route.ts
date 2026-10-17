/**
 * /api/jobs/:id — job detail and owner edits.
 *
 * GET (member): {job, checklist: [{item, result}], messages_count}.
 * PATCH (owner): {title?, scheduled_date?, start_time?, end_time?,
 *   checklist_template_id?, job_type?} — rescheduling recomputes reminders
 *   (Workstream E hook) and is audited.
 */
import { eq, sql } from "drizzle-orm";
import { apiErrorResponse, assertDate, assertTime, badRequest, notFound } from "@/lib/api";
import { requireOwner, requireSession } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { getDbApp, withUser, type Tx } from "@/lib/db";
import {
  checklistItems,
  checklistTemplates,
  cleaningJobs,
  jobChecklistResults,
  messages,
} from "@/lib/schema";
import { serializeJob } from "@/lib/scheduler";

async function loadJob(tx: Tx, id: string) {
  const [job] = await tx.select().from(cleaningJobs).where(eq(cleaningJobs.id, id)).limit(1);
  if (!job) throw notFound("Job not found");
  return job;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const data = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const job = await loadJob(tx, id);
      let checklist: Array<Record<string, unknown>> = [];
      if (job.checklistTemplateId) {
        const items = await tx
          .select()
          .from(checklistItems)
          .where(eq(checklistItems.templateId, job.checklistTemplateId))
          .orderBy(checklistItems.sortOrder);
        const results = await tx
          .select()
          .from(jobChecklistResults)
          .where(eq(jobChecklistResults.jobId, job.id));
        const byItem = new Map(results.map((r) => [r.checklistItemId, r]));
        checklist = items.map((item) => {
          const r = byItem.get(item.id);
          return {
            item: {
              id: item.id,
              label: item.label,
              sort_order: item.sortOrder,
              photo_required: item.photoRequired,
            },
            result: r
              ? {
                  is_done: r.isDone,
                  photo_url: r.photoUrl,
                  completed_at: r.completedAt,
                }
              : { is_done: false, photo_url: null, completed_at: null },
          };
        });
      }
      const countRows = await tx
        .select({ n: sql<number>`count(*)` })
        .from(messages)
        .where(eq(messages.jobId, job.id));
      return { job: serializeJob(job), checklist, messages_count: Number(countRows[0]?.n ?? 0) };
    });
    return Response.json(data);
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    const body = (await req.json()) as {
      title?: unknown;
      scheduled_date?: unknown;
      start_time?: unknown;
      end_time?: unknown;
      checklist_template_id?: unknown;
      job_type?: unknown;
    };

    const updated = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const job = await loadJob(tx, id);
      if (["completed", "cancelled"].includes(job.status)) {
        throw badRequest(`Cannot edit a ${job.status} job.`);
      }
      const set: Partial<typeof cleaningJobs.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      };
      let rescheduled = false;
      if (body.title !== undefined) {
        if (typeof body.title !== "string" || body.title.trim().length === 0) {
          throw badRequest("title must be a non-empty string");
        }
        set.title = body.title.trim();
      }
      if (body.scheduled_date !== undefined) {
        const d = assertDate(body.scheduled_date, "scheduled_date");
        if (d !== job.scheduledDate) rescheduled = true;
        set.scheduledDate = d;
      }
      if (body.start_time !== undefined) {
        const t = assertTime(body.start_time, "start_time").slice(0, 5);
        if (t !== job.startTime.slice(0, 5)) rescheduled = true;
        set.startTime = t;
      }
      if (body.end_time !== undefined) {
        const t = assertTime(body.end_time, "end_time").slice(0, 5);
        if (t !== job.endTime.slice(0, 5)) rescheduled = true;
        set.endTime = t;
      }
      if (body.checklist_template_id !== undefined) {
        if (body.checklist_template_id !== null && typeof body.checklist_template_id !== "string") {
          throw badRequest("checklist_template_id must be a UUID or null");
        }
        if (typeof body.checklist_template_id === "string") {
          const [tpl] = await tx
            .select({ id: checklistTemplates.id, propertyId: checklistTemplates.propertyId })
            .from(checklistTemplates)
            .where(eq(checklistTemplates.id, body.checklist_template_id))
            .limit(1);
          if (!tpl || tpl.propertyId !== job.propertyId) {
            throw badRequest("checklist template not found on this property");
          }
        }
        set.checklistTemplateId = body.checklist_template_id;
      }
      if (body.job_type !== undefined) {
        const allowed = ["turnover", "recurring", "deep_clean", "restock", "maintenance", "other"];
        if (typeof body.job_type !== "string" || !allowed.includes(body.job_type)) {
          throw badRequest(`job_type must be one of ${allowed.join(", ")}`);
        }
        set.jobType = body.job_type;
      }
      await tx.update(cleaningJobs).set(set).where(eq(cleaningJobs.id, job.id));
      await audit(tx, {
        actorType: "user",
        actorUserId: session.appUserId,
        action: "job.updated",
        entityType: "cleaning_job",
        entityId: job.id,
        metadata: { rescheduled },
      });
      // Workstream E: recompute reminders + update the shared-calendar event when rescheduled.
      const [next] = await tx.select().from(cleaningJobs).where(eq(cleaningJobs.id, job.id)).limit(1);
      return serializeJob(next!);
    });
    return Response.json(updated);
  } catch (e) {
    return apiErrorResponse(e);
  }
}
