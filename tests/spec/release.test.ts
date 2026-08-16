/** `POST /v1/release`: returning held capacity without spending it. */

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

describe("release", () => {
  it("returns held capacity and reports post-release state", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold({ group }, entry("messages-sent", 40, definition(100)));

    // Act
    const res = await api.release({ group }, id);

    // Assert
    expect(res.status).toBe(200);
    const [budget] = await budgetsOf<{ used: number; remaining: number }>(res);
    expect(budget!.used).toBe(0);
    expect(budget!.remaining).toBe(100);
    expect(await api.used({ group }, "messages-sent"), "the hold survived the release").toBe(0);
  });

  it("releases every budget in a multi-budget reservation", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold(
      { group },
      entry("messages-sent", 10, definition(100)),
      entry("attachment-bytes", 20, definition(100)),
    );

    // Act
    await api.release({ group }, id);

    // Assert
    expect(await api.used({ group }, "messages-sent")).toBe(0);
    expect(await api.used({ group }, "attachment-bytes")).toBe(0);
  });

  it("returns 200 on a repeat release", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold({ group }, entry("messages-sent", 40, definition(100)));
    const firstBody = await json<unknown>(await api.release({ group }, id));

    // Act
    const second = await api.release({ group }, id);

    // Assert
    expect(second.status, "a retried release must converge, not fail").toBe(200);
    expect(await json<unknown>(second), "the repeat release returned a different body").toEqual(
      firstBody,
    );
    expect(await api.used({ group }, "messages-sent")).toBe(0);
  });

  it("returns 409 when the reservation was already committed", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold({ group }, entry("messages-sent", 40, definition(100)));
    await api.commit({ group }, id);

    // Act
    const res = await api.release({ group }, id);

    // Assert
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("reservation_settled");
    expect(
      await api.used({ group }, "messages-sent"),
      "releasing a committed reservation refunded the spend",
    ).toBe(40);
  });

  it("returns 404 for an unknown or expired reservation", async () => {
    // Arrange
    const group = freshGroup();
    const expired = await api.hold({ group, ttl: 1 }, entry("messages-sent", 40, definition(100)));
    await sleep(1100);

    // Assert
    expect((await api.release({ group }, "rsv_nope")).status, "an unknown reservation").toBe(404);
    expect((await api.release({ group }, expired)).status, "an expired reservation").toBe(404);
  });

  it("requires hh-reservation-id", async () => {
    const res = await api.fetch("/v1/release", {
      method: "POST",
      headers: { "hh-group": freshGroup() },
    });
    expect(res.status).toBe(400);
  });
});
