"use client";

import { signIn } from "next-auth/react";

/** Identity-only Google sign-in for the dispatcher invite flow. */
export function AcceptInviteButton({ token }: { token: string }) {
  return (
    <button
      onClick={() => signIn("google", { callbackUrl: `/invite/${token}/accept` })}
      className="mt-6 rounded-lg bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-700"
    >
      Sign in with Google to accept
    </button>
  );
}
