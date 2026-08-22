import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type BaseModelInfo,
  extractBaseModelInfo,
  matchFamily,
  matchFamilyByName,
  EMPTY_CURSORS,
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

// ── architecture resolution ─────────────────────────────────────────────────

describe("resolveByArchitecture", () => {
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

  it("reads the architecture out of tags when no config was expanded", async () => {
    // `config` is no longer in the model expand list — it carried whole
    // per-layer quantization blocks and pushed 0.14% of records past the size
    // ceiling, where they were dropped. The Hub derives a tag from the same
    // field, and over 12,000 models it was present in 4,786 of 4,786 cases.
    await upsertModels(
      DB,
      [{ id: "someone/no-config", createdAt: "2026-08-17T00:00:00.000Z",
         tags: ["text-generation", "gemma3", "transformers"] }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family, model_type FROM hf_models WHERE repo_id = ?")
      .bind("someone/no-config")
      .first<{ family: string; model_type: string | null }>();
    expect(row?.model_type).toBeNull();
    expect(row?.family).toBe("gemma");
  });

  it("does not read a build tool as an architecture", async () => {
    // `llama.cpp` on a GGUF says which converter produced the file. 74 models
    // in 12,000 carry a tag like this and are not the family it names.
    await upsertModels(
      DB,
      [{ id: "someone/SmolLM2-135M-GGUF", createdAt: "2026-08-17T00:00:00.000Z",
         tags: ["llama.cpp", "gguf", "text-generation"] }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family FROM hf_models WHERE repo_id = ?")
      .bind("someone/SmolLM2-135M-GGUF")
      .first<{ family: string | null }>();
    expect(row?.family).toBeNull();
  });

  it("ignores namespaced tags, which are metadata rather than architectures", async () => {
    await upsertModels(
      DB,
      [{ id: "someone/plain", createdAt: "2026-08-17T00:00:00.000Z",
         tags: ["dataset:qwen-corpus", "arxiv:2401.llama", "license:apache-2.0"] }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family FROM hf_models WHERE repo_id = ?")
      .bind("someone/plain")
      .first<{ family: string | null }>();
    expect(row?.family).toBeNull();
  });

  it("places a model whose declared parent could not be named", async () => {
    // The rung used to carry `AND base_model IS NULL`, so a model with a
    // parent nobody could place went straight to `other-open` while its own
    // config named the family. 243 models in 12,000.
    await upsertModels(
      DB,
      [{ id: "someone/has-parent", createdAt: "2026-08-17T00:00:00.000Z",
         tags: ["base_model:finetune:private-org/internal-thing", "gemma3"] }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family, base_model FROM hf_models WHERE repo_id = ?")
      .bind("someone/has-parent")
      .first<{ family: string; base_model: string }>();
    expect(row?.base_model).toBe("private-org/internal-thing");
    expect(row?.family).toBe("gemma");
  });

  it("still lets a NAMED parent outrank the architecture", async () => {
    // The ordering is the safety mechanism for the rule above. Speculative
    // drafters are the case that proves it: a Nemotron built on a Qwen
    // skeleton reports model_type qwen and is not a Qwen.
    await upsertModels(
      DB,
      [{ id: "someone/drafter", createdAt: "2026-08-17T00:00:00.000Z",
         tags: ["base_model:finetune:unsloth/Nemotron-3-Nano", "qwen3"] }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family FROM hf_models WHERE repo_id = ?")
      .bind("someone/drafter")
      .first<{ family: string }>();
    expect(row?.family).toBe("nvidia-nemotron");
  });

  it("does not file a diffusion model under its text encoder", async () => {
    await upsertModels(
      DB,
      [{ id: "someone/StableDiffusion-1.4-Pruned", createdAt: "2026-08-17T00:00:00.000Z",
         tags: ["qwen3", "text-to-image"], pipeline_tag: "text-to-image",
         library_name: "diffusers" }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family FROM hf_models WHERE repo_id = ?")
      .bind("someone/StableDiffusion-1.4-Pruned")
      .first<{ family: string | null }>();
    expect(row?.family).toBeNull();
  });

  it("but does keep a family's own image model", async () => {
    // The gate is narrow on purpose. An earlier draft rejected every non-text
    // modality, which threw out Qwen's own ASR, TTS and image models — 30 rows
    // in 12,000 that genuinely are the family their architecture names.
    await upsertModels(
      DB,
      [{ id: "someone/Qwen-Image-2512", createdAt: "2026-08-17T00:00:00.000Z",
         tags: ["qwen3", "text-to-image"], pipeline_tag: "text-to-image",
         library_name: "diffusers" }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family FROM hf_models WHERE repo_id = ?")
      .bind("someone/Qwen-Image-2512")
      .first<{ family: string }>();
    expect(row?.family).toBe("qwen");
  });
});

// ── the declared parent's name, when its org says nothing ───────────────────

describe("a re-hosted parent still names its family", () => {
  it("follows the parent's name when the parent's org is not the family's", async () => {
    // The ecosystem re-hosts through unsloth, bartowski, mradermacher and
    // dozens of others. The 8-org list matched a small minority of declared
    // lineage: 664 models in 12,000 were thrown away for the wrong prefix,
    // `unsloth` alone accounting for 298.
    await upsertModels(
      DB,
      [{ id: "someone/tuned", createdAt: "2026-08-17T00:00:00.000Z",
         tags: ["base_model:finetune:unsloth/Qwen3-8B-Instruct-bnb-4bit"] }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family, base_model, resolution_source FROM hf_models WHERE repo_id = ?")
      .bind("someone/tuned")
      .first<{ family: string; base_model: string; resolution_source: string }>();
    expect(row).toMatchObject({
      family: "qwen",
      base_model: "unsloth/Qwen3-8B-Instruct-bnb-4bit",
      resolution_source: "base_model_tag",
    });
  });

  it("does the same through cardData", async () => {
    await upsertModels(
      DB,
      [{ id: "someone/card-tuned", createdAt: "2026-08-17T00:00:00.000Z", tags: [],
         cardData: { base_model: "bartowski/Mistral-Small-3.2-GGUF" } }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family, resolution_source FROM hf_models WHERE repo_id = ?")
      .bind("someone/card-tuned")
      .first<{ family: string; resolution_source: string }>();
    expect(row).toMatchObject({ family: "mistral", resolution_source: "card_data" });
  });

  it("claims no provenance for a parent it could not place", async () => {
    // resolution_source used to be stamped 'card_data' alongside a NULL
    // family, so a row that went on to be marked other-open carried a claim
    // about how we knew something we did not know.
    await upsertModels(
      DB,
      [{ id: "someone/card-mystery", createdAt: "2026-08-17T00:00:00.000Z", tags: [],
         cardData: { base_model: "private-org/internal-thing" } }],
      "2026-08-18T00:00:00.000Z",
    );
    await resolveModelFamilies(DB);

    const row = await DB.prepare("SELECT family, base_model, resolution_source FROM hf_models WHERE repo_id = ?")
      .bind("someone/card-mystery")
      .first<{ family: string; base_model: string; resolution_source: string | null }>();
    expect(row?.base_model).toBe("private-org/internal-thing");
    expect(row?.family).toBe("other-open");
    expect(row?.resolution_source).toBeNull();
  });
});

// ── repo names separated by underscores ─────────────────────────────────────

describe("matchFamilyByName reads underscores as separators", () => {
  it.each([
    ["TeamUNIVA/qwen3_asr_1.7b_ko_beta", "qwen"],
    ["PsiPi/MIDI-LLM_Llama-3.2-1B-Q8_0-GGUF", "llama"],
    ["sam01ghsh/experiments_gemma-2-2b_jump_relu_fps", "gemma"],
    ["stevel7/ondevice_gemma_litertlm", "gemma"],
  ])("%s -> %s", (repoId, expected) => {
    // `_` is a word character, so \b never fired between "qwen3" and "_asr".
    // 145 models in 12,000 whose names say plainly what they are went
    // unresolved because of it.
    expect(matchFamilyByName(repoId)).toBe(expected);
  });

  it("still refuses a family name buried inside a longer word", () => {
    expect(matchFamilyByName("someone/llamaesque")).toBeNull();
    expect(matchFamilyByName("someone/gemmatron")).toBeNull();
  });
});

// ── upsertModels size safety ────────────────────────────────────────────────

describe("upsertModels stays inside D1's statement limit", () => {
  it("writes a page of realistically fat model records", async () => {
    // The regression: this chunked by COUNT (250) under a comment claiming it
    // "never approaches D1's 100 KB statement cap". Once `config` joined the
    // model expand list, 250 records serialized to 518,088 bytes and ingest
    // died with SQLITE_TOOBIG on three consecutive runs.
    //
    // Fixing the raw layer did not fix this: models skip the raw layer, so
    // this is the path that actually carries `config`. Sized to reproduce
    // that — 400 records averaging ~1.3 KB is well past a single statement.
    const records = Array.from({ length: 400 }, (_, i) => ({
      id: `author/model-${i}`,
      author: "author",
      createdAt: "2026-08-17T00:00:00.000Z",
      likes: 1,
      tags: ["text-generation"],
      config: { model_type: "qwen3_moe", quantization_config: { bits: 4, blob: "x".repeat(1200) } },
    }));

    const written = await upsertModels(DB, records, "2026-08-18T00:00:00.000Z");
    expect(written).toBe(400);

    const row = await DB.prepare("select count(*) as n from hf_models").first<{ n: number }>();
    expect(row?.n).toBe(400);
  });

  it("still captures config.model_type across the chunk boundary", async () => {
    // Chunking must not lose or garble a field — the last record of one chunk
    // and the first of the next are where an off-by-one would show.
    const records = Array.from({ length: 300 }, (_, i) => ({
      id: `a/m-${i}`,
      createdAt: "2026-08-17T00:00:00.000Z",
      tags: [],
      config: { model_type: "gemma3", pad: "y".repeat(800) },
    }));
    await upsertModels(DB, records, "2026-08-18T00:00:00.000Z");

    const n = await DB.prepare(
      "select count(*) as n from hf_models where model_type = 'gemma3'",
    ).first<{ n: number }>();
    expect(n?.n).toBe(300);
  });
});

// ── resolver bounding ───────────────────────────────────────────────────────

describe("family resolution is bounded per call", () => {
  const seed = async (n: number, prefix: string) => {
    const now = "2026-08-18T00:00:00.000Z";
    for (let i = 0; i < n; i += 200) {
      await DB.batch(
        Array.from({ length: Math.min(200, n - i) }, (_, k) =>
          DB.prepare(
            `INSERT INTO hf_models (repo_id, created_at, tags, first_seen_at, updated_at)
             VALUES (?1, ?2, '[]', ?2, ?2)`,
          ).bind(`${prefix}/m-${String(i + k).padStart(5, "0")}`, now),
        ),
      );
    }
  };

  it("looks at no more than `limit` rows per resolver", async () => {
    // The regression: every resolver selected its whole working set and built
    // one prepared statement per row. At ~40,000 unresolved models that is
    // 40,000 statement objects in one invocation, and the run died with
    // "Worker exceeded CPU time limit".
    await seed(1200, "qwen");   // names that DO match, so work is measurable
    const first = await resolveModelFamilies(DB, 300);
    expect(first.byName).toBeLessThanOrEqual(300);

    const resolved = await DB.prepare(
      "select count(*) as n from hf_models where family is not null",
    ).first<{ n: number }>();
    expect(resolved?.n).toBeLessThanOrEqual(300);
  });

  it("advances past rows nothing can resolve, instead of re-reading them", async () => {
    // The reason a bare LIMIT is not enough. These names match no family, so a
    // LIMIT-only pager would select the same first N rows forever and never
    // reach the resolvable ones. The cursor advances on rows SEEN.
    await seed(600, "zzzunknownvendor");
    await seed(50, "qwen");     // sort after 'zzz...'? no — before it.

    // Two passes over 650 rows at 300 a pass must reach the tail.
    await resolveModelFamilies(DB, 300);
    await resolveModelFamilies(DB, 300);
    await resolveModelFamilies(DB, 300);

    const qwen = await DB.prepare(
      "select count(*) as n from hf_models where family = 'qwen'",
    ).first<{ n: number }>();
    expect(qwen?.n).toBe(50);
  });

  it("reaches resolvable rows that sit behind a wall of unresolvable ones", async () => {
    // The bug this pins: paginateUnresolved began every call at cursor "" and
    // discarded where it got to, and the workflow stopped as soon as a pass
    // resolved nothing. So a run walked the head of the set, hit a stretch it
    // could not place, and quit — leaving everything behind that stretch
    // unexamined and published as "unknown" by COALESCE(family, 'unknown').
    //
    // "aaa..." sorts before "qwen...", so with a 200-row budget the first pass
    // sees only unresolvable rows. Under the old code every later pass saw the
    // same 200 and the qwen rows were never reached.
    await seed(600, "aaaunknownvendor");
    await seed(40, "qwen");

    let cursors = EMPTY_CURSORS;
    for (let pass = 0; pass < 20; pass++) {
      const out = await resolveModelFamilies(DB, 200, cursors);
      cursors = out.cursors;
      if (out.done) break;
    }

    const qwen = await DB.prepare(
      "select count(*) as n from hf_models where family = 'qwen'",
    ).first<{ n: number }>();
    expect(qwen?.n).toBe(40);
  });

  it("reports done only when every rung has walked its whole set", async () => {
    // `done` must not mean "this pass resolved nothing" — a pass landing
    // entirely on unresolvable rows resolves zero while plenty is still
    // unexamined behind it. That conflation is the bug above.
    await seed(500, "aaaunknownvendor");

    const first = await resolveModelFamilies(DB, 100, EMPTY_CURSORS);
    expect(first.total).toBe(0);          // resolved nothing...
    expect(first.done).toBe(false);       // ...but is NOT finished
    expect(first.cursors.name).not.toBe("");  // and it did move forward
  });

  it("terminates when nothing is resolvable", async () => {
    await seed(400, "zzzunknownvendor");
    const out = await resolveModelFamilies(DB, 200);
    expect(out.total).toBe(0);
  });
});
