import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Invariants of the files the dashboard actually reads.
 *
 * Every other test here checks the code that writes these files. This one
 * checks the files, because the fault that prompted it was in neither the
 * aggregate query nor the merge in isolation — it was what a correct query and
 * a nearly-correct merge left on disk between them.
 *
 * 2026-08-17 was seeded from the old pipeline with 56 document-AI Spaces and
 * later recomputed with 165. The merge overlaid cell by cell, so every family
 * the second run emitted was corrected and the one it did not emit was not:
 * `kimi-moonshot` kept a share of 1/56 in a group where every other share was
 * out of 165, and the page showed 1.79% where the truth was 0.61%. Nothing
 * failed. The numbers were individually plausible and collectively impossible,
 * and only their sum said so — 101.79%.
 *
 * So the sum is what is asserted.
 */

const DATA = new URL("../../public/data", import.meta.url).pathname;
const read = <T>(rel: string): T => JSON.parse(readFileSync(join(DATA, rel), "utf8")) as T;

interface Entry {
  cut: string;
  dimension: string;
  subDimension: string;
  values: (number | null)[];
  denominators: (number | null)[];
  suppressed: number[];
}
interface Series {
  taxonomyVersion: string;
  weeks: string[];
  series: Entry[];
}

const series = read<Series>("series.json");
const matrix = read<Series>("series-matrix.json");
const index = read<{ weeks: string[]; useCases: string[] }>("index.json");

const rowsOf = (payload: Series, cut: string) => payload.series.filter((e) => e.cut === cut);

