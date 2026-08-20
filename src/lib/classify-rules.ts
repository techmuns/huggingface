/**
 * Phase 6 — Pass A: deterministic rule-based classification.
 *
 * High-precision, zero-cost, instant, and stable across reruns. Covers the
 * cases where tags, SDK, linked models, or the repo slug carry enough signal
 * to classify without spending a token.
 *
 * The two dimensions rules are good at are use case and technology, because
 * both are frequently declared in tags. Vertical is mostly absent from
 * metadata and is usually only inferable from prose, so it falls through to
 * Pass B far more often — that asymmetry is expected, not a gap.
 */
import { D1_BATCH } from "./raw-store";

import { contentHash } from "./enrich";
import type {
  Classification,
  ModelFamily,
  Technology,
  UseCase,
  Vertical,
} from "./taxonomy";
import { TAXONOMY_VERSION } from "./taxonomy";

export interface SpaceSignals {
  spaceId: string;
  title: string | null;
  shortDescription: string | null;
  sdk: string | null;
  tags: string[];
  linkedModels: string[];
  linkedDatasets: string[];
  readmeText: string | null;
}

/** Lower-cased haystack of every free-text field, for keyword rules. */
function textOf(s: SpaceSignals): string {
  return [
    s.spaceId,
    s.title ?? "",
    s.shortDescription ?? "",
    // README is truncated: the first 2 KB carries the pitch, and the tail is
    // usually install instructions and licence boilerplate that match
    // keywords without meaning them.
    (s.readmeText ?? "").slice(0, 2000),
  ]
    .join(" ")
    .toLowerCase();
}

// ── Use case ────────────────────────────────────────────────────────────────
//
// Ordered by precision. The first match wins, so a Space tagged both
// `text-to-image` and `chat` is image generation rather than chat.

const USE_CASE_TAGS: ReadonlyArray<[UseCase, ReadonlySet<string>]> = [
  ["voice-audio", new Set([
    "automatic-speech-recognition", "text-to-speech", "audio-to-audio",
    "audio-classification", "voice-activity-detection", "speech", "tts", "asr",
  ])],
  ["music-generation", new Set([
    "text-to-music", "music-generation", "music", "audio-generation",
  ])],
  ["image-generation", new Set([
    "text-to-image", "image-to-image", "image-generation", "inpainting",
    "image-editing",
  ])],
  ["video-generation", new Set([
    "text-to-video", "image-to-video", "video-generation", "video-editing",
  ])],
  ["3d-gaming", new Set([
    "text-to-3d", "image-to-3d", "3d", "game", "simulation",
  ])],
  ["robotics", new Set([
    "robotics", "reinforcement-learning", "embodied-ai", "lerobot",
  ])],
  ["document-ai", new Set([
    "document-question-answering", "ocr", "document-processing", "pdf",
    "text-extraction", "table-question-answering",
  ])],
  ["coding", new Set([
    "code-generation", "code", "coding", "code-completion", "text-to-sql",
  ])],
  ["search-research", new Set([
    "search", "semantic-search", "retrieval", "question-answering",
    "sentence-similarity",
  ])],
  ["data-analysis", new Set([
    "data-analysis", "visualization", "analytics", "tabular-data",
    "tabular-classification", "tabular-regression", "dataset-viewer",
  ])],
  ["scientific-tools", new Set([
    "biology", "chemistry", "protein", "medical", "physics", "climate",
    "molecular",
  ])],
  ["education", new Set([
    "education", "tutoring", "course", "learning",
  ])],
  ["chat-assistant", new Set([
    "conversational", "chat", "assistant", "text-generation",
  ])],
];

function useCaseFromTags(tags: string[]): UseCase | null {
  const set = new Set(tags.map((t) => t.toLowerCase()));
  for (const [useCase, triggers] of USE_CASE_TAGS) {
    for (const t of triggers) {
      if (set.has(t)) return useCase;
    }
  }
  return null;
}

/** Model-name signals, used when tags say nothing. */
const USE_CASE_MODEL_PATTERNS: ReadonlyArray<[UseCase, RegExp]> = [
  ["voice-audio", /whisper|\bxtts\b|\btts\b|speecht5|wav2vec|bark|parler|\bvits\b/i],
  ["music-generation", /musicgen|audiocraft|\bmusic\b|riffusion|stable-audio/i],
  ["video-generation", /\bsora\b|animatediff|videocrafter|\bwan\b|cogvideo|ltx-video|mochi/i],
  ["image-generation", /diffusion|\bsdxl\b|\bflux\b|dall-?e|kandinsky|playground-v/i],
  ["3d-gaming", /shap-?e|point-?e|triposr|\bhunyuan3d\b|zero123/i],
  ["document-ai", /donut|layoutlm|\bnougat\b|\btrocr\b|surya|\bgot-ocr\b/i],
  // `coder` unanchored also matched cross-encoder, xdecoder and vocoder
  // repos, which are not coding tools. Require a boundary that a preceding
  // "en"/"de"/"vo" cannot satisfy.
  ["coding", /\bcoder\b|codellama|starcoder|deepseek-coder|codegen|codet5/i],
  ["search-research", /\bbge\b|\be5-\b|gte-|sentence-transformers|colbert|reranker/i],
];

