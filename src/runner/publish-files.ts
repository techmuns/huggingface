import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CoveragePayload,
  type DrillPayload,
  type InsightsPayload,
  type SeriesPayload,
  type SnapshotFile,
  buildSnapshot,
  mergeDrill,
  mergeInsights,
  mergeSeries,
} from "../lib/publish";

/**
 * Writes the snapshot to disk, merging with whatever is already published.
 *
 * The merging is the point. `buildSnapshot` describes one database, and this
 * database is not the history — it is whatever the runner has ingested since
 * the state branch was last reset. Writing it over the published files would
 * be correct only if the two always agreed, and on the very first run they do
 * not: the database is one week old and the files are months old.
 *
 * So every file that spans weeks is merged, and the per-week files are simply
 * not written for weeks the database cannot speak for. A run therefore adds
 * its week and leaves every other week exactly as it found it.
 */

export interface PublishResult {
  written: string[];
  weeks: string[];
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // Missing or unreadable both mean "nothing published yet", which is the
    // first run and not an error. A corrupt file is treated the same way on
    // purpose: the alternative is a run that cannot publish until someone
    // deletes a file by hand.
    return null;
  }
}

function write(root: string, rel: string, value: unknown): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return rel;
}

/**
 * Weeks this snapshot must not touch, because what is already published
 * describes them better than the database does.
 *
 * The second guard, and the one run #2 needed. That run was asked for week
 * 2026-08-17 and aggregated it correctly, but its ingest window also caught 11
 * Spaces belonging to 2026-08-10 — enough for the aggregate step to write rows
 * for that week too. So the week passed every "does this database know about
 * it" test while knowing 11 Spaces of 5,572, and republished a complete week
 * as 0.2% of itself.
 *
 * A count is the honest comparison. If this run holds fewer Spaces for a week
 * than the published file counted, it is not a correction — it is a partial
 * view, and the published file wins. If it holds as many or more, it is at
 * least as complete and may overwrite.
 */
function regressedWeeks(
  root: string,
  files: SnapshotFile[],
  authoritative: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    if (!file.path.startsWith("coverage/")) continue;
    const next = file.value as CoveragePayload;

    // The week the run was asked for is always authoritative, even when its
    // count goes DOWN. Run #2 published week 2026-08-17 as 5,842 Spaces at
    // 100% coverage, against 6,613 at 33.6% from the old D1 pipeline — fewer
    // Spaces and a far better answer, because the count fell to deduplication
    // and to Spaces that no longer exist on the Hub. A count test alone would
    // have thrown that away, so it is only applied to the weeks the run did
    // not set out to compute.
    if (authoritative.has(next.weekStart)) continue;

    const previous = readJson<CoveragePayload>(join(root, file.path));
    if (previous && next.totalSpaces < previous.totalSpaces) {
      out.add(next.weekStart);
    }
  }
  return out;
}

/** Applies the right merge for the file, or none where none is needed. */
function merged(root: string, file: SnapshotFile): unknown {
  const path = join(root, file.path);

  if (file.path === "series.json" || file.path === "series-matrix.json") {
    return mergeSeries(readJson<SeriesPayload>(path), file.value as SeriesPayload);
  }
  if (file.path.startsWith("use-case-spaces/")) {
    return mergeDrill(readJson<DrillPayload>(path), file.value as DrillPayload);
  }
  if (file.path === "insights.json") {
    return mergeInsights(readJson<InsightsPayload>(path), file.value as InsightsPayload);
  }
  // coverage/<week>.json, narrative/<week>.json and index.json describe one
  // week, or the run itself. buildSnapshot only emits the first two for weeks
  // the database has, so writing them whole is already the merge.
  return file.value;
}

export async function publishSnapshot(
  db: D1Database,
  root: string,
  generatedAt: string,
  /**
   * The weeks this run set out to compute. Their figures replace whatever was
   * published, in either direction; every other week has to prove it is at
   * least as complete first.
   */
  authoritativeWeeks: readonly string[] = [],
): Promise<PublishResult> {
  const files = await buildSnapshot(db, { generatedAt });
  const regressed = regressedWeeks(root, files, new Set(authoritativeWeeks));
  for (const week of regressed) {
    console.warn(`publish: keeping the published ${week}; this run holds less of it`);
  }

  // index.json last, and built from what actually landed: it is what a reader
  // uses to know which weeks exist, so it must never advertise a week whose
  // file failed to write.
  const written: string[] = [];
  for (let file of files) {
    if (file.path === "index.json") continue;

    // A regressed week is dropped from both artefacts that carry per-week
    // figures. Coverage is one file per week, so it is simply skipped; the
    // drill files hold every week at once, so the week is removed from the
    // payload before the merge and the published entry survives.
    if (file.path.startsWith("coverage/")) {
      if (regressed.has((file.value as CoveragePayload).weekStart)) continue;
    } else if (file.path.startsWith("use-case-spaces/")) {
      const drill = file.value as DrillPayload;
      const weeks = Object.fromEntries(
        Object.entries(drill.weeks).filter(([week]) => !regressed.has(week)),
      );
      file = { path: file.path, value: { ...drill, weeks } satisfies DrillPayload };
    }

    written.push(write(root, file.path, merged(root, file)));
  }

  const index = files.find((f) => f.path === "index.json");
  if (index) {
    // Read back from series.json, rather than unioning with the last index.
    //
    // A union only ever grows, so a week that should never have been published
    // could not be taken back: 2026-08-24 was written by a run holding 1,830
    // Spaces and no classifications, removed from every other file, and stayed
    // in the index advertising a week nothing else had. series.json is the
    // list the dashboard actually draws from, and it is itself merged, so
    // deriving from it keeps old weeks AND drops retracted ones.
    const series = readJson<{ weeks?: string[] }>(join(root, "series.json"));
    const value = index.value as { weeks: string[] };
    const weeks = [...(series?.weeks ?? value.weeks)].sort();
    written.push(write(root, "index.json", { ...value, weeks }));
    return { written, weeks };
  }

  return { written, weeks: [] };
}
