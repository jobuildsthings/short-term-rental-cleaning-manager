/** POST /api/dispatcher/jobs/:id/decline — assigned → declined → scheduled (back to pool). */
import { transitionHandler } from "../_transition";

export const POST = transitionHandler("decline");