function useCaseFromModels(models: string[]): UseCase | null {
  for (const [useCase, re] of USE_CASE_MODEL_PATTERNS) {
    if (models.some((m) => re.test(m))) return useCase;
  }
  return null;
}

/**
 * Slug and title signals — the last deterministic rung.
 *
 * This exists because roughly half of new Spaces carry no linked model, no
 * description and no meaningful tag, leaving the name as the only thing to
 * read. Lower confidence is recorded accordingly.
 */
const USE_CASE_SLUG_PATTERNS: ReadonlyArray<[UseCase, RegExp]> = [
  ["voice-audio", /\basr\b|speech|whisper|\btts\b|voice|audio|transcri/i],
  ["music-generation", /\bmusic\b|\bsong\b|melody|audiocraft/i],
  ["video-generation", /video|\banimate\b|\bsora\b/i],
  ["image-generation", /diffusion|\bsdxl\b|\bflux\b|image[-_]?gen|text2image|txt2img|inpaint|upscal/i],
  // `render` matched text-rendering, markdown-renderer and pdf-renderer, and
  // this entry sits above document-ai and coding, so it swallowed them.
  ["3d-gaming", /\b3d\b|\bgame\b|\bunity\b|\bmesh\b|\brender(er|ing)?\b(?!.*\b(text|markdown|latex|pdf|html)\b)/i],
  ["robotics", /robot|\bdrone\b|embodied/i],
  ["document-ai", /\bocr\b|\bpdf\b|document|invoice|resume|\bdocs?\b/i],
  ["coding", /\bcode\b|\bcoder\b|\bsql\b|\bide\b|program|debug|devtool/i],
  ["search-research", /search|retriev|\brag\b|research|\bwiki\b/i],
  ["data-analysis", /analytic|dashboard|visuali[sz]|\bcsv\b|\bbi\b|chart|plot/i],
  ["scientific-tools", /protein|molecul|chem|\bbio\b|genom|climate|physics/i],
  // Bare `learn` matched "machine learning", "deep learning" and
  // "reinforcement learning" — none of which are education Spaces.
  ["education", /\btutor|\bteach|\blearn(ing)?\b(?<!(machine|deep|reinforcement|federated|transfer|ensemble)[- ]learning)|\bcourse\b|\bquiz\b|\bstudy\b/i],
  ["chat-assistant", /\bchat|\bbot\b|assistant|\bllm\b|conversat/i],
];

function useCaseFromText(s: SpaceSignals): UseCase | null {
  const slug = (s.spaceId.split("/").pop() ?? "").toLowerCase();
  const title = (s.title ?? "").toLowerCase();
  const haystack = `${slug} ${title}`;
  for (const [useCase, re] of USE_CASE_SLUG_PATTERNS) {
    if (re.test(haystack)) return useCase;
  }
  return null;
}

// ── Technology ──────────────────────────────────────────────────────────────
//
// Multi-label: a Space can be agentic AND quantized AND multimodal, and the
// brief's headline question ("60%+ of new coding Spaces are agentic") depends
// on these being independent of the use case.

