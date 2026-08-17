/**
 * The same webhook delivered twice.
 *
 * Your payment provider did not see your 200, so it sends the event again. The
 * second delivery must not spend the budget a second time.
 */

import assert from "node:assert/strict";
import { HorseHolderClient, renewal } from "@horse-holder/client";

export const name = "replaying an idempotency key";

const hh = new HorseHolderClient({
  baseUrl: process.env["HH_BASE_URL"]!,
  apiKey: process.env["HORSEHOLDER_API_KEY"]!,
});

// What handling one payment event is allowed to cost us.
const webhooks = hh
  .group("payment-webhooks")
  // The amount of events handled, limited to 50,000 per day.
  .budget("events-processed", {
    limit: 50_000,
    renewal: renewal.daily({ timezone: "UTC" }),
  })
  // The amount of fraud scoring calls made, limited to 50,000 per day.
  .budget("fraud-checks", {
    limit: 50_000,
    renewal: renewal.daily({ timezone: "UTC" }),
  });

export async function run(): Promise<void> {
  // The key is the event id, not a fresh random string. That is the whole
  // trick: the same operation has to present the same key every time you
  // retry it, or there is nothing to match against.
  const eventId = "evt_1JqX2K4M5N6P7Q8R";

  // What handling one event costs, described once. A draw is immutable until
  // it is sent, so this is a safe thing to keep around and finish three times.
  const handling = webhooks.draw("events-processed", 1).draw("fraud-checks", 5);

  const first = await handling.idempotent(eventId).charge();

  // The provider redelivers. Identical call, identical key.
  const redelivery = await handling.idempotent(eventId).charge();

  // A genuinely different event, which should genuinely be charged.
  const other = await handling.idempotent("evt_1JqX2K4M5N6P7Q9S").charge();

  if (!first.ok || !redelivery.ok || !other.ok) {
    throw new Error(`A budget was exceeded! Hold your horses!`);
  }

  assert.equal(first.get("fraud-checks").used, 5);

  // The redelivery handed back the original answer instead of charging again.
  assert.equal(redelivery.get("fraud-checks").used, 5, "the replay did not spend twice");

  assert.equal(other.get("fraud-checks").used, 10, "a new event is a new charge");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await run();
}
