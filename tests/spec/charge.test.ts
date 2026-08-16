/** `POST /v1/charge`: response shape, ordering, and request validation. */

import { beforeAll, describe, expect, it } from "vitest";
import { definition, entry, freshGroup, freshKey, post, readJson } from "../client.ts";
import { harness } from "../harness.ts";

let auth: Record<string, string>;
beforeAll(async () => {
  auth = await harness.newScope();
});

describe("charge", () => {
  it("returns entries in request order with the documented shape", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("ops", 1, definition(100)), entry("bytes", 4096, definition(1_000_000))],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    expect(res.status).toBe(200);
    const body = await readJson<{ budgets: Record<string, unknown>[] }>(res);
    expect(
      body.budgets.map((b) => b["id"]),
      "entries must come back in request order",
    ).toEqual(["ops", "bytes"]);
    expect(body.budgets[0]).toEqual({
      id: "ops",
      requested: 1,
      exceeded: false,
      limit: 100,
      used: 1,
      remaining: 99,
      renewsAt: null,
      warningsCrossed: [],
    });
  });

  it("accumulates usage across draws", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    for (const expected of [10, 20, 30]) {
      const res = await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry("acc", 10, definition(100))],
        },
        { group, key: freshKey() },
      );
      const body = await readJson<{ budgets: { used: number; remaining: number }[] }>(res);
      expect(body.budgets[0]!.used, `after drawing 10 up to ${expected}`).toBe(expected);
      expect(body.budgets[0]!.remaining, `after drawing 10 up to ${expected}`).toBe(100 - expected);
    }
  });

  it("reports remaining as max(0, limit - used) after a limit drop below usage", async () => {
    // Arrange
    const group = freshGroup();
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("clamp", 80, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("clamp", 0, definition(50))],
      },
      { group, key: freshKey() },
    );

    // Assert
    const body = await readJson<{ budgets: { used: number; remaining: number }[] }>(res);
    expect(body.budgets[0]!.used, "dropping the limit must not refund usage").toBe(80);
    expect(body.budgets[0]!.remaining, "remaining must clamp at zero, never go negative").toBe(0);
  });

  it("rejects an empty or oversized budgets array with 400", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const empty = await post(
      harness,
      auth,
      "/v1/charge",
      { budgets: [] },
      { group, key: freshKey() },
    );
    const tooMany = await post(
      harness,
      auth,
      "/v1/charge",
      { budgets: Array.from({ length: 17 }, (_, i) => entry(`b${i}`, 1, definition(10))) },
      { group, key: freshKey() },
    );

    // Assert
    expect(empty.status, "an empty budgets array is not a valid request").toBe(400);
    expect(tooMany.status, "17 budgets is past the limit of 16").toBe(400);
    expect((await readJson<{ error: { code: string } }>(tooMany)).error.code).toBe(
      "invalid_request",
    );
  });

  it("accepts exactly 16 budgets", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      { budgets: Array.from({ length: 16 }, (_, i) => entry(`b${i}`, 1, definition(10))) },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    expect(res.status, "16 budgets is exactly the documented maximum").toBe(200);
  });

  it("rejects duplicate budget ids rather than summing them", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("dup", 1, definition(10)), entry("dup", 2, definition(10))],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    expect(res.status).toBe(400);
  });

  it("rejects a zero or negative limit", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    for (const limit of [0, -1]) {
      const res = await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry("z", 1, definition(limit))],
        },
        { group, key: freshKey() },
      );
      expect(res.status, `limit ${limit}`).toBe(400);
    }
  });

  it("rejects a negative or non-finite amount", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const negative = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("n", -1, definition(10))],
      },
      { group, key: freshKey() },
    );
    const nonFinite = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [{ id: "n", amount: "1", definition: definition(10) }],
      },
      { group, key: freshKey() },
    );

    // Assert
    expect(negative.status, "a negative amount").toBe(400);
    expect(nonFinite.status, "a string amount").toBe(400);
  });

  it("allows a zero amount as a definition-only reconciliation", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("zero", 0, definition(10))],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    expect(res.status).toBe(200);
    expect((await readJson<{ budgets: { used: number }[] }>(res)).budgets[0]!.used).toBe(0);
  });

  it("requires an idempotency-key", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("k", 1, definition(10))],
      },
      { group: freshGroup() },
    );

    // Assert
    expect(res.status).toBe(400);
  });

  it("permits a draw exactly to the limit but not one past it", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const exact = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("edge", 100, definition(100))],
      },
      { group, key: freshKey() },
    );
    const past = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("edge", 1, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Assert
    expect(exact.status, "a draw landing exactly on the limit is allowed").toBe(200);
    expect(past.status, "one unit past an exhausted budget is denied").toBe(402);
  });
});
