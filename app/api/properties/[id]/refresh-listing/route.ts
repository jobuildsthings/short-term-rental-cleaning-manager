/**
 * POST /api/properties/:id/refresh-listing — owner only. Queues a refresh
 * of the property's listing info (title, address, photos) from the public
 * listing page. The actual page read happens via the operator's browser
 * (listings are public pages; server-side fetching is bot-blocked), so
 * this endpoint records the request as queued and returns immediately.
 * Contracts §2: → {sync_job_id, status: 'queued'}.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { AuthError, authErrorResponse, requireOwner } from "@/lib/auth-helpers";
import { apiErrorResponse, notFound } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getDbApp, withUser } from "@/lib/db";
import { properties } from "@/lib/schema";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    const syncJobId = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const props = await tx.select({ id: properties.id }).from(properties).where(eq(properties.id, id)).limit(1);
      if (!props[0]) throw notFound("Property not found");
      const jobId = randomUUID();
      await audit(tx, {
        actorType: "user",
        actorUserId: session.appUserId,
        action: "listing.refresh_queued",
        entityType: "property",
        entityId: id,
        metadata: { sync_job_id: jobId },
      });
      return jobId;
    });
    return Response.json({ sync_job_id: syncJobId, status: "queued" });
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}
