/**
 * Applies pending drizzle migrations. Uses the owner connection
 * (DATABASE_URL) — migrations create tables, the `app` role, grants,
 * and RLS policies, so they must run with full privileges.
 *
 * Usage: npm run db:migrate
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set — see .env.example");
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  // gen_random_uuid() defaults need pgcrypto before the first migration runs.
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
