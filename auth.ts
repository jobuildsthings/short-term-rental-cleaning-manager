/**
 * Authentication: Google OAuth only, invite-only, no public sign-up.
 *
 * TWO Google provider instances (spec update 2026-10-17 — shared calendar model):
 * - "google-owner": requests Calendar scope (access_type offline). The OWNER
 *   signs in through /signin with this provider; this single consent is how
 *   the owner's Google account gets connected so the app can later manage
 *   the dedicated shared "Cleanings" calendar (Workstream E provisions it).
 * - "google" (default): identity only (openid/email/profile). The DISPATCHER
 *   signs in through /invite/[token] with this provider — no calendar scope
 *   needed on her side; she sees cleanings through the share.
 *
 * Invite-only enforcement lives in the signIn callback: a Google identity
 * is admitted only if it maps to an existing active user, matches
 * BOOTSTRAP_OWNER_EMAIL while the users table is empty (first-run owner
 * creation), or has a valid pending invite for its email address.
 */
import NextAuth from "next-auth";
import type { Session } from "next-auth";
import Google from "next-auth/providers/google";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDbAdmin } from "./lib/db";
import { invites, memberships, properties, users, googleOauthTokens } from "./lib/schema";
import { encryptField } from "./lib/crypto";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

declare module "next-auth" {
  interface Session {
    appUserId?: string;
    memberships?: { propertyId: string; propertyName: string; role: string }[];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    appUserId?: string;
    memberships?: { propertyId: string; propertyName: string; role: string }[];
  }
}

async function loadMemberships(db: ReturnType<typeof getDbAdmin>, userId: string) {
  const rows = await db
    .select({
      propertyId: memberships.propertyId,
      propertyName: properties.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(properties, eq(memberships.propertyId, properties.id))
    .where(eq(memberships.userId, userId));
  return rows;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  providers: [
    Google({
      id: "google-owner",
      name: "Google",
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          scope: `openid email profile ${CALENDAR_SCOPE}`,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
    Google({
      // Default id "google": identity only — the dispatcher invite flow.
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: { scope: "openid email profile" },
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (!user.email || !account?.providerAccountId) return false;
      const db = getDbAdmin();

      // 1. Existing active user (by Google sub, then by email for linking).
      const bySub = await db
        .select()
        .from(users)
        .where(eq(users.googleSub, account.providerAccountId))
        .limit(1);
      if (bySub[0]?.isActive) return true;
      const byEmail = await db
        .select()
        .from(users)
        .where(eq(users.email, user.email))
        .limit(1);
      if (byEmail[0]?.isActive) return true;

      // 2. First-run bootstrap: the configured email becomes the owner.
      const bootstrap = process.env.BOOTSTRAP_OWNER_EMAIL;
      if (bootstrap && user.email === bootstrap) {
        const count = await db.select({ id: users.id }).from(users).limit(1);
        if (count.length === 0) return true;
      }

      // 3. Valid pending invite for this email address.
      const pending = await db
        .select()
        .from(invites)
        .where(
          and(
            eq(invites.email, user.email),
            isNull(invites.usedAt),
            gt(invites.expiresAt, new Date().toISOString()),
          ),
        )
        .limit(1);
      return pending.length > 0;
    },

    async jwt({ token, account, trigger }) {
      const db = getDbAdmin();

      if (account?.providerAccountId) {
        // Initial sign-in: link (or bootstrap/create) the app user.
        let appUserId: string | undefined;
        const bySub = await db
          .select()
          .from(users)
          .where(eq(users.googleSub, account.providerAccountId))
          .limit(1);
        if (bySub[0]) {
          appUserId = bySub[0].id;
        } else if (account.provider && (token.email as string | undefined)) {
          const email = token.email as string;
          const byEmail = await db.select().from(users).where(eq(users.email, email)).limit(1);
          if (byEmail[0]) {
            // Link this Google identity to the invited user row.
            await db
              .update(users)
              .set({ googleSub: account.providerAccountId })
              .where(eq(users.id, byEmail[0].id));
            appUserId = byEmail[0].id;
          } else {
            // Bootstrap owner (signIn callback already verified eligibility).
            const inserted = await db
              .insert(users)
              .values({
                email,
                displayName: (token.name as string | undefined) ?? email,
                googleSub: account.providerAccountId,
                avatarUrl: (token.picture as string | undefined) ?? null,
              })
              .returning({ id: users.id });
            appUserId = inserted[0]!.id;
          }
        }
        if (!appUserId) return token;

        // Store/refresh the Google OAuth tokens (encrypted at rest).
        // Only the owner flow yields a refresh token with calendar scope,
        // but store whatever we get — the status endpoint interprets it.
        if (account.refresh_token) {
          await db
            .insert(googleOauthTokens)
            .values({
              userId: appUserId,
              refreshTokenEncrypted: encryptField(account.refresh_token),
              scope: account.scope ?? null,
            })
            .onConflictDoUpdate({
              target: googleOauthTokens.userId,
              set: {
                refreshTokenEncrypted: encryptField(account.refresh_token),
                scope: account.scope ?? null,
                updatedAt: new Date().toISOString(),
              },
            });
        }
        token.appUserId = appUserId;
        token.memberships = await loadMemberships(db, appUserId);
      } else if (trigger === "update" && token.appUserId) {
        // Session refresh after invite acceptance: pick up new memberships.
        token.memberships = await loadMemberships(db, token.appUserId as string);
      }
      return token;
    },

    async session({ session, token }) {
      session.appUserId = token.appUserId as string | undefined;
      session.memberships = (token.memberships as Session["memberships"]) ?? [];
      return session;
    },
  },
  pages: {
    signIn: "/signin",
  },
});
