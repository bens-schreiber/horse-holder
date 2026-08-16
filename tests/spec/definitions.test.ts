/** The inline definition model and its reconciliation rules. */

import { beforeAll, describe, expect, it } from "vitest";
import { definition, entry, freshGroup, freshKey, get, post, readJson } from "../client.ts";
import { harness } from "../harness.ts";

let auth: Record<string, string>;
beforeAll(async () => {
  auth = await harness.newScope();
});

describe("inline definitions", () => {
  it("creates a budget on first draw with no prior round trip", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("fresh", 5, definition(100))],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    expect(res.status, "an undeclared budget must be created by its first draw").toBe(200);
    expect((await readJson<{ budgets: { used: number }[] }>(res)).budgets[0]!.used).toBe(5);
  });
});

describe("reconciliation", () => {
  it("applies a raised limit immediately without resetting usage", async () => {
    // Arrange
    const group = freshGroup();
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 60, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 10, definition(200))],
      },
      { group, key: freshKey() },
    );

    // Assert
    const body = await readJson<{ budgets: { used: number; limit: number }[] }>(res);
    expect(body.budgets[0]!.used, "a limit nudge must not restore capacity").toBe(70);
    expect(body.budgets[0]!.limit).toBe(200);
  });

  it("exhausts a budget when the limit drops below current usage", async () => {
    // Arrange
    const group = freshGroup();
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 90, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 1, definition(50))],
      },
      { group, key: freshKey() },
    );

    // Assert
    expect(res.status, "lowering the limit below usage exhausts the budget").toBe(402);
    const body = await readJson<{ budgets: { used: number; remaining: number }[] }>(res);
    expect(body.budgets[0]!.used).toBe(90);
    expect(body.budgets[0]!.remaining, "remaining must clamp at zero").toBe(0);
  });

  it("moves renewsAt on a renewal change without refunding usage", async () => {
    // Arrange
    const group = freshGroup();
    const first = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 40, definition(100, { renewal: { type: "never" } }))],
      },
      { group, key: freshKey() },
    );
    const firstRenewsAt = (await readJson<{ budgets: { renewsAt: null }[] }>(first)).budgets[0]!
      .renewsAt;

    // Act
    const second = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [
          entry(
            "b",
            0,
            definition(100, {
              renewal: { type: "calendar", unit: "month", timezone: "UTC" },
            }),
          ),
        ],
      },
      { group, key: freshKey() },
    );
    // Assert
    const body = await readJson<{ budgets: { used: number; renewsAt: string }[] }>(second);
    expect(firstRenewsAt, "a never budget starts with no boundary").toBeNull();
    expect(body.budgets[0]!.used, "a renewal change must never refund consumed capacity").toBe(40);
    expect(
      body.budgets[0]!.renewsAt,
      "the new calendar renewal must set a boundary",
    ).not.toBeNull();
  });

  it("rejects an unrecognized definition field", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [{ id: "b", amount: 1, definition: { limitt: 100, renewal: { type: "never" } } }],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    expect(res.status, "a silently accepted `limitt` would enforce no limit at all").toBe(400);
  });

  it("rejects every unrecognized definition field, however it is named", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    for (const extra of [{ owner: "team-a" }, { "x-owner": "team-a" }, { limitt: 100 }]) {
      const res = await post(
        harness,
        auth,
        "/v1/charge",
        { budgets: [entry("b", 1, definition(100, extra))] },
        { group, key: freshKey() },
      );
      expect(
        res.status,
        `${JSON.stringify(extra)} must be rejected: no prefix is carved out as caller metadata`,
      ).toBe(400);
    }
  });

  it("rejects an unrecognized field on a budget entry", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [{ id: "b", amount: 1, definition: definition(10), extra: true }],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    expect(res.status).toBe(400);
  });
});

describe("drift between call sites", () => {
  it("takes last write wins while preserving usage across the flapping", async () => {
    // Arrange
    const group = freshGroup();
    for (const limit of [100, 200, 100, 200]) {
      await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry("b", 10, definition(limit))],
        },
        { group, key: freshKey() },
      );
    }

    // Act
    const res = await get(harness, auth, "/v1/budget", { group, headers: { "hh-budget-id": "b" } });

    // Assert
    const body = await readJson<{ budgets: { used: number; limit: number }[] }>(res);
    expect(body.budgets[0]!.used, "an oscillating limit must never give usage back").toBe(40);
    expect(body.budgets[0]!.limit, "the last definition written wins").toBe(200);
  });
});

describe("reconciliation precedes evaluation", () => {
  it("creates a budget named by a failing draw, with no usage applied", async () => {
    // Arrange
    const group = freshGroup();
    const denied = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("born-denied", 500, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Act
    const read = await get(harness, auth, "/v1/budget", {
      group,
      headers: { "hh-budget-id": "born-denied" },
    });

    // Assert
    expect(denied.status).toBe(402);
    expect(read.status, "reconciliation precedes evaluation, so the budget must exist").toBe(200);
    const body = await readJson<{ budgets: { used: number; limit: number }[] }>(read);
    expect(body.budgets[0]!.used, "a denied draw must apply no usage").toBe(0);
    expect(body.budgets[0]!.limit, "the definition is stored even on a denial").toBe(100);
  });

  it("applies a limit change from a draw that then fails", async () => {
    // Arrange
    const group = freshGroup();
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 50, definition(100))],
      },
      { group, key: freshKey() },
    );
    const denied = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 500, definition(200))],
      },
      { group, key: freshKey() },
    );

    // Act
    const read = await get(harness, auth, "/v1/budget", {
      group,
      headers: { "hh-budget-id": "b" },
    });

    // Assert
    expect(denied.status).toBe(402);
    const body = await readJson<{ budgets: { used: number; limit: number }[] }>(read);
    expect(body.budgets[0]!.limit, "the raised limit survives the denied draw").toBe(200);
    expect(body.budgets[0]!.used, "the denied draw applied no usage").toBe(50);
  });
});
