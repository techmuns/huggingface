import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asD1, openSqliteD1, type SqliteD1 } from "../../src/lib/d1-sqlite";
import {
  type DrillPayload,
  type InsightsPayload,
  type SeriesPayload,
  buildSnapshot,
  mergeDrill,
  mergeInsights,
  mergeSeries,
  publishableWeeks,
} from "../../src/lib/publish";
import { applyMigrations } from "../../src/runner/migrate";
import { publishSnapshot } from "../../src/runner/publish-files";

/**
 * The dashboard reads files now, and a run writes them.
 *
 * The property under test throughout is the one that makes that safe: a run
 * publishes what its database knows and leaves everything else alone. It has
 * to hold, because the first run after this change starts from an EMPTY
 * database against a `public/data` holding every week the old D1 pipeline
 * ever produced — and a publisher that overwrote would take the dashboard's
 * whole history with it.
 */

const MIGRATIONS = new URL("../../migrations", import.meta.url).pathname;

const seriesOf = (
  weeks: string[],
  entries: Array<[string, string, (number | null)[]]>,
): SeriesPayload => ({
  taxonomyVersion: "1",
  weeks,
  series: entries.map(([cut, dimension, values]) => ({
    cut,
    dimension,
    subDimension: "",
    values,
    denominators: values.map((v) => (v === null ? null : 100)),
    suppressed: values.map(() => 0),
  })),
});

const valueAt = (payload: SeriesPayload, dimension: string, week: string): number | null => {
  const entry = payload.series.find((e) => e.dimension === dimension);
  const at = payload.weeks.indexOf(week);
  return entry && at >= 0 ? (entry.values[at] ?? null) : null;
};

describe("merging a series onto what was already published", () => {
  it("keeps weeks the new payload has never heard of", () => {
    const previous = seriesOf(["2026-07-27", "2026-08-03"], [["spaces_by_use_case", "coding", [10, 20]]]);
    const next = seriesOf(["2026-08-10"], [["spaces_by_use_case", "coding", [30]]]);

    const merged = mergeSeries(previous, next);

    expect(merged.weeks).toEqual(["2026-07-27", "2026-08-03", "2026-08-10"]);
    expect(valueAt(merged, "coding", "2026-07-27")).toBe(10);
    expect(valueAt(merged, "coding", "2026-08-03")).toBe(20);
    expect(valueAt(merged, "coding", "2026-08-10")).toBe(30);
  });

  it("lets a re-run correct a week rather than duplicate it", () => {
    const previous = seriesOf(["2026-08-03"], [["spaces_by_use_case", "coding", [10]]]);
    const next = seriesOf(["2026-08-03"], [["spaces_by_use_case", "coding", [99]]]);

    const merged = mergeSeries(previous, next);

    expect(merged.weeks).toEqual(["2026-08-03"]);
    expect(merged.series).toHaveLength(1);
    expect(valueAt(merged, "coding", "2026-08-03")).toBe(99);
  });

  it("keeps a gap a gap: a week with no row stays null, not zero", () => {
    // The distinction the dashboard draws: a null is a week that was never
    // computed, and a 0 is a week that was computed and scored nothing. If
    // merging turned one into the other the page would draw a line through a
    // hole in the data.
    const previous = seriesOf(["2026-07-27", "2026-08-03"], [["sdk_distribution", "gradio", [5, null]]]);
    const next = seriesOf(["2026-08-10"], [["sdk_distribution", "gradio", [0]]]);

    const merged = mergeSeries(previous, next);

    expect(valueAt(merged, "gradio", "2026-08-03")).toBeNull();
    expect(valueAt(merged, "gradio", "2026-08-10")).toBe(0);
  });

  it("does not confuse two series whose dimension contains the separator", () => {
    // Dimensions are model families and SDK names, straight from the Hub.
    const previous: SeriesPayload = {
      taxonomyVersion: "1",
      weeks: ["2026-08-03"],
      series: [
        { cut: "models_by_family", dimension: "a b", subDimension: "c", values: [1], denominators: [1], suppressed: [0] },
        { cut: "models_by_family", dimension: "a", subDimension: "b c", values: [2], denominators: [1], suppressed: [0] },
      ],
    };

    const merged = mergeSeries(previous, seriesOf([], []));

    expect(merged.series).toHaveLength(2);
    expect(merged.series.map((e) => e.values[0]).sort()).toEqual([1, 2]);
  });

  it("trims from the old end, so the cap never drops the newest week", () => {
    const weeks = ["2026-07-27", "2026-08-03", "2026-08-10"];
    const previous = seriesOf(weeks, [["spaces_by_use_case", "coding", [1, 2, 3]]]);

    const merged = mergeSeries(previous, seriesOf([], []), 2);

    expect(merged.weeks).toEqual(["2026-08-03", "2026-08-10"]);
  });
});

