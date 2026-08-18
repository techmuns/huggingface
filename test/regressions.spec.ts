/**
 * Regressions for defects found by adversarial review.
 *
 * Each test here failed before its fix. They are grouped by the symptom a
 * reader of the dashboard would have seen, because that is what makes them
 * worth keeping.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { aggregateWeeklyMetrics } from "../src/lib/aggregate";
import { BedrockClient, type BedrockResponse, firstText } from "../src/lib/bedrock";
import { RULES_PAGE_SIZE, classifyByRules, classifySpacesByRules } from "../src/lib/classify-rules";
import { dedupSpaces } from "../src/lib/enrich";
import { parseRawSpaces } from "../src/lib/parse";
import { insertRawRecords } from "../src/lib/raw-store";
import { TAXONOMY_VERSION } from "../src/lib/taxonomy";

const DB = env.DB;

beforeEach(async () => {
  await DB.batch([
    DB.prepare("DELETE FROM hf_weekly_metrics"),
    DB.prepare("DELETE FROM hf_classifications"),
    DB.prepare("DELETE FROM hf_spaces"),
    DB.prepare("DELETE FROM hf_models"),
    DB.prepare("DELETE FROM hf_raw_records"),
  ]);
});

// ── Fabricated growth from a partial window ─────────────────────────────────

describe("growth is not fabricated from a partial previous window", () => {
  async function seedWeek(week: string, coding: number, total: number) {
    const records = [];
    for (let i = 0; i < total; i++) {
      records.push({
        id: `w${week}-${i}/space-${i}`,
        author: `a${i}`,
        createdAt: `${week}T12:00:00.000Z`,
        lastModified: `${week}T12:00:00.000Z`,
        likes: 0,
        sdk: "gradio",
        tags: i < coding ? ["code-generation"] : ["conversational"],
        models: [],
        datasets: [],
        cardData: { title: `Space ${week} ${i}` },
      });
    }
    await insertRawRecords(DB, {
      runId: `run-${week}`, kind: "space", records, fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, `run-${week}`);
    const end = new Date(new Date(`${week}T00:00:00.000Z`).getTime() + 7 * 86_400_000).toISOString();
    await classifySpacesByRules(DB, `${week}T00:00:00.000Z`, end);
    await aggregateWeeklyMetrics(DB, week, end);
  }

  it("reports no 4W delta when only part of the previous window exists", async () => {
    // Flat activity: 12 coding Spaces every week, for five consecutive weeks.
    // The current 4W window is complete; the previous one only has a single
    // week of history. Summing 4 weeks against 1 invented a ~300% surge.
    for (const w of ["2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10"]) {
      await seedWeek(w, 12, 20);
    }

    const row = await DB.prepare(
      `SELECT value, delta_4w FROM hf_weekly_metrics
       WHERE week_start = ?1 AND metric_cut = 'spaces_by_use_case'
         AND dimension = 'coding' AND taxonomy_version = ?2`,
    )
      .bind("2026-08-10", TAXONOMY_VERSION)
      .first<{ value: number; delta_4w: number | null }>();

    expect(row?.value).toBe(12);
    expect(row?.delta_4w).toBeNull();
  });

  it("reports a flat 4W delta once both windows are complete", async () => {
    const weeks = [
      "2026-05-18", "2026-05-25", "2026-06-01", "2026-06-08",
      "2026-06-15", "2026-06-22", "2026-06-29", "2026-07-06",
    ];
    for (const w of weeks) await seedWeek(w, 12, 20);

    const row = await DB.prepare(
      `SELECT delta_4w FROM hf_weekly_metrics
       WHERE week_start = ?1 AND metric_cut = 'spaces_by_use_case'
         AND dimension = 'coding' AND taxonomy_version = ?2`,
    )
      .bind("2026-07-06", TAXONOMY_VERSION)
      .first<{ delta_4w: number | null }>();

    // Genuinely flat activity must read as 0%, not as growth.
    expect(row?.delta_4w).toBeCloseTo(0, 6);
  });
});

// ── Untitled Spaces collapsing into one cluster ─────────────────────────────

describe("dedup does not collapse untitled Spaces", () => {
  it("keeps every untitled, unlinked Space as its own cluster", async () => {
    // These have no title and no linked model, so there is nothing to be a
    // duplicate of. Keying them on the empty string clustered all of them
    // together and suppressed all but one from every metric.
    const records = Array.from({ length: 5 }, (_, i) => ({
      id: `anon${i}/untitled-${i}`,
      author: `anon${i}`,
      createdAt: "2026-08-17T12:00:00.000Z",
      lastModified: "2026-08-17T12:00:00.000Z",
      likes: 0,
      sdk: "static",
      tags: [],
      models: [],
      datasets: [],
      cardData: {},
    }));
    await insertRawRecords(DB, {
      runId: "run-1", kind: "space", records, fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, "run-1");

    const result = await dedupSpaces(DB, "2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
    expect(result.clusters).toBe(0);
    expect(result.clustered).toBe(0);

    const primaries = await DB.prepare(
      "SELECT COUNT(*) AS c FROM hf_spaces WHERE is_cluster_primary = 1",
    ).first<{ c: number }>();
    expect(primaries?.c).toBe(5);
  });

  it("still clusters genuine template clones", async () => {
    const records = Array.from({ length: 4 }, (_, i) => ({
      id: `user${i}/first-agent-template`,
      author: `user${i}`,
      createdAt: "2026-08-17T12:00:00.000Z",
      lastModified: "2026-08-17T12:00:00.000Z",
      likes: 0,
      sdk: "gradio",
      tags: [],
      models: [],
      datasets: [],
      cardData: { title: "First Agent Template" },
    }));
    await insertRawRecords(DB, {
      runId: "run-1", kind: "space", records, fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, "run-1");

    const result = await dedupSpaces(DB, "2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
    expect(result.clusters).toBe(1);
    expect(result.clustered).toBe(3);
  });
});

// ── Rule paging ─────────────────────────────────────────────────────────────

describe("rule classification pages without spinning", () => {
  it("drains a queue containing Spaces the rules cannot settle", async () => {
    // Unclassifiable Spaces are left for Pass B, so they stay in the queue.
    // A LIMIT without a cursor would re-read them forever.
    const records = Array.from({ length: 12 }, (_, i) => ({
      id: `u${String(i).padStart(3, "0")}/thing-${i}`,
      author: `u${i}`,
      createdAt: "2026-08-17T12:00:00.000Z",
      lastModified: "2026-08-17T12:00:00.000Z",
      likes: 0,
      sdk: "docker",
      tags: i % 2 === 0 ? ["code-generation"] : [],
      models: [],
      datasets: [],
      cardData: i % 2 === 0 ? { title: `Code Tool ${i}` } : {},
    }));
    await insertRawRecords(DB, {
      runId: "run-1", kind: "space", records, fetchedAt: "2026-08-18T00:00:00.000Z",
    });
    await parseRawSpaces(DB, "run-1");

    let cursor = "";
    let pages = 0;
    let examined = 0;
    for (; pages < 50; pages++) {
      const part = await classifySpacesByRules(
        DB, "2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z", cursor, 5,
      );
      examined += part.total;
      if (!part.nextCursor) break;
      cursor = part.nextCursor;
    }

    expect(pages).toBeLessThan(10);
    expect(examined).toBe(12);
  });

  it("exposes a page size that bounds statements per invocation", () => {
    expect(RULES_PAGE_SIZE).toBeLessThanOrEqual(500);
  });
});

// ── Vertical signal from tags ───────────────────────────────────────────────

describe("verticals read declared tags", () => {
  it("records healthcare for a Space tagged medical", () => {
    // `medical` routes the use case to scientific-tools; before the fix the
    // healthcare vertical was then lost entirely, which is precisely the
    // activity the brief asks us to track.
    const result = classifyByRules({
      spaceId: "org/analysis-tool",
      title: null,
      shortDescription: null,
      sdk: "gradio",
      tags: ["medical"],
      linkedModels: [],
      linkedDatasets: [],
      readmeText: null,
    });
    expect(result).not.toBeNull();
    expect(result!.verticals).toContain("healthcare");
  });
});

// ── Bedrock response parsing ────────────────────────────────────────────────

describe("firstText", () => {
  const base = {
    id: "m", type: "message" as const, role: "assistant" as const,
    model: "x", usage: { input_tokens: 1, output_tokens: 1 },
  };

  it("skips a leading thinking block", () => {
    // The narration model runs adaptive thinking, so content[0] is a thinking
    // block and the old content[0].text yielded "" — a silently blank summary.
    const res = {
      ...base,
      stop_reason: "end_turn" as const,
      content: [
        { type: "thinking", thinking: "considering the metrics" },
        { type: "text", text: "Coding Spaces rose 35%." },
      ],
    } as BedrockResponse;
    expect(firstText(res)).toBe("Coding Spaces rose 35%.");
  });

  it("raises on a truncated response instead of returning half a payload", () => {
    const res = {
      ...base,
      stop_reason: "max_tokens" as const,
      content: [{ type: "text", text: '{"results":[{"spaceId"' }],
    } as BedrockResponse;
    expect(() => firstText(res)).toThrow(/truncated/i);
  });

  it("raises when there is no text block at all", () => {
    const res = {
      ...base,
      stop_reason: "end_turn" as const,
      content: [{ type: "thinking", thinking: "..." }],
    } as BedrockResponse;
    expect(() => firstText(res)).toThrow(/no text block/i);
  });
});

// ── Bedrock request shape ───────────────────────────────────────────────────

describe("structured-output request shape", () => {
  it("puts the schema directly under format, with no json_schema wrapper", async () => {
    // The OpenAI-style { json_schema: { name, schema } } wrapper type-checks
    // perfectly and is rejected by the API with "Unexpected key 'json_schema'",
    // so every classification call 400'd and the pipeline stalled in retry
    // backoff with no error surfaced. Caught only by inspecting the wire body.
    let sent: any = null;
    const client = new BedrockClient({ apiKey: "k", region: "us-east-1" });
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: "m", type: "message", role: "assistant", model: "x",
          stop_reason: "end_turn", content: [{ type: "text", text: '{"results":[]}' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      await client.invoke("model-id", {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 16,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        output_config: { format: { type: "json_schema", schema: { type: "object" } } },
      });
    } finally {
      globalThis.fetch = original;
    }

    expect(sent.output_config.format.type).toBe("json_schema");
    expect(sent.output_config.format.schema).toBeDefined();
    expect(sent.output_config.format.json_schema).toBeUndefined();
    expect(sent.anthropic_version).toBe("bedrock-2023-05-31");
  });
});
