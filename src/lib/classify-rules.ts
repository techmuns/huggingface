/**
 * Phase 6 — Pass A: deterministic rule-based classification.
 *
 * High-precision, zero-cost, instant, and stable across reruns. These rules
 * cover the cases where tags, SDK, linked models, or the repo slug carry
 * enough signal to classify without an LLM.
 *
 * Each rule returns a partial classification. The first matching rule per
 * dimension wins — rules are ordered by precision, not recall.
 */

import { contentHash } from "./enrich";
import type {
  Classification,
  ModelFamily,
  Technology,
  UseCase,
  Vertical,
} from "./taxonomy";
import { TAXONOMY_VERSION } from "./taxonomy";

// ── Signal types ────────────────────────────────────────────────────────────

interface SpaceSignals {
  spaceId: string;
  title: string | null;
  shortDescription: string | null;
  sdk: string | null;
  tags: string[];
  linkedModels: string[];
  linkedDatasets: string[];
  readmeText: string | null;
}

// ── Use-case rules ──────────────────────────────────────────────────────────

const AGENTIC_TAGS = new Set([
  "mcp-server", "agent", "smolagents", "smolagent", "agent-course",
  "tool", "mcp", "agentic",
]);

const VOICE_TAGS = new Set([
  "automatic-speech-recognition", "text-to-speech", "audio-to-audio",
  "audio-classification", "voice",
]);

const IMAGE_GEN_TAGS = new Set([
  "text-to-image", "image-to-image", "image-generation",
]);

const VIDEO_TAGS = new Set([
  "text-to-video", "image-to-video", "video-generation", "video",
]);

const CODE_TAGS = new Set([
  "code-generation", "code", "coding", "ide",
]);

const DOC_TAGS = new Set([
  "document-question-answering", "ocr", "document-processing",
  "text-extraction", "pdf",
]);

const DATA_TAGS = new Set([
  "data-analysis", "visualization", "analytics", "tabular-data",
  "dataset-viewer",
]);

function matchUseCaseFromTags(tags: string[]): UseCase | null {
  for (const tag of tags) {
    if (AGENTIC_TAGS.has(tag)) return "agentic";
    if (VOICE_TAGS.has(tag)) return "voice-speech";
    if (IMAGE_GEN_TAGS.has(tag)) return "image-generation";
    if (VIDEO_TAGS.has(tag)) return "video-media";
    if (CODE_TAGS.has(tag)) return "code-tool";
    if (DOC_TAGS.has(tag)) return "document-processing";
    if (DATA_TAGS.has(tag)) return "data-analysis";
  }
  return null;
}

const VOICE_MODEL_PATTERNS = [/whisper/i, /\bspeech\b/i, /\btts\b/i, /\basr\b/i];
const IMAGE_MODEL_PATTERNS = [/diffusion/i, /\bsdxl\b/i, /\bflux\b/i, /\bdalle?\b/i];
const VIDEO_MODEL_PATTERNS = [/\bsora\b/i, /\bvideo\b/i, /\bwan\b/i];

function matchUseCaseFromModels(linkedModels: string[]): UseCase | null {
  for (const model of linkedModels) {
    for (const re of VOICE_MODEL_PATTERNS) {
      if (re.test(model)) return "voice-speech";
    }
    for (const re of IMAGE_MODEL_PATTERNS) {
      if (re.test(model)) return "image-generation";
    }
    for (const re of VIDEO_MODEL_PATTERNS) {
      if (re.test(model)) return "video-media";
    }
  }
  return null;
}

const SLUG_USE_CASE_PATTERNS: ReadonlyArray<[RegExp, UseCase]> = [
  [/\bchat(bot)?\b/i, "chatbot"],
  [/\basr\b|\bspeech\b|\bwhisper\b|\btts\b/i, "voice-speech"],
  [/\bdiffusion\b|\bsdxl\b|\bflux\b|\bimage[-_]gen/i, "image-generation"],
  [/\bvideo[-_]gen|\bsora\b/i, "video-media"],
  [/\bagent\b|\bmcp\b|\bsmolagent/i, "agentic"],
  [/\bcode[-_]?(gen|editor|assist)\b|\bide\b/i, "code-tool"],
  [/\bocr\b|\bpdf\b|\bdocument/i, "document-processing"],
  [/\banalytics?\b|\bvisuali[sz]/i, "data-analysis"],
];

