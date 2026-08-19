import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { aggregateWeeklyMetrics } from "../src/lib/aggregate";
import { classifySpacesByRules } from "../src/lib/classify-rules";
import { insertRawRecords } from "../src/lib/raw-store";
import { parseRawSpaces } from "../src/lib/parse";
import { TAXONOMY_VERSION } from "../src/lib/taxonomy";

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

/**
 * Two weeks, deliberately with a different SDK in each, so the aligned-array
 * response has a real hole in it. A hole is the case the dashboard's trend
 * line most needs to get right: a category that did not appear in a week must
 * arrive as null, never as a zero the chart would draw a crash through.
 */
async function seedTwoWeeks() {
  await insertRawRecords(DB, {
    runId: "run-w1",
    kind: "space",
    records: [
      {
        id: "a/chatbot",
        author: "a",
        createdAt: "2026-08-10T12:00:00.000Z",
        lastModified: "2026-08-10T12:00:00.000Z",
        likes: 0,
        sdk: "gradio",
        tags: ["text-generation"],
        models: [],
        datasets: [],
        cardData: { title: "chatbot" },
      },
    ],
    fetchedAt: "2026-08-11T00:00:00.000Z",
  });
  await parseRawSpaces(DB, "run-w1");
  await classifySpacesByRules(DB, "2026-08-10T00:00:00.000Z", "2026-08-17T00:00:00.000Z");
  await aggregateWeeklyMetrics(DB, "2026-08-10", "2026-08-17T00:00:00.000Z");

  await insertRawRecords(DB, {
    runId: "run-w2",
    kind: "space",
    records: [
      {
        id: "b/doc-tool",
        author: "b",
        createdAt: "2026-08-17T12:00:00.000Z",
        lastModified: "2026-08-17T12:00:00.000Z",
        likes: 0,
        sdk: "docker",
        tags: ["text-generation"],
        models: [],
        datasets: [],
        cardData: { title: "doc tool" },
      },
    ],
    fetchedAt: "2026-08-18T00:00:00.000Z",
  });
  await parseRawSpaces(DB, "run-w2");
  await classifySpacesByRules(DB, "2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
  await aggregateWeeklyMetrics(DB, "2026-08-17", "2026-08-24T00:00:00.000Z");
}

interface SeriesResponse {
  weeks: string[];
  series: {
    cut: string;
    dimension: string;
    subDimension: string;
    values: (number | null)[];
    denominators: (number | null)[];
    suppressed: number[];
  }[];
}

describe("GET /api/series", () => {
  it("returns weeks oldest-first with every series aligned to them", async () => {
    await seedTwoWeeks();
    const res = await SELF.fetch("http://localhost/api/series");
    expect(res.status).toBe(200);

    const data = (await res.json()) as SeriesResponse;
    expect(data.weeks).toEqual(["2026-08-10", "2026-08-17"]);
    expect(data.series.length).toBeGreaterThan(0);
    for (const s of data.series) {
      expect(s.values).toHaveLength(data.weeks.length);
      expect(s.denominators).toHaveLength(data.weeks.length);
      expect(s.suppressed).toHaveLength(data.weeks.length);
    }
  });

  it("leaves a null where a category has no row for a week", async () => {
    await seedTwoWeeks();
    const res = await SELF.fetch("http://localhost/api/series?cut=sdk_distribution");
    const data = (await res.json()) as SeriesResponse;

    const gradio = data.series.find((s) => s.dimension === "gradio");
    const docker = data.series.find((s) => s.dimension === "docker");
    expect(gradio?.values).toEqual([1, null]);
    expect(docker?.values).toEqual([null, 1]);
  });

  it("omits the cross-tab cut unless it is asked for by name", async () => {
    await seedTwoWeeks();
    // Written straight into the metrics table rather than aggregated: the
    // cross-tab needs Spaces with resolved model families behind them, and
    // what is under test here is the endpoint's filtering, not the pipeline
    // that fills the table. Without a row of this cut in the database the
    // assertion below passes over an empty array and proves nothing.
    await DB.prepare(
      `INSERT INTO hf_weekly_metrics (
         week_start, metric_cut, dimension, sub_dimension, value, denominator,
         coverage, delta_1w, delta_4w, delta_12w, suppressed, taxonomy_version, computed_at
       ) VALUES ('2026-08-17', 'family_share_by_use_case', 'coding', 'qwen',
                 42.0, 100, NULL, NULL, NULL, NULL, 0, ?1, datetime('now'))`,
    )
      .bind(TAXONOMY_VERSION)
      .run();

    const wide = (await (await SELF.fetch("http://localhost/api/series")).json()) as SeriesResponse;
    expect(wide.series.some((s) => s.cut === "family_share_by_use_case")).toBe(false);
    expect(wide.series.length).toBeGreaterThan(0);

    const asked = (await (
      await SELF.fetch("http://localhost/api/series?cut=family_share_by_use_case")
    ).json()) as SeriesResponse;
    expect(asked.series.length).toBeGreaterThan(0);
    expect(asked.series.every((s) => s.cut === "family_share_by_use_case")).toBe(true);
    expect(asked.series[0]?.subDimension).toBe("qwen");
  });

  it("treats an empty cut= as no cut at all", async () => {
    await seedTwoWeeks();
    const res = await SELF.fetch("http://localhost/api/series?cut=");
    expect(res.status).toBe(200);
    const data = (await res.json()) as SeriesResponse;
    expect(data.series.length).toBeGreaterThan(0);
  });

  it("returns only the newest week when asked for one", async () => {
    await seedTwoWeeks();
    const res = await SELF.fetch("http://localhost/api/series?weeks=1");
    const data = (await res.json()) as SeriesResponse;
    expect(data.weeks).toEqual(["2026-08-17"]);
  });

  it("rejects an unknown cut", async () => {
    const res = await SELF.fetch("http://localhost/api/series?cut=bogus");
    expect(res.status).toBe(400);
  });

  it("rejects a weeks value outside the cap", async () => {
    for (const weeks of ["0", "53", "3.5", "many"]) {
      const res = await SELF.fetch(`http://localhost/api/series?weeks=${weeks}`);
      expect(res.status).toBe(400);
    }
  });

  it("answers with empty arrays before any week has been aggregated", async () => {
    const res = await SELF.fetch("http://localhost/api/series");
    expect(res.status).toBe(200);
    const data = (await res.json()) as SeriesResponse;
    expect(data.weeks).toEqual([]);
    expect(data.series).toEqual([]);
  });

  it("rejects a non-GET method", async () => {
    const res = await SELF.fetch("http://localhost/api/series", { method: "POST" });
    expect(res.status).toBe(405);
  });
});
