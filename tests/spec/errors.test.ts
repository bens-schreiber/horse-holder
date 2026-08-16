/** The error envelope, and the `402` body and headers of a failed draw. */

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
} from "../client.ts";

let api: Scope;
beforeAll(async () => {
  api = await scope();
});

describe("error format", () => {
  it("carries a code and a message on every non-2xx", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const responses = [
      await api.charge({ group }),
      await api.fetch("/v1/budget", { method: "GET" }),
      await api.commit({ group }, "rsv_nope"),
    ];

    // Assert
    for (const res of responses) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = await json<{ error: { code: string; message: string } }>(res);
      expect(typeof body.error.code, `${res.status} carried no error code`).toBe("string");
      expect(body.error.message.length, `${res.status} carried an empty message`).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("the 402 body", () => {
  it("carries budgets as a sibling of error, not nested inside it", async () => {
    // Act
    const res = await api.charge(
      { group: freshGroup() },
      entry("input-tokens", 500, definition(100)),
    );

    // Assert
    const body = await json<{ error: Record<string, unknown>; budgets: unknown[] }>(res);
    expect(
      Array.isArray(body.budgets),
      "a decoder reading `budgets` on a 200 must read the same field here",
    ).toBe(true);
    expect(
      body.error["budgets"],
      "`budgets` must not also be nested under `error`",
    ).toBeUndefined();
  });

  it("counts only the budgets the request named in the message", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge({ group }, entry("requests", 1, definition(100)));

    // Act
    const res = await api.charge({ group }, entry("input-tokens", 500, definition(100)));

    // Assert
    expect(res.status).toBe(402);
    const body = await json<{ error: { message: string }; budgets: unknown[] }>(res);
    expect(body.budgets, "the array still covers the whole group").toHaveLength(2);
    expect(
      body.error.message,
      "a budget the request never named did not participate in the failure",
    ).toBe("1 of 1 budgets lacked capacity");
  });

  it("uses the same shape and ordering as a 200, covering every budget in the group", async () => {
    // Act
    const res = await api.charge(
      { group: freshGroup() },
      entry("input-tokens", 1, definition(100)),
      entry("output-tokens", 500, definition(100)),
      entry("requests", 1, definition(100)),
    );

    // Assert
    expect(res.status).toBe(402);
    const entries = await budgetsOf(res);
    expect(
      entries.map((b) => b["id"]),
      "every budget in the group must appear, ordered by id",
    ).toEqual(["input-tokens", "output-tokens", "requests"]);
    for (const budget of entries) {
      expect(Object.keys(budget).sort(), `entry ${String(budget["id"])}`).toEqual([
        "exceeded",
        "id",
        "limit",
        "remaining",
        "renewsAt",
        "requested",
        "used",
        "warningsCrossed",
      ]);
    }
  });

  it("reports pre-draw used and remaining", async () => {
    // Arrange
    const group = freshGroup();
    await api.charge({ group }, entry("input-tokens", 40, definition(100)));

    // Act
    const res = await api.charge({ group }, entry("input-tokens", 90, definition(100)));

    // Assert
    const [budget] = await budgetsOf<{ used: number; remaining: number }>(res);
    expect(budget!.used, "the denied draw must not be counted into used").toBe(40);
    expect(budget!.remaining, "remaining must reflect state before the draw").toBe(60);
  });

  it("sends retry-after set to the earliest renewal among exceeded budgets", async () => {
    // Arrange
    const group = freshGroup();
    const renewal = { type: "interval", seconds: 3600 };
    await api.charge({ group }, entry("input-tokens", 100, definition(100, { renewal })));

    // Act
    const res = await api.charge({ group }, entry("input-tokens", 1, definition(100, { renewal })));

    // Assert
    expect(res.status).toBe(402);
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter), "retry-after must be whole seconds").toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);

    const [budget] = await budgetsOf<{ renewsAt: string }>(res);
    const expected = Math.ceil((Date.parse(budget!.renewsAt) - Date.now()) / 1000);
    expect(
      Math.abs(retryAfter - expected),
      "retry-after must agree with the renewsAt it is derived from",
    ).toBeLessThanOrEqual(1);
  });

  it("takes the earliest boundary when several budgets are exceeded", async () => {
    // Act
    const res = await api.charge(
      { group: freshGroup() },
      entry(
        "input-tokens",
        500,
        definition(100, { renewal: { type: "interval", seconds: 86_400 } }),
      ),
      entry("requests", 500, definition(100, { renewal: { type: "interval", seconds: 60 } })),
    );

    // Assert
    expect(res.status).toBe(402);
    expect(
      Number(res.headers.get("retry-after")),
      "retry-after must follow the soonest boundary, not the slowest",
    ).toBeLessThanOrEqual(60);
  });

  it("omits retry-after when every exceeded budget is never", async () => {
    // Act
    const res = await api.charge(
      { group: freshGroup() },
      entry("input-tokens", 500, definition(100)),
    );

    // Assert
    expect(res.status).toBe(402);
    expect(
      res.headers.get("retry-after"),
      "a never budget never frees capacity, so no wait can be advised",
    ).toBeNull();
  });

  it("ignores a never budget when a renewing one is also exceeded", async () => {
    // Act
    const res = await api.charge(
      { group: freshGroup() },
      entry("lifetime-tokens", 500, definition(100)),
      entry("input-tokens", 500, definition(100, { renewal: { type: "interval", seconds: 3600 } })),
    );

    // Assert
    expect(res.status).toBe(402);
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter, "the renewing budget still supplies a boundary").toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });
});

describe("routing", () => {
  it("rejects an unknown route and a wrong method", async () => {
    // Act
    const unknownRoute = await api.fetch("/v1/nope", {
      method: "GET",
      headers: { "hh-group": freshGroup() },
    });
    const wrongMethod = await api.fetch("/v1/charge", {
      method: "GET",
      headers: { "hh-group": freshGroup() },
    });

    // Assert
    expect(unknownRoute.status).toBe(404);
    expect(
      (await errorCode(unknownRoute)).length,
      "a routing error carries an implementation-chosen code, but it must not be empty",
    ).toBeGreaterThan(0);
    expect(wrongMethod.status, "GET on a POST-only route is a method error").toBe(405);
  });

  it("rejects a malformed JSON body with 400", async () => {
    // Act
    const res = await api.fetch("/v1/charge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "hh-group": freshGroup(),
        "idempotency-key": "chat-turn-51ac",
      },
      body: "{not json",
    });

    // Assert
    expect(res.status).toBe(400);
  });
});
