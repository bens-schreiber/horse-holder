// @ts-check
import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  adapter: cloudflare({
    imageService: "compile",
    platformProxy: { configPath: "wrangler.dev.jsonc" },
  }),
  security: {
    checkOrigin: false,
  },
});
