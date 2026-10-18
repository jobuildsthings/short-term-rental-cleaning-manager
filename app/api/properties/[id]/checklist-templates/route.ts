/**
 * GET /api/properties/:id/checklist-templates — member; templates with items.
 * POST /api/properties/:id/checklist-templates — owner; {name, items: [{label, sort_order?, photo_required?}]}.
 */
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { AuthError, authErrorResponse, requireOwner, requireSession } from "@/lib/auth-helpers";
import { apiErrorResponse, notFound } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getDbApp, withUser } from "@/lib/db";
import { checklistItems, checklistTemplates, properties } from "@/lib/schema";

async function loadTemplates(tx: Parameters<Parameters<ReturnType<typeof getDbApp>["transaction"]>[0]>[0], propertyId: string) {
  const templates = await tx
    .select()
    .from(checklistTemplates)
    .where(eq(checklistTemplates.propertyId, propertyId))
    .orderBy(asc(checklistTemplates.name));
  const out = [];
  for (const t of templates) {
    const items = await tx
      .select()
      .from(checklistItems)
      .where(eq(checklistItems.templateId, t.id))
      .orderBy(asc(checklistItems.sortOrder));
    out.push({
      id: t.id,
      name: t.name,
      items: items.map((i) => ({
        id: i.id,
        label: i.label,
        sort_order: i.sortOrder,
        photo_required: i.photoRequired,
      })),
    });
  }
  return out;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const result = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const props = await tx.select({ id: properties.id }).from(properties).where(eq(properties.id, id)).limit(1);
      if (!props[0]) throw notFound("Property not found");
      return loadTemplates(tx, id);
    });
    return Response.json(result);
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}

const ItemBody = z.object({
  label: z.string().min(1).max(500),
  sort_order: z.number().int().min(0).max(10000).optional(),
  photo_required: z.boolean().optional(),
});

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  items: z.array(ItemBody).max(100).default([]),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    const body = CreateBody.parse(await req.json());
    const result = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const props = await tx.select({ id: properties.id }).from(properties).where(eq(properties.id, id)).limit(1);
      if (!props[0]) throw notFound("Property not found");
      const [t] = await tx
        .insert(checklistTemplates)
        .values({ propertyId: id, name: body.name })
        .returning();
      if (body.items.length > 0) {
        await tx.insert(checklistItems).values(
          body.items.map((it, idx) => ({
            templateId: t!.id,
            label: it.label,
            sortOrder: it.sort_order ?? idx,
            photoRequired: it.photo_required ?? false,
          })),
        );
      }
      await audit(tx, {
        actorType: "user",
        actorUserId: session.appUserId,
        action: "checklist_template.created",
        entityType: "checklist_template",
        entityId: t!.id,
        metadata: { property_id: id, name: body.name, items: body.items.length },
      });
      const items = await tx
        .select()
        .from(checklistItems)
        .where(eq(checklistItems.templateId, t!.id))
        .orderBy(asc(checklistItems.sortOrder));
      return {
        id: t!.id,
        name: t!.name,
        items: items.map((i) => ({
          id: i.id,
          label: i.label,
          sort_order: i.sortOrder,
          photo_required: i.photoRequired,
        })),
      };
    });
    return Response.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}
