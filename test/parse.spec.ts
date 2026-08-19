import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type BaseModelInfo,
  extractBaseModelInfo,
  matchFamily,
  matchFamilyByName,
  resolveModelFamilies,
} from "../src/lib/model-family";
import { parseRawModels, parseRawSpaces, upsertModels } from "../src/lib/parse";
import { insertRawRecords } from "../src/lib/raw-store";

const DB = env.DB;

beforeEach(async () => {
  await DB.batch([
    DB.prepare("DELETE FROM hf_classifications"),
    DB.prepare("DELETE FROM hf_weekly_metrics"),
    DB.prepare("DELETE FROM hf_spaces"),
    DB.prepare("DELETE FROM hf_models"),
    DB.prepare("DELETE FROM hf_raw_records"),
  ]);
});

// ── extractBaseModelInfo ────────────────────────────────────────────────────

describe("extractBaseModelInfo", () => {
  it("extracts a quantized relation", () => {
    const info = extractBaseModelInfo(["base_model:quantized:Qwen/Qwen3-8B", "gguf"]);
    expect(info).toEqual({ target: "Qwen/Qwen3-8B", relation: "quantization" });
  });

  it("extracts an adapter relation", () => {
    expect(extractBaseModelInfo(["base_model:adapter:meta-llama/Llama-3-8B"])).toEqual({
      target: "meta-llama/Llama-3-8B",
      relation: "adapter",
    });
  });

  it("extracts a merge relation", () => {
    expect(extractBaseModelInfo(["base_model:merge:org/model-a"])).toEqual({
      target: "org/model-a",
      relation: "merge",
    });
  });

  it("treats a bare base_model tag as finetune", () => {
    expect(extractBaseModelInfo(["base_model:Qwen/Qwen3-8B"])).toEqual({
      target: "Qwen/Qwen3-8B",
      relation: "finetune",
    });
  });

  it("prefers a qualified tag over a bare one", () => {
    const info = extractBaseModelInfo([
      "base_model:Qwen/Qwen3-8B",
      "base_model:quantized:Qwen/Qwen3-8B",
    ]);
    expect(info?.relation).toBe("quantization");
  });

  it("returns null when there are no base_model tags", () => {
    expect(extractBaseModelInfo(["text-generation", "gguf"])).toBeNull();
    expect(extractBaseModelInfo([])).toBeNull();
  });
});

// ── matchFamily ─────────────────────────────────────────────────────────────

describe("matchFamily", () => {
  it.each([
    ["Qwen/Qwen3-8B", "qwen"],
    ["meta-llama/Llama-3-8B", "llama"],
    ["deepseek-ai/DeepSeek-V2", "deepseek"],
    ["google/gemma-2-9b", "gemma"],
    ["mistralai/Mistral-7B-v0.1", "mistral"],
    ["THUDM/chatglm3-6b", "glm-zhipu"],
    ["moonshotai/Kimi-VL-A3B-Thinking", "kimi-moonshot"],
    ["nvidia/Nemotron-4-340B-Base", "nvidia-nemotron"],
  ] as const)("matches %s → %s", (target, expected) => {
    expect(matchFamily(target)).toBe(expected);
  });

  it("returns null for unknown orgs", () => {
    expect(matchFamily("someuser/my-cool-model")).toBeNull();
  });
});

describe("matchFamilyByName", () => {
  it.each([
    ["user/Qwen2-7B-Chat", "qwen"],
    ["user/llama-3-8b-instruct", "llama"],
    ["user/DeepSeek-Coder-V2", "deepseek"],
    ["user/gemma-2b-it", "gemma"],
    ["user/Mixtral-8x7B-GGUF", "mistral"],
  ] as const)("matches %s → %s", (repoId, expected) => {
    expect(matchFamilyByName(repoId)).toBe(expected);
  });

  it("returns null for names that carry no signal", () => {
    expect(matchFamilyByName("user/my-cool-model")).toBeNull();
  });
});

// ── parseRawModels ──────────────────────────────────────────────────────────

