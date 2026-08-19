/**
 * Phase 5 — enrich the blind half.
 *
 * ~58.5% of new Spaces arrive with no description and no linked model.  For
 * that subset only, fetch the README from the Hub, strip YAML front-matter,
 * filter boilerplate, and hash the result.  Dedup clusters Spaces by
 * normalised title so one viral template does not manufacture a fake trend.
 */
import { D1_BATCH } from "./raw-store";

// ── README fetching ─────────────────────────────────────────────────────────

const HF_README_BASE = "https://huggingface.co/spaces";

const BOILERPLATE_MARKER =
  "Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference";

const MIN_USEFUL_BYTES = 250;

export type ReadmeStatus = "ok" | "stub" | "missing" | "error";

export interface ReadmeResult {
  text: string | null;
  hash: string | null;
  status: ReadmeStatus;
}

/**
 * The most README text that is ever stored.
 *
 * A run died with `D1_ERROR: string or blob too big: SQLITE_TOOBIG` because
 * this column was written with whatever the Hub returned. A README is
 * arbitrary user content — embedded base64 images, generated tables, pasted
 * model dumps — and one Space large enough to breach D1's per-value ceiling
 * took down the entire week, for every Space in it.
 *
 * Nothing downstream wants the whole document. Rule classification reads the
 * first 2,000 characters and the LLM prompt reads 500; the rest was stored
 * only because nothing said not to. 8,000 is four times the largest consumer
 * and keeps a 40-statement D1 batch comfortably inside its limits.
 *
 * The HASH is still taken over the full document — see fetchReadme — so a
 * change past the cap is still detected and the cap cannot silently freeze a
 * Space's classification.
 */
export const MAX_README_CHARS = 8_000;

export async function fetchReadme(
  spaceId: string,
  existingHash: string | null,
): Promise<ReadmeResult> {
  const url = `${HF_README_BASE}/${spaceId}/raw/main/README.md`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    return { text: null, hash: null, status: "error" };
  }

  if (!response.ok) {
    // 404/410 mean the README genuinely is not there — terminal. A 429 or a
    // 5xx means the Hub was busy, which says nothing about the Space; marking
    // those 'missing' retired them permanently on the first rate-limit blip
    // and quietly shrank the enrichable population.
    const terminal = response.status === 404 || response.status === 410;
    return { text: null, hash: null, status: terminal ? "missing" : "error" };
  }

  const raw = await response.text();
  const stripped = stripFrontMatter(raw);
  const hash = await contentHash(stripped);

  if (existingHash && hash === existingHash) {
    return { text: null, hash, status: "ok" };
  }

  if (isBoilerplate(stripped)) {
    return { text: null, hash, status: "stub" };
  }

  // Truncated for storage only, and only after the hash is taken: the hash is
  // the change-detection key, so hashing the truncated text would make every
  // edit past the cap invisible and pin that Space to its first reading for
  // good.
  return { text: stripped.slice(0, MAX_README_CHARS), hash, status: "ok" };
}

export function stripFrontMatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  return raw.slice(end + 4).trim();
}

export function isBoilerplate(text: string): boolean {
  if (text.length < MIN_USEFUL_BYTES) return true;
  if (text.includes(BOILERPLATE_MARKER)) return true;
  return false;
}

export async function contentHash(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Batch enrichment ────────────────────────────────────────────────────────

export interface EnrichSummary {
  /** True if the batch cap was hit before the queue drained. */
  truncated?: boolean;
  total: number;
  fetched: number;
  ok: number;
  stub: number;
  missing: number;
  error: number;
  skippedUnchanged: number;
}

export interface EnrichBatchParams {
  db: D1Database;
  batchSize?: number;
  offset?: number;
}

/**
 * Clears transient README failures so the next run retries them.
 *
 * Within a run an 'error' row is held out of the queue so a persistently
 * unreachable Space cannot spin the batch loop. That is only safe if the flag
 * is eventually cleared — otherwise one rate-limited minute permanently
 * retires those Spaces from enrichment, and the blind half quietly shrinks
 * every week. Called once at the start of the enrich phase.
 */
export async function resetTransientReadmeErrors(db: D1Database): Promise<number> {
  const result = await db
    .prepare("UPDATE hf_spaces SET readme_status = NULL WHERE readme_status = 'error'")
    .run();
  return result.meta?.changes ?? 0;
}

export async function enrichBlindSpaces(params: EnrichBatchParams): Promise<EnrichSummary> {
  const { db, batchSize = 50, offset = 0 } = params;
  const summary: EnrichSummary = {
    total: 0,
    fetched: 0,
    ok: 0,
    stub: 0,
    missing: 0,
    error: 0,
    skippedUnchanged: 0,
  };

  // Newest first, deliberately.
  //
  // This queue is global on purpose: blind Spaces accumulate faster than one
  // run's cap drains them, so scoping it to the run's week would strand the
  // backlog permanently. But the previous ordering was `space_id`, which is
  // alphabetical and unrelated to anything — a run asked to process one week
  // could spend its entire README budget on old Spaces whose ids happen to
  // sort early and never reach the week it was started for. Ordering by
  // created_at serves the week being processed first and lets whatever budget
  // is left spill into the backlog.
  //
  // Only rows never attempted. An 'error' row deliberately stays out of the
  // queue for the rest of the run: the caller drains this batch-by-batch
  // until it comes back short, and re-selecting failures would put the same
  // unreachable Spaces back at the head of the queue on every pass, spinning
  // until the batch cap with no progress. Transient failures are already
  // covered by the Workflow step's own retries, and anything still broken is
  // retried a week later by the next run.
  const rows = await db
    .prepare(
      `SELECT space_id, readme_hash FROM hf_spaces
       WHERE signal_tier = 'blind' AND readme_status IS NULL
       ORDER BY created_at DESC, space_id
       LIMIT ?1 OFFSET ?2`,
    )
    .bind(batchSize, offset)
    .all<{ space_id: string; readme_hash: string | null }>();

  if (!rows.results?.length) return summary;
  summary.total = rows.results.length;

  // Fetched with bounded concurrency and written in one batch. Sequentially,
  // a batch of 50 was 50 round-trips to the Hub plus 50 separate UPDATEs, and
  // the blind subset is thousands of Spaces a week — the stage dominated the
  // whole run. The cap is deliberate: unbounded parallelism would trip the
  // Hub's rate limit and convert a slow stage into a failing one.
  const CONCURRENCY = 8;
  const results: Array<{ row: (typeof rows.results)[number]; result: ReadmeResult }> = [];

  for (let i = 0; i < rows.results.length; i += CONCURRENCY) {
    const slice = rows.results.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      slice.map(async (row) => ({ row, result: await fetchReadme(row.space_id, row.readme_hash) })),
    );
    results.push(...settled);
  }

  const stmts: D1PreparedStatement[] = [];
  for (const { row, result } of results) {
    summary.fetched++;
    summary[result.status]++;

    if (result.hash === row.readme_hash && result.status === "ok") {
      summary.skippedUnchanged++;
      continue;
    }

    stmts.push(
      db
        .prepare(
          `UPDATE hf_spaces
             SET readme_text = ?1, readme_hash = ?2,
                 readme_fetched_at = datetime('now'), readme_status = ?3
           WHERE space_id = ?4`,
        )
        .bind(result.text, result.hash, result.status, row.space_id),
    );
  }

  for (let i = 0; i < stmts.length; i += D1_BATCH) {
    await db.batch(stmts.slice(i, i + D1_BATCH));
  }

  return summary;
}

