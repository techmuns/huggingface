import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { type AggregateSummary, aggregateWeeklyMetrics } from "./lib/aggregate";
import { BedrockClient } from "./lib/bedrock";
import {
  type ClassifyRulesSummary,
  classifySpacesByRules,
} from "./lib/classify-rules";
import {
  BATCH_SIZE as LLM_BATCH_SIZE,
  type ClassifyLlmSummary,
  classifySpacesByLlm,
} from "./lib/classify-llm";
import {
  type DedupSummary,
  type EnrichSummary,
  dedupSpaces,
  enrichBlindSpaces,
  resetTransientReadmeErrors,
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

/**
 * Cap on rule-classification pages. 400 Spaces a page, so this covers a
 * 26-week backfill at the measured ~7k Spaces/week with room to spare.
 */
const MAX_RULE_PAGES = 500;

/**
 * Step budget.
 *
 * Cloudflare caps a Workflow instance at 1,024 steps on the Free plan and
 * 10,000 on Paid. This account is on Paid, so 10,000 is the real ceiling and
 * the routine weekly run (backfillWeeks = 1) sits far inside it:
 *
 *   ingest pages          ~100
 *   enrichment batches     250  (cap; covers a week plus the standing backlog)
 *   rule pages              18
 *   LLM batches            400  (cap; ~275 used at 5,500 unsettled Spaces)
 *   per-week + terminal     ~25
 *   -------------------------------
 *   worst case             ~793  of 10,000
 *
 * The caps are deliberately above measured demand — a week that runs hot
 * should absorb into headroom, not silently truncate. A 26-week backfill is
 * the real ceiling test: ~1,800 ingest pages + 1,200 enrichment + 500 rule +
 * 3,000 classification + ~60 terminal, still inside 10,000.
 *
 * Every stage reports `truncated` rather than quietly covering less.
 */
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
        backfillWeeks,
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
      // Models are upserted during ingest now; this still runs so any raw
      // model records stored by an earlier build are not stranded.
      const models = await parseRawModels(this.env.DB, config.runId);
      const spaces = await parseRawSpaces(this.env.DB, config.runId);
      return { models, spaces } satisfies ParseSummary;
    });

    const resolve = await step.do("resolve-models", SQL_RETRY, async () => {
      return resolveModelFamilies(this.env.DB);
    });

    // ── Phase 5: enrich blind Spaces + dedup ─────────────────────────────
    const enrich = await this.enrichBlind(step, config.backfillWeeks);

    const weekEnd = addWeeks(
      new Date(`${config.weekStart}T00:00:00.000Z`),
      1,
    ).toISOString();
    // Dedup is defined within a week: "12.8% of new Spaces share a normalised
    // title within 24h". Running it once across a whole 12-week backfill
    // window clustered Spaces created months apart, so weeks 2..N undercounted
    // and disagreed with the same week computed by the weekly cron.
    const dedup: DedupSummary = { clustered: 0, clusters: 0 };
    for (let i = config.backfillWeeks - 1; i >= 0; i--) {
      const target = weekStartIso(addWeeks(new Date(`${config.weekStart}T00:00:00.000Z`), -i));
      const targetEnd = addWeeks(new Date(`${target}T00:00:00.000Z`), 1).toISOString();
      const partial = await step.do(`dedup-${target}`, SQL_RETRY, async () =>
        dedupSpaces(this.env.DB, `${target}T00:00:00.000Z`, targetEnd),
      );
      dedup.clustered += partial.clustered;
      dedup.clusters += partial.clusters;
    }

    // ── Phase 6: classify Spaces ────────────────────────────────────────
    const classifyRules: ClassifyRulesSummary = {
      total: 0, classified: 0, deferredToLlm: 0, nextCursor: null,
    };
    let rulesCursor = "";
    for (let page = 0; page < MAX_RULE_PAGES; page++) {
      const part: ClassifyRulesSummary = await step.do(
        `classify-rules-${page}`,
        SQL_RETRY,
        async () => classifySpacesByRules(this.env.DB, config.since, weekEnd, rulesCursor),
      );
      classifyRules.total += part.total;
      classifyRules.classified += part.classified;
      classifyRules.deferredToLlm += part.deferredToLlm;
      if (!part.nextCursor) break;
      rulesCursor = part.nextCursor;
    }

    const classifyLlm = await this.classifyWithLlm(step, config.since, weekEnd, config.backfillWeeks);

    // ── Phase 7: aggregate weekly metrics ───────────────────────────────
    //
    // Every backfilled week is aggregated, oldest first — not just the week
    // being processed. Ingest, dedup and classify all span the whole backfill
    // window, and the 4W/12W deltas are computed by reading earlier weeks back
    // out of hf_weekly_metrics, so aggregating only the final week would leave
    // the comparison windows with nothing to compare against and make the
    // backfill pointless. Chronological order matters for the same reason: a
    // week's deltas read the weeks written before it.
    const aggregate: AggregateSummary = { metricsWritten: 0 };
    for (let i = config.backfillWeeks - 1; i >= 0; i--) {
      const target = weekStartIso(addWeeks(new Date(`${config.weekStart}T00:00:00.000Z`), -i));
      const targetEnd = addWeeks(new Date(`${target}T00:00:00.000Z`), 1).toISOString();
      const partial = await step.do(`aggregate-${target}`, SQL_RETRY, async () => {
        return aggregateWeeklyMetrics(this.env.DB, target, targetEnd);
      });
      aggregate.metricsWritten += partial.metricsWritten;
    }

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
  private async enrichBlind(step: WorkflowStep, backfillWeeks: number): Promise<EnrichSummary> {
    const totals: EnrichSummary = {
      total: 0,
      fetched: 0,
      ok: 0,
      stub: 0,
      missing: 0,
      error: 0,
      skippedUnchanged: 0,
    };

    // Clear last run's transient failures so they get another attempt; they
    // are held out of the queue only for the duration of a single run.
    await step.do("enrich-reset-errors", SQL_RETRY, async () =>
      resetTransientReadmeErrors(this.env.DB),
    );

    const BATCH_SIZE = 50;
    // A measured week leaves 4,089 Spaces blind (~82 steps at 50 a batch), and
    // there is a standing backlog on top: this queue is global, and 7,434
    // Spaces are currently waiting. 130 covered the week but not the backlog,
    // so it never drained — every run left more behind than it cleared.
    //
    // 250 covers a week plus the whole backlog in one pass. It is affordable
    // because the account is on Workers Paid: 10,000 steps per instance, not
    // the 1,024 the earlier caps were sized against. README fetches cost HTTP
    // requests and no model tokens, so draining the queue is a latency
    // decision, not a spend one.
    //
    // Scaled by backfill depth because a flat cap silently covered a twelfth
    // of a 12-week backfill. See the step budget above.
    const MAX_BATCHES = Math.min(250 * backfillWeeks, 1200);

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

      if (result.total < BATCH_SIZE) return totals;
    }

    // Same contract as walk(): a run that hit the cap covered less than the
    // queue, and every downstream figure is low without saying so.
    totals.truncated = true;
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
    backfillWeeks: number,
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

    // PLAN.md estimated ~175 batched requests a week. The real figure is ~275:
    // rules settle only ~22% of a week's Spaces, leaving ~5,500 for the LLM at
    // 20 a batch. The old cap of 250 therefore truncated ~500 Spaces (9%) every
    // week while 550 steps of budget sat unused. 400 covers 8,000 Spaces.
    // Scaled by backfill depth for the same reason as enrichment.
    const MAX_LLM_BATCHES = Math.min(400 * backfillWeeks, 3000);

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

      // A short batch means the queue is drained. Each call classifies the
      // Spaces it pulled, so the next call's "unclassified" filter excludes
      // them and the queue advances without an offset cursor.
      if (result.total < LLM_BATCH_SIZE) return totals;
    }

    totals.truncated = true;
    return totals;
  }
}
