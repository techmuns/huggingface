import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MIN_COVERAGE,
  MIN_DENOMINATOR,
  MIN_FACTS,
  buildFactPack,
  generateInsight,
  ground,
  renderPack,
  saveInsight,
  slotsOf,
  type Fact,
} from "../src/lib/insights";
import { insightPeriodsFor } from "../src/workflow";
import { TAXONOMY_VERSION } from "../src/lib/taxonomy";
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
    ).bind(week, cut, dim, value, den, cov, TAXONOMY_VERSION)));
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
    await seedWeek("2026-08-03", [["technology_penetration", "rag", 10, 100, 90]]);
    await seedWeek("2026-08-10", [["technology_penetration", "rag", 50, 900, 90]]);
    await seedWeek("2026-08-03", [["spaces_by_use_case", "coding", 50, 100, 90]]);
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
  it("always writes the week just processed", () => {
    const out = insightPeriodsFor("2026-08-10");
    expect(out[0]).toMatchObject({ kind: "week", periodKey: "2026-08-10", weeks: ["2026-08-10"] });
    expect(out[0]!.previousWeeks).toEqual(["2026-08-03"]);
  });

  it("writes no month until one has closed", () => {
    // 10 Aug is followed by 17 Aug, still August. Writing the month here would
    // publish an "August" that had only reached the middle of itself, and the
    // next week's run would overwrite it with a different one.
    expect(insightPeriodsFor("2026-08-10").some((p) => p.kind === "month")).toBe(false);
  });

  it("writes the month on the last Monday of it", () => {
    // 31 Aug 2026 is a Monday and the next Monday is in September.
    const out = insightPeriodsFor("2026-08-31");
    const month = out.find((p) => p.kind === "month");
    expect(month).toBeDefined();
    expect(month!.periodKey).toBe("2026-08");
    expect(month!.periodLabel).toBe("August 2026");
    expect(month!.previousLabel).toBe("July 2026");
  });

  it("buckets a week by the month its Monday falls in, like the dashboard", () => {
    const month = insightPeriodsFor("2026-08-31").find((p) => p.kind === "month")!;
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
