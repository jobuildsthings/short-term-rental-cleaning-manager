/**
 * /invite/[token]/accept — claims the invite for the signed-in user, then
 * refreshes the session so the new memberships land in the JWT.
 */
"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export default function AcceptPage({ params }: { params: Promise<{ token: string }> }) {
  const { data: session, update } = useSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current || !session?.user) return;
    ran.current = true;
    (async () => {
      const { token } = await params;
      const res = await fetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        setError("This invite couldn't be accepted. It may be for a different email address.");
        return;
      }
      await update(); // refresh JWT with new memberships
      router.replace("/dashboard");
    })();
  }, [session, params, router, update]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold">Accepting invite…</h1>
      {error && <p className="mt-4 text-sm text-red-700">{error}</p>}
    </main>
  );
}
