/**
 * Turns the database into the files the dashboard reads.
 *
 * The page used to ask a Worker, and the Worker used to ask D1, once per
 * visitor. Every figure on it changes once a week, so that was a live query
 * against a row-metered database to answer a question whose answer was already
 * fixed. Now the run writes the answers down and the page fetches files.
 *
 * The shapes below are the shapes those endpoints returned, unchanged. That is
 * deliberate and it is the whole reason the switch is cheap: the dashboard's
 * parsing, its null-versus-zero handling, its suppression flags and its
 * denominators all keep working, and the diff on the page is the URLs.
 *
 * MERGING, AND WHY IT IS NOT OPTIONAL. A snapshot is not a full history. The
 * SQLite database starts empty and each run ingests one week, so a publisher
 * that simply overwrote would erase every earlier week the moment it ran. So
 * nothing here overwrites a week it has no data for: weeks are merged, and a
 * week the database has never heard of survives untouched.
 */

import { TAXONOMY_VERSION, USE_CASES } from "./taxonomy";

/** Three years. The dashboard cannot select further back than this. */
export const MAX_SERIES_WEEKS = 156;

/**
 * Rows kept per use case per week for the drill-down card.
 *
 * The card asks for the top 20 across an arbitrary set of weeks, and the top
 * 20 of a union is always drawn from the per-week top 20s — a Space beaten by
 * 20 others in its own week cannot lead the union. So per-week lists answer
 * any window exactly, provided each list is at least as long as the largest
 * limit anyone asks for. 50 was the old endpoint's ceiling; keeping it means
 * the guarantee holds even if the card's limit is raised later.
 */
export const DRILL_LIMIT = 50;

/** Where the dashboard looks. Also the directory the runner writes. */
export const DATA_DIR = "public/data";

export interface SnapshotFile {
  /** Relative to DATA_DIR, forward slashes. */
  path: string;
  value: unknown;
}

// ── the payload shapes, as the endpoints returned them ──────────────────

export interface SeriesEntry {
  cut: string;
  dimension: string;
  subDimension: string;
  values: (number | null)[];
  denominators: (number | null)[];
  suppressed: number[];
}

export interface SeriesPayload {
  taxonomyVersion: string;
  weeks: string[];
  series: SeriesEntry[];
}

export interface CoveragePayload {
  weekStart: string;
  totalSpaces: number;
  classifiedSpaces: number;
  coveragePercent: number | null;
  bySource: { rule: number; model: number };
  llmModel: string | null;
  lowConfidence: number;
}

export interface DrillSpace {
  spaceId: string;
  title: string | null;
  author: string | null;
  likes: number;
  createdAt: string;
  sdk: string | null;
  description: string | null;
  lowConfidence: boolean;
}

export interface DrillWeek {
  total: number;
  withTraction: number;
  likes: number;
  spaces: DrillSpace[];
}

export interface DrillPayload {
  useCase: string;
  limit: number;
  weeks: Record<string, DrillWeek>;
}

export interface InsightEntry {
  kind: string;
  /** The findings. Empty for a period summarised before cards existed. */
  cards: unknown[];
  periodKey: string;
  weekStart: string | null;
  narrative: string;
  status: string;
  detail: string | null;
  facts: unknown;
  model: string | null;
  promptVersion: string | null;
  generatedAt: string;
}

export interface InsightsPayload {
  taxonomyVersion: string;
  week: InsightEntry[];
  month: InsightEntry[];
}

/**
 * Which classifier measured each week, and how much of it.
 *
 * A week is a mix, not a single value: a week partly re-classified after a fix
 * carries both versions, and that is exactly the case a reader must not compare
 * across silently. `unknown` is every row written before the column existed.
 */
export interface ClassifierPayload {
  taxonomyVersion: string;
  /** week -> version (or "unknown") -> classified Spaces */
  weeks: Record<string, Record<string, number>>;
}

export interface IndexPayload {
  taxonomyVersion: string;
  weeks: string[];
  useCases: string[];
  drillLimit: number;
  generatedAt: string;
}

