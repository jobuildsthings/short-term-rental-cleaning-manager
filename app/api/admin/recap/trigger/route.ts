/**
 * POST /api/admin/recap/trigger — owner manually triggers the weekly recap.
 *
 * Contracts §2. Idempotent per week_starting: if this week's recap was
 * already sent, returns the existing run instead of double-sending
 * (unless {force: true} is passed).
 */
import { AuthError, authErrorResponse, requireOwner } from "@/lib/auth-helpers";
import { apiErrorResponse } from "@/lib/api";
import { getDbAdmin } from "@/lib/db";
import { runRecap } from "@/lib/recap";

export async function POST(req: Request) {
  try {
    await requireOwner();
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    const result = await runRecap(getDbAdmin(), { force: body.force === true });
    return Response.json({ recap_run_id: result.recapRunId, status: result.status });
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}
