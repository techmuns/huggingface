import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { weekStartIso } from "./lib/time";

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

export interface WeeklyPipelineResult {
  weekStart: string;
  status: string;
}

/**
 * The weekly pipeline: ingest -> parse -> enrich -> classify -> aggregate ->
 * narrate -> publish.
 *
 * Each stage is a Workflow step so it retries independently. Steps return
 * counts and keys, never payloads — a step result is capped at 1 MiB, which a
 * single page of 1,000 Hugging Face records would breach on its own.
 *
 * Phases 3 onward fill the steps in; this entrypoint exists from Phase 1 so
 * the binding in `wrangler.jsonc` resolves to a real exported class.
 */
export class WeeklyPipeline extends WorkflowEntrypoint<Env, WeeklyPipelineParams> {
  override async run(
    event: WorkflowEvent<WeeklyPipelineParams>,
    step: WorkflowStep,
  ): Promise<WeeklyPipelineResult> {
    const params = event.payload ?? {};

    const resolved = await step.do("resolve-window", async () => ({
      weekStart: params.weekStart ?? weekStartIso(new Date(event.timestamp)),
      backfillWeeks: params.backfillWeeks ?? 1,
      dryRun: params.dryRun ?? false,
    }));

    return { weekStart: resolved.weekStart, status: "scaffold" };
  }
}
