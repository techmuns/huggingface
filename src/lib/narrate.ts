/**
 * Phase 8 — Narrate the week's metrics.
 *
 * Feeds computed metrics (never raw rows) to Bedrock Opus 5 and generates
 * the prose summary. Guardrails: suppress or widen the window when the
 * denominator is too small, and never report a percentage change off a
 * tiny base.
 */

import { BedrockClient, type BedrockRequest, firstText } from "./bedrock";
import { TAXONOMY_VERSION } from "./taxonomy";

export interface NarrateSummary {
  narrative: string;
  inputTokens: number;
  outputTokens: number;
}

const SYSTEM_PROMPT = `You are a data analyst writing a weekly summary of Hugging Face developer activity for a technical stakeholder.

Rules:
- Write 2-3 concise paragraphs summarizing the week's key trends.
- Lead with the most notable change or trend.
- Use specific numbers from the data provided.
- When reporting percentage changes, always include the absolute numbers.
- Do NOT report percentage changes when the denominator is below 10 — say "too few to report" instead.
- Do NOT speculate beyond what the data shows.
- Use the past tense ("rose", "fell", "held steady").
- Mention coverage and methodology caveats when relevant.
- End with one forward-looking sentence about what to watch next week.`;

export async function narrateWeek(
  db: D1Database,
  client: BedrockClient,
  modelId: string,
  weekStart: string,
): Promise<NarrateSummary> {
  const metrics = await db
    .prepare(
      `SELECT metric_cut, dimension, sub_dimension,
              value, denominator, coverage,
              delta_1w, delta_4w, delta_12w, suppressed
       FROM hf_weekly_metrics
       WHERE week_start = ?1 AND taxonomy_version = ?2
       ORDER BY metric_cut, dimension, sub_dimension`,
    )
    .bind(weekStart, TAXONOMY_VERSION)
    .all();

  if (!metrics.results?.length) {
    return { narrative: "No metrics available for this week.", inputTokens: 0, outputTokens: 0 };
  }

  const metricsText = JSON.stringify(metrics.results, null, 2);

  const request: BedrockRequest = {
    anthropic_version: "bedrock-2023-05-31",
    // Generous because the narration model runs adaptive thinking, and the
    // thinking tokens come out of this same budget before a word of prose is
    // written. 2048 was enough to be spent entirely on reasoning.
    max_tokens: 8192,
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
            text: `Here are the weekly metrics for the week starting ${weekStart}. Write the summary.\n\n${metricsText}`,
          },
        ],
      },
    ],
  };

  const response = await client.invoke(modelId, request);

  const narrative = firstText(response);

  return {
    narrative,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
