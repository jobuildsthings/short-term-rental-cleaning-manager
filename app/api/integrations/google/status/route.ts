/**
 * GET /api/integrations/google/status — calendar connection status.
 *
 * Calendar model: ONE dedicated "Cleanings" calendar lives in the OWNER's
 * Google account and is shared with the dispatcher's Google address.
 * - owner: `connected` = her own account granted Calendar scope
 *   (refresh token with calendar scope stored).
 * - dispatcher: `connected` = the shared calendar has been provisioned
 *   (she sees it through the share; no OAuth needed on her side).
 * - `calendar_id` / `calendar_shared_with_dispatcher` are written by the
 *   calendar sync (Workstream E); NULL/false until then.
 */
import { eq } from "drizzle-orm";
import { AuthError, authErrorResponse, requireSession } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { agencySettings, googleOauthTokens } from "@/lib/schema";

export async function GET() {
  try {
    const session = await requireSession();
    const data = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const isOwner = session.memberships.some((m) => m.role === "owner");
      const settings = await tx.select().from(agencySettings).limit(1);
      const s = settings[0];

      let connected = false;
      if (isOwner) {
        const tok = await tx
          .select()
          .from(googleOauthTokens)
          .where(eq(googleOauthTokens.userId, session.appUserId))
          .limit(1);
        connected =
          !!tok[0]?.refreshTokenEncrypted &&
          (tok[0]?.scope ?? "").includes("calendar");
      } else {
        connected = !!s?.googleCalendarId;
      }

      return {
        connected,
        calendar_id: s?.googleCalendarId ?? null,
        calendar_shared_with_dispatcher: s?.googleCalendarShared ?? false,
        last_sync_at: null,
      };
    });
    return Response.json(data);
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    throw e;
  }
}
