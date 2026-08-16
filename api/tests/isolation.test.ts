/**
 * Budget isolation at our scope boundary.
 *
 * Two accounts naming identical tenants, groups, and budget IDs must never interact. It is the
 * defect the protocol calls critical, checked at the boundary our authentication scheme
 * defines.
 */

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function newAccount(): Promise<string> {
  const res = await SELF.fetch("https://hh.test/v1/keys", { method: "POST" });
  return (await res.json<{ apiKey: string }>()).apiKey;
}

async function charge(apiKey: string, amount: number, tenant?: string): Promise<number> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "hh-group": "shared-group",
    "idempotency-key": crypto.randomUUID(),
  };
  if (tenant !== undefined) {
    headers["hh-tenant"] = tenant;
  }

  const res = await SELF.fetch("https://hh.test/v1/charge", {
    method: "POST",
    headers,
    body: JSON.stringify({
      budgets: [
        {
          id: "monthly-ops",
          amount,
          definition: { limit: 1000, renewal: { type: "never" } },
        },
      ],
    }),
  });
  return (await res.json<{ budgets: { used: number }[] }>()).budgets[0]!.used;
}

describe("scope isolation", () => {
  it("keeps identically-named budgets separate across accounts", async () => {
    // Arrange
    const alice = await newAccount();
    const bob = await newAccount();

    // Assert
    expect(await charge(alice, 100)).toBe(100);
    expect(await charge(bob, 100), "alice's charge leaked into bob's budget").toBe(100);
    expect(await charge(alice, 100)).toBe(200);
    expect(await charge(bob, 50), "bob's budget accumulated alice's usage").toBe(150);
  });

  it("keeps them separate even under an identical tenant string", async () => {
    // Arrange
    const alice = await newAccount();
    const bob = await newAccount();

    // Assert
    expect(await charge(alice, 10, "customer-1")).toBe(10);
    expect(
      await charge(bob, 10, "customer-1"),
      "an identical tenant string merged two accounts' budgets",
    ).toBe(10);
  });

  it("exhausts one account's budget without affecting another's", async () => {
    // Arrange
    const alice = await newAccount();
    const bob = await newAccount();
    await charge(alice, 1000);

    // Act
    const aliceDenied = await SELF.fetch("https://hh.test/v1/charge", {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice}`,
        "content-type": "application/json",
        "hh-group": "shared-group",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        budgets: [
          { id: "monthly-ops", amount: 1, definition: { limit: 1000, renewal: { type: "never" } } },
        ],
      }),
    });

    // Assert
    expect(aliceDenied.status, "an exhausted budget must deny further charges").toBe(402);
    expect(await charge(bob, 1), "alice's exhaustion spilled into bob's budget").toBe(1);
  });

  it("lets two keys mapped to one account address the same budgets", async () => {
    // Arrange
    const first = await newAccount();
    const { accountId } = await (
      await SELF.fetch("https://hh.test/v1/whoami", {
        headers: { authorization: `Bearer ${first}` },
      })
    ).json<{ accountId: string }>();

    const second = "hh_sk_second-key-for-the-same-account";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(second));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.API_KEYS.put(
      `k:${hash}`,
      JSON.stringify({ accountId, createdAt: new Date().toISOString() }),
    );

    // Assert
    expect(await charge(first, 10)).toBe(10);
    expect(
      await charge(second, 10),
      "a second key on the same account must see the same usage",
    ).toBe(20);
  });
});
