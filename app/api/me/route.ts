/**
 * GET /api/me — session user, memberships, and calendar connection status.
 *
 * google_calendar_connected means:
 * - owner: her own Google account granted Calendar scope (refresh token stored)
 * - dispatcher: the shared "Cleanings" calendar has been provisioned
 *   (Workstream E) — she sees it through the share, no OAuth needed herself.
 */
import { eq } from "drizzle-orm";
import { AuthError, authErrorResponse, requireSession } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { agencySettings, googleOauthTokens, memberships, properties, users } from "@/lib/schema";

export async function GET() {
  try {
    const session = await requireSession();
    const data = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const u = await tx.select().from(users).where(eq(users.id, session.appUserId)).limit(1);
      const ms = await tx
        .select({
          propertyId: memberships.propertyId,
          propertyName: properties.name,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(properties, eq(memberships.propertyId, properties.id))
        .where(eq(memberships.userId, session.appUserId));

      const isOwner = ms.some((m) => m.role === "owner");
      let googleCalendarConnected = false;
      if (isOwner) {
        const tok = await tx
          .select()
          .from(googleOauthTokens)
          .where(eq(googleOauthTokens.userId, session.appUserId))
          .limit(1);
        googleCalendarConnected =
          !!tok[0]?.refreshTokenEncrypted &&
          (tok[0]?.scope ?? "").includes("calendar");
      } else {
        const s = await tx.select().from(agencySettings).limit(1);
        googleCalendarConnected = !!s[0]?.googleCalendarId;
      }

      return {
        user: u[0]
          ? {
              id: u[0].id,
              email: u[0].email,
              displayName: u[0].displayName,
              avatarUrl: u[0].avatarUrl,
            }
          : null,
        memberships: ms,
        google_calendar_connected: googleCalendarConnected,
      };
    });
    return Response.json(data);
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    throw e;
  }
}
