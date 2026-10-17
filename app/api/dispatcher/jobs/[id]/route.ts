/**
 * GET /api/dispatcher/jobs/:id — full detail for one assigned job:
 * property + address, current access instructions (decrypted server-side,
 * never logged), checklist with per-job results, message count, and the
 * shared-calendar link state. 404 unless assigned to the caller.
 */
import { AuthError, authErrorResponse, requireSession } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { DispatcherError, getDispatcherJobDetail } from "@/lib/dispatcher";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const detail = await withUser(getDbApp(), session.appUserId, (tx) =>
      getDispatcherJobDetail(tx, session.appUserId, id),
    );
    return Response.json(detail);
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
