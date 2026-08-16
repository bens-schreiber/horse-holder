/** The error envelope, and the `402` body and headers of a failed draw. */

import { beforeAll, describe, expect, it } from "vitest";
import { definition, entry, freshGroup, freshKey, get, post, readJson } from "../client.ts";
import { harness } from "../harness.ts";

let auth: Record<string, string>;
beforeAll(async () => {
  auth = await harness.newScope();
});

describe("error format", () => {
  it("carries a code and a message on every non-2xx", async () => {
    // Arrange
    const group = freshGroup();

    // Act
    const responses = [
      await post(harness, auth, "/v1/charge", { budgets: [] }, { group, key: freshKey() }),
      await get(harness, auth, "/v1/budget", { group, headers: { "hh-budget-id": "nope" } }),
      await post(harness, auth, "/v1/commit", undefined, {
        group,
        headers: { "hh-reservation-id": "rsv_nope" },
      }),
    ];

    // Assert
    for (const res of responses) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = await readJson<{ error: { code: string; message: string } }>(res);
      expect(typeof body.error.code, `${res.status} carried no error code`).toBe("string");
      expect(typeof body.error.message, `${res.status} carried no error message`).toBe("string");
      expect(body.error.message.length, `${res.status} carried an empty message`).toBeGreaterThan(
        0,
      );
    }
  });

  it("reaches each documented status and code", async () => {
    // Arrange
    const group = freshGroup();

    // Case: invalid_request
    {
      // Act
      const res = await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry("b", -1, definition(100))],
        },
        { group, key: freshKey() },
      );

      // Assert
      expect([res.status, (await readJson<{ error: { code: string } }>(res)).error.code]).toEqual([
        400,
        "invalid_request",
      ]);
    }

    // Case: unauthenticated
    {
      // Act
      const res = await harness.fetch("/v1/budget", {
        method: "GET",
        headers: { "hh-group": group, "hh-budget-id": "b" },
      });

      // Assert
      expect([res.status, (await readJson<{ error: { code: string } }>(res)).error.code]).toEqual([
        401,
        "unauthenticated",
      ]);
    }

    // Case: budget_not_found
    {
      // Act
      const res = await get(harness, auth, "/v1/budget", {
        group,
        headers: { "hh-budget-id": "never-drawn" },
      });

      // Assert
      expect([res.status, (await readJson<{ error: { code: string } }>(res)).error.code]).toEqual([
        404,
        "budget_not_found",
      ]);
    }

    // Case: reservation_not_found
    {
      // Act
      const res = await post(harness, auth, "/v1/release", undefined, {
        group,
        headers: { "hh-reservation-id": "rsv_nope" },
      });

      // Assert
      expect([res.status, (await readJson<{ error: { code: string } }>(res)).error.code]).toEqual([
        404,
        "reservation_not_found",
      ]);
    }

    // Case: budget_exceeded
    {
      // Arrange
      await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry("full", 100, definition(100))],
        },
        { group, key: freshKey() },
      );

      // Act
      const res = await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry("full", 1, definition(100))],
        },
        { group, key: freshKey() },
      );

      // Assert
      expect([res.status, (await readJson<{ error: { code: string } }>(res)).error.code]).toEqual([
        402,
        "budget_exceeded",
      ]);
    }

    // Case: idempotency_conflict
    {
      // Arrange
      const key = freshKey();
      await post(
        harness,
        auth,
        "/v1/charge",
        { budgets: [entry("c", 1, definition(100))] },
        { group, key },
      );

      // Act
      const res = await post(
        harness,
        auth,
        "/v1/charge",
        {
          budgets: [entry("c", 2, definition(100))],
        },
        { group, key },
      );

      // Assert
      expect([res.status, (await readJson<{ error: { code: string } }>(res)).error.code]).toEqual([
        409,
        "idempotency_conflict",
      ]);
    }

    // Case: reservation_settled
    {
      // Arrange
      const reserved = await post(
        harness,
        auth,
        "/v1/reserve",
        {
          budgets: [entry("s", 1, definition(100))],
        },
        { group, key: freshKey() },
      );
      const { reservationId } = await readJson<{ reservationId: string }>(reserved);
      await post(harness, auth, "/v1/release", undefined, {
        group,
        headers: { "hh-reservation-id": reservationId },
      });

      // Act
      const res = await post(harness, auth, "/v1/commit", undefined, {
        group,
        headers: { "hh-reservation-id": reservationId },
      });

      // Assert
      expect([res.status, (await readJson<{ error: { code: string } }>(res)).error.code]).toEqual([
        409,
        "reservation_settled",
      ]);
    }
  });
});

