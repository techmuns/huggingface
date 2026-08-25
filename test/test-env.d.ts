import type { D1Migration } from "cloudflare:test";

/**
 * Bindings that exist only under test.
 *
 * `cloudflare:test` types its `env` as `Cloudflare.Env`, the interface
 * `wrangler types` generates from wrangler.jsonc, so a test-only binding has
 * to be merged into that namespace rather than declared alongside it.
 *
 * Everything here used to be in wrangler.jsonc and is not any more. The
 * deployed Worker serves a page: it has no database and no credentials. The
 * pipeline these tests drive has both, because it runs on a GitHub-hosted
 * runner — so the harness supplies them, and a deploy cannot pick them up.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      /** Parsed migrations/ SQL, injected by vitest.config.ts. */
      TEST_MIGRATIONS: D1Migration[];
      /** The oracle src/lib/d1-sqlite.ts is written against. */
      DB: D1Database;
      HF_TOKEN: string;
      BEDROCK_API_KEY: string;
      BEDROCK_REGION: string;
      BEDROCK_CLASSIFY_MODEL_ID: string;
      BEDROCK_NARRATE_MODEL_ID: string;
      GITHUB_TOKEN: string;
      GITHUB_REPO: string;
    }
  }
}

export {};
