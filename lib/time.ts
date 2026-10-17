/**
 * Time formatting — America/Los_Angeles ALWAYS.
 *
 * Binding rule: every time displayed anywhere in the UI or rendered into
 * emails/texts/calendar events MUST be formatted explicitly in
 * America/Los_Angeles, regardless of the viewer's device timezone or
 * physical location. Never call toLocaleString()/toLocaleDateString()/
 * toLocaleTimeString() without { timeZone: APP_TIME_ZONE }, and never rely
 * on the browser's local zone.
 *
 * Job times are stored as date + time wall-clock values interpreted in
 * America/Los_Angeles (see schema). These helpers render them; the
 * " PT" suffix makes the zone explicit to the reader.
 */
export const APP_TIME_ZONE = "America/Los_Angeles";

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", { timeZone: APP_TIME_ZONE, ...options });
}

/** "Sat, Oct 18, 2026" — YYYY-MM-DD strings are interpreted as PT calendar dates. */
export function formatDatePT(d: Date | string): string {
  const date =
    typeof d === "string"
      ? /^\d{4}-\d{2}-\d{2}$/.test(d)
        ? zonedDateTime(d, "12:00") // noon PT: unambiguous, DST-safe
        : new Date(d)
      : d;
  return formatter({ weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date);
}

/**
 * Format a wall-clock "HH:MM(:SS)" time directly as PT — no zone conversion.
 * Use this for job start/end times, which are stored as PT wall-clock.
 */
export function formatWallTimePT(timeStr: string): string {
  const [h = "0", m = "0"] = timeStr.split(":");
  const hour = Number(h);
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m.padStart(2, "0")} ${ampm} PT`;
}

/** "11:00 AM PT" */
export function formatTimePT(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return `${formatter({ hour: "numeric", minute: "2-digit", hour12: true }).format(date)} PT`;
}

/** "Sat, Oct 18, 2026 · 11:00 AM PT" */
export function formatDateTimePT(d: Date | string): string {
  return `${formatDatePT(d)} · ${formatTimePT(d)}`;
}

/**
 * Combine a YYYY-MM-DD date and an HH:MM(:SS) wall-clock time into a Date
 * representing that wall-clock moment in America/Los_Angeles, for use when
 * an absolute instant is needed (e.g. computing reminder send times).
 * Implemented via the Intl API so DST transitions are handled by the
 * platform tz database.
 */
export function zonedDateTime(dateStr: string, timeStr: string): Date {
  // Interpret wall-clock in APP_TIME_ZONE by round-tripping through a formatter.
  const asUtcGuess = new Date(`${dateStr}T${timeStr.length === 5 ? timeStr + ":00" : timeStr}Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(asUtcGuess);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const asZoned = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")),
    Number(get("minute")),
    Number(get("second")),
  );
  const diff = asZoned - asUtcGuess.getTime();
  return new Date(asUtcGuess.getTime() - diff);
}
