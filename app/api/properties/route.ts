/**
 * GET /api/properties — properties visible to the session (RLS-scoped).
 * The dispatcher sees current access instructions on assigned properties
 * (she needs the codes to get in); values are decrypted in memory here
 * and never logged.
 */
import { AuthError, authErrorResponse, requireSession } from "@/lib/auth-helpers";
import { decryptField } from "@/lib/crypto";
import { getDbApp, withUser } from "@/lib/db";
import { properties } from "@/lib/schema";

export async function GET() {
  try {
    const session = await requireSession();
    const rows = await withUser(getDbApp(), session.appUserId, async (tx) =>
      tx.select().from(properties),
    );
    return Response.json(
      rows.map((p) => ({
        id: p.id,
        name: p.name,
        listing_url: p.listingUrl,
        listing_title: p.listingTitle,
        listing_address: p.listingAddress,
        listing_photo_urls: p.listingPhotoUrls,
        timezone: p.timezone,
        default_window_start: p.defaultWindowStart,
        default_window_end: p.defaultWindowEnd,
        // Decrypted in memory for the response only — never logged.
        access_instructions: p.accessInstructions ? decryptField(p.accessInstructions) : null,
        access_instructions_updated_at: p.accessInstructionsUpdatedAt,
      })),
    );
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    throw e;
  }
}
