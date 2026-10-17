/** POST /api/dispatcher/jobs/:id/complete — in_progress → completed. */
import { transitionHandler } from "../_transition";

export const POST = transitionHandler("complete");
