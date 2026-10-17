/**
 * MessageThread — per-job message thread (Workstream D).
 *
 * Reusable client component: drop it into any job detail surface (host or
 * dispatcher view). Newest message first, simple compose box, phone-first
 * styling. All times rendered explicitly in America/Los_Angeles.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDateTimePT } from "@/lib/time";

interface ThreadMessage {
  id: string;
  body: string;
  created_at: string;
  sender: { id: string; role: "owner" | "dispatcher"; isYou: boolean };
}

function senderLabel(m: ThreadMessage): string {
  if (m.sender.isYou) return "You";
  return m.sender.role === "owner" ? "Owner" : "Dispatcher";
}

export default function MessageThread({ jobId }: { jobId: string }) {
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/messages`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message ?? "Could not load messages.");
      }
      setMessages(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load messages.");
    }
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message ?? "Could not send the message.");
      }
      setDraft("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section aria-label="Messages" className="mt-8">
      <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
        Messages
      </h2>

      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <ul className="mt-2 space-y-2">
        {messages === null && (
          <li className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-500">
            Loading messages…
          </li>
        )}
        {messages !== null &&
          messages.map((m) => (
            <li
              key={m.id}
              className={`rounded-lg border px-4 py-3 ${
                m.sender.isYou
                  ? "border-blue-200 bg-blue-50"
                  : "border-neutral-200 bg-white"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-neutral-600">
                  {senderLabel(m)}
                </span>
                <time className="shrink-0 text-xs text-neutral-400">
                  {formatDateTimePT(m.created_at)}
                </time>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-900">
                {m.body}
              </p>
            </li>
          ))}
        {messages !== null && messages.length === 0 && (
          <li className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-500">
            No messages yet. Say hello — the other side gets a notification.
          </li>
        )}
      </ul>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label htmlFor={`msg-${jobId}`} className="sr-only">
          Write a message
        </label>
        <input
          id={`msg-${jobId}`}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a message…"
          maxLength={2000}
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-4 py-2.5 text-base"
        />
        <button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          className="shrink-0 rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}
