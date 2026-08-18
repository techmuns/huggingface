import { describe, expect, it } from "vitest";
import {
  addWeeks,
  isoWeekLabel,
  toIsoDate,
  trailingWeekWindow,
  weekStart,
  weekStartIso,
} from "../src/lib/time";

describe("weekStart", () => {
  it("returns the same day for a Monday", () => {
    expect(weekStartIso(new Date("2026-08-17T12:00:00Z"))).toBe("2026-08-17");
  });

  it("walks back to Monday from mid-week", () => {
    expect(weekStartIso(new Date("2026-08-20T23:59:59Z"))).toBe("2026-08-17");
  });

  it("treats Sunday as the end of the week, not the start", () => {
    // The classic off-by-one: getUTCDay() calls Sunday 0, so a naive
    // implementation would jump Sunday forward to the next Monday.
    expect(weekStartIso(new Date("2026-08-23T00:00:00Z"))).toBe("2026-08-17");
  });

  it("truncates the time component to midnight UTC", () => {
    expect(weekStart(new Date("2026-08-20T13:45:12.345Z")).toISOString()).toBe(
      "2026-08-17T00:00:00.000Z",
    );
  });

  it("crosses a month boundary", () => {
    expect(weekStartIso(new Date("2026-09-02T09:00:00Z"))).toBe("2026-08-31");
  });
});

describe("isoWeekLabel", () => {
  it("labels a mid-year week", () => {
    expect(isoWeekLabel(new Date("2026-08-17T00:00:00Z"))).toBe("2026-W34");
  });

  it("zero-pads single-digit weeks", () => {
    expect(isoWeekLabel(new Date("2026-01-08T00:00:00Z"))).toBe("2026-W02");
  });

  it("assigns early-January days to the previous ISO year when they belong to it", () => {
    // 2027-01-01 is a Friday, so it falls in the week beginning Mon
    // 2026-12-28 — ISO week 2026-W53, not 2027-W01.
    expect(isoWeekLabel(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });

  it("assigns late-December days to the next ISO year when they belong to it", () => {
    // 2024-12-30 is a Monday whose Thursday lands on 2025-01-02.
    expect(isoWeekLabel(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
  });

  it("gives every day of one week the same label", () => {
    const labels = new Set(
      Array.from({ length: 7 }, (_, i) =>
        isoWeekLabel(new Date(Date.UTC(2026, 7, 17 + i))),
      ),
    );
    expect([...labels]).toEqual(["2026-W34"]);
  });
});

describe("trailingWeekWindow", () => {
  it("includes the week containing the reference date", () => {
    const { start, end } = trailingWeekWindow(new Date("2026-08-20T00:00:00Z"), 1);
    expect(toIsoDate(start)).toBe("2026-08-17");
    expect(toIsoDate(end)).toBe("2026-08-24");
  });

  it("spans exactly N weeks for a backfill", () => {
    const { start, end } = trailingWeekWindow(new Date("2026-08-20T00:00:00Z"), 12);
    expect(toIsoDate(start)).toBe("2026-06-01");
    expect(toIsoDate(end)).toBe("2026-08-24");
    expect((end.getTime() - start.getTime()) / 86_400_000).toBe(84);
  });

  it("produces adjacent, non-overlapping windows so records are counted once", () => {
    const recent = trailingWeekWindow(new Date("2026-08-20T00:00:00Z"), 4);
    const prior = trailingWeekWindow(addWeeks(recent.start, -1), 4);
    expect(prior.end.getTime()).toBe(recent.start.getTime());
  });

  it("rejects a non-positive or fractional window", () => {
    const ref = new Date("2026-08-20T00:00:00Z");
    expect(() => trailingWeekWindow(ref, 0)).toThrow(RangeError);
    expect(() => trailingWeekWindow(ref, -1)).toThrow(RangeError);
    expect(() => trailingWeekWindow(ref, 1.5)).toThrow(RangeError);
  });
});
