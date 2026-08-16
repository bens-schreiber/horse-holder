/** The budget key is `(scope, tenant, group, id)`, and nothing less. */

import { beforeAll, describe, expect, it } from "vitest";

import {
  type Options,
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

/** Charges a fixed amount against one shared budget id and reports where usage landed. */
async function usedAfterCharge(on: Scope, options: Options): Promise<number> {
  const res = await on.charge(options, entry("build-minutes", 10, definition(1000)));
  return (await budgetsOf<{ used: number }>(res))[0]!.used;
}

describe("budget key isolation", () => {
  it("keeps the same budget id independent across groups", async () => {
    // Arrange
    const first = freshGroup();
    const second = freshGroup();

    // Assert
    expect(await usedAfterCharge(api, { group: first })).toBe(10);
    expect(
      await usedAfterCharge(api, { group: second }),
      "a second group shared the first's usage",
    ).toBe(10);
    expect(await usedAfterCharge(api, { group: first }), "the first group lost its own usage").toBe(
      20,
    );
  });

  it("keeps the same budget id independent across tenants", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    expect(await usedAfterCharge(api, { group, tenant: "acme" })).toBe(10);
    expect(
      await usedAfterCharge(api, { group, tenant: "globex" }),
      "a second tenant shared the first's usage",
    ).toBe(10);
    expect(
      await usedAfterCharge(api, { group, tenant: "acme" }),
      "the first tenant lost its own usage",
    ).toBe(20);
  });

  it("keeps the same budget id independent across scopes", async () => {
    // Arrange
    const other = await scope();
    const group = freshGroup();

    // Assert
    expect(await usedAfterCharge(api, { group })).toBe(10);
    expect(
      await usedAfterCharge(other, { group }),
      "a second scope naming the identical tenant, group, and budget interacted with the first",
    ).toBe(10);
  });

  it("distinguishes an absent hh-tenant from an empty one", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    expect(await usedAfterCharge(api, { group })).toBe(10);
    expect(
      await usedAfterCharge(api, { group, tenant: "" }),
      'the tenant named "" shared the default tenant\'s usage',
    ).toBe(10);
    expect(await usedAfterCharge(api, { group })).toBe(20);
    expect(await usedAfterCharge(api, { group, tenant: "" })).toBe(20);
  });

  it("rejects the delimiter-forgery case the charset exists to prevent", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const forgedTenant = await api.charge(
      { group, tenant: "a::b" },
      entry("build-minutes", 1, definition(10)),
    );
    const forgedId = await api.charge(
      { group, tenant: "a" },
      entry("build::minutes", 1, definition(10)),
    );

    // Assert
    expect(forgedTenant.status, 'the tenant "a::b" must be unrepresentable').toBe(400);
    expect(forgedId.status, 'the budget id "build::minutes" must be unrepresentable').toBe(400);
  });

  it("rejects budget ids outside [A-Za-z0-9_.-]{1,128}", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    for (const bad of ["has space", "sla/sh", "emoji-🐴", "a".repeat(129)]) {
      const res = await api.charge({ group }, entry(bad, 1, definition(10)));
      expect(res.status, `budget id ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it("rejects groups outside [A-Za-z0-9_.-]{1,128}", async () => {
    // Assert
    for (const bad of ["has space", "sla/sh", "a".repeat(129)]) {
      const res = await api.charge({ group: bad }, entry("build-minutes", 1, definition(10)));
      expect(res.status, `group ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it("accepts identifiers at the edges of the charset", async () => {
    // Act
    const res = await api.charge(
      { group: freshGroup() },
      entry("A-z_0.9", 1, definition(10)),
      entry("b".repeat(128), 1, definition(10)),
    );

    // Assert
    expect(res.status, "a legal identifier at the charset edge was rejected").toBe(200);
  });
});

describe("hh-group is mandatory", () => {
  it("rejects a draw with no hh-group", async () => {
    // Act
    const res = await api.fetch("/v1/charge", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "build-acme-1187" },
      body: JSON.stringify({ budgets: [entry("build-minutes", 1, definition(10))] }),
    });

    // Assert
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
  });

  it("rejects a read with no hh-group", async () => {
    // Act
    const res = await api.fetch("/v1/budget", { method: "GET" });

    // Assert
    expect(res.status).toBe(400);
  });
});
