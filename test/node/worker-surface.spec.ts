import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What the deployed Worker is allowed to be.
 *
 * A guard on the config rather than on the code, because the config is where
 * this can silently come back: adding a binding is one line, and a Worker with
 * a database again is a Worker that can query it per page load. That is the
 * shape the pipeline just spent a month failing in — 5 million rows read a day
 * against a run that read 19.5 million, and a 10 ms CPU ceiling per Workflow
 * step that killed six runs.
 *
 * Read from disk rather than from `cloudflare:test`, deliberately. Miniflare
 * merges .env into the test environment, so asking the running Worker what it
 * has is a question about the developer's machine. The file is the deploy.
 */

const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url).pathname, "utf8");

/** JSONC: wrangler's own format, and this file is mostly comments. */
const parsed = JSON.parse(
  config
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, ""),
) as Record<string, unknown>;

describe("the deployed Worker's surface", () => {
  it("declares no database", () => {
    expect(parsed.d1_databases).toBeUndefined();
  });

  it("declares no workflow", () => {
    expect(parsed.workflows).toBeUndefined();
  });

  it("declares no cron trigger", () => {
    // The schedule is .github/workflows/weekly-runner.yml, and a trigger here
    // would fire into a Worker with no scheduled() handler.
    expect(parsed.triggers).toBeUndefined();
  });

  it("needs no secrets", () => {
    expect(parsed.secrets).toBeUndefined();
  });

  it("still serves the page and its data", () => {
    expect(parsed.assets).toMatchObject({ directory: "./public/", binding: "ASSETS" });
  });
});

describe("the Worker's code", () => {
  const source = readFileSync(new URL("../../src/index.ts", import.meta.url).pathname, "utf8");

  it("touches neither a database nor a workflow", () => {
    expect(source).not.toMatch(/\benv\.DB\b/);
    expect(source).not.toMatch(/WEEKLY_PIPELINE/);
    expect(source).not.toMatch(/\bprepare\(/);
  });

  it("has no scheduled handler", () => {
    expect(source).not.toMatch(/\bscheduled\s*\(/);
  });
});