describe("parseRawModels", () => {
  const modelRecord = (overrides: Record<string, unknown> = {}) => ({
    id: "author/my-model",
    author: "author",
    createdAt: "2026-08-17T00:00:00.000Z",
    lastModified: "2026-08-17T12:00:00.000Z",
    downloads: 42,
    downloadsAllTime: 1000,
    likes: 5,
    pipeline_tag: "text-generation",
    library_name: "transformers",
    tags: ["text-generation", "pytorch"],
    ...overrides,
  });

  it("upserts raw model records into hf_models", async () => {
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "model",
      records: [modelRecord(), modelRecord({ id: "author/second" })],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });

    const count = await parseRawModels(DB, "run-1");
    expect(count).toBe(2);

    const row = await DB.prepare(
      "SELECT repo_id, author, downloads, pipeline_tag, tags FROM hf_models WHERE repo_id = ?",
    )
      .bind("author/my-model")
      .first<{ repo_id: string; author: string; downloads: number; pipeline_tag: string; tags: string }>();

    expect(row).toMatchObject({
      repo_id: "author/my-model",
      author: "author",
      downloads: 42,
      pipeline_tag: "text-generation",
    });
    expect(JSON.parse(row!.tags)).toEqual(["text-generation", "pytorch"]);
  });

  it("handles re-ingest by upserting — later data wins", async () => {
    for (const [fetchedAt, likes] of [
      ["2026-08-18T00:00:00.000Z", 5],
      ["2026-08-25T00:00:00.000Z", 10],
    ] as const) {
      await insertRawRecords(DB, {
        runId: "run-1",
        kind: "model",
        records: [modelRecord({ likes })],
        fetchedAt,
      });
    }
    await parseRawModels(DB, "run-1");

    const row = await DB.prepare("SELECT likes FROM hf_models WHERE repo_id = ?")
      .bind("author/my-model")
      .first<{ likes: number }>();
    expect(row?.likes).toBe(10);
  });

  it("skips records without an id", async () => {
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "model",
      records: [modelRecord(), { createdAt: "2026-08-17T00:00:00.000Z" } as never],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    expect(await parseRawModels(DB, "run-1")).toBe(1);
  });
});

// ── parseRawSpaces ──────────────────────────────────────────────────────────

describe("parseRawSpaces", () => {
  const spaceRecord = (overrides: Record<string, unknown> = {}) => ({
    id: "creator/my-space",
    author: "creator",
    createdAt: "2026-08-17T00:00:00.000Z",
    lastModified: "2026-08-17T12:00:00.000Z",
    likes: 2,
    sdk: "gradio",
    tags: ["gradio"],
    models: [],
    datasets: [],
    cardData: { title: "My Space", short_description: "Does cool things" },
    ...overrides,
  });

  it("upserts a space with rich signal_tier when it has a description", async () => {
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "space",
      records: [spaceRecord()],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    expect(await parseRawSpaces(DB, "run-1")).toBe(1);

    const row = await DB.prepare(
      "SELECT space_id, title, short_description, signal_tier FROM hf_spaces WHERE space_id = ?",
    )
      .bind("creator/my-space")
      .first<{ space_id: string; title: string; short_description: string; signal_tier: string }>();

    expect(row).toMatchObject({
      space_id: "creator/my-space",
      title: "My Space",
      short_description: "Does cool things",
      signal_tier: "rich",
    });
  });

  it("marks a space as rich when it has linked models but no description", async () => {
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "space",
      records: [
        spaceRecord({
          cardData: {},
          models: ["Qwen/Qwen3-8B"],
        }),
      ],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, "run-1");

    const row = await DB.prepare("SELECT signal_tier FROM hf_spaces WHERE space_id = ?")
      .bind("creator/my-space")
      .first<{ signal_tier: string }>();
    expect(row?.signal_tier).toBe("rich");
  });

  it("marks a space as blind when it has no description and no linked models", async () => {
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "space",
      records: [spaceRecord({ cardData: {}, models: [] })],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, "run-1");

    const row = await DB.prepare("SELECT signal_tier FROM hf_spaces WHERE space_id = ?")
      .bind("creator/my-space")
      .first<{ signal_tier: string }>();
    expect(row?.signal_tier).toBe("blind");
  });

  it("stores linked_models as a JSON array", async () => {
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "space",
      records: [spaceRecord({ models: ["Qwen/Qwen3-8B", "meta-llama/Llama-3-8B"] })],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, "run-1");

    const row = await DB.prepare("SELECT linked_models FROM hf_spaces WHERE space_id = ?")
      .bind("creator/my-space")
      .first<{ linked_models: string }>();
    expect(JSON.parse(row!.linked_models)).toEqual(["Qwen/Qwen3-8B", "meta-llama/Llama-3-8B"]);
  });
});

// ── resolveModelFamilies ────────────────────────────────────────────────────

