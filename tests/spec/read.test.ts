/** `GET /v1/budget`: reading current state without drawing. */

import { beforeAll, describe, expect, it } from "vitest";
import { definition, entry, freshGroup, freshKey, get, post, readJson } from "../client.ts";
import { harness } from "../harness.ts";

let auth: Record<string, string>;
beforeAll(async () => {
  auth = await harness.newScope();
});

describe("read", () => {
  it("returns a single-entry array omitting requested, exceeded, and warningsCrossed", async () => {
    // Arrange
    const group = freshGroup();
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 25, definition(100, { warnings: [0.1] }))],
      },
      { group, key: freshKey() },
    );

    // Act
    const res = await get(harness, auth, "/v1/budget", { group, headers: { "hh-budget-id": "b" } });

    // Assert
    expect(res.status).toBe(200);
    const body = await readJson<{ budgets: Record<string, unknown>[] }>(res);
    expect(body.budgets, "a read must answer with exactly the one budget requested").toHaveLength(
      1,
    );
    expect(body.budgets[0]).toEqual({
      id: "b",
      limit: 100,
      used: 25,
      remaining: 75,
      renewsAt: null,
    });
  });

  it("does not draw", async () => {
    // Arrange
    const group = freshGroup();
    const read = { group, headers: { "hh-budget-id": "b" } };
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 25, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Act
    for (let i = 0; i < 3; i += 1) {
      await get(harness, auth, "/v1/budget", read);
    }
    const res = await get(harness, auth, "/v1/budget", read);

    // Assert
    expect(
      (await readJson<{ budgets: { used: number }[] }>(res)).budgets[0]!.used,
      "repeated reads consumed capacity",
    ).toBe(25);
  });

  it("returns 404 before the budget has ever been drawn against", async () => {
    // Act
    const res = await get(harness, auth, "/v1/budget", {
      group: freshGroup(),
      headers: { "hh-budget-id": "never-drawn" },
    });

    // Assert
    expect(res.status, "budgets are created lazily, so an undrawn budget does not exist").toBe(404);
    expect((await readJson<{ error: { code: string } }>(res)).error.code).toBe("budget_not_found");
  });

  it("honors hh-tenant", async () => {
    // Arrange
    const group = freshGroup();
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 25, definition(100))],
      },
      { group, tenant: "alice", key: freshKey() },
    );

    // Act
    const alice = await get(harness, auth, "/v1/budget", {
      group,
      tenant: "alice",
      headers: { "hh-budget-id": "b" },
    });
    const bob = await get(harness, auth, "/v1/budget", {
      group,
      tenant: "bob",
      headers: { "hh-budget-id": "b" },
    });

    // Assert
    expect(alice.status).toBe(200);
    expect(bob.status, "bob read alice's budget").toBe(404);
  });

  it("honors hh-group", async () => {
    // Arrange
    const a = freshGroup();
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 25, definition(100))],
      },
      { group: a, key: freshKey() },
    );

    // Act
    const other = await get(harness, auth, "/v1/budget", {
      group: freshGroup(),
      headers: { "hh-budget-id": "b" },
    });

    // Assert
    expect(other.status, "another group read this group's budget").toBe(404);
  });

  it("reports a renewsAt for a renewing budget", async () => {
    // Arrange
    const group = freshGroup();
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 1, definition(100, { renewal: { type: "calendar", unit: "month" } }))],
      },
      { group, key: freshKey() },
    );

    // Act
    const res = await get(harness, auth, "/v1/budget", { group, headers: { "hh-budget-id": "b" } });

    // Assert
    const body = await readJson<{ budgets: { renewsAt: string }[] }>(res);
    expect(Date.parse(body.budgets[0]!.renewsAt), "renewsAt is not in the future").toBeGreaterThan(
      Date.now(),
    );
  });
});
