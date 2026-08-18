/**
 * Phase 6 — Pass B: LLM classification via Bedrock.
 *
 * Only Spaces the rules could not settle reach this pass. Batches ~20 Spaces
 * per request to cut ~3,500 requests/week to ~175. Uses manual cache_control
 * breakpoints on the taxonomy prompt (automatic caching is not available on
 * Bedrock).
 *
 * Model: Haiku 4.5 — the cheapest option that handles structured output.
 * Opus 5 is reserved for the once-weekly narrative (Phase 8).
 */

import { BedrockClient, type BedrockContent, type BedrockRequest } from "./bedrock";
import { contentHash } from "./enrich";
import {
  type Classification,
  BATCH_CLASSIFICATION_JSON_SCHEMA,
  TAXONOMY_VERSION,
  USE_CASES,
  VERTICALS,
  MODEL_FAMILIES,
  TECHNOLOGIES,
} from "./taxonomy";

// ── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a classifier for Hugging Face Spaces. For each Space, determine:

1. **primaryUseCase** (exactly one): ${USE_CASES.join(", ")}
2. **verticals** (zero or more): ${VERTICALS.join(", ")}
3. **modelFamilies** (zero or more): ${MODEL_FAMILIES.join(", ")}
4. **technologies** (zero or more): ${TECHNOLOGIES.join(", ")}

For each dimension, provide a confidence score (0.0–1.0).
Write a one-line rationale (max 200 chars) explaining your classification.

