/**
 * POST /api/jobs/:id/start — dispatcher starts a confirmed job.
 */
import { dispatcherAction } from "@/lib/job-routes";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return dispatcherAction(req, params, "in_progress");
}
