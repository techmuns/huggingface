import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { type AggregateSummary, aggregateWeeklyMetrics } from "./lib/aggregate";
import { BedrockClient } from "./lib/bedrock";
import {
  type ClassifyRulesSummary,
  classifySpacesByRules,
} from "./lib/classify-rules";
import {
  type ClassifyLlmSummary,
  classifySpacesByLlm,
} from "./lib/classify-llm";
import {
  type DedupSummary,
  type EnrichSummary,
  dedupSpaces,
  enrichBlindSpaces,
} from "./lib/enrich";
import { HfClient, type EntityKind } from "./lib/hf-api";
import { MAX_PAGES_PER_WALK, ingestPage } from "./lib/ingest";
import { type ResolveSummary, resolveModelFamilies } from "./lib/model-family";
import { type NarrateSummary, narrateWeek } from "./lib/narrate";
import { type ParseSummary, parseRawModels, parseRawSpaces } from "./lib/parse";
import { type SnapshotSummary, buildSnapshot, commitSnapshot } from "./lib/snapshot";
import { addWeeks, weekStart, weekStartIso } from "./lib/time";

/** Parameters accepted when starting a pipeline run. */
export interface WeeklyPipelineParams {
  /**
   * ISO date (YYYY-MM-DD) of the Monday whose week is being processed.
   * Omitted on a cron run, where it is derived from the trigger time.
   */
  weekStart?: string;
  /**
   * Number of trailing weeks to ingest. The first run uses 12 so the 4W and
   * 12W comparison windows are populated on day one; later runs use 1.
   */
  backfillWeeks?: number;
  /** Skip the GitHub snapshot commit — used when re-running for debugging. */
  dryRun?: boolean;
}

export interface IngestSummary {
  kind: EntityKind;
  pages: number;
  recordsFetched: number;
  rowsWritten: number;
  oldestCreatedAt: string | null;
  /** True if the walk hit the page cap instead of reaching the window edge. */
  truncated: boolean;
}

export interface WeeklyPipelineResult {
  runId: string;
  weekStart: string;
  since: string;
  ingest: IngestSummary[];
  parse?: ParseSummary;
  resolve?: ResolveSummary;
  enrich?: EnrichSummary;
  dedup?: DedupSummary;
  classifyRules?: ClassifyRulesSummary;
  classifyLlm?: ClassifyLlmSummary;
  aggregate?: AggregateSummary;
  narrate?: NarrateSummary;
  snapshot?: SnapshotSummary;
}

/**
 * Retry policy for a listing page.
 *
 * The Hub's anonymous budget is 500 requests per 5 minutes, so the recovery
 * from a 429 is measured in minutes; an exponential backoff starting at 30s
 * clears one of those windows well within five attempts, and the Workflow
 * holds the step's state durably in the meantime rather than burning wall
 * clock inside an invocation.
 */
