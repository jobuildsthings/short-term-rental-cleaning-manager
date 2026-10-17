/**
 * POST /api/integrations/google/ensure-cleanings-calendar — owner provisions
 * the shared "Cleanings" calendar.
 *
 * Contracts §2, §4.18–20: finds (or creates) the dedicated calendar in the
 * owner's Google account and shares it with the dispatcher's Google address
 * as a reader. Idempotent — safe to call repeatedly. If the ACL share
 * fails, the calendar id is still recorded and the response reports
 * shared: false, so the UI can show the owner the manual share step.
 */
import { AuthError, authErrorResponse, requireOwner } from "@/lib/auth-helpers";
import { apiErrorResponse } from "@/lib/api";
import { getDbAdmin } from "@/lib/db";
import { CalendarError, ensureCleaningsCalendar } from "@/lib/calendar";

export async function POST() {
  try {
    await requireOwner();
    // Admin connection: calendar provisioning is a worker-grade operation
    // (documented exception — it acts on the owner's OAuth grant, and the
    // route itself is owner-gated).
    const { calendarId, shared } = await ensureCleaningsCalendar(getDbAdmin());
    return Response.json({ calendar_id: calendarId, shared });
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    if (e instanceof CalendarError) {
      return Response.json(
        { error: { code: "calendar_not_connected", message: e.message } },
        { status: 400 },
      );
    }
    return apiErrorResponse(e);
  }
}
