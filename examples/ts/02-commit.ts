/**
 * Cost known only afterward: a video transcode.
 *
 * You know roughly how many encoder-seconds a clip will take, but not exactly,
 * so you reserve an estimate and commit the real number.
 */

import assert from "node:assert/strict";
import { HorseHolderClient, renewal } from "@horse-holder/client";

export const name = "reserve then commit a correction";

const hhldr = new HorseHolderClient({
  baseUrl: process.env["HH_BASE_URL"]!,
  apiKey: process.env["HORSEHOLDER_API_KEY"]!,
});

// A MediaConvert-style transcoding pipeline.
const transcode = hhldr.group({
  id: "transcode",
  budgets: {
    // The amount of encoder time used, limited to 3,600 seconds per day.
    "encoder-seconds": {
      limit: 3_600,
      renewal: renewal.daily({ timezone: "Europe/Berlin" }),
    },
    // The amount of output storage used, limited to 50,000 megabytes per month.
    "output-megabytes": {
      limit: 50_000,
      renewal: renewal.monthly({ timezone: "Europe/Berlin" }),
    },
  },
});

export async function run(): Promise<void> {
  // A 90 second clip at roughly 4x realtime, and a generous guess at the
  // output size.
  const lease = await transcode.reserve(
    { "encoder-seconds": 360, "output-megabytes": 800 },
    { idempotencyKey: "transcode-job-4417", ttlSeconds: 60 },
  );

  if (!lease.ok) {
    throw new Error(`A budget was exceeded! Hold your horses!`);
  }

  // The encode finished faster than estimated and compressed better than feared.
  //
  // Only the output size is corrected here; encoder-seconds is left out, so it commits
  // at its reserved amount.
  //
  // Omission means "the estimate was right", never "release this one".
  const settled = await lease.commit({ "output-megabytes": 512 });

  assert.ok(settled.ok, "committing less than reserved will always have capacity");
  assert.equal(settled.get("output-megabytes").used, 512, "the difference was returned");
  assert.equal(
    settled.get("encoder-seconds").used,
    360,
    "an omitted budget commits at its reservation",
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await run();
}
