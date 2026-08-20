/**
 * Phase 8 — Publish a weekly snapshot to GitHub.
 *
 * Commits `data/weeks/YYYY-Www.json` via the GitHub contents API. This is
 * where the JSON-in-GitHub option earns its place:
 *   - A published week becomes immutable (Spaces get deleted/privatised).
 *   - It is diffable (taxonomy changes show as reviewable diffs).
 *   - It is portable (already a public, versioned, auth-free JSON feed).
 *   - It is the offsite backup that makes the 26-week D1 retention safe.
 */

import { isoWeekLabel } from "./time";
import { TAXONOMY_VERSION } from "./taxonomy";

export interface SnapshotPayload {
  weekStart: string;
  weekLabel: string;
  taxonomyVersion: string;
  generatedAt: string;
  narrative: string;
  metrics: unknown[];
  coverage: {
    totalSpaces: number;
    classifiedSpaces: number;
    coveragePercent: number | null;
  };
}

export interface SnapshotSummary {
  path: string;
  committed: boolean;
  sha: string | null;
  /**
   * Why the archive did not land, when it did not.
   *
   * Present only on a failure. The run carries on regardless — the week's
   * metrics are written in Phase 7 and the dashboard is already updated by the
   * time this runs — but the reason has to travel with the run rather than
   * only existing in a log line nobody reads.
   */
  error?: string;
}

export async function buildSnapshot(
  db: D1Database,
  weekStart: string,
  narrative: string,
): Promise<SnapshotPayload> {
  const metrics = await db
    .prepare(
      `SELECT metric_cut, dimension, sub_dimension,
              value, denominator, coverage,
              delta_1w, delta_4w, delta_12w, suppressed
       FROM hf_weekly_metrics
       WHERE week_start = ?1 AND taxonomy_version = ?2
       ORDER BY metric_cut, dimension, sub_dimension`,
    )
    .bind(weekStart, TAXONOMY_VERSION)
    .all();

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

  const classified = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM hf_spaces s
       JOIN hf_classifications c ON c.space_id = s.space_id AND c.taxonomy_version = ?1
       WHERE s.created_at >= ?2 AND s.created_at < ?3
         AND s.is_cluster_primary = 1`,
    )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .first<{ cnt: number }>();

  const totalCount = total?.cnt ?? 0;
  const classifiedCount = classified?.cnt ?? 0;

  return {
    weekStart,
    weekLabel: isoWeekLabel(new Date(`${weekStart}T00:00:00.000Z`)),
    taxonomyVersion: TAXONOMY_VERSION,
    generatedAt: new Date().toISOString(),
    narrative,
    metrics: metrics.results ?? [],
    coverage: {
      totalSpaces: totalCount,
      classifiedSpaces: classifiedCount,
      coveragePercent: totalCount > 0 ? (classifiedCount / totalCount) * 100 : null,
    },
  };
}

/**
 * Base64 for the GitHub contents API, UTF-8 safe.
 *
 * btoa() is defined over Latin-1 and throws on any code point above U+00FF.
 * This payload carries LLM-written prose (em dashes, curly quotes) and Space
 * titles that are routinely CJK or emoji, so encoding the string directly
 * would throw on the publish step of essentially every real week. Encoding to
 * UTF-8 bytes first and mapping those into the Latin-1 range keeps btoa in the
 * domain it actually supports.
 */
export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  // Chunked rather than String.fromCharCode(...bytes): a snapshot is tens of
  // KB, and spreading that many arguments risks a call-stack overflow.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Inverse of base64Utf8, for reading a snapshot back out of GitHub. */
export function decodeBase64Utf8(encoded: string): string {
  // GitHub wraps its base64 payloads at 60 characters; atob rejects newlines.
  const binary = atob(encoded.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function commitSnapshot(
  payload: SnapshotPayload,
  repo: string,
  token: string,
): Promise<SnapshotSummary> {
  const path = `data/weeks/${payload.weekLabel}.json`;
  const content = base64Utf8(JSON.stringify(payload, null, 2));

  const existingRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "hf-activity-worker",
      },
    },
  );

  let existingSha: string | undefined;
  if (existingRes.ok) {
    const existing = (await existingRes.json()) as { sha: string };
    existingSha = existing.sha;
  }

  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "hf-activity-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `data: ${payload.weekLabel} weekly snapshot`,
        content,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub commit failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const result = (await res.json()) as { content: { sha: string } };

  return {
    path,
    committed: true,
    sha: result.content.sha,
  };
}