describe("resolveModelFamilies", () => {
  async function seedModels(
    models: Array<{ id: string; tags?: string[]; cardData?: Record<string, unknown> }>,
  ) {
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "model",
      records: models.map((m) => ({
        id: m.id,
        createdAt: "2026-08-17T00:00:00.000Z",
        tags: m.tags ?? [],
        likes: 0,
        ...(m.cardData ? { cardData: m.cardData } : {}),
      })),
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawModels(DB, "run-1");
  }

  it("resolves family from base_model tags", async () => {
    await seedModels([
      { id: "user/my-gguf", tags: ["base_model:quantized:Qwen/Qwen3-8B", "gguf"] },
    ]);

    const result = await resolveModelFamilies(DB);
    expect(result.byTag).toBeGreaterThanOrEqual(1);

    const row = await DB.prepare(
      "SELECT family, derivative_type, base_model, resolution_source FROM hf_models WHERE repo_id = ?",
    )
      .bind("user/my-gguf")
      .first<{ family: string; derivative_type: string; base_model: string; resolution_source: string }>();

    expect(row).toMatchObject({
      family: "qwen",
      derivative_type: "quantization",
      base_model: "Qwen/Qwen3-8B",
      resolution_source: "base_model_tag",
    });
  });

  it("resolves by chain: A → B → known family", async () => {
    await seedModels([
      { id: "Qwen/Qwen3-8B", tags: [] },
      { id: "user/qwen-finetune", tags: ["base_model:Qwen/Qwen3-8B"] },
      { id: "user/qwen-gguf", tags: ["base_model:quantized:user/qwen-finetune"] },
    ]);

    await resolveModelFamilies(DB);

    const gguf = await DB.prepare("SELECT family FROM hf_models WHERE repo_id = ?")
      .bind("user/qwen-gguf")
      .first<{ family: string }>();
    expect(gguf?.family).toBe("qwen");
  });

  it("resolves by name pattern when there are no base_model tags", async () => {
    await seedModels([{ id: "user/Llama-3-8B-Instruct", tags: [] }]);

    const result = await resolveModelFamilies(DB);
    expect(result.byName).toBeGreaterThanOrEqual(1);

    const row = await DB.prepare("SELECT family, resolution_source FROM hf_models WHERE repo_id = ?")
      .bind("user/Llama-3-8B-Instruct")
      .first<{ family: string; resolution_source: string }>();
    expect(row).toMatchObject({ family: "llama", resolution_source: "name_pattern" });
  });

  it("marks unresolvable models with lineage as other-open", async () => {
    await seedModels([
      { id: "user/mystery-model", tags: ["base_model:unknown-org/obscure-model"] },
    ]);

    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family FROM hf_models WHERE repo_id = ?")
      .bind("user/mystery-model")
      .first<{ family: string }>();
    expect(row?.family).toBe("other-open");
  });

  it("leaves models with no lineage and no name match as NULL", async () => {
    await seedModels([{ id: "user/totally-custom-thing", tags: [] }]);

    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family FROM hf_models WHERE repo_id = ?")
      .bind("user/totally-custom-thing")
      .first<{ family: string | null }>();
    expect(row?.family).toBeNull();
  });

  it("resolves from cardData.base_model when tags are absent", async () => {
    await seedModels([
      { id: "user/card-declared", tags: [], cardData: { base_model: "meta-llama/Llama-3-8B" } },
    ]);

    const result = await resolveModelFamilies(DB);
    expect(result.byCardData).toBeGreaterThanOrEqual(1);

    const row = await DB.prepare("SELECT family, resolution_source FROM hf_models WHERE repo_id = ?")
      .bind("user/card-declared")
      .first<{ family: string; resolution_source: string }>();
    expect(row).toMatchObject({ family: "llama", resolution_source: "card_data" });
  });
});

// ── upsertModels (models bypass the raw store) ──────────────────────────────

