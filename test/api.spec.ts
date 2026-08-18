import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { aggregateWeeklyMetrics } from "../src/lib/aggregate";
import { classifySpacesByRules } from "../src/lib/classify-rules";
import { insertRawRecords } from "../src/lib/raw-store";
import { parseRawSpaces } from "../src/lib/parse";

const DB = env.DB;

beforeEach(async () => {
  await DB.batch([
    DB.prepare("DELETE FROM hf_weekly_metrics"),
    DB.prepare("DELETE FROM hf_classifications"),
    DB.prepare("DELETE FROM hf_spaces"),
    DB.prepare("DELETE FROM hf_models"),
    DB.prepare("DELETE FROM hf_raw_records"),
  ]);
});

async function seedAndAggregate() {
  await insertRawRecords(DB, {
    runId: "run-1",
    kind: "space",
    records: [
      {
        id: "a/chatbot",
        author: "a",
        createdAt: "2026-08-17T12:00:00.000Z",
        lastModified: "2026-08-17T12:00:00.000Z",
        likes: 0,
        sdk: "gradio",
        tags: ["text-generation"],
        models: [],
        datasets: [],
        cardData: { title: "chatbot" },
      },
    ],
    fetchedAt: "2026-08-18T00:00:00.000Z",
  });
  await parseRawSpaces(DB, "run-1");
  await classifySpacesByRules(DB, "2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
  await aggregateWeeklyMetrics(DB, "2026-08-17", "2026-08-24T00:00:00.000Z");
}

describe("GET /api/metrics", () => {
  it("returns metrics for a valid week", async () => {
    await seedAndAggregate();
    const res = await SELF.fetch("http://localhost/api/metrics?week=2026-08-17");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { metrics: unknown[] };
    expect(data.metrics.length).toBeGreaterThan(0);
  });

  it("rejects missing week param", async () => {
    const res = await SELF.fetch("http://localhost/api/metrics");
    expect(res.status).toBe(400);
  });

  it("rejects unknown cut", async () => {
    const res = await SELF.fetch("http://localhost/api/metrics?week=2026-08-17&cut=bogus");
    expect(res.status).toBe(400);
  });

  it("filters by cut", async () => {
    await seedAndAggregate();
    const res = await SELF.fetch(
      "http://localhost/api/metrics?week=2026-08-17&cut=spaces_by_use_case",
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { metrics: Array<{ metric_cut: string }> };
    for (const m of data.metrics) {
      expect(m.metric_cut).toBe("spaces_by_use_case");
    }
  });
});

describe("GET /api/weeks", () => {
  it("returns a list of available weeks", async () => {
    await seedAndAggregate();
    const res = await SELF.fetch("http://localhost/api/weeks");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { weeks: string[] };
    expect(data.weeks).toContain("2026-08-17");
  });

  it("returns empty array when no data exists", async () => {
    const res = await SELF.fetch("http://localhost/api/weeks");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { weeks: string[] };
    expect(data.weeks).toEqual([]);
  });
});

describe("GET /api/coverage", () => {
  it("returns coverage stats", async () => {
    await seedAndAggregate();
    const res = await SELF.fetch("http://localhost/api/coverage?week=2026-08-17");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      totalSpaces: number;
      classifiedSpaces: number;
      coveragePercent: number;
    };
    expect(data.totalSpaces).toBe(1);
    expect(data.classifiedSpaces).toBe(1);
    expect(data.coveragePercent).toBe(100);
  });

  it("rejects missing week param", async () => {
    const res = await SELF.fetch("http://localhost/api/coverage");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/review-queue", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await SELF.fetch("http://localhost/api/review-queue");
    expect(res.status).toBe(401);
  });
});

describe("unknown API paths", () => {
  it("returns 404 for unknown /api/* paths", async () => {
    const res = await SELF.fetch("http://localhost/api/nonexistent");
    expect(res.status).toBe(404);
  });
});