describe("the published series", () => {
  it("gives every row one value per week", () => {
    for (const payload of [series, matrix]) {
      for (const entry of payload.series) {
        expect(entry.values, `${entry.cut}/${entry.dimension}`).toHaveLength(payload.weeks.length);
        expect(entry.denominators).toHaveLength(payload.weeks.length);
        expect(entry.suppressed).toHaveLength(payload.weeks.length);
      }
    }
  });

  it("agrees with the index on which weeks exist", () => {
    expect(series.weeks).toEqual(index.weeks);
    expect(matrix.weeks).toEqual(series.weeks);
    expect([...series.weeks].sort()).toEqual(series.weeks);
  });

  it("counts whole Spaces, never a fraction or a negative", () => {
    for (const cut of ["spaces_by_use_case", "models_by_family", "sdk_distribution"]) {
      for (const entry of rowsOf(series, cut)) {
        for (const v of entry.values) {
          if (v === null) continue;
          expect(Number.isInteger(v), `${cut}/${entry.dimension} = ${v}`).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("keeps every share between 0 and 100", () => {
    const percent = ["share_by_use_case", "vertical_penetration", "technology_penetration"];
    for (const cut of percent) {
      for (const entry of rowsOf(series, cut)) {
        for (const v of entry.values) {
          if (v === null) continue;
          expect(v, `${cut}/${entry.dimension}`).toBeGreaterThanOrEqual(0);
          expect(v, `${cut}/${entry.dimension}`).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  /**
   * The one that would have caught it.
   *
   * Every cell of a cut for one week is computed against the same base, so a
   * cell quoting a different denominator than its neighbours is a cell from a
   * different run of that week — the exact residue a cell-by-cell merge leaves
   * when a re-run stops producing a row.
   */
  it("computes every cell of a cut and week against one denominator", () => {
    const check = (payload: Series, groupBy: (e: Entry) => string) => {
      const groups = new Map<string, Map<number, Set<number>>>();
      for (const entry of payload.series) {
        const key = groupBy(entry);
        const perWeek = groups.get(key) ?? new Map<number, Set<number>>();
        groups.set(key, perWeek);
        entry.values.forEach((v, i) => {
          if (v === null) return;
          const den = entry.denominators[i];
          if (den === null || den === undefined) return;
          const set = perWeek.get(i) ?? new Set<number>();
          perWeek.set(i, set);
          set.add(den);
        });
      }
      for (const [key, perWeek] of groups) {
        for (const [i, dens] of perWeek) {
          expect([...dens], `${key} @ ${payload.weeks[i]}`).toHaveLength(1);
        }
      }
    };

    // Every cut in series.json shares one base across its dimensions —
    // except `engagement`, which is the one cut that spans two populations:
    // downloads and likes are per model repo, Space likes are per Space. Its
    // rows are levels rather than parts of a whole, so they are grouped by
    // dimension and each simply has to be consistent with itself.
    check(series, (e) => (e.cut === "engagement" ? `${e.cut}/${e.dimension}` : e.cut));
    // The matrix is one base per use case: families are counted inside it.
    check(matrix, (e) => `${e.cut}/${e.dimension}`);
  });

  it("makes the family shares of a use case add up to that use case", () => {
    for (const [i, week] of matrix.weeks.entries()) {
      const totals = new Map<string, number>();
      for (const entry of matrix.series) {
        const v = entry.values[i];
        if (v === null || v === undefined) continue;
        totals.set(entry.dimension, (totals.get(entry.dimension) ?? 0) + v);
      }
      for (const [useCase, total] of totals) {
        expect(total, `${useCase} @ ${week}`).toBeCloseTo(100, 1);
      }
    }
  });

  it("makes the use-case shares add up to the use-case counts", () => {
    const counts = rowsOf(series, "spaces_by_use_case");
    const shares = new Map(rowsOf(series, "share_by_use_case").map((e) => [e.dimension, e]));
    expect(new Set(counts.map((e) => e.dimension))).toEqual(new Set(shares.keys()));

    for (const [i, week] of series.weeks.entries()) {
      const total = counts.reduce((sum, e) => sum + (e.values[i] ?? 0), 0);
      if (!total) continue;
      for (const entry of counts) {
        const count = entry.values[i];
        const share = shares.get(entry.dimension)?.values[i];
        if (count === null || count === undefined) continue;
        if (share === null || share === undefined) continue;
        expect(share, `${entry.dimension} @ ${week}`).toBeCloseTo((count / total) * 100, 3);
      }
    }
  });
});

describe("the published drill-down lists", () => {
  const files = readdirSync(join(DATA, "use-case-spaces")).filter((f) => f.endsWith(".json"));
  const counts = new Map(rowsOf(series, "spaces_by_use_case").map((e) => [e.dimension, e]));

  it("has one file per use case, and no file for anything else", () => {
    expect(new Set(files.map((f) => f.replace(/\.json$/, "")))).toEqual(new Set(counts.keys()));
  });

  it("counts the same Spaces the use-case cut counts", () => {
    for (const file of files) {
      const drill = read<{
        useCase: string;
        limit: number;
        weeks: Record<string, { total: number; withTraction: number; spaces: unknown[] }>;
      }>(join("use-case-spaces", file));

      for (const [week, entry] of Object.entries(drill.weeks)) {
        const at = series.weeks.indexOf(week);
        if (at < 0) {
          // A week the rest of the dataset has retracted. Harmless only while
          // it is empty — drillForWeeks reads the weeks it is asked for, not
          // the weeks the file has — but it must not carry figures.
          expect(entry.total, `${file} @ ${week}`).toBe(0);
          expect(entry.spaces).toHaveLength(0);
          continue;
        }
        expect(entry.total, `${file} @ ${week}`).toBe(counts.get(drill.useCase)?.values[at]);
        expect(entry.withTraction).toBeLessThanOrEqual(entry.total);
        expect(entry.spaces.length).toBeLessThanOrEqual(drill.limit);
      }
    }
  });

  /**
   * A Space filed under the wrong week is the mapping error with no signature
   * in any total: every count still adds up, and the list is simply about a
   * different week than its heading says.
   */
  it("files every Space in the week it was created in", () => {
    for (const file of files) {
      const drill = read<{
        weeks: Record<string, { spaces: { spaceId: string; createdAt: string }[] }>;
      }>(join("use-case-spaces", file));

      for (const [week, entry] of Object.entries(drill.weeks)) {
        const start = new Date(`${week}T00:00:00Z`);
        expect(start.getUTCDay(), `${week} is not a Monday`).toBe(1);
        const end = new Date(start.getTime() + 7 * 86_400_000);
        for (const space of entry.spaces) {
          const made = new Date(space.createdAt);
          expect(made.getTime(), `${space.spaceId} in ${week}`).toBeGreaterThanOrEqual(start.getTime());
          expect(made.getTime(), `${space.spaceId} in ${week}`).toBeLessThan(end.getTime());
        }
      }
    }
  });
});

describe("the published insights", () => {
  const insights = read<{
    week: {
      periodKey: string;
      facts: { id: string; value: number; cut: string | null; dimension: string | null }[];
      cards: {
        id: string;
        heroFact: string;
        facts: string[];
        spark: { cut: string; dimension: string | null } | null;
      }[];
    }[];
  }>("insights.json");

  const rowAt = (cut: string, dimension: string | null) =>
    series.series.find((e) => e.cut === cut && (dimension === null || e.dimension === dimension));

  it("quotes a figure the series can be read back to", () => {
    for (const entry of insights.week) {
      const at = series.weeks.indexOf(entry.periodKey);
      if (at < 0) continue;
      for (const fact of entry.facts) {
        if (!fact.cut || !fact.dimension) continue;
        const row = rowAt(fact.cut, fact.dimension);
        expect(row, `${fact.id} -> ${fact.cut}/${fact.dimension}`).toBeDefined();
        const value = row?.values[at];
        if (value === null || value === undefined) continue;
        expect(value, `${fact.id}`).toBeCloseTo(fact.value, 3);
      }
    }
  });

  /**
   * A card shows one figure and draws one line. If they came from different
   * rows the card would be a caption over somebody else's chart, and nothing
   * on the page would say so.
   */
  it("draws each card's line from the same row as its figure", () => {
    for (const entry of insights.week) {
      const byId = new Map(entry.facts.map((f) => [f.id, f]));
      for (const card of entry.cards ?? []) {
        const hero = byId.get(card.heroFact);
        expect(hero, `${card.id} heroFact ${card.heroFact}`).toBeDefined();
        for (const id of card.facts) expect(byId.has(id), `${card.id} cites ${id}`).toBe(true);
        if (!card.spark || !hero) continue;
        expect(card.spark.cut, `${card.id}`).toBe(hero.cut);
        expect(card.spark.dimension ?? null, `${card.id}`).toBe(hero.dimension ?? null);
        expect(rowAt(card.spark.cut, card.spark.dimension), `${card.id} spark`).toBeDefined();
      }
    }
  });
});

describe("the published coverage", () => {
  it("agrees with the use-case counts on how many Spaces were classified", () => {
    const counts = rowsOf(series, "spaces_by_use_case");
    for (const [i, week] of series.weeks.entries()) {
      const cov = read<{ totalSpaces: number; classifiedSpaces: number }>(
        join("coverage", `${week}.json`),
      );
      const summed = counts.reduce((sum, e) => sum + (e.values[i] ?? 0), 0);
      expect(summed, `classified @ ${week}`).toBe(cov.classifiedSpaces);
      expect(cov.classifiedSpaces).toBeLessThanOrEqual(cov.totalSpaces);
    }
  });
});
