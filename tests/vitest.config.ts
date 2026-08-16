import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./setup.ts"],
    // Several tests wait out a reservation TTL or a renewal boundary in real time.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
