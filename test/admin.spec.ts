import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { missingColumns, parseRunParams } from "../src/index";
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

describe("schema drift probe", () => {
  it("reports nothing missing when every migration has been applied", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/stats", {
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      schema: { ok: true, missingColumns: [] },
    });
  });

  it("names a column the database does not have", async () => {
    // The point of the probe: a column the deployed code writes but the
    // database lacks has to surface here, not as a failed write deep inside
    // a run. Local D1 has every migration applied, so an absent column is the
    // only way to exercise the detection.
    await expect(
      missingColumns(env.DB, [["hf_models", "column_that_does_not_exist"]]),
    ).resolves.toEqual(["hf_models.column_that_does_not_exist"]);
  });

  it("passes a column that does exist", async () => {
    await expect(
      missingColumns(env.DB, [["hf_models", "model_type"]]),
    ).resolves.toEqual([]);
  });
});

describe("run registry", () => {
  it("requires auth to list runs", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/runs");
    expect(res.status).toBe(401);
  });

  it("lists runs for an authorised caller", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/runs", {
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ runs: expect.any(Array) });
  });

  it("requires auth to terminate a run", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/run/abc123/terminate", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("rejects GET on terminate", async () => {
    // Terminating is destructive, so it must never be reachable by following
    // a link or by a browser prefetching a URL someone pasted.
    const res = await SELF.fetch("https://example.com/api/admin/run/abc123/terminate", {
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(405);
  });

  it("does not route a terminate path to the status handler", async () => {
    // The status route's regex allows the same characters as an instance id,
    // so an ordering mistake would have `/terminate` swallowed as part of the
    // id and silently return status instead of stopping anything.
    const res = await SELF.fetch("https://example.com/api/admin/run/abc123/terminate", {
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect(res.status).not.toBe(200);
  });
});

describe("run params cannot be silently dropped", () => {
  const post = (init: RequestInit) =>
    SELF.fetch("https://example.com/api/admin/run", { method: "POST", ...init });

  it("refuses a body sent without a JSON content-type", async () => {
    // The failure this pins: the body used to be ignored, the run started with
    // defaults, and 202 came back as though the request had been honoured — so
    // a run asked for one week quietly processed another.
    const res = await post({
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
      body: JSON.stringify({ weekStart: "2026-08-10", backfillWeeks: 1 }),
    });
    expect(res.status).toBe(415);
    const json = (await res.json()) as { error: string; detail: string };
    expect(json.error).toBe("unsupported_media_type");
    // The message has to name what actually arrived, or the next occurrence is
    // another archaeology exercise. fetch stamps text/plain on a string body
    // when the caller sets no content-type, so that is what should be quoted
    // back — the header the server saw, not a guess at what was intended.
    expect(json.detail).toContain("text/plain");
  });

  it("still accepts a bodyless POST, which means defaults on purpose", async () => {
    const res = await post({ headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` } });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ params: {} });
  });

  it("echoes back exactly the params it accepted", async () => {
    const res = await post({
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ weekStart: "2026-08-10", backfillWeeks: 1, dryRun: true }),
    });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      params: { weekStart: "2026-08-10", backfillWeeks: 1, dryRun: true },
    });
  });
});
