import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const DB = env.DB;

async function tableNames(): Promise<string[]> {
  const { results } = await DB.prepare(
    "select name from sqlite_master where type = 'table' and name like 'hf_%' order by name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

beforeEach(async () => {
  // Isolated storage gives each test a clean slate, but ordering matters for
  // the FK from classifications to spaces, so delete children first.
  await DB.batch([
    DB.prepare("delete from hf_classifications"),
    DB.prepare("delete from hf_weekly_metrics"),
    DB.prepare("delete from hf_spaces"),
    DB.prepare("delete from hf_models"),
    DB.prepare("delete from hf_raw_records"),
  ]);
});

describe("migration", () => {
  it("creates the five tables", async () => {
    expect(await tableNames()).toEqual([
      "hf_classifications",
      "hf_models",
      "hf_raw_records",
      "hf_spaces",
      "hf_weekly_metrics",
    ]);
  });

  it("declares every table STRICT", async () => {
    const { results } = await DB.prepare(
      "select name, sql from sqlite_master where type = 'table' and name like 'hf_%'",
    ).all<{ name: string; sql: string }>();
    expect(results.length).toBe(5);
    for (const t of results) {
      expect(t.sql.toUpperCase(), `${t.name} must be STRICT`).toMatch(/\)\s*STRICT\s*$/);
    }
  });
});

describe("hf_raw_records", () => {
  it("round-trips a payload byte-for-byte", async () => {
    // Replayability depends on this: what we store must be what we fetched.
    const payload = JSON.stringify({
      id: "Qwen/Qwen3-8B",
      tags: ["base_model:quantized:Qwen/Qwen3-8B", "text-generation"],
      unicode: "non-ascii title",
      nested: { deep: [1, 2, { three: true }] },
    });
    await DB.prepare(
      "insert into hf_raw_records (run_id, entity_kind, entity_id, fetched_at, payload) values (?,?,?,?,?)",
    )
      .bind("run-1", "model", "Qwen/Qwen3-8B", "2026-08-17T00:00:00.000Z", payload)
      .run();

    const row = await DB.prepare("select payload from hf_raw_records").first<{ payload: string }>();
    expect(row?.payload).toBe(payload);
    expect(JSON.parse(row!.payload)).toEqual(JSON.parse(payload));
  });

  it("rejects a payload that is not valid JSON", async () => {
    // A payload only discovered to be unparseable at replay time is a payload
    // that can no longer be re-fetched, so it must fail at write time.
    await expect(
      DB.prepare(
        "insert into hf_raw_records (run_id, entity_kind, entity_id, fetched_at, payload) values (?,?,?,?,?)",
      )
        .bind("run-1", "model", "a/b", "2026-08-17T00:00:00.000Z", "{not json")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects an unknown entity_kind", async () => {
    await expect(
      DB.prepare(
        "insert into hf_raw_records (run_id, entity_kind, entity_id, fetched_at, payload) values (?,?,?,?,?)",
      )
        .bind("run-1", "dataset", "a/b", "2026-08-17T00:00:00.000Z", "{}")
        .run(),
    ).rejects.toThrow();
  });

  it("is append-only: the same entity may be stored many times", async () => {
    for (const at of ["2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z"]) {
      await DB.prepare(
        "insert into hf_raw_records (run_id, entity_kind, entity_id, fetched_at, payload) values (?,?,?,?,?)",
      )
        .bind("run-1", "space", "user/demo", at, '{"id":"user/demo"}')
        .run();
    }
    const row = await DB.prepare(
      "select count(*) as n from hf_raw_records where entity_id = 'user/demo'",
    ).first<{ n: number }>();
    expect(row?.n).toBe(2);
  });
});

describe("hf_models", () => {
  const TS = "2026-08-17T00:00:00.000Z";

  const insert = (repoId: string, extra: Record<string, string | number> = {}) => {
    const cols: Record<string, string | number> = {
      repo_id: repoId,
      created_at: TS,
      first_seen_at: TS,
      updated_at: TS,
      ...extra,
    };
    const keys = Object.keys(cols);
    return DB.prepare(
      `insert into hf_models (${keys.join(",")}) values (${keys.map(() => "?").join(",")})`,
    ).bind(...Object.values(cols));
  };

  it("enforces STRICT column types", async () => {
    // Without STRICT, SQLite would silently store the string 'many' in an
    // INTEGER column and every download aggregate would be wrong.
    await expect(insert("a/b", { likes: "many" }).run()).rejects.toThrow();
  });

  it("keeps rolling downloads and the all-time counter in separate columns", async () => {
    await insert("a/b", { downloads: 1200, downloads_all_time: 98000 }).run();
    const row = await DB.prepare(
      "select downloads, downloads_all_time from hf_models where repo_id = 'a/b'",
    ).first<{ downloads: number; downloads_all_time: number }>();
    expect(row).toEqual({ downloads: 1200, downloads_all_time: 98000 });
  });

  it("rejects a derivative_type outside the taxonomy", async () => {
    await expect(insert("a/b", { derivative_type: "distillation" }).run()).rejects.toThrow();
    await expect(insert("c/d", { derivative_type: "quantization" }).run()).resolves.toBeDefined();
  });

  it("upserts rather than duplicating on re-ingest", async () => {
    await insert("a/b", { likes: 1 }).run();
    await DB.prepare(
      `insert into hf_models (repo_id, created_at, first_seen_at, updated_at, likes)
       values (?,?,?,?,?)
       on conflict (repo_id) do update set likes = excluded.likes, updated_at = excluded.updated_at`,
    )
      .bind("a/b", TS, TS, "2026-08-24T00:00:00.000Z", 42)
      .run();

    const row = await DB.prepare(
      "select count(*) as n, max(likes) as likes from hf_models",
    ).first<{ n: number; likes: number }>();
    expect(row).toEqual({ n: 1, likes: 42 });
  });

  it("unnests a JSON tag array with json_each", async () => {
    await insert("bartowski/Qwen_Qwen3-8B-GGUF", {
      tags: JSON.stringify(["base_model:quantized:Qwen/Qwen3-8B", "gguf", "text-generation"]),
    }).run();
    const { results } = await DB.prepare(
      `select j.value as tag from hf_models m, json_each(m.tags) j
       where j.value like 'base_model:%'`,
    ).all<{ tag: string }>();
    expect(results.map((r) => r.tag)).toEqual(["base_model:quantized:Qwen/Qwen3-8B"]);
  });
});

describe("hf_classifications", () => {
  const SPACE = "user/demo";
  const TS = "2026-08-17T00:00:00.000Z";

  beforeEach(async () => {
    await DB.prepare(
      "insert into hf_spaces (space_id, created_at, first_seen_at, updated_at) values (?,?,?,?)",
    )
      .bind(SPACE, TS, TS, TS)
      .run();
  });

  const classify = (taxonomyVersion: string, useCase = "coding") =>
    DB.prepare(
      `insert into hf_classifications
         (space_id, taxonomy_version, primary_use_case, source_kind, source_ref, classified_at)
       values (?,?,?,?,?,?)`,
    ).bind(SPACE, taxonomyVersion, useCase, "rule", "rule:tag-agentic", "2026-08-18T00:00:00.000Z");

  it("allows two taxonomy versions to coexist for one Space", async () => {
    // The replayability rule made physical: bumping the taxonomy must restate
    // history without destroying the previous answer.
    await classify("1").run();
    await classify("2", "agentic-coding").run();
    const { results } = await DB.prepare(
      "select taxonomy_version, primary_use_case from hf_classifications order by taxonomy_version",
    ).all<{ taxonomy_version: string; primary_use_case: string }>();
    expect(results).toEqual([
      { taxonomy_version: "1", primary_use_case: "coding" },
      { taxonomy_version: "2", primary_use_case: "agentic-coding" },
    ]);
  });

  it("permits only one classification per Space per taxonomy version", async () => {
    await classify("1").run();
    await expect(classify("1", "voice").run()).rejects.toThrow();
  });

  it("requires a single-valued primary use case", async () => {
    // Exactly one use case per Space is what lets share-by-use-case sum to 100%.
    await expect(
      DB.prepare(
        `insert into hf_classifications
           (space_id, taxonomy_version, source_kind, source_ref, classified_at)
         values (?,?,?,?,?)`,
      )
        .bind(SPACE, "1", "rule", "r", "2026-08-18T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a classification for a Space that does not exist", async () => {
    await expect(
      DB.prepare(
        `insert into hf_classifications
           (space_id, taxonomy_version, primary_use_case, source_kind, source_ref, classified_at)
         values (?,?,?,?,?,?)`,
      )
        .bind("ghost/none", "1", "coding", "rule", "r", "2026-08-18T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects an unknown source_kind", async () => {
    await expect(
      DB.prepare(
        `insert into hf_classifications
           (space_id, taxonomy_version, primary_use_case, source_kind, source_ref, classified_at)
         values (?,?,?,?,?,?)`,
      )
        .bind(SPACE, "1", "coding", "vibes", "r", "2026-08-18T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
  });

  it("stores multi-label dimensions as JSON arrays", async () => {
    await DB.prepare(
      `insert into hf_classifications
         (space_id, taxonomy_version, primary_use_case, verticals, technologies,
          source_kind, source_ref, classified_at)
       values (?,?,?,?,?,?,?,?)`,
    )
      .bind(
        SPACE,
        "1",
        "document-ai",
        JSON.stringify(["healthcare", "legal"]),
        JSON.stringify(["rag", "multimodal"]),
        "model",
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "2026-08-18T00:00:00.000Z",
      )
      .run();

    const { results } = await DB.prepare(
      "select j.value as vertical from hf_classifications c, json_each(c.verticals) j order by j.value",
    ).all<{ vertical: string }>();
    expect(results.map((r) => r.vertical)).toEqual(["healthcare", "legal"]);
  });
});

describe("hf_weekly_metrics", () => {
  const metric = (dimension: string, value: number, subDimension = "") =>
    DB.prepare(
      `insert into hf_weekly_metrics
         (week_start, metric_cut, dimension, sub_dimension, value, denominator, coverage,
          taxonomy_version, computed_at)
       values (?,?,?,?,?,?,?,?,?)
       on conflict (week_start, metric_cut, dimension, sub_dimension, taxonomy_version)
       do update set value = excluded.value, computed_at = excluded.computed_at`,
    ).bind(
      "2026-08-17",
      "spaces_by_use_case",
      dimension,
      subDimension,
      value,
      4410,
      0.65,
      "1",
      "2026-08-24T00:00:00.000Z",
    );

  it("upserts a re-run instead of double-counting", async () => {
    // The trap this guards: sub_dimension is NOT NULL DEFAULT '' because
    // SQLite treats NULLs as distinct in a UNIQUE index, so a nullable column
    // would let every re-run insert a second copy of the same metric.
    await metric("coding", 312).run();
    await metric("coding", 318).run();
    const row = await DB.prepare(
      "select count(*) as n, max(value) as value from hf_weekly_metrics",
    ).first<{ n: number; value: number }>();
    expect(row).toEqual({ n: 1, value: 318 });
  });

  it("separates cross-tab rows by sub_dimension", async () => {
    await metric("coding", 89, "qwen").run();
    await metric("coding", 61, "llama").run();
    await metric("coding", 312).run();
    const row = await DB.prepare("select count(*) as n from hf_weekly_metrics").first<{
      n: number;
    }>();
    expect(row?.n).toBe(3);
  });

  it("requires a denominator on every row", async () => {
    // A metric without its denominator is the exact failure mode the coverage
    // discipline exists to prevent, so the schema refuses to store one.
    await expect(
      DB.prepare(
        `insert into hf_weekly_metrics
           (week_start, metric_cut, dimension, value, taxonomy_version, computed_at)
         values (?,?,?,?,?,?)`,
      )
        .bind("2026-08-17", "spaces_by_use_case", "coding", 312, "1", "2026-08-24T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
  });
});
