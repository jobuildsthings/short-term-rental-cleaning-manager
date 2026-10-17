/**
 * POST /api/jobs/:id/complete — dispatcher marks a job complete.
 * Pending reminders are skipped (contracts §4 rule 15).
 */
import { dispatcherAction } from "@/lib/job-routes";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return dispatcherAction(req, params, "completed");
}
