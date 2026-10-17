/**
 * iCal parsing tests (Workstream B).
 *
 * Booking-platform feeds come in three date flavors (all-day DATE, UTC
 * DATE-TIME, TZID-qualified); all must land on the right property-local
 * calendar date. Feed URLs never appear in errors — asserted here too.
 */
import { describe, expect, it } from "vitest";
import { fetchIcalFeed, parseIcs } from "../lib/ical";

const TZ = "America/Los_Angeles";

function vevent(lines: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

describe("parseIcs", () => {
  it("parses all-day DATE values as-is", () => {
    const { events, skipped } = parseIcs(
      vevent([
        "UID:abc-123",
        "DTSTART;VALUE=DATE:20261020",
        "DTEND;VALUE=DATE:20261025",
        "SUMMARY:Smith Family",
      ]),
      TZ,
    );
    expect(skipped).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid: "abc-123",
      summary: "Smith Family",
      checkIn: "2026-10-20",
      checkOut: "2026-10-25",
      cancelled: false,
    });
  });

  it("places UTC DATE-TIME values on the property-local date", () => {
    // 2026-10-20T06:00Z is Oct 19, 11pm in Los Angeles (PDT).
    const { events } = parseIcs(
      vevent([
        "UID:utc-1",
        "DTSTART:20261020T060000Z",
        "DTEND:20261025T060000Z",
      ]),
      TZ,
    );
    expect(events[0]).toMatchObject({ checkIn: "2026-10-19", checkOut: "2026-10-24" });
  });

  it("takes the calendar date from TZID-qualified wall times", () => {
    const { events } = parseIcs(
      vevent([
        "UID:tz-1",
        "DTSTART;TZID=America/Los_Angeles:20261020T150000",
        "DTEND;TZID=America/Los_Angeles:20261025T110000",
      ]),
      TZ,
    );
    expect(events[0]).toMatchObject({ checkIn: "2026-10-20", checkOut: "2026-10-25" });
  });

  it("unfolds folded lines and unescapes text", () => {
    const { events } = parseIcs(
      vevent([
        "UID:fold-1",
        "DTSTART;VALUE=DATE:20261020",
        "DTEND;VALUE=DATE:20261021",
        "SUMMARY:O\\'Brien\\, Jane and family with a very long name that ",
        " continues on the next line",
      ]),
      TZ,
    );
    expect(events[0]!.summary).toBe("O\\'Brien, Jane and family with a very long name that continues on the next line");
  });

  it("marks STATUS:CANCELLED events", () => {
    const { events } = parseIcs(
      vevent([
        "UID:cx-1",
        "DTSTART;VALUE=DATE:20261020",
        "DTEND;VALUE=DATE:20261021",
        "STATUS:CANCELLED",
      ]),
      TZ,
    );
    expect(events[0]!.cancelled).toBe(true);
  });

  it("skips events with missing or invalid dates", () => {
    const { events, skipped } = parseIcs(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "DTSTART;VALUE=DATE:20261020",
        "DTEND;VALUE=DATE:20261021",
        "END:VEVENT", // no UID
        "BEGIN:VEVENT",
        "UID:bad-dates",
        "DTSTART;VALUE=DATE:20261025",
        "DTEND;VALUE=DATE:20261020", // checkout before checkin
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:good",
        "DTSTART;VALUE=DATE:20261020",
        "DTEND;VALUE=DATE:20261021",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
      TZ,
    );
    expect(skipped).toBe(2);
    expect(events.map((e) => e.uid)).toEqual(["good"]);
  });

  it("handles multiple events in one feed", () => {
    const { events } = parseIcs(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:e1",
        "DTSTART;VALUE=DATE:20261020",
        "DTEND;VALUE=DATE:20261022",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:e2",
        "DTSTART;VALUE=DATE:20261022",
        "DTEND;VALUE=DATE:20261025",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
      TZ,
    );
    expect(events).toHaveLength(2);
  });
});

describe("fetchIcalFeed", () => {
  it("rejects non-calendar responses without leaking the URL", async () => {
    const url = "https://secret-feed-host.example.com/private/calendar.ics?token=abc123";
    await expect(fetchIcalFeed("http://127.0.0.1:9/unreachable", 500)).rejects.toThrow(
      /feed fetch failed/,
    );
    // The URL (with its secret token) must not appear in the error.
    try {
      await fetchIcalFeed(url, 500);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-feed-host");
      expect((e as Error).message).not.toContain("abc123");
    }
  });
});