const PAGE_RETRY = {
  retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

const SQL_RETRY = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

/**
 * The weekly pipeline: ingest -> parse -> enrich -> classify -> aggregate ->
 * narrate -> publish.
 *
 * Each stage is a Workflow step so it retries independently. Steps return
 * counts and cursors, never payloads — a step result is capped at 1 MiB,
 * which a single page of 1,000 Hugging Face records would breach on its own.
 *
 * Phases 4 onward fill in the stages after ingest.
 */
export class WeeklyPipeline extends WorkflowEntrypoint<Env, WeeklyPipelineParams> {
  override async run(
    event: WorkflowEvent<WeeklyPipelineParams>,
    step: WorkflowStep,
  ): Promise<WeeklyPipelineResult> {
    const params = event.payload ?? {};

    const config = await step.do("resolve-window", async () => {
      const week = params.weekStart ?? weekStartIso(event.timestamp);
      const backfillWeeks = Math.max(1, params.backfillWeeks ?? 1);
      return {
        // The instance id is stable across resumptions, so a run that is
        // retried or resumed keeps writing under the same run_id rather than
        // fragmenting one logical run across several.
        runId: event.instanceId,
        weekStart: week,
        // Inclusive lower bound of the ingest window. A backfill of N weeks
        // reaches back N-1 weeks before the week being processed, so the
        // trailing 4W and 12W comparisons have data to compare against.
        since: addWeeks(weekStart(new Date(`${week}T00:00:00.000Z`)), -(backfillWeeks - 1)).toISOString(),
        dryRun: params.dryRun ?? false,
      };
    });

    const client = new HfClient(this.env.HF_TOKEN);
    const ingest: IngestSummary[] = [];

    for (const kind of ["model", "space"] as const) {
      ingest.push(await this.walk(step, client, kind, config.runId, config.since));
    }

    // ── Phase 4: parse raw → typed, then resolve model families ──────────
    const parse = await step.do("parse", SQL_RETRY, async () => {
      const models = await parseRawModels(this.env.DB, config.runId);
      const spaces = await parseRawSpaces(this.env.DB, config.runId);
      return { models, spaces } satisfies ParseSummary;
    });

    const resolve = await step.do("resolve-models", SQL_RETRY, async () => {
      return resolveModelFamilies(this.env.DB);
    });

    // ── Phase 5: enrich blind Spaces + dedup ─────────────────────────────
    const enrich = await this.enrichBlind(step);

    const weekEnd = addWeeks(
      new Date(`${config.weekStart}T00:00:00.000Z`),
      1,
    ).toISOString();
    const dedup = await step.do("dedup-spaces", SQL_RETRY, async () => {
      return dedupSpaces(this.env.DB, config.since, weekEnd);
    });

    // ── Phase 6: classify Spaces ────────────────────────────────────────
    const classifyRules = await step.do("classify-rules", SQL_RETRY, async () => {
      return classifySpacesByRules(this.env.DB, config.since, weekEnd);
    });

    const classifyLlm = await this.classifyWithLlm(step, config.since, weekEnd);

    // ── Phase 7: aggregate weekly metrics ───────────────────────────────
    const aggregate = await step.do("aggregate", SQL_RETRY, async () => {
      return aggregateWeeklyMetrics(this.env.DB, config.weekStart, weekEnd);
    });

    // ── Phase 8: narrate + publish snapshot ──────────────────────────────
    const bedrockNarrate = new BedrockClient({
      apiKey: this.env.BEDROCK_API_KEY,
      region: this.env.BEDROCK_REGION,
    });

    const narrate = await step.do("narrate", PAGE_RETRY, async () => {
      return narrateWeek(
        this.env.DB,
        bedrockNarrate,
        this.env.BEDROCK_NARRATE_MODEL_ID,
        config.weekStart,
      );
    });

    let snapshot: SnapshotSummary | undefined;
    if (!config.dryRun) {
      snapshot = await step.do("snapshot", PAGE_RETRY, async () => {
        const payload = await buildSnapshot(this.env.DB, config.weekStart, narrate.narrative);
        return commitSnapshot(payload, this.env.GITHUB_REPO, this.env.GITHUB_TOKEN);
      });
    }

    return {
      runId: config.runId,
      weekStart: config.weekStart,
      since: config.since,
      ingest,
      parse,
      resolve,
      enrich,
      dedup,
      classifyRules,
      classifyLlm,
      aggregate,
      narrate,
      snapshot,
    };
  }

  /**
   * Walks one listing newest-first until it reads past the window.
   *
   * One Workflow step per page, so a failure mid-walk resumes at the failed
   * page rather than re-fetching everything before it. The loop lives in the
   * workflow body rather than inside a single step for the same reason.
   */
  private async walk(
    step: WorkflowStep,
    client: HfClient,
    kind: EntityKind,
    runId: string,
    since: string,
  ): Promise<IngestSummary> {
    const summary: IngestSummary = {
      kind,
      pages: 0,
      recordsFetched: 0,
      rowsWritten: 0,
      oldestCreatedAt: null,
      truncated: false,
    };

    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES_PER_WALK; page++) {
      const result = await step.do(`ingest-${kind}-page-${page}`, PAGE_RETRY, async () =>
        ingestPage({ db: this.env.DB, client, kind, runId, since, cursor, page }),
      );

      summary.pages++;
      summary.recordsFetched += result.recordsFetched;
      summary.rowsWritten += result.rowsWritten;
      if (result.oldestCreatedAt !== null) {
        summary.oldestCreatedAt = result.oldestCreatedAt;
      }

      if (result.done) return summary;
      cursor = result.nextCursor;
    }

    // Never silently truncate: a walk that hit the cap covered less than the
    // requested window, and every metric derived from it would be low without
    // saying so.
    summary.truncated = true;
    return summary;
  }

  /**
   * Fetches READMEs for the blind subset in batches.
   *
   * One step per batch of 50 Spaces. Each batch makes up to 50 HTTP requests
   * to the Hub, which fits within a rate-limit window. The Workflow's durable
   * step state means a failure resumes at the failed batch, not from scratch.
   */
  private async enrichBlind(step: WorkflowStep): Promise<EnrichSummary> {
    const totals: EnrichSummary = {
      total: 0,
      fetched: 0,
      ok: 0,
      stub: 0,
      missing: 0,
      error: 0,
      skippedUnchanged: 0,
    };

    const BATCH_SIZE = 50;
    const MAX_BATCHES = 200;

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const result = await step.do(`enrich-batch-${batch}`, PAGE_RETRY, async () =>
        enrichBlindSpaces({
          db: this.env.DB,
          batchSize: BATCH_SIZE,
          offset: 0,
        }),
      );

      totals.total += result.total;
      totals.fetched += result.fetched;
      totals.ok += result.ok;
      totals.stub += result.stub;
      totals.missing += result.missing;
      totals.error += result.error;
      totals.skippedUnchanged += result.skippedUnchanged;

      if (result.total < BATCH_SIZE) break;
    }

    return totals;
  }

  /**
   * Classifies remaining unclassified Spaces via Bedrock LLM in batches.
   *
   * One step per batch of 20. Each batch makes one Bedrock API call.
   */
  private async classifyWithLlm(
    step: WorkflowStep,
    weekStart: string,
    weekEnd: string,
  ): Promise<ClassifyLlmSummary> {
    const totals: ClassifyLlmSummary = {
      total: 0,
      classified: 0,
      batches: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      errors: 0,
    };

    const client = new BedrockClient({
      apiKey: this.env.BEDROCK_API_KEY,
      region: this.env.BEDROCK_REGION,
    });
    const modelId = this.env.BEDROCK_CLASSIFY_MODEL_ID;

    const MAX_LLM_BATCHES = 200;

    for (let batch = 0; batch < MAX_LLM_BATCHES; batch++) {
      const result = await step.do(`classify-llm-batch-${batch}`, PAGE_RETRY, async () =>
        classifySpacesByLlm(this.env.DB, client, modelId, weekStart, weekEnd),
      );

      totals.total += result.total;
      totals.classified += result.classified;
      totals.batches += result.batches;
      totals.inputTokens += result.inputTokens;
      totals.outputTokens += result.outputTokens;
      totals.cacheReadTokens += result.cacheReadTokens;
      totals.cacheCreateTokens += result.cacheCreateTokens;
      totals.errors += result.errors;

      if (result.total === 0) break;
    }

    return totals;
  }
}
