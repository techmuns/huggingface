import { isAuthorized } from "./lib/auth";
import { decodeBase64Utf8 } from "./lib/snapshot";
import { TAXONOMY_VERSION } from "./lib/taxonomy";
import { isoWeekLabel, weekStartIso } from "./lib/time";
import type { WeeklyPipelineParams } from "./workflow";

export { WeeklyPipeline } from "./workflow";

const WEEK_MS = 7 * 86_400_000;

/**
 * Upper bound on a requested backfill.
 *
 * 12 weeks is what the dashboard's longest comparison window needs. The cap
 * exists because backfill length multiplies straight into request volume
 * against the Hub's rate limit, so an unbounded value from a request body
 * would be a self-inflicted outage.
 */
const MAX_BACKFILL_WEEKS = 26;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/api/admin/run") {
      return handleAdminRun(request, env);
    }

    const runStatus = /^\/api\/admin\/run\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (runStatus?.[1]) {
      return handleRunStatus(request, env, runStatus[1]);
    }

    // ── Phase 9: read API ────────────────────────────────────────────────
    if (url.pathname === "/api/metrics") {
      return handleMetrics(request, env, url);
    }

    if (url.pathname === "/api/narrative") {
      return handleNarrative(request, env, url);
    }

    if (url.pathname === "/api/coverage") {
      return handleCoverage(request, env, url);
    }

    if (url.pathname === "/api/review-queue") {
      return handleReviewQueue(request, env);
    }

    if (url.pathname === "/api/weeks") {
      return handleWeeksList(request, env);
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found", path: url.pathname }, { status: 404 });
    }

    // Everything else is the dashboard. In production Cloudflare's asset
    // router answers these before the Worker is invoked at all; forwarding
    // explicitly means the same request resolves the same way under `vitest`,
    // where `SELF` addresses the Worker directly and bypasses that router.
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Cron fires `30 0 * * 1` — Monday 00:30 UTC, i.e. Monday 06:00 IST. The
    // week to process is the one that just closed, not the one that began 30
    // minutes ago, so step back a week from the trigger instant.
    const weekStart = weekStartIso(new Date(controller.scheduledTime - WEEK_MS));

    await env.WEEKLY_PIPELINE.create({
      // Deterministic id: a duplicate cron delivery collides with the run
      // already in flight instead of starting a second pipeline over the same
      // week.
      id: `weekly-${weekStart}`,
      params: { weekStart, backfillWeeks: 1 },
    });
  },
} satisfies ExportedHandler<Env>;

/**
 * Starts the weekly pipeline on demand.
 *
 * Needed for the initial 12-week backfill, for re-running after a taxonomy
 * change, and for debugging without waiting a week for the cron.
 */
async function handleAdminRun(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "POST" } });
  }

  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown = {};
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
  }

  const parsed = parseRunParams(body);
  if ("error" in parsed) {
    return Response.json({ error: "invalid_params", detail: parsed.error }, { status: 400 });
  }

  const instance = await env.WEEKLY_PIPELINE.create({ params: parsed.params });
  return Response.json(
    { id: instance.id, status: await instance.status(), params: parsed.params },
    { status: 202 },
  );
}

/**
 * Reports on a pipeline run.
 *
 * Admin-guarded like the trigger: run status names instance ids and step
 * detail, which is operational information rather than dashboard data.
 */
async function handleRunStatus(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }
  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const instance = await env.WEEKLY_PIPELINE.get(id);
    return Response.json({ id, status: await instance.status() });
  } catch {
    // `get` throws for an unknown id; that is a 404, not a 500.
    return Response.json({ error: "not_found", id }, { status: 404 });
  }
}

/**
 * Validates the request body by hand.
 *
 * There is no framework doing this for us, and every field here feeds either
 * a rate-limited external walk or a SQL window, so unvalidated input is not
 * a stylistic concern.
 */
