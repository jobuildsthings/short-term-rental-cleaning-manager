/**
 * GET /api/jobs/:id/messages — the job's message thread, newest first.
 * POST /api/jobs/:id/messages — post to the thread; records the
 * fallback-notification intent for Workstream E (see §4 rule 22).
 *
 * Auth: member. Owner reads/writes all threads; dispatcher only threads
 * of jobs assigned to them (enforced in lib/messaging.ts + RLS).
 */
import {
  AuthError,
  authErrorResponse,
  requireSession,
  type AppSession,
} from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import {
  MessageError,
  assertCanMessage,
  listJobMessages,
  postJobMessage,
  type ParticipantRole,
} from "@/lib/messaging";

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function messageErrorResponse(e: MessageError): Response {
  return errorResponse(e.code, e.message, e.status);
}

/** The viewer's role on the job's property, from their session memberships. */
function viewerRoleFor(
  session: AppSession,
  propertyId: string,
  isOwner: boolean,
): ParticipantRole {
  const m = session.memberships.find((x) => x.propertyId === propertyId);
  if (m?.role === "owner" || m?.role === "dispatcher") return m.role;
  return isOwner ? "owner" : "dispatcher";
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession();
    const { id: jobId } = await params;
    const isOwner = session.memberships.some((m) => m.role === "owner");

    const thread = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const job = await assertCanMessage(tx, jobId, session.appUserId, isOwner);
      return listJobMessages(tx, {
        jobId,
        viewerUserId: session.appUserId,
        viewerRole: viewerRoleFor(session, job.propertyId, isOwner),
        isOwner,
      });
    });

    return Response.json(
      thread.map((m) => ({
        id: m.id,
        sender: m.sender,
        body: m.body,
        created_at: m.createdAt,
      })),
    );
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    if (e instanceof MessageError) return messageErrorResponse(e);
    throw e;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession();
    const { id: jobId } = await params;
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return errorResponse("invalid_json", "Request body must be JSON.", 400);
    }
    const body = (payload as { body?: unknown } | null)?.body;
    const isOwner = session.memberships.some((m) => m.role === "owner");

    const message = await withUser(getDbApp(), session.appUserId, async (tx) => {
      const job = await assertCanMessage(tx, jobId, session.appUserId, isOwner);
      return postJobMessage(tx, {
        jobId,
        senderUserId: session.appUserId,
        senderRole: viewerRoleFor(session, job.propertyId, isOwner),
        isOwner,
        body,
      });
    });

    return Response.json(
      {
        message: {
          id: message.id,
          sender: message.sender,
          body: message.body,
          created_at: message.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    if (e instanceof MessageError) return messageErrorResponse(e);
    throw e;
  }
}
