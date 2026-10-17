/**
 * POST /api/recurring-series — create a series (owner only).
 * The series is expanded immediately: jobs are generated for future
 * occurrences. rrule follows contracts §1 (+ optional dtstart, defaulting
 * to today).
 */
import { eq } from "drizzle-orm";
import { apiErrorResponse, assertTime, badRequest, notFound } from "@/lib/api";
import { requireOwner } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { properties } from "@/lib/schema";
import { createSeries } from "@/lib/scheduler";
import { validateRrule } from "@/lib/recurrence";

export async function POST(req: Request) {
  try {
    const session = await requireOwner();
    const body = (await req.json()) as {
      property_id?: unknown;
      title?: unknown;
      rrule?: unknown;
      default_start_time?: unknown;
      default_end_time?: unknown;
      notes?: unknown;
    };
    if (typeof body.property_id !== "string" || body.property_id.length === 0) {
      throw badRequest("property_id is required");
    }
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      throw badRequest("title is required");
    }
    const v = validateRrule(body.rrule);
    if (!v.ok) throw badRequest(`invalid rrule: ${v.error}`);

    const series = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const [prop] = await tx
        .select({ id: properties.id })
        .from(properties)
        .where(eq(properties.id, body.property_id as string))
        .limit(1);
      if (!prop) throw notFound("Property not found");
      return createSeries(tx, {
        propertyId: body.property_id as string,
        title: (body.title as string).trim(),
        rrule: v.rrule,
        defaultStartTime:
          body.default_start_time !== undefined
            ? assertTime(body.default_start_time, "default_start_time")
            : undefined,
        defaultEndTime:
          body.default_end_time !== undefined
            ? assertTime(body.default_end_time, "default_end_time")
            : undefined,
        notes: typeof body.notes === "string" ? body.notes : null,
        createdBy: session.appUserId,
      });
    });
    return Response.json(
      {
        id: series.id,
        property_id: series.propertyId,
        title: series.title,
        rrule: series.rrule,
        default_start_time: series.defaultStartTime.slice(0, 5),
        default_end_time: series.defaultEndTime.slice(0, 5),
        notes: series.notes,
        is_active: series.isActive,
      },
      { status: 201 },
    );
  } catch (e) {
    return apiErrorResponse(e);
  }
}
