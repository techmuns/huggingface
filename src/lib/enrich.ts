/**
 * Phase 5 — enrich the blind half.
 *
 * ~58.5% of new Spaces arrive with no description and no linked model.  For
 * that subset only, fetch the README from the Hub, strip YAML front-matter,
 * filter boilerplate, and hash the result.  Dedup clusters Spaces by
 * normalised title so one viral template does not manufacture a fake trend.
 */

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
    return { text: null, hash: null, status: "missing" };
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

  return { text: stripped, hash, status: "ok" };
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

  const rows = await db
    .prepare(
      `SELECT space_id, readme_hash FROM hf_spaces
       WHERE signal_tier = 'blind' AND (readme_status IS NULL OR readme_status = 'error')
       ORDER BY space_id
       LIMIT ?1 OFFSET ?2`,
    )
    .bind(batchSize, offset)
    .all<{ space_id: string; readme_hash: string | null }>();

  if (!rows.results?.length) return summary;
  summary.total = rows.results.length;

  for (const row of rows.results) {
    const result = await fetchReadme(row.space_id, row.readme_hash);
    summary.fetched++;
    summary[result.status]++;

    if (result.hash === row.readme_hash && result.status === "ok") {
      summary.skippedUnchanged++;
      continue;
    }

    await db
      .prepare(
        `UPDATE hf_spaces
           SET readme_text = ?1, readme_hash = ?2,
               readme_fetched_at = datetime('now'), readme_status = ?3
         WHERE space_id = ?4`,
      )
      .bind(result.text, result.hash, result.status, row.space_id)
      .run();
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
    const key = clusterKey(row.title, row.author, row.linked_models);
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

  for (const [, members] of clusters) {
    if (members.length < 2) {
      stmts.push(
        db
          .prepare(
            `UPDATE hf_spaces SET dedup_cluster_id = ?1, is_cluster_primary = 1 WHERE space_id = ?2`,
          )
          .bind(members[0], members[0]),
      );
      continue;
    }

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
    const BATCH = 100;
    for (let i = 0; i < stmts.length; i += BATCH) {
      await db.batch(stmts.slice(i, i + BATCH));
    }
  }

  return { clustered, clusters: clusterCount };
}

function clusterKey(title: string | null, author: string | null, linkedModelsJson: string): string {
  const norm = normalizeTitle(title ?? "");
  let models: string[] = [];
  try {
    models = JSON.parse(linkedModelsJson);
  } catch { /* empty */ }
  return `${norm}|${models.sort().join(",")}`;
}
