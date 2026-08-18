import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyByRules,
  classifySpacesByRules,
} from "../src/lib/classify-rules";
import {
  TAXONOMY_VERSION,
  USE_CASES,
  VERTICALS,
  MODEL_FAMILIES,
  TECHNOLOGIES,
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

// ── classifyByRules ─────────────────────────────────────────────────────────

describe("classifyByRules", () => {
  const signals = (overrides: Record<string, unknown> = {}) => ({
    spaceId: "user/my-space",
    title: null as string | null,
    shortDescription: null as string | null,
    sdk: null as string | null,
    tags: [] as string[],
    linkedModels: [] as string[],
    linkedDatasets: [] as string[],
    readmeText: null as string | null,
    ...overrides,
  });

  it("classifies agentic Spaces from tags", () => {
    const result = classifyByRules(signals({ tags: ["mcp-server", "gradio"] }));
    expect(result).not.toBeNull();
    expect(result!.primaryUseCase).toBe("agentic");
  });

  it("classifies voice-speech from tags", () => {
    const result = classifyByRules(signals({ tags: ["automatic-speech-recognition"] }));
    expect(result!.primaryUseCase).toBe("voice-speech");
  });

  it("classifies image-generation from tags", () => {
    const result = classifyByRules(signals({ tags: ["text-to-image"] }));
    expect(result!.primaryUseCase).toBe("image-generation");
  });

  it("classifies from linked models (whisper -> voice-speech)", () => {
    const result = classifyByRules(
      signals({ linkedModels: ["openai/whisper-large-v3"] }),
    );
    expect(result!.primaryUseCase).toBe("voice-speech");
  });

  it("classifies from linked models (diffusion -> image-generation)", () => {
    const result = classifyByRules(
      signals({ linkedModels: ["stabilityai/stable-diffusion-xl-base-1.0"] }),
    );
    expect(result!.primaryUseCase).toBe("image-generation");
  });

  it("classifies from slug patterns", () => {
    const result = classifyByRules(signals({ spaceId: "user/my-chatbot" }));
    expect(result!.primaryUseCase).toBe("chatbot");
  });

  it("classifies from slug: agent", () => {
    const result = classifyByRules(signals({ spaceId: "user/mcp-server-tool" }));
    expect(result!.primaryUseCase).toBe("agentic");
  });

  it("returns null when no rule matches", () => {
    const result = classifyByRules(signals({ spaceId: "user/mystery" }));
    expect(result).toBeNull();
  });

  it("detects technologies from sdk and tags", () => {
    const result = classifyByRules(
      signals({ tags: ["text-to-image", "diffusers"], sdk: "gradio" }),
    );
    expect(result!.technologies).toContain("gradio");
    expect(result!.technologies).toContain("diffusers");
  });

  it("detects model families from linked models", () => {
    const result = classifyByRules(
      signals({
        tags: ["text-generation"],
        linkedModels: ["Qwen/Qwen3-8B"],
        spaceId: "user/my-chatbot",
      }),
    );
    expect(result!.modelFamilies).toContain("qwen");
  });

  it("detects verticals from title and description", () => {
    const result = classifyByRules(
      signals({
        title: "Medical Image Classifier",
        shortDescription: "Healthcare AI tool",
        spaceId: "user/my-chatbot",
      }),
    );
    expect(result!.verticals).toContain("healthcare");
  });

  it("tags precede linked models in priority", () => {
    const result = classifyByRules(
      signals({
        tags: ["text-to-image"],
        linkedModels: ["openai/whisper-large-v3"],
      }),
    );
    expect(result!.primaryUseCase).toBe("image-generation");
  });
});

// ── classifySpacesByRules (DB integration) ──────────────────────────────────

describe("classifySpacesByRules", () => {
  async function seedSpace(
    id: string,
    overrides: Record<string, unknown> = {},
  ) {
    await insertRawRecords(DB, {
      runId: "run-1",
      kind: "space",
      records: [
        {
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
        },
      ],
      fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, "run-1");
  }

  it("classifies spaces and inserts into hf_classifications", async () => {
    await seedSpace("user/my-chatbot", { tags: ["text-generation"] });

    const result = await classifySpacesByRules(
      DB,
      "2026-08-17T00:00:00.000Z",
      "2026-08-24T00:00:00.000Z",
    );

    expect(result.total).toBe(1);
    expect(result.classified).toBe(1);

    const row = await DB.prepare(
      "SELECT primary_use_case, source_kind, taxonomy_version FROM hf_classifications WHERE space_id = ?",
    )
      .bind("user/my-chatbot")
      .first<{ primary_use_case: string; source_kind: string; taxonomy_version: string }>();

    expect(row).toMatchObject({
      primary_use_case: "chatbot",
      source_kind: "rule",
      taxonomy_version: TAXONOMY_VERSION,
    });
  });

  it("skips spaces already classified", async () => {
    await seedSpace("user/my-chatbot", { tags: ["text-generation"] });

    await classifySpacesByRules(DB, "2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
    const second = await classifySpacesByRules(
      DB,
      "2026-08-17T00:00:00.000Z",
      "2026-08-24T00:00:00.000Z",
    );

    expect(second.total).toBe(0);
  });

  it("skips spaces outside the time window", async () => {
    await seedSpace("user/old-chatbot", {
      tags: ["text-generation"],
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    const result = await classifySpacesByRules(
      DB,
      "2026-08-17T00:00:00.000Z",
      "2026-08-24T00:00:00.000Z",
    );
    expect(result.total).toBe(0);
  });

  it("leaves unclassifiable spaces for Pass B", async () => {
    await seedSpace("user/mystery-thing", {
      sdk: "docker",
      tags: [],
      models: [],
      cardData: {},
    });

    const result = await classifySpacesByRules(
      DB,
      "2026-08-17T00:00:00.000Z",
      "2026-08-24T00:00:00.000Z",
    );

    expect(result.classified).toBe(0);

    const count = await DB.prepare(
      "SELECT COUNT(*) as c FROM hf_classifications WHERE space_id = ?",
    )
      .bind("user/mystery-thing")
      .first<{ c: number }>();
    expect(count?.c).toBe(0);
  });
});

// ── Taxonomy consistency ────────────────────────────────────────────────────

describe("taxonomy", () => {
  it("has no duplicate use cases", () => {
    expect(new Set(USE_CASES).size).toBe(USE_CASES.length);
  });

  it("has no duplicate verticals", () => {
    expect(new Set(VERTICALS).size).toBe(VERTICALS.length);
  });

  it("has no duplicate model families", () => {
    expect(new Set(MODEL_FAMILIES).size).toBe(MODEL_FAMILIES.length);
  });

  it("has no duplicate technologies", () => {
    expect(new Set(TECHNOLOGIES).size).toBe(TECHNOLOGIES.length);
  });
});
