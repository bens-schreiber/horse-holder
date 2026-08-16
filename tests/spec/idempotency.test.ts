/** Deduplication on `(scope, tenant, group, endpoint, idempotency-key)`. */

import { beforeAll, describe, expect, it } from "vitest";

import {
  type Scope,
  budgetsOf,
  definition,
  entry,
  errorCode,
  freshGroup,
  freshKey,
  json,
  scope,
} from "../client.ts";

let api: Scope;
beforeAll(async () => {
  api = await scope();
});

describe("idempotency", () => {
  it("replays a completed charge with an identical status and body", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    const first = await api.charge({ group, key }, entry("events-processed", 30, definition(100)));
    const firstBody = await json<unknown>(first);

    // Act
    const replay = await api.charge({ group, key }, entry("events-processed", 30, definition(100)));

    // Assert
    expect(replay.status).toBe(first.status);
    expect(await json<unknown>(replay)).toEqual(firstBody);
    expect(
      await api.used({ group }, "events-processed"),
      "the replay must not apply the charge a second time",
    ).toBe(30);
  });

  it("replays the group as it stood when the request was first made", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    const first = await api.charge({ group, key }, entry("events-processed", 30, definition(100)));
    const firstBody = await json<unknown>(first);
    await api.charge({ group }, entry("fraud-checks", 5, definition(100)));

    // Act
    const replay = await api.charge({ group, key }, entry("events-processed", 30, definition(100)));

    // Assert
    expect(
      await json<unknown>(replay),
      "a replay must be byte-identical to the response it replays",
    ).toEqual(firstBody);
    const again = await api.charge({ group, key }, entry("events-processed", 30, definition(100)));
    expect(
      (await budgetsOf<{ id: string }>(again)).map((budget) => budget.id),
      "the replay picked up a budget the group gained after the fact",
    ).toEqual(["events-processed"]);
  });

  it("replays a reserve without creating a second hold", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    const first = await api.reserve({ group, key }, entry("events-processed", 30, definition(100)));
    const original = await json<{ reservationId: string }>(first);

    // Act
    const replay = await api.reserve(
      { group, key },
      entry("events-processed", 30, definition(100)),
    );

    // Assert
    expect(
      (await json<{ reservationId: string }>(replay)).reservationId,
      "the replay must return the original hold, not mint a new one",
    ).toBe(original.reservationId);
    expect(
      await api.used({ group }, "events-processed"),
      "a second hold would double the held amount",
    ).toBe(30);
  });

  it("rejects the same key with different amounts", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    await api.charge({ group, key }, entry("events-processed", 30, definition(100)));

    // Act
    const res = await api.charge({ group, key }, entry("events-processed", 31, definition(100)));

    // Assert
    expect(res.status, "replaying the original response here would drop a real charge").toBe(409);
    expect(await errorCode(res)).toBe("idempotency_conflict");
  });

  it("rejects the same key with a different set of budget ids", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    await api.charge({ group, key }, entry("events-processed", 30, definition(100)));

    // Act
    const res = await api.charge(
      { group, key },
      entry("events-processed", 30, definition(100)),
      entry("fraud-checks", 5, definition(100)),
    );

    // Assert
    expect(res.status, "an added budget id makes this a different request").toBe(409);
  });

  it("does not treat a changed definition alone as a different request", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    const first = await api.charge({ group, key }, entry("events-processed", 30, definition(100)));
    const firstBody = await json<unknown>(first);

    // Act
    const replay = await api.charge(
      { group, key },
      entry("events-processed", 30, definition(500, { warnings: [0.1] })),
    );

    // Assert
    expect(
      replay.status,
      "the definition is excluded from the comparison so a mid-flight limit change can retry",
    ).toBe(200);
    expect(await json<unknown>(replay)).toEqual(firstBody);
  });

  it("does not collide across groups", async () => {
    // Arrange
    const key = freshKey();
    const first = freshGroup();
    const second = freshGroup();
    await api.charge({ group: first, key }, entry("events-processed", 30, definition(100)));

    // Act
    const res = await api.charge(
      { group: second, key },
      entry("events-processed", 30, definition(100)),
    );

    // Assert
    expect(res.status, "the same key under two groups is two unrelated operations").toBe(200);
    expect(await api.used({ group: first }, "events-processed")).toBe(30);
    expect(await api.used({ group: second }, "events-processed")).toBe(30);
  });

  it("does not collide across tenants or endpoints", async () => {
    // Arrange
    const key = freshKey();
    const group = freshGroup();
    const budget = entry("events-processed", 30, definition(100));
    await api.charge({ group, key, tenant: "acme" }, budget);

    // Act
    const otherTenant = await api.charge({ group, key, tenant: "globex" }, budget);
    const otherEndpoint = await api.reserve({ group, key, tenant: "acme" }, budget);

    // Assert
    expect(otherTenant.status, "a second tenant is a separate idempotency scope").toBe(200);
    expect(otherEndpoint.status, "charge and reserve are separate idempotency scopes").toBe(200);
  });

  it("writes no record for a draw that failed with 402", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    await api.charge({ group }, entry("events-processed", 90, definition(100)));
    const denied = await api.charge({ group, key }, entry("events-processed", 50, definition(100)));

    // Act
    const retry = await api.charge({ group, key }, entry("events-processed", 50, definition(1000)));

    // Assert
    expect(denied.status).toBe(402);
    expect(retry.status, "a denial must not be recorded and replayed once capacity exists").toBe(
      200,
    );
    expect(await api.used({ group }, "events-processed")).toBe(140);
  });

  it("rejects a missing idempotency-key on both draw endpoints", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    for (const path of ["/v1/charge", "/v1/reserve"]) {
      const res = await api.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", "hh-group": group },
        body: JSON.stringify({ budgets: [entry("events-processed", 1, definition(100))] }),
      });
      expect(res.status, path).toBe(400);
    }
  });
});
