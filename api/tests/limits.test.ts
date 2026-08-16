/**
 * Our documented implementation choices: the values the spec requires us to pick and
 * publish rather than mandating (reservation TTL, idempotency retention), plus our own
 * routing codes.
 */

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { doName } from "../src/index.ts";
import {
  RESERVATION_DEFAULT_TTL_SECONDS,
  IDEMPOTENCY_RETENTION_MS,
  REQUEST_MAX_BUDGETS,
  RESERVATION_MAX_TTL_SECONDS,
} from "../src/schema.ts";

let auth: Record<string, string>;
let accountId: string;

beforeAll(async () => {
  const res = await SELF.fetch("https://hh.test/v1/keys", { method: "POST" });
  const issued = await res.json<{ accountId: string; apiKey: string }>();
  accountId = issued.accountId;
  auth = { authorization: `Bearer ${issued.apiKey}` };
});

/** The Durable Object backing a group under the suite's account, with no tenant header. */
const stubFor = (group: string): DurableObjectStub<import("../src/budget.ts").BudgetGroup> =>
  env.BUDGETS.get(env.BUDGETS.idFromName(doName(accountId, false, "", group)));

let n = 0;
const freshGroup = (): string => `g${(n += 1)}-${Math.random().toString(36).slice(2)}`;
const freshKey = (): string => `k${(n += 1)}-${Math.random().toString(36).slice(2)}`;

function reserve(group: string, ttl?: number): Promise<Response> {
  const headers: Record<string, string> = {
    ...auth,
    "content-type": "application/json",
    "hh-group": group,
    "idempotency-key": freshKey(),
  };
  if (ttl !== undefined) {
    headers["hh-ttl-seconds"] = String(ttl);
  }
  return SELF.fetch("https://hh.test/v1/reserve", {
    method: "POST",
    headers,
    body: JSON.stringify({
      budgets: [{ id: "b", amount: 1, definition: { limit: 100, renewal: { type: "never" } } }],
    }),
  });
}

describe("documented reservation TTL choices", () => {
  it("defaults to 300 seconds, the value the spec recommends", () => {
    expect(RESERVATION_DEFAULT_TTL_SECONDS).toBe(300);
  });

  it("applies that default when hh-ttl-seconds is absent", async () => {
    // Arrange
    const before = Date.now();

    // Act
    const res = await reserve(freshGroup());
    const { expiresAt } = await res.json<{ expiresAt: string }>();

    // Assert
    const ttl = (Date.parse(expiresAt) - before) / 1000;
    expect(ttl, "the applied TTL is below the documented default").toBeGreaterThan(
      RESERVATION_DEFAULT_TTL_SECONDS - 5,
    );
    expect(ttl, "the applied TTL is above the documented default").toBeLessThan(
      RESERVATION_DEFAULT_TTL_SECONDS + 5,
    );
  });

  it("supports the 86400 the spec requires as a minimum ceiling", async () => {
    // Assert
    expect(RESERVATION_MAX_TTL_SECONDS).toBe(86_400);
    expect(
      (await reserve(freshGroup(), RESERVATION_MAX_TTL_SECONDS)).status,
      "a TTL at the ceiling must be accepted",
    ).toBe(200);
    expect(
      (await reserve(freshGroup(), RESERVATION_MAX_TTL_SECONDS + 1)).status,
      "a TTL past the ceiling must be rejected",
    ).toBe(400);
  });

  it("rejects a non-integer or out-of-range TTL", async () => {
    // Assert
    for (const ttl of [0, -5, 1.5] as number[]) {
      expect((await reserve(freshGroup(), ttl)).status, `ttl ${ttl}`).toBe(400);
    }
    const nonNumeric = await SELF.fetch("https://hh.test/v1/reserve", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "hh-group": freshGroup(),
        "idempotency-key": freshKey(),
        "hh-ttl-seconds": "soon",
      },
      body: JSON.stringify({
        budgets: [{ id: "b", amount: 1, definition: { limit: 100, renewal: { type: "never" } } }],
      }),
    });
    expect(nonNumeric.status, "a non-numeric ttl header must be rejected").toBe(400);
  });
});

