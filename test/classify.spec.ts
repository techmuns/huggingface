import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type SpaceSignals,
  classifyByRules,
  classifySpacesByRules,
} from "../src/lib/classify-rules";
import {
  MODEL_FAMILIES,
  TAXONOMY_VERSION,
  TECHNOLOGIES,
  USE_CASES,
  VERTICALS,
} from "../src/lib/taxonomy";
import { insertRawRecords } from "../src/lib/raw-store";
import { parseRawSpaces } from "../src/lib/parse";

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

const signals = (overrides: Partial<SpaceSignals> = {}): SpaceSignals => ({
  spaceId: "user/my-space",
  title: null,
  shortDescription: null,
  sdk: null,
  tags: [],
  linkedModels: [],
  linkedDatasets: [],
  readmeText: null,
  ...overrides,
});

// ── Taxonomy conforms to the brief ──────────────────────────────────────────

describe("taxonomy matches the work brief", () => {
  it("has all fourteen primary use cases", () => {
    expect(USE_CASES).toHaveLength(14);
    for (const uc of [
      "coding", "chat-assistant", "search-research", "document-ai",
      "data-analysis", "image-generation", "video-generation", "voice-audio",
      "music-generation", "robotics", "3d-gaming", "education",
      "scientific-tools", "other",
    ]) {
      expect(USE_CASES).toContain(uc);
    }
  });

  it("has all twelve verticals", () => {
    expect(VERTICALS).toHaveLength(12);
    for (const v of ["healthcare", "finance", "legal", "cybersecurity", "industrial-manufacturing"]) {
      expect(VERTICALS).toContain(v);
    }
  });

  it("has all ten model families including proprietary-api", () => {
    expect(MODEL_FAMILIES).toHaveLength(10);
    expect(MODEL_FAMILIES).toContain("proprietary-api");
    expect(MODEL_FAMILIES).toContain("other-open");
  });

  it("has technologies as AI techniques, not SDK names", () => {
    for (const t of ["rag", "agentic", "multimodal", "tool-use", "quantized", "moe"]) {
      expect(TECHNOLOGIES).toContain(t);
    }
    // The SDK belongs on its own axis; letting it in here would dilute the
    // technique signal the brief actually asked about.
    for (const sdk of ["gradio", "streamlit", "docker", "static"]) {
      expect(TECHNOLOGIES).not.toContain(sdk);
    }
  });

  it("does not list agentic as a use case", () => {
    // The brief's headline question — "60%+ of new coding Spaces are agentic"
    // — is a cross-tab, which is only expressible if agentic is a technology
    // a coding Space can also carry.
    expect(USE_CASES).not.toContain("agentic");
    expect(TECHNOLOGIES).toContain("agentic");
  });

  it("has no duplicates in any dimension", () => {
    for (const list of [USE_CASES, VERTICALS, MODEL_FAMILIES, TECHNOLOGIES]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

// ── Use case ────────────────────────────────────────────────────────────────

describe("classifyByRules — primary use case", () => {
  it.each([
    [["automatic-speech-recognition"], "voice-audio"],
    [["text-to-image"], "image-generation"],
    [["text-to-video"], "video-generation"],
    [["text-to-music"], "music-generation"],
    [["code-generation"], "coding"],
    [["document-question-answering"], "document-ai"],
    [["robotics"], "robotics"],
    [["text-to-3d"], "3d-gaming"],
    [["semantic-search"], "search-research"],
    [["tabular-classification"], "data-analysis"],
    [["conversational"], "chat-assistant"],
  ] as const)("resolves tags %j to %s", (tags, expected) => {
    expect(classifyByRules(signals({ tags: [...tags] }))?.primaryUseCase).toBe(expected);
  });

  it("falls back to linked models when tags say nothing", () => {
    expect(
      classifyByRules(signals({ linkedModels: ["openai/whisper-large-v3"] }))?.primaryUseCase,
    ).toBe("voice-audio");
    expect(
      classifyByRules(signals({ linkedModels: ["deepseek-ai/deepseek-coder-6.7b"] }))?.primaryUseCase,
    ).toBe("coding");
  });

  it("falls back to the slug when there is nothing else", () => {
    expect(classifyByRules(signals({ spaceId: "user/my-chatbot" }))?.primaryUseCase)
      .toBe("chat-assistant");
    expect(classifyByRules(signals({ spaceId: "user/pdf-ocr-tool" }))?.primaryUseCase)
      .toBe("document-ai");
  });

  it("reads education from a slug at all", () => {
    // The whole education slug rule was dead: every alternative was written
    // `\\btutor` etc., and in a regex literal `\\b` matches a literal
    // backslash, not a word boundary. So `education` — one of the fourteen use
    // cases the brief names — could never be assigned from a name, and its bar
    // was structurally empty on every chart.
    for (const slug of [
      "user/math-tutor-bot",
      "user/quiz-generator",
      "user/ai-course-helper",
      "user/teach-me-python",
      "user/study-buddy",
    ]) {
      expect(classifyByRules(signals({ spaceId: slug }))?.primaryUseCase, slug)
        .toBe("education");
    }
  });

  it("does not read 'machine learning' as education", () => {
    // The negative lookbehind guarding this has never actually executed —
    // the rule it guards could not match anything. Now that the rule works,
    // this is what stops every ML demo being filed as a tutoring Space.
    for (const slug of [
      "user/machine-learning-demo",
      "user/deep-learning-playground",
      "user/reinforcement-learning-gym",
      "user/transfer-learning-kit",
      "user/federated-learning-sim",
    ]) {
      expect(classifyByRules(signals({ spaceId: slug }))?.primaryUseCase, slug)
        .not.toBe("education");
    }
  });

  it("reads a bare 'coder' in a LINKED MODEL name as coding", () => {
    // Same `\\b` defect, but this rule lives in USE_CASE_MODEL_PATTERNS, so it
    // is matched against linked model names — not the slug. The first version
    // of this test passed `spaceId` and therefore exercised a different table
    // and pinned nothing: it stayed green with the rule still broken.
    expect(
      classifyByRules(signals({ linkedModels: ["Qwen/Qwen2.5-Coder-7B"] }))?.primaryUseCase,
    ).toBe("coding");
    expect(
      classifyByRules(signals({ linkedModels: ["someone/my-coder-model"] }))?.primaryUseCase,
    ).toBe("coding");
  });

  it("still refuses encoder, decoder and vocoder as coding", () => {
    // What the word boundary is FOR, per the comment above the rule: an
    // unanchored `coder` swept all of these in, and none is a coding tool.
    for (const m of ["org/cross-encoder-base", "org/xdecoder-seg", "org/hifigan-vocoder"]) {
      expect(classifyByRules(signals({ linkedModels: [m] }))?.primaryUseCase, m)
        .not.toBe("coding");
    }
  });

  it("records lower confidence for a slug guess than a tag declaration", () => {
    const byTag = classifyByRules(signals({ tags: ["code-generation"] }))!;
    const bySlug = classifyByRules(signals({ spaceId: "user/code-helper" }))!;
    expect(bySlug.useCaseConfidence).toBeLessThan(byTag.useCaseConfidence);
  });

  it("returns null when nothing matches, deferring to Pass B", () => {
    // Guessing "other" here would inflate the bucket that measures taxonomy
    // health, so an unmatched Space must fall through instead.
    expect(classifyByRules(signals({ spaceId: "user/xyzzy" }))).toBeNull();
  });

  it("never assigns agentic as a use case", () => {
    const result = classifyByRules(signals({ tags: ["mcp-server", "agent"] }));
    expect(result?.primaryUseCase).not.toBe("agentic");
  });
});

// ── Technology ──────────────────────────────────────────────────────────────

describe("classifyByRules — technologies", () => {
  it("detects agentic from tags", () => {
    const r = classifyByRules(signals({ tags: ["code-generation", "mcp-server"] }))!;
    expect(r.technologies).toContain("agentic");
  });

  it("supports the brief's headline cross-tab: a coding Space that is agentic", () => {
    const r = classifyByRules(signals({ tags: ["code-generation", "smolagents"] }))!;
    expect(r.primaryUseCase).toBe("coding");
    expect(r.technologies).toContain("agentic");
  });

  it.each([
    [["rag", "faiss"], "rag"],
    [["function-calling"], "tool-use"],
    [["gguf"], "quantized"],
    [["ollama"], "local-inference"],
    [["mixture-of-experts"], "moe"],
    [["lora"], "fine-tuned"],
    [["multimodal"], "multimodal"],
  ] as const)("detects %j as %s", (tags, expected) => {
    expect(classifyByRules(signals({ tags: ["code-generation", ...tags] }))!.technologies)
      .toContain(expected);
  });

  it("detects techniques from prose when tags are absent", () => {
    const r = classifyByRules(signals({
      tags: ["code-generation"],
      shortDescription: "A retrieval-augmented assistant running locally via Ollama",
    }))!;
    expect(r.technologies).toContain("rag");
    expect(r.technologies).toContain("local-inference");
  });

  it("implies multimodal whenever vision-language is present", () => {
    const r = classifyByRules(signals({
      tags: ["code-generation"],
      linkedModels: ["llava-hf/llava-1.5-7b"],
    }))!;
    expect(r.technologies).toContain("vision-language");
    expect(r.technologies).toContain("multimodal");
  });

  it("infers quantized from a GGUF linked model", () => {
    const r = classifyByRules(signals({
      tags: ["code-generation"],
      linkedModels: ["TheBloke/CodeLlama-7B-GGUF"],
    }))!;
    expect(r.technologies).toContain("quantized");
  });
});

// ── Model family ────────────────────────────────────────────────────────────

describe("classifyByRules — model families", () => {
  it("maps linked models to families", () => {
    const r = classifyByRules(signals({
      tags: ["conversational"],
      linkedModels: ["Qwen/Qwen3-8B", "meta-llama/Llama-3-8B"],
    }))!;
    expect(r.modelFamilies).toContain("qwen");
    expect(r.modelFamilies).toContain("llama");
  });

  it("files an unrecognised linked model under other-open", () => {
    const r = classifyByRules(signals({
      tags: ["conversational"],
      linkedModels: ["someone/entirely-novel-model"],
    }))!;
    expect(r.modelFamilies).toContain("other-open");
  });

  it("detects a proprietary API from prose", () => {
    const r = classifyByRules(signals({
      tags: ["conversational"],
      shortDescription: "Chat UI backed by the OpenAI GPT-4 API",
    }))!;
    expect(r.modelFamilies).toContain("proprietary-api");
  });
});

// ── Vertical ────────────────────────────────────────────────────────────────

describe("classifyByRules — verticals", () => {
  it.each([
    ["Medical diagnosis assistant", "healthcare"],
    ["Stock trading analytics", "finance"],
    ["Contract review for lawyers", "legal"],
    ["Malware threat detection", "cybersecurity"],
    ["Factory defect detection", "industrial-manufacturing"],
  ] as const)("reads %s as %s", (description, expected) => {
    const r = classifyByRules(signals({ tags: ["conversational"], shortDescription: description }))!;
    expect(r.verticals).toContain(expected);
  });

  it("reports zero confidence when no vertical keyword fires", () => {
    // A miss is absence of evidence, not evidence of absence, and the
    // confidence has to say so.
    const r = classifyByRules(signals({ tags: ["conversational"] }))!;
    expect(r.verticals).toEqual([]);
    expect(r.verticalsConfidence).toBe(0);
  });
});

// ── DB integration ──────────────────────────────────────────────────────────

describe("classifySpacesByRules", () => {
  async function seedSpace(id: string, overrides: Record<string, unknown> = {}) {
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "space",
      records: [{
        id,
        author: id.split("/")[0],
        createdAt: "2026-08-17T12:00:00.000Z",
        lastModified: "2026-08-17T12:00:00.000Z",
        likes: 0,
        sdk: "gradio",
        tags: [],
        models: [],
        datasets: [],
        cardData: { title: id.split("/")[1] },
        ...overrides,
      }],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, "run-1");
  }

  const WINDOW = ["2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z"] as const;

  it("writes a classification row", async () => {
    await seedSpace("a/code-helper", { tags: ["code-generation"] });

    const result = await classifySpacesByRules(DB, ...WINDOW);
    expect(result.classified).toBe(1);

    const row = await DB.prepare(
      `SELECT primary_use_case, source_kind, taxonomy_version, technologies
       FROM hf_classifications WHERE space_id = ?`,
    )
      .bind("a/code-helper")
      .first<{ primary_use_case: string; source_kind: string; taxonomy_version: string; technologies: string }>();

    expect(row).toMatchObject({
      primary_use_case: "coding",
      source_kind: "rule",
      taxonomy_version: TAXONOMY_VERSION,
    });
    expect(JSON.parse(row!.technologies)).toBeInstanceOf(Array);
  });

  it("counts unmatched Spaces as deferred rather than classifying them", async () => {
    await seedSpace("a/xyzzy", { tags: [], cardData: {} });
    const result = await classifySpacesByRules(DB, ...WINDOW);
    expect(result.classified).toBe(0);
    expect(result.deferredToLlm).toBe(1);
  });

  it("skips Spaces already classified", async () => {
    await seedSpace("a/code-helper", { tags: ["code-generation"] });
    await classifySpacesByRules(DB, ...WINDOW);
    expect((await classifySpacesByRules(DB, ...WINDOW)).total).toBe(0);
  });

  it("ignores Spaces outside the window", async () => {
    await seedSpace("a/old", { tags: ["code-generation"], createdAt: "2026-07-01T00:00:00.000Z" });
    expect((await classifySpacesByRules(DB, ...WINDOW)).total).toBe(0);
  });

  it("cannot hold malformed JSON in the tags column", async () => {
    await seedSpace("a/code-helper", { tags: ["code-generation"] });
    // The defensive parse in classify-rules guards the raw-payload path; on
    // this table the schema already makes the bad state unreachable, which is
    // the stronger guarantee and worth pinning.
    await expect(
      DB.prepare("UPDATE hf_spaces SET tags = ? WHERE space_id = ?")
        .bind("{not json", "a/code-helper")
        .run(),
    ).rejects.toThrow(/json_valid/);
  });
});

// ── Regex precision ─────────────────────────────────────────────────────────

describe("model-name pattern precision", () => {
  it("tags genuine MoE models", () => {
    for (const model of ["Qwen/Qwen3-30B-A3B", "mistralai/Mixtral-8x7B"]) {
      expect(
        classifyByRules(signals({ tags: ["conversational"], linkedModels: [model] }))!.technologies,
      ).toContain("moe");
    }
  });

  it("does not tag dense models as MoE", () => {
    // The active-parameter suffix (-A3B) is the real signal; an unanchored
    // match also fired inside ordinary names like llama3b.
    for (const model of [
      "meta-llama/Llama-3-8B",
      "someone/llama3b",
      "org/Yi-34B",
      "google/gemma-2-9b",
    ]) {
      expect(
        classifyByRules(signals({ tags: ["conversational"], linkedModels: [model] }))!.technologies,
      ).not.toContain("moe");
    }
  });
});
