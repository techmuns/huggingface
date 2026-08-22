import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_COVERAGE_GAP,
  MIN_COVERAGE,
  MIN_DENOMINATOR,
  MIN_FACTS,
  buildFactPack,
  ensureInsightsSchema,
  isMissingInsightsTable,
  mondaysOfMonth,
  periodIsOpen,
  periodSpec,
  withInsightsSchema,
  generateInsight,
  ground,
  renderPack,
  saveInsight,
  slotsOf,
  type Fact,
} from "../src/lib/insights";
import { insightPeriodsFor } from "../src/workflow";
import { TAXONOMY_VERSION } from "../src/lib/taxonomy";
import { aggregateWeeklyMetrics } from "../src/lib/aggregate";
import type { BedrockClient, BedrockResponse } from "../src/lib/bedrock";

const DB = env.DB;

beforeEach(async () => {
  await DB.batch([
    DB.prepare("DELETE FROM hf_insights"),
    DB.prepare("DELETE FROM hf_weekly_metrics"),
  ]);
});

const fact = (o: Partial<Fact> = {}): Fact => ({
  id: "F1", what: "new Spaces in total", unit: "count",
  value: 1462, prev: 1301, changePct: 12.4, changePts: null, denominator: null,
  ...o,
});

// ── grounding ───────────────────────────────────────────────────────────────

describe("ground", () => {
  it("substitutes a slot with the figure it names", () => {
    const r = ground("There were {{F1.value}} of them.", [fact()]);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("There were 1,462 of them.");
  });

  it("formats a share as a share and a count as a count", () => {
    const r = ground("{{F1.value}} and {{F2.value}}.", [
      fact(),
      fact({ id: "F2", unit: "percent", value: 6.4421, prev: null, changePct: null }),
    ]);
    expect(r.text).toBe("1,462 and 6.4%.");
  });

  it("signs a change with a real minus, not a hyphen", () => {
    const r = ground("{{F1.change}}", [fact({ changePct: -3.06 })]);
    expect(r.text).toBe("−3.1%");
  });

  it("refuses a digit the model wrote itself", () => {
    // The whole point. "about 1,500" is the failure this exists to catch: it
    // is plausible, it is close, and it is not a number in the data.
    const r = ground("There were about 1,500 of them, up {{F1.change}}.", [fact()]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/digit of its own/);
    expect(r.text).toBe("");
  });

  it("refuses a slot naming a fact that was not in the pack", () => {
    const r = ground("{{F9.value}} of them.", [fact()]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in the pack/);
  });

  it("refuses a slot the fact does not offer", () => {
    // A fact with no earlier period has no change slot. Letting this through
    // would print a comparison against a period that was never measured.
    const r = ground("up {{F1.change}}", [fact({ prev: null, changePct: null })]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not have/);
  });

  it("refuses a placeholder that is not a slot at all", () => {
    const r = ground("{{ made up }} of them.", [fact()]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unrecognised placeholder/);
  });

  it("does not mistake a substituted figure for one the model wrote", () => {
    // The digit check runs on the ORIGINAL text with slots stripped out, so a
    // correctly-grounded 1,462 never trips it.
    const r = ground("{{F1.value}} {{F1.prev}} {{F1.change}}", [fact()]);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("1,462 1,301 +12.4%");
  });

  it("lets numbers written as words through", () => {
    const r = ground("The top three all grew, led by {{F1.value}}.", [fact()]);
    expect(r.ok).toBe(true);
  });
});

describe("slotsOf", () => {
  it("offers nothing for a figure that does not exist", () => {
    const s = slotsOf(fact({ prev: null, changePct: null, changePts: null, denominator: null }));
    expect(s.value).toBe("1,462");
    expect(s.prev).toBeNull();
    expect(s.change).toBeNull();
    expect(s.points).toBeNull();
  });

  it("names only the slots it can fill, in the pack it renders", () => {
    const text = renderPack({
      kind: "week", periodKey: "2026-08-10", periodLabel: "the week of 10 Aug 2026",
      previousLabel: null, omitted: [],
      facts: [fact({ prev: null, changePct: null })],
    });
    expect(text).toContain("{{F1.value}}");
    expect(text).not.toContain("{{F1.change}}");
  });
});

// ── the fact pack ───────────────────────────────────────────────────────────

/**
 * Seeds metric rows the way the AGGREGATOR writes them.
 *
 * `cov` is given as a percentage for readability and stored as a ratio,
 * because that is what aggregate.ts writes: `classified / denominator`. The
 * earlier version of this helper stored the percentage directly, which is why
 * a units bug that omitted every classification fact from every pack passed a
 * full suite — the fixtures encoded the assumption instead of the system.
 */
async function seedWeek(
  week: string,
  rows: Array<[cut: string, dim: string, value: number, den: number, cov: number | null]>,
) {
  await DB.batch(rows.map(([cut, dim, value, den, cov]) =>
    DB.prepare(
      `INSERT INTO hf_weekly_metrics
         (week_start, metric_cut, dimension, sub_dimension, value, denominator,
          coverage, suppressed, taxonomy_version, computed_at)
       VALUES (?1,?2,?3,'',?4,?5,?6,0,?7,?1)`,
    ).bind(week, cut, dim, value, den, cov == null ? null : cov / 100, TAXONOMY_VERSION)));

  // Every week needs an SDK row: it is where the week's whole Space count comes
  // from, and a week with no classifications writes no use-case rows at all.
  const sdk = rows.find(([cut]) => cut === "sdk_distribution");
  if (!sdk) {
    const den = rows[0]?.[3] ?? 0;
    await DB.prepare(
      `INSERT OR IGNORE INTO hf_weekly_metrics
         (week_start, metric_cut, dimension, sub_dimension, value, denominator,
          coverage, suppressed, taxonomy_version, computed_at)
       VALUES (?1,'sdk_distribution','gradio','',?2,?2,NULL,0,?3,?1)`,
    ).bind(week, den, TAXONOMY_VERSION).run();
  }
}

