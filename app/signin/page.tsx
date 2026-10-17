/**
 * /signin — owner entry point. Uses the "google-owner" provider, which
 * requests Calendar scope: this single consent connects the owner's Google
 * account so the app can later manage the shared "Cleanings" calendar.
 * Dispatchers never use this page; they sign in via /invite/[token].
 */
"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function SignInForm() {
  const params = useSearchParams();
  const error = params.get("error");
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold">Cleaning Manager</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Self-owned cleaning coordination for your short-term rental. Sign in
        with Google to continue.
      </p>
      {error && (
        <p className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error === "no-invite"
            ? "This Google account isn't invited. Ask the owner for an invite link."
            : "Sign-in failed. Please try again."}
        </p>
      )}
      <button
        onClick={() => signIn("google-owner", { callbackUrl: "/dashboard" })}
        className="mt-6 rounded-lg bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-700"
      >
        Sign in with Google
      </button>
      <p className="mt-4 text-xs text-neutral-500">
        The owner sign-in also connects your Google Calendar, so cleanings can
        be kept on a dedicated shared calendar.
      </p>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