function matchUseCaseFromSlug(spaceId: string): UseCase | null {
  const slug = spaceId.split("/").pop() ?? "";
  for (const [re, useCase] of SLUG_USE_CASE_PATTERNS) {
    if (re.test(slug)) return useCase;
  }
  return null;
}

// ── Technology rules ────────────────────────────────────────────────────────

function matchTechnologies(signals: SpaceSignals): Technology[] {
  const techs = new Set<Technology>();

  if (signals.sdk === "gradio") techs.add("gradio");
  if (signals.sdk === "streamlit") techs.add("streamlit");
  if (signals.sdk === "docker") techs.add("docker");
  if (signals.sdk === "static") techs.add("static");

  const allTags = new Set(signals.tags);
  if (allTags.has("transformers")) techs.add("transformers");
  if (allTags.has("diffusers")) techs.add("diffusers");
  if (allTags.has("langchain")) techs.add("langchain");
  if (allTags.has("llamaindex") || allTags.has("llama-index")) techs.add("llamaindex");
  if (allTags.has("mcp") || allTags.has("mcp-server")) techs.add("mcp");
  if (allTags.has("smolagents") || allTags.has("smolagent")) techs.add("smolagents");

  return [...techs];
}

// ── Model-family rules ──────────────────────────────────────────────────────

const FAMILY_PATTERNS: ReadonlyArray<[RegExp, ModelFamily]> = [
  [/\bqwen\b/i, "qwen"],
  [/\bllama\b|\bllava\b/i, "llama"],
  [/\bdeepseek\b/i, "deepseek"],
  [/\bgemma\b/i, "gemma"],
  [/\bmistral\b|\bmixtral\b/i, "mistral"],
  [/\bchatglm\b|\bglm\b/i, "glm-zhipu"],
  [/\bmoonshot\b|\bkimi\b/i, "kimi-moonshot"],
  [/\bnemotron\b/i, "nvidia-nemotron"],
  [/\bstable[-_ ]?diffusion\b|\bsdxl\b/i, "stable-diffusion"],
  [/\bwhisper\b/i, "whisper"],
];

function matchModelFamilies(linkedModels: string[]): ModelFamily[] {
  const families = new Set<ModelFamily>();
  for (const model of linkedModels) {
    for (const [re, family] of FAMILY_PATTERNS) {
      if (re.test(model)) families.add(family);
    }
  }
  return [...families];
}

// ── Vertical rules ──────────────────────────────────────────────────────────

const VERTICAL_KEYWORD_PATTERNS: ReadonlyArray<[RegExp, Vertical]> = [
  [/\bmedic(?:al|ine)\b|\bhealth\b|\bclinical\b|\bdiagno/i, "healthcare"],
  [/\bfinanc(?:e|ial)\b|\bstock\b|\btrading\b|\bbank/i, "finance"],
  [/\blegal\b|\blaw\b|\bcontract\b|\bcompliance\b/i, "legal"],
  [/\becommerce\b|\bretail\b|\bshopping\b|\bproduct[-_ ]?catalog/i, "ecommerce-retail"],
  [/\bgam(?:e|ing)\b|\bunity\b|\bunreal\b/i, "gaming"],
  [/\bcreative\b|\bart\b|\bmusic\b|\bdesign\b/i, "creative-media"],
  [/\bdeveloper\b|\bdev[-_ ]?tool\b|\bapi\b|\bcli\b/i, "developer-tools"],
  [/\bscien(?:ce|tific)\b|\bresearch\b|\bacademi/i, "science-research"],
];

function matchVerticals(signals: SpaceSignals): Vertical[] {
  const verticals = new Set<Vertical>();
  const text = [
    signals.title ?? "",
    signals.shortDescription ?? "",
    signals.spaceId,
  ].join(" ");

  for (const [re, vertical] of VERTICAL_KEYWORD_PATTERNS) {
    if (re.test(text)) verticals.add(vertical);
  }

  return [...verticals];
}

// ── Main classification function ────────────────────────────────────────────

