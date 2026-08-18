/**
 * Phase 7 — Aggregate into the eight weekly outputs.
 *
 * Every row is written with its denominator and coverage so the API and page
 * can render "312 Spaces (of 4,410 classifiable, 65% coverage)" rather than
 * a bare number.
 *
 * Precomputed because D1 is single-threaded and these are multi-dimensional
 * group-bys that must not run per page load.
 */

import { TAXONOMY_VERSION } from "./taxonomy";

export interface AggregateSummary {
  metricsWritten: number;
}

const UPSERT_METRIC = `
  INSERT INTO hf_weekly_metrics (
    week_start, metric_cut, dimension, sub_dimension,
    value, denominator, coverage,
    delta_1w, delta_4w, delta_12w,
    suppressed, taxonomy_version, computed_at
  ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, datetime('now'))
  ON CONFLICT(week_start, metric_cut, dimension, sub_dimension, taxonomy_version) DO UPDATE SET
    value = excluded.value,
    denominator = excluded.denominator,
    coverage = excluded.coverage,
    delta_1w = excluded.delta_1w,
    delta_4w = excluded.delta_4w,
    delta_12w = excluded.delta_12w,
    suppressed = excluded.suppressed,
    computed_at = excluded.computed_at
`;

const MIN_DENOMINATOR = 10;

interface MetricRow {
  weekStart: string;
  cut: string;
  dimension: string;
  subDimension: string;
  value: number;
  denominator: number;
  coverage: number | null;
  delta1w: number | null;
  delta4w: number | null;
  delta12w: number | null;
}

function suppress(row: MetricRow): MetricRow & { suppressed: number } {
  const suppressed = row.denominator < MIN_DENOMINATOR ? 1 : 0;
  return {
    ...row,
    delta1w: suppressed ? null : row.delta1w,
    delta4w: suppressed ? null : row.delta4w,
    delta12w: suppressed ? null : row.delta12w,
    suppressed,
  };
}

async function batchUpsert(db: D1Database, rows: MetricRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const stmts = rows.map((r) => {
    const s = suppress(r);
    return db
      .prepare(UPSERT_METRIC)
      .bind(
        s.weekStart, s.cut, s.dimension, s.subDimension,
        s.value, s.denominator, s.coverage,
        s.delta1w, s.delta4w, s.delta12w,
        s.suppressed, TAXONOMY_VERSION,
      );
  });

  const BATCH = 100;
  let total = 0;
  for (let i = 0; i < stmts.length; i += BATCH) {
    const results = await db.batch(stmts.slice(i, i + BATCH));
    total += results.reduce((s, r) => s + (r.meta?.changes ?? 0), 0);
  }
  return total;
}

// ── 1. New Spaces by primary use case ───────────────────────────────────────

