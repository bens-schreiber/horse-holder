/**
 * Being told no.
 *
 * Horse Holder will notify you when a budget is exceeded, and it will refuse
 * to draw against it.
 */

import assert from "node:assert/strict";
import { HorseHolderClient, renewal } from "@horse-holder/client";

export const name = "over-draw returns ok: false";

const hhldr = new HorseHolderClient({
  baseUrl: process.env["HH_BASE_URL"]!,
  apiKey: process.env["HORSEHOLDER_API_KEY"]!,
});

// A Bedrock-style inference budget.
const inference = hhldr.group({
  id: "llm-inference",
  budgets: {
    // The amount of model calls made, limited to 5,000 per month.
    requests: {
      limit: 5_000,
      renewal: renewal.monthly({ timezone: "America/New_York" }),
    },
    // The amount of input tokens spent, limited to 1,000,000 per month.
    "input-tokens": {
      limit: 1_000_000,
      renewal: renewal.monthly({ timezone: "America/New_York" }),
    },
  },
});

export async function run(): Promise<void> {
  // Five million tokens against a one million token budget. There is plenty of
  // room left in requests, but one budget falling short refuses the whole draw,
  // so nothing at all is spent.
  const refused = await inference.charge(
    { requests: 1, "input-tokens": 5_000_000 },
    { idempotencyKey: "chat-turn-51ac" },
  );

  if (refused.ok) {
    throw new Error("we want this to be refused! hold my horses!");
  }

  // You get told which budget ran out, how much room the others had,
  // and roughly how long until waiting would help. Enough to decide
  // between trimming the prompt, waiting, or upselling the customer.
  const wait = refused.retryAfter;
  const trimmed = await inference.charge(
    { requests: 1, "input-tokens": 4_000 },
    { idempotencyKey: "chat-turn-51ac-shortened" },
  );

  if (!trimmed.ok) {
    throw new Error(`A budget was exceeded! Hold your horses!`);
  }

  assert.equal(refused.get("requests").exceeded, false);
  assert.equal(refused.get("requests").used, 0, "the refusal spent nothing anywhere");
  assert.ok(wait !== null && wait > 0, "these budgets reset monthly, so waiting helps");
  assert.equal(trimmed.get("input-tokens").used, 4_000);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await run();
}
