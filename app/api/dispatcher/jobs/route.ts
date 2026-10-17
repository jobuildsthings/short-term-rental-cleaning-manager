/**
 * GET /api/dispatcher/jobs — jobs assigned to the signed-in dispatcher,
 * today and upcoming. RLS-scoped; the handler additionally filters by
 * assigned_to_user_id so the response contract is explicit.
 */
import { AuthError, authErrorResponse, requireSession } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { DispatcherError, listDispatcherJobs } from "@/lib/dispatcher";

export async function GET() {
  try {
    const session = await requireSession();
    const jobs = await withUser(getDbApp(), session.appUserId, (tx) =>
      listDispatcherJobs(tx, session.appUserId),
    );
    return Response.json(jobs);
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    if (e instanceof DispatcherError)
      return Response.json(
        { error: { code: e.code, message: e.message } },
        { status: e.status },
      );
    throw e;
  }
}
