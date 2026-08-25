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

/**
 * Who we say we are to the Hub.
 *
 * An anonymous request with no User-Agent is indistinguishable from a scraper,
 * and huggingface.co is entitled to treat it as one. Every listing request
 * this project makes has always identified itself; the README fetch beside it
 * did not, and it is the request that never worked.
 */
const HF_USER_AGENT = "huggingface-activity-dashboard/1.0 (+https://github.com/techmuns/huggingface)";

const BOILERPLATE_MARKER =
  "Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference";

const MIN_USEFUL_BYTES = 250;

export type ReadmeStatus = "ok" | "stub" | "missing" | "error";

export interface ReadmeResult {
  /** Set when the Hub answered 429. The caller slows down rather than
      recording thousands of rows as permanently unreachable. */
  rateLimited?: boolean;
  retryAfterSeconds?: number | null;
  text: string | null;
  hash: string | null;
  status: ReadmeStatus;
}

/**
 * Byte cap on stored README text.
 *
 * A README is arbitrary user content with no size limit, and it went into D1
 * unbounded. Every consumer already truncates far below this — the rules read
 * the first 2,000 characters, the LLM prompt the first 500 — so the only
 * thing the untruncated tail ever did was sit in the row waiting to breach a
 * limit.
 *
 * 32 KB is 16x the largest consumer, which leaves room for a future
 * classifier to read more without another migration, and stays well inside
 * D1's bounds.
 *
 * Measured in bytes rather than characters deliberately: a 32,000-character
 * cap permits 128 KB of four-byte UTF-8, which is past D1's 100 KB statement
 * limit. Model cards are full of CJK and emoji, so that is a real case rather
 * than a hypothetical one.
 */
export const README_MAX_BYTES = 32_000;

/**
 * Truncates to a byte budget without splitting a character in half.
 *
 * Delegates to `TextEncoder.encodeInto`, which is native, fills a fixed buffer
 * and stops on the last WHOLE code point that fits — exactly this function's
 * contract. Its `read` count is in UTF-16 code units, so slicing at it can
 * never land between the halves of a surrogate pair. Lone surrogates encode as
 * U+FFFD, the same 3 bytes the hand-rolled walk budgeted for them.
 *
 * This has been the hot spot twice, both times for the same reason: a per-
 * character JS loop over READMEs capped at 32 KB, run across a queue of
 * ~16,000, inside the stage that kept dying with "Worker exceeded CPU time
 * limit". The first version called `new TextEncoder().encode(ch).length` once
 * per code point (8,818ms for 500 oversized READMEs). The second measured
 * widths inline instead of allocating — 40x better, but still ~32,000
 * iterations per oversized README: a batch of 150 measured **72.8 ms** in
 * workerd, against a 10 ms step budget. This one measures 1.5 ms.
 *
 * The early return is the other half of the win. Every UTF-16 code unit is at
 * most 3 UTF-8 bytes, so `length * 3 <= maxBytes` proves the text fits without
 * looking at it — which is the common case, and it now costs nothing instead
 * of a full `utf8Bytes` scan of every README that was never oversized.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes) return text;

  const buf = new Uint8Array(maxBytes);
  const { read } = new TextEncoder().encodeInto(text, buf);
  return read >= text.length ? text : text.slice(0, read);
}

export async function fetchReadme(
  spaceId: string,
  existingHash: string | null,
  token?: string,
): Promise<ReadmeResult> {
  const url = `${HF_README_BASE}/${spaceId}/raw/main/README.md`;
  let response: Response;
  try {
    // Sent with credentials and an identity, which this request did not carry
    // for the entire life of the project. It was a bare `fetch(url)` — no
    // Authorization, no User-Agent — while the listing requests beside it in
    // hf-api.ts have always sent both. Two runs recorded the result:
    //
    //     2026-08-20 01:34   total 14,153   ok 8      error 14,109
    //     2026-08-20 14:17   total 14,454   ok 2      error 14,433
    //
    // 0.01% and 0.06%. `missing` was 0 in both, which is the tell: a Hub that
    // was answering would return 404 for the Spaces that genuinely have no
    // README, and none did. Nothing was reaching it.
    //
    // README text is the primary signal the rule and LLM classifiers read, so
    // every classification this project has ever published was made from a
    // title, some tags and an SDK name, with the field that was supposed to
    // carry the meaning empty. The stage reported itself complete throughout,
    // because `readme_status` was non-NULL — it just said 'error'.
    response = await fetch(url, {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "user-agent": HF_USER_AGENT,
        accept: "text/plain",
      },
    });
  } catch {
    return { text: null, hash: null, status: "error" };
  }

  if (!response.ok) {
    // 404/410 mean the README genuinely is not there — terminal. So do 401
    // and 403: a Space we are not allowed to read is not a Space the Hub was
    // too busy to serve, and retrying it every week forever costs a request
    // each time and never resolves.
    //
    // A 429 or a 5xx means the Hub was busy, which says nothing about the
    // Space; marking those 'missing' retired them permanently on the first
    // rate-limit blip and quietly shrank the enrichable population.
    const status = response.status;
    const terminal = status === 404 || status === 410 || status === 401 || status === 403;
    if (!terminal && status === 429) {
      const after = Number(response.headers.get("retry-after"));
      return {
        text: null,
        hash: null,
        status: "error",
        retryAfterSeconds: Number.isFinite(after) && after > 0 ? after : null,
        rateLimited: true,
      };
    }
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

  // The hash stays over the FULL text so change detection still sees an edit
  // past the cap; only what is stored is bounded.
  return { text: truncateToBytes(stripped, README_MAX_BYTES), hash, status: "ok" };
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

/**
 * The Hub's authenticated budget is 5,000 requests per 300 s — 16.7 a second.
 * At concurrency 8 a slice is 8 requests, so a slice may start no more often
 * than every 480 ms. 520 leaves a margin for the listing walk, which draws on
 * the same bucket.
 */
