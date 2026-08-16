/** `POST /v1/commit`: finalizing a reservation, optionally correcting amounts. */

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

describe("commit", () => {
  it("converts a hold to a spend when the body is omitted", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold({ group }, entry("encoder-seconds", 30, definition(100)));

    // Act
    const res = await api.commit({ group }, id);

    // Assert
    expect(res.status).toBe(200);
    expect(
      await api.used({ group }, "encoder-seconds"),
      'an omitted body means "the estimate was right", not "release"',
    ).toBe(30);
  });

  it("commits omitted budgets at their reserved amount", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold(
      { group },
      entry("encoder-seconds", 10, definition(100)),
      entry("output-megabytes", 20, definition(100)),
    );

    // Act
    await api.commit({ group }, id, { budgets: [{ id: "encoder-seconds", amount: 5 }] });

    // Assert
    expect(await api.used({ group }, "encoder-seconds")).toBe(5);
    expect(
      await api.used({ group }, "output-megabytes"),
      "an unmentioned budget must settle at its reserved amount",
    ).toBe(20);
  });

  it("returns the difference when the committed amount is lower", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold({ group }, entry("encoder-seconds", 50, definition(100)));

    // Act
    const res = await api.commit({ group }, id, {
      budgets: [{ id: "encoder-seconds", amount: 20 }],
    });

    // Assert
    const [budget] = await budgetsOf<{ used: number; remaining: number }>(res);
    expect(budget!.used).toBe(20);
    expect(budget!.remaining, "the unspent 30 was not returned").toBe(80);
  });

  it("draws the difference as a fresh charge when the amount is higher", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold({ group }, entry("encoder-seconds", 20, definition(100)));

    // Act
    const res = await api.commit({ group }, id, {
      budgets: [{ id: "encoder-seconds", amount: 60 }],
    });

    // Assert
    expect(res.status).toBe(200);
    expect(await api.used({ group }, "encoder-seconds")).toBe(60);
  });

  it("fails with 402 and leaves the reservation open when an increase lacks capacity", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold({ group }, entry("encoder-seconds", 20, definition(100)));
    await api.charge({ group }, entry("encoder-seconds", 70, definition(100)));

    // Act
    const res = await api.commit({ group }, id, {
      budgets: [{ id: "encoder-seconds", amount: 40 }],
    });

    // Assert
    expect(res.status, "committing at 40 needs 20 more than the 10 available").toBe(402);
    expect(await api.used({ group }, "encoder-seconds"), "the failed commit was applied").toBe(90);

    const retry = await api.commit({ group }, id, {
      budgets: [{ id: "encoder-seconds", amount: 15 }],
    });
    expect(retry.status, "the reservation must stay open and committable at a lower amount").toBe(
      200,
    );
    expect(await api.used({ group }, "encoder-seconds")).toBe(85);
  });

  it("fails atomically when one of several increases lacks capacity", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold(
      { group },
      entry("encoder-seconds", 10, definition(100)),
      entry("output-megabytes", 10, definition(100)),
    );

    // Act
    const res = await api.commit({ group }, id, {
      budgets: [
        { id: "encoder-seconds", amount: 50 },
        { id: "output-megabytes", amount: 500 },
      ],
    });

    // Assert
    expect(res.status).toBe(402);
    expect(
      await api.used({ group }, "encoder-seconds"),
      "it had room, but a commit must not be partially applied",
    ).toBe(10);
    expect(await api.used({ group }, "output-megabytes")).toBe(10);
  });

  it("rejects a budget id absent from the original reservation", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold({ group }, entry("encoder-seconds", 10, definition(100)));

    // Act
    const res = await api.commit({ group }, id, { budgets: [{ id: "storage-bytes", amount: 5 }] });

    // Assert
    expect(res.status, "that would be a draw with no capacity check behind it").toBe(400);
  });

  it("replays the original result on a repeat commit, ignoring new amounts", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold({ group }, entry("encoder-seconds", 30, definition(100)));
    const first = await api.commit({ group }, id, {
      budgets: [{ id: "encoder-seconds", amount: 25 }],
    });
    const firstBody = await json<unknown>(first);

    // Act
    const second = await api.commit({ group }, id, {
      budgets: [{ id: "encoder-seconds", amount: 99 }],
    });

    // Assert
    expect(second.status).toBe(200);
    expect(await json<unknown>(second), "the repeat commit did not replay the original").toEqual(
      firstBody,
    );
    expect(
      await api.used({ group }, "encoder-seconds"),
      "the repeat commit's new amount was applied",
    ).toBe(25);
  });

  it("returns 404 for an unknown reservation", async () => {
    // Act
    const res = await api.commit({ group: freshGroup() }, "rsv_does_not_exist");

    // Assert
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("reservation_not_found");
  });

  it("returns 404 for an expired reservation, not 410", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold({ group, ttl: 1 }, entry("encoder-seconds", 30, definition(100)));
    await sleep(1100);

    // Act
    const res = await api.commit({ group }, id);

    // Assert
    expect(res.status, "an expired reservation is gone, so the caller should start over").toBe(404);
    expect(await api.used({ group }, "encoder-seconds"), "the expired hold was not returned").toBe(
      0,
    );
  });

  it("returns 409 when the reservation was already released", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold({ group }, entry("encoder-seconds", 30, definition(100)));
    await api.release({ group }, id);

    // Act
    const res = await api.commit({ group }, id);

    // Assert
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("reservation_settled");
  });

  it("requires hh-reservation-id", async () => {
    const res = await api.fetch("/v1/commit", {
      method: "POST",
      headers: { "hh-group": freshGroup() },
    });
    expect(res.status).toBe(400);
  });

  it("reports warningsCrossed on a successful commit", async () => {
    // Arrange
    const group = freshGroup();
    const id = await api.hold(
      { group },
      entry("encoder-seconds", 10, definition(100, { warnings: [0.5] })),
    );

    // Act
    const res = await api.commit({ group }, id, {
      budgets: [{ id: "encoder-seconds", amount: 60 }],
    });

    // Assert
    const [budget] = await budgetsOf<{ warningsCrossed: number[] }>(res);
    expect(
      budget!.warningsCrossed,
      "a commit raising usage past a threshold must report it",
    ).toEqual([0.5]);
  });
});
