/** The budget key is `(scope, tenant, group, id)`, and nothing less. */

import { beforeAll, describe, expect, it } from "vitest";
import { definition, entry, freshGroup, freshKey, get, post, readJson } from "../client.ts";
import { harness } from "../harness.ts";

let auth: Record<string, string>;
beforeAll(async () => {
  auth = await harness.newScope();
});

async function usedAfterCharge(
  authHeaders: Record<string, string>,
  options: { group: string; tenant?: string },
): Promise<number> {
  const res = await post(
    harness,
    authHeaders,
    "/v1/charge",
    {
      budgets: [entry("shared-id", 10, definition(1000))],
    },
    { ...options, key: freshKey() },
  );
  const body = await readJson<{ budgets: { used: number }[] }>(res);
  return body.budgets[0]!.used;
}

describe("budget key isolation", () => {
  it("keeps the same budget id independent across groups", async () => {
    // Arrange
    const a = freshGroup();
    const b = freshGroup();

    // Assert
    expect(await usedAfterCharge(auth, { group: a })).toBe(10);
    expect(
      await usedAfterCharge(auth, { group: b }),
      "a second group shared the first's usage",
    ).toBe(10);
    expect(await usedAfterCharge(auth, { group: a }), "the first group lost its own usage").toBe(
      20,
    );
  });

  it("keeps the same budget id independent across tenants", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    expect(await usedAfterCharge(auth, { group, tenant: "alice" })).toBe(10);
    expect(
      await usedAfterCharge(auth, { group, tenant: "bob" }),
      "a second tenant shared the first's usage",
    ).toBe(10);
    expect(
      await usedAfterCharge(auth, { group, tenant: "alice" }),
      "the first tenant lost its own usage",
    ).toBe(20);
  });

  it("keeps the same budget id independent across scopes", async () => {
    // Arrange
    const other = await harness.newScope();
    const group = freshGroup();

    // Assert
    expect(await usedAfterCharge(auth, { group })).toBe(10);
    expect(
      await usedAfterCharge(other, { group }),
      "a second scope naming the identical tenant, group, and budget interacted with the first",
    ).toBe(10);
  });

  it("distinguishes an absent hh-tenant from an empty one", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    expect(await usedAfterCharge(auth, { group })).toBe(10);
    expect(
      await usedAfterCharge(auth, { group, tenant: "" }),
      'the tenant named "" shared the default tenant\'s usage',
    ).toBe(10);
    expect(await usedAfterCharge(auth, { group })).toBe(20);
    expect(await usedAfterCharge(auth, { group, tenant: "" })).toBe(20);
  });

  it("rejects the delimiter-forgery case the charset exists to prevent", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const forgedTenant = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("c", 1, definition(10))],
      },
      { group, tenant: "a::b", key: freshKey() },
    );
    const forgedId = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b::c", 1, definition(10))],
      },
      { group, tenant: "a", key: freshKey() },
    );

    // Assert
    expect(forgedTenant.status, 'the tenant "a::b" must be unrepresentable').toBe(400);
    expect(forgedId.status, 'the budget id "b::c" must be unrepresentable').toBe(400);
  });

  it("rejects budget ids outside [A-Za-z0-9_.-]{1,128}", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    for (const bad of ["has space", "sla/sh", "emoji-🐴", "a".repeat(129)]) {
      const res = await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry(bad, 1, definition(10))],
        },
        { group, key: freshKey() },
      );
      expect(res.status, `budget id ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it("rejects groups outside [A-Za-z0-9_.-]{1,128}", async () => {
    // Assert
    for (const bad of ["has space", "sla/sh", "a".repeat(129)]) {
      const res = await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry("ok", 1, definition(10))],
        },
        { group: bad, key: freshKey() },
      );
      expect(res.status, `group ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it("accepts identifiers at the edges of the charset", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("A-z_0.9", 1, definition(10)), entry("b".repeat(128), 1, definition(10))],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    expect(res.status, "a legal identifier at the charset edge was rejected").toBe(200);
  });
});

describe("hh-group is mandatory", () => {
  it("rejects a draw with no hh-group", async () => {
    // Act
    const res = await harness.fetch("/v1/charge", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "idempotency-key": freshKey() },
      body: JSON.stringify({ budgets: [entry("x", 1, definition(10))] }),
    });

    // Assert
    expect(res.status).toBe(400);
    expect((await readJson<{ error: { code: string } }>(res)).error.code).toBe("invalid_request");
  });

  it("rejects a read with no hh-group", async () => {
    // Act
    const res = await harness.fetch("/v1/budget", {
      method: "GET",
      headers: { ...auth, "hh-budget-id": "x" },
    });

    // Assert
    expect(res.status).toBe(400);
  });

  it("requires hh-budget-id on a read", async () => {
    const res = await get(harness, auth, "/v1/budget", { group: freshGroup() });
    expect(res.status).toBe(400);
  });
});
