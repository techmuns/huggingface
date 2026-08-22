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
import {
  EMPTY_CURSORS,
  RESOLVE_PAGE,
  type ResolveSummary,
  resolveModelFamilies,
} from "./lib/model-family";
import { type NarrateSummary, narrateWeek } from "./lib/narrate";
import {
  type BuildPackOptions,
  buildFactPack,
  generateInsight,
  INSIGHTS_INDEX_SQL,
  INSIGHTS_TABLE_SQL,
  type InsightKind,
  type InsightResult,
  periodIsOpen,
  periodSpec,
  saveInsight,
} from "./lib/insights";
import { type ParseSummary, parseRawModels, parseRawSpaces } from "./lib/parse";
import { type SnapshotSummary, buildSnapshot, commitSnapshot } from "./lib/snapshot";
import { addWeeks, toIsoDate, weekStart, weekStartIso } from "./lib/time";

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
  insights?: Array<{ kind: InsightKind; periodKey: string; status: string; detail: string | null }>;
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
 * Classification steps get longer than a page fetch, because each one now
 * makes two Bedrock calls rather than one. A measured call over 20 Spaces runs
 * well under a minute; five is headroom, not an expectation.
 */
const LLM_RETRY = {
  retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

/**
 * The step budget — enforced here, not described in a comment.
 *
 * Cloudflare caps a Workflow instance at 1,024 steps on Free and 10,000 on
 * Paid — this account deploys on Free, so 1,024 is the hard ceiling — but
 * that is not the limit that bites. Workflows replays the orchestration from
 * the top at every step boundary, so a run's overhead grows with the NUMBER of
 * steps; the instance is killed with WorkflowFatalError ("exceeded CPU or
 * memory limits outside of a step") long before 10,000. Measured: a run
 * spending roughly 800 steps died at 23 minutes. 700 is the working ceiling.
 *
 * The previous version of this comment set that ceiling out as a table and
 * left every loop to respect it on the honour system — and the table mixed
 * MEASURED figures for two stages with CAPS for the others, so it added up to
 * ~663 while the caps actually allowed 2,845:
 *
 *     ingest      2 walks x 900 = 1,800   (documented as ~100)
 *     rule pages            500           (documented as ~18)
 *
 * A week that ran hot would therefore sail past the ceiling with nothing to
 * stop it, which is what a fatal error is: the absence of a budget, not the
 * presence of a big week.
 *
 * So the caps below are shares of the ceiling and SUM to less than it. Every
 * loop stops when its share is gone and reports `truncated`, which the run
 * already carries end to end. A week that covers 90% of a surge and LANDS is
 * worth incomparably more than a week that reaches for all of it and is
 * killed — the first leaves a point on every chart and a note saying it is
 * light; the second leaves a gap and a dashboard that has silently stopped.
 */
const WORKING_STEPS = 700;

const STEP_BUDGET = {
  /** Per walk, and there are two — models and Spaces. 400 records a page (see
      MAX_PAGE_SIZE: 1,000 cost 7.8ms of a 10ms step budget), so 150 pages is
      60,000 records; the deepest walk observed needed 103. */
  ingestPerWalk: 150,
  /** 150 READMEs a batch: 15,000 against a standing queue of ~14,300. */
  enrich: 100,
  /** 400 Spaces a page: 16,000 against a measured ~7,000 a week. */
  rules: 40,
  /** Two Bedrock calls a step at 20 Spaces each: 6,000 against ~5,500
      unsettled a week. */
  llm: 150,
  /** Phases with a fixed step each, plus the per-week aggregate and narrate. */
  terminal: 30,
} as const;

/**
 * What a run may spend if every stage exhausts its share at once.
 *
 * 2 x 150 + 100 + 40 + 150 + 30 = 620, inside the 700 ceiling. Exported and
 * asserted in the tests rather than written in a comment, because the last
 * version of this budget WAS a comment and it was wrong by a factor of four —
 * a number nothing checks is a number that drifts.
 */
export const WORST_CASE_STEPS =
  STEP_BUDGET.ingestPerWalk * 2 + STEP_BUDGET.enrich + STEP_BUDGET.rules +
  STEP_BUDGET.llm + STEP_BUDGET.terminal;

export { WORKING_STEPS, STEP_BUDGET, stepsFor };

/**
 * How many steps a stage may spend. Deliberately NOT a function of how many
 * weeks were asked for.
 *
 * Every previous version of this scaled a cap by backfillWeeks, and that is
 * precisely what killed the runs: the ceiling is a property of the Workflow
 * INSTANCE, so multiplying a cap by the size of the request cannot buy
 * anything — it can only overshoot. A three-week dispatch asking for three
 * times the steps does not get three times the budget; it gets terminated,
 * and writes nothing at all.
 *
 * So the shares are fixed and sized for the routine one-week run. A deeper
 * backfill covers what it can inside them and reports `truncated`. Repairing
 * a long stretch of history is done one week at a time — the workflow file
 * says so, and taking no depth parameter here is what makes that true rather
 * than merely advised.
 */
function stepsFor(stage: keyof typeof STEP_BUDGET): number {
  return STEP_BUDGET[stage];
}

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

    // Schema this deployment adds and can safely add itself: two idempotent
    // CREATEs over tables it already owns, no ALTER and no data movement.
    //
    // D1 has no migrate-on-deploy — `git push` ships the Worker and a human
    // runs `wrangler d1 migrations apply` — and this repo has paid for that gap
    // twice already. Anything that alters an existing table still belongs in
    // migrations/ and is still gated before this run starts; this is only the
    // additive tail that would otherwise leave a feature dark or a query
    // unindexed until someone remembered.
    //
    // Non-fatal on purpose: an index that failed to build is a slower
    // drill-down, not a failed pipeline.
    await step.do("ensure-derived-schema", SQL_RETRY, async () => {
      const made: string[] = [];
      for (const [name, sql] of [
        ["idx_spaces_traction", `CREATE INDEX IF NOT EXISTS idx_spaces_traction
  ON hf_spaces (likes DESC, created_at DESC, space_id)
  WHERE likes > 0 AND is_cluster_primary = 1;`],
        ["hf_insights", INSIGHTS_TABLE_SQL],
        ["idx_insights_recent", INSIGHTS_INDEX_SQL],
      ] as const) {
        try {
          await this.env.DB.prepare(sql).run();
          made.push(name);
        } catch (err) {
          console.error(`ensure ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { ensured: made };
    });

    // ── Phase 4: parse raw → typed, then resolve model families ──────────
    const parse = await step.do("parse", SQL_RETRY, async () => {
      // Models are upserted during ingest now; this still runs so any raw
      // model records stored by an earlier build are not stranded.
      const models = await parseRawModels(this.env.DB, config.runId);
      const spaces = await parseRawSpaces(this.env.DB, config.runId);
      return { models, spaces } satisfies ParseSummary;
    });

    // Looped, not called once. Each pass looks at a bounded number of rows —
    // the unbounded version built ~40,000 prepared statements in one
    // invocation and the run died with "Worker exceeded CPU time limit". A
    // pass that resolves nothing means the queue is drained, so the loop ends
    // on its own; the cap is a backstop, and hitting it is reported.
    const MAX_RESOLVE_PASSES = 40;
    const resolve: ResolveSummary = {
      byTag: 0, byCardData: 0, byChain: 0, byArchitecture: 0, byName: 0,
      byBase: 0, total: 0, cursors: EMPTY_CURSORS, done: false, unfinished: [],
    };
    for (let pass = 0; pass < MAX_RESOLVE_PASSES; pass++) {
      // The cursors from the previous pass are what make this a walk rather
      // than a repeated re-read of the same head. Step results are durable, so
      // a retried step resumes from the same place instead of rewinding.
      const from = resolve.cursors;
      const part = await step.do(`resolve-models-${pass}`, SQL_RETRY, async () =>
        resolveModelFamilies(this.env.DB, RESOLVE_PAGE, from),
      );
      resolve.byTag += part.byTag;
      resolve.byCardData += part.byCardData;
      resolve.byChain += part.byChain;
      resolve.byArchitecture += part.byArchitecture;
      resolve.byName += part.byName;
      resolve.byBase += part.byBase;
      resolve.total += part.total;
      resolve.cursors = part.cursors;
      resolve.done = part.done;
      resolve.unfinished = part.unfinished;

      // Stop when every rung has walked its whole set — not when a pass
      // happens to resolve nothing. Those are different, and confusing them
      // is what left most models unexamined and published as "unknown".
      if (part.done) break;
    }

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
    const ruleCap = stepsFor("rules");
    for (let page = 0; page < ruleCap; page++) {
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

    // narrateWeek is the ORIGINAL narrator and it has none of the guards the
    // insight path has: no grounding, no coverage floor, no open-period test.
    // Its output reaches the dashboard through the GitHub archive, because
    // /api/narrative falls back to the snapshot when D1 holds no insight — so
    // gating the insight and leaving this ungated protected one road into the
    // summary card and left the other open.
    //
    // Aggregating an open week is NOT the problem and is deliberately left
    // alone: the dashboard shows the current week on purpose and marks it "so
    // far". Writing PROSE about a week two days old is the problem.
    const narrate = periodIsOpen("week", config.weekStart)
      ? { narrative: "", inputTokens: 0, outputTokens: 0 }
      : await step.do("narrate", PAGE_RETRY, async () => {
          return narrateWeek(
            this.env.DB,
            bedrockNarrate,
            this.env.BEDROCK_NARRATE_MODEL_ID,
            config.weekStart,
          );
        });

    // The written insight, stored in D1 rather than only in the GitHub
    // archive. The archive is an archive; a read path the dashboard depends on
    // should not require a credential to have been valid at the moment a
    // four-hour run finished. See migrations/0006.
    //
    // The monthly one is written only when a month has actually closed —
    // detected by the week just processed being the last Monday of its month.
    // Writing it every week would mean each week's run overwrote the last with
    // a "month" that was two weeks long.
    const insightPeriods = insightPeriodsFor(config.weekStart);
    if (insightPeriods.length === 0) {
      // Recorded, not silent: a run that wrote no summary should say why, or
      // the next person to look assumes the feature is broken.
      console.warn(
        `no insight written for ${config.weekStart}: the period has not finished yet`,
      );
    }
    const insights: Array<{ kind: InsightKind; periodKey: string; status: string; detail: string | null }> = [];
    for (const period of insightPeriods) {
      const written = await step.do(`insight-${period.kind}-${period.periodKey}`, PAGE_RETRY, async () => {
        // Non-fatal, for the same reason the snapshot step is: by the time this
        // runs the week is DONE — Phase 7 has written hf_weekly_metrics and the
        // dashboard is already serving the new figures. A summary that could
        // not be written is a missing paragraph, not a failed pipeline, and a
        // pending migration must not be able to report four hours of correct
        // work as a failure.
        try {
          const pack = await buildFactPack(this.env.DB, period);
          const result: InsightResult = await generateInsight(
            bedrockNarrate,
            this.env.BEDROCK_NARRATE_MODEL_ID,
            pack,
          );
          await saveInsight(this.env.DB, result, {
            weekStart: period.kind === "week" ? config.weekStart : null,
            modelId: this.env.BEDROCK_NARRATE_MODEL_ID,
            generatedAt: new Date().toISOString(),
          });
          return { kind: result.kind, periodKey: result.periodKey, status: result.status, detail: result.detail };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`insight ${period.kind} ${period.periodKey} failed: ${reason}`);
          return { kind: period.kind, periodKey: period.periodKey, status: "error", detail: reason };
        }
      });
      insights.push(written);
    }

    // The archive is the last thing a run does, and by the time it runs the
    // week is ALREADY DONE: Phase 7 wrote hf_weekly_metrics and the dashboard
    // is serving the new figures. Letting this step fail the run therefore
    // reports a week that landed as a week that did not.
    //
    // That is not hypothetical. A four-hour run — every stage of it correct —
    // was marked failed here because the Worker's GITHUB_TOKEN had lost
    // `contents:write`: "Resource not accessible by personal access token".
    // A credential expiring should not be able to tell you your pipeline is
    // broken, and it certainly should not be able to do so every week for as
    // long as the token stays stale.
    //
    // So the failure is recorded rather than thrown. Loudly: the reason
    // travels on the run, the CI job turns it into a warning, and the
    // `committed` flag stays false — because raw-record pruning is documented
    // to assume the archive exists, and a silent false success here is exactly
    // how that assumption would come to be untrue.
    let snapshot: SnapshotSummary | undefined;
    if (!config.dryRun) {
      snapshot = await step.do("snapshot", PAGE_RETRY, async () => {
        const payload = await buildSnapshot(this.env.DB, config.weekStart, narrate.narrative);
        try {
          return await commitSnapshot(payload, this.env.GITHUB_REPO, this.env.GITHUB_TOKEN);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`snapshot archive failed for ${config.weekStart}: ${reason}`);
          // The payload's own label, not the week start: the real path is
          // keyed by ISO week (2026-W33), so recording a date here would name
          // a file that does not exist and never will.
          return {
            path: `data/weeks/${payload.weekLabel}.json`,
            committed: false,
            sha: null,
            error: reason,
          };
        }
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
      insights,
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

    const pageCap = Math.min(MAX_PAGES_PER_WALK, stepsFor("ingestPerWalk"));
    for (let page = 0; page < pageCap; page++) {
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

    // 150 a batch, not 50. Steps are not free: Workflows replays the
    // orchestration from the top at every step boundary, so the cost of a run
    // grows with the NUMBER of steps, not the work inside them. A run that
    // took 750 enrichment steps died with WorkflowFatalError — "exceeded CPU
    // or memory limits outside of a step" — which is that replay, not the
    // fetching. At concurrency 8 a batch of 150 is ~19 waves, well inside the
    // 2-minute step timeout, and writes 4 D1 batches instead of 2.
    const BATCH_SIZE = 150;

    // Flat, NOT scaled by backfillWeeks. This queue is global — every blind
    // Space regardless of week — so its size does not grow with backfill
    // depth, and multiplying the cap by it bought nothing while tripling the
    // step count. That was the actual cause of the fatal error above: a
    // 3-week backfill asked for 750 enrichment steps against a queue of
    // 14,312 rows that 96 steps can drain.
    //
    // 100 x 150 = 15,000 Spaces against a standing queue of ~14,300. The cap
    // is this stage's share of the run's step ceiling, not a number chosen on
    // its own — see STEP_BUDGET.
    const MAX_BATCHES = stepsFor("enrich");

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

    // Rules settle only ~22% of a week's Spaces, leaving ~5,500 for the LLM at
    // 20 a batch — ~275 Bedrock calls. One call per step would spend 275 of a
    // 700-step ceiling on this stage alone, so a step makes CALLS_PER_STEP of
    // them and the prompt is left exactly as it was. Fewer, longer steps is
    // the only lever here that costs nothing: a bigger batch would mean a
    // bigger prompt and a longer JSON reply, and 4,096 max_tokens already
    // truncated mid-JSON at 20 once.
    const CALLS_PER_STEP = 2;
    const batchCap = stepsFor("llm");

    for (let batch = 0; batch < batchCap; batch++) {
      const result = await step.do(`classify-llm-batch-${batch}`, LLM_RETRY, async () => {
        const acc: ClassifyLlmSummary = {
          total: 0, classified: 0, batches: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheCreateTokens: 0, errors: 0,
        };
        for (let call = 0; call < CALLS_PER_STEP; call++) {
          const one = await classifySpacesByLlm(this.env.DB, client, modelId, weekStart, weekEnd);
          acc.total += one.total;
          acc.classified += one.classified;
          acc.batches += one.batches;
          acc.inputTokens += one.inputTokens;
          acc.outputTokens += one.outputTokens;
          acc.cacheReadTokens += one.cacheReadTokens;
          acc.cacheCreateTokens += one.cacheCreateTokens;
          acc.errors += one.errors;
          // Drained. Reported as a short step so the caller stops, exactly as
          // it did when a step was a single call.
          if (one.total < LLM_BATCH_SIZE) { acc.drained = true; break; }
        }
        return acc;
      });

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
      if (result.drained) return totals;
    }

    totals.truncated = true;
    return totals;
  }
}

/**
 * Which insights this run should write.
 *
 * Always the week just processed. Also the month, but only when that week was
 * the last Monday of its month — otherwise every run would overwrite the
 * previous one with a "month" that had only reached the middle of itself, and
 * a reader opening the tab mid-month would see August compared with July on
 * two weeks of evidence.
 *
 * The spans themselves come from periodSpec, shared with the repair endpoint,
 * so a summary written by hand covers exactly the same weeks as one written by
 * cron.
 */
export function insightPeriodsFor(weekStart: string, now: number = Date.now()): BuildPackOptions[] {
  const week = periodSpec("week", weekStart);
  if (!week) return [];
  // The rule is one rule, and this is the other place that asks. The weekly
  // cron always processes a week that has closed, so this is a no-op there —
  // but a run started by hand takes the CURRENT week when it is given no
  // parameters, and would otherwise write a summary of a week that is two days
  // old and present it as the week's.
  const out: BuildPackOptions[] = periodIsOpen("week", weekStart, now) ? [] : [week];

  // A week belongs to the month its Monday falls in — the same rule the
  // dashboard buckets by. The month is closed once the next Monday is in a
  // new one.
  const monday = new Date(`${weekStart}T00:00:00.000Z`);
  const monthOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const thisMonth = monthOf(monday);
  if (monthOf(addWeeks(monday, 1)) === thisMonth) return out;

  const month = periodSpec("month", thisMonth);
  if (month && !periodIsOpen("month", thisMonth, now)) out.push(month);
  return out;
}