async function newSpacesByUseCase(
  db: D1Database,
  weekStart: string,
  weekEnd: string,
): Promise<MetricRow[]> {
  const rows = await db
    .prepare(
      `SELECT c.primary_use_case AS dim, COUNT(*) AS cnt
       FROM hf_spaces s
       JOIN hf_classifications c ON c.space_id = s.space_id AND c.taxonomy_version = ?1
       WHERE s.created_at >= ?2 AND s.created_at < ?3
         AND s.is_cluster_primary = 1
       GROUP BY c.primary_use_case`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .all<{ dim: string; cnt: number }>();

  const total = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM hf_spaces
       WHERE created_at >= ?1 AND created_at < ?2 AND is_cluster_primary = 1`,
    )
    .bind(weekStart, weekEnd)
    .first<{ cnt: number }>();

  const denominator = total?.cnt ?? 0;
  const classified = rows.results?.reduce((s, r) => s + r.cnt, 0) ?? 0;
  const coverage = denominator > 0 ? classified / denominator : null;

  return (rows.results ?? []).map((r) => ({
    weekStart,
    cut: "spaces_by_use_case",
    dimension: r.dim,
    subDimension: "",
    value: r.cnt,
    denominator,
    coverage,
    delta1w: null,
    delta4w: null,
    delta12w: null,
  }));
}

// ── 2. Share of new Spaces by use case (%) ──────────────────────────────────

async function shareByUseCase(
  db: D1Database,
  weekStart: string,
  weekEnd: string,
): Promise<MetricRow[]> {
  const rows = await db
    .prepare(
      `SELECT c.primary_use_case AS dim, COUNT(*) AS cnt
       FROM hf_spaces s
       JOIN hf_classifications c ON c.space_id = s.space_id AND c.taxonomy_version = ?1
       WHERE s.created_at >= ?2 AND s.created_at < ?3
         AND s.is_cluster_primary = 1
       GROUP BY c.primary_use_case`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .all<{ dim: string; cnt: number }>();

  const classified = rows.results?.reduce((s, r) => s + r.cnt, 0) ?? 0;

  return (rows.results ?? []).map((r) => ({
    weekStart,
    cut: "share_by_use_case",
    dimension: r.dim,
    subDimension: "",
    value: classified > 0 ? (r.cnt / classified) * 100 : 0,
    denominator: classified,
    coverage: null,
    delta1w: null,
    delta4w: null,
    delta12w: null,
  }));
}

// ── 3. Breakdown by vertical (penetration) ──────────────────────────────────

async function breakdownByVertical(
  db: D1Database,
  weekStart: string,
  weekEnd: string,
): Promise<MetricRow[]> {
  const rows = await db
    .prepare(
      `SELECT jv.value AS dim, COUNT(DISTINCT s.space_id) AS cnt
       FROM hf_spaces s
       JOIN hf_classifications c ON c.space_id = s.space_id AND c.taxonomy_version = ?1
       JOIN json_each(c.verticals) jv
       WHERE s.created_at >= ?2 AND s.created_at < ?3
         AND s.is_cluster_primary = 1
       GROUP BY jv.value`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .all<{ dim: string; cnt: number }>();

  const total = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM hf_spaces s
       JOIN hf_classifications c ON c.space_id = s.space_id AND c.taxonomy_version = ?1
       WHERE s.created_at >= ?2 AND s.created_at < ?3
         AND s.is_cluster_primary = 1`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .first<{ cnt: number }>();

  const denominator = total?.cnt ?? 0;

  return (rows.results ?? []).map((r) => ({
    weekStart,
    cut: "vertical_penetration",
    dimension: r.dim,
    subDimension: "",
    value: denominator > 0 ? (r.cnt / denominator) * 100 : 0,
    denominator,
    coverage: null,
    delta1w: null,
    delta4w: null,
    delta12w: null,
  }));
}

// ── 4. Model-family share within each use case ──────────────────────────────

async function familyShareByUseCase(
  db: D1Database,
  weekStart: string,
  weekEnd: string,
): Promise<MetricRow[]> {
  const rows = await db
    .prepare(
      `SELECT c.primary_use_case AS usecase, jf.value AS family,
              COUNT(DISTINCT s.space_id) AS cnt
       FROM hf_spaces s
       JOIN hf_classifications c ON c.space_id = s.space_id AND c.taxonomy_version = ?1
       JOIN json_each(c.model_families) jf
       WHERE s.created_at >= ?2 AND s.created_at < ?3
         AND s.is_cluster_primary = 1
       GROUP BY c.primary_use_case, jf.value`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .all<{ usecase: string; family: string; cnt: number }>();

  const usecaseTotals = new Map<string, number>();
  for (const r of rows.results ?? []) {
    usecaseTotals.set(r.usecase, (usecaseTotals.get(r.usecase) ?? 0) + r.cnt);
  }

  return (rows.results ?? []).map((r) => {
    const total = usecaseTotals.get(r.usecase) ?? 0;
    return {
      weekStart,
      cut: "family_share_by_use_case",
      dimension: r.usecase,
      subDimension: r.family,
      value: total > 0 ? (r.cnt / total) * 100 : 0,
      denominator: total,
      coverage: null,
      delta1w: null,
      delta4w: null,
      delta12w: null,
    };
  });
}

// ── 5. Technology penetration ───────────────────────────────────────────────

async function technologyPenetration(
  db: D1Database,
  weekStart: string,
  weekEnd: string,
): Promise<MetricRow[]> {
  const rows = await db
    .prepare(
      `SELECT jt.value AS dim, COUNT(DISTINCT s.space_id) AS cnt
       FROM hf_spaces s
       JOIN hf_classifications c ON c.space_id = s.space_id AND c.taxonomy_version = ?1
       JOIN json_each(c.technologies) jt
       WHERE s.created_at >= ?2 AND s.created_at < ?3
         AND s.is_cluster_primary = 1
       GROUP BY jt.value`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .all<{ dim: string; cnt: number }>();

  const total = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM hf_spaces s
       JOIN hf_classifications c ON c.space_id = s.space_id AND c.taxonomy_version = ?1
       WHERE s.created_at >= ?2 AND s.created_at < ?3
         AND s.is_cluster_primary = 1`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .first<{ cnt: number }>();

  const denominator = total?.cnt ?? 0;

  return (rows.results ?? []).map((r) => ({
    weekStart,
    cut: "technology_penetration",
    dimension: r.dim,
    subDimension: "",
    value: denominator > 0 ? (r.cnt / denominator) * 100 : 0,
    denominator,
    coverage: null,
    delta1w: null,
    delta4w: null,
    delta12w: null,
  }));
}

// ── 6. New models by family ─────────────────────────────────────────────────

async function newModelsByFamily(
  db: D1Database,
  weekStart: string,
  weekEnd: string,
): Promise<MetricRow[]> {
  const rows = await db
    .prepare(
      `SELECT COALESCE(family, 'unknown') AS dim, COUNT(*) AS cnt
       FROM hf_models
       WHERE created_at >= ?1 AND created_at < ?2
       GROUP BY family`,
    )
    .bind(weekStart, weekEnd)
    .all<{ dim: string; cnt: number }>();

  const total = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM hf_models
       WHERE created_at >= ?1 AND created_at < ?2`,
    )
    .bind(weekStart, weekEnd)
    .first<{ cnt: number }>();

  const denominator = total?.cnt ?? 0;

  return (rows.results ?? []).map((r) => ({
    weekStart,
    cut: "models_by_family",
    dimension: r.dim,
    subDimension: "",
    value: r.cnt,
    denominator,
    coverage: null,
    delta1w: null,
    delta4w: null,
    delta12w: null,
  }));
}

// ── 7. Download/like trends ─────────────────────────────────────────────────

async function downloadLikeTrends(
  db: D1Database,
  weekStart: string,
  weekEnd: string,
): Promise<MetricRow[]> {
  const modelStats = await db
    .prepare(
      `SELECT SUM(downloads) AS total_downloads, SUM(likes) AS total_likes,
              COUNT(*) AS cnt
       FROM hf_models WHERE created_at >= ?1 AND created_at < ?2`,
    )
    .bind(weekStart, weekEnd)
    .first<{ total_downloads: number | null; total_likes: number | null; cnt: number }>();

  const spaceStats = await db
    .prepare(
      `SELECT SUM(likes) AS total_likes, COUNT(*) AS cnt
       FROM hf_spaces
       WHERE created_at >= ?1 AND created_at < ?2 AND is_cluster_primary = 1`,
    )
    .bind(weekStart, weekEnd)
    .first<{ total_likes: number | null; cnt: number }>();

  const results: MetricRow[] = [];
  if (modelStats) {
    results.push({
      weekStart,
      cut: "engagement",
      dimension: "model_downloads",
      subDimension: "",
      value: modelStats.total_downloads ?? 0,
      denominator: modelStats.cnt ?? 0,
      coverage: null,
      delta1w: null, delta4w: null, delta12w: null,
    });
    results.push({
      weekStart,
      cut: "engagement",
      dimension: "model_likes",
      subDimension: "",
      value: modelStats.total_likes ?? 0,
      denominator: modelStats.cnt ?? 0,
      coverage: null,
      delta1w: null, delta4w: null, delta12w: null,
    });
  }
  if (spaceStats) {
    results.push({
      weekStart,
      cut: "engagement",
      dimension: "space_likes",
      subDimension: "",
      value: spaceStats.total_likes ?? 0,
      denominator: spaceStats.cnt ?? 0,
      coverage: null,
      delta1w: null, delta4w: null, delta12w: null,
    });
  }

  return results;
}

// ── Delta computation ───────────────────────────────────────────────────────

async function computeDeltas(db: D1Database, weekStart: string): Promise<number> {
  const windows = [
    { field: "delta_1w", weeks: 1 },
    { field: "delta_4w", weeks: 4 },
    { field: "delta_12w", weeks: 12 },
  ] as const;

  let updated = 0;

  for (const { field, weeks } of windows) {
    const prevWeek = new Date(
      new Date(`${weekStart}T00:00:00.000Z`).getTime() - weeks * 7 * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);

    const result = await db
      .prepare(
        `UPDATE hf_weekly_metrics SET ${field} =
           CASE WHEN (
             SELECT value FROM hf_weekly_metrics prev
             WHERE prev.week_start = ?1
               AND prev.metric_cut = hf_weekly_metrics.metric_cut
               AND prev.dimension = hf_weekly_metrics.dimension
               AND prev.sub_dimension = hf_weekly_metrics.sub_dimension
               AND prev.taxonomy_version = hf_weekly_metrics.taxonomy_version
           ) > 0
           THEN (hf_weekly_metrics.value - (
             SELECT value FROM hf_weekly_metrics prev
             WHERE prev.week_start = ?1
               AND prev.metric_cut = hf_weekly_metrics.metric_cut
               AND prev.dimension = hf_weekly_metrics.dimension
               AND prev.sub_dimension = hf_weekly_metrics.sub_dimension
               AND prev.taxonomy_version = hf_weekly_metrics.taxonomy_version
           )) / (
             SELECT value FROM hf_weekly_metrics prev
             WHERE prev.week_start = ?1
               AND prev.metric_cut = hf_weekly_metrics.metric_cut
               AND prev.dimension = hf_weekly_metrics.dimension
               AND prev.sub_dimension = hf_weekly_metrics.sub_dimension
               AND prev.taxonomy_version = hf_weekly_metrics.taxonomy_version
           ) * 100
           ELSE NULL END
         WHERE week_start = ?2
           AND taxonomy_version = ?3
           AND suppressed = 0`,
      )
      .bind(prevWeek, weekStart, TAXONOMY_VERSION)
      .run();

    updated += result.meta?.changes ?? 0;
  }

  return updated;
}

// ── Main aggregation function ───────────────────────────────────────────────

export async function aggregateWeeklyMetrics(
  db: D1Database,
  weekStart: string,
  weekEnd: string,
): Promise<AggregateSummary> {
  const allRows: MetricRow[] = [];

  const [
    useCaseRows,
    shareRows,
    verticalRows,
    familyShareRows,
    techRows,
    modelRows,
    engagementRows,
  ] = await Promise.all([
    newSpacesByUseCase(db, weekStart, weekEnd),
    shareByUseCase(db, weekStart, weekEnd),
    breakdownByVertical(db, weekStart, weekEnd),
    familyShareByUseCase(db, weekStart, weekEnd),
    technologyPenetration(db, weekStart, weekEnd),
    newModelsByFamily(db, weekStart, weekEnd),
    downloadLikeTrends(db, weekStart, weekEnd),
  ]);

  allRows.push(
    ...useCaseRows,
    ...shareRows,
    ...verticalRows,
    ...familyShareRows,
    ...techRows,
    ...modelRows,
    ...engagementRows,
  );

  const metricsWritten = await batchUpsert(db, allRows);

  await computeDeltas(db, weekStart);

  return { metricsWritten };
}
