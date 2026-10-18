/**
 * GET /api/properties/:id/access-instructions/history — owner only.
 * Metadata only (changed_at, changed_by display info). Prior VALUES are
 * never returned by this endpoint (contracts §1: the owner may reveal a
 * prior value only through an explicit separate endpoint).
 */
import { desc, eq } from "drizzle-orm";
import { AuthError, authErrorResponse, requireOwner } from "@/lib/auth-helpers";
import { apiErrorResponse, notFound } from "@/lib/api";
import { getDbApp, withUser } from "@/lib/db";
import { accessInstructionHistory, properties, users } from "@/lib/schema";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    const rows = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const props = await tx.select({ id: properties.id }).from(properties).where(eq(properties.id, id)).limit(1);
      if (!props[0]) throw notFound("Property not found");
      return tx
        .select({
          changedAt: accessInstructionHistory.changedAt,
          changedBy: accessInstructionHistory.changedBy,
          changedByName: users.displayName,
        })
        .from(accessInstructionHistory)
        .innerJoin(users, eq(users.id, accessInstructionHistory.changedBy))
        .where(eq(accessInstructionHistory.propertyId, id))
        .orderBy(desc(accessInstructionHistory.changedAt));
    });
    return Response.json(
      rows.map((r) => ({
        changed_at: r.changedAt,
        changed_by: r.changedBy,
        changed_by_name: r.changedByName,
      })),
    );
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}
