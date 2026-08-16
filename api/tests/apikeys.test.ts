/** Our authentication scheme: accounts, API keys, and what they gate. */

import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`https://hh.test${path}`, init);
}

async function issue(): Promise<{ accountId: string; apiKey: string }> {
  const res = await fetchApi("/v1/keys", { method: "POST" });
  return res.json<{ accountId: string; apiKey: string }>();
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("POST /v1/keys", () => {
  it("issues an account and a key with the documented shape", async () => {
    // Act
    const res = await fetchApi("/v1/keys", { method: "POST" });
    const { accountId, apiKey } = await res.json<{ accountId: string; apiKey: string }>();

    // Assert
    expect(res.status).toBe(201);
    expect(accountId).toMatch(/^acct_[A-Za-z0-9_]+$/);
    expect(apiKey).toMatch(/^hh_sk_[A-Za-z0-9_-]{43}$/);
  });

  it("issues a distinct account per call", async () => {
    // Act
    const a = await issue();
    const b = await issue();

    // Assert
    expect(a.accountId, "two calls shared one account").not.toBe(b.accountId);
    expect(a.apiKey, "two calls issued the same credential").not.toBe(b.apiKey);
  });

  it("stores only a hash of the token, never the token itself", async () => {
    // Arrange
    const { apiKey, accountId } = await issue();

    // Act
    const byHash = await env.API_KEYS.get(`k:${await sha256Hex(apiKey)}`, "json");
    const { keys } = await env.API_KEYS.list();

    // Assert
    expect(byHash, "the key hash must resolve to its account record").toEqual({
      accountId,
      createdAt: expect.any(String),
    });
    for (const { name } of keys) {
      expect(name, "a KV dump must not yield a usable credential").not.toContain(apiKey);
    }
  });
});

describe("GET /v1/whoami", () => {
  it("returns the account the key resolves to", async () => {
    // Arrange
    const { accountId, apiKey } = await issue();

    // Act
    const res = await fetchApi("/v1/whoami", {
      headers: { authorization: `Bearer ${apiKey}` },
    });

    // Assert
    expect(res.status).toBe(200);
    expect(
      await res.json<{ accountId: string }>(),
      "the key resolved to a different account than it was issued for",
    ).toEqual({ accountId });
  });
});

describe("authentication", () => {
  it("rejects a missing, malformed, or unknown bearer token with 401", async () => {
    // Arrange
    const cases: (Record<string, string> | undefined)[] = [
      undefined,
      { authorization: "" },
      { authorization: "hh_sk_no_scheme" },
      { authorization: "Basic dXNlcjpwYXNz" },
      { authorization: "Bearer " },
      { authorization: "Bearer hh_sk_totally-made-up-key-value-that-was-never-issued" },
    ];

    // Assert
    for (const headers of cases) {
      const res = await fetchApi("/v1/whoami", headers === undefined ? {} : { headers });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(
        (await res.json<{ error: { code: string } }>()).error.code,
        JSON.stringify(headers),
      ).toBe("unauthenticated");
    }
  });

  it("requires auth on every protocol route", async () => {
    // Arrange
    const routes: [string, string][] = [
      ["POST", "/v1/charge"],
      ["POST", "/v1/reserve"],
      ["POST", "/v1/commit"],
      ["POST", "/v1/release"],
      ["GET", "/v1/budget"],
    ];

    // Assert
    for (const [method, path] of routes) {
      const res = await fetchApi(path, {
        method,
        headers: {
          "hh-group": "g",
          "hh-reservation-id": "r",
          "idempotency-key": "k",
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("authenticates before validating anything else", async () => {
    // Act
    const res = await fetchApi("/v1/charge", { method: "POST", body: "{not json" });

    // Assert
    expect(res.status, "a malformed body was reported before authentication").toBe(401);
  });
});