// ── merging ────────────────────────────────────────────────────────────

interface FlatCell {
  value: number;
  denominator: number | null;
  suppressed: number;
}

/**
 * Key separator. A NUL rather than anything printable: dimensions are model
 * families and Space SDKs, which are strings from the Hub, and a separator
 * they could contain would silently split one series into two.
 */
const SEP = "\u0000";

/**
 * A series payload as a flat map, so two of them can be combined without
 * either one's week ordering mattering.
 *
 * Nulls are dropped rather than stored. In this payload a null is "no row for
 * this week", which is not the same as zero and must not become one — the
 * dashboard draws a gap for the first and a point on the axis for the second.
 * Dropping them here and refilling on the way out preserves that exactly.
 */
function flatten(payload: SeriesPayload | null): Map<string, FlatCell> {
  const out = new Map<string, FlatCell>();
  if (!payload) return out;

  for (const entry of payload.series) {
    for (let i = 0; i < payload.weeks.length; i++) {
      const value = entry.values[i];
      if (value === null || value === undefined) continue;
      const key = [entry.cut, entry.dimension, entry.subDimension, payload.weeks[i]].join(SEP);
      out.set(key, {
        value,
        denominator: entry.denominators[i] ?? null,
        suppressed: entry.suppressed[i] ?? 0,
      });
    }
  }
  return out;
}

/**
 * Overlays a freshly-computed series onto whatever was published before.
 *
 * `next` wins wherever the two describe the same cell, which is what makes a
 * re-run of an already-published week a correction rather than a duplicate.
 * Everything `next` is silent about is carried forward.
 */
export function mergeSeries(
  previous: SeriesPayload | null,
  next: SeriesPayload,
  maxWeeks: number = MAX_SERIES_WEEKS,
): SeriesPayload {
  const cells = flatten(previous);
  for (const [key, cell] of flatten(next)) cells.set(key, cell);

  const weekSet = new Set<string>();
  for (const key of cells.keys()) weekSet.add(key.slice(key.lastIndexOf(SEP) + 1));

  // Ascending, and trimmed from the old end: a line is drawn left to right,
  // and the cap exists to bound the file, not to drop the newest week.
  const weeks = [...weekSet].sort().slice(-maxWeeks);
  const at = new Map(weeks.map((w, i) => [w, i]));

  const series = new Map<string, SeriesEntry>();
  for (const [key, cell] of cells) {
    const [cut, dimension, subDimension, week] = key.split(SEP) as [string, string, string, string];

    const index = at.get(week);
    if (index === undefined) continue; // trimmed by the cap

    const id = [cut, dimension, subDimension].join(SEP);
    let entry = series.get(id);
    if (!entry) {
      entry = {
        cut,
        dimension,
        subDimension,
        values: new Array<number | null>(weeks.length).fill(null),
        denominators: new Array<number | null>(weeks.length).fill(null),
        suppressed: new Array<number>(weeks.length).fill(0),
      };
      series.set(id, entry);
    }
    entry.values[index] = cell.value;
    entry.denominators[index] = cell.denominator;
    entry.suppressed[index] = cell.suppressed;
  }

  // Sorted so the file is stable between runs and its diff is only the data
  // that actually moved.
  const ordered = [...series.values()].sort(
    (a, b) =>
      a.cut.localeCompare(b.cut) ||
      a.dimension.localeCompare(b.dimension) ||
      a.subDimension.localeCompare(b.subDimension),
  );

  return { taxonomyVersion: next.taxonomyVersion, weeks, series: ordered };
}

/** Weeks a run knows about replace; weeks it does not are carried forward. */
export function mergeClassifier(
  previous: ClassifierPayload | null,
  next: ClassifierPayload,
): ClassifierPayload {
  const weeks: Record<string, Record<string, number>> = { ...(previous?.weeks ?? {}) };
  for (const [week, mix] of Object.entries(next.weeks)) weeks[week] = mix;
  const ordered: Record<string, Record<string, number>> = {};
  for (const week of Object.keys(weeks).sort()) ordered[week] = weeks[week]!;
  return { taxonomyVersion: next.taxonomyVersion, weeks: ordered };
}

