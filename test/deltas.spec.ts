/**
 * Growth-window tests.
 *
 * These pin the arithmetic in computeDeltas with hand-computed numbers rather
 * than whatever the implementation happens to produce. The 4W/12W windows are
 * the reason the brief asks for them at all — a point-to-point comparison
 * against a single week three months ago is exactly the noise they exist to
 * remove — so the pooling has to be verified against figures worked out
 * independently of the code.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { aggregateWeeklyMetrics } from "../src/lib/aggregate";
import { classifySpacesByRules } from "../src/lib/classify-rules";
import { parseRawSpaces } from "../src/lib/parse";
import { insertRawRecords } from "../src/lib/raw-store";
import { TAXONOMY_VERSION } from "../src/lib/taxonomy";

const DB = env.DB;

// 2026-08-17 is a Monday; each entry steps back exactly one week.
const W = "2026-08-17";
const W_END = "2026-08-24T00:00:00.000Z";
const W1 = "2026-08-10";
const W2 = "2026-08-03";
const W3 = "2026-07-27";
const W4 = "2026-07-20";
const W5 = "2026-07-13";
const W6 = "2026-07-06";
const W7 = "2026-06-29";

beforeEach(async () => {
  await DB.batch([
    DB.prepare("DELETE FROM hf_weekly_metrics"),
    DB.prepare("DELETE FROM hf_classifications"),
    DB.prepare("DELETE FROM hf_spaces"),
    DB.prepare("DELETE FROM hf_models"),
    DB.prepare("DELETE FROM hf_raw_records"),
  ]);
});

/** Writes a historical metric row directly, standing in for an earlier run. */
async function seedMetric(
  weekStart: string,
  cut: string,
  dimension: string,
  value: number,
  denominator: number,
  subDimension = "",
) {
  await DB.prepare(
    `INSERT INTO hf_weekly_metrics
       (week_start, metric_cut, dimension, sub_dimension, value, denominator,
        suppressed, taxonomy_version, computed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))`,
  )
    .bind(
      weekStart, cut, dimension, subDimension, value, denominator,
      denominator < 10 ? 1 : 0, TAXONOMY_VERSION,
    )
    .run();
}

/**
 * Seeds `codingCount` coding Spaces and `chatCount` chat Spaces into the
 * current week, then classifies them.
 */
async function seedCurrentWeek(codingCount: number, chatCount: number) {
  const records = [];
  for (let i = 0; i < codingCount; i++) {
    records.push({
      id: `dev${i}/code-tool-${i}`,
      author: `dev${i}`,
      createdAt: `${W}T12:00:00.000Z`,
      lastModified: `${W}T12:00:00.000Z`,
      likes: 0,
      sdk: "gradio",
      tags: ["code-generation"],
      models: [],
      datasets: [],
      cardData: { title: `Code Tool ${i}` },
    });
  }
  for (let i = 0; i < chatCount; i++) {
    records.push({
      id: `chat${i}/assistant-${i}`,
      author: `chat${i}`,
      createdAt: `${W}T12:00:00.000Z`,
      lastModified: `${W}T12:00:00.000Z`,
      likes: 0,
      sdk: "gradio",
      tags: ["conversational"],
      models: [],
      datasets: [],
      cardData: { title: `Assistant ${i}` },
    });
  }

  await insertRawRecords(DB, {
    runId: "run-1",
    kind: "space",
    records,
    fetchedAt: "2026-08-18T00:00:00.000Z",
  });
  await parseRawSpaces(DB, "run-1");
  await classifySpacesByRules(DB, `${W}T00:00:00.000Z`, W_END);
}

async function deltasFor(cut: string, dimension: string) {
  return DB.prepare(
    `SELECT value, delta_1w, delta_4w, delta_12w, suppressed
     FROM hf_weekly_metrics
     WHERE week_start = ?1 AND metric_cut = ?2 AND dimension = ?3
       AND sub_dimension = '' AND taxonomy_version = ?4`,
  )
    .bind(W, cut, dimension, TAXONOMY_VERSION)
    .first<{
      value: number;
      delta_1w: number | null;
      delta_4w: number | null;
      delta_12w: number | null;
      suppressed: number;
    }>();
}

describe("1W growth", () => {
  it("computes a count delta against the previous week", async () => {
    // Current week: 8 coding of 12 total.
    await seedCurrentWeek(8, 4);
    // Previous week had 4 coding.
    await seedMetric(W1, "spaces_by_use_case", "coding", 4, 12);

    await aggregateWeeklyMetrics(DB, W, W_END);

    const row = await deltasFor("spaces_by_use_case", "coding");
    expect(row?.value).toBe(8);
    // (8 - 4) / 4 = +100%
    expect(row?.delta_1w).toBeCloseTo(100, 6);
  });

  it("computes a percentage delta as a denominator-weighted rate", async () => {
    await seedCurrentWeek(8, 4);
    // Previous week: coding was 40% of a 12-Space base.
    await seedMetric(W1, "share_by_use_case", "coding", 40, 12);

    await aggregateWeeklyMetrics(DB, W, W_END);

    const row = await deltasFor("share_by_use_case", "coding");
    // Current share: 8 of 12 classified = 66.666...%
    expect(row?.value).toBeCloseTo(66.6667, 3);
    // (66.6667 - 40) / 40 = +66.6667%
    expect(row?.delta_1w).toBeCloseTo(66.6667, 3);
  });

  it("reports a negative delta when activity falls", async () => {
    await seedCurrentWeek(3, 9);
    await seedMetric(W1, "spaces_by_use_case", "coding", 6, 12);

    await aggregateWeeklyMetrics(DB, W, W_END);

    // (3 - 6) / 6 = -50%
    expect((await deltasFor("spaces_by_use_case", "coding"))?.delta_1w).toBeCloseTo(-50, 6);
  });
});

