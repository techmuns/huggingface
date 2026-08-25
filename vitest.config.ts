import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Read in Node, apply inside the Workers runtime: `readD1Migrations` parses the
// SQL files from disk, which tests running in workerd have no access to.
const migrations = await readD1Migrations("./migrations");

/**
 * Two runtimes, one library.
 *
 * `src/lib` runs in two places now — inside workerd against a D1 binding, and
 * on a Node runner against a local SQLite file — so it is tested in both. The
 * workers project is unchanged and still the source of truth: it exercises the
 * code the deployed dashboard actually runs, against real D1.
 *
 * The node project exists for the parts workerd cannot host: `node:sqlite` is
 * not available there. test/d1-conformance.ts is written once and run by both,
 * with the D1 binding as the oracle — if an assertion cannot be made to pass
 * against real D1, the contract is wrong and the shim would have been built to
 * the wrong specification.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            // Tests run inside the real workerd runtime against the bindings
            // declared in wrangler.jsonc, so D1 under test is actual SQLite
            // rather than a mock that quietly disagrees with production.
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: { TEST_MIGRATIONS: migrations },
            },
          }),
        ],
        test: {
          name: "workers",
          setupFiles: ["./test/setup.ts"],
          include: ["test/**/*.spec.ts"],
          exclude: [
            "test/node/**",
            // Throwaway measurement specs; same patterns as .gitignore and
            // tsconfig. Kept in step deliberately — a scratch file that is
            // ignored by one and picked up by another fails the build for
            // code nobody kept.
            "test/_*",
            "test/tmp*",
            "test/zz*",
            "test/aaa*",
            "test/*scratch*",
            "test/*probe*",
            "test/*bench*",
            "test/*measure*",
            "test/*cost*",
            "test/*-check.spec.ts",
          ],
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/node/**/*.spec.ts"],
        },
      },
    ],
  },
});
