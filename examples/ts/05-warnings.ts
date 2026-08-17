/**
 * Getting told you are getting close.
 *
 * You want to hear about the SMS bill at a quarter, half, and ninety percent
 * of the monthly cap. You do not want to hear about it on every message.
 */

import assert from "node:assert/strict";
import { HorseHolderClient, renewal } from "@horse-holder/client";

export const name = "warnings cross once each";

/** Whatever you would really do here: page someone, log it, email the customer. */
const paged: string[] = [];

const hh = new HorseHolderClient({
  baseUrl: process.env["HH_BASE_URL"]!,
  apiKey: process.env["HORSEHOLDER_API_KEY"]!,

  // Fires once per threshold crossed, on any draw that goes through.
  //
  // Warnings can also be observed on a per-draw basis, this global callback is for convenience.
  onWarning: ({ id, thresholds, budget }) => {
    paged.push(`${id} passed ${thresholds.join(", ")} at ${budget.used}/${budget.limit}`);
  },
});

// A Twilio-style SMS budget, counted in hundredths of a cent. Money is
// better tracked in whole small units than in floating point dollars.
const sms = hh
  .group("sms-campaign")
  // The amount spent on messages, limited to 100,000 hundredths of a cent per month.
  .budget("spend-millicents", {
    limit: 100_000,
    warnings: [0.25, 0.5, 0.9],
    renewal: renewal.monthly({ timezone: "America/Los_Angeles" }),
  });

export async function run(): Promise<void> {
  // Four batches through the month, walking the budget from empty to nearly
  // spent. One after another, since which batch trips which threshold is the
  // thing being shown here.
  const first = await sms
    .draw("spend-millicents", 30_000)
    .idempotent("campaign-jan-batch-1")
    .charge();
  const second = await sms
    .draw("spend-millicents", 40_000)
    .idempotent("campaign-jan-batch-2")
    .charge();
  const third = await sms
    .draw("spend-millicents", 5_000)
    .idempotent("campaign-jan-batch-3")
    .charge();
  const fourth = await sms
    .draw("spend-millicents", 20_000)
    .idempotent("campaign-jan-batch-4")
    .charge();

  if (!first.ok || !second.ok || !third.ok || !fourth.ok) {
    throw new Error(`A budget was exceeded! Hold your horses!`);
  }

  // 30% of the cap, so the quarter mark goes off.
  assert.deepEqual(first.warningsCrossed, [{ id: "spend-millicents", thresholds: [0.25] }]);

  // 70%, so the half mark goes off and the quarter mark stays quiet.
  assert.deepEqual(second.warningsCrossed, [{ id: "spend-millicents", thresholds: [0.5] }]);

  // 75%, which is past nothing new, so nobody is woken up.
  assert.deepEqual(third.warningsCrossed, []);

  // 95%, so the ninety mark goes off.
  assert.deepEqual(fourth.warningsCrossed, [{ id: "spend-millicents", thresholds: [0.9] }]);

  // Three thresholds, four draws, three pages. Each one fires once per period.
  assert.deepEqual(paged, [
    "spend-millicents passed 0.25 at 30000/100000",
    "spend-millicents passed 0.5 at 70000/100000",
    "spend-millicents passed 0.9 at 95000/100000",
  ]);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await run();
}
