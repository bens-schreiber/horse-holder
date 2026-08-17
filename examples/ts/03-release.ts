/**
 * The work failed, so the hold goes back.
 *
 * You reserve before handing a message to your email provider. If the provider
 * rejects it then nothing really went out, so nothing should be charged.
 */

import assert from "node:assert/strict";
import { HorseHolderClient, renewal } from "@horse-holder/client";

export const name = "reserve then release after a failure";

const hh = new HorseHolderClient({
  baseUrl: process.env["HH_BASE_URL"]!,
  apiKey: process.env["HORSEHOLDER_API_KEY"]!,
});

/** Stands in for the email provider, which is having a bad day. */
async function sendViaProvider(): Promise<never> {
  throw new Error("550 recipient domain not found");
}

// An SES-style transactional email budget.
const email = hh
  .group("transactional-email")
  // The amount of messages sent, limited to 10,000 per day.
  .budget("messages-sent", {
    limit: 10_000,
    renewal: renewal.daily({ timezone: "UTC" }),
  })
  // The amount of attachment data sent, limited to 5,000,000 bytes per day.
  .budget("attachment-bytes", {
    limit: 5_000_000,
    renewal: renewal.daily({ timezone: "UTC" }),
  });

export async function run(): Promise<void> {
  // Take the capacity before calling the provider, so two senders cannot both
  // think they have the last of the day's quota.
  const lease = await email
    .draw("messages-sent", 1)
    .draw("attachment-bytes", 50_000)
    .idempotent("receipt-email-9f30")
    .reserve({ ttlSeconds: 60 });

  if (!lease.ok) {
    throw new Error(`A budget was exceeded! Hold your horses!`);
  }

  // The usual shape: commit what you spent, release what you didn't.
  //
  // Releasing something already released is fine, so a catch block can call it
  // without keeping track of whether it already did.
  let settled;
  try {
    await sendViaProvider();
    settled = await lease.commit();
  } catch {
    settled = await lease.release();
  }

  assert.ok(settled.ok);
  assert.equal(settled.get("messages-sent").used, 0, "the hold came back in full");
  assert.equal(settled.get("attachment-bytes").used, 0);

  // Nothing was drawn by the release, so it reports nothing as requested.
  assert.equal(settled.get("attachment-bytes").requested, 0);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await run();
}
