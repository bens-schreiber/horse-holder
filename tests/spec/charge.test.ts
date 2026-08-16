/** `POST /v1/charge`: response shape, ordering, and request validation. */

import { beforeAll, describe, expect, it } from "vitest";

import {
  type Scope,
  budgetsOf,
  definition,
  entry,
  errorCode,
  freshGroup,
  scope,
} from "../client.ts";

let api: Scope;
beforeAll(async () => {
  api = await scope();
});

describe("charge", () => {
  it("returns entries ordered by id with the documented shape", async () => {
    // Act
    const res = await api.charge(
      { group: freshGroup() },
      entry("put-ops", 1, definition(100)),
      entry("storage-bytes", 4096, definition(1_000_000)),
    );

    // Assert
    expect(res.status).toBe(200);
    const entries = await budgetsOf(res);
    expect(
      entries.map((b) => b["id"]),
      "entries describe the group, so they come back by id, not in request order",
    ).toEqual(["put-ops", "storage-bytes"]);
    expect(entries.find((b) => b["id"] === "put-ops")).toEqual({
      id: "put-ops",
      requested: 1,
      exceeded: false,
      limit: 100,
      used: 1,
      remaining: 99,
      renewsAt: null,
      warningsCrossed: [],
    });
  });

  it("reports budgets the request never named", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge(
      { group },
      entry("put-ops", 1, definition(100)),
      entry("storage-bytes", 10, definition(1000)),
    );

    // Act
    const res = await api.charge({ group }, entry("put-ops", 4, definition(100)));

    // Assert
    const entries = await budgetsOf(res);
    expect(entries.map((b) => b["id"])).toEqual(["put-ops", "storage-bytes"]);
    expect(entries[1], "an undrawn budget reports its state with a zero outcome").toEqual({
      id: "storage-bytes",
      requested: 0,
      exceeded: false,
      limit: 1000,
      used: 10,
      remaining: 990,
      renewsAt: null,
      warningsCrossed: [],
    });
  });

  it("accumulates usage across draws", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const seen: number[] = [];
    for (let draw = 0; draw < 3; draw += 1) {
      const res = await api.charge({ group }, entry("put-ops", 10, definition(100)));
      seen.push((await budgetsOf<{ used: number }>(res))[0]!.used);
    }

    // Assert
    expect(seen, "each draw must add to the last, not replace it").toEqual([10, 20, 30]);
  });

  it("reports remaining as max(0, limit - used) after a limit drop below usage", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge({ group }, entry("put-ops", 80, definition(100)));

    // Act
    const res = await api.charge({ group }, entry("put-ops", 0, definition(50)));

    // Assert
    const [budget] = await budgetsOf<{ used: number; remaining: number }>(res);
    expect(budget!.used, "dropping the limit must not refund usage").toBe(80);
    expect(budget!.remaining, "remaining must clamp at zero, never go negative").toBe(0);
  });

  it("rejects an empty or oversized budgets array with 400", async () => {
    // Arrange
    const group = freshGroup();
    const seventeen = Array.from({ length: 17 }, (_, i) =>
      entry(`put-ops-${i}`, 1, definition(10)),
    );

    // Act
    const empty = await api.charge({ group });
    const tooMany = await api.charge({ group }, ...seventeen);

    // Assert
    expect(empty.status, "an empty budgets array is not a valid request").toBe(400);
    expect(tooMany.status, "17 budgets is past the limit of 16").toBe(400);
    expect(await errorCode(tooMany)).toBe("invalid_request");
  });

  it("accepts exactly 16 budgets", async () => {
    // Arrange
    const sixteen = Array.from({ length: 16 }, (_, i) => entry(`put-ops-${i}`, 1, definition(10)));

    // Act
    const res = await api.charge({ group: freshGroup() }, ...sixteen);

    // Assert
    expect(res.status, "16 budgets is exactly the documented maximum").toBe(200);
  });

  it("rejects duplicate budget ids rather than summing them", async () => {
    // Act
    const res = await api.charge(
      { group: freshGroup() },
      entry("put-ops", 1, definition(10)),
      entry("put-ops", 2, definition(10)),
    );

    // Assert
    expect(res.status).toBe(400);
  });

  it("rejects a zero or negative limit", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    for (const limit of [0, -1]) {
      const res = await api.charge({ group }, entry("put-ops", 1, definition(limit)));
      expect(res.status, `limit ${limit}`).toBe(400);
    }
  });

  it("rejects a negative or non-finite amount", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const negative = await api.charge({ group }, entry("put-ops", -1, definition(10)));
    const nonFinite = await api.charge({ group }, {
      id: "put-ops",
      amount: "1",
      definition: definition(10),
    } as never);

    // Assert
    expect(negative.status, "a negative amount").toBe(400);
    expect(nonFinite.status, "a string amount").toBe(400);
  });

  it("allows a zero amount as a definition-only reconciliation", async () => {
    // Act
    const res = await api.charge({ group: freshGroup() }, entry("put-ops", 0, definition(10)));

    // Assert
    expect(res.status).toBe(200);
    expect((await budgetsOf<{ used: number }>(res))[0]!.used).toBe(0);
  });

  it("requires an idempotency-key", async () => {
    // Act
    const res = await api.fetch("/v1/charge", {
      method: "POST",
      headers: { "content-type": "application/json", "hh-group": freshGroup() },
      body: JSON.stringify({ budgets: [entry("put-ops", 1, definition(10))] }),
    });

    // Assert
    expect(res.status).toBe(400);
  });

  it("permits a draw exactly to the limit but not one past it", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const exact = await api.charge({ group }, entry("put-ops", 100, definition(100)));
    const past = await api.charge({ group }, entry("put-ops", 1, definition(100)));

    // Assert
    expect(exact.status, "a draw landing exactly on the limit is allowed").toBe(200);
    expect(past.status, "one unit past an exhausted budget is denied").toBe(402);
  });
});
