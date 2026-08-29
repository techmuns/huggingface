/**
 * Phase 6 — taxonomy definitions.
 *
 * These four lists are taken verbatim from the work brief. They are not a
 * design choice we get to make: the stakeholder named the buckets, and the
 * whole point of the exercise is answering their four questions in their own
 * vocabulary. Adding a category they did not ask for silently changes what
 * "share of new Spaces by use case" means; dropping one hides activity.
 *
 * Cardinality is enforced by the schema:
 *   - primary_use_case: exactly ONE per Space (shares sum to 100%)
 *   - verticals, model_families, technologies: multi-label, so percentages
 *     over them are PENETRATION RATES and do not sum to 100%
 */

export const TAXONOMY_VERSION = "1";

/**
 * Which classifier produced a row — bump this whenever either classifier could
 * return a different answer for the same Space.
 *
 * NOT the same thing as TAXONOMY_VERSION, and the difference is the whole
 * point. The taxonomy versions the SHAPE of the answer, and changing it says
 * the old rows are about something else. This versions the MEASUREMENT, and
 * changing it says the old rows are about the same thing measured differently.
 * A chart may not compare across either, and only this one moves when a regex
 * is fixed.
 *
 * "2" because the classifier has already changed once, unrecorded. Version 1 is
 * whatever produced the rows written before this column existed — those are
 * stamped NULL, because naming them 1 would be a guess. The visible symptom of
 * that change is share_by_use_case scientific-tools reading 20.18 / 0.96 / 3.00
 * / 3.01 across four consecutive weeks.
 *
 * BUMP THIS WHEN: a rule regex changes, RULES_PAGE_SIZE changes what the rule
 * pass reaches, the LLM prompt or its schema changes, or the classify model id
 * changes. Not when a bug is fixed that could not alter output.
 */
export const CLASSIFIER_VERSION = "2";

/**
 * "What are developers building?" — one per Space.
 *
 * Note that `agentic` is deliberately NOT here. The brief lists it as a
 * technology, and it has to stay one: the target sentence "60%+ of new
 * coding Spaces are agentic" is a cross-tab of use case against technology,
 * which is impossible if a Space can only be one or the other.
 */
export const USE_CASES = [
  "coding",              // Coding / software development
  "chat-assistant",      // General chat / assistant
  "search-research",     // Search / research
  "document-ai",         // Document AI / knowledge work
  "data-analysis",       // Data analysis / BI
  "image-generation",    // Image generation / editing
  "video-generation",    // Video generation / editing
  "voice-audio",         // Voice / speech / audio
  "music-generation",    // Music generation
  "robotics",            // Robotics / embodied AI
  "3d-gaming",           // 3D / gaming / simulation
  "education",           // Education / tutoring
  "scientific-tools",    // Scientific tools
  "other",
] as const;

export type UseCase = (typeof USE_CASES)[number];

/** "Where are they building it?" — multi-label. */
export const VERTICALS = [
  "healthcare",               // Healthcare / medical
  "finance",
  "legal",
  "enterprise-productivity",  // Enterprise / productivity
  "consumer",
  "education",
  "media-entertainment",      // Media / entertainment
  "ecommerce-retail",         // E-commerce / retail
  "industrial-manufacturing", // Industrial / manufacturing
  "cybersecurity",
  "scientific-research",      // Scientific / research
  "other",
] as const;

export type Vertical = (typeof VERTICALS)[number];

/**
 * "What are they building on?" — multi-label.
 *
 * Identical to the family list Phase 4 resolves model repos into, so a
 * Space's declared family and a model repo's resolved family are the same
 * vocabulary and can be joined without translation.
 */
export const MODEL_FAMILIES = [
  "qwen",
  "llama",
  "deepseek",
  "gemma",
  "mistral",
  "glm-zhipu",       // GLM / Zhipu
  "kimi-moonshot",   // Kimi / Moonshot
  "nvidia-nemotron", // NVIDIA / Nemotron
  "other-open",      // Other open models
  "proprietary-api", // Proprietary API, where identifiable
] as const;

export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/**
 * "How are they building it?" — multi-label.
 *
 * These are AI techniques, not frameworks. The SDK a Space is built with
 * (gradio / streamlit / docker / static) is a different axis entirely: it is
 * already stored on hf_spaces.sdk and reported as its own metric cut, so it
 * does not belong in here diluting the technique signal.
 */
export const TECHNOLOGIES = [
  "rag",
  "agentic",
  "multimodal",
  "tool-use",           // Tool use / function calling
  "local-inference",
  "quantized",
  "long-context",
  "vision-language",
  "speech",             // Speech-to-text / text-to-speech
  "diffusion",
  "moe",                // Mixture of experts
  "fine-tuned",
  "other",
] as const;

export type Technology = (typeof TECHNOLOGIES)[number];

export interface Classification {
  primaryUseCase: UseCase;
  useCaseConfidence: number;
  verticals: Vertical[];
  verticalsConfidence: number;
  modelFamilies: ModelFamily[];
  familiesConfidence: number;
  technologies: Technology[];
  technologiesConfidence: number;
  rationale: string;
}

/**
 * Bedrock's structured output rejects numeric `minimum`/`maximum`
 * ("For 'number' type, properties maximum, minimum are not supported"), so
 * the 0–1 range cannot be enforced in the schema. Callers clamp instead —
 * see clampConfidence.
 */
export const CLASSIFICATION_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    primaryUseCase: { type: "string" as const, enum: [...USE_CASES] },
    useCaseConfidence: { type: "number" as const },
    verticals: {
      type: "array" as const,
      items: { type: "string" as const, enum: [...VERTICALS] },
    },
    verticalsConfidence: { type: "number" as const },
    modelFamilies: {
      type: "array" as const,
      items: { type: "string" as const, enum: [...MODEL_FAMILIES] },
    },
    familiesConfidence: { type: "number" as const },
    technologies: {
      type: "array" as const,
      items: { type: "string" as const, enum: [...TECHNOLOGIES] },
    },
    technologiesConfidence: { type: "number" as const },
    rationale: { type: "string" as const, maxLength: 200 },
  },
  required: [
    "primaryUseCase",
    "useCaseConfidence",
    "verticals",
    "verticalsConfidence",
    "modelFamilies",
    "familiesConfidence",
    "technologies",
    "technologiesConfidence",
    "rationale",
  ],
  additionalProperties: false,
};

export const BATCH_CLASSIFICATION_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    results: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          spaceId: { type: "string" as const },
          ...CLASSIFICATION_JSON_SCHEMA.properties,
        },
        required: ["spaceId", ...CLASSIFICATION_JSON_SCHEMA.required],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

/** The range the schema can no longer enforce. */
export function clampConfidence(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