export function parseRunParams(
  body: unknown,
): { params: WeeklyPipelineParams } | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body must be a JSON object" };
  }

  const input = body as Record<string, unknown>;
  const params: WeeklyPipelineParams = {};

  const known = new Set(["weekStart", "backfillWeeks", "dryRun"]);
  const unknownKeys = Object.keys(input).filter((k) => !known.has(k));
  if (unknownKeys.length > 0) {
    // Rejecting rather than ignoring: a typo'd `backfill_weeks` that silently
    // did nothing would look like the backfill ran and found little.
    return { error: `unknown field(s): ${unknownKeys.join(", ")}` };
  }

  if (input.weekStart !== undefined) {
    if (typeof input.weekStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.weekStart)) {
      return { error: "weekStart must be an ISO date, YYYY-MM-DD" };
    }
    const parsedDate = new Date(`${input.weekStart}T00:00:00.000Z`);
    if (Number.isNaN(parsedDate.getTime())) {
      return { error: "weekStart is not a real date" };
    }
    if (weekStartIso(parsedDate) !== input.weekStart) {
      return { error: "weekStart must be a Monday" };
    }
    params.weekStart = input.weekStart;
  }

  if (input.backfillWeeks !== undefined) {
    const weeks = input.backfillWeeks;
    if (typeof weeks !== "number" || !Number.isInteger(weeks) || weeks < 1 || weeks > MAX_BACKFILL_WEEKS) {
      return { error: `backfillWeeks must be an integer between 1 and ${MAX_BACKFILL_WEEKS}` };
    }
    params.backfillWeeks = weeks;
  }

  if (input.dryRun !== undefined) {
    if (typeof input.dryRun !== "boolean") {
      return { error: "dryRun must be a boolean" };
    }
    params.dryRun = input.dryRun;
  }

  return { params };
}

// ── Phase 9: read API handlers ──────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=3600",
};

const VALID_CUTS = new Set([
  "spaces_by_use_case",
  "share_by_use_case",
  "vertical_penetration",
  "family_share_by_use_case",
  "technology_penetration",
  "sdk_distribution",
  "models_by_family",
  "engagement",
]);

async function handleMetrics(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  const weekStart = url.searchParams.get("week");
  const cut = url.searchParams.get("cut");

  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return Response.json(
      { error: "invalid_params", detail: "week is required (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  if (cut && !VALID_CUTS.has(cut)) {
    return Response.json(
      { error: "invalid_params", detail: `unknown cut: ${cut}. Valid: ${[...VALID_CUTS].join(", ")}` },
      { status: 400 },
    );
  }

  const query = cut
    ? `SELECT metric_cut, dimension, sub_dimension, value, denominator, coverage,
              delta_1w, delta_4w, delta_12w, suppressed
       FROM hf_weekly_metrics
       WHERE week_start = ?1 AND taxonomy_version = ?2 AND metric_cut = ?3
       ORDER BY metric_cut, value DESC`
    : `SELECT metric_cut, dimension, sub_dimension, value, denominator, coverage,
              delta_1w, delta_4w, delta_12w, suppressed
       FROM hf_weekly_metrics
       WHERE week_start = ?1 AND taxonomy_version = ?2
       ORDER BY metric_cut, value DESC`;

  const rows = cut
    ? await env.DB.prepare(query).bind(weekStart, TAXONOMY_VERSION, cut).all()
    : await env.DB.prepare(query).bind(weekStart, TAXONOMY_VERSION).all();

  return Response.json(
    { weekStart, taxonomyVersion: TAXONOMY_VERSION, metrics: rows.results ?? [] },
    { headers: CORS_HEADERS },
  );
}

async function handleNarrative(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  const weekStart = url.searchParams.get("week");
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return Response.json(
      { error: "invalid_params", detail: "week is required (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  // Snapshots are committed under their ISO week label (2026-W33), not the
  // Monday date, so the label has to be derived here or every lookup 404s.
  const label = isoWeekLabel(new Date(`${weekStart}T00:00:00.000Z`));
  const path = `data/weeks/${label}.json`;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "hf-activity-worker",
        },
      },
    );

    if (!res.ok) {
      return Response.json({ error: "not_found", weekStart }, { status: 404 });
    }

    const data = (await res.json()) as { content: string };
    // Mirror of the publish-side encoding: atob alone yields Latin-1 code
    // units, so any multi-byte character in the narrative or a Space title
    // would come back mojibake.
    const decoded = JSON.parse(decodeBase64Utf8(data.content));
    return Response.json(
      { weekStart, narrative: decoded.narrative ?? null },
      { headers: CORS_HEADERS },
    );
  } catch {
    return Response.json({ error: "not_found", weekStart }, { status: 404 });
  }
}

