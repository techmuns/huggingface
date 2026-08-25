import { describe, expect, it, vi } from "vitest";
import { createRunnerStep, toMs, type StepEvent } from "../../src/runner/step";

describe("toMs", () => {
  it("reads the duration strings the pipeline's retry policies use", () => {
    expect(toMs("30 seconds", 0)).toBe(30_000);
    expect(toMs("5 seconds", 0)).toBe(5_000);
    expect(toMs("2 minutes", 0)).toBe(120_000);
    expect(toMs("5 minutes", 0)).toBe(300_000);
    expect(toMs("10 seconds", 0)).toBe(10_000);
    expect(toMs(1234, 0)).toBe(1234);
    expect(toMs(undefined, 99)).toBe(99);
    expect(toMs("nonsense", 42)).toBe(42);
  });
});

describe("the runner's step", () => {
  it("returns the callback's value and reports one attempt", async () => {
    const events: StepEvent[] = [];
    const step = createRunnerStep({ onEvent: (e) => events.push(e) });
    await expect(step.do("phase", async () => 7)).resolves.toBe(7);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "phase", attempt: 1, ok: true });
  });

  it("retries to the policy's limit and then gives up", async () => {
    vi.useFakeTimers();
    try {
      const events: StepEvent[] = [];
      const step = createRunnerStep({ onEvent: (e) => events.push(e) });
      let calls = 0;

      const pending = step.do("flaky", { retries: { limit: 3, delay: "1 second" } }, async () => {
        calls++;
        throw new Error("nope");
      }).catch((e: Error) => e);

      await vi.runAllTimersAsync();
      const outcome = await pending;

      // limit 3 means four attempts in total, matching Cloudflare's semantics.
      expect(calls).toBe(4);
      expect((outcome as Error).message).toBe("nope");
      expect(events.filter((e) => !e.ok)).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("succeeds on a later attempt without surfacing the earlier failures", async () => {
    vi.useFakeTimers();
    try {
      const step = createRunnerStep();
      let calls = 0;
      const pending = step.do("recovers", { retries: { limit: 5, delay: "1 second" } }, async () => {
        if (++calls < 3) throw new Error("transient");
        return "ok";
      });
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBe("ok");
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off exponentially, as the page and LLM policies expect", async () => {
    vi.useFakeTimers();
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    try {
      const step = createRunnerStep();
      const pending = step
        .do("pages", { retries: { limit: 4, delay: "30 seconds", backoff: "exponential" } }, async () => {
          throw new Error("429");
        })
        .catch(() => null);
      await vi.runAllTimersAsync();
      await pending;
      expect(waits).toEqual([30_000, 60_000, 120_000, 240_000]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("refuses a retry that would sleep past the run deadline", async () => {
    // A GitHub job is killed at six hours with nothing preserved. A page retry
    // alone is 930 seconds of sleeping, and those policies were written for a
    // platform with unlimited wall clock. Failing here keeps whatever earlier
    // stages committed and leaves a log line; being killed leaves neither.
    const step = createRunnerStep({ deadline: Date.now() + 1_000 });

    await expect(
      step.do("late", { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" } }, async () => {
        throw new Error("hub timeout");
      }),
    ).rejects.toThrow(/run deadline/);
  });

  it("does not memoise: a re-run genuinely re-runs", async () => {
    // Unlike Cloudflare's step, which serves a completed step from cache. The
    // runner has no durable state, so recovery is re-running — which every
    // stage is built for, and which is how one week reached 100% across six
    // separate runs.
    const step = createRunnerStep();
    let calls = 0;
    const body = async () => ++calls;
    await step.do("same-name", body);
    await step.do("same-name", body);
    expect(calls).toBe(2);
  });
});
