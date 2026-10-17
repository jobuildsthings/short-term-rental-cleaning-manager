/**
 * Database clients.
 *
 * TWO connections, two trust levels — this is the heart of the
 * database-level permission model:
 *
 * - `getDbApp()`  → APP_DATABASE_URL → role `app` (least privilege, owns
 *   nothing). Row-Level Security applies to EVERY query. Request code must
 *   wrap all queries in withUser(userId): without SET LOCAL app.user_id,
 *   every policy denies (fail-closed).
 *
 * - `getDbAdmin()` → DATABASE_URL → the migrator/owner role. Bypasses RLS.
 *   Allowed ONLY for: migrations, seed, invite acceptance (public token
 *   flow), the scheduler worker, and OAuth token bookkeeping in auth.ts.
 *   Never in request handlers that serve user data.
 *
 * Deploy note: docker-compose creates role `app`; set APP_DATABASE_URL to
 * its connection string. See README.md.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} must be set. Copy .env.example to .env — see README.md.`,
    );
  }
  return v;
}

let appDb: Db | null = null;
let adminDb: Db | null = null;

/** Least-privilege client. RLS enforced. Use inside withUser(). */
export function getDbApp(): Db {
  if (!appDb) {
    appDb = drizzlePg(new Pool({ connectionString: mustEnv("APP_DATABASE_URL") }), {
      schema,
    });
  }
  return appDb;
}

/**
 * Owner client. BYPASSES RLS — restricted to migrations, seed, invite
 * acceptance, scheduler worker, and OAuth token bookkeeping. Document the
 * reason at every call site.
 */
export function getDbAdmin(): Db {
  if (!adminDb) {
    adminDb = drizzlePg(new Pool({ connectionString: mustEnv("DATABASE_URL") }), {
      schema,
    });
  }
  return adminDb;
}

/**
 * Run `fn` with Row-Level Security scoped to `userId`.
 * Opens a transaction and sets a transaction-local user id that the RLS
 * policies read via app_user_id(). Every request handler MUST use this.
 */
export async function withUser<T>(
  db: Pick<Db, "transaction">,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx as Tx);
  });
}
