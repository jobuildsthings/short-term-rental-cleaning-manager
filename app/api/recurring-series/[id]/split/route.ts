/**
 * POST /api/recurring-series/:id/split — "this and following" scope
 * (owner only). {from_date, patch} — terminates the original series the day
 * before from_date and creates a new series from from_date with the patched
 * parameters. Jobs regenerate for both halves.
 */
import { apiErrorResponse, assertDate, assertTime, badRequest } from "@/lib/api";
import { requireOwner } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { splitSeries, type SeriesPatch } from "@/lib/scheduler";
import { validateRrule } from "@/lib/recurrence";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    const body = (await req.json()) as {
      from_date?: unknown;
      patch?: Record<string, unknown>;
    };
    const fromDate = assertDate(body.from_date, "from_date");
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
      patch.notes = typeof p["notes"] === "string" ? p["notes"] : null;
    }

    const { oldSeries, newSeries } = await withUser(getDbApp(), session.appUserId, (tx) =>
      splitSeries(tx, id, fromDate, patch, session.appUserId),
    );
    return Response.json({
      old_series: { id: oldSeries.id, rrule: oldSeries.rrule },
      new_series: { id: newSeries.id, title: newSeries.title, rrule: newSeries.rrule },
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
