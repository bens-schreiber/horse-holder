/**
 * The Durable Object name builder must be injective.
 *
 * If two distinct budget keys ever produced one name they would share a DO, which is the
 * isolation defect reintroduced through the derivation meant to prevent it.
 */

import { describe, expect, it } from "vitest";
import { doName } from "../src/index.ts";
import { ID_PATTERN } from "../src/schema.ts";

/** Every tenant/group value a validated request can carry. */
const VALID_IDS = ["a", "z", "0", "9", "_", ".", "-", "a.b", "a-b", "a_b", "x".repeat(128)];
const ACCOUNTS = ["acct_A", "acct_B", "acct_1_2"];

describe("doName", () => {
  it("is injective across accounts, tenant presence, tenants, and groups", () => {
    // Arrange
    const keysByName = new Map<string, string>();
    let combinations = 0;

    // Act
    for (const accountId of ACCOUNTS) {
      for (const tenantPresent of [true, false]) {
        const tenants = tenantPresent ? ["", ...VALID_IDS] : [""];
        for (const tenant of tenants) {
          for (const group of VALID_IDS) {
            const name = doName(accountId, tenantPresent, tenant, group);
            keysByName.set(name, JSON.stringify([accountId, tenantPresent, tenant, group]));
            combinations += 1;
          }
        }
      }
    }

    // Assert
    expect(keysByName.size, "two distinct budget keys derived the same name").toBe(combinations);
    expect(combinations, "the sweep must be wide enough to be meaningful").toBeGreaterThan(300);
  });

  it("keeps an absent tenant distinct from an empty one", () => {
    expect(
      doName("acct_A", false, "", "g"),
      "an absent and an empty tenant address different budgets",
    ).not.toBe(doName("acct_A", true, "", "g"));
  });

  it("cannot be forged across the delimiter", () => {
    // Assert
    for (const forgery of ["a:b", "a::b"]) {
      expect(
        ID_PATTERN.test(forgery),
        `${forgery} carries the delimiter and must fail the identifier charset`,
      ).toBe(false);
    }
    for (const id of VALID_IDS) {
      expect(id, "a valid identifier must never contain the delimiter").not.toContain(":");
    }
  });

  it("never lets a group value impersonate a tenant value", () => {
    // Assert
    expect(
      doName("acct_A", true, "a", "b"),
      "a tenant may not absorb the group across the delimiter",
    ).not.toBe(doName("acct_A", true, "a.b", ""));
    expect(
      doName("acct_A", true, "", "a"),
      "swapping tenant and group must address a different budget",
    ).not.toBe(doName("acct_A", true, "a", ""));
  });

  it("separates accounts even when every other component matches", () => {
    expect(
      doName("acct_A", true, "t", "g"),
      "the account is the outermost isolation boundary",
    ).not.toBe(doName("acct_B", true, "t", "g"));
  });
});
