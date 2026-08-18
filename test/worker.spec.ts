import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("serves /health", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  it("serves the dashboard page from the assets binding", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>HF Developer Activity</title>");
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