describe("4W growth", () => {
  it("pools four trailing weeks against the four preceding weeks", async () => {
    // Current window is [W-3, W-2, W-1, W]; previous is [W-7, W-6, W-5, W-4].
    // The two must be disjoint, adjacent and equal-length.
    await seedCurrentWeek(8, 4); // W contributes 8

    for (const wk of [W3, W2, W1]) {
      await seedMetric(wk, "spaces_by_use_case", "coding", 5, 12);
    }
    for (const wk of [W7, W6, W5, W4]) {
      await seedMetric(wk, "spaces_by_use_case", "coding", 2, 12);
    }

    await aggregateWeeklyMetrics(DB, W, W_END);

    const row = await deltasFor("spaces_by_use_case", "coding");
    // current = 5 + 5 + 5 + 8 = 23; previous = 2 + 2 + 2 + 2 = 8
    // (23 - 8) / 8 = +187.5%
    expect(row?.delta_4w).toBeCloseTo(187.5, 6);
  });

  it("does not let a week outside either window leak in", async () => {
    await seedCurrentWeek(8, 4);

    for (const wk of [W3, W2, W1]) {
      await seedMetric(wk, "spaces_by_use_case", "coding", 5, 12);
    }
    for (const wk of [W7, W6, W5, W4]) {
      await seedMetric(wk, "spaces_by_use_case", "coding", 2, 12);
    }
    // A week eight back sits outside BOTH windows; a spike here must not move
    // the 4W figure. This is the off-by-one guard.
    await seedMetric("2026-06-22", "spaces_by_use_case", "coding", 9999, 12);

    await aggregateWeeklyMetrics(DB, W, W_END);

    expect((await deltasFor("spaces_by_use_case", "coding"))?.delta_4w).toBeCloseTo(187.5, 6);
  });

  it("smooths a single-week spike relative to the 1W reading", async () => {
    // The whole point of the 4W window: one loud week should move it far less
    // than it moves the weekly number.
    await seedCurrentWeek(12, 0);

    for (const wk of [W3, W2, W1]) {
      await seedMetric(wk, "spaces_by_use_case", "coding", 4, 12);
    }
    for (const wk of [W7, W6, W5, W4]) {
      await seedMetric(wk, "spaces_by_use_case", "coding", 4, 12);
    }

    await aggregateWeeklyMetrics(DB, W, W_END);

    const row = await deltasFor("spaces_by_use_case", "coding");
    // 1W: (12 - 4) / 4 = +200%
    expect(row?.delta_1w).toBeCloseTo(200, 6);
    // 4W: (4+4+4+12 - 16) / 16 = +50%
    expect(row?.delta_4w).toBeCloseTo(50, 6);
    expect(Math.abs(row!.delta_4w!)).toBeLessThan(Math.abs(row!.delta_1w!));
  });
});

describe("guards", () => {
  it("leaves deltas null when there is no prior history", async () => {
    await seedCurrentWeek(8, 4);
    await aggregateWeeklyMetrics(DB, W, W_END);

    const row = await deltasFor("spaces_by_use_case", "coding");
    expect(row?.delta_1w).toBeNull();
    expect(row?.delta_4w).toBeNull();
    expect(row?.delta_12w).toBeNull();
  });

  it("refuses to report growth off a base too small to be meaningful", async () => {
    await seedCurrentWeek(8, 4);
    // A 3-Space base would yield a confident-looking but meaningless swing.
    await seedMetric(W1, "spaces_by_use_case", "coding", 1, 3);

    await aggregateWeeklyMetrics(DB, W, W_END);

    expect((await deltasFor("spaces_by_use_case", "coding"))?.delta_1w).toBeNull();
  });

  it("refuses to divide by a zero base", async () => {
    await seedCurrentWeek(8, 4);
    await seedMetric(W1, "spaces_by_use_case", "coding", 0, 40);

    await aggregateWeeklyMetrics(DB, W, W_END);

    const delta = (await deltasFor("spaces_by_use_case", "coding"))?.delta_1w;
    expect(delta).toBeNull();
    expect(Number.isFinite(delta ?? 0)).toBe(true);
  });

  it("does not attach deltas to a row whose own denominator is suppressed", async () => {
    // Only 4 Spaces this week, so the row is suppressed; pairing "too few to
    // report" with a confident percentage would be worse than saying nothing.
    await seedCurrentWeek(3, 1);
    await seedMetric(W1, "spaces_by_use_case", "coding", 2, 40);

    await aggregateWeeklyMetrics(DB, W, W_END);

    const row = await deltasFor("spaces_by_use_case", "coding");
    expect(row?.suppressed).toBe(1);
    expect(row?.delta_1w).toBeNull();
  });

  it("is idempotent — recomputing yields identical deltas", async () => {
    await seedCurrentWeek(8, 4);
    await seedMetric(W1, "spaces_by_use_case", "coding", 4, 12);

    await aggregateWeeklyMetrics(DB, W, W_END);
    const first = await deltasFor("spaces_by_use_case", "coding");
    await aggregateWeeklyMetrics(DB, W, W_END);
    const second = await deltasFor("spaces_by_use_case", "coding");

    expect(second).toEqual(first);
  });
});
