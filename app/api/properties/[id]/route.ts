/**
 * GET /api/properties/:id — property detail (member: owner sees all,
 * dispatcher sees assigned). Includes the CURRENT access instructions
 * (decrypted in memory for the response only — the dispatcher needs the
 * codes to get in). Values are never logged.
 *
 * PATCH /api/properties/:id — owner only. Partial update of property
 * fields. Changing `access_instructions` writes the prior encrypted value
 * to access_instruction_history first, then updates; audits
 * `access_instructions.changed` with timestamp + actor only (no values).
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AuthError, authErrorResponse, requireOwner, requireSession } from "@/lib/auth-helpers";
import { apiErrorResponse, assertTime, badRequest, notFound } from "@/lib/api";
import { audit } from "@/lib/audit";
import { decryptField, encryptField } from "@/lib/crypto";
import { getDbApp, withUser } from "@/lib/db";
import { accessInstructionHistory, properties } from "@/lib/schema";

function serialize(p: typeof properties.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    listing_url: p.listingUrl,
    listing_title: p.listingTitle,
    listing_address: p.listingAddress,
    listing_photo_urls: p.listingPhotoUrls,
    listing_last_refreshed_at: p.listingLastRefreshedAt,
    timezone: p.timezone,
    default_window_start: p.defaultWindowStart,
    default_window_end: p.defaultWindowEnd,
    checkin_time: p.checkinTime,
    checkout_time: p.checkoutTime,
    turnover_buffer_minutes: p.turnoverBufferMinutes,
    reminder_hours_before: p.reminderHoursBefore,
    access_instructions: p.accessInstructions ? decryptField(p.accessInstructions) : null,
    access_instructions_updated_at: p.accessInstructionsUpdatedAt,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const rows = await withUser(getDbApp(), session.appUserId, (tx) =>
      tx.select().from(properties).where(eq(properties.id, id)).limit(1),
    );
    const p = rows[0];
    if (!p) throw notFound("Property not found");
    return Response.json(serialize(p));
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  listing_url: z.string().url().max(2000).nullable().optional(),
  timezone: z.string().min(1).max(100).optional(),
  default_window_start: z.string().optional(),
  default_window_end: z.string().optional(),
  checkin_time: z.string().nullable().optional(),
  checkout_time: z.string().nullable().optional(),
  turnover_buffer_minutes: z.number().int().min(0).max(480).optional(),
  reminder_hours_before: z.array(z.number().int().min(0).max(168)).min(1).max(5).optional(),
  access_instructions: z.string().max(4000).nullable().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireOwner();
    const { id } = await params;
    const body = PatchBody.parse(await req.json());
    if (Object.keys(body).length === 0) throw badRequest("Nothing to update");

    const result = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const rows = await tx.select().from(properties).where(eq(properties.id, id)).limit(1);
      const p = rows[0];
      if (!p) throw notFound("Property not found");

      const patch: Partial<typeof properties.$inferInsert> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.listing_url !== undefined) patch.listingUrl = body.listing_url;
      if (body.timezone !== undefined) patch.timezone = body.timezone;
      if (body.default_window_start !== undefined)
        patch.defaultWindowStart = assertTime(body.default_window_start, "default_window_start");
      if (body.default_window_end !== undefined)
        patch.defaultWindowEnd = assertTime(body.default_window_end, "default_window_end");
      if (body.checkin_time !== undefined)
        patch.checkinTime = body.checkin_time === null ? null : assertTime(body.checkin_time, "checkin_time");
      if (body.checkout_time !== undefined)
        patch.checkoutTime = body.checkout_time === null ? null : assertTime(body.checkout_time, "checkout_time");
      if (body.turnover_buffer_minutes !== undefined)
        patch.turnoverBufferMinutes = body.turnover_buffer_minutes;
      if (body.reminder_hours_before !== undefined)
        patch.reminderHoursBefore = body.reminder_hours_before;

      // Access instructions: history-first, then update. Values never logged.
      let instructionsChanged = false;
      if (body.access_instructions !== undefined) {
        const current = p.accessInstructions ? decryptField(p.accessInstructions) : null;
        const next = body.access_instructions;
        if (current !== next) {
          instructionsChanged = true;
          if (p.accessInstructions) {
            await tx.insert(accessInstructionHistory).values({
              propertyId: p.id,
              instructionsEncrypted: p.accessInstructions,
              changedBy: session.appUserId,
            });
          }
          patch.accessInstructions = next === null ? null : encryptField(next);
          patch.accessInstructionsUpdatedAt = new Date().toISOString();
          patch.accessInstructionsUpdatedBy = session.appUserId;
        }
      }

      patch.updatedAt = new Date().toISOString();
      const [updated] = await tx
        .update(properties)
        .set(patch)
        .where(eq(properties.id, id))
        .returning();
      if (!updated) throw notFound("Property not found");

      await audit(tx, {
        actorType: "user",
        actorUserId: session.appUserId,
        action: "property.updated",
        entityType: "property",
        entityId: id,
        metadata: { fields: Object.keys(patch).filter((k) => k !== "accessInstructions") },
      });
      if (instructionsChanged) {
        await audit(tx, {
          actorType: "user",
          actorUserId: session.appUserId,
          action: "access_instructions.changed",
          entityType: "property",
          entityId: id,
          // Metadata only: when + by whom. Never the values.
          metadata: {},
        });
      }
      return updated;
    });
    return Response.json(serialize(result));
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}
