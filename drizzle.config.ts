import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Only used for `db:generate`; migrations run against DATABASE_URL.
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/strcleaning",
  },
});
