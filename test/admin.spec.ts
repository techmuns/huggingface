import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseRunParams } from "../src/index";
import { isAuthorized, timingSafeEqual } from "../src/lib/auth";

describe("timingSafeEqual", () => {
  it("matches identical strings", () => {
    expect(timingSafeEqual("s3cret", "s3cret")).toBe(true);
  });

  it("rejects different strings of equal length", () => {
    expect(timingSafeEqual("s3cret", "s3crea")).toBe(false);
  });

  it("rejects different lengths", () => {
    expect(timingSafeEqual("s3cret", "s3cret-longer")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });

  it("compares by bytes, not code units", () => {
    expect(timingSafeEqual("café", "café")).toBe(true);
    expect(timingSafeEqual("café", "cafe")).toBe(false);
  });
});

describe("isAuthorized", () => {
  const req = (authorization?: string) =>
    new Request("https://example.com/api/admin/run", {
      method: "POST",
      ...(authorization ? { headers: { authorization } } : {}),
    });

  it("accepts a correct bearer token", () => {
    expect(isAuthorized(req("Bearer s3cret"), "s3cret")).toBe(true);
    expect(isAuthorized(req("bearer s3cret"), "s3cret")).toBe(true);
  });

  it("rejects a wrong or missing token", () => {
    expect(isAuthorized(req("Bearer wrong"), "s3cret")).toBe(false);
    expect(isAuthorized(req(), "s3cret")).toBe(false);
    expect(isAuthorized(req("s3cret"), "s3cret")).toBe(false);
    expect(isAuthorized(req("Basic s3cret"), "s3cret")).toBe(false);
  });

  it("fails closed when the admin token is not configured", () => {
    // An unconfigured deployment must reject everything, not accept everything.
    expect(isAuthorized(req("Bearer anything"), undefined)).toBe(false);
    expect(isAuthorized(req("Bearer "), "")).toBe(false);
  });
});

describe("parseRunParams", () => {
  it("accepts an empty body", () => {
    expect(parseRunParams({})).toEqual({ params: {} });
  });

  it("accepts a valid Monday and backfill", () => {
    expect(parseRunParams({ weekStart: "2026-08-17", backfillWeeks: 12, dryRun: true })).toEqual({
      params: { weekStart: "2026-08-17", backfillWeeks: 12, dryRun: true },
    });
  });

  it("rejects a weekStart that is not a Monday", () => {
    // Silently snapping it would make the run report a different week than
    // the one that was asked for.
    expect(parseRunParams({ weekStart: "2026-08-20" })).toEqual({
      error: "weekStart must be a Monday",
    });
  });

  it("rejects a malformed or impossible date", () => {
    expect(parseRunParams({ weekStart: "17-08-2026" })).toMatchObject({ error: expect.any(String) });
    expect(parseRunParams({ weekStart: "2026-02-31" })).toMatchObject({ error: expect.any(String) });
  });

  it("bounds backfillWeeks, which multiplies into request volume", () => {
    expect(parseRunParams({ backfillWeeks: 0 })).toMatchObject({ error: expect.any(String) });
    expect(parseRunParams({ backfillWeeks: 99 })).toMatchObject({ error: expect.any(String) });
    expect(parseRunParams({ backfillWeeks: 1.5 })).toMatchObject({ error: expect.any(String) });
    expect(parseRunParams({ backfillWeeks: "12" })).toMatchObject({ error: expect.any(String) });
  });

  it("rejects unknown fields instead of ignoring them", () => {
    // A typo'd `backfill_weeks` that silently did nothing would look like the
    // backfill ran and found very little.
    expect(parseRunParams({ backfill_weeks: 12 })).toMatchObject({
      error: "unknown field(s): backfill_weeks",
    });
  });

  it("rejects non-object bodies", () => {
    expect(parseRunParams(null)).toMatchObject({ error: expect.any(String) });
    expect(parseRunParams([])).toMatchObject({ error: expect.any(String) });
    expect(parseRunParams("weekStart=2026-08-17")).toMatchObject({ error: expect.any(String) });
  });

  it("rejects a wrongly typed dryRun", () => {
    expect(parseRunParams({ dryRun: "yes" })).toMatchObject({ error: expect.any(String) });
  });
});

describe("POST /api/admin/run", () => {
  const post = (init: RequestInit = {}) =>
    SELF.fetch("https://example.com/api/admin/run", { method: "POST", ...init });

  it("rejects an unauthenticated call", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects a wrong token", async () => {
    expect((await post({ headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("rejects a non-POST method", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/run");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("checks auth before parsing the body, so an anonymous caller learns nothing", async () => {
    const res = await post({
      headers: { "content-type": "application/json" },
      body: "{ this is not json",
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid params for an authenticated caller", async () => {
    const res = await post({
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ backfillWeeks: 999 }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_params" });
  });

  it("rejects a malformed JSON body for an authenticated caller", async () => {
    const res = await post({
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, "content-type": "application/json" },
      body: "{ this is not json",
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_json" });
  });
});

describe("unknown API routes", () => {
  it("answer 404 JSON rather than serving the dashboard HTML", async () => {
    const res = await SELF.fetch("https://example.com/api/nope");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "not_found" });
  });
});
