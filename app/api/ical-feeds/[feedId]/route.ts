/**
 * DELETE /api/ical-feeds/:feedId — remove a booking-calendar feed.
 * Owner only. Reservations sourced from the feed are left in place (they
 * describe real stays); only future syncs stop.
 */
import { eq } from "drizzle-orm";
import { apiErrorResponse, notFound } from "@/lib/api";
import { requireOwner } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { icalFeeds } from "@/lib/schema";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ feedId: string }> },
) {
  try {
    const session = await requireOwner();
    const { feedId } = await params;
    await withUser(getDbApp(), session.appUserId, async (tx) => {
      const [feed] = await tx
        .select({ id: icalFeeds.id })
        .from(icalFeeds)
        .where(eq(icalFeeds.id, feedId))
        .limit(1);
      if (!feed) throw notFound("Feed not found");
      await tx.delete(icalFeeds).where(eq(icalFeeds.id, feedId));
    });
    return new Response(null, { status: 204 });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