const weekPack = (week: string, prev: string) => ({
  kind: "week" as const, periodKey: week, periodLabel: week,
  previousLabel: prev, weeks: [week], previousWeeks: [prev],
});

describe("buildFactPack", () => {
  it("puts a category and its change in front of the model", async () => {
    await seedWeek("2026-08-03", [["spaces_by_use_case", "coding", 100, 200, 80]]);
    await seedWeek("2026-08-10", [["spaces_by_use_case", "coding", 150, 300, 80]]);
    const pack = await buildFactPack(DB, weekPack("2026-08-10", "2026-08-03"));
    const coding = pack.facts.find((f) => f.what.includes("coding"));
    expect(coding?.value).toBe(150);
    expect(coding?.prev).toBe(100);
    expect(coding?.changePct).toBeCloseTo(50, 5);
  });

  it("omits every classification figure when coverage collapsed", async () => {
    // The week of 3 August 2026: coverage 21.68%, because the LLM classifier
    // never ran. Every use-case and technique figure for it describes a
    // quarter of the week. The gate is omission from the pack, not an
    // instruction in the prompt — an instruction is a request, an absent fact
    // is a guarantee.
    await seedWeek("2026-08-10", [
      ["spaces_by_use_case", "coding", 150, 300, 21.68],
      ["technology_penetration", "rag", 12.5, 300, 21.68],
      ["models_by_family", "qwen", 3849, 3849, null],
    ]);
    const pack = await buildFactPack(DB, weekPack("2026-08-10", "2026-08-03"));
    expect(pack.facts.some((f) => f.what.includes("coding"))).toBe(false);
    expect(pack.facts.some((f) => f.what.includes("RAG"))).toBe(false);
    // The models figure comes from hf_models and survives.
    expect(pack.facts.some((f) => f.what.includes("Qwen"))).toBe(true);
    // And the reader is told why, rather than the week reading as quiet.
    expect(pack.facts[0]!.what).toMatch(/able to classify/);
    expect(pack.omitted.join(" ")).toMatch(new RegExp(`below the ${MIN_COVERAGE}% floor`));
  });

  it("keeps them when coverage is fine", async () => {
    await seedWeek("2026-08-10", [
      ["spaces_by_use_case", "coding", 150, 300, 78],
      ["technology_penetration", "rag", 12.5, 300, 78],
    ]);
    const pack = await buildFactPack(DB, weekPack("2026-08-10", "2026-08-03"));
    expect(pack.facts.some((f) => f.what.includes("coding"))).toBe(true);
    expect(pack.facts.some((f) => f.what.includes("RAG"))).toBe(true);
  });

  it("omits a share over too small a base", async () => {
    await seedWeek("2026-08-10", [
      ["spaces_by_use_case", "coding", 150, 300, 78],
      ["technology_penetration", "moe", 40, MIN_DENOMINATOR - 1, 78],
    ]);
    const pack = await buildFactPack(DB, weekPack("2026-08-10", "2026-08-03"));
    expect(pack.facts.some((f) => f.what.includes("MoE"))).toBe(false);
    expect(pack.omitted.join(" ")).toMatch(/below the .* floor/);
  });

  it("omits a row the pipeline itself marked too small", async () => {
    await seedWeek("2026-08-10", [["spaces_by_use_case", "coding", 150, 300, 78]]);
    await DB.prepare(
      `INSERT INTO hf_weekly_metrics
         (week_start, metric_cut, dimension, sub_dimension, value, denominator,
          coverage, suppressed, taxonomy_version, computed_at)
       VALUES ('2026-08-10','spaces_by_use_case','robotics','',3,300,78,1,?1,'2026-08-10')`,
    ).bind(TAXONOMY_VERSION).run();
    const pack = await buildFactPack(DB, weekPack("2026-08-10", "2026-08-03"));
    expect(pack.facts.some((f) => f.what.includes("robotics"))).toBe(false);
  });

  it("gives a fact no change slot when there is nothing before it", async () => {
    await seedWeek("2026-08-10", [["spaces_by_use_case", "coding", 150, 300, 78]]);
    const pack = await buildFactPack(DB, weekPack("2026-08-10", "2026-08-03"));
    const coding = pack.facts.find((f) => f.what.includes("coding"))!;
    expect(coding.prev).toBeNull();
    expect(coding.changePct).toBeNull();
    expect(slotsOf(coding).change).toBeNull();
  });

  it("pools a monthly share by base rather than averaging the weeks flat", async () => {
    // 10% of 100 and 50% of 900 is 46%, not 30%. Getting this wrong in prose
    // would be invisible — it would read as a sentence.
    await seedWeek("2026-08-03", [
      ["technology_penetration", "rag", 10, 100, 90],
      ["spaces_by_use_case", "coding", 50, 100, 90],
    ]);
    await seedWeek("2026-08-10", [
      ["technology_penetration", "rag", 50, 900, 90],
      ["spaces_by_use_case", "coding", 400, 900, 90],
    ]);
    const pack = await buildFactPack(DB, {
      kind: "month", periodKey: "2026-08", periodLabel: "August 2026",
      previousLabel: "July 2026", weeks: ["2026-08-03", "2026-08-10"], previousWeeks: [],
    });
    const rag = pack.facts.find((f) => f.what.includes("RAG"))!;
    expect(rag.value).toBeCloseTo(46, 5);
  });
});

// ── the whole call ──────────────────────────────────────────────────────────

