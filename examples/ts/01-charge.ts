/**
 * Cost known up front: an R2 write.
 *
 * You know the object size before you PUT it, so you charge and then
 * perform the operation.
 */

import assert from "node:assert";
import { HorseHolderClient, renewal } from "@horse-holder/client";

export const name = "charge and read";

const hh = new HorseHolderClient({
  baseUrl: process.env["HH_BASE_URL"]!,
  apiKey: process.env["HORSEHOLDER_API_KEY"]!,
});

// A Cloudflare R2 object storage bucket
const r2 = hh
  .group("r2")
  // The amount of R2 PUT operations, limited to 1,000 per day.
  .budget("put-ops", {
    limit: 1_000,
    renewal: renewal.daily({ timezone: "America/Chicago" }),
  })
  // The amount of storage used, limited to 1,000,000 bytes per month.
  .budget("storage-bytes", {
    limit: 1_000_000,
    renewal: renewal.monthly({ timezone: "America/Chicago" }),
  });

export async function run(): Promise<void> {
  // Immediately charge a small amount against both budgets.
  //
  // This is a single atomic operation. Either all budgets are
  // drawn against, or neither is.
  const result = await r2
    .draw("put-ops", 1)
    .draw("storage-bytes", 4_096)
    .idempotent("upload-8b21f0")
    .charge();

  if (!result.ok) {
    throw new Error(`A budget was exceeded! Hold your horses!`);
  }

  const putOps = result.get("put-ops");
  assert.equal(putOps.used, 1);
  assert.equal(putOps.remaining, 999);
  assert.equal(putOps.exceeded, false);

  const storageBytes = result.get("storage-bytes");
  assert.equal(storageBytes.used, 4_096);
  assert.equal(storageBytes.remaining, 995_904);
  assert.equal(storageBytes.exceeded, false);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await run();
}
