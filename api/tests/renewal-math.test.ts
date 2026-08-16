/**
 * Unit tests for `renewal.ts`, the densest arithmetic in the project.
 *
 * These run against the pure functions with an injected clock, so calendar edge cases that
 * would take a year of wall time to observe over HTTP are checked directly.
 */

import { describe, expect, it } from "vitest";
import { isValidTimezone, nextBoundary, type Renewal } from "../src/renewal.ts";

const at = (iso: string): number => Date.parse(iso);
const boundary = (rule: Renewal, from: string, createdAt = from): string | null => {
  const ms = nextBoundary(rule, at(from), at(createdAt));
  return ms === null ? null : new Date(ms).toISOString();
};

describe("never renewal", () => {
  it("has no boundary", () => {
    expect(boundary({ type: "never" }, "2026-08-15T12:00:00Z")).toBeNull();
  });
});

describe("interval renewal", () => {
  it("tiles forward from an explicit anchor", () => {
    // Arrange
    const rule: Renewal = { type: "interval", seconds: 3600, anchor: "2026-01-01T00:00:00Z" };

    // Assert
    expect(boundary(rule, "2026-01-01T00:00:00Z")).toBe("2026-01-01T01:00:00.000Z");
    expect(boundary(rule, "2026-01-01T00:59:59Z")).toBe("2026-01-01T01:00:00.000Z");
    expect(boundary(rule, "2026-01-01T01:00:00Z")).toBe("2026-01-01T02:00:00.000Z");
  });

  it("stays on the anchor's phase from a far-past anchor", () => {
    // Arrange
    const rule: Renewal = { type: "interval", seconds: 3600, anchor: "2020-01-01T00:17:00Z" };

    // Assert
    expect(
      boundary(rule, "2026-08-15T12:00:00Z"),
      "six years on, boundaries must still land on the anchor's minute offset",
    ).toBe("2026-08-15T12:17:00.000Z");
    expect(boundary(rule, "2026-08-15T12:30:00Z")).toBe("2026-08-15T13:17:00.000Z");
  });

  it("defaults its anchor to the budget's creation instant", () => {
    // Arrange
    const rule: Renewal = { type: "interval", seconds: 60 };

    // Assert
    expect(boundary(rule, "2026-08-15T12:00:30Z", "2026-08-15T12:00:00Z")).toBe(
      "2026-08-15T12:01:00.000Z",
    );
  });

  it("is tumbling, not sliding: the boundary does not move with usage", () => {
    // Arrange
    const rule: Renewal = { type: "interval", seconds: 3600, anchor: "2026-01-01T00:00:00Z" };

    // Act
    const first = boundary(rule, "2026-01-01T00:05:00Z");
    const later = boundary(rule, "2026-01-01T00:45:00Z");

    // Assert
    expect(first, "the boundary moved with usage, so the window is sliding").toBe(later);
  });

  it("handles a one-second window", () => {
    const rule: Renewal = { type: "interval", seconds: 1, anchor: "2026-01-01T00:00:00Z" };
    expect(boundary(rule, "2026-01-01T00:00:00.500Z")).toBe("2026-01-01T00:00:01.000Z");
  });
});