function stubClient(replies: string[]): BedrockClient {
  let i = 0;
  return {
    invoke: async (): Promise<BedrockResponse> => ({
      id: "x", type: "message", role: "assistant",
      content: [{ type: "text", text: replies[Math.min(i++, replies.length - 1)]! }],
      model: "m", stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
  } as unknown as BedrockClient;
}

const fullPack = () => ({
  kind: "week" as const, periodKey: "2026-08-10", periodLabel: "the week of 10 Aug 2026",
  previousLabel: "the week of 3 Aug 2026", omitted: [],
  facts: Array.from({ length: MIN_FACTS }, (_, k) => fact({ id: `F${k + 1}` })),
});

describe("generateInsight", () => {
  it("returns grounded prose", async () => {
    const r = await generateInsight(stubClient(["Activity rose to {{F1.value}} Spaces."]), "m", fullPack());
    expect(r.status).toBe("ok");
    expect(r.narrative).toBe("Activity rose to 1,462 Spaces.");
  });

  it("asks again when the model writes a figure of its own", async () => {
    const r = await generateInsight(
      stubClient(["Activity rose to about 1,500 Spaces.", "Activity rose to {{F1.value}} Spaces."]),
      "m", fullPack(),
    );
    expect(r.status).toBe("ok");
    expect(r.narrative).toBe("Activity rose to 1,462 Spaces.");
    // Both calls are paid for, and both are counted.
    expect(r.outputTokens).toBe(40);
  });

  it("gives up rather than publishing an ungrounded summary", async () => {
    const r = await generateInsight(stubClient(["Activity rose to about 1,500 Spaces."]), "m", fullPack());
    expect(r.status).toBe("ungrounded");
    expect(r.narrative).toBe("");
    expect(r.detail).toMatch(/digit of its own/);
  });

  it("does not call the model at all when there is nothing to say", async () => {
    let called = 0;
    const client = { invoke: async () => { called++; throw new Error("should not be called"); } } as unknown as BedrockClient;
    const r = await generateInsight(client, "m", { ...fullPack(), facts: [fact()] });
    expect(called).toBe(0);
    expect(r.status).toBe("insufficient");
  });

  it("records a transport failure as an error rather than as silence", async () => {
    const client = { invoke: async () => { throw new Error("bedrock exploded"); } } as unknown as BedrockClient;
    const r = await generateInsight(client, "m", fullPack());
    expect(r.status).toBe("error");
    expect(r.detail).toBe("bedrock exploded");
  });
});

// ── which periods a run writes ──────────────────────────────────────────────

describe("insightPeriodsFor", () => {
  // The instant the weekly cron would fire for the week of 31 Aug: Monday
  // 7 September, 00:30 UTC. Passed explicitly so these assertions do not
  // depend on when the suite happens to run.
  const CRON = Date.parse("2026-09-07T00:30:00Z");

  it("always writes the week just processed", () => {
    const out = insightPeriodsFor("2026-08-10", CRON);
    expect(out[0]).toMatchObject({ kind: "week", periodKey: "2026-08-10", weeks: ["2026-08-10"] });
    expect(out[0]!.previousWeeks).toEqual(["2026-08-03"]);
  });

  it("writes no month until one has closed", () => {
    // 10 Aug is followed by 17 Aug, still August. Writing the month here would
    // publish an "August" that had only reached the middle of itself, and the
    // next week's run would overwrite it with a different one.
    expect(insightPeriodsFor("2026-08-10", CRON).some((p) => p.kind === "month")).toBe(false);
  });

  it("writes the month on the last Monday of it", () => {
    // 31 Aug 2026 is a Monday and the next Monday is in September.
    const out = insightPeriodsFor("2026-08-31", Date.parse("2026-09-07T00:30:00Z"));
    const month = out.find((p) => p.kind === "month");
    expect(month).toBeDefined();
    expect(month!.periodKey).toBe("2026-08");
    expect(month!.periodLabel).toBe("August 2026");
    expect(month!.previousLabel).toBe("July 2026");
  });

  it("buckets a week by the month its Monday falls in, like the dashboard", () => {
    const month = insightPeriodsFor("2026-08-31", Date.parse("2026-09-07T00:30:00Z")).find((p) => p.kind === "month")!;
    expect(month.weeks).toEqual(["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"]);
    expect(month.previousWeeks).toEqual(["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"]);
  });
});

// ── the read API ────────────────────────────────────────────────────────────

describe("/api/insights", () => {
  const save = (kind: "week" | "month", key: string, status = "ok", narrative = "Something happened.") =>
    saveInsight(
      DB,
      { kind, periodKey: key, narrative, facts: [fact()], status: status as "ok", detail: null,
        inputTokens: 1, outputTokens: 2 },
      { weekStart: kind === "week" ? key : null, modelId: "m", generatedAt: "2026-08-11T00:00:00.000Z" },
    );

  it("answers with both kinds, newest first", async () => {
    await save("week", "2026-08-03");
    await save("week", "2026-08-10");
    await save("month", "2026-07");
    const res = await SELF.fetch("http://localhost/api/insights");
    expect(res.status).toBe(200);
    const d = (await res.json()) as { week: Array<{ periodKey: string }>; month: Array<{ periodKey: string }> };
    expect(d.week.map((x) => x.periodKey)).toEqual(["2026-08-10", "2026-08-03"]);
    expect(d.month.map((x) => x.periodKey)).toEqual(["2026-07"]);
  });

  it("does not let one kind crowd out the other", async () => {
    // Asking for six of each is not the same as the six most recent overall,
    // which on a weekly cron would be six weeks and no month at all.
    for (const w of ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10"]) {
      await save("week", w);
    }
    await save("month", "2026-07");
    const d = (await (await SELF.fetch("http://localhost/api/insights?limit=6")).json()) as
      { week: unknown[]; month: unknown[] };
    expect(d.week).toHaveLength(6);
    expect(d.month).toHaveLength(1);
  });

  it("returns a period it could not write, with the reason", async () => {
    await save("week", "2026-08-10", "ungrounded", "");
    const d = (await (await SELF.fetch("http://localhost/api/insights?kind=week")).json()) as
      { week: Array<{ status: string; narrative: string }> };
    expect(d.week[0]!.status).toBe("ungrounded");
    expect(d.week[0]!.narrative).toBe("");
  });

  it("hands back the facts the prose was written from", async () => {
    await save("week", "2026-08-10");
    const d = (await (await SELF.fetch("http://localhost/api/insights?kind=week")).json()) as
      { week: Array<{ facts: Array<{ id: string; value: number }> }> };
    expect(d.week[0]!.facts[0]).toMatchObject({ id: "F1", value: 1462 });
  });

  it("re-writing a period replaces it rather than adding a second", async () => {
    await save("week", "2026-08-10", "ok", "First.");
    await save("week", "2026-08-10", "ok", "Second.");
    const d = (await (await SELF.fetch("http://localhost/api/insights?kind=week")).json()) as
      { week: Array<{ narrative: string }> };
    expect(d.week).toHaveLength(1);
    expect(d.week[0]!.narrative).toBe("Second.");
  });

  it("rejects an unknown kind and a limit outside the cap", async () => {
    expect((await SELF.fetch("http://localhost/api/insights?kind=decade")).status).toBe(400);
    expect((await SELF.fetch("http://localhost/api/insights?limit=0")).status).toBe(400);
    expect((await SELF.fetch("http://localhost/api/insights?limit=13")).status).toBe(400);
  });

  it("rejects a non-GET method", async () => {
    expect((await SELF.fetch("http://localhost/api/insights", { method: "POST" })).status).toBe(405);
  });
});

// ── the summary card no longer depends on a GitHub write ────────────────────

describe("/api/narrative", () => {
  it("answers from the database when the archive never landed", async () => {
    await saveInsight(
      DB,
      { kind: "week", periodKey: "2026-08-10", narrative: "The week went like this.",
        facts: [], status: "ok", detail: null, inputTokens: 0, outputTokens: 0 },
      { weekStart: "2026-08-10", modelId: "m", generatedAt: "2026-08-11T00:00:00.000Z" },
    );
    const res = await SELF.fetch("http://localhost/api/narrative?week=2026-08-10");
    expect(res.status).toBe(200);
    const d = (await res.json()) as { narrative: string; source: string };
    expect(d.narrative).toBe("The week went like this.");
    expect(d.source).toBe("database");
  });

  it("does not serve a period whose insight could not be written", async () => {
    await saveInsight(
      DB,
      { kind: "week", periodKey: "2026-08-10", narrative: "", facts: [],
        status: "ungrounded", detail: "wrote a digit", inputTokens: 0, outputTokens: 0 },
      { weekStart: "2026-08-10", modelId: "m", generatedAt: "2026-08-11T00:00:00.000Z" },
    );
    const res = await SELF.fetch("http://localhost/api/narrative?week=2026-08-10");
    expect(res.status).not.toBe(200);
  });
});

// ── a deployment that shipped ahead of its migration ────────────────────────

/** What the migration built, as SQLite recorded it. */
async function schemaOf(): Promise<Array<{ name: string; sql: string }>> {
  const { results } = await DB.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE name IN ('hf_insights', 'idx_insights_recent') ORDER BY name`,
  ).all<{ name: string; sql: string }>();
  return results;
}

describe("the schema bootstrap", () => {
  it("rebuilds byte-for-byte what the migration built", async () => {
    // The one thing that makes a self-creating table safe: it cannot drift
    // from migrations/0006, because this test drops what the migration made,
    // rebuilds it from the constants in the code, and compares what SQLite
    // stored. If someone edits one and not the other, this fails.
    const fromMigration = await schemaOf();
    expect(fromMigration).toHaveLength(2);

    await DB.prepare("DROP TABLE hf_insights").run();
    expect(await schemaOf()).toHaveLength(0);

    await ensureInsightsSchema(DB);
    expect(await schemaOf()).toEqual(fromMigration);
  });

  it("is idempotent, so applying the migration afterwards is a clean no-op", async () => {
    // Both statements are IF NOT EXISTS. Without that, `wrangler d1 migrations
    // apply` on a database the Worker had already healed would fail with
    // "index idx_insights_recent already exists" — and the operator would be
    // told their migration is broken when it is not.
    await ensureInsightsSchema(DB);
    await ensureInsightsSchema(DB);
    await ensureInsightsSchema(DB);
    expect(await schemaOf()).toHaveLength(2);
  });

  it("only ever recognises its OWN table as missing", async () => {
    // A guard this narrow is the difference between healing a table this
    // feature owns and papering over a real database fault.
    expect(isMissingInsightsTable(new Error("D1_ERROR: no such table: hf_insights: SQLITE_ERROR"))).toBe(true);
    expect(isMissingInsightsTable(new Error("no such table: main.hf_insights"))).toBe(true);
    expect(isMissingInsightsTable(new Error("no such table: hf_spaces"))).toBe(false);
    expect(isMissingInsightsTable(new Error("no such column: hf_insights.narrative"))).toBe(false);
    expect(isMissingInsightsTable(new Error("D1_ERROR: database is locked"))).toBe(false);
  });

  it("does not swallow a real error behind a retry", async () => {
    let calls = 0;
    await expect(withInsightsSchema(DB, async () => {
      calls++;
      throw new Error("D1_ERROR: something else entirely");
    })).rejects.toThrow(/something else entirely/);
    expect(calls).toBe(1);
  });

  it("heals the read path: the tab works on the first request", async () => {
    await DB.prepare("DROP TABLE hf_insights").run();
    const res = await SELF.fetch("http://localhost/api/insights");
    expect(res.status).toBe(200);
    const d = (await res.json()) as { week: unknown[]; month: unknown[]; unavailable?: string };
    // No "not applied" message: it made the table and answered normally.
    expect(d.unavailable).toBeUndefined();
    expect(d.week).toEqual([]);
    expect(await schemaOf()).toHaveLength(2);
  });

  it("heals the write path: the pipeline can store an insight", async () => {
    await DB.prepare("DROP TABLE hf_insights").run();
    await saveInsight(
      DB,
      { kind: "week", periodKey: "2026-08-10", narrative: "It worked.", facts: [],
        status: "ok", detail: null, inputTokens: 0, outputTokens: 0 },
      { weekStart: "2026-08-10", modelId: "m", generatedAt: "2026-08-11T00:00:00.000Z" },
    );
    const row = await DB.prepare("SELECT narrative FROM hf_insights WHERE period_key = '2026-08-10'")
      .first<{ narrative: string }>();
    expect(row?.narrative).toBe("It worked.");
  });

  it("heals /api/narrative too, rather than falling through to GitHub forever", async () => {
    await DB.prepare("DROP TABLE hf_insights").run();
    await saveInsight(
      DB,
      { kind: "week", periodKey: "2026-08-10", narrative: "The week went like this.",
        facts: [], status: "ok", detail: null, inputTokens: 0, outputTokens: 0 },
      { weekStart: "2026-08-10", modelId: "m", generatedAt: "2026-08-11T00:00:00.000Z" },
    );
    const res = await SELF.fetch("http://localhost/api/narrative?week=2026-08-10");
    expect(res.status).toBe(200);
    expect((await res.json() as { source: string }).source).toBe("database");
  });
});

