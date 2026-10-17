/**
 * Recurrence rule expansion (Workstream B).
 *
 * Supports the MVP frequencies (contracts §7 decision 14): weekly and
 * monthly. All arithmetic is on calendar dates (YYYY-MM-DD strings), so
 * daylight-saving transitions can never shift an occurrence to the wrong
 * weekday — a Wednesday series stays on Wednesdays across the DST change.
 *
 * rrule shape (contracts §1): {freq, interval, weekdays?, until?, count?}
 * - weekly: `weekdays` is an array of 0=Sunday..6=Saturday. Defaults to the
 *   weekday of dtstart when omitted.
 * - monthly: the day-of-month of dtstart, clamped to the month length
 *   (Jan 31 → Feb 28). `weekdays` is ignored for monthly.
 * - `until`: last allowed occurrence date, inclusive (YYYY-MM-DD).
 * - `count`: total occurrences counting from dtstart.
 * - `dtstart`: the series start date (YYYY-MM-DD). For app series this is
 *   the series' creation date — occurrences are never generated before it.
 */

export interface RruleInput {
  freq: "weekly" | "monthly";
  interval: number;
  weekdays?: number[];
  until?: string | null;
  count?: number | null;
  /**
   * Series start date (YYYY-MM-DD). Optional extension of the contracts'
   * rrule shape: the app sets it at creation (creation date, or the split
   * date for "this and following" splits). Defaults to the series'
   * creation date when absent.
   */
  dtstart?: string;
}

export type RruleValidation =
  | { ok: true; rrule: Required<Pick<RruleInput, "freq" | "interval">> & RruleInput }
  | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parts(ymd: string): [number, number, number] {
  const [y, m, d] = ymd.split("-").map(Number);
  return [y!, m!, d!];
}

function iso(y: number, m: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

/** 0=Sunday..6=Saturday for a calendar date. Noon construction avoids DST edges. */
export function weekdayOf(ymd: string): number {
  const [y, m, d] = parts(ymd);
  return new Date(y, m - 1, d, 12).getDay();
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = parts(ymd);
  const dt = new Date(y, m - 1, d, 12);
  dt.setDate(dt.getDate() + n);
  return iso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

/** Add months, clamping the day to the target month's length. */
export function addMonths(ymd: string, n: number): string {
  const [y, m, d] = parts(ymd);
  const total = (m - 1) + n;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12 + 1;
  return iso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function validateRrule(raw: unknown): RruleValidation {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "rrule must be an object" };
  }
  const r = raw as Record<string, unknown>;
  if (r["freq"] !== "weekly" && r["freq"] !== "monthly") {
    return { ok: false, error: "rrule.freq must be 'weekly' or 'monthly'" };
  }
  const interval = r["interval"];
  if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > 52) {
    return { ok: false, error: "rrule.interval must be an integer between 1 and 52" };
  }
  let weekdays: number[] | undefined;
  if (r["weekdays"] !== undefined) {
    if (
      !Array.isArray(r["weekdays"]) ||
      r["weekdays"].length === 0 ||
      !r["weekdays"].every((w) => Number.isInteger(w) && (w as number) >= 0 && (w as number) <= 6)
    ) {
      return { ok: false, error: "rrule.weekdays must be a non-empty array of 0-6" };
    }
    weekdays = [...(r["weekdays"] as number[])].sort((a, b) => a - b);
  }
  const until = r["until"];
  if (until !== undefined && until !== null && (typeof until !== "string" || !DATE_RE.test(until))) {
    return { ok: false, error: "rrule.until must be a YYYY-MM-DD date or null" };
  }
  const count = r["count"];
  if (
    count !== undefined &&
    count !== null &&
    (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 1000)
  ) {
    return { ok: false, error: "rrule.count must be an integer between 1 and 1000 or null" };
  }
  const dtstartRaw = r["dtstart"];
  if (
    dtstartRaw !== undefined &&
    (typeof dtstartRaw !== "string" || !DATE_RE.test(dtstartRaw))
  ) {
    return { ok: false, error: "rrule.dtstart must be a YYYY-MM-DD date" };
  }
  return {
    ok: true,
    rrule: {
      freq: r["freq"] as "weekly" | "monthly",
      interval,
      weekdays,
      until: (until as string | null | undefined) ?? null,
      count: (count as number | null | undefined) ?? null,
      ...(typeof dtstartRaw === "string" ? { dtstart: dtstartRaw } : {}),
    },
  };
}

/**
 * Expand occurrences in [from, to] (inclusive, YYYY-MM-DD).
 * `count`/`until` are honored relative to dtstart, so windowing the query
 * never changes which dates are generated.
 */
export function expandRrule(
  rrule: RruleInput,
  dtstart: string,
  from: string,
  to: string,
): string[] {
  if (!DATE_RE.test(dtstart) || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    return [];
  }
  const weekdays = rrule.weekdays ?? [weekdayOf(dtstart)];
  const until = rrule.until ?? null;
  const maxCount = rrule.count ?? null;
  const out: string[] = [];
  let produced = 0; // occurrences counted from dtstart (for `count`)

  // Dates are generated in ascending order starting at dtstart, so once a
  // candidate exceeds `to` (and `until`/`count` can't pull it back), we stop.
  const consider = (date: string): boolean => {
    if (until && date > until) return false;
    produced++;
    if (maxCount !== null && produced > maxCount) return false;
    if (date >= from && date <= to) out.push(date);
    return true;
  };

  if (rrule.freq === "weekly") {
    // Anchor on the Sunday starting dtstart's week; step by interval weeks.
    const weekStart = addDays(dtstart, -weekdayOf(dtstart));
    for (let w = 0; w < 5200; w++) {
      const base = addDays(weekStart, w * 7 * rrule.interval);
      if (base > to) break;
      for (const wd of weekdays) {
        const date = addDays(base, wd);
        if (date < dtstart) continue; // series hadn't started yet: not an occurrence
        if (!consider(date)) return out;
      }
      if (maxCount !== null && produced >= maxCount) break;
    }
  } else {
    const [sy, sm, sd] = parts(dtstart);
    for (let k = 0; k < 1200; k++) {
      const total = sm - 1 + k * rrule.interval;
      const ny = sy + Math.floor(total / 12);
      const nm = ((total % 12) + 12) % 12 + 1;
      const date = iso(ny, nm, Math.min(sd, daysInMonth(ny, nm)));
      if (date > to) break;
      if (!consider(date)) return out;
      if (maxCount !== null && produced >= maxCount) break;
    }
  }
  return out;
}
