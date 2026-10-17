import { describe, expect, it } from "vitest";
import { allowedTransitions, canTransition, isTerminal } from "../lib/job-transitions";

describe("job status state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("draft", "scheduled", "owner")).toBe(true);
    expect(canTransition("scheduled", "assigned", "owner")).toBe(true);
    expect(canTransition("assigned", "confirmed", "dispatcher")).toBe(true);
    expect(canTransition("confirmed", "in_progress", "dispatcher")).toBe(true);
    expect(canTransition("in_progress", "completed", "dispatcher")).toBe(true);
  });

  it("handles decline → back to pool", () => {
    expect(canTransition("assigned", "declined", "dispatcher")).toBe(true);
    expect(canTransition("declined", "scheduled", "owner")).toBe(true);
    expect(canTransition("declined", "confirmed", "dispatcher")).toBe(false);
  });

  it("restricts roles per transition", () => {
    // Dispatcher cannot drive owner-side transitions and vice versa.
    expect(canTransition("draft", "scheduled", "dispatcher")).toBe(false);
    expect(canTransition("assigned", "confirmed", "owner")).toBe(false);
    expect(canTransition("confirmed", "in_progress", "owner")).toBe(false);
  });

  it("rejects skips and backwards moves", () => {
    expect(canTransition("draft", "confirmed", "owner")).toBe(false);
    expect(canTransition("scheduled", "completed", "dispatcher")).toBe(false);
    expect(canTransition("completed", "in_progress", "dispatcher")).toBe(false);
    expect(canTransition("scheduled", "scheduled", "owner")).toBe(false);
  });

  it("allows owner-only cancellation from any non-terminal state", () => {
    for (const s of ["draft", "scheduled", "assigned", "confirmed", "in_progress", "declined"] as const) {
      expect(canTransition(s, "cancelled", "owner")).toBe(true);
      expect(canTransition(s, "cancelled", "dispatcher")).toBe(false);
    }
    expect(canTransition("completed", "cancelled", "owner")).toBe(false);
  });

  it("marks terminal states", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("confirmed")).toBe(false);
    expect(allowedTransitions("completed", "owner")).toEqual([]);
  });
});
