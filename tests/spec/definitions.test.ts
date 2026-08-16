/** The inline definition model and its reconciliation rules. */

import { beforeAll, describe, expect, it } from "vitest";

import { type Scope, budgetsOf, definition, entry, freshGroup, scope } from "../client.ts";

let api: Scope;
beforeAll(async () => {
  api = await scope();
});

describe("inline definitions", () => {
  it("creates a budget on first draw with no prior round trip", async () => {
    // Act
    const res = await api.charge({ group: freshGroup() }, entry("put-ops", 5, definition(100)));

    // Assert
    expect(res.status, "an undeclared budget must be created by its first draw").toBe(200);
    expect((await budgetsOf<{ used: number }>(res))[0]!.used).toBe(5);
  });
});

describe("reconciliation", () => {
  it("applies a raised limit immediately without resetting usage", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge({ group }, entry("put-ops", 60, definition(100)));

    // Act
    const res = await api.charge({ group }, entry("put-ops", 10, definition(200)));

    // Assert
    const [budget] = await budgetsOf<{ used: number; limit: number }>(res);
    expect(budget!.used, "a limit nudge must not restore capacity").toBe(70);
    expect(budget!.limit).toBe(200);
  });

  it("exhausts a budget when the limit drops below current usage", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge({ group }, entry("put-ops", 90, definition(100)));

    // Act
    const res = await api.charge({ group }, entry("put-ops", 1, definition(50)));

    // Assert
    expect(res.status, "lowering the limit below usage exhausts the budget").toBe(402);
    const [budget] = await budgetsOf<{ used: number; remaining: number }>(res);
    expect(budget!.used).toBe(90);
    expect(budget!.remaining, "remaining must clamp at zero").toBe(0);
  });

  it("moves renewsAt on a renewal change without refunding usage", async () => {
    // Arrange
    const group = freshGroup();
    const first = await api.charge(
      { group },
      entry("put-ops", 40, definition(100, { renewal: { type: "never" } })),
    );
    const before = (await budgetsOf<{ renewsAt: string | null }>(first))[0]!.renewsAt;

    // Act
    const calendar = { type: "calendar", unit: "month", timezone: "UTC" };
    const res = await api.charge(
      { group },
      entry("put-ops", 0, definition(100, { renewal: calendar })),
    );

    // Assert
    expect(before, "a never budget starts with no boundary").toBeNull();
    const [budget] = await budgetsOf<{ used: number; renewsAt: string | null }>(res);
    expect(budget!.used, "a renewal change must never refund consumed capacity").toBe(40);
    expect(budget!.renewsAt, "the new calendar renewal must set a boundary").not.toBeNull();
  });

  it("rejects every unrecognized definition field, however it is named", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    for (const extra of [{ owner: "team-a" }, { "x-owner": "team-a" }, { limitt: 100 }]) {
      const res = await api.charge({ group }, entry("put-ops", 1, definition(100, extra)));
      expect(
        res.status,
        `${JSON.stringify(extra)} must be rejected: no prefix is carved out as caller metadata`,
      ).toBe(400);
    }
  });

  it("rejects an unrecognized field on a budget entry", async () => {
    // Act
    const res = await api.charge({ group: freshGroup() }, {
      id: "put-ops",
      amount: 1,
      definition: definition(10),
      extra: true,
    } as never);

    // Assert
    expect(res.status).toBe(400);
  });
});

describe("drift between call sites", () => {
  it("takes last write wins while preserving usage across the flapping", async () => {
    // Arrange
    const group = freshGroup();
    for (const limit of [100, 200, 100, 200]) {
      await api.charge({ group }, entry("put-ops", 10, definition(limit)));
    }

    // Act
    const res = await api.read({ group });

    // Assert
    const [budget] = await budgetsOf<{ used: number; limit: number }>(res);
    expect(budget!.used, "an oscillating limit must never give usage back").toBe(40);
    expect(budget!.limit, "the last definition written wins").toBe(200);
  });
});

describe("reconciliation precedes evaluation", () => {
  it("creates a budget named by a failing draw, with no usage applied", async () => {
    // Arrange
    const group = freshGroup();
    const denied = await api.charge({ group }, entry("put-ops", 500, definition(100)));

    // Act
    const read = await api.read({ group });

    // Assert
    expect(denied.status).toBe(402);
    expect(read.status, "reconciliation precedes evaluation, so the budget must exist").toBe(200);
    const [budget] = await budgetsOf<{ used: number; limit: number }>(read);
    expect(budget!.used, "a denied draw must apply no usage").toBe(0);
    expect(budget!.limit, "the definition is stored even on a denial").toBe(100);
  });

  it("applies a limit change from a draw that then fails", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge({ group }, entry("put-ops", 50, definition(100)));
    const denied = await api.charge({ group }, entry("put-ops", 500, definition(200)));

    // Act
    const read = await api.read({ group });

    // Assert
    expect(denied.status).toBe(402);
    const [budget] = await budgetsOf<{ used: number; limit: number }>(read);
    expect(budget!.limit, "the raised limit survives the denied draw").toBe(200);
    expect(budget!.used, "the denied draw applied no usage").toBe(50);
  });
});
