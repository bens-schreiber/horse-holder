/** `POST /v1/reserve`: time-bounded holds on capacity. */

import { beforeAll, describe, expect, it } from "vitest";
import { definition, entry, freshGroup, freshKey, get, post, readJson } from "../client.ts";
import { harness } from "../harness.ts";

let auth: Record<string, string>;
beforeAll(async () => {
  auth = await harness.newScope();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("reserve", () => {
  it("returns a reservation id, an expiry, and the charge budget shape", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/reserve",
      {
        budgets: [entry("b", 30, definition(100))],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    expect(res.status).toBe(200);
    const body = await readJson<{
      reservationId: string;
      expiresAt: string;
      budgets: Record<string, unknown>[];
    }>(res);
    expect(typeof body.reservationId).toBe("string");
    expect(body.reservationId.length).toBeGreaterThan(0);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(body.budgets[0]).toMatchObject({ id: "b", requested: 30, exceeded: false, used: 30 });
  });

  it("counts held amounts toward used immediately", async () => {
    // Arrange
    const group = freshGroup();
    await post(
      harness,
      auth,
      "/v1/reserve",
      {
        budgets: [entry("b", 40, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Act
    const read = await get(harness, auth, "/v1/budget", {
      group,
      headers: { "hh-budget-id": "b" },
    });

    // Assert
    const body = await readJson<{ budgets: { used: number; remaining: number }[] }>(read);
    expect(body.budgets[0]!.used, "a hold must count toward used the moment it is taken").toBe(40);
    expect(body.budgets[0]!.remaining).toBe(60);
  });

  it("blocks a later draw that would exceed the limit with a hold outstanding", async () => {
    // Arrange
    const group = freshGroup();
    await post(
      harness,
      auth,
      "/v1/reserve",
      {
        budgets: [entry("b", 80, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 30, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Assert
    expect(res.status, "30 on top of an 80 hold against a limit of 100 must be denied").toBe(402);
  });

  it("fails identically to a charge when capacity is short", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/reserve",
      {
        budgets: [entry("b", 200, definition(100))],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    expect(res.status).toBe(402);
    const body = await readJson<{ error: { code: string }; budgets: { exceeded: boolean }[] }>(res);
    expect(body.error.code).toBe("budget_exceeded");
    expect(body.budgets[0]!.exceeded).toBe(true);
  });

  it("returns held capacity when the reservation expires", async () => {
    // Arrange
    const group = freshGroup();
    await post(
      harness,
      auth,
      "/v1/reserve",
      {
        budgets: [entry("b", 90, definition(100))],
      },
      { group, key: freshKey(), ttl: 1 },
    );
    await sleep(1100);

    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 90, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Assert
    expect(res.status, "the expired hold must not still be reserving capacity").toBe(200);
    expect((await readJson<{ budgets: { used: number }[] }>(res)).budgets[0]!.used).toBe(90);
  });

  it("honors hh-ttl-seconds and rejects values outside the supported range", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/reserve",
      {
        budgets: [entry("b", 1, definition(100))],
      },
      { group: freshGroup(), key: freshKey(), ttl: 86_400 },
    );

    // Assert
    expect(res.status).toBe(200);
    const { expiresAt } = await readJson<{ expiresAt: string }>(res);
    expect(
      Date.parse(expiresAt) - Date.now(),
      "a ttl of 86400 must be honored, not clamped down",
    ).toBeGreaterThan(86_000_000);

    for (const ttl of [0, -1, 1.5]) {
      const bad = await post(
        harness,
        auth,
        "/v1/reserve",
        {
          budgets: [entry("b", 1, definition(100))],
        },
        { group: freshGroup(), key: freshKey(), ttl },
      );
      expect(bad.status, `ttl ${ttl}`).toBe(400);
    }
  });

  it("applies a default TTL when hh-ttl-seconds is absent", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/reserve",
      {
        budgets: [entry("b", 1, definition(100))],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    const { expiresAt } = await readJson<{ expiresAt: string }>(res);
    expect(
      Date.parse(expiresAt),
      "an absent ttl header must still produce a future expiry",
    ).toBeGreaterThan(Date.now());
  });
});

describe("renewal with open holds", () => {
  it("resets usage to the sum of open holds, not to zero", async () => {
    // Arrange
    const group = freshGroup();
    const renewal = { type: "interval", seconds: 1 };
    await post(
      harness,
      auth,
      "/v1/reserve",
      {
        budgets: [entry("b", 30, definition(100, { renewal }))],
      },
      { group, key: freshKey(), ttl: 300 },
    );
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 50, definition(100, { renewal }))],
      },
      { group, key: freshKey() },
    );
    await sleep(1100);

    // Act
    const read = await get(harness, auth, "/v1/budget", {
      group,
      headers: { "hh-budget-id": "b" },
    });

    // Assert
    const body = await readJson<{ budgets: { used: number }[] }>(read);
    expect(
      body.budgets[0]!.used,
      "the charge renews away but the still-open hold carries across the boundary",
    ).toBe(30);
  });
});