describe("the 402 body", () => {
  it("carries budgets as a sibling of error, not nested inside it", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 500, definition(100))],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    const body = await readJson<{ error: Record<string, unknown>; budgets: unknown[] }>(res);
    expect(
      Array.isArray(body.budgets),
      "a decoder reading `budgets` on a 200 must read the same field here",
    ).toBe(true);
    expect(
      body.error["budgets"],
      "`budgets` must not also be nested under `error`",
    ).toBeUndefined();
  });

  it("uses the same shape and ordering as a 200, covering every requested budget", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [
          entry("first", 1, definition(100)),
          entry("second", 500, definition(100)),
          entry("third", 1, definition(100)),
        ],
      },
      { group: freshGroup(), key: freshKey() },
    );

    // Assert
    expect(res.status).toBe(402);
    const body = await readJson<{ budgets: Record<string, unknown>[] }>(res);
    expect(
      body.budgets.map((b) => b["id"]),
      "every requested budget must appear, in request order",
    ).toEqual(["first", "second", "third"]);
    for (const b of body.budgets) {
      expect(Object.keys(b).sort(), `entry ${String(b["id"])}`).toEqual([
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
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 40, definition(100))],
      },
      { group, key: freshKey() },
    );

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
    const body = await readJson<{ budgets: { used: number; remaining: number }[] }>(res);
    expect(body.budgets[0]!.used, "the denied draw must not be counted into used").toBe(40);
    expect(body.budgets[0]!.remaining, "remaining must reflect state before the draw").toBe(60);
  });

  it("sends retry-after set to the earliest renewal among exceeded budgets", async () => {
    // Arrange
    const group = freshGroup();
    const renewal = { type: "interval", seconds: 3600 };
    await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 100, definition(100, { renewal }))],
      },
      { group, key: freshKey() },
    );

    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 1, definition(100, { renewal }))],
      },
      { group, key: freshKey() },
    );

    // Assert
    expect(res.status).toBe(402);
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter), "retry-after must be whole seconds").toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    const body = await readJson<{ budgets: { renewsAt: string }[] }>(res);
    const expected = Math.ceil((Date.parse(body.budgets[0]!.renewsAt) - Date.now()) / 1000);
    expect(
      Math.abs(retryAfter - expected),
      "retry-after must agree with the renewsAt it is derived from",
    ).toBeLessThanOrEqual(1);
  });

  it("takes the earliest boundary when several budgets are exceeded", async () => {
    // Act
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [
          entry("slow", 500, definition(100, { renewal: { type: "interval", seconds: 86_400 } })),
          entry("fast", 500, definition(100, { renewal: { type: "interval", seconds: 60 } })),
        ],
      },
      { group: freshGroup(), key: freshKey() },
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
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [entry("b", 500, definition(100))],
      },
      { group: freshGroup(), key: freshKey() },
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
    const res = await post(
      harness,
      auth,
      "/v1/charge",
      {
        budgets: [
          entry("lifetime", 500, definition(100)),
          entry("hourly", 500, definition(100, { renewal: { type: "interval", seconds: 3600 } })),
        ],
      },
      { group: freshGroup(), key: freshKey() },
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
    const unknown = await get(harness, auth, "/v1/nope", { group: freshGroup() });
    const wrongMethod = await get(harness, auth, "/v1/charge", { group: freshGroup() });

    // Assert
    expect(unknown.status).toBe(404);
    expect(
      (await readJson<{ error: { code: string } }>(unknown)).error.code.length,
      "a routing error carries an implementation-chosen code, but it must not be empty",
    ).toBeGreaterThan(0);
    expect(wrongMethod.status, "GET on a POST-only route is a method error").toBe(405);
  });

  it("rejects a malformed JSON body with 400", async () => {
    // Act
    const res = await harness.fetch("/v1/charge", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "hh-group": freshGroup(),
        "idempotency-key": freshKey(),
      },
      body: "{not json",
    });

    // Assert
    expect(res.status).toBe(400);
  });
});
