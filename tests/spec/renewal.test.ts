/** Renewal rules, observed through the wire protocol. */

import { beforeAll, describe, expect, it } from "vitest";
import { definition, entry, freshGroup, freshKey, post, readJson } from "../client.ts";
import { harness } from "../harness.ts";

let auth: Record<string, string>;
beforeAll(async () => {
  auth = await harness.newScope();
});

async function draw(
  group: string,
  amount: number,
  renewal: Record<string, unknown>,
  limit = 100,
): Promise<{ used: number; renewsAt: string | null }> {
  const res = await post(
    harness,
    auth,
    "/v1/charge",
    {
      budgets: [entry("b", amount, definition(limit, { renewal }))],
    },
    { group, key: freshKey() },
  );
  const body = await readJson<{ budgets: { used: number; renewsAt: string | null }[] }>(res);
  return body.budgets[0]!;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
      const res = await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry("b", 1, definition(10, { renewal: { type: "interval", seconds } }))],
        },
        { group, key: freshKey() },
      );
      expect(res.status, `seconds ${seconds}`).toBe(400);
    }
  });
});

describe("calendar renewal", () => {
  it("lands on the 1st of the next month at local midnight in UTC", async () => {
    // Act
    const { renewsAt } = await draw(freshGroup(), 1, { type: "calendar", unit: "month" });

    // Assert
    const d = new Date(renewsAt!);
    expect(d.getUTCDate()).toBe(1);
    expect([d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]).toEqual([0, 0, 0]);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });

  it("honors a non-UTC timezone", async () => {
    // Act
    const { renewsAt } = await draw(freshGroup(), 1, {
      type: "calendar",
      unit: "month",
      timezone: "America/Chicago",
    });

    // Assert
    const d = new Date(renewsAt!);
    expect([5, 6], "Chicago midnight is 05:00 or 06:00 UTC depending on daylight saving").toContain(
      d.getUTCHours(),
    );
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(d);
    expect(local.find((p) => p.type === "day")!.value).toBe("1");
    expect(Number(local.find((p) => p.type === "hour")!.value)).toBe(0);
  });

  it("keeps an anchor on the 31st rather than drifting to February's clamp", async () => {
    // Act
    const { renewsAt } = await draw(freshGroup(), 1, {
      type: "calendar",
      unit: "month",
      anchor: "2020-01-31T00:00:00Z",
    });

    // Assert
    const d = new Date(renewsAt!);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    expect(
      d.getUTCDate(),
      "the anchor day must be clamped per month, never carried forward as drift",
    ).toBe(Math.min(31, lastDay));
  });

  it("supports day, week, and year units", async () => {
    // Assert
    for (const unit of ["day", "week", "year"] as const) {
      const { renewsAt } = await draw(freshGroup(), 1, { type: "calendar", unit });
      const d = new Date(renewsAt!);
      expect(d.getTime(), unit).toBeGreaterThan(Date.now());
      expect([d.getUTCHours(), d.getUTCMinutes()], unit).toEqual([0, 0]);
      if (unit === "week") {
        expect(d.getUTCDay(), "weeks default to Monday").toBe(1);
      }
      if (unit === "year") {
        expect([d.getUTCMonth(), d.getUTCDate()], unit).toEqual([0, 1]);
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
      const res = await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry("b", 1, definition(10, { renewal }))],
        },
        { group, key: freshKey() },
      );
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
      const res = await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry("b", 1, definition(10, { renewal }))],
        },
        { group, key: freshKey() },
      );
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
    const blocked = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 1, definition(100, { renewal }))],
      },
      { group, key: freshKey() },
    );
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
