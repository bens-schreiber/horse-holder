/**
 * Atomicity. These properties are non-negotiable: an implementation that violates them cannot
 * be trusted to enforce a budget at all.
 *
 * The concurrency tests below are the ones most likely to survive casual testing, because the
 * defect appears only under real concurrency.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { type Scope, budgetsOf, definition, entry, freshGroup, json, scope } from "../client.ts";

let api: Scope;
beforeAll(async () => {
  api = await scope();
});

describe("all-or-nothing across budgets", () => {
  it("leaves every budget untouched when one lacks capacity", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge(
      { group },
      entry("storage-bytes", 0, definition(1000)),
      entry("put-ops", 95, definition(100)),
    );

    // Act
    const res = await api.charge(
      { group },
      entry("storage-bytes", 10, definition(1000)),
      entry("put-ops", 10, definition(100)),
    );

    // Assert
    expect(res.status).toBe(402);
    expect(
      await api.used({ group }, "storage-bytes"),
      "a denied draw silently consumed capacity",
    ).toBe(0);
    expect(await api.used({ group }, "put-ops")).toBe(95);
  });

  it("marks every budget that lacked capacity, not merely the first", async () => {
    // Act
    const res = await api.charge(
      { group: freshGroup() },
      entry("delete-ops", 200, definition(100)),
      entry("put-ops", 1, definition(100)),
      entry("storage-bytes", 500, definition(100)),
    );

    // Assert
    expect(res.status).toBe(402);
    const entries = await budgetsOf<{ id: string; exceeded: boolean }>(res);
    expect(
      entries.map((budget) => [budget.id, budget.exceeded]),
      "every budget that lacked capacity must be marked",
    ).toEqual([
      ["delete-ops", true],
      ["put-ops", false],
      ["storage-bytes", true],
    ]);
  });

  it("applies a multi-budget draw to all budgets when all have capacity", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const res = await api.charge(
      { group },
      entry("put-ops", 10, definition(100)),
      entry("storage-bytes", 20, definition(100)),
    );

    // Assert
    expect(res.status).toBe(200);
    expect(await api.used({ group }, "put-ops")).toBe(10);
    expect(await api.used({ group }, "storage-bytes")).toBe(20);
  });
});

describe("atomic check-and-decrement", () => {
  it("never overshoots under many concurrent charges against one budget", async () => {
    // Arrange
    const group = freshGroup();
    const limit = 100;
    const amount = 10;
    const attempts = 60;

    // Act
    const responses = await Promise.all(
      Array.from({ length: attempts }, () =>
        api.charge({ group }, entry("put-ops", amount, definition(limit))),
      ),
    );

    // Assert
    const succeeded = responses.filter((res) => res.status === 200).length;
    const denied = responses.filter((res) => res.status === 402).length;
    expect(succeeded, "exactly the number of charges the limit admits must succeed").toBe(
      limit / amount,
    );
    expect(denied, "every charge beyond the limit must be denied").toBe(attempts - limit / amount);
    expect(await api.used({ group }, "put-ops"), "concurrent charges overshot the limit").toBe(
      limit,
    );
  });

  it("never overshoots under concurrent multi-budget draws", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const responses = await Promise.all(
      Array.from({ length: 40 }, () =>
        api.charge(
          { group },
          entry("put-ops", 10, definition(100)),
          entry("storage-bytes", 20, definition(100)),
        ),
      ),
    );

    // Assert
    const succeeded = responses.filter((res) => res.status === 200).length;
    expect(succeeded, "storage-bytes is the binding constraint at 5 successes").toBe(5);
    expect(
      await api.used({ group }, "put-ops"),
      "put-ops must move in lockstep with the binding budget",
    ).toBe(50);
    expect(await api.used({ group }, "storage-bytes")).toBe(100);
  });

  it("never overshoots under a mix of concurrent charges, reserves, and settles", async () => {
    // Arrange
    const group = freshGroup();
    const limit = 100;
    const reserves = await Promise.all(
      Array.from({ length: 20 }, () =>
        api.reserve({ group }, entry("put-ops", 10, definition(limit))),
      ),
    );
    const ids = await Promise.all(
      reserves
        .filter((res) => res.status === 200)
        .map(async (res) => (await json<{ reservationId: string }>(res)).reservationId),
    );
    expect(ids.length, "the limit admits exactly 10 concurrent reservations").toBe(10);

    // Act
    await Promise.all(ids.slice(0, 5).map((id) => api.release({ group }, id)));
    await Promise.all(
      Array.from({ length: 20 }, () =>
        api.charge({ group }, entry("put-ops", 10, definition(limit))),
      ),
    );

    // Assert
    expect(
      await api.used({ group }, "put-ops"),
      "a concurrent mix of charges, reserves, and settles overshot the limit",
    ).toBeLessThanOrEqual(limit);
  });
});
