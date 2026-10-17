# Cleaning Manager

Self-owned cleaning coordination for a short-term rental: booking calendars
sync in, turnover jobs generate automatically, the cleaning-agency dispatcher
confirms and completes them, reminders go out by text and email, and a
Saturday recap keeps everyone aligned. No subscriptions, no usage tiers.

> **Brand-neutral repo.** Never write brand names (short-term rental
> platforms), the paid service's name, or any real agency/person name in
> this repo — code, comments, docs, or commit messages. Generic terms only:
> `dispatcher`, `cleaning agency`, `owner`, `listing`, `rental platform`,
> `short-term rental`. CI enforces this with a grep gate.

## Stack

- Next.js 15 (App Router) + TypeScript + Tailwind CSS v4
- Postgres 16 + Drizzle ORM, migrations in `drizzle/`
- Auth.js v5 — Google OAuth only, invite-only (no public sign-up)
- Permissions enforced **in the database** (Postgres Row-Level Security),
  not just in app code — see `ARCHITECTURE.md`
- Tests: Vitest + PGlite (real Postgres in-process, RLS included)

## Setup (under 30 minutes)

### 1. Prerequisites

- Node 20+, npm
- Docker (for the local Postgres) — or any Postgres 16 you can reach
- A Google Cloud OAuth client (https://console.cloud.google.com/apis/credentials)
  - Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`

### 2. Install and configure

```bash
npm install
cp .env.example .env
# fill in .env (see comments in the file)
docker compose up -d
```

Required env vars:

| Var | What |
|---|---|
| `DATABASE_URL` | Owner connection (migrations, seed). `postgres://postgres:postgres@localhost:5432/strcleaning` |
| `APP_DATABASE_URL` | Least-privilege `app` role. `postgres://app:app@localhost:5432/strcleaning` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `ACCESS_INSTRUCTIONS_KEY` | `openssl rand -hex 32` — encrypts door codes + OAuth tokens |
| `BOOTSTRAP_OWNER_EMAIL` | Email allowed to create the first owner account (unset after) |

The `app` role is created by `docker-entrypoint-initdb.d`? No — migration
`0001` creates role `app` (NOLOGIN-safe `IF NOT EXISTS`) and grants it
least-privilege access. For local dev the role needs a login password;
`docker-compose.yml` mounts `docker/init-roles.sh` which sets it from
`APP_DB_PASSWORD` (default `app`, dev only).

### 3. Migrate, seed, run

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

Open http://localhost:3000. The bootstrap email signs in at `/signin`
(requests Calendar scope — this connects the owner's Google account).
The dispatcher is invited from the owner UI (API for now) and signs in via
`/invite/<token>` (identity only — no calendar scope needed; she sees
cleanings through the shared calendar Workstream E provisions).

### 4. Verify

```bash
npm run verify   # lint + typecheck + tests (includes RLS permission tests)
```

## Scripts

| Script | What |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run db:migrate` | Apply drizzle migrations (`scripts/migrate.ts`) |
| `npm run db:seed` | Demo data (clearly fake values only) |
| `npm run verify` | `lint` + `typecheck` + `test` |

## Project layout

```
app/                 Next.js routes: pages + /api/*
  api/               REST API (see ARCHITECTURE.md for the route list)
lib/                 db clients, Drizzle schema, auth helpers, crypto, time
drizzle/             SQL migrations (0000 schema, 0001 RLS, 0002 calendar cols)
scripts/             migrate.ts, seed.ts
tests/               Vitest: unit + PGlite RLS integration tests
docs/decisions/      One file per major decision (why, when, exact wording)
```

## Timezone

Everything is **America/Los_Angeles, always** — regardless of device or
user location. Use `lib/time.ts` (`formatDatePT`, `formatWallTimePT`, …);
never format a time without an explicit `timeZone: "America/Los_Angeles"`.