const TECH_TAGS: ReadonlyArray<[Technology, ReadonlySet<string>]> = [
  ["agentic", new Set([
    "agent", "agents", "agentic", "mcp", "mcp-server", "smolagents",
    "smolagent", "agent-course", "autogen", "crewai", "langgraph", "autogpt",
  ])],
  ["rag", new Set([
    "rag", "retrieval-augmented-generation", "vector-database", "embeddings",
    "faiss", "chromadb", "pinecone", "llamaindex", "llama-index",
  ])],
  ["tool-use", new Set([
    "function-calling", "tool-use", "tool-calling", "tools",
  ])],
  ["multimodal", new Set([
    "multimodal", "any-to-any", "image-text-to-text", "video-text-to-text",
  ])],
  ["vision-language", new Set([
    "vision-language", "visual-question-answering", "image-to-text", "vlm",
  ])],
  ["speech", new Set([
    "automatic-speech-recognition", "text-to-speech", "tts", "asr",
    "speech-to-text",
  ])],
  ["diffusion", new Set([
    "diffusers", "stable-diffusion", "diffusion", "text-to-image",
    "latent-diffusion",
  ])],
  ["quantized", new Set([
    "gguf", "gptq", "awq", "quantized", "4bit", "8bit", "bitsandbytes",
    "int4", "int8", "quantization",
  ])],
  ["local-inference", new Set([
    "llama-cpp", "llamacpp", "ollama", "onnx", "webgpu", "transformers.js",
    "candle", "mlx", "webllm",
  ])],
  ["moe", new Set([
    "moe", "mixture-of-experts", "mixtral",
  ])],
  ["fine-tuned", new Set([
    "fine-tuned", "finetune", "finetuned", "lora", "peft", "sft", "dpo",
    "qlora",
  ])],
  ["long-context", new Set([
    "long-context", "128k", "200k", "1m-context",
  ])],
];

/** Free-text fallbacks, for techniques that are described but never tagged. */
const TECH_TEXT_PATTERNS: ReadonlyArray<[Technology, RegExp]> = [
  ["rag", /retrieval[- ]augmented|\brag\b|vector (?:db|database|store)|semantic search/i],
  ["agentic", /\bagent(?:ic|s)?\b|\bmcp\b|tool[- ]calling loop|multi[- ]agent/i],
  ["tool-use", /function[- ]calling|tool use|tool[- ]calling/i],
  ["multimodal", /multi[- ]?modal/i],
  ["quantized", /\bgguf\b|\bgptq\b|\bawq\b|\b4-?bit\b|\b8-?bit\b|quanti[sz]/i],
  ["local-inference", /\bollama\b|llama\.cpp|runs? locally|on-device|in[- ]browser|\bwebgpu\b/i],
  ["long-context", /long[- ]context|\b128k\b|\b1m tokens?\b/i],
  ["moe", /mixture[- ]of[- ]experts|\bmoe\b/i],
];

const TECH_MODEL_PATTERNS: ReadonlyArray<[Technology, RegExp]> = [
  ["quantized", /\bgguf\b|\bgptq\b|\bawq\b|-4bit|-8bit/i],
  ["diffusion", /diffusion|\bsdxl\b|\bflux\b/i],
  ["speech", /whisper|\btts\b|\bxtts\b|wav2vec|speecht5/i],
  ["vision-language", /\bllava\b|\bvlm\b|qwen.*-vl|internvl|\bidefics\b|\bblip\b/i],
  // Anchored to a separator: the bare `a\d+b` matched inside ordinary names
  // (llama3b), tagging dense models as MoE. The convention this targets is the
  // active-parameter suffix, as in Qwen3-30B-A3B.
  ["moe", /mixtral|[-_]moe\b|[-_]a\d+b\b/i],
];

function technologiesFrom(s: SpaceSignals): Technology[] {
  const found = new Set<Technology>();
  const tagSet = new Set(s.tags.map((t) => t.toLowerCase()));

  for (const [tech, triggers] of TECH_TAGS) {
    for (const t of triggers) {
      if (tagSet.has(t)) { found.add(tech); break; }
    }
  }

  for (const [tech, re] of TECH_MODEL_PATTERNS) {
    if (s.linkedModels.some((m) => re.test(m))) found.add(tech);
  }

  const text = textOf(s);
  for (const [tech, re] of TECH_TEXT_PATTERNS) {
    if (re.test(text)) found.add(tech);
  }

  // Vision-language is a strict specialisation of multimodal; asserting one
  // without the other makes the two penetration rates disagree.
  if (found.has("vision-language")) found.add("multimodal");

  return [...found];
}

// ── Model family ────────────────────────────────────────────────────────────

const FAMILY_PATTERNS: ReadonlyArray<[ModelFamily, RegExp]> = [
  ["qwen", /\bqwen\d*\b|\bqwq\b/i],
  ["llama", /\bllama\b|\bllava\b|\bcodellama\b/i],
  ["deepseek", /\bdeepseek\b/i],
  ["gemma", /\bgemma\b|\bpaligemma\b/i],
  ["mistral", /\bmistral\b|\bmixtral\b|\bmagistral\b/i],
  ["glm-zhipu", /\bchatglm\b|\bglm-?\d|\bzhipu\b/i],
  ["kimi-moonshot", /\bkimi\b|\bmoonshot\b/i],
  ["nvidia-nemotron", /\bnemotron\b/i],
];

