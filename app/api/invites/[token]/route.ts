/**
 * GET /api/invites/:token — public invite preview (unguessable token).
 * Uses the admin client: unauthenticated callers have no RLS identity.
 * Returns metadata only — never anything sensitive.
 */
import { eq } from "drizzle-orm";
import { getDbAdmin } from "@/lib/db";
import { invites } from "@/lib/schema";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const rows = await getDbAdmin()
    .select({
      email: invites.email,
      role: invites.role,
      propertyIds: invites.propertyIds,
      expiresAt: invites.expiresAt,
      usedAt: invites.usedAt,
    })
    .from(invites)
    .where(eq(invites.token, token))
    .limit(1);

  const invite = rows[0];
  if (!invite || invite.usedAt || new Date(invite.expiresAt) <= new Date()) {
    return Response.json(
      { error: { code: "not_found", message: "This invite is invalid or expired." } },
      { status: 404 },
    );
  }
  return Response.json({
    email: invite.email,
    role: invite.role,
    property_ids: invite.propertyIds,
    expires_at: invite.expiresAt,
  });
}
