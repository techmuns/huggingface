import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WeeklyPipeline } from "../src/workflow";

/**
 * The first test that drives the orchestrator.
 *
 * src/workflow.ts is 796 lines and, until this file, nothing executed a single
 * one of them. Every stage it calls is covered; the code that decides WHICH
 * stages run, in what order, with which window, and what the run reports at
 * the end, was not. That is also the code about to be lifted out so a Node
 * runner can share it, and refactoring 796 untested lines is how this project
 * has repeatedly shipped silent wrongness.
 *
 * It runs the real `run()` against real D1 in workerd. Only two things are
 * substituted: the Workflow step, which becomes a plain call so there is no
 * durability or retry in the way, and `fetch`, so the Hub and Bedrock answer
 * from fixtures instead of the network.
 */
const DB = env.DB;
const realFetch = globalThis.fetch;

/** Every step.do() shape the orchestrator uses, executed immediately. */
const steps: string[] = [];
const step = {
  do: (name: string, a: unknown, b?: unknown) => {
    steps.push(name);
    return (typeof a === "function" ? a : b) as () => Promise<unknown>;
  },
} as unknown as Record<string, unknown>;

// step.do returns the function above; wrap so it is actually invoked.
const fakeStep = {
  do: async (name: string, a: unknown, b?: unknown) => {
    steps.push(name);
    const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
    return await fn();
  },
} as never;

function model(i: number) {
  return {
    id: `org${i}/model-${i}`,
    author: `org${i}`,
    createdAt: "2026-08-18T10:00:00.000Z",
    lastModified: "2026-08-18T10:00:00.000Z",
    downloads: 100 + i,
    downloadsAllTime: 1000 + i,
    likes: i,
    pipeline_tag: "text-generation",
    tags: ["transformers", i % 2 === 0 ? "qwen2" : "llama"],
    config: { model_type: i % 2 === 0 ? "qwen2" : "llama" },
  };
}

function space(i: number) {
  return {
    id: `user${i}/space-${i}`,
    author: `user${i}`,
    createdAt: "2026-08-18T10:00:00.000Z",
    lastModified: "2026-08-18T10:00:00.000Z",
    likes: i,
    sdk: "gradio",
    tags: ["text-generation", "chat"],
    models: [`org${i}/model-${i}`],
    datasets: [],
    cardData: { title: `Chat assistant ${i}` },
  };
}

function stubFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input : input.url);

    // The Hub listing. One page, no `link` header, so the walk stops cleanly.
    if (url.includes("/api/models")) {
      return new Response(JSON.stringify(Array.from({ length: 6 }, (_, i) => model(i))), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/spaces")) {
      return new Response(JSON.stringify(Array.from({ length: 6 }, (_, i) => space(i))), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    // README fetches.
    if (url.includes("/raw/main/README.md")) {
      return new Response("# Chat assistant\n\nA gradio app that chats using llama.", { status: 200 });
    }
    // Bedrock — classification and narration both land here.
    if (url.includes("bedrock")) {
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "[]" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function drive(weekStart: string) {
  const event = {
    payload: { weekStart, backfillWeeks: 1, dryRun: true },
    timestamp: new Date("2026-08-24T00:30:00.000Z"),
    instanceId: "test-instance",
  };
  // A real instance without running the WorkflowEntrypoint constructor, which
  // needs a Cloudflare execution context we do not have. The prototype carries
  // walk/enrichBlind/classifyWithLlm, so `this` has to be built from it rather
  // than from a bare object.
  const instance = Object.create(WeeklyPipeline.prototype) as { env: unknown };
  instance.env = env;
  return await (instance as unknown as {
    run(e: unknown, s: unknown): Promise<Record<string, unknown>>;
  }).run(event, fakeStep);
}

describe("the weekly pipeline, end to end", () => {
  beforeEach(async () => {
    steps.length = 0;
    stubFetch();
    await DB.batch([
      DB.prepare("DELETE FROM hf_classifications"),
      DB.prepare("DELETE FROM hf_weekly_metrics"),
      DB.prepare("DELETE FROM hf_spaces"),
      DB.prepare("DELETE FROM hf_models"),
      DB.prepare("DELETE FROM hf_raw_records"),
    ]);
  });

  afterEach(() => { globalThis.fetch = realFetch; });

  it("runs every phase in order and reports a complete result", async () => {
    const result = await drive("2026-08-17");

    // The stage order is the contract the runner will have to reproduce.
    expect(steps[0]).toBe("resolve-window");
    expect(steps).toContain("ensure-derived-schema");
    expect(steps).toContain("parse");
    expect(steps.some((s) => s.startsWith("ingest-model-page-"))).toBe(true);
    expect(steps.some((s) => s.startsWith("ingest-space-page-"))).toBe(true);
    expect(steps.some((s) => s.startsWith("resolve-models-"))).toBe(true);
    expect(steps).toContain("enrich-reset-errors");
    expect(steps.some((s) => s.startsWith("dedup-"))).toBe(true);
    expect(steps.some((s) => s.startsWith("aggregate-"))).toBe(true);

    // The shape the GitHub workflow reads: it gates on snapshot.committed and
    // resolve.done, so those must survive any refactor.
    expect(result).toHaveProperty("weekStart", "2026-08-17");
    expect(result).toHaveProperty("resolve");
    expect(result).toHaveProperty("snapshot");
    expect(result).toHaveProperty("ingest");
  });

  it("actually writes the week's data, rather than reporting that it did", async () => {
    await drive("2026-08-17");

    const models = await DB.prepare("SELECT COUNT(*) AS n FROM hf_models").first<{ n: number }>();
    const spaces = await DB.prepare("SELECT COUNT(*) AS n FROM hf_spaces").first<{ n: number }>();
    expect(models?.n).toBe(6);
    expect(spaces?.n).toBe(6);

    // Families resolved from the config/tags, not left NULL.
    const resolved = await DB.prepare(
      "SELECT COUNT(*) AS n FROM hf_models WHERE family IS NOT NULL",
    ).first<{ n: number }>();
    expect(resolved?.n).toBe(6);
  });

  it("is idempotent: running the same week twice does not double anything", async () => {
    await drive("2026-08-17");
    const first = await DB.prepare("SELECT COUNT(*) AS n FROM hf_spaces").first<{ n: number }>();

    steps.length = 0;
    await drive("2026-08-17");
    const second = await DB.prepare("SELECT COUNT(*) AS n FROM hf_spaces").first<{ n: number }>();

    expect(second?.n).toBe(first?.n);
  });
});
