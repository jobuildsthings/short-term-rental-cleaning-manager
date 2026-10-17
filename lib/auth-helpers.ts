/**
 * Request authentication helpers.
 *
 * Every API route starts with requireSession() (or requireOwner()).
 * Data access then goes through withUser(session.appUserId, …) so the
 * database enforces the permission matrix even if a handler forgets a
 * filter — RLS is the backstop, these helpers are the front door.
 *
 * NOTE: `@/auth` (next-auth) is imported lazily inside requireSession so
 * that modules importing these helpers (e.g. lib/api) stay loadable in
 * unit tests, which never touch the session.
 */
import type { Session } from "next-auth";

export class AuthError extends Error {
  status: 401 | 403;
  constructor(code: "unauthenticated" | "forbidden") {
    super(code);
    this.status = code === "unauthenticated" ? 401 : 403;
  }
}

export type AppSession = Session & {
  appUserId: string;
  memberships: { propertyId: string; propertyName: string; role: string }[];
};

/** Throw AuthError(401) unless a signed-in app user exists. */
export async function requireSession(): Promise<AppSession> {
  const { auth } = await import("@/auth");
  const session = (await auth()) as AppSession | null;
  if (!session?.appUserId) {
    throw new AuthError("unauthenticated");
  }
  return session;
}

/** Throw AuthError(403) unless the session belongs to an owner. */
export async function requireOwner(): Promise<AppSession> {
  const session = await requireSession();
  if (!session.memberships.some((m) => m.role === "owner")) {
    throw new AuthError("forbidden");
  }
  return session;
}

/** JSON error body matching the contracts' error shape. */
export function authErrorResponse(e: AuthError): Response {
  return Response.json(
    { error: { code: e.message, message: e.message === "unauthenticated" ? "Sign in required." : "Not allowed." } },
    { status: e.status },
  );
}
