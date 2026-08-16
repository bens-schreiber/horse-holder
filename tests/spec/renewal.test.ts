/** Renewal rules, observed through the wire protocol. */

import { beforeAll, describe, expect, it } from "vitest";

import { type Scope, budgetsOf, definition, entry, freshGroup, scope, sleep } from "../client.ts";

let api: Scope;
beforeAll(async () => {
  api = await scope();
});

/** Charges one budget under `renewal` and reports where usage and the boundary landed. */
async function draw(
  group: string,
  amount: number,
  renewal: Record<string, unknown>,
  limit = 100,
): Promise<{ used: number; renewsAt: string | null }> {
  const res = await api.charge({ group }, entry("put-ops", amount, definition(limit, { renewal })));
  return (await budgetsOf<{ used: number; renewsAt: string | null }>(res))[0]!;
}

describe("never renewal", () => {
  it("reports a null renewsAt and accumulates indefinitely", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    expect((await draw(group, 10, { type: "never" })).renewsAt).toBeNull();
    expect(
      (await draw(group, 10, { type: "never" })).used,
      "a never budget must carry usage forward instead of resetting",
    ).toBe(20);
  });
});

describe("interval renewal", () => {
  it("tumbles: usage resets to zero at the boundary", async () => {
    // Arrange
    const group = freshGroup();
    const renewal = { type: "interval", seconds: 1 };

    // Act
    const first = await draw(group, 10, renewal);
    await sleep(1100);
    const afterBoundary = await draw(group, 10, renewal);

    // Assert
    expect(first.used).toBe(10);
    expect(first.renewsAt).not.toBeNull();
    expect(afterBoundary.used, "the new period must start from zero, not from 20").toBe(10);
  });

  it("tiles windows forward from an explicit anchor", async () => {
    // Arrange
    const anchor = "2020-01-01T00:00:00Z";

    // Act
    const result = await draw(freshGroup(), 1, { type: "interval", seconds: 3600, anchor });

    // Assert
    const renewsAt = Date.parse(result.renewsAt!);
    expect(
      (renewsAt - Date.parse(anchor)) % 3_600_000,
      "the boundary must land an exact number of windows from the anchor",
    ).toBe(0);
    expect(renewsAt).toBeGreaterThan(Date.now());
    expect(renewsAt - Date.now()).toBeLessThanOrEqual(3_600_000);
  });

  it("rejects a non-positive or fractional seconds", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    for (const seconds of [0, -60, 1.5]) {
      const renewal = { type: "interval", seconds };
      const res = await api.charge({ group }, entry("put-ops", 1, definition(10, { renewal })));
      expect(res.status, `seconds ${seconds}`).toBe(400);
    }
  });
});

describe("calendar renewal", () => {
  it("lands on the 1st of the next month at local midnight in UTC", async () => {
    // Act
    const { renewsAt } = await draw(freshGroup(), 1, { type: "calendar", unit: "month" });

    // Assert
    const boundary = new Date(renewsAt!);
    expect(boundary.getUTCDate()).toBe(1);
    expect([boundary.getUTCHours(), boundary.getUTCMinutes(), boundary.getUTCSeconds()]).toEqual([
      0, 0, 0,
    ]);
    expect(boundary.getTime()).toBeGreaterThan(Date.now());
  });

  it("honors a non-UTC timezone", async () => {
    // Act
    const { renewsAt } = await draw(freshGroup(), 1, {
      type: "calendar",
      unit: "month",
      timezone: "America/Chicago",
    });

    // Assert
    const boundary = new Date(renewsAt!);
    expect([5, 6], "Chicago midnight is 05:00 or 06:00 UTC depending on daylight saving").toContain(
      boundary.getUTCHours(),
    );
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(boundary);
    expect(local.find((part) => part.type === "day")!.value).toBe("1");
    expect(Number(local.find((part) => part.type === "hour")!.value)).toBe(0);
  });

  it("keeps an anchor on the 31st rather than drifting to February's clamp", async () => {
    // Act
    const { renewsAt } = await draw(freshGroup(), 1, {
      type: "calendar",
      unit: "month",
      anchor: "2020-01-31T00:00:00Z",
    });

    // Assert
    const boundary = new Date(renewsAt!);
    const lastDay = new Date(
      Date.UTC(boundary.getUTCFullYear(), boundary.getUTCMonth() + 1, 0),
    ).getUTCDate();
    expect(
      boundary.getUTCDate(),
      "the anchor day must be clamped per month, never carried forward as drift",
    ).toBe(Math.min(31, lastDay));
  });

  it("supports day, week, and year units", async () => {
    // Assert
    for (const unit of ["day", "week", "year"] as const) {
      const { renewsAt } = await draw(freshGroup(), 1, { type: "calendar", unit });
      const boundary = new Date(renewsAt!);
      expect(boundary.getTime(), unit).toBeGreaterThan(Date.now());
      expect([boundary.getUTCHours(), boundary.getUTCMinutes()], unit).toEqual([0, 0]);
      if (unit === "week") {
        expect(boundary.getUTCDay(), "weeks default to Monday").toBe(1);
      }
      if (unit === "year") {
        expect([boundary.getUTCMonth(), boundary.getUTCDate()], unit).toEqual([0, 1]);
      }
    }
  });

  it("honors a multi-unit interval", async () => {
    // Arrange
    const mondayAnchor = "2026-01-05T00:00:00Z";

    // Act
    const { renewsAt } = await draw(freshGroup(), 1, {
      type: "calendar",
      unit: "week",
      interval: 2,
      anchor: mondayAnchor,
    });

    // Assert
    const weeks = (Date.parse(renewsAt!) - Date.parse(mondayAnchor)) / (7 * 86_400_000);
    expect(Number.isInteger(weeks), "the boundary must land on a whole week from the anchor").toBe(
      true,
    );
    expect(weeks % 2, "an interval of 2 must skip every other week").toBe(0);
  });

  it("rejects an unknown unit, a bad timezone, and a bad anchor", async () => {
    // Arrange
    const group = freshGroup();
    const cases: Record<string, unknown>[] = [
      { type: "calendar", unit: "fortnight" },
      { type: "calendar", unit: "month", timezone: "Mars/Olympus" },
      { type: "calendar", unit: "month", anchor: "not-a-date" },
      { type: "calendar", unit: "month", interval: 0 },
      { type: "calendar" },
    ];

    // Assert
    for (const renewal of cases) {
      const res = await api.charge({ group }, entry("put-ops", 1, definition(10, { renewal })));
      expect(res.status, JSON.stringify(renewal)).toBe(400);
    }
  });

  it("rejects an unknown renewal type and unknown renewal fields", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    for (const renewal of [
      { type: "sliding", seconds: 60 },
      { type: "never", seconds: 60 },
    ]) {
      const res = await api.charge({ group }, entry("put-ops", 1, definition(10, { renewal })));
      expect(res.status, JSON.stringify(renewal)).toBe(400);
    }
  });
});

describe("applying renewals", () => {
  it("evaluates renewal lazily on the next request touching the budget", async () => {
    // Arrange
    const group = freshGroup();
    const renewal = { type: "interval", seconds: 1 };
    await draw(group, 100, renewal);

    // Act
    const blocked = await api.charge({ group }, entry("put-ops", 1, definition(100, { renewal })));
    await sleep(1100);
    const afterBoundary = await draw(group, 1, renewal);

    // Assert
    expect(blocked.status, "the budget is exhausted for this period").toBe(402);
    expect(
      afterBoundary.used,
      "no background job runs, so this request itself must apply the renewal",
    ).toBe(1);
  });
});
