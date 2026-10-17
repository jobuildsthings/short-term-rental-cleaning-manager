/**
 * GET /api/admin/recap/history — owner views past recap runs.
 *
 * Contracts §2. Metadata only (no bodies — bodies are never persisted).
 */
import { desc } from "drizzle-orm";
import { AuthError, authErrorResponse, requireOwner } from "@/lib/auth-helpers";
import { apiErrorResponse } from "@/lib/api";
import { getDbApp, withUser } from "@/lib/db";
import { recapRuns } from "@/lib/schema";

export async function GET() {
  try {
    const session = await requireOwner();
    const rows = await withUser(getDbApp(), session.appUserId, async (tx) =>
      tx
        .select({
          id: recapRuns.id,
          weekStarting: recapRuns.weekStarting,
          generatedAt: recapRuns.generatedAt,
          sentAt: recapRuns.sentAt,
          status: recapRuns.status,
        })
        .from(recapRuns)
        .orderBy(desc(recapRuns.weekStarting))
        .limit(52),
    );
    return Response.json(rows);
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e);
    return apiErrorResponse(e);
  }
}
