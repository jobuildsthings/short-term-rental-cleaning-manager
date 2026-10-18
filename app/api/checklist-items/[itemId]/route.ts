/**
 * PATCH /api/checklist-items/:itemId — owner; label/sort_order/photo_required.
 * DELETE /api/checklist-items/:itemId — owner.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AuthError, authErrorResponse, requireOwner } from "@/lib/auth-helpers";
import { apiErrorResponse, badRequest, notFound } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getDbApp, withUser } from "@/lib/db";
import { checklistItems } from "@/lib/schema";

const PatchBody = z.object({
  label: z.string().min(1).max(500).optional(),
  sort_order: z.number().int().min(0).max(10000).optional(),
  photo_required: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ itemId: string }> },
) {
  try {
    const session = await requireOwner();
    const { itemId } = await params;
    const body = PatchBody.parse(await req.json());
    if (Object.keys(body).length === 0) throw badRequest("Nothing to update");
    const result = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const patch: Partial<typeof checklistItems.$inferInsert> = {};
      if (body.label !== undefined) patch.label = body.label;
      if (body.sort_order !== undefined) patch.sortOrder = body.sort_order;
      if (body.photo_required !== undefined) patch.photoRequired = body.photo_required;
      const [item] = await tx
        .update(checklistItems)
        .set(patch)
        .where(eq(checklistItems.id, itemId))
        .returning();
      if (!item) throw notFound("Checklist item not found");
      await audit(tx, {
        actorType: "user",
        actorUserId: session.appUserId,
        action: "checklist_item.updated",
        entityType: "checklist_item",
        entityId: item.id,
        metadata: {},
      });
      return {
        id: item.id,
        label: item.label,
        sort_order: item.sortOrder,
        photo_required: item.photoRequired,
      };
    });
    return Response.json(result);
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ itemId: string }> },
) {
  try {
    const session = await requireOwner();
    const { itemId } = await params;
    await withUser(getDbApp(), session.appUserId, async (tx) => {
      const [item] = await tx
        .delete(checklistItems)
        .where(eq(checklistItems.id, itemId))
        .returning({ id: checklistItems.id });
      if (!item) throw notFound("Checklist item not found");
      await audit(tx, {
        actorType: "user",
        actorUserId: session.appUserId,
        action: "checklist_item.deleted",
        entityType: "checklist_item",
        entityId: itemId,
        metadata: {},
      });
    });
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}
