/**
 * Phase 6 — taxonomy definitions.
 *
 * Every label the pipeline produces lives here so the taxonomy is one import,
 * one version string, and one place to change when the taxonomy evolves.
 *
 * Cardinality is enforced by the schema:
 *   - primary_use_case: exactly ONE per Space (sums to 100%)
 *   - verticals, model_families, technologies: multi-label (penetration rates)
 */

export const TAXONOMY_VERSION = "1";

export const USE_CASES = [
  "chatbot",
  "image-generation",
  "voice-speech",
  "code-tool",
  "data-analysis",
  "document-processing",
  "video-media",
  "agentic",
  "education-research",
  "model-demo",
  "other",
] as const;

export type UseCase = (typeof USE_CASES)[number];

export const VERTICALS = [
  "healthcare",
  "finance",
  "legal",
  "ecommerce-retail",
  "gaming",
  "creative-media",
  "developer-tools",
  "science-research",
  "enterprise",
  "consumer",
] as const;

export type Vertical = (typeof VERTICALS)[number];

export const MODEL_FAMILIES = [
  "qwen",
  "llama",
  "deepseek",
  "gemma",
  "mistral",
  "glm-zhipu",
  "kimi-moonshot",
  "nvidia-nemotron",
  "stable-diffusion",
  "whisper",
  "other-open",
] as const;

export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export const TECHNOLOGIES = [
  "gradio",
  "streamlit",
  "docker",
  "static",
  "transformers",
  "diffusers",
  "langchain",
  "llamaindex",
  "mcp",
  "smolagents",
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

export const CLASSIFICATION_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    primaryUseCase: { type: "string" as const, enum: [...USE_CASES] },
    useCaseConfidence: { type: "number" as const, minimum: 0, maximum: 1 },
    verticals: {
      type: "array" as const,
      items: { type: "string" as const, enum: [...VERTICALS] },
    },
    verticalsConfidence: { type: "number" as const, minimum: 0, maximum: 1 },
    modelFamilies: {
      type: "array" as const,
      items: { type: "string" as const, enum: [...MODEL_FAMILIES] },
    },
    familiesConfidence: { type: "number" as const, minimum: 0, maximum: 1 },
    technologies: {
      type: "array" as const,
      items: { type: "string" as const, enum: [...TECHNOLOGIES] },
    },
    technologiesConfidence: { type: "number" as const, minimum: 0, maximum: 1 },
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
