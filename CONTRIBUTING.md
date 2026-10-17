# CONTRIBUTING — for human and AI contributors alike

## The one rule that gates every push

This repo is **brand-neutral and name-free**. Never write these words in any
file, comment, or commit message: the paid service's name, short-term rental
platform brand names, or any real agency/person name. Generic terms only:
`dispatcher`, `cleaning agency`, `owner`, `listing`, `rental platform`,
`short-term rental`. (The ordinary word "turnover" is fine.)

CI runs a brand-name grep gate over the tree on every push — a hit fails the
build. (The pattern is written self-excluding in the workflow so it can't
match itself.) Run it yourself before pushing.

## Branches and PRs

- Branch naming: `<workstream>-<short-name>`, e.g. `a-foundation`,
  `b-scheduling`, `c-host-ui`. One workstream per branch.
- Open a PR to `main` for architect review. **Never merge your own PR.**
- PR checklist (paste into the PR body and check each):
  - [ ] `npm run verify` passes (lint + typecheck + tests)
  - [ ] New/changed API routes follow the error shape `{error: {code, message}}`
  - [ ] Every new query runs inside `withUser()` — no unscoped reads
  - [ ] No secrets, tokens, URLs, or personal data in code or fixtures
  - [ ] Banned-words grep gate is clean
  - [ ] Docs updated if behavior changed (`README.md` / `ARCHITECTURE.md`)

## How to work here

```bash
npm install
cp .env.example .env        # fill in; see README.md
docker compose up -d
npm run db:migrate
npm run db:seed             # demo data only — obviously fake values
npm run dev
```

## Seed data

`npm run db:seed` creates: one owner, one demo property, one dispatcher
user + membership + agency settings, one **pending** dispatcher invite
(exercise the invite flow at `/invite/<token>`), one sample turnover job,
and one weekly Wednesday recurring series with a generated instance.
Re-run with `--force` to reseed. All values are fake (`@example.com`,
`+1555…`, "Demo …") — never put real names, numbers, or codes in seed.

## How to verify your work

```bash
npm run verify
```

- `tests/crypto.test.ts` — encryption round-trip, tamper and wrong-key rejection
- `tests/transitions.test.ts` — job status state machine + role rules
- `tests/permissions.test.ts` — **the important one**: spins up real
  Postgres (PGlite, RLS included), applies the actual migrations, then
  queries as the least-privilege `app` role. If you add a table, add it to
  the RLS migration **and** add a test proving the scoping.
- Adding a migration? Name it `NNNN_description.sql`, add the
  `--> statement-breakpoint` separators, and register it in
  `drizzle/meta/_journal.json` (copy the existing entry shape).

## Timezone discipline

Everything is **America/Los_Angeles, always**. Use `lib/time.ts`
(`formatDatePT`, `formatWallTimePT`, `formatDateTimePT`). Never format a
time without an explicit `timeZone: "America/Los_Angeles"`, and never trust
the browser/device local zone.

## Secrets discipline

- Real values live in `.env` (gitignored) — never in code, fixtures, or docs.
- Access-instruction values and OAuth refresh tokens: encrypted at rest
  (`lib/crypto.ts`), decrypted only in memory at the point of use, never
  logged. Audit metadata must never contain them.
- iCal feed URLs: never logged, never exposed to the dispatcher role.
