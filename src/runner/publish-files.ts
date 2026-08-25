import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
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
): Promise<PublishResult> {
  const files = await buildSnapshot(db, { generatedAt });

  // index.json last, and built from what actually landed: it is what a reader
  // uses to know which weeks exist, so it must never advertise a week whose
  // file failed to write.
  const written: string[] = [];
  for (const file of files) {
    if (file.path === "index.json") continue;
    written.push(write(root, file.path, merged(root, file)));
  }

  const index = files.find((f) => f.path === "index.json");
  if (index) {
    // Union with what was published before, for the same reason everything
    // else here merges: the earlier weeks are still on disk and still on the
    // page, and dropping them from the index would hide them.
    const previous = readJson<{ weeks?: string[] }>(join(root, "index.json"));
    const value = index.value as { weeks: string[] };
    const weeks = [...new Set([...(previous?.weeks ?? []), ...value.weeks])].sort();
    written.push(write(root, "index.json", { ...value, weeks }));
    return { written, weeks };
  }

  return { written, weeks: [] };
}