describe("merging the drill-down lists", () => {
  const week = (total: number): DrillPayload["weeks"][string] => ({
    total,
    withTraction: total,
    likes: total * 2,
    spaces: [],
  });

  it("keeps weeks the new payload does not cover", () => {
    const previous: DrillPayload = { useCase: "coding", limit: 50, weeks: { "2026-07-27": week(5) } };
    const next: DrillPayload = { useCase: "coding", limit: 50, weeks: { "2026-08-10": week(9) } };

    const merged = mergeDrill(previous, next);

    expect(Object.keys(merged.weeks)).toEqual(["2026-07-27", "2026-08-10"]);
    expect(merged.weeks["2026-07-27"]!.total).toBe(5);
  });

  /**
   * The claim the whole per-week layout rests on.
   *
   * The card wants the top N across a set of weeks. Storing per-week top-N
   * lists answers that exactly, because a Space outside its own week's top N
   * is behind N Spaces that are all in the union too — so it cannot be in the
   * union's top N. This checks the claim against a brute-force answer rather
   * than restating it.
   */
  it("re-ranking per-week lists gives the same top N as ranking everything", () => {
    const all: Array<{ spaceId: string; likes: number; week: string }> = [];
    for (let i = 0; i < 200; i++) {
      all.push({
        spaceId: `s${i}`,
        // Deterministic and deliberately lumpy, so the biggest are not spread
        // evenly across the weeks.
        likes: (i * 37) % 91,
        week: ["2026-07-27", "2026-08-03", "2026-08-10"][i % 3]!,
      });
    }

    const rank = (rows: typeof all) =>
      [...rows].sort((a, b) => b.likes - a.likes || a.spaceId.localeCompare(b.spaceId));

    const perWeek = new Map<string, typeof all>();
    for (const row of all) {
      const list = perWeek.get(row.week) ?? [];
      list.push(row);
      perWeek.set(row.week, list);
    }
    const stored = [...perWeek.values()].flatMap((rows) => rank(rows).slice(0, 20));

    expect(rank(stored).slice(0, 20).map((r) => r.spaceId)).toEqual(
      rank(all).slice(0, 20).map((r) => r.spaceId),
    );
  });
});

describe("merging insights", () => {
  const entry = (periodKey: string, narrative: string): InsightsPayload["week"][number] => ({
    kind: "week",
    periodKey,
    weekStart: periodKey,
    narrative,
    status: "ok",
    detail: null,
    facts: [],
    model: "m",
    promptVersion: "1",
    generatedAt: "2026-08-20T00:00:00.000Z",
  });

  it("keeps one entry per period, newest first, and lets a re-run replace one", () => {
    const previous: InsightsPayload = {
      taxonomyVersion: "1",
      week: [entry("2026-08-03", "old"), entry("2026-07-27", "older")],
      month: [],
    };
    const next: InsightsPayload = {
      taxonomyVersion: "1",
      week: [entry("2026-08-10", "new"), entry("2026-08-03", "corrected")],
      month: [],
    };

    const merged = mergeInsights(previous, next);

    expect(merged.week.map((e) => e.periodKey)).toEqual(["2026-08-10", "2026-08-03", "2026-07-27"]);
    expect(merged.week[1]!.narrative).toBe("corrected");
  });
});