/**
 * Proprietary endpoints are only detectable from prose, since a Space that
 * calls one has no linked model to give it away.
 */
const PROPRIETARY_PATTERN =
  /\bopenai\b|\bgpt-[45]\b|\bchatgpt\b|\bclaude\b|\banthropic\b|\bgemini\b|\bgrok\b|\bcohere\b/i;

function modelFamiliesFrom(s: SpaceSignals): ModelFamily[] {
  const found = new Set<ModelFamily>();

  for (const model of s.linkedModels) {
    let matched = false;
    for (const [family, re] of FAMILY_PATTERNS) {
      if (re.test(model)) { found.add(family); matched = true; }
    }
    // A linked model that matches no known family is still an open model, and
    // dropping it would understate open-model usage.
    if (!matched) found.add("other-open");
  }

  if (PROPRIETARY_PATTERN.test(textOf(s))) found.add("proprietary-api");

  return [...found];
}

// ── Vertical ────────────────────────────────────────────────────────────────

const VERTICAL_PATTERNS: ReadonlyArray<[Vertical, RegExp]> = [
  ["healthcare", /\bmedical\b|\bmedicine\b|\bhealth\b|\bclinical\b|\bdiagnos|\bpatient\b|\bradiolog|\bdisease\b/i],
  ["finance", /\bfinanc|\bstock\b|\btrading\b|\bbank|\binvest|\bportfolio\b|\baccounting\b|\bcrypto\b/i],
  ["legal", /\blegal\b|\blaw\b|\blawyer\b|\bcontract\b|\bcompliance\b|\blitigation\b/i],
  ["cybersecurity", /\bsecurity\b|\bcyber|\bmalware\b|\bphishing\b|\bvulnerabilit|\bthreat\b|\bpentest/i],
  ["ecommerce-retail", /\becommerce\b|\be-commerce\b|\bretail\b|\bshopping\b|\bproduct catalog|\bstorefront\b/i],
  ["industrial-manufacturing", /\bmanufactur|\bindustrial\b|\bfactory\b|\bsupply chain\b|\blogistics\b|\bdefect detect/i],
  ["media-entertainment", /\bmovie\b|\bfilm\b|\bmusic\b|\bentertainment\b|\bpodcast\b|\bstreaming\b|\bcreative\b|(?<!state[- ]of[- ]the[- ])\bart\b/i],
  ["education", /\beducation\b|\btutor|\bteach|\bstudent\b|\bcourse\b|\bclassroom\b|\bhomework\b/i],
  ["scientific-research", /\bscientific\b|\bresearch\b|\bacademi|\bprotein\b|\bgenom|\bchemistry\b|\bphysics\b|\bbiolog/i],
  ["enterprise-productivity", /\benterprise\b|\bproductivity\b|\bworkflow\b|\bcrm\b|\berp\b|\bhr\b|\brecruit|\bmeeting\b/i],
];

function verticalsFrom(s: SpaceSignals): Vertical[] {
  // Tags are included deliberately. Vertical is the dimension least often
  // stated in prose, so the few tags that do declare one — `medical`,
  // `finance`, `legal` — are the strongest signal available. Reading only the
  // free text meant a Space tagged `medical` was routed to the
  // scientific-tools use case and then recorded with no vertical at all,
  // losing exactly the healthcare activity the brief asks us to track.
  const text = `${textOf(s)} ${s.tags.join(" ").toLowerCase()}`;
  const found = new Set<Vertical>();
  for (const [vertical, re] of VERTICAL_PATTERNS) {
    if (re.test(text)) found.add(vertical);
  }
  return [...found];
}

// ── Assembly ────────────────────────────────────────────────────────────────

/**
 * Confidence reflects which rung produced the use case, because that is the
 * dimension a wrong answer damages most. A tag is a declaration; a slug is
 * an inference, and it is flagged as such so the review queue can catch it.
 */
const CONFIDENCE_BY_SOURCE = {
  tag: 0.95,
  model: 0.85,
  text: 0.55,
} as const;

