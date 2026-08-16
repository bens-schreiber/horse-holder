/**
 * Drives every example in `examples/ts` and asserts nothing threw, so `make example` is a
 * pass/fail run as well as a readable tour.
 *
 * This is the test driver, which is why it lives here rather than beside the examples. The
 * examples themselves are plain files a reader can open, copy, or run on their own; nothing
 * in this file is part of what they demonstrate.
 */

// Every import below is dynamic, so this marks the file as a module and keeps top-level await.
export {};

const baseUrl = process.env["HH_BASE_URL"];
if (baseUrl === undefined) {
  console.error("HH_BASE_URL is not set. Try `make example`, which defaults it to make dev.");
  process.exit(1);
}

/**
 * The examples use constant budget and group ids, exactly as real calling code would, so they
 * assert exact usage numbers. That needs an empty set of budgets to start from, which is what
 * a fresh scope is.
 *
 * Issuing a key is our server's own extension rather than anything the protocol defines,
 * which is why it happens in this driver and never in an example or in the client. Set
 * HORSEHOLDER_API_KEY to skip it and bring your own.
 */
async function freshScope(): Promise<string> {
  const response = await fetch(new URL("/v1/keys", baseUrl), { method: "POST" });
  if (response.status !== 201) {
    throw new Error(
      `could not issue an API key: ${response.status}. Is a server running at ${baseUrl}? ` +
        `Try \`make dev\`, or set HORSEHOLDER_API_KEY to a key of your own.`,
    );
  }
  return ((await response.json()) as { apiKey: string }).apiKey;
}

process.env["HORSEHOLDER_API_KEY"] ??= await freshScope();

// Imported after the key is in the environment, since each example reads it at module scope.
const examples = await Promise.all([
  import("../../examples/ts/01-charge.ts"),
  import("../../examples/ts/02-commit.ts"),
  import("../../examples/ts/03-release.ts"),
  import("../../examples/ts/04-exceeded.ts"),
  import("../../examples/ts/05-warnings.ts"),
  import("../../examples/ts/06-tenants.ts"),
  import("../../examples/ts/07-idempotency.ts"),
]);
await import("./type-assertions.ts");

console.log(`Horse Holder client examples, against ${baseUrl}\n`);

let failed = 0;
for (const [index, example] of examples.entries()) {
  console.log(`${index + 1}. ${example.name}`);
  try {
    await example.run();
    console.log("   ok\n");
  } catch (error) {
    failed += 1;
    console.error(`   FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof Error && error.stack !== undefined) {
      console.error(error.stack);
    }
  }
}

const passed = examples.length - failed;
console.log(`${passed}/${examples.length} examples passed`);
process.exit(failed === 0 ? 0 : 1);
