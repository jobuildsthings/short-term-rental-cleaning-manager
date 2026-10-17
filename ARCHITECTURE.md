# ARCHITECTURE

## Why this exists

Replace a paid cleaning-coordination subscription with a reliable,
self-owned web app the owner and a cleaning-agency dispatcher use every
week. A missed cleaning is a failed guest stay — so reliability (no silent
failures, idempotent scheduling, audit log) outranks feature breadth.

## System shape

```
Browser (owner + dispatcher, mobile-first)
   │  Google OAuth (Auth.js v5, JWT sessions)
   ▼
Next.js App Router ──► Postgres 16 (Drizzle ORM)
   │                      ▲ RLS policies enforce the permission matrix
   │                      │ for EVERY query from the app role
   ▼
Background workers (Workstream B/E): iCal sync, reminder + recap sends,
calendar sync — run with the owner connection, audited like everything else
```

No vendor lock-in by design: plain Postgres + Drizzle, deployable to a VPS
(Docker) or any managed Postgres. No free-tier-only services.

## Authentication

- Google OAuth only. No passwords, no public sign-up.
- **Two provider instances** (spec update 2026-10-17, shared-calendar model):
  - `google-owner` — requests `https://www.googleapis.com/auth/calendar`
    (offline). The owner signs in via `/signin`; this single consent
    connects her Google account.
  - `google` — identity only (`openid email profile`). The dispatcher
    signs in via `/invite/[token]`; no calendar scope on her side.
- Invite-only admission (`auth.ts` `signIn` callback): admitted iff the
  Google identity maps to an existing active user, matches
  `BOOTSTRAP_OWNER_EMAIL` while `users` is empty (first-run owner), or has
  a valid pending invite for its email.
- Invite flow: owner `POST /api/invites` → single-use 7-day token →
  `/invite/[token]` → Google sign-in → `POST /api/auth/accept-invite`
  creates user + memberships in one admin transaction → client refreshes
  the session so memberships land in the JWT.
- Google refresh tokens are stored encrypted (`google_oauth_tokens`,
  AES-256-GCM via `lib/crypto.ts`), never logged. The actual Calendar
  event create/update/delete is Workstream E; foundation only stores
  tokens and exposes `GET /api/integrations/google/status`.

## Authorization: two layers

1. **Route layer** (`lib/auth-helpers.ts`): `requireSession()` /
   `requireOwner()` throw typed `AuthError`s → 401/403 JSON.
   Fine-grained transition rules live in `lib/job-transitions.ts`
   (the job status state machine).
2. **Database layer** (the backstop): every request query runs inside
   `withUser(userId)` (`lib/db.ts`), which opens a transaction and sets
   `app.user_id` transaction-locally. Postgres RLS policies
   (`drizzle/0001_rls_policies.sql`) then enforce the contracts §3 matrix
   for the least-privilege `app` role:
   - owner: everything (via `app_is_owner()`)
   - dispatcher: assigned properties' jobs/messages/checklists only;
     no invites, feed URLs, instruction history, audit, reminders, settings
   - without `withUser`, `app_user_id()` is NULL and every policy denies
     (fail-closed).

The owner connection (`DATABASE_URL`) bypasses RLS and is restricted to:
migrations, seed, invite acceptance, the scheduler worker, and OAuth token
bookkeeping. Each call site documents why.

## Data

- Schema: `lib/schema.ts` mirrors frozen contracts §1 (15 tables) plus
  two foundation additions the API contracts required: `invites`
  (single-use 7-day tokens) and `google_oauth_tokens` (encrypted refresh
  tokens). `agency_settings` also carries `google_calendar_id` /
  `google_calendar_shared`, provisioned by Workstream E.
- Migrations: `drizzle/0000` (tables), `0001` (RLS), `0002` (calendar cols).
- All ids are server-generated UUIDs. No soft deletes. `audit_log` is
  append-only and must never contain instruction values, feed URLs, or
  message bodies.

## Secrets and sensitive data

- Access instructions (door codes): AES-256-GCM at the application layer
  (`ACCESS_INSTRUCTIONS_KEY`), decrypted only in memory at render time.
  Never in logs, errors, audit metadata, or stored reminder bodies
  (bodies are rendered at send time from current values).
- iCal feed URLs: treated as secrets, never logged or exposed to the dispatcher.
- `.env.example` documents every variable; real values never enter git.

## Time

`APP_TIME_ZONE = America/Los_Angeles`, always. Storage: `timestamptz` for
instants, `date`+`time` wall-clock for job times (interpreted in PT).
Display: `lib/time.ts` with explicit `timeZone`. Calendar events are
created with `timeZone: America/Los_Angeles`.

## Where the other workstreams plug in

- **B (scheduling):** iCal fetch/parse, turnover derivation, recurrence
  expansion, `POST /api/jobs` + transitions — reuse `lib/job-transitions.ts`
  and `withUser`.
- **C (host UI):** builds on `/api/*`; keep PT formatting via `lib/time.ts`.
- **D (dispatcher view):** mobile-first pages on the same routes.
- **E (notifications/calendar):** reminder scheduler, Resend email, SMS via
  the owner's paired phone, Google Calendar create/share/sync using the
  stored owner tokens + `agency_settings.google_calendar_id`.
- **F (QA):** `npm run verify` must stay green; extend `tests/`.
