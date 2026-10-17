/**
 * POST /api/auth/accept-invite — signed-in user claims a dispatcher invite.
 * Body: { token }
 *
 * Validates the token (exists, unused, unexpired, email matches the Google
 * identity), then — in one admin transaction — links/creates the user row,
 * creates memberships, marks the invite used, and writes an audit entry.
 * Uses the admin client because invite acceptance happens before the user
 * has any RLS identity (documented exception).
 *
 * After this returns, the client must refresh the session (useSession().update())
 * so the new memberships land in the JWT.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { AuthError, authErrorResponse, requireSession } from "@/lib/auth-helpers";
import { getDbAdmin } from "@/lib/db";
import { auditLog, invites, memberships, users } from "@/lib/schema";

const Body = z.object({ token: z.string().min(1) });

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const { token } = Body.parse(await req.json());
    const db = getDbAdmin();

    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(invites)
        .where(
          and(
            eq(invites.token, token),
            isNull(invites.usedAt),
            gt(invites.expiresAt, new Date().toISOString()),
          ),
        )
        .limit(1);
      const invite = rows[0];
      if (!invite) {
        throw new AuthError("forbidden");
      }
      if (invite.email.toLowerCase() !== (session.user?.email ?? "").toLowerCase()) {
        throw new AuthError("forbidden");
      }

      // Link (or create) the user row for this Google identity.
      let userId = session.appUserId;
      const existing = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!existing[0]) {
        const inserted = await tx
          .insert(users)
          .values({
            email: session.user!.email!,
            displayName: session.user!.name ?? session.user!.email!,
          })
          .returning({ id: users.id });
        userId = inserted[0]!.id;
      }

      const created: { propertyId: string; role: string }[] = [];
      for (const pid of invite.propertyIds) {
        await tx
          .insert(memberships)
          .values({ userId, propertyId: pid, role: invite.role })
          .onConflictDoNothing();
        created.push({ propertyId: pid, role: invite.role });
      }

      await tx.update(invites).set({ usedAt: new Date().toISOString() }).where(eq(invites.id, invite.id));

      await tx.insert(auditLog).values({
        actorType: "user",
        actorUserId: userId,
        action: "invite.accepted",
        entityType: "invite",
        entityId: invite.id,
        metadata: { role: invite.role },
      });

      return { user: { id: userId }, memberships: created };
    });

    return Response.json(result);
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
