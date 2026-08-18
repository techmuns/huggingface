import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // As of @cloudflare/vitest-pool-workers 0.21 (the Vitest 4 line) the
    // integration is a Vite plugin; `defineWorkersConfig` and the old
    // `test.poolOptions.workers` block were both removed.
    cloudflareTest({
      // Tests run inside the real workerd runtime against the bindings
      // declared in wrangler.jsonc, so D1 under test is actual SQLite rather
      // than a mock that quietly disagrees with production.
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
