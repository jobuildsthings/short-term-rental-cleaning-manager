/** POST /api/dispatcher/jobs/:id/start — confirmed → in_progress. */
import { transitionHandler } from "../_transition";

export const POST = transitionHandler("start");