/** Same rule, one use case at a time: new weeks win, old weeks survive. */
export function mergeDrill(previous: DrillPayload | null, next: DrillPayload): DrillPayload {
  const weeks: Record<string, DrillWeek> = { ...(previous?.weeks ?? {}) };
  for (const [week, data] of Object.entries(next.weeks)) weeks[week] = data;

  const ordered: Record<string, DrillWeek> = {};
  for (const week of Object.keys(weeks).sort()) ordered[week] = weeks[week]!;

  return { useCase: next.useCase, limit: next.limit, weeks: ordered };
}

/** Newest periods first, one entry per period, capped. */
export function mergeInsights(
  previous: InsightsPayload | null,
  next: InsightsPayload,
  limit = 12,
): InsightsPayload {
  const pick = (kind: "week" | "month"): InsightEntry[] => {
    const byPeriod = new Map<string, InsightEntry>();
    for (const entry of previous?.[kind] ?? []) byPeriod.set(entry.periodKey, entry);
    for (const entry of next[kind]) byPeriod.set(entry.periodKey, entry);
    return [...byPeriod.values()]
      .sort((a, b) => b.periodKey.localeCompare(a.periodKey))
      .slice(0, limit);
  };
  return { taxonomyVersion: next.taxonomyVersion, week: pick("week"), month: pick("month") };
}

// ── reading the database ───────────────────────────────────────────────

interface SeriesRow {
  week_start: string;
  metric_cut: string;
  dimension: string;
  sub_dimension: string | null;
  value: number;
  denominator: number;
  suppressed: number;
}

const MATRIX_CUT = "family_share_by_use_case";

async function readSeries(db: D1Database, matrix: boolean): Promise<SeriesPayload> {
  const rows = await db
    .prepare(
      `SELECT week_start, metric_cut, dimension, sub_dimension, value, denominator, suppressed
         FROM hf_weekly_metrics
        WHERE taxonomy_version = ?1
          AND ((?2 = 1 AND metric_cut = '${MATRIX_CUT}')
            OR (?2 = 0 AND metric_cut <> '${MATRIX_CUT}'))
        ORDER BY week_start ASC`,
    )
    .bind(TAXONOMY_VERSION, matrix ? 1 : 0)
    .all<SeriesRow>();

  const results = rows.results ?? [];
  const weeks = [...new Set(results.map((r) => r.week_start))].sort();
  const at = new Map(weeks.map((w, i) => [w, i]));
  const series = new Map<string, SeriesEntry>();

  for (const r of results) {
    const index = at.get(r.week_start);
    if (index === undefined) continue;
    const sub = r.sub_dimension ?? "";
    const id = [r.metric_cut, r.dimension, sub].join(SEP);
    let entry = series.get(id);
    if (!entry) {
      entry = {
        cut: r.metric_cut,
        dimension: r.dimension,
        subDimension: sub,
        values: new Array<number | null>(weeks.length).fill(null),
        denominators: new Array<number | null>(weeks.length).fill(null),
        suppressed: new Array<number>(weeks.length).fill(0),
      };
      series.set(id, entry);
    }
    entry.values[index] = r.value;
    entry.denominators[index] = r.denominator;
    entry.suppressed[index] = r.suppressed ? 1 : 0;
  }

  return { taxonomyVersion: TAXONOMY_VERSION, weeks, series: [...series.values()] };
}

