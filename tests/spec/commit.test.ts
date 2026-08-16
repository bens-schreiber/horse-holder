/** `POST /v1/commit`: finalizing a reservation, optionally correcting amounts. */

import { beforeAll, describe, expect, it } from "vitest";
import { definition, entry, freshGroup, freshKey, get, post, readJson } from "../client.ts";
import { harness } from "../harness.ts";

let auth: Record<string, string>;
beforeAll(async () => {
  auth = await harness.newScope();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function reserve(
  group: string,
  budgets: Record<string, unknown>[],
  ttl?: number,
): Promise<string> {
  const res = await post(
    harness,
    auth,
    "/v1/reserve",
    { budgets },
    {
      group,
      key: freshKey(),
      ...(ttl === undefined ? {} : { ttl }),
    },
  );
  if (res.status !== 200) {
    throw new Error(`reserve failed: ${res.status}`);
  }
  return (await readJson<{ reservationId: string }>(res)).reservationId;
}

function commit(group: string, reservationId: string, body?: unknown): Promise<Response> {
  return post(harness, auth, "/v1/commit", body, {
    group,
    headers: { "hh-reservation-id": reservationId },
  });
}

async function used(group: string, id = "b"): Promise<number> {
  const res = await get(harness, auth, "/v1/budget", { group, headers: { "hh-budget-id": id } });
  return (await readJson<{ budgets: { used: number }[] }>(res)).budgets[0]!.used;
}

describe("commit", () => {
  it("converts a hold to a spend when the body is omitted", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [entry("b", 30, definition(100))]);

    // Act
    const res = await commit(group, id);

    // Assert
    expect(res.status).toBe(200);
    expect(await used(group), 'an omitted body means "the estimate was right", not "release"').toBe(
      30,
    );
  });

  it("commits omitted budgets at their reserved amount", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [
      entry("a", 10, definition(100)),
      entry("b", 20, definition(100)),
    ]);

    // Act
    await commit(group, id, { budgets: [{ id: "a", amount: 5 }] });

    // Assert
    expect(await used(group, "a")).toBe(5);
    expect(await used(group, "b"), "an unmentioned budget must settle at its reserved amount").toBe(
      20,
    );
  });

  it("returns the difference when the committed amount is lower", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [entry("b", 50, definition(100))]);

    // Act
    const res = await commit(group, id, { budgets: [{ id: "b", amount: 20 }] });

    // Assert
    const body = await readJson<{ budgets: { used: number; remaining: number }[] }>(res);
    expect(body.budgets[0]!.used).toBe(20);
    expect(body.budgets[0]!.remaining, "the unspent 30 was not returned").toBe(80);
  });

  it("draws the difference as a fresh charge when the amount is higher", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [entry("b", 20, definition(100))]);

    // Act
    const res = await commit(group, id, { budgets: [{ id: "b", amount: 60 }] });

    // Assert
    expect(res.status).toBe(200);
    expect(await used(group)).toBe(60);
  });

  it("fails with 402 and leaves the reservation open when an increase lacks capacity", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [entry("b", 20, definition(100))]);
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 70, definition(100))],
      },
      { group, key: freshKey() },
    );

    // Act
    const res = await commit(group, id, { budgets: [{ id: "b", amount: 40 }] });

    // Assert
    expect(res.status, "committing at 40 needs 20 more than the 10 available").toBe(402);
    expect(await used(group), "the failed commit was partially applied").toBe(90);

    const retry = await commit(group, id, { budgets: [{ id: "b", amount: 15 }] });
    expect(retry.status, "the reservation must stay open and committable at a lower amount").toBe(
      200,
    );
    expect(await used(group)).toBe(85);
  });

  it("fails atomically when one of several increases lacks capacity", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [
      entry("a", 10, definition(100)),
      entry("b", 10, definition(100)),
    ]);

    // Act
    const res = await commit(group, id, {
      budgets: [
        { id: "a", amount: 50 },
        { id: "b", amount: 500 },
      ],
    });

    // Assert
    expect(res.status).toBe(402);
    expect(await used(group, "a"), "`a` had room, but a commit must not be partially applied").toBe(
      10,
    );
    expect(await used(group, "b")).toBe(10);
  });

  it("rejects a budget id absent from the original reservation", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [entry("b", 10, definition(100))]);

    // Act
    const res = await commit(group, id, { budgets: [{ id: "unknown", amount: 5 }] });

    // Assert
    expect(res.status, "that would be a draw with no capacity check behind it").toBe(400);
  });

  it("replays the original result on a repeat commit, ignoring new amounts", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [entry("b", 30, definition(100))]);
    const first = await commit(group, id, { budgets: [{ id: "b", amount: 25 }] });
    const firstBody = await readJson<unknown>(first);

    // Act
    const second = await commit(group, id, { budgets: [{ id: "b", amount: 99 }] });

    // Assert
    expect(second.status).toBe(200);
    expect(
      await readJson<unknown>(second),
      "the repeat commit did not replay the original",
    ).toEqual(firstBody);
    expect(await used(group), "the repeat commit's new amount was applied").toBe(25);
  });

  it("returns 404 for an unknown reservation", async () => {
    // Act
    const res = await commit(freshGroup(), "rsv_does_not_exist");

    // Assert
    expect(res.status).toBe(404);
    expect((await readJson<{ error: { code: string } }>(res)).error.code).toBe(
      "reservation_not_found",
    );
  });

  it("returns 404 for an expired reservation, not 410", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [entry("b", 30, definition(100))], 1);
    await sleep(1100);

    // Act
    const res = await commit(group, id);

    // Assert
    expect(res.status, "an expired reservation is gone, so the caller should start over").toBe(404);
    expect(await used(group), "the expired hold was not returned").toBe(0);
  });

  it("returns 409 when the reservation was already released", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [entry("b", 30, definition(100))]);
    await post(harness, auth, "/v1/release", undefined, {
      group,
      headers: { "hh-reservation-id": id },
    });

    // Act
    const res = await commit(group, id);

    // Assert
    expect(res.status).toBe(409);
    expect((await readJson<{ error: { code: string } }>(res)).error.code).toBe(
      "reservation_settled",
    );
  });

  it("requires hh-reservation-id", async () => {
    const res = await post(harness, auth, "/v1/commit", undefined, { group: freshGroup() });
    expect(res.status).toBe(400);
  });

  it("reports warningsCrossed on a successful commit", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [entry("b", 10, definition(100, { warnings: [0.5] }))]);

    // Act
    const res = await commit(group, id, { budgets: [{ id: "b", amount: 60 }] });

    // Assert
    const body = await readJson<{ budgets: { warningsCrossed: number[] }[] }>(res);
    expect(
      body.budgets[0]!.warningsCrossed,
      "a commit raising usage past a threshold must report it",
    ).toEqual([0.5]);
  });
});
