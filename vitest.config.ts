import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Read in Node, apply inside the Workers runtime: `readD1Migrations` parses the
// SQL files from disk, which tests running in workerd have no access to.
const migrations = await readD1Migrations("./migrations");

/**
 * Two runtimes, one library.
 *
 * `src/lib` runs against a local SQLite file in production now — the weekly
 * run is a Node process on a GitHub-hosted runner. It is still tested in both
 * places, and the workers project is why: D1 is the oracle the SQLite shim was
 * written against, and the only way to know the two have not drifted is to
 * keep running the same code against the real thing.
 *
 * The deployed Worker has no database at all. So D1 lives in this harness and
 * nowhere else — see the miniflare block below.
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
            // Tests run inside the real workerd runtime, so D1 under test is
            // actual D1 rather than a mock that quietly disagrees with it.
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              // Test-only, every one of them. wrangler.jsonc declares no
              // database and no credentials, because the deployed Worker needs
              // neither. The pipeline these tests drive needs both, so the
              // harness supplies them and a deploy cannot inherit them.
              d1Databases: { DB: "hf-activity-test" },
              bindings: {
                TEST_MIGRATIONS: migrations,
                HF_TOKEN: "test-hf-token",
                BEDROCK_API_KEY: "test-bedrock-key",
                BEDROCK_REGION: "us-east-1",
                BEDROCK_CLASSIFY_MODEL_ID: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
                BEDROCK_NARRATE_MODEL_ID: "us.anthropic.claude-opus-5",
                GITHUB_TOKEN: "test-github-token",
                GITHUB_REPO: "techmuns/huggingface",
              },
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
