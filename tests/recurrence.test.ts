/**
 * Recurrence expansion tests (Workstream B).
 *
 * The DST test is the critical one: a Wednesday series must stay on
 * Wednesdays across the November 1, 2026 fall-back in America/Los_Angeles.
 * Pure calendar-date arithmetic makes this hold by construction.
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  expandRrule,
  validateRrule,
  weekdayOf,
} from "../lib/recurrence";

describe("validateRrule", () => {
  it("accepts a valid weekly rule", () => {
    const v = validateRrule({ freq: "weekly", interval: 1, weekdays: [3] });
    expect(v.ok).toBe(true);
  });

  it("rejects bad frequencies, intervals, and weekdays", () => {
    expect(validateRrule({ freq: "daily", interval: 1 }).ok).toBe(false);
    expect(validateRrule({ freq: "weekly", interval: 0 }).ok).toBe(false);
    expect(validateRrule({ freq: "weekly", interval: 1, weekdays: [7] }).ok).toBe(false);
    expect(validateRrule({ freq: "weekly", interval: 1, weekdays: [] }).ok).toBe(false);
    expect(validateRrule(null).ok).toBe(false);
  });

  it("rejects bad until/count", () => {
    expect(validateRrule({ freq: "weekly", interval: 1, until: "next friday" }).ok).toBe(false);
    expect(validateRrule({ freq: "weekly", interval: 1, count: 0 }).ok).toBe(false);
  });
});

describe("expandRrule weekly", () => {
  it("expands every Wednesday from dtstart", () => {
    // 2026-10-21 is a Wednesday.
    const dates = expandRrule(
      { freq: "weekly", interval: 1, weekdays: [3] },
      "2026-10-21",
      "2026-10-21",
      "2026-11-30",
    );
    expect(dates.length).toBeGreaterThan(3);
    expect(dates[0]).toBe("2026-10-21");
    for (const d of dates) expect(weekdayOf(d)).toBe(3);
    // Consecutive Wednesdays, 7 days apart.
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]).toBe(addDays(dates[i - 1]!, 7));
    }
  });

  it("stays on the right weekday across the DST fall-back", () => {
    // DST ends Nov 1, 2026 in America/Los_Angeles.
    const dates = expandRrule(
      { freq: "weekly", interval: 1, weekdays: [3] },
      "2026-10-21",
      "2026-10-28",
      "2026-11-11",
    );
    expect(dates).toEqual(["2026-10-28", "2026-11-04", "2026-11-11"]);
  });

  it("supports biweekly intervals and multiple weekdays", () => {
    const dates = expandRrule(
      { freq: "weekly", interval: 2, weekdays: [1, 4] },
      "2026-10-19", // a Monday
      "2026-10-19",
      "2026-11-30",
    );
    // Oct 19 (Mon), Oct 22 (Thu), then skip a week: Nov 2, Nov 5, ...
    expect(dates.slice(0, 4)).toEqual(["2026-10-19", "2026-10-22", "2026-11-02", "2026-11-05"]);
  });

  it("honors count from dtstart regardless of the window", () => {
    const rule = { freq: "weekly" as const, interval: 1, weekdays: [3], count: 3 };
    const wide = expandRrule(rule, "2026-10-21", "2026-01-01", "2027-12-31");
    expect(wide).toEqual(["2026-10-21", "2026-10-28", "2026-11-04"]);
    // A window starting later still yields the same absolute dates.
    const narrow = expandRrule(rule, "2026-10-21", "2026-10-28", "2027-12-31");
    expect(narrow).toEqual(["2026-10-28", "2026-11-04"]);
  });

  it("honors until (inclusive)", () => {
    const dates = expandRrule(
      { freq: "weekly", interval: 1, weekdays: [3], until: "2026-11-04" },
      "2026-10-21",
      "2026-10-21",
      "2026-12-31",
    );
    expect(dates).toEqual(["2026-10-21", "2026-10-28", "2026-11-04"]);
  });

  it("defaults to the dtstart weekday when weekdays is omitted", () => {
    const dates = expandRrule(
      { freq: "weekly", interval: 1 },
      "2026-10-22", // Thursday
      "2026-10-22",
      "2026-11-05",
    );
    expect(dates).toEqual(["2026-10-22", "2026-10-29", "2026-11-05"]);
  });
});

describe("expandRrule monthly", () => {
  it("repeats on the same month-day", () => {
    const dates = expandRrule(
      { freq: "monthly", interval: 1 },
      "2026-10-15",
      "2026-10-15",
      "2027-01-31",
    );
    expect(dates).toEqual(["2026-10-15", "2026-11-15", "2026-12-15", "2027-01-15"]);
  });

  it("clamps month-end dates to short months", () => {
    const dates = expandRrule(
      { freq: "monthly", interval: 1 },
      "2026-01-31",
      "2026-01-31",
      "2026-04-30",
    );
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("supports every-N-months intervals", () => {
    const dates = expandRrule(
      { freq: "monthly", interval: 3 },
      "2026-01-10",
      "2026-01-10",
      "2026-12-31",
    );
    expect(dates).toEqual(["2026-01-10", "2026-04-10", "2026-07-10", "2026-10-10"]);
  });
});

describe("date helpers", () => {
  it("addMonths clamps correctly", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29"); // leap year
    expect(addMonths("2026-10-15", 3)).toBe("2027-01-15");
  });
});
