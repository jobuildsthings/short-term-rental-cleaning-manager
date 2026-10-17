/**
 * POST /api/jobs/:id/decline — dispatcher declines; the job returns to the
 * pool (status `declined`, assignment cleared) for the owner to reassign.
 * Optional {reason}.
 */
import { dispatcherAction } from "@/lib/job-routes";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return dispatcherAction(req, params, "declined");
}