Rules:
- primaryUseCase must be exactly ONE value. Use "model-demo" for Spaces that showcase a model without a clear application use case. Use "other" only as last resort.
- verticals should be empty if no specific industry vertical is evident.
- modelFamilies should reflect models linked to the Space.
- technologies should reflect the SDK and frameworks used.
- Confidence should reflect certainty: 0.9+ for clear cases, 0.5-0.8 for uncertain, below 0.5 for guesses.`;

// ── Types ───────────────────────────────────────────────────────────────────

interface SpaceForLlm {
  spaceId: string;
  title: string | null;
  shortDescription: string | null;
  sdk: string | null;
  tags: string[];
  linkedModels: string[];
  readmeText: string | null;
}

interface BatchResult {
  spaceId: string;
  primaryUseCase: string;
  useCaseConfidence: number;
  verticals: string[];
  verticalsConfidence: number;
  modelFamilies: string[];
  familiesConfidence: number;
  technologies: string[];
  technologiesConfidence: number;
  rationale: string;
}

export interface ClassifyLlmSummary {
  total: number;
  classified: number;
  batches: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  errors: number;
}

// ── Formatting ──────────────────────────────────────────────────────────────

function formatSpaceForPrompt(space: SpaceForLlm): string {
  const parts = [`ID: ${space.spaceId}`];
  if (space.title) parts.push(`Title: ${space.title}`);
  if (space.shortDescription) parts.push(`Description: ${space.shortDescription}`);
  if (space.sdk) parts.push(`SDK: ${space.sdk}`);
  if (space.tags.length) parts.push(`Tags: ${space.tags.join(", ")}`);
  if (space.linkedModels.length) parts.push(`Models: ${space.linkedModels.join(", ")}`);
  if (space.readmeText) {
    const truncated = space.readmeText.slice(0, 500);
    parts.push(`README (truncated): ${truncated}`);
  }
  return parts.join("\n");
}

// ── Core batch classification ───────────────────────────────────────────────

async function classifyBatch(
  client: BedrockClient,
  modelId: string,
  spaces: SpaceForLlm[],
): Promise<{ results: BatchResult[]; usage: { input: number; output: number; cacheRead: number; cacheCreate: number } }> {
  const batchText = spaces
    .map((s, i) => `--- Space ${i + 1} ---\n${formatSpaceForPrompt(s)}`)
    .join("\n\n");

  const request: BedrockRequest = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Classify each of the following ${spaces.length} Spaces. Return a JSON object with a "results" array containing one entry per Space, each with a "spaceId" field matching the Space ID.\n\n${batchText}`,
          },
        ],
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        json_schema: {
          name: "batch_classification",
          schema: BATCH_CLASSIFICATION_JSON_SCHEMA,
        },
      },
    },
  };

  const response = await client.invoke(modelId, request);

  const text = response.content[0]?.text;
  if (!text) throw new Error("Empty Bedrock response");

  const parsed = JSON.parse(text) as { results: BatchResult[] };

  return {
    results: parsed.results,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheCreate: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

// ── DB-driven batch classification ──────────────────────────────────────────

const BATCH_SIZE = 20;
const MAX_BATCHES = 200;

export async function classifySpacesByLlm(
  db: D1Database,
  client: BedrockClient,
  modelId: string,
  weekStart: string,
  weekEnd: string,
): Promise<ClassifyLlmSummary> {
  const summary: ClassifyLlmSummary = {
    total: 0,
    classified: 0,
    batches: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    errors: 0,
  };

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const rows = await db
      .prepare(
        `SELECT s.space_id, s.title, s.short_description, s.sdk,
                s.tags, s.linked_models, s.readme_text
         FROM hf_spaces s
         LEFT JOIN hf_classifications c
           ON c.space_id = s.space_id AND c.taxonomy_version = ?1
         WHERE s.created_at >= ?2 AND s.created_at < ?3
           AND c.id IS NULL
         ORDER BY s.space_id
         LIMIT ?4`,
      )
      .bind(TAXONOMY_VERSION, weekStart, weekEnd, BATCH_SIZE)
      .all<{
        space_id: string;
        title: string | null;
        short_description: string | null;
        sdk: string | null;
        tags: string;
        linked_models: string;
        readme_text: string | null;
      }>();

    if (!rows.results?.length) break;

    summary.total += rows.results.length;
    summary.batches++;

    const spaces: SpaceForLlm[] = rows.results.map((r) => ({
      spaceId: r.space_id,
      title: r.title,
      shortDescription: r.short_description,
      sdk: r.sdk,
      tags: JSON.parse(r.tags),
      linkedModels: JSON.parse(r.linked_models),
      readmeText: r.readme_text,
    }));

    try {
      const { results, usage } = await classifyBatch(client, modelId, spaces);
      summary.inputTokens += usage.input;
      summary.outputTokens += usage.output;
      summary.cacheReadTokens += usage.cacheRead;
      summary.cacheCreateTokens += usage.cacheCreate;

      const stmts: D1PreparedStatement[] = [];

      for (const result of results) {
        const space = spaces.find((s) => s.spaceId === result.spaceId);
        if (!space) continue;

        const hash = await contentHash(
          JSON.stringify({ space, result }),
        );

        const lowConfidence =
          result.useCaseConfidence < 0.5 || result.verticalsConfidence < 0.5 ? 1 : 0;

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
               ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 'model', ?12, ?13, ?14, ?15, datetime('now'))
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
                 prompt_version = excluded.prompt_version,
                 rationale = excluded.rationale,
                 content_hash = excluded.content_hash,
                 classified_at = excluded.classified_at`,
            )
            .bind(
              result.spaceId,
              TAXONOMY_VERSION,
              result.primaryUseCase,
              result.useCaseConfidence,
              JSON.stringify(result.verticals),
              result.verticalsConfidence,
              JSON.stringify(result.modelFamilies),
              result.familiesConfidence,
              JSON.stringify(result.technologies),
              result.technologiesConfidence,
              lowConfidence,
              modelId,
              "v1",
              result.rationale,
              hash,
            ),
        );
        summary.classified++;
      }

      const STMT_BATCH = 100;
      for (let i = 0; i < stmts.length; i += STMT_BATCH) {
        await db.batch(stmts.slice(i, i + STMT_BATCH));
      }
    } catch {
      summary.errors++;
    }
  }

  return summary;
}
