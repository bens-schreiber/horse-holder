/**
 * The values we had to pick and publish (reservation TTL, idempotency retention), plus our own
 * routing and body-handling codes.
 */

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { doName } from "../src/serve.ts";
import {
  IDEMPOTENCY_RETENTION_MS,
  RESERVATION_DEFAULT_TTL_SECONDS,
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
function stubFor(group: string): DurableObjectStub<import("../src/budget.ts").BudgetGroup> {
  return env.BUDGETS.get(env.BUDGETS.idFromName(doName(accountId, null, group)));
}

let n = 0;

function freshGroup(): string {
  return `ci-builds-${(n += 1)}`;
}

function freshKey(): string {
  return `build-${(n += 1)}`;
}

function draw(path: string, group: string, options: { key?: string; ttl?: number } = {}) {
  const headers: Record<string, string> = {
    ...auth,
    "content-type": "application/json",
    "hh-group": group,
    "idempotency-key": options.key ?? freshKey(),
  };
  if (options.ttl !== undefined) {
    headers["hh-ttl-seconds"] = String(options.ttl);
  }
  return SELF.fetch(`https://hh.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      budgets: [
        {
          id: "build-minutes",
          amount: 1,
          definition: { limit: 100, renewal: { type: "never" } },
        },
      ],
    }),
  });
}

function reserve(group: string, ttl?: number): Promise<Response> {
  return draw("/v1/reserve", group, ttl === undefined ? {} : { ttl });
}

describe("reservation TTL", () => {
  it("holds for 300 seconds when hh-ttl-seconds is absent", async () => {
    // Arrange
    const before = Date.now();

    // Act
    const { expiresAt } = await (await reserve(freshGroup())).json<{ expiresAt: string }>();

    // Assert
    const ttl = (Date.parse(expiresAt) - before) / 1000;
    expect(ttl, "the applied TTL is below the documented default").toBeGreaterThan(
      RESERVATION_DEFAULT_TTL_SECONDS - 5,
    );
    expect(ttl, "the applied TTL is above the documented default").toBeLessThan(
      RESERVATION_DEFAULT_TTL_SECONDS + 5,
    );
  });

  it("accepts a hold at the 24 hour ceiling and rejects one past it", async () => {
    // Assert
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
    for (const ttl of [0, -5, 1.5]) {
      expect((await reserve(freshGroup(), ttl)).status, `ttl ${ttl}`).toBe(400);
    }

    // Act
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
        budgets: [
          {
            id: "build-minutes",
            amount: 1,
            definition: { limit: 100, renewal: { type: "never" } },
          },
        ],
      }),
    });

    // Assert
    expect(nonNumeric.status, "a non-numeric ttl header must be rejected").toBe(400);
  });
});

describe("idempotency retention", () => {
  it("honors the window at read time, not on whether reclamation has run", async () => {
    // Arrange
    const group = freshGroup();
    const key = freshKey();
    async function used(): Promise<number> {
      const res = await draw("/v1/charge", group, { key });
      return (await res.json<{ budgets: { used: number }[] }>()).budgets[0]!.used;
    }
    expect(await used(), "the first draw should have applied once").toBe(1);

    // Act
    const replay = await used();

    // Assert
    expect(replay, "a replay inside the window must return the original result").toBe(1);

    vi.setSystemTime(Date.now() + IDEMPOTENCY_RETENTION_MS + 1000);
    try {
      expect(await used(), "past the window the key must be evaluated fresh").toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reclaims a record once it falls past the window", async () => {
    // Arrange
    const group = freshGroup();
    await draw("/v1/charge", group);
    async function records(): Promise<string[]> {
      return runInDurableObject(stubFor(group), async (_instance, state) => [
        ...(await state.storage.list({ prefix: "i:" })).keys(),
      ]);
    }
    expect(await records(), "the charge should have stored one record").toHaveLength(1);

    // Act: a later request past the window is what drives reclamation.
    vi.setSystemTime(Date.now() + IDEMPOTENCY_RETENTION_MS + 60_000);
    try {
      await draw("/v1/charge", group);

      // Assert
      expect(
        await records(),
        "only the second draw's record should remain, the stale one reclaimed",
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no index entry behind for a record it reclaimed", async () => {
    // Arrange
    const group = freshGroup();
    await draw("/v1/charge", group);
    async function index(): Promise<string[]> {
      return runInDurableObject(stubFor(group), async (_instance, state) => [
        ...(await state.storage.list({ prefix: "x:" })).keys(),
      ]);
    }
    expect(await index(), "a stored record must be indexed by its deadline").toHaveLength(1);

    // Act
    vi.setSystemTime(Date.now() + IDEMPOTENCY_RETENTION_MS + 60_000);
    try {
      await draw("/v1/charge", group);

      // Assert
      expect(await index(), "the reclaimed record's index entry outlived it").toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("routing codes", () => {
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
        budgets: [
          { id: "build-minutes", amount: 1, definition: { limit: 10, renewal: { type: "never" } } },
        ],
        surprise: true,
      }),
    });

    // Assert
    expect(res.status, "an unknown top-level body field was accepted").toBe(400);
  });

  it("treats an empty commit body the same as an omitted one", async () => {
    // Arrange
    const group = freshGroup();
    const { reservationId } = await (await reserve(group)).json<{ reservationId: string }>();

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
    const { reservationId } = await (await reserve(group)).json<{ reservationId: string }>();

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
        budgets: [
          {
            id: "build-minutes",
            amount: 1,
            definition: { limit: 999, renewal: { type: "never" } },
          },
        ],
      }),
    });

    // Assert
    expect(res.status, "a commit corrects amounts and has no definition to reconcile").toBe(400);
  });

  it("rejects an idempotency-key longer than 255 characters", async () => {
    // Act
    const res = await draw("/v1/charge", freshGroup(), { key: "k".repeat(256) });

    // Assert
    expect(res.status, "an over-length idempotency-key was accepted").toBe(400);
  });
});
