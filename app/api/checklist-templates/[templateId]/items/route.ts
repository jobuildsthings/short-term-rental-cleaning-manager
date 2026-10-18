/**
 * POST /api/checklist-templates/:templateId/items — owner; add an item.
 */
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { AuthError, authErrorResponse, requireOwner } from "@/lib/auth-helpers";
import { apiErrorResponse, notFound } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getDbApp, withUser } from "@/lib/db";
import { checklistItems, checklistTemplates } from "@/lib/schema";

const Body = z.object({
  label: z.string().min(1).max(500),
  sort_order: z.number().int().min(0).max(10000).optional(),
  photo_required: z.boolean().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ templateId: string }> },
) {
  try {
    const session = await requireOwner();
    const { templateId } = await params;
    const body = Body.parse(await req.json());
    const result = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const tmpl = await tx
        .select({ id: checklistTemplates.id })
        .from(checklistTemplates)
        .where(eq(checklistTemplates.id, templateId))
        .limit(1);
      if (!tmpl[0]) throw notFound("Checklist template not found");
      let sortOrder = body.sort_order;
      if (sortOrder === undefined) {
        const existing = await tx
          .select({ sortOrder: checklistItems.sortOrder })
          .from(checklistItems)
          .where(eq(checklistItems.templateId, templateId))
          .orderBy(asc(checklistItems.sortOrder));
        sortOrder = existing.length === 0 ? 0 : Math.max(...existing.map((e) => e.sortOrder)) + 1;
      }
      const [item] = await tx
        .insert(checklistItems)
        .values({
          templateId,
          label: body.label,
          sortOrder,
          photoRequired: body.photo_required ?? false,
        })
        .returning();
      await audit(tx, {
        actorType: "user",
        actorUserId: session.appUserId,
        action: "checklist_item.created",
        entityType: "checklist_item",
        entityId: item!.id,
        metadata: { template_id: templateId },
      });
      return {
        id: item!.id,
        label: item!.label,
        sort_order: item!.sortOrder,
        photo_required: item!.photoRequired,
      };
    });
    return Response.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}