async function handleCoverage(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  const weekStart = url.searchParams.get("week");
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return Response.json(
      { error: "invalid_params", detail: "week is required (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  const weekEnd = new Date(
    new Date(`${weekStart}T00:00:00.000Z`).getTime() + 7 * 86_400_000,
  ).toISOString();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM hf_spaces
     WHERE created_at >= ?1 AND created_at < ?2 AND is_cluster_primary = 1`,
  )
    .bind(weekStart, weekEnd)
    .first<{ cnt: number }>();

  const classified = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM hf_spaces s
     JOIN hf_classifications c ON c.space_id = s.space_id AND c.taxonomy_version = ?1
     WHERE s.created_at >= ?2 AND s.created_at < ?3
       AND s.is_cluster_primary = 1`,
  )
    .bind(TAXONOMY_VERSION, weekStart, weekEnd)
    .first<{ cnt: number }>();

  const ruleCount = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM hf_classifications
     WHERE taxonomy_version = ?1 AND source_kind = 'rule'`,
  )
    .bind(TAXONOMY_VERSION)
    .first<{ cnt: number }>();

  const modelCount = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM hf_classifications
     WHERE taxonomy_version = ?1 AND source_kind = 'model'`,
  )
    .bind(TAXONOMY_VERSION)
    .first<{ cnt: number }>();

  const lowConfidence = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM hf_classifications
     WHERE taxonomy_version = ?1 AND low_confidence = 1`,
  )
    .bind(TAXONOMY_VERSION)
    .first<{ cnt: number }>();

  const totalCount = total?.cnt ?? 0;
  const classifiedCount = classified?.cnt ?? 0;

  return Response.json(
    {
      weekStart,
      totalSpaces: totalCount,
      classifiedSpaces: classifiedCount,
      coveragePercent: totalCount > 0 ? (classifiedCount / totalCount) * 100 : null,
      bySource: {
        rule: ruleCount?.cnt ?? 0,
        model: modelCount?.cnt ?? 0,
      },
      lowConfidence: lowConfidence?.cnt ?? 0,
    },
    { headers: CORS_HEADERS },
  );
}

async function handleReviewQueue(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await env.DB.prepare(
    `SELECT c.space_id, c.primary_use_case, c.use_case_confidence,
            c.verticals, c.verticals_confidence,
            c.source_kind, c.rationale,
            s.title, s.short_description
     FROM hf_classifications c
     JOIN hf_spaces s ON s.space_id = c.space_id
     WHERE c.taxonomy_version = ?1
       AND c.low_confidence = 1
       AND c.reviewed = 0
     ORDER BY c.use_case_confidence ASC
     LIMIT 100`,
  )
    .bind(TAXONOMY_VERSION)
    .all();

  return Response.json({ items: rows.results ?? [] });
}

async function handleWeeksList(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }

  const rows = await env.DB.prepare(
    `SELECT DISTINCT week_start FROM hf_weekly_metrics
     WHERE taxonomy_version = ?1
     ORDER BY week_start DESC
     LIMIT 52`,
  )
    .bind(TAXONOMY_VERSION)
    .all<{ week_start: string }>();

  return Response.json(
    { weeks: (rows.results ?? []).map((r) => r.week_start) },
    { headers: CORS_HEADERS },
  );
}
