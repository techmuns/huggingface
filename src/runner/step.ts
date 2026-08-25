import type { PipelineStep } from "../pipeline";

/**
 * `PipelineStep` for a plain Node process.
 *
 * Cloudflare's Workflows engine gives a step three things: it runs the body,
 * it retries on failure, and it remembers the result so a resumed instance
 * skips work already done. This supplies the first two and deliberately not
 * the third.
 *
 * Durability is the one that looks alarming to drop and is not. Every stage in
 * this pipeline is already built to be re-run: ingest upserts, parse is
 * idempotent SQL, enrich and both classifiers select only rows that still lack
 * an answer, and the resolver walks cursors it recomputes from the table. That
 * is not a hopeful reading — it is what let week 2026-08-10 reach 100% across
 * six separate runs, each picking up what the last one left. A crash costs the
 * runner its wall clock and nothing else.
 *
 * What it gains in exchange is the reason the pipeline moved: no 10 ms CPU
 * ceiling per step, and no 1,024-step limit per run.
 */

export interface StepRetry {
  retries?: { limit?: number; delay?: string | number; backoff?: "constant" | "linear" | "exponential" };
  timeout?: string | number;
}

export interface StepEvent {
  name: string;
  attempt: number;
  ms: number;
  ok: boolean;
  error?: string;
}

export interface RunnerStepOptions {
  /** Called after every attempt, successful or not. The run log is built from these. */
  onEvent?: (event: StepEvent) => void;
  /**
   * Hard ceiling on the whole run, in milliseconds.
   *
   * A GitHub-hosted job is killed at six hours with no output preserved, so
   * "slow but eventually correct" — which is a fine outcome on Workflows,
   * where wall clock is unlimited — becomes "killed with nothing to show".
   * The retry policies were written for the platform without that cliff: a
   * page retry alone is 30+60+120+240+480 seconds. So the budget dominates
   * them, and a step that would sleep past it fails immediately instead,
   * leaving the stages that already landed in the database.
   */
  deadline?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** "30 seconds" | "2 minutes" | 30000 -> milliseconds. */
export function toMs(value: string | number | undefined, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return fallback;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)?\s*$/i.exec(value);
  if (!m) return fallback;
  const n = Number(m[1]);
  switch ((m[2] ?? "s").toLowerCase()) {
    case "ms": case "millisecond": case "milliseconds": return n;
    case "m": case "minute": case "minutes": return n * 60_000;
    case "h": case "hour": case "hours": return n * 3_600_000;
    default: return n * 1_000;
  }
}

function delayFor(
  attempt: number,
  base: number,
  backoff: "constant" | "linear" | "exponential",
): number {
  if (backoff === "constant") return base;
  if (backoff === "linear") return base * attempt;
  return base * 2 ** (attempt - 1);
}

export function createRunnerStep(options: RunnerStepOptions = {}): PipelineStep {
  const { onEvent, deadline } = options;

  async function run<T>(
    name: string,
    retry: StepRetry | undefined,
    callback: () => Promise<T>,
  ): Promise<T> {
    const limit = retry?.retries?.limit ?? 0;
    const base = toMs(retry?.retries?.delay, 1_000);
    const backoff = retry?.retries?.backoff ?? "constant";

    let lastError: unknown;

    for (let attempt = 1; attempt <= limit + 1; attempt++) {
      const startedAt = Date.now();
      try {
        const value = await callback();
        onEvent?.({ name, attempt, ms: Date.now() - startedAt, ok: true });
        return value;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        onEvent?.({ name, attempt, ms: Date.now() - startedAt, ok: false, error: message });

        if (attempt > limit) break;

        const wait = delayFor(attempt, base, backoff);

        // Refuse a sleep that would outlive the job rather than being killed
        // mid-wait. Failing here keeps whatever the earlier stages committed
        // and produces a log line; being killed produces neither.
        if (deadline !== undefined && Date.now() + wait > deadline) {
          throw new Error(
            `${name}: ${message} — giving up, a ${Math.round(wait / 1000)}s retry would pass the run deadline`,
            { cause: err },
          );
        }
        await sleep(wait);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`${name} failed: ${String(lastError)}`);
  }

  // Both call shapes the pipeline uses: with a retry policy and without.
  const step = {
    do<T>(
      name: string,
      optionsOrCallback: unknown,
      maybeCallback?: () => Promise<T>,
    ): Promise<T> {
      return typeof optionsOrCallback === "function"
        ? run(name, undefined, optionsOrCallback as () => Promise<T>)
        : run(name, optionsOrCallback as StepRetry, maybeCallback as () => Promise<T>);
    },
  };

  return step as PipelineStep;
}
