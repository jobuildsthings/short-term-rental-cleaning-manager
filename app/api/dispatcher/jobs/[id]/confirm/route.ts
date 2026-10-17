/** POST /api/dispatcher/jobs/:id/confirm — assigned → confirmed. */
import { transitionHandler } from "../_transition";

export const POST = transitionHandler("confirm");