describe("documented idempotency retention window", () => {
  it("is 24 hours, the required minimum", () => {
    expect(IDEMPOTENCY_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("arms a reclamation alarm once a draw has something to retain", async () => {
    // Arrange
    const group = freshGroup();
    const alarmAt = async (): Promise<number | null> =>
      runInDurableObject(stubFor(group), (_instance, state) => state.storage.getAlarm());
    expect(await alarmAt(), "an untouched group must start with no alarm armed").toBeNull();

    // Act
    await reserve(group);
    const scheduled = await alarmAt();

    // Assert
    expect(scheduled, "a draw with a record to retain must arm a reclamation alarm").not.toBeNull();
    expect(scheduled! - Date.now(), "the alarm was armed in the past").toBeGreaterThan(0);
  });

  it("reclaims a record once the alarm fires past the window", async () => {
    // Arrange
    const group = freshGroup();
    await reserve(group);
    const idempotencyKeys = async (): Promise<string[]> =>
      runInDurableObject(stubFor(group), async (_instance, state) => [
        ...(await state.storage.list({ prefix: "i:" })).keys(),
      ]);
    expect(await idempotencyKeys(), "the reserve should have stored one record").toHaveLength(1);

    // Act
    await runInDurableObject(stubFor(group), (instance) => instance.alarm());

    // Assert
    expect(
      await idempotencyKeys(),
      "a sweep inside the retention window must keep the record",
    ).toHaveLength(1);

    vi.setSystemTime(Date.now() + IDEMPOTENCY_RETENTION_MS + 1000);
    try {
      await runInDurableObject(stubFor(group), (instance) => instance.alarm());
      expect(
        await idempotencyKeys(),
        "a sweep past the retention window must reclaim the record",
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors the window at read time, not on whether the sweep has run", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    const draw = async (): Promise<Response> =>
      SELF.fetch("https://hh.test/v1/charge", {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "hh-group": group,
          "idempotency-key": key,
        },
        body: JSON.stringify({
          budgets: [{ id: "b", amount: 1, definition: { limit: 100, renewal: { type: "never" } } }],
        }),
      });

    const first = await draw();
    expect(
      (await first.json<{ budgets: { used: number }[] }>()).budgets[0]!.used,
      "the first draw should have applied once",
    ).toBe(1);

    // Act
    const replay = await draw();

    // Assert
    expect(
      (await replay.json<{ budgets: { used: number }[] }>()).budgets[0]!.used,
      "a replay inside the window must return the original result without re-applying",
    ).toBe(1);

    vi.setSystemTime(Date.now() + IDEMPOTENCY_RETENTION_MS + 1000);
    try {
      const stale = await draw();
      expect(
        (await stale.json<{ budgets: { used: number }[] }>()).budgets[0]!.used,
        "past the window the key must be evaluated fresh, even before the alarm fires",
      ).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("documented request bounds", () => {
  it("caps a draw at the 16 budgets the spec mandates", () => {
    expect(REQUEST_MAX_BUDGETS).toBe(16);
  });
});

describe("our routing codes", () => {
  it("names its own codes for routing failures the protocol does not define", async () => {
    // Act
    const unknown = await SELF.fetch("https://hh.test/v1/nonexistent", { headers: auth });
    const wrongMethod = await SELF.fetch("https://hh.test/v1/charge", { headers: auth });

    // Assert
    expect(unknown.status).toBe(404);
    expect((await unknown.json<{ error: { code: string } }>()).error.code).toBe("not_found");
    expect(wrongMethod.status).toBe(405);
    expect((await wrongMethod.json<{ error: { code: string } }>()).error.code).toBe(
      "method_not_allowed",
    );
  });

  it("does not leak route existence to an unauthenticated caller", async () => {
    const res = await SELF.fetch("https://hh.test/v1/nonexistent");
    expect(res.status, "an unknown route answered 404 before authenticating").toBe(401);
  });
});

describe("body handling", () => {
  it("rejects a body that is not a JSON object", async () => {
    // Assert
    for (const body of ["[]", '"a string"', "42", "null"]) {
      const res = await SELF.fetch("https://hh.test/v1/charge", {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "hh-group": freshGroup(),
          "idempotency-key": freshKey(),
        },
        body,
      });
      expect(res.status, body).toBe(400);
    }
  });

  it("rejects an unknown top-level body field", async () => {
    // Act
    const res = await SELF.fetch("https://hh.test/v1/charge", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "hh-group": freshGroup(),
        "idempotency-key": freshKey(),
      },
      body: JSON.stringify({
        budgets: [{ id: "b", amount: 1, definition: { limit: 10, renewal: { type: "never" } } }],
        surprise: true,
      }),
    });

    // Assert
    expect(res.status, "an unknown top-level body field was accepted").toBe(400);
  });

  it("treats an empty commit body the same as an omitted one", async () => {
    // Arrange
    const group = freshGroup();
    const reserved = await reserve(group);
    const { reservationId } = await reserved.json<{ reservationId: string }>();

    // Act
    const res = await SELF.fetch("https://hh.test/v1/commit", {
      method: "POST",
      headers: { ...auth, "hh-group": group, "hh-reservation-id": reservationId },
    });

    // Assert
    expect(res.status).toBe(200);
    const body = await res.json<{ budgets: { used: number }[] }>();
    expect(body.budgets[0]!.used, "the commit did not settle the reserved amount").toBe(1);
  });

  it("rejects a definition on a commit entry", async () => {
    // Arrange
    const group = freshGroup();
    const reserved = await reserve(group);
    const { reservationId } = await reserved.json<{ reservationId: string }>();

    // Act
    const res = await SELF.fetch("https://hh.test/v1/commit", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "hh-group": group,
        "hh-reservation-id": reservationId,
      },
      body: JSON.stringify({
        budgets: [{ id: "b", amount: 1, definition: { limit: 999, renewal: { type: "never" } } }],
      }),
    });

    // Assert
    expect(res.status, "a commit corrects amounts and has no definition to reconcile").toBe(400);
  });

  it("rejects an idempotency-key longer than 255 characters", async () => {
    // Act
    const res = await SELF.fetch("https://hh.test/v1/charge", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "hh-group": freshGroup(),
        "idempotency-key": "k".repeat(256),
      },
      body: JSON.stringify({
        budgets: [{ id: "b", amount: 1, definition: { limit: 10, renewal: { type: "never" } } }],
      }),
    });

    // Assert
    expect(res.status, "an over-length idempotency-key was accepted").toBe(400);
  });
});
