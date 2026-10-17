/**
 * PATCH /api/dispatcher/jobs/:id/checklist — toggle a checklist item on an
 * assigned job. Body: {item_id: string, is_done: boolean}.
 * (Photo upload is Phase 2.)
 */
import { AuthError, authErrorResponse, requireSession } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { DispatcherError, setDispatcherChecklistResult } from "@/lib/dispatcher";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const body = await req.json();
    const itemId = body?.item_id;
    const isDone = body?.is_done;
    if (typeof itemId !== "string" || typeof isDone !== "boolean") {
      return Response.json(
        { error: { code: "invalid_request", message: "Expected {item_id: string, is_done: boolean}." } },
        { status: 400 },
      );
    }
    const result = await withUser(getDbApp(), session.appUserId, (tx) =>
      setDispatcherChecklistResult(tx, session.appUserId, id, itemId, isDone),
    );
    return Response.json(result);
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
