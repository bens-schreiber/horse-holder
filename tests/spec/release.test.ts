/** `POST /v1/release`: returning held capacity without spending it. */

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
  return (await readJson<{ reservationId: string }>(res)).reservationId;
}

function release(group: string, reservationId: string): Promise<Response> {
  return post(harness, auth, "/v1/release", undefined, {
    group,
    headers: { "hh-reservation-id": reservationId },
  });
}

async function used(group: string, id = "b"): Promise<number> {
  const res = await get(harness, auth, "/v1/budget", { group, headers: { "hh-budget-id": id } });
  return (await readJson<{ budgets: { used: number }[] }>(res)).budgets[0]!.used;
}

describe("release", () => {
  it("returns held capacity and reports post-release state", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [entry("b", 40, definition(100))]);

    // Act
    const res = await release(group, id);

    // Assert
    expect(res.status).toBe(200);
    const body = await readJson<{ budgets: { used: number; remaining: number }[] }>(res);
    expect(body.budgets[0]!.used).toBe(0);
    expect(body.budgets[0]!.remaining).toBe(100);
    expect(await used(group), "the hold survived the release").toBe(0);
  });

  it("releases every budget in a multi-budget reservation", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [
      entry("a", 10, definition(100)),
      entry("b", 20, definition(100)),
    ]);

    // Act
    await release(group, id);

    // Assert
    expect(await used(group, "a")).toBe(0);
    expect(await used(group, "b")).toBe(0);
  });

  it("returns 200 on a repeat release", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [entry("b", 40, definition(100))]);
    const first = await release(group, id);
    const firstBody = await readJson<unknown>(first);

    // Act
    const second = await release(group, id);

    // Assert
    expect(second.status, "a retried release must converge, not fail").toBe(200);
    expect(await readJson<unknown>(second), "the repeat release returned a different body").toEqual(
      firstBody,
    );
    expect(await used(group)).toBe(0);
  });

  it("returns 409 when the reservation was already committed", async () => {
    // Arrange
    const group = freshGroup();
    const id = await reserve(group, [entry("b", 40, definition(100))]);
    await post(harness, auth, "/v1/commit", undefined, {
      group,
      headers: { "hh-reservation-id": id },
    });

    // Act
    const res = await release(group, id);

    // Assert
    expect(res.status).toBe(409);
    expect((await readJson<{ error: { code: string } }>(res)).error.code).toBe(
      "reservation_settled",
    );
    expect(await used(group), "releasing a committed reservation refunded the spend").toBe(40);
  });

  it("returns 404 for an unknown or expired reservation", async () => {
    // Arrange
    const group = freshGroup();
    const expired = await reserve(group, [entry("b", 40, definition(100))], 1);
    await sleep(1100);

    // Assert
    expect((await release(group, "rsv_nope")).status, "an unknown reservation").toBe(404);
    expect((await release(group, expired)).status, "an expired reservation").toBe(404);
  });

  it("requires hh-reservation-id", async () => {
    const res = await post(harness, auth, "/v1/release", undefined, { group: freshGroup() });
    expect(res.status).toBe(400);
  });
});