// ── Dedup clustering ────────────────────────────────────────────────────────

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface DedupSummary {
  clustered: number;
  clusters: number;
}

export async function dedupSpaces(db: D1Database, weekStart: string, weekEnd: string): Promise<DedupSummary> {
  const rows = await db
    .prepare(
      `SELECT space_id, title, author, linked_models, created_at
       FROM hf_spaces
       WHERE created_at >= ?1 AND created_at < ?2
       ORDER BY created_at`,
    )
    .bind(weekStart, weekEnd)
    .all<{
      space_id: string;
      title: string | null;
      author: string | null;
      linked_models: string;
      created_at: string;
    }>();

  if (!rows.results?.length) return { clustered: 0, clusters: 0 };

  const clusters = new Map<string, string[]>();
  for (const row of rows.results) {
    const key = clusterKey(row.space_id, row.title, row.linked_models);
    const group = clusters.get(key);
    if (group) {
      group.push(row.space_id);
    } else {
      clusters.set(key, [row.space_id]);
    }
  }

  const stmts: D1PreparedStatement[] = [];
  let clustered = 0;
  let clusterCount = 0;

  // Singletons are the overwhelming majority and already hold the right state:
  // is_cluster_primary defaults to 1, and one bulk statement below backfills
  // dedup_cluster_id for them. Writing a row each was ~7,000 statements inside
  // a single Workflow step, well past D1's 1,000-queries-per-invocation limit.
  for (const [, members] of clusters) {
    if (members.length < 2) continue;

    clusterCount++;
    const primary = members[0]!;
    for (let i = 0; i < members.length; i++) {
      stmts.push(
        db
          .prepare(
            `UPDATE hf_spaces SET dedup_cluster_id = ?1, is_cluster_primary = ?2 WHERE space_id = ?3`,
          )
          .bind(primary, i === 0 ? 1 : 0, members[i]),
      );
      if (i > 0) clustered++;
    }
  }

  if (stmts.length > 0) {
    const BATCH = D1_BATCH;
    for (let i = 0; i < stmts.length; i += BATCH) {
      await db.batch(stmts.slice(i, i + BATCH));
    }
  }

  // Every Space not in a real cluster is its own cluster. One statement rather
  // than one per row.
  await db
    .prepare(
      `UPDATE hf_spaces
          SET dedup_cluster_id = space_id, is_cluster_primary = 1
        WHERE created_at >= ?1 AND created_at < ?2
          AND dedup_cluster_id IS NULL`,
    )
    .bind(weekStart, weekEnd)
    .run();

  return { clustered, clusters: clusterCount };
}

function clusterKey(
  spaceId: string,
  title: string | null,
  linkedModelsJson: string,
): string {
  const norm = normalizeTitle(title ?? "");
  let models: string[] = [];
  try {
    const parsed = JSON.parse(linkedModelsJson);
    if (Array.isArray(parsed)) models = parsed.filter((m) => typeof m === "string");
  } catch { /* malformed JSON is treated as no linked models */ }

  // A Space with no title and no linked model has nothing to be a duplicate
  // *of*. Keying it on the empty string collapsed every such Space into a
  // single cluster and suppressed all but one of them from every metric —
  // and the untitled ones are a large share of the blind half. Fall back to
  // the id so it clusters only with itself.
  if (norm === "" && models.length === 0) return `id:${spaceId}`;

  return `${norm}|${[...models].sort().join(",")}`;
}
