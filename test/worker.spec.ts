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

  it("serves the published data files", async () => {
    // The dashboard reads these instead of an API. A missing series.json is
    // the one failure that empties the whole page, and it is invisible from
    // the Worker's own code — nothing here references it.
    const res = await SELF.fetch("https://example.com/data/series.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { weeks: string[]; series: unknown[] };
    expect(body.weeks.length).toBeGreaterThan(0);
    expect(body.series.length).toBeGreaterThan(0);
  });

  it("tells a caller of the retired API where the data went", async () => {
    // 410 rather than 404: these paths existed for months, and a bookmark or
    // a runbook hitting one should learn that it moved, not that it never was.
    const res = await SELF.fetch("https://example.com/api/series?weeks=12");
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("gone");
    expect(body.detail).toContain("/data");
  });

  it("does not answer /api/* with the dashboard HTML", async () => {
    const res = await SELF.fetch("https://example.com/api/nope");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