/**
 * The weeks this database can speak for.
 *
 * Weeks it AGGREGATED, not weeks it has a Space from. The difference is the
 * whole guard, and getting it wrong cost real data: run #2 ingested week
 * 2026-08-17 and, at the edge of its window, picked up 11 Spaces belonging to
 * 2026-08-10. The old rule here was "any week with at least one Space", so it
 * republished 2026-08-10 — a week that was complete at 5,572 Spaces and 99.96%
 * coverage — as 11 Spaces and 0%.
 *
 * hf_weekly_metrics is written only by the aggregate step, and the aggregate
 * step runs only for the week the run was asked to process. So a row here
 * means "this run computed this week", which is exactly the claim a per-week
 * file makes. It is also why series.json survived that run untouched: it was
 * already built from this table.
 *
 * The caller applies a second guard on top — see publishSnapshot — because a
 * week can be aggregated from a partial ingest too.
 */
export async function publishableWeeks(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT week_start FROM hf_weekly_metrics
        WHERE taxonomy_version = ?1
        ORDER BY week_start`,
    )
    .bind(TAXONOMY_VERSION)
    .all<{ week_start: string }>();

  return (rows.results ?? []).map((r) => r.week_start);
}

/**
 * The classifier mix for one week.
 *
 * Same join and same bounds as readCoverage, so the two files always describe
 * the same population — a version breakdown that did not add up to the
 * classified count would be worse than none.
 */
async function readClassifierMix(
  db: D1Database,
  weekStart: string,
): Promise<Record<string, number>> {
  const weekEnd = new Date(
    new Date(`${weekStart}T00:00:00.000Z`).getTime() + 7 * 86_400_000,
  ).toISOString();

  const rows = await db
    .prepare(
      `SELECT COALESCE(c.classifier_version, 'unknown') AS v, COUNT(*) AS cnt
         FROM hf_classifications c
         JOIN hf_spaces s ON s.space_id = c.space_id
        WHERE c.taxonomy_version = ?1
          AND s.created_at >= ?2 AND s.created_at < ?3
          AND s.is_cluster_primary = 1
        GROUP BY v`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .all<{ v: string; cnt: number }>();

  const out: Record<string, number> = {};
  for (const r of rows.results ?? []) out[r.v] = r.cnt;
  return out;
}

async function readCoverage(db: D1Database, weekStart: string): Promise<CoveragePayload | null> {
  const weekEnd = new Date(
    new Date(`${weekStart}T00:00:00.000Z`).getTime() + 7 * 86_400_000,
  ).toISOString();

  const total = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM hf_spaces
        WHERE created_at >= ?1 AND created_at < ?2 AND is_cluster_primary = 1`,
    )
    .bind(weekStart, weekEnd)
    .first<{ cnt: number }>();

  // Nothing ingested for this week in this database. Say so by returning
  // null, so the caller leaves the published file alone.
  if (!total?.cnt) return null;

  const classified = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM hf_spaces s
         JOIN hf_classifications c ON c.space_id = s.space_id AND c.taxonomy_version = ?1
        WHERE s.created_at >= ?2 AND s.created_at < ?3
          AND s.is_cluster_primary = 1`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .first<{ cnt: number }>();

  const bySource = await db
    .prepare(
      `SELECT c.source_kind AS kind, COUNT(*) AS cnt
         FROM hf_classifications c
         JOIN hf_spaces s ON s.space_id = c.space_id
        WHERE c.taxonomy_version = ?1
          AND s.created_at >= ?2 AND s.created_at < ?3
          AND s.is_cluster_primary = 1
        GROUP BY c.source_kind`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .all<{ kind: string; cnt: number }>();

  const lowConfidence = await db
    .prepare(
      `SELECT COUNT(*) AS cnt
         FROM hf_classifications c
         JOIN hf_spaces s ON s.space_id = c.space_id
        WHERE c.taxonomy_version = ?1 AND c.low_confidence = 1
          AND s.created_at >= ?2 AND s.created_at < ?3
          AND s.is_cluster_primary = 1`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .first<{ cnt: number }>();

  const llmModel = await db
    .prepare(
      `SELECT c.source_ref AS ref, COUNT(*) AS cnt
         FROM hf_classifications c
         JOIN hf_spaces s ON s.space_id = c.space_id
        WHERE c.taxonomy_version = ?1 AND c.source_kind = 'model'
          AND s.created_at >= ?2 AND s.created_at < ?3
          AND s.is_cluster_primary = 1
        GROUP BY c.source_ref
        ORDER BY cnt DESC
        LIMIT 1`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .first<{ ref: string | null; cnt: number }>();

  const counts = new Map((bySource.results ?? []).map((r) => [r.kind, r.cnt]));
  const totalCount = total.cnt;
  const classifiedCount = classified?.cnt ?? 0;

  return {
    weekStart,
    totalSpaces: totalCount,
    classifiedSpaces: classifiedCount,
    coveragePercent: totalCount > 0 ? (classifiedCount / totalCount) * 100 : null,
    bySource: { rule: counts.get("rule") ?? 0, model: counts.get("model") ?? 0 },
    llmModel: llmModel?.ref ?? null,
    lowConfidence: lowConfidence?.cnt ?? 0,
  };
}

async function readDrillWeek(
  db: D1Database,
  useCase: string,
  weekStart: string,
): Promise<DrillWeek> {
  const weekEnd = new Date(
    new Date(`${weekStart}T00:00:00.000Z`).getTime() + 7 * 86_400_000,
  ).toISOString();
  const fromIso = `${weekStart}T00:00:00.000Z`;

  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN s.likes > 0 THEN 1 ELSE 0 END) AS with_traction,
              SUM(s.likes) AS likes
         FROM hf_classifications c
         JOIN hf_spaces s ON s.space_id = c.space_id
        WHERE c.taxonomy_version = ?1 AND c.primary_use_case = ?2
          AND s.created_at >= ?3 AND s.created_at < ?4
          AND s.is_cluster_primary = 1`,
    )
    .bind(TAXONOMY_VERSION, useCase, fromIso, weekEnd)
    .first<{ total: number; with_traction: number | null; likes: number | null }>();

  // Ordered so idx_spaces_traction can be walked rather than sorted; space_id
  // last so the order is total and two runs of the same week agree.
  const rows = await db
    .prepare(
      `SELECT s.space_id, s.title, s.author, s.likes, s.created_at, s.sdk,
              s.short_description, c.low_confidence
         FROM hf_classifications c
         JOIN hf_spaces s ON s.space_id = c.space_id
        WHERE c.taxonomy_version = ?1 AND c.primary_use_case = ?2
          AND s.created_at >= ?3 AND s.created_at < ?4
          AND s.is_cluster_primary = 1 AND s.likes > 0
        ORDER BY s.likes DESC, s.created_at DESC, s.space_id
        LIMIT ?5`,
    )
    .bind(TAXONOMY_VERSION, useCase, fromIso, weekEnd, DRILL_LIMIT)
    .all<{
      space_id: string;
      title: string | null;
      author: string | null;
      likes: number;
      created_at: string;
      sdk: string | null;
      short_description: string | null;
      low_confidence: number;
    }>();

  return {
    total: counts?.total ?? 0,
    withTraction: counts?.with_traction ?? 0,
    likes: counts?.likes ?? 0,
    spaces: (rows.results ?? []).map((r) => ({
      spaceId: r.space_id,
      title: r.title,
      author: r.author,
      likes: r.likes,
      createdAt: r.created_at,
      sdk: r.sdk,
      description: r.short_description,
      lowConfidence: r.low_confidence === 1,
    })),
  };
}

