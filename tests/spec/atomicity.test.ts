/**
 * Atomicity. These properties are non-negotiable: an implementation that violates them
 * cannot be trusted to enforce a budget at all.
 *
 * The concurrency test below is the one most likely to survive casual
 * testing, because the defect appears only under real concurrency.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { definition, entry, freshGroup, freshKey, get, post, readJson } from "../client.ts";
import { harness } from "../harness.ts";

let auth: Record<string, string>;
beforeAll(async () => {
  auth = await harness.newScope();
});

async function used(group: string, id: string): Promise<number> {
  const res = await get(harness, auth, "/v1/budget", { group, headers: { "hh-budget-id": id } });
  if (res.status !== 200) {
    return 0;
  }
  return (await readJson<{ budgets: { used: number }[] }>(res)).budgets[0]!.used;
}

describe("all-or-nothing across budgets", () => {
  it("leaves every budget untouched when one lacks capacity", async () => {
    // Arrange
    const group = freshGroup();
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("rich", 0, definition(1000)), entry("poor", 95, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("rich", 10, definition(1000)), entry("poor", 10, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Assert
    expect(res.status).toBe(402);
    expect(await used(group, "rich"), "a denied draw silently consumed capacity").toBe(0);
    expect(await used(group, "poor")).toBe(95);
  });

  it("marks every budget that lacked capacity, not merely the first", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [
          entry("a", 200, definition(100)),
          entry("b", 1, definition(100)),
          entry("c", 500, definition(100)),
        ],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    expect(res.status).toBe(402);
    const body = await readJson<{ budgets: { id: string; exceeded: boolean }[] }>(res);
    expect(
      body.budgets.map((b) => [b.id, b.exceeded]),
      "every budget that lacked capacity must be marked",
    ).toEqual([
      ["a", true],
      ["b", false],
      ["c", true],
    ]);
  });

  it("applies a multi-budget draw to all budgets when all have capacity", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("a", 10, definition(100)), entry("b", 20, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Assert
    expect(res.status).toBe(200);
    expect(await used(group, "a")).toBe(10);
    expect(await used(group, "b")).toBe(20);
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
        post(
          harness,
          auth,
          "/v1/charge",
          {
            budgets: [entry("hot", amount, definition(limit))],
          },
          { group, key: freshKey() },
        ),
      ),
    );

    // Assert
    const succeeded = responses.filter((r) => r.status === 200).length;
    const denied = responses.filter((r) => r.status === 402).length;
    expect(succeeded, "exactly the number of charges the limit admits must succeed").toBe(
      limit / amount,
    );
    expect(denied, "every charge beyond the limit must be denied").toBe(attempts - limit / amount);
    expect(await used(group, "hot"), "concurrent charges overshot the limit").toBe(limit);
  });

  it("never overshoots under concurrent multi-budget draws", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const responses = await Promise.all(
      Array.from({ length: 40 }, () =>
        post(
          harness,
          auth,
          "/v1/charge",
          {
            budgets: [entry("x", 10, definition(100)), entry("y", 20, definition(100))],
          },
          { group, key: freshKey() },
        ),
      ),
    );

    // Assert
    const succeeded = responses.filter((r) => r.status === 200).length;
    expect(succeeded, "`y` is the binding constraint at 5 successes").toBe(5);
    expect(await used(group, "x"), "`x` must move in lockstep with the binding budget").toBe(50);
    expect(await used(group, "y")).toBe(100);
  });

  it("never overshoots under a mix of concurrent charges, reserves, and settles", async () => {
    // Arrange
    const group = freshGroup();
    const limit = 100;

    const reserves = await Promise.all(
      Array.from({ length: 20 }, () =>
        post(
          harness,
          auth,
          "/v1/reserve",
          {
            budgets: [entry("mix", 10, definition(limit))],
          },
          { group, key: freshKey() },
        ),
      ),
    );
    const ids = await Promise.all(
      reserves
        .filter((r) => r.status === 200)
        .map(async (r) => (await readJson<{ reservationId: string }>(r)).reservationId),
    );
    expect(ids.length, "the limit admits exactly 10 concurrent reservations").toBe(10);

    // Act
    await Promise.all(
      ids.slice(0, 5).map((id) =>
        post(harness, auth, "/v1/release", undefined, {
          group,
          headers: { "hh-reservation-id": id },
        }),
      ),
    );
    await Promise.all(
      Array.from({ length: 20 }, () =>
        post(
          harness,
          auth,
          "/v1/charge",
          {
            budgets: [entry("mix", 10, definition(limit))],
          },
          { group, key: freshKey() },
        ),
      ),
    );

    // Assert
    expect(
      await used(group, "mix"),
      "a concurrent mix of charges, reserves, and settles overshot the limit",
    ).toBeLessThanOrEqual(limit);
  });
});
