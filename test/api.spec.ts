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
    for (const weeks of ["0", "157", "3.5", "many", "-1"]) {
      const res = await SELF.fetch(`http://localhost/api/series?weeks=${weeks}`);
      expect(res.status).toBe(400);
    }
  });

  it("accepts the cap itself", async () => {
    const res = await SELF.fetch("http://localhost/api/series?weeks=156");
    expect(res.status).toBe(200);
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

// ── /api/use-case-spaces ────────────────────────────────────────────────────

interface UseCaseSpacesResponse {
  useCase: string;
  from: string;
  to: string;
  total: number;
  withTraction: number;
  likes: number;
  spaces: Array<{
    spaceId: string; title: string | null; author: string | null;
    likes: number; createdAt: string; sdk: string | null;
    description: string | null; lowConfidence: boolean;
  }>;
}

describe("/api/use-case-spaces", () => {
  /** Seven Spaces in one use case, six of them with no likes at all. */
  async function seedCoding() {
    const rows: Array<[string, string, number, number]> = [
      // space_id, created_at, likes, is_cluster_primary
      ["a/code-1", "2026-08-03T01:00:00.000Z", 12, 1],
      ["a/code-2", "2026-08-04T01:00:00.000Z", 5, 1],
      ["a/code-3", "2026-08-05T01:00:00.000Z", 0, 1],
      ["a/code-4", "2026-08-06T01:00:00.000Z", 0, 1],
      ["a/code-5", "2026-08-07T01:00:00.000Z", 0, 1],
      // a duplicate of a viral template: real likes, but it is not its own Space
      ["a/code-dupe", "2026-08-07T02:00:00.000Z", 99, 0],
      // outside the window
      ["a/code-old", "2026-07-20T01:00:00.000Z", 40, 1],
    ];
    await DB.batch(rows.map(([id, created, likes, primary]) =>
      DB.prepare(
        `INSERT INTO hf_spaces (space_id, author, created_at, last_modified, likes,
           title, sdk, tags, linked_models, linked_datasets, is_cluster_primary,
           first_seen_at, updated_at)
         VALUES (?1,'a',?2,?2,?3,?4,'gradio','[]','[]','[]',?5,?2,?2)`,
      ).bind(id, created, likes, id.split("/")[1], primary)));

    await DB.batch(rows.map(([id, created]) =>
      DB.prepare(
        `INSERT INTO hf_classifications (space_id, taxonomy_version, primary_use_case,
           verticals, model_families, technologies, source_kind, source_ref, classified_at)
         VALUES (?1, ?2, 'coding', '[]', '[]', '[]', 'rule', 'r1', ?3)`,
      ).bind(id, TAXONOMY_VERSION, created)));
  }

  const get = (q: string) => SELF.fetch(`http://localhost/api/use-case-spaces?${q}`);

  it("ranks the new Spaces in one use case that got any traction", async () => {
    await seedCoding();
    const res = await get("useCase=coding&from=2026-08-03&to=2026-08-10");
    expect(res.status).toBe(200);
    const data = (await res.json()) as UseCaseSpacesResponse;
    expect(data.spaces.map((s) => s.spaceId)).toEqual(["a/code-1", "a/code-2"]);
    expect(data.spaces[0]!.likes).toBe(12);
  });

  it("says how few of them that is, rather than presenting a leaderboard", async () => {
    // 95.5% of new Spaces never get a single like. A top ten with no
    // denominator beside it reads as "the ten biggest" instead of "the only
    // two anybody noticed".
    await seedCoding();
    const data = (await (await get("useCase=coding&from=2026-08-03&to=2026-08-10")).json()) as UseCaseSpacesResponse;
    expect(data.total).toBe(5);
    expect(data.withTraction).toBe(2);
  });

  it("counts clusters, not copies", async () => {
    // One viral template produced 2% of a day's Spaces on its own. The
    // duplicate here has more likes than anything else in the window and must
    // not appear, or the drill-down becomes a list of one template.
    await seedCoding();
    const data = (await (await get("useCase=coding&from=2026-08-03&to=2026-08-10")).json()) as UseCaseSpacesResponse;
    expect(data.spaces.map((s) => s.spaceId)).not.toContain("a/code-dupe");
    expect(data.total).toBe(5);
  });

  it("treats `to` as exclusive, like every other window in the pipeline", async () => {
    await seedCoding();
    const inside = (await (await get("useCase=coding&from=2026-07-20&to=2026-08-04")).json()) as UseCaseSpacesResponse;
    expect(inside.spaces.map((s) => s.spaceId)).toEqual(["a/code-old", "a/code-1"]);
    const boundary = (await (await get("useCase=coding&from=2026-07-20&to=2026-08-03")).json()) as UseCaseSpacesResponse;
    expect(boundary.spaces.map((s) => s.spaceId)).toEqual(["a/code-old"]);
  });

  it("orders ties by newest, then by id, so two identical requests agree", async () => {
    await DB.batch([
      DB.prepare(
        `INSERT INTO hf_spaces (space_id, author, created_at, last_modified, likes, title,
           sdk, tags, linked_models, linked_datasets, is_cluster_primary, first_seen_at, updated_at)
         VALUES ('z/tie','z','2026-08-03T00:00:00.000Z','2026-08-03T00:00:00.000Z',4,'z','gradio','[]','[]','[]',1,'2026-08-03T00:00:00.000Z','2026-08-03T00:00:00.000Z')`,
      ),
      DB.prepare(
        `INSERT INTO hf_spaces (space_id, author, created_at, last_modified, likes, title,
           sdk, tags, linked_models, linked_datasets, is_cluster_primary, first_seen_at, updated_at)
         VALUES ('a/tie','a','2026-08-04T00:00:00.000Z','2026-08-04T00:00:00.000Z',4,'a','gradio','[]','[]','[]',1,'2026-08-04T00:00:00.000Z','2026-08-04T00:00:00.000Z')`,
      ),
    ]);
    await DB.batch(["z/tie", "a/tie"].map((id) =>
      DB.prepare(
        `INSERT INTO hf_classifications (space_id, taxonomy_version, primary_use_case,
           verticals, model_families, technologies, source_kind, source_ref, classified_at)
         VALUES (?1, ?2, 'coding', '[]', '[]', '[]', 'rule', 'r1', '2026-08-04T00:00:00.000Z')`,
      ).bind(id, TAXONOMY_VERSION)));

    const once = (await (await get("useCase=coding&from=2026-08-01&to=2026-08-10")).json()) as UseCaseSpacesResponse;
    const twice = (await (await get("useCase=coding&from=2026-08-01&to=2026-08-10")).json()) as UseCaseSpacesResponse;
    expect(once.spaces.map((s) => s.spaceId)).toEqual(["a/tie", "z/tie"]);
    expect(twice.spaces.map((s) => s.spaceId)).toEqual(once.spaces.map((s) => s.spaceId));
  });

  it("answers honestly when nothing in the window got noticed", async () => {
    await seedCoding();
    const data = (await (await get("useCase=coding&from=2026-08-05&to=2026-08-07")).json()) as UseCaseSpacesResponse;
    expect(data.spaces).toEqual([]);
    expect(data.total).toBe(2);
    expect(data.withTraction).toBe(0);
  });

  it("rejects a use case that is not in the taxonomy", async () => {
    const res = await get("useCase=not-a-use-case&from=2026-08-03&to=2026-08-10");
    expect(res.status).toBe(400);
  });

  it("rejects a missing or malformed window", async () => {
    expect((await get("useCase=coding")).status).toBe(400);
    expect((await get("useCase=coding&from=2026-08-03")).status).toBe(400);
    expect((await get("useCase=coding&from=03-08-2026&to=2026-08-10")).status).toBe(400);
    expect((await get("useCase=coding&from=2026-08-10&to=2026-08-03")).status).toBe(400);
    expect((await get("useCase=coding&from=2026-08-03&to=2026-08-03")).status).toBe(400);
  });

  it("rejects a limit outside the cap", async () => {
    expect((await get("useCase=coding&from=2026-08-03&to=2026-08-10&limit=0")).status).toBe(400);
    expect((await get("useCase=coding&from=2026-08-03&to=2026-08-10&limit=51")).status).toBe(400);
    expect((await get("useCase=coding&from=2026-08-03&to=2026-08-10&limit=2.5")).status).toBe(400);
    expect((await get("useCase=coding&from=2026-08-03&to=2026-08-10&limit=50")).status).toBe(200);
  });

  it("rejects a non-GET method", async () => {
    const res = await SELF.fetch(
      "http://localhost/api/use-case-spaces?useCase=coding&from=2026-08-03&to=2026-08-10",
      { method: "POST" },
    );
    expect(res.status).toBe(405);
  });
});

// ── a selection that is not one unbroken span ───────────────────────────────

describe("/api/use-case-spaces honours the exact weeks", () => {
  async function seedThreeWeeks() {
    const rows: Array<[string, string, number]> = [
      ["a/w1-liked", "2026-08-03T01:00:00.000Z", 10],
      ["a/w1-quiet", "2026-08-03T02:00:00.000Z", 0],
      ["a/w2-liked", "2026-08-10T01:00:00.000Z", 20],
      ["a/w2-quiet", "2026-08-10T02:00:00.000Z", 0],
      ["a/w3-liked", "2026-08-17T01:00:00.000Z", 30],
      ["a/w3-quiet", "2026-08-17T02:00:00.000Z", 0],
    ];
    await DB.batch(rows.map(([id, created, likes]) =>
      DB.prepare(
        `INSERT INTO hf_spaces (space_id, author, created_at, last_modified, likes, title,
           sdk, tags, linked_models, linked_datasets, is_cluster_primary, first_seen_at, updated_at)
         VALUES (?1,'a',?2,?2,?3,?4,'gradio','[]','[]','[]',1,?2,?2)`,
      ).bind(id, created, likes, id)));
    await DB.batch(rows.map(([id, created]) =>
      DB.prepare(
        `INSERT INTO hf_classifications (space_id, taxonomy_version, primary_use_case,
           verticals, model_families, technologies, source_kind, source_ref, classified_at)
         VALUES (?1, ?2, 'coding', '[]', '[]', '[]', 'rule', 'r1', ?3)`,
      ).bind(id, TAXONOMY_VERSION, created)));
  }
  const get = (q: string) => SELF.fetch(`http://localhost/api/use-case-spaces?${q}`);

  it("skips a week inside the span that was not picked", async () => {
    // The defect: from/to describes a RANGE, and a reader can pick two periods
    // with a third between them. Without this the card counted the third and
    // reported more Spaces than the bars it was opened from.
    await seedThreeWeeks();
    const span = "useCase=coding&from=2026-08-03&to=2026-08-24";
    const all = (await (await get(span)).json()) as UseCaseSpacesResponse;
    expect(all.total).toBe(6);

    const picked = (await (await get(`${span}&weeks=2026-08-03,2026-08-17`)).json()) as UseCaseSpacesResponse;
    expect(picked.total).toBe(4);
    expect(picked.withTraction).toBe(2);
    expect(picked.spaces.map((s) => s.spaceId)).toEqual(["a/w3-liked", "a/w1-liked"]);
  });

  it("applies the same filter to the count and to the list", async () => {
    // A denominator over one span and rows over another is the defect wearing
    // a different hat.
    await seedThreeWeeks();
    const d = (await (await get(
      "useCase=coding&from=2026-08-03&to=2026-08-24&weeks=2026-08-10",
    )).json()) as UseCaseSpacesResponse;
    expect(d.total).toBe(2);
    expect(d.withTraction).toBe(1);
    expect(d.spaces).toHaveLength(1);
    expect(d.spaces[0]!.spaceId).toBe("a/w2-liked");
  });

  it("echoes the weeks so a caller can see they were honoured", async () => {
    await seedThreeWeeks();
    const d = (await (await get(
      "useCase=coding&from=2026-08-03&to=2026-08-24&weeks=2026-08-03,2026-08-17",
    )).json()) as UseCaseSpacesResponse & { weeks: string[] | null };
    expect(d.weeks).toEqual(["2026-08-03", "2026-08-17"]);
  });

  it("behaves exactly as before when weeks is omitted", async () => {
    await seedThreeWeeks();
    const d = (await (await get("useCase=coding&from=2026-08-03&to=2026-08-24")).json()) as
      UseCaseSpacesResponse & { weeks: string[] | null };
    expect(d.weeks).toBeNull();
    expect(d.total).toBe(6);
  });

  it("rejects a malformed or oversized weeks list", async () => {
    expect((await get("useCase=coding&from=2026-08-03&to=2026-08-24&weeks=")).status).toBe(400);
    expect((await get("useCase=coding&from=2026-08-03&to=2026-08-24&weeks=03-08-2026")).status).toBe(400);
    const many = Array.from({ length: 161 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, "0")}`).join(",");
    expect((await get(`useCase=coding&from=2026-08-03&to=2026-08-24&weeks=${many}`)).status).toBe(400);
  });
});