async function readInsights(db: D1Database, limit: number): Promise<InsightsPayload> {
  const out: InsightsPayload = { taxonomyVersion: TAXONOMY_VERSION, week: [], month: [] };

  for (const kind of ["week", "month"] as const) {
    let rows;
    try {
      rows = await db
        .prepare(
          `SELECT kind, period_key, week_start, narrative, facts, cards, status, detail,
                  model_id, prompt_version, generated_at
             FROM hf_insights
            WHERE kind = ?1 AND taxonomy_version = ?2
            ORDER BY period_key DESC
            LIMIT ?3`,
        )
        .bind(kind, TAXONOMY_VERSION, limit)
        .all<{
          kind: string; period_key: string; week_start: string | null;
          narrative: string; facts: string; cards: string | null;
          status: string; detail: string | null;
          model_id: string | null; prompt_version: string | null; generated_at: string;
        }>();
    } catch {
      // The table is created by migration 0006 and by the insights stage. A
      // database without it has no insights to publish, which is a fact about
      // the data and not a reason to fail a run that otherwise succeeded.
      continue;
    }

    out[kind] = (rows.results ?? []).map((r) => ({
      kind: r.kind,
      periodKey: r.period_key,
      weekStart: r.week_start,
      narrative: r.narrative,
      status: r.status,
      detail: r.detail,
      facts: safeParse(r.facts),
      cards: Array.isArray(safeParse(r.cards ?? "[]")) ? (safeParse(r.cards ?? "[]") as unknown[]) : [],
      model: r.model_id,
      promptVersion: r.prompt_version,
      generatedAt: r.generated_at,
    }));
  }

  return out;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

// ── the snapshot ───────────────────────────────────────────────────────

export interface SnapshotOptions {
  /** Stamped into index.json. Passed in so a snapshot is reproducible. */
  generatedAt: string;
  insightsLimit?: number;
}

/**
 * Every file the dashboard reads, built from one database.
 *
 * Returned rather than written: the caller owns the filesystem, and returning
 * them makes the whole of this module testable against an in-memory database
 * with no temporary directory anywhere.
 *
 * Narratives are not here. They are a field of the insights rows, and the
 * dashboard reads them from `narrative/<week>.json`, which is written by the
 * caller from the insights payload — see `narrativeFiles`.
 */
export async function buildSnapshot(
  db: D1Database,
  options: SnapshotOptions,
): Promise<SnapshotFile[]> {
  const weeks = await publishableWeeks(db);
  const files: SnapshotFile[] = [];

  files.push({ path: "series.json", value: await readSeries(db, false) });
  files.push({ path: "series-matrix.json", value: await readSeries(db, true) });

  for (const week of weeks) {
    const coverage = await readCoverage(db, week);
    if (coverage) files.push({ path: `coverage/${week}.json`, value: coverage });
  }

  for (const useCase of USE_CASES) {
    const byWeek: Record<string, DrillWeek> = {};
    for (const week of weeks) byWeek[week] = await readDrillWeek(db, useCase, week);
    files.push({
      path: `use-case-spaces/${useCase}.json`,
      value: { useCase, limit: DRILL_LIMIT, weeks: byWeek } satisfies DrillPayload,
    });
  }

  const mix: Record<string, Record<string, number>> = {};
  for (const week of weeks) {
    const m = await readClassifierMix(db, week);
    if (Object.keys(m).length > 0) mix[week] = m;
  }
  files.push({
    path: "classifier.json",
    value: { taxonomyVersion: TAXONOMY_VERSION, weeks: mix } satisfies ClassifierPayload,
  });

  const insights = await readInsights(db, options.insightsLimit ?? 12);
  files.push({ path: "insights.json", value: insights });
  files.push(...narrativeFiles(insights));

  files.push({
    path: "index.json",
    value: {
      taxonomyVersion: TAXONOMY_VERSION,
      weeks,
      useCases: [...USE_CASES],
      drillLimit: DRILL_LIMIT,
      generatedAt: options.generatedAt,
    } satisfies IndexPayload,
  });

  return files;
}

/**
 * The weekly narrative, split out per week.
 *
 * The dashboard asks for one week at a time and hides the card when there is
 * nothing, so a file per week keeps the request small and keeps "no narrative
 * yet" as a 404 — which is exactly what the page already handles.
 */
export function narrativeFiles(insights: InsightsPayload): SnapshotFile[] {
  return insights.week
    .filter((e) => e.status === "ok" && e.weekStart && e.narrative)
    .map((e) => ({
      path: `narrative/${e.weekStart}.json`,
      value: { weekStart: e.weekStart, narrative: e.narrative, source: "snapshot" },
    }));
}
