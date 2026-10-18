/**
 * PATCH /api/checklist-templates/:templateId — owner; rename.
 * DELETE /api/checklist-templates/:templateId — owner; items cascade.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AuthError, authErrorResponse, requireOwner } from "@/lib/auth-helpers";
import { apiErrorResponse, notFound } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getDbApp, withUser } from "@/lib/db";
import { checklistTemplates } from "@/lib/schema";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ templateId: string }> },
) {
  try {
    const session = await requireOwner();
    const { templateId } = await params;
    const body = z.object({ name: z.string().min(1).max(200) }).parse(await req.json());
    const result = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const [t] = await tx
        .update(checklistTemplates)
        .set({ name: body.name })
        .where(eq(checklistTemplates.id, templateId))
        .returning();
      if (!t) throw notFound("Checklist template not found");
      await audit(tx, {
        actorType: "user",
        actorUserId: session.appUserId,
        action: "checklist_template.updated",
        entityType: "checklist_template",
        entityId: t.id,
        metadata: { name: body.name },
      });
      return { id: t.id, name: t.name };
    });
    return Response.json(result);
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ templateId: string }> },
) {
  try {
    const session = await requireOwner();
    const { templateId } = await params;
    await withUser(getDbApp(), session.appUserId, async (tx) => {
      const [t] = await tx
        .delete(checklistTemplates)
        .where(eq(checklistTemplates.id, templateId))
        .returning({ id: checklistTemplates.id });
      if (!t) throw notFound("Checklist template not found");
      await audit(tx, {
        actorType: "user",
        actorUserId: session.appUserId,
        action: "checklist_template.deleted",
        entityType: "checklist_template",
        entityId: templateId,
        metadata: {},
      });
    });
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}
