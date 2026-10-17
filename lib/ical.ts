/**
 * iCal feed fetching and parsing (Workstream B).
 *
 * Booking platforms expose reservations as iCal (ICS) feeds: one VEVENT per
 * stay, DTSTART = check-in, DTEND = check-out. Feeds are usually all-day
 * DATE values, but some platforms send DATE-TIME (UTC or TZID-qualified),
 * so all three forms are handled and normalized to YYYY-MM-DD dates in the
 * property timezone.
 *
 * SECURITY: feed URLs are secrets. They must never appear in logs, errors,
 * or audit metadata — every error message here is URL-free by construction.
 */

export interface ParsedIcalEvent {
  uid: string;
  /** Guest name when the feed puts it in SUMMARY; null otherwise. */
  summary: string | null;
  /** YYYY-MM-DD in the property timezone. */
  checkIn: string;
  /** YYYY-MM-DD in the property timezone. */
  checkOut: string;
  /** True when the VEVENT carries STATUS:CANCELLED. */
  cancelled: boolean;
}

export interface ParsedFeed {
  events: ParsedIcalEvent[];
  /** VEVENTs skipped (missing UID/DSTART/DEND or unparseable dates). */
  skipped: number;
}

/** Fetch a feed URL. Throws URL-free errors on failure. */
export async function fetchIcalFeed(url: string, timeoutMs = 20000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "str-cleaning-manager/1.0 (+ical-sync)",
        Accept: "text/calendar,text/plain,*/*",
      },
    });
    if (!res.ok) {
      throw new Error(`feed fetch failed: HTTP ${res.status}`);
    }
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) {
      throw new Error("feed fetch failed: response is not a VCALENDAR document");
    }
    return text;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error("feed fetch failed: timed out");
    }
    // Network/DNS/TLS failures: uniform URL-free message.
    throw new Error("feed fetch failed: network error");
  } finally {
    clearTimeout(timer);
  }
}

interface IcalProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfoldLines(ics: string): string[] {
  const out: string[] = [];
  for (const raw of ics.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
    } else if (raw.length > 0) {
      out.push(raw);
    }
  }
  return out;
}

function parseProp(line: string): IcalProp {
  const colon = line.indexOf(":");
  const head = colon >= 0 ? line.slice(0, colon) : line;
  const value = colon >= 0 ? line.slice(colon + 1) : "";
  const segments = head.split(";");
  const params: Record<string, string> = {};
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf("=");
    if (eq >= 0) {
      params[seg.slice(0, eq).toUpperCase()] = seg
        .slice(eq + 1)
        .replace(/^"|"$/g, "");
    }
  }
  return { name: segments[0]!.toUpperCase(), params, value };
}

/** YYYY-MM-DD for an instant, in the given IANA zone. */
export function ymdInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Normalize a DTSTART/DTEND value to YYYY-MM-DD in `timeZone`.
 * Returns null when the value is unparseable.
 */
function dateValueToYmd(prop: IcalProp, timeZone: string): string | null {
  const v = prop.value.trim();
  if (prop.params["VALUE"] === "DATE") {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, s, z] = m;
  if (z === "Z") {
    const instant = new Date(
      Date.UTC(Number(Y), Number(Mo) - 1, Number(D), Number(h), Number(mi), Number(s)),
    );
    return ymdInTimeZone(instant, timeZone);
  }
  // TZID-qualified or floating wall time: the calendar date is the date part.
  // (Booking feeds express these in property-local time.)
  return `${Y}-${Mo}-${D}`;
}

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/**
 * Parse VEVENTs out of an ICS document. `timeZone` is the property timezone
 * (IANA name), used to place DATE-TIME values on the right calendar date.
 */
export function parseIcs(ics: string, timeZone: string): ParsedFeed {
  const events: ParsedIcalEvent[] = [];
  let skipped = 0;
  let inEvent = false;
  let props: IcalProp[] = [];

  const flush = () => {
    if (!inEvent) return;
    inEvent = false;
    const byName = new Map<string, IcalProp>();
    for (const p of props) {
      if (!byName.has(p.name)) byName.set(p.name, p);
    }
    props = [];
    const uid = byName.get("UID")?.value.trim();
    const dtstart = byName.get("DTSTART");
    const dtend = byName.get("DTEND");
    if (!uid || !dtstart || !dtend) {
      skipped++;
      return;
    }
    const checkIn = dateValueToYmd(dtstart, timeZone);
    const checkOut = dateValueToYmd(dtend, timeZone);
    if (!checkIn || !checkOut || checkOut <= checkIn) {
      skipped++;
      return;
    }
    const status = byName.get("STATUS")?.value.trim().toUpperCase();
    const summary = byName.get("SUMMARY")?.value.trim();
    events.push({
      uid,
      summary: summary ? unescapeText(summary) : null,
      checkIn,
      checkOut,
      cancelled: status === "CANCELLED",
    });
  };

  for (const line of unfoldLines(ics)) {
    const prop = parseProp(line);
    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VEVENT") {
      inEvent = true;
      props = [];
    } else if (prop.name === "END" && prop.value.toUpperCase() === "VEVENT") {
      flush();
    } else if (inEvent) {
      props.push(prop);
    }
  }
  // A truncated document may leave an event unclosed; don't trust it.
  return { events, skipped };
}
