/**
 * Shared "Cleanings" calendar sync (Workstream E).
 *
 * Calendar model (contracts §4.18–20, spec update 2026-10-17): the app
 * manages ONE dedicated calendar ("Cleanings") in the OWNER's Google
 * account, shared with the dispatcher's Google address as a reader. Only
 * the owner grants Calendar OAuth scope at sign-in; the dispatcher sees
 * everything through the share.
 *
 * Job lifecycle → calendar:
 *   created     → event created (title, date/time, address, CURRENT
 *                 access instructions in the description)
 *   rescheduled → event updated
 *   cancelled   → event deleted
 *   confirmed   → event updated to reflect confirmation
 * `google_event_id` is stored per job. All events use timeZone
 * America/Los_Angeles, always.
 *
 * Google API is called with plain fetch (no SDK dependency).
 * Refresh tokens are decrypted in memory only, never logged.
 */
import { and, eq, gt, isNotNull, ne } from "drizzle-orm";
import { decryptField } from "./crypto";
import { type Db } from "./db";
import { agencySettings, cleaningJobs, googleOauthTokens, memberships, properties, users } from "./schema";
import { APP_TIME_ZONE, formatDatePT, formatWallTimePT } from "./time";

const CALENDAR_NAME = "Cleanings";

export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new CalendarError(`${name} is not set`);
  return v;
}

async function gfetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 204) return null;
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!res.ok) {
    throw new CalendarError(
      `Google Calendar API ${res.status} on ${path}: ${body?.error?.message ?? "unknown"}`.slice(0, 300),
    );
  }
  return body;
}

/**
 * Exchange the owner's stored refresh token for a live access token.
 * Throws CalendarError if the owner hasn't granted calendar scope.
 */
export async function getOwnerAccessToken(admin: Db): Promise<string> {
  const owners = await admin
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.role, "owner"))
    .limit(1);
  const ownerId = owners[0]?.userId;
  if (!ownerId) throw new CalendarError("no owner user found");
  const toks = await admin
    .select()
    .from(googleOauthTokens)
    .where(eq(googleOauthTokens.userId, ownerId))
    .limit(1);
  const tok = toks[0];
  const refreshToken = tok?.refreshTokenEncrypted ? decryptField(tok.refreshTokenEncrypted) : null;
  if (!refreshToken || !(tok?.scope ?? "").includes("calendar")) {
    throw new CalendarError("owner has not granted Calendar scope — sign in again with calendar access");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: mustEnv("GOOGLE_CLIENT_ID"),
      client_secret: mustEnv("GOOGLE_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !body?.access_token) {
    throw new CalendarError(`token refresh failed: HTTP ${res.status}`);
  }
  return body.access_token;
}

async function getDispatcherEmail(admin: Db): Promise<string | null> {
  const rows = await admin
    .select({ email: users.email })
    .from(agencySettings)
    .innerJoin(users, eq(users.id, agencySettings.dispatcherUserId))
    .limit(1);
  return rows[0]?.email ?? null;
}

/**
 * Ensure the shared "Cleanings" calendar exists in the owner's account
 * and is shared with the dispatcher as a reader. Writes
 * agency_settings.google_calendar_id / google_calendar_shared.
 * Idempotent — safe to call on every worker pass.
 */
export async function ensureCleaningsCalendar(admin: Db): Promise<{
  calendarId: string;
  shared: boolean;
}> {
  const accessToken = await getOwnerAccessToken(admin);

  // Find (not deleted) or create.
  const list = (await gfetch(accessToken, "/calendar/v3/users/me/calendarList")) as {
    items?: { id?: string; summary?: string; deleted?: boolean }[];
  };
  let calendarId = list.items?.find((c) => c.summary === CALENDAR_NAME && !c.deleted)?.id;
  if (!calendarId) {
    const created = (await gfetch(accessToken, "/calendar/v3/calendars", {
      method: "POST",
      body: JSON.stringify({ summary: CALENDAR_NAME, timeZone: APP_TIME_ZONE }),
    })) as { id?: string };
    if (!created.id) throw new CalendarError("calendar creation returned no id");
    calendarId = created.id;
  }

  // Share with the dispatcher (reader). Best-effort idempotent.
  let shared = false;
  const dispatcherEmail = await getDispatcherEmail(admin);
  if (dispatcherEmail) {
    try {
      const acl = (await gfetch(
        accessToken,
        `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/acl`,
      )) as { items?: { scope?: { value?: string } }[] };
      const already = acl.items?.some(
        (r) => r.scope?.value?.toLowerCase() === dispatcherEmail.toLowerCase(),
      );
      if (!already) {
        await gfetch(accessToken, `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/acl`, {
          method: "POST",
          body: JSON.stringify({
            role: "reader",
            scope: { type: "user", value: dispatcherEmail },
          }),
        });
      }
      shared = true;
    } catch (e) {
      // Sharing failure is not fatal: the owner gets a manual share step
      // (contracts §4.20). Record the calendar id; shared stays false.
      console.error(
        JSON.stringify({ event: "calendar_share_failed", error: e instanceof Error ? e.message : "unknown" }),
      );
    }
  }

  const settings = await admin.select().from(agencySettings).limit(1);
  if (settings[0]) {
    await admin
      .update(agencySettings)
      .set({ googleCalendarId: calendarId, googleCalendarShared: shared })
      .where(eq(agencySettings.id, settings[0].id));
  }
  return { calendarId, shared };
}

// ---------------------------------------------------------------------------
// Event building (pure) + lifecycle sync
// ---------------------------------------------------------------------------

