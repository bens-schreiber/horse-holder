/** Deduplication on `(scope, tenant, group, endpoint, idempotency-key)`. */

import { beforeAll, describe, expect, it } from "vitest";
import { definition, entry, freshGroup, freshKey, get, post, readJson } from "../client.ts";
import { harness } from "../harness.ts";

let auth: Record<string, string>;
beforeAll(async () => {
  auth = await harness.newScope();
});

async function used(group: string, id = "b"): Promise<number> {
  const res = await get(harness, auth, "/v1/budget", { group, headers: { "hh-budget-id": id } });
  return (await readJson<{ budgets: { used: number }[] }>(res)).budgets[0]!.used;
}

describe("idempotency", () => {
  it("replays a completed charge with an identical status and body", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    const body = { budgets: [entry("b", 30, definition(100))] };

    const first = await post(harness, auth, "/v1/charge", body, { group, key });
    const firstBody = await readJson<unknown>(first);

    // Act
    const replay = await post(harness, auth, "/v1/charge", body, { group, key });

    // Assert
    expect(replay.status).toBe(first.status);
    expect(await readJson<unknown>(replay)).toEqual(firstBody);
    expect(await used(group), "the replay must not apply the charge a second time").toBe(30);
  });

  it("replays a reserve without creating a second hold", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    const body = { budgets: [entry("b", 30, definition(100))] };
    const first = await post(harness, auth, "/v1/reserve", body, { group, key });
    const firstBody = await readJson<{ reservationId: string }>(first);

    // Act
    const replay = await post(harness, auth, "/v1/reserve", body, { group, key });

    // Assert
    expect(
      (await readJson<{ reservationId: string }>(replay)).reservationId,
      "the replay must return the original hold, not mint a new one",
    ).toBe(firstBody.reservationId);
    expect(await used(group), "a second hold would double the held amount").toBe(30);
  });

  it("rejects the same key with different amounts", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 30, definition(100))],
      },
      { group, key },
    );

    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 31, definition(100))],
      },
      { group, key },
    );

    // Assert
    expect(res.status, "replaying the original response here would drop a real charge").toBe(409);
    expect((await readJson<{ error: { code: string } }>(res)).error.code).toBe(
      "idempotency_conflict",
    );
  });

  it("rejects the same key with a different set of budget ids", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 30, definition(100))],
      },
      { group, key },
    );

    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 30, definition(100)), entry("c", 5, definition(100))],
      },
      { group, key },
    );

    // Assert
    expect(res.status, "an added budget id makes this a different request").toBe(409);
  });

  it("does not treat a changed definition alone as a different request", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    const first = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 30, definition(100))],
      },
      { group, key },
    );
    const firstBody = await readJson<unknown>(first);

    // Act
    const replay = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 30, definition(500, { warnings: [0.1] }))],
      },
      { group, key },
    );

    // Assert
    expect(
      replay.status,
      "the definition is excluded from the conflict comparison so a mid-flight limit change can retry",
    ).toBe(200);
    expect(await readJson<unknown>(replay)).toEqual(firstBody);
  });

  it("does not collide across groups", async () => {
    // Arrange
    const key = freshKey();
    const a = freshGroup();
    const b = freshGroup();
    const body = { budgets: [entry("b", 30, definition(100))] };
    await post(harness, auth, "/v1/charge", body, { group: a, key });

    // Act
    const second = await post(harness, auth, "/v1/charge", body, { group: b, key });

    // Assert
    expect(second.status, "the same key under two groups is two unrelated operations").toBe(200);
    expect(await used(a)).toBe(30);
    expect(await used(b)).toBe(30);
  });

  it("does not collide across tenants or endpoints", async () => {
    // Arrange
    const key = freshKey();
    const group = freshGroup();
    const body = { budgets: [entry("b", 30, definition(100))] };
    await post(harness, auth, "/v1/charge", body, { group, key, tenant: "alice" });

    // Act
    const otherTenant = await post(harness, auth, "/v1/charge", body, {
      group,
      key,
      tenant: "bob",
    });
    const otherEndpoint = await post(harness, auth, "/v1/reserve", body, {
      group,
      key,
      tenant: "alice",
    });

    // Assert
    expect(otherTenant.status, "a second tenant is a separate idempotency scope").toBe(200);
    expect(otherEndpoint.status, "charge and reserve are separate idempotency scopes").toBe(200);
  });

  it("writes no record for a draw that failed with 402", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 90, definition(100))],
      },
      { group, key: freshKey() },
    );
    const denied = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 50, definition(100))],
      },
      { group, key },
    );

    // Act
    const retry = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 50, definition(1000))],
      },
      { group, key },
    );

    // Assert
    expect(denied.status).toBe(402);
    expect(retry.status, "a denial must not be recorded and replayed once capacity exists").toBe(
      200,
    );
    expect(await used(group)).toBe(140);
  });

  it("rejects a missing idempotency-key on both draw endpoints", async () => {
    // Arrange
    const group = freshGroup();

    // Assert
    for (const path of ["/v1/charge", "/v1/reserve"]) {
      const res = await post(
        harness,
        auth,
        path,
        {
          budgets: [entry("b", 1, definition(100))],
        },
        { group },
      );
      expect(res.status, path).toBe(400);
    }
  });
});