describe("publishing a snapshot from a database", () => {
  let db: SqliteD1;
  let root: string;

  const insertSpace = (id: string, createdAt: string, likes: number) =>
    db.handle
      .prepare(
        `INSERT INTO hf_spaces (space_id, author, created_at, likes, title, sdk,
                                is_cluster_primary, first_seen_at, updated_at)
         VALUES (?, 'a', ?, ?, ?, 'gradio', 1, ?, ?)`,
      )
      .run(id, createdAt, likes, id, createdAt, createdAt);

  const classify = (id: string, useCase: string) =>
    db.handle
      .prepare(
        `INSERT INTO hf_classifications (space_id, taxonomy_version, primary_use_case,
                                         low_confidence, source_kind, source_ref, classified_at)
         VALUES (?, '1', ?, 0, 'rule', 'r', '2026-08-20T00:00:00.000Z')`,
      )
      .run(id, useCase);

  const metric = (week: string, dimension: string, value: number) =>
    db.handle
      .prepare(
        `INSERT INTO hf_weekly_metrics (week_start, metric_cut, dimension, value,
                                        denominator, suppressed, taxonomy_version, computed_at)
         VALUES (?, 'spaces_by_use_case', ?, ?, 100, 0, '1', '2026-08-20T00:00:00.000Z')`,
      )
      .run(week, dimension, value);

  beforeEach(() => {
    db = openSqliteD1(":memory:");
    applyMigrations(db, MIGRATIONS);
    root = mkdtempSync(join(tmpdir(), "publish-"));
  });


  it("writes the files the dashboard asks for", async () => {
    insertSpace("a/one", "2026-08-12T10:00:00.000Z", 7);
    classify("a/one", "coding");
    metric("2026-08-10", "coding", 1);

    const result = await publishSnapshot(asD1(db), root, "2026-08-20T00:00:00.000Z");

    expect(result.weeks).toEqual(["2026-08-10"]);
    for (const path of ["series.json", "series-matrix.json", "insights.json", "index.json",
                        "coverage/2026-08-10.json", "use-case-spaces/coding.json"]) {
      expect(result.written).toContain(path);
    }

    const coverage = JSON.parse(readFileSync(join(root, "coverage/2026-08-10.json"), "utf8"));
    expect(coverage).toMatchObject({ weekStart: "2026-08-10", totalSpaces: 1, classifiedSpaces: 1 });

    const drill = JSON.parse(readFileSync(join(root, "use-case-spaces/coding.json"), "utf8"));
    expect(drill.weeks["2026-08-10"].total).toBe(1);
    expect(drill.weeks["2026-08-10"].spaces[0].spaceId).toBe("a/one");
  });

  /**
   * The first run, exactly as it will happen: a database holding one week,
   * published over files holding several. Nothing but that week may move.
   */
  it("an empty database does not erase what is already published", async () => {
    insertSpace("a/old", "2026-08-05T10:00:00.000Z", 2);
    classify("a/old", "coding");
    metric("2026-08-03", "coding", 4);
    await publishSnapshot(asD1(db), root, "2026-08-20T00:00:00.000Z");

    const before = readFileSync(join(root, "coverage/2026-08-03.json"), "utf8");

    const fresh = openSqliteD1(":memory:");
    applyMigrations(fresh, MIGRATIONS);
    const result = await publishSnapshot(asD1(fresh), root, "2026-08-27T00:00:00.000Z");
    fresh.close();

    expect(readFileSync(join(root, "coverage/2026-08-03.json"), "utf8")).toBe(before);

    const series: SeriesPayload = JSON.parse(readFileSync(join(root, "series.json"), "utf8"));
    expect(series.weeks).toEqual(["2026-08-03"]);
    expect(valueAt(series, "coding", "2026-08-03")).toBe(4);

    const drill: DrillPayload = JSON.parse(readFileSync(join(root, "use-case-spaces/coding.json"), "utf8"));
    expect(drill.weeks["2026-08-03"]!.total).toBe(1);

    // And the index still advertises the week whose files are still there.
    const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
    expect(index.weeks).toContain("2026-08-03");
    expect(result.written).toContain("index.json");
  });

  it("a second run adds its week to the first run's", async () => {
    insertSpace("a/old", "2026-08-05T10:00:00.000Z", 2);
    classify("a/old", "coding");
    metric("2026-08-03", "coding", 4);
    await publishSnapshot(asD1(db), root, "2026-08-20T00:00:00.000Z");

    insertSpace("a/new", "2026-08-12T10:00:00.000Z", 9);
    classify("a/new", "coding");
    metric("2026-08-10", "coding", 6);
    await publishSnapshot(asD1(db), root, "2026-08-27T00:00:00.000Z");

    const series: SeriesPayload = JSON.parse(readFileSync(join(root, "series.json"), "utf8"));
    expect(series.weeks).toEqual(["2026-08-03", "2026-08-10"]);
    expect(valueAt(series, "coding", "2026-08-03")).toBe(4);
    expect(valueAt(series, "coding", "2026-08-10")).toBe(6);

    const drill: DrillPayload = JSON.parse(readFileSync(join(root, "use-case-spaces/coding.json"), "utf8"));
    expect(Object.keys(drill.weeks)).toEqual(["2026-08-03", "2026-08-10"]);
  });

  /**
   * Run #2, exactly as it happened.
   *
   * Asked for week 2026-08-17. Its ingest window also caught 11 Spaces
   * belonging to 2026-08-10 — a week already published as 5,572 Spaces at
   * 99.96% coverage — and the publisher rewrote that week as 11 Spaces at 0%.
   * The drill lists for it went to zero at the same time.
   */
  it("does not overwrite a complete week with a partial view of it", async () => {
    // The complete week, as an earlier run published it.
    for (let i = 0; i < 30; i++) {
      insertSpace(`a/old-${i}`, "2026-08-12T10:00:00.000Z", i);
      classify(`a/old-${i}`, "coding");
    }
    metric("2026-08-10", "coding", 30);
    await publishSnapshot(asD1(db), root, "2026-08-17T00:00:00.000Z");

    const complete = readFileSync(join(root, "coverage/2026-08-10.json"), "utf8");
    const completeDrill = readFileSync(join(root, "use-case-spaces/coding.json"), "utf8");

    // A later run, from a database that holds only the tail of that week plus
    // the week it was actually asked for.
    const partial = openSqliteD1(":memory:");
    applyMigrations(partial, MIGRATIONS);
    const p = (sql: string, ...args: (string | number)[]) => partial.handle.prepare(sql).run(...args);
    p(`INSERT INTO hf_spaces (space_id, author, created_at, likes, title, sdk,
                              is_cluster_primary, first_seen_at, updated_at)
       VALUES ('a/old-0','a','2026-08-12T10:00:00.000Z',0,'t','gradio',1,'x','x')`);
    p(`INSERT INTO hf_spaces (space_id, author, created_at, likes, title, sdk,
                              is_cluster_primary, first_seen_at, updated_at)
       VALUES ('a/new','a','2026-08-19T10:00:00.000Z',5,'t','gradio',1,'x','x')`);
    p(`INSERT INTO hf_classifications (space_id, taxonomy_version, primary_use_case,
                                       low_confidence, source_kind, source_ref, classified_at)
       VALUES ('a/new','1','coding',0,'rule','r','x')`);
    // Both weeks aggregated — which is how the week leaked through the first
    // guard: the aggregate step wrote rows for it from those few Spaces.
    for (const [week, value] of [["2026-08-10", 1], ["2026-08-17", 1]] as const) {
      p(`INSERT INTO hf_weekly_metrics (week_start, metric_cut, dimension, value,
                                        denominator, suppressed, taxonomy_version, computed_at)
         VALUES (?, 'spaces_by_use_case', 'coding', ?, 100, 0, '1', 'x')`, week, value);
    }

    await publishSnapshot(asD1(partial), root, "2026-08-24T00:00:00.000Z");
    partial.close();

    // The complete week is exactly as it was.
    expect(readFileSync(join(root, "coverage/2026-08-10.json"), "utf8")).toBe(complete);

    const drill: DrillPayload = JSON.parse(readFileSync(join(root, "use-case-spaces/coding.json"), "utf8"));
    expect(drill.weeks["2026-08-10"]).toEqual(
      (JSON.parse(completeDrill) as DrillPayload).weeks["2026-08-10"],
    );
    // And the week it really did process is published.
    expect(drill.weeks["2026-08-17"]!.total).toBe(1);
  });

  /**
   * The other half of the rule, and the one a count test alone gets wrong.
   *
   * Run #2 published week 2026-08-17 as 5,842 Spaces at 100% coverage against
   * 6,613 at 33.6% from the old pipeline. Fewer Spaces, a far better answer —
   * the count fell to deduplication and to Spaces that no longer exist. A week
   * the run was asked for wins in either direction.
   */
  it("lets the run's own week win even when its count goes down", async () => {
    for (let i = 0; i < 20; i++) {
      insertSpace(`a/s-${i}`, "2026-08-12T10:00:00.000Z", i);
      classify(`a/s-${i}`, "coding");
    }
    metric("2026-08-10", "coding", 20);
    await publishSnapshot(asD1(db), root, "2026-08-17T00:00:00.000Z", ["2026-08-10"]);
    expect(
      JSON.parse(readFileSync(join(root, "coverage/2026-08-10.json"), "utf8")).totalSpaces,
    ).toBe(20);

    // The same week re-run after deduplication removed half of them.
    for (let i = 0; i < 10; i++) {
      db.handle.prepare("UPDATE hf_spaces SET is_cluster_primary = 0 WHERE space_id = ?").run(`a/s-${i}`);
    }

    await publishSnapshot(asD1(db), root, "2026-08-24T00:00:00.000Z", ["2026-08-10"]);
    expect(
      JSON.parse(readFileSync(join(root, "coverage/2026-08-10.json"), "utf8")).totalSpaces,
    ).toBe(10);

    // But without that claim, the same shrink is refused.
    for (let i = 10; i < 20; i++) {
      db.handle.prepare("UPDATE hf_spaces SET is_cluster_primary = 0 WHERE space_id = ?").run(`a/s-${i}`);
    }
    await publishSnapshot(asD1(db), root, "2026-08-31T00:00:00.000Z");
    expect(
      JSON.parse(readFileSync(join(root, "coverage/2026-08-10.json"), "utf8")).totalSpaces,
    ).toBe(10);
  });

  it("still lets a more complete run correct a week", async () => {
    insertSpace("a/one", "2026-08-12T10:00:00.000Z", 1);
    metric("2026-08-10", "coding", 1);
    await publishSnapshot(asD1(db), root, "2026-08-17T00:00:00.000Z");
    expect(
      JSON.parse(readFileSync(join(root, "coverage/2026-08-10.json"), "utf8")).totalSpaces,
    ).toBe(1);

    // The same week, re-run, now holding all of it.
    for (let i = 0; i < 10; i++) insertSpace(`a/more-${i}`, "2026-08-12T11:00:00.000Z", i);
    await publishSnapshot(asD1(db), root, "2026-08-24T00:00:00.000Z");

    expect(
      JSON.parse(readFileSync(join(root, "coverage/2026-08-10.json"), "utf8")).totalSpaces,
    ).toBe(11);
  });

  it("speaks only for weeks it aggregated, not weeks it merely has a Space from", async () => {
    insertSpace("a/edge", "2026-08-12T10:00:00.000Z", 1); // week 2026-08-10
    insertSpace("a/target", "2026-08-19T10:00:00.000Z", 1); // week 2026-08-17
    metric("2026-08-17", "coding", 1); // only this one was aggregated

    expect(await publishableWeeks(asD1(db))).toEqual(["2026-08-17"]);
  });

  it("publishes a narrative file only for a week that has one", async () => {
    insertSpace("a/one", "2026-08-12T10:00:00.000Z", 1);
    db.handle
      .prepare(
        `INSERT INTO hf_insights (kind, period_key, week_start, taxonomy_version,
                                  narrative, status, generated_at)
         VALUES ('week', '2026-08-10', '2026-08-10', '1', 'A good week.', 'ok', '2026-08-20T00:00:00.000Z'),
                ('week', '2026-08-03', '2026-08-03', '1', '', 'error', '2026-08-20T00:00:00.000Z')`,
      )
      .run();

    const result = await publishSnapshot(asD1(db), root, "2026-08-20T00:00:00.000Z");

    expect(result.written).toContain("narrative/2026-08-10.json");
    expect(result.written).not.toContain("narrative/2026-08-03.json");
    const narrative = JSON.parse(readFileSync(join(root, "narrative/2026-08-10.json"), "utf8"));
    expect(narrative.narrative).toBe("A good week.");
  });

  it("survives a database with no insights table", async () => {
    db.exec("DROP TABLE hf_insights");
    insertSpace("a/one", "2026-08-12T10:00:00.000Z", 1);

    const files = await buildSnapshot(asD1(db), { generatedAt: "2026-08-20T00:00:00.000Z" });
    const insights = files.find((f) => f.path === "insights.json")!.value as InsightsPayload;

    expect(insights.week).toEqual([]);
    expect(insights.month).toEqual([]);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