describe("calendar renewal: month-end clamping", () => {
  const rule: Renewal = { type: "calendar", unit: "month", anchor: "2026-01-31T00:00:00Z" };

  it("clamps into February and returns to the 31st in March", () => {
    // Assert
    expect(boundary(rule, "2026-01-31T12:00:00Z")).toBe("2026-02-28T00:00:00.000Z");
    expect(
      boundary(rule, "2026-02-28T12:00:00Z"),
      "the anchor day was overwritten by the clamped value",
    ).toBe("2026-03-31T00:00:00.000Z");
    expect(boundary(rule, "2026-03-31T12:00:00Z")).toBe("2026-04-30T00:00:00.000Z");
    expect(boundary(rule, "2026-04-30T12:00:00Z")).toBe("2026-05-31T00:00:00.000Z");
  });

  it("does not drift after many clamped months", () => {
    // Assert
    expect(
      boundary(rule, "2027-07-15T00:00:00Z"),
      "a budget anchored to the 31st migrated permanently to a clamped day",
    ).toBe("2027-07-31T00:00:00.000Z");
    expect(boundary(rule, "2030-12-15T00:00:00Z")).toBe("2030-12-31T00:00:00.000Z");
  });

  it("clamps to February 29 in a leap year", () => {
    // Assert
    expect(boundary(rule, "2028-02-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(boundary(rule, "2028-02-29T12:00:00Z")).toBe("2028-03-31T00:00:00.000Z");
  });

  it("clamps a 30th anchor only in February", () => {
    // Arrange
    const thirtieth: Renewal = { type: "calendar", unit: "month", anchor: "2026-01-30T00:00:00Z" };

    // Assert
    expect(boundary(thirtieth, "2026-02-01T00:00:00Z")).toBe("2026-02-28T00:00:00.000Z");
    expect(boundary(thirtieth, "2026-03-01T00:00:00Z")).toBe("2026-03-30T00:00:00.000Z");
  });

  it("defaults the phase to the 1st of the month", () => {
    const plain: Renewal = { type: "calendar", unit: "month" };
    expect(boundary(plain, "2026-08-15T12:00:00Z")).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("calendar renewal: timezones and daylight saving", () => {
  it("computes boundaries at local midnight, not UTC midnight", () => {
    const rule: Renewal = { type: "calendar", unit: "day", timezone: "America/Chicago" };
    expect(
      boundary(rule, "2026-08-15T12:00:00Z"),
      "Chicago is UTC-5 in August, so local midnight is 05:00Z",
    ).toBe("2026-08-16T05:00:00.000Z");
  });

  it("shifts with the offset across a spring-forward transition", () => {
    // Arrange
    const rule: Renewal = { type: "calendar", unit: "day", timezone: "America/Chicago" };

    // Assert
    expect(
      boundary(rule, "2026-03-07T12:00:00Z"),
      "before the 2026-03-08 spring-forward Chicago is UTC-6",
    ).toBe("2026-03-08T06:00:00.000Z");
    expect(
      boundary(rule, "2026-03-09T00:00:00Z"),
      "after the 2026-03-08 spring-forward Chicago is UTC-5",
    ).toBe("2026-03-09T05:00:00.000Z");
  });

  it("shifts with the offset across a fall-back transition", () => {
    // Arrange
    const rule: Renewal = { type: "calendar", unit: "day", timezone: "America/Chicago" };

    // Assert
    expect(
      boundary(rule, "2026-10-31T12:00:00Z"),
      "before the 2026-11-01 fall-back Chicago is UTC-5",
    ).toBe("2026-11-01T05:00:00.000Z");
    expect(
      boundary(rule, "2026-11-01T12:00:00Z"),
      "after the 2026-11-01 fall-back Chicago is UTC-6",
    ).toBe("2026-11-02T06:00:00.000Z");
  });

  it("resolves a boundary inside a spring-forward gap to the first valid instant after it", () => {
    // Arrange
    const rule: Renewal = { type: "calendar", unit: "day", timezone: "Africa/Cairo" };

    // Act
    const result = nextBoundary(rule, at("2023-04-27T12:00:00Z"), at("2023-04-27T12:00:00Z"));

    // Assert
    expect(
      new Date(result!).toISOString(),
      "Cairo skipped April 28 00:00 local, so the boundary must be the transition at 01:00",
    ).toBe("2023-04-27T22:00:00.000Z");
  });

  it("resolves a boundary inside a fall-back overlap to the first occurrence", () => {
    // Arrange
    const rule: Renewal = { type: "calendar", unit: "day", timezone: "Australia/Lord_Howe" };

    // Act
    const result = nextBoundary(rule, at("2026-04-04T00:00:00Z"), at("2026-04-04T00:00:00Z"));

    // Assert
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: "Australia/Lord_Howe",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(result!));
    expect(local, "the boundary did not round-trip to local midnight").toBe("00:00");
  });

  it("handles a Southern-Hemisphere zone, where DST runs the other way", () => {
    // Arrange
    const rule: Renewal = { type: "calendar", unit: "day", timezone: "Australia/Sydney" };

    // Assert
    expect(
      boundary(rule, "2026-07-15T00:00:00Z"),
      "Sydney is UTC+10 in July, its standard-time half of the year",
    ).toBe("2026-07-15T14:00:00.000Z");
    expect(
      boundary(rule, "2026-01-15T00:00:00Z"),
      "Sydney is UTC+11 in January, its daylight half of the year",
    ).toBe("2026-01-15T13:00:00.000Z");
  });

  it("handles a half-hour offset zone", () => {
    const rule: Renewal = { type: "calendar", unit: "day", timezone: "Asia/Kolkata" };
    expect(boundary(rule, "2026-08-15T12:00:00Z")).toBe("2026-08-15T18:30:00.000Z");
  });

  it("defaults to UTC", () => {
    const rule: Renewal = { type: "calendar", unit: "day" };
    expect(boundary(rule, "2026-08-15T12:00:00Z")).toBe("2026-08-16T00:00:00.000Z");
  });
});

describe("calendar renewal: week and year phases", () => {
  it("defaults weeks to Monday", () => {
    const rule: Renewal = { type: "calendar", unit: "week" };
    expect(
      boundary(rule, "2026-08-15T12:00:00Z"),
      "2026-08-15 is a Saturday, so the next default weekly boundary is Monday the 17th",
    ).toBe("2026-08-17T00:00:00.000Z");
  });

  it("takes its weekday phase from an anchor", () => {
    // Arrange
    const rule: Renewal = { type: "calendar", unit: "week", anchor: "2026-01-01T00:00:00Z" };

    // Act
    const result = new Date(nextBoundary(rule, at("2026-08-15T12:00:00Z"), 0)!);

    // Assert
    expect(result.getUTCDay(), "the anchor 2026-01-01 is a Thursday").toBe(4);
  });

  it("steps fortnightly with interval 2", () => {
    // Arrange
    const rule: Renewal = {
      type: "calendar",
      unit: "week",
      interval: 2,
      anchor: "2026-01-05T00:00:00Z",
    };

    // Assert
    expect(boundary(rule, "2026-01-05T12:00:00Z")).toBe("2026-01-19T00:00:00.000Z");
    expect(boundary(rule, "2026-01-19T12:00:00Z")).toBe("2026-02-02T00:00:00.000Z");
  });

  it("defaults years to January 1 and honors an anchored month", () => {
    // Assert
    expect(boundary({ type: "calendar", unit: "year" }, "2026-08-15T12:00:00Z")).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(
      boundary(
        { type: "calendar", unit: "year", anchor: "2020-07-01T00:00:00Z" },
        "2026-08-15T12:00:00Z",
      ),
      "a fiscal year anchored in July must keep its July phase",
    ).toBe("2027-07-01T00:00:00.000Z");
  });

  it("steps multi-year intervals on the anchor's lattice", () => {
    // Arrange
    const rule: Renewal = {
      type: "calendar",
      unit: "year",
      interval: 3,
      anchor: "2020-01-01T00:00:00Z",
    };

    // Assert
    expect(boundary(rule, "2026-08-15T12:00:00Z")).toBe("2029-01-01T00:00:00.000Z");
  });

  it("steps multi-month intervals on the anchor's lattice", () => {
    // Arrange
    const rule: Renewal = {
      type: "calendar",
      unit: "month",
      interval: 3,
      anchor: "2026-01-01T00:00:00Z",
    };

    // Assert
    expect(boundary(rule, "2026-01-15T00:00:00Z")).toBe("2026-04-01T00:00:00.000Z");
    expect(boundary(rule, "2026-08-15T00:00:00Z")).toBe("2026-10-01T00:00:00.000Z");
  });

  it("returns a strictly future boundary when called exactly on one", () => {
    const rule: Renewal = { type: "calendar", unit: "day" };
    expect(
      boundary(rule, "2026-08-15T00:00:00Z"),
      "a boundary exactly at the query instant must advance, not return itself",
    ).toBe("2026-08-16T00:00:00.000Z");
  });
});

describe("isValidTimezone", () => {
  it("accepts IANA names and rejects anything else", () => {
    // Assert
    for (const tz of ["UTC", "America/Chicago", "Asia/Kolkata", "Australia/Sydney"]) {
      expect(isValidTimezone(tz), tz).toBe(true);
    }
    for (const tz of ["Mars/Olympus", "Not A Zone", ""]) {
      expect(isValidTimezone(tz), tz).toBe(false);
    }
  });
});