export function classifyByRules(signals: SpaceSignals): Classification | null {
  let useCase = useCaseFromTags(signals.tags);
  let source: keyof typeof CONFIDENCE_BY_SOURCE = "tag";

  if (!useCase) {
    useCase = useCaseFromModels(signals.linkedModels);
    source = "model";
  }
  if (!useCase) {
    useCase = useCaseFromText(signals);
    source = "text";
  }

  // No use case means no row. Leaving it to Pass B is the whole point of the
  // funnel — guessing "other" here would quietly inflate the Other bucket,
  // which is the taxonomy's health metric.
  if (!useCase) return null;

  const technologies = technologiesFrom(signals);
  const modelFamilies = modelFamiliesFrom(signals);
  const verticals = verticalsFrom(signals);

  return {
    primaryUseCase: useCase,
    useCaseConfidence: CONFIDENCE_BY_SOURCE[source],
    verticals,
    // Vertical rules only ever fire on an explicit keyword, so a hit is
    // decent evidence and a miss is no evidence at all — not evidence of
    // absence. Zero confidence marks the difference.
    verticalsConfidence: verticals.length > 0 ? 0.7 : 0,
    modelFamilies,
    familiesConfidence: modelFamilies.length > 0 ? 0.95 : 0,
    technologies,
    technologiesConfidence: technologies.length > 0 ? 0.9 : 0,
    rationale: `rule:${source}:${useCase}`,
  };
}

// ── Batch DB classify ───────────────────────────────────────────────────────

export interface ClassifyRulesSummary {
  /** Last space_id examined, or null when the queue is drained. */
  nextCursor?: string | null;
  total: number;
  classified: number;
  deferredToLlm: number;
}

const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Rows examined per call. Bounds the statements issued in one invocation. */
/**
 * Spaces examined per rule-classification step.
 *
 * 40 steps (STEP_BUDGET.rules) x 400 = 16,000 against a measured ~6,800 new
 * Spaces a week. It was 120, giving 4,800 — so roughly 2,000 Spaces a week
 * were never examined by either pass while still counting in the denominator,
 * dragging coverage down every week and leaving those Spaces out of every
 * chart. The budget comment beside STEP_BUDGET.rules already said "400 Spaces
 * a page: 16,000"; the constant simply never matched it.
 *
 * Raised here rather than by adding steps, deliberately: step count is what
 * exhausts the orchestration's CPU and killed several runs, and
 * test/step-budget.spec.ts holds the ceiling. Measured cost of a page at this
 * size is ~47ms against ~13ms at 120 — linear, and far below a step's budget.
 */
export const RULES_PAGE_SIZE = 400;

export async function classifySpacesByRules(
  db: D1Database,
  weekStart: string,
  weekEnd: string,
  cursor: string = "",
  pageSize: number = RULES_PAGE_SIZE,
): Promise<ClassifyRulesSummary> {
  const summary: ClassifyRulesSummary = {
    total: 0, classified: 0, deferredToLlm: 0, nextCursor: null,
  };

  // Paged by space_id rather than by an unbounded scan: this issued one INSERT
  // per classified Space inside a single Workflow step, and a week is several
  // thousand Spaces — far past D1's 1,000-queries-per-invocation limit.
  //
  // The cursor is on space_id, not an OFFSET, because Spaces the rules cannot
  // settle are deliberately left unclassified for Pass B. They therefore stay
  // in this queue, and an offset-free LIMIT would re-read the same
  // unclassifiable rows forever.
  const rows = await db
    .prepare(
      `SELECT s.space_id, s.title, s.short_description, s.sdk,
              s.tags, s.linked_models, s.linked_datasets, s.readme_text
       FROM hf_spaces s
       LEFT JOIN hf_classifications c
         ON c.space_id = s.space_id AND c.taxonomy_version = ?1
       WHERE s.created_at >= ?2 AND s.created_at < ?3
         AND c.id IS NULL
         AND s.space_id > ?4
       ORDER BY s.space_id
       LIMIT ?5`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd, cursor, pageSize)
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
      tags: safeJsonArray(row.tags),
      linkedModels: safeJsonArray(row.linked_models),
      linkedDatasets: safeJsonArray(row.linked_datasets),
      readmeText: row.readme_text,
    };

    const result = classifyByRules(signals);
    if (!result) {
      summary.deferredToLlm++;
      continue;
    }

    const hash = await contentHash(JSON.stringify(signals));

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
          result.useCaseConfidence < LOW_CONFIDENCE_THRESHOLD ? 1 : 0,
          result.rationale,
          result.rationale,
          hash,
        ),
    );
    summary.classified++;
  }

  const BATCH = D1_BATCH;
  for (let i = 0; i < stmts.length; i += BATCH) {
    await db.batch(stmts.slice(i, i + BATCH));
  }

  // A short page means the queue is drained; otherwise hand back the last id
  // so the next step resumes past it, including past rows left for Pass B.
  summary.nextCursor =
    rows.results.length < pageSize
      ? null
      : rows.results[rows.results.length - 1]!.space_id;

  return summary;
}

/**
 * A malformed JSON column must not abort the whole week's classification;
 * the row is simply treated as carrying no signal on that field.
 */
function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}
