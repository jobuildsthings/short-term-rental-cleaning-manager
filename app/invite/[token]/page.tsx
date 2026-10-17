/**
 * /invite/[token] — dispatcher entry point.
 * Shows the invite (role, properties are NOT named to strangers — just the
 * agency-neutral summary), then signs in with the identity-only Google
 * provider ("google"): no calendar scope needed on the dispatcher's side,
 * she sees cleanings through the shared calendar.
 */
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDbAdmin } from "@/lib/db";
import { invites } from "@/lib/schema";
import { AcceptInviteButton } from "./accept-button";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await auth();

  const rows = await getDbAdmin()
    .select({
      email: invites.email,
      role: invites.role,
      expiresAt: invites.expiresAt,
      usedAt: invites.usedAt,
    })
    .from(invites)
    .where(eq(invites.token, token))
    .limit(1);
  const invite = rows[0];
  const valid = !!invite && !invite.usedAt && new Date(invite.expiresAt) > new Date();

  if (!valid) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold">Invite not found</h1>
        <p className="mt-2 text-sm text-neutral-600">
          This invite link is invalid or expired. Ask the owner for a new one.
        </p>
      </main>
    );
  }

  if (session?.appUserId) {
    // Already signed in: claim it immediately.
    redirect(`/invite/${token}/accept`);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold">You&apos;re invited</h1>
      <p className="mt-2 text-sm text-neutral-600">
        {invite.email} has been invited as a <strong>{invite.role}</strong> on
        the cleaning schedule. Sign in with Google to accept.
      </p>
      <AcceptInviteButton token={token} />
      <p className="mt-4 text-xs text-neutral-500">
        No calendar access is requested — you&apos;ll see cleanings on a shared
        calendar instead.
      </p>
    </main>
  );
}