export interface CalendarJobView {
  id: string;
  title: string;
  status: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  googleEventId: string | null;
}

export interface CalendarPropertyView {
  name: string;
  listingAddress: string | null;
}

/** RFC3339 local wall time; Google interprets it in `timeZone`. */
function localDateTime(date: string, time: string): string {
  const t = time.length === 5 ? `${time}:00` : time;
  return `${date}T${t}`;
}

export interface CalendarEventInput {
  summary: string;
  location?: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
}

/**
 * Build the Calendar event for a job. Description carries the CURRENT
 * access instructions (contracts §5.6 — the calendar is shared only with
 * the dispatcher, who already gets them in every reminder).
 */
export function buildCalendarEvent(
  job: CalendarJobView,
  property: CalendarPropertyView,
  accessInstructions: string | null,
): CalendarEventInput {
  const when = `${formatDatePT(job.scheduledDate)} · ${formatWallTimePT(job.startTime)} – ${formatWallTimePT(job.endTime)}`;
  const confirmed = job.status === "confirmed" ? "Confirmed ✓" : `Status: ${job.status}`;
  const lines = [
    `${job.title}`,
    when,
    confirmed,
    ``,
    `Access instructions:`,
    accessInstructions ?? "No access instructions on file — check the app.",
  ];
  return {
    summary: `Cleaning — ${property.name}`,
    location: property.listingAddress ?? undefined,
    description: lines.join("\n"),
    start: { dateTime: localDateTime(job.scheduledDate, job.startTime), timeZone: APP_TIME_ZONE },
    end: { dateTime: localDateTime(job.scheduledDate, job.endTime), timeZone: APP_TIME_ZONE },
  };
}

/**
 * Sync one job to the shared calendar: create / update / delete per the
 * lifecycle. Stores google_event_id. No-op (with cleanup) when the
 * calendar isn't provisioned yet.
 */
export async function syncJobEvent(admin: Db, jobId: string): Promise<void> {
  const settings = await admin.select().from(agencySettings).limit(1);
  const calendarId = settings[0]?.googleCalendarId;
  if (!calendarId) return; // not provisioned — reconcile later

  const jobs = await admin
    .select()
    .from(cleaningJobs)
    .where(eq(cleaningJobs.id, jobId))
    .limit(1);
  const job = jobs[0];
  if (!job) return;
  const props = await admin
    .select()
    .from(properties)
    .where(eq(properties.id, job.propertyId))
    .limit(1);
  const property = props[0];
  if (!property) return;

  const accessToken = await getOwnerAccessToken(admin);
  const path = (suffix = "") =>
    `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${suffix}`;

  if (job.status === "cancelled") {
    if (job.googleEventId) {
      try {
        await gfetch(accessToken, path(`/${encodeURIComponent(job.googleEventId)}`), {
          method: "DELETE",
        });
      } catch {
        // Already gone server-side — treat as cleaned up.
        console.error(
          JSON.stringify({ event: "calendar_event_delete_failed", job_id: jobId }),
        );
      }
      await admin
        .update(cleaningJobs)
        .set({ googleEventId: null })
        .where(eq(cleaningJobs.id, jobId));
    }
    return;
  }

  const instructions = property.accessInstructions
    ? decryptField(property.accessInstructions)
    : null;
  const event = buildCalendarEvent(
    {
      id: job.id,
      title: job.title,
      status: job.status,
      scheduledDate: job.scheduledDate,
      startTime: job.startTime,
      endTime: job.endTime,
      googleEventId: job.googleEventId,
    },
    { name: property.name, listingAddress: property.listingAddress },
    instructions,
  );

  if (job.googleEventId) {
    await gfetch(accessToken, path(`/${encodeURIComponent(job.googleEventId)}`), {
      method: "PATCH",
      body: JSON.stringify(event),
    });
  } else {
    const created = (await gfetch(accessToken, path(), {
      method: "POST",
      body: JSON.stringify(event),
    })) as { id?: string };
    if (created.id) {
      await admin
        .update(cleaningJobs)
        .set({ googleEventId: created.id })
        .where(eq(cleaningJobs.id, jobId));
    }
  }
}

/**
 * Worker pass: ensure the calendar exists, then sync jobs changed since
 * `sinceIso` (plus any cancelled job still holding an event id).
 */
export async function reconcileCalendar(admin: Db, sinceIso: string): Promise<number> {
  const { calendarId } = await ensureCleaningsCalendar(admin);
  void calendarId;
  const jobs = await admin
    .select({ id: cleaningJobs.id })
    .from(cleaningJobs)
    .where(
      and(
        ne(cleaningJobs.status, "completed"),
        gt(cleaningJobs.updatedAt, sinceIso),
      ),
    );
  const staleCancels = await admin
    .select({ id: cleaningJobs.id })
    .from(cleaningJobs)
    .where(
      and(eq(cleaningJobs.status, "cancelled"), isNotNull(cleaningJobs.googleEventId)),
    );
  const ids = new Set([...jobs.map((j) => j.id), ...staleCancels.map((j) => j.id)]);
  let n = 0;
  for (const id of ids) {
    try {
      await syncJobEvent(admin, id);
      n++;
    } catch (e) {
      console.error(
        JSON.stringify({ event: "calendar_job_sync_failed", job_id: id, error: e instanceof Error ? e.message : "unknown" }),
      );
    }
  }
  return n;
}

export { APP_TIME_ZONE as CALENDAR_TIME_ZONE };