describe("upsertModels", () => {
  const rec = (o: Record<string, unknown> = {}) => ({
    id: "author/direct-model",
    author: "author",
    createdAt: "2026-08-17T00:00:00.000Z",
    downloads: 7,
    likes: 3,
    tags: ["text-generation"],
    ...o,
  });

  it("writes models straight to hf_models without a raw record", async () => {
    const n = await upsertModels(DB, [rec(), rec({ id: "author/second" })], "2026-08-18T00:00:00.000Z");
    expect(n).toBe(2);

    const raw = await DB.prepare("SELECT COUNT(*) AS c FROM hf_raw_records WHERE entity_kind = 'model'")
      .first<{ c: number }>();
    expect(raw?.c).toBe(0);

    const row = await DB.prepare("SELECT repo_id, downloads, likes FROM hf_models WHERE repo_id = ?")
      .bind("author/direct-model")
      .first<{ repo_id: string; downloads: number; likes: number }>();
    expect(row).toMatchObject({ repo_id: "author/direct-model", downloads: 7, likes: 3 });
  });

  it("captures cardData.base_model, so family resolution keeps its second rung", async () => {
    // This column is the whole reason raw model payloads can be dropped:
    // resolveFromCardData used to reach into hf_raw_records for it.
    await upsertModels(
      DB,
      [rec({ id: "user/card-declared", tags: [], cardData: { base_model: "meta-llama/Llama-3-8B" } })],
      "2026-08-18T00:00:00.000Z",
    );

    const row = await DB.prepare("SELECT card_base_model FROM hf_models WHERE repo_id = ?")
      .bind("user/card-declared")
      .first<{ card_base_model: string }>();
    expect(row?.card_base_model).toBe("meta-llama/Llama-3-8B");

    const result = await resolveModelFamilies(DB);
    expect(result.byCardData).toBeGreaterThanOrEqual(1);

    const fam = await DB.prepare("SELECT family, resolution_source FROM hf_models WHERE repo_id = ?")
      .bind("user/card-declared")
      .first<{ family: string; resolution_source: string }>();
    expect(fam).toMatchObject({ family: "llama", resolution_source: "card_data" });
  });

  it("upserts on re-ingest rather than duplicating", async () => {
    await upsertModels(DB, [rec({ likes: 3 })], "2026-08-18T00:00:00.000Z");
    await upsertModels(DB, [rec({ likes: 91 })], "2026-08-25T00:00:00.000Z");

    const row = await DB.prepare("SELECT likes FROM hf_models WHERE repo_id = ?")
      .bind("author/direct-model")
      .first<{ likes: number }>();
    expect(row?.likes).toBe(91);

    const c = await DB.prepare("SELECT COUNT(*) AS c FROM hf_models").first<{ c: number }>();
    expect(c?.c).toBe(1);
  });
});

// ── config.model_type resolution ────────────────────────────────────────────

describe("resolveByModelType", () => {
  it("resolves a family from the model's own declared architecture", async () => {
    // ~11.5% of new models declare no base_model but do report a model_type.
    // It rides the listing request we already make, so it costs nothing.
    await upsertModels(
      DB,
      [{ id: "someone/undeclared", createdAt: "2026-08-17T00:00:00.000Z",
         tags: ["text-generation"], config: { model_type: "qwen3_5_moe" } }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family, resolution_source, model_type FROM hf_models WHERE repo_id = ?")
      .bind("someone/undeclared")
      .first<{ family: string; resolution_source: string; model_type: string }>();
    expect(row?.model_type).toBe("qwen3_5_moe");
    expect(row?.family).toBe("qwen");
    // Provenance must not read as a declared parent or a guess from the title.
    // NULL, not 'config_model_type': the CHECK does not permit that value, and
    // widening it costs a ~75,000-row table rebuild to constrain a column
    // nothing reads. The family is what the dashboard consumes; recording it
    // as 'name_pattern' to dodge the CHECK is the outcome this pins against.
    expect(row?.resolution_source).toBeNull();
  });

  it("leaves a bespoke architecture unresolved rather than forcing a bucket", async () => {
    await upsertModels(
      DB,
      [{ id: "someone/bespoke", createdAt: "2026-08-17T00:00:00.000Z",
         tags: [], config: { model_type: "inkling_mm_model" } }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family FROM hf_models WHERE repo_id = ?")
      .bind("someone/bespoke")
      .first<{ family: string | null }>();
    expect(row?.family).toBeNull();
  });

  it("prefers a declared parent over the architecture", async () => {
    await upsertModels(
      DB,
      [{ id: "someone/declared", createdAt: "2026-08-17T00:00:00.000Z",
         tags: ["base_model:quantized:Qwen/Qwen3-8B"], config: { model_type: "llama" } }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family, resolution_source FROM hf_models WHERE repo_id = ?")
      .bind("someone/declared")
      .first<{ family: string; resolution_source: string }>();
    expect(row).toMatchObject({ family: "qwen", resolution_source: "base_model_tag" });
  });
});
