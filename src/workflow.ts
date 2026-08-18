import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { HfClient, type EntityKind } from "./lib/hf-api";
import { MAX_PAGES_PER_WALK, ingestPage } from "./lib/ingest";
import { type ResolveSummary, resolveModelFamilies } from "./lib/model-family";
import { type ParseSummary, parseRawModels, parseRawSpaces } from "./lib/parse";
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

    return {
      runId: config.runId,
      weekStart: config.weekStart,
      since: config.since,
      ingest,
      parse,
      resolve,
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
}
