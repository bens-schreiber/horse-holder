/** `GET /v1/budget`: reading current state without drawing. */

import { beforeAll, describe, expect, it } from "vitest";

import { type Scope, budgetsOf, definition, entry, freshGroup, scope } from "../client.ts";

let api: Scope;
beforeAll(async () => {
  api = await scope();
});

describe("read", () => {
  it("omits requested, exceeded, and warningsCrossed", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge({ group }, entry("put-ops", 25, definition(100, { warnings: [0.1] })));

    // Act
    const res = await api.read({ group });

    // Assert
    expect(res.status).toBe(200);
    const entries = await budgetsOf(res);
    expect(entries, "one budget was drawn, so the group holds one").toHaveLength(1);
    expect(entries[0]).toEqual({
      id: "put-ops",
      limit: 100,
      used: 25,
      remaining: 75,
      renewsAt: null,
    });
  });

  it("returns every budget in the group, ordered by id", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge(
      { group },
      entry("storage-bytes", 1, definition(100)),
      entry("delete-ops", 2, definition(200)),
      entry("put-ops", 3, definition(300)),
    );

    // Act
    const res = await api.read({ group });

    // Assert
    expect(res.status).toBe(200);
    const entries = await budgetsOf<{ id: string; used: number }>(res);
    expect(
      entries.map((budget) => budget.id),
      "one request answers for the whole group, lexicographic by id",
    ).toEqual(["delete-ops", "put-ops", "storage-bytes"]);
    expect(entries.map((budget) => budget.used)).toEqual([2, 3, 1]);
  });

  it("reports every budget at the same instant", async () => {
    // Arrange: two budgets always drawn together.
    const group = freshGroup();
    const draw = [
      entry("put-ops", 1, definition(1000)),
      entry("storage-bytes", 100, definition(100000)),
    ] as const;
    await api.charge({ group }, ...draw);

    // Act: read while more draws land, which a per-budget read could tear across.
    const [read] = await Promise.all([api.read({ group }), api.charge({ group }, ...draw)]);

    // Assert: both entries describe the same number of applied draws, never a half-applied one.
    const entries = await budgetsOf<{ id: string; used: number }>(read!);
    const putOps = entries.find((budget) => budget.id === "put-ops")!.used;
    const storageBytes = entries.find((budget) => budget.id === "storage-bytes")!.used;
    expect(
      storageBytes,
      "a group read must not show a draw applied to one budget but not the other",
    ).toBe(putOps * 100);
  });

  it("does not draw", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge({ group }, entry("put-ops", 25, definition(100)));

    // Act
    await api.read({ group });
    await api.read({ group });
    const res = await api.read({ group });

    // Assert
    expect(
      (await budgetsOf<{ used: number }>(res))[0]!.used,
      "repeated reads consumed capacity",
    ).toBe(25);
  });

  it("returns an empty array before anything in the group has been drawn against", async () => {
    // Act
    const res = await api.read({ group: freshGroup() });

    // Assert
    expect(res.status, "an untouched group is an answer, not an error").toBe(200);
    expect(await budgetsOf(res)).toEqual([]);
  });

  it("honors hh-tenant", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge({ group, tenant: "acme" }, entry("put-ops", 25, definition(100)));

    // Act
    const acme = await api.read({ group, tenant: "acme" });
    const globex = await api.read({ group, tenant: "globex" });

    // Assert
    expect(await budgetsOf(acme)).toHaveLength(1);
    expect(await budgetsOf(globex), "globex read acme's budget").toEqual([]);
  });

  it("honors hh-group", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge({ group }, entry("put-ops", 25, definition(100)));

    // Act
    const other = await api.read({ group: freshGroup() });

    // Assert
    expect(await budgetsOf(other), "another group read this group's budget").toEqual([]);
  });

  it("reports a renewsAt for a renewing budget", async () => {
    // Arrange
    const group = freshGroup();
    const renewal = { type: "calendar", unit: "month" };
    await api.charge({ group }, entry("put-ops", 1, definition(100, { renewal })));

    // Act
    const res = await api.read({ group });

    // Assert
    const [budget] = await budgetsOf<{ renewsAt: string }>(res);
    expect(Date.parse(budget!.renewsAt), "renewsAt is not in the future").toBeGreaterThan(
      Date.now(),
    );
  });
});
