# Short-Term Rental Cleaning Manager

Self-owned web app for coordinating short-term rental cleanings with a cleaning-agency dispatcher.

- Automatic turnover scheduling from booking calendars (iCal)
- Manual and recurring jobs
- Reminders and a weekly recap for the dispatcher
- Per-job messaging

## Roles

- **Owner**: full access — properties, jobs, messages, settings, invites.
- **Dispatcher** (cleaning agency): assigned jobs, confirm/decline/complete, per-job messages.

## Docs

- `ARCHITECTURE.md` — system design
- `docs/decisions/` — one file per major decision
- `CONTRIBUTING.md` — how (human or agent) contributors work here

## Anonymity rule

This repo never contains brand names or real personal/agency names. Generic terms only: dispatcher, cleaning agency, owner, listing, rental platform, short-term rental. Real contact details are injected at deploy time, never committed.
