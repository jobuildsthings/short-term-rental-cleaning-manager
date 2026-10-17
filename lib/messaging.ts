/**
 * Per-job messaging (Workstream D).
 *
 * Contracts §1 (messages table — immutable, per-job), §2 (GET/POST
 * /api/jobs/:id/messages), §3 (owner: all threads; dispatcher: threads of
 * jobs assigned to them only), §4 rule 22 + §7.16 (new message triggers a
 * lightweight fallback notification to the other party — SMS via the
 * owner's phone to the dispatcher, email to the owner; the actual send is
 * Workstream E's job, this module only records the intent), §5 (message
 * bodies never in audit metadata).
 *
 * Permission enforcement is defense in depth: these functions check
 * participation explicitly for clean 403/404 semantics, and the RLS
 * policies on `messages` (no UPDATE/DELETE policy at all — immutable at
 * the database level) remain the backstop.
 */
import { desc, eq } from "drizzle-orm";
import type { Tx } from "./db";
import { auditLog, cleaningJobs, messages } from "./schema";

export type ParticipantRole = "owner" | "dispatcher";

export class MessageError extends Error {
  status: 400 | 403 | 404;
  code: string;
  constructor(code: string, status: 400 | 403 | 404, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface ThreadMessage {
  id: string;
  body: string;
  createdAt: string;
  sender: { id: string; role: ParticipantRole; isYou: boolean };
}

const MAX_BODY_LENGTH = 2000;

function cleanBody(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new MessageError("invalid_body", 400, "Message body must be a string.");
  }
  const body = raw.trim();
  if (body.length === 0) {
    throw new MessageError("empty_body", 400, "Message body cannot be empty.");
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new MessageError(
      "body_too_long",
      400,
      `Message body is too long (max ${MAX_BODY_LENGTH} characters).`,
    );
  }
  return body;
}

/**
 * Load the job and verify the user may participate in its thread.
 * Mirrors the RLS policy exactly: owner bypass, otherwise the job must be
 * assigned to the user. Throws MessageError(404) when the job is not
 * visible, MessageError(403) when visible-but-not-participant.
 * `tx` must be RLS-scoped via withUser().
 */
export async function assertCanMessage(
  tx: Tx,
  jobId: string,
  userId: string,
  isOwner: boolean,
) {
  const rows = await tx
    .select({
      id: cleaningJobs.id,
      propertyId: cleaningJobs.propertyId,
      assignedToUserId: cleaningJobs.assignedToUserId,
    })
    .from(cleaningJobs)
    .where(eq(cleaningJobs.id, jobId))
    .limit(1);
  const job = rows[0];
  if (!job) {
    throw new MessageError("job_not_found", 404, "Job not found.");
  }
  if (!isOwner && job.assignedToUserId !== userId) {
    throw new MessageError(
      "forbidden",
      403,
      "You can only message on jobs assigned to you.",
    );
  }
  return job;
}

/**
 * Post a message to a job thread. Inserts the immutable message row and
 * records the fallback-notification intent as an audit row
 * (action 'message.posted', metadata carries job_id, message_id and the
 * notification channel/recipient — NEVER the body, per §5).
 *
 * Workstream E consumes the intent. Long-term home for intents is a
 * dedicated notification_outbox table — see
 * docs/decisions/2026-10-17-message-notification-outbox.md.
 */
export async function postJobMessage(
  tx: Tx,
  args: {
    jobId: string;
    senderUserId: string;
    senderRole: ParticipantRole;
    isOwner: boolean;
    body: unknown;
  },
): Promise<ThreadMessage> {
  const body = cleanBody(args.body);
  await assertCanMessage(tx, args.jobId, args.senderUserId, args.isOwner);

  const [row] = await tx
    .insert(messages)
    .values({ jobId: args.jobId, senderUserId: args.senderUserId, body })
    .returning({ id: messages.id, createdAt: messages.createdAt });
  if (!row) {
    throw new MessageError("post_failed", 400, "Could not post the message.");
  }

  // §7.16: SMS via the owner's phone to the dispatcher; email to the owner.
  const notification =
    args.senderRole === "owner"
      ? { channel: "sms", recipient: "dispatcher" }
      : { channel: "email", recipient: "owner" };

  await tx.insert(auditLog).values({
    actorType: "user",
    actorUserId: args.senderUserId,
    action: "message.posted",
    entityType: "message",
    entityId: row.id,
    metadata: {
      job_id: args.jobId,
      message_id: row.id,
      notification,
    },
  });

  return {
    id: row.id,
    body,
    createdAt: row.createdAt,
    sender: { id: args.senderUserId, role: args.senderRole, isYou: true },
  };
}

/**
 * List a job's thread, newest first. `viewerRole` is the viewer's role on
 * the job's property (from their session memberships). The other party in
 * a thread is always the opposite role — threads are strictly
 * owner ↔ dispatcher, so no extra user-table reads are needed (and RLS
 * would hide the other party's user row from a dispatcher anyway).
 */
export async function listJobMessages(
  tx: Tx,
  args: {
    jobId: string;
    viewerUserId: string;
    viewerRole: ParticipantRole;
    isOwner: boolean;
  },
): Promise<ThreadMessage[]> {
  await assertCanMessage(tx, args.jobId, args.viewerUserId, args.isOwner);

  const rows = await tx
    .select({
      id: messages.id,
      body: messages.body,
      createdAt: messages.createdAt,
      senderUserId: messages.senderUserId,
    })
    .from(messages)
    .where(eq(messages.jobId, args.jobId))
    .orderBy(desc(messages.createdAt), desc(messages.id));

  const otherRole: ParticipantRole =
    args.viewerRole === "owner" ? "dispatcher" : "owner";

  return rows.map((m) => {
    const isYou = m.senderUserId === args.viewerUserId;
    return {
      id: m.id,
      body: m.body,
      createdAt: m.createdAt,
      sender: {
        id: m.senderUserId,
        role: isYou ? args.viewerRole : otherRole,
        isYou,
      },
    };
  });
}
