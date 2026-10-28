import { describe, expect, it } from "vitest";

import { computeElapsed } from "@/hooks/timer";
import type { TimeEntry } from "@/lib/types";

import { durationInputValue, parseDurationInput } from "./TimeComponents";

describe("parseDurationInput", () => {
  it.each([
    ["1:30", 5400],
    ["0:05", 300],
    ["2h", 7200],
    ["45m", 2700],
    ["1h 15m", 4500],
    ["1.5h", 5400],
    ["1.5", 5400],
    ["  2:00 ", 7200],
  ])("parses %s", (input, seconds) => {
    expect(parseDurationInput(input)).toBe(seconds);
  });

  it.each(["", "abc", "1:2:3", "h", "-1"])("rejects %j", (input) => {
    expect(parseDurationInput(input)).toBeNull();
  });

  it("round-trips through the input format", () => {
    expect(durationInputValue(5400)).toBe("1:30");
    expect(parseDurationInput(durationInputValue(3900))).toBe(3900);
  });
});

describe("computeElapsed", () => {
  const base = { accumulated_seconds: 600, timer_state: "running", segment_started_at: "2026-10-19T10:00:00Z" } as TimeEntry;
  const tenOFive = Date.parse("2026-10-19T10:05:00Z");

  it("adds the current segment to accumulated time for a running timer", () => {
    expect(computeElapsed(base, tenOFive, 0)).toBe(600 + 300);
  });

  it("uses the server clock offset rather than trusting the browser clock", () => {
    // Browser clock is 2 minutes slow relative to the server.
    expect(computeElapsed(base, tenOFive - 120_000, 120_000)).toBe(900);
  });

  it("never goes negative when the browser clock is ahead of the segment start", () => {
    expect(computeElapsed(base, Date.parse("2026-10-19T09:59:00Z"), 0)).toBe(600);
  });

  it("returns accumulated time for a paused timer and zero without a timer", () => {
    expect(computeElapsed({ ...base, timer_state: "paused", segment_started_at: null } as TimeEntry, tenOFive, 0)).toBe(600);
    expect(computeElapsed(null, tenOFive, 0)).toBe(0);
  });
});
