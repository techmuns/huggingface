/**
 * Cloudflare's driver for the weekly pipeline.
 *
 * The pipeline itself lives in `src/pipeline.ts` and knows nothing about
 * Workers. This file is the adapter: it satisfies `PipelineStep` with
 * Cloudflare's `WorkflowStep`, `PipelineEnv` with the Worker's bindings, and
 * `PipelineEvent` with the workflow event — then gets out of the way.
 *
 * Keeping it this thin is the point. There are two runtimes now, and the way
 * two runtimes go wrong is by drifting: each acquiring a fix the other missed,
 * agreeing on every test, and disagreeing on the week they publish. They can
 * only drift if there are two copies of the logic, so there is one, and this
 * file is not it.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  type PipelineStep,
  type WeeklyPipelineParams,
  type WeeklyPipelineResult,
  runWeeklyPipeline,
} from "./pipeline";

export class WeeklyPipeline extends WorkflowEntrypoint<Env, WeeklyPipelineParams> {
  override async run(
    event: WorkflowEvent<WeeklyPipelineParams>,
    step: WorkflowStep,
  ): Promise<WeeklyPipelineResult> {
    return runWeeklyPipeline(step as PipelineStep, this.env, {
      payload: event.payload,
      timestamp: event.timestamp,
      instanceId: event.instanceId,
    });
  }
}

// Re-exported so existing importers — the tests and src/index.ts — keep
// working without caring which file the pipeline moved to.
export {
  STEP_BUDGET,
  WORKING_STEPS,
  WORST_CASE_STEPS,
  insightPeriodsFor,
  runWeeklyPipeline,
  stepsFor,
  type PipelineEnv,
  type PipelineEvent,
  type PipelineStep,
  type WeeklyPipelineParams,
  type WeeklyPipelineResult,
} from "./pipeline";
