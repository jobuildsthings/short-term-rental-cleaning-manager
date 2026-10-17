/**
 * PATCH /api/recurring-series/:id — "entire series" scope (owner only).
 * {scope: 'series', patch} — updates the series and regenerates all future,
 * non-completed occurrences. Completed/cancelled jobs are never rewritten.
 * Setting is_active=false cancels future scheduled/assigned jobs.
 */
import { apiErrorResponse, assertTime, badRequest } from "@/lib/api";
import { requireOwner } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { updateSeries, type SeriesPatch } from "@/lib/scheduler";
import { validateRrule } from "@/lib/recurrence";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    const body = (await req.json()) as { scope?: unknown; patch?: Record<string, unknown> };
    if (body.scope !== "series") {
      throw badRequest("scope must be 'series' (use /split or /override-occurrence for other scopes)");
    }
    const p = body.patch ?? {};
    const patch: SeriesPatch = {};
    if (p["title"] !== undefined) {
      if (typeof p["title"] !== "string" || p["title"].trim().length === 0) {
        throw badRequest("title must be a non-empty string");
      }
      patch.title = p["title"].trim();
    }
    if (p["rrule"] !== undefined) {
      const v = validateRrule(p["rrule"]);
      if (!v.ok) throw badRequest(`invalid rrule: ${v.error}`);
      patch.rrule = v.rrule;
    }
    if (p["default_start_time"] !== undefined) {
      patch.defaultStartTime = assertTime(p["default_start_time"], "default_start_time");
    }
    if (p["default_end_time"] !== undefined) {
      patch.defaultEndTime = assertTime(p["default_end_time"], "default_end_time");
    }
    if (p["notes"] !== undefined) {
      if (p["notes"] !== null && typeof p["notes"] !== "string") {
        throw badRequest("notes must be a string or null");
      }
      patch.notes = p["notes"] as string | null;
    }
    if (p["is_active"] !== undefined) {
      if (typeof p["is_active"] !== "boolean") throw badRequest("is_active must be a boolean");
      patch.isActive = p["is_active"];
    }

    const series = await withUser(getDbApp(), session.appUserId, (tx) =>
      updateSeries(tx, id, patch, session.appUserId),
    );
    return Response.json({
      id: series.id,
      title: series.title,
      rrule: series.rrule,
      is_active: series.isActive,
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
