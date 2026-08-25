import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The resolver's queries must SEEK, not SCAN.
 *
 * D1 bills rows READ, and on the free plan the ceiling is 5 million a day.
 * One run on 2026-08-25 read 19.5 million, of which 22.5 million across four
 * queries came from the resolver walking the unresolved model set — to return
 * about four hundred rows. The cause was an index on (family, created_at)
 * against queries that order by repo_id, so SQLite read every unresolved row
 * and sorted, on every sub-chunk.
 *
 * These assertions read SQLite's own plan rather than timing anything, because
 * the failure is not slowness — it is volume, and volume is invisible until a
 * quota rejects it.
 */
const DB = env.DB;

async function plan(sql: string): Promise<string> {
  const rows = await DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
  return (rows.results ?? []).map((r) => r.detail).join(" | ");
}

describe("the resolver seeks the unresolved set instead of scanning it", () => {
  it("the tags rung uses the index", async () => {
    const detail = await plan(
      `SELECT repo_id, tags FROM hf_models
       WHERE family IS NULL AND repo_id > '' ORDER BY repo_id LIMIT 250`,
    );
    expect(detail).toContain("idx_models_unresolved");
    expect(detail).not.toMatch(/SCAN hf_models(?! USING)/);
  });

  it("the architecture rung uses the index", async () => {
    const detail = await plan(
      `SELECT repo_id, model_type, tags, pipeline_tag, library_name FROM hf_models
       WHERE family IS NULL AND repo_id > '' ORDER BY repo_id LIMIT 250`,
    );
    expect(detail).toContain("idx_models_unresolved");
  });

  it("the name rung uses the index despite its extra filter", async () => {
    const detail = await plan(
      `SELECT repo_id FROM hf_models
       WHERE family IS NULL AND base_model IS NULL AND repo_id > '' ORDER BY repo_id LIMIT 250`,
    );
    expect(detail).toContain("idx_models_unresolved");
  });

  it("no resolver query sorts the whole set to satisfy ORDER BY", async () => {
    // A "USE TEMP B-TREE FOR ORDER BY" here means SQLite materialised and
    // sorted every matching row — which is precisely the 88,000-row read the
    // old index forced, 117 times a run.
    for (const sql of [
      `SELECT repo_id, tags FROM hf_models WHERE family IS NULL AND repo_id > '' ORDER BY repo_id LIMIT 250`,
      `SELECT repo_id FROM hf_models WHERE family IS NULL AND base_model IS NULL AND repo_id > '' ORDER BY repo_id LIMIT 250`,
    ]) {
      expect(await plan(sql)).not.toContain("TEMP B-TREE FOR ORDER BY");
    }
  });

  it("the aggregate's family breakdown still has an index to use", async () => {
    // The index this replaces was (family, created_at). Nothing filtered on a
    // family VALUE — every `family =` in src/ is a SET inside an UPDATE — but
    // the weekly breakdown does select a created_at range, and must keep
    // seeking rather than scanning.
    const detail = await plan(
      `SELECT COALESCE(family, 'unknown') AS dim, COUNT(*) AS cnt FROM hf_models
       WHERE created_at >= '2026-08-17' AND created_at < '2026-08-24' GROUP BY family`,
    );
    expect(detail).toContain("idx_models_created");
  });
});
