/**
 * POST /api/ical-feeds/:feedId/sync — manual sync trigger. Owner only.
 * The network fetch happens outside the DB transaction; only the apply
 * phase runs inside withUser (RLS-scoped).
 */
import { eq } from "drizzle-orm";
import { apiErrorResponse, notFound } from "@/lib/api";
import { requireOwner } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { icalFeeds, properties } from "@/lib/schema";
import { applyFeedSync, fetchFeedEvents } from "@/lib/scheduler";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ feedId: string }> },
) {
  try {
    const session = await requireOwner();
    const { feedId } = await params;

    const target = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const [feed] = await tx
        .select()
        .from(icalFeeds)
        .where(eq(icalFeeds.id, feedId))
        .limit(1);
      if (!feed) throw notFound("Feed not found");
      const [prop] = await tx
        .select({ timezone: properties.timezone })
        .from(properties)
        .where(eq(properties.id, feed.propertyId))
        .limit(1);
      return { url: feed.url, timezone: prop?.timezone ?? "America/Los_Angeles" };
    });

    // Fetch outside any transaction (feed URLs never leave this scope).
    const fetched = await fetchFeedEvents(target.url, target.timezone);

    const result = await withUser(getDbApp(), session.appUserId, (tx) =>
      applyFeedSync(tx, feedId, fetched),
    );
    return Response.json({
      status: result.status,
      reservations_upserted: result.reservationsUpserted,
      reservations_removed: result.reservationsRemoved,
      jobs_created: result.jobsCreated,
      jobs_updated: result.jobsUpdated,
      jobs_cancelled: result.jobsCancelled,
      jobs_flagged: result.jobsFlagged,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
