/**
 * Scheduler worker entry point.
 *
 * Runs the scheduling engine on a loop: iCal feeds due for sync (hourly)
 * are fetched and applied; recurring series are re-expanded (idempotent,
 * self-healing). Uses the owner connection (DATABASE_URL): bypassing RLS
 * is allowed for the scheduler worker (see lib/db.ts).
 *
 * Usage: npm run scheduler
 * Runs forever until SIGTERM/SIGINT. Logs are JSON, one event per line —
 * and never include feed URLs (secrets).
 */
import { runSchedulerPass } from "../lib/scheduler";

const INTERVAL_MS = 15 * 60 * 1000; // check for due feeds every 15 minutes

async function main(): Promise<void> {
  console.log(JSON.stringify({ event: "scheduler_start" }));
  for (;;) {
    try {
      await runSchedulerPass();
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "scheduler_pass_failed",
          error: e instanceof Error ? e.message : "unknown",
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

process.on("SIGTERM", () => {
  console.log(JSON.stringify({ event: "scheduler_stop", signal: "SIGTERM" }));
  process.exit(0);
});
process.on("SIGINT", () => process.exit(0));

void main();
