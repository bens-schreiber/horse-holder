import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Isolated storage is off: its per-test stack-frame rollback does not work against
        // SQLite-backed Durable Objects (it fails popping the frame on the `-shm` file).
        // Tests do not need it: every test mints a fresh scope via the harness and a fresh
        // group, so each lands in its own Durable Object and shares state with nothing.
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
