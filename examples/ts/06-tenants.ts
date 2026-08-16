/**
 * One budget declaration, one copy per customer.
 *
 * Every customer on your platform gets 500 build minutes a month. That is one
 * group with a tenant per customer, not 500 minutes shared between all of them.
 */

import assert from "node:assert/strict";
import { HorseHolderClient, renewal } from "@horse-holder/client";

export const name = "tenants are independent";

const hhldr = new HorseHolderClient({
  baseUrl: process.env["HH_BASE_URL"]!,
  apiKey: process.env["HORSEHOLDER_API_KEY"]!,
});

// A Vercel-style CI budget.
const ci = hhldr.group({
  id: "ci-builds",
  budgets: {
    // The amount of build time used, limited to 500 minutes per month.
    "build-minutes": {
      limit: 500,
      renewal: renewal.monthly({ timezone: "UTC" }),
    },
    // The amount of build output stored, limited to 20,000 megabytes per month.
    "artifact-megabytes": {
      limit: 20_000,
      renewal: renewal.monthly({ timezone: "UTC" }),
    },
  },
});

export async function run(): Promise<void> {
  // The same group, pointed at two of your customers. They share one connection
  // and one declaration, and nothing else.
  const acme = ci.tenant("acme");
  const globex = ci.tenant("globex");

  const [acmeBuild, globexBuild] = await Promise.all([
    acme.charge(
      { "build-minutes": 12, "artifact-megabytes": 340 },
      { idempotencyKey: "build-acme-1187" },
    ),
    globex.charge({ "build-minutes": 3 }, { idempotencyKey: "build-globex-2043" }),
  ]);

  if (!acmeBuild.ok || !globexBuild.ok) {
    throw new Error(`A budget was exceeded! Hold your horses!`);
  }

  assert.equal(acmeBuild.get("build-minutes").used, 12);
  assert.equal(globexBuild.get("build-minutes").used, 3, "globex has its own 500 minutes");

  // A draw always answers for the whole group, so the budget globex skipped is
  // reported as untouched rather than left out entirely.
  assert.equal(globexBuild.get("artifact-megabytes").requested, 0);
  assert.equal(globexBuild.get("artifact-megabytes").used, 0);

  // Reading follows the tenant too.
  const acmeState = await acme.read();
  assert.equal(acmeState.get("build-minutes")?.used, 12);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await run();
}
