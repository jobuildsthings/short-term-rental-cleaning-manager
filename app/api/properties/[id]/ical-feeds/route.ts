/**
 * /api/properties/:id/ical-feeds — list (metadata only, never URLs) and
 * create booking-calendar feeds. Owner only: feed URLs are secrets and the
 * dispatcher must never see them (contracts §3).
 */
import { eq } from "drizzle-orm";
import { apiErrorResponse, badRequest, notFound } from "@/lib/api";
import { requireOwner } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { icalFeeds, properties } from "@/lib/schema";

function serializeFeed(f: typeof icalFeeds.$inferSelect) {
  return {
    id: f.id,
    property_id: f.propertyId,
    label: f.label,
    last_synced_at: f.lastSyncedAt,
    last_sync_status: f.lastSyncStatus,
    last_sync_error: f.lastSyncError,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    const rows = await withUser(getDbApp(), session.appUserId, (tx) =>
      tx.select().from(icalFeeds).where(eq(icalFeeds.propertyId, id)),
    );
    return Response.json(rows.map(serializeFeed));
  } catch (e) {
    return apiErrorResponse(e);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    const body = (await req.json()) as { label?: unknown; url?: unknown };
    if (typeof body.label !== "string" || body.label.trim().length === 0) {
      throw badRequest("label is required");
    }
    if (typeof body.url !== "string" || !/^https?:\/\//.test(body.url.trim())) {
      throw badRequest("url must be an http(s) URL");
    }
    const label = body.label.trim();
    const url = body.url.trim();
    const created = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const [prop] = await tx
        .select({ id: properties.id })
        .from(properties)
        .where(eq(properties.id, id))
        .limit(1);
      if (!prop) throw notFound("Property not found");
      const [feed] = await tx
        .insert(icalFeeds)
        .values({ propertyId: id, label, url })
        .returning();
      return feed!;
    });
    return Response.json(serializeFeed(created), { status: 201 });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
