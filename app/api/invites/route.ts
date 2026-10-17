/**
 * POST /api/invites — owner creates a single-use, 7-day dispatcher invite.
 * Body: { email, role: 'dispatcher', property_ids: string[] }
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AuthError, authErrorResponse, requireOwner } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { auditLog, invites, properties } from "@/lib/schema";

const Body = z.object({
  email: z.string().email(),
  role: z.literal("dispatcher"),
  property_ids: z.array(z.string().uuid()).min(1),
});

export async function POST(req: Request) {
  try {
    const session = await requireOwner();
    const body = Body.parse(await req.json());

    const result = await withUser(getDbApp(), session.appUserId, async (tx) => {
      // Every property id must exist (RLS scopes the read).
      const props = await tx.select({ id: properties.id }).from(properties);
      const known = new Set(props.map((p) => p.id));
      for (const pid of body.property_ids) {
        if (!known.has(pid)) {
          throw new AuthError("forbidden");
        }
      }

      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      const [row] = await tx
        .insert(invites)
        .values({
          token,
          email: body.email,
          role: body.role,
          propertyIds: body.property_ids,
          expiresAt,
          createdBy: session.appUserId,
        })
        .returning({ id: invites.id });

      await tx.insert(auditLog).values({
        actorType: "user",
        actorUserId: session.appUserId,
        action: "invite.created",
        entityType: "invite",
        entityId: row!.id,
        metadata: { email: body.email, role: body.role },
      });

      return { invite_token: token, expires_at: expiresAt };
    });
    return Response.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    if (e instanceof z.ZodError) {
      return Response.json(
        { error: { code: "invalid_body", message: "Invalid request body." } },
        { status: 400 },
      );
    }
    throw e;
  }
}
