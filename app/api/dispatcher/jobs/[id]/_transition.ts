/**
 * Shared handler factory for dispatcher one-tap transitions.
 * (Underscore-prefixed: not a route.)
 */
import { AuthError, authErrorResponse, requireSession } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import {
  DispatcherError,
  transitionDispatcherJob,
  type DispatcherAction,
} from "@/lib/dispatcher";

export function transitionHandler(action: DispatcherAction) {
  return async (
    req: Request,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    try {
      const session = await requireSession();
      const { id } = await params;
      let reason: string | undefined;
      if (action === "decline") {
        try {
          const body = await req.json();
          if (typeof body?.reason === "string") reason = body.reason.slice(0, 500);
        } catch {
          // No body is fine — reason is optional.
        }
      }
      const job = await withUser(getDbApp(), session.appUserId, (tx) =>
        transitionDispatcherJob(tx, session.appUserId, id, action, { reason }),
      );
      return Response.json(job);
    } catch (e) {
      if (e instanceof AuthError) return authErrorResponse(e);
      if (e instanceof DispatcherError)
        return Response.json(
          { error: { code: e.code, message: e.message } },
          { status: e.status },
        );
      throw e;
    }
  };
}
