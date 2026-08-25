import { describe, expect, it } from "vitest";
import {
  STEP_BUDGET,
  WORKING_STEPS,
  WORST_CASE_STEPS,
  stepsFor,
} from "../src/pipeline";
import { RULES_PAGE_SIZE } from "../src/lib/classify-rules";
import { MAX_PAGE_SIZE } from "../src/lib/hf-api";

/**
 * The step budget is the thing that decides whether an unattended dashboard
 * keeps filling itself.
 *
 * Cloudflare replays a Workflow's orchestration from the top at every step
 * boundary, so a run's overhead grows with the NUMBER of steps and the
 * instance is killed — WorkflowFatalError, "exceeded CPU or memory limits
 * outside of a step" — long before the documented 10,000. A run that is killed
 * writes no week at all.
 *
 * The previous budget was a comment. It mixed measured figures for two stages
 * with caps for the others, so it read ~663 while the caps permitted 2,845,
 * and nothing anywhere checked it. These tests are the check.
 */
describe("the workflow step budget", () => {
  it("fits inside the working ceiling when every stage exhausts its share", () => {
    expect(WORST_CASE_STEPS).toBeLessThanOrEqual(WORKING_STEPS);
  });

  it("leaves headroom rather than sitting on the ceiling", () => {
    // Workflows charges for retries against the same replay cost, so a budget
    // that exactly meets the ceiling meets it only while nothing fails.
    expect(WORST_CASE_STEPS).toBeLessThanOrEqual(WORKING_STEPS * 0.9);
  });

  it("accounts for BOTH ingest walks, not one", () => {
    // The walk runs once for models and once for Spaces. The old comment
    // counted a single walk's measured page count and missed a whole pass.
    const single = WORST_CASE_STEPS - STEP_BUDGET.ingestPerWalk;
    expect(single).toBeLessThan(WORST_CASE_STEPS);
    expect(WORST_CASE_STEPS - single).toBe(STEP_BUDGET.ingestPerWalk);
  });

  it("keeps an ingest page inside the CPU a step is given", () => {
    // A step gets 10ms of CPU on Workers Free, and an ingest step serializes
    // every record it fetches. At 1,000 a page that measured 7.8ms — the whole
    // budget, with nothing left for orchestration replay — and a run died at
    // ingest-model-page-41 with "Worker exceeded CPU time limit", the fastest
    // of six attempts failing in 178ms.
    //
    // This is a proxy, not a CPU measurement: it pins the page size that the
    // measurement justified, so raising it silently is not possible.
    expect(MAX_PAGE_SIZE).toBeLessThanOrEqual(400);

    // And the smaller page must still cover the deepest walk seen (41,000
    // records) inside the step budget, or the fix trades one ceiling for
    // another.
    const DEEPEST_WALK_RECORDS = 41_000;
    const pagesNeeded = Math.ceil(DEEPEST_WALK_RECORDS / MAX_PAGE_SIZE);
    expect(pagesNeeded).toBeLessThanOrEqual(STEP_BUDGET.ingestPerWalk);
  });

  it("gives the rules pass enough capacity for a whole week", () => {
    // This drifted unnoticed because nothing asserted it: the budget comment
    // described 400 Spaces a page while RULES_PAGE_SIZE was 120, so capacity
    // was 4,800 against ~6,800 new Spaces a week and ~2,000 were never
    // examined — counted in the denominator, absent from every chart. The
    // equivalent assertions existed for `llm` and `enrich`, just not this one.
    const SPACES_PER_WEEK = 6_800;
    expect(STEP_BUDGET.rules * RULES_PAGE_SIZE).toBeGreaterThan(SPACES_PER_WEEK);
  });

  describe("stepsFor", () => {
    it("takes no backfill depth at all", () => {
      // Structural, not incidental. Every earlier version scaled a cap by the
      // number of weeks requested, which is what terminated the runs: the
      // ceiling belongs to the Workflow instance, so a bigger request cannot
      // buy a bigger budget — it can only overshoot and write nothing. A
      // function that cannot see the depth cannot be widened by it.
      expect(stepsFor).toHaveLength(1);
    });

    it("returns each stage's share, and never more", () => {
      for (const stage of Object.keys(STEP_BUDGET) as Array<keyof typeof STEP_BUDGET>) {
        expect(stepsFor(stage)).toBe(STEP_BUDGET[stage]);
        expect(stepsFor(stage)).toBeLessThanOrEqual(STEP_BUDGET[stage]);
      }
    });

    it("gives every stage at least one step, so none is silently skipped", () => {
      for (const stage of Object.keys(STEP_BUDGET) as Array<keyof typeof STEP_BUDGET>) {
        expect(stepsFor(stage)).toBeGreaterThanOrEqual(1);
      }
    });

    it("keeps a run inside the ceiling with every stage at its cap", () => {
      const worst =
        stepsFor("ingestPerWalk") * 2 +
        stepsFor("enrich") +
        stepsFor("rules") +
        stepsFor("llm") +
        stepsFor("terminal");
      expect(worst).toBe(WORST_CASE_STEPS);
      expect(worst).toBeLessThanOrEqual(WORKING_STEPS);
    });
  });

  it("gives classification enough steps for a measured week", () => {
    // ~5,500 Spaces reach the LLM each week at 20 a call, and a step makes two
    // calls. Short of this the weekly run truncates classification every week,
    // which shows up as a permanently sagging coverage figure.
    const CALLS_PER_STEP = 2;
    const SPACES_PER_CALL = 20;
    const MEASURED_WEEKLY = 5500;
    expect(stepsFor("llm") * CALLS_PER_STEP * SPACES_PER_CALL)
      .toBeGreaterThanOrEqual(MEASURED_WEEKLY);
  });

  it("gives enrichment enough steps to drain the standing queue", () => {
    const READMES_PER_STEP = 150;
    // Observed on the live database on 2026-08-24, and growing: it was 14,312
    // when this test was written and the cap of 100 steps x 150 = 15,000 had
    // already slipped underneath it, so enrich truncated every week and the
    // READMEs it never fetched are the signal the classifiers then work
    // without. The number is a floor to budget above, not a constant.
    const STANDING_QUEUE = 16_494;
    expect(stepsFor("enrich") * READMES_PER_STEP).toBeGreaterThanOrEqual(STANDING_QUEUE);
  });
});
