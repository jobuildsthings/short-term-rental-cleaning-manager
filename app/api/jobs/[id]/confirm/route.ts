/**
 * POST /api/jobs/:id/confirm — dispatcher confirms an assigned job.
 * Workstream E: create the shared-calendar event here.
 */
import { dispatcherAction } from "@/lib/job-routes";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return dispatcherAction(req, params, "confirmed");
}
