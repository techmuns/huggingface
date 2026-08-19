import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("serves /health", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("reports which version is deployed", async () => {
    // The point of these two fields: a push and its deploy are minutes apart,
    // and a run started in that gap executes the previous version. Twice today
    // a failure was attributed to code that had already been fixed but was not
    // yet live. Both keys must always be present — a missing key reads as "no
    // information" and sends you back to inferring it from behaviour.
    const res = await SELF.fetch("https://example.com/health");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["deployedAt", "status", "version"]);
  });

  it("serves the dashboard page from the assets binding", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>HF Developer Activity Dashboard</title>");
  });
});

describe("bindings", () => {
  it("exposes a working D1 database", async () => {
    const row = await env.DB.prepare("select 1 as n").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("exposes the weekly pipeline workflow binding", () => {
    expect(typeof env.WEEKLY_PIPELINE?.create).toBe("function");
  });

  it("carries the plaintext vars the pipeline reads", () => {
    expect(env.BEDROCK_REGION).toBe("us-east-1");
    // Classification is the high-volume path and must stay on the cheap model.
    expect(env.BEDROCK_CLASSIFY_MODEL_ID).toContain("haiku");
    expect(env.BEDROCK_NARRATE_MODEL_ID).toContain("opus");
  });
});