const SLICE_MIN_MS = 520;

/** Fallback pause when the Hub sends 429 without a Retry-After. */
const RATE_LIMIT_PAUSE_S = 30;

/** Never sleep longer than this on one 429, however large Retry-After is. */
const RATE_LIMIT_MAX_PAUSE_S = 120;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface EnrichBatchParams {
  db: D1Database;
  batchSize?: number;
  offset?: number;
  /** Hub token. Optional, but its absence is what made this stage a no-op. */
  token?: string;
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
  const { db, batchSize = 50, offset = 0, token } = params;
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
    const startedAt = Date.now();
    const settled = await Promise.all(
      slice.map(async (row) => ({
        row,
        result: await fetchReadme(row.space_id, row.readme_hash, token),
      })),
    );
    results.push(...settled);

    // Pace against the quota the Hub publishes, rather than going as fast as
    // the network allows and calling the resulting 429s "errors".
    //
    // The Hub answers every request with its budget:
    //
    //     anonymous       ratelimit-policy: "resolvers"; q=3000; w=300
    //     authenticated   ratelimit-policy: "resolvers"; q=5000; w=300
    //
    // This queue is ~16,500 READMEs. Unpaced at concurrency 8 that is roughly
    // 40 requests a second against a sustainable 16.7, so the budget is gone
    // in under two minutes and every remaining request comes back 429 —
    // recorded as `error`, which is exactly the 14,433-of-14,454 that two runs
    // reported while calling themselves complete. Worse anonymously: that
    // bucket is keyed by IP and a Worker shares its egress with every other
    // Worker hitting the same host, which is how a 3,000 budget yielded 2.
    //
    // So spend the slice's own wall clock first and only sleep the remainder.
    // A slice that took longer than its share costs nothing extra.
    const elapsed = Date.now() - startedAt;
    const owed = SLICE_MIN_MS - elapsed;
    if (owed > 0) await sleep(owed);

    // A 429 despite pacing means something else is drawing on the same bucket.
    // Honour the Hub's own Retry-After before continuing; the batch runs
    // inside one Workflow step and step wall clock is unlimited, so waiting is
    // free where marking rows unreachable is not.
    const limited = settled.find((x) => x.result.rateLimited);
    if (limited) {
      const wait = limited.result.retryAfterSeconds ?? RATE_LIMIT_PAUSE_S;
      await sleep(Math.min(wait, RATE_LIMIT_MAX_PAUSE_S) * 1000);
    }
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

/**
 * Spaces keyed per dedup page.
 *
 * The clustering walk is a synchronous loop — a JSON.parse, a regex
 * normalisation and a sort for every row — and it used to run over the whole
 * week in one unbroken block. Measured in workerd, that block costs 10.0 ms at
 * 7,000 Spaces, 16 ms at 12,000 and 43 ms at 20,000, against a step budget of
 * 10 ms. Week 2026-08-17 held 6,595 Spaces and the run died on this step.
 *
 * It is the only stage that had no page, no cursor and no cap, so it was the
 * one stage whose cost was a pure function of how big a week the Hub had —
 * which is the definition of a thing that breaks on its own schedule. At 1,000
 * a page the block is ~1.4 ms and the D1 await between pages ends the run of
 * synchronous work that the CPU limit actually measures.
 */
export const DEDUP_PAGE = 1_000;

export async function dedupSpaces(db: D1Database, weekStart: string, weekEnd: string): Promise<DedupSummary> {
  const clusters = new Map<string, string[]>();

  // Paged on (created_at, space_id). Ordering by created_at alone is what the
  // unpaged version did and it is what decides the cluster PRIMARY — the
  // earliest Space is the original and the rest are its duplicates — so the
  // order is preserved exactly rather than switched to a bare space_id cursor.
  // space_id only breaks ties, which were previously arbitrary.
  let cursorCreated = "";
  let cursorId = "";
  let first = true;

  for (;;) {
    const page = await db
      .prepare(
        `SELECT space_id, title, linked_models, created_at
           FROM hf_spaces
          WHERE created_at >= ?1 AND created_at < ?2
            AND (?3 = 1 OR created_at > ?4 OR (created_at = ?4 AND space_id > ?5))
          ORDER BY created_at, space_id
          LIMIT ?6`,
      )
      .bind(weekStart, weekEnd, first ? 1 : 0, cursorCreated, cursorId, DEDUP_PAGE)
      .all<{
        space_id: string;
        title: string | null;
        linked_models: string;
        created_at: string;
      }>();

    const rows = page.results ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const key = clusterKey(row.space_id, row.title, row.linked_models);
      const group = clusters.get(key);
      if (group) {
        group.push(row.space_id);
      } else {
        clusters.set(key, [row.space_id]);
      }
    }

    const last = rows[rows.length - 1]!;
    cursorCreated = last.created_at;
    cursorId = last.space_id;
    first = false;
    if (rows.length < DEDUP_PAGE) break;
  }

  if (clusters.size === 0) return { clustered: 0, clusters: 0 };

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