describe("a deployment where the table cannot be created at all", () => {
  it("answers with empty lists and says why, rather than a 500", async () => {
    // The lesson of /api/narrative, which spent weeks answering not_found for
    // every week on record while the card hid itself. An empty list with no
    // explanation is indistinguishable from a feature nobody has built.
    await DB.prepare("DROP TABLE hf_insights").run();
    // A view of the same name: CREATE TABLE IF NOT EXISTS will not replace it,
    // and every SELECT against it still fails. Stands in for a database the
    // Worker cannot write to.
    await DB.prepare("CREATE VIEW hf_insights AS SELECT 1 AS narrative WHERE 0").run();
    try {
      const res = await SELF.fetch("http://localhost/api/insights");
      expect(res.status).toBe(200);
      const d = (await res.json()) as { week: unknown[]; month: unknown[]; unavailable?: string };
      expect(d.week).toEqual([]);
      expect(d.month).toEqual([]);
      expect(d.unavailable).toBeTruthy();
    } finally {
      await DB.prepare("DROP VIEW IF EXISTS hf_insights").run();
      await DB.exec(
        "CREATE TABLE IF NOT EXISTS hf_insights (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('week','month')), period_key TEXT NOT NULL, week_start TEXT, taxonomy_version TEXT NOT NULL, narrative TEXT NOT NULL, facts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(facts)), status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','ungrounded','insufficient','error')), detail TEXT, model_id TEXT, prompt_version TEXT, input_tokens INTEGER, output_tokens INTEGER, generated_at TEXT NOT NULL, UNIQUE (kind, period_key, taxonomy_version)) STRICT",
      );
    }
  });

  it("is reported as degraded, and does NOT stop the weekly run", async () => {
    // The distinction that matters. A missing hf_models column breaks a write a
    // third of the way into a run and must stop it before it starts. A missing
    // hf_insights costs one paragraph — gating on it would have blocked
    // ingest, classification and aggregation, four hours of the only work that
    // matters, the first Monday after this shipped.
    const { missingColumns } = await import("../src/index");
    await DB.prepare("DROP TABLE hf_insights").run();
    try {
      const missing = await missingColumns(DB, [["hf_insights", "narrative"]]);
      expect(missing).toEqual(["hf_insights.narrative"]);

      const res = await SELF.fetch("http://localhost/api/admin/stats", {
        headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const d = (await res.json()) as { schema: { ok: boolean; missingColumns: string[]; degraded: string[] } };
      // Degraded, not missing: the gate stays green and CI raises a warning.
      expect(d.schema.degraded).toContain("hf_insights.narrative");
      expect(d.schema.missingColumns).not.toContain("hf_insights.narrative");
      expect(d.schema.ok).toBe(true);
    } finally {
      await DB.exec(
        "CREATE TABLE IF NOT EXISTS hf_insights (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('week','month')), period_key TEXT NOT NULL, week_start TEXT, taxonomy_version TEXT NOT NULL, narrative TEXT NOT NULL, facts TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(facts)), status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','ungrounded','insufficient','error')), detail TEXT, model_id TEXT, prompt_version TEXT, input_tokens INTEGER, output_tokens INTEGER, generated_at TEXT NOT NULL, UNIQUE (kind, period_key, taxonomy_version)) STRICT",
      );
    }
  });
});

// ── the repair endpoint ─────────────────────────────────────────────────────

describe("periodSpec", () => {
  it("gives a week its own Monday and the one before", () => {
    const s = periodSpec("week", "2026-08-10")!;
    expect(s.weeks).toEqual(["2026-08-10"]);
    expect(s.previousWeeks).toEqual(["2026-08-03"]);
    expect(s.periodLabel).toBe("the week of 10 Aug 2026");
  });

  it("refuses a date that is not a Monday", () => {
    // A week in this pipeline IS its Monday. Accepting a Wednesday would write
    // a row keyed by a date no metric is stored under.
    expect(periodSpec("week", "2026-08-11")).toBeNull();
    expect(periodSpec("week", "2026-08")).toBeNull();
    expect(periodSpec("week", "not-a-date")).toBeNull();
  });

  it("gives a month every Monday that belongs to it", () => {
    const s = periodSpec("month", "2026-08")!;
    expect(s.weeks).toEqual(["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"]);
    expect(s.previousWeeks).toEqual(["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"]);
    expect(s.periodLabel).toBe("August 2026");
    expect(s.previousLabel).toBe("July 2026");
  });

  it("crosses a year boundary correctly", () => {
    const s = periodSpec("month", "2026-01")!;
    expect(s.previousLabel).toBe("December 2025");
    expect(s.previousWeeks[0]!.startsWith("2025-12")).toBe(true);
  });

  it("refuses a malformed month", () => {
    expect(periodSpec("month", "2026-13")).toBeNull();
    expect(periodSpec("month", "2026")).toBeNull();
  });

  it("agrees with what the weekly run would write", () => {
    // One definition of "which weeks is August", shared by cron and by hand.
    // Two answers is how a repaired month disagrees with the month beside it.
    const fromRun = insightPeriodsFor("2026-08-31", Date.parse("2026-09-07T00:30:00Z")).find((p) => p.kind === "month")!;
    expect(fromRun).toEqual(periodSpec("month", "2026-08"));
  });
});

describe("POST /api/admin/insight", () => {
  const auth = { authorization: `Bearer ${env.ADMIN_TOKEN}` };
  const post = (q: string, headers: Record<string, string> = auth) =>
    SELF.fetch(`http://localhost/api/admin/insight?${q}`, { method: "POST", headers });

  it("refuses without the admin token", async () => {
    expect((await post("kind=week&period=2026-08-10", {})).status).toBe(401);
    expect((await post("kind=week&period=2026-08-10", { authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("refuses a GET, because it spends money and overwrites a row", async () => {
    const res = await SELF.fetch("http://localhost/api/admin/insight?kind=week&period=2026-08-10", {
      headers: auth,
    });
    expect(res.status).toBe(405);
  });

  it("rejects a bad kind or period before calling any model", async () => {
    expect((await post("kind=decade&period=2026")).status).toBe(400);
    expect((await post("kind=week")).status).toBe(400);
    expect((await post("kind=week&period=2026-08-11")).status).toBe(400);
    expect((await post("kind=month&period=2026-13")).status).toBe(400);
  });
});

// ── two defects a review bot found on #9, both real ─────────────────────────

describe("periodSpec refuses a date that does not exist", () => {
  it.each([
    ["2026-02-30", "30 February rolls forward to Monday 2 March"],
    ["2026-02-29", "2026 is not a leap year"],
    ["2026-11-31", "November has thirty days"],
  ])("rejects %s — %s", (key) => {
    // V8 rolls these forward rather than rejecting them, so the weekday test
    // alone passes and the row is stored under a key no calendar contains and
    // no metric exists for — visible in /api/insights for good.
    expect(periodSpec("week", key)).toBeNull();
  });

  it("still accepts a real Monday", () => {
    expect(periodSpec("week", "2026-08-10")?.periodKey).toBe("2026-08-10");
  });
});

describe("periodIsOpen", () => {
  // A month is not finished when its calendar ends: a week whose Monday is
  // 31 August belongs to August and runs into September.
  const AT = (iso: string) => Date.parse(iso);

  it("a week is open until seven days after its Monday", () => {
    expect(periodIsOpen("week", "2026-08-10", AT("2026-08-16T23:59:59Z"))).toBe(true);
    expect(periodIsOpen("week", "2026-08-10", AT("2026-08-17T00:00:00Z"))).toBe(false);
  });

  it("a month is open until its LAST WEEK ends, not when the calendar month does", () => {
    // August 2026's last Monday is the 31st; that week runs to 7 September.
    expect(mondaysOfMonth("2026-08").at(-1)).toBe("2026-08-31");
    expect(periodIsOpen("month", "2026-08", AT("2026-09-01T00:00:00Z"))).toBe(true);
    expect(periodIsOpen("month", "2026-08", AT("2026-09-06T23:59:59Z"))).toBe(true);
    expect(periodIsOpen("month", "2026-08", AT("2026-09-07T00:00:00Z"))).toBe(false);
  });

  it("agrees with the moment the weekly run would write that month", () => {
    // insightPeriodsFor writes 2026-08 when it processes the week of 31 Aug,
    // and that run happens on Monday 7 September. The two rules must not
    // disagree by so much as an hour, or a month is either written twice or
    // refused when cron would have allowed it.
    const writesMonth = insightPeriodsFor("2026-08-31", Date.parse("2026-09-07T00:30:00Z")).some((p) => p.kind === "month");
    expect(writesMonth).toBe(true);
    expect(periodIsOpen("month", "2026-08", AT("2026-09-07T00:30:00Z"))).toBe(false);
  });

  it("treats a malformed key as open, never as finished", () => {
    expect(periodIsOpen("month", "2026-13")).toBe(true);
    expect(periodIsOpen("week", "not-a-date")).toBe(true);
  });
});

describe("POST /api/admin/insight refuses a period still running", () => {
  const auth = { authorization: `Bearer ${env.ADMIN_TOKEN}` };
  const post = (q: string) =>
    SELF.fetch(`http://localhost/api/admin/insight?${q}`, { method: "POST", headers: auth });

  it("409s on the current week, and says which week it would take", async () => {
    const thisMonday = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
    const res = await post(`kind=week&period=${thisMonday}`);
    expect(res.status).toBe(409);
    const d = (await res.json()) as { error: string; detail: string; latestWritable: string };
    expect(d.error).toBe("period_not_finished");
    expect(d.detail).toMatch(/has not finished yet/);
    // Actionable: the 409 names a period that would be accepted.
    expect(d.latestWritable).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(periodIsOpen("week", d.latestWritable)).toBe(false);
  });

  it("409s on the current month", async () => {
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const res = await post(`kind=month&period=${thisMonth}`);
    expect(res.status).toBe(409);
    const d = (await res.json()) as { latestWritable: string };
    expect(d.latestWritable).toMatch(/^\d{4}-\d{2}$/);
    expect(periodIsOpen("month", d.latestWritable)).toBe(false);
  });

  it("rejects the rolled-over date before it reaches the model", async () => {
    expect((await post("kind=week&period=2026-02-30")).status).toBe(400);
  });
});


describe("the pipeline refuses an open period as well", () => {
  it("writes nothing for a week that has not finished", () => {
    // A run started by hand takes the CURRENT week when given no parameters.
    // Without this it would write a summary of a week two days old and present
    // it as the week's — the same defect the endpoint already refuses.
    expect(insightPeriodsFor("2026-08-10", Date.parse("2026-08-12T10:00:00Z"))).toEqual([]);
  });

  it("writes the week once it has closed", () => {
    const out = insightPeriodsFor("2026-08-10", Date.parse("2026-08-17T00:30:00Z"));
    expect(out.map((p) => p.kind)).toEqual(["week"]);
  });

  it("does not write a month whose last week is still running", () => {
    // 31 Aug is the last Monday of August and its week runs to 7 September.
    expect(insightPeriodsFor("2026-08-31", Date.parse("2026-09-02T00:30:00Z"))
      .some((p) => p.kind === "month")).toBe(false);
  });
});

describe("the original narrator is gated too", () => {
  it("buildSnapshot receives no prose for a week still running", async () => {
    // narrateWeek has none of the guards the insight path has — no grounding,
    // no coverage floor — and its output reaches the summary card through the
    // GitHub archive, because /api/narrative falls back to the snapshot when
    // D1 holds no insight. Gating one road and leaving the other open is not a
    // gate. Asserted through periodIsOpen, which is the test the run makes.
    expect(periodIsOpen("week", "2026-08-10", Date.parse("2026-08-12T10:00:00Z"))).toBe(true);
    expect(periodIsOpen("week", "2026-08-10", Date.parse("2026-08-17T00:30:00Z"))).toBe(false);
  });
});

describe("the open-period gate is pinned to one instant", () => {
  it("answers the same however long the run takes", () => {
    // A run takes hours. One that starts Sunday evening and reaches Phase 8
    // after midnight would see the week as closed on a Date.now() gate and
    // write prose about a week whose ingest happened while it was still open.
    const started = Date.parse("2026-08-16T20:00:00Z");   // Sunday, week still open
    const afterMidnight = Date.parse("2026-08-17T00:30:00Z"); // week has closed
    expect(periodIsOpen("week", "2026-08-10", started)).toBe(true);
    expect(periodIsOpen("week", "2026-08-10", afterMidnight)).toBe(false);
    // The run must use the first of those, so both gates agree with each other
    // and with themselves on every replay.
    expect(insightPeriodsFor("2026-08-10", started)).toEqual([]);
  });

  it("is a pure function of the instant it is given", () => {
    // Workflows replays the orchestration from the top at every step boundary.
    // A gate that reads the clock answers differently on different replays; one
    // that reads a number written down inside a step cannot.
    const at = Date.parse("2026-08-17T00:30:00Z");
    const a = insightPeriodsFor("2026-08-10", at);
    const b = insightPeriodsFor("2026-08-10", at);
    expect(a).toEqual(b);
    expect(a.map((p) => p.kind)).toEqual(["week"]);
  });
});


// ── comparing two periods classified to different depths ────────────────────

describe("a change needs both periods classified alike", () => {
  it("withholds the comparison, keeping the figure", async () => {
    // The real case this run would have hit: the week of 10 Aug is 100%
    // classified and the week of 3 Aug is 21.7%, because the LLM stage never
    // ran there. A ratio between them is arithmetic on two populations, and it
    // turns rises into falls — Agentic went 112 Spaces to 332 and read as down
    // 33.5% everywhere this was allowed.
    await seedWeek("2026-08-03", [["spaces_by_use_case", "coding", 50, 100, 21.7]]);
    await seedWeek("2026-08-10", [["spaces_by_use_case", "coding", 300, 300, 100]]);
    const pack = await buildFactPack(DB, weekPack("2026-08-10", "2026-08-03"));
    const coding = pack.facts.find((f) => f.what.includes("coding"))!;
    expect(coding.value).toBe(300);
    // The figure survives; the comparison does not.
    expect(coding.prev).toBeNull();
    expect(coding.changePct).toBeNull();
    expect(coding.changePts).toBeNull();
    expect(slotsOf(coding).change).toBeNull();
    expect(pack.omitted.join(" ")).toMatch(/ratio of the classifier/);
  });

  it("keeps the comparison when both periods were classified alike", async () => {
    await seedWeek("2026-08-03", [["spaces_by_use_case", "coding", 100, 200, 96]]);
    await seedWeek("2026-08-10", [["spaces_by_use_case", "coding", 150, 300, 99]]);
    const pack = await buildFactPack(DB, weekPack("2026-08-10", "2026-08-03"));
    const coding = pack.facts.find((f) => f.what.includes("coding"))!;
    expect(coding.prev).toBe(100);
    expect(coding.changePct).toBeCloseTo(50, 5);
  });

  it("does not withhold a figure that never depended on classification", async () => {
    // models_by_family comes from hf_models. A classifier that did not run has
    // no bearing on it, so its comparison must survive.
    await seedWeek("2026-08-03", [
      ["spaces_by_use_case", "coding", 50, 100, 21.7],
      ["models_by_family", "qwen", 2527, 2527, null],
    ]);
    await seedWeek("2026-08-10", [
      ["spaces_by_use_case", "coding", 300, 300, 100],
      ["models_by_family", "qwen", 3849, 3849, null],
    ]);
    const pack = await buildFactPack(DB, weekPack("2026-08-10", "2026-08-03"));
    const qwen = pack.facts.find((f) => f.what.includes("Qwen"))!;
    expect(qwen.prev).toBe(2527);
    expect(qwen.changePct).toBeCloseTo(52.3, 0);
  });

  it("the gap it allows is the gap it documents", () => {
    expect(MAX_COVERAGE_GAP).toBe(10);
  });
});


// ── the units the aggregator actually writes ────────────────────────────────

describe("coverage is read in the units the aggregator stores", () => {
  it("treats a fully classified week as 100%, not as 1%", async () => {
    // aggregate.ts stores classified/denominator — a RATIO. Every threshold in
    // this module is a percentage. Comparing them directly meant `coverage >=
    // 40` could never be true for a real pipeline row, so every
    // classification-derived fact was omitted from every pack and the one fact
    // that survived reported a 100% week as "1.0%". A whole suite passed
    // because its fixtures used the scale this module assumed.
    await seedWeek("2026-08-10", [
      ["sdk_distribution", "gradio", 5570, 5570, null],
      ["spaces_by_use_case", "coding", 5570, 5570, 100],
    ]);
    const pack = await buildFactPack(DB, weekPack("2026-08-10", "2026-08-03"));
    const cov = pack.facts[0]!;
    expect(cov.what).toMatch(/able to classify/);
    expect(cov.value).toBeCloseTo(100, 5);
    // And the classification facts are admitted, which is the whole point.
    expect(pack.facts.some((f) => f.what.includes("coding"))).toBe(true);
  });

  it("reads the real pipeline's own output", async () => {
    // Driven through aggregateWeeklyMetrics rather than hand-seeded, so the
    // scale cannot be assumed on either side.
    await DB.batch([
      DB.prepare(
        `INSERT INTO hf_spaces (space_id, author, created_at, last_modified, likes, title,
           sdk, tags, linked_models, linked_datasets, is_cluster_primary, first_seen_at, updated_at)
         VALUES ('a/one','a','2026-08-10T01:00:00.000Z','2026-08-10T01:00:00.000Z',0,'one','gradio','[]','[]','[]',1,'2026-08-10T01:00:00.000Z','2026-08-10T01:00:00.000Z')`),
      DB.prepare(
        `INSERT INTO hf_classifications (space_id, taxonomy_version, primary_use_case,
           verticals, model_families, technologies, source_kind, source_ref, classified_at)
         VALUES ('a/one', ?1, 'coding', '[]','[]','[]','rule','r1','2026-08-10T01:00:00.000Z')`,
      ).bind(TAXONOMY_VERSION),
    ]);
    await aggregateWeeklyMetrics(DB, "2026-08-10", "2026-08-17T00:00:00.000Z");

    const stored = await DB.prepare(
      `SELECT coverage FROM hf_weekly_metrics
        WHERE week_start='2026-08-10' AND metric_cut='spaces_by_use_case' LIMIT 1`,
    ).first<{ coverage: number }>();
    // This is the assertion that pins the contract between the two modules.
    expect(stored!.coverage).toBeLessThanOrEqual(1);

    const pack = await buildFactPack(DB, weekPack("2026-08-10", "2026-08-03"));
    expect(pack.facts[0]!.value).toBeCloseTo(100, 5);
  });

  it("pools a month by Spaces, not by how many use cases each week saw", async () => {
    // Every row of a week repeats that week's coverage, so an average over rows
    // weights a week by its number of dimensions. 100% of 100 Spaces and 20% of
    // 900 is 28%, not 60%.
    await seedWeek("2026-08-03", [
      ["sdk_distribution", "gradio", 100, 100, null],
      ["spaces_by_use_case", "coding", 100, 100, 100],
    ]);
    await seedWeek("2026-08-10", [
      ["sdk_distribution", "gradio", 900, 900, null],
      ["spaces_by_use_case", "coding", 90, 900, 20],
      ["spaces_by_use_case", "education", 45, 900, 20],
      ["spaces_by_use_case", "robotics", 45, 900, 20],
    ]);
    const pack = await buildFactPack(DB, {
      kind: "month", periodKey: "2026-08", periodLabel: "August 2026",
      previousLabel: "July 2026", weeks: ["2026-08-03", "2026-08-10"], previousWeeks: [],
    });
    expect(pack.facts[0]!.value).toBeCloseTo(28, 1);
  });

  it("does not let a week with nothing classified vanish from the average", async () => {
    // A week with no classifications writes no use-case rows, so it disappears
    // from an average taken over them — and a vanished zero flatters the month.
    await seedWeek("2026-08-03", [["sdk_distribution", "gradio", 1000, 1000, null]]);
    await seedWeek("2026-08-10", [
      ["sdk_distribution", "gradio", 1000, 1000, null],
      ["spaces_by_use_case", "coding", 1000, 1000, 100],
    ]);
    const pack = await buildFactPack(DB, {
      kind: "month", periodKey: "2026-08", periodLabel: "August 2026",
      previousLabel: "July 2026", weeks: ["2026-08-03", "2026-08-10"], previousWeeks: [],
    });
    expect(pack.facts[0]!.value).toBeCloseTo(50, 1);
  });

  it("refuses a comparison whose earlier period is itself below the floor", async () => {
    // A 5-point gap between 40% and 35% is a small gap between one figure this
    // module trusts and one it does not.
    await seedWeek("2026-08-03", [
      ["sdk_distribution", "gradio", 1000, 1000, null],
      ["spaces_by_use_case", "coding", 350, 1000, 35],
    ]);
    await seedWeek("2026-08-10", [
      ["sdk_distribution", "gradio", 1000, 1000, null],
      ["spaces_by_use_case", "coding", 400, 1000, 40],
    ]);
    const pack = await buildFactPack(DB, weekPack("2026-08-10", "2026-08-03"));
    const coding = pack.facts.find((f) => f.what.includes("coding"))!;
    expect(coding.value).toBe(400);
    expect(coding.prev).toBeNull();
  });
});
