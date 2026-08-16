/** `POST /v1/reserve`: time-bounded holds on capacity. */

import { beforeAll, describe, expect, it } from "vitest";

import {
  type Scope,
  budgetsOf,
  definition,
  entry,
  errorCode,
  freshGroup,
  json,
  scope,
  sleep,
} from "../client.ts";

let api: Scope;
beforeAll(async () => {
  api = await scope();
});

describe("reserve", () => {
  it("returns a reservation id, an expiry, and the charge budget shape", async () => {
    // Act
    const res = await api.reserve(
      { group: freshGroup() },
      entry("encoder-seconds", 30, definition(100)),
    );

    // Assert
    expect(res.status).toBe(200);
    const body = await json<{ reservationId: string; expiresAt: string }>(res.clone());
    expect(typeof body.reservationId).toBe("string");
    expect(body.reservationId.length).toBeGreaterThan(0);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect((await budgetsOf(res))[0]).toMatchObject({
      id: "encoder-seconds",
      requested: 30,
      exceeded: false,
      used: 30,
    });
  });

  it("counts held amounts toward used immediately", async () => {
    // Arrange
    const group = freshGroup();
    await api.reserve({ group }, entry("encoder-seconds", 40, definition(100)));

    // Act
    const res = await api.read({ group });

    // Assert
    const [budget] = await budgetsOf<{ used: number; remaining: number }>(res);
    expect(budget!.used, "a hold must count toward used the moment it is taken").toBe(40);
    expect(budget!.remaining).toBe(60);
  });

  it("blocks a later draw that would exceed the limit with a hold outstanding", async () => {
    // Arrange
    const group = freshGroup();
    await api.reserve({ group }, entry("encoder-seconds", 80, definition(100)));

    // Act
    const res = await api.charge({ group }, entry("encoder-seconds", 30, definition(100)));

    // Assert
    expect(res.status, "30 on top of an 80 hold against a limit of 100 must be denied").toBe(402);
  });

  it("fails identically to a charge when capacity is short", async () => {
    // Act
    const res = await api.reserve(
      { group: freshGroup() },
      entry("encoder-seconds", 200, definition(100)),
    );

    // Assert
    expect(res.status).toBe(402);
    expect(await errorCode(res.clone())).toBe("budget_exceeded");
    expect((await budgetsOf<{ exceeded: boolean }>(res))[0]!.exceeded).toBe(true);
  });

  it("returns held capacity when the reservation expires", async () => {
    // Arrange
    const group = freshGroup();
    await api.reserve({ group, ttl: 1 }, entry("encoder-seconds", 90, definition(100)));
    await sleep(1100);

    // Act
    const res = await api.charge({ group }, entry("encoder-seconds", 90, definition(100)));

    // Assert
    expect(res.status, "the expired hold must not still be reserving capacity").toBe(200);
    expect((await budgetsOf<{ used: number }>(res))[0]!.used).toBe(90);
  });

  it("honors hh-ttl-seconds and rejects values outside the supported range", async () => {
    // Act
    const res = await api.reserve(
      { group: freshGroup(), ttl: 86_400 },
      entry("encoder-seconds", 1, definition(100)),
    );

    // Assert
    expect(res.status).toBe(200);
    const { expiresAt } = await json<{ expiresAt: string }>(res);
    expect(
      Date.parse(expiresAt) - Date.now(),
      "a ttl of 86400 must be honored, not clamped down",
    ).toBeGreaterThan(86_000_000);

    for (const ttl of [0, -1, 1.5]) {
      const bad = await api.reserve(
        { group: freshGroup(), ttl },
        entry("encoder-seconds", 1, definition(100)),
      );
      expect(bad.status, `ttl ${ttl}`).toBe(400);
    }
  });
});

describe("renewal with open holds", () => {
  it("resets usage to the sum of open holds, not to zero", async () => {
    // Arrange
    const group = freshGroup();
    const renewal = { type: "interval", seconds: 1 };
    await api.reserve(
      { group, ttl: 300 },
      entry("encoder-seconds", 30, definition(100, { renewal })),
    );
    await api.charge({ group }, entry("encoder-seconds", 50, definition(100, { renewal })));
    await sleep(1100);

    // Act
    const res = await api.read({ group });

    // Assert
    expect(
      (await budgetsOf<{ used: number }>(res))[0]!.used,
      "the charge renews away but the still-open hold carries across the boundary",
    ).toBe(30);
  });
});
