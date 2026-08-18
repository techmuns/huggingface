import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { aggregateWeeklyMetrics } from "../src/lib/aggregate";
import { classifySpacesByRules } from "../src/lib/classify-rules";
import { insertRawRecords } from "../src/lib/raw-store";
import { parseRawModels, parseRawSpaces } from "../src/lib/parse";
import { resolveModelFamilies } from "../src/lib/model-family";

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

async function seedClassifiedSpaces(
  spaces: Array<{
    id: string;
    tags?: string[];
    models?: string[];
    sdk?: string;
    cardData?: Record<string, unknown>;
  }>,
) {
  await insertRawRecords(DB, {
    runId: "run-1",
    kind: "space",
    records: spaces.map((s) => ({
      id: s.id,
      author: s.id.split("/")[0],
      createdAt: "2026-08-17T12:00:00.000Z",
      lastModified: "2026-08-17T12:00:00.000Z",
      likes: 2,
      sdk: s.sdk ?? "gradio",
      tags: s.tags ?? [],
      models: s.models ?? [],
      datasets: [],
      cardData: s.cardData ?? { title: s.id.split("/")[1] },
    })),
    fetchedAt: "2026-08-18T00:00:00.000Z",
  });
  await parseRawSpaces(DB, "run-1");
  await classifySpacesByRules(DB, "2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
}

async function seedModels(
  models: Array<{ id: string; tags?: string[] }>,
) {
  await insertRawRecords(DB, {
    runId: "run-1",
    kind: "model",
    records: models.map((m) => ({
      id: m.id,
      author: m.id.split("/")[0],
      createdAt: "2026-08-17T12:00:00.000Z",
      lastModified: "2026-08-17T12:00:00.000Z",
      downloads: 100,
      downloadsAllTime: 1000,
      likes: 10,
      pipeline_tag: "text-generation",
      tags: m.tags ?? [],
    })),
    fetchedAt: "2026-08-18T00:00:00.000Z",
  });
  await parseRawModels(DB, "run-1");
  await resolveModelFamilies(DB);
}

describe("aggregateWeeklyMetrics", () => {
  const WEEK_START = "2026-08-17";
  const WEEK_END = "2026-08-24T00:00:00.000Z";

  it("computes spaces_by_use_case metrics", async () => {
    await seedClassifiedSpaces([
      { id: "a/chatbot-1", tags: ["text-generation"] },
      { id: "b/chatbot-2", tags: ["text-generation"] },
      { id: "c/image-gen", tags: ["text-to-image"] },
    ]);

    const result = await aggregateWeeklyMetrics(DB, WEEK_START, WEEK_END);
    expect(result.metricsWritten).toBeGreaterThan(0);

    const rows = await DB.prepare(
      `SELECT dimension, value FROM hf_weekly_metrics
       WHERE week_start = ?1 AND metric_cut = 'spaces_by_use_case'
       ORDER BY value DESC`,
    )
      .bind(WEEK_START)
      .all<{ dimension: string; value: number }>();

    const chatbot = rows.results?.find((r) => r.dimension === "chatbot");
    const imageGen = rows.results?.find((r) => r.dimension === "image-generation");
    expect(chatbot?.value).toBe(2);
    expect(imageGen?.value).toBe(1);
  });

  it("computes share_by_use_case that sums to 100%", async () => {
    await seedClassifiedSpaces([
      { id: "a/chatbot", tags: ["text-generation"] },
      { id: "b/img", tags: ["text-to-image"] },
    ]);

    await aggregateWeeklyMetrics(DB, WEEK_START, WEEK_END);

    const rows = await DB.prepare(
      `SELECT SUM(value) AS total FROM hf_weekly_metrics
       WHERE week_start = ?1 AND metric_cut = 'share_by_use_case'`,
    )
      .bind(WEEK_START)
      .first<{ total: number }>();

    expect(rows?.total).toBeCloseTo(100, 0);
  });

  it("computes models_by_family", async () => {
    await seedModels([
      { id: "user/qwen-finetune", tags: ["base_model:quantized:Qwen/Qwen3-8B"] },
      { id: "user/llama-thing", tags: ["base_model:meta-llama/Llama-3-8B"] },
    ]);

    await aggregateWeeklyMetrics(DB, WEEK_START, WEEK_END);

    const rows = await DB.prepare(
      `SELECT dimension, value FROM hf_weekly_metrics
       WHERE week_start = ?1 AND metric_cut = 'models_by_family'`,
    )
      .bind(WEEK_START)
      .all<{ dimension: string; value: number }>();

    expect(rows.results?.length).toBeGreaterThan(0);
  });

  it("computes engagement metrics", async () => {
    await seedModels([{ id: "user/model-a" }]);

    await aggregateWeeklyMetrics(DB, WEEK_START, WEEK_END);

    const rows = await DB.prepare(
      `SELECT dimension FROM hf_weekly_metrics
       WHERE week_start = ?1 AND metric_cut = 'engagement'`,
    )
      .bind(WEEK_START)
      .all<{ dimension: string }>();

    const dims = rows.results?.map((r) => r.dimension) ?? [];
    expect(dims).toContain("model_downloads");
    expect(dims).toContain("model_likes");
  });

  it("every metric row has a denominator", async () => {
    await seedClassifiedSpaces([
      { id: "a/chatbot", tags: ["text-generation"] },
    ]);

    await aggregateWeeklyMetrics(DB, WEEK_START, WEEK_END);

    const missing = await DB.prepare(
      `SELECT COUNT(*) AS cnt FROM hf_weekly_metrics
       WHERE week_start = ?1 AND denominator IS NULL`,
    )
      .bind(WEEK_START)
      .first<{ cnt: number }>();

    expect(missing?.cnt).toBe(0);
  });

  it("is idempotent — re-running upserts rather than duplicates", async () => {
    await seedClassifiedSpaces([
      { id: "a/chatbot", tags: ["text-generation"] },
    ]);

    await aggregateWeeklyMetrics(DB, WEEK_START, WEEK_END);
    await aggregateWeeklyMetrics(DB, WEEK_START, WEEK_END);

    const count = await DB.prepare(
      `SELECT COUNT(*) AS cnt FROM hf_weekly_metrics WHERE week_start = ?1`,
    )
      .bind(WEEK_START)
      .first<{ cnt: number }>();

    const uniqueCount = await DB.prepare(
      `SELECT COUNT(DISTINCT metric_cut || dimension || sub_dimension) AS cnt
       FROM hf_weekly_metrics WHERE week_start = ?1`,
    )
      .bind(WEEK_START)
      .first<{ cnt: number }>();

    expect(count?.cnt).toBe(uniqueCount?.cnt);
  });
});