export function classifyByRules(signals: SpaceSignals): Classification | null {
  const useCase =
    matchUseCaseFromTags(signals.tags) ??
    matchUseCaseFromModels(signals.linkedModels) ??
    matchUseCaseFromSlug(signals.spaceId);

  if (!useCase) return null;

  const technologies = matchTechnologies(signals);
  const modelFamilies = matchModelFamilies(signals.linkedModels);
  const verticals = matchVerticals(signals);

  return {
    primaryUseCase: useCase,
    useCaseConfidence: 0.9,
    verticals,
    verticalsConfidence: verticals.length > 0 ? 0.7 : 0,
    modelFamilies,
    familiesConfidence: modelFamilies.length > 0 ? 0.95 : 0,
    technologies,
    technologiesConfidence: technologies.length > 0 ? 0.95 : 0,
    rationale: `rule:${useCase}`,
  };
}

// ── Batch DB classify ───────────────────────────────────────────────────────

export interface ClassifyRulesSummary {
  total: number;
  classified: number;
  skippedCached: number;
}

export async function classifySpacesByRules(
  db: D1Database,
  weekStart: string,
  weekEnd: string,
): Promise<ClassifyRulesSummary> {
  const summary: ClassifyRulesSummary = { total: 0, classified: 0, skippedCached: 0 };

  const rows = await db
    .prepare(
      `SELECT s.space_id, s.title, s.short_description, s.sdk,
              s.tags, s.linked_models, s.linked_datasets, s.readme_text
       FROM hf_spaces s
       LEFT JOIN hf_classifications c
         ON c.space_id = s.space_id AND c.taxonomy_version = ?1
       WHERE s.created_at >= ?2 AND s.created_at < ?3
         AND c.id IS NULL
       ORDER BY s.space_id`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .all<{
      space_id: string;
      title: string | null;
      short_description: string | null;
      sdk: string | null;
      tags: string;
      linked_models: string;
      linked_datasets: string;
      readme_text: string | null;
    }>();

  if (!rows.results?.length) return summary;
  summary.total = rows.results.length;

  const stmts: D1PreparedStatement[] = [];

  for (const row of rows.results) {
    const signals: SpaceSignals = {
      spaceId: row.space_id,
      title: row.title,
      shortDescription: row.short_description,
      sdk: row.sdk,
      tags: JSON.parse(row.tags),
      linkedModels: JSON.parse(row.linked_models),
      linkedDatasets: JSON.parse(row.linked_datasets),
      readmeText: row.readme_text,
    };

    const result = classifyByRules(signals);
    if (!result) continue;

    const hash = await contentHash(
      JSON.stringify({ signals, result }),
    );

    stmts.push(
      db
        .prepare(
          `INSERT INTO hf_classifications (
             space_id, taxonomy_version,
             primary_use_case, use_case_confidence,
             verticals, verticals_confidence,
             model_families, families_confidence,
             technologies, technologies_confidence,
             low_confidence, reviewed,
             source_kind, source_ref, prompt_version,
             rationale, content_hash, classified_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 'rule', ?12, NULL, ?13, ?14, datetime('now'))
           ON CONFLICT(space_id, taxonomy_version) DO UPDATE SET
             primary_use_case = excluded.primary_use_case,
             use_case_confidence = excluded.use_case_confidence,
             verticals = excluded.verticals,
             verticals_confidence = excluded.verticals_confidence,
             model_families = excluded.model_families,
             families_confidence = excluded.families_confidence,
             technologies = excluded.technologies,
             technologies_confidence = excluded.technologies_confidence,
             low_confidence = excluded.low_confidence,
             source_kind = excluded.source_kind,
             source_ref = excluded.source_ref,
             rationale = excluded.rationale,
             content_hash = excluded.content_hash,
             classified_at = excluded.classified_at`,
        )
        .bind(
          row.space_id,
          TAXONOMY_VERSION,
          result.primaryUseCase,
          result.useCaseConfidence,
          JSON.stringify(result.verticals),
          result.verticalsConfidence,
          JSON.stringify(result.modelFamilies),
          result.familiesConfidence,
          JSON.stringify(result.technologies),
          result.technologiesConfidence,
          result.useCaseConfidence < 0.5 ? 1 : 0,
          result.rationale,
          result.rationale,
          hash,
        ),
    );
    summary.classified++;
  }

  const BATCH = 100;
  for (let i = 0; i < stmts.length; i += BATCH) {
    await db.batch(stmts.slice(i, i + BATCH));
  }

  return summary;
}
